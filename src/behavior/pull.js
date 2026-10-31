// The pure core of the pulled channel block (`<channel_view>`). A turn
// sometimes needs another channel than the one it speaks in: the read-only
// channel a call came from, a channel someone named with an explicit <#id>
// in the recent messages, or one a route hook names. Without it the persona
// would be asked about a channel it cannot see. This module decides which
// channels a turn pulls, which of their messages are shown -- a window that
// ENDS at the channel's newest message however old it is (a channel last
// written in two days ago at 10:00 shows 9:00-10:00 of that day),
// at least a few messages, at most a ceiling -- and which of their pictures
// may get a fresh caption and which only a cached one. It also reads the
// `context.pull` settings and the `features.channelPull` switch, so their
// fallbacks exist once. No I/O, no platform SDK: callers pass plain normalized
// messages and the clock.

import { collectEmojiItems, collectPictures, isDescribable } from '../media/classify.js';
import { DAY_MS, MINUTE_MS } from '../time.js';

/**
 * Defaults of the `context.pull` config block (config.json carries the same
 * values). `maxAgeDays` 0 means no age limit: the window ends at the
 * channel's last message whatever its age.
 */
export const PULL_DEFAULTS = Object.freeze({
  windowMinutes: 60,
  minMessages: 5,
  maxMessages: 60,
  maxPictures: 10,
  maxNewDescriptions: 8,
  describeTimeoutMs: 15000,
  scanMessages: 20,
  maxChannels: 1,
  maxAgeDays: 0,
  sameAudience: true,
  seenTtlMinutes: 120,
  keepMinutes: 10,
  keepTurns: 3,
});

/** An integer from a finite `value` of at least `min` (floored), else `fallback`. */
function intAtLeast(value, fallback, min) {
  return Number.isFinite(value) && value >= min ? Math.floor(value) : fallback;
}

/** A finite `value` of at least `min`, else `fallback`. */
function numberAtLeast(value, fallback, min) {
  return Number.isFinite(value) && value >= min ? value : fallback;
}

/**
 * The `context.pull` settings read from the live config, each falling back to
 * its default (PULL_DEFAULTS) when missing or unusable. Counts are floored;
 * `maxChannels` 0 leaves a turn its source alone, `maxAgeDays` 0 is no age
 * limit; only `false` turns `sameAudience` off.
 * @param {object} config  The live config.
 * @returns {{ windowMinutes: number, minMessages: number, maxMessages: number, maxPictures: number,
 *   maxNewDescriptions: number, describeTimeoutMs: number, scanMessages: number, maxChannels: number,
 *   maxAgeDays: number, sameAudience: boolean, seenTtlMinutes: number, keepMinutes: number, keepTurns: number }}
 */
export function pullSettings(config) {
  const p = config?.context?.pull ?? {};
  const d = PULL_DEFAULTS;
  return {
    windowMinutes: numberAtLeast(p.windowMinutes, d.windowMinutes, 0),
    minMessages: intAtLeast(p.minMessages, d.minMessages, 0),
    maxMessages: intAtLeast(p.maxMessages, d.maxMessages, 1),
    maxPictures: intAtLeast(p.maxPictures, d.maxPictures, 0),
    maxNewDescriptions: intAtLeast(p.maxNewDescriptions, d.maxNewDescriptions, 0),
    describeTimeoutMs: intAtLeast(p.describeTimeoutMs, d.describeTimeoutMs, 0),
    scanMessages: intAtLeast(p.scanMessages, d.scanMessages, 0),
    maxChannels: intAtLeast(p.maxChannels, d.maxChannels, 0),
    maxAgeDays: numberAtLeast(p.maxAgeDays, d.maxAgeDays, 0),
    sameAudience: p.sameAudience !== false,
    seenTtlMinutes: numberAtLeast(p.seenTtlMinutes, d.seenTtlMinutes, 0),
    keepMinutes: numberAtLeast(p.keepMinutes, d.keepMinutes, 0),
    keepTurns: intAtLeast(p.keepTurns, d.keepTurns, 0),
  };
}

