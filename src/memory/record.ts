// The record: what the app observed, kept for good. Hot memory forgets by design (caps,
// eviction); the record does not, so nothing the persona lived through is lost to eviction.
// One line per observation in the memory database (src/memory/db/service.ts), in the unit of its
// day, `<place>/record/<YYYY-MM>/<YYYY-MM-DD>.jsonl` (`dayFile`, relative to the data
// directory: the unit's name, no file), by the UTC day of the line's `occurredAt`; a private
// chat's lines go under `private/<accountId>/record/` instead and never into the place record. Kinds:
//
//   - `seen`: a message the app observed (an edit is a new line with revision 2, 3, ...);
//   - `deleted`: the platform deleted a message (its stored text stays: not a forget request);
//   - `said`: the persona's own message, once its post succeeded;
//   - `felt`: the feeling she attached to a stored moment, with its own id.
//
// Only a whitelist of a message's fields enters a line (toRecordLine): ids, time, channel,
// author, reply target, text, media kinds (never a URL of a file), mentions, `direct`, and for a
// posted link with a preview the compact `links` (recordLinks: its URL, as posted in the text, with
// the preview's title, description and site, so a link post is found by what it shows). `append`
// waits while a writer lock is held (`writerGate`), then writes every line as the record mapper maps
// it, in its day's unit (`memoryDb.writeUnit`, op `lines`), which refuses a line whose message
// revision (or deletion) the month already holds and adopts a line the live observation wrote
// first; the promise resolves once the writer committed and rejects with the writer's code. Every
// read is answered from the database (src/memory/db/readers/record.ts); a closed database is an
// error with a code (`DB_CLOSED`), never an empty answer.
//
// Logs carry counts and ids of places, never a line's contents.

import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { keyText, placeOrPersona } from './db/storage-keys.ts';

import type { StorageKey } from './db/storage-keys.ts';

import { log as defaultLog } from '../log.ts';
import { clampChars, clampWithEllipsis, oneLine } from './clamp.ts';
import { memoryRootOf } from './root.ts';

import { recordDays, recordLines, recordMonths, recordNewestRevision, recordStats } from './db/readers/record.ts';
import { isFiniteNumber, isIntegerNumber, readSeamOf } from './types.ts';
import type { StoredRecord, MemoryDb, Untyped } from './types.ts';
import type { NativeMessageLocator } from './db/recall.ts';

/** The schema version every line carries. */
export const RECORD_VERSION = 1;

const MONTH_RE = /^\d{4}-\d{2}$/;
const DAY_RE = /^\d{4}-\d{2}-\d{2}/;
const DATE_ONLY_RE = /^\d{4}-\d{2}-\d{2}$/;

/** The most links one record line keeps. */
export const RECORD_LINKS_MAX = 3;
/** The longest title or description of a recorded link, in code points (the ellipsis included). */
const LINK_TEXT_CHARS = 200;
/** The longest URL and cache id of a recorded link, in code points. */
const LINK_URL_CHARS = 500;
/** The longest site name of a recorded link, in code points. */
const LINK_SITE_CHARS = 100;

/** Distinct non-empty strings of `values` (arrays), in order. */
function idList(...values: Array<unknown>): Array<string> {
  const out: Array<string> = [];
  for (const value of values) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item === 'string' && item && !out.includes(item)) out.push(item);
    }
  }
  return out;
}

/**
 * An epoch-ms or ISO time (a bare `YYYY-MM-DD` is that day's midnight UTC) as an ISO string, else
 * null. Shared with src/memory/archive.ts.
 */
export function isoOf(value: unknown): string | null {
  if (typeof value === 'number' && isFiniteNumber(value)) return new Date(value).toISOString();
  if (typeof value === 'string' && value) {
    if (DATE_ONLY_RE.test(value)) return `${value}T00:00:00.000Z`;
    const ms = Date.parse(value);
    return isFiniteNumber(ms) ? new Date(ms).toISOString() : null;
  }
  return null;
}

/** The media kinds of a slim message: attachments, links, then one `sticker` per sticker. */
function mediaKinds(slim: Untyped) {
  const kinds = [];
  for (const item of [
    ...(Array.isArray(slim.attachments) ? slim.attachments : []),
    ...(Array.isArray(slim.links) ? slim.links : []),
  ]) {
    if (item && typeof item.kind === 'string' && item.kind) kinds.push(item.kind);
  }
  for (const sticker of Array.isArray(slim.stickers) ? slim.stickers : []) if (sticker) kinds.push('sticker');
  return kinds;
}

