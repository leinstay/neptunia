#!/usr/bin/env node
// Operations tool for the memory database (`data/memory.db`, spec: the memory store). Run from a checkout:
//
//   node tools/memory-db.mjs import --data <dir> --db <file> [--resume]
//        Reads every memory file under the data directory into a new database. Refuses a database that already has
//        files in it unless --resume (then it is a normal sync).
//   node tools/memory-db.mjs sync --data <dir> --db <file>
//        One sync pass: only the files that changed since the last pass are read; rows that left their file are retired.
//   node tools/memory-db.mjs export --db <file> --to <dir>
//        Writes today's JSON layout from the database alone (an empty or new directory).
//   node tools/memory-db.mjs verify --data <dir> --db <file>
//        Exports to a temporary directory under TMPDIR and compares it file by file with the data directory (JSON deep
//        equal, JSONL line by line parsed, .i8 bytes). Prints, per kind, how many files are equal, differ (key paths
//        only, never values), are missing or extra. Exit 1 on any difference. It does not sync: run `sync` first if
//        the bot has written since the last pass.
//   node tools/memory-db.mjs parity --data <dir> --db <file>
//        Reads every public read of the store twice, from the JSON files and through the database (the read switch,
//        `memoryDb.read`), and compares them deep. Exit 1 on any difference. Run `sync` first; a file that changed on
//        disk since the last sync is read from the disk and counted as stale. Opens the database read-only.
//   node tools/memory-db.mjs stats --db <file>
//        Row counts of every table of the schema (sqlite_master), per scope kind where a table has scopes, and per
//        audience where it has `audience_id` (none, internal, each interface's group, DM rows with the number of DM
//        places; no ids printed).
//   node tools/memory-db.mjs hash --db <file> [--tables a,b]
//        One content hash per table (SHA-256 of every row in primary-key order, every column, retired rows included; a
//        table without a primary key in the order of all its columns; a full-text table by its index content, so two
//        files holding the same rows and the same index hash the same whatever their page layout). The round-trip
//        contract: a `VACUUM INTO` copy hashes like its source. Opens the database read-only.
//   node tools/memory-db.mjs reproject --db <file>
//        Projects every typed row into the graph again (src/memory/db/graph.js#reproject; idempotent), and finishes a
//        projection the v9 migration left pending.
//   node tools/memory-db.mjs rebuild --db <file>
//        The rebuildability contract: drops the derived rows (the graph projection and its `node_access`) and builds
//        them again from the typed tables, then rebuilds the full-text indexes. Prints the hashes of the derived tables
//        before and after. An edge the graph had retired because its row no longer produces it is history the typed
//        tables do not hold: a rebuild does not bring it back (it says how many such edges there were).
//   node tools/memory-db.mjs ledger-import --ledger <ledger.db> --db <file>
//        Copies the task ledger's rows into the reserved ledger_* tables as JSON records (the source is opened
//        read-only).
//
// import, sync, reproject, rebuild and ledger-import take the database's writer lock and refuse while the bot (or another
// tool) holds it.
// The database is never added to git. Nothing here starts the bot or calls a model.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { performance } from 'node:perf_hooks';
import { openMemoryDb } from '../src/memory/db/open.js';
import { syncOnce, walk, forgottenOf, memberOfUnit, lineIsForgotten } from '../src/memory/db/sync.js';
import { exportAll, exportOne, idsUnderDir } from '../src/memory/db/export.js';
import { createStore } from '../src/memory/store.js';
import { isDeepStrictEqual } from 'node:util';
import { classify } from '../src/memory/db/map/index.js';
import { jsonEqual, isPlainObject } from '../src/memory/db/map/common.js';
import { createHash } from 'node:crypto';
import { rebuildGraph, reproject, projectPending } from '../src/memory/db/graph.js';

const FLAGS = new Set(['resume']);

