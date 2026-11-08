// health: allow file-length until 2027-02-01 -- the place rename widened lines the formatter wraps; split in the slice after the cutover
// The replay sandbox (scripts/replay.ts). A sandbox turn takes a real moment of
// the chat -- normalized channel messages fetched again, the trigger among
// them -- builds the request a real turn would build for it (live prompts,
// live config, the stored memory or a snapshot of it), asks the model, parses
// the answer, and stops there: nothing reaches the interface and nothing is written
// to memory. It reproduces the reply path (src/behavior/prompt.ts#buildRequest,
// src/behavior/turn.ts) as the turn it was when the caller knows its mode and
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
// A skill scenario (scripts/replay.ts `--skills`, `answerSkillScenario`) is the
// one sandbox turn that shows the persona her skills: the `<skills>` block of
// the requester's catalogue (`scenarioInventory`, the live listing over a copy
// of the config carrying the scenario's grants, `personaGrantsConfig`). Every
// sandbox turn sends her tools as a live turn does (`sandboxToolset`). Her
// tool calls pass the real resolution and the real gateway (`simulateCall`);
// the operation itself never runs -- a canned result stands in for it, a write
// and a paid effect included -- and the turn goes on as a live one does on the
// step engine (`runSkillLoop`: her speech held while a call left something to
// read, one result per call, the next request appended to the first). A
// multi-step scenario carries each turn into the next step's channel
// (`afterScenarioTurn`: her lines, her reactions, a post the call left here,
// every call's mark), so the next request reads what she said and did. A step
// whose messages come in a burst is played as the live queue plays it
// (`burstTurns`: each call its own turn in arrival order, the waiting ones
// named under the task labels, one follow-up slot per channel). A line of hers
// the scenario seeds is shaped as her live lines (`seededSelfLine`) without a
// turn run for it. A task-result scenario hands in a finished errand of hers
// (`taskResult`, a task as src/errands/store.ts keeps one): the turn its end
// opens is built as src/errands/turns.ts opens it -- trigger kind `errand`, the
// `<errand_result>` block (src/errands/blocks.ts#errandResultText) -- and the
// caller resolves her calls with its files' handles (`file:<task id>/<name>`)
// as a live turn does; the gateway reads an errand's budget through `tasks`
// (simulateCall).

import { accountOf } from '../memory/addresses.ts';
import { buildRequest, skillsInventoryText, userText as userTextOf } from './prompt.ts';
import { detectTrigger, isTaggedCall } from './mention.ts';
import { addPending, followUpSlot, popOldest } from './pending.ts';
import { RECALL_DEFAULTS, recallSettings } from './recall.ts';
import { resolveHandles } from './handles.ts';
import { linkChannels } from '../memory/mentions.ts';
import { answerOf, continuationHistory, loopSettings, pickOtherProfiles, taskInput } from './turn.ts';
import { appendStep, cutToFit, roomLeft, segments, stepNote, stepVerdict, thinkMissing } from './tool-step.ts';
import { diagnosticText } from './wake.ts';
import { callMarksFor, callReason, MAX_MESSAGE_CHARS } from '../format.ts';
import { replayFrame } from './sandbox-frame.ts';
import { grant as accessGrant, revoke as accessRevoke } from '../tools/operations/grants.ts';
import {
  collectAudio,
  collectEmojiItems,
  collectPictures,
  collectVideos,
  isDescribable,
  watchedLengths,
} from '../media/classify.ts';
import { REPLY_REQUEST, cacheTtlFor } from '../llm/openrouter.ts';
import { roleModel } from '../llm/roles.ts';
import { parseOutput } from '../llm/parse.ts';
import { log } from '../log.ts';
import { clampChars, oneLine } from '../memory/clamp.ts';
import { tokenIds } from '../memory/mentions.ts';
import { checkSkill, listSkills } from '../tools/gateway.ts';
import { exposedSkillNames, proposalVerdicts, proposedRows } from '../tools/discovery.ts';
import { outcomeDetail, refusalStatus, resolveCall } from '../tools/executors.ts';
import { coerceArgs, toolResultText, transportOf } from '../tools/tool-calls.ts';
import { buildTools } from '../tools/tools-json.ts';
import { skillRegistry } from '../tools/registry.ts';
import { toolsBlockText } from '../llm/tool-text.ts';
import { requestTokenLimit } from '../llm/budget.ts';
import { estimateMessages, estimateTools } from '../llm/tokens.ts';
import { isPlainObject } from '../config.ts';
import { selfreflectionChatIds, viewSelfreflectionIds } from './mirror.ts';
import { utcDay } from '../time.ts';
import { DEFAULT_RESULT_MAX_CHARS, errandResultText } from '../errands/blocks.ts';
import { CODE } from '../tools/codes.ts';
import { hasTrait } from '../tools/definitions.ts';
import { MARK_TEXT_CHARS } from '../turn/calls.ts';
import { isFiniteNumber, objOf } from '../tools/types.ts';
import type { BuildRequestInput, RequestPart } from './prompt-types.ts';
import type { Line } from './lines.ts';
import type { Untyped } from '../tools/types.ts';
import type { PendingPing } from './pending.ts';
import type {
  MomentCutoffInput,
  HiddenLaterResult,
  LiveViewInput,
  LiveViewResult,
  SituationHistoryInput,
  SampleInput,
  SandboxToolsetInput,
  SandboxToolsetResult,
  AnswerReplyInput,
  AnswerReplyResult,
  ScenarioInventoryInput,
  SimulateCallInput,
  SimulateCallResult,
  SkillScenarioRequestResult,
  CallMarkOfInput,
  AnswerSkillScenarioResult,
  RunSkillLoopInput,
  AfterScenarioTurnInput,
  SeededSelfLineInput,
  BurstTurnsResult,
  SituationHistoryResult,
  SandboxView,
  ScenarioRun,
  StepRecord,
  SandboxRequestInput,
} from './sandbox-types.ts';

// Token estimates taken as they are: the calibrator of a view built without a live one.
const IDENTITY_CALIBRATOR = Object.freeze({ ratio: 1, apply: (n: number) => n, observe: () => 1 });
// pickOtherProfiles takes a place id; the view serves one place, so this only fills the argument.
const SANDBOX_PLACE = 'sandbox';
/**
 * A cache breakpoint on the user part. A JSON field, not prompt text: the llm client
 * (src/llm/openrouter.js#withCacheMarker) gives it its own TTL, or removes it when the
 * request is not cached.
 */
const USER_CACHE_MARKER = Object.freeze({ type: 'ephemeral' });

/**
 * The modes a moment's turn can have (src/behavior/turn.ts#runTurn): a reply, or an interjection with no trigger (an
 * errand's result whose asking message is gone). A recorded `initiate` of the forced turn reads as a reply.
 */
const MODES = new Set(['reply', 'interject']);
/** The modes of a turn nobody asked for: no trigger. */
const SPONTANEOUS = new Set<unknown>(['interject']);
/** src/behavior/turn.ts#TriggerKind without `private`: a private chat is never replayed. */
const KINDS = new Set(['mention', 'reply', 'followUp', 'overheard']);

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** The kinds of items `momentView` hides, in the order `hiddenLater` reports them. */

const HIDDEN_KINDS = ['episodes', 'affinity', 'reasons', 'details', 'interests', 'aliases', 'learned', 'lore'] as const;

/**
 * Every memory store method a sandbox turn calls (`liveView`, the GIF library
 * and the describer cache). A read-only store (a tool's) allows exactly these.
 * `getRecent`, `getGifs` and `getMediaCache` may be missing: the turn then goes
 * on without the recent lines, the GIF library or the captions.
 */
export const SANDBOX_STORE_READS = Object.freeze([
  'getPlace',
  'getUser',
  'listUserProfiles',
  'listChannels',
  'getLore',
  'getRecent',
  'getGifs',
  'getMediaCache',
  // The addresses of src/memory/store-addresses.ts: each reads a row or spells an id, and writes nothing.
  'dmHomeOf',
  'placeOfChat',
  'placeOfRoot',
  'holdsSharedChat',
  'sharedPlaceOf',
  'accountOf',
  'personOfAccount',
  'nativeRootOf',
  'placeChainOf',
  'chatOfPlace',
  'listChildren',
  'topPlaces',
  'placesHolding',
  'placeHolding',
]);

/**
 * The inputs of src/behavior/prompt.ts#buildRequest a sandbox turn leaves
 * out on purpose, each with its reason: `sandboxRequestInput` passes them in
 * the form buildRequest reads as absent (null). Every other input is passed.
 */
export const SANDBOX_OMITS: Readonly<Record<string, string>> = Object.freeze({
  mediaPickText: 'no interface runs here: nothing declares its text',
  dmChat: 'never a private chat: the private layer is out of bounds',
  privateProfile: 'never a private chat: the private layer is out of bounds',
  reads: 'no web lookup: no link is read',
  prefetch:
    'no automatic memory prefetch: no <retrieved> block (a scenario run with her tool loop hands in the one a live turn would get: `coreTools.prefetch`)',
  imageAnswers: 'no second look at a picture is run: no imageAnswered line',
  recallAvailable: 'no server search is run: <senses> does not offer it',
  drawOn: 'no drawing is offered: a sandbox never draws, so <senses> has no drawing line',
  tasks:
    "no part of a split message, no queued or folded call: a replay knows none (a skill scenario's burst hands in its waiting calls: `queued`)",
  selfreflectionChannel:
    'no selfreflection is offered: a sandbox turn never posts, so <senses> has no selfreflection line',
  selfreflection: 'never a selfreflection post: no <virtual_world>, <selfreflection>, <plan> or <found> block',
  offPeriods: 'a replay has no journal of downtime: <now> shows the time only',
  skillsInventory: 'no catalogue: a replay runs no classifier (a skill scenario hands one in: SKILL_SCENARIO_OMITS)',
  around:
    'a replay has no live gateway: no voice channels or statuses, so <people_now> has no live fields (its fields from memory stay)',
  toolsGranted:
    'a request built without a tools set (`toolset`): <senses> names no tool (answerReply and a skill scenario hand one in: SKILL_SCENARIO_OMITS)',
  toolsBlock: 'a request built without a tools set: no <tools> block (the text transport describes the tools there)',
  toolsTokens: 'a request built without a tools set: nothing taken off the room the sections share',
  errands:
    'no task store: a replay knows no errands of hers, so no <errands> or <errand_result> block (a task-result scenario hands in the one errand whose end opens its turn: `taskResult`)',
  intentions: 'no intention store: a replay knows no intentions of hers, so no <intentions> block',
  wake: 'an inner turn only (scripts/replay.ts --inner runs the live turn runner instead of this sandbox)',
  awake: 'an inner turn only: no wake, so no reason to be awake in <spatial_awareness>',
  serviceInner: 'a selfimprovement wake only: no <work> or <board>',
  wakeKind: 'an inner turn only: no wake, so no heartbeat task text',
  previousThink:
    'no earlier turn or step in a replay: no <previous_think> block (a live turn carries its previous think, src/behavior/previous-think.ts)',
  myDay: 'no journal in a replay: no <my_day> block (a live turn reads her day, src/turn/request/my-day.ts)',
  callMarks:
    "no earlier call in a replay: no call mark in <chat> (a skill scenario hands in its earlier steps' calls: `callMarks`)",
  stableFreeze: 'one request per moment, no cache bucket to hold: <self_facts> renders from memory as it stands',
  mind: 'no graph reader runs in a replay: `<memory>` holds the person she answers alone (a live turn reads src/memory/db/mind-read.ts)',
  lookups: 'no earlier lookup in a replay: no <recall> block (a live turn keeps her lookups, src/turn/calls.ts)',
  meanwhileReads: 'no memory reads in a replay: no <meanwhile> block (a live turn reads her lines elsewhere)',
  surroundings: 'no stored fields in a replay: <surroundings> names the place by its path alone',
  refLineOf: 'no memory reads in a replay: an identity outside the chat renders as unavailable',
});

