// Offline catch-up: the messages posted while the bot was down (a deploy, a restart). The
// gateway never replays them, so without this a member who tagged the persona during a restart
// stays unanswered, and the missed-answer registry (src/behavior/missed.js) cannot help: it only
// knows messages the bot saw.
//
// Once at start, after the gateway is ready and the store is loaded: for every channel the
// store knows (`store.listChannels`, the channels the persona reads) with a last observed message
// (`lastMessageAt`, written live by src/memory/update.js#touchMemory), when Discord says the
// channel has a newer message (its last message id; unknown -> looked at anyway), the newest
// `offlineCatchUp.maxMessages` messages are fetched over REST and those posted after the last one
// the bot saw are kept. All of them, across channels, oldest first and one at a time, go through
// the live message handler (src/behavior/pipeline.js#catchUpMessage): observed into memory like
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

import { log as defaultLog } from '../log.js';
import { MINUTE_MS } from '../time.js';

/** `offlineCatchUp.*` when a key is missing or broken: config.json's values. */
const CATCH_UP_FALLBACK = Object.freeze({ windowMinutes: 15, maxMessages: 50 });
/** Discord serves at most this many messages per fetch. */
const MAX_FETCH = 100;

/**
 * `offlineCatchUp.*` of the live config: `windowMinutes` a finite number >= 0, `maxMessages` an
 * integer from 1 to 100; anything else is config.json's value.
 * @param {object|undefined} config  The whole live config.
 * @returns {{ windowMinutes: number, maxMessages: number }}
 */
export function catchUpSettings(config) {
  const raw = config?.offlineCatchUp ?? {};
  const windowMinutes =
    Number.isFinite(raw.windowMinutes) && raw.windowMinutes >= 0 ? raw.windowMinutes : CATCH_UP_FALLBACK.windowMinutes;
  const maxMessages =
    Number.isInteger(raw.maxMessages) && raw.maxMessages >= 1
      ? Math.min(raw.maxMessages, MAX_FETCH)
      : CATCH_UP_FALLBACK.maxMessages;
  return { windowMinutes, maxMessages };
}

/**
 * The fetched messages of one channel posted after the last one the bot saw, oldest first, each
 * with whether it may still start a turn: younger than `windowMs` at `nowMs`, and no message of
 * the persona after it (she already spoke there since). Pure.
 * @param {{ id: string, createdTimestamp: number, author?: { id?: string } }[]} messages  Any order.
 * @param {{ lastSeenAt: number, nowMs: number, windowMs: number, selfId: string|null }} options
 * @returns {{ message: object, ts: number, trigger: boolean }[]}
 */
export function planChannel(messages, { lastSeenAt, nowMs, windowMs, selfId }) {
  const fresh = (Array.isArray(messages) ? messages : [])
    .filter((message) => message && Number.isFinite(message.createdTimestamp) && message.createdTimestamp > lastSeenAt)
    .sort((a, b) => a.createdTimestamp - b.createdTimestamp || compareIds(a.id, b.id));
  let lastOwn = -1;
  fresh.forEach((message, i) => {
    if (selfId && message.author?.id === selfId) lastOwn = i;
  });
  return fresh.map((message, i) => ({
    message,
    ts: message.createdTimestamp,
    trigger: i > lastOwn && nowMs - message.createdTimestamp <= windowMs,
  }));
}

/** Two snowflake ids in posting order (a shorter id is older). */
function compareIds(a, b) {
  const x = String(a ?? '');
  const y = String(b ?? '');
  return x.length - y.length || (x < y ? -1 : x > y ? 1 : 0);
}

/**
 * @param {object} deps
 * @param {{ config: object }} deps.hot  Read at the moment of use.
 * @param {{ state: { data: object }, listChannels: (guildId: string) => object[] }} deps.store
 * @param {() => string|null} deps.selfId  The persona's user id.
 * @param {(channelId: string) => { available: boolean, latestAt: number|null }} deps.channelInfo
 *   Whether the bot can see the channel now, and the time of its last message as Discord knows
 *   it (null when unknown).
 * @param {(channelId: string, limit: number) => Promise<object[]>} deps.fetchRecent  The newest
 *   `limit` messages of the channel (discord.js messages), any order.
 * @param {(message: object, options: { trigger: boolean }) => Promise<string>} deps.deliver  One
 *   message to the live handler's catch-up path; resolves to its outcome
 *   ('duplicate' | 'ignored' | 'observed' | 'triggered').
 * @param {{ system?: Function }|null} [deps.journal]
 * @param {() => number} [deps.now]
 * @param {object} [deps.log]
 */
export function createOfflineCatchUp({
  hot,
  store,
  selfId,
  channelInfo,
  fetchRecent,
  deliver,
  journal = null,
  now = Date.now,
  log = defaultLog,
}) {
  /**
   * Catch up `guildId` once. Never throws.
   * @returns {Promise<{ channels: object[], failed: number }|null>}  The counts, or null when it did not run.
   */
  async function run(guildId) {
    try {
      const config = hot.config;
      if (config.features?.offlineCatchUp === false) return null;
      if (store?.state?.data?.paused) {
        log.info('catch-up: skipped', { guildId, reason: 'paused' });
        return null;
      }
      const { windowMinutes, maxMessages } = catchUpSettings(config);
      const dryRunChannelId = config.bot?.dryRunChannelId || null;
      const channels = (store.listChannels(guildId) ?? []).filter(
        (channel) => channel?.id && Number.isFinite(channel.lastMessageAt) && channel.id !== dryRunChannelId
      );
      const startedAt = now();
      const self = selfId();
      const planned = [];
      const tallies = new Map();
      let failed = 0;
      for (const channel of channels) {
        let info;
        try {
          info = channelInfo(channel.id) ?? { available: false, latestAt: null };
        } catch {
          info = { available: false, latestAt: null };
        }
        if (!info.available) continue;
        if (Number.isFinite(info.latestAt) && info.latestAt <= channel.lastMessageAt) continue;
        let messages;
        try {
          messages = await fetchRecent(channel.id, maxMessages);
        } catch (err) {
          failed += 1;
          log.warn('catch-up: fetch failed', {
            channelId: channel.id,
            code: err?.code ?? null,
            name: err?.name ?? null,
          });
          continue;
        }
        const items = planChannel(messages, {
          lastSeenAt: channel.lastMessageAt,
          nowMs: startedAt,
          windowMs: windowMinutes * MINUTE_MS,
          selfId: self,
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
      planned.sort((a, b) => a.ts - b.ts || compareIds(a.message.id, b.message.id));
      for (const item of planned) {
        const tally = tallies.get(item.channelId);
        let outcome;
        try {
          outcome = await deliver(item.message, { trigger: item.trigger });
        } catch {
          outcome = 'ignored';
        }
        if (outcome in tally) tally[outcome] += 1;
        else tally.ignored += 1;
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
      if (config.features?.journal === true && typeof journal?.system === 'function') {
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
