// The memory writer applies semantic unit updates in one transaction. Value writes replace a collection while
// preserving protected session rows; lines append in catalog order and retain message-family idempotence and native
// identity. Diary and vector operations keep their existing publication and index behavior. Catalog owner keys are
// independent of source IDs and visibility. Historical owner strings are accepted by the explicit import and
// pending compatibility boundary, which preserves their provenance without using it for live ownership.

import { ensureUnit, hasStorageUnits, unitById, listUnits } from './storage-units.ts';
import { storageMapper } from './map/index.ts';
import { classify } from '../migration/classify.ts';
import { legacyStorageKey, currentUnitPath } from '../migration/paths.ts';
import { personaKey } from './storage-keys.ts';
import type { StorageKey } from './storage-keys.ts';
import { messageLocator } from './message-locator.ts';
import type { MessageLocator } from './message-locator.ts';
import type { MapContext, ResolvedRecordIdentity } from './map/common.ts';
import { resolveMessageFamily } from './message-families.ts';
import { familyError, hasMessageFamilies } from './message-family-catalog.ts';
import { observedSourceId } from './observe.ts';
import { parseExtra } from './map/common.ts';

import { ifaceOrLegacy as ifaceOf } from './legacy-namespace.ts';
import { hotClaimIds, linkVectors, qualify, retireAbsent, writeMapping } from './upsert.ts';
import { unitRows, isMediaDescriptionEntry, mediaDescriptionId } from './export.ts';
import { unitValue } from './readers/common.ts';
import { assignDiaryDestination } from './publish.ts';
import { graphPending, projectPending, projectRow } from './graph.ts';
import { storeHeld } from './media-stems.ts';
import { fillStems, markStemsPending, stemsPending } from './stems.ts';
import {
  adoptLibraryRows,
  keepItemFields,
  takeRecordMedia,
  tellFromCacheKey,
  writeMediaCache,
  writeRecordMedia,
} from './media-store.ts';
import { applyErrandUnit, skippedErrandUnit } from '../../board/errands.ts';
import { dbOf, asText, isFiniteNumber, isWholeNumber } from './types.ts';
import type { Db, MemoryHandle, Row, Rows } from './types.ts';
import type { MappedPath } from '../migration/classify.ts';
import { SCOPE_INTERNAL, audienceOf, groupScope } from './scope.ts';
import type { Scope } from './scope.ts';
import { ensureAudience } from './rows.ts';
import { legacyPersonNative } from './ids.ts';
import { writeGifVector } from './gif-vectors.ts';
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

/** The month prefix of a record unit (`<prefix>/record/<YYYY-MM>/`). */
const monthPrefixOf = (owner: string) => owner.replace(/[^/]+$/, '');

/** Whether a record line is one the unit's month already holds (the id index's rule; observations are adopted, not duplicates). */
function recordDuplicate(db: Db, owner: string, line: Row): boolean {
  const messageId = filled(line?.messageId) ? line.messageId : null;
  if (!messageId) return false;
  const unit = hasStorageUnits(db) ? unitById(db, owner) : undefined;
  const ids = unit
    ? listUnits(db, { kind: 'record', subject: unit.key.subject, scopePlaceId: unit.key.scopePlaceId })
        .filter((entry) => entry.key.partition?.slice(0, 7) === unit.key.partition?.slice(0, 7))
        .map((entry) => entry.id)
    : [];
  const prefix = monthPrefixOf(owner);
  const ownership = unit ? `owner_key IN (${ids.map(() => '?').join(',')})` : 'owner_file >= ? AND owner_file < ?';
  const owners = unit ? ids : [prefix, `${prefix}￿`];
  if (line.kind === 'deleted') {
    return (
      db
        .prepare(
          `SELECT 1 AS ok FROM sources WHERE native_id = ? AND kind = 'deleted' AND ${ownership} AND retired_at IS NULL LIMIT 1`
        )
        .get(messageId, ...owners) !== undefined
    );
  }
  const revision = isWholeNumber(line.revision) && line.revision > 0 ? line.revision : 1;
  for (const row of db
    .prepare(
      `SELECT id, revision, origin FROM sources WHERE native_id = ? AND kind IN ('seen', 'said') AND ${ownership} AND retired_at IS NULL`
    )
    .all(messageId, ...owners)) {
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
      .prepare('SELECT 1 AS ok FROM work_events WHERE owner_key = ? AND record = ? AND retired_at IS NULL LIMIT 1')
      .get(owner, JSON.stringify(line)) !== undefined
  );
}

