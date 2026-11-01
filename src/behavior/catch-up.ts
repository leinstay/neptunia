// Offline catch-up: the messages posted while the bot was down (a deploy, a restart). The
// gateway never replays them, so without this a member who tagged the persona during a restart
// stays unanswered, and the missed-answer registry (src/behavior/missed.ts) cannot help: it only
// knows messages the bot saw.
//
// Once at start, after the interface is connected and the store is loaded: for every channel the
// store knows (`store.listChannels`, the channels the persona reads) with a last observed message
// (`lastMessageAt`, written live by src/memory/update.ts#touchMemory), when the interface says the
// conversation has a newer message (`conversationInfo`'s `lastMessageAt`; unknown -> looked at anyway), the newest
// `offlineCatchUp.maxMessages` messages are read through `history` (whole `message.received` events) and those
// posted after the last one the bot saw are kept. All of them, across channels, oldest first and one at a time, go through
// the live message handler (src/pipeline/handle-message.ts#catchUpMessage): observed into memory like
// live messages, and the ones that would have started a turn live -- a mention, a reply to the
// persona, her name, by the live trigger classification -- take the ordinary call path when they
// are younger than `offlineCatchUp.windowMinutes` and the persona did not post in that channel
// after them. Older ones are only observed: a long outage never brings replies to stale chatter.
// A message the gateway also delivers is handled once (the handler keeps both paths' ids).
//
// Off with `features.offlineCatchUp` false (a missing key counts as on), while paused, and with
// no channel to look at. A failed channel is logged and skipped; nothing here ever throws or
// holds the start up. The counts per channel go to the log and, with the journal on, to one
// `system` record (`event: 'catch-up'`). Logs carry ids and counts, never message contents.

import { log as defaultLog } from '../log.ts';
import { MINUTE_MS } from '../time.ts';
import { isReadable } from './snapshot.ts';
import { isFiniteNumber } from '../tools/types.ts';
import type { Untyped } from '../tools/types.ts';
import type { Logger } from '../protocol/serve.ts';

/** What the catch-up counted for one conversation. */
type Tally = {
  channelId: string;
  fetched: number;
  observed: number;
  triggered: number;
  duplicate: number;
  ignored: number;
};
import type { MessageEvent } from '../protocol/adapter.ts';
import type { Reads } from '../interface/reads.ts';

/** `offlineCatchUp.*` when a key is missing or broken: config.json's values. */
const CATCH_UP_FALLBACK = Object.freeze({ windowMinutes: 15, maxMessages: 50 });
/** The most messages one conversation's catch-up reads. */
const MAX_FETCH = 100;

/**
 * `offlineCatchUp.*` of the live config: `windowMinutes` a finite number >= 0, `maxMessages` an
 * integer from 1 to 100; anything else is config.json's value.
 * @param config  The whole live config.
 */
export function catchUpSettings(config: Record<string, Untyped> | undefined): {
  windowMinutes: number;
  maxMessages: number;
} {
  const raw: Record<string, unknown> = config?.offlineCatchUp ?? {};
  const windowMinutes =
    isFiniteNumber(raw.windowMinutes) && raw.windowMinutes >= 0 ? raw.windowMinutes : CATCH_UP_FALLBACK.windowMinutes;
  const maxMessages =
    isFiniteNumber(raw.maxMessages) && Number.isInteger(raw.maxMessages) && raw.maxMessages >= 1
      ? Math.min(raw.maxMessages, MAX_FETCH)
      : CATCH_UP_FALLBACK.maxMessages;
  return { windowMinutes, maxMessages };
}

/**
 * The events of one conversation posted after the last message the bot saw, oldest first, each with whether it may
 * still start a turn: younger than `windowMs` at `nowMs`, and no message of the persona after it (she already spoke
 * there since). The events are the interface's own; their time and author are theirs. Pure.
 * @param events  Any order.
 */
export function planChannel(
  events: Array<MessageEvent>,
  { lastSeenAt, nowMs, windowMs }: { lastSeenAt: number; nowMs: number; windowMs: number }
): Array<{ event: MessageEvent; ts: number; trigger: boolean }> {
  const atOf = (event: MessageEvent): number => event?.message?.at ?? Number.NaN;
  const fresh = (Array.isArray(events) ? events : [])
    .filter((event) => Number.isFinite(atOf(event)) && atOf(event) > lastSeenAt)
    .sort((a, b) => atOf(a) - atOf(b) || compareIds(a.message.id, b.message.id));
  let lastOwn = -1;
  fresh.forEach((event, i) => {
    if (event.message.author?.self === true) lastOwn = i;
  });
  return fresh.map((event, i) => ({
    event,
    ts: atOf(event),
    trigger: i > lastOwn && nowMs - atOf(event) <= windowMs,
  }));
}