/**
 * The compact links of a record line, from a normalized message's links (src/protocol/events.ts#Message:
 * `{ id, kind, url, title, text, site }`) or from links already in this shape (`description`
 * instead of `text`): each `{ id?, url, title, description, site }` on one line, the title and the
 * description clamped to LINK_TEXT_CHARS at a boundary (clampWithEllipsis). Only a link (`kind`
 * `link`, or no kind: never a GIF, whose URL leaves the text) with a title or a description is
 * kept, at most RECORD_LINKS_MAX, in order. `id` is the link's media-cache key, when it has one.
 * Pure.
 */
export function recordLinks(
  items: unknown
): Array<{ id?: string; url: string; title: string; description: string; site: string }> {
  const out = [];
  const str = (value: Untyped) => (typeof value === 'string' ? oneLine(value) : '');
  for (const item of Array.isArray(items) ? items : []) {
    if (out.length >= RECORD_LINKS_MAX) break;
    if (!item || typeof item !== 'object' || (item.kind !== undefined && item.kind !== 'link')) continue;
    const title = clampWithEllipsis(str(item.title), LINK_TEXT_CHARS);
    const description = clampWithEllipsis(str(item.description ?? item.text), LINK_TEXT_CHARS);
    if (!title && !description) continue;
    const id = clampChars(str(item.id), LINK_URL_CHARS);
    out.push({
      ...(id ? { id } : {}),
      url: clampChars(str(item.url), LINK_URL_CHARS),
      title,
      description,
      site: clampChars(str(item.site), LINK_SITE_CHARS),
    });
  }
  return out;
}

/**
 * One record line from a slim message (src/memory/update.ts#slimMessage; `mentionedAccountIds`
 * and `replyToAuthorId` are read when the slim has them). Only the whitelisted fields are
 * copied: `messageId`, `revision`, `occurredAt` (the slim's `ts`), the channel (as `scope`),
 * `by`, `replyTo`, `text`, `media` (kinds only), `links` (recordLinks of the slim's `linkCards`,
 * only when there are some: a line without the key has no link preview), `mentions`, `direct`;
 * `participants` = the author, the mentioned members and the reply target's author when known. A `said` line names
 * no author (it is the persona's) and carries `turnId` / `opId`; a `deleted` line keeps only
 * the message id and its author as a participant. `placeId` is stamped on append.
 *
 */
export function toRecordLine(
  slim: StoredRecord,
  {
    kind = 'seen',
    revision = 1,
    origin = 'live',
    now = Date.now,
    uuid = randomUUID,
    turnId = null,
    opId = null,
  }: {
    kind?: 'seen' | 'said' | 'deleted';
    revision?: number;
    origin?: 'live' | 'backfill';
    now?: () => number;
    uuid?: () => string;
    turnId?: string | null;
    opId?: string | null;
  } = {}
): object {
  const source = slim && typeof slim === 'object' ? slim : {};
  const messageId = typeof source.id === 'string' && source.id ? source.id : null;
  const placeId = typeof source.placeId === 'string' && source.placeId ? source.placeId : null;
  const by = typeof source.authorId === 'string' && source.authorId ? source.authorId : null;
  const replyTo = typeof source.replyToId === 'string' && source.replyToId ? source.replyToId : null;
  const replyAuthor =
    replyTo && typeof source.replyToAuthorId === 'string' && source.replyToAuthorId ? source.replyToAuthorId : null;
  const mentions = idList(source.mentionedAccountIds ?? source.mentions);
  const recordedAt = new Date(now()).toISOString();
  const head = {
    v: RECORD_VERSION,
    id: uuid(),
    kind,
    messageId,
  };
  const envelope = {
    occurredAt: isoOf(source.ts) ?? recordedAt,
    recordedAt,
    scope: placeId ? { channel: placeId } : {},
  };
  const tail = { sourceMessageIds: idList(messageId), origin: origin === 'backfill' ? 'backfill' : 'live' };
  if (kind === 'deleted') return { ...head, ...envelope, participants: idList(by), ...tail };
  const rev = isIntegerNumber(revision) && revision > 0 ? revision : 1;
  const links = recordLinks(source.linkCards);
  const body = {
    ...head,
    revision: rev,
    ...envelope,
    ...(kind === 'said' ? {} : { by }),
    replyTo,
    text: typeof source.content === 'string' ? source.content : '',
    media: mediaKinds(source),
    ...(links.length > 0 ? { links } : {}),
    mentions,
  };
  if (kind === 'said') {
    return {
      ...body,
      turnId: turnId ?? null,
      opId: opId ?? null,
      participants: idList(mentions, replyAuthor),
      ...tail,
    };
  }
  return { ...body, direct: source.direct === true, participants: idList(by, mentions, replyAuthor), ...tail };
}

