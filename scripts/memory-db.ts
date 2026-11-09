#!/usr/bin/env node
// Operations tool for the memory database (`data/memory.db`, spec: the memory store). Run from a checkout:
//
//   node scripts/memory-db.ts stats --db <file>
//        Row counts of every table of the schema (sqlite_master), per scope kind where a table has scopes, and per
//        audience where it has `audience_id` (none, internal, each interface's group, DM rows with the number of DM
//        places; no ids printed).
//   node scripts/memory-db.ts hash --db <file> [--tables a,b]
//        One content hash per table (SHA-256 of every row in primary-key order, every column, retired rows included; a
//        table without a primary key in the order of all its columns; a full-text table by its index content, so two
//        files holding the same rows and the same index hash the same whatever their page layout). The round-trip
//        contract: a `VACUUM INTO` copy hashes like its source. Opens the database read-only.
//   node scripts/memory-db.ts reproject --db <file>
//        Projects every typed row into the graph again (src/memory/db/graph.ts#reproject; idempotent), and finishes a
//        projection the v9 migration left pending.
//   node scripts/memory-db.ts rebuild --db <file>
//        The rebuildability contract: drops the derived rows (the graph projection and its `node_access`) and builds
//        them again from the typed tables, then rebuilds the full-text indexes. Prints the hashes of the derived tables
//        before and after. An edge the graph had retired because its row no longer produces it is history the typed
//        tables do not hold: a rebuild does not bring it back (it says how many such edges there were).
//   node scripts/memory-db.ts index-policy --db <file> [--apply] [--days <n>]
//        The index policy (src/memory/db/index-policy.ts): the tier of every stored line and the vectors outside the
//        owner's classes (older than --days, default `recall.db.vectorDays` 90, and not cited, pinned, touched or
//        consolidated). Without --apply it prints what it would evict and changes nothing (read-only); with --apply it
//        writes the tiers and evicts (the vector rows stay, only their bytes go).
//   node scripts/memory-db.ts media-check --db <file> --data <dir> [--apply]
//        Her selfreflection media: each `media` row of kind selfreflection is `present` when its file under the data directory exists
//        with the stored size, else `missing`; every other row stays `unknown`. Prints the counts; --apply writes them.
//   node scripts/memory-db.ts restore-tables --part board|memory --from <backup dir> --db <file>
//        Brings one part of the database back from a backup and leaves the other as it is. The backup is a folder
//        that holds a `memory.db`, refused when it holds none. `board` replaces every `board_*` table (`board_schema_version` included)
//        with the backup's; `memory` replaces every other table, the full-text indexes rebuilt from the restored
//        lines. Refused, with nothing changed, when the part's schema versions differ between the two files.
//   node scripts/memory-db.ts board list --db <file> [--json]
//   node scripts/memory-db.ts board show <id> --db <file> [--json]
//        The task board read with the core down or running: every task, or one task with its dependencies,
//        attempts, questions, reviews, results, comments and latest events. Opens the database read-only. `--json`
//        prints one line, the answer of `task.list` or `task.show`. An unknown id, or a board that is not at the
//        engine's version, exits 1.
//   node scripts/memory-db.ts board verify-errands --db <file> [--json]
//        Compares every errand of the `work` archive with the errand its board task holds since board v3, field by
//        field over the record (src/board/archive.ts#compareArchive). Opens the database read-only. `--json` prints
//        one line, `{ checked, mismatches: [{ id, field }] }`, the field `missing` for an errand with no task. Exits 0
//        with no mismatch, 1 with any.
//
// reproject, rebuild, restore-tables, index-policy --apply and media-check --apply take the database's writer lock
// and refuse while the bot (or another tool) holds it.
// The database is never added to git. Nothing here starts the bot or calls a model.

