// The owner's GIF recache (`/nep gifs recache`): GIFs described before they
// were watched carry a caption of one still frame. This re-describes them
// through the GIF watch (src/memory/describe.ts#watchGif) without waiting
// for each to come up again. One run: the one-frame GIF captions of the
// media cache that belong to no library entry are dropped at once (each is
// described again, watched, the next time it appears in a transcript); then,
// in the background, at most `gifs.recachePerRun` library entries not yet
// watched, or watched in the older one-line format (no `reaction` field, so
// the library moves to the three-field captions run by run) -- oldest-described
// first, so repeated runs work through the whole library -- are watched again
// from their message, re-read through the
// interface for a fresh animation URL. A failed watch keeps the old caption, marked
// `watchFailed`, which sends it to the back of the queue. One run at a time;
// refused while paused or while GIFs are not watched; a run stops before the
// next GIF once the bot is paused or a daily rail is spent. Logs carry counts only.
//
// The media recache (`/nep media kind:pictures action:recache days:<n>`,
// startMedia) re-describes by the current models the cached descriptions of
// pictures -- images, link thumbnails, stickers, custom emoji and GIFs alike
// -- last used (`usedAt`, else written: `ts`) within the last `days`, written
// by an older model: skipped are the ones described at or after
// `media.recacheBefore` when it is set, and the ones whose `model` is the
// current one for their kind (the video role for a watched GIF, else the
// vision role). An emoji is fetched from the address the emoji index holds for its id; a library GIF from its
// library entry's message; any other picture from the messages the record
// (src/memory/record.ts) says may hold it -- an attachment id or a gif
// embed's message id dates the message, a link thumbnail or a sticker is
// looked for in the window -- read again through the interface, newest first.
// One description at a time (src/memory/describe.ts#redescribe: the normal
// path, a failure keeps the old text), at least `media.recacheIntervalMs`
// apart. It shares the one-run-at-a-time rule and the stops of the GIF run,
// and stops at once when `llm.maxRequestsPerDay` is spent. A picture whose
// message cannot be found is left as it is (counted `unlocated`); with
// `media.recacheBefore` set it is still described again when it comes up.

import { collectPictures } from '../media/classify.ts';
import { lineOf } from '../behavior/line-of.ts';
import { collectGifItems, normalizeGifs } from './gifs.ts';
import { isStaleDescription, recacheCutoffMs } from './describe.ts';
import { roleModel } from '../llm/roles.ts';
import { DAY_MS, MINUTE_MS } from '../time.ts';
import { log as defaultLog } from '../log.ts';
import { isFiniteNumber, isIntegerNumber } from './types.ts';
import type { Reads } from '../interface/reads.ts';
import type { StoredRecord, Hot, Log, Untyped } from './types.ts';
import type { StoreView } from './store.ts';
import type { RecordStore } from './record.ts';
import { asRecordLines } from './record.ts';

/** The GIFs one recache run queues. Production value, config cut of 2026-10-31. */
const DEFAULT_PER_RUN = 50;
/** The wait between two recache requests, in ms. Production value, config cut of 2026-10-31. */
const DEFAULT_INTERVAL_MS = 3000;
/** The `days` of a media recache run: the default and the bounds (`/nep media` checks the same). */
export const RECACHE_DAYS = Object.freeze({ default: 7, min: 1, max: 60 });
// A gif embed's per-message item id (`<message>#e<n>`, set by the interface package).
const EMBED_ID_RE = /#e\d+$/;
// An attachment's item id: its snowflake, the platform's own id.
const ATTACHMENT_ID_RE = /^\d+$/;
// The other picture item ids (src/media/classify.ts#collectPictures, collectEmojiItems).
const PICTURE_KEY_PREFIXES = ['emoji:', 'sticker:', 'link:', 'video:url:'];
// The start of the snowflake clock that dates an attachment id of the media cache keys (the keys keep the platform's own ids).
const SNOWFLAKE_EPOCH_MS = 1_420_070_400_000;
// How long before its message an attachment may be uploaded (its snowflake is the upload's).
const UPLOAD_LEAD_MS = 30 * MINUTE_MS;

/**
 * The creation time (ms) of a snowflake id, or null for anything else. Pure.
 */
