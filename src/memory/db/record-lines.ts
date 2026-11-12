// The lines of the record: what she saw, what she said, a deletion and a feeling, one `sources` row per line, owned by
// the unit of its place's day (`placeOrPersona('record', placeId, { partition: <YYYY-MM-DD> })`, the UTC day of the
// line's `occurredAt`), the unit the live observation (observe.ts) writes its lines into too. src/memory/record.ts writes
// them through the write kind `record-lines` (session-write.ts) and reads them back through the readers below.
//
// A row holds the line's fields in its columns (`kind`, `native_id` for `messageId`, `revision`, `occurred_at`,
// `recorded_at`, `text`, `media`, `mentions`, `direct`, `reply_to`, `author_account` for `by`, `turn_id`, `op_id`,
// `origin`) and the rest in `extra`. `seen_at` is the `recordedAt` of a `seen` line, null for any other kind. The scope
// comes from the line's old scope (scope-parts.ts): a line of a DM place takes the place's audience.
//
// A line a write names in `messages` (`{ lineId, locator, observedSourceId? }`, src/memory/record.ts#RecordMessageRef)
// takes the message family its locator resolves (message-families.ts), the one the live observation of the same
// message takes, and adopts the observation's row when it stored the line first: the row keeps its id and its place in
// the day, and takes the line's origin and fields. Her own line with no reference resolves its family from its own
// address. A line with neither keeps the id its message and revision spell. A line whose message revision, or deletion,
// the month already holds is a duplicate and writes nothing. A row's media go to `media` and `media_links`
// (media-store.ts), and a line read back gets them again.

import { messageLocator } from './message-locator.ts';
import type { MessageLocator } from './message-locator.ts';
import { messageSourceId, nativeAuthorityOf, PERSONA_ID } from './ids.ts';
import { mintedAccount } from './native-rows.ts';
import { extraText, ifaceOf, join, parseExtra, split } from './row-columns.ts';
import type { MapContext, Spec } from './row-columns.ts';
import { storageContext } from './storage-context.ts';
import type { OldScope } from './scope-parts.ts';
import { scopeFrom, scopeInto } from './scope-parts.ts';
import { resolveMessageFamily } from './message-families.ts';
import { familyError, hasMessageFamilies } from './message-family-catalog.ts';
import { observedSourceId } from './observe.ts';
import { writtenRowOf } from './source-current.ts';
import { storeHeld } from './media-stems.ts';
import { recordFieldsOf, takeRecordMedia, writeRecordMedia } from './media-store.ts';
import { markStemsPending } from './stems.ts';
import { placeOrPersona } from './unit-keys.ts';
import type { UnitKey } from './unit-keys.ts';
import { lineColumns, lineOwnerOf, linePeriods, lineRows, nextLinePosition } from './line-owner.ts';
import type { LineOwner } from './line-owner.ts';
import { writeMapping } from './upsert.ts';
import { requiredIface } from './live-iface.ts';
import { asText, dbOf, isFiniteNumber, isWholeNumber } from './types.ts';
import type { Db, MemoryHandle, Row } from './types.ts';
import type { NativeMessageLocator } from './recall.ts';

/** One write of the kind: lines of one place (null: the persona's), with the native references of some of them. */
export type RecordLinesWrite = {
  placeId: string | null;
  lines: ReadonlyArray<Row>;
  messages?: ReadonlyArray<Row>;
};

/** What a write answers: the lines it wrote, the ones the month already held, and the observations it adopted. */
export type RecordLinesResult = { written: number; duplicates: number; adopted: number };

/** The native identity a referenced line takes: its source id, its family and its revision. */
type Identity = {
  iface: string;
  sourceId: string;
  authority: string;
  nativeKind: string;
  familyKey: string;
  generation: number;
  revision: number | null;
};

/** What every line of one day's write shares: its unit, the unit's subject context and the write's references. */
type DayWrite = {
  key: UnitKey;
  /** The day's owner columns (line-owner.ts). */
  owner: LineOwner;
  ctx: MapContext;
  iface: string;
  messages: ReadonlyArray<Row> | undefined;
};

