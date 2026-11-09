// The entries of the archive: past versions of items that left hot memory (expired, replaced, removed, ...), one
// `claim_versions` row per entry, owned by the unit of its place's month (`placeOrPersona('archive', placeId,
// { partition: <YYYY-MM> })`). src/memory/archive.ts writes them through the write kind `archive-lines`
// (session-write.ts) and reads them back through the readers below.
//
// A row's id is the entry's id; `claim_id` is its `itemId` (the hot claim, episode or recent line it belonged to);
// `revision_id`, `event`, `by`, `origin` and `recorded_at` are columns; `text` is `text.text` when the entry has one;
// the rest (kind, itemKind, scope, participants, observedAt, the other text fields, ...) is in `extra`. An entry with
// no id takes one from its hash and position, and a value that is not an object is kept whole in `extra`.
//
// An entry whose item hot memory does not hold (upsert.ts#hotClaimIds) brings a claim of that item with `retired_at`
// set and truth `historical`, its text from the entry. A claim of the item already stored stays as it is.

import { shortHash } from './ids.ts';
import { mintedChannel } from './native-rows.ts';
import { scopeColumns } from './scope.ts';
import { extraText, ifaceOf, isPlainObject, join, parseExtra, put, split } from './map/common.ts';
import type { MapContext, Spec } from './map/common.ts';
import { storageContext } from './map/index.ts';
import { dmPlaceScope, memberDmOf, storedDmOf } from './map/scope-parts.ts';
import { LEGACY_IFACE, ifaceOrLegacy } from './legacy-namespace.ts';
import { markStemsPending } from './stems.ts';
import { PERSONA_ID, placeOrPersona } from './storage-keys.ts';
import type { StorageKey } from './storage-keys.ts';
import { ensureUnit } from './storage-units.ts';
import { lineColumns, lineOwnerOf, linePeriods, lineRows, nextLinePosition } from './line-owner.ts';
import type { LineOwner } from './line-owner.ts';
import { hotClaimIds, writeMapping } from './upsert.ts';
import { noteUnit } from './unit-write.ts';
import { dbOf, isFiniteNumber } from './types.ts';
import type { Db, MemoryHandle, Row, Rows } from './types.ts';

/** One write of the kind: entries of one place's month (null: the persona's). */
export type ArchiveLinesWrite = { placeId: string | null; month: string; lines: ReadonlyArray<unknown> };

/** What a write answers: the entries it wrote (the writer refuses none: the archive drops a known key before). */
export type ArchiveLinesResult = { written: number; duplicates: number; adopted: number };

const SPEC: Array<Spec> = [
  { col: 'id', key: 'id', type: 'text' },
  { col: 'claim_id', key: 'itemId', type: 'text' },
  { col: 'revision_id', key: 'revisionId', type: 'text' },
  { col: 'recorded_at', key: 'recordedAt', type: 'text' },
  { col: 'event', key: 'event', type: 'text' },
  { col: 'by', key: 'by', type: 'text' },
  { col: 'origin', key: 'origin', type: 'text' },
];

const MONTH_RE = /^\d{4}-\d{2}$/;
const coded = (code: string): Error & { code: string } => Object.assign(new Error(code), { code });
const filled = (value: unknown): value is string => typeof value === 'string' && value !== '';

/**
 * Where an entry's rows belong: the unit's id, the month's owner columns (line-owner.ts), the entry's position in it
 * and, from an older release, its owner path.
 */
type Owner = { id: string; line: LineOwner; position: number; legacyOwner?: string };

const owned = (owner: Owner): Row => ({
  owner_key: owner.id,
  ...(owner.legacyOwner ? { owner_file: owner.legacyOwner } : {}),
});

