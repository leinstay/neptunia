// Sync: keeps the memory database equal to the JSON memory files under a data directory (spec section 5).
//
// One pass walks the data directory through the mapper registry (`classify` in map/index.js). For every memory file:
//   - the signature `(size, mtime_ms)` is compared with the `files` row; an unchanged file costs nothing;
//   - a JSON (or text) file that changed is re-mapped whole and upserted by id; rows of that file that the new
//     mapping no longer holds get `retired_at` (never deleted; a row that comes back is un-retired by the upsert);
//   - a JSONL file is read from the stored byte `offset` to its last complete line (a partial last line waits for
//     its newline) and the lines are upserted; a file that shrank, or whose first 4 KB no longer hash as before, is
//     read whole again and handled like a changed JSON file;
//   - a month of vectors (three files) is one unit, mapped together;
//   - each file is one transaction, and one bad file is counted and logged (its kind and error code, never its
//     path or content) while the pass goes on.
// A file that left the disk retires its rows and drops its `files` row. A forgotten member (`forgotten.json`,
// `forgetting/*`) is never imported: the member's files and lines are skipped and rows already imported are retired.
//
// Order inside a pass: ordinary files first, then archive segments, participation and vectors (an archived item that is not in hot
// memory becomes a retired `historical` claim, which needs the hot claims to be in), then request dumps (a dump's
// step source is kept only when the turn's own answer row exists; otherwise the dump stays pending and is tried
// again next pass).
//
// Pure of the bot: it takes an opened database (`openMemoryDb` handle, or a raw `DatabaseSync` already in WAL), the
// data directory, and `{ now, log, filter }` (`filter(relPath)` limits the pass to some paths of the data directory).
// The caller holds the writer lock (opening the database does).

import fs from 'node:fs';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { inTransaction } from './open.js';
import { classify } from './map/index.js';
import { stepSourceBelongsTo } from './map/requests.js';
import { personId } from './ids.js';

/** Tables whose rows belong to one file (`owner_file`), and their primary key columns. */
export const OWNED = {
  people: ['id'], accounts: ['id'], places: ['id'], memberships: ['id'], sources: ['id'], claims: ['id'],
  claim_versions: ['id'], descriptions: ['id'], description_versions: ['id'], episodes: ['id'],
  affinity_events: ['id'], day: ['id'], diary: ['id'], media: ['id'], intentions: ['id'], work: ['id'],
  work_events: ['id'], decisions: ['id'], operational: ['kind', 'owner'], vectors: ['chunk_key'],
};

/** Tables that hang off a parent row of the same unit: child table -> [parent table, link column, parent key]. */
const CHILDREN = {
  episode_sources: ['episodes', 'episode_id'],
  claim_sources: ['claims', 'claim_id'],
  diary_mirrors: ['diary', 'diary_id'],
};

const HEAD_BYTES = 4096;
const noop = () => {};
const silent = { info: noop, warn: noop, error: noop, debug: noop };

const sha1Of = (buffer) => createHash('sha1').update(buffer).digest('hex');
const iso = (now) => new Date(now()).toISOString();
const quote = (name) => `"${name}"`;

const columnCache = new WeakMap();
function columnsOf(db, table) {
  let tables = columnCache.get(db);
  if (!tables) columnCache.set(db, (tables = new Map()));
  if (!tables.has(table)) tables.set(table, new Set(db.prepare(`PRAGMA table_info(${quote(table)})`).all().map((c) => c.name)));
  return tables.get(table);
}

const statementCache = new WeakMap();
function prepared(db, sql) {
  let map = statementCache.get(db);
  if (!map) statementCache.set(db, (map = new Map()));
  if (!map.has(sql)) map.set(sql, db.prepare(sql));
  return map.get(sql);
}

const bind = (value) => (value === undefined ? null : value);

