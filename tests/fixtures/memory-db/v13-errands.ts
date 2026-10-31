// A memory database at schema v13 with the errand and intention units the way the code before the errand rename wrote
// them: `guilds/<g>/tasks.json` and `tasks.jsonl` as `files`, `work`, `work_events` and `operational` rows,
// `intentions.json` and its archive as `intentions` rows. The rows are inserted by hand, because the writers of the
// current code write the new unit names. Used by the tests of schema v14 and of the errand boundary. Synthetic data
// only.
import { MIGRATIONS, openMemoryDb } from '../../../src/memory/db/open.js';

export type Row = Record<string, unknown>;
type Statement = {
  all(...args: Array<unknown>): Array<Row>;
  get(...args: Array<unknown>): Row | undefined;
  run(...args: Array<unknown>): unknown;
};
export type Db = { prepare(sql: string): Statement; exec(sql: string): void };
export type Record13 = Record<string, unknown> & { id: string };

/** The connection of an opened handle, typed for what these tests do with it (`openMemoryDb` types it as `object`). */
export function dbOf(handle: { db: object }): Db {
  // The handle's `db` is a node:sqlite DatabaseSync; the tests use prepare, all, get, run and exec only.
  return handle.db as Db;
}

/**
 * A database file at v13 (the migrations before v14), opened for writing. A database of that time had no task board,
 * so none is created: the current code's first open builds it over the errands these rows hold (board v3).
 */
export function openV13(file: string): { db: Db; close(): void } {
  const handle = openMemoryDb(file, { migrations: MIGRATIONS.slice(0, 13), boardMigrations: [] });
  return { db: dbOf(handle), close: () => handle.close() };
}

/** The same file opened by the current code: every migration applied. */
export function openCurrent(file: string): { db: Db; close(): void } {
  const handle = openMemoryDb(file);
  return { db: dbOf(handle), close: () => handle.close() };
}

const NOW_ISO = '2026-10-20T10:00:00.000Z';

/** One `files` row for a unit. */
export function putFile(db: Db, unit: string, kind: string, lines: number | null = null): void {
  db.prepare(
    'INSERT INTO files (path, kind, size, mtime_ms, sha1, offset, synced_at, lines, tail_sha1, bad, gone_at) VALUES (?, ?, NULL, NULL, NULL, NULL, ?, ?, NULL, NULL, NULL)'
  ).run(unit, kind, NOW_ISO, lines);
}

/**
 * The unit `guilds/<guild>/tasks.json` (the list) and `tasks.jsonl` (the transitions) of one guild, as the writer of
 * schema v13 laid them out: a `work` row per errand with its record verbatim, one `work_events` row per transition
 * line, one `operational` row (kind `tasks`) with `$has: ["tasks"]` and `extra` beside it.
 */
export function putTaskUnits(
  db: Db,
  guild: string,
  errands: Array<Record13>,
  lines: Array<Record13 & { at: number }>,
  extra: Row = {}
): void {
  const list = `guilds/${guild}/tasks.json`;
  const events = `guilds/${guild}/tasks.jsonl`;
  putFile(db, list, 'tasks');
  putFile(db, events, 'tasks', lines.length);
  const work = db.prepare(
    `INSERT INTO work (id, kind, state, record, created_ms, updated_ms, outcome, seen, scope_kind, owner_file, position)
      VALUES (?, 'errand', ?, ?, ?, ?, NULL, ?, 'group', ?, ?)`
  );
  errands.forEach((errand, position) => {
    work.run(
      errand.id,
      errand.state,
      JSON.stringify(errand),
      errand.createdAt ?? null,
      errand.endedAt ?? errand.startedAt ?? errand.createdAt ?? null,
      errand.seen === true ? 1 : 0,
      list,
      position
    );
  });
  const event = db.prepare(
    'INSERT INTO work_events (id, work_id, at_ms, record, owner_file, position) VALUES (?, ?, ?, ?, ?, ?)'
  );
  lines.forEach((line, position) => {
    event.run(`${line.id}:${line.at}:${position}`, line.id, line.at, JSON.stringify(line), events, position);
  });
  db.prepare("INSERT INTO operational (kind, owner, value, owner_file) VALUES ('tasks', ?, ?, ?)").run(
    list,
    JSON.stringify({ ...extra, $has: ['tasks'] }),
    list
  );
}

/**
 * The unit `guilds/<guild>/intentions.json` and, when `archived` has records, `intentions-archive.jsonl`, as schema
 * v13 laid them out: an `intentions` row per record, the record verbatim, one `operational` row (kind `intentions`).
 */
export function putIntentionUnits(db: Db, guild: string, open: Array<Record13>, archived: Array<Record13> = []): void {
  const list = `guilds/${guild}/intentions.json`;
  const archive = `guilds/${guild}/intentions-archive.jsonl`;
  putFile(db, list, 'intentions');
  const insert = db.prepare(
    `INSERT INTO intentions (id, record, status, due_ms, created_ms, updated_ms, scope_kind, archived, owner_file, position)
      VALUES (?, ?, ?, ?, ?, ?, 'group', ?, ?, ?)`
  );
  const put = (record: Record13, owner: string, flag: number, position: number): void => {
    insert.run(
      record.id,
      JSON.stringify(record),
      record.status ?? null,
      record.dueAt ?? null,
      record.createdAt ?? null,
      record.updatedAt ?? null,
      flag,
      owner,
      position
    );
  };
  open.forEach((record, position) => put(record, list, 0, position));
  db.prepare("INSERT INTO operational (kind, owner, value, owner_file) VALUES ('intentions', ?, ?, ?)").run(
    list,
    JSON.stringify({ $has: ['intentions'] }),
    list
  );
  if (archived.length > 0) {
    putFile(db, archive, 'intentions', archived.length);
    archived.forEach((record, position) => put(record, archive, 1, position));
  }
}

/**
 * Every table of the database as `{ table: rows }`, rows in rowid order, JSON text as it is stored. Virtual tables and
 * their shadow tables are left out (the full-text and trigram indexes), as is every table named in `skip`.
 */
export function dumpTables(db: Db, skip: ReadonlyArray<string> = []): Record<string, Array<Row>> {
  const tables = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all();
  const virtual = tables.filter((table) => String(table.sql).startsWith('CREATE VIRTUAL')).map((table) => table.name);
  const out: Record<string, Array<Row>> = {};
  for (const table of tables) {
    const name = String(table.name);
    if (skip.includes(name)) continue;
    if (virtual.some((prefix) => name.startsWith(`${String(prefix)}_`) || name === prefix)) continue;
    out[name] = db.prepare(`SELECT * FROM "${name}" ORDER BY rowid`).all();
  }
  return out;
}
