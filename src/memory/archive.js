// The archive: every memory item that leaves a hot list, kept for good. Hot memory forgets by
// design (caps, expiry, the analyzer's removes and replaces); before an item leaves, its last
// version is written here, so nothing the persona once held is lost to a cap. One line per event
// in the memory database (src/memory/db/service.js), in the unit of its month,
// `guilds/<guildId>/archive/<YYYY-MM>.jsonl` by the entry's `recordedAt`; a private layer's
// items go under `private/<userId>/archive/` instead and never into the guild archive.
//
// An entry carries three ids: `itemId` (the item's stable identity, src/memory/store.js stamps it
// on write), `revisionId` (a hash of the item's text, so two versions of one item tell apart) and
// `id` (the event). `text` holds the item's text fields verbatim but for their links (never stored
// in memory, src/memory/clamp.js#stripUrls), `stored` its other stored fields
// (dates, counts, ids), so an owner restore rebuilds it as it was. `sourceRefs` lists the messages
// the item came from only when the item names them; it is never guessed.
//
// A month's `itemId:revisionId` keys (read from the database once per month, then kept) refuse an
// entry already archived; a `restored` line is a lifecycle event and is never refused. Entries the
// archive could not take wait in the operational file `archive/pending.jsonl` (through the append
// store, src/memory/append-store.js); `drainPending` writes them and notes each one in
// `archive/pending-done.jsonl`, then compacts both files. The writers wait while a writer lock is
// held (`writerGate`).
//
// Logs carry counts and guild ids, never an entry's text.

import * as nodeFs from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { isPlainObject } from '../config.js';
import { log as defaultLog } from '../log.js';
import { stripUrls } from './clamp.js';
import { TEACHER_TOKEN_RE, tokenIds } from './mentions.ts';
import { isoOf, revisionOf } from './record.js';
import { memoryRootOf } from './root.js';
import { createReadSeam } from './db/readers/common.js';
import { archiveLayers, archiveLines, archiveMonths } from './db/readers/archive.js';

/** The schema version every entry carries. */
export const ARCHIVE_VERSION = 1;

/**
 * The prefix of an item's `itemId` by kind: the stable identity a stored memory item gets on its
 * first write (`ep-` + a UUID, ...) and keeps, so whatever later leaves the hot files can be told
 * apart and found again. The field is optional: an item written before it existed loads without
 * one and gets it on its next write; no reader requires it. Self facts and in-jokes are stored as
 * plain strings, so they carry no id while stored: the id is minted when one leaves the list.
 * The keys are the archive's item kinds.
 */
export const ITEM_ID_PREFIX = Object.freeze({
  episode: 'ep-',
  lesson: 'ln-',
  interest: 'in-',
  detail: 'dt-',
  alias: 'al-',
  realName: 'rn-',
  selfFact: 'sf-',
  move: 'mv-',
  recent: 'rc-',
  participation: 'pt-',
  diary: 'dy-',
  injoke: 'ij-',
  version: 'vs-',
});

/** The events an entry may record. */
export const ARCHIVE_EVENTS = Object.freeze([
  'evicted',
  'expired',
  'replaced',
  'merged',
  'set-aside',
  'restored',
  'backfill',
]);

/** The text fields of each kind: what `text` holds verbatim and the revision hashes. */
const TEXT_FIELDS = Object.freeze({
  episode: ['what', 'quote', 'feeling'],
  lesson: ['text'],
  interest: ['topic', 'note'],
  detail: ['text'],
  alias: ['name'],
  realName: ['name'],
  selfFact: ['text'],
  move: ['reason'],
  recent: ['text'],
  participation: ['messages'],
  diary: ['gist', 'search'],
  injoke: ['text'],
  version: ['text'],
});

/** The item kinds, in a stable order (the `kind` choices of `/nep memory archive`). */
export const ARCHIVE_KINDS = Object.freeze(Object.keys(TEXT_FIELDS));

/** The item's own time, newest first among the fields that hold one. */
const TIME_FIELDS = ['firstSeen', 'ts', 'at', 'startAt', 'addedAt'];
/** The item's last sighting. */
const LAST_SEEN_FIELDS = ['lastSeen', 'lastAt', 'addedAt'];
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
const MONTH_RE = /^\d{4}-\d{2}$/;

