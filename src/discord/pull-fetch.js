// Fetching another channel for a turn: the pulled block (`<channel_view>`).
// A turn sometimes needs a channel other than the one it speaks in -- the
// read-only channel a call came from, a channel someone named with an
// explicit <#id>, or any channel a route hook names -- and without it the
// persona would be asked about a channel it cannot see. The pure decisions
// live elsewhere: src/behavior/pull.js (the window that ends at the channel's
// newest message, the pictures that may get a caption, the `context.pull`
// settings) and src/behavior/elsewhere.js (the ring of calls, the audience
// comparison). This module is the Discord side, fetchPull, which any caller
// can use for any channel id: the rails a pull must pass (a readable text
// channel, allowed, not a thread, not the dry-run mirror, visible to everyone
// who can view the channel the persona speaks in -- in a private chat, to the
// partner), one page of history, the
// ring's calls marked on their lines, and the captions -- the cache's first,
// fresh ones only for a turn certain to run, in parallel and never waited
// for past a timeout. A pull made before the turn is certain (a chooser can
// still return `not-now`) gets its fresh captions later from captionPulled,
// without fetching the channel again.

import { PermissionFlagsBits, SnowflakeUtil } from 'discord.js';
import { log } from '../log.js';
import { isTooOld, pullPictures, pullSettings, pullWindow } from '../behavior/pull.js';
import { audienceCovers, elsewhereSettings, pingStatus, pingsIn } from '../behavior/elsewhere.js';
import { ID_DIGITS } from '../memory/mentions.js';
import { MINUTE_MS } from '../time.js';
import {
  PAGE,
  audienceOf,
  canSend,
  channelAllowed,
  fetchHistoryWindow,
  fetchMessage,
  isReadableChannel,
  lastActivity,
  normalizeMessage,
} from './collect.js';

const ANCHOR_RE = new RegExp(`^${ID_DIGITS}$`);
const DEFAULT_TIMERS = Object.freeze({
  set: (fn, ms) => setTimeout(fn, ms),
  clear: (timer) => clearTimeout(timer),
});

/**
 * One channel shown to the persona beside the chat it answers. Consumed by
 * src/behavior/prompt.js (rendering; it finds the newest line shown itself)
 * and src/behavior/turn.js (reactions, which ask canReact of the live
 * channel; seen marks); the discord.js channel object is never inside it.
 * @typedef {object} PulledChannel
 * @property {string} channelId
 * @property {string|null} channelName
 * @property {boolean} readOnly       the bot cannot send there (canSend)
 * @property {'routed'|'noticed'|'mention'|'route'|'recall'|null} reason  why it was pulled ('recall': no
 *                                    production caller yet, see fetchPull's `anchorId`)
 * @property {object[]} messages      normalized messages shown, oldest first: the window, the routed trigger when
 *                                    it was outside the window, and the earlier calls (`earlierPingIds`)
 * @property {Set<string>} earlierPingIds  ids among `messages` shown before the window: the routed trigger when it is
 *                                    older than the window, and the ring's unanswered calls older than the window
 * @property {boolean} olderNotShown  older messages of the channel exist that are not shown
 * @property {Map<string, string>} descriptions  picture / emoji item id -> caption (cached or fresh)
 * @property {number} picturesNotSeen  pictures of `messages` left without a caption
 * @property {Map<string, 'answered'|'skipped'|'unanswered'>} pingState  message id -> state of its ring call,
 *                                    for every shown line that is a call in the ring except the trigger itself
 * @property {{ hashes: Map<string, string>, oldestTs: number, oldestId: string|null, shownAt: number }} [seenBefore]  the last view of
 *                                    this channel shown in the turn's channel (createPullViews), attached by
 *                                    src/behavior/turn.js; absent when there is none within the TTL
 */

