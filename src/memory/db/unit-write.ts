// The database writers of the memory units: every memory module writes the rows its unit's mapper derives
// (src/memory/db/map/) through upsert.ts (`writeMapping`, `qualify`, `retireAbsent`, `linkVectors`), on the writer
// connection (the worker, through session-write.ts#applyMemoryWrite), in one transaction per write: the same id,
// columns, `owner_file` (the unit's full path, `guilds/<g>/record/<YYYY-MM>/<day>.jsonl`) and `position`, the graph
// projected and a diary mirror's publication derived in the same transaction.
//
// applyUnitWrite(handle, update) -> counts.
//   { kind: 'unit', op: 'lines', owner, lines }   every line of a JSONL unit (a record day, a journal day, an archive
//       month, a private layer's alike, `intentions-archive.jsonl`, `errands.jsonl`) mapped at the next position of the
//       unit (the `files` row's `lines`, else one past the highest position its rows hold) and the `files` row kept
//       (`lines`, so the export and the directory ids find the unit). A record line whose message revision (or, for
//       `deleted`, whose deletion) the unit's month already holds is a duplicate (`duplicates`); a line the live
//       observation wrote first (`origin` `observation`, the same id) is adopted: the line's columns win, its place in
//       the unit stays. An archive line of an item hot memory does not hold brings its retired `historical` claim
//       (map/archive.ts). A transition of `errands.jsonl` the unit already holds (its key is the line itself: the task's
//       id, the transition's time and the task as it was then) is a duplicate, never a second transition, so a write
//       retried after its answer was lost is harmless. Returns `{ written, duplicates, adopted }`.
//   { kind: 'unit', op: 'value', owner, value, destination? }   a whole JSON unit, mapped whole, the unit's rows it
//       no longer holds retired and its `files` row kept: every unit of the store's cache (users, private layers,
//       channels, guild, lore, recent, versions, the diary), participation.json and media.json (whose files stay
//       written), and the module stores' (intentions.json, errands.json). A diary's mirrors that name no destination get
//       `destination` as in op `diary`. Request dumps (`journal/requests/`) are not written this way.
//   { kind: 'unit', op: 'diary', owner, post, max, updatedAt, destination }   one diary post appended to the diary the
//       database holds (the newest `max` kept, `updatedAt` stamped, as store.js#writeDiary does), the unit mapped
//       whole; its mirrors' publications are derived (publish.ts) and, where they name no destination, get
//       `destination` (the diary channel's place) when that place is stored.
//   { kind: 'unit', op: 'vectors', owner, delta }   rows appended to a month of the meaning index: `delta` is
//       `{ manifest, meta, i8 }` (the new manifest, the new jsonl lines, their int8 bytes), mapped by
//       map/vectors.ts#appendRows, or the month mapped whole when it cannot be extended (a new month, a stored tail);
//       `{ owner, value }` instead is a whole month (a rewrite, a replace).
//   { kind: 'unit', op: 'project', sliceUnits, maxSlices, at }   the graph projection a migration left pending
//       (graph.ts#projectPending, at most `maxSlices` slices) and the stems still pending (stems.ts); returns
//       `{ units, done, stems }`.
//   { kind: 'unit', op: 'errand', owner, value }   one write of the errand store (src/errands/store.ts): `value` is a
//       src/board/errands.ts#ErrandSave with its `closing` (the closing journal line, `{ owner, line }`, or null) and
//       `owner` the outbox's key of that errand (`board/errands/<id>`). src/board/errands.ts#applyErrandUnit brings the
//       board to the errand and, when the save moves it to an end, the closing line is written as op `lines` writes it,
//       all in one transaction. Returns `{ ended }`.
// From board v3 (src/board/errands.ts#ERRANDS_ON_BOARD) her errands live on the board: a write of an errand unit
// (`errands.json`, `errands.jsonl`, under either name) is accepted and writes nothing, its count returned as
// `skipped` (the service logs it), so `work` and `work_events` stay the archive board v3 left.
// An unmapped owner is refused with `UNIT_UNMAPPED`, an unknown op with `UNIT_BAD_OP`. Counts and codes only, never a
// text.