/** The inputs a skill scenario hands in: the skills inventory and the names of her granted skills. */
const SKILL_SCENARIO_INPUTS = new Set(['skillsInventory', 'toolsGranted', 'toolsBlock', 'toolsTokens']);

/**
 * What a skill scenario's turn (`answerSkillScenario`) leaves out: SANDBOX_OMITS but the skills
 * inventory and her granted skills, which it hands in (`scenarioInventory`, `skillsGranted`) so
 * the persona sees her `<skills>` and her tools' senses as live.
 */
export const SKILL_SCENARIO_OMITS: Readonly<Record<string, string>> = Object.freeze(
  Object.fromEntries(Object.entries(SANDBOX_OMITS).filter(([key]) => !SKILL_SCENARIO_INPUTS.has(key)))
);

/** A non-empty string id. */
function isId(value: Untyped) {
  return typeof value === 'string' && value !== '';
}

/** A recorded turn mode: `reply` or `interject`; null for anything else, which the sandbox runs as a reply. Pure. */
export function momentMode(value: unknown): 'reply' | 'interject' | null {
  // MODES holds exactly these two names.
  return typeof value === 'string' && MODES.has(value) ? (value as 'reply' | 'interject') : null;
}

/**
 * A recorded trigger kind (src/behavior/turn.ts#TriggerKind, never
 * `private`); null for anything else. Pure.
 */
export function momentKind(value: unknown): string | null {
  return typeof value === 'string' && KINDS.has(value) ? value : null;
}

/** Whether `mode` is a turn nobody asked for (`interject`): it has no trigger. Pure. */
export function isSpontaneous(mode: Untyped): boolean {
  return SPONTANEOUS.has(mode);
}

/**
 * The message a moment answers: the one its `triggerId` names in its
 * history, else the last message of the history. Null for a spontaneous turn
 * and for an empty history.
 */
function momentTrigger(moment: Untyped) {
  const history = Array.isArray(moment?.history) ? moment.history : [];
  if (history.length === 0 || isSpontaneous(moment?.mode)) return null;
  const id = moment.triggerId;
  const found = isId(id) ? history.find((message: Untyped) => message?.id === id) : null;
  return found ?? history[history.length - 1] ?? null;
}

// ---- what the persona saw of the moment's media -------------------------------------

/** `cache[key]` when it is the cache's own entry (never an inherited property), else undefined. */
function entryOf(cache: Untyped, key: Untyped) {
  return cache && typeof cache === 'object' && Object.hasOwn(cache as object, key as PropertyKey)
    ? cache[key]
    : undefined;
}

/**
 * The text of a describer cache entry the persona could have seen: not a
 * miss, a non-empty `text`, a watched video (`watched`) or a caption as asked,
 * and written no later than `before` (an entry without a time is taken; a
 * null `before` takes any time). Else null.
 */
function seenText(entry: Untyped, { watched, before }: { watched: Untyped; before: Untyped }) {
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
function mediaItemsOf(message: Line, sites: unknown) {
  const pictures = [...collectPictures(message), ...collectAudio(message), ...collectEmojiItems(message)]
    .filter(isDescribable)
    .map((item) => item.itemId);
  const videos = collectVideos(message, { videoSites: Array.isArray(sites) ? sites : [] }).map((item) => item.itemId);
  return { pictures: [...new Set(pictures)], videos: [...new Set(videos)] };
}

/**
 * The caption and video maps a replayed moment's transcript is rendered
 * with (src/format.ts#formatTranscript's `descriptions` and
 * `videos`, the same the live turn passes): for every media item of the
 * history, the describer's `cache` entry as it stood by `before` (null: any
 * time), read only. A cached miss, a limit or error state and an entry written
 * after `before` are no description; a watched summary is the video state
 * `{ state: 'watched', text }` plus the entry's `watchedSeconds` / `totalSeconds` when stored. Without a cache, empty maps. Pure.
 * @param history  Normalized messages (src/protocol/events.js#Message).
 * @param [options]  `cache`: the
 *   describer's cache (`store.getMediaCache(placeId)`), or null.
 */
export function replayMedia(
  history: Array<Line>,
  {
    cache = null,
    sites = [],
    before = null,
  }: { cache?: Record<string, Untyped> | null; sites?: Array<string>; before?: number | null } = {}
): { descriptions: Map<string, string>; videos: Map<string, { state: 'watched'; text: string }> } {
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

function zeroCounts(): Record<(typeof HIDDEN_KINDS)[number], number> {
  return { episodes: 0, affinity: 0, reasons: 0, details: 0, interests: 0, aliases: 0, learned: 0, lore: 0 };
}

/** The time (ms) of an ISO string or an epoch number; null when there is none. */
function timeOf(value: Untyped) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value !== 'string' || !value) return null;
  const ms = Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

/** Whether a dated value is at or after `cutoff`; an undated one never is. */
function isLater(value: Untyped, cutoff: Untyped) {
  const ms = timeOf(value);
  return ms !== null && ms >= cutoff;
}

/**
 * Whether an episode was written at or after `cutoff`: by its `addedAt` (when
 * the analyzer stored it); without one, by its `date`, day by day -- an
 * episode dated the cutoff's day or later is hidden, as that day may hold the
 * moment itself. An episode with neither is kept.
 */
function isLaterEpisode(episode: Untyped, cutoff: Untyped) {
  if (timeOf(episode?.addedAt) !== null) return isLater(episode.addedAt, cutoff);
  if (typeof episode?.date === 'string' && DAY_RE.test(episode.date)) return episode.date >= utcDay(cutoff);
  return false;
}

/** `list` without the items `later` flags, and how many were left out; a non-array passes through. */
function keepBefore(list: Untyped, later: Untyped) {
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
function affinityBefore(affinity: Untyped, cutoff: Untyped) {
  if (!affinity || typeof affinity !== 'object' || !Array.isArray(affinity.history))
    return { affinity, hidden: 0, reasons: 0 };
  const { list: history, hidden } = keepBefore(affinity.history, (entry: Untyped) => isLater(entry?.ts, cutoff));
  if (hidden === 0) return { affinity, hidden: 0, reasons: 0 };
  const newest = affinity.history[affinity.history.length - 1];
  if (!isLater(newest?.ts, cutoff)) return { affinity: { ...affinity, history }, hidden, reasons: 0 };
  const worded = history.findLast((entry: Untyped) => typeof entry?.reason === 'string' && entry.reason !== '');
  return { affinity: { ...affinity, history, reason: worded ? worded.reason : '' }, hidden, reasons: 1 };
}

/**
 * A member's profile as it stood before `cutoff`: episodes, affinity history
 * (and the reason it produced), details, interests and aliases first recorded
 * at or after the cutoff left out. A new object when anything was hidden, the
 * stored profile itself otherwise; null for null.
 */
function profileBefore(
  profile: Untyped,
  cutoff: Untyped
): { profile: Record<string, Untyped> | null; hidden: Record<string, Untyped> } {
  const hidden = zeroCounts();
  if (!profile || typeof profile !== 'object') return { profile, hidden };
  const firstSeenLater = (item: Untyped) => isLater(item?.firstSeen, cutoff);
  const episodes = keepBefore(profile.episodes, (episode: Untyped) => isLaterEpisode(episode, cutoff));
  const details = keepBefore(profile.details, firstSeenLater);
  const interests = keepBefore(profile.interests, firstSeenLater);
  const aliases = keepBefore(profile.aliases, firstSeenLater);
  const affinityKept = affinityBefore(profile.affinity, cutoff);
  hidden.episodes = episodes.hidden;
  hidden.details = details.hidden;
  hidden.interests = interests.hidden;
  hidden.aliases = aliases.hidden;
  hidden.affinity = affinityKept.hidden;
  hidden.reasons = affinityKept.reasons;
  if (HIDDEN_KINDS.every((kind) => hidden[kind] === 0)) return { profile, hidden };
  const out = { ...profile };
  if (episodes.hidden) out.episodes = episodes.list;
  if (details.hidden) out.details = details.list;
  if (interests.hidden) out.interests = interests.list;
  if (aliases.hidden) out.aliases = aliases.list;
  if (affinityKept.hidden) out.affinity = affinityKept.affinity;
  return { profile: out, hidden };
}

/** The place memory before `cutoff`: learned items first recorded at or after it left out. */
function placeBefore(place: Untyped, cutoff: Untyped) {
  if (!place || typeof place !== 'object') return { place, hidden: 0 };
  const learned = keepBefore(place.learned, (item: Untyped) => isLater(item?.firstSeen, cutoff));
  return learned.hidden ? { place: { ...place, learned: learned.list }, hidden: learned.hidden } : { place, hidden: 0 };
}

/** The lorebook before `cutoff`: entries created at or after it left out. */
function loreBefore(entries: Untyped, cutoff: Untyped) {
  return keepBefore(entries, (entry: Untyped) => isLater(entry?.createdAt, cutoff));
}

/**
 * The recent store (src/memory/store.js#getRecent) before `cutoff`: the lines
 * the analyzer added at or after it left out (by `addedAt`; a line without
 * one, by the time of the moment it is about, `at`). A new object when a line
 * was hidden, the given one otherwise; a value without `lines` (a view
 * without a recent store reads null) passes through.
 */
function recentBefore(recent: Untyped, cutoff: Untyped) {
  if (!recent || typeof recent !== 'object' || !Array.isArray(recent.lines)) return recent;
  const { list, hidden } = keepBefore(recent.lines, (line: Untyped) =>
    isLater(timeOf(line?.addedAt) !== null ? line.addedAt : line?.at, cutoff)
  );
  return hidden ? { ...recent, lines: list } : recent;
}

/**
 * When a replayed moment's memory stops: the time of the newest line the
 * persona saw (the last message of its `history`, or its trigger when that
 * is newer), else its `at` (when the persona answered); null when neither is
 * known (nothing is then hidden). Pure.
 */
export function momentCutoff(moment: MomentCutoffInput): number | null {
  const history = Array.isArray(moment?.history) ? moment.history : [];
  const times: Array<number> = [history[history.length - 1]?.ts, momentTrigger(moment)?.ts].filter(Number.isFinite);
  if (times.length > 0) return Math.max(...times);
  return Array.isArray(moment?.history) && typeof moment?.at === 'number' && Number.isFinite(moment.at)
    ? moment.at
    : null;
}

/**
 * A view of the same shape as `base` (`liveView`) whose memory is the base
 * memory as it stood before `cutoff`: every dated item written at or after it
 * is left out -- a member's episodes (by `addedAt`; without one, those dated
 * the cutoff's day or later), affinity history entries (by `ts`; when the
 * newest one goes, `reason` falls back to that of the newest kept entry that
 * has one, or to ''; the score stays), details, interests and aliases (by
 * `firstSeen`), the place's learned items (by `firstSeen`), lore entries (by
 * `createdAt`) and the recent store's lines (by `addedAt`, else by their
 * moment `at`; null for a base without `getRecent`). Undated items and every
 * other field pass through -- a profile's names and counters, its portrait
 * and relationship text, the place's patterns, the channel entries, the
 * current text of a lore entry updated later; `prompts`, `config`,
 * `calibrator` and `listChannels` are the base's, read at call time. The base
 * is never written and nothing is cached. Pure.
 * @param cutoff  Epoch ms.
 */
export function momentView(base: SandboxView, cutoff: number): SandboxView {
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
      getPlace: () => placeBefore(base.memory.getPlace(), cutoff).place,
      getUser: (id: Untyped) => profileBefore(base.memory.getUser(id), cutoff).profile,
      listUserProfiles: () =>
        (base.memory.listUserProfiles() ?? []).map((profile: Untyped) => profileBefore(profile, cutoff).profile),
      listChannels: () => base.memory.listChannels(),
      getLore: () => loreBefore(base.memory.getLore(), cutoff).list,
      getRecent: () =>
        recentBefore(typeof base.memory.getRecent === 'function' ? base.memory.getRecent() : null, cutoff),
    },
  };
}