/**
 * `features.channelPull` (a missing key counts as on): whether an explicit
 * `<#id>` or a route hook id pulls a channel. A turn's own source (a routed
 * call, a noticed comment) is pulled regardless: that is `features.elsewhere`.
 * @param {object} config  The live config.
 * @returns {boolean}
 */
export function channelPullOn(config) {
  return config?.features?.channelPull !== false;
}

/**
 * The channel ids written as explicit `<#id>` mentions in `messages`
 * (each message's `mentionedChannelIds`), newest message first, each id
 * once; within one message its own order is kept. Missing entries and
 * messages without the list are skipped; only non-empty string ids count.
 * @param {object[]} messages  Normalized messages, oldest first.
 * @returns {string[]}
 */
export function explicitChannelIds(messages) {
  const list = Array.isArray(messages) ? messages : [];
  const out = [];
  const seen = new Set();
  for (let i = list.length - 1; i >= 0; i -= 1) {
    const ids = list[i]?.mentionedChannelIds;
    if (!Array.isArray(ids)) continue;
    for (const id of ids) {
      if (typeof id !== 'string' || !id || seen.has(id)) continue;
      seen.add(id);
      out.push(id);
    }
  }
  return out;
}

/**
 * @typedef {object} PullTarget
 * @property {string} channelId
 * @property {'routed'|'noticed'|'mention'|'route'|'kept'} reason  The source's own reason, `mention` for an
 *   explicit `<#id>`, `route` for a route hook id.
 */

/**
 * The channels a turn pulls, in priority order:
 * 1. the turn's `source` (a routed call or a noticed comment), always kept
 *    and counted toward `maxChannels` -- it is what the turn is about, so it
 *    stays even when `maxChannels` leaves no slot (with `maxChannels` 0 the
 *    result is the source alone, one entry over the setting), and
 *    `isPullable` does not judge it (the caller chose it). A source equal to
 *    `currentChannelId` is dropped: that channel is the chat itself, a view
 *    of it would repeat the chat, and its slot goes to the next candidate;
 * 2. explicit `<#id>` mentions in the trigger (always) and in the members'
 *    lines among the last `scanMessages` messages of `history` -- another
 *    bot's line or the persona's own in that span never pulls but still uses
 *    up its place in the span; the trigger is scanned once, as the newest,
 *    and not counted among them -- newest mention first;
 * 3. `extra` ids (the route hook's: src/behavior/route-channel.js, wired in
 *    src/index.js), reason `route`;
 * 4. `kept` ids (the channels an earlier turn of the same exchange pulled and the
 *    exchange still keeps: turn.js#keptPullIds), reason `kept`.
 * Mentions and route ids fill the slots the source leaves, up to
 * `maxChannels`, skipping the current channel, duplicates and ids for which
 * `isPullable(id)` is false. `isPullable` carries the caller's checks: same
 * guild, text based, not a thread, not the dry-run mirror
 * (`bot.dryRunChannelId`), and every check fetchPull
 * (src/behavior/pull-fetch.ts) can make before its fetch (readable, the
 * audience rail), so a slot goes only to a channel the
 * fetch can serve and a refused newer mention never crowds out an older
 * usable one. It is asked in priority order, once per distinct id, and not
 * after the slots are full, so a counting predicate tells the caller how
 * many ids were refused. Without an `isPullable` function no mention or
 * route id is pulled (fail closed: the mirror check cannot be forgotten).
 * With `channelPull` false (see channelPullOn) only the source is returned.
 * Unusable `scanMessages` / `maxChannels` fall back to PULL_DEFAULTS.
 * @param {object} [params]
 * @param {{ channelId: string, reason: 'routed'|'noticed' }|null} [params.source]
 * @param {object[]} [params.history]          Normalized messages of the turn's channel, oldest first.
 * @param {object|null} [params.trigger]       The normalized trigger message, or null.
 * @param {string[]} [params.extra]            Route hook ids.
 * @param {string[]} [params.kept]             Channel ids the exchange keeps from an earlier turn.
 * @param {string|null} [params.currentChannelId]
 * @param {number} [params.scanMessages]
 * @param {number} [params.maxChannels]
 * @param {(channelId: string) => boolean} [params.isPullable]  Missing -> only the source.
 * @param {boolean} [params.channelPull]       `features.channelPull`; default true.
 * @returns {PullTarget[]}
 */