export function snowflakeMs(id: unknown): number | null {
  if (typeof id !== 'string' || !/^\d{15,20}$/.test(id)) return null;
  return Number(BigInt(id) >> 22n) + SNOWFLAKE_EPOCH_MS;
}

/**
 * Whether a media cache key holds a picture's description (an attachment's
 * snowflake, a gif embed's `<message>#e<n>`, `emoji:`, `sticker:`, `link:`
 * or a video-site link's thumbnail `video:url:`) -- never a video summary
 * (`video:<item id>`), a question's answer or a web lookup entry. Pure.
 */
export function isPictureKey(key: string): boolean {
  if (typeof key !== 'string') return false;
  if (key.startsWith('video:')) return key.startsWith('video:url:') && !key.includes(':q:');
  if (key.includes(':q:')) return false;
  return (
    ATTACHMENT_ID_RE.test(key) || EMBED_ID_RE.test(key) || PICTURE_KEY_PREFIXES.some((prefix) => key.startsWith(prefix))
  );
}

/** When a cached description was last used: its `usedAt` or its `ts`, whichever is later; -Infinity when neither. */
function lastUseOf(entry: Untyped) {
  const times = [entry.usedAt, entry.ts].filter((value) => typeof value === 'number' && isFiniteNumber(value));
  return times.length > 0 ? Math.max(...times) : -Infinity;
}

/**
 * The media cache keys a media recache run re-describes, most recently used
 * first: picture descriptions (isPictureKey, a text, no miss) last used
 * (`usedAt`, else `ts`) at or after `nowMs - days` days, minus the ones
 * described at or after `cutoffMs` (media.recacheBefore, when not null) and
 * the ones whose `model` is the current one for their kind (`models.video`
 * for a watched GIF, else `models.vision`). Pure.
 * @param cache  The place's media cache.
 */
export function pickStaleDescriptions(
  cache: StoredRecord,
  {
    nowMs,
    days,
    cutoffMs,
    models,
  }: {
    nowMs: number;
    days: number;
    cutoffMs: number | null;
    models: { vision: string | null | undefined; video: string | null | undefined };
  }
): Array<string> {
  const since = nowMs - days * DAY_MS;
  const picked: Array<{ key: string; usedAt: number }> = [];
  for (const [key, entry] of Object.entries<Untyped>(cache ?? {})) {
    if (!isPictureKey(key) || !entry || entry.miss || typeof entry.text !== 'string' || entry.text.trim() === '')
      continue;
    const usedAt = lastUseOf(entry);
    if (usedAt < since) continue;
    if (cutoffMs !== null && cutoffMs !== undefined && !isStaleDescription(entry, cutoffMs)) continue;
    const current = entry.watched === true ? models?.video : models?.vision;
    if (typeof entry.model === 'string' && entry.model === current) continue;
    picked.push({ key, usedAt });
  }
  return picked.sort((a, b) => b.usedAt - a.usedAt).map((item) => item.key);
}

/**
 * Which record lines (src/memory/record.ts) may hold the pictures under
 * `keys` (no emoji: those need no message): a `seen` or `said` line with a
 * message, a channel and some media that is the message of a gif embed key,
 * whose time is at most UPLOAD_LEAD_MS after an attachment key's snowflake
 * time (and not over a minute before it), or -- while a key carries no time
 * (a link thumbnail, a sticker) -- that falls at or after `sinceMs`.
 * `fromMs` is the earliest moment worth reading. Pure.
 * @param sinceMs  The run's window start.
 */
