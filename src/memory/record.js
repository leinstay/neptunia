// The record: what the app observed, kept for good. Hot memory forgets by design (caps,
// eviction); the record does not, so nothing the persona lived through is lost to eviction.
// One line per observation in the memory database (src/memory/db/service.js), in the unit of its
// day, `guilds/<guildId>/record/<YYYY-MM>/<YYYY-MM-DD>.jsonl` (`dayFile`, relative to the data
// directory: the unit's name, no file), by the UTC day of the line's `occurredAt`; a private
// chat's lines go under `private/<userId>/record/` instead and never into the guild record. Kinds:
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
// read is answered from the database (src/memory/db/readers/record.js); a closed database is an
// error with a code (`DB_CLOSED`), never an empty answer.
//
// Logs carry counts and ids of guilds, never a line's contents.

import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { log as defaultLog } from '../log.js';
import { clampChars, clampWithEllipsis, oneLine } from './clamp.js';
import { memoryRootOf } from './root.js';
import { createReadSeam } from './db/readers/common.js';
import { recordDays, recordLines, recordMonths, recordNewestRevision, recordStats } from './db/readers/record.js';

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
function idList(...values) {
  const out = [];
  for (const value of values) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item === 'string' && item && !out.includes(item)) out.push(item);
    }
  }
  return out;
}

/**
 * An epoch-ms or ISO time (a bare `YYYY-MM-DD` is that day's midnight UTC) as an ISO string, else
 * null. Shared with src/memory/archive.js.
 * @param {unknown} value
 * @returns {string|null}
 */
export function isoOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return new Date(value).toISOString();
  if (typeof value === 'string' && value) {
    if (DATE_ONLY_RE.test(value)) return `${value}T00:00:00.000Z`;
    const ms = Date.parse(value);
    return Number.isFinite(ms) ? new Date(ms).toISOString() : null;
  }
  return null;
}

/** The media kinds of a slim message: attachments, links, then one `sticker` per sticker. */
function mediaKinds(slim) {
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
 * The compact links of a record line, from a normalized message's links (src/protocol/events.js#Message:
 * `{ id, kind, url, title, text, site }`) or from links already in this shape (`description`
 * instead of `text`): each `{ id?, url, title, description, site }` on one line, the title and the
 * description clamped to LINK_TEXT_CHARS at a boundary (clampWithEllipsis). Only a link (`kind`
 * `link`, or no kind: never a GIF, whose URL leaves the text) with a title or a description is
 * kept, at most RECORD_LINKS_MAX, in order. `id` is the link's media-cache key, when it has one.
 * Pure.
 * @param {unknown} items
 * @returns {{ id?: string, url: string, title: string, description: string, site: string }[]}
 */
