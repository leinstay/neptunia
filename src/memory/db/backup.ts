// Daily persona backups: a consistent SQLite snapshot plus the regular files under data/.
// Runtime files under run/ and the database's WAL, SHM and writer lock are excluded.
// The manifest records checksums and table counts; restoration verifies them before copying.
// The scheduler keeps the configured number of finished backups and retries failed writes.
// A backup holds the persona's keys and memory: every folder it creates is 700 and every file 600, whatever the source's
// mode. The manifest keeps each file's mode for the restore, with `keys.json` at 600 even from a looser source.
// A backup copies and hashes the whole data folder, seconds on a large one: inside the core it runs on another thread
// (the writer for the daily one, `backupInWorker` for the owner's), and the pruning deletes through the async `fs`.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { Worker } from 'node:worker_threads';
import { openMemoryDb, schemaVersion } from './open.ts';
import type { Config, Db, MemoryHandle, Row } from './types.ts';
import { dbOf, asText, isWholeNumber } from './types.ts';

/** A backup's manifest: what it holds and the checksum of every file. */
export type BackupManifest = {
  v: number;
  schemaVersion: number;
  /** `mode`: what a restore gives the file back; the backup's own copy is always 600. */
  files: Array<{ path: string; size: number; sha256: string; mode?: number }>;
  rows?: Record<string, number>;
  [key: string]: unknown;
};

/** The diary media folder under the data directory. */
export const DIARY_MEDIA = path.join('media', 'diary');
/** `memoryDb.backup.*` when missing (config.json carries the same). */
export const BACKUP_DEFAULTS = Object.freeze({ enabled: false, hour: 3, dir: '../backups/memory', keep: 7 });
/** A finished backup's folder name. */
const NAME_RE = /^\d{4}-\d{2}-\d{2}-\d{6}-memory$/;
const PARTIAL = '.partial';
/** The persona's key file: never looser than 600, in a backup or after a restore. */
const KEYS_FILE = 'keys.json';
const BACKUP_WORKER = new URL('./backup-worker.ts', import.meta.url);

const sha256File = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** The files under `dir`, relative, in name order (none when it does not exist). */
export function filesUnder(dir: string): Array<string> {
  if (!fs.existsSync(dir)) return [];
  const out: Array<string> = [];
  const visit = (rel: string): void => {
    for (const entry of fs
      .readdirSync(path.join(dir, rel), { withFileTypes: true })
      .sort((a, b) => a.name.localeCompare(b.name))) {
      const next = rel ? path.join(rel, entry.name) : entry.name;
      if (entry.isDirectory()) visit(next);
      else if (entry.isFile()) out.push(next);
    }
  };
  visit('');
  return out;
}

/** The tables of a database (no SQLite internals), with the virtual ones marked and their shadow tables left out. */
export function tablesOf(db: Db): Array<{ name: string; virtual: boolean }> {
  const rows = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all();
  const virtual = new Set(
    rows
      .filter((row) => /^CREATE VIRTUAL TABLE/i.test((row.sql as string | null) ?? ''))
      .map((row) => row.name as string)
  );
  return rows
    .map((row) => row.name as string)
    .filter((name) => ![...virtual].some((v) => name.startsWith(`${v}_`)))
    .map((name) => ({ name, virtual: virtual.has(name) }));
}

/** Row counts of every table (tablesOf), by name. */
export function rowCounts(db: Db): Record<string, number> {
  return Object.fromEntries(
    tablesOf(db).map(({ name }) => [name, db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get()?.n as number])
  );
}

/** Canonical JSON: keys sorted at every level. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    const object = value as Row;
    return `{${Object.keys(object)
      .sort()
      .filter((key) => object[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical(object[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** SHA-256 of the config as canonical JSON. */
export function configHash(config: Config | null | undefined): string {
  return createHash('sha256')
    .update(canonical(config ?? {}))
    .digest('hex');
}