/**
 * The last view of each pulled channel shown in each destination channel, in
 * process only (no file: it is about the current conversation, and a restart
 * forgets it). Keyed `${destinationChannelId}:${sourceChannelId}`; one view
 * holds each shown line's id with its hash, the oldest window line's time and
 * id (`oldestId`: an earlier page starts before it, fetchPull's `beforeId`)
 * and when it was shown. src/behavior/turn.js reads it before building a turn's
 * request (the PulledChannel's `seenBefore`) and writes it once the request
 * was sent and answered, from buildRequest's `pulledViews`. A view older than
 * the TTL (`context.pull.seenTtlMinutes`, read by the caller at the moment of
 * use) is ignored and pruned.
 * @returns {{
 *   previous: (destinationId: string, sourceId: string, options: { now: number, ttlMinutes: number }) =>
 *     ({ hashes: Map<string, string>, oldestTs: number, oldestId: string|null, shownAt: number }|null),
 *   remember: (destinationId: string, views: { channelId: string, hashes: Map<string, string>, oldestTs: number,
 *     oldestId?: string|number|null }[], now: number) => void,
 *   size: () => number,
 * }}
 */
export function createPullViews() {
  const views = new Map();
  const prune = (now, ttlMs) => {
    for (const [key, view] of views) if (now - view.shownAt > ttlMs) views.delete(key);
  };
  return {
    previous(destinationId, sourceId, { now, ttlMinutes }) {
      prune(now, ttlMinutes * MINUTE_MS);
      return views.get(`${destinationId}:${sourceId}`) ?? null;
    },
    remember(destinationId, shown, now) {
      for (const view of Array.isArray(shown) ? shown : []) {
        if (!view?.channelId || !(view.hashes instanceof Map)) continue;
        const oldestId = view.oldestId === null || view.oldestId === undefined || view.oldestId === '' ? null : String(view.oldestId);
        views.set(`${destinationId}:${view.channelId}`, { hashes: view.hashes, oldestTs: view.oldestTs, oldestId, shownAt: now });
      }
    },
    size: () => views.size,
  };
}

/** A refusal: nothing of the channel. */
function refused(skip) {
  return { channel: null, skip };
}

/**
 * Whether `partner` (a discord.js GuildMember) has View Channel on `source`,
 * a channel of the partner's guild. No partner, a source without a guild or
 * of another guild -> false.
 */
function partnerViews(partner, source) {
  if (!partner || !source?.guild || typeof source.permissionsFor !== 'function') return false;
  if (partner.guild?.id && partner.guild.id !== source.guild.id) return false;
  return source.permissionsFor(partner)?.has(PermissionFlagsBits.ViewChannel) === true;
}

/**
 * Whether content of `source` may enter a turn in `destination`. A private
 * chat (a destination without a guild) has one reader: the source must be a
 * channel its `partner` (the guild member the persona talks to) has View
 * Channel on, whatever `context.pull.sameAudience` says; no partner never
 * qualifies. Elsewhere, with `context.pull.sameAudience` (read from `config`,
 * the live config; only `false` turns it off) everyone who can view the
 * destination must be able to view the source, checked role by role on both
 * channels' audiences (src/discord/collect.js#audienceOf,
 * src/behavior/elsewhere.js#audienceCovers; no shortcut for a source
 * @everyone can view). A missing destination or a thread never qualifies
 * while the rail is on.
 * @param {object|null} destination  The discord.js channel the turn speaks in.
 * @param {object|null} source       The discord.js channel whose content would enter it.
 * @param {object} config            The live config.
 * @param {{ partner?: object|null }} [options]  A private chat's partner (a discord.js GuildMember).
 * @returns {boolean}
 */
export function audienceAllows(destination, source, config, { partner = null } = {}) {
  if (destination && !destination.guild) return partnerViews(partner, source);
  if (!pullSettings(config).sameAudience) return true;
  return audienceCovers(audienceOf(destination), audienceOf(source));
}

