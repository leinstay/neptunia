// The database writers of the memory units: every memory module writes the rows its unit's mapper derives
// (src/memory/db/map/) through upsert.js (`writeMapping`, `qualify`, `retireAbsent`, `linkVectors`), on the writer
// connection (the worker, through session-write.js#applyMemoryWrite), in one transaction per write: the same id,
// columns, `owner_file` (the unit's full path, `guilds/<g>/record/<YYYY-MM>/<day>.jsonl`) and `position`, the graph
// projected and a diary mirror's publication derived in the same transaction.
//
// applyUnitWrite(handle, update) -> counts.
//   { kind: 'unit', op: 'lines', owner, lines }   every line of a JSONL unit (a record day, a journal day, an archive
//       month, a private layer's alike, `intentions-archive.jsonl`, `tasks.jsonl`) mapped at the next position of the
//       unit (the `files` row's `lines`, else one past the highest position its rows hold) and the `files` row kept
//       (`lines`, so the export and the directory ids find the unit). A record line whose message revision (or, for
//       `deleted`, whose deletion) the unit's month already holds is a duplicate (`duplicates`); a line the live
//       observation wrote first (`origin` `observation`, the same id) is adopted: the line's columns win, its place in
//       the unit stays. An archive line of an item hot memory does not hold brings its retired `historical` claim
//       (map/archive.js). A transition of `tasks.jsonl` the unit already holds (its key is the line itself: the task's
//       id, the transition's time and the task as it was then) is a duplicate, never a second transition, so a write
//       retried after its answer was lost is harmless. Returns `{ written, duplicates, adopted }`.
//   { kind: 'unit', op: 'value', owner, value, destination? }   a whole JSON unit, mapped whole, the unit's rows it
//       no longer holds retired and its `files` row kept: every unit of the store's cache (users, private layers,
//       channels, guild, lore, recent, versions, the diary), participation.json and media.json (whose files stay
//       written), and the module stores' (intentions.json, tasks.json). A diary's mirrors that name no destination get
//       `destination` as in op `diary`. Request dumps (`journal/requests/`) are not written this way.
//   { kind: 'unit', op: 'diary', owner, post, max, updatedAt, destination }   one diary post appended to the diary the
//       database holds (the newest `max` kept, `updatedAt` stamped, as store.js#writeDiary does), the unit mapped
//       whole; its mirrors' publications are derived (publish.js) and, where they name no destination, get
//       `destination` (the diary channel's place) when that place is stored.
//   { kind: 'unit', op: 'vectors', owner, delta }   rows appended to a month of the meaning index: `delta` is
//       `{ manifest, meta, i8 }` (the new manifest, the new jsonl lines, their int8 bytes), mapped by
//       map/vectors.js#appendRows, or the month mapped whole when it cannot be extended (a new month, a stored tail);
//       `{ owner, value }` instead is a whole month (a rewrite, a replace).
//   { kind: 'unit', op: 'project', sliceUnits, maxSlices, at }   the graph projection a migration left pending
//       (graph.js#projectPending, at most `maxSlices` slices) and the stems still pending (stems.js); returns
//       `{ units, done, stems }`.
// An unmapped owner is refused with `UNIT_UNMAPPED`, an unknown op with `UNIT_BAD_OP`. Counts and codes only, never a
// text.

import { classify } from './map/index.js';
import { hotClaimIds, linkVectors, qualify, retireAbsent, writeMapping } from './upsert.js';
import { unitRows } from './export.js';
import { assignDiaryDestination } from './publish.js';
import { graphPending, projectPending } from './graph.js';
import { fillStems, markStemsPending, stemsPending } from './stems.js';

/** Tables of an owned unit whose rows carry a `position`. */
const POSITIONED = [
  'sources',
  'day',
  'decisions',
  'claims',
  'claim_versions',
  'description_versions',
  'episodes',
  'affinity_events',
  'diary',
  'intentions',
  'work',
  'work_events',
];
/** The kinds of JSONL unit op `lines` writes. */
const LINE_KINDS = new Set(['record', 'journal', 'archive', 'intentions', 'tasks']);

const coded = (code) => Object.assign(new Error(code), { code });
const isoOf = (ms) => new Date(Number.isFinite(ms) ? ms : Date.now()).toISOString();
const filled = (value) => typeof value === 'string' && value !== '';