/** The retired claim of an archived item hot memory does not hold: historical, its text from the entry. */
function claimStub(entry: Row, ctx: MapContext, owner: Owner): Row {
  const scope = (entry.scope ?? {}) as { user?: unknown; channel?: unknown };
  const entryText = entry.text as { text?: unknown } | undefined;
  const observedAt = entry.observedAt as { date?: unknown } | undefined;
  const user = typeof scope.user === 'string' && scope.user ? scope.user : null;
  const member = user === null ? null : (ctx.personOfMember?.(LEGACY_IFACE, user) ?? null);
  const channel = typeof scope.channel === 'string' && scope.channel ? scope.channel : null;
  const subject =
    member !== null
      ? { subject_kind: 'person', subject_id: member }
      : channel !== null
        ? {
            subject_kind: 'place',
            subject_id: ctx.placeOfChannel?.(LEGACY_IFACE, channel) ?? mintedChannel(LEGACY_IFACE, channel),
          }
        : { subject_kind: null, subject_id: null };
  return {
    id: entry.itemId,
    ...subject,
    kind: typeof entry.itemKind === 'string' ? entry.itemKind : null,
    text: typeof entryText?.text === 'string' ? entryText.text : null,
    extra: null,
    weight: typeof entry.weight === 'number' ? entry.weight : null,
    first_seen_at: typeof observedAt?.date === 'string' ? observedAt.date : null,
    last_seen_at: typeof entry.lastSeen === 'string' ? entry.lastSeen : null,
    valid_to: null,
    superseded_by: null,
    how: 'archive',
    author: 'import',
    from_person: null,
    truth: 'historical',
    shown: 0,
    ...(ctx.dmPlace
      ? dmPlaceScope(ifaceOf(ctx), ctx.dmPlace)
      : scopeColumns(entry.scope, {
          privateUser: null,
          dmOf: memberDmOf(LEGACY_IFACE, ctx.dmOfMember),
          dmOfPlace: storedDmOf(LEGACY_IFACE, ctx.dmPlaceOf),
        })),
    created_at: null,
    retired_at: typeof entry.recordedAt === 'string' ? entry.recordedAt : null,
    origin_file: owner.id,
    ...owned(owner),
    writer: 'archive',
    position: null,
  };
}

/**
 * The rows of an archive entry: its version, and the retired claim of its item when `hot` (the ids of the hot claims
 * and episodes) does not hold the item.
 */
export function archiveRows(entry: unknown, ctx: MapContext, owner: Owner, hot: ReadonlySet<string>): Rows {
  const rows: Rows = {};
  if (!isPlainObject(entry)) {
    put(rows, 'claim_versions', {
      id: `cv:${shortHash(JSON.stringify(entry))}:${owner.position}`,
      claim_id: null,
      revision_id: null,
      text: null,
      extra: JSON.stringify({ $raw: entry }),
      recorded_at: null,
      event: null,
      by: null,
      origin: null,
      ...owned(owner),
      ...lineColumns(owner.line),
      position: owner.position,
    });
    return rows;
  }
  const body: Row = { ...entry };
  let text: string | null = null;
  const entryText = entry.text;
  if (isPlainObject(entryText) && typeof entryText.text === 'string') {
    text = entryText.text;
    const left = { ...entryText };
    delete left.text;
    body.text = left;
  }
  const { cols, rest } = split(body, SPEC);
  if (cols.id === null) {
    cols.id = `cv:${shortHash(JSON.stringify(entry))}:${owner.position}`;
    rest.$noId = true;
  }
  put(rows, 'claim_versions', {
    ...cols,
    text,
    extra: extraText(rest),
    ...owned(owner),
    ...lineColumns(owner.line),
    position: owner.position,
  });
  const item = entry.itemId;
  if (filled(item) && !hot.has(item)) put(rows, 'claims', claimStub(entry, ctx, owner));
  return rows;
}

/** The entry of a stored version, as it was written. */
export function archiveEntryOf(row: Row): unknown {
  const rest = parseExtra(row.extra);
  if (Object.hasOwn(rest, '$raw')) return rest.$raw;
  const noId = rest.$noId === true;
  delete rest.$noId;
  const entry = join(row, rest, SPEC);
  if (noId) delete entry.id;
  if (row.text !== null && row.text !== undefined)
    entry.text = { text: row.text, ...(isPlainObject(rest.text) ? rest.text : {}) };
  return entry;
}

