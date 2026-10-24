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
//   node tools/memory-db.mjs reader-parity --data <dir> --db <file> [--days N] [--live]
//        The memory modules' reads (stage W1) both ways over the same frozen snapshot: each module created over the data
//        directory (authority `json`, the files) and over the database (authority `db`, src/memory/db/readers/), and
//        the same calls with fixed parameters compared, for every guild and private layer: record.iterate over the
//        last N days (default 30, ending on the newest record or journal day) and per channel, record.newestRevision
//        for a sample of 200 message ids, archive.iterate over the range and archive.find for a sample of items,
//        journal.read per day, findTurn, turnOperations and pending for a sample of turns, timeline, vectors.search
//        for 20 query vectors taken from the index itself (top 20 ids, scores within 1e-6), vectors.has and stats,
//        the intention stores' list, get and archived, the task stores' open, recent, get and costs. Prints per
//        function `compared / equal / differ` and the first three differences (key paths only, never values); exit 1
//        on any difference. Opens the database read-only. Refuses a data directory or a database a live process holds
//        (its writer lock) unless --live: give it a copy. The file side is the engine's own code: a record month
//        without its id index gets it rebuilt (written) by newestRevision, as at any start.
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
//   node tools/memory-db.mjs index-policy --db <file> [--apply] [--days <n>]
//        The index policy (src/memory/db/index-policy.js): the tier of every stored line and the vectors outside the
//        owner's classes (older than --days, default `recall.db.vectorDays` 90, and not cited, pinned, touched or
//        consolidated). Without --apply it prints what it would evict and changes nothing (read-only); with --apply it
//        writes the tiers and evicts (the vector rows stay, only their bytes go). Under `memoryDb.authority: json` the
//        vector month files still hold the bytes, so `verify` then reports the evicted rows' months as different.
//   node tools/memory-db.mjs media-check --db <file> --data <dir> [--apply]
//        Her diary media: each `media` row of kind diary is `present` when its file under the data directory exists
//        with the stored size, else `missing`; every other row stays `unknown`. Prints the counts; --apply writes them.
//   node tools/memory-db.mjs backup --db <file> --to <dir> [--data <dir>]
//        `VACUUM INTO <dir>/memory.db`, a copy of `media/diary/` (from --data, default the database's directory) and
//        `<dir>/manifest.json`: every file with its size and SHA-256, the schema version, the engine commit and the row
//        count of every table (src/memory/db/backup.js; the bot's own daily backup, `memoryDb.backup`, also names the
//        config's hash). The directory must be new or empty. Opens the database read-only.
//   node tools/memory-db.mjs restore --from <dir> --db <file> [--data <dir>]
//        Checks every file of the backup against its manifest, then restores the database to --db (which must not
//        exist) and the diary media under --data (default the new database's directory; no file is overwritten), and
//        checks the schema version and the row counts of the restored file.
//   node tools/memory-db.mjs retire-check --data <dir> [--since <iso>]
//        The memory files that retire when the database becomes the writer (src/memory/db/paths.js#MEMORY_PATTERNS):
//        per pattern the number of files and the newest modification time, then how many files are operational (the
//        allowlist, still written under `db`) and how many are in neither list (the first five named). With --since (the
//        switch time) it exits 1 when any memory file was modified after it, naming the first five: the proof that
//        nothing writes a memory file under `db`. Reads only.
//   node tools/memory-db.mjs restore-test --from <backup dir> [--days N]
//        The exact-restore rehearsal: `restore` of the backup into a new temporary data directory, a memory service
//        opened there with authority `db` (no worker, no network, no interface, every job off), the memory modules'
//        reads of `reader-parity` (over the last N days, default 30) through that service compared with the same reads
//        through a second such service over a plain copy of the backup's database (both get the same first start: the
//        handoff of a backup taken before the switch writes the analyzer's buffered lines into their record units), and
//        an `export` of the restored database compared file by file (as `verify`) with an `export` of that copy. Exit 1
//        on any difference. The temporary directory is removed in every case.
//   node tools/memory-db.mjs observe-check --db <file> --since <iso> [--data <dir>]   (--data: lines still in the analyzer buffer are pending)
//        The live observation path against the sync (stage 8a, `memoryDb.observeLive`): the record lines of every kind
//        (`seen`, `said`, `deleted`, `felt`) that happened since --since and that only one side wrote: observed and
//        never brought by a record file (an observation, or the record's shadow of a said, deleted or felt line, that
//        the sync did not adopt), and brought by a record file and never observed (no source key in `external_keys`;
//        a seen or said line also counts as observed through the same message under the other subtype). Lines of a DM
//        are counted apart. Prints counts and at most five source ids per list, no text; exit 1 when a list outside
//        DMs is not empty. Opens the database read-only.
//
// import, sync, reproject, rebuild, ledger-import, index-policy --apply and media-check --apply take the database's
// writer lock and refuse while the bot (or another tool) holds it.
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
import { checkMedia, classify as classifyIndex } from '../src/memory/db/index-policy.js';
import { lockPathOf } from '../src/memory/db/open.js';
import { createAppendStore } from '../src/memory/append-store.js';
import { createRecord } from '../src/memory/record.js';
import { createArchive } from '../src/memory/archive.js';
import { createJournal } from '../src/memory/journal.js';
import { createVectors, dequantize } from '../src/memory/vectors.js';
import { createIntentionStores } from '../src/intentions/store.js';
import { createTaskStores } from '../src/errands/store.js';
import { chunkKey } from '../src/memory/chunks.js';
import { backupDatabase, restoreDatabase, tablesOf } from '../src/memory/db/backup.js';
import { MEMORY_PATTERNS, pathClass } from '../src/memory/db/paths.js';
import { createMemoryDb, engineCommit } from '../src/memory/db/service.js';