function recordLocator(hint: Row, line: Row): MessageLocator {
  const raw = hint.locator;
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) throw familyError('BAD_NATIVE');
  const locator = messageLocator({ ...raw, v: 1, origin: 'record-v1' }, 'iface' in raw ? raw.iface : null);
  const scope = line.scope;
  if (
    !locator ||
    locator.messageId !== line.messageId ||
    !scope ||
    typeof scope !== 'object' ||
    !('channel' in scope) ||
    scope.channel !== locator.conversationId
  )
    throw familyError('BAD_PLACE');
  return locator;
}

/**
 * Her own line reaches the record with no descriptor (src/turn/journal-notes.ts#recordSaid and its siblings). Its
 * interface, its channel and its message id are its address, so it takes the family the echo of the same message took,
 * or reserves the one the echo will find.
 */
function saidReference(db: Db, unit: Unit, update: Row, line: Row): { hint: Row; locator: MessageLocator } | undefined {
  // A write by a legacy owner is the importer's: it keeps the keys of the rows it brings.
  if (!update.key || line.kind !== 'said' || line.v !== 1 || !hasMessageFamilies(db)) return undefined;
  const iface = (unit.key ? storageContext(db, unit.key).iface : null) ?? ifaceOf(update);
  const conversationId = (line.scope as { channel?: unknown } | undefined)?.channel;
  const locator = messageLocator(
    { v: 1, origin: 'record-v1', iface, conversationId, messageId: line.messageId },
    iface
  );
  return locator ? { hint: {}, locator } : undefined;
}

function recordReference(
  db: Db,
  unit: Unit,
  update: Row,
  line: Row
): { hint: Row; locator: MessageLocator } | undefined {
  if (update.messages === undefined) return saidReference(db, unit, update, line);
  if (!Array.isArray(update.messages)) throw familyError('BAD_NATIVE');
  const matching = update.messages.filter(
    (value: unknown): value is Row =>
      value !== null &&
      typeof value === 'object' &&
      !Array.isArray(value) &&
      'lineId' in value &&
      value.lineId === line.id
  );
  if (matching.length === 0 && !['seen', 'said', 'deleted'].includes(asText(line.kind))) return undefined;
  if (matching.length !== 1 || line.v !== 1 || !filled(line.id)) throw familyError('BAD_NATIVE');
  const hint = matching[0];
  const locator = recordLocator(hint, line);
  return { hint, locator };
}

function recordIdentity(
  db: Db,
  unit: Unit,
  update: Row,
  line: Row
): (ResolvedRecordIdentity & { iface: string }) | undefined {
  const reference = recordReference(db, unit, update, line);
  if (!reference) return undefined;
  const { hint, locator } = reference;
  const family = resolveMessageFamily(db, { locator, authority: `${locator.iface}/global` });
  const revision =
    line.kind === 'deleted' ? null : isWholeNumber(line.revision) && line.revision > 0 ? line.revision : 1;
  const found =
    hint.observedSourceId === undefined
      ? db
          .prepare(
            'SELECT * FROM sources WHERE authority_id = ? AND native_kind = ? AND native_id = ? AND generation = ? AND revision IS ? AND kind = ?'
          )
          .get(family.authority_id, family.native_kind, family.native_key, family.generation, revision, line.kind)
      : db.prepare('SELECT * FROM sources WHERE id = ?').get(hint.observedSourceId);
  if (
    hint.observedSourceId !== undefined &&
    (!found ||
      found.authority_id !== family.authority_id ||
      found.native_kind !== family.native_kind ||
      found.native_id !== family.native_key ||
      found.generation !== family.generation ||
      found.revision !== revision ||
      found.kind !== line.kind)
  )
    throw familyError('BAD_NATIVE');
  const native = {
    kind: family.native_kind,
    key: family.native_key,
    generation: family.generation,
    revision,
    subtype: String(line.kind),
  };
  return {
    iface: locator.iface,
    sourceId: typeof found?.id === 'string' ? found.id : observedSourceId({ authority: family.authority_id, native }),
    authority: family.authority_id,
    nativeKind: family.native_kind,
    familyKey: family.native_key,
    generation: family.generation,
    revision,
  };
}

