// The owner's GIF recache (`/nep gifs recache`): GIFs described before they
// were watched carry a caption of one still frame. This re-describes them
// through the GIF watch (src/memory/describe.js#watchGif) without waiting
// for each to come up again. One run: the one-frame GIF captions of the
// media cache that belong to no library entry are dropped at once (each is
// described again, watched, the next time it appears in a transcript); then,
// in the background, at most `gifs.recachePerRun` library entries not yet
// watched, or watched in the older one-line format (no `reaction` field, so
// the library moves to the three-field captions run by run) -- oldest-described
// first, so repeated runs work through the whole library -- are watched again
// from their message, re-read over the Discord
// API for a fresh animation URL. A failed watch keeps the old caption, marked
// `watchFailed`, which sends it to the back of the queue. One run at a time;
// refused while paused, during a warmup or while GIFs are not watched; a run
// stops before the next GIF once the bot is paused, a warmup starts or a
// daily rail is spent. Logs carry counts only.

import { normalizeMessage } from '../discord/collect.js';
import { collectPictures } from '../discord/media.js';
import { collectGifItems, normalizeGifs } from './gifs.js';
import { log as defaultLog } from '../log.js';

/** `gifs.recachePerRun` when missing or invalid (config.json carries the same). */
const DEFAULT_PER_RUN = 50;
// A gif embed's per-message item id (src/discord/collect.js#normalizeEmbedLinks).
const EMBED_ID_RE = /#e\d+$/;

/**
 * Where one GIF's caption stands in the media cache entry `entry`:
 * `watched` (a watched caption), `failed` (a watch was tried and failed; any
 * one-frame caption is kept), `one-frame` (a caption from one still frame),
 * `none` (no caption: no entry or a miss).
 * @param {object|undefined} entry
 * @returns {'watched'|'failed'|'one-frame'|'none'}
 */
export function gifCaptionState(entry) {
  const hasText = Boolean(entry) && !entry.miss && typeof entry.text === 'string' && entry.text.trim() !== '';
  if (hasText && entry.watched) return 'watched';
  if (entry && Number.isFinite(entry.watchFailed)) return 'failed';
  return hasText ? 'one-frame' : 'none';
}

/**
 * How many library entries stand where (see gifCaptionState), by their
 * `itemId` in the media cache.
 * @param {unknown} gifs   A stored library (normalised here).
 * @param {object} cache   The guild's media cache.
 * @returns {{ watched: number, 'one-frame': number, failed: number, none: number }}
 */
export function gifCaptionCounts(gifs, cache) {
  const counts = { watched: 0, 'one-frame': 0, failed: 0, none: 0 };
  for (const entry of Object.values(normalizeGifs(gifs).entries)) counts[gifCaptionState(cache?.[entry.itemId])] += 1;
  return counts;
}

/**
 * Whether a cached GIF caption is watched in the older one-line format: no
 * `reaction` field (src/memory/describe.js#parseGifDescription writes it,
 * '' included, on every watch since GIFs are described in three fields).
 * @param {object|undefined} entry
 * @returns {boolean}
 */
function watchedOldFormat(entry) {
  return gifCaptionState(entry) === 'watched' && typeof entry.reaction !== 'string';
}

/**
 * How far the library is in the move to three-field captions, by its
 * entries' `itemId` in the media cache: `fields` watched with a `reaction`
 * field, `oldFormat` watched without one (the recache re-describes them),
 * `unwatched` everything else (one-frame, failed watch, no caption).
 * @param {unknown} gifs   A stored library (normalised here).
 * @param {object} cache   The guild's media cache.
 * @returns {{ fields: number, oldFormat: number, unwatched: number }}
 */