/**
 * How many items `momentView(base, cutoff)` leaves out over the whole memory,
 * by kind: `episodes`, `affinity` (history entries), `reasons` (attitudes
 * whose reason fell back), `details`, `interests`, `aliases`, `learned`,
 * `lore`. The recent lines it leaves out are not counted. Counts only. Pure.
 */
export function hiddenLater(base: SandboxView, cutoff: number): HiddenLaterResult {
  const counts = zeroCounts();
  for (const profile of base.memory.listUserProfiles() ?? []) {
    const { hidden } = profileBefore(profile, cutoff);
    for (const kind of HIDDEN_KINDS) counts[kind] += hidden[kind];
  }
  counts.learned += placeBefore(base.memory.getPlace(), cutoff).hidden;
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
function readOnlyCalibrator(live: Untyped) {
  if (!live) return IDENTITY_CALIBRATOR;
  return {
    get ratio() {
      return live.ratio;
    },
    apply: (n: number) => live.apply(n),
    observe: () => live.ratio,
  };
}

export function liveView({ hot, store, placeId, calibrator }: LiveViewInput): LiveViewResult {
  return {
    get prompts() {
      return hot.prompts;
    },
    get config() {
      return hot.config;
    },
    calibrator: readOnlyCalibrator(calibrator),
    memory: {
      getPlace: () => store.getPlace(placeId),
      getUser: (id) => store.getUser(accountOf(store, String(id))),
      listUserProfiles: () => store.listUserProfiles(),
      listChannels: () => store.listChannels(placeId),
      getLore: () => store.getLore(placeId),
      getRecent: () => (typeof store.getRecent === 'function' ? store.getRecent(placeId) : null),
      selfreflectionChannelIds: () => [...selfreflectionChatIds(store)],
    },
  };
}

/**
 * The history a moment is answered from: its normalized messages as they are.
 * Its trigger is the message its `triggerId` names (else the last message)
 * and its `triggerKind` the recorded `kind` when it is one a turn has
 * (`momentKind`), else the guess: 'reply' when the trigger replies to a
 * message of the persona in that history, else 'mention'. A spontaneous
 * moment (`mode` `interject`) has neither: trigger and kind are
 * null. Pure.
 * @throws {Error} a missing or empty history, or a trigger by the persona.
 */
export function situationHistory(moment: SituationHistoryInput): SituationHistoryResult {
  const history = moment?.history;
  if (!Array.isArray(history) || history.length === 0) throw new Error('moment: the history is empty');
  if (isSpontaneous(moment.mode)) return { history, trigger: null, triggerKind: null };
  const trigger = momentTrigger(moment);
  if (!trigger || trigger.self === true) throw new Error('moment: the trigger must not be by self');
  const target = trigger.replyToId ? history.find((message) => message?.id === trigger.replyToId) : null;
  return { history, trigger, triggerKind: momentKind(moment.kind) ?? (target?.self === true ? 'reply' : 'mention') };
}

/** The text of a message's content: a string as is, an array of parts as its text parts joined. */
function textOf(content: string | Array<RequestPart>): string {
  if (Array.isArray(content)) {
    return content
      .filter((part) => part?.type === 'text')
      .map((part) => part.text)
      .join('\n');
  }
  return content ?? '';
}

/** How many samples to take: a positive integer, 1 when unusable. */
function sampleCount(samples: Untyped) {
  const n = Math.floor(Number(samples));
  return Number.isFinite(n) && n > 0 ? n : 1;
}

/**
 * `samples` completions of `messages`, one after another. Before each one
 * `signal` is checked; an aborted signal (also one that aborts mid-request)
 * stops the loop and `stopped` is true. Any other llm error is thrown.
 * `onUsage(usage, estimated)` follows every completion.
 */
async function sample({ llm, messages, options, samples, signal, onUsage, read }: SampleInput) {
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
    answers.push(read(completion.text, completion));
  }
  return { answers, stopped };
}

/** The frame and whereabouts of a sandbox turn (src/behavior/sandbox-frame.ts#replayFrame). */
function framedTurn({
  view,
  situation,
  channel,
  at,
}: Pick<SandboxRequestInput, 'view' | 'situation' | 'channel' | 'at'>): ReturnType<typeof replayFrame> {
  const { trigger, triggerKind } = situationHistory(situation);
  const config = view.config;
  return replayFrame({
    memory: view.memory,
    channel,
    trigger,
    mode: momentMode(situation?.mode) ?? 'reply',
    triggerKind,
    now: at,
    timezone: String(config.bot?.timezone ?? 'UTC'),
  });
}