/** What an owner (a unit's full path) is: `{ full, rel, kind, mapper, format, guildId }`; throws `UNIT_UNMAPPED`. */
export function unitOf(owner, { vectors = false } = {}) {
  const full = String(owner ?? '');
  const info = classify(vectors ? `${full}/manifest.json` : full);
  if (!filled(full) || !info || info.skipped || info.guildId === undefined) throw coded('UNIT_UNMAPPED');
  return { full, rel: info.unit, kind: info.kind, mapper: info.mapper, format: info.format, guildId: info.guildId };
}

const hasTable = (db, name) =>
  db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;

/**
 * The next position of a unit: the `files` row's line count when it has one, else one past the highest position its
 * rows hold (0 for a new unit).
 */
export function nextPosition(db, owner) {
  const file = db.prepare('SELECT lines FROM files WHERE path = ? AND gone_at IS NULL').get(owner);
  if (Number.isInteger(file?.lines) && file.lines >= 0) return file.lines;
  let top = -1;
  for (const table of POSITIONED) {
    if (!hasTable(db, table)) continue;
    const found = db.prepare(`SELECT MAX(position) AS p FROM "${table}" WHERE owner_file = ?`).get(owner)?.p;
    if (Number.isInteger(found) && found > top) top = found;
  }
  return top + 1;
}

/**
 * Keeps the `files` row of a unit the writers hold (what the export lists and the directory ids read): created when
 * missing, its line count (`lines`) or a month's generation and rows (`offset`, `lines`) moved. Its size and time stay
 * null (the columns of the files a unit once came from).
 */
export function noteUnit(db, owner, kind, { lines = null, offset = null, at }) {
  db.prepare(
    `INSERT INTO files (path, kind, size, mtime_ms, sha1, offset, synced_at, lines, tail_sha1, bad, gone_at)
      VALUES (?, ?, NULL, NULL, NULL, ?, ?, ?, NULL, NULL, NULL)
    ON CONFLICT(path) DO UPDATE SET kind = excluded.kind, synced_at = excluded.synced_at, gone_at = NULL,
      lines = COALESCE(excluded.lines, files.lines), offset = COALESCE(excluded.offset, files.offset)`
  ).run(owner, kind, offset, at, lines);
}

/** The month prefix of a record unit (`guilds/<g>/record/<YYYY-MM>/`, a private layer's alike). */
const monthPrefixOf = (owner) => owner.replace(/[^/]+$/, '');

/** Whether a record line is one the unit's month already holds (the id index's rule; observations are adopted, not duplicates). */
function recordDuplicate(db, owner, line) {
  const messageId = filled(line?.messageId) ? line.messageId : null;
  if (!messageId) return false;
  const prefix = monthPrefixOf(owner);
  if (line.kind === 'deleted') {
    return (
      db
        .prepare(
          "SELECT 1 AS ok FROM sources WHERE native_id = ? AND kind = 'deleted' AND owner_file >= ? AND owner_file < ? AND retired_at IS NULL LIMIT 1"
        )
        .get(messageId, prefix, `${prefix}￿`) !== undefined
    );
  }
  const revision = Number.isInteger(line.revision) && line.revision > 0 ? line.revision : 1;
  for (const row of db
    .prepare(
      "SELECT id, revision, origin FROM sources WHERE native_id = ? AND kind IN ('seen', 'said') AND owner_file >= ? AND owner_file < ? AND retired_at IS NULL"
    )
    .all(messageId, prefix, `${prefix}￿`)) {
    if (row.origin === 'observation') continue;
    if ((Number.isInteger(row.revision) && row.revision > 0 ? row.revision : 1) === revision) return true;
  }
  return false;
}

/** Whether a task transition line is one the unit already holds (the same line: a retried write). */
function transitionHeld(db, owner, line) {
  return (
    db
      .prepare('SELECT 1 AS ok FROM work_events WHERE owner_file = ? AND record = ? AND retired_at IS NULL LIMIT 1')
      .get(owner, JSON.stringify(line)) !== undefined
  );
}

