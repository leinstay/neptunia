// The record: what the app observed, kept for good. Hot memory forgets by design (caps,
// eviction); the record does not, so nothing the persona lived through is lost to eviction.
// One JSON line per observation, through the append store (src/memory/append-store.js), in a
// day file `data/guilds/<guildId>/record/<YYYY-MM>/<YYYY-MM-DD>.jsonl` by the UTC day of the
// line's `occurredAt`; a private chat's lines go under `private/<userId>/record/` instead and
// never into the guild record. Kinds:
//
//   - `seen`: a message the app observed (an edit is a new line with revision 2, 3, ...);
//   - `deleted`: Discord deleted a message (its stored text stays: not a forget request);
//   - `said`: the persona's own message, once its post succeeded;
//   - `felt`: the feeling she attached to a stored moment, with its own id.
//
// Only a whitelist of a message's fields enters a line (toRecordLine): ids, time, channel,
// author, reply target, text, media kinds (never a URL of a file), mentions, `direct`, and for a
// posted link with a preview the compact `links` (recordLinks: its URL, as posted in the text, with
// the preview's title, description and site, so a link post is found by what it shows). A per-month id
// index (`record/<YYYY-MM>/ids.json`, a sorted array of `messageId:revision` keys, held in
// memory per month and rebuilt from the segments when missing) refuses a line already
// recorded. `forgetUser` drops every line naming a member, under a forgetting marker; `iterate`
// hides such a member until the forget is done, and `append` waits while a writer lock is held
// (`writerGate`).
//
// Logs carry counts and ids of guilds, never a line's contents.

import * as nodeFs from 'node:fs/promises';
import path from 'node:path';
import { createHash, randomUUID } from 'node:crypto';
import { log as defaultLog } from '../log.js';
import { clampChars, clampWithEllipsis, oneLine } from './clamp.js';
import { memoryRootOf } from './root.js';
import { createReadSeam, hiddenIds } from './db/readers/common.js';
import { recordDays, recordLines, recordMonths, recordNewestRevision, recordStats } from './db/readers/record.js';

/** The schema version every line carries. */
export const RECORD_VERSION = 1;

const MONTH_RE = /^\d{4}-\d{2}$/;
const DAY_FILE_RE = /^(\d{4}-\d{2}-\d{2})\.jsonl$/;
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
  for (const item of [...(Array.isArray(slim.attachments) ? slim.attachments : []), ...(Array.isArray(slim.links) ? slim.links : [])]) {
    if (item && typeof item.kind === 'string' && item.kind) kinds.push(item.kind);
  }
  for (const sticker of Array.isArray(slim.stickers) ? slim.stickers : []) if (sticker) kinds.push('sticker');
  return kinds;
}

/**
 * The compact links of a record line, from a normalized message's links (interfaces/discord/collect.js:
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
export function toRecordLine(slim, { kind = 'seen', revision = 1, origin = 'live', now = Date.now, uuid = randomUUID, turnId = null, opId = null } = {}) {
  const source = slim && typeof slim === 'object' ? slim : {};
  const messageId = typeof source.id === 'string' && source.id ? source.id : null;
  const channelId = typeof source.channelId === 'string' && source.channelId ? source.channelId : null;
  const by = typeof source.authorId === 'string' && source.authorId ? source.authorId : null;
  const replyTo = typeof source.replyToId === 'string' && source.replyToId ? source.replyToId : null;
  const replyAuthor = replyTo && typeof source.replyToAuthorId === 'string' && source.replyToAuthorId ? source.replyToAuthorId : null;
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
    return { ...body, turnId: turnId ?? null, opId: opId ?? null, participants: idList(mentions, replyAuthor), ...tail };
  }
  return { ...body, direct: source.direct === true, participants: idList(by, mentions, replyAuthor), ...tail };
}

/**
 * The revision id of a feeling's text: `rv-` and the first 12 hex digits of its sha256.
 * @param {string} text
 * @returns {string}
 */
export function revisionOf(text) {
  return `rv-${createHash('sha256').update(String(text ?? ''), 'utf8').digest('hex').slice(0, 12)}`;
}

/**
 * A `felt` line: the feeling the persona attached to a stored moment of `userId`.
 * @param {{ userId: string, itemId?: string|null, text: string, date?: string|null,
 *   sourceMessageIds?: string[] }} feeling  `date`: the episode's date (a day or an ISO time).
 * @param {{ now?: () => number, uuid?: () => string, origin?: 'live'|'backfill' }} [options]
 * @returns {object}
 */