/**
 * The input of src/behavior/prompt.ts#buildRequest for one sandbox turn, every
 * key named: the turn the moment was (`situationHistory`: its trigger and
 * kind; its mode, `reply` when none or an unknown one is recorded), memory
 * through `view.memory` as in a real turn (`features.memory` off leaves it
 * out, the recent lines included: `recentLinesOf`), tokens measured with
 * `view.calibrator`, and the caller's lists and `<senses>` inputs. The inputs
 * left out on purpose are `SANDBOX_OMITS`, passed as absent -- but the
 * skills inventory and her granted skills when a skill scenario hands them in
 * (`skillsInventory`, a non-empty list of catalogue rows; `skillsGranted`, a
 * non-empty list of skill names: SKILL_SCENARIO_OMITS). `tasks` is
 * absent but when a skill scenario's burst hands in the calls still waiting after this one
 * (`queued`, `{ id, text, author? }` each, burstTurns's): then the task labels name them as a
 * live turn names its queued calls (src/behavior/turn.ts#taskInput: the trigger author's own
 * under `labels.task.queued`, another member's under `labels.task.queuedOthers`). `taskResult`
 * (a finished task, as src/errands/store.ts keeps one) makes it the turn that errand's end
 * opens, as src/errands/turns.ts runs it: trigger kind `errand` whatever the mode, and `errands`
 * carrying its `<errand_result>` body (src/errands/blocks.ts#errandResultText, cut to
 * `errands.resultMaxChars` read now) with no `<errands>` list -- a replay knows no other errand of
 * hers. `coreTools` (`{ recallAvailable, prefetch? }`, a skill scenario run with her tool loop)
 * hands in whether the server search could run (`recallAvailable`) and the automatic memory prefetch of
 * the trigger (`prefetch`, `<retrieved>`), which every other sandbox turn leaves out (SANDBOX_OMITS). The view is
 * read now and nothing is written. `preTurn` (`{ lookup, recallAvailable }`, an input no replay mode hands in now) hands in what a live turn's search classifier and searches found before her
 * reply (`<lookup>`) and whether the server search could run. `toolset` (sandboxToolset's) hands in her
 * tools: their names (`<senses>`), the `<tools>` block of the text transport and the tokens the native
 * `tools` field takes off the room.
 * @param input  The inputs of `answerReply` that shape the request (see there), and
 *   `skillsInventory`, `toolset`, `queued`, `taskResult`, `coreTools`, `preTurn`
 *   (`answerSkillScenario`'s).
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
  toolset = null,
  queued = null,
  taskResult = null,
  coreTools = null,
  preTurn = null,
  callMarks = null,
}: SandboxRequestInput): Record<string, Untyped> {
  const config = view.config;
  const memory = view.memory;
  // The turn an errand's end opens: its `<errand_result>` body, as src/behavior/turn.ts#errandsInputFor renders it.
  const resultText = taskResult
    ? errandResultText(taskResult, view.prompts?.labels, {
        maxChars: config.errands?.resultMaxChars ?? DEFAULT_RESULT_MAX_CHARS,
      })
    : '';
  // A burst's calls still waiting, named as a live turn names its queued calls; absent otherwise.
  const waiting = Array.isArray(queued) && queued.length > 0 ? queued : null;
  const tasks = waiting
    ? taskInput({ part: null, queued: () => waiting, added: null, labels: view.prompts?.labels, placeId: channel.id })
        .input
    : null;
  const memoryOn = true;
  const { history, trigger, triggerKind } = situationHistory(situation);
  const framed = framedTurn({ view, situation, channel, at });
  // pickOtherProfiles reads a store-shaped object; this one reads the view.
  const viewAsStore = { getUser: (id: string | undefined) => memory.getUser(id) };
  return {
    config,
    prompts: view.prompts,
    calibrator: view.calibrator ?? IDENTITY_CALIBRATOR,
    mode: momentMode(situation?.mode) ?? 'reply',
    now: at,
    selfName,
    // As a live turn: her own profile is never listed in `<directory>`.
    selfId: selfId ?? null,
    history,
    trigger,
    // An errand's end opens a turn of kind `task` (src/errands/turns.ts), with or without a trigger.
    triggerKind: taskResult ? 'errand' : triggerKind,
    // As a live turn reads it: an untagged reply takes the follow-up task.
    taggedCall: trigger ? isTaggedCall(trigger, selfId) : null,
    placeMemory: memoryOn ? memory.getPlace() : {},
    interlocutor: memoryOn && trigger ? memory.getUser(trigger.authorId) : null,
    otherProfiles: memoryOn ? pickOtherProfiles(viewAsStore, SANDBOX_PLACE, history, trigger?.authorId) : [],
    candidateProfiles: memoryOn ? memory.listUserProfiles() : [],
    nameOf: memoryOn ? (id: Untyped) => memory.getUser(id)?.names?.[0] ?? null : null,
    currentChannelId: channel.id,
    descriptions: descriptions instanceof Map ? descriptions : new Map(),
    videos: videos instanceof Map ? videos : new Map(),
    imageAnswers: null,
    searchAvailable: searchAvailable === true,
    customEmoji: Array.isArray(customEmoji) ? customEmoji : [],
    mediaPickText: null,
    gifs,
    mediaCache,
    elsewhereDestination:
      typeof elsewhereDestination?.name === 'string' && elsewhereDestination.name
        ? { name: elsewhereDestination.name }
        : null,
    // SANDBOX_OMITS, as buildRequest reads them absent.
    dmChat: null,
    privateProfile: null,
    reads: null,
    // Absent (SANDBOX_OMITS) but with her tool loop (`coreTools.prefetch`): the memory prefetch a live turn would show.
    prefetch: coreTools?.prefetch ?? null,
    // Absent (SANDBOX_OMITS) but with her tool loop (`coreTools`) or the pre-turn searches: whether the server search runs.
    recallAvailable: coreTools ? coreTools.recallAvailable === true : preTurn ? preTurn.recallAvailable === true : null,
    drawOn: false,
    // Absent but on a burst's turn with calls still waiting (`queued`).
    tasks,
    selfreflectionChannel: null,
    selfreflectionChannelIds: viewSelfreflectionIds(view),
    selfreflection: null,
    offPeriods: null,
    around: null,
    // Absent but in a skill scenario: the catalogue rows it hands in.
    skillsInventory: Array.isArray(skillsInventory) && skillsInventory.length > 0 ? skillsInventory : null,
    // Absent but when the caller hands in her tools set (sandboxToolset): the names, the text transport's block, the native transport's tokens.
    toolsGranted: Array.isArray(toolset?.names) && toolset.names.length > 0 ? toolset.names : null,
    toolsBlock: typeof toolset?.block === 'string' && toolset.block ? toolset.block : null,
    toolsTokens: isFiniteNumber(toolset?.tokens) && toolset.tokens > 0 ? toolset.tokens : null,
    // Absent (a replay has no task store: SANDBOX_OMITS) but on a task-result scenario's turn.
    errands: resultText ? { list: '', result: resultText } : null,
    // No intention store (SANDBOX_OMITS): no <intentions> block.
    intentions: null,
    wake: null,
    awake: null,
    serviceInner: null,
    wakeKind: null,
    previousThink: null,
    // No journal (SANDBOX_OMITS): no <my_day> block.
    myDay: null,
    // A skill scenario's earlier calls, put among the chat's lines by time; none otherwise (SANDBOX_OMITS).
    callMarks,
    // No cache bucket to hold (SANDBOX_OMITS): the stable part renders from memory as it stands.
    stableFreeze: null,
    // The frame a live reply carries and the whereabouts it states.
    whereabouts: framed.whereabouts,
    frame: framed.frame,
    // No memory reads in a replay (SANDBOX_OMITS): the frame's blocks hold what the turn itself gives.
    mind: null,
    lookups: null,
    meanwhileReads: null,
    surroundings: null,
    refLineOf: null,
  };
}

/**
 * Her tools for a sandbox request, as a live turn pins them at its start (src/behavior/turn.ts): the names
 * (src/tools/discovery.ts#exposedSkillNames over the view's config and `selfId`), their definitions
 * (src/tools/tools-json.ts#buildTools over the skills layer of the view's prompts), the transport
 * (`tools.transport`, read now) and what the request carries of them -- the `<tools>` text on the text
 * transport, the calibrated tokens of the `tools` field on the native one. Nothing is sent here. Pure.
 */
export function sandboxToolset({
  view,
  selfId = null,
  registry = skillRegistry(),
}: SandboxToolsetInput): SandboxToolsetResult {
  const config = view.config;
  const transport = transportOf(config);
  const names = exposedSkillNames({ config, selfId, registry });
  const tools = buildTools(names, {
    registry,
    texts: view.prompts?.tools,
    fill: { drawChars: config.image?.maxPromptChars ?? 1600 },
  });
  const calibrator = view.calibrator ?? IDENTITY_CALIBRATOR;
  const block = transport === 'text' && tools.length > 0 ? toolsBlockText(tools, view.prompts?.labels) : null;
  const tokens = transport === 'native' && tools.length > 0 ? estimateTools(tools) : 0;
  return { transport, names, tools, block, tokens, registry };
}

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
  tools,
  toolChoice,
  parallelToolCalls,
}: AnswerReplyInput): Promise<AnswerReplyResult> {
  // `tools` undefined: her tools as a live turn sends them (sandboxToolset); null or [] none; an array as given.
  const toolset = tools === undefined ? sandboxToolset({ view, selfId }) : null;
  const { request, messages, systemMessage, userContent } = sandboxMessages(
    {
      view,
      situation,
      selfId,
      selfName,
      channel,
      at,
      descriptions,
      videos,
      customEmoji,
      gifs,
      mediaCache,
      elsewhereDestination,
      searchAvailable,
      channelDirectory,
      toolset,
    },
    samples
  );
  const sent = toolset ? (toolset.transport === 'native' ? toolset.tools : null) : tools;
  const transport = toolset?.transport ?? 'native';

  const { answers, stopped } = await sample({
    llm,
    messages,
    options: toolOptions(sandboxOptions(signal), {
      tools: sent,
      toolChoice: toolChoice ?? (toolset && sent?.length ? 'auto' : undefined),
      parallelToolCalls,
    }),
    samples,
    signal,
    onUsage,
    read: (text: string, completion: Untyped) => {
      const split = answerOf(completion, { transport, step: 1, registry: toolset?.registry ?? skillRegistry() });
      const parsed = parseOutput(split.speechText, { cutOff: completion?.finishReason === 'length' });
      const shaped = shapeAnswer(parsed, view.config, request.handles);
      if (transport === 'text') return split.calls.length > 0 ? { ...shaped, toolCalls: split.calls } : shaped;
      return Array.isArray(completion?.toolCalls) ? { ...shaped, toolCalls: completion.toolCalls } : shaped;
    },
  });

  return { request: { system: textOf(systemMessage.content), user: textOf(userContent) }, answers, stopped };
}

/** `options` with native tool calling added when `tools` is a non-empty array (stored definitions passed through as they were). */
function toolOptions(
  options: Untyped,
  { tools, toolChoice, parallelToolCalls }: { tools: Untyped; toolChoice: Untyped; parallelToolCalls: Untyped }
) {
  if (!Array.isArray(tools) || tools.length === 0) return options;
  return {
    ...options,
    tools,
    ...(toolChoice !== undefined ? { toolChoice } : {}),
    ...(parallelToolCalls !== undefined ? { parallelToolCalls } : {}),
  };
}

/** The llm options of every sandbox completion: the reply's role and purpose, as the replay's own, off the rails' counters. */
function sandboxOptions(signal: Untyped) {
  return { ...REPLY_REQUEST, origin: 'replay', countAgainstDailyCap: false, skipCalibration: true, signal };
}

/**
 * The request of a sandbox turn (buildRequest over sandboxRequestInput's `input`) and the
 * messages sent for it: the user part as one text (the text-only re-render when a picture was
 * attached), carrying a cache breakpoint when `samples` > 1 and the client caches the request
 * (samples 2..N repeat sample 1 exactly). `userText` is that text without the marker. With
 * `segments` (a skill scenario's turn, which runs on the step engine) the user message stays as
 * buildRequest made it, its text parts tagged with their `cacheSegment` as a live turn sends them:
 * the client places the stable and profiles markers, and the steps appended to it keep the prefix.
 */
function sandboxMessages(input: Untyped, samples: Untyped, { segments = false } = {}) {
  const config = input.view.config;
  // Her tools set: handed in (null: none), else as a live turn pins it.
  const toolset =
    input.toolset === undefined ? sandboxToolset({ view: input.view, selfId: input.selfId }) : input.toolset;
  // An input the sandbox leaves out is null, which buildRequest reads as absent.
  const request = buildRequest(sandboxRequestInput({ ...input, toolset }) as BuildRequestInput);
  const [systemMessage, userMessage] = request.messages;
  const userText = userTextOf(userMessage.content);
  const cached =
    sampleCount(samples) > 1 &&
    cacheTtlFor(config, REPLY_REQUEST.role, roleModel(config, REPLY_REQUEST.role, REPLY_REQUEST.purpose)) !== null;
  const userContent = cached
    ? [{ type: 'text', text: userText, cache_control: { ...USER_CACHE_MARKER } }]
    : segments
      ? userMessage.content
      : userText;
  return {
    request,
    systemMessage,
    userMessage,
    userText,
    userContent,
    toolset,
    messages: [systemMessage, { ...userMessage, content: userContent }],
  };
}

/**
 * One parsed answer (parseOutput's) shaped like a real turn's under `config`: reactions with
 * `features.reactions` on, one message with `features.multiMessage` off; `skip`
 * when the model skipped or left nothing to do. With the request's `handles`
 * (features.mentionHandles on) a message whose text holds a handle-shaped token also carries
 * what a live turn would mention (handleMentions); its `text` stays as she wrote it.
 */
function shapeAnswer(parsed: Untyped, config: Untyped, handles: Map<string, string> | null = null) {
  const reactions = parsed.reactions;
  const kept = parsed.messages;
  const replies = kept.map((message: Untyped) => ({ ...message, ...handleMentions(message.text, handles) }));
  const nothingToDo = replies.length === 0 && reactions.length === 0;
  return { messages: replies, reactions, skip: parsed.skip || nothingToDo, think: parsed.think };
}

