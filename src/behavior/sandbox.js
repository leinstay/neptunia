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
//
// A skill scenario (tools/replay.mjs `--skills`, `answerSkillScenario`) is the
// one sandbox turn that shows the persona her skills: the `<skills>` block of
// the requester's catalogue (`scenarioInventory`, the live listing over a copy
// of the config carrying the scenario's grants, `personaGrantsConfig`). Her
// `<call>` passes the real resolution and the real gateway (`simulateCall`);
// the operation itself never runs -- a canned result stands in for it -- and
// the follow-up pass a live turn would make is made with that result. A
// multi-step scenario carries each turn into the next step's channel
// (`afterScenarioTurn`: her lines, her reactions, a post the call left here,
// every call's mark), so the next request reads what she said and did. A step
// whose messages come in a burst is played as the live queue plays it
// (`burstTurns`: each call its own turn in arrival order, the waiting ones
// named under the task labels, one follow-up slot per channel). A line of hers
// the scenario seeds is shaped as her live lines (`seededSelfLine`) without a
// turn run for it.

import { buildRequest, continuesTurn, skillResultBlock, userText as userTextOf, withSkillResult } from './prompt.js';
import { detectTrigger, isTaggedCall } from './mention.js';
import { addPending, followUpSlot, popOldest } from './pending.js';
import { snowflakeAt } from './recall.js';
import { resolveHandles } from './handles.js';
import { linkChannels } from '../memory/mentions.js';
import { continuationHistory, firstPass, pickOtherProfiles, taskInput } from './turn.js';
import { withCalls } from '../format.js';
import { grant as accessGrant, revoke as accessRevoke } from '../discord/access.js';
import { collectEmojiItems, collectPictures, collectVideos, isDescribable, watchedLengths } from '../media/classify.js';
import { REPLY_REQUEST, cacheTtlFor } from '../llm/openrouter.js';
import { roleModel } from '../llm/roles.js';
import { parseOutput } from '../llm/parse.js';
import { log } from '../log.js';
import { clampChars, oneLine } from '../memory/clamp.js';
import { findGif } from '../memory/index.js';
import { tokenIds } from '../memory/mentions.js';
import { liveRecent, recentSettings } from '../memory/recent.js';
import { checkSkill, listSkills } from '../skills/gateway.js';
import { discoveryOn, proposalVerdicts, proposedRows } from '../skills/discovery.js';
import { QUIET_ON_OK, needsFollowUp, outcomeDetail, refusalStatus, resolveCall } from '../skills/executors.js';
import { isPlainObject } from '../config.js';
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
  tasks: 'no part of a split message, no queued or folded call: a replay knows none (a skill scenario\'s burst hands in its waiting calls: `queued`)',
  recentAudience: 'no guild to compare audiences in: <recent> shows the lines of the turn\'s own channel only',
  participation: 'no guild to compare audiences in: no <participation> block of the persona\'s exchanges elsewhere',
  diaryChannel: 'no diary is offered: a sandbox turn never posts, so <senses> has no diary line',
  diary: 'never a diary post: no <world>, <diary>, <plan> or <found> block',
  offPeriods: 'a replay has no journal of downtime: <now> shows the time only',
  skillsInventory: 'no skills inventory: a replay runs no search classifier, so no <skills> block (a skill scenario hands one in: SKILL_SCENARIO_OMITS)',
  around: 'a replay has no live gateway: no voice channels or statuses, so <people_now> has no live fields (its fields from memory stay)',
  skillsGranted: 'no skill registry: no <skills_granted> block of her granted skills (a skill scenario hands them in: SKILL_SCENARIO_OMITS)',
  errands: 'no task store: a replay knows no errands of hers, so no <tasks> or <task_result> block',
});

/** The inputs a skill scenario hands in: the skills inventory and the names of her granted skills. */
const SKILL_SCENARIO_INPUTS = new Set(['skillsInventory', 'skillsGranted']);

/**
 * What a skill scenario's turn (`answerSkillScenario`) leaves out: SANDBOX_OMITS but the skills
 * inventory and her granted skills, which it hands in (`scenarioInventory`, `skillsGranted`) so
 * the persona sees her `<skills>` and `<skills_granted>` as live.
 * @type {Readonly<Record<string, string>>}
 */