import { currentUnitPath } from './paths.ts';
import { classify } from './map/index.ts';
import { ifaceOrLegacy as ifaceOf } from './legacy-namespace.ts';
import { hotClaimIds, linkVectors, qualify, retireAbsent, writeMapping } from './upsert.ts';
import { unitRows } from './export.ts';
import { assignDiaryDestination } from './publish.ts';
import { graphPending, projectPending } from './graph.ts';
import { fillStems, markStemsPending, stemsPending } from './stems.ts';
import { applyErrandUnit, skippedErrandUnit } from '../../board/errands.ts';
import { dbOf, asText, isFiniteNumber, isWholeNumber } from './types.ts';
import type { Db, MemoryHandle, Row } from './types.ts';
import type { MappedPath } from './map/index.ts';

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
const LINE_KINDS = new Set(['record', 'journal', 'archive', 'intentions', 'errands']);

const coded = (code: string): Error & { code: string } => Object.assign(new Error(code), { code });
const isoOf = (ms: unknown): string => new Date(isFiniteNumber(ms) ? ms : Date.now()).toISOString();
const filled = (value: unknown): value is string => typeof value === 'string' && value !== '';

/** What an owner is: its full path and the path inside its guild, the mapper and the kind and format of its file. */
export type Unit = {
  full: string;
  rel: string;
  kind: MappedPath['kind'];
  mapper: MappedPath['mapper'];
  format: MappedPath['format'];
  guildId: string;
};

/** What an owner (a unit's full path) is: `{ full, rel, kind, mapper, format, guildId }`; throws `UNIT_UNMAPPED`. */
export function unitOf(owner: unknown, { vectors = false }: { vectors?: boolean } = {}): Unit {
  const full = currentUnitPath(asText(owner ?? ''));
  const info = classify(vectors ? `${full}/manifest.json` : full);
  if (!filled(full) || !info || 'skipped' in info || info.guildId === undefined) throw coded('UNIT_UNMAPPED');
  return { full, rel: info.unit, kind: info.kind, mapper: info.mapper, format: info.format, guildId: info.guildId };
}

const hasTable = (db: Db, name: string): boolean =>
  db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;

/**
 * The next position of a unit: the `files` row's line count when it has one, else one past the highest position its
 * rows hold (0 for a new unit).
 */
export function nextPosition(db: Db, owner: string): number {
  const file = db.prepare('SELECT lines FROM files WHERE path = ? AND gone_at IS NULL').get(owner);
  if (typeof file?.lines === 'number' && Number.isInteger(file.lines) && file.lines >= 0) return file.lines;
  let top = -1;
  for (const table of POSITIONED) {
    if (!hasTable(db, table)) continue;
    const found = db.prepare(`SELECT MAX(position) AS p FROM "${table}" WHERE owner_file = ?`).get(owner)?.p;
    if (isWholeNumber(found) && found > top) top = found;
  }
  return top + 1;
}

/**
 * Keeps the `files` row of a unit the writers hold (what the export lists and the directory ids read): created when
 * missing, its line count (`lines`) or a month's generation and rows (`offset`, `lines`) moved. Its size and time stay
 * null (the columns of the files a unit once came from).
 */
export function noteUnit(
  db: Db,
  owner: string,
  kind: string,
  { lines = null, offset = null, at }: { lines?: number | null; offset?: number | null; at: string }
): void {
  db.prepare(
    `INSERT INTO files (path, kind, size, mtime_ms, sha1, offset, synced_at, lines, tail_sha1, bad, gone_at)
      VALUES (?, ?, NULL, NULL, NULL, ?, ?, ?, NULL, NULL, NULL)
    ON CONFLICT(path) DO UPDATE SET kind = excluded.kind, synced_at = excluded.synced_at, gone_at = NULL,
      lines = COALESCE(excluded.lines, files.lines), offset = COALESCE(excluded.offset, files.offset)`
  ).run(owner, kind, offset, at, lines);
}

/** The month prefix of a record unit (`guilds/<g>/record/<YYYY-MM>/`, a private layer's alike). */
const monthPrefixOf = (owner: string) => owner.replace(/[^/]+$/, '');

/** Whether a record line is one the unit's month already holds (the id index's rule; observations are adopted, not duplicates). */
function recordDuplicate(db: Db, owner: string, line: Row): boolean {
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
  const revision = isWholeNumber(line.revision) && line.revision > 0 ? line.revision : 1;
  for (const row of db
    .prepare(
      "SELECT id, revision, origin FROM sources WHERE native_id = ? AND kind IN ('seen', 'said') AND owner_file >= ? AND owner_file < ? AND retired_at IS NULL"
    )
    .all(messageId, prefix, `${prefix}￿`)) {
    if (row.origin === 'observation') continue;
    const stored = row.revision;
    if ((isWholeNumber(stored) && stored > 0 ? stored : 1) === revision) return true;
  }
  return false;
}