export function pullTargets({
  source = null,
  history = [],
  trigger = null,
  extra = [],
  kept = [],
  currentChannelId = null,
  scanMessages,
  maxChannels,
  isPullable,
  channelPull = true,
} = {}) {
  const limit = intAtLeast(maxChannels, PULL_DEFAULTS.maxChannels, 0);
  const scan = intAtLeast(scanMessages, PULL_DEFAULTS.scanMessages, 0);
  const out = [];
  // Every id already decided, kept or refused: isPullable is asked once per id.
  const judged = new Set();

  const sourceId = source?.channelId;
  if (typeof sourceId === 'string' && sourceId && sourceId !== currentChannelId) {
    out.push({ channelId: sourceId, reason: source.reason });
    judged.add(sourceId);
  }
  if (!channelPull || typeof isPullable !== 'function') return out;

  const add = (id, reason) => {
    if (out.length >= limit) return;
    if (typeof id !== 'string' || !id || id === currentChannelId || judged.has(id)) return;
    judged.add(id);
    if (isPullable(id)) out.push({ channelId: id, reason });
  };

  const past = (Array.isArray(history) ? history : []).filter((m) => m && !(trigger && m.id === trigger.id));
  // The span is counted in messages; only members' lines in it may pull.
  const scanned = (scan > 0 ? past.slice(-scan) : []).filter((m) => !m.bot && !m.self);
  for (const id of explicitChannelIds([...scanned, trigger])) add(id, 'mention');
  for (const id of Array.isArray(extra) ? extra : []) add(id, 'route');
  for (const id of Array.isArray(kept) ? kept : []) add(id, 'kept');
  return out;
}

/**
 * Whether a channel whose anchor (its newest message, or an explicit anchor)
 * was written at `anchorTs` is too old to pull at `now`: only with a positive
 * `maxAgeDays`, and only when strictly older than that many days. 0 (the
 * default) never refuses; an unknown `anchorTs` or `now` is not judged here.
 * @param {number|null} anchorTs
 * @param {{ maxAgeDays?: number, now?: number }} [options]
 * @returns {boolean}
 */
export function isTooOld(anchorTs, { maxAgeDays, now } = {}) {
  const days = numberAtLeast(maxAgeDays, PULL_DEFAULTS.maxAgeDays, 0);
  if (days <= 0 || !Number.isFinite(anchorTs) || !Number.isFinite(now)) return false;
  return now - anchorTs > days * DAY_MS;
}

/** A window result that pulls nothing, with its kebab-case skip code. */
function skipped(skip) {
  return { messages: [], olderNotShown: false, skip };
}

/**
 * The messages of a pulled channel the persona is shown: a window that ENDS
 * at the anchor, not at now. The anchor is `anchorTs` when given (an explicit
 * anchor: src/behavior/pull-fetch.ts#fetchPull's `anchorId`, which has no
 * production caller yet), else the newest message of `messages`. Messages after the anchor
 * are left out; every message with `ts >= anchor - windowMinutes` is kept;
 * when fewer than `minMessages` fall inside, the last `minMessages` up to the
 * anchor are taken regardless of time; then only the newest `maxMessages`
 * (the ceiling, over `minMessages` too). No gap cut inside the window.
 * `olderNotShown` is true when an earlier message was cut or `pageFull` says
 * the fetched page did not reach the channel's start.
 * Skip codes: `empty` (nothing at or before the anchor), `too-old` (a
 * positive `maxAgeDays` and an anchor older than that, see isTooOld). With
 * `maxAgeDays` 0 (the default) the window ends at the newest message whatever
 * its age. Unusable numbers fall back to PULL_DEFAULTS. The input is not
 * changed.
 * @param {object[]} messages  Normalized messages of the channel, oldest first.
 * @param {{ anchorTs?: number|null, windowMinutes?: number, minMessages?: number, maxMessages?: number,
 *   pageFull?: boolean, maxAgeDays?: number, now?: number }} [options]
 * @returns {{ messages: object[], olderNotShown: boolean, skip: 'empty'|'too-old'|null }}
 */