// Kinds whose source id carries the message revision. A deleted or felt line, and any line without a revision, has no
// revision to tell it apart, so its id carries the line's own id (ids never collide).
const REVISIONED_KINDS = new Set(['seen', 'said']);

/** The columns of a line under each context's readers, made once per context. */
const specs = new WeakMap<MapContext, Array<Spec>>();
function specOf(ctx: MapContext): Array<Spec> {
  let spec = specs.get(ctx);
  if (!spec) specs.set(ctx, (spec = lineSpec(ctx)));
  return spec;
}

/**
 * The columns of a line. Its author is the account its row holds, read back from that row. An author no row holds keeps
 * the id the line gave beside the column (`exact`).
 */
const lineSpec = (ctx: MapContext): Array<Spec> => [
  { col: 'kind', key: 'kind', type: 'text' },
  { col: 'native_id', key: 'messageId', type: 'text' },
  { col: 'revision', key: 'revision', type: 'num' },
  { col: 'occurred_at', key: 'occurredAt', type: 'text' },
  { col: 'recorded_at', key: 'recordedAt', type: 'text' },
  { col: 'text', key: 'text', type: 'text' },
  { col: 'media', key: 'media', type: 'json' },
  { col: 'mentions', key: 'mentions', type: 'json' },
  { col: 'direct', key: 'direct', type: 'bool' },
  { col: 'reply_to', key: 'replyTo', type: 'text' },
  {
    col: 'author_account',
    key: 'by',
    type: 'text',
    enc: (v: unknown, iface: string | null) =>
      iface === null ? null : (ctx.accountOfMember?.(iface, String(v)) ?? mintedAccount(iface, String(v))),
    dec: (v: unknown) => (typeof v === 'string' ? (ctx.memberOfAccount?.(v) ?? null) : null),
    exact: true,
  },
  { col: 'turn_id', key: 'turnId', type: 'text' },
  { col: 'op_id', key: 'opId', type: 'text' },
  { col: 'origin', key: 'origin', type: 'text' },
];

const coded = (code: string): Error & { code: string } => Object.assign(new Error(code), { code });
const filled = (value: unknown): value is string => typeof value === 'string' && value !== '';
const isRecord = (value: unknown): value is Row => value !== null && typeof value === 'object' && !Array.isArray(value);

/** The id of a line's row; a line built with no interface spells `none` in its place. */
function sourceIdOf(line: Row, given: string | null): string {
  const iface = given ?? 'none';
  const kind = typeof line.kind === 'string' ? line.kind : 'unknown';
  const messageId = typeof line.messageId === 'string' ? line.messageId : null;
  if (REVISIONED_KINDS.has(kind) && messageId && isFiniteNumber(line.revision))
    return messageSourceId(iface, messageId, line.revision, kind);
  return `src:${iface}:${messageId ?? 'none'}:${kind}:${asText(line.id ?? 'unknown')}`;
}

/**
 * The `sources` row of a line, without its owner and position: `ctx.iface` its interface, `ctx.privateAccountId` the
 * partner of a private layer, `ctx.dmPlace` the DM place of its unit, `identity` the family a reference resolved.
 */
export function recordSourceRow(line: Row, ctx: MapContext = {}, identity?: Identity): Row {
  const iface = ifaceOf(ctx);
  const { cols, rest } = split(line, specOf(ctx), iface);
  delete rest.scope;
  delete rest.$messageLocator;
  delete rest.$messageReply;
  if (line.v === 1 && REVISIONED_KINDS.has(String(line.kind))) {
    const locator = messageLocator(
      {
        v: 1,
        origin: 'record-v1',
        iface,
        messageId: line.messageId,
        chatId: (line.scope as OldScope | undefined)?.channel,
      },
      iface
    );
    if (locator) rest.$messageLocator = locator;
  }
  const scopeRest = {};
  const scope = scopeInto(
    scopeRest,
    line.scope as OldScope | undefined,
    ctx.privateAccountId ?? null,
    iface,
    ctx.dmPlace,
    ctx
  );
  Object.assign(rest, scopeRest);
  return {
    id: identity?.sourceId ?? sourceIdOf(line, iface),
    iface,
    ...cols,
    ...(identity
      ? {
          authority_id: identity.authority,
          native_kind: identity.nativeKind,
          native_id: identity.familyKey,
          generation: identity.generation,
          revision: identity.revision,
        }
      : {}),
    ...scope,
    seen_at: line.kind === 'seen' && typeof line.recordedAt === 'string' && line.recordedAt ? line.recordedAt : null,
    extra: extraText(rest),
  };
}