export { backupDatabase, restoreDatabase };

const FLAGS = new Set(['resume', 'apply', 'live']);

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

// ---------- reader-parity ----------

const DAY_MS = 86_400_000;
const PARITY_DAYS = 30;
const SAMPLE_MESSAGES = 200;
const SAMPLE_ITEMS = 50;
const SAMPLE_TURNS = 50;
const QUERY_VECTORS = 20;
const SEARCH_K = 20;
const SCORE_EPSILON = 1e-6;

/** Whether a live process holds the writer lock of `dbPath`. */
function heldLive(dbPath) {
  let lock = null;
  try {
    lock = JSON.parse(fs.readFileSync(lockPathOf(dbPath), 'utf8'));
  } catch {
    return false;
  }
  if (!Number.isInteger(lock?.pid) || lock.pid <= 0) return false;
  try {
    process.kill(lock.pid, 0);
    return true;
  } catch (error) {
    return error?.code === 'EPERM';
  }
}

/** Sorted names under `dir` ([] when missing); `dirs` keeps directories only. */
function namesIn(dir, { dirs = false } = {}) {
  try {
    return fs.readdirSync(dir, { withFileTypes: true }).filter((entry) => !dirs || entry.isDirectory()).map((entry) => entry.name).sort();
  } catch {
    return [];
  }
}

/** `count` items of `list` spread evenly over it, in order. */
function spread(list, count) {
  if (list.length <= count) return [...list];
  return Array.from({ length: count }, (_, i) => list[Math.floor((i * list.length) / count)]);
}

/** The newest day (`YYYY-MM-DD`) of a guild's record and journal files, or null. */
function newestDayOf(guildDir) {
  let newest = null;
  for (const month of namesIn(path.join(guildDir, 'record'), { dirs: true })) {
    for (const name of namesIn(path.join(guildDir, 'record', month))) {
      const day = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name)?.[1];
      if (day && (newest === null || day > newest)) newest = day;
    }
  }
  for (const name of namesIn(path.join(guildDir, 'journal'))) {
    const day = /^(\d{4}-\d{2}-\d{2})\.jsonl$/.exec(name)?.[1];
    if (day && (newest === null || day > newest)) newest = day;
  }
  return newest;
}