function recordReply(db: Db, source: Row, line: Row, identity: ResolvedRecordIdentity): void {
  if (!filled(line.replyTo)) return;
  const extra = parseExtra(source.extra);
  const locator = messageLocator(extra.$messageLocator, source.iface);
  if (!locator) throw familyError('BAD_NATIVE');
  const reply = { iface: locator.iface, conversationId: locator.conversationId, messageId: line.replyTo };
  const parent = resolveMessageFamily(db, { locator: reply, authority: identity.authority });
  source.reply_to = parent.native_key;
  source.extra = JSON.stringify({ ...extra, $messageReply: reply });
}

function adoptedRecord(source: Row, found: Row): Row {
  const adopted: Row = {
    ...found,
    owner_key: source.owner_key,
    owner_file: found.owner_file,
    position: source.position,
    origin: source.origin,
    turn_id: source.turn_id ?? found.turn_id,
    op_id: source.op_id ?? found.op_id,
    extra: JSON.stringify({
      ...parseExtra(source.extra),
      ...parseExtra(found.extra),
      ...Object.fromEntries(Object.entries(parseExtra(source.extra)).filter(([key]) => !key.startsWith('$'))),
    }),
  };
  delete adopted.rowid;
  return adopted;
}

function duplicateLine(
  db: Db,
  unit: Unit,
  line: Row,
  identity: ResolvedRecordIdentity | undefined,
  found: Row | undefined
): boolean {
  if (unit.kind === 'record' && !identity && recordDuplicate(db, unit.full, line)) {
    return true;
  }
  if (unit.kind === 'errands' && transitionHeld(db, unit.full, line)) {
    return true;
  }
  if (found && found.origin !== 'observation' && found.retired_at === null) {
    return true;
  }
  return false;
}

// health: allow complexity until 2027-04-01 -- the steps of one line write, in their order
function writeLine(
  db: Db,
  {
    update,
    unit,
    line,
    ctx,
    position,
    at,
    archive,
  }: { update: Row; unit: Unit; line: Row; ctx: MapContext; position: number; at: string; archive: boolean }
) {
  const identity = unit.kind === 'record' ? recordIdentity(db, unit, update, line) : undefined;
  const mapping = unit.mapper.toRows(unit.rel, line, {
    ...ctx,
    position,
    ...(identity ? { iface: identity.iface, messageIdentity: identity } : {}),
  });
  let source = unit.kind === 'record' ? mapping.sources?.[0] : null;
  if (source && identity) recordReply(db, source, line, identity);
  const found = source ? db.prepare('SELECT * FROM sources WHERE id = ?').get(source.id) : undefined;
  if (duplicateLine(db, unit, line, identity, found)) return { written: 0, duplicates: 1, adopted: 0, advance: 0 };
  if (source && identity && found) {
    source = adoptedRecord(source, found);
    mapping.sources[0] = source;
  }
  // The live observation wrote the line first: the line takes the row over, its place in the unit stays.
  const keep =
    found && found.origin === 'observation' && found.owner_key === unit.full && Number.isInteger(found.position);
  // A row is looked up only for a source line, so `keep` holds only with one.
  if (keep) (source as Row).position = found.position;
  // A source row's media go to `media` and `media_links`: what a record line holds of them leaves its `extra`.
  const media = source && storeHeld(db) ? takeRecordMedia(source) : null;
  writeMapping(db, qualify(mapping, unit), unit.full, { at, ignoreClaims: archive });
  if (source && media) writeRecordMedia(db, asText(source.id), media, at);
  return { written: 1, duplicates: 0, adopted: found?.origin === 'observation' ? 1 : 0, advance: keep ? 0 : 1 };
}