/**
 * The revision id of a feeling's text: `rv-` and the first 12 hex digits of its sha256.
 */
export function revisionOf(text: string): string {
  return `rv-${createHash('sha256')
    .update(String(text ?? ''), 'utf8')
    .digest('hex')
    .slice(0, 12)}`;
}

/**
 * A `felt` line: the feeling the persona attached to a stored moment of `accountId`.
 * @param feeling  `date`: the episode's date (a day or an ISO time).
 */
export function feltLine(
  {
    accountId,
    itemId = null,
    text,
    date = null,
    sourceMessageIds = [],
  }: {
    accountId: string;
    itemId?: string | null;
    text: string;
    date?: string | null;
    sourceMessageIds?: Array<string>;
  },
  {
    now = Date.now,
    uuid = randomUUID,
    origin = 'live',
  }: { now?: () => number; uuid?: () => string; origin?: 'live' | 'backfill' } = {}
): object {
  const recordedAt = new Date(now()).toISOString();
  return {
    v: RECORD_VERSION,
    id: uuid(),
    kind: 'felt',
    feltId: `f-${uuid()}`,
    itemId: typeof itemId === 'string' && itemId ? itemId : null,
    revisionId: revisionOf(text),
    occurredAt: isoOf(date) ?? recordedAt,
    recordedAt,
    scope: { user: String(accountId) },
    text: String(text ?? ''),
    participants: idList(String(accountId)),
    sourceMessageIds: idList(sourceMessageIds),
    origin: origin === 'backfill' ? 'backfill' : 'live',
  };
}

/** How many times appendRevision moves an edit past a revision the record already holds. */
export const EDIT_REVISION_RETRIES = 5;

/**
 * Append an edit's line at `revision`, or after the newest revision the record holds when that
 * one is taken (revisions the caller's own count does not know): on a duplicate the line is rebuilt with the record's newest revision of
 * the message + 1 (`record.newestRevision`, else the refused revision + 1) and appended again, at
 * most EDIT_REVISION_RETRIES times. A bump is logged as `record: edit revision bumped` (counts
 * only). The caller continues its own count from the returned `revision`.
 * @param record  From createRecord.
 * @param lineAt  The line at a revision (toRecordLine).
 * @param revision  The revision to try first.
 */
export async function appendRevision(
  record: { append: Untyped; newestRevision?: Untyped },
  placeId: string,
  lineAt: (revision: number) => Untyped,
  revision: number,
  { log = defaultLog }: { log?: { info: Untyped } } = {}
): Promise<{ revision: number; written: number; duplicates: number; bumps: number }> {
  let current = revision;
  let line = lineAt(current);
  let result = await record.append(placeId, [line]);
  let bumps = 0;
  while ((result?.duplicates ?? 0) > 0 && bumps < EDIT_REVISION_RETRIES) {
    bumps += 1;
    const known =
      typeof record.newestRevision === 'function'
        ? await record.newestRevision(placeId, line.messageId, line.occurredAt)
        : null;
    current = Math.max(current, isIntegerNumber(known) ? known : current) + 1;
    line = lineAt(current);
    result = await record.append(placeId, [line]);
  }
  const written = result?.written ?? 0;
  if (bumps > 0) log.info('record: edit revision bumped', { placeId: String(placeId), bumps, written });
  return { revision: current, written, duplicates: result?.duplicates ?? 0, bumps };
}

/** A line of the record as it is stored: a message the persona saw or said, or the deletion of one. */
export type RecordLine = {
  [field: string]: Untyped;
  kind?: string;
  messageId: string;
  occurredAt: string;
  revision?: number;
  scope: { channel?: string; private?: boolean; user?: string };
  text?: string;
  by?: string;
  links?: Array<Untyped>;
};