export function recordFinder(
  keys: Iterable<string>,
  sinceMs: number
): { fromMs: number; matches: (line: object) => boolean } {
  const messageIds = new Set<string>();
  const uploads: Array<Untyped> = [];
  let untimed = false;
  let fromMs = sinceMs;
  for (const key of keys) {
    if (EMBED_ID_RE.test(key)) {
      const messageId = key.replace(EMBED_ID_RE, '');
      messageIds.add(messageId);
      const at = snowflakeMs(messageId);
      if (at !== null) fromMs = Math.min(fromMs, at - MINUTE_MS);
      else untimed = true;
      continue;
    }
    const at = ATTACHMENT_ID_RE.test(key) ? snowflakeMs(key) : null;
    if (at === null) {
      untimed = true;
      continue;
    }
    uploads.push(at);
    fromMs = Math.min(fromMs, at - MINUTE_MS);
  }
  const matches = (line: Untyped) => {
    if (!line || (line.kind !== 'seen' && line.kind !== 'said')) return false;
    if (typeof line.messageId !== 'string' || !line.messageId || typeof line.scope?.channel !== 'string') return false;
    if (!Array.isArray(line.media) || line.media.length === 0) return false;
    if (messageIds.has(line.messageId)) return true;
    const occurredMs = Date.parse(line.occurredAt);
    if (
      isFiniteNumber(occurredMs) &&
      uploads.some((upload) => upload <= occurredMs + MINUTE_MS && upload >= occurredMs - UPLOAD_LEAD_MS)
    )
      return true;
    return untimed && isFiniteNumber(occurredMs) && occurredMs >= sinceMs;
  };
  return { fromMs, matches };
}

/**
 * Where one GIF's caption stands in the media cache entry `entry`:
 * `watched` (a watched caption), `failed` (a watch was tried and failed; any
 * one-frame caption is kept), `one-frame` (a caption from one still frame),
 * `none` (no caption: no entry or a miss).
 */
export function gifCaptionState(entry: StoredRecord): 'watched' | 'failed' | 'one-frame' | 'none' {
  const hasText = Boolean(entry) && !entry.miss && typeof entry.text === 'string' && entry.text.trim() !== '';
  if (hasText && entry.watched) return 'watched';
  if (entry && isFiniteNumber(entry.watchFailed)) return 'failed';
  return hasText ? 'one-frame' : 'none';
}

/**
 * How many library entries stand where (see gifCaptionState), by their
 * `itemId` in the media cache.
 * @param gifs   A stored library (normalised here).
 * @param cache   The place's media cache.
 */
export function gifCaptionCounts(
  gifs: unknown,
  cache: StoredRecord
): { watched: number; 'one-frame': number; failed: number; none: number } {
  const counts = { watched: 0, 'one-frame': 0, failed: 0, none: 0 };
  for (const entry of Object.values(normalizeGifs(gifs).entries)) counts[gifCaptionState(cache?.[entry.itemId])] += 1;
  return counts;
}

/**
 * Whether a cached GIF caption is watched in the older one-line format: no
 * `reaction` field (src/memory/describe.ts#parseGifDescription writes it,
 * '' included, on every watch since GIFs are described in three fields).
 */
function watchedOldFormat(entry: StoredRecord): boolean {
  return gifCaptionState(entry) === 'watched' && typeof entry.reaction !== 'string';
}

/**
 * How far the library is in the move to three-field captions, by its
 * entries' `itemId` in the media cache: `fields` watched with a `reaction`
 * field, `oldFormat` watched without one (the recache re-describes them),
 * `unwatched` everything else (one-frame, failed watch, no caption).
 * @param gifs   A stored library (normalised here).
 * @param cache   The place's media cache.
 */
export function gifFormatCounts(
  gifs: unknown,
  cache: StoredRecord
): { fields: number; oldFormat: number; unwatched: number } {
  const counts = { fields: 0, oldFormat: 0, unwatched: 0 };
  for (const entry of Object.values(normalizeGifs(gifs).entries)) {
    const cached = cache?.[entry.itemId];
    if (gifCaptionState(cached) !== 'watched') counts.unwatched += 1;
    else if (watchedOldFormat(cached)) counts.oldFormat += 1;
    else counts.fields += 1;
  }
  return counts;
}

/**
 * The library entries a run re-describes, as `[{ key, ...entry }]`: every
 * entry not watched yet, and every one watched in the older one-line format
 * (no `reaction` field), oldest-described first -- by the cache entry's
 * `watchFailed` (a failed watch counts as described then), else its `ts`;
 * an entry with no cache entry at all comes first -- ties in library order,
 * at most `limit` of them.
 * @param gifs   A stored library (normalised here).
 * @param cache   The place's media cache.
 */