/** Inserts a row, or updates the columns it names when the primary key exists (rowid and unnamed columns stay). */
function upsert(db, table, row, { ignore = false } = {}) {
  const have = columnsOf(db, table);
  const out = { ...row };
  if (have.has('retired_at') && !Object.hasOwn(out, 'retired_at')) out.retired_at = null;
  const cols = Object.keys(out).filter((col) => have.has(col));
  const key = OWNED[table] ?? [];
  const update = cols.filter((col) => !key.includes(col));
  const sql = `INSERT INTO ${quote(table)} (${cols.map(quote).join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) ON CONFLICT(${key.map(quote).join(', ')}) `
    + (ignore || update.length === 0 ? 'DO NOTHING' : `DO UPDATE SET ${update.map((col) => `${quote(col)} = excluded.${quote(col)}`).join(', ')}`);
  prepared(db, sql).run(...cols.map((col) => bind(out[col])));
}

const keyOf = (table, row) => OWNED[table].map((col) => row[col]).join('\u0000');

/** Retires the active rows of a unit that the given mapping no longer holds. Returns how many. */
function retireAbsent(db, owner, mapping, at) {
  let count = 0;
  for (const [table, key] of Object.entries(OWNED)) {
    const keep = new Set((mapping[table] ?? []).map((row) => keyOf(table, row)));
    const existing = prepared(db, `SELECT ${key.map(quote).join(', ')} FROM ${quote(table)} WHERE owner_file = ? AND retired_at IS NULL`).all(owner);
    const update = prepared(db, `UPDATE ${quote(table)} SET retired_at = ? WHERE ${key.map((col) => `${quote(col)} = ?`).join(' AND ')}`);
    for (const row of existing) {
      if (keep.has(keyOf(table, row))) continue;
      update.run(at, ...key.map((col) => row[col]));
      count += 1;
    }
  }
  return count;
}

/** Retires every active row of a unit. */
const retireUnit = (db, owner, at) => retireAbsent(db, owner, {}, at);