export function pullWindow(
  messages,
  { anchorTs = null, windowMinutes, minMessages, maxMessages, pageFull = false, maxAgeDays, now } = {}
) {
  const list = (Array.isArray(messages) ? messages : [])
    .filter((m) => m && Number.isFinite(m.ts))
    .sort((a, b) => a.ts - b.ts);
  const anchor = Number.isFinite(anchorTs) ? anchorTs : (list.at(-1)?.ts ?? null);
  if (anchor === null) return skipped('empty');
  if (isTooOld(anchor, { maxAgeDays, now })) return skipped('too-old');

  const upTo = list.filter((m) => m.ts <= anchor);
  const d = PULL_DEFAULTS;
  const from = anchor - numberAtLeast(windowMinutes, d.windowMinutes, 0) * MINUTE_MS;
  const firstInside = upTo.findIndex((m) => m.ts >= from);
  const inside = firstInside === -1 ? 0 : upTo.length - firstInside;
  const atLeast = Math.max(inside, intAtLeast(minMessages, d.minMessages, 0));
  const take = Math.min(atLeast, intAtLeast(maxMessages, d.maxMessages, 1));
  const kept = take > 0 ? upTo.slice(-take) : [];
  if (kept.length === 0) return skipped('empty');
  return { messages: kept, olderNotShown: kept.length < upTo.length || pageFull === true, skip: null };
}

/**
 * The describable items of a pulled window, for its captions. Pictures: the
 * picture items of each message (collectPictures) the describer can caption
 * (isDescribable), newest message first and each message in its own order,
 * each picture (`itemId`) once at its newest message; the first
 * `maxPictures` are `items` (the only ones a fresh caption may be requested
 * for), the others, in the same order, are `rest` (a cached caption only),
 * and `overflow` is `rest.length`. Every picture of the window is in `items`
 * or `rest`, so the cache can be asked for all of them. `emoji`: the
 * window's custom emoji (collectEmojiItems), in the same order and once
 * each -- not pictures, never counted toward `maxPictures` or `overflow`,
 * returned for the cached captions the transcript renders. Unusable
 * `maxPictures` falls back to PULL_DEFAULTS.
 * @param {object[]} messages  Normalized messages, oldest first (a pullWindow result).
 * @param {number} maxPictures
 * @returns {{ items: object[], rest: object[], overflow: number, emoji: object[] }}
 */
export function pullPictures(messages, maxPictures) {
  const limit = intAtLeast(maxPictures, PULL_DEFAULTS.maxPictures, 0);
  const list = Array.isArray(messages) ? messages : [];
  const items = [];
  const rest = [];
  const emoji = [];
  const seen = new Set();
  /** A describable item met for the first time (the newest message's copy wins). */
  const firstDescribable = (item) => {
    if (!isDescribable(item) || seen.has(item.itemId)) return false;
    seen.add(item.itemId);
    return true;
  };
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (!list[i]) continue;
    for (const item of collectPictures(list[i])) {
      if (firstDescribable(item)) (items.length < limit ? items : rest).push(item);
    }
    for (const item of collectEmojiItems(list[i])) {
      if (firstDescribable(item)) emoji.push(item);
    }
  }
  return { items, rest, overflow: rest.length, emoji };
}