export function gifFormatCounts(gifs, cache) {
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
 * @param {unknown} gifs   A stored library (normalised here).
 * @param {object} cache   The guild's media cache.
 * @param {number} limit
 * @returns {object[]}
 */
export function recacheQueue(gifs, cache, limit) {
  const describedAt = (entry) => {
    const cached = cache?.[entry.itemId];
    if (!cached) return 0;
    if (Number.isFinite(cached.watchFailed)) return cached.watchFailed;
    return Number.isFinite(cached.ts) ? cached.ts : 0;
  };
  return Object.entries(normalizeGifs(gifs).entries)
    .filter(([, entry]) => gifCaptionState(cache?.[entry.itemId]) !== 'watched' || watchedOldFormat(cache?.[entry.itemId]))
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
 * @param {object} cache   The guild's media cache.
 * @param {unknown} gifs   A stored library (normalised here).
 * @returns {string[]}
 */
export function oneFrameGifKeys(cache, gifs) {
  const library = new Set(Object.values(normalizeGifs(gifs).entries).map((entry) => entry.itemId));
  const keys = [];
  for (const [key, entry] of Object.entries(cache ?? {})) {
    if (key.startsWith('video:') || library.has(key)) continue;
    if (!entry || entry.miss || entry.watched || typeof entry.text !== 'string') continue;
    if (entry.gif === true || EMBED_ID_RE.test(key)) keys.push(key);
  }
  return keys;
}

/**
 * The GIF recache for the served guild.
 * @param {object} deps
 * @param {object} deps.hot        src/hot.js view; `config.gifs.recachePerRun`, `config.media.embedTextChars` read at use.
 * @param {object} deps.store      src/memory/store.js.
 * @param {object} deps.client     The discord.js Client (`user.id`, `channels.fetch`).
 * @param {object} [deps.describer]  From createDescriber(): `watchGif`, `gifWatchBlocker`. Absent -> never runs.
 * @param {() => boolean} [deps.isWarmingUp]  True while the memory warmup runs.
 * @param {object} [deps.log]      src/log.js-shaped logger.
 */
export function createGifRecache({ hot, store, client, describer = null, isWarmingUp = () => false, log = defaultLog }) {
  let running = null;

  /**
   * The GIF's picture item read again from its latest message (Discord
   * attachment URLs expire, a gif embed's animation comes with the embed),
   * under the entry's `itemId`; matched by the entry's key, a link GIF also
   * by its URL (src/memory/gifs.js#matchGifKey's rule). Null when the
   * message or the GIF in it is gone, or the read fails.
   */
  async function pictureOf(entry) {
    if (!entry.messageId || !entry.channelId) return null;
    try {
      const channel = await client.channels.fetch(entry.channelId);
      const message = await channel?.messages?.fetch(entry.messageId);
      if (!message) return null;
      const normalized = normalizeMessage(message, client.user?.id, { embedTextChars: hot.config.media?.embedTextChars, videoSites: hot.config.media?.video?.sites, maxUrlChars: hot.config.context?.maxUrlChars });
      const gifs = collectGifItems(normalized);
      const found =
        gifs.find((gif) => gif.key === entry.itemId || gif.key === entry.key) ??
        (entry.kind === 'link' ? gifs.find((gif) => gif.kind === 'link' && gif.url === entry.url) : null);
      if (!found) return null;
      const picture = collectPictures(normalized).find((item) => item.kind === 'gif' && item.itemId === found.key);
      return picture ? { ...picture, itemId: entry.itemId } : null;
    } catch (err) {
      log.warn('gif-recache: message read failed', { channelId: entry.channelId, error: err });
      return null;
    }
  }

  /** Watch every queued entry in turn; stops on pause, a warmup or a spent rail. */
  async function work(guildId, queue) {
    const counts = { watched: 0, failed: 0 };
    let stopped = null;
    for (const entry of queue) {
      if (store.state?.data?.paused) {
        stopped = 'paused';
        break;
      }
      if (isWarmingUp()) {
        stopped = 'warmup';
        break;
      }
      const item = (await pictureOf(entry)) ?? { itemId: entry.itemId, kind: 'gif' };
      const outcome = await describer.watchGif(guildId, item);
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
   * Start one run for `guildId`: drops the one-frame captions outside the
   * library (oneFrameGifKeys) at once, then watches up to
   * `gifs.recachePerRun` library entries (recacheQueue) in the background.
   * Resolves at once, never throws for a skip: `{ ok: false, reason }` --
   * `running`, `paused`, `warmup`, `unavailable` (no describer), or why GIFs
   * are not watched (`off`, `video-off`, `no-prompt`) -- else `{ ok: true,
   * dropped, queued }`.
   * @param {string} guildId
   */
  function start(guildId) {
    if (running) return { ok: false, reason: 'running' };
    if (store.state?.data?.paused) return { ok: false, reason: 'paused' };
    if (isWarmingUp()) return { ok: false, reason: 'warmup' };
    if (typeof describer?.watchGif !== 'function') return { ok: false, reason: 'unavailable' };
    const blocker = typeof describer.gifWatchBlocker === 'function' ? describer.gifWatchBlocker() : null;
    if (blocker) return { ok: false, reason: blocker };

    const cache = store.getMediaCache(guildId);
    const gifs = store.getGifs(guildId);
    const dropped = oneFrameGifKeys(cache, gifs);
    for (const key of dropped) delete cache[key];
    if (dropped.length > 0) store.markMediaCacheDirty(guildId);

    const perRun = hot.config.gifs?.recachePerRun;
    const limit = Number.isInteger(perRun) && perRun >= 0 ? perRun : DEFAULT_PER_RUN;
    const queue = recacheQueue(gifs, cache, limit);
    log.info('gif-recache: started', { dropped: dropped.length, queued: queue.length });

    running = work(guildId, queue)
      .catch((err) => log.error('gif-recache: failed', { error: err }))
      .finally(() => {
        running = null;
      });
    return { ok: true, dropped: dropped.length, queued: queue.length };
  }

  /** Whether a run is in flight. */
  function isRunning() {
    return running !== null;
  }

  /** Resolves once no run is in flight (`/nep pause` waits on it). */
  async function waitIdle() {
    while (running) await running;
  }

  return { start, isRunning, waitIdle };
}
