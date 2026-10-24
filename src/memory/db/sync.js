// Sync: keeps the memory database equal to the JSON memory files under a data directory (spec section 5).
//
// One pass walks the data directory through the mapper registry (`classify` in map/index.js). For every memory file:
//   - the signature `(size, mtime_ms)` is compared with the `files` row; an unchanged file costs nothing;
//   - a JSON (or text) file that changed is re-mapped whole and upserted by id; rows of that file that the new
//     mapping no longer holds get `retired_at` (never deleted; a row that comes back is un-retired by the upsert);
//   - a JSONL file is read from the stored byte `offset` to its last complete line (a partial last line waits for
//     its newline) and the lines are upserted; a file that shrank, whose first 4 KB or whose last 4 KB before the
//     offset no longer hash as before (a rewrite that kept its start), or that has no stored tail hash yet, is read
//     whole again and handled like a changed JSON file. A malformed line is not consumed: its position and byte start
//     are kept in `files.bad` and it is read again on every pass that reads the file, logged with a code (BAD_LINE)
//     until it parses; a rewritten file starts the list over;
//   - a month of vectors (three files) is one unit, mapped together; a month whose generation is the one stored and
//     whose rows only grew reads just the jsonl bytes and int8 bytes past the stored counts (`appendRows` in
//     map/vectors.js), a new generation (a rewrite) is mapped whole. The month's `gen` and `rows` are kept in the
//     `files` row (`offset` and `lines`);
//   - each file is one transaction, and one bad file is counted and logged (its kind and error code, never its
//     path or content) while the pass goes on.
// A file that left the disk retires its rows and its `files` row becomes a tombstone (`gone_at`); a directory that
// cannot be read is not a vanished directory (nothing under it is retired, the pass logs DIR_UNREADABLE). A unit's
// `owner_file` (and the `files.path`) is the full path from the data root (`guilds/<g>/users/<u>.json`), so two guilds
// never share a unit. A row that two guilds both map (one person in two servers) stays one row owned by the first;
// the others are listed in `co_owners` (an export of their unit finds it, and retiring the owner hands it over). Rows
// the database itself wrote (no `owner_file`) are never updated or retired by a file remap, and neither are child links
// (`claim_sources`, `episode_sources`, `diary_mirrors`) without an `owner_file`: a remap retires the links its file no
// longer holds (`retired_at`) and un-retires the ones that return, it never deletes. A forgotten member (`forgotten.json`,
// `forgetting/*`) is never imported: the member's files and lines are skipped and rows already imported are retired.
//
// From schema v7 every row is written with its derived columns filled from the row itself (rows.js#deriveRow: the
// audience, an account's or a place's authority and native key, a source's author kind), so a remap re-derives them
// and never nulls them; the DM place a DM row names and its audience are created when missing; people, accounts and
// places are registered in `external_keys`; an account with a person gets its `account_person_links` row once. Those
// rows have no `owner_file`: no remap and no retirement of a file ever touches them. From schema v8 a line's `reply_to`
// also gives it a `source_relations` row (rows.js#ensureRelations), inserted once and resolved when the replied line is
// stored; the tables the database owns (participants, links, merges, capture, relations) are never remapped or retired.
// From schema v9 every row a pass writes or retires is projected into the graph in the same transaction
// (graph.js#projectRow), and a full pass (no `filter`) finishes the projection the v9 migration left pending
// (graph.js#projectPending, in slices) in its closing step. Lines are matched to a message by their native tuple (the
// authority, the native kind and generation, and the native id), never by the native id alone.
// Stage 8a: a row an observation wrote live (observe.js: a line, an account, a place under the importer's own id) is
// adopted when its file brings it (`observedRow`): the file's row wins while the files are the writer.
// Stage W2a: `writeMapping`, `qualify`, `retireAbsent` and `linkVectors` are also the database writers' own path
// (unit-write.js): under authority `db` the record, the journal, participation, the diary and the vectors write their
// mapper's rows through them, so a row the writers make is the row a pass would have made.
// From schema v10 every diary mirror a pass writes or retires derives its `publications` row in the same transaction
// (publish.js#deriveMirrorPublication: inserted once by its key, then following the mirror); the other publications,
// the grants and the focus tables are the database's own and no pass touches them.
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
import { fillStems, markStemsPending, stemsPending } from './stems.js';
import { deriveRow, ensureLinks, ensureNodeKeys, ensureRelations } from './rows.js';
import { projectPending, projectRow } from './graph.js';
import { deriveMirrorPublication } from './publish.js';

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
const TAIL_BYTES = 4096;
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