/**
 * Why `channel` is not one the persona may read, or null when it is. The
 * decision is isReadableChannel's (src/discord/collect.js: the one rule every
 * reader of the bot obeys, neighbours included); the checks after it only
 * name the refusal, and a refusal none of them names (a rule
 * isReadableChannel gains later) is `not-readable`. A channel without
 * `isTextBased` is `not-text` before the rule is asked.
 */
function readableRefusal(channel, bot) {
  if (typeof channel.isTextBased !== 'function' || !channel.isTextBased()) return 'not-text';
  if (isReadableChannel(channel, bot)) return null;
  if (channel.isThread?.()) return 'thread';
  const mirrorId = bot.dryRunChannelId;
  if (mirrorId && channel.id === mirrorId) return 'dry-run-channel';
  if (!channelAllowed(channel, bot)) return 'denied';
  return 'not-readable';
}

/**
 * The rails a pull must pass before anything is fetched, in this order, each
 * with its kebab-case skip code: a `destination` that is given is a guild
 * channel, or a private chat with its `partner` (`private-chat` without one,
 * whatever the audience rail says); the id is a channel of `guild` (`not-found`); the channel is one the
 * persona may read (src/discord/collect.js#isReadableChannel, the rule
 * neighbours obey too), the refusal named `not-text` (not a text channel),
 * `thread`, `dry-run-channel` (`bot.dryRunChannelId`), `denied` (not allowed
 * by `bot.channels`) or else `not-readable` (the bot cannot read its history);
 * the audience rail toward `destination` (`audience`, see audienceAllows: in
 * a private chat, the partner's View Channel on it);
 * and its newest message not older than a positive `context.pull.maxAgeDays`
 * (`too-old`; 0, the default, never refuses). No request is made: a route
 * hook or a mention scan can ask it for every candidate id (`pullTargets`'
 * `isPullable`).
 * @param {{ guild: object, channelId: string, destination?: object|null, partner?: object|null,
 *   config: object, now?: number }} args  `partner`: a private chat's partner, the discord.js
 *   GuildMember of `guild` the persona talks to there.
 * @returns {{ channel: object|null, skip: string|null }}  The discord.js channel when it passes, else its code.
 */
export function checkPull({ guild, channelId, destination = null, partner = null, config, now = Date.now() } = {}) {
  if (destination && !destination.guild && !partner) return refused('private-chat');
  const channel = typeof channelId === 'string' && channelId ? (guild?.channels?.cache?.get?.(channelId) ?? null) : null;
  if (!channel) return refused('not-found');
  const unreadable = readableRefusal(channel, config?.bot ?? {});
  if (unreadable) return refused(unreadable);
  if (!audienceAllows(destination, channel, config, { partner })) return refused('audience');
  const last = lastActivity(channel);
  if (last > 0 && isTooOld(last, { maxAgeDays: pullSettings(config).maxAgeDays, now })) return refused('too-old');
  return { channel, skip: null };
}

/**
 * One page of the channel's history ending at `anchorId` (inclusive) or at its
 * newest message, oldest first, through fetchHistoryWindow; null when the
 * fetch failed. fetchHistoryWindow logs a page error itself (`collect:
 * history window fetch failed`) and returns what it has, so an empty result
 * would look like an empty channel: the view of the channel handed to it
 * notes the failure. A message of the page that cannot be normalized throws
 * out of fetchHistoryWindow: `pull: page unreadable`, null. With `beforeId`
 * (an earlier page) instead: the `limit` messages before that message
 * (exclusive), one request (`{ before, limit }`), normalized the same way;
 * a failed request is null too.
 */