import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { createHash } from 'node:crypto';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { rebuildGraph, reproject, projectPending } from '../src/memory/db/graph.ts';
import { checkMedia, classify as classifyIndex } from '../src/memory/db/index-policy.ts';
import { readBoard } from '../src/board/board.ts';
import { compareArchive } from '../src/board/archive.ts';
import { BoardError } from '../src/board/machine.ts';
import type { BoardDb as BoardDbShape } from '../src/board/schema.ts';
import type { Db } from '../src/memory/db/types.ts';
import type { Untyped } from '../src/tools/types.ts';
import { sqlOf } from './lib/sql.ts';
import type { SqlDb } from './lib/sql.ts';
import type { TaskView } from '../src/board/board.ts';

/** An object read by key whose values are not typed yet. */
type Rec = Record<string, Untyped>;

const FLAGS = new Set(['apply', 'json']);

function parseArgs(argv: Untyped) {
  const [command, ...rest] = argv;
  const options: Untyped = {};
  const positionals: Array<string> = [];
  // `board` takes its subcommand and an id before its flags.
  while (command === 'board' && rest.length && !rest[0].startsWith('--')) positionals.push(rest.shift());
  options._ = positionals;
  for (let i = 0; i < rest.length; i += 1) {
    const arg = rest[i];
    if (!arg.startsWith('--')) throw new Error(`unexpected argument ${arg}`);
    const name = arg.slice(2);
    if (FLAGS.has(name)) options[name] = true;
    else {
      if (i + 1 >= rest.length) throw new Error(`--${name} needs a value`);
      options[name] = rest[(i += 1)];
    }
  }
  return { command, options };
}

const need = (options: Untyped, ...names: Array<Untyped>) => {
  for (const name of names) if (!options[name]) throw new Error(`--${name} is required`);
};

const seconds = (start: Untyped) => `${((performance.now() - start) / 1000).toFixed(1)}s`;

// ---------- stats ----------

