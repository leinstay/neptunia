// The custom emoji history backfill: the live observer counts members' custom emoji
// only from the lines it sees (src/memory/update.ts), so on a server
// with a long history the `<emoji>` block would show the server's first emoji
// in server order until enough lines pass. This reads the last
// `BACKFILL_MESSAGES` messages of every readable channel
// through the interface's history reads -- no LLM, no token budget -- and counts them into
// place.json's `emojiUsage` at once (src/memory/emoji-usage.ts), starting from
// a cleared ranking, then stamps `emojiBackfill: { at, channels, messages }`
// so it never counts the same history twice. Runs once at startup
// (`startIfNeeded`) and again only on the owner's `/nep emoji rescan` (`run`
// with `force`).

import { emojiUsageOpts } from './emoji-usage.ts';
import { lineOf } from '../behavior/line-of.ts';
import { isReadable } from '../behavior/snapshot.ts';
import { log as defaultLog } from '../log.ts';
import type { Reads } from '../interface/reads.ts';
import type { StoreView } from './store.ts';
import type { Log, StoredRecord } from './types.ts';

/** How many messages one `store.recordEmojiUsage` call takes. */
const CHUNK = 500;

/** The messages read per channel. Production value, config cut of 2026-10-31. */
const BACKFILL_MESSAGES = 500;

/**
 * The newest `limit` messages of every readable chat of the root `placeId`, read one chat
 * after another through the interface's `history` (it pages), as lines, without the persona's and other bots'
 * messages. A chat whose read fails is logged (`<prefix>: channel read failed`) and skipped. The history read
 * of both backfills (this one and src/memory/gif-backfill.ts). Null when the interface lists no chat of the root
 * the persona may read: a backfill clears and recounts, so it never runs over nothing.
 * @returns `messages` as lines, in read order.
 */
export async function readMemberHistory(
  reads: Reads,
  placeId: string,
  limit: number,
  { iface, log = defaultLog, prefix }: { iface: string; log?: Log; prefix: string }
): Promise<{ channels: number; messages: Array<StoredRecord> } | null> {
  const listing = await reads.chats({ placeId });
  if (listing === null) return null;
  const channels = listing.chats.filter((entry) => isReadable(entry));
  if (channels.length === 0) return null;
  const messages: Array<StoredRecord> = [];
  for (const channel of channels) {
    const found = await reads.history({ iface, chatId: channel.id }, { limit });
    if (found === null) {
      log.warn(`${prefix}: channel read failed`, { placeId: channel.id });
      continue;
    }
    for (const event of found.events) {
      const line = lineOf(event);
      if (!line.self && !line.bot) messages.push(line);
    }
  }
  return { channels: channels.length, messages };
}

function buildEmojiBackfill({
  store,
  reads,
  iface,
  log = defaultLog,
}: {
  store: StoreView;
  reads: Reads;
  iface: () => string;
  log?: Log;
}) {
  let running = false;

  /** Whether the bot is paused (`/nep pause`), read at each step. */
  function isPaused() {
    const stateData = store.state?.data;
    return Boolean(stateData?.paused);
  }

  function skipped(reason: string): { ok: false; reason: string } {
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
   * channel is read. Skips (never throws) when paused, when already stamped (no `force`), while another
   * run is in flight, or when the interface lists no readable chat of the root; an
   * unexpected error is thrown.
   */
  async function run(
    placeId: string,
    { force = false }: { force?: boolean } = {}
  ): Promise<{ ok: true; channels: number; messages: number; emoji: number } | { ok: false; reason: string }> {
    if (running) return skipped('running');
    if (isPaused()) return skipped('paused');
    if (!force && store.getPlace(placeId).emojiBackfill?.at) return skipped('done');

    running = true;
    try {
      const history = await readMemberHistory(reads, placeId, BACKFILL_MESSAGES, {
        iface: iface(),
        log,
        prefix: 'emoji-backfill',
      });
      if (history === null) return skipped('no-place');
      const channels = history.channels;
      const collected = history.messages.map((message) => ({
        id: message.id,
        ts: message.ts,
        emojis: message.emojis ?? [],
      }));

      if (isPaused()) return skipped('paused');
      const members = [...collected].sort((a, b) => a.ts - b.ts);
      const opts = emojiUsageOpts();

      // Always from a cleared ranking: the window already holds what the live counting counted so far.
      store.clearEmojiUsage(placeId);
      let emoji = 0;
      for (let i = 0; i < members.length; i += CHUNK) {
        emoji += store.recordEmojiUsage(placeId, members.slice(i, i + CHUNK), opts);
      }
      store.setEmojiBackfill(placeId, { at: new Date().toISOString(), channels, messages: members.length });
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
   * counts as on) and the place has no `emojiBackfill` stamp yet. Meant to be
   * called without awaiting; resolves either way, errors are logged, never thrown.
   */
  async function startIfNeeded(placeId: string): Promise<void> {
    try {
      await run(placeId);
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

export type EmojiBackfill = ReturnType<typeof buildEmojiBackfill>;

/**
 * The emoji history backfill for the served place.
 * @param deps.store   src/memory/store.ts.
 * @param deps.reads  The core's reads of the interface (readMemberHistory's).
 * @param deps.iface  The interface's name, read when a run starts.
 * @param [deps.log]   src/log.js-shaped logger.
 */
export function createEmojiBackfill(deps: Parameters<typeof buildEmojiBackfill>[0]): EmojiBackfill {
  return buildEmojiBackfill(deps);
}