/** The guild directory prefix of a full unit path (`guilds/<g>/`), or null. */
const guildOf = (owner) => /^guilds\/[^/]+\//.exec(String(owner ?? ''))?.[0] ?? null;

/** Inserts a row, or updates the columns it names when the primary key exists (rowid and unnamed columns stay). */
function upsert(db, table, row, { ignore = false } = {}) {
  const have = columnsOf(db, table);
  const out = { ...row };
  if (have.has('retired_at') && !Object.hasOwn(out, 'retired_at')) out.retired_at = null;
  const cols = Object.keys(out).filter((col) => have.has(col));
  const key = OWNED[table] ?? [];
  const update = cols.filter((col) => !key.includes(col));
  // A source whose text changed loses its stems (the pass's closing step stems it again).
  const restem = table === 'sources' && cols.includes('text') && have.has('stems') ? ', "stems" = CASE WHEN excluded."text" IS "sources"."text" THEN "sources"."stems" ELSE NULL END' : '';
  const sql = `INSERT INTO ${quote(table)} (${cols.map(quote).join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) ON CONFLICT(${key.map(quote).join(', ')}) `
    + (ignore || update.length === 0 ? 'DO NOTHING' : `DO UPDATE SET ${update.map((col) => `${quote(col)} = excluded.${quote(col)}`).join(', ')}${restem}`);
  prepared(db, sql).run(...cols.map((col) => bind(out[col])));
}

const keyOf = (table, row) => OWNED[table].map((col) => row[col]).join('\u0000');

/** The existing row of a mapped row's primary key: { owner_file, retired_at, origin? } or undefined. */
function existingOf(db, table, row) {
  const key = OWNED[table];
  const origin = table === 'sources' ? ', origin' : '';
  return prepared(db, `SELECT owner_file, retired_at${origin} FROM ${quote(table)} WHERE ${key.map((col) => `${quote(col)} = ?`).join(' AND ')}`)
    .get(...key.map((col) => bind(row[col])));
}

/**
 * Whether a row the database wrote is an observation's (observe.js, stage 8a) that a file now brings: a line observed
 * live (`origin` `observation`), or an account or a non-DM place (only an observation writes those without a file;
 * the DM places the resolver creates are never in a file). While the files are the writer the file's row wins: the
 * sync adopts it (its `owner_file`, every column the mapping names) instead of skipping it or writing a second row.
 */
const observedRow = (table, found, row) => (table === 'sources' ? found.origin === 'observation'
  : table === 'accounts' || (table === 'places' && row.kind !== 'dm'));

/**
 * Writes one mapped row of a unit, keeping the ownership rules: a row the database wrote (no owner) is left alone;
 * a live row of another guild is shared (listed in `co_owners`, not rewritten); anything else is upserted.
 * Returns true when the row is now this unit's to write (false: skipped).
 */
function writeRow(db, table, row, opts) {
  const found = existingOf(db, table, row);
  if (found) {
    if ((found.owner_file === null || found.owner_file === undefined) && !observedRow(table, found, row)) return false;
    const mine = row.owner_file;
    if (found.owner_file !== mine && found.retired_at === null) {
      const theirs = guildOf(found.owner_file);
      if (theirs !== null && guildOf(mine) !== null && theirs !== guildOf(mine)) {
        prepared(db, 'INSERT OR IGNORE INTO co_owners (tbl, key, owner_file) VALUES (?, ?, ?)').run(table, keyOf(table, row), mine);
        return false;
      }
    }
  }
  // The v7 derived columns (audience, authority, native key, ...) come from the row itself, so a remap re-derives them.
  const derived = deriveRow(db, table, row, { at: opts.at });
  upsert(db, table, derived, opts);
  if (table === 'people' || table === 'accounts' || table === 'places') ensureNodeKeys(db, table, derived, { at: opts.at });
  // Schema v8: a line's `reply_to` is a `replies_to` relation, and relations waiting for this line are resolved. Schema
  // v9: the row's unit is projected (ensureRelations projects a source with its relations).
  if (table === 'sources') ensureRelations(db, derived, { at: opts.at });
  else projectRow(db, table, derived, { at: opts.at });
  if (found && found.owner_file !== row.owner_file) {
    prepared(db, 'DELETE FROM co_owners WHERE tbl = ? AND key = ? AND owner_file = ?').run(table, keyOf(table, row), row.owner_file);
  }
  return true;
}