export const SKILL_SCENARIO_OMITS = Object.freeze(Object.fromEntries(Object.entries(SANDBOX_OMITS).filter(([key]) => !SKILL_SCENARIO_INPUTS.has(key))));

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
 * them: pictures (src/media/classify.js#collectPictures and
 * #collectEmojiItems, describable ones) and videos (#collectVideos over `sites`).
 */
function mediaItemsOf(message, sites) {
  const pictures = [...collectPictures(message), ...collectEmojiItems(message)].filter(isDescribable).map((item) => item.itemId);
  const videos = collectVideos(message, { videoSites: Array.isArray(sites) ? sites : [] }).map((item) => item.itemId);
  return { pictures: [...new Set(pictures)], videos: [...new Set(videos)] };
}

/**
 * The caption and video maps a replayed moment's transcript is rendered
 * with (src/format.js#formatTranscript's `descriptions` and
 * `videos`, the same the live turn passes): for every media item of the
 * history, the describer's `cache` entry as it stood by `before` (null: any
 * time), read only. A cached miss, a limit or error state and an entry written
 * after `before` are no description; a watched summary is the video state
 * `{ state: 'watched', text }` plus the entry's `watchedSeconds` / `totalSeconds` when stored. Without a cache, empty maps. Pure.
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
      const entry = entryOf(cache, `video:${id}`);
      const text = seenText(entry, { watched: true, before });
      // The watched lengths too, so a part-watched video renders as in the live turn.
      if (text !== null && !videos.has(id)) videos.set(id, { state: 'watched', text, ...watchedLengths(entry) });
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
 * The channels a sandbox request's `<channel_directory>` lists: `given` when it is a list (the
 * guild's readable text channels, as a live turn reads them), else the view's stored channel map
 * (`{ id, name, category }`; none with `features.memory` off) with the turn's `channel` when it has
 * a name. Pure but for the view's read.
 * @returns {{ id: string, name: string, category?: string|null }[]}
 */
function sandboxChannels(given, view, channel) {
  if (Array.isArray(given)) return given;
  const memoryOn = view.config.features?.memory !== false;
  const stored = memoryOn && typeof view.memory?.listChannels === 'function' ? (view.memory.listChannels() ?? []) : [];
  const list = stored.filter((entry) => entry && entry.id !== undefined && entry.id !== null).map((entry) => ({ id: String(entry.id), name: entry.name, category: entry.category ?? null }));
  if (channel && typeof channel.name === 'string' && channel.name && !list.some((entry) => entry.id === String(channel.id))) list.push({ id: String(channel.id), name: channel.name, category: null });
  return list;
}

/**
 * The input of src/behavior/prompt.js#buildRequest for one sandbox turn, every
 * key named: the turn the moment was (`situationHistory`: its trigger and
 * kind; its mode, `reply` when none or an unknown one is recorded), memory
 * through `view.memory` as in a real turn (`features.memory` off leaves it
 * out, the recent lines included: `recentLinesOf`), tokens measured with
 * `view.calibrator`, and the caller's lists and `<senses>` inputs. The inputs
 * left out on purpose are `SANDBOX_OMITS`, passed as absent -- but the
 * skills inventory and her granted skills when a skill scenario hands them in
 * (`skillsInventory`, a non-empty list of catalogue rows; `skillsGranted`, a
 * non-empty list of skill names: SKILL_SCENARIO_OMITS). `continuation` is
 * null but on a skill scenario's continued turn (`{ skill }`, scenarioContinuation). `tasks` is
 * absent but when a skill scenario's burst hands in the calls still waiting after this one
 * (`queued`, `{ id, text, author? }` each, burstTurns's): then the task labels name them as a
 * live turn names its queued calls (src/behavior/turn.js#taskInput: the trigger author's own
 * under `labels.task.queued`, another member's under `labels.task.queuedOthers`). Never an
 * owner-forced turn. `<channel_directory>` lists `channelDirectory` (the guild's readable text
 * channels, src/discord/collect.js#channelDirectoryOf, as a live turn passes them) when given, else
 * the view's stored channel map with the turn's channel (sandboxChannels). The view is read now
 * and nothing is written.
 * @param {object} input  The inputs of `answerReply` that shape the request (see there), and
 *   `skillsInventory`, `skillsGranted`, `continuation` and `queued` (`answerSkillScenario`'s).
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
  skillsInventory = null,
  skillsGranted = null,
  continuation = null,
  queued = null,
  channelDirectory = null,
}) {
  const config = view.config;
  const memory = view.memory;
  // A burst's calls still waiting, named as a live turn names its queued calls; absent otherwise.
  const waiting = Array.isArray(queued) && queued.length > 0 ? queued : null;
  const tasks = waiting ? taskInput({ part: null, queued: () => waiting, added: null, labels: view.prompts?.labels, channelId: channel.id }).input : null;
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
    // As a live turn: her own profile is never listed in `<directory>`.
    selfId: selfId ?? null,
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
    // As a live turn: every text channel with its handle (sandboxChannels).
    channelDirectory: sandboxChannels(channelDirectory, view, channel),
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
    // Absent but on a burst's turn with calls still waiting (`queued`).
    tasks,
    recentAudience: null,
    participation: null,
    diaryChannel: null,
    diary: null,
    offPeriods: null,
    around: null,
    // Absent but in a skill scenario: the catalogue rows it hands in.
    skillsInventory: Array.isArray(skillsInventory) && skillsInventory.length > 0 ? skillsInventory : null,
    // Absent but in a skill scenario: the names of her granted skills it hands in.
    skillsGranted: Array.isArray(skillsGranted) && skillsGranted.length > 0 ? skillsGranted : null,
    // A skill scenario's turn continued after her call (answerSkillScenario); null otherwise.
    continuation: continuation && typeof continuation.skill === 'string' ? { skill: continuation.skill } : null,
    // Absent: a replay has no task store, so no errands of hers (SANDBOX_OMITS).
    errands: null,
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
 *   answers: { messages: { text: string, replyTo: number|null, mentions?: string[], unknownHandles?: number }[], reactions: { to: number, emoji: string }[],
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
  channelDirectory = null,
}) {
  const { request, messages, systemMessage, userContent } = sandboxMessages(
    { view, situation, selfId, selfName, channel, at, descriptions, videos, customEmoji, gifs, mediaCache, elsewhereDestination, searchAvailable, channelDirectory },
    samples,
  );

  const { answers, stopped } = await sample({
    llm,
    messages,
    options: sandboxOptions(signal),
    samples,
    signal,
    onUsage,
    read: (text) => shapeAnswer(parseOutput(text, { maxDrawChars: view.config.image?.maxPromptChars }), view.config, gifs, request.handles),
  });

  return { request: { system: textOf(systemMessage.content), user: textOf(userContent) }, answers, stopped };
}

/** The llm options of every sandbox completion: the reply's role and purpose, as the replay's own, off the rails' counters. */
function sandboxOptions(signal) {
  return { ...REPLY_REQUEST, origin: 'replay', countAgainstDailyCap: false, skipCalibration: true, signal };
}

/**
 * The request of a sandbox turn (buildRequest over sandboxRequestInput's `input`) and the
 * messages sent for it: the user part as one text (the text-only re-render when a picture was
 * attached), carrying a cache breakpoint when `samples` > 1 and the client caches the request
 * (samples 2..N repeat sample 1 exactly). `userText` is that text without the marker.
 */
function sandboxMessages(input, samples) {
  const config = input.view.config;
  const request = buildRequest(sandboxRequestInput(input));
  const [systemMessage, userMessage] = request.messages;
  const userText = userTextOf(request.textFallback ?? userMessage.content);
  const cached = sampleCount(samples) > 1 && cacheTtlFor(config, REPLY_REQUEST.role, roleModel(config, REPLY_REQUEST.role, REPLY_REQUEST.purpose)) !== null;
  const userContent = cached ? [{ type: 'text', text: userText, cache_control: { ...USER_CACHE_MARKER } }] : userText;
  return { request, systemMessage, userMessage, userText, userContent, messages: [systemMessage, { ...userMessage, content: userContent }] };
}

/**
 * One parsed answer (parseOutput's) shaped like a real turn's under `config`: reactions with
 * `features.reactions` on, one message with `features.multiMessage` off, a GIF only from the
 * library with `features.gifs` on, a drawing only with `features.imageGeneration` on; `skip`
 * when the model skipped or left nothing to do. With the request's `handles`
 * (features.mentionHandles on) a message whose text holds a handle-shaped token also carries
 * what a live turn would mention (handleMentions); its `text` stays as she wrote it.
 */
function shapeAnswer(parsed, config, gifs, handles = null) {
  const features = config.features ?? {};
  const reactions = features.reactions === false ? [] : parsed.reactions;
  const kept = features.multiMessage === false ? parsed.messages.slice(0, 1) : parsed.messages;
  const replies = kept.map((message) => ({ ...message, ...handleMentions(message.text, handles) }));
  // As src/behavior/turn.js: a GIF off the library or with the switch off, a drawing with drawing off, is dropped.
  const gif = parsed.gif && features.gifs !== false && findGif(gifs, parsed.gif.id) ? parsed.gif : null;
  const draw = features.imageGeneration === false ? null : parsed.draw;
  const nothingToDo = replies.length === 0 && reactions.length === 0 && gif === null && draw === null;
  return { messages: replies, reactions, gif, draw, skip: parsed.skip || nothingToDo, think: parsed.think };
}

/**
 * What a live turn would mention in `text` (src/behavior/turn.js#renderPost over
 * src/behavior/handles.js#resolveHandles with the request's `handles`): `mentions`, the member
 * ids an exact `@handle` resolves to (the only ones a send would notify), and `unknownHandles`,
 * the handle-shaped tokens the request does not hold (left as text). {} when there are no
 * handles (features.mentionHandles off) or the text holds no handle-shaped token, so an answer
 * without one keeps its shape. Pure.
 * @param {string} text
 * @param {Map<string, string>|null} handles
 * @returns {{ mentions?: string[], unknownHandles?: number }}
 */
export function handleMentions(text, handles) {
  if (!(handles instanceof Map)) return {};
  const { userIds, unknown } = resolveHandles(text, handles);
  return userIds.length > 0 || unknown > 0 ? { mentions: userIds, unknownHandles: unknown } : {};
}

/** The operations whose `text` argument is a message she posts (src/ops/message.js). */
const MESSAGE_TEXT_SKILLS = Object.freeze(['message.create', 'message.edit']);

/**
 * The text a `<call>` (src/llm/parse.js's) would post: its body, else -- for a message.create or
 * message.edit -- its `text` attribute (the command takes the body as `text`,
 * src/skills/executors.js#resolveCall); '' for none. Pure.
 */
function callTextOf(call) {
  const body = typeof call?.body === 'string' ? call.body : '';
  if (body) return body;
  const text = call?.args?.text;
  return MESSAGE_TEXT_SKILLS.includes(call?.skill) && typeof text === 'string' ? text : '';
}

// ---- skill scenarios -----------------------------------------------------------

/** The persona as the principal of a call (src/skills/gateway.js), as a live turn names her. */
const PERSONA = Object.freeze({ kind: 'persona' });

/** The result a skill's `<result>` block is cut to when `skills.resultMaxChars` is not set (config.json's value). */
const RESULT_MAX_CHARS = 4500;

/**
 * A copy of `config` whose persona grants are exactly `names`: her user id (`selfId`) taken
 * off every `bot.access` entry, then granted on each name -- with the very grant and revoke
 * `/nep access` stores (src/discord/access.js). People's grants are kept. The names are used as
 * given (the caller expands `*` and groups, as `/nep access grant` does); a name no grant opens
 * for her (src/skills/access.js#NOT_GRANTABLE_TO_PERSONA) is stored too, so the gateway's own
 * refusal of it shows. `config` is never changed. Pure.
 * @param {object} config  The live merged config.
 * @param {string} selfId  The bot's own user id.
 * @param {string[]} names  Skill names.
 * @returns {object}
 */
export function personaGrantsConfig(config, selfId, names) {
  const copy = structuredClone(isPlainObject(config) ? config : {});
  copy.bot = isPlainObject(copy.bot) ? copy.bot : {};
  let access = isPlainObject(copy.bot.access) ? copy.bot.access : {};
  for (const key of Object.keys(access)) access = accessRevoke(access, key, { userId: selfId });
  for (const name of new Set(Array.isArray(names) ? names : [])) access = accessGrant(access, name, { userId: selfId });
  copy.bot.access = access;
  return copy;
}

/**
 * The `<skills>` rows of a skill scenario, built as a live turn's skills discovery builds them
 * (src/behavior/turn.js#discoverSkills) for `requester` in `conversationId`: the catalogue
 * (src/skills/gateway.js#listSkills over `config`, `selfId`, the skills layer `texts`) whole
 * when the search classifier would have answered `skills: inventory` (`discovery`
 * `'inventory'`), the rows of the skills it would have named (`discovery` a list of names:
 * proposalVerdicts, proposedRows), none for `'none'`. Null with discovery off
 * (`features.skills` / `features.skillsDiscovery`) or nothing to show. Pure.
 * @param {{ config: object, selfId: string, texts?: object, requester: object|null, conversationId: string,
 *   registry: Map<string, object>, discovery?: 'inventory'|'none'|string[], getOp?: Function }} input
 * @returns {object[]|null}
 */
export function scenarioInventory({ config, selfId, texts, requester, conversationId, registry, discovery = 'inventory', getOp }) {
  if (!discoveryOn(config) || discovery === 'none') return null;
  const rows = listSkills({ config, selfId, texts, requester, audience: { conversationId: String(conversationId) }, registry, ...(getOp ? { getOp } : {}) });
  if (discovery === 'inventory') return rows.length > 0 ? rows : null;
  return proposedRows(proposalVerdicts(Array.isArray(discovery) ? discovery : [], rows), rows);
}

/**
 * One `<call>` of the persona (`call`, src/llm/parse.js's) taken through what a live turn does
 * before the operation runs (src/behavior/turn.js#planCall and #runCall): resolved on the
 * server's side over `view` (src/skills/executors.js#resolveCall; src/behavior/turn.js#callViewOf),
 * checked by the gateway (src/skills/gateway.js#checkSkill: the persona as principal, `requester`,
 * `conversationId` as the audience, `config` with her grants, `selfId`, the registry of `view`,
 * no mixed requesters, no earlier destructive run, `now`, the image quota of `images`), then
 * mapped by its command (`command.toCall` must reach this very operation). The operation never
 * runs: a call that passed is recorded (`executed`: the skill and its resolved arguments) and
 * answered with a canned `ok` whose text is `resultText`. `verdict` says where it stopped
 * (`stage`: `resolve`, `gateway` or `command`; `ok`, `code`, `reason`). `followUp` is whether a
 * live turn would ask her again with that result: a refusal as
 * src/skills/executors.js#needsFollowUp says, an `ok` unless the operation is one whose success
 * is its own answer (QUIET_ON_OK: a live operation of any other kind answers with text). Never
 * throws; pure but for the gateway's reads of `images`.
 * @param {{ call: { skill: string, args: object, body: string }, view: object, config: object, selfId: string,
 *   requester: { id: string, roleIds: string[] }|null, conversationId: string, now: number, images?: object,
 *   getOp?: Function, resultText?: string }} input
 * @returns {{ verdict: { stage: string, ok: boolean, code?: string, reason?: string },
 *   executed: { skill: string, args: object }|null, result: { skill: string, status: string, code?: string, data?: { text: string } },
 *   followUp: boolean }}
 */
export function simulateCall({ call, view, config, selfId, requester, conversationId, now, images = null, getOp, resultText = '' }) {
  const skill = String(call?.skill ?? '');
  const refused = (stage, code, reason) => {
    // The machine reason rides along, as a live call keeps it for its mark (outcomeDetail).
    const result = { skill, status: refusalStatus(code), code, ...(reason ? { reason } : {}) };
    return { verdict: { stage, ok: false, code, reason: reason ?? '' }, executed: null, result, followUp: needsFollowUp(skill, result) };
  };
  const resolved = resolveCall(call, view);
  if (!resolved.ok) return refused('resolve', resolved.code, resolved.reason);
  const verdict = checkSkill({
    skill: resolved.skill,
    args: resolved.args,
    principal: PERSONA,
    requester,
    audience: { conversationId: String(conversationId) },
    context: {
      config,
      selfId,
      registry: view.skills,
      mixedRequesters: false,
      lastRunAt: null,
      now,
      ...(images ? { images } : {}),
      ...(getOp ? { getOp } : {}),
    },
  });
  if (!verdict.ok) return refused('gateway', verdict.code, verdict.reason);
  let mapped = null;
  try {
    mapped = resolved.command.toCall({ ...resolved.args });
  } catch {
    mapped = null;
  }
  if (!mapped?.args || mapped.op !== resolved.skill) {
    const result = { skill, status: 'invalid', code: 'invalid-args', reason: 'command' };
    return { verdict: { stage: 'command', ok: false, code: 'invalid-args', reason: 'command' }, executed: null, result, followUp: needsFollowUp(skill, result) };
  }
  const text = typeof resultText === 'string' ? resultText : '';
  return {
    verdict: { stage: 'gateway', ok: true },
    executed: { skill: resolved.skill, args: { ...resolved.args } },
    result: { skill, status: 'ok', data: { text } },
    followUp: !QUIET_ON_OK.includes(skill),
  };
}

/**
 * The request a skill scenario sends first (buildRequest over sandboxRequestInput with
 * `skillsInventory`), never sent: its two texts, the token estimate the budget measured
 * (`tokens`, `limit`) and the transcript numbers (`idByIndex`). For `--dry`.
 * @param {object} input  `answerSkillScenario`'s request inputs.
 * @returns {{ system: string, user: string, tokens: number|null, limit: number|null, idByIndex: Map<number, string> }}
 */
export function skillScenarioRequest(input) {
  const { request, systemMessage, userText } = sandboxMessages(input, 1);
  return {
    system: textOf(systemMessage.content),
    user: userText,
    tokens: Number.isFinite(request.stats?.used) ? request.stats.used : null,
    limit: Number.isFinite(request.stats?.limit) ? request.stats.limit : null,
    idByIndex: request.idByIndex,
  };
}

/** How far apart a scenario's continuation places her posts, the call and its request (ms). */
const CONTINUATION_STEP_MS = 1000;

/** The operation's own message on a call mark when `skills.markTextMaxChars` is not set (config.json's value). */
const MARK_TEXT_MAX_CHARS = 200;

/** The id scenarioContinuation gives her `index`-th (0-based) first-pass message. */
function continuationLineId(index) {
  return `continuation-${index + 1}`;
}

/**
 * The follow-up of a skill scenario's run as a live turn continues it
 * (src/behavior/turn.js#continuationRequest): the moment's `history`, then her messages of the
 * first pass (`answer`) as her lines a second apart after `at` (ids `continuation-<n>`), the
 * call's mark on the last of them, else as a line of its own (withCalls: the outcome's status
 * and, when it did not work, why -- outcomeDetail --, its target from the resolved arguments, a
 * channel named from the view's channel map), the request rebuilt a second after the call with
 * the continue task (sandboxMessages with `continuation`; the moment's trigger kept), and an `ok`
 * outcome's data in a `<result>` block before `<task>` (skillResultBlock cut to `maxChars`,
 * withSkillResult). The earlier calls of a multi-step scenario (`callMarks`) keep their marks.
 * No cache marker. Reads the view only. Returns the messages and the transcript numbers of the
 * rebuilt request (`idByIndex`: what the follow-up's `reply="#n"` points at).
 */
function scenarioContinuation({ requestArgs, history, answer, outcome, labels, maxChars, callMarks = [] }) {
  const { view, situation, channel, selfId, selfName, at } = requestArgs;
  const channelId = String(channel.id);
  const own = answer.messages.map((message, i) => ({ id: continuationLineId(i), channelId, ts: at + (i + 1) * CONTINUATION_STEP_MS, authorId: String(selfId), content: message.text }));
  const callAt = at + (own.length + 1) * CONTINUATION_STEP_MS;
  const result = outcome.result;
  const mark = callMarkOf({ outcome, channelId, at: callAt, postedId: null, posted: own.map((line) => line.id), config: view.config });
  const lines = withCalls(continuationHistory({ history, own, selfName }), { calls: [...callMarks, mark] }, { nameOf: channelNamesOf(view, channel) });
  const { trigger } = situationHistory(situation);
  const moment = { ...situation, history: lines, ...(trigger ? { triggerId: trigger.id } : {}) };
  const built = sandboxMessages({ ...requestArgs, situation: moment, at: callAt + CONTINUATION_STEP_MS, continuation: { skill: result.skill } }, 1);
  const block = result.status === 'ok' && result.data ? skillResultBlock(result, labels, { maxChars }) : '';
  return { messages: withSkillResult([built.systemMessage, { ...built.userMessage, content: built.userText }], block), idByIndex: built.request.idByIndex };
}

/**
 * The mark one call of hers leaves on the transcript, in src/format.js#withCalls's shape
 * and as a live turn notes it (src/behavior/turn.js, `noteCall`): `outcome` (simulateCall's) made
 * in the turn of `channelId`, its result back at `at`; its status and, when it did not work, why
 * (outcomeDetail, `skills.markTextMaxChars` read from `config`); its target from the resolved
 * arguments; `postedId` the message the call itself posted, `posted` every message the turn
 * posted. Pure.
 */
function callMarkOf({ outcome, channelId, at, postedId, posted, config }) {
  const result = outcome.result;
  const args = outcome.executed?.args ?? {};
  const idOf = (value) => (typeof value === 'string' && value ? value : null);
  return {
    channelId,
    at,
    skill: result.skill,
    status: result.status,
    detail: outcomeDetail(result, { textChars: config.skills?.markTextMaxChars ?? MARK_TEXT_MAX_CHARS }),
    target: { messageId: idOf(args.message) ?? idOf(args.reply), channelId: idOf(args.channel) },
    postedId: postedId ?? null,
    posted,
  };
}

/** A channel's name by id for a call mark: the view's channel map, the turn's `channel` by its own name. */
function channelNamesOf(view, channel) {
  const memoryOn = view.config.features?.memory !== false;
  const stored = memoryOn && typeof view.memory?.listChannels === 'function' ? (view.memory.listChannels() ?? []) : [];
  const names = new Map(stored.filter((entry) => entry && typeof entry.name === 'string').map((entry) => [String(entry.id), entry.name]));
  if (typeof channel.name === 'string' && channel.name) names.set(String(channel.id), channel.name);
  return (id) => names.get(id) ?? null;
}

/**
 * A skill scenario: the moment's request with the persona's skills shown (`skillsInventory`,
 * scenarioInventory's rows; else as answerReply), answered `runs` times one after another. Each
 * answer is parsed with parseOutput and shaped as a real turn's; a well-formed `<call>` goes to
 * `onCall(call, { idByIndex, history, channelHandles })` (the caller's simulateCall; the request's channel handles) -- a malformed one is only
 * reported, as a live turn runs none -- and when its outcome says a live turn would ask her
 * again (`followUp`), the follow-up request is sent as a live turn sends it, with no cache
 * marker: under src/behavior/prompt.js#continuesTurn (the view's config: the scenario's, so
 * `features.followUpContinuation` decides) the turn continued (scenarioContinuation); otherwise
 * the same messages with the `<result>` block before `<task>` (src/behavior/prompt.js#skillResultBlock
 * over the outcome's `result`, led by what the first pass posted, src/behavior/turn.js#firstPass;
 * `skills.resultMaxChars` read now; withSkillResult). The run's `followUp.continuation` says
 * which. Its answer is shaped likewise, a `<call>` in it
 * ignored (`extraCall`). A failed follow-up is reported by its error name, never thrown; a
 * failed first pass throws (as answerReply). An aborted `signal` stops the runs (`stopped`).
 * Every completion goes out as answerReply's do (`origin: 'replay'`, off the daily cap and the
 * calibration). Nothing is sent to Discord and nothing is stored.
 * A step of a multi-step scenario hands in the calls of its earlier steps (`callMarks`,
 * withCalls's shape, afterScenarioTurn's): with features.callMarkers on (a missing key counts as
 * on) her lines carry their marks in both requests, as a live turn's history does. A turn of a
 * burst hands in the calls still waiting after it (`queued`, burstTurns's; sandboxRequestInput),
 * named in both requests as a live turn names them. A call's text -- its body, or the `text`
 * attribute of a message.create / message.edit -- carries what it would mention
 * (`callMentions`, handleMentions over the request's handles). Each run keeps
 * what afterScenarioTurn needs to carry the turn on (`refs`: the transcript numbers and mention
 * handles of the request each pass answered).
 * @param {object} input  answerReply's inputs (`samples` is `runs`), `skillsInventory`, `skillsGranted`
 *   (the names of the skills her scenario grants, src/skills/discovery.js#grantedSkillNames), `onCall`,
 *   `callMarks` and `queued`.
 * @returns {Promise<{ request: { system: string, user: string, tokens: number|null, limit: number|null },
 *   runs: { answer: object, call: object|null, callError: string|null, extraCalls: number, usage: object|null,
 *     callMentions?: { mentions: string[], unknownHandles: number },
 *     outcome: object|null, followUp: { answer?: object, extraCall?: boolean, usage?: object|null, continuation?: boolean, error?: string }|null,
 *     refs: { idByIndex: Map<number, string>, handles: Map<string, string>|null, followUpIdByIndex: Map<number, string>|null } }[],
 *   stopped: boolean }>}
 */
export async function answerSkillScenario({
  view,
  situation,
  selfId,
  selfName,
  channel,
  llm,
  runs,
  at,
  signal,
  descriptions,
  videos,
  customEmoji,
  gifs = null,
  mediaCache = null,
  elsewhereDestination = null,
  searchAvailable = false,
  skillsInventory = null,
  skillsGranted = null,
  onCall,
  callMarks = null,
  queued = null,
  channelDirectory = null,
}) {
  // The earlier steps' calls on her lines, as a live turn's history carries them (linkCalls).
  const earlier = Array.isArray(callMarks) && view.config.features?.callMarkers !== false ? callMarks : [];
  const moment = earlier.length > 0 ? { ...situation, history: withCalls(situationHistory(situation).history, { calls: earlier }, { nameOf: channelNamesOf(view, channel) }) } : situation;
  const requestArgs = { view, situation: moment, selfId, selfName, channel, at, descriptions, videos, customEmoji, gifs, mediaCache, elsewhereDestination, searchAvailable, skillsInventory, skillsGranted, queued, channelDirectory };
  const built = sandboxMessages(requestArgs, runs);
  const { request, messages, systemMessage, userMessage, userText } = built;
  const history = situationHistory(moment).history;
  const parseText = (text) => parseOutput(text, { maxDrawChars: view.config.image?.maxPromptChars });
  const out = [];
  let stopped = false;
  for (let i = 0; i < sampleCount(runs); i += 1) {
    if (signal?.aborted) {
      stopped = true;
      break;
    }
    let completion;
    try {
      completion = await llm.complete(messages, sandboxOptions(signal));
    } catch (err) {
      if (signal?.aborted) {
        stopped = true;
        break;
      }
      throw err;
    }
    const parsed = parseText(completion.text);
    const answer = shapeAnswer(parsed, view.config, gifs, request.handles);
    const run = {
      answer, call: parsed.call ?? null, callError: parsed.callError ?? null, extraCalls: parsed.extraCalls ?? 0, usage: completion.usage ?? null, outcome: null, followUp: null,
      refs: { idByIndex: request.idByIndex, handles: request.handles ?? null, channelHandles: request.channelHandles ?? null, followUpIdByIndex: null },
    };
    // A call's text (its body, or a message's `text=` attribute) is rendered like a <msg> of the turn.
    const callMentions = run.call ? handleMentions(callTextOf(run.call), request.handles) : {};
    if (callMentions.mentions) run.callMentions = callMentions;
    out.push(run);
    if (!run.call || typeof onCall !== 'function') continue;
    run.outcome = await onCall(run.call, { idByIndex: request.idByIndex, history, channelHandles: request.channelHandles ?? null });
    if (run.outcome?.followUp !== true) continue;
    // The follow-up as a live turn sends it (no cache marker): the turn continued over her lines
    // with the call's mark (continuesTurn), else the same request with the result before `<task>`.
    const labels = view.prompts?.labels ?? {};
    const maxChars = view.config.skills?.resultMaxChars ?? RESULT_MAX_CHARS;
    const continued = continuesTurn(view.config, labels);
    const followUpMessages = () => {
      if (continued) {
        const next = scenarioContinuation({ requestArgs, history, answer, outcome: run.outcome, labels, maxChars, callMarks: earlier });
        run.refs.followUpIdByIndex = next.idByIndex;
        return next.messages;
      }
      run.refs.followUpIdByIndex = request.idByIndex;
      const acted = {
        reacted: answer.reactions,
        gifs: answer.gif ? [answer.gif.id] : [],
        texts: answer.messages.map((message) => message.text),
        drew: Boolean(answer.draw),
      };
      const block = skillResultBlock(run.outcome.result, labels, { maxChars, posted: firstPass(acted, labels) });
      return withSkillResult([systemMessage, { ...userMessage, content: userText }], block);
    };
    try {
      const second = await llm.complete(followUpMessages(), sandboxOptions(signal));
      const parsedAgain = parseText(second.text);
      // The continued request lists the same members (her own lines add no author): the first request's handles.
      run.followUp = { answer: shapeAnswer(parsedAgain, view.config, gifs, request.handles), extraCall: Boolean(parsedAgain.call || parsedAgain.callError), usage: second.usage ?? null, continuation: continued };
    } catch (err) {
      if (signal?.aborted) {
        stopped = true;
        break;
      }
      run.followUp = { error: String(err?.name ?? 'Error') };
    }
  }
  return {
    request: {
      system: textOf(systemMessage.content),
      user: userText,
      tokens: Number.isFinite(request.stats?.used) ? request.stats.used : null,
      limit: Number.isFinite(request.stats?.limit) ? request.stats.limit : null,
    },
    runs: out,
    stopped,
  };
}

/** The operations that post into a channel: what a call that passed leaves there as a line of hers. */
const POSTING_SKILLS = Object.freeze(['message.create', 'draw.create']);

/** The id of the `seq`-th line of hers at `ts`: a snowflake of its moment (recall.js#snowflakeAt), `seq` in its low bits. */
function ownLineId(ts, seq) {
  return (BigInt(snowflakeAt(ts)) + BigInt(seq)).toString();
}

/** A picture she posted, as an attachment of her line: no file behind it, never described. */
function postedPicture(lineId) {
  return { id: `${lineId}-image`, kind: 'image', name: 'image.png', url: null, size: null, durationSec: null, width: null, height: null };
}

/** `line` with her reaction `emoji` on it (a normalized reaction: `{ emoji, count, mine }`); kept as it is when she already reacted so. */
function withOwnReaction(line, emoji) {
  const reactions = Array.isArray(line.reactions) ? line.reactions : [];
  const same = reactions.find((reaction) => reaction?.emoji === emoji);
  if (same?.mine) return line;
  const next = same ? reactions.map((reaction) => (reaction === same ? { ...reaction, count: (Number(reaction.count) || 0) + 1, mine: true } : reaction)) : [...reactions, { emoji, count: 1, mine: true }];
  return { ...line, reactions: next };
}

/**
 * One turn of a multi-step skill scenario (tools/replay.mjs `--skills` with `steps`) carried
 * into the channel the next step reads, as the channel would stand after the live turn:
 * `transcript` (the step's lines, its incoming messages last) and `callMarks` (the earlier steps'
 * calls, withCalls's shape) with what the persona did in `run` (answerSkillScenario's, answered at
 * `at` in `channel`). Her messages of both passes become her lines (src/behavior/turn.js#continuationHistory:
 * `selfName` as author), timed as scenarioContinuation times them (a second apart after `at`; the
 * call a second after her last first-pass message; the follow-up's request a second after the
 * call): the text with its `@handles` rendered as a live post renders them
 * (src/behavior/handles.js#resolveHandles over the request's handles; `mentionedUserIds` the
 * members it would mention), the reply target her `reply="#n"` names in the request that pass
 * answered, the link to the step's trigger (`triggerId`, as linkTriggers puts it on); a drawing
 * (`<draw>`) as a line of hers with a picture. Her reactions land on their lines (a normalized
 * reaction, `mine`). A call that passed and posts (message.create, draw.create) into this channel
 * leaves its post as a line of hers; into another channel nothing here but its mark; a call
 * that passed and reacts (message.react.add) on a line here leaves the reaction. Every call
 * leaves its mark (callMarkOf: `posted` every line of hers of the turn, the call's own post
 * `postedId`) for the next steps' requests. Not carried: a GIF, an edit or a deletion, the image
 * quota. Ids are snowflakes of their moments. Pure.
 * @param {{ transcript: object[], callMarks?: object[], run: object, at: number, selfId: string, selfName: string,
 *   channel: { id: string }, triggerId?: string|null, config: object }} input
 * @returns {{ transcript: object[], callMarks: object[], posted: string[] }}
 */
export function afterScenarioTurn({ transcript, callMarks: earlier = [], run, at, selfId, selfName, channel, triggerId = null, config }) {
  const callMarks = Array.isArray(earlier) ? earlier : [];
  const channelId = String(channel.id);
  let lines = Array.isArray(transcript) ? [...transcript] : [];
  const own = [];
  let seq = 0;
  const addLine = (ts, fields) => {
    seq += 1;
    const id = ownLineId(ts, seq);
    const line = { id, channelId, ts, authorId: String(selfId), content: '', ...(triggerId ? { triggerId: String(triggerId) } : {}), ...fields(id) };
    own.push(line);
    return line;
  };
  const known = (id) => typeof id === 'string' && id !== '' && (lines.some((line) => line?.id === id) || own.some((line) => line.id === id));
  const react = (id, emoji) => {
    if (!known(id) || typeof emoji !== 'string' || !emoji) return;
    lines = lines.map((line) => (line?.id === id ? withOwnReaction(line, emoji) : line));
    for (let i = 0; i < own.length; i += 1) if (own[i].id === id) own[i] = withOwnReaction(own[i], emoji);
  };
  const rendered = (text, handles) => {
    const resolved = handles instanceof Map ? resolveHandles(text, handles) : { text: String(text ?? ''), userIds: [] };
    // Her `#handle` links its channel as a live post does (the line keeps the `<#id>` and names the channel).
    const content = channelHandles instanceof Map ? linkChannels(resolved.text, [], channelHandles) : resolved.text;
    const channelIds = [...new Set(Array.from(content.matchAll(/<#(\d+)>/g), (match) => match[1]))];
    return { content, mentionedUserIds: resolved.userIds, ...(channelIds.length > 0 ? { mentionedChannelIds: channelIds } : {}) };
  };
  // One pass (a shaped answer) answered over `idByIndex`, its request sent at `start`; `aliases`:
  // the continued request's ids of her first-pass lines -> their ids here.
  const pass = (answer, idByIndex, handles, start, aliases = new Map()) => {
    if (!answer) return;
    const target = (n) => {
      const listed = n !== null && n !== undefined && idByIndex instanceof Map ? (idByIndex.get(n) ?? null) : null;
      const id = aliases.get(listed) ?? listed;
      return known(id) ? id : null;
    };
    const messages = Array.isArray(answer.messages) ? answer.messages : [];
    messages.forEach((message, i) => {
      addLine(start + (i + 1) * CONTINUATION_STEP_MS, () => ({ ...rendered(message.text, handles), replyToId: target(message.replyTo) }));
    });
    if (answer.draw) addLine(start + messages.length * CONTINUATION_STEP_MS + CONTINUATION_STEP_MS / 2, (id) => ({ replyToId: target(answer.draw.replyTo), attachments: [postedPicture(id)] }));
    for (const reaction of Array.isArray(answer.reactions) ? answer.reactions : []) react(target(reaction.to), reaction.emoji);
  };
  const refs = run?.refs ?? {};
  const channelHandles = refs.channelHandles ?? null;
  pass(run?.answer, refs.idByIndex, refs.handles, at);
  const outcome = run?.call ? run.outcome : null;
  if (!outcome?.result) {
    return { transcript: continuationHistory({ history: lines, own, selfName }), callMarks: [...callMarks], posted: own.map((line) => line.id) };
  }
  const callAt = at + ((run.answer?.messages?.length ?? 0) + 1) * CONTINUATION_STEP_MS;
  const executed = outcome.verdict?.ok === true ? outcome.executed : null;
  const args = executed?.args ?? {};
  const here = !args.channel || String(args.channel) === channelId;
  let postedId = null;
  if (executed && here && POSTING_SKILLS.includes(executed.skill)) {
    const reply = typeof args.reply === 'string' && known(args.reply) ? args.reply : null;
    const line = executed.skill === 'message.create'
      ? addLine(callAt, () => ({ ...rendered(args.text ?? '', refs.handles), replyToId: reply }))
      : addLine(callAt, (id) => ({ replyToId: reply, attachments: [postedPicture(id)] }));
    postedId = line.id;
  }
  if (executed?.skill === 'message.react.add' && here) react(args.message, typeof args.emoji === 'string' ? args.emoji.trim() : '');
  if (run.followUp?.answer) {
    const firstLines = new Map(own.slice(0, run.answer?.messages?.length ?? 0).map((line, i) => [continuationLineId(i), line.id]));
    pass(run.followUp.answer, refs.followUpIdByIndex ?? refs.idByIndex, refs.handles, callAt + CONTINUATION_STEP_MS, firstLines);
  }
  const mark = callMarkOf({ outcome, channelId, at: callAt, postedId, posted: own.map((line) => line.id), config: config ?? {} });
  return { transcript: continuationHistory({ history: lines, own, selfName }), callMarks: [...callMarks, mark], posted: own.map((line) => line.id) };
}

/**
 * A line of the persona's seeded into a skill scenario (tools/replay.mjs `--skills`, a step
 * `{ self }` or a burst item `{ self: true }`): `text` as if she had said it at `at` in
 * `channel`, no turn run for it. Shaped exactly as afterScenarioTurn shapes her live lines
 * (src/behavior/turn.js#continuationHistory, `selfName` as author; its id a snowflake of its
 * moment), the text as given with `mentionedUserIds` the members its `<@id>` tags name
 * (src/memory/mentions.js#tokenIds) -- and, since no turn posted it, no link to a trigger and no
 * call mark. Pure.
 * @param {{ text: string, at: number, selfId: string, selfName: string, channel: { id: string } }} input
 * @returns {object}
 */
export function seededSelfLine({ text, at, selfId, selfName, channel }) {
  const content = String(text ?? '');
  const line = { id: ownLineId(at, 1), channelId: String(channel.id), ts: at, authorId: String(selfId), content, mentionedUserIds: tokenIds(content), replyToId: null };
  return continuationHistory({ history: [], own: [line], selfName })[0];
}

/** A burst's waiting text when `context.maxMessageChars` is not set (config.json's value). */
const QUEUED_TEXT_MAX_CHARS = 2000;
/** The pending queue's cap when `mention.maxPending` is not set (config.json's value). */
const MAX_PENDING = 6;

/**
 * The turns one step of a skill scenario gets when its messages (`incoming`, normalized lines in
 * arrival order, all of one channel) come in a burst, as the live queue gives them
 * (src/discord/events.js, src/behavior/pending.js). How each message calls her is read as the
 * live pipeline reads it (src/behavior/mention.js#detectTrigger, each input masked by its switch:
 * a tag of hers among `mentionedUserIds` with features.mentions on, a reply to a line of hers in
 * `history` or the burst with features.replies on, one of `bot.nameTriggers` as a whole word with
 * features.nameTriggers on -- a missing key counts as on); a message that does not call her is a
 * follow-up the address classifier said `yes` to (it is never asked here). The first message finds
 * her attention free and starts a turn; the rest come in while that turn runs: a call waits in the
 * queue (addPending, `mention.maxPending` the cap: the oldest waiting entry is `dropped`, reason
 * `full`), a follow-up takes the channel's one follow-up slot (followUpSlot: a newer one takes an
 * older one's place, which is `replaced` -- live, a missed-answer candidate -- by the newer's id).
 * The queue is then drained oldest first (popOldest), each entry its own turn. Each turn's
 * `queued` is what still waits besides it, arrival order, as src/discord/events.js#queuedFor lists
 * it: the trigger author's own as `{ id, text }`, another member's as `{ id, text, author }`
 * (their display name), the text on one line cut to `context.maxMessageChars`. Not modelled: the
 * ignore rolls, the merge classifier folding a call into an earlier one, a follow-up's window and
 * staleness checks. Pure; nothing handed in is changed.
 * @param {object[]} incoming
 * @param {{ selfId: string, config: object, history?: object[] }} input
 * @returns {{ turns: { line: object, kind: 'mention'|'reply'|'name'|'followUp', queued: { id: string, text: string, author?: string }[] }[],
 *   replaced: { id: string, by: string }[], dropped: { id: string, reason: string }[] }}
 */
export function burstTurns(incoming, { selfId, config, history = [] }) {
  const lines = (Array.isArray(incoming) ? incoming : []).filter(Boolean);
  if (lines.length === 0) return { turns: [], replaced: [], dropped: [] };
  const features = config?.features ?? {};
  const self = String(selfId);
  const nameTriggers = features.nameTriggers !== false && Array.isArray(config?.bot?.nameTriggers) ? config.bot.nameTriggers : [];
  const herLines = new Set([...(Array.isArray(history) ? history : []), ...lines].filter((line) => line?.self === true).map((line) => line.id));
  const kindOf = (line) =>
    detectTrigger({
      mentionsSelf: features.mentions !== false && (line.mentionedUserIds ?? []).includes(self),
      repliesToSelf: features.replies !== false && Boolean(line.replyToId) && herLines.has(line.replyToId),
      content: String(line.content ?? ''),
      nameTriggers,
    }) ?? 'followUp';
  const maxPending = config?.mention?.maxPending ?? MAX_PENDING;
  const maxChars = config?.context?.maxMessageChars ?? QUEUED_TEXT_MAX_CHARS;
  const [first, ...rest] = lines;
  let pending = [];
  const replaced = [];
  const dropped = [];
  for (const line of rest) {
    const kind = kindOf(line);
    const channelId = String(line.channelId ?? '');
    const slot = followUpSlot(pending, channelId, kind);
    if (!slot.admit) continue;
    if (slot.replaced) {
      pending = pending.filter((ping) => ping !== slot.replaced);
      replaced.push({ id: slot.replaced.trigger.id, by: line.id });
    }
    const { list, evicted } = addPending(pending, { channelId, trigger: line, kind, arrivedAt: Number(line.ts) || 0 }, maxPending);
    pending = list;
    if (evicted) dropped.push({ id: evicted.trigger.id, reason: 'full' });
  }
  const queuedFor = (trigger) =>
    pending
      .filter((ping) => ping.kind !== 'overheard' && ping.trigger.id !== trigger.id)
      .sort((a, b) => a.arrivedAt - b.arrivedAt)
      .map((ping) => ({
        id: ping.trigger.id,
        text: clampChars(oneLine(ping.trigger.content), maxChars),
        ...(ping.trigger.authorId === trigger.authorId ? {} : { author: oneLine(ping.trigger.authorName ?? '') }),
      }));
  const turns = [{ line: first, kind: kindOf(first), queued: queuedFor(first) }];
  while (pending.length > 0) {
    const next = popOldest(pending);
    pending = next.list;
    turns.push({ line: next.ping.trigger, kind: next.ping.kind, queued: queuedFor(next.ping.trigger) });
  }
  return { turns, replaced, dropped };
}