function runStats(io: Rec, options: Untyped) {
  need(options, 'db');
  const handle = openMemoryDb(options.db, { readOnly: true });
  try {
    const db = sqlOf(handle);
    for (const { name: table } of db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()) {
      const columns = new Set(
        db
          .prepare(`PRAGMA table_info("${table}")`)
          .all()
          .map((column: Rec) => String(column.name))
      );
      const total = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n;
      let line = `${table.padEnd(22)} ${String(total).padStart(8)}`;
      if (columns.has('retired_at'))
        line += `  retired ${db.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE retired_at IS NOT NULL`).get().n}`;
      if (columns.has('scope_kind') && total) {
        const scopes = db
          .prepare(`SELECT scope_kind AS k, COUNT(*) AS n FROM "${table}" GROUP BY scope_kind ORDER BY k`)
          .all();
        line += `  scope ${scopes.map((scope: Rec) => `${scope.k ?? 'null'}=${scope.n}`).join(' ')}`;
      }
      if (columns.has('audience_id') && total) {
        const kinds = db
          .prepare(
            `SELECT CASE WHEN audience_id IS NULL THEN 'null' WHEN audience_id LIKE 'aud:dm:%' THEN 'dm' ELSE substr(audience_id, 5) END AS k,
          COUNT(*) AS n, COUNT(DISTINCT CASE WHEN audience_id LIKE 'aud:dm:%' THEN audience_id END) AS places FROM "${table}" GROUP BY 1 ORDER BY 1`
          )
          .all();
        line += `  audience ${kinds.map((kind: Untyped) => `${kind.k}=${kind.n}${kind.k === 'dm' ? ` (${kind.places} places)` : ''}`).join(' ')}`;
      }
      io.out(line);
    }
    return 0;
  } finally {
    handle.close();
  }
}

// ---------- hash, reproject, rebuild ----------

const valueOf = (value: Untyped) => {
  if (value instanceof Uint8Array) return ['blob', Buffer.from(value).toString('hex')];
  if (typeof value === 'bigint') return ['int', String(value)];
  return [value === null ? 'null' : typeof value, value];
};

/** The tables of a database (no SQLite internals), with the virtual ones marked and their shadow tables left out. */
function tablesOf(db: Pick<Db, 'prepare'>): Array<{ name: string; virtual: boolean }> {
  const rows = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row) => ({ name: String(row.name), sql: typeof row.sql === 'string' ? row.sql : '' }));
  const virtual = new Set(rows.filter((row) => /^CREATE VIRTUAL TABLE/i.test(row.sql)).map((row) => row.name));
  return rows
    .map((row) => row.name)
    .filter((name) => ![...virtual].some((v) => name.startsWith(`${v}_`)))
    .map((name) => ({ name, virtual: virtual.has(name) }));
}

/**
 * The content hash of every table (or of `only`): `[{ table, rows, hash }]`. Rows in primary-key order, every column;
 * a table without a primary key in the order of all its columns; a full-text table by its index content (fts5vocab
 * `instance`: every term, row, column and offset).
 * @param db node:sqlite's DatabaseSync, which open.js types as `object`
 */
export function tableHashes(
  handleDb: unknown,
  tables: unknown = null
): Array<{ table: string; rows: number; hash: string }> {
  const db = handleDb as SqlDb; // the connection under a memory handle, which types it as `object`
  const only = tables as ReadonlyArray<string> | null; // the names to hash, or null for every table
  const out = [];
  for (const { name, virtual } of tablesOf(db)) {
    if (only && !only.includes(name)) continue;
    const hash = createHash('sha256');
    let rows = 0;
    let statement;
    if (virtual) {
      const vocab = `_hash_${name}`;
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS temp."${vocab}" USING fts5vocab(main, "${name}", 'instance')`);
      statement = db.prepare(`SELECT term, doc, col, offset FROM temp."${vocab}" ORDER BY term, doc, col, offset`);
    } else {
      const columns = db.prepare(`PRAGMA table_info("${name}")`).all();
      const keys = columns
        .filter((column: Rec) => column.pk > 0)
        .sort((a: Rec, b: Rec) => a.pk - b.pk)
        .map((column: Rec) => column.name);
      const order = (keys.length ? keys : columns.map((column: Rec) => String(column.name)))
        .map((column: string) => `"${column}"`)
        .join(', ');
      statement = db.prepare(
        `SELECT ${columns.map((column: Rec) => `"${column.name}"`).join(', ')} FROM "${name}" ORDER BY ${order}`
      );
    }
    for (const row of statement.iterate()) {
      hash.update(JSON.stringify(Object.values(row).map(valueOf)));
      hash.update('\n');
      rows += 1;
    }
    out.push({ table: name, rows, hash: hash.digest('hex') });
  }
  return out;
}

function runHash(io: Rec, options: Untyped) {
  need(options, 'db');
  const handle = openMemoryDb(options.db, { readOnly: true });
  try {
    const only = options.tables
      ? String(options.tables)
          .split(',')
          .map((name) => name.trim())
          .filter(Boolean)
      : null;
    const hashes = tableHashes(sqlOf(handle), only);
    for (const { table, rows, hash } of hashes) io.out(`${table.padEnd(26)} ${String(rows).padStart(8)}  ${hash}`);
    const missing = (only ?? []).filter((name) => !hashes.some((entry) => entry.table === name));
    for (const name of missing) io.out(`${name.padEnd(26)} no such table`);
    return missing.length ? 1 : 0;
  } finally {
    handle.close();
  }
}

function runReproject(io: Rec, options: Untyped) {
  need(options, 'db');
  const handle = openMemoryDb(options.db);
  try {
    const at = new Date().toISOString();
    const pending = projectPending(handle, { at });
    const done = reproject(handle, { at });
    io.out(
      `graph: ${done.units} units projected, ${done.edges} edges, ${done.retired} retired as stale, ${done.ms} ms${pending.units ? ` (the pending projection took ${pending.ms} ms)` : ''}`
    );
    return 0;
  } finally {
    handle.close();
  }
}

