// Backups of the memory database (spec 2026-10-24-memory-authority, section 6 items 4 and 8; stage W4): the exact
// restore is the database, her diary media and the pinned application, schema and config, so a backup holds the first
// two and names the other three.
//
//   writeBackup(handle, { to, dataDir, now, commit, configHash }) -> manifest
//     `VACUUM INTO <to>/memory.db` on the given connection (the service passes its writer connection, so the copy is
//     consistent and no WAL file is copied), a copy of `<dataDir>/media/diary/` under `<to>/media/diary/`, and
//     `<to>/manifest.json`: `v` 1, `createdAt`, `schemaVersion`, `engineCommit` and `configHash` (when given), every
//     file with its size and SHA-256 (the database first, then every diary media file in name order) and the row
//     count of every table. `to` must be new or empty. Not inside a transaction (VACUUM refuses one).
//   backupDatabase({ db, to, data, now, commit, configHash }) -> manifest
//     the same from a database path, opened read-only (the tool's `backup`; the bot's lock is not needed).
//   checkBackup(from) -> manifest
//     every file of the backup against its manifest (size and SHA-256); throws on the first mismatch.
//   restoreDatabase({ from, db, data }) -> manifest
//     checks every file of the backup against its manifest, then copies the database to `db` (which must not exist,
//     nor its -wal, -shm or lock) and the diary media under `data` (no file is overwritten), and checks the restored
//     file's schema version and row counts against the manifest.
//   configHash(config) -> hex     SHA-256 of the config as canonical JSON (keys sorted at every level)
//   backupSettings(config, dataDir) -> { hour, dir, keep }   (the service's switch is `memoryDb.backup.enabled`)
//     `memoryDb.backup.hour` (UTC, an integer 0-23, default 3), `memoryDb.backup.dir` resolved against the data
//     directory (default `../backups/memory`: beside `data/`, never inside it), `memoryDb.backup.keep` (a whole number
//     1 or more, default 7).
//   backupName(ms) -> 'YYYY-MM-DD-HHMMSS-memory'     the folder of one backup (UTC; names sort by time)
//   backupsIn(dir) -> names       the finished backups (folders with that name and a manifest), oldest first
//   backupOn(dir, day) -> name|null      the newest finished backup of a UTC day
//   pruneBackups(dir, keep) -> removed   deletes all but the newest `keep` finished backups, and every unfinished one
//                                        (`<name>.partial`) but `except`; never anything else under `dir`
// Paths only from the config and the data directory; nothing here logs.

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { openMemoryDb, schemaVersion } from './open.js';

/** The diary media folder under the data directory. */
export const DIARY_MEDIA = path.join('media', 'diary');
/** `memoryDb.backup.*` when missing (config.json carries the same). */
export const BACKUP_DEFAULTS = Object.freeze({ enabled: false, hour: 3, dir: '../backups/memory', keep: 7 });
/** A finished backup's folder name. */
const NAME_RE = /^\d{4}-\d{2}-\d{2}-\d{6}-memory$/;
const PARTIAL = '.partial';

const sha256File = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** The files under `dir`, relative, in name order (none when it does not exist). */
export function filesUnder(dir) {
  if (!fs.existsSync(dir)) return [];
  const out = [];
  const visit = (rel) => {
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
export function tablesOf(db) {
  const rows = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all();
  const virtual = new Set(rows.filter((row) => /^CREATE VIRTUAL TABLE/i.test(row.sql ?? '')).map((row) => row.name));
  return rows
    .map((row) => row.name)
    .filter((name) => ![...virtual].some((v) => name.startsWith(`${v}_`)))
    .map((name) => ({ name, virtual: virtual.has(name) }));
}

/** Row counts of every table (tablesOf), by name. */
export function rowCounts(db) {
  return Object.fromEntries(
    tablesOf(db).map(({ name }) => [name, db.prepare(`SELECT COUNT(*) AS n FROM "${name}"`).get().n])
  );
}

/** Canonical JSON: keys sorted at every level. */
function canonical(value) {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value !== null && typeof value === 'object') {
    return `{${Object.keys(value)
      .sort()
      .filter((key) => value[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${canonical(value[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

/** SHA-256 of the config as canonical JSON. */
export function configHash(config) {
  return createHash('sha256')
    .update(canonical(config ?? {}))
    .digest('hex');
}

/** Writes a backup through an open connection (see the head of this file); returns its manifest. */
export function writeBackup(handle, { to, dataDir, now = Date.now, commit = null, configHash: hash = null }) {
  if (fs.existsSync(to) && fs.readdirSync(to).length > 0)
    throw Object.assign(new Error(`${to} is not empty`), { code: 'BACKUP_NOT_EMPTY' });
  fs.mkdirSync(to, { recursive: true });
  handle.db.prepare('VACUUM INTO ?').run(path.join(to, 'memory.db'));
  const files = ['memory.db'];
  for (const rel of filesUnder(path.join(dataDir, DIARY_MEDIA))) {
    const out = path.join(to, DIARY_MEDIA, rel);
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.copyFileSync(path.join(dataDir, DIARY_MEDIA, rel), out);
    files.push(path.join(DIARY_MEDIA, rel));
  }
  const manifest = {
    v: 1,
    createdAt: new Date(now()).toISOString(),
    schemaVersion: schemaVersion(handle.db),
    ...(typeof commit === 'string' && commit ? { engineCommit: commit } : {}),
    ...(typeof hash === 'string' && hash ? { configHash: hash } : {}),
    files: files.map((rel) => ({
      path: rel.split(path.sep).join('/'),
      size: fs.statSync(path.join(to, rel)).size,
      sha256: sha256File(path.join(to, rel)),
    })),
    rows: rowCounts(handle.db),
  };
  fs.writeFileSync(path.join(to, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`);
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
}) {
  if (fs.existsSync(to) && fs.readdirSync(to).length > 0) throw new Error(`${to} is not empty`);
  const handle = openMemoryDb(dbPath, { readOnly: true });
  try {
    return writeBackup(handle, { to, dataDir: data, now, commit, configHash: hash });
  } finally {
    handle.close();
  }
}