/** Distinct non-empty strings of `values` (arrays or single values), in order. */
function idList(...values) {
  const out = [];
  for (const value of values) {
    for (const item of Array.isArray(value) ? value : [value]) {
      if (typeof item === 'string' && item && !out.includes(item)) out.push(item);
    }
  }
  return out;
}

/** A plain-string item (a self fact, an in-joke) as `{ text }`; an object as it is; else `{}`. */
function itemValue(item) {
  if (typeof item === 'string') return { text: item };
  return isPlainObject(item) ? item : {};
}

/**
 * The text fields of `item` for `itemKind`, verbatim (strings, and a participation episode's
 * messages copied whole); a field the item does not hold is left out.
 * @param {string} itemKind  One of `ARCHIVE_KINDS`.
 * @param {unknown} item
 * @returns {object}
 */
export function archiveText(itemKind, item) {
  const value = itemValue(item);
  const text = {};
  for (const field of TEXT_FIELDS[itemKind] ?? []) {
    if (typeof value[field] === 'string') text[field] = value[field];
    else if (Array.isArray(value[field])) text[field] = structuredClone(value[field]);
  }
  return text;
}

/** `archiveText` as an entry stores it: every string field without its links
 * (src/memory/clamp.js#stripUrls); a participation episode's messages stay whole. */
function storedText(itemKind, item) {
  const text = archiveText(itemKind, item);
  for (const [field, value] of Object.entries(text)) {
    if (typeof value === 'string') text[field] = stripUrls(value);
  }
  return text;
}

/**
 * The revision id of `item`'s content: `rv-` and 12 hex digits of the sha256 of its text fields
 * as an entry stores them (src/memory/record.js#revisionOf over `archiveText`, links taken out).
 * Two items with the same text share it, whatever their weights or dates.
 * @param {string} itemKind
 * @param {unknown} item
 * @returns {string}
 */
export function archiveRevision(itemKind, item) {
  return revisionOf(JSON.stringify(storedText(itemKind, item)));
}

/** The item's own time: a stored day (`day`), else the first time field it holds (`time`), else `approx` today. */
function observedAtOf(value, recordedAt) {
  if (typeof value.date === 'string' && DAY_RE.test(value.date)) return { date: value.date, precision: 'day' };
  for (const field of TIME_FIELDS) {
    const iso = isoOf(value[field]);
    if (iso) return { date: iso, precision: 'time' };
  }
  return { date: recordedAt.slice(0, 10), precision: 'approx' };
}

/** The messages an item names itself, as `{ channelId?, messageId, revision? }`; [] when none. */
function sourceRefsOf(value, given) {
  const clean = (ref) => {
    if (!isPlainObject(ref) || typeof ref.messageId !== 'string' || !ref.messageId) return null;
    return {
      ...(typeof ref.channelId === 'string' && ref.channelId ? { channelId: ref.channelId } : {}),
      messageId: ref.messageId,
      ...(Number.isInteger(ref.revision) && ref.revision > 0 ? { revision: ref.revision } : {}),
    };
  };
  const explicit = Array.isArray(given) ? given : Array.isArray(value.sourceRefs) ? value.sourceRefs : null;
  if (explicit) return explicit.map(clean).filter(Boolean);
  const channelId = typeof value.channelId === 'string' && value.channelId ? value.channelId : null;
  const ids = Array.isArray(value.messages)
    ? value.messages.map((message) => (isPlainObject(message) ? message.id : null))
    : Array.isArray(value.sourceMessageIds)
      ? value.sourceMessageIds
      : [];
  return idList(ids).map((messageId) => (channelId ? { channelId, messageId } : { messageId }));
}

/** The members an item concerns: the scope's member, `given`, ids named in its text, its teacher, the authors of its messages. */
function participantsOf(value, text, scope, given) {
  const named = [];
  for (const field of Object.values(text)) if (typeof field === 'string') named.push(...tokenIds(field));
  const teacher = typeof value.from === 'string' ? (value.from.match(TEACHER_TOKEN_RE)?.[1] ?? null) : null;
  const authors = Array.isArray(value.messages)
    ? value.messages
        .filter((message) => isPlainObject(message) && message.self !== true)
        .map((message) => message.authorId)
    : [];
  return idList(scope?.user, given, Array.isArray(value.who) ? value.who : [], named, teacher, authors, value.userId);
}

