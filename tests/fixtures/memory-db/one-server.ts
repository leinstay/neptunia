// The input of the offline conversion: the frozen synthetic database of one Discord server at schema v28
// (one-server-v28.sql) as a closed file in WAL mode, the config beside it, and the command run as a separate process with
// an empty environment, so nothing of a deployment can reach it.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { fileURLToPath } from 'node:url';
import { tempDir } from '../tmp.ts';

const ROOT = fileURLToPath(new URL('../../..', import.meta.url));
const SQL = fileURLToPath(new URL('./one-server-v28.sql', import.meta.url));
export const SCRIPT = path.join(ROOT, 'scripts', 'memory-convert-places.ts');

export type Row = Record<string, unknown>;
export type Scene = {
  input: string;
  configIn: string;
  outDir: string;
  output: string;
  configOut: string;
  report: string;
};

export const CONFIG = {
  bot: { timezone: 'UTC', guildId: 'g1', owners: ['u1'] },
  memory: { mainChannelIds: ['c1'], aliasHalfLifeDays: 3 },
  selfreflection: { enabled: true },
};

/** Fresh input files in a fresh folder. `edit` changes the database before it is closed, foreign keys off. */
export function scene(edit?: (db: DatabaseSync) => void): Scene {
  const root = tempDir('nep-convert-');
  const input = path.join(root, 'in', 'memory.db');
  const configIn = path.join(root, 'in', 'config');
  const outDir = path.join(root, 'out');
  fs.mkdirSync(configIn, { recursive: true });
  fs.mkdirSync(outDir, { recursive: true });
  fs.writeFileSync(path.join(configIn, 'config.json'), `${JSON.stringify(CONFIG, null, 2)}\n`);
  const db = new DatabaseSync(input);
  db.exec(fs.readFileSync(SQL, 'utf8'));
  db.exec('PRAGMA foreign_keys = OFF');
  edit?.(db);
  db.exec('PRAGMA journal_mode = WAL');
  db.close();
  return {
    input,
    configIn,
    outDir,
    output: path.join(outDir, 'memory.db'),
    configOut: path.join(outDir, 'config'),
    report: path.join(outDir, 'report.json'),
  };
}

/** The command: `memory-convert-places.ts --input --output --config-in --config-out --report --now`. */
export function convert(where: Scene): { status: number | null; stderr: string } {
  const done = spawnSync(
    process.execPath,
    [
      SCRIPT,
      '--input',
      where.input,
      '--output',
      where.output,
      '--config-in',
      where.configIn,
      '--config-out',
      where.configOut,
      '--report',
      where.report,
      '--now',
      '2026-11-06T00:00:00.000Z',
    ],
    { cwd: ROOT, env: { PATH: process.env.PATH, TMPDIR: process.env.TMPDIR }, encoding: 'utf8', timeout: 60000 }
  );
  return { status: done.status, stderr: done.stderr };
}

export const sha256 = (file: string): string => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** Every row of `table` in a stable order, the columns in `except` left out. */
export function rowsOf(file: string, table: string, except: ReadonlyArray<string> = []): Array<Row> {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (db.prepare(`SELECT * FROM "${table}"`).all() as Array<Row>)
      .map((row) => Object.fromEntries(Object.entries(row).filter(([key]) => !except.includes(key))))
      .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));
  } finally {
    db.close();
  }
}

/** The ordinary tables of a database file: no FTS shadow, no sqlite table. */
export function tablesOf(file: string): Array<string> {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return (db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table'").all() as Array<Row>)
      .filter((row) => !/^(sqlite_|(sources|media)_(fts|tri)_)/.test(String(row.name)) && !/VIRTUAL/i.test(String(row.sql)))
      .map((row) => String(row.name))
      .sort();
  } finally {
    db.close();
  }
}