/** Writes a mapping (table -> rows). Children of a parent row are replaced with the mapping's. */
function writeMapping(db, mapping, { ignoreClaims = false } = {}) {
  let count = 0;
  for (const [table, rows] of Object.entries(mapping)) {
    if (CHILDREN[table] || !rows.length) continue;
    for (const row of rows) {
      upsert(db, table, row, { ignore: table === 'claims' && ignoreClaims });
      count += 1;
    }
  }
  for (const [child, [parent, link]] of Object.entries(CHILDREN)) {
    const parents = mapping[parent] ?? [];
    if (!parents.length) continue;
    const remove = prepared(db, `DELETE FROM ${quote(child)} WHERE ${quote(link)} = ?`);
    for (const row of parents) remove.run(row.id);
    for (const row of mapping[child] ?? []) {
      const cols = Object.keys(row);
      prepared(db, `INSERT INTO ${quote(child)} (${cols.map(quote).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((col) => bind(row[col])));
      count += 1;
    }
  }
  return count;
}

function merge(into, mapping) {
  for (const [table, rows] of Object.entries(mapping)) (into[table] ??= []).push(...rows);
}

// ---------- the walk ----------

const TEMP_FILE = /\.\d+\.tmp$/;

/** Every file under `dir` as { rel, abs, size, mtimeMs }, depth first in name order. Skipped trees are not entered. */
export function walk(dir, rel = '', out = []) {
  let entries;
  try {
    entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
  } catch (error) {
    if (rel === '') throw error;
    return out;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (classify(`${child}/_`)?.skipped) continue;
      walk(dir, child, out);
    } else if (entry.isFile() && !TEMP_FILE.test(entry.name)) {
      const abs = path.join(dir, child);
      try {
        const stat = fs.statSync(abs);
        out.push({ rel: child, abs, size: stat.size, mtimeMs: Math.floor(stat.mtimeMs) });
      } catch { /* vanished between listing and stat */ }
    }
  }
  return out;
}

/** Memory units of a data directory: one per file, one per month of vectors. */
export function unitsOf(files, unknown, skipped) {
  const units = new Map();
  for (const file of files) {
    const info = classify(file.rel);
    if (!info) { unknown.push(file.rel); continue; }
    if (info.skipped) { skipped.count += 1; continue; }
    const prefix = info.guildId === undefined ? '' : `guilds/${info.guildId}/`;
    const full = `${prefix}${info.unit}`;
    const unit = units.get(full) ?? {
      full, rel: info.unit, kind: info.kind, mapper: info.mapper, format: info.format, guildId: info.guildId, parts: [],
    };
    unit.parts.push(file);
    units.set(full, unit);
  }
  for (const unit of units.values()) {
    unit.size = unit.parts.reduce((sum, part) => sum + part.size, 0);
    unit.mtimeMs = unit.parts.reduce((max, part) => Math.max(max, part.mtimeMs), 0);
    unit.abs = unit.parts[0].abs;
  }
  const priority = (unit) => (unit.kind === 'requests' ? 2 : ['archive', 'vectors', 'participation'].includes(unit.kind) ? 1 : 0);
  return [...units.values()].sort((a, b) => priority(a) - priority(b) || (a.full < b.full ? -1 : a.full > b.full ? 1 : 0));
}

// ---------- forgotten members ----------

export function forgottenOf(dataDir, guildId) {
  const ids = new Set();
  const root = path.join(dataDir, 'guilds', guildId);
  try {
    const ledger = JSON.parse(fs.readFileSync(path.join(root, 'forgotten.json'), 'utf8'));
    if (Array.isArray(ledger)) for (const entry of ledger) if (typeof entry?.userId === 'string') ids.add(entry.userId);
  } catch { /* no ledger, or unreadable: nobody is forgotten yet */ }
  try {
    for (const name of fs.readdirSync(path.join(root, 'forgetting'))) {
      if (name.endsWith('.json')) ids.add(name.slice(0, -'.json'.length));
    }
  } catch { /* no markers */ }
  return ids;
}

/** The member a unit belongs to (a profile, a private layer, a version file), or null. */
export function memberOfUnit(rel) {
  const match = /^(?:users\/([^/]+)\.json|private\/([^/]+?)(?:\.json|\/.*)|versions\/users\/([^/]+)\.json)$/.exec(rel);
  return match ? (match[1] ?? match[2] ?? match[3]) : null;
}

export function lineIsForgotten(line, forgotten) {
  if (!forgotten.size || line === null || typeof line !== 'object') return false;
  for (const key of ['by', 'userId', 'authorId']) if (typeof line[key] === 'string' && forgotten.has(line[key])) return true;
  return false;
}

/** Retires every active row that belongs to a forgotten member (their person, account, scoped and authored rows). */
function retireMember(db, userId, at) {
  const person = personId(userId);
  const account = `discord:${userId}`;
  let count = 0;
  const run = (sql, ...params) => { count += Number(prepared(db, sql).run(...params).changes); };
  run('UPDATE people SET retired_at = ? WHERE id = ? AND retired_at IS NULL', at, person);
  run('UPDATE accounts SET retired_at = ? WHERE id = ? AND retired_at IS NULL', at, account);
  run('UPDATE memberships SET retired_at = ? WHERE account_id = ? AND retired_at IS NULL', at, account);
  run('UPDATE sources SET retired_at = ? WHERE author_account = ? AND retired_at IS NULL', at, account);
  run('UPDATE affinity_events SET retired_at = ? WHERE person_id = ? AND retired_at IS NULL', at, person);
  run('UPDATE claims SET retired_at = ? WHERE (subject_id = ? OR from_person = ?) AND retired_at IS NULL', at, person, person);
  for (const table of ['claims', 'episodes', 'sources', 'day', 'diary', 'media', 'intentions', 'work', 'vectors', 'descriptions', 'affinity_events']) {
    run(`UPDATE ${quote(table)} SET retired_at = ? WHERE scope_kind = 'dm' AND scope_dm = ? AND retired_at IS NULL`, at, person);
  }
  return count;
}

// ---------- reading a unit ----------

function readHead(fd, length) {
  const buffer = Buffer.alloc(length);
  const read = length > 0 ? fs.readSync(fd, buffer, 0, length, 0) : 0;
  return buffer.subarray(0, read);
}

function readVectors(unit) {
  const manifestFile = unit.parts.find((part) => part.rel.endsWith('/manifest.json'));
  if (!manifestFile) throw Object.assign(new Error('vectors month without a manifest'), { code: 'NO_MANIFEST' });
  const manifest = JSON.parse(fs.readFileSync(manifestFile.abs, 'utf8'));
  const gen = manifest?.gen;
  const find = (ext) => unit.parts.find((part) => part.rel.endsWith(`/${gen}.${ext}`));
  const meta = find('jsonl');
  const i8 = find('i8');
  return {
    manifest,
    meta: meta ? fs.readFileSync(meta.abs, 'utf8') : '',
    i8: i8 ? fs.readFileSync(i8.abs) : Buffer.alloc(0),
  };
}

function hotClaimIds(db) {
  const ids = new Set();
  for (const row of db.prepare("SELECT id FROM claims WHERE retired_at IS NULL AND owner_file NOT GLOB '*archive/*'").all()) ids.add(row.id);
  for (const row of db.prepare('SELECT id FROM episodes WHERE retired_at IS NULL').all()) ids.add(row.id);
  return ids;
}

/**
 * Points every participation message ref (`src:discord:<messageId>`) at the newest revision of that message in the
 * record, when the record has it; a ref the record does not hold is kept as it is. Returns how many were changed.
 */
function relinkParticipation(db) {
  const find = prepared(db, "SELECT id FROM sources WHERE native_id = ? AND kind IN ('seen', 'said') AND retired_at IS NULL ORDER BY revision DESC LIMIT 1");
  const update = prepared(db, 'UPDATE episode_sources SET source_id = ? WHERE episode_id = ? AND position = ? AND source_id = ?');
  let count = 0;
  for (const row of db.prepare("SELECT episode_id, source_id, position FROM episode_sources WHERE source_id LIKE 'src:discord:%'").all()) {
    const messageId = /^src:discord:([^:]+)/.exec(row.source_id)?.[1];
    const found = messageId ? find.get(messageId) : null;
    if (!found || found.id === row.source_id) continue;
    update.run(found.id, row.episode_id, row.position, row.source_id);
    count += 1;
  }
  return count;
}

function linkVectors(db, rows) {
  for (const row of rows) {
    const match = /^(?:private:[^:]+:)?record:(.+):([^:]*?)(?:#\d+)?$/.exec(String(row.chunk_key));
    if (!match || match[2] === '') continue;
    const found = prepared(db, "SELECT rowid FROM sources WHERE native_id = ? AND revision = ? AND kind IN ('seen', 'said') ORDER BY kind LIMIT 1")
      .get(match[1], Number(match[2]));
    if (found) row.source_rowid = found.rowid;
  }
}

// ---------- the pass ----------

const upsertFile = (db, unit, fields) => prepared(db, `INSERT INTO files (path, kind, size, mtime_ms, sha1, offset, synced_at, lines)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(path) DO UPDATE SET kind = excluded.kind, size = excluded.size,
  mtime_ms = excluded.mtime_ms, sha1 = excluded.sha1, offset = excluded.offset, synced_at = excluded.synced_at, lines = excluded.lines`)
  .run(unit.full, unit.kind, fields.size, bind(fields.mtimeMs), bind(fields.sha1), bind(fields.offset), fields.at, bind(fields.lines));

/** Syncs one JSON, text or vectors unit. Returns { upserted, retired } (null upserted when nothing changed). */
function syncWhole(db, unit, prior, at) {
  let value;
  if (unit.format === 'vectors') value = readVectors(unit);
  else {
    const text = fs.readFileSync(unit.abs, 'utf8');
    value = unit.format === 'text' ? text : JSON.parse(text);
  }
  const ctx = { guildId: unit.guildId };
  if (unit.kind === 'archive') ctx.hotClaimIds = hotClaimIds(db);
  const mapping = unit.mapper.toRows(unit.rel, value, ctx);
  let pending = false;
  if (unit.kind === 'requests' && mapping.sources?.length) {
    const answer = prepared(db, 'SELECT place_id, scope_kind, scope_iface, scope_dm FROM sources WHERE id = ? AND retired_at IS NULL').get(stepSourceBelongsTo(mapping.sources[0].id));
    if (answer) Object.assign(mapping.sources[0], answer);
    else { delete mapping.sources; pending = true; }
  }
  if (unit.kind === 'vectors') {
    for (const row of mapping.vectors ?? []) row.owner_file = unit.rel;
    linkVectors(db, mapping.vectors ?? []);
  }
  const upserted = writeMapping(db, mapping, { ignoreClaims: unit.kind === 'archive' });
  const retired = retireAbsent(db, unit.rel, mapping, at);
  upsertFile(db, unit, { size: unit.size, mtimeMs: pending ? null : unit.mtimeMs, sha1: pending ? 'pending' : null, offset: null, lines: null, at });
  return { upserted, retired };
}

/** Syncs one JSONL unit: from the stored offset when the file only grew, else whole. */
function syncLines(db, unit, prior, at, forgotten, errors) {
  const fd = fs.openSync(unit.abs, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    let start = 0;
    let lines = 0;
    let whole = true;
    if (prior && Number.isInteger(prior.offset) && size >= prior.offset && prior.sha1) {
      const head = readHead(fd, Math.min(HEAD_BYTES, prior.offset));
      if (sha1Of(head) === prior.sha1) {
        start = prior.offset;
        lines = prior.lines ?? 0;
        whole = false;
      }
    }
    const chunk = Buffer.alloc(size - start);
    const read = chunk.length ? fs.readSync(fd, chunk, 0, chunk.length, start) : 0;
    const data = chunk.subarray(0, read);
    const end = data.lastIndexOf(0x0a) + 1;
    const offset = start + end;
    const mapping = {};
    const ctxBase = { guildId: unit.guildId };
    if (unit.kind === 'archive') ctxBase.hotClaimIds = hotClaimIds(db);
    let position = lines;
    for (const text of data.subarray(0, end).toString('utf8').split('\n')) {
      if (!text.trim()) continue;
      let value;
      try {
        value = JSON.parse(text);
      } catch {
        errors.push('BAD_LINE');
        position += 1;
        continue;
      }
      if (!lineIsForgotten(value, forgotten)) merge(mapping, unit.mapper.toRows(unit.rel, value, { ...ctxBase, position }));
      position += 1;
    }
    const upserted = writeMapping(db, mapping, { ignoreClaims: unit.kind === 'archive' });
    const retired = whole ? retireAbsent(db, unit.rel, mapping, at) : 0;
    const head = offset === start && !whole ? null : readHead(fd, Math.min(HEAD_BYTES, offset));
    upsertFile(db, unit, {
      size: unit.size, mtimeMs: unit.mtimeMs, offset, lines: position, at,
      sha1: head === null ? prior.sha1 : sha1Of(head),
    });
    return { upserted, retired };
  } finally {
    fs.closeSync(fd);
  }
}

const bump = (counts, kind) => (counts[kind] ??= { seen: 0, changed: 0, upserted: 0, retired: 0, errors: 0 });

/**
 * One pass over a data directory. Never throws for one bad file.
 * @param {object} database  an `openMemoryDb` handle (`{ db, transaction }`) or a raw database
 * @param {string} dataDir
 * @param {{ now?: () => number, log?: object, filter?: (rel: string) => boolean }} [opts]
 * @returns {{ seen: number, changed: number, upserted: number, retired: number, errors: number, forgotten: number,
 *   byKind: object, unknown: string[], skipped: number }}
 */
export function syncOnce(database, dataDir, { now = Date.now, log = silent, filter } = {}) {
  const db = database.db ?? database;
  const transaction = database.transaction ?? ((fn) => inTransaction(db, fn));
  if (!fs.existsSync(dataDir)) throw new Error('memory sync: the data directory does not exist');
  const at = iso(now);
  const result = { seen: 0, changed: 0, upserted: 0, retired: 0, errors: 0, forgotten: 0, byKind: {}, unknown: [], skipped: 0 };
  const skipped = { count: 0 };
  const everything = walk(dataDir);
  const files = filter ? everything.filter((file) => filter(file.rel)) : everything;
  const units = unitsOf(files, result.unknown, skipped);
  result.skipped = skipped.count;
  const forgottenByGuild = new Map();
  const forgottenOfGuild = (guildId) => {
    if (guildId === undefined) return new Set();
    if (!forgottenByGuild.has(guildId)) forgottenByGuild.set(guildId, forgottenOf(dataDir, guildId));
    return forgottenByGuild.get(guildId);
  };
  const seenPaths = new Set();
  for (const unit of units) {
    const counts = bump(result.byKind, unit.kind);
    counts.seen += 1;
    result.seen += 1;
    seenPaths.add(unit.full);
    const forgotten = forgottenOfGuild(unit.guildId);
    try {
      transaction(() => {
        const prior = db.prepare('SELECT * FROM files WHERE path = ?').get(unit.full);
        const member = memberOfUnit(unit.rel);
        if (member && forgotten.has(member)) {
          if (prior) {
            const retired = retireUnit(db, unit.rel, at);
            db.prepare('DELETE FROM files WHERE path = ?').run(unit.full);
            counts.retired += retired;
            result.retired += retired;
            counts.changed += 1;
            result.changed += 1;
          }
          result.forgotten += 1;
          return;
        }
        if (prior && prior.size === unit.size && prior.mtime_ms === unit.mtimeMs) return;
        const lineErrors = [];
        const done = unit.format === 'jsonl' ? syncLines(db, unit, prior, at, forgotten, lineErrors) : syncWhole(db, unit, prior, at);
        counts.changed += 1;
        counts.upserted += done.upserted;
        counts.retired += done.retired;
        result.changed += 1;
        result.upserted += done.upserted;
        result.retired += done.retired;
        if (lineErrors.length) {
          counts.errors += lineErrors.length;
          result.errors += lineErrors.length;
          log.warn('memory sync: unreadable lines skipped', { kind: unit.kind, code: 'BAD_LINE', count: lineErrors.length });
        }
      });
    } catch (error) {
      counts.errors += 1;
      result.errors += 1;
      log.warn('memory sync: file failed', { kind: unit.kind, code: error?.code ?? error?.name ?? 'ERROR' });
    }
  }
  // Files that left the disk.
  if (units.length) {
    for (const prior of db.prepare('SELECT path, kind FROM files').all()) {
      if (seenPaths.has(prior.path)) continue;
      const rel = prior.path.replace(/^guilds\/[^/]+\//, '');
      if (filter && !filter(prior.path)) continue;
      const counts = bump(result.byKind, prior.kind);
      try {
        transaction(() => {
          const retired = retireUnit(db, rel, at);
          db.prepare('DELETE FROM files WHERE path = ?').run(prior.path);
          counts.retired += retired;
          counts.changed += 1;
          result.retired += retired;
          result.changed += 1;
        });
      } catch (error) {
        counts.errors += 1;
        result.errors += 1;
        log.warn('memory sync: retire failed', { kind: prior.kind, code: error?.code ?? error?.name ?? 'ERROR' });
      }
    }
  }
  // Rows of forgotten members that an earlier pass imported.
  try {
    transaction(() => {
      const before = new Set(JSON.parse(db.prepare("SELECT value FROM meta WHERE key = 'forgotten'").get()?.value ?? '[]'));
      const now = new Set(before);
      for (const ids of forgottenByGuild.values()) {
        for (const userId of ids) {
          if (before.has(userId)) continue;
          result.retired += retireMember(db, userId, at);
          now.add(userId);
        }
      }
      if (result.byKind.record?.changed || result.byKind.participation?.changed) relinkParticipation(db);
      db.prepare("INSERT INTO meta (key, value) VALUES ('forgotten', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify([...now].sort()));
      db.prepare("INSERT INTO meta (key, value) VALUES ('last_sync_at', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(at);
      db.prepare("INSERT INTO meta (key, value) VALUES ('importer_version', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
    });
  } catch (error) {
    result.errors += 1;
    log.warn('memory sync: closing step failed', { kind: 'meta', code: error?.code ?? error?.name ?? 'ERROR' });
  }
  log.info('memory sync: pass done', { seen: result.seen, changed: result.changed, upserted: result.upserted, retired: result.retired, errors: result.errors });
  return result;
}