function parseArgs(argv) {
  const [command, ...rest] = argv;
  const options = {};
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

const need = (options, ...names) => {
  for (const name of names) if (!options[name]) throw new Error(`--${name} is required`);
};

const seconds = (start) => `${((performance.now() - start) / 1000).toFixed(1)}s`;

function printSync(io, result) {
  io.out(`files: ${result.seen} seen, ${result.changed} changed, ${result.skipped} not memory, ${result.unknown.length} unknown, ${result.forgotten} forgotten-member files skipped`);
  io.out(`rows: ${result.upserted} upserted, ${result.retired} retired, ${result.errors} errors`);
  for (const [kind, counts] of Object.entries(result.byKind).sort()) {
    io.out(`  ${kind.padEnd(14)} seen ${counts.seen}  changed ${counts.changed}  upserted ${counts.upserted}  retired ${counts.retired}  errors ${counts.errors}`);
  }
  if (result.unknown.length) io.out(`unknown files (first 5): ${result.unknown.slice(0, 5).join(', ')}`);
}

function hasFiles(dbPath) {
  if (!fs.existsSync(dbPath) || fs.statSync(dbPath).size === 0) return false;
  const handle = openMemoryDb(dbPath, { readOnly: true });
  try {
    const table = handle.db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'files'").get();
    return Boolean(table) && handle.db.prepare('SELECT COUNT(*) AS n FROM files').get().n > 0;
  } finally {
    handle.close();
  }
}

const stderrLog = (io) => ({
  info() {},
  debug() {},
  warn: (message, fields) => io.err(`${message} ${JSON.stringify(fields ?? {})}`),
  error: (message, fields) => io.err(`${message} ${JSON.stringify(fields ?? {})}`),
});

function runSync(io, options, { importing }) {
  need(options, 'data', 'db');
  if (importing && !options.resume && hasFiles(options.db)) {
    throw new Error(`${options.db} already holds imported files; use --resume to continue, or a new file`);
  }
  const start = performance.now();
  const handle = openMemoryDb(options.db);
  try {
    const result = syncOnce(handle, options.data, { log: stderrLog(io) });
    printSync(io, result);
    io.out(`${importing ? 'import' : 'sync'} took ${seconds(start)}`);
    return result.errors ? 1 : 0;
  } finally {
    handle.close();
  }
}

function runExport(io, options) {
  need(options, 'db', 'to');
  if (fs.existsSync(options.to) && fs.readdirSync(options.to).length) throw new Error(`${options.to} is not empty`);
  const handle = openMemoryDb(options.db, { readOnly: true });
  try {
    const start = performance.now();
    const result = exportAll(handle, options.to);
    io.out(`exported ${result.files} files in ${seconds(start)}`);
    for (const failed of result.failed) io.out(`failed: ${failed.kind} ${failed.code}`);
    return result.failed.length ? 1 : 0;
  } finally {
    handle.close();
  }
}

// ---------- verify ----------

const MAX_PATHS = 8;

/** Key paths where two JSON values differ (never the values themselves); `a` is the rebuilt value, `b` the live one. */
export function diffPaths(a, b, prefix = '$', out = []) {
  if (out.length >= MAX_PATHS || jsonEqual(a, b)) return out;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) out.push(`${prefix} (length ${a.length} vs ${b.length})`);
    for (let i = 0; i < Math.min(a.length, b.length); i += 1) diffPaths(a[i], b[i], `${prefix}[${i}]`, out);
  } else if (isPlainObject(a) && isPlainObject(b)) {
    for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
      if (!Object.hasOwn(a, key)) out.push(`${prefix}.${key} (only in live)`);
      else if (!Object.hasOwn(b, key)) out.push(`${prefix}.${key} (only in rebuilt)`);
      else diffPaths(a[key], b[key], `${prefix}.${key}`, out);
    }
  } else {
    out.push(`${prefix} (${typeof a} vs ${typeof b})`);
  }
  return out.slice(0, MAX_PATHS);
}

function parseLines(text, forgotten) {
  const values = [];
  let bad = 0;
  for (const line of text.split('\n')) {
    if (!line.trim()) continue;
    try {
      const value = JSON.parse(line);
      if (!lineIsForgotten(value, forgotten)) values.push(value);
    } catch {
      bad += 1;
    }
  }
  return { values, bad };
}