/** The derived tables the rebuild drops and builds again. */
export const DERIVED_TABLES = [
  'graph_nodes',
  'graph_edges',
  'node_access',
  'sources_fts',
  'sources_tri',
  'media_fts',
  'media_tri',
];

function runRebuild(io: Rec, options: Untyped) {
  need(options, 'db');
  const handle = openMemoryDb(options.db);
  try {
    const before = tableHashes(sqlOf(handle), DERIVED_TABLES);
    const stale = sqlOf(handle).prepare('SELECT COUNT(*) AS n FROM graph_edges WHERE retired_at IS NOT NULL').get().n;
    const done = rebuildGraph(handle, { at: new Date().toISOString() });
    handle.transaction(() => {
      sqlOf(handle).exec(
        "INSERT INTO sources_fts(sources_fts) VALUES ('rebuild'); INSERT INTO sources_tri(sources_tri) VALUES ('rebuild'); INSERT INTO media_fts(media_fts) VALUES ('rebuild'); INSERT INTO media_tri(media_tri) VALUES ('rebuild');"
      );
    });
    const after = tableHashes(sqlOf(handle), DERIVED_TABLES);
    const keptRetired = sqlOf(handle)
      .prepare('SELECT COUNT(*) AS n FROM graph_edges WHERE retired_at IS NOT NULL')
      .get().n;
    io.out(
      `graph rebuilt: ${done.units} units, ${done.edges} edges in ${done.ms} ms; retired edges ${stale} before, ${keptRetired} after (the rest were stale: their rows no longer produce them)`
    );
    let differ = 0;
    for (const entry of after) {
      const was = before.find((row) => row.table === entry.table);
      const same = was?.hash === entry.hash;
      if (!same) differ += 1;
      io.out(
        `${entry.table.padEnd(26)} ${String(was?.rows ?? 0).padStart(8)} -> ${String(entry.rows).padStart(8)}  ${same ? 'equal' : 'differs'}`
      );
    }
    io.out(
      differ ? `rebuild: ${differ} derived tables differ from before` : 'rebuild: every derived table equal to before'
    );
    return 0;
  } finally {
    handle.close();
  }
}

// ---------- index policy, media ----------

function runIndexPolicy(io: Rec, options: Untyped) {
  need(options, 'db');
  const apply = options.apply === true;
  const days = options.days === undefined ? undefined : Number(options.days);
  if (days !== undefined && !(Number.isFinite(days) && days > 0)) throw new Error('--days must be a positive number');
  const handle = openMemoryDb(options.db, { readOnly: !apply });
  try {
    const config = { recall: { db: { ...(days ? { vectorDays: days } : {}), vectorEviction: apply } } };
    const done = classifyIndex(handle, { now: Date.now(), config, apply, evict: apply });
    io.out(
      `tiers: a ${done.tiers.a}, b ${done.tiers.b}, c ${done.tiers.c} (${Object.entries(done.reasons)
        .sort()
        .map(([reason, n]) => `${reason} ${n}`)
        .join(', ')})`
    );
    const kept = done.vectors.kept;
    io.out(
      `vectors kept: recent ${kept.recent}, cited ${kept.cited}, pinned ${kept.pinned}, touched ${kept.touch}, consolidated ${kept.consolidated}, unlinked ${kept.unlinked}; evicted before ${done.vectors.evicted}`
    );
    io.out(
      apply
        ? `evicted now: ${done.evictedNow}`
        : `would evict: ${done.vectors.evict} (dry run: nothing written; --apply to evict)`
    );
    return 0;
  } finally {
    handle.close();
  }
}

