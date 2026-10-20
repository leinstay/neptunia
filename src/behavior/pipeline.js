// The message pipeline: turns the `message.received` event of a discord.js
// `messageCreate` (packages/protocol/, built by interfaces/discord/collect.js#toEvent)
// into one of a handful of outcomes (ignore, observe into memory, let the spontaneous
// scheduler eavesdrop, or run a turn) without ever throwing into discord.js.
// A direct message goes through the private-chat gate instead
// (features.privateMessages, src/behavior/private.js). A turn someone asked
// for that a rail refused gets one plain limit notice (src/behavior/limits.js);
// a direct call while paused gets the pause notice the same way.
// A call in a channel the persona can read but not write in is answered in
// the main channel (features.elsewhere) once that channel settles; so is a
// remark the persona chose to make about it (a noticed comment). A line put
// to the whole room may get a higher chance of an unprompted answer
// (spontaneous.roomQuestionChance, the room classifier).
// Owner commands are a separate pipeline entirely (interfaces/discord/commands.js,
// driven by `interactionCreate`, not `messageCreate`). Kept free of
// discord.js-specific assumptions beyond the shape already used by
// interfaces/discord/collect.js, so it can be driven with plain fake objects in
// tests. The few Discord functions it calls (a permission check, the history
// and message fetches, the normalization and the event builder) come injected
// as `discord` by its caller, src/index.js: nothing here imports the Discord
// interface package.

import { isOwnerId } from '../ops/grants.js';
import { collectPictures, collectEmojiItems, collectVideos, collectReadableLinks, isDescribable } from '../media/classify.js';
import {
  detectTrigger,
  strippedLength,
  decideMention,
  repeatWindowMs,
  isFollowUpOpen,
  followUpPreFilter,
  parseAddressAnswer,
  followUpTriggerKind,
  isTaggedCall,
  roomPreFilter,
} from './mention.js';
import { helperRequestOptions, railReason } from '../llm/openrouter.js';
import { roleModel } from '../llm/roles.js';
import { clampChars, oneLine } from '../memory/clamp.js';
import { fill, formatTranscript, renderTranscript } from '../format.js';
import { topByRank } from '../memory/ranking.js';
import { CODE } from '../skills/codes.js';
import { addPending, authorCalls, foldInto, followUpSlot, isExpired, parseMergeAnswer, popOldest, requeuePending } from './pending.js';
import { between } from './random.js';
import { block, fillPromptTemplate } from './prompt.js';
import { roomQuestionChance } from './spontaneous.js';
import { routeFor } from './turn.js';
import { elsewhereSettings, pingsIn, pingStatus, recordPing, settleDueAt, stampPings } from './elsewhere.js';
import { privateGate } from './private.js';
import { isLimitNotice, pauseNotice, pauseNoticeMinutes, postLimitNotice, postPauseNotice } from './limits.js';
import { isVideoVisionOn, slimMessage, appendRevision, toRecordLine, gifOpts, participationSettings, recordFollowing } from '../memory/index.js';
import { log } from '../log.js';
import { MINUTE_MS, utcDay } from '../time.js';

/** @typedef {import('./turn.js').TurnOutcome} TurnOutcome */
/** @typedef {import('./turn.js').TriggerKind} TriggerKind */

// The most links one observed message has read ahead of time (web.links.prefill).
const MAX_WARM_LINKS_PER_MESSAGE = 1;
/** How many message ids each path of handleMessage remembers (the live one, the start's catch-up). */
const CATCH_UP_IDS_KEPT = 1000;
// Only when web.links.prefillPerUserPerDay is missing (config.json always has it).
const PREFILL_PER_USER_PER_DAY_FALLBACK = 10;

/**
 * How many items of one observed message a prefill may take: `value` (a
 * config count, read by the caller now) floored at 0, or `fallback` (the
 * config.json value) when it is missing or not a number. 0 turns that prefill off.
 */
function prefillPerMessage(value, fallback) {
  return Number.isFinite(value) ? Math.max(0, Math.floor(value)) : fallback;
}

/**
 * Whether a follow-up whose address classifier failed (threw or answered
 * nothing) still belongs to an active one-to-one exchange, from the channel
 * `history` its request fetched (normalized, oldest first, without the
 * candidate): the persona's latest line before `candidate` was posted at most
 * `minutes` before it; that line (with the lines of hers right before it, one
 * multi-line answer) replied only to messages of the candidate's author, or -- no
 * reply target found in `history` -- a message of that author directly
 * preceded it; and nobody but that author wrote between it and `candidate`.
 * False otherwise, and with `minutes` not above 0. Pure.
 * @param {object[]} history
 * @param {{ authorId: string, ts: number }} candidate
 * @param {number} minutes
 * @returns {boolean}
 */
function activeExchangeWith(history, candidate, minutes) {
  if (!(minutes > 0) || !Array.isArray(history)) return false;
  const before = history.filter((m) => m && Number.isFinite(m.ts) && m.ts <= candidate.ts);
  let last = -1;
  for (let i = before.length - 1; i >= 0; i -= 1) {
    if (before[i].self) {
      last = i;
      break;
    }
  }
  if (last < 0 || candidate.ts - before[last].ts > minutes * MINUTE_MS) return false;
  if (before.slice(last + 1).some((m) => m.authorId !== candidate.authorId)) return false;
  let first = last;
  while (first > 0 && before[first - 1].self) first -= 1;
  const byId = new Map(history.map((m) => [m?.id, m]));
  const targets = before
    .slice(first, last + 1)
    .map((m) => (m.replyToId ? byId.get(m.replyToId) : null))
    .filter((m) => m && !m.self);
  if (targets.length > 0) return targets.every((m) => m.authorId === candidate.authorId);
  return first > 0 && before[first - 1].authorId === candidate.authorId;
}

/**
 * How strongly a call asks for an answer: a tag (mention/reply) above the
 * persona's name, which rolls mention.nameTriggerChance. A settle wait never
 * trades a call for a weaker one.
 * @param {TriggerKind|undefined} triggerKind
 * @returns {number}
 */
function callRank(triggerKind) {
  if (triggerKind === 'mention' || triggerKind === 'reply') return 2;
  return triggerKind === 'name' ? 1 : 0;
}

/**
 * Whether the switch that lets a server call of `kind` through (onMessage
 * step 8) is off in `features` now: features.replies for a reply,
 * features.nameTriggers for a name, features.mentions for a mention.
 * @param {TriggerKind} kind
 * @param {object} features
 * @returns {boolean}
 */
function callSwitchOff(kind, features) {
  if (kind === 'reply') return features.replies === false;
  if (kind === 'name') return features.nameTriggers === false;
  return features.mentions === false;
}

// Discord's answers for a message that no longer exists: HTTP 404 with the
// JSON code Unknown Message, or Unknown Channel when its channel went too.
const UNKNOWN_CHANNEL = 10003;
const UNKNOWN_MESSAGE = 10008;

/** Whether a failed message fetch said the message (or its channel) is not there any more. */
function isNotFound(err) {
  return err?.status === 404 || err?.code === UNKNOWN_MESSAGE || err?.code === UNKNOWN_CHANNEL;
}

/**
 * The `mention: dropped` reason for a call messageStillExists did not find:
 * `gone` (deleted) or `fetch-failed` (the lookup failed; it may still exist).
 * @param {'gone'|'error'} missing
 */
function missingReason(missing) {
  return missing === 'gone' ? 'gone' : 'fetch-failed';
}

/**
 * The media of `normalized` the buffered copy did not carry yet (`known`: the item ids of every
 * attachment and link of the buffered message and its forwarded snapshots): what an embed
 * Discord attached after the message arrived brought. Stickers and custom emoji always come
 * with the message itself, so none is late. Pure; never mutates `normalized`.
 * @param {object} normalized  A normalized message (interfaces/discord/collect.js#normalizeMessage).
 * @param {Set<string>} known
 * @returns {object} `normalized` with only the late attachments and links in each part.
 */
function lateMedia(normalized, known) {
  const fresh = (items) => (items ?? []).filter((item) => item?.id != null && !known.has(String(item.id)));
  const part = (p) => ({ ...p, attachments: fresh(p.attachments), links: fresh(p.links), stickers: [], emojis: [] });
  return { ...part(normalized), forwarded: (normalized.forwarded ?? []).map(part) };
}

/** The attachment and link item ids of a buffered (slim) message and its forwarded snapshots. */
function bufferedMediaIds(buffered) {
  const ids = new Set();
  for (const p of [buffered, ...(Array.isArray(buffered.forwarded) ? buffered.forwarded : [])]) {
    for (const item of [...(p?.attachments ?? []), ...(p?.links ?? [])]) {
      if (item?.id != null) ids.add(String(item.id));
    }
  }
  return ids;
}

/**
 * @param {object} deps
 * @param {import('../hot.js').createHot extends (...args: any) => infer R ? R : never} deps.hot
 * @param {ReturnType<import('../memory/store.js').createStore>} deps.store
 * @param {import('discord.js').Client} deps.client
 * @param {object} deps.discord  The Discord functions the pipeline calls, by name, from the
 *   Discord interface package (interfaces/discord/collect.js; src/index.js passes the interface's
 *   capabilities object, tests pass the same functions or fakes of them): `canSend(channel)`,
 *   `fetchHistory(channel, options)`,
 *   `fetchMessage(channel, id)`, `normalizeOptions(config)`, `normalizedOf(event)` and
 *   `toEvent(message, selfId, options)`, and the `isWritableChannel` and `audienceAllows` the
 *   route of a call it passes to (src/behavior/turn.js#routeFor). Required.
 * @param {ReturnType<import('./turn.js').createTurnRunner>} deps.turns
 * @param {ReturnType<import('./spontaneous.js').createSpontaneous>} deps.spontaneous
 * @param {ReturnType<import('../memory/update.js').createMemoryUpdater>} deps.memory
 * @param {ReturnType<import('./mention.js').createTagHistory>} deps.tagHistory
 * @param {object} [deps.llm]  From createLlm() (src/llm/openrouter.js), used for the address
 *   classifier (`features.followUp`): a message with no trigger, arriving while a
 *   conversation window this instance opened by answering is still open, is checked here before
 *   ever running a turn. Absent -- an older/direct caller, or a test that never opens a window --
 *   simply means `features.followUp` cannot ever fire (nothing reaches this dependency otherwise).
 *   The room classifier (spontaneous.roomQuestionChance, see maybeRoom) uses it too; absent, no
 *   room call is made.
 * @param {() => string | null} deps.getGuildId  the single guild this instance serves, or null before it resolves
 * @param {(guildId: string) => string} [deps.getSelfName]  The persona's display name in a guild
 *   (src/index.js). Default: the client's cached guild member, else the bot user's name.
 * @param {() => boolean} [deps.isWarmingUp]  true while the memory warmup runner
 *   (src/memory/warmup.js) is in flight: messages are still observed, but no
 *   trigger, turn, eavesdrop or pending-ping drain happens. Default: never warming up.
 * @param {object} [deps.describer]  From createDescriber() (src/memory/describe.js), optional: when
 *   absent, or features.mediaDescriptions is off, no description request is ever made from this
 *   pipeline. When present, every observed human message's pictures (up to
 *   media.prefillPerMessage) are handed to it fire-and-forget -- errors swallowed -- so the
 *   cache is already warm by the time the live memory analyzer (src/memory/update.js#analyze)
 *   wants a caption for one of them; the analyzer itself never triggers a new request. Only the
 *   address and room classifiers await a message's own prefill, then read captions from the cache alone
 *   (`describer.cachedDescriptions` / `cachedVideos`), never a new request. With
 *   features.mediaDescriptions, features.videoDescriptions (a missing key counts as on) and
 *   media.video.prefill all on, the message's first videos (up to
 *   media.video.prefillPerMessage) are handed to `describer.describeVideos` the same way.
 * @param {object} [deps.lookup]  From createLookup() (src/web/lookup.js), optional: with
 *   features.webLookup, web.links.enabled and web.links.prefill on, the message's first readable
 *   link (MAX_WARM_LINKS_PER_MESSAGE) is handed to `lookup.readLinks` the same way. Absent -> no
 *   link is ever read from this pipeline.
 * @param {() => number} [deps.rng]
 * @param {() => number} [deps.now]
 * @param {(ms: number) => Promise<void>} [deps.sleep]  Used only for the "human switch pause"
 *   before answering a deferred pending ping (mention.switchDelayMs) -- see drainPending below.
 * @param {{ set: (fn: () => void, ms: number) => any, clear: (timer: any) => void }} [deps.timers]
 *   The settle waits of calls from channels the persona cannot write in (see armSettle below).
 *   Default: setTimeout / clearTimeout, each timer unref'd.
 * @param {{ note: (channelId: string, authorId: string, at: number) => void }} [deps.activity]
 *   From src/behavior/activity.js#createActivity, shared with the turn runner: every message of
 *   anyone but the persona in a served channel or a private chat is noted (no contents), so a
 *   turn answering a person can wait until they stop writing (pace.settleMs). Absent: nothing noted.
 * @param {{ append: Function }|null} [deps.record]  From src/memory/record.js#createRecord,
 *   optional: with features.record exactly true (read at each event), a deleted message of the
 *   served guild writes a `deleted` line (onMessageDelete) and an edited one a `seen` line with
 *   the next revision (recordEdit). Absent: nothing is recorded here.
 * @param {{ noteFact: Function, noteActivity: Function }|null} [deps.missed]  From
 *   src/behavior/missed.js#createMissed, optional: a failed address classifier
 *   (`gate-failed`, or `gate-failopen` when it let the line through anyway) and a deferred
 *   follow-up replaced by a newer one (`replaced-deferred`, both ids) are noted as facts, and
 *   every message of a served channel as activity there. Absent: nothing is noted.
 * @returns {(event: import('../protocol.js').MessageReceived & { raw: import('discord.js').Message }) => Promise<void>}
 *   Takes the `message.received` event of a new message (interfaces/discord/collect.js#toEvent; src/index.js
 *   builds and validates it): the pipeline reads the normalised message, the mention and the reply
 *   from the event, and the discord.js message (`event.raw`, private to the Discord side and gone in
 *   stage 4 of the structure rework) only for its channel, guild, history and sends. Also carries a
 *   `.drainPending()` method: called once a turn finishes anywhere (src/index.js wires it to
 *   src/behavior/turn.js's `setOnIdle`, in the same `finally` that frees the channel) to answer
 *   the oldest non-expired pending direct ping, one at a time, after a human switch pause. And a
 *   `.clearPending()` method (`/nep pause`, wired from src/admin.js via src/index.js) that
 *   drops every queued ping and every settle wait without answering any of them. And a `.stop()`
 *   method (shutdown, src/index.js) that clears every settle wait, so none starts a turn while the
 *   client goes down. And an `.onMessageUpdate(event)` method (src/index.js wires it to
 *   `messageUpdate` through an edit event) that folds an embed Discord attached after the
 *   message arrived into its buffered copy -- see onMessageUpdate below. And an
 *   `.onMessageDelete(event)` method (src/index.js wires it to `messageDelete` through a
 *   deletion event) that writes a `deleted` line to the record. And a `.catchUp(event, { trigger })`
 *   method (src/behavior/catch-up.js, at start) for a message posted while the bot was offline:
 *   see catchUpMessage below.
 */