/** Up to `count` query vectors of a layer's index, read from its own month files (dequantised rows). */
function queryVectorsOf(baseDir, count) {
  const rows = [];
  for (const month of namesIn(baseDir, { dirs: true }).filter((name) => /^\d{4}-\d{2}$/.test(name))) {
    let manifest = null;
    try {
      manifest = JSON.parse(fs.readFileSync(path.join(baseDir, month, 'manifest.json'), 'utf8'));
    } catch {
      continue;
    }
    if (!Number.isInteger(manifest?.rows) || !Number.isInteger(manifest?.dims) || manifest.dims < 1) continue;
    let i8;
    let metas;
    try {
      i8 = fs.readFileSync(path.join(baseDir, month, `${manifest.gen}.i8`));
      metas = fs.readFileSync(path.join(baseDir, month, `${manifest.gen}.jsonl`), 'utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line));
    } catch {
      continue;
    }
    for (let row = 0; row < Math.min(manifest.rows, metas.length); row += 1) {
      if (!(metas[row]?.scale > 0) || (row + 1) * manifest.dims > i8.length) continue;
      const bytes = new Int8Array(i8.buffer, i8.byteOffset + row * manifest.dims, manifest.dims);
      rows.push(Array.from(dequantize(bytes, metas[row].scale)));
    }
  }
  return spread(rows, count);
}

/** Two search results the same: the same rows in the same order, scores within SCORE_EPSILON. */
function sameHits(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false;
  return a.every((hit, i) => chunkKey(hit.meta) === chunkKey(b[i].meta) && Math.abs(hit.score - b[i].score) <= SCORE_EPSILON && isDeepStrictEqual(hit.meta, b[i].meta));
}

/**
 * The memory modules' reads over two sides, compared with fixed parameters: the side `files` is each module created
 * with the arguments `left` (none: its files), the side `db` with `right` (`{ memoryDb }`: the database readers).
 * `root` is the layout the guilds, the private layers, the days and the query vectors are listed from (a data
 * directory, or an export of a database), and the modules' data directory. Returns `{ results, failures }`: per function
 * `{ compared, equal, differ, first }`, and the codes of the database reads that failed.
 */
async function compareModuleReads({ root, days, left = {}, right, scratch }) {
  const failures = [];
  const quiet = { info() {}, debug() {}, error() {}, warn: (message, fields) => { if (message === 'memory db: read failed') failures.push(fields?.code ?? 'ERROR'); } };
  const results = new Map();
  const compare = (fn, label, fileValue, dbValue, same = isDeepStrictEqual(fileValue, dbValue)) => {
    const entry = results.get(fn) ?? { compared: 0, equal: 0, differ: 0, first: [] };
    results.set(fn, entry);
    entry.compared += 1;
    if (same) { entry.equal += 1; return; }
    entry.differ += 1;
    if (entry.first.length < 3) entry.first.push(`${label}: ${diffPaths(dbValue, fileValue).join('; ') || 'differs'}`);
  };
  const both = async (fn, label, read) => {
    let fileValue;
    let dbValue;
    try { fileValue = await read('files'); } catch (error) { fileValue = { $error: error?.code ?? error?.name ?? 'ERROR' }; }
    try { dbValue = await read('db'); } catch (error) { dbValue = { $error: error?.code ?? error?.name ?? 'ERROR' }; }
    compare(fn, label, fileValue, dbValue);
    return fileValue;
  };
  const collect = async (iterable) => { const out = []; for await (const value of iterable) out.push(value); return out; };
  const make = (factory, args) => ({ files: factory({ ...args, log: quiet, ...left }), db: factory({ ...args, log: quiet, ...right }) });
  const appendStore = createAppendStore({ log: quiet });
  const noOut = path.join(scratch, 'no-out');
  const taskConfig = () => ({ agents: new Proxy({}, { get: () => ({ out: noOut }) }) });
  const guilds = namesIn(path.join(root, 'guilds'), { dirs: true });
  for (const g of guilds) {
    const guildDir = path.join(root, 'guilds', g);
    const endDay = newestDayOf(guildDir) ?? new Date().toISOString().slice(0, 10);
    const endMs = Date.parse(`${endDay}T23:59:59.999Z`);
    const startMs = Date.parse(`${endDay}T00:00:00.000Z`) - (days - 1) * DAY_MS;
    const range = { from: new Date(startMs).toISOString(), to: new Date(endMs).toISOString() };
    const dayList = Array.from({ length: days }, (_, i) => new Date(startMs + i * DAY_MS).toISOString().slice(0, 10));
    const record = make(createRecord, { appendStore, dataDir: root });
    const archive = make(createArchive, { appendStore, dataDir: root });
    const journal = make(createJournal, { appendStore, dataDir: root, now: () => endMs });
    const vectors = make(createVectors, { dataDir: root });
    const layers = [null, ...namesIn(path.join(guildDir, 'private'), { dirs: true })];
    for (const layer of layers) {
      const at = `${g}${layer ? `/private/${layer}` : ''}`;
      const lines = await both('record.iterate', at, (side) => collect(record[side].iterate(g, { ...range, privateUserId: layer })));
      const list = Array.isArray(lines) ? lines : [];
      for (const channel of spread([...new Set(list.map((line) => line?.scope?.channel).filter(Boolean))], 3)) {
        await both('record.iterate', `${at} channel`, (side) => collect(record[side].iterate(g, { ...range, channelIds: [channel], privateUserId: layer })));
      }
      const messages = new Map();
      for (const line of list) if (typeof line?.messageId === 'string' && !messages.has(line.messageId)) messages.set(line.messageId, line.occurredAt);
      for (const [id, occurredAt] of spread([...messages], SAMPLE_MESSAGES)) {
        await both('record.newestRevision', at, (side) => record[side].newestRevision(g, id, occurredAt, { privateUserId: layer }));
      }
      const entries = await both('archive.iterate', at, (side) => collect(archive[side].iterate(g, { ...range, privateUserId: layer })));
      const everything = await collect(archive.files.iterate(g, { privateUserId: layer })).catch(() => []);
      const items = [...new Set([...(Array.isArray(entries) ? entries : []), ...everything].map((entry) => entry?.itemId).filter((id) => typeof id === 'string'))];
      for (const itemId of spread(items, SAMPLE_ITEMS)) await both('archive.find', at, (side) => archive[side].find(g, itemId));
      const turns = [];
      for (const day of dayList) {
        const records = await both('journal.read', `${at} ${day}`, (side) => journal[side].read(g, { day, n: Number.MAX_SAFE_INTEGER, privateUserId: layer }));
        for (const rec of Array.isArray(records) ? records : []) if (rec?.kind === 'turn' && typeof rec.turnId === 'string') turns.push({ rec, day });
      }
      for (const { rec, day } of spread(turns, SAMPLE_TURNS)) {
        const next = new Date(Date.parse(`${day}T00:00:00.000Z`) + DAY_MS).toISOString().slice(0, 10);
        await both('journal.turnOperations', at, (side) => journal[side].turnOperations(g, { turnId: rec.turnId, days: [day, next], privateUserId: layer }));
        if (layer) continue;
        for (const posted of (Array.isArray(rec.posted) ? rec.posted : []).slice(0, 1)) {
          if (typeof posted?.messageId !== 'string') continue;
          await both('journal.findTurn', at, (side) => journal[side].findTurn(g, { messageId: posted.messageId, at: Date.parse(rec.occurredAt) }));
        }
      }
      const vectorBase = layer ? path.join(guildDir, 'private', layer, 'vectors') : path.join(guildDir, 'vectors');
      for (const query of queryVectorsOf(vectorBase, QUERY_VECTORS)) {
        const fileHits = await vectors.files.search(g, query, { k: SEARCH_K, privateUserId: layer }).catch((error) => ({ $error: error?.code ?? 'ERROR' }));
        const dbHits = await vectors.db.search(g, query, { k: SEARCH_K, privateUserId: layer }).catch((error) => ({ $error: error?.code ?? 'ERROR' }));
        compare('vectors.search', at, fileHits, dbHits, sameHits(fileHits, dbHits));
      }
      for (const month of namesIn(vectorBase, { dirs: true }).filter((name) => /^\d{4}-\d{2}$/.test(name))) {
        await both('vectors.has', `${at} ${month}`, async (side) => [...await vectors[side].has(g, month, { privateUserId: layer })].sort());
      }
      await both('vectors.stats', at, (side) => vectors[side].stats(g, { privateUserId: layer }));
    }
    await both('journal.timeline', g, (side) => journal[side].timeline(g, { from: startMs }));
    await both('journal.pending', g, (side) => journal[side].pending(g, { days: dayList }));
    const intentions = make(createIntentionStores, { dataDir: root });
    const ids = await both('intentions.list', g, (side) => intentions[side].get(g).list());
    for (const intention of Array.isArray(ids) ? ids : []) await both('intentions.get', g, (side) => intentions[side].get(g).get(intention.id));
    await both('intentions.archived', g, (side) => intentions[side].get(g).archived());
    const tasks = make(createTaskStores, { dataDir: root, config: taskConfig });
    await both('tasks.open', g, (side) => tasks[side].get(g).open());
    const recent = await both('tasks.recent', g, (side) => tasks[side].get(g).recent(Number.MAX_SAFE_INTEGER));
    for (const task of Array.isArray(recent) ? recent : []) await both('tasks.get', g, (side) => tasks[side].get(g).get(task.id));
    await both('tasks.costs', g, (side) => tasks[side].get(g).costs());
  }
  await appendStore.close?.();
  return { results, failures };
}

/** Prints a comparison (`compareModuleReads`); returns how many reads differ. */
function printComparison(io, { results, failures }) {
  let differ = 0;
  for (const [fn, entry] of [...results].sort(([a], [b]) => a.localeCompare(b))) {
    differ += entry.differ;
    io.out(`${fn.padEnd(24)} compared ${entry.compared}  equal ${entry.equal}  differ ${entry.differ}`);
    for (const line of entry.first) io.out(`  ${line}`);
  }
  if (failures.length > 0) io.out(`database reads failed: ${failures.length} (${[...new Set(failures)].join(', ')})`);
  return differ;
}

/**
 * The memory modules' reads from the files and from the database, compared (see the head of this file).
 * @returns {Promise<number>} the exit code
 */
async function runReaderParity(io, options) {
  need(options, 'data', 'db');
  const days = options.days === undefined ? PARITY_DAYS : Number(options.days);
  if (!Number.isInteger(days) || days < 1) throw new Error('--days must be a whole number of days, 1 or more');
  const root = path.resolve(options.data);
  if (!options.live && (heldLive(options.db) || heldLive(path.join(root, 'memory.db')))) {
    throw new Error('a live process holds this data: run on a frozen copy, or pass --live');
  }
  const start = performance.now();
  const handle = openMemoryDb(options.db, { readOnly: true });
  const scratch = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'reader-parity-'));
  try {
    const memoryDb = { authority: () => 'db', readHandle: () => handle };
    const differ = printComparison(io, await compareModuleReads({ root, days, right: { memoryDb }, scratch }));
    io.out(differ === 0 ? `reader parity ok (${seconds(start)})` : `reader parity FAILED: ${differ} differ (${seconds(start)})`);
    return differ === 0 ? 0 : 1;
  } finally {
    handle.close();
    fs.rmSync(scratch, { recursive: true, force: true });
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

// ---------- index policy, media, backups ----------

function runIndexPolicy(io, options) {
  need(options, 'db');
  const apply = options.apply === true;
  const days = options.days === undefined ? undefined : Number(options.days);
  if (days !== undefined && !(Number.isFinite(days) && days > 0)) throw new Error('--days must be a positive number');
  const handle = openMemoryDb(options.db, { readOnly: !apply });
  try {
    const config = { recall: { db: { ...(days ? { vectorDays: days } : {}), vectorEviction: apply } } };
    const done = classifyIndex(handle, { now: Date.now(), config, apply, evict: apply });
    io.out(`tiers: a ${done.tiers.a}, b ${done.tiers.b}, c ${done.tiers.c} (${Object.entries(done.reasons).sort().map(([reason, n]) => `${reason} ${n}`).join(', ')})`);
    const kept = done.vectors.kept;
    io.out(`vectors kept: recent ${kept.recent}, cited ${kept.cited}, pinned ${kept.pinned}, touched ${kept.touch}, consolidated ${kept.consolidated}, unlinked ${kept.unlinked}; evicted before ${done.vectors.evicted}`);
    io.out(apply ? `evicted now: ${done.evictedNow}` : `would evict: ${done.vectors.evict} (dry run: nothing written; --apply to evict)`);
    return 0;
  } finally {
    handle.close();
  }
}

function runMediaCheck(io, options) {
  need(options, 'db', 'data');
  const apply = options.apply === true;
  const handle = openMemoryDb(options.db, { readOnly: !apply });
  try {
    const done = checkMedia(handle, { dataDir: options.data, apply });
    io.out(`media: present ${done.present}, missing ${done.missing}, unknown ${done.unknown}; ${apply ? 'marked' : 'would mark'} ${done.changed}`);
    return 0;
  } finally {
    handle.close();
  }
}

function runBackup(io, options) {
  need(options, 'db', 'to');
  const start = performance.now();
  const manifest = backupDatabase({ db: options.db, to: options.to, commit: engineCommit(), ...(options.data ? { data: options.data } : {}) });
  io.out(`backup: schema ${manifest.schemaVersion}, ${manifest.files.length} files, ${Object.keys(manifest.rows).length} tables in ${seconds(start)}`);
  return 0;
}

function runRestore(io, options) {
  need(options, 'from', 'db');
  const start = performance.now();
  const manifest = restoreDatabase({ from: options.from, db: options.db, ...(options.data ? { data: options.data } : {}) });
  io.out(`restore ok: schema ${manifest.schemaVersion}, ${manifest.files.length} files checked and restored, row counts equal (${seconds(start)})`);
  return 0;
}

// ---------- retire-check, restore-test ----------

/** Every regular file under `dir`: [{ rel, mtimeMs }], relative with forward slashes, in name order. */
function filesWithTimes(dir, rel = '', out = []) {
  const entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true }).sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) filesWithTimes(dir, child, out);
    else if (entry.isFile()) out.push({ rel: child, mtimeMs: fs.statSync(path.join(dir, child)).mtimeMs });
  }
  return out;
}