/**
 * What a live turn would mention in `text` (src/behavior/turn.ts#renderPost over
 * src/behavior/handles.ts#resolveHandles with the request's `handles`): `mentions`, the member
 * ids an exact `@handle` resolves to (the only ones a send would notify), and `unknownHandles`,
 * the handle-shaped tokens the request does not hold (left as text). {} when there are no
 * handles (features.mentionHandles off) or the text holds no handle-shaped token, so an answer
 * without one keeps its shape. Pure.
 */
export function handleMentions(
  text: string,
  handles: Map<string, string> | null
): { mentions?: Array<string>; unknownHandles?: number } {
  if (!(handles instanceof Map)) return {};
  const { accountIds, unknown } = resolveHandles(text, handles);
  return accountIds.length > 0 || unknown > 0 ? { mentions: accountIds, unknownHandles: unknown } : {};
}

/** The operations whose `text` argument is a message she posts (src/tools/operations/message.ts). */
const MESSAGE_TEXT_SKILLS: ReadonlyArray<unknown> = Object.freeze(['message.create', 'message.edit']);

/** The text a tool call would post: the `text` argument of a message.create or message.edit; '' for none. Pure. */
function callTextOf(call: Untyped) {
  const text = call?.args?.text;
  return MESSAGE_TEXT_SKILLS.includes(call?.skill) && typeof text === 'string' ? text : '';
}

// ---- skill scenarios -----------------------------------------------------------

/** The persona as the principal of a call (src/tools/gateway.ts), as a live turn names her. */
const PERSONA = Object.freeze({ kind: 'persona' });

/** The result a skill's `<result>` block is cut to when `tools.resultMaxChars` is not set (config.json's value). */
const RESULT_MAX_CHARS = 4500;

/**
 * A copy of `config` whose persona grants are exactly `names`: her user id (`selfId`) taken
 * off every `bot.access` entry, then granted on each name -- with the very grant and revoke
 * `/nep access` stores (src/tools/operations/grants.ts). People's grants are kept. The names are used as
 * given (the caller expands `*` and groups, as `/nep access grant` does); a name no grant opens
 * for her (src/tools/access.ts#NOT_GRANTABLE_TO_PERSONA) is stored too, so the gateway's own
 * refusal of it shows. `config` is never changed. Pure.
 * @param config  The live merged config.
 * @param selfId  The bot's own user id.
 * @param names  Skill names.
 */
export function personaGrantsConfig(
  config: Record<string, Untyped>,
  selfId: string,
  names: Array<string>
): Record<string, Untyped> {
  const copy = structuredClone(isPlainObject(config) ? config : {});
  copy.bot = isPlainObject(copy.bot) ? copy.bot : {};
  let access = isPlainObject(copy.bot.access) ? copy.bot.access : {};
  for (const key of Object.keys(access)) access = accessRevoke(access, key, { accountId: selfId });
  for (const name of new Set(Array.isArray(names) ? names : []))
    access = accessGrant(access, name, { accountId: selfId });
  copy.bot.access = access;
  return copy;
}

/**
 * The `<skills>` rows of a skill scenario, built as a live turn's skills discovery builds them
 * (src/behavior/turn.ts#discoverSkills) for `requester` in `chatId`: the catalogue
 * (src/tools/gateway.ts#listSkills over `config`, `selfId`, the skills layer `texts`) whole
 * when the search classifier would have answered `skills: inventory` (`discovery`
 * `'inventory'`), the rows of the skills it would have named (`discovery` a list of names:
 * proposalVerdicts, proposedRows), none for `'none'`. Null when there is nothing to show. Pure.
 */
export function scenarioInventory({
  config,
  selfId,
  texts,
  requester,
  chatId,
  registry,
  discovery = 'inventory',
  getOp,
}: ScenarioInventoryInput): Array<Record<string, Untyped>> | null {
  if (discovery === 'none') return null;
  const rows = listSkills({
    config,
    selfId,
    texts,
    requester,
    audience: { chatId: String(chatId) },
    registry,
    ...(getOp ? { getOp } : {}),
  });
  if (discovery === 'inventory') return rows.length > 0 ? rows : null;
  return proposedRows(proposalVerdicts(Array.isArray(discovery) ? discovery : [], rows), rows);
}

/** The voice budget a sandbox hands the gateway: open, the synthesis itself being canned. */
const SANDBOX_SPEECH = Object.freeze({ quota: () => ({ used: 0, cap: 1, spent: false }) });

export function simulateCall({
  call,
  view,
  config,
  selfId,
  requester,
  chatId,
  now,
  images = null,
  tasks = null,
  getOp,
  resultText = '',
}: SimulateCallInput): SimulateCallResult {
  const skill = String(call?.skill ?? '');
  const refused = (stage: Untyped, code: Untyped, reason: string) => {
    // The machine reason rides along, as a live call keeps it for its mark (outcomeDetail).
    const result = { skill, status: refusalStatus(code), code, ...(reason ? { reason } : {}) };
    return { verdict: { stage, ok: false, code, reason: reason ?? '' }, executed: null, result };
  };
  const resolved = resolveCall(call, view);
  if (!resolved.ok) return refused('resolve', resolved.code, resolved.reason);
  const verdict = checkSkill({
    skill: resolved.skill,
    args: resolved.args,
    principal: PERSONA,
    requester,
    audience: { chatId: String(chatId) },
    context: {
      config,
      selfId,
      registry: view.skills,
      mixedRequesters: false,
      lastRunAt: null,
      now,
      ...(images ? { images } : {}),
      // A voice message is canned in a sandbox, so its day's budget is never spent here.
      speech: SANDBOX_SPEECH,
      // An errand's caps are its budget, as a live turn hands them in (src/behavior/turn.ts#checkCall).
      ...(tasks ? { tasks } : {}),
      ...(getOp ? { getOp } : {}),
    },
  });
  if (!verdict.ok) return refused('gateway', verdict.code, verdict.reason);
  let mapped = null;
  try {
    mapped = resolved.dispatch.toOp({ ...resolved.args });
  } catch {
    mapped = null;
  }
  if (!mapped?.args || mapped.op !== resolved.skill) {
    const result = { skill, status: 'invalid', code: CODE.INVALID_ARGS, reason: 'command' };
    return {
      verdict: { stage: 'command', ok: false, code: CODE.INVALID_ARGS, reason: 'command' },
      executed: null,
      result,
    };
  }
  const text = typeof resultText === 'string' ? resultText : '';
  return {
    verdict: { stage: 'gateway', ok: true },
    executed: { skill: resolved.skill, args: { ...resolved.args } },
    result: { skill, status: 'ok', data: { text } },
  };
}

/**
 * The request a skill scenario sends first (buildRequest over sandboxRequestInput with
 * `skillsInventory`), never sent: its two texts, the token estimate the budget measured
 * (`tokens`, `limit`) and the transcript numbers (`idByIndex`). For `--dry`.
 * @param input  `answerSkillScenario`'s request inputs.
 */
export function skillScenarioRequest(input: Record<string, Untyped>): SkillScenarioRequestResult {
  const { request, systemMessage, userText, toolset } = sandboxMessages(input, 1);
  return {
    system: textOf(systemMessage.content),
    user: userText,
    transport: toolset?.transport ?? 'native',
    tools: toolset?.tools.length ?? 0,
    toolsTokens: toolset?.tokens ?? 0,
    tokens: Number.isFinite(request.stats?.used) ? request.stats.used : null,
    limit: Number.isFinite(request.stats?.limit) ? request.stats.limit : null,
    idByIndex: request.idByIndex,
  };
}

/** How far apart a scenario's continuation places her posts, the call and its request (ms). */
const CONTINUATION_STEP_MS = 1000;

/**
 * The mark one call of hers leaves on the transcript, in the shape src/format.ts#callMarksFor reads
 * and as a live turn notes it (src/behavior/turn.ts, `noteCall`): `outcome` (simulateCall's) made
 * in the turn of `placeId`, its result back at `at`; its status and, when it did not work, why
 * (outcomeDetail, cut at MARK_TEXT_CHARS); its target from the resolved
 * arguments; `postedId` the message the call itself posted, `posted` every message the turn
 * posted. Pure.
 */
function callMarkOf({ outcome, placeId, at, postedId, posted }: CallMarkOfInput) {
  const result = outcome.result;
  const args = outcome.executed?.args ?? {};
  const idOf = (value: Untyped) => (typeof value === 'string' && value ? value : null);
  return {
    placeId,
    at,
    skill: result.skill,
    status: result.status,
    detail: outcomeDetail(result, { textChars: MARK_TEXT_CHARS }),
    target: { messageId: idOf(args.message) ?? idOf(args.reply), placeId: idOf(args.place) },
    postedId: postedId ?? null,
    posted,
  };
}

/** A channel's name by id for a call mark: the view's channel map, the turn's `channel` by its own name. */
function channelNamesOf(view: Untyped, channel: Untyped): (id: string) => string | null {
  const memoryOn = true;
  const stored = memoryOn && typeof view.memory?.listChannels === 'function' ? (view.memory.listChannels() ?? []) : [];
  const names = new Map<string, string>(
    stored
      .filter((entry: Untyped) => entry && typeof entry.name === 'string')
      .map((entry: Untyped) => [String(entry.id), entry.name])
  );
  if (typeof channel.name === 'string' && channel.name) names.set(String(channel.id), channel.name);
  return (id: string) => names.get(id) ?? null;
}

