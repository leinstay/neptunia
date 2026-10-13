// The replay sandbox (tools/replay.mjs). A sandbox turn takes a real moment of
// the chat -- normalized channel messages fetched again, the trigger among
// them -- builds the request a real turn would build for it (live prompts,
// live config, the stored memory or a snapshot of it), asks the model, parses
// the answer, and stops there: nothing reaches Discord and nothing is written
// to memory. It reproduces the reply path (src/behavior/prompt.js#buildRequest,
// src/behavior/turn.js) as the turn it was when the caller knows its mode and
// trigger kind (an overheard line, a follow-up, a name call, an unasked turn);
// otherwise the trigger is a reply when it replies to the persona, else a
// mention. The last hours (`<recent>`) are the view's recent lines of the
// channel the turn is in, as they stood at the turn's time.
// Every input of buildRequest is named here (`sandboxRequestInput`); the ones
// a sandbox turn leaves out on purpose are `SANDBOX_OMITS`, each with its
// reason, so a new input of the request builder cannot go missing unseen.
// Outside that request it never reproduces the address classifier (whether
// the persona answers at all), the analyzer prompts, or a private chat.
//
// Every read of prompts, config and memory goes through a `view` (see
// `liveView`), never through `hot` or the store directly, so a caller can hand
// in another view of the same shape: `momentView` wraps one so that its
// memory leaves out what the analyzer wrote at or after the moment (the
// persona would otherwise "remember" how the exchange ended). The private
// layer is out of bounds: a view has no accessor for it and no private chat is
// ever built. The persona saw more of the chat's media than its labels: the
// describer's cached captions and watched summaries render through
// `replayMedia`, the cache only read.

import { buildRequest, userText as userTextOf } from './prompt.js';
import { isTaggedCall } from './mention.js';
import { pickOtherProfiles } from './turn.js';
import { collectEmojiItems, collectPictures, collectVideos, isDescribable } from '../discord/media.js';
import { REPLY_REQUEST, cacheTtlFor } from '../llm/openrouter.js';
import { parseOutput } from '../llm/parse.js';
import { log } from '../log.js';
import { findGif } from '../memory/gifs.js';
import { liveRecent, recentSettings } from '../memory/recent.js';
import { utcDay } from '../time.js';

// Token estimates taken as they are: the calibrator of a view built without a live one.
const IDENTITY_CALIBRATOR = Object.freeze({ ratio: 1, apply: (n) => n, observe: () => 1 });
// pickOtherProfiles takes a guild id; the view serves one guild, so this only fills the argument.
const SANDBOX_GUILD = 'sandbox';
/**
 * A cache breakpoint on the user part. A JSON field, not prompt text: the llm client
 * (src/llm/openrouter.js#withCacheMarker) gives it its own TTL, or removes it when the
 * request is not cached.
 */
const USER_CACHE_MARKER = Object.freeze({ type: 'ephemeral' });

/** The modes a moment's turn can have (src/behavior/turn.js#runTurn after `auto` is chosen). */
const MODES = new Set(['reply', 'interject', 'initiate']);
/** The modes of a turn nobody asked for: no trigger. */
const SPONTANEOUS = new Set(['interject', 'initiate']);
/** src/behavior/turn.js#TriggerKind without `private`: a private chat is never replayed. */
const KINDS = new Set(['mention', 'reply', 'name', 'followUp', 'overheard', 'drawFailed']);

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** The kinds of items `momentView` hides, in the order `hiddenLater` reports them. */
const HIDDEN_KINDS = ['episodes', 'affinity', 'reasons', 'details', 'interests', 'aliases', 'learned', 'lore'];

/**
 * Every memory store method a sandbox turn calls (`liveView`, the GIF library
 * and the describer cache). A read-only store (a tool's) allows exactly these.
 * `getRecent`, `getGifs` and `getMediaCache` may be missing: the turn then goes
 * on without the recent lines, the GIF library or the captions.
 */
export const SANDBOX_STORE_READS = Object.freeze([
  'getGuild',
  'getUser',
  'listUserProfiles',
  'listChannels',
  'getLore',
  'getRecent',
  'getGifs',
  'getMediaCache',
]);

/**
 * The inputs of src/behavior/prompt.js#buildRequest a sandbox turn leaves
 * out on purpose, each with its reason: `sandboxRequestInput` passes them in
 * the form buildRequest reads as absent (null; `neighbors` and `pulled` an
 * empty list). Every other input is passed.
 * @type {Readonly<Record<string, string>>}
 */