export function recacheQueue(gifs: unknown, cache: StoredRecord, limit: number): Array<object> {
  const describedAt = (entry: Untyped) => {
    const cached = cache?.[entry.itemId];
    if (!cached) return 0;
    if (isFiniteNumber(cached.watchFailed)) return cached.watchFailed;
    return isFiniteNumber(cached.ts) ? cached.ts : 0;
  };
  return Object.entries(normalizeGifs(gifs).entries)
    .filter(
      ([, entry]) => gifCaptionState(cache?.[entry.itemId]) !== 'watched' || watchedOldFormat(cache?.[entry.itemId])
    )
    .map(([key, entry]) => ({ key, ...entry }))
    .sort((a, b) => describedAt(a) - describedAt(b))
    .slice(0, Math.max(0, limit));
}

/**
 * The media cache keys of one-frame GIF captions that belong to no library
 * entry: a caption not watched that is marked `gif` (every GIF caption
 * written since GIFs are watched) or sits under a gif embed's per-message id
 * (`<message>#e<n>`: only gif embeds are described under such an id). An
 * attached GIF captioned before the marker existed cannot be told from a
 * picture, so it is left alone. Video entries (`video:`) are never touched.
 * @param cache   The place's media cache.
 * @param gifs   A stored library (normalised here).
 */
export function oneFrameGifKeys(cache: StoredRecord, gifs: unknown): Array<string> {
  const library = new Set(Object.values(normalizeGifs(gifs).entries).map((entry) => entry.itemId));
  const keys: Array<string> = [];
  for (const [key, entry] of Object.entries<Untyped>(cache ?? {})) {
    if (key.startsWith('video:') || library.has(key)) continue;
    if (!entry || entry.miss || entry.watched || typeof entry.text !== 'string') continue;
    if (entry.gif === true || EMBED_ID_RE.test(key)) keys.push(key);
  }
  return keys;
}