/**
 * A skill scenario: the moment's request with the persona's skills shown (`skillsInventory`,
 * scenarioInventory's rows; else as answerReply) and her tools sent with it as a live turn sends
 * them (sandboxToolset over the scenario's config: the `tools` field on the native transport, the
 * `<tools>` block on the text one), answered `runs` times one after another. Each run is a turn on
 * the step engine (runSkillLoop): her answer is split into speech and tool calls (turn.js#answerOf),
 * the speech parsed and shaped as a real turn's, and every call goes to
 * `onCall(call, { idByIndex, history, channelHandles, timeoutMs })` (the caller's simulateCall: the
 * real resolution and gateway, nothing real run), reads together, every other call alone in her
 * order; the speech is kept only when every call worked and needs no reading, else held; a call that
 * left something to read (a data result, a refusal) is followed by one more request that appends her
 * answer, one result per call and a note to the messages of the first (nothing rebuilt), up to
 * `loop.settings.maxSteps`, the last of them final. A failed follow-up ends the turn with its error
 * name, never thrown; a failed first request throws (as answerReply). An aborted `signal` stops the
 * runs (`stopped`). Every completion goes out as answerReply's do (`origin: 'replay'`, off the daily
 * cap and the calibration). Nothing is sent to the interface and nothing is stored.
 * A step of a multi-step scenario hands in the calls of its earlier steps (`callMarks`, the shape
 * src/format.ts#callMarksFor reads, afterScenarioTurn's): each stands in the request's chat as a line of hers at its
 * time, as a live turn's call marks do. A turn of a burst hands in the calls still waiting after
 * it (`queued`, burstTurns's; sandboxRequestInput). A message's text (`text` of a message.create or
 * message.edit) carries what it would mention (`callMentions`, handleMentions over the request's
 * handles). A task-result scenario hands in its errand (`taskResult`, sandboxRequestInput).
 * `loop` (`{ settings?, now? }`: src/behavior/turn.ts#loopSettings's bounds, the clock; the bounds
 * default to the config's) sets the bounds and the clock. `coreTools` (`{ recallAvailable, prefetch? }`)
 * puts the server search's senses line and the memory prefetch into the request, as
 * a live turn does (sandboxRequestInput).
 * What a run keeps: `run.loop = { steps: [{ step, answer, calls: [{ call, outcome, ms }], dropped,
 * capped, held, thinkMissing, coerced, usage, ms, requestChars, requests?, error? }], ms }` (step 0 the
 * reply), and for the single-call fields `call` / `callError` / `outcome` (the reply's first call),
 * `extraCalls` (the reply's calls past the cap) and `followUp` (the first follow-up step).
 * @param input  answerReply's inputs (`samples` is `runs`), `skillsInventory`, `onCall`,
 *   `callMarks`, `queued`, `taskResult`, `coreTools`, `loop`, `registry` (default: the live one).
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
  onCall,
  callMarks = null,
  queued = null,
  channelDirectory = null,
  taskResult = null,
  coreTools = null,
  loop = null,
  preTurn = null,
  registry = skillRegistry(),
}: Record<string, Untyped>): Promise<AnswerSkillScenarioResult> {
  // The earlier steps' calls among her lines by time, as a live turn's call marks (callMarksOf).
  const earlier = Array.isArray(callMarks) ? callMarks : [];
  const marks = earlier.length > 0 ? callMarksFor(earlier, channelNamesOf(view, channel)) : null;
  const moment = situation;
  const toolset = sandboxToolset({ view, selfId, registry });
  const requestArgs = {
    view,
    situation: moment,
    selfId,
    selfName,
    channel,
    at,
    descriptions,
    videos,
    customEmoji,
    gifs,
    mediaCache,
    elsewhereDestination,
    searchAvailable,
    skillsInventory,
    toolset,
    queued,
    channelDirectory,
    taskResult,
    ...(coreTools ? { coreTools } : {}),
    ...(preTurn ? { preTurn } : {}),
    ...(marks ? { callMarks: marks } : {}),
  };
  const built = sandboxMessages(requestArgs, runs, { segments: true });
  const { request, systemMessage, userText } = built;
  const history = situationHistory(moment).history;
  const settings = loop?.settings ?? loopSettings(view.config);
  const clock = typeof loop?.now === 'function' ? loop.now : Date.now;
  const out = [];
  let stopped = false;
  for (let i = 0; i < sampleCount(runs); i += 1) {
    if (signal?.aborted) {
      stopped = true;
      break;
    }
    const sentAt = clock();
    let completion;
    try {
      completion = await llm.complete(built.messages, stepOptions(signal, toolset));
    } catch (err) {
      if (signal?.aborted) {
        stopped = true;
        break;
      }
      throw err;
    }
    const firstMs = clock() - sentAt;
    const read = readStep(completion, {
      toolset,
      step: 1,
      config: view.config,
      handles: request.handles,
      registry,
    });
    const run: ScenarioRun = {
      answer: read.answer,
      call: null,
      callError: null,
      extraCalls: 0,
      usage: completion.usage ?? null,
      outcome: null,
      followUp: null,
      refs: {
        idByIndex: request.idByIndex,
        handles: request.handles ?? null,
        channelHandles: request.channelHandles ?? null,
        followUpIdByIndex: null,
      },
    };
    out.push(run);
    const looped = await runSkillLoop({
      run,
      read,
      sentAt,
      firstMs,
      built,
      requestArgs,
      history,
      view,
      gifs,
      llm,
      signal,
      onCall,
      settings,
      clock,
      toolset,
      registry,
    });
    if (looped.stopped) {
      stopped = true;
      break;
    }
  }
  return {
    request: {
      system: textOf(systemMessage.content),
      user: userText,
      tokens: Number.isFinite(request.stats?.used) ? request.stats.used : null,
      limit: Number.isFinite(request.stats?.limit) ? request.stats.limit : null,
      toolsTokens: toolset.tokens,
      tools: toolset.tools.length,
    },
    runs: out,
    stopped,
  };
}

/** The least time one call of the tool loop gets, whatever is left of its budget (src/behavior/turn.ts's). */
const LOOP_MIN_CALL_MS = 2000;
/** `tools.callTimeoutMs` when it is not set (config.json's value). */
const CALL_TIMEOUT_MS = 120000;

/** The characters of a request's messages (its text parts), for the record of a loop step. */
function requestChars(messages: Untyped) {
  return messages.reduce((total: Untyped, message: Untyped) => total + textOf(message.content).length, 0);
}

/** The llm options of one request of a skill scenario's turn: the sandbox's own, and her tools on the native transport. */
function stepOptions(signal: Untyped, toolset: Untyped) {
  const base = sandboxOptions(signal);
  return toolset.transport === 'native' && toolset.tools.length > 0
    ? { ...base, tools: toolset.tools, toolChoice: 'auto' }
    : base;
}

/**
 * One completion read as a step of the turn: split into speech and calls (turn.js#answerOf, the ids
 * `s<step>c<n>`), the speech parsed and shaped as a real turn's (`answer`), the parser's `diagnostics`
 * and whether her text began with her thinking (`thinkMissing`).
 */
function readStep(
  completion: Untyped,
  {
    toolset,
    step,
    config,
    handles,
    registry,
  }: { toolset: Untyped; step: Untyped; config: Untyped; handles: Untyped; registry: Untyped }
) {
  const split = answerOf(completion, { transport: toolset.transport, step, registry });
  const parsed = parseOutput(split.speechText, { cutOff: completion?.finishReason === 'length' });
  return {
    ...split,
    parsed,
    answer: shapeAnswer(parsed, config, handles),
    thinkMissing: thinkMissing(split.rawText),
    completion,
  };
}

/** The tokens a provider usage reports, with the cache reads and writes when it gives them. */
function usageNumbers(usage: Untyped) {
  const details = usage?.prompt_tokens_details ?? {};
  return {
    prompt: Number(usage?.prompt_tokens) || 0,
    completion: Number(usage?.completion_tokens) || 0,
    cacheRead: Number(details.cached_tokens ?? usage?.cache_read_input_tokens) || 0,
    cacheWrite: Number(details.cache_write_tokens ?? usage?.cache_creation_input_tokens) || 0,
  };
}

/** The most characters of a result's data her next request carries (src/behavior/turn.ts#resultCharsFor). */
function resultCharsFor(skill: Untyped, config: Untyped) {
  if (skill === 'memory.search' || skill === 'conversation.read')
    return recallSettings(config)?.quoteMaxChars ?? RECALL_DEFAULTS.quoteMaxChars;
  return config?.tools?.resultMaxChars ?? RESULT_MAX_CHARS;
}

/** The reason a call of a step is refused before it is planned: `{ code, reason }` or null (src/behavior/turn.ts#preRefusalOf). */
function preRefusal(
  record: Untyped,
  {
    isFinal,
    room,
    maxCallsPerStep,
    finalReason,
  }: { isFinal: Untyped; room: Untyped; maxCallsPerStep: Untyped; finalReason: Untyped }
) {
  if (record.problem) return { code: record.problem, reason: record.problem === CODE.UNKNOWN_SKILL ? record.name : '' };
  const capped = (what: Untyped) => ({ code: CODE.LOOP_CAP, reason: what });
  if (isFinal) return capped(finalReason);
  if (!room.run) return capped(room.capReason ?? 'time');
  if (record.index >= maxCallsPerStep) return capped('extra-call');
  return null;
}

/**
 * The turn of one skill-scenario run on the step engine, as a live turn's runSteps runs it
 * (src/behavior/turn.ts; the pure parts are src/behavior/tool-step.ts): the first answer `read` is
 * in hand; each of its calls is refused before it runs (unreadable, unknown, cut off, past the
 * step's cap or in the final answer: a `loop-cap` result), repaired (coerceArgs) and given to
 * `onCall`; reads run together, every other call alone in her order (segments). The speech of the
 * step stands only when every call worked and its definition's result is an effect or an accepted
 * errand (stepVerdict); otherwise it is held (`held`) and never posted later. A step that left
 * something to read is followed, with room left (roomLeft, `settings`), by one request: the first
 * messages untouched, her whole text and her calls, one result per call in call order, a note (the
 * held-speech notice, the last-step notice, the parser's diagnostics) -- appendStep over both
 * transports. The last request allowed is final; its calls get `loop-cap` results, its speech is
 * held. A request over the room (the prompt rail, llm.maxRequestTokens x SAFETY_MARGIN, the tools counted) cuts
 * the results to fit and is final. What it did is kept on the run (see answerSkillScenario). Resolves
 * `{ stopped }`; the clock is `clock`.
 */