/**
 * One archive entry for `item` (a stored item, or a plain string for a self fact or an in-joke).
 * Pure apart from `now` and `uuid`. `itemId` is the item's own (a string item, or an object
 * without one, gets `ITEM_ID_PREFIX[itemKind]` + `uuid()`), `revisionId` hashes its text fields,
 * `id` is `uuid()`. `text` holds the text fields verbatim but for their links (`storedText`); `stored` the item's other fields
 * (without `itemId` and `weight`); `observedAt` the item's own time with its precision (`day`,
 * `time`, or `approx`: today, when the item holds none); `lastSeen` its last sighting or null;
 * `sourceRefs` the messages it names itself (`sourceRefs` given, else its own `sourceRefs`, its
 * messages' ids, its `sourceMessageIds`), else []: never guessed. `participants`: the scope's
 * member, `participants` given, the `<@id>` tokens of its text, its teacher and the other authors
 * of its messages. `guildId` is stamped on append.
 *
 * @param {unknown} item
 * @param {{ itemKind: string, event: string, scope?: object, origin?: 'live'|'backfill', by?: string,
 *   now?: () => number, sourceRefs?: object[], neutral?: string|null, uuid?: () => string,
 *   participants?: string[] }} options
 * @returns {object}
 * @throws {TypeError} An unknown `itemKind` or `event`.
 */
export function archiveEntry(
  item,
  {
    itemKind,
    event,
    scope = { guild: true },
    origin = 'live',
    by = 'store',
    now = Date.now,
    sourceRefs,
    neutral = null,
    uuid = randomUUID,
    participants = [],
  } = {}
) {
  if (!TEXT_FIELDS[itemKind]) throw new TypeError(`archiveEntry: unknown item kind ${itemKind}`);
  if (!ARCHIVE_EVENTS.includes(event)) throw new TypeError(`archiveEntry: unknown event ${event}`);
  const value = itemValue(item);
  const text = storedText(itemKind, value);
  const recordedAt = new Date(now()).toISOString();
  const textFields = new Set(TEXT_FIELDS[itemKind]);
  const stored = {};
  for (const [key, field] of Object.entries(value)) {
    if (textFields.has(key) || key === 'itemId' || key === 'weight') continue;
    stored[key] = structuredClone(field);
  }
  const lastSeen = LAST_SEEN_FIELDS.map((field) => isoOf(value[field])).find(Boolean) ?? null;
  const entryScope = isPlainObject(scope) ? { ...scope } : { guild: true };
  const id = uuid();
  return {
    v: ARCHIVE_VERSION,
    id,
    kind: 'archive',
    event,
    itemKind,
    itemId: typeof value.itemId === 'string' && value.itemId ? value.itemId : `${ITEM_ID_PREFIX[itemKind]}${uuid()}`,
    revisionId: revisionOf(JSON.stringify(text)),
    scope: entryScope,
    participants: participantsOf(value, text, entryScope, participants),
    observedAt: observedAtOf(value, recordedAt),
    lastSeen,
    sourceRefs: sourceRefsOf(value, sourceRefs),
    neutral: typeof neutral === 'string' && neutral ? neutral : null,
    text,
    ...(typeof value.weight === 'number' && Number.isFinite(value.weight) ? { weight: value.weight } : {}),
    stored,
    origin: origin === 'backfill' ? 'backfill' : 'live',
    by: typeof by === 'string' && by ? by : 'store',
    occurredAt: recordedAt,
    recordedAt,
    guildId: null,
  };
}

/** The dedupe key of an entry: `itemId:revisionId`; a `restored` event (a lifecycle line) has none. */
function keyOf(entry) {
  if (!isPlainObject(entry) || entry.event === 'restored') return null;
  if (typeof entry.itemId !== 'string' || !entry.itemId || typeof entry.revisionId !== 'string') return null;
  return `${entry.itemId}:${entry.revisionId}`;
}

/** The parsed line, or null. */
function parse(line) {
  try {
    const value = JSON.parse(line);
    return isPlainObject(value) ? value : null;
  } catch {
    return null;
  }
}