/** The line of a stored row, as it was written. `ctx` is its day's subject context. */
export function recordLineOf(row: Row, ctx: MapContext = {}): Row {
  const rest = parseExtra(row.extra);
  const locator = messageLocator(rest.$messageLocator, row.iface);
  const reply =
    rest.$messageReply && typeof rest.$messageReply === 'object'
      ? messageLocator({ ...rest.$messageReply, v: 1, origin: 'record-v1' }, row.iface)
      : null;
  delete rest.$messageLocator;
  delete rest.$messageReply;
  const scope = scopeFrom(row, rest, ctx.privateAccountId, ctx);
  const line = join(row, rest, specOf(ctx));
  if (locator) line.messageId = locator.messageId;
  if (reply) line.replyTo = reply.messageId;
  if (scope !== undefined) line.scope = scope;
  return line;
}

/** A record line reads its media as it was written: the kinds and link cards of the items it links. */
export function addSourceMedia(db: Db, sources: Array<Row>): void {
  if (sources.length === 0 || !db.prepare("SELECT 1 FROM sqlite_master WHERE name = 'media_links'").get()) return;
  for (const source of sources) {
    const { media, links } = recordFieldsOf(db, asText(source.id));
    if (media.length === 0) continue;
    source.media = JSON.stringify(media);
    if (links.length > 0) source.extra = JSON.stringify({ ...parseExtra(source.extra), links });
  }
}

/** The rows of the record of `holder` in `month`, as a condition on `sources` and its values. */
function monthOf(holder: string, month: string): { sql: string; args: Array<string> } {
  return {
    sql: "writer = 'record' AND holder_id = ? AND period >= ? AND period < ?",
    args: [holder, `${month}-01`, `${month}-99`],
  };
}

/** Whether a line is one its day's month already holds (an observation is adopted, never a duplicate). */
function recordDuplicate(db: Db, owner: LineOwner, line: Row): boolean {
  const messageId = filled(line?.messageId) ? line.messageId : null;
  if (!messageId) return false;
  const month = monthOf(owner.holder_id, owner.period.slice(0, 7));
  if (line.kind === 'deleted') {
    return (
      db
        .prepare(
          `SELECT 1 AS ok FROM sources WHERE native_id = ? AND kind = 'deleted' AND ${month.sql} AND retired_at IS NULL LIMIT 1`
        )
        .get(messageId, ...month.args) !== undefined
    );
  }
  const revision = isWholeNumber(line.revision) && line.revision > 0 ? line.revision : 1;
  for (const row of db
    .prepare(
      `SELECT id, revision, origin FROM sources WHERE native_id = ? AND kind IN ('seen', 'said') AND ${month.sql} AND retired_at IS NULL`
    )
    .all(messageId, ...month.args)) {
    if (row.origin === 'observation') continue;
    const stored = row.revision;
    if ((isWholeNumber(stored) && stored > 0 ? stored : 1) === revision) return true;
  }
  return false;
}

function recordLocator(hint: Row, line: Row): MessageLocator {
  const raw = hint.locator;
  if (!isRecord(raw)) throw familyError('BAD_NATIVE');
  const locator = messageLocator({ ...raw, v: 1, origin: 'record-v1' }, 'iface' in raw ? raw.iface : null);
  const scope = line.scope;
  if (
    !locator ||
    locator.messageId !== line.messageId ||
    !isRecord(scope) ||
    !('channel' in scope) ||
    scope.channel !== locator.chatId
  )
    throw familyError('BAD_PLACE');
  return locator;
}

/**
 * Her own line reaches the record with no reference (src/turn/journal-notes.ts#recordSaid and its siblings). Its
 * interface, its channel and its message id are its address, so it takes the family the echo of the same message took,
 * or reserves the one the echo will find.
 */