/** Wait `ms` on the real clock. */
function realSleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function buildGifRecache({
  hot,
  store,
  reads,
  iface,
  emoji,
  describer = null,
  record = null,
  now = Date.now,
  sleep = realSleep,
  log = defaultLog,
}: {
  hot: Hot;
  store: StoreView;
  reads: Reads;
  iface: () => string;
  emoji: { refresh: () => Promise<void>; urlOf: (id: string) => string | null };
  describer?: Untyped;
  record?: Pick<RecordStore, 'iterate'> | null;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  log?: Log;
}) {
  let running: Untyped = null;

  /** One message read again through the interface, as a line; null when it is gone or the read fails. */
  async function readMessage(placeId: string, messageId: string) {
    const found = await reads.fetchMessages({ iface: iface(), conversationId: String(placeId) }, [messageId]);
    const event = found?.messages[0]?.event;
    if (!event) {
      log.warn('gif-recache: message read failed', { placeId });
      return null;
    }
    return lineOf(event);
  }

  /**
   * The GIF's picture item read again from its latest message (an
   * attachment's address may expire, a gif embed's animation comes with the embed),
   * under the entry's `itemId`; matched by the entry's key, a link GIF also
   * by its URL (src/memory/gifs.ts#matchGifKey's rule). Null when the
   * message or the GIF in it is gone, or the read fails.
   */
  async function pictureOf(entry: Untyped) {
    if (!entry.messageId || !entry.placeId) return null;
    const normalized = await readMessage(entry.placeId, entry.messageId);
    if (!normalized) return null;
    const gifs = collectGifItems(normalized);
    const found =
      gifs.find((gif) => gif.key === entry.itemId || gif.key === entry.key) ??
      (entry.kind === 'link' ? gifs.find((gif) => gif.kind === 'link' && gif.url === entry.url) : null);
    if (!found) return null;
    const picture = collectPictures(normalized).find((item) => item.kind === 'gif' && item.itemId === found.key);
    return picture ? { ...picture, itemId: entry.itemId } : null;
  }

  /** Watch every queued entry in turn; stops on pause or a spent rail. */
  async function work(placeId: string, queue: Untyped) {
    const counts = { watched: 0, failed: 0 };
    let stopped = null;
    for (const entry of queue) {
      if (store.state?.data?.paused) {
        stopped = 'paused';
        break;
      }
      const item = (await pictureOf(entry)) ?? { itemId: entry.itemId, kind: 'gif' };
      const outcome = await describer.watchGif(placeId, item);
      if (outcome.state === 'watched') counts.watched += 1;
      else if (outcome.state === 'failed') counts.failed += 1;
      else {
        stopped = outcome.reason ?? 'unavailable';
        break;
      }
    }
    if (!store.state?.data?.paused) store.flush();
    log.info('gif-recache: done', { ...counts, queued: queue.length, stopped });
  }

  /**
   * Start one run for `placeId`: drops the one-frame captions outside the
   * library (oneFrameGifKeys) at once, then watches up to
   * `gifs.recachePerRun` library entries (recacheQueue) in the background.
   * Resolves at once, never throws for a skip: `{ ok: false, reason }` --
   * `running`, `paused`, `unavailable` (no describer), or why GIFs
   * are not watched (`off`, `no-prompt`) -- else `{ ok: true,
   * dropped, queued }`.
   */
  function start(placeId: string) {
    if (running) return { ok: false, reason: 'running' };
    if (store.state?.data?.paused) return { ok: false, reason: 'paused' };
    if (typeof describer?.watchGif !== 'function') return { ok: false, reason: 'unavailable' };
    const blocker = typeof describer.gifWatchBlocker === 'function' ? describer.gifWatchBlocker() : null;
    if (blocker) return { ok: false, reason: blocker };

    const cache = store.getMediaCache(placeId);
    const gifs = store.getGifs(placeId);
    const dropped = oneFrameGifKeys(cache, gifs);
    for (const key of dropped) delete cache[key];
    if (dropped.length > 0) store.markMediaCacheDirty(placeId);

    const queue = recacheQueue(gifs, cache, DEFAULT_PER_RUN);
    log.info('gif-recache: started', { dropped: dropped.length, queued: queue.length });

    running = work(placeId, queue)
      .catch((err) => log.error('gif-recache: failed', { error: err }))
      .finally(() => {
        running = null;
      });
    return { ok: true, dropped: dropped.length, queued: queue.length };
  }

  /** The wait between two recache requests. */
  function intervalMs() {
    return DEFAULT_INTERVAL_MS;
  }

  /** Why a run must stop before its next step (`paused`), or null. */
  function stopReason() {
    return store.state?.data?.paused ? 'paused' : null;
  }

  /** Re-describe the picked keys: emoji, then library GIFs, then the rest through the record; see startMedia. */
  async function workMedia(placeId: string, keys: Untyped, sinceMs: Untyped) {
    const counts = { done: 0, failed: 0 };
    const wanted = new Set<string>(keys);
    let stopped = null;
    let lastAt: number | null = null;

    /** One description, at least intervalMs() after the previous one began; false = stop the run. */
    const one = async (item: Untyped) => {
      stopped = stopReason();
      if (stopped) return false;
      if (lastAt !== null) {
        const wait = lastAt + intervalMs() - now();
        if (wait > 0) await sleep(wait);
      }
      lastAt = now();
      const outcome = await describer.redescribe(placeId, item);
      if (outcome.state === 'done') counts.done += 1;
      else if (outcome.state === 'failed') counts.failed += 1;
      else {
        stopped = outcome.reason ?? 'unavailable';
        return false;
      }
      return true;
    };

    const run = async () => {
      // A custom emoji's picture comes from the emoji index; one the community no longer lists cannot be fetched.
      await emoji.refresh();
      for (const key of keys) {
        if (!key.startsWith('emoji:')) continue;
        const url = emoji.urlOf(key.slice('emoji:'.length));
        if (url === null) continue;
        wanted.delete(key);
        if (!(await one({ source: 'emoji', itemId: key, kind: 'emoji', url }))) return;
      }
      // A library GIF from its library entry's message.
      for (const entry of Object.values(normalizeGifs(store.getGifs(placeId)).entries)) {
        if (!wanted.has(entry.itemId)) continue;
        stopped = stopReason();
        if (stopped) return;
        const item = await pictureOf(entry);
        if (!item) continue;
        wanted.delete(entry.itemId);
        if (!(await one(item))) return;
      }
      // The rest from the messages the record says may hold them, newest first.
      if (wanted.size === 0 || typeof record?.iterate !== 'function') return;
      const finder = recordFinder(wanted, sinceMs);
      const messages = new Map();
      for await (const line of asRecordLines(
        record.iterate(placeId, { from: new Date(finder.fromMs).toISOString() })
      )) {
        if (!finder.matches(line)) continue;
        const at = Date.parse(line.occurredAt);
        messages.set(line.messageId, {
          messageId: line.messageId,
          placeId: line.scope.channel,
          at: isFiniteNumber(at) ? at : 0,
        });
      }
      for (const ref of [...messages.values()].sort((a, b) => b.at - a.at)) {
        if (wanted.size === 0) return;
        stopped = stopReason();
        if (stopped) return;
        const normalized = await readMessage(ref.placeId, ref.messageId);
        if (!normalized) continue;
        for (const item of collectPictures(normalized)) {
          if (!wanted.has(item.itemId)) continue;
          wanted.delete(item.itemId);
          if (!(await one(item))) return;
        }
      }
    };

    await run();
    if (!store.state?.data?.paused) store.flush();
    log.info('media: recached', { picked: keys.length, ...counts, unlocated: stopped ? 0 : wanted.size, stopped });
  }

  /**
   * Start one media recache run for `placeId` (see the header): picks the
   * keys at once (pickStaleDescriptions, under the live media.recacheBefore
   * and the current vision and video models), then re-describes them in the
   * background. Resolves at once, never throws for a skip: `{ ok: false,
   * reason }` -- `running` (this or a GIF run), `paused`,
   * `unavailable` (no describer), or why pictures are not described
   * (`no-prompt`) -- else `{ ok: true, picked, days }`.
   * @param [options]  Whole days back, RECACHE_DAYS (out of bounds -> clamped).
   */
  function startMedia(placeId: string, { days = RECACHE_DAYS.default }: { days?: number } = {}) {
    if (running) return { ok: false, reason: 'running' };
    if (store.state?.data?.paused) return { ok: false, reason: 'paused' };
    if (typeof describer?.redescribe !== 'function') return { ok: false, reason: 'unavailable' };
    const blocker = typeof describer.pictureBlocker === 'function' ? describer.pictureBlocker() : null;
    if (blocker) return { ok: false, reason: blocker };

    const span = isIntegerNumber(days)
      ? Math.min(RECACHE_DAYS.max, Math.max(RECACHE_DAYS.min, days))
      : RECACHE_DAYS.default;
    const nowMs = now();
    const keys = pickStaleDescriptions(store.getMediaCache(placeId), {
      nowMs,
      days: span,
      cutoffMs: recacheCutoffMs(hot.config),
      models: { vision: roleModel(hot.config, 'vision', 'describe'), video: roleModel(hot.config, 'video') },
    });
    log.info('media: recaching', { picked: keys.length, days: span });

    running = workMedia(placeId, keys, nowMs - span * DAY_MS)
      .catch((err) => log.error('media: recache failed', { error: err }))
      .finally(() => {
        running = null;
      });
    return { ok: true, picked: keys.length, days: span };
  }

  /** Whether a run is in flight. */
  function isRunning() {
    return running !== null;
  }

  /** Resolves once no run is in flight (`/nep pause` waits on it). */
  async function waitIdle() {
    while (running) await running;
  }

  return { start, startMedia, isRunning, waitIdle };
}