async function runSkillLoop({
  run,
  read: firstRead,
  sentAt,
  firstMs,
  built,
  requestArgs,
  history,
  view,
  llm,
  signal,
  onCall,
  settings,
  clock,
  toolset,
  registry,
}: RunSkillLoopInput) {
  const { request } = built;
  const config = view.config;
  const labels = view.prompts?.labels ?? {};
  const transport = toolset.transport;
  const definitionOf = (name: string) => registry.get(name) ?? null;
  const isRead = (plan: Untyped) => !plan.refusal && definitionOf(plan.call.skill)?.kind === 'read';
  const stepRecord = (n: number, read: Untyped, extra: Partial<StepRecord> = {}): StepRecord => ({
    step: n,
    answer: read.answer,
    calls: [],
    dropped: 0,
    capped: null,
    held: false,
    thinkMissing: read.thinkMissing,
    coerced: 0,
    usage: read.completion?.usage ?? null,
    ms: 0,
    requestChars: 0,
    idByIndex: request.idByIndex,
    history,
    channelHandles: request.channelHandles ?? null,
    continuation: true,
    ...extra,
  });
  const first = stepRecord(0, firstRead, {
    usage: run.usage,
    ms: firstMs,
    requestChars: requestChars(built.messages),
    continuation: undefined,
  });
  const loopSteps = [first];
  run.loop = { steps: loopSteps, ms: 0 };
  let messages = built.messages;
  let read = firstRead;
  let current = first;
  let step = 0;
  let finalReason: Untyped = null;
  let loopStart = null;
  let stopped = false;
  const tokenLimit = requestTokenLimit(config);
  const calibrator = view.calibrator ?? IDENTITY_CALIBRATOR;
  const costOf = (list: Untyped) =>
    calibrator.apply(estimateMessages(list)) + (transport === 'native' ? estimateTools(toolset.tools) : 0);
  for (;;) {
    const records = read.calls;
    const readAnswer = read.answer;
    const speechItems = readAnswer.messages.length + readAnswer.reactions.length;
    if (records.length === 0) break;
    if (typeof onCall !== 'function') break;
    const isFinal = finalReason !== null;
    loopStart ??= clock();
    const room = roomLeft({
      step,
      maxSteps: settings.maxSteps,
      elapsedMs: clock() - loopStart,
      timeBudgetMs: settings.timeBudgetMs,
    });
    // 1. Her calls: refused before they run, repaired, made.
    const plans = records.map((record: Untyped) => {
      const refusal = preRefusal(record, { isFinal, room, maxCallsPerStep: settings.maxCallsPerStep, finalReason });
      const coercion = refusal
        ? { args: record.args, coerced: [] }
        : coerceArgs(record.args, definitionOf(record.name)?.argsSchema);
      return {
        record,
        refusal,
        coerced: coercion.coerced,
        call: { skill: record.name, args: coercion.args, body: '', toolCallId: record.id, index: record.index },
      };
    });
    current.coerced = plans.reduce((total: Untyped, plan: Untyped) => total + plan.coerced.length, 0);
    current.dropped = plans.filter((plan: Untyped) => plan.refusal?.code === CODE.LOOP_CAP).length;
    current.capped = plans.find((plan: Untyped) => plan.refusal?.code === CODE.LOOP_CAP)?.refusal.reason ?? null;
    const left = settings.timeBudgetMs - (clock() - loopStart);
    const timeoutMs = Math.min(config.tools?.callTimeoutMs ?? CALL_TIMEOUT_MS, Math.max(LOOP_MIN_CALL_MS, left));
    const refs = {
      idByIndex: current.idByIndex,
      history: current.history,
      channelHandles: current.channelHandles,
      timeoutMs,
    };
    const outcomes: Array<Untyped> = new Array(plans.length);
    let at = 0;
    for (const segment of segments(plans, isRead)) {
      const made = await Promise.all(
        segment.calls.map(async (plan) => {
          const { skill } = plan.call;
          if (plan.refusal) {
            const result = {
              skill,
              status: refusalStatus(plan.refusal.code),
              code: plan.refusal.code,
              ...(plan.refusal.reason ? { reason: plan.refusal.reason } : {}),
            };
            return {
              call: plan.call,
              outcome: {
                verdict: { stage: 'plan', ok: false, code: plan.refusal.code, reason: plan.refusal.reason ?? '' },
                executed: null,
                result,
              },
              ms: 0,
            };
          }
          const started = clock();
          let outcome;
          try {
            outcome = await onCall(plan.call, refs);
          } catch (err) {
            log.warn('sandbox: tool call threw', { skill, error: objOf(err).message ?? String(err) });
            outcome = null;
          }
          if (!outcome?.result)
            outcome = {
              verdict: { stage: 'command', ok: false, code: CODE.ERROR, reason: '' },
              executed: null,
              result: { skill, status: 'failed', code: CODE.ERROR },
            };
          return { call: plan.call, outcome, ms: clock() - started };
        })
      );
      made.forEach((item, i) => {
        outcomes[at + i] = item;
      });
      at += segment.calls.length;
    }
    current.calls = outcomes;
    if (signal?.aborted) {
      stopped = true;
      break;
    }
    const results = outcomes.map(({ outcome }) => outcome.result);

    // 2. Her speech: out after the calls when every one worked and needs no reading, else held (a final answer's with calls always).
    const verdict = stepVerdict(
      results.map((result) => ({ name: result.skill, result })),
      { definitionOf }
    );
    const speak = isFinal ? false : verdict.speak;
    current.held = !speak && speechItems > 0;

    // 3. What follows: a request when something is left to read and room is left.
    const after = roomLeft({
      step,
      maxSteps: settings.maxSteps,
      elapsedMs: clock() - loopStart,
      timeBudgetMs: settings.timeBudgetMs,
    });
    const stoppedAll = results.some((result) => result.code === CODE.SKILLS_OFF);
    if (isFinal || stoppedAll || !verdict.fresh || after.next === 'none') break;

    // 4. The request: the messages so far, her answer, a result for every call, the note.
    const detailOf = (result: Untyped) =>
      callReason(
        {
          detail: outcomeDetail(result, {
            argNames: definitionOf(result.skill)?.dispatch?.options?.map((option: Untyped) => option.name) ?? null,
          }),
        },
        labels
      );
    const texts = results.map((result, i) =>
      toolResultText(result, labels, {
        maxChars: resultCharsFor(result.skill, config),
        coerced: plans[i].coerced,
        rowsText: (rows: Untyped, labelsGiven: Untyped) => skillsInventoryText(rows, labelsGiven),
        reasonOf: detailOf,
      })
    );
    const diagnostics = (read.parsed.diagnostics ?? [])
      .map((diagnostic: Untyped) => diagnosticText(diagnostic, labels))
      .filter(Boolean)
      .map((line: Untyped) => `- ${line}`);
    const build = (last: Untyped, list: Untyped) =>
      appendStep({
        transport,
        messages,
        rawText: read.rawText,
        calls: records,
        results: list.map((text: string, i: Untyped) => ({ text, status: results[i]?.status })),
        note: stepNote({ labels, held: current.held, last, diagnostics }),
      });
    let last = after.next === 'final';
    let reason = last ? (step >= settings.maxSteps - 1 ? 'steps' : 'time') : null;
    let sent = build(last, texts);
    if (costOf(sent) > tokenLimit) {
      const excessChars = Math.ceil(((costOf(sent) - tokenLimit) * 3.5) / Math.max(0.1, calibrator.ratio));
      last = true;
      reason = 'tokens';
      sent = build(true, cutToFit(texts, excessChars));
      if (costOf(sent) > tokenLimit) {
        current.capped = 'tokens';
        break;
      }
    }
    const next = stepRecord(step + 1, { answer: null, thinkMissing: false });
    next.requestChars = requestChars(sent);
    loopSteps.push(next);
    const started = clock();
    let completion;
    try {
      completion = await llm.complete(sent, stepOptions(signal, toolset));
    } catch (err) {
      next.ms = clock() - started;
      if (signal?.aborted) {
        stopped = true;
        break;
      }
      const errorName = objOf(err).name;
      next.error = typeof errorName === 'string' ? errorName : 'Error';
      break;
    }
    next.ms = clock() - started;
    step += 1;
    messages = sent;
    if (last) finalReason = reason;
    read = readStep(completion, { toolset, step: step + 1, config, handles: request.handles, registry });
    next.answer = read.answer;
    next.thinkMissing = read.thinkMissing;
    next.usage = completion.usage ?? null;
    current = next;
  }
  run.loop.ms = clock() - sentAt;
  // The single-call fields of the run: the reply's first call, its extras, the first follow-up step.
  const replyCalls = first.calls;
  const firstCall = replyCalls[0] ?? null;
  const recordFirst = firstRead.calls[0] ?? null;
  const firstVerdict = firstCall?.outcome.verdict;
  run.call = firstCall && !firstVerdict?.stage?.startsWith('plan') ? firstCall.call : null;
  run.callError =
    recordFirst && !run.call ? (firstRead.calls.find((record: Untyped) => record.problem)?.problem ?? null) : null;
  run.extraCalls = first.dropped;
  run.outcome = firstCall?.outcome ?? null;
  const callText = run.call ? handleMentions(callTextOf(run.call), request.handles) : {};
  if (callText.mentions) run.callMentions = callText;
  const followed = loopSteps[1];
  if (followed) {
    run.refs.followUpIdByIndex = followed.idByIndex;
    run.followUp = followed.error
      ? { error: followed.error }
      : followed.answer
        ? {
            answer: followed.answer,
            extraCall: followed.dropped > 0 || followed.calls.length > 0,
            usage: followed.usage,
            continuation: true,
          }
        : null;
  }
  return { stopped };
}

/** The id of the `seq`-th line of hers at `ts`: 19 digits that sort by moment, then by `seq` (the millisecond times a million, plus `seq`). */
function ownLineId(ts: number, seq: number) {
  return (BigInt(Math.floor(ts)) * 1_000_000n + BigInt(seq)).toString();
}

/** A picture or a voice message she posted, as an attachment of her line: no file behind it, never described. */
function postedFile(lineId: Untyped, voice: boolean) {
  return {
    id: `${lineId}-${voice ? 'voice' : 'image'}`,
    kind: voice ? 'voice' : 'image',
    name: voice ? 'voice.ogg' : 'image.png',
    url: null,
    size: null,
    durationSec: null,
    width: null,
    height: null,
  };
}

/** `line` with her reaction `emoji` on it (a normalized reaction: `{ emoji, count, mine }`); kept as it is when she already reacted so. */
function withOwnReaction(line: Untyped, emoji: Untyped) {
  const reactions = Array.isArray(line.reactions) ? line.reactions : [];
  const same = reactions.find((reaction: Untyped) => reaction?.emoji === emoji);
  if (same?.mine) return line;
  const next = same
    ? reactions.map((reaction: Untyped) =>
        reaction === same ? { ...reaction, count: (Number(reaction.count) || 0) + 1, mine: true } : reaction
      )
    : [...reactions, { emoji, count: 1, mine: true }];
  return { ...line, reactions: next };
}