/** Writes a backup through an open connection (see the head of this file); returns its manifest. */
export function writeBackup(
  handle: MemoryHandle,
  {
    to,
    dataDir,
    now = Date.now,
    commit = null,
    configHash: hash = null,
  }: { to: string; dataDir: string; now?: () => number; commit?: unknown; configHash?: unknown }
): BackupManifest {
  if (fs.existsSync(to) && fs.readdirSync(to).length > 0)
    throw Object.assign(new Error(`${to} is not empty`), { code: 'BACKUP_NOT_EMPTY' });
  const relative = path.relative(path.resolve(dataDir), path.resolve(to));
  if (!relative || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative)))
    throw new Error('backup destination must be outside the data directory');
  fs.mkdirSync(to, { recursive: true, mode: 0o700 });
  fs.chmodSync(to, 0o700);
  dbOf(handle).prepare('VACUUM INTO ?').run(path.join(to, 'memory.db'));
  fs.chmodSync(path.join(to, 'memory.db'), 0o600);
  const databaseFiles = new Set(['', '-wal', '-shm', '.lock'].map((suffix) => path.resolve(handle.path + suffix)));
  const files = ['memory.db'];
  const modes = new Map<string, number>();
  for (const rel of filesUnder(dataDir)) {
    const source = path.join(dataDir, rel);
    if (rel.split(path.sep)[0] === 'run' || databaseFiles.has(path.resolve(source))) continue;
    const out = path.join(to, rel);
    fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
    fs.copyFileSync(source, out);
    fs.chmodSync(out, 0o600);
    modes.set(rel, rel === KEYS_FILE ? 0o600 : fs.statSync(source).mode & 0o777);
    files.push(rel);
  }
  const manifest = {
    v: 1,
    scope: 'persona',
    createdAt: new Date(now()).toISOString(),
    schemaVersion: schemaVersion(dbOf(handle)),
    ...(typeof commit === 'string' && commit ? { engineCommit: commit } : {}),
    ...(typeof hash === 'string' && hash ? { configHash: hash } : {}),
    files: files.map((rel) => ({
      path: rel.split(path.sep).join('/'),
      size: fs.statSync(path.join(to, rel)).size,
      sha256: sha256File(path.join(to, rel)),
      ...(modes.has(rel) ? { mode: modes.get(rel) } : {}),
    })),
    rows: rowCounts(dbOf(handle)),
  };
  fs.writeFileSync(path.join(to, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
  return manifest;
}

/** A backup from a database path, opened read-only (see the head of this file); returns its manifest. */
export function backupDatabase({
  db: dbPath,
  to,
  data = path.dirname(dbPath),
  now = Date.now,
  commit = null,
  configHash: hash = null,
}: {
  db: string;
  to: string;
  data?: string;
  now?: () => number;
  commit?: unknown;
  configHash?: unknown;
}): BackupManifest {
  if (fs.existsSync(to) && fs.readdirSync(to).length > 0) throw new Error(`${to} is not empty`);
  const handle = openMemoryDb(dbPath, { readOnly: true });
  try {
    return writeBackup(handle, { to, dataDir: data, now, commit, configHash: hash });
  } finally {
    handle.close();
  }
}

/**
 * `backupDatabase` on its own thread (backup-worker.ts): the same manifest, and the caller's thread stays free. `at` is
 * the backup's time. Rejects with the backup's own message.
 */
export function backupInWorker(
  args: { db: string; to: string; data: string; at: number },
  workerFile: string | URL = BACKUP_WORKER
): Promise<BackupManifest> {
  return new Promise((resolve, reject) => {
    const worker = new Worker(workerFile, { workerData: args });
    let answered = false;
    worker.once('message', (answer: { manifest: BackupManifest } | { error: string }) => {
      answered = true;
      if ('manifest' in answer) resolve(answer.manifest);
      else reject(new Error(answer.error));
    });
    worker.once('error', reject);
    worker.once('exit', (exit) => {
      if (!answered) reject(new Error(`the backup thread ended without an answer (exit ${exit})`));
    });
  });
}

/**
 * Checks every file of the backup in `from` against its manifest; returns the manifest, throws on a mismatch.
 */
export function checkBackup(from: string): BackupManifest {
  // A manifest is checked field by field below before any field is trusted.
  const manifest = JSON.parse(fs.readFileSync(path.join(from, 'manifest.json'), 'utf8')) as BackupManifest;
  if (manifest?.v !== 1 || !Array.isArray(manifest.files) || !manifest.files.some((file) => file.path === 'memory.db'))
    throw new Error('not a memory database backup');
  for (const file of manifest.files) {
    const abs = path.join(from, ...String(file.path).split('/'));
    if (String(file.path).split('/').includes('..')) throw new Error(`bad path in the manifest: ${file.path}`);
    if (!fs.existsSync(abs)) throw new Error(`missing from the backup: ${file.path}`);
    if (fs.statSync(abs).size !== file.size || sha256File(abs) !== file.sha256)
      throw new Error(`does not match the manifest: ${file.path}`);
  }
  return manifest;
}

/** Checks a backup against its manifest and restores it (see the head of this file); returns the manifest. */
export function restoreDatabase({
  from,
  db: dbPath,
  data = path.dirname(dbPath),
}: {
  from: string;
  db: string;
  data?: string;
}): BackupManifest {
  const manifest = checkBackup(from);
  for (const suffix of ['', '-wal', '-shm', '.lock'])
    if (fs.existsSync(`${dbPath}${suffix}`))
      throw new Error(`${dbPath}${suffix} exists; restore only into an empty path`);
  const personaFiles = manifest.files.filter((file) => file.path !== 'memory.db');
  for (const file of personaFiles) {
    const out = path.join(data, ...String(file.path).split('/'));
    if (fs.existsSync(out)) throw new Error(`${out} exists; restore never overwrites a file`);
  }
  fs.mkdirSync(path.dirname(dbPath), { recursive: true, mode: 0o700 });
  fs.copyFileSync(path.join(from, 'memory.db'), dbPath, fs.constants.COPYFILE_EXCL);
  for (const file of personaFiles) {
    const out = path.join(data, ...String(file.path).split('/'));
    fs.mkdirSync(path.dirname(out), { recursive: true, mode: 0o700 });
    fs.copyFileSync(path.join(from, ...String(file.path).split('/')), out, fs.constants.COPYFILE_EXCL);
    if (typeof file.mode === 'number') fs.chmodSync(out, file.mode);
  }
  const handle = openMemoryDb(dbPath, { readOnly: true });
  try {
    if (schemaVersion(dbOf(handle)) !== manifest.schemaVersion)
      throw new Error('the restored schema version differs from the manifest');
    const rows = rowCounts(dbOf(handle));
    for (const [table, n] of Object.entries(manifest.rows ?? {}))
      if (rows[table] !== n) throw new Error(`the restored row count of ${table} differs from the manifest`);
  } finally {
    handle.close();
  }
  return manifest;
}

/** The backup schedule's settings (see the head of this file), read at the moment of use. */
export function backupSettings(config: unknown, dataDir: string): { hour: number; keep: number; dir: string } {
  const given = (config as Config | null | undefined)?.memoryDb?.backup ?? {};
  const hour = isWholeNumber(given.hour) && given.hour >= 0 && given.hour <= 23 ? given.hour : BACKUP_DEFAULTS.hour;
  const keep = isWholeNumber(given.keep) && given.keep >= 1 ? given.keep : BACKUP_DEFAULTS.keep;
  const dir = typeof given.dir === 'string' && given.dir.trim() ? given.dir : BACKUP_DEFAULTS.dir;
  return { hour, keep, dir: path.resolve(dataDir, dir) };
}

/** The folder name of a backup made at `ms` (UTC). */
export function backupName(ms: number): string {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}-memory`;
}

/** The finished backups under `dir`, oldest first. */
export function backupsIn(dir: string): Array<string> {
  let entries: Array<fs.Dirent> = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(
      (entry) =>
        entry.isDirectory() && NAME_RE.test(entry.name) && fs.existsSync(path.join(dir, entry.name, 'manifest.json'))
    )
    .map((entry) => entry.name)
    .sort();
}

/** The newest finished backup of a UTC day (`YYYY-MM-DD`), or null. */
export function backupOn(dir: string, day: unknown): string | null {
  return (
    backupsIn(dir)
      .filter((name) => name.startsWith(`${asText(day)}-`))
      .at(-1) ?? null
  );
}

/** The unfinished folder a backup is written into before it is renamed to its name. */
export const partialOf = (name: string): string => `${name}${PARTIAL}`;

/** Deletes all but the newest `keep` finished backups and every unfinished one but `except`; returns how many went. */
export async function pruneBackups(
  dir: string,
  keep: number,
  { except = null }: { except?: string | null } = {}
): Promise<number> {
  const finished = backupsIn(dir);
  const names = finished.slice(0, Math.max(0, finished.length - keep));
  let entries: Array<fs.Dirent> = [];
  try {
    entries = await fs.promises.readdir(dir, { withFileTypes: true });
  } catch {
    entries = [];
  }
  for (const entry of entries) {
    if (
      entry.isDirectory() &&
      entry.name !== except &&
      entry.name.endsWith(PARTIAL) &&
      NAME_RE.test(entry.name.slice(0, -PARTIAL.length))
    )
      names.push(entry.name);
  }
  for (const name of names) await fs.promises.rm(path.join(dir, name), { recursive: true, force: true });
  return names.length;
}