/** Hands a row over to another live unit that also maps it; false when there is none. */
function handOver(db, table, key, owner) {
  const heir = prepared(db, `SELECT c.owner_file FROM co_owners c JOIN files f ON f.path = c.owner_file
     WHERE c.tbl = ? AND c.key = ? AND c.owner_file != ? AND f.gone_at IS NULL ORDER BY c.owner_file LIMIT 1`).get(table, keyOf(table, key), owner);
  if (!heir) return false;
  const cols = OWNED[table];
  prepared(db, `UPDATE ${quote(table)} SET owner_file = ? WHERE ${cols.map((col) => `${quote(col)} = ?`).join(' AND ')}`).run(heir.owner_file, ...cols.map((col) => key[col]));
  prepared(db, 'DELETE FROM co_owners WHERE tbl = ? AND key = ? AND owner_file = ?').run(table, keyOf(table, key), heir.owner_file);
  for (const [child, [parent, link]] of Object.entries(CHILDREN)) {
    if (parent === table) prepared(db, `UPDATE ${quote(child)} SET owner_file = ? WHERE ${quote(link)} = ? AND owner_file = ?`).run(heir.owner_file, key.id, owner);
  }
  return true;
}

/** The identity of a child link inside its unit: where it sits under its parent (a mirror: which place it was sent to). */
const childKey = (child, row) => (child === 'diary_mirrors'
  ? [row.diary_id, row.iface, row.place_id ?? ''].join('\u0000')
  : [row[CHILDREN[child][1]], row.position].join('\u0000'));

/** Retires the active rows of a unit that the given mapping no longer holds. Returns how many. */
export function retireAbsent(db, owner, mapping, at) {
  let count = 0;
  for (const [table, key] of Object.entries(OWNED)) {
    const keep = new Set((mapping[table] ?? []).map((row) => keyOf(table, row)));
    const existing = prepared(db, `SELECT ${key.map(quote).join(', ')} FROM ${quote(table)} WHERE owner_file = ? AND retired_at IS NULL`).all(owner);
    const update = prepared(db, `UPDATE ${quote(table)} SET retired_at = ? WHERE ${key.map((col) => `${quote(col)} = ?`).join(' AND ')}`);
    for (const row of existing) {
      if (keep.has(keyOf(table, row))) continue;
      if (handOver(db, table, row, owner)) continue;
      update.run(at, ...key.map((col) => row[col]));
      projectRow(db, table, row, { at });
      count += 1;
    }
    // This unit no longer maps the rows it shared with another guild.
    for (const shared of prepared(db, 'SELECT key FROM co_owners WHERE tbl = ? AND owner_file = ?').all(table, owner)) {
      if (!keep.has(shared.key)) prepared(db, 'DELETE FROM co_owners WHERE tbl = ? AND key = ? AND owner_file = ?').run(table, shared.key, owner);
    }
  }
  for (const [child, [parent, link]] of Object.entries(CHILDREN)) {
    const keep = new Set((mapping[child] ?? []).map((row) => childKey(child, row)));
    const cols = child === 'diary_mirrors' ? 'rowid, diary_id, iface, place_id' : `rowid, ${quote(link)}, position`;
    const existing = prepared(db, `SELECT ${cols} FROM ${quote(child)} c WHERE owner_file = ? AND retired_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM ${quote(parent)} p WHERE p.id = c.${quote(link)} AND p.retired_at IS NULL AND p.owner_file IS NOT NULL AND p.owner_file != ?)`).all(owner, owner);
    for (const row of existing) {
      if (keep.has(childKey(child, row))) continue;
      prepared(db, `UPDATE ${quote(child)} SET retired_at = ? WHERE rowid = ?`).run(at, row.rowid);
      if (child === 'diary_mirrors') deriveMirrorPublication(db, row, { at });
      projectRow(db, child, row, { at });
      count += 1;
    }
  }
  return count;
}

/** Retires every active row of a unit. */
const retireUnit = (db, owner, at) => retireAbsent(db, owner, {}, at);