async function fetchPage(channel, { anchorId, beforeId = null, limit, selfId, embedTextChars, videoSites, maxUrlChars }, logIds) {
  if (beforeId) {
    let fetched;
    try {
      fetched = await channel.messages.fetch({ before: beforeId, limit });
    } catch (err) {
      log.warn('pull: earlier page fetch failed', { ...logIds, error: err });
      return null;
    }
    try {
      return [...fetched.values()]
        .sort((a, b) => a.createdTimestamp - b.createdTimestamp)
        .map((message) => normalizeMessage(message, selfId, { embedTextChars, videoSites, maxUrlChars }));
    } catch (err) {
      log.warn('pull: page unreadable', { ...logIds, error: err });
      return null;
    }
  }
  let failed = false;
  const watched = {
    id: channel.id,
    messages: {
      fetch: async (query) => {
        try {
          return await channel.messages.fetch(query);
        } catch (err) {
          failed = true;
          throw err;
        }
      },
    },
  };
  try {
    const page = await fetchHistoryWindow(watched, { anchorId, limit, selfId, embedTextChars, videoSites, maxUrlChars });
    return failed ? null : page;
  } catch (err) {
    log.warn('pull: page unreadable', { ...logIds, error: err });
    return null;
  }
}

/**
 * One message of the pulled channel by id, normalized: the page's copy when
 * the page holds it (no request), else one fetch (fetchMessage); null when it
 * is gone (deleted, no access, any fetch error) or cannot be normalized
 * (`pull: call unreadable`).
 */
async function messageById(channel, messageId, { pageById, selfId, normalizeOptions, logIds }) {
  if (pageById.has(messageId)) return pageById.get(messageId);
  const message = await fetchMessage(channel, messageId);
  if (!message) return null;
  try {
    return normalizeMessage(message, selfId, normalizeOptions);
  } catch (err) {
    log.warn('pull: call unreadable', { ...logIds, error: err });
    return null;
  }
}

/** Whether `trigger` is a normalized message of channel `channelId` with an id and a time. */
function isTriggerOf(trigger, channelId) {
  return typeof trigger?.id === 'string' && trigger.id !== '' && trigger.channelId === channelId && Number.isFinite(trigger.ts);
}

/**
 * Fresh captions for `items`, one single-item describeMany call each, all at
 * once, waited for at most `timeoutMs` (an unref'd timer). A caption that
 * arrives later is not used now (its request is not cancelled: the describer
 * still caches it for the next turn). A request that fails is logged (`pull:
 * caption failed`) and counts as answered, not late; the others are kept.
 * Every request counts against `llm.maxRequestsPerDay`.
 * @returns {Promise<{ got: Map<string, string>, late: number }>}
 */
async function freshCaptions({ describer, guildId, items, timeoutMs, timers, logIds }) {
  const got = new Map();
  if (items.length === 0) return { got, late: 0 };
  let open = true;
  let settled = 0;
  const requests = items.map(async (item) => {
    try {
      const result = await describer.describeMany(guildId, [item], { maxNew: 1 });
      const text = result?.descriptions?.get?.(item.itemId);
      if (open && typeof text === 'string' && text) got.set(item.itemId, text);
    } catch (err) {
      log.warn('pull: caption failed', { ...logIds, error: err });
    } finally {
      if (open) settled += 1;
    }
  });
  let timer;
  const timedOut = new Promise((resolve) => {
    timer = timers.set(resolve, timeoutMs);
    timer?.unref?.();
  });
  await Promise.race([Promise.all(requests), timedOut]);
  open = false;
  timers.clear(timer);
  return { got, late: items.length - settled };
}

/**
 * The captions of a pulled channel's lines, `known` (captions it already
 * has) kept. Only with `features.mediaDescriptions` true and a describer:
 * the cache's for every picture and custom emoji not known yet, free; then,
 * with `requestFresh`, fresh ones (freshCaptions) for the pictures still
 * uncaptioned among the first `context.pull.maxPictures` (newest first), at
 * most `maxNewDescriptions`. A picture whose caption failed within the last
 * hour (the describer's miss memory, which the cache does not report) is
 * asked like any other: it takes one of those slots and sends no request.
 * Custom emoji are never pictures: no fresh caption, never counted.
 * @returns {Promise<{ descriptions: Map<string, string>, pictures: number, captioned: number, notSeen: number,
 *   asked: number, fresh: number, late: number }>}
 */