function writeLines(db, update, at) {
  const unit = unitOf(update.owner);
  if (unit.format !== 'jsonl' || !LINE_KINDS.has(unit.kind)) throw coded('UNIT_UNMAPPED');
  const lines = (Array.isArray(update.lines) ? update.lines : []).filter(
    (line) => line !== null && typeof line === 'object' && !Array.isArray(line)
  );
  const result = { written: 0, duplicates: 0, adopted: 0 };
  let position = nextPosition(db, unit.full);
  // An archive line of an item hot memory does not hold brings its retired claim (map/archive.js).
  const archive = unit.kind === 'archive';
  const ctx = archive ? { guildId: unit.guildId, hotClaimIds: hotClaimIds(db) } : { guildId: unit.guildId };
  for (const line of lines) {
    const mapping = unit.mapper.toRows(unit.rel, line, { ...ctx, position });
    const source = unit.kind === 'record' ? mapping.sources?.[0] : null;
    const found = source
      ? db.prepare('SELECT owner_file, position, origin, retired_at FROM sources WHERE id = ?').get(source.id)
      : undefined;
    if (unit.kind === 'record' && recordDuplicate(db, unit.full, line)) {
      result.duplicates += 1;
      continue;
    }
    if (unit.kind === 'tasks' && transitionHeld(db, unit.full, line)) {
      result.duplicates += 1;
      continue;
    }
    if (found && found.origin !== 'observation' && found.retired_at === null) {
      result.duplicates += 1;
      continue;
    }
    // The live observation wrote the line first: the line takes the row over, its place in the unit stays.
    const keep =
      found && found.origin === 'observation' && found.owner_file === unit.full && Number.isInteger(found.position);
    if (keep) source.position = found.position;
    writeMapping(db, qualify(mapping, unit), unit.full, { at, ignoreClaims: archive });
    if (found && found.origin === 'observation') result.adopted += 1;
    result.written += 1;
    if (!keep) position += 1;
  }
  noteUnit(db, unit.full, unit.kind, { lines: position, at });
  if (result.written > 0) markStemsPending(db);
  return result;
}

/** The kinds of JSON unit op `value` does not write (the request dumps: a step source needs its turn's answer). */
const NOT_VALUE_KINDS = new Set(['requests']);

function writeValue(db, update, at) {
  const unit = unitOf(update.owner);
  if (unit.format !== 'json' || NOT_VALUE_KINDS.has(unit.kind)) throw coded('UNIT_UNMAPPED');
  const mapping = qualify(unit.mapper.toRows(unit.rel, update.value ?? {}, { guildId: unit.guildId }), unit);
  const upserted = writeMapping(db, mapping, unit.full, { at });
  const retired = retireAbsent(db, unit.full, mapping, at);
  noteUnit(db, unit.full, unit.kind, { at });
  const destinations =
    unit.kind === 'diary' && filled(update.destination)
      ? assignDiaryDestination(db, update.destination, { owner: unit.full, at })
      : 0;
  return { upserted, retired, ...(unit.kind === 'diary' ? { destinations } : {}) };
}

function writeDiary(db, update, at) {
  const unit = unitOf(update.owner);
  if (unit.kind !== 'diary') throw coded('UNIT_UNMAPPED');
  const rows = unitRows(db, unit.full);
  const held = rows.operational.length > 0 ? unit.mapper.fromRows(rows) : { posts: [] };
  const posts = [
    ...(Array.isArray(held.posts) ? held.posts : []),
    ...(update.post && typeof update.post === 'object' ? [update.post] : []),
  ];
  const max = Number.isInteger(update.max) && update.max > 0 ? update.max : posts.length;
  const value = {
    posts: posts.slice(-max),
    updatedAt: Number.isFinite(update.updatedAt) ? update.updatedAt : Date.parse(at),
  };
  const mapping = qualify(unit.mapper.toRows(unit.rel, value, { guildId: unit.guildId }), unit);
  const upserted = writeMapping(db, mapping, unit.full, { at });
  const retired = retireAbsent(db, unit.full, mapping, at);
  noteUnit(db, unit.full, unit.kind, { at });
  const destinations = filled(update.destination)
    ? assignDiaryDestination(db, update.destination, { owner: unit.full, at })
    : 0;
  return { upserted, retired, posts: value.posts.length, destinations };
}