export function createMessageHandler({
  hot,
  store,
  client,
  discord,
  turns,
  spontaneous,
  memory,
  tagHistory,
  getGuildId,
  getSelfName = (guildId) => client.guilds?.cache?.get(guildId)?.members?.me?.displayName ?? client.user?.username ?? 'bot',
  isWarmingUp = () => false,
  describer,
  llm,
  lookup,
  rng = Math.random,
  now = Date.now,
  sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
  timers = { set: setTimeout, clear: clearTimeout },
  activity = null,
  record = null,
  missed = null,
}) {
  const { canSend, fetchHistory, fetchMessage, normalizeOptions, normalizedOf, toEvent } = discord;

  // The record's edits (recordEdit): messageId -> the last revision written, for the UTC day
  // `revisionsDay`; cleared when the day turns, so it stays small. An edit of a message not in
  // it is revision 2 (the message itself was revision 1); one the record already holds moves
  // past the record's newest (src/memory/record.js#appendRevision) and the count continues there.
  const revisions = new Map();
  let revisionsDay = null;

  /**
   * Whether the message `replyToId` (normalizeMessage's: a forward has none)
   * is one of the persona's own (collect.js#fetchMessage: the channel's cache
   * first, then a fetch; a failed fetch is no reply). A message that replies
   * to nothing costs no lookup.
   */
  async function resolveReference(channel, replyToId, selfId) {
    // Every guild message comes through here: no id, no fetch at all.
    if (!replyToId) return false;
    return (await fetchMessage(channel, replyToId))?.author?.id === selfId;
  }

  /**
   * Whether a turn blocks a new one in `channelId` (config read by the caller
   * now): with one attention (mention.oneAtATime, default on) a turn running
   * anywhere, otherwise one running in this channel -- the rule runTurn applies.
   */
  function turnBlocked(channelId, config) {
    return config.mention?.oneAtATime !== false ? turns.isAnyBusy() : turns.isBusy(channelId);
  }

  /**
   * Fire-and-forget: the message path never waits on it (see
   * createMessageHandler). A no-op when the feature is off or no describer was wired in, so
   * this pipeline makes zero describer calls in that case. Returns the
   * picture prefill's promise (it never rejects), or null when none started:
   * only the address and room classifiers await it, so a sticker- or
   * picture-only line reaches them with its caption (see cachedFollowUpMedia).
   * @returns {Promise<void>|null}
   */
  function warmMediaCache(guildId, normalized) {
    warmLinkCache(guildId, normalized);
    if (!describer) return null;
    warmVideoCache(guildId, normalized);
    if (hot.config.features?.mediaDescriptions !== true) return null;
    // Per real-time message, not per batch, so it stays small (media.prefillPerMessage).
    const max = prefillPerMessage(hot.config.media?.prefillPerMessage, 5);
    const candidates = describableItems([normalized]).slice(0, max);
    if (candidates.length === 0) return null;
    return describer
      .describeMany(guildId, candidates)
      .then(() => {})
      .catch((err) => log.warn('events: media cache prefill failed', { error: err }));
  }

  /**
   * The describable items of `messages`, in order: each message's pictures
   * (attachments/embeds/stickers) before its custom emoji, both filtered to
   * what the describer can actually caption.
   */
  function describableItems(messages) {
    return messages.flatMap((m) => [...collectPictures(m), ...collectEmojiItems(m)].filter(isDescribable));
  }

  /**
   * What the address classifier's transcript shows of `messages`' media:
   * `{ descriptions, videos }` read from the describer's cache only -- no
   * new request, nothing counted. `ownPrefill` (the candidate's own picture
   * prefill from warmMediaCache, already running) is awaited first, so the
   * candidate's caption is in the cache when it can be; it is never started
   * again here. Empty without a describer or with features.mediaDescriptions
   * off (read now).
   */
  async function cachedFollowUpMedia(guildId, messages, config, ownPrefill) {
    if (!describer || config.features?.mediaDescriptions !== true) return {};
    if (ownPrefill) await ownPrefill;
    const media = {};
    if (typeof describer.cachedDescriptions === 'function') {
      media.descriptions = describer.cachedDescriptions(guildId, describableItems(messages));
    }
    if (typeof describer.cachedVideos === 'function') {
      const sites = config.media?.video?.sites;
      const items = messages.flatMap((m) => collectVideos(m, { videoSites: sites }));
      if (items.length > 0) media.videos = await describer.cachedVideos(guildId, items);
    }
    return media;
  }

  /** Fire-and-forget like warmMediaCache: watch the message's first videos now, not when a turn needs it. */
  function warmVideoCache(guildId, normalized) {
    const config = hot.config;
    // Both switches, like the describer and the senses line; a missing videoDescriptions counts as on.
    if (!isVideoVisionOn(config)) return;
    if (config.media?.video?.prefill !== true) return;
    if (typeof describer.describeVideos !== 'function') return;
    // Watching is far dearer than a picture caption: one video per message by default.
    const max = prefillPerMessage(config.media.video.prefillPerMessage, 5);
    const candidates = collectVideos(normalized, { videoSites: config.media.video.sites }).slice(0, max);
    if (candidates.length === 0) return;
    describer
      .describeVideos(guildId, candidates)
      .catch((err) => log.warn('events: video cache prefill failed', { error: err }));
  }

  /**
   * Fire-and-forget like warmMediaCache: read the message's first readable
   * link now (src/web/lookup.js), not when a turn needs it. Needs
   * features.webLookup (a missing key counts as OFF: it costs money),
   * web.links.enabled (a missing key counts as on) and web.links.prefill.
   * One member gets at most `web.links.prefillPerUserPerDay` new fetches a
   * UTC day this way (in memory; cache hits are free), so posting links
   * cannot spend `web.maxPerDay` for everyone. The turn path is not limited.
   */
  function warmLinkCache(guildId, normalized) {
    if (typeof lookup?.readLinks !== 'function') return;
    const config = hot.config;
    if (config.features?.webLookup !== true) return;
    const linksCfg = config.web?.links ?? {};
    if (linksCfg.enabled === false || linksCfg.prefill !== true) return;
    const links = collectReadableLinks(normalized, { videoSites: config.media?.video?.sites ?? [] }).slice(0, MAX_WARM_LINKS_PER_MESSAGE);
    if (links.length === 0) return;
    const perUser = Number.isFinite(linksCfg.prefillPerUserPerDay)
      ? Math.max(0, Math.floor(linksCfg.prefillPerUserPerDay))
      : PREFILL_PER_USER_PER_DAY_FALLBACK;
    const slot = reservePrefill(`${guildId}:${normalized.authorId ?? ''}`, links.length, perUser);
    if (slot.granted === 0) return;
    Promise.resolve()
      .then(() => lookup.readLinks(guildId, links, { maxNew: slot.granted }))
      .then((result) => refundPrefill(slot, slot.granted - (result?.newCount ?? 0)))
      .catch((err) => log.warn('events: link prefill failed', { error: err }));
  }

  // Per-(guild, author) prefill counts for the current UTC day; cleared when the day turns.
  const prefillCounts = new Map();
  let prefillDay = null;

  /** Take up to `wanted` of the member's remaining daily prefill slots: `{ key, day, granted }`. */
  function reservePrefill(key, wanted, perUser) {
    const day = utcDay(now());
    if (day !== prefillDay) {
      prefillDay = day;
      prefillCounts.clear();
    }
    const used = prefillCounts.get(key) ?? 0;
    const granted = Math.max(0, Math.min(wanted, perUser - used));
    if (granted > 0) prefillCounts.set(key, used + granted);
    return { key, day, granted };
  }

  /** Give back the slots a prefill did not spend on a new fetch (a cache hit, a fresh miss, the daily cap). */
  function refundPrefill(slot, unused) {
    if (unused <= 0 || slot.day !== prefillDay) return;
    const used = prefillCounts.get(slot.key) ?? 0;
    prefillCounts.set(slot.key, Math.max(0, used - unused));
  }

  // --- The address classifier (mention.followUp*) ---------------------------
  // A conversation window per channel: (re)opened and extended to `now`
  // whenever the persona sends a message there -- hooked in the self-message
  // branch of onMessage below (the same place turns.notePost() is called),
  // never here. An untagged message that arrives while the window is open is
  // not answered blindly: it goes through address.md first (see
  // docs/prompt-contract.md, "The address classifier"). Its answer is `yes`
  // (said to the persona: a follow-up turn), `overheard` (about the persona,
  // said to someone else or to the room: an overheard turn, or a follow-up
  // with mention.followUpOverheard off) or `no`.
  //
  // The Map is mirrored into `store.state.data.followUpWindows` (timestamps
  // and a counter only, never message text) so a restart does not close
  // every open window; the saved entries are loaded back just below.
  let missingAddressPromptLogged = false;
  const followUpWindows = new Map(); // channelId -> { openedAt, lastAnswerAt, noStreak }
  const followUpInFlight = new Set(); // channelIds with a classifier call running right now
  const followUpHeld = new Map(); // channelId -> { message, normalized, selfId, ownPrefill }: the latest message that arrived in flight

  /** Mirror one window into state.json (a fresh copy, numbers only). */
  function persistFollowUpWindow(channelId, window) {
    const state = store?.state;
    if (!state?.data) return;
    if (!state.data.followUpWindows || typeof state.data.followUpWindows !== 'object') state.data.followUpWindows = {};
    state.data.followUpWindows[channelId] = {
      openedAt: window.openedAt,
      lastAnswerAt: window.lastAnswerAt,
      noStreak: window.noStreak,
    };
    state.markDirty?.();
  }

  /** Close a window: drop it from the Map and delete its key from state.json. */
  function closeFollowUpWindow(channelId) {
    followUpWindows.delete(channelId);
    const saved = store?.state?.data?.followUpWindows;
    if (saved && typeof saved === 'object' && Object.hasOwn(saved, channelId)) {
      delete saved[channelId];
      store.state.markDirty?.();
    }
  }

  /**
   * Startup: load the saved windows back, dropping (and deleting from state)
   * any whose last answer is already older than `mention.followUpMinutes`
   * (read now) or that is malformed. Started paused (`/nep pause`), the
   * dropped ones are only left out of the Map: state.json is not touched.
   */
  function loadFollowUpWindows() {
    const saved = store?.state?.data?.followUpWindows;
    if (!saved || typeof saved !== 'object') return;
    const paused = Boolean(store.state.data.paused);
    const minutes = hot.config.mention?.followUpMinutes ?? 15;
    const t = now();
    let dropped = 0;
    for (const [channelId, entry] of Object.entries(saved)) {
      const valid =
        entry &&
        Number.isFinite(entry.openedAt) &&
        Number.isFinite(entry.lastAnswerAt) &&
        Number.isFinite(entry.noStreak);
      if (valid && t - entry.lastAnswerAt < minutes * MINUTE_MS) {
        followUpWindows.set(channelId, { openedAt: entry.openedAt, lastAnswerAt: entry.lastAnswerAt, noStreak: entry.noStreak });
      } else {
        if (!paused) delete saved[channelId];
        dropped += 1;
      }
    }
    if (dropped > 0 && !paused) store.state.markDirty?.();
    if (followUpWindows.size > 0 || dropped > 0) {
      log.info('follow-up: windows restored', { restored: followUpWindows.size, dropped, ...(paused ? { paused: true } : {}) });
    }
  }
  loadFollowUpWindows();

  /** (Re)opens/extends the window -- called wherever the persona's own message is observed. */
  function noteFollowUpSend(channelId, ts) {
    const window = { openedAt: ts, lastAnswerAt: ts, noStreak: 0 };
    followUpWindows.set(channelId, window);
    persistFollowUpWindow(channelId, window);
  }

  /** One "no" verdict (pre-filter or model): bump the streak, close the window once the streak reaches the limit. */
  function bumpFollowUpNoStreak(channelId, state, mentionCfg) {
    state.noStreak += 1;
    // A window replaced meanwhile (the persona spoke again while a classifier
    // call was in flight) is not the live one: nothing to mirror or close.
    if (followUpWindows.get(channelId) !== state) return;
    if (state.noStreak >= (mentionCfg.followUpNoStreak ?? 5)) {
      log.info('follow-up: window closed', { channel: channelId });
      closeFollowUpWindow(channelId);
    } else {
      persistFollowUpWindow(channelId, state);
    }
  }

  /**
   * The request of a classifier about one new message, shared by the address
   * classifier and the room classifier: system = `prompt` (address.md or
   * room.md, `{{name}}` filled), user = the last `mention.followUpContext`
   * lines of the channel, then an `<author>` block when the new message's
   * author has stored aliases (followUpAuthorLine), then the new message
   * wrapped in a `<candidate>` block (tags structural, not model-facing
   * wording). Pictures, stickers, emoji and videos carry the captions the
   * describer already cached (cachedFollowUpMedia). Also `history`, the
   * fetched lines without the candidate (never sent). `null` when `prompt` is
   * missing -- the caller treats that the same as a "no".
   */
  async function buildClassifierRequest({ prompt, config, prompts, channel, selfId, selfName, normalized, ownPrefill }) {
    if (!prompt) return null;
    const labels = prompts.labels;
    const contextLines = Math.max(0, config.mention.followUpContext ?? 15);
    const raw = contextLines > 0 ? await fetchHistory(channel, { limit: contextLines, selfId, embedTextChars: config.media?.embedTextChars, videoSites: config.media?.video?.sites, maxUrlChars: config.context?.maxUrlChars }) : [];
    const history = raw.filter((m) => m.id !== normalized.id);
    const messages = [...history, normalized];
    const { descriptions, videos } = await cachedFollowUpMedia(channel.guild.id, messages, config, ownPrefill);
    const items = formatTranscript(messages, {
      timezone: config.bot.timezone,
      gapMinutes: config.context.gapMarkerMinutes,
      maxChars: config.context.maxMessageChars,
      selfName,
      labels,
      seeReactions: config.features?.seeReactions !== false,
      reactionsPerMessage: config.context.reactionsPerMessage,
      replyQuoteChars: config.context.replyQuoteChars,
      descriptions,
      videos,
    });
    const candidateItem = items[items.length - 1];
    const transcript = renderTranscript(items.slice(0, -1), config.bot.timezone, labels);
    const author = followUpAuthorLine(channel.guild.id, normalized, config, labels);
    const authorBlock = author ? `\n<author>\n${author}\n</author>` : '';
    return {
      system: fillPromptTemplate(prompt, { name: selfName }),
      user: `${transcript}${authorBlock}\n<candidate>\n${candidateItem.text}\n</candidate>`,
      // The fetched lines themselves (never sent): a failed address call decides from them (activeExchangeWith).
      history,
    };
  }

  /**
   * The `<author>` block's one line: the candidate author's display name and
   * the top `mention.followUpAliases` stored aliases by rank (decayed with
   * `memory.aliasHalfLifeDays`, the same order the persona's own request
   * shows), filled into `labels.address.author` (`{name}`, `{aliases}`) --
   * so the classifier can tie a nickname in the persona's line to this
   * member. Read-only (`store.getUser`). `''` (no block) with no profile, no
   * aliases, a cap of 0 or no `labels.address.author`.
   */
  function followUpAuthorLine(guildId, normalized, config, labels) {
    const template = labels?.address?.author;
    if (!template) return '';
    const cap = Math.max(0, Math.floor(config.mention?.followUpAliases ?? 5));
    if (!(cap > 0)) return '';
    const profile = store?.getUser?.(guildId, normalized.authorId);
    const aliases = Array.isArray(profile?.aliases) ? profile.aliases : [];
    const names = topByRank(aliases, cap, config.memory?.aliasHalfLifeDays).map((item) => item.name);
    if (names.length === 0) return '';
    return fill(template, { name: normalized.authorName, aliases: names.join(', ') });
  }

  /** Whether the address classifier is switched off (features.followUp or features.mentions false) in `config`. */
  function followUpOff(config) {
    const features = config.features ?? {};
    return features.followUp === false || features.mentions === false;
  }

  /**
   * Why the persona is mute right now, as onMessage sees it before any
   * classifier (and a settle wait when it is over): `'paused'` (`/nep
   * pause`), `'warmup'` (a memory warmup run in flight) or null.
   * @returns {'paused'|'warmup'|null}
   */
  function followUpMuted() {
    if (store?.state?.data?.paused) return 'paused';
    return isWarmingUp() ? 'warmup' : null;
  }

  /**
   * The checks in front of the classifier, read from the hot config now:
   * `{ kind: 'skip', reason }` when the classifier does not apply (feature
   * off, no open window, a turn that would refuse this one -- see
   * turnBlocked -- whose "yes" could not be deferred, cannot send), `{ kind: 'handled' }` when the pre-filter
   * already gave a "no" (logged, streak bumped), `{ kind: 'classify', config,
   * state }` when the model must be asked.
   */
  function followUpGate(message, normalized, selfId) {
    const config = hot.config;
    if (followUpOff(config)) return { kind: 'skip', reason: 'off' };

    const channel = message.channel;
    const channelId = channel.id;
    const mentionCfg = config.mention;
    const state = followUpWindows.get(channelId);
    if (!isFollowUpOpen(state, now(), mentionCfg)) {
      if (state) closeFollowUpWindow(channelId); // expired: forget it here and in state.json
      return { kind: 'skip', reason: 'closed' };
    }
    // A turn that blocks this one (turnBlocked) does not stop the classifier
    // (mention.classifyWhileBusy, missing = on): its "yes" waits in the
    // pending queue (startFollowUpTurn -> deferFollowUp). The paid call is
    // skipped only when that "yes" could not wait: the switch off, or its
    // own channel busy with mention.pendingSameChannel off.
    if (turnBlocked(channelId, config)) {
      const sameChannelDrop = turns.isBusy(channelId) && mentionCfg.pendingSameChannel === false;
      if (mentionCfg.classifyWhileBusy === false || sameChannelDrop) return { kind: 'skip', reason: 'busy' };
    }
    if (!canSend(channel)) return { kind: 'skip', reason: 'cannot-send' };

    const startedAt = now();
    if (followUpPreFilter(normalized, selfId, mentionCfg)) {
      log.info('follow-up: verdict', { channel: channelId, author: normalized.authorId, verdict: 'no', answer: 'no', ms: now() - startedAt });
      bumpFollowUpNoStreak(channelId, state, mentionCfg);
      return { kind: 'handled' };
    }
    return { kind: 'classify', config, state };
  }

  /**
   * Whether an untagged `normalized` message was fully handled by the address
   * classifier (pre-filter or a real model verdict, any answer, or
   * held for a classifier call already in flight in its channel) -- the
   * caller must then NOT also hand it to the spontaneous scheduler. Never
   * throws: an LLM/context-building error is treated as a "no" per the
   * contract. `false` means none of this applied (feature off, no open
   * window, a turn running that blocks this one with mention.classifyWhileBusy
   * off -- see followUpGate) and the caller falls back to its usual
   * handling. `ownPrefill` is the message's picture prefill from
   * warmMediaCache (or null), awaited before its classifier request is built.
   */
  async function maybeFollowUp(message, normalized, selfId, ownPrefill = null) {
    const gate = followUpGate(message, normalized, selfId);
    if (gate.kind === 'skip') return false;
    if (gate.kind === 'handled') return true;

    // At most one classifier call in flight per channel. A message landing
    // while one is already running is held (only the latest per channel; an
    // earlier held one is replaced) and returned as handled. When the call in
    // flight ends without starting a turn, the held message goes through the
    // gate and the classifier as if it had just arrived; after a turn started
    // (a "yes") it is dropped, since the turn reads it in the channel history
    // anyway. An overheard turn frames its line as not said to the persona,
    // so it waits instead: the held message is classified first
    // (settleFollowUp). The slot stays taken until the held messages are
    // worked off, one at a time.
    const channelId = message.channel.id;
    if (followUpInFlight.has(channelId)) {
      const replaced = followUpHeld.has(channelId);
      followUpHeld.set(channelId, { message, normalized, selfId, ownPrefill });
      log.info('follow-up: held while a classifier call is in flight', { channel: channelId, message: normalized.id, replaced });
      return true;
    }

    followUpInFlight.add(channelId);
    let settled;
    try {
      const answer = await classifyFollowUp(message, normalized, selfId, gate, ownPrefill);
      settled = settleFollowUp(channelId, { message, normalized }, answer);
    } catch (err) {
      followUpHeld.delete(channelId);
      followUpInFlight.delete(channelId);
      throw err;
    }
    // Not awaited: this message is answered (or waits on a held one); a held
    // one is classified in the background, still holding the slot. With
    // nothing held the slot is released synchronously, before this returns.
    classifyHeldFollowUps(channelId, settled).catch((err) =>
      log.error('follow-up: classifying a held message failed', { channel: channelId, error: err }),
    );
    return true;
  }

  /**
   * Works off the messages held for `channelId` while its classifier slot was
   * taken, one at a time, then frees the slot. `settled` is what the call
   * that just ended left (settleFollowUp): whether it started a turn, and the
   * overheard line still waiting on the held messages, if any. A waiting
   * line that no newer verdict replaced is started at the end
   * (startWaitingLine: its turn is overheard, or followUp with the switch
   * turned off meanwhile) -- or dropped there.
   * @param {string} channelId
   * @param {{ started: boolean, waiting: { message: object, normalized: object }|null }} settled
   */
  async function classifyHeldFollowUps(channelId, settled) {
    try {
      let { started, waiting } = settled;
      for (;;) {
        const held = followUpHeld.get(channelId);
        if (!held) break;
        followUpHeld.delete(channelId);
        if (started) {
          log.info('follow-up: held message dropped', { channel: channelId, message: held.normalized.id, reason: 'turn' });
          return;
        }
        // As if it had just arrived: paused or warming up, onMessage would
        // never reach the classifier (and pause forbids marking the store dirty).
        const muted = followUpMuted();
        const gate = muted ? { kind: 'skip', reason: muted } : followUpGate(held.message, held.normalized, held.selfId);
        if (gate.kind === 'skip') {
          log.info('follow-up: held message dropped', { channel: channelId, message: held.normalized.id, reason: gate.reason });
          // A waiting line meets the same check in startWaitingLine, except
          // `closed` (it was classified inside the window).
          break;
        }
        if (gate.kind === 'handled') break;
        const answer = await classifyFollowUp(held.message, held.normalized, held.selfId, gate, held.ownPrefill);
        ({ started, waiting } = settleFollowUp(channelId, held, answer, waiting));
      }
      if (waiting) startWaitingLine(channelId, waiting);
    } finally {
      followUpHeld.delete(channelId);
      followUpInFlight.delete(channelId);
    }
  }

  /**
   * What an answer of the address classifier starts for `candidate` (`{
   * message, normalized }`): `{ started, waiting }`. A "no" starts nothing and
   * keeps `waiting` (an earlier overheard line still waiting on held
   * messages). An overheard turn (followUpTriggerKind, the switch read now)
   * waits while a newer message is held in the channel: that one is
   * classified first. Otherwise the turn starts now (startFollowUpTurn), and
   * a waiting line gives way to this newer one, whose turn reads it in the
   * channel history.
   * @param {string} channelId
   * @param {{ message: object, normalized: object }} candidate
   * @param {'yes'|'overheard'|'no'} answer
   * @param {{ message: object, normalized: object }|null} [waiting]
   * @returns {{ started: boolean, waiting: { message: object, normalized: object }|null }}
   */
  function settleFollowUp(channelId, candidate, answer, waiting = null) {
    if (answer === 'no') return { started: false, waiting };
    if (waiting) log.info('follow-up: dropped', { channel: channelId, message: waiting.normalized.id, reason: 'newer' });
    const triggerKind = followUpTriggerKind(answer, hot.config.mention);
    if (triggerKind === 'overheard' && followUpHeld.has(channelId)) return { started: false, waiting: candidate };
    return { started: startFollowUpTurn(candidate, triggerKind), waiting: null };
  }

  /**
   * Start the overheard line that waited on the held messages (settleFollowUp)
   * once they are worked off. That took at least one more classifier call,
   * so the gate's checks that do not depend on the window are read again
   * now: paused, a warmup run, the follow-up or mention switch off, or no
   * Send Messages drop the line (`follow-up: dropped` with that reason); a
   * turn running drops it as busy (startFollowUpTurn). A window closed
   * meanwhile does not: the line was classified while it was open. The kind
   * is read now as well (followUpTriggerKind).
   * @param {string} channelId
   * @param {{ message: object, normalized: object }} waiting
   */
  function startWaitingLine(channelId, waiting) {
    const config = hot.config;
    let reason = followUpMuted();
    if (!reason && followUpOff(config)) reason = 'off';
    if (!reason && !canSend(waiting.message.channel)) reason = 'cannot-send';
    if (reason) {
      log.info('follow-up: dropped', { channel: channelId, message: waiting.normalized.id, reason });
      return;
    }
    startFollowUpTurn(waiting, followUpTriggerKind('overheard', config.mention));
  }

  /**
   * One classifier call for `normalized` (the gate already passed): logs the
   * verdict and bumps the no-streak on a "no"; a "yes" or an "overheard"
   * leaves the streak alone (the persona is still part of the exchange).
   * Resolves to the answer (parseAddressAnswer); the caller starts the turn
   * (settleFollowUp) and owns the in-flight slot. A call that threw or
   * answered nothing is a "yes" while the message keeps an active one-to-one
   * exchange (activeExchangeWith, within mention.failOpenMinutes read now;
   * 0 = off), a "no" otherwise -- `follow-up: fail-open` says which.
   * @returns {Promise<'yes'|'overheard'|'no'>}
   */
  async function classifyFollowUp(message, normalized, selfId, { config, state }, ownPrefill = null) {
    const channel = message.channel;
    const channelId = channel.id;
    const mentionCfg = config.mention;
    const startedAt = now();
    const selfName = getSelfName(channel.guild.id);
    let request = null;
    let buildFailed = false;
    try {
      const prompts = hot.prompts;
      request = await buildClassifierRequest({ prompt: prompts?.address, config, prompts, channel, selfId, selfName, normalized, ownPrefill });
    } catch (err) {
      buildFailed = true;
      log.warn('follow-up: building the classifier request failed', { channel: channelId, error: err });
    }

    if (!request) {
      // Only a really missing prompt latches its one warning; a failed build was logged above.
      if (!buildFailed && !missingAddressPromptLogged) {
        missingAddressPromptLogged = true;
        log.warn('follow-up: prompts.address is missing, every follow-up is treated as "no"', {});
      }
      // A failed build is a failed gate (src/behavior/missed.js); a missing prompt is the deployment's.
      if (buildFailed) missed?.noteFact({ reason: 'gate-failed', message: normalized, failure: 'build-failed' });
      log.info('follow-up: verdict', { channel: channelId, author: normalized.authorId, verdict: 'no', answer: 'no', ms: now() - startedAt });
      bumpFollowUpNoStreak(channelId, state, mentionCfg);
      return 'no';
    }

    let answer = 'no';
    let failure = null; // 'classifier-failed' | 'empty' when the call gave no answer
    if (llm) {
      // Read once: the request and its empty-answer warning name the same model.
      const model = roleModel(config, 'analyzer', 'address');
      try {
        // A classifier call skipped by the daily cap (DailyCapError, thrown
        // synchronously before any fetch) lands here exactly like any other
        // error -- "no", logged, no request ever left the process.
        const completion = await llm.complete(
          [
            { role: 'system', content: request.system },
            { role: 'user', content: request.user },
          ],
          {
            model,
            // A helper's request: on llm.helperTimeoutMs, never the turn-length llm.timeoutMs, and
            // hedged (llm.hedge) -- while this call is in flight it holds the channel's follow-up
            // slot, and every untagged line there is only held.
            ...helperRequestOptions(config, { role: 'analyzer', maxOutputTokens: mentionCfg.followUpMaxOutputTokens, purpose: 'address' }),
          },
        );
        if (String(completion.text ?? '').trim()) {
          answer = parseAddressAnswer(completion.text);
        } else {
          // Nothing at all (typically a reasoning model that spent its whole
          // output cap thinking) is a failed call, not a silent "no".
          log.warn('follow-up: classifier failed', { channel: channelId, reason: 'empty', model: model ?? null });
          failure = 'empty';
        }
      } catch (err) {
        answer = 'no';
        log.warn('follow-up: classifier failed', { channel: channelId, error: err });
        failure = 'classifier-failed';
      }
    }

    // A failed call (provider slowness, a timeout) does not drop a line from
    // the member the persona is talking with one to one right now.
    const failOpenMinutes = mentionCfg.failOpenMinutes ?? 3;
    let open = false;
    if (failure && failOpenMinutes > 0) {
      open = activeExchangeWith(request.history, { authorId: normalized.authorId, ts: normalized.ts ?? now() }, failOpenMinutes);
      log.info('follow-up: fail-open', { channel: channelId, author: normalized.authorId, reason: failure, open });
      if (open) answer = 'yes';
    }
    // A failed gate is a fact for the missed-answer registry (src/behavior/missed.js), let through or not.
    if (failure) missed?.noteFact({ reason: open ? 'gate-failopen' : 'gate-failed', message: normalized, failure });

    // `verdict` is the two-way projection (overheard counts as yes), `answer` the word itself.
    const verdict = answer === 'no' ? 'no' : 'yes';
    log.info('follow-up: verdict', { channel: channelId, author: normalized.authorId, verdict, answer, ms: now() - startedAt });
    if (answer === 'no') missed?.noteNotAddressed?.(normalized);
    if (answer === 'no') bumpFollowUpNoStreak(channelId, state, mentionCfg);
    return answer;
  }

  /**
   * Start the reply turn a follow-up verdict asked for, `triggerKind` being
   * `followUp` or `overheard` (followUpTriggerKind). Never awaits the turn;
   * returns whether it was started: a turn started
   * elsewhere while the classifier was thinking (turnBlocked, read now)
   * would answer 'busy', so none is started (and a held message is not
   * dropped as already answered). A `followUp` that finds the attention
   * taken -- here, or as runTurn's 'busy' -- waits in the pending queue
   * (deferFollowUp); so does an `overheard` one while
   * mention.pendingOverheard is on (missing = on, read at that moment),
   * keeping its kind; with the switch off it is dropped (`follow-up:
   * dropped`, `busy`). A `followUp` the ignore roll lets pass
   * (mention.followUpIgnoreChance, `ignored:follow-up`) starts no turn and
   * returns false, so a line held meanwhile is classified next.
   * @param {{ message: object, normalized: object }} candidate
   * @param {'followUp'|'overheard'} triggerKind
   * @returns {boolean}
   */
  function startFollowUpTurn({ message, normalized }, triggerKind) {
    const channel = message.channel;
    const channelId = channel.id;
    const config = hot.config;
    if (turnBlocked(channelId, config)) {
      if (waitsWhenBusy(triggerKind, config)) deferFollowUp(channel, normalized, triggerKind);
      else log.info('follow-up: dropped', { channel: channelId, message: normalized.id, reason: 'busy' });
      return false;
    }
    // A follow-up is counted for spam (mention.spamThreshold, future
    // explicit pings) and rolled for mention.followUpIgnoreChance
    // (decideAndLog): the persona may let the other person have the last
    // word. An ignored one starts no turn and leaves the window and its
    // no-streak as they are. Talk about the persona (overheard) is not a call
    // to it: neither counted nor rolled.
    if (triggerKind === 'followUp' && !decideAndLog(channel, normalized, 'followUp', config).respond) return false;
    turns
      .runTurn({ channel, mode: 'reply', trigger: normalized, triggerKind })
      .then((result) => {
        if (result?.outcome === 'busy') {
          if (!waitsWhenBusy(triggerKind, hot.config)) {
            log.info('follow-up: dropped', { channel: channelId, message: normalized.id, reason: 'busy' });
            return undefined;
          }
          deferFollowUp(channel, normalized, triggerKind);
          if (!turnBlocked(channelId, hot.config)) return drainPending();
          return undefined;
        }
        return announceRefusal(channel, normalized, result, triggerKind);
      })
      .catch((err) => log.error('follow-up: reply turn failed', { channel: channelId, error: err }));
    return true;
  }

  /**
   * Whether a follow-up turn of `triggerKind` that found the attention taken
   * waits in the pending queue: a `followUp` always, an `overheard` while
   * mention.pendingOverheard is on in `config` (missing = on).
   * @param {'followUp'|'overheard'} triggerKind
   * @param {object} config
   * @returns {boolean}
   */
  function waitsWhenBusy(triggerKind, config) {
    return triggerKind === 'followUp' || config.mention?.pendingOverheard !== false;
  }

  // --- Room questions (spontaneous.roomQuestionChance) -----------------------
  // Outside any follow-up window, an untagged line that failed the eavesdrop
  // roll may be a question or remark put to everyone present. When the
  // eavesdrop rails pass for its channel now (spontaneous.eavesdropReady),
  // the line passes roomPreFilter (text, no reply, no member mention) and a
  // roll of spontaneous.roomQuestionChance wins, the room classifier
  // (room.md, the same request shape as the address classifier:
  // buildClassifierRequest) is asked once; a `yes` hands the line back to the
  // scheduler as a room line (spontaneous.onMessage with `room`: no second
  // roll, the turn about that line). At most one call per channel in flight;
  // a line arriving meanwhile is skipped, not held. Nothing is persisted.
  const roomInFlight = new Set(); // channelIds with a room classifier call running right now

  /**
   * The room path of an untagged `normalized` message the eavesdrop roll did
   * not schedule (onMessage step 10), every check read from the live config
   * now, the cheap ones first: the chance above 0 and an llm, no open
   * follow-up window in the channel, the eavesdrop rails, the pre-filter,
   * then the roll; only then the prompt (`room: skipped`, `no-prompt`) and
   * the channel's slot (`in-flight`). Never throws past its own call:
   * classifyRoom logs a failure and answers null.
   */
  async function maybeRoom(message, normalized, selfId, ownPrefill) {
    const config = hot.config;
    const chance = roomQuestionChance(config);
    if (!(chance > 0) || !llm) return;
    const channel = message.channel;
    if (isFollowUpOpen(followUpWindows.get(channel.id), now(), config.mention)) return;
    if (spontaneous.eavesdropReady?.(channel) !== true) return;
    if (!roomPreFilter(normalized)) return;
    if (rng() >= chance) return;
    const prompt = hot.prompts?.room;
    if (!prompt) {
      log.info('room: skipped', { channel: channel.id, reason: 'no-prompt' });
      return;
    }
    if (roomInFlight.has(channel.id)) {
      log.info('room: skipped', { channel: channel.id, reason: 'in-flight' });
      return;
    }
    roomInFlight.add(channel.id);
    try {
      const answer = await classifyRoom({ channel, normalized, selfId, ownPrefill, prompt, config });
      if (answer === 'yes') spontaneous.onMessage(channel, normalized, { room: true });
    } finally {
      roomInFlight.delete(channel.id);
    }
  }

  /**
   * One room classifier call for `normalized` in `channel`: the request from
   * buildClassifierRequest with `prompt` (room.md), sent with the helper
   * request options (role analyzer, mention.followUpMaxOutputTokens, the
   * daily cap, llm.helperTimeoutMs, purpose `room`). Resolves to `'yes'` or
   * `'no'` (`room: verdict`; the first word, read as the address
   * classifier's answer is: anything but a yes is a no), or null when no
   * verdict came: a request that could not be built (`room: skipped`,
   * `failed`) or a call that failed or answered nothing (`room: classifier
   * failed` with `reason`: the rail's code, `llm-error` or `empty`, and the
   * HTTP `status` when there is one).
   * @returns {Promise<'yes'|'no'|null>}
   */
  async function classifyRoom({ channel, normalized, selfId, ownPrefill, prompt, config }) {
    const channelId = channel.id;
    const startedAt = now();
    const selfName = getSelfName(channel.guild.id);
    let request = null;
    try {
      request = await buildClassifierRequest({ prompt, config, prompts: hot.prompts, channel, selfId, selfName, normalized, ownPrefill });
    } catch (err) {
      log.warn('room: skipped', { channel: channelId, reason: 'failed', name: err?.name ?? null });
      return null;
    }
    if (!request) return null;

    const model = roleModel(config, 'analyzer', 'room');
    let completion;
    try {
      completion = await llm.complete(
        [
          { role: 'system', content: request.system },
          { role: 'user', content: request.user },
        ],
        {
          model,
          ...helperRequestOptions(config, { role: 'analyzer', maxOutputTokens: config.mention?.followUpMaxOutputTokens, purpose: 'room' }),
        },
      );
    } catch (err) {
      log.warn('room: classifier failed', { channel: channelId, reason: railReason(err), status: err?.statusCode ?? null, name: err?.name ?? null });
      return null;
    }
    const text = String(completion?.text ?? '').trim();
    if (!text) {
      // Nothing at all (a reasoning model that spent its whole output cap) is a failed call, not a "no".
      log.warn('room: classifier failed', { channel: channelId, reason: 'empty', status: null, model: model ?? null });
      return null;
    }
    const answer = parseAddressAnswer(text) === 'yes' ? 'yes' : 'no';
    log.info('room: verdict', { channel: channelId, author: normalized.authorId, answer, ms: now() - startedAt });
    return answer;
  }

  // --- Limit notices ----------------------------------------------------------
  // A turn someone asked for (a mention, reply, name, follow-up or private
  // message) that a rail refused gets one plain line naming the limit and the
  // numbers (labels.limits.notice), so the requester knows it was a limit and
  // not silence in character. Spontaneous turns never come through here; an
  // overheard turn does, and nobody asked for it: it stays silent too.

  /**
   * Post the limit notice in `channel` (src/behavior/limits.js#postLimitNotice:
   * labels, dry-run and the mirror read now). A follow-up's notice is never a
   * Discord reply, like the follow-up turn itself; nor is one posted `plain`
   * (a routed call's, whose trigger lives in another channel). Never throws.
   * @param {TriggerKind} triggerKind
   * @param {{ plain?: boolean }} [options]
   */
  async function notifyLimit(channel, trigger, limit, triggerKind, { plain = false } = {}) {
    await postLimitNotice({
      channel,
      trigger,
      limit,
      asReply: !plain && triggerKind !== 'followUp',
      labels: hot.prompts?.labels,
      config: hot.config,
      client,
    });
  }

  /**
   * After a triggered turn: a rail refusal that carries its limit gets the
   * notice in `channel` -- except on an overheard turn, which nobody asked
   * for. `plain`: see notifyLimit.
   * @param {{ outcome: TurnOutcome, limit?: object|null }|undefined} result
   * @param {TriggerKind} triggerKind
   * @param {{ plain?: boolean }} [options]
   */
  async function announceRefusal(channel, trigger, result, triggerKind, { plain = false } = {}) {
    if (triggerKind === 'overheard') return;
    if (result?.outcome !== 'refused' || !result.limit) return;
    await notifyLimit(channel, trigger, result.limit, triggerKind, { plain });
  }

  /**
   * `{ destination: id }` for the log lines of a routed call (anything
   * carrying the channel its turn posts in as `destination`: a call, a
   * pending ping), `{}` for any other.
   * @param {{ destination?: object|null }} call
   */
  function routedFields({ destination }) {
    return destination ? { destination: destination.id } : {};
  }

  /**
   * After the reply turn of a server call, the live path and the drain alike:
   * a rail refusal gets its limit notice (announceRefusal). A routed call
   * (`destination`: the channel its turn posted in) gets it there, as a plain
   * message -- never a Discord reply to a message of another channel -- and its
   * ring entry follows the outcome (markRoutedCall).
   * @param {object} channel  Where the call was written.
   * @param {object} trigger
   * @param {{ outcome: TurnOutcome, dryRun?: boolean, delivered?: boolean, limit?: object|null }|undefined} result
   * @param {TriggerKind} kind
   * @param {object|null} [destination]
   */
  async function afterCallTurn(channel, trigger, result, kind, destination = null) {
    if (!destination) {
      await announceRefusal(channel, trigger, result, kind);
      return;
    }
    markRoutedCall(trigger.id, result);
    await announceRefusal(destination, trigger, result, kind, { plain: true });
  }

  /**
   * The routed call itself after its turn (state.json `elsewherePings`, read
   * by every later pull of the source; stampRing): answered when the turn
   * spoke for real and something reached the chat (`delivered`: a reaction
   * alone counts), skipped when the persona chose silence (`skip`) or nothing
   * it chose reached the chat (a reaction dropped or refused). The other
   * calls of the ring the turn showed -- one this call replaced, an earlier
   * one still waiting -- are the turn's to stamp, by what its output answered
   * (src/behavior/turn.js#stampShownCalls); one it did not show stays as it
   * was. A dry run that spoke reached nobody and stamps nothing (the call
   * stays unanswered); a dry run that skipped stamps it like any skip --
   * silence is the persona's choice, not a post. Any other outcome (an error,
   * a refusal, busy, paused) stamps nothing.
   * @param {string} messageId
   * @param {{ outcome: TurnOutcome, dryRun?: boolean, delivered?: boolean }|undefined} result
   */
  function markRoutedCall(messageId, result) {
    let status = null;
    if (result?.outcome === 'skip') status = 'skipped';
    else if (result?.outcome === 'spoke' && result.dryRun !== true) status = result.delivered === false ? 'skipped' : 'answered';
    if (status) stampRing([{ messageId, status }]);
  }

  /**
   * The ignore roll let a routed call pass -- the persona's choice, and one
   * decision for the burst the settle grouped: the call and every call it
   * took the place of (`superseded`: replaced in the settle wait, or
   * outranked by it) are stamped skipped (stampRing), so a
   * later pull never presents them as waiting. Safe in a dry run: a skip
   * claims no answer.
   * @param {string} messageId
   * @param {string[]} [superseded]
   */
  function passRoutedCall(messageId, superseded = []) {
    stampRing([messageId, ...superseded].map((id) => ({ messageId: id, status: 'skipped' })));
  }

  /**
   * A routed call a turn that spoke already had in view
   * (turns.spokeAfterSeeing): the call and every other call of its source in
   * the ring that turn showed are stamped skipped (stampRing) -- in view, so
   * a later pull never presents them as waiting. A turn that spoke for real
   * stamped them itself already (src/behavior/turn.js#stampShownCalls; an
   * answer it gave is kept), a rehearsal did not. A call of the source that
   * turn did not show is left as it was. Safe in a dry run: a skip claims no
   * answer.
   * @param {string} sourceId
   * @param {string} messageId
   */
  function skipSeenCalls(sourceId, messageId) {
    const seen = ringCalls(sourceId)
      .map((entry) => entry.messageId)
      .filter((id) => id !== messageId && turns.spokeAfterSeeing?.(sourceId, id));
    stampRing([messageId, ...seen].map((id) => ({ messageId: id, status: 'skipped' })));
  }

  /**
   * The calls of `sourceId` the ring holds (state.json `elsewherePings`, read
   * now), oldest first, those past elsewhere.pingMaxAgeDays left out
   * (src/behavior/elsewhere.js#pingsIn). Read-only.
   * @param {string} sourceId
   */
  function ringCalls(sourceId) {
    const { pingMaxAgeMs } = elsewhereSettings(hot.config);
    return pingsIn(store?.state?.data?.elsewherePings, sourceId, { now: now(), maxAgeMs: pingMaxAgeMs });
  }

  /**
   * Whether the ring holds the routed call `messageId` of `sourceId` as
   * answered (src/behavior/elsewhere.js#pingStatus): a turn that showed it
   * spoke and stamped it. Read from state.json, so it holds across a restart
   * and after a later turn's view of the source (turns.spokeAfterSeeing, in
   * memory) left the call out. A call the ring does not hold (never recorded,
   * past its age, no state) is not answered; nor is a skipped one.
   * @param {string} sourceId
   * @param {string} messageId
   */
  function ringAnswered(sourceId, messageId) {
    return pingStatus(ringCalls(sourceId).find((entry) => entry.messageId === messageId)) === 'answered';
  }

  /**
   * Stamp calls of the ring (state.json `elsewherePings`) `answered` or
   * `skipped` (src/behavior/elsewhere.js#stampPings: an answer wins over a
   * skip, a stamp is never moved), log `elsewhere: marked` for each call
   * whose state changed and mark the state dirty once. A message id the ring
   * does not hold is passed over. Nothing changes while paused (the owner may
   * be editing data/) or without a state.
   * @param {{ messageId: string, status: 'answered'|'skipped' }[]} stamps
   */
  function stampRing(stamps) {
    const state = store?.state;
    const data = state?.data;
    if (!data || data.paused || !Array.isArray(data.elsewherePings)) return;
    const { ring, marked } = stampPings(data.elsewherePings, stamps, now());
    if (marked.length === 0) return;
    data.elsewherePings = ring;
    state.markDirty?.();
    for (const { messageId, channelId, status } of marked) log.info('elsewhere: marked', { source: channelId, message: messageId, status });
  }

  /**
   * After a private turn: every turn that reached the model (it spoke, or it
   * chose to stay silent -- `skip`) counts toward today's cap; a refusal is
   * announced. A refused, busy, paused, error or not-now turn is not counted.
   */
  async function afterPrivateTurn(channel, guildId, trigger, result) {
    if (result?.outcome === 'spoke' || result?.outcome === 'skip') {
      store.bumpPrivateReplies(guildId, trigger.authorId, utcDay(now()));
    }
    await announceRefusal(channel, trigger, result, 'private');
  }

  /**
   * The private-chat gate for one DM author (src/behavior/private.js#privateGate),
   * shared by a live DM and a queued one at drain time. The free checks (a
   * stored profile, the owner flag, the attitude threshold) run before any
   * REST call: the served guild's member cache is read first, and
   * `members.fetch` is only reached when those checks would let the author
   * through. `config` is the caller's `hot.config`, read at the moment of use.
   * @returns {Promise<{ gate: object, isOwner: boolean, replies: object|null, today: string }>}
   */
  async function checkPrivateGate(config, guildId, authorId) {
    const profile = store.getUser(guildId, authorId);
    const isOwner = isOwnerId(config, authorId);
    const replies = store.getPrivate(guildId, authorId)?.replies ?? null;
    const today = utcDay(now());
    const input = { config, profile, isOwner, replies, today };

    const guild = client.guilds?.cache?.get(guildId);
    let isMember = Boolean(guild?.members?.cache?.get(authorId));
    if (guild && !isMember) {
      const free = privateGate({ ...input, isMember: true });
      if (!free.ok && free.reason !== 'cap') return { gate: free, isOwner, replies, today };
      isMember = Boolean(await guild.members.fetch(authorId).catch(() => null));
    }
    return { gate: privateGate({ ...input, isMember }), isOwner, replies, today };
  }

  // A recovery turn of the missed-answer registry in a DM passes the same gate, and counts toward the same cap.
  missed?.setPrivateRecovery?.({
    allow: async (_channel, trigger) => {
      const guildId = getGuildId();
      if (!guildId || hot.config.features?.privateMessages !== true) return false;
      return (await checkPrivateGate(hot.config, guildId, trigger.authorId)).gate.ok === true;
    },
    after: async (channel, trigger, result) => {
      const guildId = getGuildId();
      if (guildId) await afterPrivateTurn(channel, guildId, trigger, result);
    },
  });

  /**
   * A DM the gate refused: dropped silently (the reason is logged), except
   * the daily-cap notice, posted at most once a day per person.
   */
  async function dropPrivate(channel, guildId, authorId, trigger, { gate, isOwner, replies, today }) {
    log.info('private: dropped', { reason: gate.reason });
    if (gate.reason === 'cap' && replies?.noticedDay !== today) {
      store.markPrivateNoticed(guildId, authorId, today);
      const key = isOwner ? 'private.maxPerOwnerPerDay' : 'private.maxPerUserPerDay';
      await notifyLimit(channel, trigger, { key, used: gate.used, cap: gate.cap }, 'private');
    }
  }

  // --- Pending direct pings ---------------------------------------------------
  // A @mention, a reply to the persona or her name that arrives while a turn is running
  // in its own channel (mention.pendingSameChannel) or, with one attention
  // (mention.oneAtATime), in another channel is remembered here instead of
  // dropped, and answered once the turn frees up -- every one of them, in
  // arrival order (src/behavior/pending.js), unless the turn that spoke there
  // already had it in view (turns.spokeAfterSeeing; a turn that named it as
  // still waiting for its own turn does not count). A routed
  // call (written where the persona cannot write, answered in the main
  // channel) is held the same way once its settle wait is over: under the
  // channel it was written in, carrying the `destination` its turn posts in;
  // one the ring already holds as answered is not answered again.
  // A call whose author already has items waiting in that channel -- the
  // parts of their message a chain has not reached yet (turns.waitingParts),
  // their queued calls -- may be about one of them: the merge classifier
  // (prompts/merge.md, holdCall) folds it into that item instead of queueing
  // it, and the item's turn names it (labels.task.added).
  // A follow-up the address classifier said `yes` to that found the attention
  // taken waits here too (deferFollowUp, kind `followUp`), and so does an
  // `overheard` one (kind `overheard`, mention.pendingOverheard): one of them
  // per channel (followUpSlot), logged as `follow-up: ...`; at pickup its
  // window must still be open (followUpStale) and, like any call, it is
  // dropped as answered only when the turn that spoke there had it in its
  // history (turns.spokeAfterSeeing).
  // Never persisted.
  let pendingList = [];
  let draining = false; // guards against a re-entrant drainPending() call (see below)

  /** How many calls `authorId` has waiting in `channelId` (authorCalls): the `queued` count of the pending logs. */
  function queuedCount(channelId, authorId) {
    return authorCalls(pendingList, channelId, authorId).length;
  }

  /** A waiting item's or a candidate's text as the merge classifier and the task labels show it: one line, cut. */
  function itemText(text) {
    return clampChars(oneLine(text), hot.config.context?.maxMessageChars ?? 2000);
  }

  /**
   * The `queued` input of a turn answering `trigger` (src/behavior/turn.js): a
   * function giving, when the turn builds its request, the other calls waiting
   * in `channelId` (never a routed one, nor a deferred overheard line: talk
   * about the persona is no call to it), arrival order: the trigger author's
   * own as `{ id, text }`, another member's as `{ id, text, author }` (their
   * display name). Null for a routed call: its turn is about another channel.
   */
  function queuedFor(channelId, trigger, routed = false) {
    if (routed || !trigger?.authorId) return null;
    return () =>
      pendingList
        .filter((p) => !p.destination && p.kind !== 'overheard' && p.channelId === channelId && p.trigger?.id !== trigger.id)
        .sort((a, b) => a.arrivedAt - b.arrivedAt)
        .map((p) => ({
          id: p.trigger.id,
          text: itemText(p.trigger.content),
          ...(p.trigger.authorId === trigger.authorId ? {} : { author: oneLine(p.trigger.authorName ?? '') }),
        }));
  }

  /**
   * Log the ping addPending / requeuePending pushed out to stay within
   * mention.maxPending (the oldest of any channel, a routed call's destination
   * included), with the counts: how many wait now, and the cap.
   */
  function logEvicted(evicted, maxPending) {
    logPending(evicted, 'dropped', { reason: 'full', pending: pendingList.length, maxPending });
    noteUnanswered(evicted, CODE.PENDING_FULL);
  }

  /** The kinds of call somebody waits on an answer for; an overheard line and a routed call are nobody's debt. */
  const OWED_PING_KINDS = new Set(['mention', 'reply', 'name', 'private', 'followUp']);

  /**
   * A call that left the pending queue without its turn (evicted `full`, `expired`, `outranked`) is
   * a missed fact with that code (src/behavior/missed.js), so the missed-answer recovery owes it like
   * a turn that was dropped. A private message's stays in its chat. Never throws.
   * @param {{ kind: string, channelId: string, trigger: object, destination?: object }} ping
   * @param {string} code
   */
  function noteUnanswered(ping, code) {
    if (!missed || !OWED_PING_KINDS.has(ping?.kind) || ping.destination || !ping.trigger?.id) return;
    missed.noteFact({ reason: code, message: { ...ping.trigger, channelId: ping.trigger.channelId ?? ping.channelId } });
  }

  /**
   * One log line about a pending entry: `follow-up: <event>` for a deferred
   * follow-up or overheard line (its message id included, as every follow-up
   * line has it),
   * `mention: <event>` for any other call; channel, kind, `fields`, and a
   * routed call's destination.
   */
  function logPending(ping, event, fields = {}) {
    const followUp = isDeferredFollowUp(ping);
    log.info(`${followUp ? 'follow-up' : 'mention'}: ${event}`, {
      channel: ping.channelId,
      kind: ping.kind,
      ...(followUp ? { message: ping.trigger.id } : {}),
      ...fields,
      ...routedFields(ping),
    });
  }

  /**
   * A follow-up `yes` (trigger kind `followUp`) that found the attention
   * taken (startFollowUpTurn): held in the pending queue like a direct call,
   * answered by drainPending once the turn frees up, after the window check
   * (followUpStale) and the "already answered" one (spokeAfterSeeing) there. Read now: muted
   * (paused, a warmup run), features.followUp / features.mentions off, or its
   * own channel busy with mention.pendingSameChannel off -- not held, dropped
   * with that reason (`busy` for the last two, as before). An `overheard`
   * line (`kind`, startFollowUpTurn) is held the same way. One of them per
   * channel, by followUpSlot: a newer one takes an older one's place
   * (`follow-up: dropped`, `newer`), except that an `overheard` line never
   * takes a waiting `followUp`'s place -- it is dropped itself
   * (`outranked`). Never folded into another call, nor a fold target
   * (waitingItems). `follow-up: deferred` names where the running turn is
   * (`runningIn`), and the kind of an overheard line.
   * @param {'followUp'|'overheard'} [kind]
   */
  function deferFollowUp(channel, trigger, kind = 'followUp') {
    const config = hot.config;
    const channelId = channel.id;
    const sameChannel = turns.isBusy(channelId);
    let reason = followUpMuted();
    if (!reason && (followUpOff(config) || (sameChannel && config.mention.pendingSameChannel === false))) reason = 'busy';
    if (reason) {
      log.info('follow-up: dropped', { channel: channelId, message: trigger.id, reason });
      return;
    }
    const slot = followUpSlot(pendingList, channelId, kind);
    if (!slot.admit) {
      log.info('follow-up: dropped', { channel: channelId, message: trigger.id, reason: 'outranked' });
      noteUnanswered({ kind, channelId, trigger }, CODE.PENDING_OUTRANKED);
      return;
    }
    if (slot.replaced) dropReplaced(slot.replaced, trigger.id);
    const maxPending = config.mention.maxPending ?? 6;
    const ping = { channelId, channel, trigger, kind, arrivedAt: now() };
    const { list, evicted } = addPending(pendingList, ping, maxPending);
    pendingList = list;
    log.info('follow-up: deferred', {
      channel: channelId,
      author: trigger.authorId,
      message: trigger.id,
      runningIn: sameChannel ? channelId : (turns.busyChannels?.()[0] ?? null),
      sameChannel,
      pending: pendingList.length,
      ...(kind === 'overheard' ? { kind } : {}),
    });
    if (evicted) logEvicted(evicted, maxPending);
  }

  /**
   * Remove the deferred follow-up or overheard line a newer entry of its channel replaced
   * (followUpSlot), logged `newer`. A replaced follow-up -- a line said to the persona -- is a
   * `replaced-deferred` fact with both ids (src/behavior/missed.js); an overheard line is not.
   */
  function dropReplaced(older, newerId = null) {
    pendingList = pendingList.filter((p) => p !== older);
    log.info('follow-up: dropped', { channel: older.channelId, message: older.trigger.id, reason: 'newer' });
    if (older.kind === 'followUp') missed?.noteFact({ reason: 'replaced-deferred', message: older.trigger, replacedBy: newerId });
  }

  /** Whether a pending entry is a deferred follow-up or overheard line (deferFollowUp), not a call. */
  function isDeferredFollowUp(ping) {
    return ping.kind === 'followUp' || ping.kind === 'overheard';
  }

  /**
   * Why a deferred follow-up or overheard line is no longer to be answered
   * at pickup, read now: `closed` -- the window of its channel is not open
   * any more (isFollowUpOpen: mention.followUpMinutes and the no-streak, the
   * rule the classifier used; an expired one is forgotten as the gate does).
   * Null: still to answer. A post of the persona in that channel after the
   * line does not make it answered by itself: the turn that posted may have
   * fetched its history before the line arrived. Whether that turn had the
   * line in view is the drain's spokeAfterSeeing check, made before this one.
   * @returns {'closed'|null}
   */
  function followUpStale(ping, config) {
    const window = followUpWindows.get(ping.channelId);
    if (!isFollowUpOpen(window, now(), config.mention)) {
      if (window) closeFollowUpWindow(ping.channelId);
      return 'closed';
    }
    return null;
  }

  /**
   * Whether the message `messageId` of `channel` is still there to answer:
   * `true` (in the channel's cache, or fetched), `'gone'` (the fetch found
   * nothing, or Discord answered not found: deleted) or `'error'` (any other
   * failure -- a rate limit, a server error, lost access: it may still exist).
   * The drain and the settle drop the call either way and log which
   * (heldCallState, missingReason). Not collect.js#fetchMessage: that answers
   * null for every failure, and a failed fetch must not read as a deleted
   * message.
   * @returns {Promise<true|'gone'|'error'>}
   */
  async function messageStillExists(channel, messageId) {
    if (channel.messages.cache?.get?.(messageId)) return true;
    try {
      return (await channel.messages.fetch(messageId)) ? true : 'gone';
    } catch (err) {
      return isNotFound(err) ? 'gone' : 'error';
    }
  }

  /**
   * What became of the held call `messageId` written in `channel` while it
   * waited (a settle wait, the pending queue), read now: `'answered'` when it
   * is a routed call (`routed`) the ring holds as answered (ringAnswered),
   * else what messageStillExists says (`true`, `'gone'`, `'error'`). The ring
   * is read on both sides of the lookup: before it, so a call already
   * answered costs no fetch and is never reported as lost when its message
   * cannot be found any more; after it, for a stamp that landed while the
   * fetch was in flight. An answer wins over a missing message either way.
   * @param {object} channel  Where the call was written.
   * @param {string} messageId
   * @param {boolean} routed  Only a routed call is in the ring.
   * @returns {Promise<true|'answered'|'gone'|'error'>}
   */
  async function heldCallState(channel, messageId, routed) {
    const answered = () => routed && ringAnswered(channel.id, messageId);
    if (answered()) return 'answered';
    const found = await messageStillExists(channel, messageId);
    return answered() ? 'answered' : found;
  }

  /**
   * Remember a direct ping (mention/reply/name/private message) that arrived while
   * a turn is running in its own channel or, with one attention, elsewhere --
   * or a routed call (`destination`: the channel its turn posts in) while a
   * turn runs there or, with one attention, anywhere. Every call waits, in
   * arrival order (`arrivedAt`, default now): none replaces another, of its
   * channel or of its author; a routed call carries the calls its settle wait
   * took the place of (src/behavior/pending.js `superseded`). At most
   * mention.maxPending entries; the oldest of any channel is evicted when full
   * (logEvicted). A direct call (not a routed one) takes the place of an
   * overheard line waiting in its channel (followUpSlot, `follow-up:
   * dropped`, `newer`): its turn reads that line in the history.
   * `sameChannel` is logged for the channel the turn would post in,
   * `queued` is how many calls the author has waiting in that channel.
   * @param {string[]} [superseded]  A routed call only: see answerCall.
   */
  function enqueuePending(channel, trigger, kind, destination = null, superseded = [], arrivedAt = now()) {
    const maxPending = hot.config.mention.maxPending ?? 6;
    const routed = destination ? { destination, ...(superseded.length > 0 ? { superseded: [...superseded] } : {}) } : {};
    if (!destination) {
      const { replaced } = followUpSlot(pendingList, channel.id, kind);
      if (replaced) dropReplaced(replaced, trigger.id);
    }
    const ping = { channelId: channel.id, channel, trigger, kind, arrivedAt, ...routed };
    const { list, evicted } = addPending(pendingList, ping, maxPending);
    pendingList = list;
    log.info('mention: deferred', {
      channel: channel.id,
      kind,
      sameChannel: turns.isBusy((destination ?? channel).id),
      pending: pendingList.length,
      queued: queuedCount(channel.id, trigger.authorId),
      ...routedFields(ping),
    });
    if (evicted) logEvicted(evicted, maxPending);
  }

  /**
   * Hold a call that cannot be answered now (the live path and a private
   * message alike). A routed call, or one whose author has nothing waiting
   * in that channel (no part of a chain not reached yet, no queued call), is
   * queued at once (enqueuePending). Otherwise the merge classifier is asked
   * (classifyMerge; the persona is busy, so this costs no reply time) whether
   * the call is about one of those items: about one, it is folded into it
   * (turns.addToPart for a part, foldInto for a queued call) -- no turn of its
   * own; its item's turn names it -- and a server call still counts toward the
   * member's repeat and spam counters (tagHistory), as it would at its own
   * turn; `new`, no verdict, or an item that stopped waiting meanwhile, it is
   * queued with its arrival time. Paused meanwhile, it is dropped (`mention:
   * dropped`, `paused`). Once it is queued, a drain starts if nothing blocks
   * it any more (drainPending). Never throws.
   * @param {string[]} [superseded]  A routed call only: see answerCall.
   */
  function holdCall(channel, trigger, kind, destination = null, superseded = []) {
    const items = destination ? [] : waitingItems(channel.id, trigger.authorId);
    if (items.length === 0) {
      enqueuePending(channel, trigger, kind, destination, superseded);
      return;
    }
    const arrivedAt = now();
    foldOrQueue({ channel, trigger, kind, items, arrivedAt }).catch((err) => {
      log.error('merge: failed', { channel: channel.id, reason: 'error', status: null, error: err });
    });
  }

  /**
   * The items `authorId` waits for in `channelId`, in order: the parts of their
   * message a chain there has not reached yet, then their queued calls.
   * @returns {({ kind: 'part', index: number, text: string }|{ kind: 'call', id: string, text: string })[]}
   */
  function waitingItems(channelId, authorId) {
    let parts = [];
    try {
      const found = turns.waitingParts?.(channelId, authorId);
      parts = Array.isArray(found) ? found : [];
    } catch {
      parts = [];
    }
    return [
      ...parts.map((part) => ({ kind: 'part', index: part.index, text: itemText(part.text) })),
      // A deferred follow-up or overheard line is not one: it may still be dropped (window closed, answered).
      ...authorCalls(pendingList, channelId, authorId)
        .filter((p) => !isDeferredFollowUp(p))
        .map((p) => ({ kind: 'call', id: p.trigger.id, text: itemText(p.trigger.content) })),
    ];
  }

  /** holdCall's asynchronous side: the merge verdict, then the fold or the queue. */
  async function foldOrQueue({ channel, trigger, kind, items, arrivedAt }) {
    const index = await classifyMerge(channel, trigger, items);
    if (store?.state?.data?.paused) {
      log.info('mention: dropped', { channel: channel.id, kind, reason: 'paused' });
      return;
    }
    const item = index ? items[index - 1] : null;
    if (item) {
      const message = { id: trigger.id, text: itemText(trigger.content), ts: trigger.ts };
      let folded = false;
      if (item.kind === 'part') {
        folded = turns.addToPart?.(channel.id, trigger.authorId, item.index, message) === true;
      } else {
        const result = foldInto(pendingList, item.id, message);
        pendingList = result.list;
        folded = result.folded;
      }
      if (folded) {
        if (kind !== 'private') tagHistory.hit(trigger.authorId, now(), repeatWindowMs(hot.config.mention));
        return;
      }
    }
    enqueuePending(channel, trigger, kind, null, [], arrivedAt);
    if (!turnBlocked(channel.id, hot.config)) {
      drainPending().catch((err) => log.error('mention: drain failed', { error: err }));
    }
  }

  /**
   * One merge classifier call: is `trigger` (a call of an author with `items`
   * waiting) about one of them? System = prompts.merge with `{{name}}`; user
   * = `<waiting>` (the items as `<n>. <text>` lines from 1) then
   * `<candidate>` (`<author>: <text>`). A helper's request (role analyzer,
   * mention.followUpMaxOutputTokens, purpose `merge`). Resolves the item's
   * 1-based index (`merge: verdict`, `answer: 'item'`), or null for `new`
   * (`answer: 'new'`) and for every other outcome, logged as `merge: failed`
   * with its reason: `no-prompt`, the rail's code or `llm-error` (with the
   * HTTP status), `empty`, `unparsed`, `out-of-range`. Codes and counts only.
   * @returns {Promise<number|null>}
   */
  async function classifyMerge(channel, trigger, items) {
    const channelId = channel.id;
    const prompt = hot.prompts?.merge;
    if (!prompt || !llm) {
      log.info('merge: failed', { channel: channelId, reason: 'no-prompt', status: null });
      return null;
    }
    const config = hot.config;
    const startedAt = now();
    const guildId = channel.guild?.id ?? getGuildId();
    const waiting = items.map((item, i) => `${i + 1}. ${item.text}`).join('\n');
    const user = [block('waiting', waiting), block('candidate', `${trigger.authorName}: ${itemText(trigger.content)}`)].join('\n');
    let completion;
    try {
      completion = await llm.complete(
        [
          { role: 'system', content: fillPromptTemplate(prompt, { name: getSelfName(guildId) }) },
          { role: 'user', content: user },
        ],
        {
          model: roleModel(config, 'analyzer', 'merge'),
          ...helperRequestOptions(config, { role: 'analyzer', maxOutputTokens: config.mention?.followUpMaxOutputTokens, purpose: 'merge' }),
        },
      );
    } catch (err) {
      log.warn('merge: failed', { channel: channelId, reason: railReason(err), status: err?.statusCode ?? null });
      return null;
    }
    const { index, reason } = parseMergeAnswer(completion?.text, items.length);
    if (reason !== 'item' && reason !== 'new') {
      log.warn('merge: failed', { channel: channelId, reason, status: null });
      return null;
    }
    log.info('merge: verdict', { channel: channelId, waiting: items.length, answer: index ? 'item' : 'new', ms: now() - startedAt });
    return index;
  }

  /**
   * The drain's runTurn answered 'busy': another turn started during the
   * switch pause. The ping goes back into the queue with its original
   * arrivedAt, ahead of every call that came after it (mention.maxPending
   * still applies). Synchronous on
   * purpose -- see drainPending. Returns whether a turn that blocks this ping
   * is still running (its end calls drainPending again through onIdle): for a
   * routed call, one that blocks its destination.
   */
  function requeueBusy(ping) {
    const mentionCfg = hot.config.mention;
    const maxPending = mentionCfg.maxPending ?? 6;
    const { list, evicted } = requeuePending(pendingList, ping, maxPending);
    pendingList = list;
    logPending(ping, 'deferred again', { reason: 'busy', pending: pendingList.length, queued: queuedCount(ping.channelId, ping.trigger.authorId) });
    if (evicted) logEvicted(evicted, maxPending);
    return turnBlocked(ping.destination?.id ?? ping.channelId, hot.config);
  }

  /**
   * Count the call, roll the ignore decision (decideMention) and log it, for
   * a server ping of `kind` -- the live path and the drain alike. `config` is
   * the caller's `hot.config`, read at the moment of use; `deferred` marks a
   * ping answered from the pending queue; `destination` is the channel a
   * routed call's turn posts in (logged beside `channel`, where the call was
   * written). Whether the call tags the persona (isTaggedCall: not by the
   * reply ping alone) is read off `trigger`, so an untagged reply meets
   * mention.followUpIgnoreChance like a follow-up (decideMention).
   * @returns {{ respond: boolean, reason: string, ignoreChance: number, roll?: number }}
   */
  function decideAndLog(channel, trigger, kind, config, { deferred = false, destination = null } = {}) {
    const features = config.features ?? {};
    const guildId = channel.guild.id;
    const recentCalls = tagHistory.hit(trigger.authorId, now(), repeatWindowMs(config.mention));
    const affinityScore =
      features.memory !== false && features.relationships !== false
        ? store?.getUser?.(guildId, trigger.authorId)?.affinity?.score
        : undefined;
    const decision = decideMention({
      kind,
      tagged: isTaggedCall(trigger, client.user?.id),
      textLength: strippedLength(trigger.content, getSelfName(guildId)),
      recentCalls,
      neverIgnore: config.mention.neverIgnore.includes(trigger.authorId),
      affinityScore,
      cfg: config.mention,
      rng,
    });
    log.info('mention: decided', {
      kind,
      reason: decision.reason,
      ignoreChance: decision.ignoreChance,
      roll: decision.roll === undefined ? undefined : Math.round(decision.roll * 100) / 100,
      author: trigger.authorId,
      channel: channel.id,
      ...(deferred ? { deferred: true } : {}),
      ...routedFields({ destination }),
    });
    return decision;
  }

  /**
   * Answers pending direct pings, oldest first, one at a time, each after a
   * human "switch" pause (mention.switchDelayMs) -- called once a turn
   * finishes anywhere (src/index.js wires this to src/behavior/turn.js's
   * `setOnIdle`, in the same `finally` that frees the channel). The ignore
   * decision (decideMention) is rolled HERE, not when the ping arrived. A
   * ping whose message was deleted meanwhile (`gone`) or cannot be fetched
   * now (`fetch-failed`: messageStillExists), a channel that lost send
   * permission, or a ping the last turn that spoke in its channel already
   * had in its history (turns.spokeAfterSeeing -- unless that turn named it as
   * a call still waiting for its own turn: its author's under
   * labels.task.queued, another member's under labels.task.queuedOthers),
   * is dropped with a log line; the messages folded into a dropped call
   * (`added`) go with it. Each call's turn gets the other calls waiting in its
   * channel (`queued`, queuedFor) and the messages folded into it (`added`).
   * A ping queued in a channel whose own turn was running is picked up the
   * same way once that turn frees the channel. A deferred follow-up is never
   * rolled (counted for spam only) and is dropped when its window closed
   * (followUpStale) or a turn that spoke had it in view, or when
   * features.followUp is off now. Guarded against re-entrancy:
   * the turn this function itself starts also frees the channel through the very same `onIdle`,
   * which would otherwise start a second overlapping drain. A no-op while
   * `isWarmingUp()` is true -- the queue is left untouched for a later
   * call once the warmup run ends -- and while paused (`/nep pause` clears
   * the queue itself); a pause that lands during the switch pause drops the
   * ping in hand and ends the pass. A server ping is also dropped when its
   * switch (features.mentions / features.replies / features.nameTriggers) was turned
   * off while it waited (callSwitchOff).
   *
   * A routed call (one with a `destination`) goes through the same checks in
   * the channel it was written in, except the send permission: the
   * destination it waited with is not checked, its route is read again now
   * instead (routeFor: features.elsewhere, memory.mainChannelIds, the audience
   * rail, a main channel the bot can send in) -- a route that no longer holds
   * drops it like onMessage step 11 does (`cannot-send` with `route`) -- and
   * its turn posts in the destination resolved now, with its source
   * (afterCallTurn: the notice there, plain; the ring). A routed call the
   * ring already holds as answered is dropped (`mention: already answered`,
   * reason `ring`: read from state.json, so it holds across a restart,
   * whatever the turns remember in memory) -- read before its message is
   * looked up, so an answered call is never logged as `gone` or
   * `fetch-failed` (heldCallState). Otherwise, a routed call a turn
   * that spoke already had in view is stamped skipped in the ring with every
   * other call of its source that turn showed (skipSeenCalls); one the ignore
   * roll lets pass, with every call it took the place of (passRoutedCall).
   *
   * A turn that started during the switch pause makes runTurn answer 'busy':
   * the ping is re-queued (requeueBusy; a server ping keeps its `respond`
   * decision, so the retry neither counts it again toward spamThreshold nor
   * re-rolls the ignore chance) and the pass stops -- the running turn calls
   * drainPending again when it ends. From the busy result to `draining =
   * false` nothing is awaited, so that onIdle call either finds `draining`
   * already cleared, or the blocking turn had already ended when requeueBusy
   * looked and the pass goes on instead of stopping.
   */
  async function drainPending() {
    if (draining || isWarmingUp() || store?.state?.data?.paused) return;
    draining = true;
    try {
      while (pendingList.length > 0) {
        const { ping, list } = popOldest(pendingList);
        pendingList = list;
        if (!ping) break;

        const mentionCfg = hot.config.mention;
        const routed = routedFields(ping);
        if (isExpired(ping, now(), mentionCfg.pendingMinutes ?? 10)) {
          logPending(ping, 'expired');
          noteUnanswered(ping, CODE.PENDING_EXPIRED);
          continue;
        }

        logPending(ping, 'picked up', { queued: queuedCount(ping.channelId, ping.trigger.authorId) });
        await sleep(between(mentionCfg.switchDelayMs ?? [2000, 9000], rng));

        // Paused meanwhile: nothing may run or mark the store dirty; the
        // queue's other pings are cleared by the pause itself.
        if (store?.state?.data?.paused) {
          logPending(ping, 'dropped', { reason: 'paused' });
          break;
        }
        // An ordinary ping is answered where it was written. A routed call's
        // turn posts in a main channel, resolved again below (routeFor): the
        // one it waited with may have changed or lost Send meanwhile.
        if (!ping.destination && !canSend(ping.channel)) {
          logPending(ping, 'dropped', { reason: 'cannot-send' });
          continue;
        }
        const held = await heldCallState(ping.channel, ping.trigger.id, Boolean(ping.destination));
        // A routed call the ring holds as answered (a turn that showed it
        // spoke): not answered a second time, whatever the turns remember.
        if (held === 'answered') {
          log.info('mention: already answered', { channel: ping.channelId, kind: ping.kind, reason: 'ring', ...routed });
          continue;
        }
        if (held !== true) {
          logPending(ping, 'dropped', { reason: missingReason(held) });
          continue;
        }
        // The turn that ran meanwhile fetched its history after this ping
        // landed and spoke with it in view: not answered a second time (a
        // routed call, and the calls of its source that turn showed, are no
        // longer presented as waiting either).
        if (turns.spokeAfterSeeing?.(ping.channelId, ping.trigger.id)) {
          if (isDeferredFollowUp(ping)) logPending(ping, 'dropped', { reason: 'answered' });
          else log.info('mention: already answered', { channel: ping.channelId, kind: ping.kind, ...routed });
          if (ping.destination) skipSeenCalls(ping.channelId, ping.trigger.id);
          continue;
        }

        const config = hot.config;
        const features = config.features ?? {};
        let stop = false; // set by requeueBusy while the turn that blocked this ping still runs

        // A private message is answered like a direct ping, without the
        // ignore roll; the channel has no guild, so the pinned one is passed.
        // The gate is checked again here: the switch, the profile or today's
        // cap may have changed while the ping waited.
        if (ping.kind === 'private') {
          const privateGuildId = getGuildId();
          if (!privateGuildId) continue;
          try {
            const authorId = ping.trigger.authorId;
            const check = await checkPrivateGate(config, privateGuildId, authorId);
            if (!check.gate.ok) {
              await dropPrivate(ping.channel, privateGuildId, authorId, ping.trigger, check);
              continue;
            }
            const result = await turns.runTurn({
              channel: ping.channel,
              guildId: privateGuildId,
              mode: 'reply',
              trigger: ping.trigger,
              triggerKind: 'private',
              queued: queuedFor(ping.channelId, ping.trigger),
              added: ping.added ?? null,
            });
            if (result?.outcome === 'busy') stop = requeueBusy(ping);
            else await afterPrivateTurn(ping.channel, privateGuildId, ping.trigger, result);
          } catch (err) {
            log.error('private: deferred turn failed', { channel: ping.channelId, error: err });
          }
          if (stop) break;
          continue;
        }

        // The ping's own switch is hot: it may have changed while the ping
        // waited.
        const switchOff = isDeferredFollowUp(ping) ? followUpOff(config) : callSwitchOff(ping.kind, features);
        if (switchOff) {
          logPending(ping, 'dropped', { reason: 'off' });
          continue;
        }

        // A routed call: where it is answered is read again now (the switch,
        // the main channels and the audience rail are hot).
        let destination = null;
        if (ping.destination) {
          const route = routeFor(ping.channel, config, discord);
          if (!route.destination) {
            log.info('mention: dropped', { channel: ping.channelId, kind: ping.kind, reason: 'cannot-send', route: route.reason, ...routed });
            continue;
          }
          destination = route.destination;
        }

        // A deferred follow-up or overheard line: its window must still be
        // open (a post the line came too late for is no answer: the
        // spokeAfterSeeing check above decides that). A follow-up is
        // counted for spam and rolled for the ignore chance like a live one,
        // an overheard line is neither (startFollowUpTurn).
        if (isDeferredFollowUp(ping)) {
          const stale = followUpStale(ping, config);
          if (stale) {
            logPending(ping, 'dropped', { reason: stale });
            continue;
          }
          if (ping.kind === 'followUp' && !ping.decided) {
            if (!decideAndLog(ping.channel, ping.trigger, ping.kind, config, { deferred: true }).respond) continue;
          }
        }
        // A re-queued ping was already counted and decided `respond` on the
        // pass whose turn found another one running: not counted or rolled again.
        else if (!ping.decided) {
          const decision = decideAndLog(ping.channel, ping.trigger, ping.kind, config, { deferred: true, destination });
          if (!decision.respond) {
            // The ignore roll let a routed call pass, and the calls it replaced with it.
            if (destination) passRoutedCall(ping.trigger.id, ping.superseded);
            continue;
          }
        }

        try {
          const result = await turns.runTurn({
            channel: destination ?? ping.channel,
            mode: 'reply',
            trigger: ping.trigger,
            triggerKind: ping.kind,
            queued: queuedFor(ping.channelId, ping.trigger, Boolean(destination)),
            added: ping.added ?? null,
            ...(destination ? { source: { channelId: ping.channelId, reason: 'routed' } } : {}),
          });
          if (result?.outcome === 'busy') stop = requeueBusy({ ...ping, decided: true, ...(destination ? { destination } : {}) });
          else await afterCallTurn(ping.channel, ping.trigger, result, ping.kind, destination);
        } catch (err) {
          log.error('mention: deferred turn failed', { channel: ping.channelId, ...routed, error: err });
        }
        if (stop) break;
      }
    } finally {
      draining = false;
    }
  }

  /**
   * The ordinary path of a server call the persona may answer, the live one
   * and a routed one alike. `channel` is where the call was written,
   * `destination` the channel a routed call's turn posts in (null: the call's
   * own channel); busy and the pending rules are keyed by the channel the turn
   * posts in. A direct call (mention/reply/name) that cannot be answered now is
   * remembered as pending instead of dropped, and answered by drainPending
   * once the turn frees up (the tag count and the ignore roll happen there):
   *  - a turn is running in that channel (mention.pendingSameChannel, default
   *    on, regardless of mention.oneAtATime) -- that turn may already have
   *    fetched its history without this message;
   *  - one attention (mention.oneAtATime, default on): a turn is running in
   *    another channel.
   * A direct call is held through holdCall: queued, or folded into an item
   * its author already waits for there (the merge classifier).
   * A routed call is held the same way, never folded: queued under the channel it was
   * written in (its source), carrying its destination, which the drain posts
   * in, and the calls its settle wait took the place of. A name call is held
   * like a tag; its mention.nameTriggerChance roll is made at drain time, as
   * the others' ignore roll is. With pendingSameChannel off, a call in a busy
   * channel is dropped here (`mention: dropped`, `busy`) -- before it is
   * counted or rolled, so it neither adds to the spam count (tagHistory) nor
   * meets the ignore chance. A routed call dropped as busy stays unanswered
   * in the ring: busy is not the persona's choice, and only a call she chose
   * to let pass is stamped skipped. Should runTurn itself still answer
   * 'busy', that is logged as the same drop.
   * Otherwise the call is counted and rolled (decideAndLog) and the reply
   * turn started, never awaited; a routed one carries its `source`
   * (`reason: 'routed'`), and its outcome reaches the ring and its notice the
   * destination (afterCallTurn). A routed call the ignore roll lets pass
   * (`ignored:*`, `name-unnoticed`) is stamped skipped in the ring with the
   * calls it took the place of (passRoutedCall). `config` is the caller's
   * `hot.config`, read now.
   * @param {{ channel: object, normalized: object, kind: TriggerKind, config: object, destination?: object|null,
   *   superseded?: string[] }} call  `superseded`: a routed call only, the message ids of the calls of its
   *   source it took the place of in its settle wait (armSettle).
   */
  function answerCall({ channel, normalized, kind, config, destination = null, superseded = [] }) {
    const turnChannel = destination ?? channel;
    const routed = routedFields({ destination });
    const direct = kind === 'mention' || kind === 'reply' || kind === 'name';
    const oneAtATime = config.mention.oneAtATime !== false;
    const dropBusy = () => log.info('mention: dropped', { channel: channel.id, kind, reason: 'busy', ...routed });
    const holdDirect = () => holdCall(channel, normalized, kind, destination, superseded);
    const sameChannelBusy = turns.isBusy(turnChannel.id);
    if (sameChannelBusy && direct && config.mention.pendingSameChannel !== false) {
      holdDirect();
      return;
    }
    // Not held (pendingSameChannel off): dropped before it is counted or rolled.
    if (sameChannelBusy) {
      dropBusy();
      return;
    }
    const busyElsewhere = oneAtATime && turns.isAnyBusy();
    if (busyElsewhere) {
      if (direct) holdDirect();
      else dropBusy();
      return;
    }

    const decision = decideAndLog(channel, normalized, kind, config, { destination });
    if (!decision.respond) {
      // The ignore roll let a routed call pass, and the calls it replaced with it.
      if (destination) passRoutedCall(normalized.id, superseded);
      return;
    }
    const source = destination ? { source: { channelId: channel.id, reason: 'routed' } } : {};
    turns
      .runTurn({ channel: turnChannel, mode: 'reply', trigger: normalized, triggerKind: kind, queued: queuedFor(channel.id, normalized, Boolean(destination)), ...source })
      .then((result) => {
        if (result?.outcome === 'busy') dropBusy();
        return afterCallTurn(channel, normalized, result, kind, destination);
      })
      .catch((err) => log.error('mention: reply turn failed', { channel: channel.id, ...routed, error: err }));
  }

  // --- Calls from a channel the persona cannot write in (features.elsewhere) --
  // A call (a mention, a reply or the persona's name) written where the bot
  // can read but not send has nowhere to be answered. When a destination is
  // usable (the first usable id of memory.mainChannelIds,
  // src/behavior/turn.js#usableDestination) and everyone who can view it can
  // view the source too (the audience rail, context.pull.sameAudience;
  // src/behavior/turn.js#routeFor), the
  // call is recorded in the ring (state.json `elsewherePings`: ids and a time,
  // no author, no text) and a settle wait is armed for the source: one timer
  // per source, never a busy mark, so the one attention stays free while it
  // waits. Every message observed in the source moves the wait
  // (elsewhere.settleSeconds after the last one, at most
  // elsewhere.settleMaxSeconds after the call that armed it); a newer call
  // there takes the waiting one's place unless it is weaker (a name after a
  // tag; callRank), and both stay in the ring; the call that keeps the wait
  // carries the other along (`superseded`): the settle groups a burst into
  // one decision. When the wait is over, the call takes the ordinary call path
  // (answerCall) with the destination as the channel the turn posts in and
  // the source passed to the turn -- pending included -- and the ring follows
  // the outcome: the call by its turn's outcome (markRoutedCall; every other
  // call the turn showed is stamped by the turn itself), the call and those it
  // carries when the ignore roll lets it pass (passRoutedCall), the call and
  // the others of its source a turn that spoke already had in view
  // (skipSeenCalls). A call the ring already holds as answered is never
  // answered again (ringAnswered: state.json, so a restart keeps it). The
  // waits live in memory only: a restart during one loses
  // the call, which stays unanswered in the ring; a pause (clearPending) and
  // shutdown (stop) clear them.
  // The same wait (kind `noticed`, no call, nothing in the ring) follows an
  // eavesdrop hit on an untriggered message there (spontaneous.noticeElsewhere)
  // when no wait is armed in that source; when it is over the persona may
  // comment on the source in the destination (spontaneous.runNoticed). A call
  // arriving meanwhile takes its place, as a newer call does.
  // source channel id -> { kind, channel, normalized, triggerKind, superseded, firstAt, lastAt, due, moved, timer }
  const settles = new Map();

  /**
   * Clear every settle wait without answering its call (it stays unanswered
   * in the ring); with a `reason` each is logged as `elsewhere: dropped`.
   * @param {'paused'|null} reason
   */
  function clearSettles(reason) {
    for (const [sourceId, entry] of settles) {
      timers.clear(entry.timer);
      if (reason) log.info('elsewhere: dropped', { source: sourceId, kind: entry.kind, message: entry.normalized.id, reason });
    }
    settles.clear();
  }

  /**
   * Record a routable call written in `source` in the ring (state.json
   * `elsewherePings`; elsewhere.rememberPings and elsewhere.pingMaxAgeDays
   * read from `config` now) and mark the state dirty. No state, nothing kept.
   */
  function rememberCall(source, normalized, config) {
    const state = store?.state;
    if (!state?.data) return;
    const { rememberPings, pingMaxAgeMs } = elsewhereSettings(config);
    state.data.elsewherePings = recordPing(
      state.data.elsewherePings,
      { messageId: normalized.id, channelId: source.id, ts: normalized.ts },
      { cap: rememberPings, maxAgeMs: pingMaxAgeMs, now: now() },
    );
    state.markDirty?.();
  }

  /** When the wait `entry` is due (settleDueAt, elsewhere.settleSeconds / settleMaxSeconds read now). */
  function settleDue(entry) {
    const { settleMs, settleMaxMs } = elsewhereSettings(hot.config);
    return settleDueAt({ firstAt: entry.firstAt, lastAt: entry.lastAt, settleMs, maxMs: settleMaxMs });
  }

  /** (Re)start the timer of the wait `entry` for `due`, the previous one cleared; a real timer is unref'd. */
  function scheduleSettle(sourceId, entry, due) {
    timers.clear(entry.timer);
    const timer = timers.set(() => fireSettle(sourceId, entry), Math.max(0, due - now()));
    timer?.unref?.();
    entry.timer = timer;
    entry.due = due;
  }

  /**
   * Arm the settle wait of `source` for a routed call of `triggerKind`
   * (`elsewhere: settling`), or, while one is armed there, hand it to this
   * newer call when it is at least as strong (callRank): the waiting call is
   * dropped (`elsewhere: dropped`, `replaced`; it stays in the ring), the wait
   * keeps its start, and its due time was already moved for this message
   * (touchSettle). A weaker newer call (the persona's name after a tag) is the
   * one dropped (`outranked`; it stays in the ring too) and the waiting call
   * keeps its place. Either way the call that keeps the wait carries the one
   * dropped, and whatever that one carried, in `superseded`. Waits are per
   * source: a call elsewhere never touches this one. A waiting noticed
   * comment (no call: callRank 0) always gives way to a call, and the call
   * carries nothing for it (its message is no call of the ring).
   */
  function armSettle(source, normalized, triggerKind, destination) {
    const waiting = settles.get(source.id);
    if (waiting) {
      if (callRank(triggerKind) < callRank(waiting.triggerKind)) {
        log.info('elsewhere: dropped', { source: source.id, kind: 'ping', message: normalized.id, reason: 'outranked' });
        waiting.superseded = [...waiting.superseded, normalized.id];
        return;
      }
      log.info('elsewhere: dropped', { source: source.id, kind: waiting.kind, message: waiting.normalized.id, reason: 'replaced' });
      const superseded = waiting.kind === 'noticed' ? [...waiting.superseded] : [...waiting.superseded, waiting.normalized.id];
      Object.assign(waiting, { kind: 'ping', channel: source, normalized, triggerKind, superseded });
      return;
    }
    startSettle(source, normalized, 'ping', triggerKind, destination);
  }

  /**
   * Arm a new settle wait in `source` (none is armed there) for a routed call
   * (`ping`, its `triggerKind`) or a noticed comment (`noticed`, no
   * triggerKind) and log `elsewhere: settling`.
   * @param {'ping'|'noticed'} kind
   */
  function startSettle(source, normalized, kind, triggerKind, destination) {
    const t = now();
    const entry = { kind, channel: source, normalized, triggerKind, superseded: [], firstAt: t, lastAt: t, due: null, moved: 0, timer: null };
    settles.set(source.id, entry);
    scheduleSettle(source.id, entry, settleDue(entry));
    log.info('elsewhere: settling', { source: source.id, kind, message: normalized.id, destination: destination.id });
  }

  /**
   * An untriggered message in `source`, a channel the bot cannot send in,
   * after its settle wait was touched: with no wait armed there, an
   * eavesdrop hit (spontaneous.noticeElsewhere: the rails and the roll)
   * arms one of kind `noticed` toward the destination resolved now.
   */
  function maybeNotice(source, normalized) {
    if (settles.has(source.id)) return;
    if (spontaneous.noticeElsewhere?.(source, normalized) !== true) return;
    const route = routeFor(source, hot.config, discord);
    if (!route.destination) return;
    startSettle(source, normalized, 'noticed', null, route.destination);
  }

  /**
   * A noticed wait is over: the comment runs through spontaneous.runNoticed,
   * which reads every rail again; one that refuses is logged as
   * `elsewhere: dropped` with its code.
   */
  async function fireNoticed(sourceId, { channel, normalized }) {
    const result = await spontaneous.runNoticed?.(channel);
    if (result?.reason) log.info('elsewhere: dropped', { source: sourceId, kind: 'noticed', message: normalized.id, reason: result.reason });
  }

  /**
   * A message observed in `channelId`: when a settle wait is armed there, it
   * now ends elsewhere.settleSeconds after this message, never later than
   * elsewhere.settleMaxSeconds after the call that armed it (read now). A
   * message that pushes the due time later counts as `moved`.
   */
  function touchSettle(channelId) {
    const entry = settles.get(channelId);
    if (!entry) return;
    entry.lastAt = now();
    const due = settleDue(entry);
    if (due === entry.due) return;
    if (due > entry.due) entry.moved += 1;
    scheduleSettle(channelId, entry, due);
  }

  /**
   * The settle wait of `sourceId` is over (`elsewhere: settled`): the waiting
   * call takes the ordinary call path (answerCall) toward the destination
   * resolved again now. It is dropped instead, and stays unanswered in the
   * ring, while paused or warming up and when the route no longer holds
   * (`elsewhere: dropped` with that code), or, as at the pending drain
   * (heldCallState): when the ring already holds it as answered (`mention:
   * already answered`, reason `ring`: a turn that showed it answered it --
   * read from state.json, so it holds across a restart and after a later
   * turn's view left the call out; read before the lookup below, and once
   * more after it); when its message was deleted meanwhile or cannot be
   * fetched now (`mention: dropped`, `gone` / `fetch-failed`:
   * messageStillExists); when a turn that spoke had it in view
   * (turns.spokeAfterSeeing -- a pulled block showed it and the persona
   * could answer it there; `mention: already answered`, and the call and the
   * other calls of its source that turn showed are stamped skipped in the
   * ring: skipSeenCalls); when its kind's switch was turned off
   * (`mention: dropped`, `off`). The calls it carries (`superseded`) go with it to
   * answerCall. A noticed wait (no call) goes to fireNoticed instead once
   * the pause / warmup check passed. A timer whose wait already ended (or
   * was removed) does nothing. Never rejects: it runs from a timer.
   */
  async function fireSettle(sourceId, entry) {
    if (settles.get(sourceId) !== entry) return;
    settles.delete(sourceId);
    try {
      const { kind, channel, normalized, triggerKind, superseded } = entry;
      log.info('elsewhere: settled', { source: sourceId, kind, waitedMs: now() - entry.firstAt, moved: entry.moved });
      const muted = followUpMuted();
      if (muted) {
        log.info('elsewhere: dropped', { source: sourceId, kind, message: normalized.id, reason: muted });
        return;
      }
      if (kind === 'noticed') {
        await fireNoticed(sourceId, entry);
        return;
      }
      const held = await heldCallState(channel, normalized.id, true);
      // A turn that showed this call in a pulled block of its source answered
      // it and stamped the ring (read from state.json: it holds across a
      // restart): not answered a second time.
      if (held === 'answered') {
        log.info('mention: already answered', { channel: sourceId, kind: triggerKind, reason: 'ring' });
        return;
      }
      if (held !== true) {
        log.info('mention: dropped', { channel: sourceId, kind: triggerKind, reason: missingReason(held) });
        return;
      }
      // A turn that spoke meanwhile showed this call in a pulled block of its
      // source: not answered a second time.
      if (turns.spokeAfterSeeing?.(sourceId, normalized.id)) {
        log.info('mention: already answered', { channel: sourceId, kind: triggerKind });
        skipSeenCalls(sourceId, normalized.id);
        return;
      }
      const config = hot.config;
      const features = config.features ?? {};
      // The switch that let this call through in onMessage step 8.
      const switchOff = callSwitchOff(triggerKind, features);
      if (switchOff) {
        log.info('mention: dropped', { channel: sourceId, kind: triggerKind, reason: 'off' });
        return;
      }
      const route = routeFor(channel, config, discord);
      if (!route.destination) {
        log.info('elsewhere: dropped', { source: sourceId, kind, message: normalized.id, reason: route.reason });
        return;
      }
      answerCall({ channel, normalized, kind: triggerKind, config, destination: route.destination, superseded });
    } catch (err) {
      log.error('elsewhere: settle failed', { source: sourceId, error: err });
    }
  }

  /**
   * A direct message (private chat). Checked locally with zero tokens: the
   * switch, other bots, the served guild, membership, a stored profile, the
   * public attitude and today's reply cap (privateGate). A refused DM is
   * dropped silently, except the daily-cap notice once a day per person. No
   * ignore roll, follow-up window, eavesdrop or address classifier here.
   */
  async function onPrivateMessage(event, config) {
    const message = event.raw;
    const features = config.features ?? {};
    if (features.privateMessages !== true) return;
    const selfId = client.user.id;
    if (message.author.bot && message.author.id !== selfId) return;
    // When the partner last wrote here (pace.settleMs); the persona's own messages never count.
    if (message.author.id !== selfId) activity?.note(message.channel.id, message.author.id, message.createdTimestamp);

    const guildId = getGuildId();
    if (!guildId) return;
    const memoryOn = features.memory !== false;
    const channel = message.channel;
    const normalized = normalizedOf(event);

    // The persona's own DM message: bookkeeping, remembered under the
    // partner's id. Without a usable partner id, or for a limit notice (not
    // the persona's speech), only the post is noted.
    if (normalized.self) {
      turns.notePost(normalized.channelId, normalized.ts);
      const partnerId = channel.recipientId ?? channel.recipient?.id;
      if (!partnerId || String(partnerId) === String(selfId)) return;
      if (isLimitNotice(hot.prompts?.labels, normalized.content)) return;
      if (memoryOn) memory.observe(guildId, normalized, { private: partnerId });
      return;
    }

    const authorId = message.author.id;
    const check = await checkPrivateGate(config, guildId, authorId);
    if (!check.gate.ok) {
      await dropPrivate(channel, guildId, authorId, normalized, check);
      return;
    }

    // Observed like a direct call; during a memory warmup run, never answered.
    if (memoryOn) memory.observe(guildId, normalized, { direct: true, private: authorId });
    if (isWarmingUp()) return;

    // One attention: busy anywhere (or, with oneAtATime off, in this very
    // chat) -> pending, answered by drainPending once the turn frees up.
    if (turnBlocked(channel.id, config)) {
      holdCall(channel, normalized, 'private');
      return;
    }

    turns
      .runTurn({ channel, guildId, mode: 'reply', trigger: normalized, triggerKind: 'private', queued: queuedFor(channel.id, normalized) })
      .then((result) => afterPrivateTurn(channel, guildId, normalized, result))
      .catch((err) => log.error('private: turn failed', { channel: channel.id, error: err }));
  }

  // --- The pause notice ---------------------------------------------------------
  // While paused (`/nep pause`) a direct call gets one plain line saying so
  // (labels.limits.paused, features.pauseNotice), like a limit notice. Read
  // only: no model request, no observe, no queue, no window, no ring stamp,
  // nothing marked dirty. The interval lives in memory alone.
  const pauseNoticeAt = new Map(); // channelId -> when the last pause notice went out

  /**
   * How `message` (arriving while paused) called the persona directly, by the
   * rules of the live path without its model request: on the server a
   * mention, a reply to one of its messages or its name (each behind its
   * switch) in the served guild, outside threads, in a channel the bot can
   * send in, not the dry-run mirror, from a human; in a private chat
   * (features.privateMessages) an author the private gate lets through, the
   * daily cap aside. `{ channel, trigger, kind }`, or null for anything else
   * (an untagged follow-up included: it would need the address classifier).
   */
  async function pausedCall(event, config) {
    const message = event.raw;
    const features = config.features ?? {};
    const selfId = client.user.id;
    if (message.author?.bot || message.author?.id === selfId) return null;
    const normalize = () => normalizedOf(event);

    if (!message.guild) {
      if (features.privateMessages !== true) return null;
      const guildId = getGuildId();
      if (!guildId) return null;
      const { gate } = await checkPrivateGate(config, guildId, message.author.id);
      if (!gate.ok && gate.reason !== 'cap') return null;
      return { channel: message.channel, trigger: normalize(), kind: 'private' };
    }

    const channel = message.channel;
    if (message.guild.id !== getGuildId() || channel.isThread?.()) return null;
    if (config.bot.dryRunChannelId && channel.id === config.bot.dryRunChannelId) return null;
    if (!canSend(channel)) return null;
    const normalized = normalize();
    const kind = detectTrigger({
      mentionsSelf: features.mentions !== false && event.addressing.mentioned,
      repliesToSelf: features.replies !== false && (event.addressing.replyToSelf || (await resolveReference(channel, normalized.replyToId, selfId))),
      content: normalized.content,
      nameTriggers: features.nameTriggers !== false ? config.bot.nameTriggers : [],
    });
    return kind ? { channel, trigger: normalized, kind } : null;
  }

  /**
   * A message arrived while paused: a direct call (pausedCall) gets the pause
   * notice in its channel -- a reply to the call, like a limit notice -- at
   * most once per channel per mention.pauseNoticeMinutes (0: every call).
   * Off with features.pauseNotice or without the label; anything else stays
   * silent. Config and labels read now.
   */
  async function maybePauseNotice(event) {
    const config = hot.config;
    if (config.features?.pauseNotice === false) return;
    const labels = hot.prompts?.labels;
    if (!pauseNotice(labels)) return;
    const call = await pausedCall(event, config);
    if (!call) return;
    const minutes = pauseNoticeMinutes(config);
    const last = pauseNoticeAt.get(call.channel.id);
    const t = now();
    if (minutes > 0 && last !== undefined && t - last < minutes * MINUTE_MS) return;
    pauseNoticeAt.set(call.channel.id, t);
    await postPauseNotice({ ...call, asReply: true, labels, config, client });
  }

  /**
   * A member's line in a server channel right after the persona spoke there: it joins the
   * channel's newest participation episode (src/memory/participation.js#recordFollowing,
   * settings read now) and the store is written only when it changed (`participation:
   * recorded`, `following: true`). Cheap: nothing is fetched and no profile read, and the store
   * is not even read unless the persona's last post here (turns.lastPostAt) is within
   * `participation.followMinutes`. Off with features.memory or features.participation false (a
   * missing key counts as on), in the diary channel, or for a store without the participation
   * store. Never throws: a failure logs `participation: failed` (`reason: 'following-error'`).
   */
  function noteFollowingLine(guildId, normalized, config) {
    try {
      const features = config.features ?? {};
      if (features.memory === false || features.participation === false) return;
      const diaryId = config.diary?.channelId;
      if (diaryId && normalized.channelId === diaryId) return;
      const settings = participationSettings(config);
      const lastOwn = typeof turns.lastPostAt === 'function' ? turns.lastPostAt(normalized.channelId) : 0;
      if (!(lastOwn > 0) || normalized.ts - lastOwn > settings.followMinutes * MINUTE_MS) return;
      if (typeof store?.getParticipation !== 'function' || typeof store.setParticipation !== 'function') return;
      const message = {
        id: normalized.id,
        ts: normalized.ts,
        authorId: normalized.authorId,
        name: normalized.authorName ?? '',
        self: false,
        text: normalized.content ?? '',
        replyTo: normalized.replyToId ?? null,
        caption: null,
      };
      const at = now();
      const state = store.getParticipation(guildId);
      const next = recordFollowing(state, { channelId: normalized.channelId, message }, settings, at);
      if (next === state) return;
      store.setParticipation(guildId, next, { settings, now: at });
      log.info('participation: recorded', { channel: normalized.channelId, episodes: next.episodes.length, following: true });
    } catch (err) {
      log.warn('participation: failed', { channel: normalized?.channelId ?? null, reason: 'following-error', name: err?.name ?? null });
    }
  }

  // The ids of the messages the gateway delivered and of those the start's catch-up delivered
  // (catchUpMessage), each the newest CATCH_UP_IDS_KEPT: a message the gateway also delivers is
  // handled once, whichever path reaches it first. The live path never skips a message the
  // catch-up has not taken.
  const liveIds = new Set();
  const caughtUpIds = new Set();
  /** Add `id` to `ids`, the oldest past the cap going first. */
  function keepId(ids, id) {
    ids.add(id);
    if (ids.size > CATCH_UP_IDS_KEPT) ids.delete(ids.values().next().value);
  }

  async function onMessage(event) {
    await handleMessage(event, null);
  }

  /**
   * One message posted while the bot was offline (src/behavior/catch-up.js, at start), handled
   * like a live one with three differences: it is dropped when the gateway (or an earlier
   * catch-up) already delivered it; nothing at all happens while paused (no pause notice), in a
   * private chat or for a line that is no call (no follow-up, eavesdrop or room question for
   * stale chatter); and a call (a mention, a reply to the persona, her name -- the live
   * detectTrigger) reaches the ordinary call path (answerCall, or the settle wait of a channel
   * she cannot write in) only with `trigger` true, otherwise it is only observed. Never throws.
   * @param {import('../protocol.js').MessageReceived & { raw: object }} event
   * @param {{ trigger?: boolean }} [options]
   * @returns {Promise<'duplicate'|'ignored'|'observed'|'triggered'>}
   */
  async function catchUpMessage(event, { trigger = false } = {}) {
    return (await handleMessage(event, { trigger: trigger === true })) ?? 'ignored';
  }

  async function handleMessage(event, catchUp) {
    try {
      // The discord.js message behind the event: still needed for the channel, the guild and
      // the sends of this stage; everything the normaliser gave is read from the event.
      const message = event.raw;
      // 1. System / webhook messages are not conversation.
      if (message.system || message.webhookId) return 'ignored';

      // 1a. Once per message across the gateway and the start's catch-up (checked and noted
      // before the first await, so the two paths never both take it).
      const messageId = message.id ?? event.message?.id ?? null;
      if (messageId) {
        if (caughtUpIds.has(messageId)) return 'duplicate';
        if (catchUp) {
          if (liveIds.has(messageId)) return 'duplicate';
          keepId(caughtUpIds, messageId);
        } else {
          keepId(liveIds, messageId);
        }
      }

      // 1b. Paused (owner editing data/ by hand, /nep pause): the
      // persona does nothing at all -- no observe, no trigger, no turn, no
      // eavesdrop -- and nothing below may mark the store dirty. A direct
      // call only gets the pause notice (maybePauseNotice); a caught-up one not even that.
      if (store?.state?.data?.paused) {
        if (!catchUp) await maybePauseNotice(event);
        return 'ignored';
      }

      const config = hot.config;
      const features = config.features ?? {};
      const memoryOn = features.memory !== false;

      // 2. DMs: private chat (features.privateMessages, off by default) --
      // see onPrivateMessage. Owner commands are slash commands
      // (interfaces/discord/commands.js, interactionCreate), never DMs.
      if (!message.guild) {
        if (catchUp) return 'ignored';
        await onPrivateMessage(event, config);
        return;
      }

      // 3. This instance serves exactly one guild; no threads. Which channels
      // it sees is Discord's permissions alone.
      if (message.guild.id !== getGuildId()) return 'ignored';
      if (message.channel.isThread?.()) return 'ignored';

      // 3b. The dry-run mirror channel is the owner's private test room: it
      // carries the persona's own rehearsal output (src/behavior/turn.js),
      // never real conversation. Nothing posted here is ever observed into
      // memory, no trigger is detected, no turn runs, no eavesdrop.
      const dryRunChannelId = config.bot.dryRunChannelId;
      if (dryRunChannelId && message.channel.id === dryRunChannelId) return 'ignored';

      // 3c. When this author last wrote in this channel, for a turn that waits until the person
      // it answers stops writing (pace.settleMs). The persona's own messages never count.
      if (message.author.id !== client.user.id) activity?.note(message.channel.id, message.author.id, message.createdTimestamp);
      // Any message, hers included, pushes back a missed-answer sweep armed here (src/behavior/missed.js).
      missed?.noteActivity(message.channel.id, message.createdTimestamp);

      // 4. The normalised message, as the event carries it.
      const selfId = client.user.id;
      const normalized = normalizedOf(event);
      const guildId = message.guild.id;

      // 5. Its own message: only bookkeeping. Also (re)opens/extends the
      // follow-up window for this channel -- see noteFollowUpSend above. A
      // limit notice is not the persona's speech: the post is noted, but it
      // never opens a window or reaches memory.
      if (normalized.self) {
        turns.notePost(normalized.channelId, normalized.ts);
        if (isLimitNotice(hot.prompts?.labels, normalized.content)) return 'ignored';
        noteFollowUpSend(normalized.channelId, normalized.ts);
        if (memoryOn) memory.observe(guildId, normalized);
        return 'observed';
      }

      // 6. Other bots are never answered, never memorised.
      if (message.author.bot) return 'ignored';

      // 6b. A line soon after the persona's own one here joins her participation episode.
      noteFollowingLine(guildId, normalized, config);

      // 7. A memory warmup run is in flight: the persona stays mute (no
      // trigger, no turn, no eavesdrop), but the message still feeds the
      // memory buffer like any other observed message.
      if (isWarmingUp()) {
        warmMediaCache(guildId, normalized);
        if (memoryOn) memory.observe(guildId, normalized, { direct: false });
        return 'observed';
      }

      // 8. Detect how (if at all) the persona was called, masking each input
      // by its own feature switch so detectTrigger itself stays pure. Done
      // BEFORE memory observes the message, so the buffer can mark it. A
      // forward of the persona's own message has no replyToId: not a reply.
      const mentionsSelf = features.mentions !== false && event.addressing.mentioned;
      // The adapter's cached answer first; else the reference is fetched as before.
      const repliesToSelf = features.replies !== false && (event.addressing.replyToSelf || (await resolveReference(message.channel, normalized.replyToId, selfId)));
      const nameTriggers = features.nameTriggers !== false ? config.bot.nameTriggers : [];
      const kind = detectTrigger({
        mentionsSelf,
        repliesToSelf,
        content: normalized.content,
        nameTriggers,
      });

      // 9. Everyone else feeds memory; a message addressed to the persona is
      // marked `direct` so the analyzer can weigh it separately.
      const ownPrefill = warmMediaCache(guildId, normalized);
      if (memoryOn) memory.observe(guildId, normalized, { direct: Boolean(kind) });

      // 9b. A channel whose call waits to be answered elsewhere is still
      // talking: its settle wait moves (touchSettle).
      touchSettle(message.channel.id);

      // 10. No trigger: maybe a follow-up (features.followUp) inside a
      // window the persona itself opened by answering -- fully handled by
      // maybeFollowUp either way (a computed verdict or a deliberate no-op,
      // see its own header comment); otherwise let the spontaneous scheduler
      // eavesdrop, nothing more. In a channel the bot cannot send in, an
      // eavesdrop hit there arms a noticed settle wait (maybeNotice). A
      // line the eavesdrop roll did not schedule may still be put to the
      // whole room (maybeRoom). A caught-up line stops here: no follow-up, eavesdrop or room
      // question for chatter from before the start; so does a caught-up call not to be answered.
      if (catchUp && (!kind || !catchUp.trigger)) return 'observed';
      if (!kind) {
        const followedUp = await maybeFollowUp(message, normalized, selfId, ownPrefill);
        if (!followedUp) {
          const scheduled = spontaneous.onMessage(message.channel, normalized) === true;
          if (!canSend(message.channel)) maybeNotice(message.channel, normalized);
          else if (!scheduled) await maybeRoom(message, normalized, selfId, ownPrefill);
        }
        return;
      }

      // 11. The persona was called where it cannot write: the call is
      // answered in the main channel when the route holds (routeFor) --
      // recorded in the ring, then answered once this channel settles
      // (armSettle). Otherwise it is never queued, but it leaves a trace with
      // the route's code.
      if (!canSend(message.channel)) {
        const route = routeFor(message.channel, config, discord);
        if (!route.destination) {
          log.info('mention: dropped', { channel: message.channel.id, kind, reason: 'cannot-send', route: route.reason });
          return 'observed';
        }
        rememberCall(message.channel, normalized, config);
        armSettle(message.channel, normalized, kind, route.destination);
        return 'triggered';
      }

      // 11b. Decide whether to actually answer, or keep a direct call
      // pending while a turn runs (answerCall).
      answerCall({ channel: message.channel, normalized, kind, config });
      return 'triggered';
    } catch (err) {
      log.error('events: message handler failed', { error: err });
      return 'ignored';
    }
  }

  /**
   * A message changed after it arrived (`messageUpdate`). Discord attaches some embeds late -- a
   * Tenor link's `gifv` embed comes in an update, not with `messageCreate` -- so the buffered
   * copy would keep a bare link and its GIF would never reach the library. When the message is
   * still in the memory buffer, its copy is rebuilt from the updated message (src/memory/
   * update.js#slimMessage, keeping its `direct` mark); the attachments and links it did not
   * carry yet are counted into the GIF library (features.gifs) and handed to the media prefill
   * under the same switches as on arrival (warmMediaCache). Nothing else: no trigger, no turn,
   * no eavesdrop, no counters, no channel map, no affinity. A message no longer buffered (the
   * analyzer took it) is an accepted miss, logged with counts only. Off with
   * features.embedUpdates (a missing key counts as on), with features.memory off and while
   * paused. Only the served guild, a channel outside threads and the dry-run mirror,
   * and a human author's message with embeds. Config read now. Never throws.
   * @param {import('../protocol.js').MessageReceived & { raw: object, rawPrevious: object|null }} event
   *   The edit event (collect.js#toEvent with `edit`): `raw` is the updated discord.js message,
   *   `rawPrevious` the old one; a partial one is fetched here and its event built again.
   * @returns {Promise<void>}
   */
  async function onMessageUpdate(event) {
    await recordEdit(event);
    try {
      const config = hot.config;
      const features = config.features ?? {};
      if (features.embedUpdates === false || features.memory === false) return;
      if (store?.state?.data?.paused) return;
      let message = event.raw;
      let edited = event;
      const guildId = message?.guild?.id ?? message?.guildId ?? null;
      if (!guildId || guildId !== getGuildId()) return;
      if (message.partial) {
        message = await message.fetch();
        edited = null;
      }
      if (message.system || message.webhookId) return;
      const selfId = client.user.id;
      if (!message.author || message.author.bot || message.author.id === selfId) return;
      if (message.channel?.isThread?.()) return;
      const dryRunChannelId = config.bot.dryRunChannelId;
      if (dryRunChannelId && message.channel.id === dryRunChannelId) return;
      const embeds = message.embeds?.length ?? 0;
      if (embeds === 0) return;

      // A message fetched whole here gets its event now, as the adapter would have built it.
      const normalized = normalizedOf(edited ?? toEvent(message, selfId, { ...normalizeOptions(config), edit: true, now }));
      const fields = { channelId: normalized.channelId, messageId: normalized.id, embeds };
      const buffered = store.getBuffer(guildId).find((m) => m?.id != null && String(m.id) === String(normalized.id));
      if (!buffered) {
        log.info('events: embeds late', fields);
        return;
      }
      const late = lateMedia(normalized, bufferedMediaIds(buffered));
      store.updateBuffered(guildId, slimMessage(normalized, buffered.direct === true));
      const gifs = features.gifs !== false ? store.recordGifs(guildId, [late], gifOpts(config)) : 0;
      warmMediaCache(guildId, late);
      log.info('events: embeds folded', { ...fields, gifs });
    } catch (err) {
      log.error('events: update handler failed', { error: err });
    }
  }

  /**
   * Whether `message` may enter the record: a record injected and features.record exactly true
   * (`config` read now), the served guild, no system or webhook message, no other bot's, a
   * channel outside threads and the dry-run mirror.
   */
  function recordable(message, config) {
    if (!record || config.features?.record !== true) return false;
    const guildId = message?.guild?.id ?? message?.guildId ?? null;
    if (!guildId || guildId !== getGuildId()) return false;
    if (message.system || message.webhookId) return false;
    if (message.author?.bot && message.author.id !== client.user?.id) return false;
    if (!message.channel || message.channel.isThread?.()) return false;
    const dryRunChannelId = config.bot?.dryRunChannelId;
    return !(dryRunChannelId && message.channel.id === dryRunChannelId);
  }

  /** The text of a message as Discord holds it, for telling an edit from an embed update. */
  const rawText = (message) => (typeof message?.content === 'string' ? message.content : (message?.cleanContent ?? ''));

  /**
   * An edited message (its text changed between `oldMessage` and `newMessage`) as a `seen`
   * line of the record with the next revision of the day (`revisions`). An update that only
   * attached embeds is no edit. `event` is onMessageUpdate's (its `raw` and `rawPrevious` the
   * new and old discord.js messages). Never throws: a refused append is logged as `events:
   * record failed` (counts only).
   */
  async function recordEdit(event) {
    try {
      const config = hot.config;
      const newMessage = event?.raw;
      const oldMessage = event?.rawPrevious ?? null;
      if (!newMessage || newMessage.partial || event.partial || !recordable(newMessage, config)) return;
      if (oldMessage && !oldMessage.partial && rawText(oldMessage) === rawText(newMessage)) return;
      const guildId = newMessage.guild?.id ?? newMessage.guildId;
      const normalized = normalizedOf(event);
      const buffered = typeof store?.getBuffer === 'function' ? store.getBuffer(guildId).find((m) => m?.id != null && String(m.id) === String(normalized.id)) : null;
      const day = utcDay(now());
      if (day !== revisionsDay) {
        revisions.clear();
        revisionsDay = day;
      }
      const revision = (revisions.get(normalized.id) ?? 1) + 1;
      revisions.set(normalized.id, revision);
      const slim = slimMessage(normalized, buffered?.direct === true);
      // A revision the record already holds (a tool appended one) moves the edit past it; later edits continue from there.
      const landed = await appendRevision(record, guildId, (next) => toRecordLine(slim, { revision: next, now }), revision);
      if (landed.revision > (revisions.get(normalized.id) ?? 0)) revisions.set(normalized.id, landed.revision);
    } catch (err) {
      log.warn('events: record failed', { kind: 'seen', lines: 1, code: err?.code ?? null });
    }
  }

  /**
   * A message of the served guild deleted on Discord (`messageDelete`) as a `deleted` line of
   * the record, dated by the message's own creation time (`createdTimestamp`, which a partial
   * message has too; now when missing) so a window can place it; the envelope's `recordedAt`
   * keeps the deletion time. The message's recorded text stays (a deletion is not a forget
   * request). Only what `recordable` lets in. Never throws: a refused append is logged as
   * `events: record failed` (counts only).
   * @param {import('../protocol.js').MessageReceived & { raw: object }} event  The deletion
   *   event (collect.js#toEvent with `deleted`): `message.id`, and `raw` the deleted discord.js
   *   message, possibly partial.
   * @returns {Promise<void>}
   */
  async function onMessageDelete(event) {
    try {
      const config = hot.config;
      const message = event?.raw;
      const id = event?.message?.id;
      if (!id || !recordable(message, config)) return;
      const guildId = message.guild?.id ?? message.guildId;
      const line = toRecordLine(
        { id: String(id), channelId: message.channel.id, authorId: message.author?.id ?? null, ts: Number.isFinite(message.createdTimestamp) && message.createdTimestamp > 0 ? message.createdTimestamp : now() },
        { kind: 'deleted', now },
      );
      await record.append(guildId, [line]);
    } catch (err) {
      log.warn('events: record failed', { kind: 'deleted', lines: 1, code: err?.code ?? null });
    }
  }

  onMessage.drainPending = drainPending;
  onMessage.catchUp = catchUpMessage;
  onMessage.onMessageUpdate = onMessageUpdate;
  onMessage.onMessageDelete = onMessageDelete;
  /**
   * Drop every pending direct ping and every settle wait without answering any
   * of them (`/nep pause`): no timer fires afterwards. Each wait is logged as
   * `elsewhere: dropped` (`paused`); its call stays unanswered in the ring.
   */
  onMessage.clearPending = () => {
    pendingList = [];
    clearSettles('paused');
  };
  /** How many direct pings wait for the attention (src/behavior/inner.js lets people go first). */
  onMessage.pendingCount = () => pendingList.length;
  /** Clear every settle wait without answering its call (shutdown): none starts a turn on a client going down. */
  onMessage.stop = () => {
    clearSettles(null);
  };
  return onMessage;
}