function saidReference(db: Db, day: DayWrite, line: Row): { hint: Row; locator: MessageLocator } | undefined {
  // A write by an older owner path keeps the keys of the rows it brings.
  if (line.kind !== 'said' || line.v !== 1 || !hasMessageFamilies(db)) return undefined;
  const iface = day.ctx.iface ?? day.iface;
  const chatId = (line.scope as { channel?: unknown } | undefined)?.channel;
  const locator = messageLocator({ v: 1, origin: 'record-v1', iface, chatId, messageId: line.messageId }, iface);
  return locator ? { hint: {}, locator } : undefined;
}

function recordReference(db: Db, day: DayWrite, line: Row): { hint: Row; locator: MessageLocator } | undefined {
  if (day.messages === undefined) return saidReference(db, day, line);
  const given: unknown = day.messages;
  if (!Array.isArray(given)) throw familyError('BAD_NATIVE');
  const matching = (given as Array<unknown>).filter(
    (value): value is Row => isRecord(value) && value.lineId === line.id
  );
  if (matching.length === 0 && !['seen', 'said', 'deleted'].includes(asText(line.kind))) return undefined;
  if (matching.length !== 1 || line.v !== 1 || !filled(line.id)) throw familyError('BAD_NATIVE');
  const hint = matching[0];
  return { hint, locator: recordLocator(hint, line) };
}