async function pullCaptions(messages, { describer, guildId, config, requestFresh, timers, known = null, logIds }) {
  const settings = pullSettings(config);
  const { items, rest, emoji } = pullPictures(messages, settings.maxPictures);
  const pictures = [...items, ...rest];
  const descriptions = new Map(known instanceof Map ? known : []);
  let asked = 0;
  let fresh = 0;
  let late = 0;
  if (config?.features?.mediaDescriptions === true && describer) {
    const unknown = [...pictures, ...emoji].filter((item) => !descriptions.has(item.itemId));
    if (unknown.length > 0 && typeof describer.cachedDescriptions === 'function') {
      for (const [id, text] of describer.cachedDescriptions(guildId, unknown) ?? []) descriptions.set(id, text);
    }
    if (requestFresh && typeof describer.describeMany === 'function') {
      const uncached = items.filter((item) => !descriptions.has(item.itemId)).slice(0, settings.maxNewDescriptions);
      asked = uncached.length;
      const result = await freshCaptions({ describer, guildId, items: uncached, timeoutMs: settings.describeTimeoutMs, timers, logIds });
      for (const [id, text] of result.got) descriptions.set(id, text);
      fresh = result.got.size;
      late = result.late;
    }
  }
  const captioned = pictures.filter((item) => descriptions.has(item.itemId)).length;
  return { descriptions, pictures: pictures.length, captioned, notSeen: pictures.length - captioned, asked, fresh, late };
}

/** The caption counts of a `pull:` log line (pullCaptions' result); never a caption. */
function captionCounts(captions) {
  return {
    pictures: captions.pictures,
    cached: captions.captioned - captions.fresh,
    asked: captions.asked,
    fresh: captions.fresh,
    late: captions.late,
    notSeen: captions.notSeen,
  };
}

/**
 * Fresh captions for a channel already pulled (a PulledChannel from
 * fetchPull without `turnCertain`), once the turn is certain to run: no
 * request to Discord, the same lines and window. The cache is asked again
 * for the pictures and custom emoji still without a caption (the prefill may
 * have cached some meanwhile), then fresh captions are requested for the
 * uncached pictures among the first `context.pull.maxPictures`, at most
 * `maxNewDescriptions`, in parallel, waited for at most `describeTimeoutMs`
 * (a late one renders blind this turn), exactly as fetchPull with
 * `turnCertain` does; see pullCaptions. Only with `features.mediaDescriptions`
 * true and a describer. Returns a new record with `descriptions` merged and
 * `picturesNotSeen` recomputed; the given one is not changed. Logs `pull:
 * captions` (`channel`, `source`, `pullReason`, the caption counts, ms).
 * @param {PulledChannel} pulled
 * @param {object} args
 * @param {object|null} args.describer   From createDescriber (src/memory/describe.js).
 * @param {string} args.guildId          The guild id for the media cache.
 * @param {object} args.config           The live config.
 * @param {object|null} [args.destination] The discord.js channel the turn speaks in (the log).
 * @param {{ set: Function, clear: Function }} [args.timers]  setTimeout / clearTimeout (tests inject fakes).
 * @returns {Promise<PulledChannel>}
 */
export async function captionPulled(pulled, { describer = null, guildId = null, config, destination = null, timers = DEFAULT_TIMERS } = {}) {
  if (!pulled || !Array.isArray(pulled.messages)) return pulled;
  const started = Date.now();
  const logIds = { channel: destination?.id ?? null, source: pulled.channelId ?? null };
  const captions = await pullCaptions(pulled.messages, {
    describer,
    guildId,
    config,
    requestFresh: true,
    timers,
    known: pulled.descriptions,
    logIds,
  });
  log.info('pull: captions', { ...logIds, pullReason: pulled.reason ?? null, ...captionCounts(captions), ms: Date.now() - started });
  return { ...pulled, descriptions: captions.descriptions, picturesNotSeen: captions.notSeen };
}

