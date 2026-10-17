// The GIF library history backfill: members' GIFs are recorded as they arrive
// (src/memory/update.js), so on a server with a long history the `<gifs>`
// block would stay empty until enough GIFs are posted again. This reads the
// last `gifs.backfillMessages` messages of every readable channel over the
// Discord API -- no LLM for the counting, no token budget -- and counts them
// into gifs.json at once (src/memory/gifs.js), starting from counts reset to
// 0 (entries and handles kept, so a GIF keeps its handle across a recount),
// then stamps `backfill: { at, channels, messages }` so it never
// counts the same history twice. The top `gifs.backfillDescribe` GIFs without
// a cached caption are then sent to the media describer (real requests,
// counted against the daily cap), so the list the persona picks from says
// what each GIF shows. Runs once at startup (`startIfNeeded`) and again only
// on the owner's `/nep gifs rescan` (`run` with `force`).

import { collectPictures } from '../media/classify.js';
import { readMemberHistory } from './emoji-backfill.js';
import { gifOpts, rankGifs } from './gifs.js';
import { log as defaultLog } from '../log.js';

/** How many messages one `store.recordGifs` call takes. */
const CHUNK = 500;

/** Defaults of `gifs.*` when a key is missing (config.json carries the same). */
const DEFAULT_BACKFILL_MESSAGES = 500;
const DEFAULT_BACKFILL_DESCRIBE = 20;

/**
 * The GIF history backfill for the served guild.
 * @param {object} deps
 * @param {object} deps.hot        src/hot.js view; `config.gifs`, `config.bot`,
 *   `config.media.embedTextChars`, `config.features.gifs` read at use.
 * @param {object} deps.store      src/memory/store.js.
 * @param {object} deps.client     The discord.js Client (`user.id`, `guilds.cache`).
 * @param {object} [deps.describer]  From createDescriber() (src/memory/describe.js): `describeMany`.
 *   Absent -> nothing is described.
 * @param {object} [deps.log]      src/log.js-shaped logger.
 */