/** A whole month of vectors (its rows linked to their lines, the rows it no longer holds retired). */
function writeMonth(db, unit, value, at) {
  const mapping = unit.mapper.toRows(unit.rel, value, { guildId: unit.guildId });
  for (const row of mapping.vectors ?? []) row.owner_file = unit.rel;
  linkVectors(db, mapping.vectors ?? []);
  qualify(mapping, unit);
  const upserted = writeMapping(db, mapping, unit.full, { at });
  const retired = retireAbsent(db, unit.full, mapping, at);
  return { upserted, retired };
}

function writeVectors(db, update, at) {
  const unit = unitOf(update.owner, { vectors: true });
  if (unit.kind !== 'vectors') throw coded('UNIT_UNMAPPED');
  let done;
  let manifest;
  if (update.value) {
    manifest = update.value.manifest;
    done = writeMonth(db, unit, update.value, at);
  } else {
    const delta = update.delta ?? {};
    manifest = delta.manifest;
    const stored = db
      .prepare("SELECT value FROM operational WHERE kind = 'vectors' AND owner = ? AND retired_at IS NULL")
      .get(unit.full);
    let previous = null;
    try {
      previous = stored ? JSON.parse(stored.value) : null;
    } catch {
      previous = null;
    }
    const keys = db
      .prepare('SELECT chunk_key FROM vectors WHERE owner_file = ?')
      .all(unit.full)
      .map((row) => row.chunk_key);
    const rows = previous ? unit.mapper.appendRows(unit.rel, delta, { previous, keys }) : null;
    if (rows) {
      for (const row of rows.vectors ?? []) row.owner_file = unit.rel;
      linkVectors(db, rows.vectors ?? []);
      done = { upserted: writeMapping(db, qualify(rows, unit), unit.full, { at }), retired: 0 };
    } else {
      // A new month is the delta whole; a stored month that cannot be extended is rebuilt with the delta after its
      // counted rows (a tail past the manifest's count is dropped, as the file append cuts it).
      let value = {
        manifest,
        meta: Buffer.isBuffer(delta.meta) ? delta.meta.toString('utf8') : String(delta.meta ?? ''),
        i8: Buffer.from(delta.i8 ?? []),
      };
      if (previous) {
        const held = unit.mapper.fromRows(unitRows(db, unit.full));
        const counted = Number.isInteger(previous.manifest?.bytes) ? previous.manifest.bytes : held.i8.length;
        value = {
          manifest,
          meta: `${held.meta}${value.meta}`,
          i8: Buffer.concat([Buffer.from(held.i8).subarray(0, counted), value.i8]),
        };
      }
      done = writeMonth(db, unit, value, at);
    }
  }
  noteUnit(db, unit.full, unit.kind, {
    lines: Number.isInteger(manifest?.rows) ? manifest.rows : null,
    offset: Number.isInteger(manifest?.gen) ? manifest.gen : null,
    at,
  });
  return done;
}

function project(handle, update, at) {
  const out = { units: 0, done: true, stems: 0 };
  if (graphPending(handle)) {
    const slice = Number.isInteger(update.sliceUnits) && update.sliceUnits > 0 ? update.sliceUnits : undefined;
    const done = projectPending(handle, {
      at,
      ...(slice ? { sliceUnits: slice } : {}),
      maxSlices: Number.isInteger(update.maxSlices) && update.maxSlices > 0 ? update.maxSlices : 1,
    });
    out.units = done.units;
    out.done = done.done;
  }
  // The stems run their own transactions (stems.js#fillStems).
  if (stemsPending(handle.db)) out.stems = fillStems(handle.db)?.stamped ?? 0;
  return out;
}

/**
 * One write of an append-like memory unit (see the head of this file).
 * @param {{ db: object, transaction: (fn: () => any) => any }} handle  the writer
 * @param {object} update
 */
export function applyUnitWrite(handle, update) {
  const at = isoOf(update?.now);
  const op = update?.op;
  if (op === 'project') return project(handle, update, at);
  const db = handle.db;
  const run = {
    lines: () => writeLines(db, update, at),
    value: () => writeValue(db, update, at),
    diary: () => writeDiary(db, update, at),
    vectors: () => writeVectors(db, update, at),
  }[op];
  if (!run) throw coded('UNIT_BAD_OP');
  return handle.transaction(run);
}