/** Compares one file of the live layout with the rebuilt one: null when equal, else the key paths. */
function compareFile(info, rel, livePath, rebuiltPath, forgotten) {
  if (rel.endsWith('.i8')) {
    return Buffer.compare(fs.readFileSync(livePath), fs.readFileSync(rebuiltPath)) === 0 ? null : ['bytes differ'];
  }
  const live = fs.readFileSync(livePath, 'utf8');
  const rebuilt = fs.readFileSync(rebuiltPath, 'utf8');
  const jsonl = info.format === 'jsonl' || (info.format === 'vectors' && rel.endsWith('.jsonl'));
  if (info.format === 'text') return live === rebuilt ? null : ['text differs'];
  if (jsonl) {
    const a = parseLines(live, forgotten).values;
    const b = parseLines(rebuilt, forgotten).values;
    return jsonEqual(a, b) ? null : diffPaths(b, a, '$');
  }
  let liveValue;
  try {
    liveValue = JSON.parse(live);
  } catch {
    return ['live file is not valid JSON'];
  }
  const value = JSON.parse(rebuilt);
  return jsonEqual(liveValue, value) ? null : diffPaths(value, liveValue, '$');
}

/** Compares a rebuilt layout with the live data directory. Returns { byKind, equal, different } (no values). */
export function compareTrees(dataDir, rebuiltDir) {
  const byKind = {};
  const bucket = (kind) => (byKind[kind] ??= { equal: 0, differs: [], missing: [], extra: [], forgotten: 0 });
  const forgottenByGuild = new Map();
  const forgotten = (guildId) => {
    if (!forgottenByGuild.has(guildId)) forgottenByGuild.set(guildId, forgottenOf(dataDir, guildId));
    return forgottenByGuild.get(guildId);
  };
  const live = new Map();
  for (const file of walk(dataDir)) {
    const info = classify(file.rel);
    if (info && !info.skipped) live.set(file.rel, { info, file });
  }
  const rebuilt = new Map();
  for (const file of walk(rebuiltDir)) {
    const info = classify(file.rel);
    if (info && !info.skipped) rebuilt.set(file.rel, { info, file });
  }
  for (const [rel, { info, file }] of live) {
    const slot = bucket(info.kind);
    const other = rebuilt.get(rel);
    if (!other) {
      const member = info.guildId === undefined ? null : memberOfUnit(info.unit);
      if (member && forgotten(info.guildId).has(member)) slot.forgotten += 1;
      else slot.missing.push(rel);
      continue;
    }
    let paths;
    try {
      paths = compareFile(info, rel, file.abs, other.file.abs, info.guildId === undefined ? new Set() : forgotten(info.guildId));
    } catch (error) {
      paths = [`compare failed (${error?.code ?? error?.name ?? 'ERROR'})`];
    }
    if (paths === null) slot.equal += 1;
    else slot.differs.push({ rel, paths });
  }
  for (const [rel, { info }] of rebuilt) if (!live.has(rel)) bucket(info.kind).extra.push(rel);
  let different = 0;
  for (const slot of Object.values(byKind)) different += slot.differs.length + slot.missing.length + slot.extra.length;
  return { byKind, different };
}