/**
 * Fetch one channel for a turn's `<channel_view>`: the hook any caller uses
 * for any channel id (a routed call's source, a noticed comment's source, an
 * explicit `<#id>`, a route hook's id, a recall's anchor).
 *
 * The rails of checkPull come first; a refusal returns its code and fetches
 * nothing. Then one page of history (`min(100, max(maxMessages, minMessages)
 * + 1)` messages ending at `anchorId` inclusive, else at the newest message)
 * is cut by pullWindow: the window ends at that message whatever its age.
 * More skip codes: `not-found` for a malformed `anchorId`, `too-old` for an
 * anchor older than a positive `maxAgeDays`, `fetch-failed` when the page
 * could not be fetched or read, `empty` when nothing is at or before the
 * anchor, `trigger-gone` when the `trigger` no longer exists.
 *
 * The `trigger` (a normalized message of this channel, a routed call; a
 * trigger of another channel is ignored) is always shown, as the channel
 * holds it now: the page's copy (its reactions, its edited text) when the
 * page holds it; when the page lacks it although its time falls inside the
 * page's span it was deleted (`trigger-gone`); otherwise (older than the
 * page, or newer than an explicit anchor) it is fetched by id, and
 * `trigger-gone` when that finds nothing. A trigger outside the window and
 * older than it is listed in `earlierPingIds` (shown before the window, so
 * the window's span stays what it is); one newer than an explicit anchor
 * follows the window (a routed call is pulled without an anchor). The
 * ring's unanswered calls of this channel older than the window are added
 * too (`earlierPingIds`; each taken from the page or fetched by id, dropped
 * when gone or unreadable). `pingState` marks every shown line that is a call
 * of the ring, by id, with its state (answered, skipped by choice, or
 * unanswered); the trigger itself carries no mark.
 *
 * Captions (see pullCaptions): the cache's for every picture and custom emoji
 * of the shown lines, free; then, only when `turnCertain` is true, fresh ones
 * for the uncached pictures among the first `context.pull.maxPictures`, at
 * most `maxNewDescriptions`, in parallel, waited for at most
 * `describeTimeoutMs`; a late one renders blind this turn. A pull made
 * before the turn is certain gets them later from captionPulled. Pictures
 * left without a caption are counted in `picturesNotSeen`.
 *
 * With `direction: 'earlier'` and a `beforeId` (the oldest window line of
 * the last view of this channel shown in the destination, createPullViews),
 * the page is the one before that message instead of the newest one; the
 * window then ends at that page's newest message. `earlier` without a
 * `beforeId` pulls the newest page (`pullDirection: 'earlier-no-previous'` in
 * the log); a `beforeId` without `earlier` is ignored. An anchor wins over both.
 *
 * Logs `pull: channel` (`channel` = the destination, `source`, `pullReason`
 * = why the pull was asked, `direction` (`earlier` or null), for an earlier
 * pull `beforeId` = whether a previous view gave one (a boolean, never the
 * id), the counts, ms) or `pull: skipped` (the same ids,
 * `reason` = the skip code, `pullReason`); never message text or captions.
 * `earlier` counts the ring calls added before the window, `earlierGone` the
 * ones wanted but gone or unreadable; `asked` the pictures handed to the
 * describer for a fresh caption (a recent miss sends no request), `fresh`
 * the captions back in time, `late` the ones not. Settings are read from
 * `config` (the caller's live config) at the call.
 * @param {object} args
 * @param {object} args.guild            The discord.js guild of the turn.
 * @param {string} [args.guildId]        The guild id for the media cache; default `guild.id`.
 * @param {string} args.channelId        The channel to pull.
 * @param {object|null} args.destination The discord.js channel the turn speaks in (the audience rail; the log).
 * @param {object|null} [args.partner]  When `destination` is a private chat: the partner, a discord.js
 *   GuildMember of `guild` (the audience rail is their View Channel; none -> `private-chat`).
 * @param {'routed'|'noticed'|'mention'|'route'|'recall'} args.reason
 * @param {string|null} [args.anchorId]  The window ends at this message instead of the newest one. No
 *   production caller yet: the seam a recall (reason `recall`) will use; only tests pass it today.
 * @param {'earlier'|null} [args.direction]  `earlier`: the page before `beforeId` (see above).
 * @param {string|null} [args.beforeId]  The oldest window line of the last view shown (createPullViews).
 * @param {object|null} [args.trigger]   A routed call (normalized), always shown (the channel's copy), see above.
 * @param {object[]} [args.pings]        The stored ring of calls (`state.json` `elsewherePings`, any channel):
 *   `{ messageId, channelId, ts, answeredAt, skippedAt }`; only this channel's unexpired entries count
 *   (`elsewhere.pingMaxAgeDays`).
 * @param {object} args.config           The live config.
 * @param {string} args.selfId           The bot user's id.
 * @param {number} [args.now]            The turn's clock (epoch ms).
 * @param {object|null} [args.describer] From createDescriber (src/memory/describe.js):
 *   `cachedDescriptions`, `describeMany`.
 * @param {boolean} [args.turnCertain]   True only when the turn is certain to run (no chooser can still return
 *   `not-now`): only then are fresh captions requested. Default false: cached captions only (captionPulled
 *   adds the fresh ones once the turn is certain).
 * @param {{ set: Function, clear: Function }} [args.timers]  setTimeout / clearTimeout (tests inject fakes).
 * @returns {Promise<{ pulled: PulledChannel|null, skip: string|null }>}  `pulled` null on a skip.
 */