/** The parsed line, or null. */
function parse(line: Untyped) {
  try {
    const value = JSON.parse(line);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/** What `RecordStore.iterate` yields, as the record lines they are (the store's public type keeps them plain objects). */
export function asRecordLines(lines: AsyncIterable<object>): AsyncIterable<RecordLine> {
  // The record writes nothing but record lines.
  return lines as AsyncIterable<RecordLine>;
}

export type RecordMessageRef = Readonly<{
  lineId: string;
  locator: NativeMessageLocator;
  observedSourceId?: string;
}>;

export type RecordStore = {
  append(
    placeId: string | null,
    lines: Array<object>,
    opts?: { messages?: ReadonlyArray<RecordMessageRef> }
  ): Promise<{ written: number; duplicates: number }>;
  dayFile(placeId: string, occurredAtIso: string): string;
  iterate(placeId: string, query?: { from?: string; to?: string; placeIds?: Array<string> }): AsyncIterable<object>;
  newestRevision(
    placeId: string,
    messageId: string,
    occurredAtIso: string,
    opts?: { locator?: NativeMessageLocator }
  ): Promise<number | null>;
  stats(placeId: string): Promise<{ messages: number; days: number; first: string | null }>;
};

/**
 * Create the record.
 *
 * @param options.dataDir  the `data/` directory (the units' names are relative to it)
 * @param [options.writerGate]  awaited before every append: the
 *   journal's `waitUnlocked`, so its writer lock (src/memory/journal.ts#withWriterLock) holds the
 *   record's appends too
 * @param options.memoryDb  the memory database service (src/memory/db/service.ts): every
 *   read is answered from it (src/memory/db/readers/record.ts) and `append` writes it (`writeUnit`); a
 *   failed read or write rejects with a code
 *   `stats` counts the record of a place (the distinct message ids of its lines). `append` stamps
 *   the private scope on each line of a DM place, one write per run of
 *   lines of one day; a line the month already holds is a duplicate (`duplicates`). `iterate` streams
 *   the parsed lines whose `occurredAt` lies in `[from, to]` (and whose channel is one of `placeIds`
 *   when given), day by day. `newestRevision` is the highest revision the month of `occurredAtIso`
 *   holds for the message (null when none; a `deleted` line does not count). Appends run one at a time.
 *   `dayFile` is the absolute path a day's unit is named after (no file is written there).
 */
export function createRecord({
  dataDir,
  log = defaultLog,
  now = Date.now,
  writerGate = null,
  memoryDb = null,
}: {
  dataDir: string;
  log?: { info: Untyped; warn: Untyped };
  now?: () => number;
  writerGate?: (() => Promise<void>) | null;
  memoryDb: MemoryDb | null;
}): RecordStore {
  const root = memoryRootOf(dataDir);
  const seam = readSeamOf(memoryDb, log, 'record');
  let chain: Promise<unknown> = Promise.resolve();

  /** Run `task` after every append already queued. */
  function serial<TResult>(task: () => Promise<TResult>): Promise<TResult> {
    const run = chain.then(task);
    chain = run.catch(() => {});
    return run;
  }

  function baseDir(placeId: string | null) {
    return path.join(root.placeDir(placeId), 'record');
  }

  function dayOf(iso: string) {
    return String(iso ?? '').match(DAY_RE)?.[0] ?? new Date(now()).toISOString().slice(0, 10);
  }

  function dayFile(placeId: string | null, occurredAtIso: Untyped) {
    const day = dayOf(occurredAtIso);
    return path.join(baseDir(placeId), day.slice(0, 7), `${day}.jsonl`);
  }

  /** The partner of a stored DM place: the account and its native id, or null for any other place. */
  function partnerOf(placeId: string | null): { native: string } | null {
    if (placeId === null || !memoryDb?.readHandle?.()) return null;
    const db = seam.db();
    const row = seam.run(() =>
      db
        .prepare(
          `SELECT a.native_id AS native, p.native_key AS key FROM places p LEFT JOIN accounts a ON a.id = p.partner_account
           WHERE p.id = ? AND (p.kind = 'dm' OR p.conversation = 'dm')`
        )
        .get(placeId)
    );
    // A DM place no row holds yet (a kept write of an older release): its spelled id names the partner.
    if (!row) {
      const spelled = /^[^:]+:dm:(.+)$/.exec(placeId)?.[1];
      return spelled ? { native: spelled } : null;
    }
    const native = row.native ?? /^dm:(.+)$/.exec(String(row.key))?.[1];
    return typeof native === 'string' ? { native } : null;
  }

  /** A line as `append` stores it: `occurredAt` as ISO, a line of a DM place with the private scope. */
  function stamped(raw: Untyped, partner: { native: string } | null) {
    const line = { ...raw };
    line.occurredAt = isoOf(line.occurredAt) ?? new Date(now()).toISOString();
    if (partner) {
      const channel = typeof raw.scope?.channel === 'string' ? raw.scope.channel : null;
      line.scope = { user: partner.native, private: true, ...(channel ? { channel } : {}) };
    }
    return line;
  }

  /** The database's writer, or a coded rejection when there is none. */
  function unitWriter() {
    if (typeof memoryDb?.writeUnit !== 'function')
      throw Object.assign(new Error('memory db: no writer'), { code: 'DB_CLOSED' });
    return memoryDb.writeUnit;
  }

  /** The lines go to the database, each run of lines of one day as one write. */
  async function appendToDb(placeId: string | null, lines: Untyped, messages?: ReadonlyArray<RecordMessageRef>) {
    const write = seam.run(() => unitWriter());
    const partner = partnerOf(placeId);
    let written = 0;
    let duplicates = 0;
    const flush = async (owner: string | null, run: Untyped) => {
      if (!owner || run.length === 0) return;
      // The writer answers a lines unit with how many lines it wrote and how many it already held.
      const done = (await seam.run(() =>
        write({ op: 'lines', key: JSON.parse(owner) as StorageKey, lines: run, ...(messages ? { messages } : {}) })
      )) as StoredRecord | undefined;
      written += done?.written ?? 0;
      duplicates += done?.duplicates ?? 0;
    };
    let owner = null;
    let run = [];
    for (const raw of Array.isArray(lines) ? lines : []) {
      if (!raw || typeof raw !== 'object') continue;
      const line = stamped(raw, partner);
      const unit = keyText(placeOrPersona('record', placeId, { partition: String(line.occurredAt).slice(0, 10) }));
      if (unit !== owner) {
        await flush(owner, run);
        owner = unit;
        run = [];
      }
      run.push(line);
    }
    await flush(owner, run);
    return { written, duplicates };
  }

  async function append(
    placeId: string | null,
    lines: Array<Untyped>,
    { messages }: { messages?: ReadonlyArray<RecordMessageRef> } = {}
  ) {
    if (typeof writerGate === 'function') await writerGate();
    return serial(() => appendToDb(placeId, lines, messages));
  }

  async function* iterate(
    placeId: string | null,
    {
      from = null,
      to = null,
      placeIds: conversationIds = null,
    }: {
      from?: string | null;
      to?: string | null;
      placeIds?: Array<string> | null;
    } = {}
  ) {
    const db = seam.db();
    const fromMs = from ? Date.parse(from) : -Infinity;
    const toMs = to ? Date.parse(to) : Infinity;
    const fromDay = from ? dayOf(from) : '0000-00-00';
    const toDay = to ? dayOf(to) : '9999-99-99';
    const channels = Array.isArray(conversationIds) ? new Set(conversationIds) : null;
    for (const month of seam.run(() => recordMonths(db, placeId))) {
      if (!MONTH_RE.test(month) || month < fromDay.slice(0, 7) || month > toDay.slice(0, 7)) continue;
      for (const unit of seam.run(() => recordDays(db, placeId, month))) {
        const { day } = unit;
        if (day < fromDay || day > toDay) continue;
        for (const line of seam.run(() => recordLines(db, unit.owner))) {
          const value = parse(line);
          if (!value) continue;
          const at = Date.parse(value.occurredAt);
          if (isFiniteNumber(at) && (at < fromMs || at > toMs)) continue;
          if (channels && !channels.has(value.scope?.channel)) continue;
          yield value;
        }
      }
    }
  }

  function newestRevision(
    placeId: string,
    messageId: string,
    occurredAtIso: Untyped,
    { locator }: { locator?: NativeMessageLocator } = {}
  ) {
    return serial(async () => {
      const db = seam.db();
      return seam.run(() => recordNewestRevision(db, placeId, dayOf(occurredAtIso).slice(0, 7), messageId, locator));
    });
  }

  async function stats(placeId: string | null) {
    const db = seam.db();
    return seam.run(() => recordStats(db, placeId));
  }

  return { append, dayFile, iterate, newestRevision, stats };
}
