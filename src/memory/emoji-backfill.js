// The custom emoji history backfill: the live observer counts members' custom emoji
// only from the lines it sees (src/memory/update.js), so on a server
// with a long history the `<emoji>` block would show the server's first emoji
// in server order until enough lines pass. This reads the last
// `context.customEmoji.backfillMessages` messages of every readable channel
// through the interface's history reads -- no LLM, no token budget -- and counts them into
// guild.json's `emojiUsage` at once (src/memory/emoji-usage.js), starting from
// a cleared ranking, then stamps `emojiBackfill: { at, channels, messages }`
// so it never counts the same history twice. Runs once at startup
// (`startIfNeeded`) and again only on the owner's `/nep emoji rescan` (`run`
// with `force`).

import { emojiUsageOpts } from './emoji-usage.js';
import { lineOf } from '../behavior/line-of.js';
import { isReadable } from '../behavior/snapshot.ts';
import { log as defaultLog } from '../log.js';

/** How many messages one `store.recordEmojiUsage` call takes. */
const CHUNK = 500;

/** Default of `context.customEmoji.backfillMessages` when the key is missing. */
const DEFAULT_BACKFILL_MESSAGES = 500;

/**
 * The newest `limit` messages of every readable conversation of the community `communityId`, read one conversation
 * after another through the interface's `history` (it pages), as lines, without the persona's and other bots'
 * messages. A conversation whose read fails is logged (`<prefix>: channel read failed`) and skipped. The history read
 * of both backfills (this one and src/memory/gif-backfill.js). Null when the interface lists no conversation of the community
 * the persona may read: a backfill clears and recounts, so it never runs over nothing.
 * @param {import('../interface/reads.ts').Reads} reads
 * @param {string} communityId
 * @param {number} limit
 * @param {{ config: object, iface: string, log?: object, prefix: string }} deps  `config` is the live config (`bot`).
 * @returns {Promise<{ channels: number, messages: object[] }|null>}  `messages` as lines, in read order.
 */
export async function readMemberHistory(reads, communityId, limit, { config, iface, log = defaultLog, prefix }) {
  const listing = await reads.conversations({ communityId });
  if (listing === null) return null;
  const channels = listing.conversations.filter((entry) => isReadable(entry, config.bot));
  if (channels.length === 0) return null;
  const messages = [];
  for (const channel of channels) {
    const found = await reads.history({ iface, conversationId: channel.id }, { limit });
    if (found === null) {
      log.warn(`${prefix}: channel read failed`, { channelId: channel.id });
      continue;
    }
    for (const event of found.events) {
      const line = lineOf(event);
      if (!line.self && !line.bot) messages.push(line);
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
 * @param {import('../interface/reads.ts').Reads} deps.reads  The core's reads of the interface (readMemberHistory's).
 * @param {() => string} deps.iface  The interface's name, read when a run starts.
 * @param {object} [deps.log]   src/log.js-shaped logger.
 */
export function createEmojiBackfill({ hot, store, reads, iface, log = defaultLog }) {
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
   * Channels are read one after another (readMemberHistory). Messages of bots and of the persona are skipped, as are those
   * still in the analyzer buffer (the analyzer counts them when it consumes
   * them). Clearing, counting and stamping happen together after every
   * channel is read. Skips (never throws) when paused, when
   * `backfillMessages` is 0, when already stamped (no `force`), while another
   * run is in flight, or when the interface lists no readable conversation of the community; an
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
      const history = await readMemberHistory(reads, guildId, limit, {
        config: hot.config,
        iface: iface(),
        log,
        prefix: 'emoji-backfill',
      });
      if (history === null) return skipped('no-guild');
      const channels = history.channels;
      const collected = history.messages.map((message) => ({
        id: message.id,
        ts: message.ts,
        emojis: message.emojis ?? [],
      }));

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