function runMediaCheck(io: Rec, options: Untyped) {
  need(options, 'db', 'data');
  const apply = options.apply === true;
  const handle = openMemoryDb(options.db, { readOnly: !apply });
  try {
    const done = checkMedia(handle, { dataDir: options.data, apply });
    io.out(
      `media: present ${done.present}, missing ${done.missing}, unknown ${done.unknown}; ${apply ? 'marked' : 'would mark'} ${done.changed}`
    );
    return 0;
  } finally {
    handle.close();
  }
}

// ---------- restore-tables ----------

type BoardDb = BoardDbShape & Db;
type Io = { out: (line: string) => void; err: (line: string) => void };

const isBoardTable = (name: string) => name.startsWith('board_');

/** The names `schema`'s sqlite_master lists for `sql` (a query of `name` and `sql`). */
const namesOf = (db: BoardDb, query: string, params: Array<unknown> = []): Array<{ name: string; sql: string }> =>
  db
    .prepare(query)
    .all(...params)
    .map((row) => ({ name: String(row.name), sql: typeof row.sql === 'string' ? row.sql : '' }));

/**
 * The plain tables of one part of the database `schema` names (`main` or `backup`): every board table, or every other
 * table, without the SQLite internals and without the full-text tables and their storage, which a memory restore
 * rebuilds from the restored lines.
 */
function partTables(db: BoardDb, schema: string, part: 'board' | 'memory'): Array<string> {
  const rows = namesOf(
    db,
    `SELECT name, sql FROM "${schema}".sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name`
  );
  const virtual = rows.filter((row) => /^CREATE VIRTUAL TABLE/i.test(row.sql)).map((row) => row.name);
  return rows
    .map((row) => row.name)
    .filter((name) => !virtual.some((v) => name === v || name.startsWith(`${v}_`)))
    .filter((name) => (part === 'board' ? isBoardTable(name) : !isBoardTable(name)));
}

/** Whether the database `schema` names has the table `table`. */
const hasTable = (db: BoardDb, schema: string, table: string) =>
  db.prepare(`SELECT 1 AS ok FROM "${schema}".sqlite_master WHERE type = 'table' AND name = ?`).get(table) !==
  undefined;

/** The version a part is at in the database `schema` names; 0 when it has none. */
function partVersion(db: BoardDb, schema: string, part: 'board' | 'memory'): number {
  const table = part === 'board' ? 'board_schema_version' : 'schema_version';
  if (!hasTable(db, schema, table)) return 0;
  return Number(db.prepare(`SELECT MAX(version) AS v FROM "${schema}"."${table}"`).get()?.v ?? 0);
}

/** Copies the part's rows of `sqlite_sequence` (the AUTOINCREMENT counters) from the backup. */
function copySequences(db: BoardDb, part: 'board' | 'memory') {
  if (!hasTable(db, 'main', 'sqlite_sequence') || !hasTable(db, 'backup', 'sqlite_sequence')) return;
  const mine = part === 'board' ? "name LIKE 'board\\_%' ESCAPE '\\'" : "name NOT LIKE 'board\\_%' ESCAPE '\\'";
  db.exec(`DELETE FROM main.sqlite_sequence WHERE ${mine}`);
  db.exec(`INSERT INTO main.sqlite_sequence (name, seq) SELECT name, seq FROM backup.sqlite_sequence WHERE ${mine}`);
}

/**
 * Copies every table of `tables` from the backup; for the memory part the triggers are dropped for the copy and made
 * again from the database's own definitions, the full-text indexes rebuilt and the foreign keys checked.
 */
