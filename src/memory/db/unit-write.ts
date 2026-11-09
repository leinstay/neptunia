// The memory writer applies semantic unit updates in one transaction. Value writes replace a collection while
// preserving protected session rows; lines append in catalog order. A day of the record or of the journal and a month
// of the archive are that kind's lines write (record-lines.ts, journal-lines.ts, archive-lines.ts), and an account's
// profile, a private layer and a history of prose that kind's value write (account-profile.ts, private-layer.ts,
// prose-versions.ts). Selfreflection and
// vector operations keep their existing publication and index behavior. Catalog owner keys are independent of source
// IDs and visibility. Historical owner strings are accepted by the explicit import and pending compatibility boundary,
// which preserves their provenance without using it for live ownership.

import { ensureUnit, hasStorageUnits } from './storage-units.ts';
import { storageMapper } from './map/index.ts';
import { classify } from '../migration/classify.ts';
import { legacyStorageKey, currentUnitPath } from '../migration/paths.ts';
import type { StorageKey } from './storage-keys.ts';
import type { MapContext } from './map/common.ts';
import { parseExtra } from './map/common.ts';

import { ifaceOrLegacy as ifaceOf } from './legacy-namespace.ts';
import { qualify, retireAbsent, writeMapping } from './upsert.ts';
import { unitRows, isMediaDescriptionEntry, mediaDescriptionId } from './export.ts';
import { assignSelfreflectionDestination } from './publish.ts';
import { graphPending, projectPending, projectRow } from './graph.ts';
import { storeHeld } from './media-stems.ts';
import { fillStems, markStemsPending, stemsPending } from './stems.ts';
import { adoptLibraryRows, keepItemFields, tellFromCacheKey, writeMediaCache } from './media-store.ts';
import { applyErrandUnit, skippedErrandUnit } from '../../board/errands.ts';
import { dbOf, asText, isFiniteNumber, isWholeNumber } from './types.ts';
import type { Db, MemoryHandle, Row } from './types.ts';
import type { MappedPath } from '../migration/classify.ts';
import { SCOPE_INTERNAL, audienceOf, groupScope } from './scope.ts';
import type { Scope } from './scope.ts';
import { ensureAudience } from './rows.ts';
import { legacyPersonNative } from './ids.ts';
import { writeGifVector } from './gif-vectors.ts';
import { intentionsOfUnit, writeIntentions } from './intentions-write.ts';
import { monthLines, writeLineVectors } from './line-vectors.ts';
import { writeRecordDay } from './record-lines.ts';
import { writeJournalDay } from './journal-lines.ts';
import { writeArchiveMonth } from './archive-lines.ts';
import { operationalOfUnit, writeOperational } from './operational.ts';
import { accountProfileWriteOf, isAccountProfileKey, writeAccountProfile } from './account-profile.ts';
import { SESSION_COLUMNS, profileOwnerOf, stampProfileRows } from './profile-owner.ts';
import { proseVersionsValueOf, writeProseVersions } from './prose-versions.ts';
import { isPrivateLayerKey, privateLayerWriteOf, writePrivateLayer } from './private-layer.ts';
import { storageContext } from './map/index.ts';

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
  'selfreflection',
  'intentions',
  'work',
  'work_events',
];
/** The kinds of JSONL unit op `lines` writes. */
const LINE_KINDS = new Set(['errands']);

const coded = (code: string): Error & { code: string } => Object.assign(new Error(code), { code });
const isoOf = (ms: unknown): string => new Date(isFiniteNumber(ms) ? ms : Date.now()).toISOString();
const filled = (value: unknown): value is string => typeof value === 'string' && value !== '';

/** What an owner is: its full id and its id inside the mapper, the mapper and the kind and format of its lines. */
export type Unit = {
  full: string;
  rel: string;
  kind: MappedPath['kind'];
  mapper: MappedPath['mapper'];
  format: MappedPath['format'];
  key?: StorageKey;
};

/** What an owner (a unit's full path) is: `{ full, rel, kind, mapper, format }`; throws `UNIT_UNMAPPED`. */
export function unitOf(owner: unknown, { vectors = false }: { vectors?: boolean } = {}): Unit {
  const full = currentUnitPath(asText(owner ?? ''));
  const info = classify(vectors ? `${full}/manifest.json` : full);
  if (!filled(full) || !info || 'skipped' in info) throw coded('UNIT_UNMAPPED');
  return { full, rel: info.unit, kind: info.kind, mapper: info.mapper, format: info.format };
}