export function afterScenarioTurn({
  transcript,
  callMarks: earlier = [],
  run,
  at,
  selfId,
  selfName,
  channel,
  triggerId = null,
}: AfterScenarioTurnInput): {
  transcript: ReturnType<typeof continuationHistory>;
  callMarks: Array<Record<string, Untyped>>;
  posted: Array<string>;
} {
  const callMarks = Array.isArray(earlier) ? earlier : [];
  const placeId = String(channel.id);
  let lines = Array.isArray(transcript) ? [...transcript] : [];
  const own: Array<Untyped> = [];
  let seq = 0;
  const addLine = (ts: Untyped, fields: Untyped) => {
    seq += 1;
    const id = ownLineId(ts, seq);
    const line = {
      id,
      placeId,
      ts,
      authorId: String(selfId),
      content: '',
      ...(triggerId ? { triggerId: String(triggerId) } : {}),
      ...fields(id),
    };
    own.push(line);
    return line;
  };
  const known = (id: Untyped) =>
    typeof id === 'string' &&
    id !== '' &&
    (lines.some((line) => line?.id === id) || own.some((line) => line.id === id));
  const react = (id: Untyped, emoji: Untyped) => {
    if (!known(id) || typeof emoji !== 'string' || !emoji) return;
    lines = lines.map((line) => (line?.id === id ? withOwnReaction(line, emoji) : line));
    for (let i = 0; i < own.length; i += 1) if (own[i].id === id) own[i] = withOwnReaction(own[i], emoji);
  };
  const rendered = (text: string, handles: Untyped) => {
    const resolved =
      handles instanceof Map ? resolveHandles(text, handles) : { text: String(text ?? ''), accountIds: [] };
    // Her `#handle` links its channel as a live post does (the line keeps the `<#id>` and names the channel).
    const content = channelHandles instanceof Map ? linkChannels(resolved.text, [], channelHandles) : resolved.text;
    const placeIds = [...new Set(Array.from(content.matchAll(/<#(\d+)>/g), (match) => match[1]))];
    return {
      content,
      mentionedAccountIds: resolved.accountIds,
      ...(placeIds.length > 0 ? { mentionedChannelIds: placeIds } : {}),
    };
  };
  // One pass (a shaped answer) answered over `idByIndex`, its request sent at `start`.
  const pass = (answer: Untyped, idByIndex: Untyped, handles: Untyped, start: Untyped) => {
    if (!answer) return;
    const target = (n: number) => {
      const listed = n !== null && n !== undefined && idByIndex instanceof Map ? (idByIndex.get(n) ?? null) : null;
      return known(listed) ? listed : null;
    };
    const messages = Array.isArray(answer.messages) ? answer.messages : [];
    messages.forEach((message: Untyped, i: Untyped) => {
      addLine(start + (i + 1) * CONTINUATION_STEP_MS, () => ({
        ...rendered(message.text, handles),
        replyToId: target(message.replyTo),
      }));
    });
    for (const reaction of Array.isArray(answer.reactions) ? answer.reactions : [])
      react(target(reaction.to), reaction.emoji);
  };
  const refs = run?.refs ?? {};
  const channelHandles = refs.channelHandles ?? null;
  // What one call that passed leaves here at `callAt` (a post, a reaction), and its mark.
  const callEffects = (outcome: Untyped, callAt: Untyped) => {
    const executed = outcome.verdict?.ok === true ? outcome.executed : null;
    const args = executed?.args ?? {};
    const here = !args.place || String(args.place) === placeId;
    let postedId = null;
    // A call of a tool with the trait `posts` leaves a line of hers here.
    if (executed && here && typeof executed.skill === 'string' && hasTrait(executed.skill, 'posts')) {
      const reply = typeof args.reply === 'string' && known(args.reply) ? args.reply : null;
      const line =
        executed.skill === 'message.create'
          ? addLine(callAt, () => ({ ...rendered(args.text ?? '', refs.handles), replyToId: reply }))
          : addLine(callAt, (id: Untyped) => ({
              replyToId: reply,
              attachments: [postedFile(id, executed.skill === 'voice.say')],
            }));
      postedId = line.id;
    }
    if (executed?.skill === 'message.react.add' && here)
      react(args.message, typeof args.emoji === 'string' ? args.emoji.trim() : '');
    return callMarkOf({
      outcome,
      placeId,
      at: callAt,
      postedId,
      posted: own.map((line) => line.id),
    });
  };
  // The turn's steps: every step's posted speech (a held step's is not in the chat), then its calls' effects and marks,
  // in order. Her `#n` in a later step names the first request's lines: the request is never rebuilt.
  const marks = [];
  let cursor = at;
  // A run without its loop record (a single reply, a call and a follow-up) is read as the steps it was.
  const steps: Array<{ answer: Untyped; calls?: Array<Untyped>; idByIndex?: Untyped; held?: boolean }> = Array.isArray(
    run?.loop?.steps
  )
    ? run.loop.steps
    : [
        {
          answer: run?.answer,
          calls: run?.call && run?.outcome ? [{ outcome: run.outcome }] : [],
          idByIndex: refs.idByIndex,
        },
        ...(run?.followUp?.answer
          ? [{ answer: run.followUp.answer, calls: [], idByIndex: refs.followUpIdByIndex ?? refs.idByIndex }]
          : []),
      ];
  for (const step of steps) {
    const { answer } = step;
    if (answer && step.held !== true) {
      pass(answer, step.idByIndex ?? refs.idByIndex, refs.handles, cursor);
      cursor += ((answer.messages?.length ?? 0) + 1) * CONTINUATION_STEP_MS;
    }
    for (const { outcome } of step.calls ?? []) {
      if (!outcome?.result) continue;
      cursor += CONTINUATION_STEP_MS;
      marks.push(callEffects(outcome, cursor));
    }
  }
  const posted = own.map((line) => line.id);
  return {
    transcript: continuationHistory({ history: lines, own, selfName }),
    callMarks: [...callMarks, ...marks.map((mark) => ({ ...mark, posted }))],
    posted,
  };
}

/**
 * A line of the persona's seeded into a skill scenario (scripts/replay.ts `--skills`, a step
 * `{ self }` or a burst item `{ self: true }`): `text` as if she had said it at `at` in
 * `channel`, no turn run for it. Shaped exactly as afterScenarioTurn shapes her live lines
 * (src/behavior/turn.ts#continuationHistory, `selfName` as author; its id a snowflake of its
 * moment), the text as given with `mentionedAccountIds` the members its `<@id>` tags name
 * (src/memory/mentions.ts#tokenIds) -- and, since no turn posted it, no link to a trigger and no
 * call mark. Pure.
 */
export function seededSelfLine({
  text,
  at,
  selfId,
  selfName,
  channel,
}: SeededSelfLineInput): ReturnType<typeof continuationHistory>[number] {
  const content = String(text ?? '');
  const line = {
    id: ownLineId(at, 1),
    placeId: String(channel.id),
    ts: at,
    authorId: String(selfId),
    content,
    mentionedAccountIds: tokenIds(content),
    replyToId: null,
  };
  return continuationHistory({ history: [], own: [line], selfName })[0];
}

/** The pending queue's cap when `mention.maxPending` is not set (config.json's value). */
const MAX_PENDING = 6;

/**
 * The turns one step of a skill scenario gets when its messages (`incoming`, normalized lines in
 * arrival order, all of one channel) come in a burst, as the live queue gives them
 * (src/behavior/pipeline.ts, src/behavior/pending.ts). How each message calls her is read as the
 * live pipeline reads it (src/behavior/mention.ts#detectTrigger:
 * a tag of hers among `mentionedAccountIds`, a reply to a line of hers in `history` or the burst); a message that
 * does not call her is a
 * follow-up the address classifier said `yes` to (it is never asked here). The first message finds
 * her attention free and starts a turn; the rest come in while that turn runs: a call waits in the
 * queue (addPending, `mention.maxPending` the cap: the oldest waiting entry is `dropped`, reason
 * `full`), a follow-up takes the channel's one follow-up slot (followUpSlot: a newer one takes an
 * older one's place, which is `replaced` -- live, a missed-answer candidate -- by the newer's id).
 * The queue is then drained oldest first (popOldest), each entry its own turn. Each turn's
 * `queued` is what still waits besides it, arrival order, as src/pipeline/pending-queue.ts#queuedFor lists
 * it: the trigger author's own as `{ id, text }`, another member's as `{ id, text, author }`
 * (their display name), the text on one line cut to `MAX_MESSAGE_CHARS`. Not modelled: the
 * address classifier, the per-author rail, the merge classifier folding a call into an earlier one, a follow-up's window and
 * staleness checks. Pure; nothing handed in is changed.
 */
export function burstTurns(
  incoming: Array<Untyped>,
  { selfId, config, history = [] }: { selfId: string; config: Record<string, Untyped>; history?: Array<Line> }
): BurstTurnsResult {
  const lines = (Array.isArray(incoming) ? incoming : []).filter(Boolean);
  if (lines.length === 0) return { turns: [], replaced: [], dropped: [] };
  const self = String(selfId);
  const herLines = new Set(
    [...(Array.isArray(history) ? history : []), ...lines].filter((line) => line?.self === true).map((line) => line.id)
  );
  const kindOf = (line: Untyped) =>
    detectTrigger({
      mentionsSelf: (line.mentionedAccountIds ?? []).includes(self),
      repliesToSelf: Boolean(line.replyToId) && herLines.has(line.replyToId),
    }) ?? 'followUp';
  const maxPending = config?.mention?.maxPending ?? MAX_PENDING;
  const maxChars = MAX_MESSAGE_CHARS;
  const [first, ...rest] = lines;
  let pending: Array<PendingPing> = [];
  const replaced: Array<{ id: string; by: string }> = [];
  const dropped: Array<{ id: string; reason: string }> = [];
  for (const line of rest) {
    const kind = kindOf(line);
    const placeId = String(line.placeId ?? '');
    const slot = followUpSlot(pending, placeId, kind);
    if (!slot.admit) continue;
    const displaced = slot.replaced;
    if (displaced) {
      pending = pending.filter((ping) => ping !== displaced);
      replaced.push({ id: displaced.trigger.id, by: line.id });
    }
    const { list, evicted } = addPending(
      pending,
      { placeId, trigger: line, kind, arrivedAt: Number(line.ts) || 0 },
      maxPending
    );
    pending = list;
    if (evicted) dropped.push({ id: evicted.trigger.id, reason: 'full' });
  }
  const queuedFor = (trigger: Untyped) =>
    pending
      .filter((ping) => ping.kind !== 'overheard' && ping.trigger.id !== trigger.id)
      .sort((a, b) => a.arrivedAt - b.arrivedAt)
      .map((ping) => ({
        id: ping.trigger.id,
        text: clampChars(oneLine(ping.trigger.content), maxChars),
        ...(ping.trigger.authorId === trigger.authorId ? {} : { author: oneLine(ping.trigger.authorName ?? '') }),
      }));
  const turns: Array<{
    line: Record<string, Untyped>;
    kind: PendingPing['kind'];
    queued: Array<{ id: string; text: string; author?: string }>;
  }> = [{ line: first, kind: kindOf(first), queued: queuedFor(first) }];
  while (pending.length > 0) {
    const next = popOldest(pending);
    pending = next.list;
    if (next.ping === null) break;
    turns.push({ line: next.ping.trigger, kind: next.ping.kind, queued: queuedFor(next.ping.trigger) });
  }
  return { turns, replaced, dropped };
}