function copyPart(db: BoardDb, part: 'board' | 'memory', tables: Array<string>) {
  const triggers =
    part === 'memory'
      ? namesOf(db, "SELECT name, sql FROM main.sqlite_master WHERE type = 'trigger' AND sql IS NOT NULL")
      : [];
  for (const trigger of triggers) db.exec(`DROP TRIGGER main."${trigger.name}"`);
  for (const table of tables) {
    const columns = db
      .prepare(`PRAGMA main.table_info("${table}")`)
      .all()
      .map((column) => `"${String(column.name)}"`)
      .join(', ');
    db.exec(`DELETE FROM main."${table}"`);
    db.exec(`INSERT INTO main."${table}" (${columns}) SELECT ${columns} FROM backup."${table}"`);
  }
  copySequences(db, part);
  if (part !== 'memory') return;
  for (const { name, virtual } of tablesOf(db)) {
    if (virtual) db.exec(`INSERT INTO main."${name}"("${name}") VALUES ('rebuild')`);
  }
  for (const trigger of triggers) db.exec(trigger.sql);
  const broken = db.prepare('PRAGMA main.foreign_key_check').all();
  if (broken.length) throw new Error(`${broken.length} rows of the restored memory break a foreign key`);
}

/** Replaces one part of the database with the backup's, in one transaction (see the head of this file). */
function runRestoreTables(io: Io, options: Record<string, unknown>): number {
  need(options, 'part', 'from', 'db');
  const { part, from, db: file } = options;
  if (part !== 'board' && part !== 'memory') throw new Error('--part must be board or memory');
  if (typeof from !== 'string' || typeof file !== 'string') throw new Error('--from and --db need a path');
  if (!fs.existsSync(path.join(from, 'memory.db'))) throw new Error(`no memory.db in ${from}; restore refused`);
  const start = performance.now();
  // No migration of either part: a restore leaves the versions as they are, and refuses when they differ.
  const handle = openMemoryDb(file, { migrations: [], boardMigrations: [] });
  // node:sqlite's DatabaseSync, which open.js types as `object`, has every method BoardDb names.
  const db = sqlOf(handle) as BoardDb;
  let attached = false;
  try {
    db.prepare('ATTACH DATABASE ? AS backup').run(path.join(from, 'memory.db'));
    attached = true;
    const here = partVersion(db, 'main', part);
    const there = partVersion(db, 'backup', part);
    if (here !== there) {
      throw new Error(`the ${part} is at version ${here} here and ${there} in the backup; restore refused`);
    }
    const tables = partTables(db, 'main', part);
    if (tables.join(',') !== partTables(db, 'backup', part).join(',')) {
      throw new Error(`the ${part} tables differ from the backup's; restore refused`);
    }
    // Foreign keys cannot be switched inside a transaction; the copy checks them itself before it commits.
    if (part === 'memory') db.exec('PRAGMA foreign_keys = OFF');
    try {
      handle.transaction(() => copyPart(db, part, tables));
    } finally {
      if (part === 'memory') db.exec('PRAGMA foreign_keys = ON');
    }
    io.out(
      `restore-tables ok: the ${part} at version ${here}, ${tables.length} tables from the backup (${seconds(start)})`
    );
    return 0;
  } finally {
    if (attached) db.exec('DETACH DATABASE backup');
    handle.close();
  }
}

// ---------- board ----------

/** Prints one task of `board show` as lines. */
function printTask(io: Io, view: TaskView) {
  const { task } = view;
  const lease = task.lease_owner ? `, held by ${task.lease_owner} until ${task.lease_expires_at ?? '?'}` : '';
  io.out(`${task.id}  ${task.status}  ${task.lane}  ${task.title}`);
  io.out(
    `requester ${task.requester}, risk ${task.risk}, priority ${task.priority}, revision ${task.revision}${lease}`
  );
  io.out(
    `attempts ${view.attempts.length}, questions ${view.questions.length}, reviews ${view.approvals.length}, results ${view.results.length}, comments ${view.comments.length}`
  );
  for (const event of view.events) {
    io.out(`${String(event.seq).padStart(6)}  ${event.created_at}  ${event.actor}  ${event.type}  ${event.new ?? ''}`);
  }
}