/** Resolve a live semantic update; legacy owners are accepted only by import and pending adapters. */
function updateUnit(db: Db, update: Row, vectors = false): Unit {
  if (!hasStorageUnits(db)) return unitOf(update.owner, { vectors });
  const key = (update.key as StorageKey | undefined) ?? legacyStorageKey(String(update.owner), ifaceOf(update));
  const id = ensureUnit(db, key);
  const legacyOwner = typeof update.owner === 'string' && !update.key ? update.owner : undefined;
  if (legacyOwner) {
    db.prepare('INSERT OR IGNORE INTO legacy_unit_aliases(path,unit_id) VALUES (?,?)').run(legacyOwner, id);
    db.prepare('INSERT OR IGNORE INTO files(path,kind) VALUES (?,?)').run(legacyOwner, key.kind);
  }
  const mapped = storageMapper(db, key, id, legacyOwner);
  return { full: id, rel: id, ...mapped, key };
}

const hasTable = (db: Db, name: string): boolean =>
  db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;

/**
 * The next position of a unit: the `files` row's line count when it has one, else one past the highest position its
 * rows hold (0 for a new unit).
 */
export function nextPosition(db: Db, owner: string): number {
  const file = hasStorageUnits(db)
    ? db.prepare('SELECT lines FROM storage_units WHERE id = ? AND retired_at IS NULL').get(owner)
    : db.prepare('SELECT lines FROM files WHERE path = ? AND gone_at IS NULL').get(owner);
  if (typeof file?.lines === 'number' && Number.isInteger(file.lines) && file.lines >= 0) return file.lines;
  let top = -1;
  for (const table of POSITIONED) {
    if (!hasTable(db, table)) continue;
    const found = db
      .prepare(
        `SELECT MAX(position) AS p FROM "${table}" WHERE ${hasStorageUnits(db) ? 'owner_key' : 'owner_file'} = ?`
      )
      .get(owner)?.p;
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
  if (hasStorageUnits(db)) {
    const id = owner.startsWith('unit:') ? owner : ensureUnit(db, legacyStorageKey(owner));
    db.prepare(
      'UPDATE storage_units SET lines=COALESCE(?,lines), offset=COALESCE(?,offset), synced_at=?, retired_at=NULL WHERE id=?'
    ).run(lines, offset, at, id);
    return;
  }
  db.prepare(
    `INSERT INTO files (path, kind, size, mtime_ms, sha1, offset, synced_at, lines, tail_sha1, bad, gone_at)
      VALUES (?, ?, NULL, NULL, NULL, ?, ?, ?, NULL, NULL, NULL)
    ON CONFLICT(path) DO UPDATE SET kind = excluded.kind, synced_at = excluded.synced_at, gone_at = NULL,
      lines = COALESCE(excluded.lines, files.lines), offset = COALESCE(excluded.offset, files.offset)`
  ).run(owner, kind, offset, at, lines);
}

/** Whether a task transition line is one the unit already holds (the same line: a retried write). */
function transitionHeld(db: Db, owner: string, line: unknown): boolean {
  return (
    db
      .prepare('SELECT 1 AS ok FROM work_events WHERE owner_key = ? AND record = ? AND retired_at IS NULL LIMIT 1')
      .get(owner, JSON.stringify(line)) !== undefined
  );
}

function duplicateLine(db: Db, unit: Unit, line: Row): boolean {
  return unit.kind === 'errands' && transitionHeld(db, unit.full, line);
}

function writeLine(
  db: Db,
  { unit, line, ctx, position, at }: { unit: Unit; line: Row; ctx: MapContext; position: number; at: string }
) {
  const mapping = unit.mapper.toRows(unit.rel, line, { ...ctx, position });
  if (duplicateLine(db, unit, line)) return { written: 0, duplicates: 1, adopted: 0, advance: 0 };
  writeMapping(db, qualify(mapping, unit), unit.full, { at });
  return { written: 1, duplicates: 0, adopted: 0, advance: 1 };
}

function writeLines(db: Db, update: Row, at: string): { written: number; duplicates: number; adopted: number } {
  const unit = updateUnit(db, update);
  const unitKey = unit.key;
  if (unitKey?.kind === 'versions' && unitKey.selector?.versionKind === 'media')
    return writeMediaDescriptions(db, unit, update.lines, at);
  if (unit.format !== 'jsonl' || !LINE_KINDS.has(unit.kind)) throw coded('UNIT_UNMAPPED');
  const lines = (Array.isArray(update.lines) ? (update.lines as Array<unknown>) : []).filter(
    (line): line is Row => line !== null && typeof line === 'object' && !Array.isArray(line)
  );
  const result = { written: 0, duplicates: 0, adopted: 0 };
  let position = nextPosition(db, unit.full);
  const ctx = { iface: ifaceOf(update) };
  for (const line of lines) {
    const done = writeLine(db, { unit, line, ctx, position, at });
    result.written += done.written;
    result.duplicates += done.duplicates;
    result.adopted += done.adopted;
    position += done.advance;
  }
  noteUnit(db, unit.full, unit.kind, { lines: position, at });
  if (result.written > 0) markStemsPending(db);
  return result;
}

/** Media generations append independently of the active cache's replacement writes. */
function writeMediaDescriptions(db: Db, unit: Unit, given: unknown, at: string) {
  const key = unit.key!;
  const holder = profileOwnerOf(key)!; // a `versions` unit always has its owner columns (profile-owner.ts)
  const descriptionId = mediaDescriptionId(key);
  let written = 0;
  let duplicates = 0;
  for (const event of Array.isArray(given) ? given : []) {
    if (!event || typeof event !== 'object') throw coded('UNIT_BAD_OP');
    const line = event as Row;
    const current = db
      .prepare(
        `SELECT v.id,v.extra FROM descriptions d JOIN description_versions v ON v.id=d.current_version
       WHERE d.id=? AND d.writer=? AND d.holder_id=?`
      )
      .get(descriptionId, holder.writer, holder.holder_id);
    if (line.op === 'refresh-failed') {
      if (current && isFiniteNumber(line.at)) {
        const extra = parseExtra(current.extra);
        db.prepare('UPDATE description_versions SET extra=? WHERE id=?').run(
          JSON.stringify({ ...extra, refreshFailedAt: line.at }),
          current.id
        );
        written += 1;
      }
      continue;
    }
    if (!isMediaDescriptionEntry(line.entry) || !filled(line.id)) throw coded('UNIT_BAD_OP');
    const versionId = `${descriptionId}:${line.id}`;
    if ((line.op === 'seed' && current) || db.prepare('SELECT 1 FROM description_versions WHERE id=?').get(versionId)) {
      duplicates += 1;
      continue;
    }
    const version = Number(
      db
        .prepare(
          'SELECT COALESCE(MAX(position),0)+1 AS version FROM description_versions WHERE writer=? AND holder_id=?'
        )
        .get(holder.writer, holder.holder_id)?.version
    );
    const text = typeof line.entry.text === 'string' ? line.entry.text : line.entry.answer;
    writeMapping(
      db,
      stampProfileRows(
        {
          description_versions: [
            {
              id: versionId,
              description_id: descriptionId,
              text,
              written_at: isoOf(line.entry.ts),
              origin: 'media',
              extra: JSON.stringify({ entry: line.entry }),
              owner_key: unit.full,
              position: version,
            },
          ],
          descriptions: [
            {
              id: descriptionId,
              subject_kind: 'media',
              subject_id: key.selector?.itemId,
              field: 'description',
              current_version: versionId,
              owner_key: unit.full,
              ...groupScope(storageContext(db, key).iface ?? null),
            },
          ],
          operational: [
            {
              kind: 'versions',
              owner: unit.full,
              owner_key: unit.full,
              value: JSON.stringify({ $has: { media: descriptionId } }),
            },
          ],
        },
        holder
      ),
      unit.full,
      { at }
    );
    if (storeHeld(db) && filled(key.selector?.itemId) && typeof text === 'string' && text !== '') {
      tellFromCacheKey(db, { iface: storageContext(db, key).iface ?? null, key: key.selector.itemId, text, at });
    }
    written += 1;
  }
  noteUnit(db, unit.full, unit.kind, { at });
  return { written, duplicates, adopted: 0 };
}

/** The kinds of JSON unit op `value` does not write (the request dumps: a step source needs its turn's answer). */
const NOT_VALUE_KINDS = new Set(['requests']);

function writeValue(db: Db, update: Row, at: string): Row {
  const unit = updateUnit(db, update);
  if (unit.format !== 'json' || NOT_VALUE_KINDS.has(unit.kind)) throw coded('UNIT_UNMAPPED');
  // The describer's cache lives on the items: an entry is the text form of its row, and a linked row is never trimmed.
  if (unit.kind === 'media' && storeHeld(db)) {
    const iface = (unit.key ? storageContext(db, unit.key).iface : null) ?? ifaceOf(update);
    const cached = writeMediaCache(db, { owner: unit.full, iface, value: (update.value ?? {}) as Row, at });
    noteUnit(db, unit.full, unit.kind, { at });
    return { ...cached, destinations: [] };
  }
  const mapping = qualify(unit.mapper.toRows(unit.rel, update.value ?? {}, { iface: ifaceOf(update) }), unit);
  if (unit.kind === 'gifs' && storeHeld(db)) keepItemFields(db, mapping.media ?? []);
  const upserted = writeMapping(db, mapping, unit.full, { at });
  const retired = retireAbsent(db, unit.full, mapping, at);
  if (unit.kind === 'gifs' && storeHeld(db)) adoptLibraryRows(db, unit.full, at);
  noteUnit(db, unit.full, unit.kind, { at });
  const destinations =
    unit.kind === 'selfreflection' && filled(update.destination)
      ? assignSelfreflectionDestination(db, update.destination, { owner: unit.full, at })
      : 0;
  return { upserted, retired, ...(unit.kind === 'selfreflection' ? { destinations } : {}) };
}

function writeSelfreflection(db: Db, update: Row, at: string): Row {
  const unit = updateUnit(db, update);
  if (unit.kind !== 'selfreflection') throw coded('UNIT_UNMAPPED');
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
  const mapping = qualify(unit.mapper.toRows(unit.rel, value, { iface: ifaceOf(update) }), unit);
  const upserted = writeMapping(db, mapping, unit.full, { at });
  const retired = retireAbsent(db, unit.full, mapping, at);
  noteUnit(db, unit.full, unit.kind, { at });
  const destinations = filled(update.destination)
    ? assignSelfreflectionDestination(db, update.destination, { owner: unit.full, at })
    : 0;
  return { upserted, retired, posts: value.posts.length, destinations };
}

/**
 * A month of vectors a unit write carries (a write kept pending by an older index, or a seed of old files): its month
 * files as the line vectors write of the unit's place (line-vectors.ts). A month whose lines are not clean, or whose
 * manifest names no vector size, holds no vectors and writes nothing.
 */
function writeVectors(db: Db, update: Row, at: string): Row {
  const keyed = withKey(db, update);
  const key = keyed?.key as StorageKey | undefined;
  if (key?.kind !== 'vectors' || !key.partition) throw coded('UNIT_UNMAPPED');
  const files = (update.value ?? update.delta ?? {}) as Row;
  const lines = monthLines(files);
  if (lines === null) return { written: 0, retired: 0 };
  const manifest = (files.manifest ?? {}) as Row;
  return writeLineVectors(
    db,
    {
      op: update.value ? 'month' : 'append',
      placeId: key.subject.id,
      month: key.partition.slice(0, 7),
      model: typeof manifest.model === 'string' ? manifest.model : null,
      lines,
    },
    at
  );
}

function project(handle: MemoryHandle, update: Row, at: string): { units: number; done: boolean; stems: number } {
  const out = { units: 0, done: true, stems: 0 };
  if (graphPending(handle)) {
    const slice = isWholeNumber(update.sliceUnits) && update.sliceUnits > 0 ? update.sliceUnits : undefined;
    const projected = projectPending(handle, {
      at,
      ...(slice ? { sliceUnits: slice } : {}),
      maxSlices: isWholeNumber(update.maxSlices) && update.maxSlices > 0 ? update.maxSlices : 1,
    });
    out.units = projected.units;
    out.done = projected.done;
  }
  // The stems run their own transactions (stems.ts#fillStems).
  if (stemsPending(dbOf(handle))) out.stems = fillStems(dbOf(handle))?.stamped ?? 0;
  return out;
}

/**
 * The scope of a name the owner gives a person: the groups of the person's interface, the scope a member's profile gives
 * its aliases (account-profile.ts). `iface` is the interface the command came from, for a person with no account and no spelled
 * interface; with none of those the name is internal. Which interface of several makes no difference to who reads it:
 * every group audience reads alike (scope.ts#allowedAudience).
 */
export function ownerNameScope(db: Db, personId: string, iface: unknown): Scope & { audience_id: string } {
  const account = db
    .prepare("SELECT iface FROM accounts WHERE person_id = ? AND link = 'verified' AND retired_at IS NULL ORDER BY id")
    .get(personId)?.iface;
  const found = account ?? legacyPersonNative(personId)?.iface ?? iface;
  return audienceOf(typeof found === 'string' && found !== '' ? groupScope(found) : SCOPE_INTERNAL);
}

/**
 * A name the owner gave a person (`/memory users names add|remove`): an `alias` claim with `author` `owner`, added once or
 * retired. A name her memory session or the analyzer writes has another author, so the two never mix.
 */
function writeOwnerName(db: Db, update: Row, at: string): { personId: string; name: string; stored: boolean } {
  const personId = typeof update.personId === 'string' ? update.personId : '';
  const name = typeof update.name === 'string' ? update.name.trim() : '';
  if (!personId || !name) throw coded('UNIT_BAD_OP');
  const live = db
    .prepare(
      "SELECT id FROM claims WHERE subject_id = ? AND kind = 'alias' AND author = 'owner' AND retired_at IS NULL AND lower(text) = lower(?)"
    )
    .get(personId, name) as { id?: string } | undefined;
  if (update.remove === true) {
    if (live?.id) {
      db.prepare('UPDATE claims SET retired_at = ? WHERE id = ?').run(at, live.id);
      projectRow(db, 'claims', { id: live.id }, { at });
    }
    return { personId, name, stored: false };
  }
  if (!live?.id) {
    const id = `claim:owner-name:${personId}:${name.toLowerCase()}:${at}`;
    const scope = ownerNameScope(db, personId, update.iface);
    ensureAudience(db, scope);
    db.prepare(
      `INSERT INTO claims (id, subject_kind, subject_id, kind, text, weight, first_seen_at, last_seen_at, how, author,
        truth, created_at, scope_kind, scope_iface, scope_dm, audience_id, writer)
        VALUES (?, 'person', ?, 'alias', ?, 1, ?, ?, 'owner', 'owner', 'current', ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      personId,
      name,
      at,
      at,
      at,
      scope.scope_kind,
      scope.scope_iface,
      scope.scope_dm,
      scope.audience_id,
      SESSION_COLUMNS.writer
    );
    projectRow(db, 'claims', { id }, { at });
  }
  return { personId, name, stored: true };
}

/** The kind of a keyed lines write whose unit has its own write kind (the record, the journal, the archive), else null. */
function dayKindOf(db: Db, keyed: Row): 'record' | 'journal' | 'archive' | null {
  const kind = (keyed.key as StorageKey | undefined)?.kind;
  return hasStorageUnits(db) && (kind === 'record' || kind === 'journal' || kind === 'archive') ? kind : null;
}

/**
 * A keyed lines write of a record or journal day or an archive month, through that kind's writer (record-lines.ts,
 * journal-lines.ts, archive-lines.ts).
 */
function writeDay(db: Db, update: Row, keyed: Row, at: string): unknown {
  const key = keyed.key as StorageKey;
  const lines = Array.isArray(keyed.lines) ? (keyed.lines as Array<Row>) : [];
  // An update that names an owner path and no key is an older release's: its rows keep the path.
  const legacyOwner = typeof update.owner === 'string' && !update.key ? { legacyOwner: update.owner } : {};
  if (key.kind === 'journal') return writeJournalDay(db, key, lines, { iface: ifaceOf(keyed), at, ...legacyOwner });
  if (key.kind === 'archive') return writeArchiveMonth(db, key, lines, { iface: ifaceOf(keyed), at, ...legacyOwner });
  return writeRecordDay(db, key, lines, {
    ...(keyed.messages !== undefined ? { messages: keyed.messages as Array<Row> } : {}),
    iface: ifaceOf(keyed),
    at,
    ...legacyOwner,
  });
}

/** The update with the storage key its owner path spells, when it names a path and no key; null when none maps. */
function withKey(db: Db, update: Row): Row | null {
  if (update.key) return update;
  if (typeof update.owner !== 'string') return null;
  try {
    return { ...update, key: legacyStorageKey(update.owner, ifaceOf(update)) };
  } catch {
    // An owner no path maps is the unit write's to refuse.
    return null;
  }
}

/**
 * The write of a keyed value update whose kind has its own value write (an account's profile, a private layer, a
 * history of prose: account-profile.ts, private-layer.ts, prose-versions.ts), to run in the writer's transaction; else
 * null.
 */
function ownValueWrite(db: Db, update: Row, keyed: Row, at: string): (() => unknown) | null {
  const key = keyed.key as StorageKey;
  // An update that names an owner path and no key is an older release's: its rows keep the path.
  const legacyOwner = typeof update.owner === 'string' && !update.key ? { legacyOwner: update.owner } : {};
  if (isAccountProfileKey(key)) {
    const { value } = accountProfileWriteOf({ accountId: key.subject.id, value: keyed.value ?? {} });
    return () => writeAccountProfile(db, key, value, { at, ...legacyOwner });
  }
  if (isPrivateLayerKey(key)) {
    const { value } = privateLayerWriteOf({ accountId: key.subject.id, value: keyed.value ?? {} });
    return () => writePrivateLayer(db, key, value, { at, ...legacyOwner });
  }
  if (key.kind !== 'versions') return null;
  const value = proseVersionsValueOf(keyed.value ?? {});
  return () => writeProseVersions(db, key, value, { at, ...legacyOwner });
}

/**
 * One write of an append-like memory unit (see the head of this file). `handle` is the writer.
 */
export function applyUnitWrite(handle: MemoryHandle, update: Row): unknown {
  const at = isoOf(update?.now);
  const op = update?.op;
  if (op === 'project') return project(handle, update, at);
  const db = dbOf(handle);
  // A unit of an operational kind or of the intentions, such as a write kept pending by an older outbox, is the direct
  // write of its kind.
  const keyed = op === 'value' || op === 'lines' ? withKey(db, update) : null;
  // An operational row of an older schema, which a seed of old files writes, keeps its unit.
  const operational = keyed && hasStorageUnits(db) ? operationalOfUnit(keyed) : null;
  if (operational) return handle.transaction(() => writeOperational(db, operational));
  const intentions = keyed ? intentionsOfUnit(keyed) : null;
  if (intentions) return handle.transaction(() => writeIntentions(db, intentions, at));
  // An account's profile or a history of prose, such as a write kept pending by an older release, is that kind's write.
  const own = op === 'value' && keyed && hasStorageUnits(db) ? ownValueWrite(db, update, keyed, at) : null;
  if (own) return handle.transaction(own);
  // A record or journal day or an archive month, such as a write kept pending by an older release, is that kind's write.
  if (op === 'lines' && keyed && dayKindOf(db, keyed)) return handle.transaction(() => writeDay(db, update, keyed, at));
  const runs: Record<string, (() => unknown) | undefined> = {
    lines: () => skippedErrandUnit(db, update, () => update.key ?? unitOf(update.owner)) ?? writeLines(db, update, at),
    value: () => skippedErrandUnit(db, update, () => update.key ?? unitOf(update.owner)) ?? writeValue(db, update, at),
    selfreflection: () => writeSelfreflection(db, update, at),
    vectors: () => writeVectors(db, update, at),
    'gif-vector': () => writeGifVector(db, update, at),
    'owner-name': () => writeOwnerName(db, update, at),
    errand: () =>
      applyErrandUnit(db, update, at, (closing) => {
        const keyedClosing = withKey(db, closing);
        if (keyedClosing && dayKindOf(db, keyedClosing)) writeDay(db, closing, keyedClosing, at);
        else writeLines(db, closing, at);
      }),
  };
  const run = typeof op === 'string' ? runs[op] : undefined;
  if (!run) throw coded('UNIT_BAD_OP');
  return handle.transaction(run);
}