export const SANDBOX_OMITS = Object.freeze({
  neighbors: 'no neighbouring channel is fetched: no <other_channels>',
  neighborDescriptions: 'no neighbouring channel, so no captions of one',
  pulled: 'no other channel is pulled in: no <channel_view>',
  source: 'no routed call: the moment is answered in its own channel',
  readOnlyIds: 'no pulled channel, so none of them is read-only',
  privateChat: 'never a private chat: the private layer is out of bounds',
  privateProfile: 'never a private chat: the private layer is out of bounds',
  reads: 'no web lookup: no link is read',
  lookup: 'no web lookup: no search is run',
  imageAnswers: 'no second look at a picture is run: no imageAnswered line',
  recallAvailable: 'no server search is run: <senses> does not offer it',
  drawQuota: 'no drawing is offered: a sandbox never draws, so <senses> has no drawing line',
  drawReason: 'a failed drawing\'s reason is not known to a replay',
  focus: 'no room question: a live turn has no caller for it either',
  tasks: 'no part of a split message, no queued or folded call: a replay knows none',
  recentAudience: 'no guild to compare audiences in: <recent> shows the lines of the turn\'s own channel only',
  participation: 'no guild to compare audiences in: no <participation> block of the persona\'s exchanges elsewhere',
  diaryChannel: 'no diary is offered: a sandbox turn never posts, so <senses> has no diary line',
  diary: 'never a diary post: no <world>, <diary>, <plan> or <found> block',
});

/** A non-empty string id. */
function isId(value) {
  return typeof value === 'string' && value !== '';
}

/**
 * A recorded turn mode: `reply`, `interject` or `initiate`; null for anything
 * else. Pure.
 * @param {unknown} value
 * @returns {'reply'|'interject'|'initiate'|null}
 */
export function momentMode(value) {
  return MODES.has(value) ? value : null;
}

/**
 * A recorded trigger kind (src/behavior/turn.js#TriggerKind, never
 * `private`); null for anything else. Pure.
 * @param {unknown} value
 * @returns {string|null}
 */
export function momentKind(value) {
  return KINDS.has(value) ? value : null;
}

/** Whether `mode` is a turn nobody asked for (`interject`, `initiate`): it has no trigger. Pure. */
export function isSpontaneous(mode) {
  return SPONTANEOUS.has(mode);
}

/**
 * The message a moment answers: the one its `triggerId` names in its
 * history, else the last message of the history. Null for a spontaneous turn
 * and for an empty history.
 */
function momentTrigger(moment) {
  const history = Array.isArray(moment?.history) ? moment.history : [];
  if (history.length === 0 || isSpontaneous(moment?.mode)) return null;
  const id = moment.triggerId;
  const found = isId(id) ? history.find((message) => message?.id === id) : null;
  return found ?? history[history.length - 1] ?? null;
}

// ---- what the persona saw of the moment's media -------------------------------------

/** `cache[key]` when it is the cache's own entry (never an inherited property), else undefined. */
function entryOf(cache, key) {
  return cache && typeof cache === 'object' && Object.prototype.hasOwnProperty.call(cache, key) ? cache[key] : undefined;
}

/**
 * The text of a describer cache entry the persona could have seen: not a
 * miss, a non-empty `text`, a watched video (`watched`) or a caption as asked,
 * and written no later than `before` (an entry without a time is taken; a
 * null `before` takes any time). Else null.
 */
function seenText(entry, { watched, before }) {
  if (!entry || typeof entry !== 'object' || entry.miss) return null;
  if ((entry.watched === true) !== watched) return null;
  if (typeof entry.text !== 'string' || !entry.text.trim()) return null;
  if (before !== null && Number.isFinite(entry.ts) && entry.ts > before) return null;
  return entry.text;
}

/**
 * The media item ids of one normalized message a live turn could have had
 * described (its forwarded snapshots included), as the live turn collects
 * them: pictures (src/discord/media.js#collectPictures and
 * #collectEmojiItems, describable ones) and videos (#collectVideos over `sites`).
 */
function mediaItemsOf(message, sites) {
  const pictures = [...collectPictures(message), ...collectEmojiItems(message)].filter(isDescribable).map((item) => item.itemId);
  const videos = collectVideos(message, { videoSites: Array.isArray(sites) ? sites : [] }).map((item) => item.itemId);
  return { pictures: [...new Set(pictures)], videos: [...new Set(videos)] };
}