/** Writes the child links of a mapping for one unit: a link that is already there is updated and un-retired, a new one is inserted. */
function writeChildren(db, mapping, owner, skippedParents, touched) {
  let count = 0;
  for (const [child, [parent, link]] of Object.entries(CHILDREN)) {
    for (const row of mapping[child] ?? []) {
      if (skippedParents.has(`${parent}\u0000${row[link]}`)) continue;
      const out = { ...row, owner_file: owner, retired_at: null };
      const cols = Object.keys(out);
      const where = child === 'diary_mirrors' ? 'diary_id = ? AND iface = ? AND coalesce(place_id, \'\') = ?' : `${quote(link)} = ? AND position = ?`;
      const args = child === 'diary_mirrors' ? [row.diary_id, row.iface, row.place_id ?? ''] : [row[link], bind(row.position)];
      const found = prepared(db, `SELECT rowid, owner_file FROM ${quote(child)} WHERE ${where} ORDER BY owner_file IS NULL DESC, rowid LIMIT 1`).get(...args);
      if (found && (found.owner_file === null || found.owner_file === undefined)) continue;
      if (found) {
        prepared(db, `UPDATE ${quote(child)} SET ${cols.map((col) => `${quote(col)} = ?`).join(', ')} WHERE rowid = ?`).run(...cols.map((col) => bind(out[col])), found.rowid);
      } else {
        prepared(db, `INSERT INTO ${quote(child)} (${cols.map(quote).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`).run(...cols.map((col) => bind(out[col])));
      }
      touched.push([child, row]);
      count += 1;
    }
  }
  return count;
}

/** Writes a mapping (table -> rows) of the unit `owner`. */
export function writeMapping(db, mapping, owner, { ignoreClaims = false, at } = {}) {
  let count = 0;
  const skippedParents = new Set();
  for (const [table, rows] of Object.entries(mapping)) {
    if (CHILDREN[table] || !rows.length) continue;
    for (const row of rows) {
      if (writeRow(db, table, row, { ignore: table === 'claims' && ignoreClaims, at })) count += 1;
      else if (Object.values(CHILDREN).some(([parent]) => parent === table)) skippedParents.add(`${table}\u0000${row.id}`);
    }
  }
  // An account with a person gets its link row once; an existing link is the database's and is never rewritten.
  ensureLinks(db, mapping.accounts, { at });
  const touched = [];
  count += writeChildren(db, mapping, owner, skippedParents, touched);
  // A participation file names lines by their message (`src:discord:<id>`): they are pointed at the stored revision
  // before the episodes are projected, so a remap never projects the bare reference for a moment.
  if ((mapping.episode_sources ?? []).length > 0) relinkParticipation(db, at);
  // Schema v10: a mirror's publication follows the mirror (publish.js#deriveMirrorPublication), on this one path.
  for (const [child, row] of touched) {
    if (child === 'diary_mirrors') deriveMirrorPublication(db, row, { at });
    projectRow(db, child, row, { at });
  }
  return count;
}

/** Makes a unit's mapping use the full unit path: `owner_file` of every row, and the `owner` of an operational row built from the path. */
export function qualify(mapping, unit) {
  for (const rows of Object.values(mapping)) {
    for (const row of rows) {
      if (row.owner_file !== undefined && row.owner_file !== null && row.owner_file === unit.rel) {
        if (row.owner !== undefined && (row.owner === unit.rel || String(row.owner).startsWith(`${unit.rel}#`))) row.owner = `${unit.full}${String(row.owner).slice(unit.rel.length)}`;
        row.owner_file = unit.full;
      }
    }
  }
  for (const child of Object.keys(CHILDREN)) for (const row of mapping[child] ?? []) row.owner_file = unit.full;
  return mapping;
}

function merge(into, mapping) {
  for (const [table, rows] of Object.entries(mapping)) (into[table] ??= []).push(...rows);
}

// ---------- the walk ----------

const TEMP_FILE = /\.\d+\.tmp$/;

/**
 * Every file under `dir` as { rel, abs, size, mtimeMs }, depth first in name order. Skipped trees are not entered. A
 * directory or file that cannot be read (anything but a file that vanished between the listing and the stat) is
 * pushed to `unreadable` as { rel, code }: what was under it is not known to be gone.
 */