function writeLines(db: Db, update: Row, at: string): { written: number; duplicates: number; adopted: number } {
  const unit = updateUnit(db, update);
  if (unit.key?.kind === 'versions' && unit.key.selector?.versionKind === 'media')
    return writeMediaDescriptions(db, unit, update.lines, at);
  if (unit.key?.kind === 'recall_trace') return writeRecallTrace(db, unit, update, at);
  if (unit.format !== 'jsonl' || !LINE_KINDS.has(unit.kind)) throw coded('UNIT_UNMAPPED');
  const lines = (Array.isArray(update.lines) ? (update.lines as Array<unknown>) : []).filter(
    (line): line is Row => line !== null && typeof line === 'object' && !Array.isArray(line)
  );
  const result = { written: 0, duplicates: 0, adopted: 0 };
  let position = nextPosition(db, unit.full);
  // An archive line of an item hot memory does not hold brings its retired claim (map/archive.ts).
  const archive = unit.kind === 'archive';
  const ctx = archive ? { iface: ifaceOf(update), hotClaimIds: hotClaimIds(db) } : { iface: ifaceOf(update) };
  for (const line of lines) {
    const done = writeLine(db, { update, unit, line, ctx, position, at, archive });
    result.written += done.written;
    result.duplicates += done.duplicates;
    result.adopted += done.adopted;
    position += done.advance;
  }
  noteUnit(db, unit.full, unit.kind, { lines: position, at });
  if (result.written > 0) markStemsPending(db);
  return result;
}

/** Recall diagnostics use the existing unit writer and keep only the requested recent history. */
function writeRecallTrace(db: Db, unit: Unit, update: Row, at: string) {
  let position = nextPosition(db, unit.full);
  let written = 0;
  for (const item of Array.isArray(update.lines) ? (update.lines as Array<Row>) : []) {
    if (!item.record || typeof item.record !== 'object' || Array.isArray(item.record)) throw coded('UNIT_BAD_OP');
    const cap = isWholeNumber(item.maxLines) && item.maxLines > 0 ? item.maxLines : 500;
    const mapping = unit.mapper.toRows(unit.rel, item.record, { position });
    writeMapping(db, qualify(mapping, unit), unit.full, { at });
    db.prepare(
      `DELETE FROM operational WHERE kind = 'recall_trace' AND owner_key = ? AND rowid NOT IN
       (SELECT rowid FROM operational WHERE kind = 'recall_trace' AND owner_key = ? ORDER BY rowid DESC LIMIT ?)`
    ).run(unit.full, unit.full, cap);
    position += 1;
    written += 1;
  }
  noteUnit(db, unit.full, unit.kind, { lines: position, at });
  return { written, duplicates: 0, adopted: 0 };
}