/**
 * Create the archive.
 *
 * @param {object} options
 * @param {{ append: Function, iterate: Function, rewrite: Function, stats?: Function }} options.appendStore
 *   src/memory/append-store.js, for the pending queue's files; best its own, so its counts speak for the archive alone.
 * @param {string} options.dataDir  the `data/` directory
 * @param {{ info: Function, warn: Function }} [options.log]
 * @param {() => number} [options.now=Date.now]
 * @param {object} [options.fs]  a `node:fs/promises`-shaped API (the pending queue's directories)
 * @param {(() => Promise<void>)|null} [options.writerGate]  awaited before every append, queue and
 *   drain: the journal's `waitUnlocked`, so its writer lock (src/memory/journal.js#withWriterLock)
 *   holds the archive's writers too
 * @param {object|null} options.memoryDb  the memory database service (src/memory/db/service.js): `iterate` and
 *   `find` are answered from it (src/memory/db/readers/archive.js), a failed read rejects with a code; `append`
 *   writes the entries it does not refuse as lines of the month's unit (`memoryDb.writeUnit`, op `lines`), and a
 *   failed write rejects as a failed append does (the store then queues the entries in the pending file and the
 *   drain writes them through `append` again)
 * @returns {{
 *   append(guildId: string, entries: object[], opts?: { privateUserId?: string|null }): Promise<{ written: number, duplicates: number }>,
 *   iterate(guildId: string, query?: { from?: string, to?: string, scope?: object, kinds?: string[], privateUserId?: string|null }): AsyncIterable<object>,
 *   find(guildId: string, itemId: string): Promise<object[]>,
 *   queuePending(guildId: string, entries: object[], opts?: { privateUserId?: string|null }): Promise<number>,
 *   drainPending(guildId: string): Promise<{ archived: number, left: number, confirmed: object[] }>,
 *   stats(guildId: string): { pending: number },
 * }}
 *   `append` stamps `guildId` (and, with `privateUserId`, the private scope `{ user, private: true }`)
 *   on each entry and refuses an entry whose key the month already holds (`duplicates`). `iterate` streams
 *   the entries whose `recordedAt` lies in `[from, to]`, of `kinds` and matching every key of `scope` when
 *   given, month by month (an entry repeated by a retried write is yielded once). `find` returns every entry
 *   of one item, the private archives included, oldest first. `queuePending` keeps entries in `pending.jsonl`
 *   (the member's private one with `privateUserId`) and resolves to their count; `drainPending` appends
 *   every pending entry of the guild and its private layers (a duplicate counts as archived), notes each in
 *   `pending-done.jsonl`, compacts both files and returns the counts and the `confirmed` entries; it stops a
 *   file at the first refusal. `stats` reads the pending count kept in memory (set by `queuePending` and
 *   `drainPending`; 0 before the first). Every method but `iterate`, `find` and `stats` runs one at a time.
 */