/**
 * Stores the entries of one month's unit `key` inside the caller's transaction, in order from the unit's next position.
 * `iface` is the interface of the write, for a persona's unit; `legacyOwner` an owner path of an older release.
 */
export function writeArchiveMonth(
  db: Db,
  key: StorageKey,
  lines: ReadonlyArray<unknown>,
  { iface, at, legacyOwner }: { iface: string; at: string; legacyOwner?: string }
): ArchiveLinesResult {
  const id = ensureUnit(db, key);
  if (legacyOwner) {
    db.prepare('INSERT OR IGNORE INTO legacy_unit_aliases(path,unit_id) VALUES (?,?)').run(legacyOwner, id);
    db.prepare('INSERT OR IGNORE INTO files(path,kind) VALUES (?,?)').run(legacyOwner, key.kind);
  }
  const base = storageContext(db, key);
  const ctx: MapContext = { ...base, iface: base.iface ?? iface };
  const hot = hotClaimIds(db);
  const month = lineOwnerOf(key);
  if (!month) throw coded('ARCHIVE_LINES_MONTH');
  let position = nextLinePosition(db, month);
  let written = 0;
  for (const line of lines) {
    if (line === null || typeof line !== 'object' || Array.isArray(line)) continue;
    writeMapping(db, archiveRows(line, ctx, { id, line: month, position, legacyOwner }, hot), id, {
      at,
      ignoreClaims: true,
    });
    written += 1;
    position += 1;
  }
  noteUnit(db, id, 'archive', { lines: position, at });
  if (written > 0) markStemsPending(db);
  return { written, duplicates: 0, adopted: 0 };
}

/** A write as the writer receives it, checked. */
export function archiveLinesWriteOf(update: Row): ArchiveLinesWrite {
  if (update.placeId !== null && !filled(update.placeId)) throw coded('ARCHIVE_LINES_PLACE');
  if (typeof update.month !== 'string' || !MONTH_RE.test(update.month)) throw coded('ARCHIVE_LINES_MONTH');
  if (!Array.isArray(update.lines)) throw coded('ARCHIVE_LINES_LINES');
  return { placeId: update.placeId, month: update.month, lines: update.lines as Array<unknown> };
}

/** The write kind `archive-lines` on the writer connection (session-write.ts). */
export function applyArchiveLinesWrite(handle: MemoryHandle, update: Row): ArchiveLinesResult {
  const write = archiveLinesWriteOf(update);
  const at = new Date(isFiniteNumber(update.now) ? update.now : Date.now()).toISOString();
  const key = placeOrPersona('archive', write.placeId, { partition: write.month });
  return handle.transaction(() =>
    writeArchiveMonth(dbOf(handle), key, write.lines, { iface: ifaceOrLegacy(update), at })
  );
}

/** The holder id of a place's archive (the persona's with null). */
const holderOf = (placeId: string | null): string => placeOrPersona('archive', placeId).subject.id;

/** The months of a place's archive (the persona's with null), in order. */
export function archiveMonths(db: Db, placeId: string | null): Array<string> {
  return linePeriods(db, 'archive', holderOf(placeId)).map((row) => row.period);
}

/** The entries (JSON text) of one month of a place's archive, in the order they were written. */
export function archiveLines(db: Db, placeId: string | null, month: string): Array<string> {
  return archiveUnitLines(db, placeOrPersona('archive', placeId, { partition: month }));
}

/** The entries (JSON text) of one archive month's unit `key`, in the order they were written. */
export function archiveUnitLines(db: Db, key: StorageKey): Array<string> {
  const owner = lineOwnerOf(key);
  if (!owner) return [];
  return lineRows(db, owner, 'claim_versions').map((row) => JSON.stringify(archiveEntryOf(row)));
}

/** Every holder of an archive: the places, and null for the persona's own. */
export function archiveHolders(db: Db): Array<string | null> {
  const holders = new Set<string | null>();
  for (const row of linePeriods(db, 'archive')) holders.add(row.holder === PERSONA_ID ? null : row.holder);
  return [...holders].sort((a, b) => String(a).localeCompare(String(b)));
}