/**
 * Checks every file of the backup in `from` against its manifest; returns the manifest, throws on a mismatch.
 * @param {string} from
 * @returns {{ v: number, schemaVersion: number, files: Array<{ path: string, size: number, sha256: string }>, rows?: Record<string, number> }}
 */
export function checkBackup(from) {
  // A manifest is checked field by field below before any field is trusted.
  const manifest =
    /** @type {{ v: number, schemaVersion: number, files: Array<{ path: string, size: number, sha256: string }>, rows?: Record<string, number> }} */ (
      JSON.parse(fs.readFileSync(path.join(from, 'manifest.json'), 'utf8'))
    );
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
export function restoreDatabase({ from, db: dbPath, data = path.dirname(dbPath) }) {
  const manifest = checkBackup(from);
  for (const suffix of ['', '-wal', '-shm', '.lock'])
    if (fs.existsSync(`${dbPath}${suffix}`))
      throw new Error(`${dbPath}${suffix} exists; restore only into an empty path`);
  const media = manifest.files.filter((file) => file.path !== 'memory.db');
  for (const file of media) {
    const out = path.join(data, ...String(file.path).split('/'));
    if (fs.existsSync(out)) throw new Error(`${out} exists; restore never overwrites a file`);
  }
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  fs.copyFileSync(path.join(from, 'memory.db'), dbPath, fs.constants.COPYFILE_EXCL);
  for (const file of media) {
    const out = path.join(data, ...String(file.path).split('/'));
    fs.mkdirSync(path.dirname(out), { recursive: true });
    fs.copyFileSync(path.join(from, ...String(file.path).split('/')), out, fs.constants.COPYFILE_EXCL);
  }
  const handle = openMemoryDb(dbPath, { readOnly: true });
  try {
    if (schemaVersion(handle.db) !== manifest.schemaVersion)
      throw new Error('the restored schema version differs from the manifest');
    const rows = rowCounts(handle.db);
    for (const [table, n] of Object.entries(manifest.rows ?? {}))
      if (rows[table] !== n) throw new Error(`the restored row count of ${table} differs from the manifest`);
  } finally {
    handle.close();
  }
  return manifest;
}

/** The backup schedule's settings (see the head of this file), read at the moment of use. */
export function backupSettings(config, dataDir) {
  const given = config?.memoryDb?.backup ?? {};
  const hour = Number.isInteger(given.hour) && given.hour >= 0 && given.hour <= 23 ? given.hour : BACKUP_DEFAULTS.hour;
  const keep = Number.isInteger(given.keep) && given.keep >= 1 ? given.keep : BACKUP_DEFAULTS.keep;
  const dir = typeof given.dir === 'string' && given.dir.trim() ? given.dir : BACKUP_DEFAULTS.dir;
  return { hour, keep, dir: path.resolve(dataDir, dir) };
}

/** The folder name of a backup made at `ms` (UTC). */
export function backupName(ms) {
  const iso = new Date(ms).toISOString();
  return `${iso.slice(0, 10)}-${iso.slice(11, 13)}${iso.slice(14, 16)}${iso.slice(17, 19)}-memory`;
}

/** The finished backups under `dir`, oldest first. */
export function backupsIn(dir) {
  let entries = [];
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
export function backupOn(dir, day) {
  return (
    backupsIn(dir)
      .filter((name) => name.startsWith(`${day}-`))
      .at(-1) ?? null
  );
}

/** The unfinished folder a backup is written into before it is renamed to its name. */
export const partialOf = (name) => `${name}${PARTIAL}`;

/** Deletes all but the newest `keep` finished backups and every unfinished one but `except`; returns how many went. */
export function pruneBackups(dir, keep, { except = null } = {}) {
  let removed = 0;
  const finished = backupsIn(dir);
  for (const name of finished.slice(0, Math.max(0, finished.length - keep))) {
    fs.rmSync(path.join(dir, name), { recursive: true, force: true });
    removed += 1;
  }
  let entries = [];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return removed;
  }
  for (const entry of entries) {
    if (
      !entry.isDirectory() ||
      entry.name === except ||
      !entry.name.endsWith(PARTIAL) ||
      !NAME_RE.test(entry.name.slice(0, -PARTIAL.length))
    )
      continue;
    fs.rmSync(path.join(dir, entry.name), { recursive: true, force: true });
    removed += 1;
  }
  return removed;
}