/** `board list` and `board show <id>` over a read-only open (see the head of this file). */
function runBoard(io: Io, options: Record<string, unknown>): number {
  need(options, 'db');
  const [sub, id, ...extra] = Array.isArray(options._) ? options._.map(String) : [];
  if (sub === 'verify-errands') return runVerifyErrands(io, options, [id, ...extra]);
  if (sub !== 'list' && sub !== 'show')
    throw new Error('usage: board list|show <id>|verify-errands --db <file> [--json]');
  if (sub === 'show' && !id) throw new Error('board show needs a task id');
  const surplus = sub === 'list' ? [id, ...extra] : extra;
  if (surplus.some((arg) => arg !== undefined)) throw new Error(`unexpected argument ${String(surplus.find(Boolean))}`);
  const handle = openMemoryDb(String(options.db), { readOnly: true });
  try {
    // node:sqlite's DatabaseSync, which open.js types as `object`, has every method BoardDb names.
    const board = readBoard(sqlOf(handle), Date.now);
    if (sub === 'list') {
      const tasks = board.list();
      if (options.json) io.out(JSON.stringify(tasks));
      else
        for (const task of tasks)
          io.out(`${task.id}  ${task.status.padEnd(16)}  p${task.priority}  ${task.lane}  ${task.title}`);
      return 0;
    }
    const view = board.show(String(id));
    if (options.json) io.out(JSON.stringify(view));
    else printTask(io, view);
    return 0;
  } catch (error) {
    // An unknown id or a board at another version is an answer, not a usage error.
    if (error instanceof BoardError && (error.code === 'not-found' || error.code === 'board-unavailable')) {
      io.err(`memory-db: ${error.message}`);
      return 1;
    }
    throw error;
  } finally {
    handle.close();
  }
}

/**
 * `board verify-errands` over a read-only open (see the head of this file).
 * @param surplus the arguments after the subcommand, none expected
 */
function runVerifyErrands(io: Io, options: Record<string, unknown>, surplus: Array<string | undefined>): number {
  const extra = surplus.find((arg) => arg !== undefined);
  if (extra !== undefined) throw new Error(`unexpected argument ${extra}`);
  const handle = openMemoryDb(String(options.db), { readOnly: true });
  try {
    // node:sqlite's DatabaseSync, which open.js types as `object`, has every method BoardDb names.
    const verdict = compareArchive(sqlOf(handle));
    if (options.json) io.out(JSON.stringify(verdict));
    else {
      io.out(`verify-errands: ${verdict.checked} archived errands, ${verdict.mismatches.length} mismatches`);
      for (const { id, field } of verdict.mismatches) io.out(`${id}  ${field}`);
    }
    return verdict.mismatches.length === 0 ? 0 : 1;
  } finally {
    handle.close();
  }
}

// ---------- entry ----------

const COMMANDS: Untyped = {
  stats: runStats,
  hash: runHash,
  reproject: runReproject,
  rebuild: runRebuild,
  'index-policy': runIndexPolicy,
  'media-check': runMediaCheck,
  'restore-tables': runRestoreTables,
  board: runBoard,
};

/** Runs a command line; returns the exit code, or a promise of it. `io` is { out(line), err(line) }. */
export function main(
  argv: Rec,
  io = { out: (line: Untyped) => console.log(line), err: (line: string) => console.error(line) }
): Untyped {
  try {
    const { command, options } = parseArgs(argv);
    const run = COMMANDS[command];
    if (!run) {
      io.err(`usage: memory-db.ts <${Object.keys(COMMANDS).join('|')}> [options] (see the header of this file)`);
      return 2;
    }
    const code = run(io, options);
    if (code && typeof code.then === 'function') {
      return code.catch((error: Untyped) => {
        io.err(`memory-db: ${error.message}`);
        return 2;
      });
    }
    return code;
  } catch (error: Untyped) {
    io.err(`memory-db: ${error.message}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  Promise.resolve(main(process.argv.slice(2))).then((code) => {
    process.exitCode = code;
  });
}