export type GifRecache = ReturnType<typeof buildGifRecache>;

/**
 * The GIF recache for the served place, and the media recache (startMedia).
 * @param deps.hot        src/hot.js view; `config.gifs.recachePerRun`, `config.media.embedTextChars`,
 *   `config.media.recacheBefore`, `config.media.recacheIntervalMs` and the roles read at use.
 * @param deps.store      src/memory/store.ts.
 * @param deps.reads  The core's reads of the interface: a message read again.
 * @param deps.iface  The interface's name, read at each run.
 * @param deps.emoji  The core's emoji index
 *   (src/behavior/emoji-index.ts): the address of a custom emoji's picture.
 * @param [deps.describer]  From createDescriber(): `watchGif`, `gifWatchBlocker`, `redescribe`,
 *   `pictureBlocker`. Absent -> never runs.
 * @param [deps.record]  src/memory/record.ts (`iterate`), where the media recache finds the
 *   messages of the pictures it re-describes. Absent -> only emoji and library GIFs are found.
 * @param [deps.sleep]  The media recache's pause between two descriptions.
 * @param [deps.log]      src/log.js-shaped logger.
 */
export function createGifRecache(deps: Parameters<typeof buildGifRecache>[0]): GifRecache {
  return buildGifRecache(deps);
}