/**
 * The caption and video maps a replayed moment's transcript is rendered
 * with (src/discord/format.js#formatTranscript's `descriptions` and
 * `videos`, the same the live turn passes): for every media item of the
 * history, the describer's `cache` entry as it stood by `before` (null: any
 * time), read only. A cached miss, a limit or error state and an entry written
 * after `before` are no description; a watched summary is the video state
 * `{ state: 'watched', text }`. Without a cache, empty maps. Pure.
 * @param {object[]} history  Normalized messages (src/discord/collect.js#normalizeMessage).
 * @param {{ cache?: object|null, sites?: string[], before?: number|null }} [options]  `cache`: the
 *   describer's cache (`store.getMediaCache(guildId)`), or null.
 * @returns {{ descriptions: Map<string, string>, videos: Map<string, { state: 'watched', text: string }> }}
 */
export function replayMedia(history, { cache = null, sites = [], before = null } = {}) {
  const descriptions = new Map();
  const videos = new Map();
  if (!cache) return { descriptions, videos };
  for (const message of Array.isArray(history) ? history : []) {
    if (!message || typeof message !== 'object') continue;
    const { pictures, videos: clips } = mediaItemsOf(message, sites);
    for (const id of pictures) {
      const text = seenText(entryOf(cache, id), { watched: false, before });
      if (text !== null && !descriptions.has(id)) descriptions.set(id, text);
    }
    for (const id of clips) {
      const text = seenText(entryOf(cache, `video:${id}`), { watched: true, before });
      if (text !== null && !videos.has(id)) videos.set(id, { state: 'watched', text });
    }
  }
  return { descriptions, videos };
}

// ---- the memory as it stood at the moment ----------------------------------------

function zeroCounts() {
  return Object.fromEntries(HIDDEN_KINDS.map((kind) => [kind, 0]));
}