export function walk(dir, rel = '', out = [], unreadable = []) {
  let entries;
  try {
    entries = fs.readdirSync(path.join(dir, rel), { withFileTypes: true });
  } catch (error) {
    if (rel === '') throw error;
    unreadable.push({ rel, code: error?.code ?? error?.name ?? 'ERROR' });
    return out;
  }
  entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
  for (const entry of entries) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      if (classify(`${child}/_`)?.skipped) continue;
      walk(dir, child, out, unreadable);
    } else if (entry.isFile() && !TEMP_FILE.test(entry.name)) {
      const abs = path.join(dir, child);
      try {
        const stat = fs.statSync(abs);
        out.push({ rel: child, abs, size: stat.size, mtimeMs: Math.floor(stat.mtimeMs) });
      } catch (error) {
        if (error?.code !== 'ENOENT') unreadable.push({ rel: child, code: error?.code ?? error?.name ?? 'ERROR' });
      }
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
  // A table the graph projects returns the ids it retired, and each is projected again (its edges retire with it).
  const run = (table, sql, ...params) => {
    if (table === null) { count += Number(prepared(db, sql).run(...params).changes); return; }
    const done = prepared(db, `${sql} RETURNING id`).all(...params);
    count += done.length;
    for (const row of done) projectRow(db, table, { id: row.id }, { at });
  };
  run('people', 'UPDATE people SET retired_at = ? WHERE id = ? AND retired_at IS NULL', at, person);
  run('accounts', 'UPDATE accounts SET retired_at = ? WHERE id = ? AND retired_at IS NULL', at, account);
  run('memberships', 'UPDATE memberships SET retired_at = ? WHERE account_id = ? AND retired_at IS NULL', at, account);
  run('sources', 'UPDATE sources SET retired_at = ? WHERE author_account = ? AND retired_at IS NULL', at, account);
  run(null, 'UPDATE affinity_events SET retired_at = ? WHERE person_id = ? AND retired_at IS NULL', at, person);
  run('claims', 'UPDATE claims SET retired_at = ? WHERE (subject_id = ? OR from_person = ?) AND retired_at IS NULL', at, person, person);
  for (const table of ['claims', 'episodes', 'sources', 'day', 'diary', 'media', 'intentions', 'work', 'vectors', 'descriptions', 'affinity_events']) {
    const projected = ['day', 'vectors', 'affinity_events'].includes(table) ? null : table;
    run(projected, `UPDATE ${quote(table)} SET retired_at = ? WHERE scope_kind = 'dm' AND scope_dm = ? AND retired_at IS NULL`, at, person);
  }
  return count;
}

// ---------- reading a unit ----------

function readHead(fd, length) {
  const buffer = Buffer.alloc(length);
  const read = length > 0 ? fs.readSync(fd, buffer, 0, length, 0) : 0;
  return buffer.subarray(0, read);
}

function vectorsManifest(unit) {
  const manifestFile = unit.parts.find((part) => part.rel.endsWith('/manifest.json'));
  if (!manifestFile) throw Object.assign(new Error('vectors month without a manifest'), { code: 'NO_MANIFEST' });
  return JSON.parse(fs.readFileSync(manifestFile.abs, 'utf8'));
}

/** Reads a file from a byte position to its end. */
function readFrom(abs, from) {
  const fd = fs.openSync(abs, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    const buffer = Buffer.alloc(Math.max(0, size - from));
    const read = buffer.length ? fs.readSync(fd, buffer, 0, buffer.length, from) : 0;
    return buffer.subarray(0, read);
  } finally {
    fs.closeSync(fd);
  }
}