export async function fetchPull({
  guild,
  guildId = guild?.id ?? null,
  channelId,
  destination = null,
  partner = null,
  reason = null,
  anchorId = null,
  direction = null,
  beforeId = null,
  trigger = null,
  pings = [],
  config,
  selfId,
  now = Date.now(),
  describer = null,
  turnCertain = false,
  timers = DEFAULT_TIMERS,
} = {}) {
  const started = Date.now();
  const nowMs = Number.isFinite(now) ? now : Date.now();
  const logIds = { channel: destination?.id ?? null, source: typeof channelId === 'string' ? channelId : null };
  const skipWith = (skip) => {
    log.info('pull: skipped', { ...logIds, reason: skip, pullReason: reason });
    return { pulled: null, skip };
  };

  const checked = checkPull({ guild, channelId, destination, partner, config, now: nowMs });
  if (checked.skip) return skipWith(checked.skip);
  const { channel } = checked;
  const settings = pullSettings(config);

  let anchor = null;
  let anchorTs = null;
  if (anchorId !== null && anchorId !== undefined && anchorId !== '') {
    anchor = String(anchorId);
    if (!ANCHOR_RE.test(anchor)) return skipWith('not-found');
    anchorTs = SnowflakeUtil.timestampFrom(anchor);
    if (isTooOld(anchorTs, { maxAgeDays: settings.maxAgeDays, now: nowMs })) return skipWith('too-old');
  }

  const normalizeOptions = { embedTextChars: config?.media?.embedTextChars, videoSites: config?.media?.video?.sites, maxUrlChars: config?.context?.maxUrlChars };
  const limit = Math.min(PAGE, Math.max(settings.maxMessages, settings.minMessages) + 1);
  const earlierPull = direction === 'earlier';
  const before = earlierPull && anchor === null && typeof beforeId === 'string' && beforeId !== '' ? beforeId : null;
  const page = await fetchPage(channel, { anchorId: anchor, beforeId: before, limit, selfId, ...normalizeOptions }, logIds);
  if (page === null) return skipWith('fetch-failed');

  const window = pullWindow(page, {
    anchorTs,
    windowMinutes: settings.windowMinutes,
    minMessages: settings.minMessages,
    maxMessages: settings.maxMessages,
    pageFull: page.length >= limit,
    maxAgeDays: settings.maxAgeDays,
    now: nowMs,
  });
  if (window.skip) return skipWith(window.skip);

  const shown = [...window.messages];
  const shownIds = new Set(shown.map((m) => m.id));
  const windowStart = window.messages[0].ts;
  const pageById = new Map(page.map((m) => [m.id, m]));
  const byId = (messageId) => messageById(channel, messageId, { pageById, selfId, normalizeOptions, logIds });
  // Shown before the window: the trigger when older than it, the ring's earlier calls.
  const beforeWindow = new Set();

  // The routed trigger, as the channel holds it now; a deleted one ends the pull.
  const triggerId = isTriggerOf(trigger, channel.id) ? trigger.id : null;
  if (triggerId !== null && !shownIds.has(triggerId)) {
    // The page's span: from its oldest message to the anchor, the earlier page's newest one, or now.
    const pageEnd = anchorTs ?? (before !== null ? page.at(-1).ts : null);
    const deleted =
      !pageById.has(triggerId) && trigger.ts > page[0].ts && (pageEnd === null || trigger.ts <= pageEnd);
    const line = deleted ? null : await byId(triggerId);
    if (!line) return skipWith('trigger-gone');
    shown.push(line);
    shownIds.add(line.id);
    if (line.ts < windowStart) beforeWindow.add(line.id);
  }

  // The ring's calls of this channel: the unanswered ones older than the window are shown too.
  const ring = pingsIn(pings, channel.id, { now: nowMs, maxAgeMs: elsewhereSettings(config).pingMaxAgeMs });
  const wanted = ring.filter(
    (entry) =>
      pingStatus(entry) === 'unanswered' &&
      entry.messageId !== triggerId &&
      !shownIds.has(entry.messageId) &&
      entry.ts < windowStart,
  );
  const fetched = await Promise.all(wanted.map((entry) => byId(entry.messageId)));
  let earlier = 0;
  for (const message of fetched) {
    if (!message || !Number.isFinite(message.ts) || message.ts >= windowStart || shownIds.has(message.id)) continue;
    shown.push(message);
    shownIds.add(message.id);
    beforeWindow.add(message.id);
    earlier += 1;
  }
  shown.sort((a, b) => a.ts - b.ts);

  const pingState = new Map();
  for (const entry of ring) {
    if (entry.messageId === triggerId || !shownIds.has(entry.messageId)) continue;
    pingState.set(entry.messageId, pingStatus(entry));
  }

  // Captions: the cache's for every picture and emoji, fresh ones only for a turn certain to run.
  const captions = await pullCaptions(shown, {
    describer,
    guildId,
    config,
    requestFresh: turnCertain === true,
    timers,
    logIds,
  });

  const pulled = {
    channelId: channel.id,
    channelName: channel.name ?? null,
    readOnly: !canSend(channel),
    reason,
    messages: shown,
    earlierPingIds: beforeWindow,
    olderNotShown: window.olderNotShown,
    descriptions: captions.descriptions,
    picturesNotSeen: captions.notSeen,
    pingState,
  };
  log.info('pull: channel', {
    ...logIds,
    pullReason: reason,
    direction: earlierPull ? 'earlier' : null,
    ...(earlierPull ? { beforeId: before !== null } : {}),
    ...(earlierPull && before === null ? { pullDirection: 'earlier-no-previous' } : {}),
    messages: shown.length,
    earlier,
    earlierGone: wanted.length - earlier,
    olderNotShown: window.olderNotShown,
    ...captionCounts(captions),
    pings: pingState.size,
    ms: Date.now() - started,
  });
  return { pulled, skip: null };
}