export function createGifBackfill({ hot, store, client, describer = null, log = defaultLog }) {
  let running = false;

  function skipped(reason) {
    log.info('gif-backfill: skipped', { reason });
    return { ok: false, reason };
  }

  /**
   * Describe the top `limit` library entries (rank order) that have no
   * cached caption: one describer item per entry -- the GIF's picture item
   * read this run (src/media/classify.js#collectPictures: an attachment's
   * file, an embed's thumbnail and its animation, so the describer can watch
   * it), under the entry's `itemId`; an entry without one is skipped.
   * Returns how many got a caption.
   */
  async function describeTop(guildId, pictures, limit) {
    if (!describer || typeof describer.describeMany !== 'function' || limit <= 0) return 0;
    const cache = store.getMediaCache(guildId);
    const items = [];
    for (const entry of rankGifs(store.getGifs(guildId), gifOpts(hot.config).halfLifeDays)) {
      if (items.length >= limit) break;
      const cached = cache?.[entry.itemId];
      if (cached && !cached.miss && typeof cached.text === 'string' && cached.text.trim()) continue;
      const picture = pictures.get(entry.itemId);
      if (!picture) continue;
      items.push({ ...picture, itemId: entry.itemId, kind: 'gif', name: entry.name ?? '' });
    }
    if (items.length === 0) return 0;
    // One at a time, as a background job should: a GIF watch converts with ffmpeg.
    const { descriptions } = await describer.describeMany(guildId, items, { concurrency: 1 });
    return descriptions.size;
  }

  /**
   * Read the history and recount the library from it. Every run that goes
   * ahead RESETS every entry's count to 0 and recounts from the history
   * window alone: the window already holds the GIFs recorded on arrival
   * since the feature went live, so adding on top would count them twice.
   * Without `force` that happens only on the first run -- it is a no-op once
   * `backfill.at` is set (the startup run). With `force` it ignores the
   * stamp: the owner's explicit `/nep gifs rescan`. Entries survive the
   * reset, so a GIF seen again keeps its handle; one no longer in the window
   * stays at count 0, ranked below every counted one, until `storeMax`
   * evicts it (src/memory/gifs.js#rankGifs). Handles are never reused.
   * Channels are read one after another, 100 messages per page (see
   * interfaces/discord/collect.js#fetchHistoryWindow). Messages of bots and of the
   * persona are skipped. Resetting, counting and stamping happen together
   * after every channel is read; the describing comes after, and only while
   * not paused. Skips (never throws) when paused, when `backfillMessages` is
   * 0, when already stamped (no `force`), while another run is in flight, or
   * when the guild is not in the client's cache; an unexpected error is thrown.
   * @param {string} guildId
   * @param {{ force?: boolean }} [opts]
   * @returns {Promise<{ ok: true, channels: number, messages: number, gifs: number, described: number }
   *   | { ok: false, reason: string }>}
   */
  async function run(guildId, { force = false } = {}) {
    if (running) return skipped('running');
    if (store.state?.data?.paused) return skipped('paused');
    const limit = hot.config.gifs?.backfillMessages ?? DEFAULT_BACKFILL_MESSAGES;
    if (!Number.isInteger(limit) || limit <= 0) return skipped('disabled');
    if (!force && store.getGifs(guildId).backfill?.at) return skipped('done');

    running = true;
    try {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) return skipped('no-guild');

      const { channels, messages: collected } = await readMemberHistory(guild, limit, { config: hot.config, selfId: client.user?.id, log, prefix: 'gif-backfill' });

      // From here on nothing awaits until the stamp: no GIF can be recorded in between.
      if (store.state?.data?.paused) return skipped('paused');
      const members = collected.sort((a, b) => a.ts - b.ts);
      const gifCfg = hot.config.gifs ?? {};
      const opts = gifOpts(hot.config);

      // Always from zero counts: the window already holds what was recorded on arrival.
      store.resetGifCounts(guildId);
      let gifs = 0;
      for (let i = 0; i < members.length; i += CHUNK) {
        gifs += store.recordGifs(guildId, members.slice(i, i + CHUNK), opts);
      }
      store.setGifBackfill(guildId, { at: new Date().toISOString(), channels, messages: members.length });
      store.flush();

      // The picture item to describe per GIF: an attachment's file, an embed's thumbnail and animation.
      const pictures = new Map();
      for (const message of members) {
        for (const picture of collectPictures(message)) {
          if (picture.kind === 'gif' && picture.url && !pictures.has(picture.itemId)) pictures.set(picture.itemId, picture);
        }
      }
      const describeLimit = gifCfg.backfillDescribe ?? DEFAULT_BACKFILL_DESCRIBE;
      const described =
        store.state?.data?.paused || !Number.isInteger(describeLimit) ? 0 : await describeTop(guildId, pictures, describeLimit);
      if (described > 0) store.flush();

      const counts = { channels, messages: members.length, gifs, described };
      log.info('gif-backfill: done', counts);
      return { ok: true, ...counts };
    } finally {
      running = false;
    }
  }

  /**
   * The startup run: once, when `features.gifs` is on (a missing key counts
   * as on) and the library has no `backfill` stamp yet. Meant to be called
   * without awaiting; resolves either way, errors are logged, never thrown.
   * @param {string} guildId
   * @returns {Promise<void>}
   */
  async function startIfNeeded(guildId) {
    try {
      if (hot.config.features?.gifs === false) {
        skipped('feature-off');
        return;
      }
      await run(guildId);
    } catch (err) {
      log.error('gif-backfill: failed', { error: err });
    }
  }

  /** Whether a backfill is reading history (or describing) right now. */
  function isRunning() {
    return running;
  }

  return { run, startIfNeeded, isRunning };
}