function readVectors(unit, manifest) {
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

/** The new rows of a month that only grew since the stored pass, or null when the month has to be mapped whole. */
function vectorsAppend(db, unit, prior, manifest) {
  if (!prior || prior.gone_at || prior.offset !== manifest?.gen || !Number.isInteger(prior.lines) || !(manifest.rows > prior.lines)) return null;
  const stored = db.prepare("SELECT value FROM operational WHERE kind = 'vectors' AND owner = ?").get(unit.full);
  let previous;
  try { previous = stored ? JSON.parse(stored.value) : null; } catch { return null; }
  const old = previous?.manifest;
  if (!old || old.rows !== prior.lines || !(old.bytes >= 0) || !(old.metaBytes >= 0)) return null;
  const find = (ext) => unit.parts.find((part) => part.rel.endsWith(`/${manifest.gen}.${ext}`));
  const meta = find('jsonl');
  const i8 = find('i8');
  if (!meta || !i8 || meta.size < manifest.metaBytes || i8.size < manifest.bytes) return null;
  const delta = { manifest, meta: readFrom(meta.abs, old.metaBytes).toString('utf8'), i8: readFrom(i8.abs, old.bytes) };
  const keys = db.prepare('SELECT chunk_key FROM vectors WHERE owner_file = ?').all(unit.full).map((row) => row.chunk_key);
  return unit.mapper.appendRows(unit.rel, delta, { previous, keys });
}

/** The ids of the hot claims and episodes (what an archive line must not stub over, map/archive.js). */
export function hotClaimIds(db) {
  const ids = new Set();
  for (const row of db.prepare("SELECT id FROM claims WHERE retired_at IS NULL AND owner_file NOT GLOB '*archive/*'").all()) ids.add(row.id);
  for (const row of db.prepare('SELECT id FROM episodes WHERE retired_at IS NULL').all()) ids.add(row.id);
  return ids;
}

/**
 * Points every participation message ref (`src:discord:<messageId>`) at the newest revision of that message in the
 * record, when the record has it; a ref the record does not hold is kept as it is. Returns how many were changed.
 */
function relinkParticipation(db, at) {
  // The ref names a Discord message: the line is looked up by its native tuple (schema v8), so another interface's id
  // that happens to be the same string is never taken for it. A database before v8 has only the native id.
  const tuple = columnsOf(db, 'sources').has('native_kind');
  const find = tuple
    ? prepared(db, "SELECT id FROM sources WHERE authority_id = 'discord/global' AND native_kind = 'message' AND generation = 1 AND native_id = ? AND kind IN ('seen', 'said') AND retired_at IS NULL ORDER BY revision DESC LIMIT 1")
    : prepared(db, "SELECT id FROM sources WHERE native_id = ? AND kind IN ('seen', 'said') AND retired_at IS NULL ORDER BY revision DESC LIMIT 1");
  const update = prepared(db, 'UPDATE episode_sources SET source_id = ? WHERE episode_id = ? AND position = ? AND source_id = ?');
  let count = 0;
  for (const row of db.prepare("SELECT episode_id, source_id, position FROM episode_sources WHERE source_id LIKE 'src:discord:%' AND retired_at IS NULL").all()) {
    const messageId = /^src:discord:([^:]+)/.exec(row.source_id)?.[1];
    const found = messageId ? find.get(messageId) : null;
    if (!found || found.id === row.source_id) continue;
    update.run(found.id, row.episode_id, row.position, row.source_id);
    projectRow(db, 'episode_sources', { episode_id: row.episode_id }, { at });
    count += 1;
  }
  return count;
}

export function linkVectors(db, rows) {
  for (const row of rows) {
    const match = /^(?:private:[^:]+:)?record:(.+):([^:]*?)(?:#\d+)?$/.exec(String(row.chunk_key));
    if (!match || match[2] === '') continue;
    const found = prepared(db, "SELECT rowid FROM sources WHERE native_id = ? AND revision = ? AND kind IN ('seen', 'said') ORDER BY kind LIMIT 1")
      .get(match[1], Number(match[2]));
    if (found) row.source_rowid = found.rowid;
  }
}

// ---------- the pass ----------

const upsertFile = (db, unit, fields) => prepared(db, `INSERT INTO files (path, kind, size, mtime_ms, sha1, offset, synced_at, lines, tail_sha1, bad, gone_at)
  VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL) ON CONFLICT(path) DO UPDATE SET kind = excluded.kind, size = excluded.size,
  mtime_ms = excluded.mtime_ms, sha1 = excluded.sha1, offset = excluded.offset, synced_at = excluded.synced_at, lines = excluded.lines,
  tail_sha1 = excluded.tail_sha1, bad = excluded.bad, gone_at = NULL`)
  .run(unit.full, unit.kind, fields.size, bind(fields.mtimeMs), bind(fields.sha1), bind(fields.offset), fields.at, bind(fields.lines), bind(fields.tail), bind(fields.bad));

/** Syncs one JSON, text or vectors unit. Returns { upserted, retired } (null upserted when nothing changed). */
function syncWhole(db, unit, prior, at) {
  let value;
  let generation = null;
  if (unit.format === 'vectors') {
    const manifest = vectorsManifest(unit);
    generation = { gen: Number.isInteger(manifest?.gen) ? manifest.gen : null, rows: Number.isInteger(manifest?.rows) ? manifest.rows : null };
    const rows = vectorsAppend(db, unit, prior, manifest);
    if (rows) {
      for (const row of rows.vectors ?? []) row.owner_file = unit.rel;
      linkVectors(db, rows.vectors ?? []);
      const upserted = writeMapping(db, qualify(rows, unit), unit.full, { at });
      upsertFile(db, unit, { size: unit.size, mtimeMs: unit.mtimeMs, sha1: null, offset: generation.gen, lines: generation.rows, at });
      return { upserted, retired: 0 };
    }
    value = readVectors(unit, manifest);
  } else {
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
  qualify(mapping, unit);
  const upserted = writeMapping(db, mapping, unit.full, { ignoreClaims: unit.kind === 'archive', at });
  const retired = retireAbsent(db, unit.full, mapping, at);
  upsertFile(db, unit, { size: unit.size, mtimeMs: pending ? null : unit.mtimeMs, sha1: pending ? 'pending' : null, offset: generation?.gen ?? null, lines: generation?.rows ?? null, at });
  return { upserted, retired };
}

/** The bytes of a file from `from` to `to` (clamped to the file). */
function readRange(fd, from, to) {
  const length = Math.max(0, to - from);
  const buffer = Buffer.alloc(length);
  const read = length > 0 ? fs.readSync(fd, buffer, 0, length, from) : 0;
  return buffer.subarray(0, read);
}

/** The malformed lines still to retry, as stored: [[position, byteStart], ...]. */
function badOf(prior) {
  try {
    const list = JSON.parse(prior?.bad ?? '[]');
    return Array.isArray(list) ? list.filter((entry) => Array.isArray(entry) && Number.isInteger(entry[0]) && Number.isInteger(entry[1])) : [];
  } catch {
    return [];
  }
}

/**
 * Syncs one JSONL unit: from the stored offset when the file only grew (its first 4 KB and the last 4 KB before the
 * offset still hash as stored), else whole. A malformed line is not consumed: it is read again on the next pass.
 */
function syncLines(db, unit, prior, at, forgotten, errors) {
  const fd = fs.openSync(unit.abs, 'r');
  try {
    const size = fs.fstatSync(fd).size;
    let start = 0;
    let lines = 0;
    let whole = true;
    let retry = [];
    if (prior && !prior.gone_at && Number.isInteger(prior.offset) && prior.offset > 0 && size >= prior.offset && prior.sha1 && prior.tail_sha1) {
      const head = readHead(fd, Math.min(HEAD_BYTES, prior.offset));
      const tail = readRange(fd, Math.max(0, prior.offset - TAIL_BYTES), prior.offset);
      if (sha1Of(head) === prior.sha1 && sha1Of(tail) === prior.tail_sha1 && (prior.offset === 0 || tail[tail.length - 1] === 0x0a)) {
        start = prior.offset;
        lines = prior.lines ?? 0;
        whole = false;
        retry = badOf(prior);
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
    const bad = [];
    const take = (text, position) => {
      if (!text.trim()) return true;
      let value;
      try {
        value = JSON.parse(text);
      } catch {
        return false;
      }
      if (!lineIsForgotten(value, forgotten)) merge(mapping, unit.mapper.toRows(unit.rel, value, { ...ctxBase, position }));
      return true;
    };
    // Lines that did not parse on an earlier pass: the same bytes are tried again.
    for (const [position, byteStart] of retry) {
      const raw = readRange(fd, byteStart, Math.min(prior.offset, byteStart + (1 << 20)));
      const stop = raw.indexOf(0x0a);
      const text = (stop < 0 ? raw : raw.subarray(0, stop)).toString('utf8');
      if (!take(text, position)) bad.push([position, byteStart]);
    }
    let position = lines;
    let cursor = start;
    for (const text of data.subarray(0, end).toString('utf8').split('\n')) {
      if (text.trim()) {
        if (!take(text, position)) bad.push([position, cursor]);
        position += 1;
      }
      cursor += Buffer.byteLength(text) + 1;
    }
    const known = new Set(retry.map(([at2]) => at2));
    for (const [position2] of bad) if (!known.has(position2)) errors.push('BAD_LINE');
    const stillBad = bad.filter(([position2]) => known.has(position2)).length;
    qualify(mapping, unit);
    const upserted = writeMapping(db, mapping, unit.full, { ignoreClaims: unit.kind === 'archive', at });
    const retired = whole ? retireAbsent(db, unit.full, mapping, at) : 0;
    const keepHead = offset === start && !whole;
    upsertFile(db, unit, {
      size: unit.size, mtimeMs: unit.mtimeMs, offset, lines: position, at, bad: bad.length ? JSON.stringify(bad) : null,
      sha1: keepHead ? prior.sha1 : sha1Of(readHead(fd, Math.min(HEAD_BYTES, offset))),
      tail: keepHead ? prior.tail_sha1 : sha1Of(readRange(fd, Math.max(0, offset - TAIL_BYTES), offset)),
    });
    return { upserted, retired, stillBad };
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
  const unreadable = [];
  const everything = walk(dataDir, '', [], unreadable);
  for (const entry of unreadable) log.warn('memory sync: path unreadable, nothing under it is retired', { kind: 'directory', code: entry.code });
  const underUnreadable = (full) => unreadable.some((entry) => full === entry.rel || full.startsWith(`${entry.rel}/`) || entry.rel.startsWith(`${full}/`));
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
          if (prior && !prior.gone_at) {
            const retired = retireUnit(db, unit.full, at);
            db.prepare('UPDATE files SET gone_at = ?, synced_at = ? WHERE path = ?').run(at, at, unit.full);
            counts.retired += retired;
            result.retired += retired;
            counts.changed += 1;
            result.changed += 1;
          }
          result.forgotten += 1;
          return;
        }
        if (prior && prior.size === unit.size && prior.mtime_ms === unit.mtimeMs && !prior.gone_at && !prior.bad) return;
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
          log.warn('memory sync: unreadable lines, retried on the next pass', { kind: unit.kind, code: 'BAD_LINE', count: lineErrors.length });
        }
        if (done.stillBad) log.debug?.('memory sync: a line is still unreadable', { kind: unit.kind, code: 'BAD_LINE', count: done.stillBad });
      });
    } catch (error) {
      counts.errors += 1;
      result.errors += 1;
      log.warn('memory sync: file failed', { kind: unit.kind, code: error?.code ?? error?.name ?? 'ERROR' });
    }
  }
  // Files that left the disk: their rows are retired and the `files` row stays as a tombstone. Nothing is retired
  // under a directory that could not be read.
  if (units.length) {
    for (const prior of db.prepare('SELECT path, kind FROM files WHERE gone_at IS NULL').all()) {
      if (seenPaths.has(prior.path)) continue;
      if (filter && !filter(prior.path)) continue;
      if (underUnreadable(prior.path)) continue;
      const counts = bump(result.byKind, prior.kind);
      try {
        transaction(() => {
          const retired = retireUnit(db, prior.path, at);
          db.prepare('UPDATE files SET gone_at = ?, synced_at = ? WHERE path = ?').run(at, at, prior.path);
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
  // The stems of the rows this pass wrote (the word search reads them; src/memory/db/stems.js). A pass limited to some
  // files (a slice of the first import, `filter`) leaves them: the importer stems once, when the last slice is in.
  try {
    if (result.upserted > 0) markStemsPending(db);
    if (!filter && stemsPending(db)) fillStems(db);
  } catch (error) {
    result.errors += 1;
    log.warn('memory sync: stems failed', { kind: 'sources', code: error?.code ?? error?.name ?? 'ERROR' });
  }
  // The projection the v9 migration left pending (a pass limited to some files leaves it, as it leaves the stems).
  if (!filter) {
    try {
      const done = projectPending({ db, transaction }, { at });
      if (done.units > 0) log.debug?.('memory sync: graph projected', { units: done.units, ms: done.ms, done: done.done });
    } catch (error) {
      result.errors += 1;
      log.warn('memory sync: graph projection failed', { kind: 'graph', code: error?.code ?? error?.name ?? 'ERROR' });
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
      if (result.byKind.record?.changed || result.byKind.participation?.changed) relinkParticipation(db, at);
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