export function createArchive({
  appendStore,
  dataDir,
  log = defaultLog,
  now = Date.now,
  fs = nodeFs,
  writerGate = null,
  memoryDb = null,
}) {
  const root = memoryRootOf(dataDir);
  const seam = createReadSeam({ memoryDb, log, reader: 'archive' });
  const indexes = new Map(); // unit -> Set of keys
  const pendingCounts = new Map(); // guildId -> entries waiting in the pending files
  let chain = Promise.resolve();

  /** Run `task` after every write already queued. */
  function serial(task) {
    const run = chain.then(task);
    chain = run.catch(() => {});
    return run;
  }

  function guildBase(guildId) {
    return root.guildDir(guildId);
  }

  function baseDir(guildId, privateUserId = null) {
    return typeof privateUserId === 'string' && privateUserId
      ? path.join(guildBase(guildId), 'private', privateUserId, 'archive')
      : path.join(guildBase(guildId), 'archive');
  }

  const segmentFile = (base, month) => path.join(base, `${month}.jsonl`);
  const pendingFile = (base) => path.join(base, 'pending.jsonl');
  const doneFile = (base) => path.join(base, 'pending-done.jsonl');

  async function listDir(dir, { dirsOnly = false } = {}) {
    try {
      const entries = await fs.readdir(dir, { withFileTypes: true });
      return entries
        .filter((entry) => !dirsOnly || entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return [];
      throw error;
    }
  }

  /** Every base of a guild that may hold a pending queue: its own archive, then each private layer's
   * directory that exists (only directories are layers). */
  async function bases(guildId) {
    const out = [{ base: baseDir(guildId), privateUserId: null }];
    for (const userId of await listDir(path.join(guildBase(guildId), 'private'), { dirsOnly: true })) {
      const base = baseDir(guildId, userId);
      if ((await listDir(base)).length > 0) out.push({ base, privateUserId: userId });
    }
    return out;
  }

  /** Append one line of a pending file durably: rejects when the append store failed it or holds it for a retry. */
  async function appendLine(file, line) {
    const before = typeof appendStore.stats === 'function' ? appendStore.stats() : null;
    await appendStore.append(file, line, { sync: true });
    if (before) {
      const after = appendStore.stats();
      if (after.failed > before.failed || after.pending > 0) {
        const error = new Error('archive: the write is not on disk yet');
        error.code = 'archive-unconfirmed';
        throw error;
      }
    }
  }

  function monthOf(entry) {
    const iso = isoOf(entry.recordedAt) ?? new Date(now()).toISOString();
    return iso.slice(0, 7);
  }

  /** A month's keys, from the database's lines of the month's unit, read once and then kept. */
  function dbIndex(db, guildId, privateUserId, month, owner) {
    const cached = indexes.get(owner);
    if (cached) return cached;
    const keys = new Set();
    for (const line of seam.run(() => archiveLines(db, guildId, privateUserId, month))) {
      const key = keyOf(parse(line));
      if (key) keys.add(key);
    }
    indexes.set(owner, keys);
    return keys;
  }

  /** The month units' lines written through the database's writer. */
  async function appendNow(guildId, entries, privateUserId = null) {
    const db = seam.db();
    if (typeof memoryDb?.writeUnit !== 'function')
      throw Object.assign(new Error('memory db: no writer'), { code: 'DB_CLOSED' });
    const base = baseDir(guildId, privateUserId);
    const isPrivate = typeof privateUserId === 'string' && privateUserId;
    const months = new Map(); // owner -> { keys, lines, added }
    let duplicates = 0;
    for (const raw of Array.isArray(entries) ? entries : []) {
      if (!isPlainObject(raw)) continue;
      const entry = { ...raw, guildId: String(guildId) };
      if (isPrivate) entry.scope = { user: privateUserId, private: true };
      const month = monthOf(entry);
      const owner = root.relative(segmentFile(base, month));
      let unit = months.get(owner);
      if (!unit)
        months.set(
          owner,
          (unit = { keys: dbIndex(db, guildId, privateUserId, month, owner), lines: [], added: new Set() })
        );
      const key = keyOf(entry);
      if (key && (unit.keys.has(key) || unit.added.has(key))) {
        duplicates += 1;
        continue;
      }
      unit.lines.push(entry);
      if (key) unit.added.add(key);
    }
    let written = 0;
    for (const [owner, unit] of months) {
      if (unit.lines.length === 0) continue;
      await memoryDb.writeUnit({ op: 'lines', owner, lines: unit.lines });
      for (const key of unit.added) unit.keys.add(key);
      written += unit.lines.length;
    }
    return { written, duplicates };
  }

  /** Wait while a writer lock is held (outside the chain: a writer queued behind it would wait for itself). */
  async function gate() {
    if (typeof writerGate === 'function') await writerGate();
  }

  async function append(guildId, entries, { privateUserId = null } = {}) {
    await gate();
    return serial(() => appendNow(guildId, entries, privateUserId));
  }

  async function* iterate(guildId, { from = null, to = null, scope = null, kinds = null, privateUserId = null } = {}) {
    const db = seam.db();
    const fromMs = from ? Date.parse(from) : -Infinity;
    const toMs = to ? Date.parse(to) : Infinity;
    const fromMonth = from ? String(isoOf(from) ?? '').slice(0, 7) : '0000-00';
    const toMonth = to ? String(isoOf(to) ?? '').slice(0, 7) : '9999-99';
    const wanted = Array.isArray(kinds) && kinds.length > 0 ? new Set(kinds) : null;
    const scopeKeys = isPlainObject(scope) ? Object.entries(scope) : [];
    for (const month of seam.run(() => archiveMonths(db, guildId, privateUserId))) {
      if (!MONTH_RE.test(month) || month < fromMonth || month > toMonth) continue;
      const seen = new Set();
      for (const line of seam.run(() => archiveLines(db, guildId, privateUserId, month))) {
        const entry = parse(line);
        if (!entry || seen.has(entry.id)) continue;
        seen.add(entry.id);
        const at = Date.parse(entry.recordedAt);
        if (Number.isFinite(at) && (at < fromMs || at > toMs)) continue;
        if (wanted && !wanted.has(entry.itemKind)) continue;
        if (scopeKeys.some(([key, value]) => entry.scope?.[key] !== value)) continue;
        yield entry;
      }
    }
  }

  async function find(guildId, itemId) {
    const out = [];
    const db = seam.db();
    const layers = [null, ...seam.run(() => archiveLayers(db, guildId))];
    for (const privateUserId of layers) {
      for await (const entry of iterate(guildId, { privateUserId })) if (entry.itemId === itemId) out.push(entry);
    }
    return out.sort((a, b) => String(a.recordedAt).localeCompare(String(b.recordedAt)));
  }

  /** The pending entries of one base not yet noted done, in order, and the done ids. */
  async function readPending(base) {
    const done = new Set();
    for await (const { line } of appendStore.iterate(doneFile(base))) {
      const value = parse(line);
      if (typeof value?.id === 'string') done.add(value.id);
    }
    const waiting = [];
    const ids = new Set();
    for await (const { line } of appendStore.iterate(pendingFile(base))) {
      const value = parse(line);
      const entry = value?.entry;
      if (!isPlainObject(entry) || typeof entry.id !== 'string' || done.has(entry.id) || ids.has(entry.id)) continue;
      ids.add(entry.id);
      waiting.push(entry);
    }
    return { waiting, done };
  }

  async function countPending(guildId) {
    let pending = 0;
    for (const { base } of await bases(guildId)) pending += (await readPending(base)).waiting.length;
    pendingCounts.set(String(guildId), pending);
    return pending;
  }

  async function queuePending(guildId, entries, { privateUserId = null } = {}) {
    await gate();
    return serial(async () => {
      const base = baseDir(guildId, privateUserId);
      let queued = 0;
      for (const entry of Array.isArray(entries) ? entries : []) {
        if (!isPlainObject(entry) || typeof entry.id !== 'string') continue;
        await appendLine(pendingFile(base), JSON.stringify({ id: entry.id, entry }));
        queued += 1;
        pendingCounts.set(String(guildId), (pendingCounts.get(String(guildId)) ?? 0) + 1);
      }
      return queued;
    });
  }

  async function drainPending(guildId) {
    await gate();
    return serial(async () => {
      let archived = 0;
      const confirmed = [];
      for (const { base, privateUserId } of await bases(guildId)) {
        const { waiting, done } = await readPending(base);
        if (waiting.length === 0) {
          if (done.size > 0) await appendStore.rewrite(doneFile(base), () => false);
          continue;
        }
        let taken = 0;
        for (const entry of waiting) {
          try {
            await appendNow(guildId, [entry], privateUserId);
            await appendLine(doneFile(base), JSON.stringify({ id: entry.id }));
          } catch (error) {
            log.warn('archive: drain stopped', {
              guildId: String(guildId),
              left: waiting.length - taken,
              code: error?.code ?? null,
            });
            break;
          }
          done.add(entry.id);
          taken += 1;
          confirmed.push(entry);
        }
        archived += taken;
        if (taken > 0) {
          // The queue first, then the notes: a crash between leaves notes of entries no longer queued, which is harmless.
          await appendStore.rewrite(pendingFile(base), (line) => !done.has(parse(line)?.entry?.id));
          if (taken === waiting.length) await appendStore.rewrite(doneFile(base), () => false);
        }
      }
      const left = await countPending(guildId);
      if (archived > 0) log.info('archive: drained', { guildId: String(guildId), archived, left });
      return { archived, left, confirmed };
    });
  }

  function stats(guildId) {
    return { pending: pendingCounts.get(String(guildId)) ?? 0 };
  }

  return { append, iterate, find, queuePending, drainPending, stats };
}