export function recordLinks(items) {
  const out = [];
  const str = (value) => (typeof value === 'string' ? oneLine(value) : '');
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
 * One record line from a slim message (src/memory/update.js#slimMessage; `mentionedUserIds`
 * and `replyToAuthorId` are read when the slim has them). Only the whitelisted fields are
 * copied: `messageId`, `revision`, `occurredAt` (the slim's `ts`), the channel (as `scope`),
 * `by`, `replyTo`, `text`, `media` (kinds only), `links` (recordLinks of the slim's `linkCards`,
 * only when there are some: a line without the key has no link preview), `mentions`, `direct`;
 * `participants` = the author, the mentioned members and the reply target's author when known. A `said` line names
 * no author (it is the persona's) and carries `turnId` / `opId`; a `deleted` line keeps only
 * the message id and its author as a participant. `guildId` is stamped on append.
 *
 * @param {object} slim
 * @param {{ kind?: 'seen'|'said'|'deleted', revision?: number, origin?: 'live'|'backfill',
 *   now?: () => number, uuid?: () => string, turnId?: string|null, opId?: string|null }} [options]
 * @returns {object}
 */
export function toRecordLine(
  slim,
  { kind = 'seen', revision = 1, origin = 'live', now = Date.now, uuid = randomUUID, turnId = null, opId = null } = {}
) {
  const source = slim && typeof slim === 'object' ? slim : {};
  const messageId = typeof source.id === 'string' && source.id ? source.id : null;
  const channelId = typeof source.channelId === 'string' && source.channelId ? source.channelId : null;
  const by = typeof source.authorId === 'string' && source.authorId ? source.authorId : null;
  const replyTo = typeof source.replyToId === 'string' && source.replyToId ? source.replyToId : null;
  const replyAuthor =
    replyTo && typeof source.replyToAuthorId === 'string' && source.replyToAuthorId ? source.replyToAuthorId : null;
  const mentions = idList(source.mentionedUserIds ?? source.mentions);
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
    guildId: null,
    scope: channelId ? { channel: channelId } : { guild: true },
  };
  const tail = { sourceMessageIds: idList(messageId), origin: origin === 'backfill' ? 'backfill' : 'live' };
  if (kind === 'deleted') return { ...head, ...envelope, participants: idList(by), ...tail };
  const rev = Number.isInteger(revision) && revision > 0 ? revision : 1;
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
 * @param {string} text
 * @returns {string}
 */
export function revisionOf(text) {
  return `rv-${createHash('sha256')
    .update(String(text ?? ''), 'utf8')
    .digest('hex')
    .slice(0, 12)}`;
}

/**
 * A `felt` line: the feeling the persona attached to a stored moment of `userId`.
 * @param {{ userId: string, itemId?: string|null, text: string, date?: string|null,
 *   sourceMessageIds?: string[] }} feeling  `date`: the episode's date (a day or an ISO time).
 * @param {{ now?: () => number, uuid?: () => string, origin?: 'live'|'backfill' }} [options]
 * @returns {object}
 */
export function feltLine(
  { userId, itemId = null, text, date = null, sourceMessageIds = [] },
  { now = Date.now, uuid = randomUUID, origin = 'live' } = {}
) {
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
    guildId: null,
    scope: { user: String(userId) },
    text: String(text ?? ''),
    participants: idList(String(userId)),
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
 * @param {{ append: Function, newestRevision?: Function }} record  From createRecord.
 * @param {string} guildId
 * @param {(revision: number) => object} lineAt  The line at a revision (toRecordLine).
 * @param {number} revision  The revision to try first.
 * @param {{ log?: { info: Function }, privateUserId?: string|null }} [options]
 * @returns {Promise<{ revision: number, written: number, duplicates: number, bumps: number }>}
 */
export async function appendRevision(
  record,
  guildId,
  lineAt,
  revision,
  { log = defaultLog, privateUserId = null } = {}
) {
  const opts = privateUserId ? { privateUserId } : undefined;
  let current = revision;
  let line = lineAt(current);
  let result = await record.append(guildId, [line], opts);
  let bumps = 0;
  while ((result?.duplicates ?? 0) > 0 && bumps < EDIT_REVISION_RETRIES) {
    bumps += 1;
    const known =
      typeof record.newestRevision === 'function'
        ? await record.newestRevision(guildId, line.messageId, line.occurredAt, { privateUserId })
        : null;
    current = Math.max(current, Number.isInteger(known) ? known : current) + 1;
    line = lineAt(current);
    result = await record.append(guildId, [line], opts);
  }
  const written = result?.written ?? 0;
  if (bumps > 0) log.info('record: edit revision bumped', { guildId: String(guildId), bumps, written });
  return { revision: current, written, duplicates: result?.duplicates ?? 0, bumps };
}

/** The parsed line, or null. */
function parse(line) {
  try {
    const value = JSON.parse(line);
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

/**
 * Create the record.
 *
 * @param {object} options
 * @param {string} options.dataDir  the `data/` directory (the units' names are relative to it)
 * @param {{ info: Function, warn: Function }} [options.log]
 * @param {() => number} [options.now=Date.now]
 * @param {(() => Promise<void>)|null} [options.writerGate]  awaited before every append: the
 *   journal's `waitUnlocked`, so its writer lock (src/memory/journal.js#withWriterLock) holds the
 *   record's appends too
 * @param {object|null} options.memoryDb  the memory database service (src/memory/db/service.js): every
 *   read is answered from it (src/memory/db/readers/record.js) and `append` writes it (`writeUnit`); a
 *   failed read or write rejects with a code
 * @returns {{
 *   append(guildId: string, lines: object[], opts?: { privateUserId?: string|null }): Promise<{ written: number, duplicates: number }>,
 *   dayFile(guildId: string, occurredAtIso: string, privateUserId?: string|null): string,
 *   iterate(guildId: string, query?: { from?: string, to?: string, channelIds?: string[], privateUserId?: string|null }): AsyncIterable<object>,
 *   newestRevision(guildId: string, messageId: string, occurredAtIso: string, opts?: { privateUserId?: string|null }): Promise<number|null>,
 *   stats(guildId: string): Promise<{ messages: number, days: number, first: string|null }>,
 * }}
 *   `stats` counts the guild record (the distinct message ids of its lines). `append` stamps
 *   `guildId` (and, with `privateUserId`, the private scope) on each line, one write per run of
 *   lines of one day; a line the month already holds is a duplicate (`duplicates`). `iterate` streams
 *   the parsed lines whose `occurredAt` lies in `[from, to]` (and whose channel is one of `channelIds`
 *   when given), day by day. `newestRevision` is the highest revision the month of `occurredAtIso`
 *   holds for the message (null when none; a `deleted` line does not count). Appends run one at a time.
 *   `dayFile` is the absolute path a day's unit is named after (no file is written there).
 */
export function createRecord({ dataDir, log = defaultLog, now = Date.now, writerGate = null, memoryDb = null }) {
  const root = memoryRootOf(dataDir);
  const seam = createReadSeam({ memoryDb, log, reader: 'record' });
  let chain = Promise.resolve();

  /** Run `task` after every append already queued. */
  function serial(task) {
    const run = chain.then(task);
    chain = run.catch(() => {});
    return run;
  }

  function baseDir(guildId, privateUserId = null) {
    return root.recordDir(guildId, privateUserId);
  }

  function dayOf(iso) {
    return String(iso ?? '').match(DAY_RE)?.[0] ?? new Date(now()).toISOString().slice(0, 10);
  }

  function dayFile(guildId, occurredAtIso, privateUserId = null) {
    const day = dayOf(occurredAtIso);
    return path.join(baseDir(guildId, privateUserId), day.slice(0, 7), `${day}.jsonl`);
  }

  /** A line as `append` stores it: `guildId` stamped, `occurredAt` as ISO, a private line's scope. */
  function stamped(guildId, raw, privateUserId) {
    const line = { ...raw, guildId: String(guildId) };
    line.occurredAt = isoOf(line.occurredAt) ?? new Date(now()).toISOString();
    if (typeof privateUserId === 'string' && privateUserId) {
      const channel = typeof raw.scope?.channel === 'string' ? raw.scope.channel : null;
      line.scope = { user: privateUserId, private: true, ...(channel ? { channel } : {}) };
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
  async function appendToDb(guildId, lines, privateUserId) {
    const write = seam.run(() => unitWriter());
    let written = 0;
    let duplicates = 0;
    const flush = async (owner, run) => {
      if (run.length === 0) return;
      const done = await seam.run(() => write({ op: 'lines', owner, lines: run }));
      written += done?.written ?? 0;
      duplicates += done?.duplicates ?? 0;
    };
    let owner = null;
    let run = [];
    for (const raw of Array.isArray(lines) ? lines : []) {
      if (!raw || typeof raw !== 'object') continue;
      const line = stamped(guildId, raw, privateUserId);
      const unit = root.relative(dayFile(guildId, line.occurredAt, privateUserId));
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

  async function append(guildId, lines, { privateUserId = null } = {}) {
    if (typeof writerGate === 'function') await writerGate();
    return serial(() => appendToDb(guildId, lines, privateUserId));
  }

  async function* iterate(guildId, { from = null, to = null, channelIds = null, privateUserId = null } = {}) {
    const db = seam.db();
    const fromMs = from ? Date.parse(from) : -Infinity;
    const toMs = to ? Date.parse(to) : Infinity;
    const fromDay = from ? dayOf(from) : '0000-00-00';
    const toDay = to ? dayOf(to) : '9999-99-99';
    const channels = Array.isArray(channelIds) ? new Set(channelIds) : null;
    for (const month of seam.run(() => recordMonths(db, guildId, privateUserId))) {
      if (!MONTH_RE.test(month) || month < fromDay.slice(0, 7) || month > toDay.slice(0, 7)) continue;
      for (const unit of seam.run(() => recordDays(db, guildId, privateUserId, month))) {
        const { day } = unit;
        if (day < fromDay || day > toDay) continue;
        for (const line of seam.run(() => recordLines(db, unit.owner))) {
          const value = parse(line);
          if (!value) continue;
          const at = Date.parse(value.occurredAt);
          if (Number.isFinite(at) && (at < fromMs || at > toMs)) continue;
          if (channels && !channels.has(value.scope?.channel)) continue;
          yield value;
        }
      }
    }
  }

  function newestRevision(guildId, messageId, occurredAtIso, { privateUserId = null } = {}) {
    return serial(async () => {
      const db = seam.db();
      return seam.run(() =>
        recordNewestRevision(db, guildId, privateUserId, dayOf(occurredAtIso).slice(0, 7), messageId)
      );
    });
  }

  async function stats(guildId) {
    const db = seam.db();
    return seam.run(() => recordStats(db, guildId));
  }

  return { append, dayFile, iterate, newestRevision, stats };
}