function runVerify(io, options) {
  need(options, 'data', 'db');
  const start = performance.now();
  const handle = openMemoryDb(options.db, { readOnly: true });
  const temp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-verify-'));
  try {
    const exported = exportAll(handle, temp);
    io.out(`rebuilt ${exported.files} files in ${seconds(start)}`);
    for (const failed of exported.failed) io.out(`could not rebuild: ${failed.kind} ${failed.code}`);
    const { byKind, different } = compareTrees(options.data, temp);
    for (const [kind, slot] of Object.entries(byKind).sort()) {
      io.out(`${kind.padEnd(14)} equal ${slot.equal}  differs ${slot.differs.length}  missing ${slot.missing.length}  extra ${slot.extra.length}${slot.forgotten ? `  (forgotten members' files not imported: ${slot.forgotten})` : ''}`);
      for (const item of slot.differs.slice(0, 5)) io.out(`    differs ${item.rel}: ${item.paths.join('; ')}`);
      for (const rel of slot.missing.slice(0, 5)) io.out(`    missing ${rel}`);
      for (const rel of slot.extra.slice(0, 5)) io.out(`    extra ${rel}`);
    }
    io.out(different || exported.failed.length ? `verify FAILED: ${different} files differ (${seconds(start)})` : `verify ok: every memory file equal (${seconds(start)})`);
    return different || exported.failed.length ? 1 : 0;
  } finally {
    handle.close();
    fs.rmSync(temp, { recursive: true, force: true });
  }
}

// ---------- parity ----------

/**
 * Every public read of the store, once from the JSON files and once through the database (the read switch of
 * spec section 7, `memoryDb.read`), compared deep. The proof that the switch changes nothing: run `sync` first. A file
 * the database is behind on (it changed on disk after the last sync) is read from the disk and counted as stale.
 */
function runParity(io, options) {
  need(options, 'data', 'db');
  const start = performance.now();
  const handle = openMemoryDb(options.db, { readOnly: true });
  try {
    const root = path.resolve(options.data);
    const served = { db: 0, missing: 0, stale: 0, unmapped: 0, empty: 0, absent: 0 };
    const relative = (file) => path.relative(root, file).split(path.sep).join('/');
    const memoryRead = {
      value(file) {
        const found = exportOne(handle, relative(file), { dataDir: root });
        if (found.found) { served.db += 1; return found; }
        if (found.reason === 'missing' && !fs.existsSync(file)) served.absent += 1;
        else served[found.reason] = (served[found.reason] ?? 0) + 1;
        return null;
      },
      ids: (dir) => idsUnderDir(handle, relative(dir)),
    };
    const files = createStore({ dataDir: root });
    const db = createStore({ dataDir: root, memoryRead });
    const guilds = fs.existsSync(path.join(root, 'guilds')) ? fs.readdirSync(path.join(root, 'guilds')) : [];
    let compared = 0;
    const differ = new Map();
    for (const g of guilds) {
      const users = files.listUserProfiles(g).map((user) => user.id);
      const privates = files.listPrivate(g);
      const channels = files.listChannels(g).map((channel) => channel.id);
      const reads = (store) => ({
        users: store.listUserProfiles(g), userCount: store.countUsers(g), privateIds: store.listPrivate(g),
        guild: store.getGuild(g), channels: store.listChannels(g), lore: store.getLore(g), media: store.getMediaCache(g),
        gifs: store.getGifs(g), recent: store.getRecent(g), participation: store.getParticipation(g),
        diary: store.getDiary(g), buffer: store.getBuffer(g), voice: store.getVoiceQueue(g),
        ...Object.fromEntries(users.flatMap((id) => [[`user:${id}`, store.getUser(g, id)], [`versions:${id}`, store.listVersions(g, 'users', id)]])),
        ...Object.fromEntries(privates.flatMap((id) => [[`private:${id}`, store.getPrivate(g, id)], [`privateBuffer:${id}`, store.getPrivateBuffer(g, id)]])),
        ...Object.fromEntries(channels.map((id) => [`channel:${id}`, store.getChannel(g, id)])),
      });
      const a = reads(files);
      const b = reads(db);
      for (const key of Object.keys(a)) {
        compared += 1;
        if (!isDeepStrictEqual(a[key], b[key])) {
          const kind = key.split(':')[0];
          differ.set(kind, (differ.get(kind) ?? 0) + 1);
        }
      }
    }
    io.out(`reads compared ${compared}, differ ${[...differ.values()].reduce((n, v) => n + v, 0)}${differ.size ? ` (${[...differ].map(([k, n]) => `${k} ${n}`).join(', ')})` : ''}`);
    io.out(`files read: from the database ${served.db}, absent on disk too ${served.absent}, from the disk: missing ${served.missing}, stale ${served.stale}, not memory ${served.unmapped}, empty ${served.empty}`);
    const ok = differ.size === 0;
    io.out(ok ? `parity ok (${seconds(start)})` : `parity FAILED (${seconds(start)})`);
    return ok ? 0 : 1;
  } finally {
    handle.close();
  }
}

// ---------- stats ----------

function runStats(io, options) {
  need(options, 'db');
  const handle = openMemoryDb(options.db, { readOnly: true });
  try {
    const db = handle.db;
    for (const { name: table } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all()) {
      const columns = new Set(db.prepare(`PRAGMA table_info("${table}")`).all().map((column) => column.name));
      const total = db.prepare(`SELECT COUNT(*) AS n FROM "${table}"`).get().n;
      let line = `${table.padEnd(22)} ${String(total).padStart(8)}`;
      if (columns.has('retired_at')) line += `  retired ${db.prepare(`SELECT COUNT(*) AS n FROM "${table}" WHERE retired_at IS NOT NULL`).get().n}`;
      if (columns.has('scope_kind') && total) {
        const scopes = db.prepare(`SELECT scope_kind AS k, COUNT(*) AS n FROM "${table}" GROUP BY scope_kind ORDER BY k`).all();
        line += `  scope ${scopes.map((scope) => `${scope.k ?? 'null'}=${scope.n}`).join(' ')}`;
      }
      if (columns.has('audience_id') && total) {
        const kinds = db.prepare(`SELECT CASE WHEN audience_id IS NULL THEN 'null' WHEN audience_id LIKE 'aud:dm:%' THEN 'dm' ELSE substr(audience_id, 5) END AS k,
          COUNT(*) AS n, COUNT(DISTINCT CASE WHEN audience_id LIKE 'aud:dm:%' THEN audience_id END) AS places FROM "${table}" GROUP BY 1 ORDER BY 1`).all();
        line += `  audience ${kinds.map((kind) => `${kind.k}=${kind.n}${kind.k === 'dm' ? ` (${kind.places} places)` : ''}`).join(' ')}`;
      }
      io.out(line);
    }
    return 0;
  } finally {
    handle.close();
  }
}

// ---------- hash, reproject, rebuild ----------

/** The tables of a database (no SQLite internals), with the virtual ones marked and their shadow tables left out. */
function tablesOf(db) {
  const rows = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const virtual = new Set(rows.filter((row) => /^CREATE VIRTUAL TABLE/i.test(row.sql ?? '')).map((row) => row.name));
  return rows.map((row) => row.name).filter((name) => ![...virtual].some((v) => name.startsWith(`${v}_`))).map((name) => ({ name, virtual: virtual.has(name) }));
}

const valueOf = (value) => {
  if (value instanceof Uint8Array) return ['blob', Buffer.from(value).toString('hex')];
  if (typeof value === 'bigint') return ['int', String(value)];
  return [value === null ? 'null' : typeof value, value];
};

/**
 * The content hash of every table (or of `only`): `[{ table, rows, hash }]`. Rows in primary-key order, every column;
 * a table without a primary key in the order of all its columns; a full-text table by its index content (fts5vocab
 * `instance`: every term, row, column and offset).
 */
export function tableHashes(db, only = null) {
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
      const keys = columns.filter((column) => column.pk > 0).sort((a, b) => a.pk - b.pk).map((column) => column.name);
      const order = (keys.length ? keys : columns.map((column) => column.name)).map((column) => `"${column}"`).join(', ');
      statement = db.prepare(`SELECT ${columns.map((column) => `"${column.name}"`).join(', ')} FROM "${name}" ORDER BY ${order}`);
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

function runHash(io, options) {
  need(options, 'db');
  const handle = openMemoryDb(options.db, { readOnly: true });
  try {
    const only = options.tables ? String(options.tables).split(',').map((name) => name.trim()).filter(Boolean) : null;
    const hashes = tableHashes(handle.db, only);
    for (const { table, rows, hash } of hashes) io.out(`${table.padEnd(26)} ${String(rows).padStart(8)}  ${hash}`);
    const missing = (only ?? []).filter((name) => !hashes.some((entry) => entry.table === name));
    for (const name of missing) io.out(`${name.padEnd(26)} no such table`);
    return missing.length ? 1 : 0;
  } finally {
    handle.close();
  }
}

function runReproject(io, options) {
  need(options, 'db');
  const handle = openMemoryDb(options.db);
  try {
    const at = new Date().toISOString();
    const pending = projectPending(handle, { at });
    const done = reproject(handle, { at });
    io.out(`graph: ${done.units} units projected, ${done.edges} edges, ${done.retired} retired as stale, ${done.ms} ms${pending.units ? ` (the pending projection took ${pending.ms} ms)` : ''}`);
    return 0;
  } finally {
    handle.close();
  }
}

/** The derived tables the rebuild drops and builds again. */
export const DERIVED_TABLES = ['graph_nodes', 'graph_edges', 'node_access', 'sources_fts', 'sources_tri'];

function runRebuild(io, options) {
  need(options, 'db');
  const handle = openMemoryDb(options.db);
  try {
    const before = tableHashes(handle.db, DERIVED_TABLES);
    const stale = handle.db.prepare("SELECT COUNT(*) AS n FROM graph_edges WHERE retired_at IS NOT NULL").get().n;
    const done = rebuildGraph(handle, { at: new Date().toISOString() });
    handle.transaction(() => {
      handle.db.exec("INSERT INTO sources_fts(sources_fts) VALUES ('rebuild'); INSERT INTO sources_tri(sources_tri) VALUES ('rebuild');");
    });
    const after = tableHashes(handle.db, DERIVED_TABLES);
    const keptRetired = handle.db.prepare("SELECT COUNT(*) AS n FROM graph_edges WHERE retired_at IS NOT NULL").get().n;
    io.out(`graph rebuilt: ${done.units} units, ${done.edges} edges in ${done.ms} ms; retired edges ${stale} before, ${keptRetired} after (the rest were stale: their rows no longer produce them)`);
    let differ = 0;
    for (const entry of after) {
      const was = before.find((row) => row.table === entry.table);
      const same = was?.hash === entry.hash;
      if (!same) differ += 1;
      io.out(`${entry.table.padEnd(26)} ${String(was?.rows ?? 0).padStart(8)} -> ${String(entry.rows).padStart(8)}  ${same ? 'equal' : 'differs'}`);
    }
    io.out(differ ? `rebuild: ${differ} derived tables differ from before` : 'rebuild: every derived table equal to before');
    return 0;
  } finally {
    handle.close();
  }
}

// ---------- ledger-import ----------

const LEDGER_TABLES = ['tasks', 'attempts', 'questions', 'approvals', 'results', 'comments', 'events', 'outbox'];

function runLedgerImport(io, options) {
  need(options, 'ledger', 'db');
  const source = openMemoryDb(options.ledger, { readOnly: true });
  const target = openMemoryDb(options.db);
  try {
    const counts = {};
    target.transaction(() => {
      for (const table of LEDGER_TABLES) {
        const exists = source.db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(table);
        counts[table] = 0;
        if (!exists) continue;
        const insert = target.db.prepare(`INSERT OR REPLACE INTO ledger_${table} (id, record) VALUES (?, ?)`);
        for (const row of source.db.prepare(`SELECT * FROM "${table}"`).all()) {
          insert.run(String(row.id ?? row.seq), JSON.stringify({ ...row }));
          counts[table] += 1;
        }
      }
    });
    io.out(`ledger rows copied: ${LEDGER_TABLES.map((table) => `${table} ${counts[table]}`).join(', ')}`);
    return 0;
  } finally {
    source.close();
    target.close();
  }
}

// ---------- entry ----------

const COMMANDS = {
  import: (io, options) => runSync(io, options, { importing: true }),
  sync: (io, options) => runSync(io, options, { importing: false }),
  export: runExport,
  verify: runVerify,
  parity: runParity,
  stats: runStats,
  hash: runHash,
  reproject: runReproject,
  rebuild: runRebuild,
  'ledger-import': runLedgerImport,
};

/** Runs a command line; returns the exit code. `io` is { out(line), err(line) }. */
export function main(argv, io = { out: (line) => console.log(line), err: (line) => console.error(line) }) {
  try {
    const { command, options } = parseArgs(argv);
    const run = COMMANDS[command];
    if (!run) {
      io.err(`usage: memory-db.mjs <${Object.keys(COMMANDS).join('|')}> [options] (see the header of this file)`);
      return 2;
    }
    return run(io, options);
  } catch (error) {
    io.err(`memory-db: ${error.message}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  process.exitCode = main(process.argv.slice(2));
}