/** The time (ms) of an ISO string or an epoch number; null when there is none. */
function timeOf(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Whether a dated value is at or after `cutoff`; an undated one never is. */
function isLater(value, cutoff) {
  const ms = timeOf(value);
  return ms !== null && ms >= cutoff;
}

/**
 * Whether an episode was written at or after `cutoff`: by its `addedAt` (when
 * the analyzer stored it); without one, by its `date`, day by day -- an
 * episode dated the cutoff's day or later is hidden, as that day may hold the
 * moment itself. An episode with neither is kept.
 */
function isLaterEpisode(episode, cutoff) {
  if (timeOf(episode?.addedAt) !== null) return isLater(episode.addedAt, cutoff);
  if (typeof episode?.date === 'string' && DAY_RE.test(episode.date)) return episode.date >= utcDay(cutoff);
  return false;
}

/** `list` without the items `later` flags, and how many were left out; a non-array passes through. */
function keepBefore(list, later) {
  if (!Array.isArray(list)) return { list, hidden: 0 };
  const kept = list.filter((item) => !later(item));
  return { list: kept, hidden: list.length - kept.length };
}

/**
 * An affinity without the history entries at or after `cutoff`. When the
 * newest stored entry is one of them, the current `reason` came from it (or
 * from a later one): it falls back to the reason of the newest entry kept that
 * has one -- an entry may carry an empty reason (a two-stage move not worded
 * yet, see src/memory/affinity.js#applyDelta), and the stored reason then
 * stayed the earlier one -- or to none. The score is left as stored.
 */
function affinityBefore(affinity, cutoff) {
  if (!affinity || typeof affinity !== 'object' || !Array.isArray(affinity.history)) return { affinity, hidden: 0, reasons: 0 };
  const { list: history, hidden } = keepBefore(affinity.history, (entry) => isLater(entry?.ts, cutoff));
  if (hidden === 0) return { affinity, hidden: 0, reasons: 0 };
  const newest = affinity.history[affinity.history.length - 1];
  if (!isLater(newest?.ts, cutoff)) return { affinity: { ...affinity, history }, hidden, reasons: 0 };
  const worded = history.findLast((entry) => typeof entry?.reason === 'string' && entry.reason !== '');
  return { affinity: { ...affinity, history, reason: worded ? worded.reason : '' }, hidden, reasons: 1 };
}

/**
 * A member's profile as it stood before `cutoff`: episodes, affinity history
 * (and the reason it produced), details, interests and aliases first recorded
 * at or after the cutoff left out. A new object when anything was hidden, the
 * stored profile itself otherwise; null for null.
 * @returns {{ profile: object|null, hidden: object }}
 */
function profileBefore(profile, cutoff) {
  const hidden = zeroCounts();
  if (!profile || typeof profile !== 'object') return { profile, hidden };
  const firstSeenLater = (item) => isLater(item?.firstSeen, cutoff);
  const episodes = keepBefore(profile.episodes, (episode) => isLaterEpisode(episode, cutoff));
  const details = keepBefore(profile.details, firstSeenLater);
  const interests = keepBefore(profile.interests, firstSeenLater);
  const aliases = keepBefore(profile.aliases, firstSeenLater);
  const affinity = affinityBefore(profile.affinity, cutoff);
  hidden.episodes = episodes.hidden;
  hidden.details = details.hidden;
  hidden.interests = interests.hidden;
  hidden.aliases = aliases.hidden;
  hidden.affinity = affinity.hidden;
  hidden.reasons = affinity.reasons;
  if (HIDDEN_KINDS.every((kind) => hidden[kind] === 0)) return { profile, hidden };
  const out = { ...profile };
  if (episodes.hidden) out.episodes = episodes.list;
  if (details.hidden) out.details = details.list;
  if (interests.hidden) out.interests = interests.list;
  if (aliases.hidden) out.aliases = aliases.list;
  if (affinity.hidden) out.affinity = affinity.affinity;
  return { profile: out, hidden };
}

/** The guild memory before `cutoff`: learned items first recorded at or after it left out. */
function guildBefore(guild, cutoff) {
  if (!guild || typeof guild !== 'object') return { guild, hidden: 0 };
  const learned = keepBefore(guild.learned, (item) => isLater(item?.firstSeen, cutoff));
  return learned.hidden ? { guild: { ...guild, learned: learned.list }, hidden: learned.hidden } : { guild, hidden: 0 };
}

/** The lorebook before `cutoff`: entries created at or after it left out. */
function loreBefore(entries, cutoff) {
  return keepBefore(entries, (entry) => isLater(entry?.createdAt, cutoff));
}

/**
 * The recent store (src/memory/store.js#getRecent) before `cutoff`: the lines
 * the analyzer added at or after it left out (by `addedAt`; a line without
 * one, by the time of the moment it is about, `at`). A new object when a line
 * was hidden, the given one otherwise; a value without `lines` (a view
 * without a recent store reads null) passes through.
 */
function recentBefore(recent, cutoff) {
  if (!recent || typeof recent !== 'object' || !Array.isArray(recent.lines)) return recent;
  const { list, hidden } = keepBefore(recent.lines, (line) => isLater(timeOf(line?.addedAt) !== null ? line.addedAt : line?.at, cutoff));
  return hidden ? { ...recent, lines: list } : recent;
}

/**
 * When a replayed moment's memory stops: the time of the newest line the
 * persona saw (the last message of its `history`, or its trigger when that
 * is newer), else its `at` (when the persona answered); null when neither is
 * known (nothing is then hidden). Pure.
 * @param {{ history?: object[], triggerId?: string|null, mode?: string|null, at?: number }} moment
 * @returns {number|null}
 */
export function momentCutoff(moment) {
  const history = Array.isArray(moment?.history) ? moment.history : [];
  const times = [history[history.length - 1]?.ts, momentTrigger(moment)?.ts].filter(Number.isFinite);
  if (times.length > 0) return Math.max(...times);
  return Array.isArray(moment?.history) && Number.isFinite(moment?.at) ? moment.at : null;
}

/**
 * A view of the same shape as `base` (`liveView`) whose memory is the base
 * memory as it stood before `cutoff`: every dated item written at or after it
 * is left out -- a member's episodes (by `addedAt`; without one, those dated
 * the cutoff's day or later), affinity history entries (by `ts`; when the
 * newest one goes, `reason` falls back to that of the newest kept entry that
 * has one, or to ''; the score stays), details, interests and aliases (by
 * `firstSeen`), the guild's learned items (by `firstSeen`), lore entries (by
 * `createdAt`) and the recent store's lines (by `addedAt`, else by their
 * moment `at`; null for a base without `getRecent`). Undated items and every
 * other field pass through -- a profile's names and counters, its portrait
 * and relationship text, the guild's patterns, the channel entries, the
 * current text of a lore entry updated later; `prompts`, `config`,
 * `calibrator` and `listChannels` are the base's, read at call time. The base
 * is never written and nothing is cached. Pure.
 * @param {object} base
 * @param {number} cutoff  Epoch ms.
 * @returns {object}
 */
export function momentView(base, cutoff) {
  return {
    get prompts() {
      return base.prompts;
    },
    get config() {
      return base.config;
    },
    get calibrator() {
      return base.calibrator;
    },
    memory: {
      getGuild: () => guildBefore(base.memory.getGuild(), cutoff).guild,
      getUser: (id) => profileBefore(base.memory.getUser(id), cutoff).profile,
      listUserProfiles: () => (base.memory.listUserProfiles() ?? []).map((profile) => profileBefore(profile, cutoff).profile),
      listChannels: () => base.memory.listChannels(),
      getLore: () => loreBefore(base.memory.getLore(), cutoff).list,
      getRecent: () => recentBefore(typeof base.memory.getRecent === 'function' ? base.memory.getRecent() : null, cutoff),
    },
  };
}

/**
 * How many items `momentView(base, cutoff)` leaves out over the whole memory,
 * by kind: `episodes`, `affinity` (history entries), `reasons` (attitudes
 * whose reason fell back), `details`, `interests`, `aliases`, `learned`,
 * `lore`. The recent lines it leaves out are not counted. Counts only. Pure.
 * @param {object} base
 * @param {number} cutoff
 * @returns {{ episodes: number, affinity: number, reasons: number, details: number, interests: number,
 *   aliases: number, learned: number, lore: number }}
 */
export function hiddenLater(base, cutoff) {
  const counts = zeroCounts();
  for (const profile of base.memory.listUserProfiles() ?? []) {
    const { hidden } = profileBefore(profile, cutoff);
    for (const kind of HIDDEN_KINDS) counts[kind] += hidden[kind];
  }
  counts.learned += guildBefore(base.memory.getGuild(), cutoff).hidden;
  counts.lore += loreBefore(base.memory.getLore(), cutoff).hidden;
  return counts;
}

// ---- the view and the turn -----------------------------------------------------

/**
 * A read-only view of the live calibrator: `ratio` and `apply` read the live
 * one at the moment of use (its ratio moves while the bot runs), `observe`
 * feeds nothing and returns the live ratio. Without a live calibrator, the
 * identity one (ratio 1).
 */
function readOnlyCalibrator(live) {
  if (!live) return IDENTITY_CALIBRATOR;
  return {
    get ratio() {
      return live.ratio;
    },
    apply: (n) => live.apply(n),
    observe: () => live.ratio,
  };
}

/**
 * A view over the live state of one guild: prompts and config are getters
 * that read `hot` at call time, memory accessors read the store at call time.
 * Nothing is copied. `calibrator` measures tokens the way a real turn does
 * (the live ratio, read at call time) and never feeds the live calibrator;
 * without a live `calibrator` it is the identity one (ratio 1).
 * `memory.getRecent` is the guild's recent store (src/memory/store.js#getRecent),
 * null for a store that keeps none. A view passed instead must offer the same
 * shape (a missing `calibrator` counts as the identity one, a missing
 * `memory.getRecent` as no recent store).
 * @param {{ hot: { prompts: object, config: object }, store: object, guildId: string,
 *   calibrator?: { ratio: number, apply: (n: number) => number } }} deps
 * @returns {{ readonly prompts: object, readonly config: object,
 *   calibrator: { readonly ratio: number, apply: (n: number) => number, observe: () => number }, memory: {
 *   getGuild: () => object, getUser: (id: string) => (object|null), listUserProfiles: () => object[],
 *   listChannels: () => object[], getLore: () => object[],
 *   getRecent: () => ({ nextId: number, lines: object[] }|null) } }}
 */
export function liveView({ hot, store, guildId, calibrator }) {
  return {
    get prompts() {
      return hot.prompts;
    },
    get config() {
      return hot.config;
    },
    calibrator: readOnlyCalibrator(calibrator),
    memory: {
      getGuild: () => store.getGuild(guildId),
      getUser: (id) => store.getUser(guildId, id),
      listUserProfiles: () => store.listUserProfiles(guildId),
      listChannels: () => store.listChannels(guildId),
      getLore: () => store.getLore(guildId),
      getRecent: () => (typeof store.getRecent === 'function' ? store.getRecent(guildId) : null),
    },
  };
}

/**
 * The history a moment is answered from: its normalized messages as they are.
 * Its trigger is the message its `triggerId` names (else the last message)
 * and its `triggerKind` the recorded `kind` when it is one a turn has
 * (`momentKind`), else the guess: 'reply' when the trigger replies to a
 * message of the persona in that history, else 'mention'. A spontaneous
 * moment (`mode` `interject` / `initiate`) has neither: trigger and kind are
 * null. Pure.
 * @param {{ history: object[], triggerId?: string|null, kind?: string|null, mode?: string|null }} moment
 * @returns {{ history: object[], trigger: object|null, triggerKind: string|null }}
 * @throws {Error} a missing or empty history, or a trigger by the persona.
 */
export function situationHistory(moment) {
  const history = moment?.history;
  if (!Array.isArray(history) || history.length === 0) throw new Error('moment: the history is empty');
  if (isSpontaneous(moment.mode)) return { history, trigger: null, triggerKind: null };
  const trigger = momentTrigger(moment);
  if (!trigger || trigger.self === true) throw new Error('moment: the trigger must not be by self');
  const target = trigger.replyToId ? history.find((message) => message?.id === trigger.replyToId) : null;
  return { history, trigger, triggerKind: momentKind(moment.kind) ?? (target?.self === true ? 'reply' : 'mention') };
}

/** The text of a message's content: a string as is, an array of parts as its text parts joined. */
function textOf(content) {
  if (Array.isArray(content)) {
    return content
      .filter((part) => part?.type === 'text')
      .map((part) => part.text)
      .join('\n');
  }
  return String(content ?? '');
}

/** How many samples to take: a positive integer, 1 when unusable. */
function sampleCount(samples) {
  const n = Math.floor(Number(samples));
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * `samples` completions of `messages`, one after another. Before each one
 * `signal` is checked; an aborted signal (also one that aborts mid-request)
 * stops the loop and `stopped` is true. Any other llm error is thrown.
 * `onUsage(usage, estimated)` follows every completion.
 */
async function sample({ llm, messages, options, samples, signal, onUsage, read }) {
  const answers = [];
  let stopped = false;
  for (let i = 0; i < sampleCount(samples); i += 1) {
    if (signal?.aborted) {
      stopped = true;
      break;
    }
    let completion;
    try {
      completion = await llm.complete(messages, options);
    } catch (err) {
      if (signal?.aborted) {
        stopped = true;
        break;
      }
      throw err;
    }
    if (typeof onUsage === 'function') onUsage(completion.usage ?? null, completion.estimated ?? 0);
    answers.push(read(completion.text));
  }
  return { answers, stopped };
}

/**
 * The recent lines a sandbox turn answered at `at` hands to buildRequest
 * (`recentLines`), read as a live turn reads them (src/behavior/turn.js): the
 * lines of the view's recent store still inside `memory.recentHours` at that
 * time -- an empty list when none is, so `<recent>` may still show the
 * members' moments of those hours. Null -- no block at all -- with
 * `features.recent` off (a missing key counts as on), for a view without a
 * recent store, and when the read fails: that is logged (`sandbox: recent
 * failed`) and never ends the turn, as a live turn goes on without the block.
 * @param {object} view
 * @param {number} at
 * @returns {object[]|null}
 */
function recentLinesOf(view, at) {
  const settings = recentSettings(view.config);
  if (!settings || typeof view.memory.getRecent !== 'function') return null;
  try {
    const stored = view.memory.getRecent();
    return stored ? liveRecent(stored.lines, { now: at, hours: settings.hours }) : null;
  } catch (err) {
    log.warn('sandbox: recent failed', { error: err });
    return null;
  }
}

/**
 * The input of src/behavior/prompt.js#buildRequest for one sandbox turn, every
 * key named: the turn the moment was (`situationHistory`: its trigger and
 * kind; its mode, `reply` when none or an unknown one is recorded), memory
 * through `view.memory` as in a real turn (`features.memory` off leaves it
 * out, the recent lines included: `recentLinesOf`), tokens measured with
 * `view.calibrator`, and the caller's lists and `<senses>` inputs. The inputs
 * left out on purpose are `SANDBOX_OMITS`, passed as absent. Never an
 * owner-forced turn. The view is read now and nothing is written.
 * @param {object} input  The inputs of `answerReply` that shape the request (see there).
 * @returns {object}
 */
export function sandboxRequestInput({
  view,
  situation,
  selfId,
  selfName,
  channel,
  at,
  descriptions,
  videos,
  customEmoji,
  gifs = null,
  mediaCache = null,
  elsewhereDestination = null,
  searchAvailable = false,
}) {
  const config = view.config;
  const memory = view.memory;
  const memoryOn = config.features?.memory !== false;
  const { history, trigger, triggerKind } = situationHistory(situation);
  // pickOtherProfiles reads a store-shaped object; this one reads the view.
  const viewAsStore = { getUser: (guildId, id) => memory.getUser(id) };
  return {
    config,
    prompts: view.prompts,
    calibrator: view.calibrator ?? IDENTITY_CALIBRATOR,
    mode: momentMode(situation?.mode) ?? 'reply',
    forced: false,
    now: at,
    selfName,
    history,
    trigger,
    triggerKind,
    // As a live turn reads it: an untagged reply takes the follow-up task.
    taggedCall: trigger ? isTaggedCall(trigger, selfId) : null,
    guildMemory: memoryOn ? memory.getGuild() : {},
    interlocutor: memoryOn && trigger ? memory.getUser(trigger.authorId) : null,
    otherProfiles: memoryOn ? pickOtherProfiles(viewAsStore, SANDBOX_GUILD, history, trigger?.authorId, config.context.otherProfiles) : [],
    candidateProfiles: memoryOn ? memory.listUserProfiles() : [],
    nameOf: memoryOn ? (id) => memory.getUser(id)?.names?.[0] ?? null : null,
    channels: memoryOn ? memory.listChannels() : [],
    loreEntries: memoryOn ? memory.getLore() : [],
    currentChannelId: channel.id,
    descriptions: descriptions instanceof Map ? descriptions : new Map(),
    videos: videos instanceof Map ? videos : new Map(),
    imageAnswers: null,
    searchAvailable: searchAvailable === true,
    customEmoji: Array.isArray(customEmoji) ? customEmoji : [],
    gifs,
    mediaCache,
    elsewhereDestination: typeof elsewhereDestination?.name === 'string' && elsewhereDestination.name ? { name: elsewhereDestination.name } : null,
    // `<recent>`: the last hours as the view holds them (no block without a recent store).
    recentLines: memoryOn ? recentLinesOf(view, at) : null,
    // SANDBOX_OMITS, as buildRequest reads them absent.
    neighbors: [],
    neighborDescriptions: null,
    pulled: [],
    source: null,
    readOnlyIds: null,
    privateChat: null,
    privateProfile: null,
    reads: null,
    lookup: null,
    recallAvailable: null,
    drawQuota: null,
    drawReason: null,
    focus: null,
    tasks: null,
    recentAudience: null,
    participation: null,
    diaryChannel: null,
    diary: null,
  };
}

/**
 * The reply sandbox: the request a real turn would send for the moment
 * (buildRequest over `sandboxRequestInput`: its mode and trigger kind when
 * recorded; memory through `view.memory`, tokens measured with
 * `view.calibrator`, so the caps trim what a real turn trims), `samples`
 * completions, each parsed with parseOutput and trimmed by
 * `features.reactions` / `features.multiMessage` like a real turn. The
 * server's custom emoji (`<emoji>`) and GIF library (`<gifs>`, the
 * transcript's GIF handles) render as in a real turn when the caller hands in
 * the same sources the turn uses (`customEmoji`, `gifs`, `mediaCache`;
 * buildRequest applies `features.customEmoji` / `features.gifs`); so do
 * `<senses>`' line on where a call from a read-only channel is answered
 * (`elsewhereDestination`) and its search line (`searchAvailable`). `<recent>`
 * shows the view's recent lines of this channel inside `memory.recentHours`
 * at `at` and the members' moments of those hours (`recentLinesOf`; a
 * `momentView` holds the lines added before the moment). Left out, unlike a
 * real turn: every input of `SANDBOX_OMITS` (neighbours, other channels, the
 * web lookup, the server search, a drawing offer, a room question, the recent
 * lines of other channels, a private chat), pictures (a user message with
 * image parts is sent as its text-only re-render), an owner-forced turn's
 * text, the daily GIF cap, and a custom-emoji reaction is kept as written
 * (not resolved through the emoji index); nothing is sent to Discord and
 * nothing is stored. Media render with their labels only, unless the caller
 * hands in what the persona saw of them (`descriptions` / `videos`, see
 * `replayMedia`): nothing is described or watched here. Every completion
 * passes `role: 'voice'`, `purpose: 'reply'` (`REPLY_REQUEST`), `origin:
 * 'replay'`, `countAgainstDailyCap: false` and `skipCalibration: true`; the
 * per-request token cap stays in force. With `samples` > 1 and a request the
 * llm client caches (src/llm/openrouter.js#cacheTtlFor: `features.promptCache`,
 * role `voice`, the model), the user message is one text part carrying a
 * cache marker, so samples 2..N read the cache instead of paying for it again.
 * An answer's `gif` (a handle of the library, `features.gifs` on) and `draw`
 * (`features.imageGeneration` on) count as actions, as in a real turn; an
 * unknown handle or a switched-off kind is dropped (null). `skip` is true
 * when the model skipped or left nothing to do (as a real turn treats it).
 * @param {object} input
 * @param {object} input.view        From `liveView` (or a view of the same shape, e.g. `momentView`).
 * @param {{ history: object[], triggerId?: string|null, kind?: string|null, mode?: string|null }} input.situation
 *   The moment (see `situationHistory`).
 * @param {string} input.selfId
 * @param {string} input.selfName
 * @param {{ id: string, name?: string, category?: string, topic?: string }} input.channel
 * @param {{ complete: Function }} input.llm
 * @param {number} input.samples
 * @param {number} input.at          The moment the turn is answered at (ms).
 * @param {AbortSignal} [input.signal]
 * @param {(usage: object|null, estimated: number) => void} [input.onUsage]  Called after every completion.
 * @param {Map<string, string>} [input.descriptions]  Item id -> caption, rendered as the live transcript does.
 * @param {Map<string, object>} [input.videos]  Item id -> video state (`{ state: 'watched', text }`), likewise.
 * @param {{ id: string, name: string, animated?: boolean }[]} [input.customEmoji]  The served guild's
 *   custom emoji (src/discord/emoji.js#createEmojiIndex `list()`); omitted, no `<emoji>`.
 * @param {object|null} [input.gifs]  The guild's GIF library (store.getGifs); omitted, no `<gifs>` and no `<gif>` kept.
 * @param {object|null} [input.mediaCache]  The describer cache (store.getMediaCache), read only, for both lists' captions.
 * @param {{ name: string }|null} [input.elsewhereDestination]  Where a call from a read-only channel is
 *   answered, as a live turn resolves it (src/behavior/turn.js#usableDestination); omitted, no such line.
 * @param {boolean} [input.searchAvailable]  Whether a web search key is configured (the lookup's
 *   `hasSearch()`); only `true` adds the search line (with `features.webLookup` on). No search is run.
 * @returns {Promise<{ request: { system: string, user: string },
 *   answers: { messages: { text: string, replyTo: number|null }[], reactions: { to: number, emoji: string }[],
 *     gif: { id: string, replyTo: number|null }|null, draw: { text: string, self: boolean, replyTo: number|null }|null,
 *     skip: boolean, think: string }[], stopped: boolean }>}
 */
export async function answerReply({
  view,
  situation,
  selfId,
  selfName,
  channel,
  llm,
  samples,
  at,
  signal,
  onUsage,
  descriptions,
  videos,
  customEmoji,
  gifs = null,
  mediaCache = null,
  elsewhereDestination = null,
  searchAvailable = false,
}) {
  const config = view.config;
  const request = buildRequest(
    sandboxRequestInput({ view, situation, selfId, selfName, channel, at, descriptions, videos, customEmoji, gifs, mediaCache, elsewhereDestination, searchAvailable }),
  );

  // No pictures: the whole user text as one string (the text-only re-render when any was attached).
  const [systemMessage, userMessage] = request.messages;
  const userText = userTextOf(request.textFallback ?? userMessage.content);
  // Samples 2..N repeat sample 1 exactly: the user part carries a cache breakpoint when the client caches the request.
  const cached = sampleCount(samples) > 1 && cacheTtlFor(config, REPLY_REQUEST.role, config.llm?.model) !== null;
  const userContent = cached ? [{ type: 'text', text: userText, cache_control: { ...USER_CACHE_MARKER } }] : userText;
  const messages = [systemMessage, { ...userMessage, content: userContent }];

  const { answers, stopped } = await sample({
    llm,
    messages,
    options: { ...REPLY_REQUEST, origin: 'replay', countAgainstDailyCap: false, skipCalibration: true, signal },
    samples,
    signal,
    onUsage,
    read: (text) => {
      const parsed = parseOutput(text, { maxDrawChars: view.config.image?.maxPromptChars });
      const features = view.config.features ?? {};
      const reactions = features.reactions === false ? [] : parsed.reactions;
      const replies = features.multiMessage === false ? parsed.messages.slice(0, 1) : parsed.messages;
      // As src/behavior/turn.js: a GIF off the library or with the switch off, a drawing with drawing off, is dropped.
      const gif = parsed.gif && features.gifs !== false && findGif(gifs, parsed.gif.id) ? parsed.gif : null;
      const draw = features.imageGeneration === false ? null : parsed.draw;
      const nothingToDo = replies.length === 0 && reactions.length === 0 && gif === null && draw === null;
      return { messages: replies, reactions, gif, draw, skip: parsed.skip || nothingToDo, think: parsed.think };
    },
  });

  return { request: { system: textOf(systemMessage.content), user: textOf(userContent) }, answers, stopped };
}
