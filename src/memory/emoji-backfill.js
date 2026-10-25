// The custom emoji history backfill: the live observer counts members' custom emoji
// only from the lines it sees (src/memory/update.js), so on a server
// with a long history the `<emoji>` block would show the server's first emoji
// in server order until enough lines pass. This reads the last
// `context.customEmoji.backfillMessages` messages of every readable channel
// over the Discord API -- no LLM, no token budget -- and counts them into
// guild.json's `emojiUsage` at once (src/memory/emoji-usage.js), starting from
// a cleared ranking, then stamps `emojiBackfill: { at, channels, messages }`
// so it never counts the same history twice. Runs once at startup
// (`startIfNeeded`) and again only on the owner's `/nep emoji rescan` (`run`
// with `force`).

import { emojiUsageOpts } from './emoji-usage.js';
import { log as defaultLog } from '../log.js';

/** How many messages one `store.recordEmojiUsage` call takes. */
const CHUNK = 500;

/** Default of `context.customEmoji.backfillMessages` when the key is missing. */
const DEFAULT_BACKFILL_MESSAGES = 500;

/**
 * The newest `limit` messages of every readable channel of `guild`, read one channel after
 * another over the Discord API (interfaces/discord/collect.js#fetchHistoryWindow, 100 per page;
 * discord.js waits out rate limits), without the persona's and other bots' messages. A channel
 * whose read fails is logged (`<prefix>: channel read failed`) and skipped. The history read
 * of both backfills (this one and src/memory/gif-backfill.js).
 * @param {object} guild  A discord.js Guild.
 * @param {number} limit
 * @param {{ config: object, discord: object, selfId?: string, log?: object, prefix: string }} deps
 *   `config` is the live config (`bot`, `media.embedTextChars`, `media.video.sites`); `discord` the
 *   Discord interface's capabilities object (`readableChannels`, `fetchHistoryWindow`), passed by
 *   the caller.
 * @returns {Promise<{ channels: number, messages: object[] }>}  `messages` normalized, in read order.
 */
export async function readMemberHistory(guild, limit, { config, discord, selfId, log = defaultLog, prefix }) {
  const { readableChannels, fetchHistoryWindow } = discord;
  const channels = readableChannels(guild, config.bot);
  const messages = [];
  for (const channel of channels) {
    let window = [];
    try {
      window = await fetchHistoryWindow(channel, {
        limit,
        minTs: 0,
        selfId,
        embedTextChars: config.media?.embedTextChars,
        videoSites: config.media?.video?.sites,
        maxUrlChars: config.context?.maxUrlChars,
      });
    } catch (err) {
      log.warn(`${prefix}: channel read failed`, { channelId: channel.id, error: err });
    }
    for (const message of window) {
      if (!message.self && !message.bot) messages.push(message);
    }
  }
  return { channels: channels.length, messages };
}

/**
 * The emoji history backfill for the served guild.
 * @param {object} deps
 * @param {object} deps.hot     src/hot.js view; `config.context.customEmoji`, `config.bot`,
 *   `config.media.embedTextChars`, `config.features.customEmoji` read at use.
 * @param {object} deps.store   src/memory/store.js.
 * @param {object} deps.client  The discord.js Client (`user.id`, `guilds.cache`).
 * @param {object} deps.discord  The Discord interface's capabilities object (src/index.js injects it): readMemberHistory's reads.
 * @param {object} [deps.log]   src/log.js-shaped logger.
 */
export function createEmojiBackfill({ hot, store, client, discord, log = defaultLog }) {
  let running = false;

  function skipped(reason) {
    log.info('emoji-backfill: skipped', { reason });
    return { ok: false, reason };
  }

  /**
   * Read the history and rebuild `emojiUsage` from it. Every run that goes
   * ahead CLEARS `emojiUsage` and recounts it from the history window alone:
   * the window already holds the messages the analyzer counted since the
   * feature went live, so adding on top would count them twice (counts the
   * analyzer added for messages older than the window are dropped). Without
   * `force` that happens only on the first run -- it is a no-op once
   * `emojiBackfill.at` is set (the startup run). With `force` it ignores the
   * stamp: the owner's explicit `/nep emoji rescan`.
   * Channels are read one after another, 100 messages per page (see
   * interfaces/discord/collect.js#fetchHistoryWindow; discord.js waits out rate
   * limits). Messages of bots and of the persona are skipped, as are those
   * still in the analyzer buffer (the analyzer counts them when it consumes
   * them). Clearing, counting and stamping happen together after every
   * channel is read. Skips (never throws) when paused, when
   * `backfillMessages` is 0, when already stamped (no `force`), while another
   * run is in flight, or when the guild is not in the client's cache; an
   * unexpected error is thrown.
   * @param {string} guildId
   * @param {{ force?: boolean }} [opts]
   * @returns {Promise<{ ok: true, channels: number, messages: number, emoji: number } | { ok: false, reason: string }>}
   */
  async function run(guildId, { force = false } = {}) {
    if (running) return skipped('running');
    if (store.state?.data?.paused) return skipped('paused');
    const limit = hot.config.context?.customEmoji?.backfillMessages ?? DEFAULT_BACKFILL_MESSAGES;
    if (!Number.isInteger(limit) || limit <= 0) return skipped('disabled');
    if (!force && store.getGuild(guildId).emojiBackfill?.at) return skipped('done');

    running = true;
    try {
      const guild = client.guilds.cache.get(guildId);
      if (!guild) return skipped('no-guild');

      const history = await readMemberHistory(guild, limit, { config: hot.config, discord, selfId: client.user?.id, log, prefix: 'emoji-backfill' });
      const channels = history.channels;
      const collected = history.messages.map((message) => ({ id: message.id, ts: message.ts, emojis: message.emojis ?? [] }));

      if (store.state?.data?.paused) return skipped('paused');
      const members = [...collected].sort((a, b) => a.ts - b.ts);
      const opts = emojiUsageOpts(hot.config);

      // Always from a cleared ranking: the window already holds what the live counting counted so far.
      store.clearEmojiUsage(guildId);
      let emoji = 0;
      for (let i = 0; i < members.length; i += CHUNK) {
        emoji += store.recordEmojiUsage(guildId, members.slice(i, i + CHUNK), opts);
      }
      store.setEmojiBackfill(guildId, { at: new Date().toISOString(), channels, messages: members.length });
      store.flush();

      const counts = { channels, messages: members.length, emoji };
      log.info('emoji-backfill: done', counts);
      return { ok: true, ...counts };
    } finally {
      running = false;
    }
  }

  /**
   * The startup run: once, when `features.customEmoji` is on (a missing key
   * counts as on) and the guild has no `emojiBackfill` stamp yet. Meant to be
   * called without awaiting; resolves either way, errors are logged, never thrown.
   * @param {string} guildId
   * @returns {Promise<void>}
   */
  async function startIfNeeded(guildId) {
    try {
      if (hot.config.features?.customEmoji === false) {
        skipped('feature-off');
        return;
      }
      await run(guildId);
    } catch (err) {
      log.error('emoji-backfill: failed', { error: err });
    }
  }

  /** Whether a backfill is reading history right now. */
  function isRunning() {
    return running;
  }

  return { run, startIfNeeded, isRunning };
}