function recordIdentity(db: Db, day: DayWrite, line: Row): Identity | undefined {
  const reference = recordReference(db, day, line);
  if (!reference) return undefined;
  const { hint, locator } = reference;
  // A family the echo has not reserved yet takes the interface's native authority, the one its account and place sit
  // under (`cli/local` for the command line), so the echo's replay finds her account there.
  const family = resolveMessageFamily(db, { locator, authority: nativeAuthorityOf(locator.iface) });
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

function recordReply(db: Db, source: Row, line: Row, identity: Identity): void {
  if (!filled(line.replyTo)) return;
  const extra = parseExtra(source.extra);
  const locator = messageLocator(extra.$messageLocator, source.iface);
  if (!locator) throw familyError('BAD_NATIVE');
  const reply = { iface: locator.iface, chatId: locator.chatId, messageId: line.replyTo };
  const parent = resolveMessageFamily(db, { locator: reply, authority: identity.authority });
  source.reply_to = parent.native_key;
  source.extra = JSON.stringify({ ...extra, $messageReply: reply });
}

function adoptedRecord(source: Row, found: Row): Row {
  const adopted: Row = {
    ...found,
    ...lineColumns({ writer: 'record', holder_id: asText(source.holder_id), period: asText(source.period) }),
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

/** Whether a stored row is one of the day `owner`'s lines. */
const ownedBy = (row: Row, owner: LineOwner): boolean =>
  row.writer === owner.writer && row.holder_id === owner.holder_id && row.period === owner.period;

/** One line of a day's write at `position`; what it wrote and whether the day's next position moves. */
function writeLine(db: Db, day: DayWrite, line: Row, position: number, at: string) {
  const identity = recordIdentity(db, day, line);
  // The unit's subject names the interface; the persona's, which names none, takes the reference's or the write's.
  const iface = day.ctx.iface ?? identity?.iface ?? day.iface;
  let source: Row = {
    ...recordSourceRow(line, { ...day.ctx, iface }, identity),
    ...lineColumns(day.owner),
    position,
  };
  if (identity) recordReply(db, source, line, identity);
  const found = db.prepare('SELECT * FROM sources WHERE id = ?').get(source.id);
  const duplicate =
    (!identity && recordDuplicate(db, day.owner, line)) ||
    (found !== undefined && found.origin !== 'observation' && found.retired_at === null);
  if (duplicate) return { written: 0, duplicates: 1, adopted: 0, advance: 0 };
  if (identity && found) source = adoptedRecord(source, found);
  // The live observation wrote the line first: the line takes the row over, its place in the unit stays.
  const keep =
    found !== undefined &&
    found.origin === 'observation' &&
    ownedBy(found, day.owner) &&
    Number.isInteger(found.position);
  if (keep) source.position = found.position;
  // What a line holds of its media goes to `media` and `media_links`, and leaves its `extra`.
  const media = storeHeld(db) ? takeRecordMedia(source) : null;
  writeMapping(db, { sources: [source] }, { at });
  if (media) writeRecordMedia(db, asText(source.id), media, at);
  return { written: 1, duplicates: 0, adopted: found?.origin === 'observation' ? 1 : 0, advance: keep ? 0 : 1 };
}

/**
 * Stores the lines of one day's unit `key` inside the caller's transaction, in order from the unit's next position.
 * `iface` is the interface of the write, for a persona's unit.
 */
export function writeRecordDay(
  db: Db,
  key: UnitKey,
  lines: ReadonlyArray<Row>,
  { messages, iface, at }: { messages?: ReadonlyArray<Row>; iface: string; at: string }
): RecordLinesResult {
  const owner = lineOwnerOf(key);
  if (!owner) throw coded('RECORD_LINES_DAY');
  const day: DayWrite = { key, owner, ctx: storageContext(db, key, iface), iface, messages };
  const result: RecordLinesResult = { written: 0, duplicates: 0, adopted: 0 };
  let position = nextLinePosition(db, owner);
  for (const line of lines) {
    if (!isRecord(line)) continue;
    const done = writeLine(db, day, line, position, at);
    result.written += done.written;
    result.duplicates += done.duplicates;
    result.adopted += done.adopted;
    position += done.advance;
  }
  if (result.written > 0) markStemsPending(db);
  return result;
}

/** A write as the writer receives it, checked. */
export function recordLinesWriteOf(update: Row): RecordLinesWrite {
  if (update.placeId !== null && !filled(update.placeId)) throw coded('RECORD_LINES_PLACE');
  if (!Array.isArray(update.lines)) throw coded('RECORD_LINES_LINES');
  if (update.messages !== undefined && !Array.isArray(update.messages)) throw familyError('BAD_NATIVE');
  return {
    placeId: update.placeId,
    lines: (update.lines as Array<unknown>).filter(isRecord),
    ...(update.messages !== undefined ? { messages: update.messages as Array<Row> } : {}),
  };
}

/** Stores one checked write inside the caller's transaction: each run of lines of one day in that day's unit. */
export function writeRecordLines(db: Db, write: RecordLinesWrite, iface: string, at: string): RecordLinesResult {
  const result: RecordLinesResult = { written: 0, duplicates: 0, adopted: 0 };
  const runs: Array<{ day: string; lines: Array<Row> }> = [];
  for (const line of write.lines) {
    const day = String(line.occurredAt).slice(0, 10);
    const last = runs.at(-1);
    if (last?.day === day) last.lines.push(line);
    else runs.push({ day, lines: [line] });
  }
  for (const run of runs) {
    const key = placeOrPersona('record', write.placeId, { partition: run.day });
    const done = writeRecordDay(db, key, run.lines, { messages: write.messages, iface, at });
    result.written += done.written;
    result.duplicates += done.duplicates;
    result.adopted += done.adopted;
  }
  return result;
}

/** The write kind `record-lines` on the writer connection (session-write.ts). */
export function applyRecordLinesWrite(handle: MemoryHandle, update: Row): RecordLinesResult {
  const write = recordLinesWriteOf(update);
  const at = new Date(isFiniteNumber(update.now) ? update.now : Date.now()).toISOString();
  return handle.transaction(() => writeRecordLines(dbOf(handle), write, requiredIface(update), at));
}

/** The holder id of a place's record (the persona's with null). */
const holderOf = (placeId: string | null): string => placeOrPersona('record', placeId).subject.id;

/** The days of a place's record, in order. */
function daysOf(db: Db, placeId: string | null): Array<string> {
  return linePeriods(db, 'record', holderOf(placeId)).map((row) => row.period);
}

/** The months of a place's record, in order. */
export function recordMonths(db: Db, placeId: string | null): Array<string> {
  return [...new Set(daysOf(db, placeId).map((day) => day.slice(0, 7)))].sort();
}

/** The days of a month of a place's record, each with its unit, in order. */
export function recordDays(db: Db, placeId: string | null, month: string): Array<{ day: string; owner: UnitKey }> {
  return daysOf(db, placeId)
    .filter((day) => day.startsWith(`${month}-`))
    .map((day) => ({ day, owner: placeOrPersona('record', placeId, { partition: day }) }));
}

/** The lines of one day's unit as JSON text, in the order they were written. */
export function recordLines(db: Db, key: UnitKey): Array<string> {
  const owner = lineOwnerOf(key);
  if (!owner) return [];
  const ctx = storageContext(db, key);
  const rows = lineRows(db, owner, 'sources');
  addSourceMedia(db, rows);
  return rows.map((row) => JSON.stringify(recordLineOf(whoseRow(db, row), ctx)));
}

/**
 * `row` as the record reads it: an edit is stored `seen` with the author of the edit, so a later revision of a stored
 * line takes the kind and the author of the first revision, whose line it is. Moment and revision stay the row's.
 */
function whoseRow(db: Db, row: Row): Row {
  const written = writtenRowOf(db, row);
  return written === row
    ? row
    : { ...row, kind: written.kind, author_kind: written.author_kind, author_account: written.author_account };
}

/** The interface of the place that holds a record: its stored one, else none. */
function ifaceOfHolder(db: Db, placeId: string | null): string | null {
  if (placeId === null) return null;
  const stored = db.prepare('SELECT iface FROM places WHERE id = ?').get(placeId)?.iface;
  return typeof stored === 'string' ? stored : null;
}

/** The highest revision the month holds of a message (a deletion does not count), or null when it holds none. */
export function recordNewestRevision(
  db: Db,
  placeId: string | null,
  month: string,
  messageId: unknown,
  locator?: NativeMessageLocator,
  iface = locator?.iface ?? ifaceOfHolder(db, placeId)
): number | null {
  const scope = monthOf(holderOf(placeId), month);
  const family = locator
    ? db
        .prepare('SELECT * FROM message_families WHERE iface=? AND conversation_id=? AND message_id=? AND generation=1')
        .get(locator.iface, locator.chatId, locator.messageId)
    : null;
  if (locator && (!family || locator.messageId !== messageId)) return null;
  // With no locator the message id still names its family: an observed line holds the family's key.
  const clause = family
    ? 'authority_id=? AND native_kind=? AND native_id=? AND generation=?'
    : hasMessageFamilies(db)
      ? 'native_id IN (?, (SELECT native_key FROM message_families WHERE iface=? AND message_id=? AND generation=1))'
      : 'native_id=?';
  const values = family
    ? [family.authority_id, family.native_kind, family.native_key, family.generation]
    : hasMessageFamilies(db)
      ? [String(messageId), iface, String(messageId)]
      : [String(messageId)];
  const rows = db
    .prepare(`SELECT kind,revision FROM sources WHERE ${clause} AND ${scope.sql} AND retired_at IS NULL`)
    .all(...values, ...scope.args);
  let newest: number | null = null;
  for (const row of rows)
    if (row.kind !== 'deleted') {
      const revision = Number.isInteger(row.revision) && Number(row.revision) > 0 ? Number(row.revision) : 1;
      newest = Math.max(newest ?? 0, revision);
    }
  return newest;
}

/** How many messages a place's record holds, over how many days, from which first day. */
export function recordStats(db: Db, placeId: string | null): { messages: number; days: number; first: string | null } {
  const days = daysOf(db, placeId);
  const messages = days.length
    ? Number(
        db
          .prepare(
            `SELECT COUNT(DISTINCT json_array(iface,authority_id,native_kind,native_id,generation)) AS n FROM sources
    WHERE native_id IS NOT NULL AND writer = 'record' AND holder_id = ? AND retired_at IS NULL`
          )
          .get(holderOf(placeId))?.n
      )
    : 0;
  return { messages, days: days.length, first: days[0] ?? null };
}

/** Every place that holds a record. */
export function recordHolders(db: Db): Array<string> {
  return [...new Set(linePeriods(db, 'record').map((row) => row.holder))]
    .filter((holder) => holder !== PERSONA_ID)
    .sort();
}