/**
 * The memory files of a data directory (src/memory/db/paths.js#MEMORY_PATTERNS) with their newest time, per pattern,
 * and the ones modified after --since: the proof that nothing writes a memory file under authority `db`.
 */
function runRetireCheck(io, options) {
  need(options, 'data');
  let sinceMs = null;
  if (options.since !== undefined) {
    sinceMs = Date.parse(options.since);
    if (!Number.isFinite(sinceMs)) throw new Error('--since needs an ISO time');
  }
  const files = filesWithTimes(path.resolve(options.data));
  const byPattern = new Map(MEMORY_PATTERNS.map((entry) => [entry.glob, { files: 0, newest: null }]));
  const touched = [];
  const unknown = [];
  let operational = 0;
  for (const file of files) {
    const kind = pathClass(file.rel);
    if (kind === 'operational') { operational += 1; continue; }
    if (kind === null) { unknown.push(file.rel); continue; }
    const entry = MEMORY_PATTERNS.find((item) => item.re.test(file.rel));
    const slot = byPattern.get(entry.glob);
    slot.files += 1;
    if (slot.newest === null || file.mtimeMs > slot.newest) slot.newest = file.mtimeMs;
    if (sinceMs !== null && file.mtimeMs > sinceMs) touched.push(file);
  }
  for (const [glob, slot] of byPattern) {
    io.out(`${glob.padEnd(56)} files ${String(slot.files).padStart(6)}  newest ${slot.newest === null ? '-' : new Date(slot.newest).toISOString()}`);
  }
  io.out(`operational files ${operational}, unknown files ${unknown.length}${unknown.length ? ` (first: ${unknown.slice(0, 5).join(', ')})` : ''}`);
  if (sinceMs === null) return 0;
  const since = new Date(sinceMs).toISOString();
  if (touched.length === 0) {
    io.out(`retire-check ok: no memory file modified since ${since}`);
    return 0;
  }
  io.out(`retire-check FAILED: ${touched.length} memory files modified since ${since}`);
  for (const file of touched.slice(0, 5)) io.out(`  ${file.rel} ${new Date(file.mtimeMs).toISOString()}`);
  return 1;
}