/** Two message ids at the same moment in a stable order: a shorter id first, then by their characters. */
function compareIds(a: Untyped, b: Untyped) {
  const x = String(a ?? '');
  const y = String(b ?? '');
  return x.length - y.length || (x < y ? -1 : x > y ? 1 : 0);
}

/**
 * @param deps.hot  Read at the moment of use.
 * @param deps.iface  The interface's name.
 * @param deps.reads  The core's reads: `conversationInfo` says whether the bot
 *   can read the conversation now and the time of its newest message (null when unknown), `history` gives its newest
 *   `maxMessages` events.
 * @param deps.deliver  One
 *   event to the live handler's catch-up path; resolves to its outcome
 *   ('duplicate' | 'ignored' | 'observed' | 'triggered').
 */
export function createOfflineCatchUp({
  hot,
  store,
  iface,
  reads,
  deliver,
  journal = null,
  now = Date.now,
  log = defaultLog,
}: {
  hot: { config: Untyped };
  store: {
    state: { data: Untyped };
    listChannels: (guildId: string) => Array<object>;
  };
  iface: string;
  reads: Reads;
  deliver: (event: MessageEvent, options: { trigger: boolean }) => Promise<string>;
  journal?: { system?: (...args: Array<Untyped>) => Untyped } | null;
  now?: () => number;
  log?: Logger;
}): { run: (guildId: string) => Promise<{ channels: Array<Record<string, Untyped>>; failed: number } | null> } {
  /**
   * Catch up `guildId` once. Never throws.
   * @returns The counts, or null when it did not run.
   */
  async function run(guildId: string): Promise<{ channels: Array<Record<string, Untyped>>; failed: number } | null> {
    try {
      const config = hot.config;
      if (store?.state?.data?.paused) {
        log.info('catch-up: skipped', { guildId, reason: 'paused' });
        return null;
      }
      const { windowMinutes, maxMessages } = catchUpSettings(config);
      // The store answers its channels as plain objects; they are the stored channels.
      const listed = (store.listChannels(guildId) ?? []) as Array<{ id?: string; lastMessageAt?: unknown }>;
      const channels = listed.filter(
        (channel): channel is { id: string; lastMessageAt: number } =>
          Boolean(channel?.id) && isFiniteNumber(channel.lastMessageAt)
      );
      const startedAt = now();
      const planned = [];
      const tallies = new Map<string, Tally>();
      let failed = 0;
      for (const channel of channels) {
        const ref = { iface, conversationId: channel.id };
        const info = (await reads.conversationInfo(ref))?.conversation ?? null;
        if (info === null || !isReadable(info)) continue;
        if (
          typeof info.lastMessageAt === 'number' &&
          Number.isFinite(info.lastMessageAt) &&
          info.lastMessageAt <= channel.lastMessageAt
        )
          continue;
        const page = await reads.history(ref, { limit: maxMessages });
        if (page === null) {
          failed += 1;
          log.warn('catch-up: fetch failed', { channelId: channel.id });
          continue;
        }
        const items = planChannel(page.events, {
          lastSeenAt: channel.lastMessageAt,
          nowMs: startedAt,
          windowMs: windowMinutes * MINUTE_MS,
        });
        if (items.length === 0) continue;
        tallies.set(channel.id, {
          channelId: channel.id,
          fetched: items.length,
          observed: 0,
          triggered: 0,
          duplicate: 0,
          ignored: 0,
        });
        for (const item of items) planned.push({ ...item, channelId: channel.id });
      }
      planned.sort((a, b) => a.ts - b.ts || compareIds(a.event.message.id, b.event.message.id));
      for (const item of planned) {
        const tally = tallies.get(item.channelId) as Tally; // every planned item came from a channel tallied above
        let outcome: string;
        try {
          outcome = await deliver(item.event, { trigger: item.trigger });
        } catch {
          outcome = 'ignored';
        }
        // An outcome of the live handler that the tally names counts as itself, any other as ignored.
        if (outcome in tally) {
          const byName = tally as Record<string, unknown>;
          byName[outcome] = Number(byName[outcome]) + 1;
        } else tally.ignored += 1;
      }
      const counts = [...tallies.values()];
      for (const tally of counts) log.info('catch-up: channel', tally);
      log.info('catch-up: done', {
        guildId,
        channels: counts.length,
        messages: planned.length,
        triggered: counts.reduce((sum, tally) => sum + tally.triggered, 0),
        failed,
      });
      if (typeof journal?.system === 'function') {
        await journal.system(guildId, { event: 'catch-up', by: 'service', channels: counts, failed });
      }
      return { channels: counts, failed };
    } catch (err) {
      log.error('catch-up: failed', { guildId, error: err });
      return null;
    }
  }

  return { run };
}