/** Media generations append independently of the active cache's replacement writes. */
function writeMediaDescriptions(db: Db, unit: Unit, given: unknown, at: string) {
  const key = unit.key!;
  const descriptionId = mediaDescriptionId(key);
  let written = 0;
  let duplicates = 0;
  for (const event of Array.isArray(given) ? given : []) {
    if (!event || typeof event !== 'object') throw coded('UNIT_BAD_OP');
    const line = event as Row;
    const current = db
      .prepare(
        `SELECT v.id,v.extra FROM descriptions d JOIN description_versions v ON v.id=d.current_version
       WHERE d.id=? AND d.owner_key=?`
      )
      .get(descriptionId, unit.full);
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
        .prepare('SELECT COALESCE(MAX(position),0)+1 AS version FROM description_versions WHERE owner_key=?')
        .get(unit.full)?.version
    );
    const text = typeof line.entry.text === 'string' ? line.entry.text : line.entry.answer;
    writeMapping(
      db,
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
    unit.kind === 'diary' && filled(update.destination)
      ? assignDiaryDestination(db, update.destination, { owner: unit.full, at })
      : 0;
  return { upserted, retired, ...(unit.kind === 'diary' ? { destinations } : {}) };
}

function writeDiary(db: Db, update: Row, at: string): Row {
  const unit = updateUnit(db, update);
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
  const mapping = qualify(unit.mapper.toRows(unit.rel, value, { iface: ifaceOf(update) }), unit);
  const upserted = writeMapping(db, mapping, unit.full, { at });
  const retired = retireAbsent(db, unit.full, mapping, at);
  noteUnit(db, unit.full, unit.kind, { at });
  const destinations = filled(update.destination)
    ? assignDiaryDestination(db, update.destination, { owner: unit.full, at })
    : 0;
  return { upserted, retired, posts: value.posts.length, destinations };
}

/**
 * A vector row belongs to its month. A chunk key spells the partner's native id and no interface, so two DM places of one
 * native id can spell the same key: a row whose key another unit holds takes `#<n>`, which still links to its line, and
 * lands here instead of being refused as shared while the month's manifest counts it.
 */
function ownChunkKeys(db: Db, unit: Unit, rows: ReadonlyArray<Row>): void {
  const column = hasStorageUnits(db) ? 'owner_key' : 'owner_file';
  const holder = db.prepare(`SELECT ${column} AS owner FROM vectors WHERE chunk_key = ? AND retired_at IS NULL`);
  const taken = new Set<string>();
  for (const row of rows) {
    const base = asText(row.chunk_key);
    let key = base;
    for (let n = 2; ; n += 1) {
      const owner = holder.get(key)?.owner;
      if (!taken.has(key) && (owner === undefined || owner === unit.full)) break;
      key = `${base}#${n}`;
    }
    taken.add(key);
    row.chunk_key = key;
  }
}

/** A whole month of vectors (its rows linked to their lines, the rows it no longer holds retired). */
function writeMonth(db: Db, unit: Unit, value: Row, at: string, iface: string): Row {
  const mapping = unit.mapper.toRows(unit.rel, value, { iface });
  ownChunkKeys(db, unit, mapping.vectors ?? []);
  for (const row of mapping.vectors ?? []) row[hasStorageUnits(db) ? 'owner_key' : 'owner_file'] = unit.full;
  linkVectors(db, mapping.vectors ?? []);
  qualify(mapping, unit);
  const upserted = writeMapping(db, mapping, unit.full, { at });
  const retired = retireAbsent(db, unit.full, mapping, at);
  return { upserted, retired };
}

/** The files of a month an update carries: the manifest, the jsonl text and the int8 bytes. */
type MonthDelta = { manifest?: Row; meta?: unknown; i8?: ArrayLike<number> };

/** Append mappings retain ownership and source links on the same writer transaction. */
function writeVectorDelta(db: Db, unit: Unit, rows: Rows, at: string): Row {
  const current = hasStorageUnits(db);
  ownChunkKeys(db, unit, rows.vectors ?? []);
  for (const row of rows.vectors ?? []) {
    if (current) delete row.owner_file;
    row[current ? 'owner_key' : 'owner_file'] = unit.full;
  }
  linkVectors(db, rows.vectors ?? []);
  return { upserted: writeMapping(db, qualify(rows, unit), unit.full, { at }), retired: 0 };
}

function writeVectors(db: Db, update: Row, at: string): Row {
  const unit = updateUnit(db, update, true);
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
      .prepare(
        `SELECT value FROM operational WHERE kind = 'vectors' AND ${hasStorageUnits(db) ? 'owner_key' : 'owner'} = ? AND retired_at IS NULL`
      )
      .get(unit.full);
    let previous: { manifest?: Row; raw?: unknown; tailI8?: unknown } | null = null;
    try {
      previous = stored ? JSON.parse(stored.value as string) : null;
    } catch {
      previous = null;
    }
    const keys = db
      .prepare(`SELECT chunk_key FROM vectors WHERE ${hasStorageUnits(db) ? 'owner_key' : 'owner_file'} = ?`)
      .all(unit.full)
      .map((row) => row.chunk_key as string);
    // `appendRows` is the vectors mapper's: this write is for that kind alone (`unitOf` above checked it).
    const rows = previous
      ? unit.mapper.appendRows!(unit.rel, delta as never, {
          previous: previous as never,
          keys,
          // A keyed unit's mapper answers with the interface of its own subject.
          ...(unit.key ? {} : { iface: ifaceOf(update) }),
        })
      : null;
    if (rows) {
      done = writeVectorDelta(db, unit, rows, at);
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

/** Numeric clocks from historical communities share their latest recorded bounds. */
function mergeClock(previous: unknown, incoming: unknown): Row | null {
  if (!previous && !incoming) return null;
  const left = previous && typeof previous === 'object' ? (previous as Row) : {};
  const right = incoming && typeof incoming === 'object' ? (incoming as Row) : {};
  const out = { ...left, ...right };
  for (const name of new Set([...Object.keys(left), ...Object.keys(right)])) {
    const values = [left[name], right[name]].filter(isFiniteNumber);
    if (values.length) out[name] = Math.max(...values);
  }
  return out;
}

/** Preserve review snapshots by community while sharing the latest day's draw and completion. */
function mergeReview(value: Row, source: Row, scope: string): void {
  const incoming = source.review as Row | null;
  if (!incoming || typeof incoming.day !== 'string') return;
  const views = value.reviewViews as Row;
  views[scope] = { day: incoming.day, channels: incoming.channels ?? [], lines: incoming.lines ?? 0 };
  const known = value.review as Row | null;
  if (!known || String(known.day) < incoming.day) value.review = { ...incoming, channels: [], lines: 0 };
  else if (known.day === incoming.day) {
    known.done = known.done === true || incoming.done === true;
    known.at = mergeClock({ at: known.at }, { at: incoming.at })?.at ?? null;
  }
}

/** Historical evidence keeps its original community when the persona state is consolidated. */
function mergeInner(value: Row, source: Row, scope: string): void {
  if (source.stopped === true)
    Object.assign(value, { stopped: true, stoppedAt: source.stoppedAt, stoppedBy: source.stoppedBy });
  for (const field of ['heartbeat', 'selfimprovement']) value[field] = mergeClock(value[field], source[field]);
  for (const field of ['facts', 'turns', 'spend']) {
    const items = Array.isArray(source[field]) ? (source[field] as Array<Row>) : [];
    value[field] = [
      ...(value[field] as Array<Row>),
      ...items.map((item) => ({ ...item, scopePlaceId: item.scopePlaceId ?? scope })),
    ];
  }
  value.turnIds = [
    ...new Set([
      ...(value.turnIds as Array<string>),
      ...(Array.isArray(source.turnIds) ? (source.turnIds as Array<string>) : []),
    ]),
  ];
  mergeReview(value, source, scope);
}

/** Consolidate historical community state once through the same writer that persists the persona's state. */
export function consolidateInnerState(handle: MemoryHandle, { now }: { now: number }): { consolidated: number } {
  return handle.transaction(() => {
    const db = dbOf(handle);
    const key = personaKey('inner');
    if (unitValue(db, key).found) return { consolidated: 0 };
    const units = listUnits(db, { kind: 'inner' }).filter((unit) => unit.key.subject.type !== 'persona');
    const value: Row = {
      v: 1,
      stopped: false,
      review: null,
      reviewViews: {},
      heartbeat: null,
      selfimprovement: null,
      facts: [],
      turns: [],
      spend: [],
      turnIds: [],
    };
    for (const unit of units) {
      const stored = unitValue(db, unit.key);
      if (stored.found && stored.value && typeof stored.value === 'object')
        mergeInner(value, stored.value as Row, unit.key.scopePlaceId ?? unit.key.subject.id);
    }
    writeValue(db, { key, value }, isoOf(now));
    return { consolidated: units.length };
  });
}

/**
 * The scope of a name the owner gives a person: the groups of the person's interface, the scope a member's profile gives
 * its aliases (map/user.ts). `iface` is the interface the command came from, for a person with no account and no spelled
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
    ensureAudience(db, scope, { at });
    db.prepare(
      `INSERT INTO claims (id, subject_kind, subject_id, kind, text, weight, first_seen_at, last_seen_at, how, author,
        truth, created_at, scope_kind, scope_iface, scope_dm, audience_id)
        VALUES (?, 'person', ?, 'alias', ?, 1, ?, ?, 'owner', 'owner', 'current', ?, ?, ?, ?, ?)`
    ).run(id, personId, name, at, at, at, scope.scope_kind, scope.scope_iface, scope.scope_dm, scope.audience_id);
    projectRow(db, 'claims', { id }, { at });
  }
  return { personId, name, stored: true };
}

/**
 * One write of an append-like memory unit (see the head of this file). `handle` is the writer.
 */
export function applyUnitWrite(handle: MemoryHandle, update: Row): unknown {
  if (update?.op === 'consolidate-inner') return consolidateInnerState(handle, { now: Number(update.now) });
  const at = isoOf(update?.now);
  const op = update?.op;
  if (op === 'project') return project(handle, update, at);
  const db = dbOf(handle);
  const runs: Record<string, (() => unknown) | undefined> = {
    lines: () => skippedErrandUnit(db, update, () => update.key ?? unitOf(update.owner)) ?? writeLines(db, update, at),
    value: () => skippedErrandUnit(db, update, () => update.key ?? unitOf(update.owner)) ?? writeValue(db, update, at),
    diary: () => writeDiary(db, update, at),
    vectors: () => writeVectors(db, update, at),
    'gif-vector': () => writeGifVector(db, update, at),
    'owner-name': () => writeOwnerName(db, update, at),
    errand: () => applyErrandUnit(db, update, at, (closing) => writeLines(db, closing, at)),
  };
  const run = typeof op === 'string' ? runs[op] : undefined;
  if (!run) throw coded('UNIT_BAD_OP');
  return handle.transaction(run);
}