/** The config of the isolated service a restore test opens: authority `db`, every start check met, every job off. */
const RESTORE_TEST_CONFIG = Object.freeze({
  features: { memoryDb: true },
  memoryDb: { authority: 'db', read: true, observeLive: true, session: { mode: 'off' }, backup: { enabled: false } },
  recall: { backend: 'db' },
});

/**
 * Restores a backup into a temporary data directory, opens a service there under authority `db` (no worker, no
 * network, no interface), and compares: the memory modules' reads through the service against the same reads through
 * a second service over a plain copy of the backup's database (the same first start, its handoff included), and an
 * export of the restored database against an export of that copy. The backup itself is only read. The temporary
 * directory is removed in every case.
 * @returns {Promise<number>} the exit code
 */
async function runRestoreTest(io, options) {
  need(options, 'from');
  const days = options.days === undefined ? PARITY_DAYS : Number(options.days);
  if (!Number.isInteger(days) || days < 1) throw new Error('--days must be a whole number of days, 1 or more');
  const start = performance.now();
  const scratch = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'restore-test-'));
  const data = path.join(scratch, 'data');
  let service = null;
  let source = null;
  try {
    const manifest = restoreDatabase({ from: options.from, db: path.join(data, 'memory.db'), data });
    io.out(`restored: schema ${manifest.schemaVersion}, ${manifest.files.length} files checked`);
    const warnings = [];
    const log = { info() {}, debug() {}, error: (message, fields) => warnings.push({ message, code: fields?.code ?? null }), warn: (message, fields) => warnings.push({ message, code: fields?.code ?? null }) };
    const open = async (dir) => {
      const opened = createMemoryDb({ hot: { config: structuredClone(RESTORE_TEST_CONFIG), prompts: {} }, dataDir: dir, log, worker: false });
      await opened.tick();
      await opened.tick();
      return opened;
    };
    service = await open(data);
    const state = service.status();
    if (!state.open || !service.readHandle()) {
      io.out(`restore-test FAILED: the service did not open the restored database (${state.refused ?? (warnings.map((entry) => entry.code).filter(Boolean).join(', ') || 'unknown')})`);
      return 1;
    }
    // The backup's database as it is (a plain copy, the backup only read), opened by the same first start.
    const sourceDir = path.join(scratch, 'source');
    fs.mkdirSync(sourceDir, { recursive: true });
    fs.copyFileSync(path.join(options.from, 'memory.db'), path.join(sourceDir, 'memory.db'));
    source = await open(sourceDir);
    if (!source.readHandle()) {
      io.out(`restore-test FAILED: the service did not open the copy of the backup (${source.status().refused ?? 'unknown'})`);
      return 1;
    }
    const backup = source.readHandle();
    const backupSeam = { authority: () => 'db', readHandle: () => backup };
    // The layout the reads are listed from: the backup's database exported (the restored data directory holds no file).
    const layout = path.join(scratch, 'backup-export');
    const exportedBackup = exportAll(backup, layout);
    const restoredExport = path.join(scratch, 'restored-export');
    const exportedRestored = exportAll(service.readHandle(), restoredExport);
    const comparison = await compareModuleReads({ root: layout, days, left: { memoryDb: backupSeam }, right: { memoryDb: service }, scratch });
    const differ = printComparison(io, comparison);
    const failed = [...exportedBackup.failed, ...exportedRestored.failed];
    for (const item of failed) io.out(`could not export: ${item.kind} ${item.code}`);
    const { byKind, different } = compareTrees(layout, restoredExport);
    for (const [kind, slot] of Object.entries(byKind).sort()) {
      io.out(`export ${kind.padEnd(14)} equal ${slot.equal}  differs ${slot.differs.length}  missing ${slot.missing.length}  extra ${slot.extra.length}`);
    }
    const ok = differ === 0 && different === 0 && failed.length === 0;
    io.out(ok
      ? `restore-test ok: reads equal, the restored export equals the backup's (${exportedRestored.files} files, ${seconds(start)})`
      : `restore-test FAILED: ${differ} reads differ, ${different} exported files differ (${seconds(start)})`);
    return ok ? 0 : 1;
  } finally {
    if (source) await source.close();
    if (service) await service.close();
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

// ---------- observe-check ----------

/** The record kinds the check covers. */
const CHECKED_KINDS = "'seen', 'said', 'deleted', 'felt'";

/** A DM line: its audience or its scope says so. */
const DM_LINE_SQL = "(s.audience_id LIKE 'aud:dm:%' OR s.scope_kind = 'dm')";

/** The message ids in every guild's analyzer buffer under `dataDir` (empty without one). */
function bufferedIds(dataDir) {
  const ids = new Set();
  if (!dataDir) return ids;
  let guilds = [];
  try { guilds = fs.readdirSync(path.join(dataDir, 'guilds')); } catch { return ids; }
  for (const guild of guilds) {
    try {
      const buffer = JSON.parse(fs.readFileSync(path.join(dataDir, 'guilds', guild, 'buffer.json'), 'utf8'));
      const list = Array.isArray(buffer) ? buffer : Array.isArray(buffer?.messages) ? buffer.messages : [];
      for (const message of list) if (message?.id != null) ids.add(String(message.id));
    } catch { /* no buffer: nothing pending */ }
  }
  return ids;
}

function runObserveCheck(io, options) {
  need(options, 'db', 'since');
  const sinceMs = Date.parse(options.since);
  if (!Number.isFinite(sinceMs)) throw new Error('--since needs an ISO time');
  const since = new Date(sinceMs).toISOString();
  const handle = openMemoryDb(options.db, { readOnly: true });
  try {
    const { db } = handle;
    const observedRows = db.prepare(`SELECT s.id AS id, s.native_id AS native, ${DM_LINE_SQL} AS dm FROM sources s
      WHERE s.origin = 'observation' AND s.owner_file IS NULL AND s.kind IN (${CHECKED_KINDS}) AND s.occurred_at >= ? AND s.retired_at IS NULL ORDER BY s.occurred_at, s.id`).all(since);
    const syncOnly = db.prepare(`SELECT s.id AS id, ${DM_LINE_SQL} AS dm FROM sources s
      WHERE s.owner_file GLOB '*record/*' AND s.kind IN (${CHECKED_KINDS}) AND s.occurred_at >= ? AND s.retired_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM external_keys k WHERE k.object_kind = 'source' AND k.node_id = s.id)
        -- the same message observed under the other subtype (her echo recorded as \`seen\` beside her \`said\`) is observed
        AND (s.kind NOT IN ('seen', 'said') OR NOT EXISTS (SELECT 1 FROM sources o JOIN external_keys k ON k.object_kind = 'source' AND k.node_id = o.id
          WHERE o.native_id = s.native_id AND o.authority_id IS s.authority_id AND o.retired_at IS NULL))
        ORDER BY s.occurred_at, s.id`).all(since);
    const report = (name, rows) => {
      const outside = rows.filter((row) => !row.dm);
      const dm = rows.length - outside.length;
      io.out(`${name}: ${outside.length}${dm ? ` (and ${dm} DM lines)` : ''}`);
      if (outside.length > 0) io.out(`  first: ${outside.slice(0, 5).map((row) => row.id).join(', ')}`);
      return outside.length;
    };
    // A line still in the analyzer's buffer (`--data`: data/guilds/<g>/buffer.json) is not in the record yet: the record
    // takes seen lines when the analyzer takes the batch. Those are pending, not a difference.
    const buffered = bufferedIds(options.data);
    const pending = observedRows.filter((row) => buffered.has(String(row.native)));
    const observedOnly = observedRows.filter((row) => !buffered.has(String(row.native)));
    if (options.data) io.out(`observed, still in the analyzer buffer (pending): ${pending.length}`);
    const differ = report('observed, not in the record', observedOnly) + report('in the record, not observed', syncOnly);
    io.out(differ === 0 ? `observe-check ok since ${since}` : `observe-check FAILED: ${differ} lines differ since ${since}`);
    return differ === 0 ? 0 : 1;
  } finally {
    handle.close();
  }
}

// ---------- entry ----------

const COMMANDS = {
  import: (io, options) => runSync(io, options, { importing: true }),
  sync: (io, options) => runSync(io, options, { importing: false }),
  export: runExport,
  verify: runVerify,
  parity: runParity,
  'reader-parity': runReaderParity,
  stats: runStats,
  hash: runHash,
  reproject: runReproject,
  rebuild: runRebuild,
  'ledger-import': runLedgerImport,
  'index-policy': runIndexPolicy,
  'media-check': runMediaCheck,
  'observe-check': runObserveCheck,
  backup: runBackup,
  restore: runRestore,
  'retire-check': runRetireCheck,
  'restore-test': runRestoreTest,
};

/** Runs a command line; returns the exit code (a promise of it for `reader-parity` and `restore-test`). `io` is { out(line), err(line) }. */
export function main(argv, io = { out: (line) => console.log(line), err: (line) => console.error(line) }) {
  try {
    const { command, options } = parseArgs(argv);
    const run = COMMANDS[command];
    if (!run) {
      io.err(`usage: memory-db.mjs <${Object.keys(COMMANDS).join('|')}> [options] (see the header of this file)`);
      return 2;
    }
    const code = run(io, options);
    if (code && typeof code.then === 'function') {
      return code.catch((error) => {
        io.err(`memory-db: ${error.message}`);
        return 2;
      });
    }
    return code;
  } catch (error) {
    io.err(`memory-db: ${error.message}`);
    return 2;
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(fs.realpathSync(process.argv[1])).href) {
  Promise.resolve(main(process.argv.slice(2))).then((code) => { process.exitCode = code; });
}