/** Whether a task transition line is one the unit already holds (the same line: a retried write). */
function transitionHeld(db: Db, owner: string, line: unknown): boolean {
  return (
    db
      .prepare('SELECT 1 AS ok FROM work_events WHERE owner_file = ? AND record = ? AND retired_at IS NULL LIMIT 1')
      .get(owner, JSON.stringify(line)) !== undefined
  );
}

function writeLines(db: Db, update: Row, at: string): { written: number; duplicates: number; adopted: number } {
  const unit = unitOf(update.owner);
  if (unit.format !== 'jsonl' || !LINE_KINDS.has(unit.kind)) throw coded('UNIT_UNMAPPED');
  const lines = (Array.isArray(update.lines) ? (update.lines as Array<unknown>) : []).filter(
    (line): line is Row => line !== null && typeof line === 'object' && !Array.isArray(line)
  );
  const result = { written: 0, duplicates: 0, adopted: 0 };
  let position = nextPosition(db, unit.full);
  // An archive line of an item hot memory does not hold brings its retired claim (map/archive.ts).
  const archive = unit.kind === 'archive';
  const ctx = archive
    ? { guildId: unit.guildId, iface: ifaceOf(update), hotClaimIds: hotClaimIds(db) }
    : { guildId: unit.guildId, iface: ifaceOf(update) };
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
    if (unit.kind === 'errands' && transitionHeld(db, unit.full, line)) {
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
    // A row is looked up only for a source line, so `keep` holds only with one.
    if (keep) (source as Row).position = found.position;
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

function writeValue(db: Db, update: Row, at: string): Row {
  const unit = unitOf(update.owner);
  if (unit.format !== 'json' || NOT_VALUE_KINDS.has(unit.kind)) throw coded('UNIT_UNMAPPED');
  const mapping = qualify(
    unit.mapper.toRows(unit.rel, update.value ?? {}, { guildId: unit.guildId, iface: ifaceOf(update) }),
    unit
  );
  const upserted = writeMapping(db, mapping, unit.full, { at });
  const retired = retireAbsent(db, unit.full, mapping, at);
  noteUnit(db, unit.full, unit.kind, { at });
  const destinations =
    unit.kind === 'diary' && filled(update.destination)
      ? assignDiaryDestination(db, update.destination, { owner: unit.full, at })
      : 0;
  return { upserted, retired, ...(unit.kind === 'diary' ? { destinations } : {}) };
}

function writeDiary(db: Db, update: Row, at: string): Row {
  const unit = unitOf(update.owner);
  if (unit.kind !== 'diary') throw coded('UNIT_UNMAPPED');
  const rows = unitRows(db, unit.full);
  const held = (rows.operational.length > 0 ? unit.mapper.fromRows(rows) : { posts: [] }) as { posts?: unknown };
  const posts = [
    ...(Array.isArray(held.posts) ? (held.posts as Array<unknown>) : []),
    ...(update.post && typeof update.post === 'object' ? [update.post] : []),
  ];
  const max = isWholeNumber(update.max) && update.max > 0 ? update.max : posts.length;
  const value = {
    posts: posts.slice(-max),
    updatedAt: isFiniteNumber(update.updatedAt) ? update.updatedAt : Date.parse(at),
  };
  const mapping = qualify(unit.mapper.toRows(unit.rel, value, { guildId: unit.guildId, iface: ifaceOf(update) }), unit);
  const upserted = writeMapping(db, mapping, unit.full, { at });
  const retired = retireAbsent(db, unit.full, mapping, at);
  noteUnit(db, unit.full, unit.kind, { at });
  const destinations = filled(update.destination)
    ? assignDiaryDestination(db, update.destination, { owner: unit.full, at })
    : 0;
  return { upserted, retired, posts: value.posts.length, destinations };
}

/** A whole month of vectors (its rows linked to their lines, the rows it no longer holds retired). */
function writeMonth(db: Db, unit: Unit, value: Row, at: string, iface: string): Row {
  const mapping = unit.mapper.toRows(unit.rel, value, { guildId: unit.guildId, iface });
  for (const row of mapping.vectors ?? []) row.owner_file = unit.rel;
  linkVectors(db, mapping.vectors ?? []);
  qualify(mapping, unit);
  const upserted = writeMapping(db, mapping, unit.full, { at });
  const retired = retireAbsent(db, unit.full, mapping, at);
  return { upserted, retired };
}

/** The files of a month an update carries: the manifest, the jsonl text and the int8 bytes. */
type MonthDelta = { manifest?: Row; meta?: unknown; i8?: ArrayLike<number> };

function writeVectors(db: Db, update: Row, at: string): Row {
  const unit = unitOf(update.owner, { vectors: true });
  if (unit.kind !== 'vectors') throw coded('UNIT_UNMAPPED');
  let done: Row;
  let manifest: Row | undefined;
  if (update.value) {
    manifest = (update.value as MonthDelta).manifest;
    done = writeMonth(db, unit, update.value as Row, at, ifaceOf(update));
  } else {
    const delta = (update.delta ?? {}) as MonthDelta;
    manifest = delta.manifest;
    const stored = db
      .prepare("SELECT value FROM operational WHERE kind = 'vectors' AND owner = ? AND retired_at IS NULL")
      .get(unit.full);
    let previous: { manifest?: Row; raw?: unknown; tailI8?: unknown } | null = null;
    try {
      previous = stored ? JSON.parse(stored.value as string) : null;
    } catch {
      previous = null;
    }
    const keys = db
      .prepare('SELECT chunk_key FROM vectors WHERE owner_file = ?')
      .all(unit.full)
      .map((row) => row.chunk_key as string);
    // `appendRows` is the vectors mapper's: this write is for that kind alone (`unitOf` above checked it).
    const rows = previous
      ? unit.mapper.appendRows!(unit.rel, delta as never, { previous: previous as never, keys, iface: ifaceOf(update) })
      : null;
    if (rows) {
      for (const row of rows.vectors ?? []) row.owner_file = unit.rel;
      linkVectors(db, rows.vectors ?? []);
      done = { upserted: writeMapping(db, qualify(rows, unit), unit.full, { at }), retired: 0 };
    } else {
      // A new month is the delta whole; a stored month that cannot be extended is rebuilt with the delta after its
      // counted rows (a tail past the manifest's count is dropped, as the file append cuts it).
      let value: { manifest: Row | undefined; meta: string; i8: Buffer } = {
        manifest,
        meta: Buffer.isBuffer(delta.meta) ? delta.meta.toString('utf8') : asText(delta.meta ?? ''),
        i8: Buffer.from(delta.i8 ?? []),
      };
      if (previous) {
        const held = unit.mapper.fromRows(unitRows(db, unit.full)) as { meta: string; i8: Buffer };
        const bytes = previous.manifest?.bytes;
        const counted = isWholeNumber(bytes) ? bytes : held.i8.length;
        value = {
          manifest,
          meta: `${held.meta}${value.meta}`,
          i8: Buffer.concat([Buffer.from(held.i8).subarray(0, counted), value.i8]),
        };
      }
      done = writeMonth(db, unit, value, at, ifaceOf(update));
    }
  }
  noteUnit(db, unit.full, unit.kind, {
    lines: isWholeNumber(manifest?.rows) ? manifest.rows : null,
    offset: isWholeNumber(manifest?.gen) ? manifest.gen : null,
    at,
  });
  return done;
}

function project(handle: MemoryHandle, update: Row, at: string): { units: number; done: boolean; stems: number } {
  const out = { units: 0, done: true, stems: 0 };
  if (graphPending(handle)) {
    const slice = isWholeNumber(update.sliceUnits) && update.sliceUnits > 0 ? update.sliceUnits : undefined;
    const done = projectPending(handle, {
      at,
      ...(slice ? { sliceUnits: slice } : {}),
      maxSlices: isWholeNumber(update.maxSlices) && update.maxSlices > 0 ? update.maxSlices : 1,
    });
    out.units = done.units;
    out.done = done.done;
  }
  // The stems run their own transactions (stems.ts#fillStems).
  if (stemsPending(dbOf(handle))) out.stems = fillStems(dbOf(handle))?.stamped ?? 0;
  return out;
}

/**

 * One write of an append-like memory unit (see the head of this file). `handle` is the writer.
 */
export function applyUnitWrite(handle: MemoryHandle, update: Row): unknown {
  const at = isoOf(update?.now);
  const op = update?.op;
  if (op === 'project') return project(handle, update, at);
  const db = dbOf(handle);
  const runs: Record<string, (() => unknown) | undefined> = {
    lines: () => skippedErrandUnit(db, update, unitOf) ?? writeLines(db, update, at),
    value: () => skippedErrandUnit(db, update, unitOf) ?? writeValue(db, update, at),
    diary: () => writeDiary(db, update, at),
    vectors: () => writeVectors(db, update, at),
    errand: () => applyErrandUnit(db, update, at, (closing) => writeLines(db, closing, at)),
  };
  const run = typeof op === 'string' ? runs[op] : undefined;
  if (!run) throw coded('UNIT_BAD_OP');
  return handle.transaction(run);
}