export function feltLine({ userId, itemId = null, text, date = null, sourceMessageIds = [] }, { now = Date.now, uuid = randomUUID, origin = 'live' } = {}) {
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
 * one is taken (a tool such as `tools/backfill.mjs links` appended revisions the caller's own
 * count does not know): on a duplicate the line is rebuilt with the record's newest revision of
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
export async function appendRevision(record, guildId, lineAt, revision, { log = defaultLog, privateUserId = null } = {}) {
  const opts = privateUserId ? { privateUserId } : undefined;
  let current = revision;
  let line = lineAt(current);
  let result = await record.append(guildId, [line], opts);
  let bumps = 0;
  while ((result?.duplicates ?? 0) > 0 && bumps < EDIT_REVISION_RETRIES) {
    bumps += 1;
    const known = typeof record.newestRevision === 'function' ? await record.newestRevision(guildId, line.messageId, line.occurredAt, { privateUserId }) : null;
    current = Math.max(current, Number.isInteger(known) ? known : current) + 1;
    line = lineAt(current);
    result = await record.append(guildId, [line], opts);
  }
  const written = result?.written ?? 0;
  if (bumps > 0) log.info('record: edit revision bumped', { guildId: String(guildId), bumps, written });
  return { revision: current, written, duplicates: result?.duplicates ?? 0, bumps };
}

/** The dedupe key of a line: `messageId:revision`, `messageId:deleted`, or null (a `felt` line). */
function keyOf(line) {
  if (typeof line?.messageId !== 'string' || !line.messageId) return null;
  if (line.kind === 'deleted') return `${line.messageId}:deleted`;
  return `${line.messageId}:${Number.isInteger(line.revision) && line.revision > 0 ? line.revision : 1}`;
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
 * Whether forgetting `userId` drops this record line: its `participants` or its `by` name them
 * and, with `before` (epoch ms, the deletion ledger's time), it happened earlier (a line without a
 * readable `occurredAt` counts as earlier). The one rule `forgetUser` and the store's vault pass
 * (src/memory/store.js#forgetUser) both apply.
 * @param {unknown} value  A parsed record line.
 * @param {string} userId
 * @param {number|null} [before]
 * @returns {boolean}
 */
export function recordDrops(value, userId, before = null) {
  const id = String(userId);
  const names = (Array.isArray(value?.participants) && value.participants.includes(id)) || value?.by === id;
  if (!names) return false;
  if (!Number.isFinite(before)) return true;
  return !(Date.parse(value.occurredAt) >= before);
}

/** The member ids under a forgetting marker of the guild (`data/guilds/<id>/forgetting/<userId>.json`). Shared with src/memory/archive.js. */
export async function forgettingIds(fs, dataDir, guildId) {
  try {
    return new Set(
      (await fs.readdir(memoryRootOf(dataDir).forgettingDir(guildId)))
        .filter((name) => name.endsWith('.json'))
        .map((name) => name.slice(0, -'.json'.length)),
    );
  } catch {
    return new Set();
  }
}

/**
 * The guild record's counts read from its files: `messages` (the distinct message ids its month id indexes hold; a
 * month without an index counts none), `days` (day files) and `first` (the earliest day, or null). What the status
 * card shows; src/ops/status.js falls back to it for a record without `stats`.
 * @param {object} fs  a `node:fs/promises`-shaped API
 * @param {string} base  the guild record's directory
 * @returns {Promise<{ messages: number, days: number, first: string|null }>}
 */
export async function recordFileStats(fs, base) {
  const list = async (dir) => {
    try {
      return (await fs.readdir(dir)).sort();
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return [];
      throw error;
    }
  };
  const ids = new Set();
  let days = 0;
  let first = null;
  for (const month of (await list(base)).filter((name) => MONTH_RE.test(name))) {
    for (const name of await list(path.join(base, month))) {
      const day = name.match(DAY_FILE_RE)?.[1];
      if (!day) continue;
      days += 1;
      if (first === null || day < first) first = day;
    }
    let keys = null;
    try {
      keys = JSON.parse(await fs.readFile(path.join(base, month, 'ids.json'), 'utf8'));
    } catch {
      // no index for the month yet: its messages are not counted
    }
    if (Array.isArray(keys)) {
      for (const key of keys) if (typeof key === 'string' && key.includes(':')) ids.add(key.slice(0, key.lastIndexOf(':')));
    }
  }
  return { messages: ids.size, days, first };
}

/**
 * Create the record.
 *
 * @param {object} options
 * @param {{ append: Function, iterate: Function, rewrite: Function }} options.appendStore  src/memory/append-store.js
 * @param {string} options.dataDir  the `data/` directory
 * @param {{ info: Function, warn: Function }} [options.log]
 * @param {() => number} [options.now=Date.now]
 * @param {() => string} [options.uuid=randomUUID]
 * @param {object} [options.fs]  a `node:fs/promises`-shaped API
 * @param {(() => Promise<void>)|null} [options.writerGate]  awaited before every append: the
 *   journal's `waitUnlocked`, so a forget's writer lock (src/memory/journal.js#withWriterLock)
 *   holds the record's appends too
 * @param {object|null} [options.memoryDb]  the memory database service (src/memory/db/service.js): under its
 *   authority `db` every read below is answered from the database (src/memory/db/readers/record.js), with no file
 *   fallback (a failed read rejects with a code); under `json` (the default) the files are read as always
 * @param {(() => string)|null} [options.authorityOf]  the authority, when not the service's own
 * @returns {{
 *   append(guildId: string, lines: object[], opts?: { privateUserId?: string|null }): Promise<{ written: number, duplicates: number }>,
 *   dayFile(guildId: string, occurredAtIso: string, privateUserId?: string|null): string,
 *   iterate(guildId: string, query?: { from?: string, to?: string, channelIds?: string[], privateUserId?: string|null }): AsyncIterable<object>,
 *   newestRevision(guildId: string, messageId: string, occurredAtIso: string, opts?: { privateUserId?: string|null }): Promise<number|null>,
 *   rebuildIndex(guildId: string, month: string, privateUserId?: string|null): Promise<number>,
 *   forgetUser(guildId: string, userId: string, opts?: { before?: number|null }): Promise<{ dropped: number }>,
 *   stats(guildId: string): Promise<{ messages: number, days: number, first: string|null }>,
 * }}
 *   `stats` counts the guild record (recordFileStats; from the database: the distinct message ids of its lines).
 *   `iterate` leaves out the lines naming a member under a forgetting marker (`recordDrops`),
 *   and yields nothing of such a member's private record. `forgetUser` with `before` (the
 *   deletion ledger re-applied, src/memory/store.js#applyLedger) writes no marker and drops only
 *   the lines that happened earlier, the member's private record rewritten the same way.
 *   `append` stamps `guildId` (and, with `privateUserId`, the private scope) on each line,
 *   refuses a line whose key the month's index already holds (`duplicates`), writes the rest
 *   to their day files and then the touched months' `ids.json`; it rejects when the append
 *   store refuses a line (the lines before it are written and indexed). `iterate` streams the
 *   parsed lines whose `occurredAt` lies in `[from, to]` (and whose channel is one of
 *   `channelIds` when given), day file by day file. `newestRevision` is the highest revision the
 *   id index of the month of `occurredAtIso` holds for the message (null when none; a `deleted`
 *   key does not count). `rebuildIndex` rewrites a month's
 *   `ids.json` from its segments and returns the number of keys. `forgetUser` writes the
 *   marker `data/guilds/<id>/forgetting/<userId>.json` first (unless one exists: then the
 *   caller owns it and it is left in place), rewrites every guild segment without the lines
 *   whose `participants` (or `by`) name the member, rebuilds the touched indexes, deletes the
 *   member's private record whole and removes the marker it wrote last; `dropped` counts the
 *   guild lines removed. Appends and forgets run one at a time.
 */
export function createRecord({ appendStore, dataDir, log = defaultLog, now = Date.now, uuid = randomUUID, fs = nodeFs, writerGate = null, memoryDb = null, authorityOf = null }) {
  const root = memoryRootOf(dataDir);
  const seam = createReadSeam({ memoryDb, authorityOf, log, reader: 'record' });
  const indexes = new Map(); // ids.json path -> Set of keys
  let chain = Promise.resolve();

  /** Run `task` after every append or forget already queued. */
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

  async function listDir(dir) {
    try {
      return (await fs.readdir(dir)).sort();
    } catch (error) {
      if (error?.code === 'ENOENT') return [];
      throw error;
    }
  }

  async function dayFiles(base, month) {
    const out = [];
    for (const name of await listDir(path.join(base, month))) {
      const match = name.match(DAY_FILE_RE);
      if (match) out.push({ day: match[1], file: path.join(base, month, name) });
    }
    return out;
  }

  async function writeIndex(file, keys) {
    await fs.mkdir(path.dirname(file), { recursive: true });
    const tmp = `${file}.tmp`;
    await fs.writeFile(tmp, JSON.stringify([...keys].sort()));
    await fs.rename(tmp, file);
  }

  /** The keys of every line in `month`'s segments under `base`. */
  async function scanMonth(base, month) {
    const keys = new Set();
    for (const { file } of await dayFiles(base, month)) {
      for await (const { line } of appendStore.iterate(file)) {
        const key = keyOf(parse(line));
        if (key) keys.add(key);
      }
    }
    return keys;
  }

  async function rebuild(base, month) {
    const keys = await scanMonth(base, month);
    const file = path.join(base, month, 'ids.json');
    await writeIndex(file, keys);
    indexes.set(file, keys);
    return keys.size;
  }

  /** The month's index, read from `ids.json` once, rebuilt from the segments when missing or unreadable. */
  async function loadIndex(base, month) {
    const file = path.join(base, month, 'ids.json');
    if (indexes.has(file)) return indexes.get(file);
    let keys = null;
    try {
      const value = JSON.parse(await fs.readFile(file, 'utf8'));
      if (Array.isArray(value)) keys = new Set(value.filter((key) => typeof key === 'string'));
    } catch (error) {
      if (error?.code !== 'ENOENT') log.warn('record: index unreadable', { month, code: error?.code ?? null });
    }
    if (!keys) {
      keys = await scanMonth(base, month);
      if (keys.size > 0) {
        await writeIndex(file, keys);
        log.info('record: index rebuilt', { month, keys: keys.size });
      }
    }
    indexes.set(file, keys);
    return keys;
  }

  async function append(guildId, lines, { privateUserId = null } = {}) {
    // Outside the chain: a forget queued behind a held append would wait for itself.
    if (typeof writerGate === 'function') await writerGate();
    return serial(async () => {
      const base = baseDir(guildId, privateUserId);
      const isPrivate = typeof privateUserId === 'string' && privateUserId;
      const touched = new Map(); // ids.json path -> keys
      let written = 0;
      let duplicates = 0;
      try {
        for (const raw of Array.isArray(lines) ? lines : []) {
          if (!raw || typeof raw !== 'object') continue;
          const line = { ...raw, guildId: String(guildId) };
          line.occurredAt = isoOf(line.occurredAt) ?? new Date(now()).toISOString();
          if (isPrivate) {
            const channel = typeof raw.scope?.channel === 'string' ? raw.scope.channel : null;
            line.scope = { user: privateUserId, private: true, ...(channel ? { channel } : {}) };
          }
          const month = dayOf(line.occurredAt).slice(0, 7);
          const key = keyOf(line);
          let keys = null;
          if (key) {
            keys = await loadIndex(base, month);
            if (keys.has(key)) {
              duplicates += 1;
              continue;
            }
          }
          await appendStore.append(dayFile(guildId, line.occurredAt, privateUserId), JSON.stringify(line));
          written += 1;
          if (key) {
            keys.add(key);
            touched.set(path.join(base, month, 'ids.json'), keys);
          }
        }
      } finally {
        for (const [file, keys] of touched) {
          await writeIndex(file, keys).catch((error) => log.warn('record: index write failed', { code: error?.code ?? null, guildId: String(guildId) }));
        }
      }
      return { written, duplicates };
    });
  }

  /** The members under a forgetting marker: the marker files, or the database's markers under `db`. */
  async function hiddenOf(guildId, db) {
    if (!db) return forgettingIds(fs, dataDir, guildId);
    return seam.run(() => hiddenIds(db, guildId));
  }

  /** The lines (text) of one day: the day file's, or the database's unit under `db`. */
  async function* dayLines(db, unit) {
    if (db) {
      for (const line of seam.run(() => recordLines(db, unit.owner))) yield line;
      return;
    }
    for await (const { line } of appendStore.iterate(unit.file)) yield line;
  }

  async function* iterate(guildId, { from = null, to = null, channelIds = null, privateUserId = null } = {}) {
    const db = seam.db();
    const base = baseDir(guildId, privateUserId);
    const fromMs = from ? Date.parse(from) : -Infinity;
    const toMs = to ? Date.parse(to) : Infinity;
    const fromDay = from ? dayOf(from) : '0000-00-00';
    const toDay = to ? dayOf(to) : '9999-99-99';
    const channels = Array.isArray(channelIds) ? new Set(channelIds) : null;
    // A member being forgotten is hidden until the forget is done.
    const hidden = await hiddenOf(guildId, db);
    if (typeof privateUserId === 'string' && hidden.has(privateUserId)) return;
    const months = db ? seam.run(() => recordMonths(db, guildId, privateUserId)) : await listDir(base);
    for (const month of months) {
      if (!MONTH_RE.test(month) || month < fromDay.slice(0, 7) || month > toDay.slice(0, 7)) continue;
      const days = db ? seam.run(() => recordDays(db, guildId, privateUserId, month)) : await dayFiles(base, month);
      for (const unit of days) {
        const { day } = unit;
        if (day < fromDay || day > toDay) continue;
        for await (const line of dayLines(db, unit)) {
          const value = parse(line);
          if (!value) continue;
          const at = Date.parse(value.occurredAt);
          if (Number.isFinite(at) && (at < fromMs || at > toMs)) continue;
          if (channels && !channels.has(value.scope?.channel)) continue;
          if (hidden.size > 0 && [...hidden].some((id) => recordDrops(value, id))) continue;
          yield value;
        }
      }
    }
  }

  /**
   * The deletion ledger re-applied (`forgetUser` with `before`): every guild line naming the member
   * that happened before `before` goes, and every earlier line of their private record; no marker.
   */
  async function forgetEarlier(guildId, id, before) {
    const keep = (line) => {
      const value = parse(line);
      return !value || !recordDrops(value, id, before);
    };
    const earlier = (line) => {
      const value = parse(line);
      return Boolean(value) && !(Date.parse(value.occurredAt) >= before);
    };
    let dropped = 0;
    for (const [base, test] of [[baseDir(guildId), keep], [baseDir(guildId, id), (line) => !earlier(line)]]) {
      for (const month of await listDir(base)) {
        if (!MONTH_RE.test(month)) continue;
        let monthDropped = 0;
        for (const { file } of await dayFiles(base, month)) monthDropped += (await appendStore.rewrite(file, test)).dropped;
        if (monthDropped > 0) await rebuild(base, month);
        dropped += monthDropped;
      }
    }
    if (dropped > 0) log.info('record: forgotten', { guildId: String(guildId), dropped });
    return { dropped };
  }

  function newestRevision(guildId, messageId, occurredAtIso, { privateUserId = null } = {}) {
    return serial(async () => {
      const db = seam.db();
      if (db) return seam.run(() => recordNewestRevision(db, guildId, privateUserId, dayOf(occurredAtIso).slice(0, 7), messageId));
      const keys = await loadIndex(baseDir(guildId, privateUserId), dayOf(occurredAtIso).slice(0, 7));
      const prefix = `${messageId}:`;
      let newest = null;
      for (const key of keys) {
        if (!key.startsWith(prefix)) continue;
        const n = Number(key.slice(prefix.length));
        if (Number.isInteger(n) && n > (newest ?? 0)) newest = n;
      }
      return newest;
    });
  }

  function rebuildIndex(guildId, month, privateUserId = null) {
    return serial(() => rebuild(baseDir(guildId, privateUserId), month));
  }

  function forgetUser(guildId, userId, { before = null } = {}) {
    if (Number.isFinite(before)) return serial(() => forgetEarlier(guildId, String(userId), before));
    return serial(async () => {
      const id = String(userId);
      const marker = path.join(root.forgettingDir(guildId), `${id}.json`);
      let created = false;
      try {
        await fs.stat(marker);
      } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
        await fs.mkdir(path.dirname(marker), { recursive: true });
        await fs.writeFile(marker, JSON.stringify({ userId: id, at: new Date(now()).toISOString(), step: 'record' }));
        created = true;
      }
      const keep = (line) => {
        const value = parse(line);
        return !value || !recordDrops(value, id);
      };
      const base = baseDir(guildId);
      let dropped = 0;
      for (const month of await listDir(base)) {
        if (!MONTH_RE.test(month)) continue;
        let monthDropped = 0;
        for (const { file } of await dayFiles(base, month)) {
          monthDropped += (await appendStore.rewrite(file, keep)).dropped;
        }
        if (monthDropped > 0) await rebuild(base, month);
        dropped += monthDropped;
      }
      // The private record goes whole; each of its files is emptied through the append store
      // first, so its descriptor is closed and no queued line lands after the delete.
      const privateBase = baseDir(guildId, id);
      for (const month of await listDir(privateBase)) {
        if (!MONTH_RE.test(month)) continue;
        for (const { file } of await dayFiles(privateBase, month)) await appendStore.rewrite(file, () => false);
      }
      await fs.rm(privateBase, { recursive: true, force: true });
      for (const file of [...indexes.keys()]) if (file.startsWith(privateBase + path.sep)) indexes.delete(file);
      if (created) await fs.rm(marker, { force: true });
      log.info('record: forgotten', { guildId: String(guildId), dropped });
      return { dropped };
    });
  }

  async function stats(guildId) {
    const db = seam.db();
    if (db) return seam.run(() => recordStats(db, guildId));
    return recordFileStats(fs, baseDir(guildId));
  }

  return { append, dayFile, iterate, newestRevision, rebuildIndex, forgetUser, stats };
}
