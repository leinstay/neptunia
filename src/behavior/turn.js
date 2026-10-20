// One "turn": collect context → build the request under the token cap → ask
// the model → act in Discord like a person would (pause, typing indicator
// proportional to the text, several short messages in a row, reactions).
// Used for answering a call ('reply') and for spontaneous turns
// ('interject' / 'initiate'), in a server channel or in a private chat (a
// channel without a guild, served on behalf of the one pinned guild). A
// server turn -- and a private chat, on its partner's behalf -- may also show
// other channels it is about (`<channel_view>`):
// the read-only channel a call came from, a channel named with an explicit
// <#id>, or one a route hook names. The turn still speaks only here: a
// reaction on a shown line of another channel lands in that channel, and a
// post (a message, the GIF, the picture) answering such a line goes here
// plain, with a jump link to it.

import { createHash, randomUUID } from 'node:crypto';
import { block, buildDiaryPlanRequest, buildRequest, classifierTranscript, continuesTurn, fillPromptTemplate, freezePerBucket, gifFieldChars, ownGifLines, skillResultBlock, stableThenTail, usesFollowUpTask, withSkillResult } from './prompt.js';
import {
  DIARY_DAILY,
  DIARY_PICTURES_DAILY,
  diaryTopic,
  gistOf,
  isPictureKind,
  isSetKind,
  parseSeedFamilies,
  pickSeeds,
  renderSeedsBlock,
  renderTopicBlock,
  setSettings,
  stripUrls,
  validatePlan,
  withoutPictureKinds,
} from './diary.js';
import { channelPullOn, pullSettings, pullTargets } from './pull.js';
import { audienceCovers, markSeen, messageLink, resolveDestination, stampPings } from './elsewhere.js';
import { isTaggedCall } from './mention.js';
import { resolveHandles } from './handles.js';
import { roleModel } from '../llm/roles.js';
import { RECALL_DEFAULTS, fallbackLookupPlan, parseLookupAnswer, recallSettings } from './recall.js';
import { parseSplitAnswer, splitCandidate, splitSettings } from './split.js';
import { captionedEntries, gifPickSettings, parseGifPick, pickCandidates, pickContext, renderGifLibrary } from './gif-pick.js';
import { turnRequestInput } from './turn-input.js';
import { DEFAULT_RESULT_MAX_CHARS, tasksBlockText, taskResultText } from '../errands/blocks.js';
import { DEFAULT_INTENTIONS_CAP, intentionsBlockText } from '../intentions/blocks.js';
import { parseJsonObject, parseOutput } from '../llm/parse.js';
import { DailyCapError, REPLY_REQUEST, TokenLimitError, cacheTtlMs, errorCodeOf, hedgeSettings, helperRequestOptions, railReason, sleep } from '../llm/openrouter.js';
import { ImageCapError, ImageGenError } from '../llm/images.js';
import { limitOf, mirrorChannelLabel, mirrorDryRun, postLimitNotice } from './limits.js';
import { between, typingMs } from './random.js';
import { startTypingLease } from '../interface/typing.js';
import { settleWait } from './activity.js';
import {
  collectPictures,
  collectEmojiItems,
  collectVideos,
  collectReadableLinks,
  isDescribable,
  lateVideoStates,
} from '../media/classify.js';
import { createImageFetcher } from '../media/fetch-image.js';
import { createDrawingTool, drawPicture, drawPromptOf } from '../errands/tools.js';
import { renderCustomEmoji, resolveReactionEmoji } from './emoji.js';
import { fill, replyMarker, withCalls, withTriggers } from '../format.js';
import { log } from '../log.js';
import { clampChars, clampWithEllipsis, countDashes, oneLine, stripDashes } from '../memory/clamp.js';
import { gifPostsToday, rankGifs, participationSettings, recordOwnLine, isVideoVisionOn, toRecordLine, createOffPeriodsReader } from '../memory/index.js';
import { linkChannels, linkMessageNumbers, outsideUrls } from '../memory/mentions.js';
import { foldText, liveRecent, recentSettings } from '../memory/recent.js';
import { createParticipationPicker, participationEpisodeOffer } from './participation-pick.js';
import { askPlanner, parsePlannerAnswer, parseRewatchPickDetailed, plannerOn } from './planner.js';
import { routeAllowed, routeCandidate, routeSettings } from './route.js';
import { routeChannelOffer } from './route-channel.js';
import { deletedLinesMax, deletedLinesOf, withDeletedLines } from './deleted-lines.js';
import { freshAttachmentUrl as sharedFreshAttachmentUrl, gifPostUrl, countGifPost } from '../media/gif-post.js';
import { DAY_MS, bumpDaily, countToday, utcDay, zonedDay } from '../time.js';
import { isPlainObject } from '../config.js';
import { budgetDrops } from '../llm/budget.js';
import { createLimits } from '../llm/limits.js';
import { checkReplyEffect, checkSkill, listSkills } from '../skills/gateway.js';
import { coreToolRows, discoveryOn, grantedSkillNames, proposalVerdicts, proposedRows, skillsIndex } from '../skills/discovery.js';
import { skillFeatureOn, skillsOn } from '../skills/access.js';
import { skillRegistry } from '../skills/registry.js';
import { executeCall, needsFollowUp, outcomeDetail, refusalStatus, resolveCall } from '../skills/executors.js';
import { IN_TURN_TOOLS, firstLinkIn, lookPerTurn, runMediaLook, runMemorySearch, runWebRead, runWebSearch } from '../skills/tools.js';
import { prefetchLanes, prefetchOn, wakeLanes } from './prefetch.js';
import { FACTS_SHOWN_MAX, POSTING_SKILLS, createLocalFacts, factPayload, innerSettings } from './inner.js';
import { innerOutputCalls } from './inner-output.js';
import { SOURCE_CHARS_MAX, lineSourcesOf, textsOf } from '../intentions/sources.js';
import { intentionSettings, isIntentionId } from '../intentions/model.js';
import { WAKE_PURPOSE_CHARS } from './wake.js';
import { feedbackInTurnText, placesBlockText, wakeBlockText } from './wake.js';
import { CODE } from '../skills/codes.js';

/**
 * How a turn ended. `spoke` and `skip` reached the model (a skip chose
 * silence); `busy` (another turn blocks this one), `paused` (`/nep pause`),
 * `not-now` (a spontaneous chooser found nothing to do) never did; `refused`
 * is a rail (request or token cap) and carries its `limit`; `error` is any
 * other failure, logged -- a turn dropped unposted at its bar
 * (pace.dropAfterMs, `turn: dropped`) included.
 * @typedef {'spoke'|'skip'|'busy'|'refused'|'paused'|'not-now'|'error'} TurnOutcome
 */

/**
 * The `reason` codes of a `skip` outcome, journaled with the turn: she chose not to speak (an
 * explicit skip, or an answer with nothing to act on), or an inner turn (mode `inner`,
 * src/behavior/inner.js) ended with no action of hers -- silence is a valid answer there.
 */
export const SKIP_SILENCE = 'silence';
export const SKIP_NOTHING_TO_DO = 'nothing-to-do';

/**
 * Why a reply turn runs: a `@mention`, a Discord reply to the persona, a
 * name trigger, a follow-up the address classifier said "yes" to, a line the
 * address classifier found to be about the persona but said to someone else
 * or to the room (`overheard`), a private chat message, the second turn
 * after a drawing that failed, or a message to the persona left unanswered
 * earlier (`missed`, src/behavior/missed.js). Each has a `labels.triggers` entry.
 * @typedef {'mention'|'reply'|'name'|'followUp'|'overheard'|'private'|'drawFailed'|'missed'|'task'} TriggerKind
 */

/**
 * Whether a turn of `triggerKind` posts plain, never as a Discord reply: the
 * address classifier's turns (a follow-up, an overheard line), whose model
 * `reply="#n"` quotes nothing for messages, the GIF and the picture alike (a
 * pulled line it points at still gets its jump link: replyTarget). The
 * drawFailed turn after such a turn posts plain too: runTurn hands it the
 * first turn's kind. Exported so a limit notice can quote by the same rule.
 * @param {TriggerKind|null|undefined} triggerKind
 * @returns {boolean}
 */
export function postsPlain(triggerKind) {
  return triggerKind === 'followUp' || triggerKind === 'overheard';
}

/** `pace` when a key is missing: config.json's values. */
const PACE_FALLBACK = Object.freeze({ prepareMs: 6000, prepareSearchMs: 18000, prepareMediaMs: 20000, dropAfterMs: 120000, replyHedgeMs: 30000, typingWhilePreparing: false, unpromptedWaits: true, settleMs: 3000, settleMaxMs: 8000 });

/** The longest single pause of a settle wait: the author's activity is read again after it. */
const SETTLE_STEP_MS = 250;

/**
 * The pace of a turn's preparation, read from `config` (the live config):
 * `prepareMs`, how long everything before the reply request may take, counted
 * from the turn's start; `prepareSearchMs`, the longer limit once the search
 * classifier asked for a web or server search (never shorter than
 * `prepareMs`), and the longest the turn waits past `prepareMs` for that
 * classifier's verdict (null: no wait; it stops at once on a verdict asking
 * for no search); `prepareMediaMs`, the longer limit of a direct call whose own
 * message (or the message it replies to) brought a picture, a GIF or a video
 * the turn describes or watches (never shorter than `prepareMs`; with both,
 * the larger of the two; null = no such extension); `dropAfterMs`, the bar a
 * turn's answer must be in hand by,
 * counted from the turn's start, past which the turn is dropped unposted;
 * `replyHedgeMs`, how long the reply request of a turn with a bar is given
 * before a second, identical one is sent (the first answer wins);
 * each a positive number of milliseconds, or null -- no deadline, wait for
 * everything; no bar; no second request -- for 0, a negative value or a
 * non-number. A missing key takes config.json's value. `typingWhilePreparing` (only exactly true
 * turns it on; off as shipped): the typing indicator from the start of a turn
 * answering a direct call until its answer is in hand. Off, the indicator
 * shows only while the finished answer is being typed out, as before.
 * `unpromptedWaits` (a missing key counts as on; only false turns it off): a
 * turn nobody waits for (unhurried) gets neither the deadline nor the bar --
 * it waits for every stage and posts once ready. Off, every turn keeps the same
 * deadline and bar. `settleMs`: how long the author of a turn answering a person must have
 * been quiet before the turn reads the channel (0 = no wait, also for a negative value or a
 * non-number); `settleMaxMs`: the longest that wait runs, counted from the author's trigger
 * message (null for 0, a negative value or a non-number: one settle from it). A missing key
 * takes config.json's value.
 * @param {object} config
 * @returns {{ prepareMs: number|null, prepareSearchMs: number|null, prepareMediaMs: number|null,
 *   dropAfterMs: number|null, replyHedgeMs: number|null, typingWhilePreparing: boolean, unpromptedWaits: boolean,
 *   settleMs: number, settleMaxMs: number|null }}
 */
export function paceSettings(config) {
  const pace = isPlainObject(config?.pace) ? config.pace : {};
  const limit = (value, fallback) => {
    if (value === undefined) return fallback;
    return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : null;
  };
  return {
    prepareMs: limit(pace.prepareMs, PACE_FALLBACK.prepareMs),
    prepareSearchMs: limit(pace.prepareSearchMs, PACE_FALLBACK.prepareSearchMs),
    prepareMediaMs: limit(pace.prepareMediaMs, PACE_FALLBACK.prepareMediaMs),
    dropAfterMs: limit(pace.dropAfterMs, PACE_FALLBACK.dropAfterMs),
    replyHedgeMs: limit(pace.replyHedgeMs, PACE_FALLBACK.replyHedgeMs),
    typingWhilePreparing: pace.typingWhilePreparing === true,
    unpromptedWaits: pace.unpromptedWaits !== false,
    settleMs: limit(pace.settleMs, PACE_FALLBACK.settleMs) ?? 0,
    settleMaxMs: limit(pace.settleMaxMs, PACE_FALLBACK.settleMaxMs),
  };
}

/** skills.loop's values when a key is missing (config.json's). */
const LOOP_FALLBACK = Object.freeze({ maxSteps: 3, timeBudgetMs: 20000, maxCallsPerStep: 4 });
/** The least time one call of the tool loop gets, whatever is left of its budget. */
const LOOP_MIN_CALL_MS = 2000;
/**
 * The terminal actions of an inner turn (docs/inner-life.md): the one call its last loop step
 * still runs -- a post, or a change of an intention of hers. A read or any other skill on the
 * last step is dropped as on every turn.
 */
const INNER_TERMINAL_SKILLS = Object.freeze(['message.create', 'intent.set', 'intent.update', 'intent.cancel']);
/** An inner turn's loop end state when no tool loop ran (`inner.loop`). */
const NO_LOOP = Object.freeze({ steps: 0, cut: null, droppedCalls: 0 });
/** The intention calls of an inner turn that name an intention (`id`, or the id alone in the body). */
const INTENT_ID_SKILLS = Object.freeze(['intent.update', 'intent.cancel']);

/**
 * Whether the persona's own tools drive her turn (features.coreTools exactly true; tracked
 * default false): the bounded tool loop (createTurnRunner's toolLoop), her in-turn tools
 * (`web.search`, `web.read`, `media.look`, `memory.search`), no search classifier before her
 * reply and no re-watch classifier (her own `media.look` instead). Read at the moment of use. Pure.
 * @param {object} config
 * @returns {boolean}
 */
export function coreToolsOn(config) {
  return config?.features?.coreTools === true;
}

/**
 * The tool loop's bounds under `config` (`skills.loop`, read by the caller now): `maxSteps`, the
 * most follow-up requests after her calls in one turn (a whole number of at least 1);
 * `timeBudgetMs`, how long the loop may run from its first call before the next request is
 * her last (a positive number); `maxCallsPerStep`, the most calls of one answer that run (a
 * whole number of at least 1; the rest are dropped and logged). A missing or unusable value
 * takes config.json's. An inner turn (`inner`: mode `inner`, docs/inner-life.md) has its own
 * bounds, `innerLife.loop` (src/behavior/inner.js#innerSettings; nobody waits for it, so its
 * budget is generous): the same three, plus `callTimeoutMs`, the most one call of hers may run.
 * `skills.loop` never
 * reaches an inner turn, `innerLife.loop` never an ordinary one. Pure.
 * @param {object} config
 * @param {{ inner?: boolean }} [options]
 * @returns {{ maxSteps: number, timeBudgetMs: number, maxCallsPerStep: number, callTimeoutMs?: number }}
 */
export function loopSettings(config, { inner = false } = {}) {
  if (inner) return { ...innerSettings(config).loop };
  const loop = isPlainObject(config?.skills?.loop) ? config.skills.loop : {};
  const whole = (value, fallback) => (Number.isInteger(value) && value >= 1 ? value : fallback);
  return {
    maxSteps: whole(loop.maxSteps, LOOP_FALLBACK.maxSteps),
    timeBudgetMs: typeof loop.timeBudgetMs === 'number' && Number.isFinite(loop.timeBudgetMs) && loop.timeBudgetMs > 0 ? loop.timeBudgetMs : LOOP_FALLBACK.timeBudgetMs,
    maxCallsPerStep: whole(loop.maxCallsPerStep, LOOP_FALLBACK.maxCallsPerStep),
  };
}

/** The stages of a turn's preparation, in the order `turn: timings` names them. */
const PREPARE_STAGES = Object.freeze(['history', 'previews', 'captions', 'videos', 'rewatch', 'links', 'lookup', 'neighbors', 'pulled', 'participation']);

/**
 * The trigger kinds that are a direct call (a private chat message included): the typing
 * indicator may show while such a turn prepares and waits for its answer, and its preparation
 * keeps the deadline and the bar (see unhurried).
 */
const DIRECT_CALLS = new Set(['mention', 'reply', 'name', 'followUp', 'private']);

/**
 * The most characters of a skill result's data the follow-up request carries, read from `config`: a
 * memory.search result is cut by the tool itself, window by window, at `recall.quoteMaxChars`, and
 * is bounded there; every other result at `skills.resultMaxChars`.
 */
function resultCharsFor(result, config) {
  if (result?.skill === 'memory.search') return recallSettings(config)?.quoteMaxChars ?? RECALL_DEFAULTS.quoteMaxChars;
  return config?.skills?.resultMaxChars ?? 4500;
}

/**
 * Whether nobody waits for a turn of `triggerKind` -- a spontaneous one (no trigger kind: an
 * interject, an initiate, a noticed comment, a forced turn) or an overheard line -- so that, with
 * `pace.unpromptedWaits` on, it prepares without a deadline or a bar. A drawFailed turn answers
 * the direct call before it and keeps that call's pace.
 * @param {TriggerKind|null} triggerKind
 * @param {{ unpromptedWaits: boolean }} pace  paceSettings of the turn's config.
 * @returns {boolean}
 */
function unhurried(triggerKind, pace) {
  return pace.unpromptedWaits && triggerKind !== 'drawFailed' && !DIRECT_CALLS.has(triggerKind);
}

/** What a turn throws to itself once its bar (pace.dropAfterMs) has passed: caught by runTurnOnce. */
const TOO_SLOW = Symbol('too-slow');

// Discord shows a typing indicator for about ten seconds: it is sent again before it fades.
const PREPARE_TYPING_REFRESH_MS = 8000;

// How many of the persona's posted messages keep the link to their turn's trigger in process
// (far more than two days of her lines; the oldest go first).
const TRIGGER_LINKS_MAX = 5000;

// How many of the persona's skill calls her transcript lines keep showing, in process (far more
// than two days of them; the oldest go first), and how many of her posts keep the channel of the
// turn that posted them from elsewhere.
const CALL_MARKS_MAX = 500;
const POSTED_FROM_MAX = 2000;

/** The real timer behind createTurnRunner's `schedule`: `fn` once after `ms`; resolves a cancel function. */
function scheduleTimer(fn, ms) {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
}

/**
 * One stage of a turn's preparation: `work()` started now, its outcome kept
 * on the returned record once it settles -- `value` (undefined after a
 * failure, which `onError` hears of), `ms` since `startedAt` on `clock`, and
 * `done`. `settled` never rejects, so a stage the turn no longer waits for
 * can never surface as an unhandled rejection.
 * @param {() => unknown} work
 * @param {{ clock: () => number, startedAt: number, onError: (err: unknown) => void }} options
 * @returns {{ done: boolean, value: unknown, ms: number|null, settled: Promise<void> }}
 */
function trackStage(work, { clock, startedAt, onError }) {
  const stage = { done: false, value: undefined, ms: null, settled: null };
  stage.settled = new Promise((resolve) => resolve(work()))
    .then(
      (value) => {
        stage.value = value;
      },
      (err) => {
        try {
          onError(err);
        } catch {
          // A failing log line never fails the stage.
        }
      },
    )
    .then(() => {
      stage.ms = clock() - startedAt;
      stage.done = true;
    });
  return stage;
}

/**
 * The deadline of a turn's preparation: `reached` resolves once `limitMs`
 * (counted from `startedAt` on `clock`; null = no deadline, never) has
 * passed. `extend(ms)` moves it to a later limit (null lifts it) while it has
 * not passed; `hold(work, ms)`, while it has not passed and has a limit, keeps
 * it from passing until `work` (a promise) settles, at most until `ms` (counted
 * the same way; null or not later than the limit: no hold; one hold at a
 * time): a limit that passed meanwhile passes as soon as `work` settles,
 * unless an `extend` moved it later first. `close()` ends it -- `passed` turns
 * true and the timer is cleared -- once the turn goes on. `leftMs()`: the time
 * left to its limit now (0 once that passed, a hold aside), null without a
 * limit. Also the turn's bar (pace.dropAfterMs).
 * @param {{ clock: () => number, startedAt: number, schedule: (fn: () => void, ms: number) => () => void,
 *   limitMs: number|null }} options
 */
function createDeadline({ clock, startedAt, schedule, limitMs }) {
  let passed = false;
  let limit = null;
  let cancel = null;
  // While a hold is on: the latest limit it allows; `due` once the limit passed under it.
  let holdUntil = null;
  let due = false;
  let release;
  const reached = new Promise((resolve) => {
    release = resolve;
  });
  const fire = () => {
    cancel = null;
    passed = true;
    release();
  };
  const arm = (ms) => {
    cancel?.();
    cancel = null;
    limit = ms;
    due = false;
    if (ms === null) return;
    cancel = schedule(() => {
      cancel = null;
      if (holdUntil !== null && holdUntil > ms) {
        // Held: wait for the work, at most until the hold's own limit.
        due = true;
        cancel = schedule(fire, Math.max(0, holdUntil - (clock() - startedAt)));
        return;
      }
      fire();
    }, Math.max(0, ms - (clock() - startedAt)));
  };
  arm(limitMs);
  return {
    reached,
    get passed() {
      return passed;
    },
    leftMs() {
      if (limit === null) return null;
      return passed ? 0 : Math.max(0, limit - (clock() - startedAt));
    },
    extend(ms) {
      if (passed || limit === null) return;
      if (ms === null || ms > limit) arm(ms);
    },
    hold(work, ms) {
      if (passed || limit === null || ms === null || ms <= limit || holdUntil !== null) return;
      holdUntil = ms;
      const end = () => {
        holdUntil = null;
        if (due && !passed) {
          cancel?.();
          fire();
        }
      };
      Promise.resolve(work).then(end, end);
    },
    close() {
      passed = true;
      cancel?.();
      cancel = null;
    },
  };
}

/**
 * Whether someone asked for this turn: it has a trigger that is not an
 * overheard line (talk about the persona asks it nothing). An unasked turn
 * gets no image-cap notice and no drawFailed turn, and charges no member's
 * picture quota -- like a spontaneous turn.
 */
function askedFor(trigger, triggerKind) {
  return Boolean(trigger) && triggerKind !== 'overheard';
}

/**
 * The `<transcript>` block of a classifier request (re-watch, search): the
 * last `contextMessages` messages of `history` before the trigger, rendered
 * by src/behavior/prompt.js#classifierTranscript (as the route classifier's)
 * with the media states the caller already has, plus the trigger's text cut to
 * `context.maxMessageChars`. `transcriptBlock` is '' (no block) for a
 * window of 0 or no earlier message. Pure.
 * @returns {{ triggerText: string, transcriptBlock: string }}
 */
function renderClassifierContext({ config, labels, selfName, history, trigger, contextMessages, descriptions, videos, reads }) {
  const triggerText = [...String(trigger.content ?? '')].slice(0, config.context?.maxMessageChars ?? 2000).join('');
  const context = contextMessages > 0 ? history.filter((m) => m.id !== trigger.id).slice(-contextMessages) : [];
  if (context.length === 0) return { triggerText, transcriptBlock: '' };
  const body = classifierTranscript(context, { config, selfName, labels, descriptions, videos, reads });
  return { triggerText, transcriptBlock: `<transcript>\n${body}\n</transcript>\n` };
}

/**
 * The user message of the search classifier (prompts.lookup) as a live turn
 * sends it (createTurnRunner's maybeLookup): the `<transcript>` of the last
 * `web.search.contextMessages` (50 when missing) messages of `history` before
 * `trigger` (renderClassifierContext, `labels` = prompts.labels), then the
 * trigger as `<candidate>` with its author's name. Exported so
 * tools/search-policy-eval.mjs measures exactly what production sends. Pure.
 * @param {{ config: object, labels: object, selfName: string, history: object[], trigger: object,
 *   descriptions?: Map<string, unknown>, videos?: Map<string, unknown>, reads?: Map<string, unknown> }} params
 * @returns {{ triggerText: string, transcriptBlock: string, user: string }}
 */
export function lookupClassifierInput({ config, labels, selfName, history, trigger, descriptions, videos, reads }) {
  const contextMessages = Math.max(0, Math.floor(config.web?.search?.contextMessages ?? 50));
  const { triggerText, transcriptBlock } = renderClassifierContext({ config, labels, selfName, history, trigger, contextMessages, descriptions, videos, reads });
  return { triggerText, transcriptBlock, user: `${transcriptBlock}<candidate>\n${trigger.authorName}: ${triggerText}\n</candidate>` };
}

// The server search on a question's own words lives with the recall planning (src/behavior/recall.js).
export { fallbackLookupPlan };

/**
 * The name matching of features.mentionHandles off (kept for rollback; with it on, renderPost
 * resolves only `@handle`, src/behavior/handles.js#resolveHandles).
 * Turn `@nick` written by the model into real mentions for people the request showed: the
 * authors of `history` (the lines shown), then the stored names in `knownNames` (the members
 * whose profile the request showed, the authors of the pulled lines shown). A transcript
 * author wins a name a stored profile shares, the last author of a display name wins, and of
 * two stored profiles sharing a name the first handed over wins. Longer names are matched
 * first, so a multi-word name is never cut at a shorter one it starts with. A URL in the text
 * is left exactly as written (src/memory/mentions.js#outsideUrls).
 * What is left falls back to `directory` (mentionDirectory: every member of the served guild
 * the bot knows): matched case-insensitively, longest first, only as a whole name (no letter,
 * digit or underscore right after it); a name one of the request's own sources gives in any
 * case keeps that member, any other resolves only when exactly one member carries it, and a
 * name two or more members share stays text.
 * @param {string} text
 * @param {object[]} history  Normalized lines (`authorName`, `authorId`, `self`, `bot`).
 * @param {Iterable<{ name: string, id: string }>} [knownNames]
 * @param {Iterable<{ name: string, id: string }>} [directory]
 * @returns {{ text: string, userIds: string[] }}  `userIds`: the members pinged (allowedMentions).
 */
export function resolveMentions(text, history, knownNames = [], directory = []) {
  const people = new Map();
  for (const { name, id } of knownNames) {
    if (typeof name !== 'string' || !name.trim() || id === undefined || id === null || people.has(name)) continue;
    people.set(name, String(id));
  }
  for (const message of history) {
    if (!message.self && !message.bot && message.authorName) people.set(message.authorName, message.authorId);
  }
  const names = [...people.keys()].sort((a, b) => b.length - a.length);
  const fallback = fallbackNames(people, directory);
  const userIds = new Set();
  // An `@name` inside a URL (a channel handle on a video site) is part of the address.
  const resolved = outsideUrls(text, (part) => {
    let out = part;
    for (const name of names) {
      if (!out.includes(`@${name}`)) continue;
      out = out.replaceAll(`@${name}`, `<@${people.get(name)}>`);
      userIds.add(people.get(name));
    }
    return fallback.size > 0 ? resolveFallback(out, fallback, userIds) : out;
  });
  return { text: resolved, userIds: [...userIds] };
}

/**
 * The fallback's case-folded names (resolveMentions) → the one member each resolves to, or
 * null when it stays text: a name the request's own sources (`people`) give in any case keeps
 * their member (null when they give it to two), else the one directory member carrying it
 * (null when two or more do).
 * @param {Map<string, string>} people  The request's own names → member ids.
 * @param {Iterable<{ name: string, id: string }>} directory
 * @returns {Map<string, string|null>}
 */
function fallbackNames(people, directory) {
  const idsOf = (pairs) => {
    const byKey = new Map();
    for (const [name, id] of pairs) {
      if (typeof name !== 'string' || !name.trim() || id === undefined || id === null) continue;
      const key = name.toLowerCase();
      if (!byKey.has(key)) byKey.set(key, new Set());
      byKey.get(key).add(String(id));
    }
    return byKey;
  };
  const listed = idsOf([...directory].map((entry) => [entry?.name, entry?.id]));
  if (listed.size === 0) return new Map();
  const shown = idsOf(people);
  const fallback = new Map();
  for (const [key, ids] of listed) {
    const owners = shown.get(key) ?? ids;
    fallback.set(key, owners.size === 1 ? [...owners][0] : null);
  }
  return fallback;
}

/**
 * `part` (outside URLs, after the exact pass) with every whole `@name` of `fallback` that
 * resolves turned into a mention, longest first; the members mentioned are added to `userIds`.
 * A mention already made (`<@id>`) is never matched again.
 */
function resolveFallback(part, fallback, userIds) {
  const lower = part.toLowerCase();
  const candidates = [...fallback.keys()].filter((key) => fallback.get(key) !== null && lower.includes(`@${key}`));
  if (candidates.length === 0) return part;
  candidates.sort((a, b) => b.length - a.length);
  const escaped = candidates.map((key) => key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'));
  const pattern = new RegExp(`(?<!<)@(?:${escaped.join('|')})(?![\\p{L}\\p{N}_])`, 'giu');
  return part.replace(pattern, (match) => {
    const id = fallback.get(match.slice(1).toLowerCase());
    if (!id) return match;
    userIds.add(id);
    return `<@${id}>`;
  });
}

/**
 * The fallback directory `@name` resolves by after the request's own sources (resolveMentions):
 * every name of every member of the served guild the bot knows without asking Discord -- the
 * guild's member cache (`members`: display name, nickname, global name, username) and the
 * stored profiles (`profiles`: names and aliases). Never a bot (by the cache) nor the persona
 * herself (`selfId`).
 * @param {{ members?: Iterable<object>, profiles?: Iterable<object>, selfId?: string|null }} [sources]
 *   `members`: discord.js GuildMembers; `profiles`: stored member profiles (store.listUserProfiles).
 * @returns {{ name: string, id: string }[]}
 */
export function mentionDirectory({ members = [], profiles = [], selfId = null } = {}) {
  const entries = [];
  const seen = new Set();
  const bots = new Set();
  const self = selfId === null || selfId === undefined ? null : String(selfId);
  const add = (name, id) => {
    if (typeof name !== 'string' || !name.trim()) return;
    const key = `${id}\u0000${name}`;
    if (seen.has(key)) return;
    seen.add(key);
    entries.push({ name, id });
  };
  const cached = [...members].filter((member) => member && typeof member === 'object');
  for (const member of cached) {
    const id = member.id ?? member.user?.id;
    if (id !== undefined && id !== null && member.user?.bot === true) bots.add(String(id));
  }
  const counts = (id) => id !== undefined && id !== null && String(id) !== self && !bots.has(String(id));
  for (const member of cached) {
    const id = member.id ?? member.user?.id;
    if (!counts(id)) continue;
    for (const name of [member.displayName, member.nickname, member.user?.globalName, member.user?.username]) add(name, String(id));
  }
  for (const profile of profiles) {
    if (!profile || typeof profile !== 'object' || !counts(profile.id)) continue;
    for (const name of Array.isArray(profile.names) ? profile.names : []) add(name, String(profile.id));
    for (const alias of Array.isArray(profile.aliases) ? profile.aliases : []) add(alias?.name, String(profile.id));
  }
  return entries;
}

/**
 * The stored names `@name` may resolve by besides the transcript's display names (see
 * resolveMentions): every name of each member whose profile the request showed (`peopleShown`,
 * in its order), then every stored name of each author of the pulled lines shown -- those lines
 * carry the name Discord gave, often not the one the persona remembers them by.
 * @param {{ id: string, names: string[] }[]|undefined} peopleShown  buildRequest's `peopleShown`.
 * @param {object[]} shownLines  The pulled lines the request showed.
 * @param {(userId: string) => (object|null)} profileOf  The stored profile of a member, or null.
 * @returns {{ name: string, id: string }[]}
 */
function storedNames(peopleShown, shownLines, profileOf) {
  const known = [];
  for (const person of peopleShown ?? []) {
    for (const name of person.names) known.push({ name, id: person.id });
  }
  const authors = new Set();
  for (const line of shownLines) {
    if (line.self || line.bot || !line.authorId || authors.has(line.authorId)) continue;
    authors.add(line.authorId);
    const names = profileOf(line.authorId)?.names;
    if (Array.isArray(names)) for (const name of names) known.push({ name, id: line.authorId });
  }
  return known;
}

/**
 * Profiles of the people most recently active in the transcript, excluding `exceptId`.
 * Also used by the replay sandbox (src/behavior/sandbox.js) with a store-shaped reader.
 * @param {{ getUser: (guildId: string, userId: string) => (object|null) }} store
 * @param {string} guildId
 * @param {object[]} history
 * @param {string|undefined} exceptId
 * @param {number} count
 * @returns {object[]}
 */
export function pickOtherProfiles(store, guildId, history, exceptId, count) {
  const seen = new Set();
  const profiles = [];
  for (const message of [...history].reverse()) {
    if (message.self || message.bot || message.authorId === exceptId || seen.has(message.authorId)) continue;
    seen.add(message.authorId);
    const profile = store.getUser(guildId, message.authorId);
    if (profile) profiles.push(profile);
    if (profiles.length >= count) break;
  }
  return profiles;
}

/** No `<recent>` input: no store's lines handed over, so the request builder builds no block. */
const NO_RECENT = Object.freeze({ lines: undefined, audience: undefined });

/**
 * The audience of "every member of the server" in the shape
 * src/behavior/elsewhere.js#audienceCovers compares: @everyone views it and no
 * role or member is held back. A source covers it only when every member can
 * read that source -- the private chat's rail for recent lines.
 */
function everyMemberAudience() {
  return { everyone: true, roles: new Set(), roleAllow: new Set(), roleDeny: new Set(), memberAllow: new Set(), memberDeny: new Set() };
}

/** Display name of the author of `messageId` in `history`, or null when the message is not there. */
function authorNameFor(history, messageId) {
  const message = history.find((m) => m.id === messageId);
  return message?.authorName ?? null;
}

/**
 * Where the model's `reply="#n"` points. `replyId`: a line of this chat, which
 * a post may quote as a Discord reply. `pulledId`: a line of a pulled channel
 * (`pulledIds`, buildRequest's map of every pulled line to its channel), which
 * a post here never quotes -- Discord resolves a reply reference in the
 * channel posted to -- and links instead (createLinker). A turn that posts
 * plain (postsPlain) quotes no chat line; a pulled line is linked all the
 * same, since a link is not a Discord reply.
 * @returns {{ replyId: string|null, pulledId: string|null }}
 */
function replyTarget(replyTo, { plain, idByIndex, pulledIds }) {
  const id = replyTo !== null && replyTo !== undefined ? (idByIndex.get(replyTo) ?? null) : null;
  if (id === null) return { replyId: null, pulledId: null };
  if (pulledIds.has(id)) return { replyId: null, pulledId: id };
  return { replyId: plain ? null : id, pulledId: null };
}

/**
 * Where a reaction on line `targetId` goes: this channel for a chat line; for
 * a pulled line (`pulledIds`) its own channel, looked up in this channel's
 * guild, while the bot may react there now (canReact). Otherwise `target` is
 * null and `reason` is the code the drop is logged with: `not-found` (the
 * channel is gone) or `cannot-react`. `source` is the pulled channel's id,
 * null for a chat line. `canReact` comes from the turn's `discord` capabilities.
 * @returns {{ target: object|null, source: string|null, reason: 'not-found'|'cannot-react'|null }}
 */
function reactionChannel(channel, targetId, pulledIds, { canReact }) {
  const source = pulledIds.get(targetId) ?? null;
  if (!source) return { target: channel, source: null, reason: null };
  const target = channel.guild?.channels?.cache?.get?.(source) ?? null;
  if (!target) return { target: null, source, reason: 'not-found' };
  return canReact(target) ? { target, source, reason: null } : { target: null, source, reason: 'cannot-react' };
}

/**
 * What the first post of a turn about another channel (`source`) links to
 * when it answers no pulled line: a routed call (in its own channel), else the
 * newest line of the source the request showed (buildRequest's `pulledKept`).
 * Null without a source, or when nothing of it was shown (the budget dropped
 * its block): a post never points at a line the model did not see.
 * @returns {{ channelId: string, messageId: string }|null}
 */
function sourceLinkTarget({ source, trigger, pulledKept }) {
  if (!source?.channelId) return null;
  if (source.reason === 'routed' && trigger?.id) return { channelId: trigger.channelId || source.channelId, messageId: trigger.id };
  const newestId = pulledKept.find((shown) => shown.channelId === source.channelId)?.newestId ?? null;
  return newestId ? { channelId: source.channelId, messageId: newestId } : null;
}

/**
 * The jump links (src/behavior/elsewhere.js#messageLink) of one turn's posts
 * -- its messages, then the GIF, then the picture -- asked in posting order;
 * act and dryAct share the rule, so a rehearsal shows the links a real turn
 * posts. A post answering a pulled line (`pulledId`) links to that line; on a
 * turn about another channel the first post links to `sourceTarget` when it
 * answers none. One line is linked at most once per turn: a second answer to
 * it carries no link.
 * @param {{ guildId: string, pulledIds: Map<string, string>,
 *   sourceTarget: { channelId: string, messageId: string }|null }} args
 * @returns {(pulledId: string|null) => string|null}  The next post's link, or null.
 */
function createLinker({ guildId, pulledIds, sourceTarget }) {
  const linked = new Set();
  let first = true;
  return (pulledId) => {
    const target = pulledId ? { channelId: pulledIds.get(pulledId), messageId: pulledId } : first ? sourceTarget : null;
    first = false;
    if (!target || linked.has(target.messageId)) return null;
    linked.add(target.messageId);
    return messageLink(guildId, target.channelId, target.messageId);
  };
}

// A Discord message holds at most 2000 characters.
const DISCORD_MESSAGE_CHARS = 2000;

/**
 * `text` cut to `max` characters at its end, never inside a `<...>` token (a
 * mention, a custom emoji); unchanged when it fits. A cut is told to `limits`
 * (src/llm/limits.js#createLimits, optional) as a `message-cut` with the characters lost.
 */
function cutPost(text, max, limits = null) {
  let body = clampChars(text, max);
  if (body.length < text.length) {
    const open = body.lastIndexOf('<');
    if (open > body.lastIndexOf('>')) body = body.slice(0, open);
    body = body.trimEnd();
    limits?.add({ kind: 'message-cut', where: 'post', lost: [...text].length - [...body].length });
  }
  return body;
}

/**
 * `text` with `link` joined through `labels.elsewhere.link` (`{text}` `{link}`);
 * without the label, a newline between them. Every post fits one Discord
 * message: `text` is cut at its end (cutPost) when it would outgrow it --
 * with a link, so that the link always fits; without one, after the mentions
 * and custom emoji expanded into it (parse.js leaves only a small margin for
 * them, which a few long ones or a link outgrow). `limits` (optional) is told a cut (cutPost).
 */
function withLink(text, link, labels, limits = null) {
  if (!link) return cutPost(text, DISCORD_MESSAGE_CHARS, limits);
  const template = labels?.elsewhere?.link;
  const join = (body) => (typeof template === 'string' && template ? fill(template, { text: body, link }) : `${body}\n${link}`);
  return join(cutPost(text, Math.max(0, DISCORD_MESSAGE_CHARS - [...join('')].length), limits));
}

const REWATCH_SUMMARY_CHARS = 200;
// Protocol tokens of the re-watch classifier (docs/prompt-contract.md), not wording:
// the kind and status columns of a `<media>` line. The answer's parser
// (parseRewatchPickDetailed) lives in src/behavior/planner.js, which reads the
// planner's re-watch block with it; it is re-exported from here.
const REWATCH_KIND_VIDEO = 'video';
const REWATCH_KIND_PICTURE = 'picture';
// A watched GIF: listed to the classifier as a video (REWATCH_KIND_VIDEO); `gif` is the internal
// candidate kind and the log's code, never written into `<media>`.
const REWATCH_KIND_GIF = 'gif';
const REWATCH_STATUS_WATCHED = 'watched';
const REWATCH_STATUS_NOT_LOADED = 'not loaded';
const REWATCH_STATUS_DESCRIBED = 'described';

export { parseRewatchPickDetailed };

/**
 * The link items of `history` the web lookup may read (src/media/classify.js#collectReadableLinks:
 * no video-site link, no gif embed), newest message first.
 */
function readableLinkCandidates(history, sites) {
  const out = [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    out.push(...collectReadableLinks(history[i], { videoSites: sites ?? [] }));
  }
  return out;
}

/**
 * `history` with the messages its replies answer from outside it prepended as its oldest lines
 * (interfaces/discord/collect.js#fetchReplyParents): the parent of `trigger` when it lives in this
 * channel, one level of that parent's own parent, and the parents of the last
 * `context.replyParentsFor` lines (every line of the window with `features.anchoredWindow`
 * exactly true: the request then shows the parents as anchors in `<earlier>`), at most
 * `context.replyParentsMax` in all, each marked `replyParent: true`. Off with
 * `context.fetchReplyParents` false (a missing key counts as on); `history` as it is then.
 * @param {object} channel
 * @param {object[]} history
 * @param {{ trigger: object|null, selfId: string, config: object, discord: object }} options
 *   `discord` the turn's capabilities object (its `fetchReplyParents`).
 * @returns {Promise<object[]>}
 */
async function withReplyParents(channel, history, { trigger, selfId, config, discord }) {
  const context = config.context ?? {};
  if (context.fetchReplyParents === false) return history;
  const own = trigger && (!trigger.channelId || trigger.channelId === channel.id) ? trigger : null;
  const parents = await discord.fetchReplyParents(channel, history, {
    trigger: own,
    recent: config.features?.anchoredWindow === true ? history.length : (context.replyParentsFor ?? 3),
    max: context.replyParentsMax ?? 4,
    selfId,
    embedTextChars: config.media?.embedTextChars,
    videoSites: config.media?.video?.sites,
    maxUrlChars: config.context?.maxUrlChars,
  });
  // Marked, so the request can say which of its lines came from outside the window (the journal's `seen.parents`).
  return parents.length > 0 ? [...parents.map((parent) => ({ ...parent, replyParent: true })), ...history] : history;
}

/**
 * The pictures of `history` a second look on a question may be offered for
 * (features.imageRelook): every `image` item of collectPictures -- an attached
 * picture, the persona's own posted drawings included -- newest message first.
 */
function relookCandidates(history) {
  const out = [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    for (const item of collectPictures(history[i])) if (item.kind === 'image') out.push(item);
  }
  return out;
}

/**
 * The GIFs of `history` a second look on a question may be offered for
 * (features.videoRewatch): every `gif` item of collectPictures -- an
 * attached .gif, a tenor/giphy embed -- newest message first. Which of them
 * were watched is the describer's to say (describer.watchedGifs).
 */
function gifRewatchItems(history) {
  const out = [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    for (const item of collectPictures(history[i])) if (item.kind === 'gif') out.push(item);
  }
  return out;
}

/** Upload file name for a generated picture: `image/jpeg` -> `image.jpg`, else `image.<subtype>`; `/nep draw` names its picture the same way. */
export function imageFileName(mediaType) {
  const subtype = String(mediaType ?? '').split('/')[1]?.split(';')[0]?.trim().toLowerCase() || 'png';
  return `image.${subtype === 'jpeg' ? 'jpg' : subtype}`;
}

// Discord's limit of files on one message.
const MAX_FILES_PER_MESSAGE = 10;

/**
 * A diary set's pictures split into messages, in order: a message holds at
 * most 10 files, and a picture whose bytes would take its message past
 * `maxBytes` (`diary.set.maxMessageBytes`) starts the next one; a picture
 * larger than `maxBytes` on its own goes alone. Pure.
 * @template {{ buffer: { length: number } }} T
 * @param {T[]} pictures
 * @param {number} maxBytes
 * @returns {T[][]}
 */
export function chunkPictures(pictures, maxBytes) {
  const chunks = [];
  let current = [];
  let bytes = 0;
  for (const picture of Array.isArray(pictures) ? pictures : []) {
    const size = picture?.buffer?.length ?? 0;
    if (current.length > 0 && (current.length >= MAX_FILES_PER_MESSAGE || bytes + size > maxBytes)) {
      chunks.push(current);
      current = [];
      bytes = 0;
    }
    current.push(picture);
    bytes += size;
  }
  if (current.length > 0) chunks.push(current);
  return chunks;
}

// A Discord message holds 2000 characters; the part mark is ` (n/m)` on the header plus the newline.
const MIRROR_MAX_CHARS = 2000;
const MIRROR_PART_MARK_CHARS = 16;

/**
 * `text` in pieces of at most `max` code points, each cut at its last newline
 * when there is one, so a dry-run mirror of a long text fits Discord messages.
 */
function splitForMirror(text, max) {
  const limit = Math.max(1, Math.floor(max));
  const parts = [];
  let rest = [...String(text ?? '')];
  while (rest.length > limit) {
    const window = rest.slice(0, limit);
    const newline = window.lastIndexOf('\n');
    const cut = newline > 0 ? newline : limit;
    parts.push(rest.slice(0, cut).join(''));
    rest = rest.slice(newline > 0 ? cut + 1 : cut);
  }
  parts.push(rest.join(''));
  return parts;
}

/**
 * Describable pictures (image/gif/video/sticker/link-thumbnail, plus custom
 * emoji — see src/media/classify.js#isDescribable) of `history`, newest
 * message first — so a per-turn cap spends its budget on what the persona
 * just saw. Pictures (collectPictures) come before that message's emoji.
 */
function describableCandidates(history) {
  const out = [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    for (const item of [...collectPictures(history[i]), ...collectEmojiItems(history[i])]) {
      if (!isDescribable(item)) continue;
      out.push(item);
    }
  }
  return out;
}

/** The picture kinds (src/media/classify.js) that make a direct call's own media something to look at. */
const LOOKED_AT_KINDS = new Set(['image', 'gif', 'video']);

/**
 * Whether `trigger` (a direct call) brought something to look at that this turn's stages work
 * on: an item of `captionItems` (the caption stage's candidates) that is a picture, a GIF or a
 * video -- attached or embedded; never a sticker, an emoji or a link's thumbnail -- or any item
 * of `videoItems` (the video stage's candidates: an attached video, a video-site link), on the
 * trigger's own message or on the message it replies to. Media of any other line does not count.
 * @param {{ id: string, replyToId?: string|null }} trigger
 * @param {object[]} captionItems
 * @param {object[]} videoItems
 * @returns {boolean}
 */
function triggerBringsMedia(trigger, captionItems, videoItems) {
  const ids = new Set([trigger.id, trigger.replyToId].filter(Boolean));
  const own = (item) => ids.has(item.messageId);
  return videoItems.some(own) || captionItems.some((item) => own(item) && LOOKED_AT_KINDS.has(item.kind));
}

/**
 * Where the persona's words about a channel it cannot write in go (a call
 * from there, a remark on it), read from `config` (the live config) at the
 * call: the first id of `memory.mainChannelIds`
 * (src/behavior/elsewhere.js#resolveDestination) that is a channel of
 * `guild` the persona may write in (interfaces/discord/collect.js#isWritableChannel:
 * a text channel, not a thread, never the dry-run mirror, its history
 * readable, the bot can send) and not `exceptId` (the
 * channel the words are about). The one copy of the rule: `<senses>` names
 * this channel, and whatever routes a call there asks the same function.
 * @param {object|null} guild  The discord.js guild; none (a private chat) has no destination.
 * @param {object} config      The live config.
 * @param {{ exceptId?: string|null, discord: object }} options  `discord` the Discord interface's
 *   capabilities object (its `isWritableChannel`), passed by the caller.
 * @returns {{ channel: object, reason: null } | { channel: null, reason: 'off'|'no-destination' }}
 *   `reason` is resolveDestination's code: `off` with features.elsewhere false, else `no-destination`.
 */
export function usableDestination(guild, config, { exceptId = null, discord } = {}) {
  const channelOf = (id) => guild?.channels?.cache?.get?.(id) ?? null;
  const usable = (id) => {
    const target = channelOf(id);
    return Boolean(target) && id !== exceptId && typeof target.isTextBased === 'function' && discord.isWritableChannel(target, config?.bot ?? {});
  };
  const { destinationId, reason } = resolveDestination(config, usable);
  return destinationId ? { channel: channelOf(destinationId), reason: null } : { channel: null, reason };
}

/**
 * Where the persona's words about `source` (a channel the bot cannot send
 * in) go, read from `config` (the live config) now: `{ destination, reason:
 * null }` with the discord.js channel, or `{ destination: null, reason }`
 * with the code logged as `route`: `off` (features.elsewhere false),
 * `no-destination` (no usable memory.mainChannelIds entry other than the
 * source, `usableDestination`) or `audience` (someone who
 * can view the destination cannot view the source,
 * interfaces/discord/pull-fetch.js#audienceAllows). The one copy of the route of a
 * routed call and of a noticed comment.
 * @param {object} source  A discord.js guild channel.
 * @param {object} config  The live config.
 * @param {object} discord  The Discord interface's capabilities object (`isWritableChannel`,
 *   `audienceAllows`), passed by the caller.
 * @returns {{ destination: object, reason: null } | { destination: null, reason: 'off'|'no-destination'|'audience' }}
 */
export function routeFor(source, config, discord) {
  const { channel: destination, reason } = usableDestination(source.guild, config, { exceptId: source.id, discord });
  if (!destination) return { destination: null, reason };
  if (!discord.audienceAllows(destination, source, config)) return { destination: null, reason: 'audience' };
  return { destination, reason: null };
}

/** The values a coded outcome's reason takes (`{status}`, `{what}`), as the journal keeps them so a mark reseeded after a restart words the same. */
function valuesOf(result) {
  const values = result?.values;
  return values && typeof values === 'object' && !Array.isArray(values) && Object.keys(values).length > 0 ? { values: { ...values } } : {};
}

/** The mode a journal's `turn.start` names: a follow-up or an overheard line by its kind, else the turn's mode. */
function journalMode(mode, triggerKind) {
  return triggerKind === 'followUp' || triggerKind === 'overheard' ? triggerKind : (mode ?? null);
}

/** A journal operation that writes nothing: an attempt the journal does not follow. */
const NO_OP = Object.freeze({
  opId: null,
  proposed: async () => {},
  started: async () => {},
  succeeded: async () => {},
  failed: async () => {},
  unknown: async () => {},
});

/**
 * How an interface port result that is not `ok` (src/interface/port.js) closes its journal
 * operation: `unknown` (a network error, a timeout, a 5xx: it may have taken effect anyway) is
 * `unknown` -- the restart's reconciliation looks for a post; nothing is ever sent again --, any
 * other status is `failed` with the port's code (`http-<status>` for Discord's refusals).
 */
function closeResult(op, result) {
  if (result?.status === 'unknown') return op.unknown();
  return op.failed(result?.error?.code ?? result?.status ?? CODE.ERROR);
}

/** How many characters of a message's text its send hash covers (what survives a trailing link or a cut). */
const SEND_HASH_CHARS = 80;

/**
 * The hash of a message's text as a send whose answer never came records it, and as her own lines of
 * the channel are checked against it later: the first SEND_HASH_CHARS characters with whitespace folded.
 * @param {unknown} text
 * @returns {string}
 */
export function sendHash(text) {
  const folded = Array.from(String(text ?? '').replace(/\s+/g, ' ').trim()).slice(0, SEND_HASH_CHARS).join('');
  return createHash('sha1').update(folded).digest('hex').slice(0, 16);
}

/**
 * The facts of `pending` with the sends whose answer never came (`sendFailed` with `unknown`) settled
 * against `history` (the channel's lines as the turn fetched them): a message of hers with that hash
 * after the send is there, so the fact is dropped and `dropped` names it; any other stays, to be
 * told as it is. Pure.
 * @param {object[]} pending
 * @param {object[]} history
 * @returns {{ kept: object[], dropped: object[] }}
 */
export function settleUnknownSends(pending, history) {
  const own = (Array.isArray(history) ? history : []).filter((line) => line?.self === true && typeof line.content === 'string');
  const kept = [];
  const dropped = [];
  for (const fact of pending) {
    const found = fact.kind === 'sendFailed' && fact.unknown === true && typeof fact.hash === 'string'
      && own.some((line) => sendHash(line.content) === fact.hash && (!Number.isFinite(line.ts) || !Number.isFinite(fact.at) || line.ts >= fact.at - 60_000));
    (found ? dropped : kept).push(fact);
  }
  return { kept, dropped };
}

/** What the logs show of a port result's error: the platform's own error when the adapter kept it. */
function portError(result) {
  return result?.error?.cause ?? result?.error ?? null;
}

/** A sent message as the turn notes it, from an `ok` port result: its id (null when unknown) and stamp. */
function postedOf(result) {
  return { id: result?.ref?.messageId ?? null, ...(Number.isFinite(result?.at) ? { createdTimestamp: result.at } : {}) };
}

/** The persona as the principal of her skill calls (src/skills/gateway.js). */
const PERSONA = Object.freeze({ kind: 'persona' });

/**
 * The requester of a skill call: `trigger`'s author (`{ id, roleIds }`, the role ids from the
 * guild's member cache of `channel`, none when the member is not cached), or null when nobody
 * asked (a turn without a trigger author). Exported for the replay's skill scenarios
 * (tools/replay.mjs `--skills`), which build their requester exactly so.
 * @param {{ authorId?: string }|null} trigger
 * @param {object} channel
 * @returns {{ id: string, roleIds: string[] }|null}
 */
export function requesterOf(trigger, channel) {
  if (!trigger?.authorId) return null;
  const id = String(trigger.authorId);
  const roles = channel?.guild?.members?.cache?.get?.(id)?.roles?.cache;
  return { id, roleIds: roles && typeof roles.keys === 'function' ? [...roles.keys()].map(String) : [] };
}

/**
 * What a `<call>` of the persona is resolved against (src/skills/executors.js#resolveCall), read
 * now: the turn's channel as the current conversation, the channels she can name (the guild's
 * text channels, then the stored channel notes, the turn's own channel; where she may act is the
 * operation's rule, src/ops/shared.js#postingConversation), this turn's transcript numbers (`idByIndex`;
 * a pulled line lives in its own channel, `pulledIds`; its author from `lines`), the stored
 * profiles (only with memory on), her own id (`selfId`), the guild's roles, the request's channel
 * handles (`channelHandles`: handle -> channel id, a `#handle` resolved exactly before any name), the request's
 * member handles (`memberHandles`: handle -> member id, her `@handle` in a member argument) and the skill registry
 * (`skills`: a derived skill's options are resolved by its command), and `fileOf` (a file handle
 * of one of her errands -> the file, null when this conversation may not use it), and `triggerText` (the
 * trigger message's text: a channel it names may take an errand's file). Reads `store` only. Exported
 * for the replay's skill scenarios, which resolve a call exactly as a live turn does.
 * @returns {object}
 */
export function callViewOf({ channel, guildId, idByIndex, lines, pulledIds, memoryOn, store, selfId, skills, channelHandles = null, memberHandles = null, fileOf = null, triggerText = null, deletedIds = null }) {
  const conversations = [];
  const cache = channel?.guild?.channels?.cache;
  if (cache && typeof cache.values === 'function') {
    for (const ch of cache.values()) {
      const textBased = typeof ch?.isTextBased === 'function' ? ch.isTextBased() : ch?.type === 0;
      if (textBased && ch.id && typeof ch.name === 'string') conversations.push({ id: String(ch.id), name: ch.name });
    }
  }
  if (guildId && typeof store?.listChannels === 'function') {
    for (const note of store.listChannels(guildId) ?? []) if (note?.id && typeof note.name === 'string') conversations.push({ id: String(note.id), name: note.name });
  }
  if (typeof channel.name === 'string' && channel.name) conversations.push({ id: String(channel.id), name: channel.name });
  // The guild's roles a derived skill's role option may name.
  const roles = [];
  const roleCache = channel?.guild?.roles?.cache;
  if (roleCache && typeof roleCache.values === 'function') {
    for (const role of roleCache.values()) if (role?.id && typeof role.name === 'string') roles.push({ id: String(role.id), name: role.name });
  }
  return {
    currentConversationId: String(channel.id),
    conversations,
    channelHandles: channelHandles instanceof Map ? channelHandles : null,
    memberHandles: memberHandles instanceof Map ? memberHandles : null,
    messageAt: (n) => {
      const id = idByIndex?.get(n);
      if (!id) return null;
      const line = (lines ?? []).find((entry) => entry.id === id);
      return { id: String(id), conversationId: String(pulledIds?.get(id) ?? channel.id), authorId: line?.authorId ?? null, self: line?.self === true, ...(line?.deleted === true ? { deleted: true } : {}) };
    },
    members: memoryOn && guildId && typeof store?.listUserProfiles === 'function' ? (store.listUserProfiles(guildId) ?? []) : [],
    selfId: selfId ?? null,
    roles,
    skills,
    // Messages the record holds as deleted that the history lacks (their ids or links are refused as deleted).
    ...(deletedIds instanceof Set && deletedIds.size > 0 ? { deletedIds } : {}),
    // A file handle of one of her errands (`file:<task id>/<name>`), resolved for this conversation.
    ...(typeof fileOf === 'function' ? { fileOf } : {}),
    // The trigger message's text: a channel it names may take an errand's file.
    ...(typeof triggerText === 'string' && triggerText ? { triggerText } : {}),
  };
}

/**
 * The journal's closing record of a successful persona skill call: counts only, never content.
 * `messageId` of the message it posted (result.ref); `chars` the length of the answer the persona
 * reads (the text, or the serialized rows of a list; absent when empty); `items` the row count of
 * a list. `{}` when the call returned nothing.
 * @param {{ ref?: { messageId?: string }, data?: { text?: string, rows?: object[] }|null }|null} result
 * @returns {{ messageId?: string, chars?: number, items?: number }}
 */
export function journalResultOf(result) {
  const out = {};
  if (result?.ref?.messageId) out.messageId = result.ref.messageId;
  const data = result?.data;
  if (data) {
    const rows = Array.isArray(data.rows) ? data.rows : null;
    const chars = rows ? JSON.stringify(rows).length : String(data.text ?? '').length;
    if (chars > 0) out.chars = chars;
    if (rows) out.items = rows.length;
  }
  return out;
}

/**
 * What the first pass of a turn posted (`acted`, act's answer), one item each, for the
 * follow-up's `<result>`: each reaction as the transcript shows hers
 * (`labels.transcript.reactions` over `reactionMine`), each GIF as `labels.transcript.gif`
 * with its handle, each message as she wrote it, the picture as `labels.transcript.image`. An
 * item whose label is missing is left out. Pure; exported for the replay's skill scenarios.
 * @param {{ reacted?: { emoji: string }[], gifs?: string[], texts?: string[], drew?: boolean }|null} acted
 * @param {object} labels
 * @returns {string[]}
 */
export function firstPass(acted, labels) {
  const t = labels?.transcript ?? {};
  const items = [];
  if (typeof t.reactions === 'string' && typeof t.reactionMine === 'string') {
    for (const reaction of acted?.reacted ?? []) items.push(fill(t.reactions, { list: fill(t.reactionMine, { emoji: reaction.emoji, count: 1 }) }));
  }
  if (typeof t.gif === 'string') for (const id of acted?.gifs ?? []) items.push(fill(t.gif, { name: id }));
  items.push(...(acted?.texts ?? []));
  if (acted?.drew === true && typeof t.image === 'string') items.push(t.image);
  return items;
}

/** The list fields of a normalized message (interfaces/discord/collect.js#normalizeMessage), empty on a line built here. */
const EMPTY_LINE_LISTS = Object.freeze(['mentionedUserIds', 'mentionedChannelIds', 'attachments', 'links', 'forwarded', 'stickers', 'emojis', 'reactions']);

/**
 * The answers act gave to the steps of a tool loop (createTurnRunner's toolLoop) as one, the way
 * a turn reads its one follow-up's: `delivered` when any reached the chat, the lines `answered`,
 * the `posts` and `reacted` of every step in order. None: `{ cutOff: true }` when a step was cut
 * off with nothing complete, else null. Pure.
 * @param {object[]} answers
 * @param {boolean} cutOff
 * @returns {object|null}
 */
export function mergedAnswers(answers, cutOff = false) {
  const list = (Array.isArray(answers) ? answers : []).filter(Boolean);
  if (list.length === 0) return cutOff ? { cutOff: true } : null;
  return {
    delivered: list.some((answer) => answer.delivered === true),
    answered: new Set(list.flatMap((answer) => [...(answer.answered ?? [])])),
    posts: list.flatMap((answer) => answer.posts ?? []),
    reacted: list.flatMap((answer) => answer.reacted ?? []),
  };
}

/**
 * The turn's channel as it stands when the turn continues after the persona's skill call
 * (followUp): the turn's `history` as it was (its lines, previews and order untouched), then the
 * lines it did not hold yet, oldest first -- those of a fresh fetch (`fetched`: her own posts of
 * the turn as Discord gives them, and what others wrote meanwhile), then her posts of the turn the
 * fetch did not return (`own`, act's `lines`: id, time and text as written; `selfName` as their
 * author's name, the missing list fields empty). A line without an id is left out; an id is kept
 * once, the first time it comes. The call marks and trigger links are the caller's to put on.
 * Pure; exported for the tests and the replay's skill scenarios.
 * @param {{ history: object[], fetched?: object[]|null, own?: object[]|null, selfName?: string|null }} input
 * @returns {object[]}
 */
export function continuationHistory({ history, fetched = [], own = [], selfName = null }) {
  const base = Array.isArray(history) ? history : [];
  const seen = new Set(base.map((line) => line?.id).filter((id) => typeof id === 'string' && id));
  const asLine = (line) => {
    const out = { channelName: null, authorName: selfName ?? '', bot: false, replyToId: null, replyPingUserId: null, forwardedFrom: null, ...line, self: true };
    for (const key of EMPTY_LINE_LISTS) if (!Array.isArray(out[key])) out[key] = [];
    return out;
  };
  const later = [];
  const add = (line) => {
    if (!line || typeof line.id !== 'string' || !line.id || seen.has(line.id)) return;
    seen.add(line.id);
    later.push(line);
  };
  for (const line of Array.isArray(fetched) ? fetched : []) add(line);
  for (const line of Array.isArray(own) ? own : []) if (line && !seen.has(line.id)) add(asLine(line));
  later.sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
  return [...base, ...later];
}

/**
 * The immutable envelope of the persona's skill call, built by code from the turn, never from
 * what the model wrote: the actor (the persona), the requester (the person who asked for the
 * turn, `requester` -- `/nep message create` -- else the author of the request the turn answers,
 * requesterOf; a recovery turn's trigger is the original candidate, so its author; null when
 * nobody asked), whether the turn answers several people at once (`mixed`: a recovery
 * bundle naming more than one author -- no write then), the source message ids (the trigger and
 * the lines folded into it), the origin channel, and a fresh invocation id the call's journal
 * lines and its operation carry. The follow-up pass inherits it; a tool's output never adds a
 * requester.
 * `turnId` (the journal's turn, else one id per attempt) and `idempotencyKey` (that turn, its
 * attempt and the call's index in it) go with every call: an errand records the turn, and the
 * same call made twice queues one errand (src/errands/store.js#add).
 * @returns {Readonly<{ actor: 'persona', requester: object|null, mixed: boolean, sourceMessageIds: string[], originChannelId: string, invocationId: string, turnId?: string, idempotencyKey?: string }>}
 */
function callEnvelope({ trigger, channel, added = null, missed = null, requester: asked = null, turnId = null, idempotencyKey = null, ownInitiative = false, chainId = null }) {
  const requester = asked?.id ? { id: String(asked.id), roleIds: Array.isArray(asked.roleIds) ? asked.roleIds.map(String) : [] } : requesterOf(trigger, channel);
  const authors = new Set((Array.isArray(missed) ? missed : []).map((line) => line?.author).filter((author) => typeof author === 'string' && author));
  const sources = [trigger?.id, ...(Array.isArray(added) ? added.map((line) => line?.id) : [])].filter(Boolean).map(String);
  return Object.freeze({
    actor: 'persona',
    requester: requester ? Object.freeze({ id: requester.id, roleIds: Object.freeze([...requester.roleIds]) }) : null,
    mixed: authors.size > 1,
    sourceMessageIds: Object.freeze(sources),
    originChannelId: String(channel.id),
    invocationId: randomUUID(),
    // The turn whose call this is and the call's index in it: one errand per call, whatever retries.
    ...(turnId ? { turnId: String(turnId) } : {}),
    ...(idempotencyKey ? { idempotencyKey: String(idempotencyKey) } : {}),
    // An inner turn: her own initiative, nobody asked (src/skills/executors.js#executeCall), and
    // its causal chain (which of her candidates it may accept, src/intentions/model.js#acceptRefusal).
    ...(ownInitiative ? { ownInitiative: true, ...(chainId ? { chainId: String(chainId) } : {}) } : {}),
  });
}

/** What a post of the reply carries, for the reader of its check: its text and/or media, the message it replies to. */
function sendArgs({ text = null, media = null, replyId = null }) {
  return { ...(text ? { text } : {}), ...(media ? { media } : {}), ...(replyId ? { replyTo: replyId } : {}) };
}

/** The skill registry a runner checks against when none is injected: every operation's (src/skills/registry.js). */
function defaultSkills() {
  return skillRegistry();
}

/** The most channels a runner's default adapter keeps a handle on (the oldest go first). */
const HELD_CHANNELS_MAX = 500;

/** The distinct hosts of `links` (`{ url }` items), in order; a URL that does not parse is left out. */
function linkHosts(links) {
  const hosts = [];
  for (const link of links ?? []) {
    let host = null;
    try {
      host = new URL(link?.url).hostname;
    } catch {
      host = null;
    }
    if (host && !hosts.includes(host)) hosts.push(host);
  }
  return hosts;
}

/**
 * The preparation steps of one attempt in the journal (link reads, video watches, captions,
 * searches): each step's operation is closed once its work settled and the turn took what it
 * had. `step(stage, op, offeredOf)` wraps an operation of the stage `stage`; its
 * `succeeded(result, offered?)` keeps the result until `take(stage, used)` says whether the
 * stage's value reached the request, then writes `succeeded` with `delivered` (taken and
 * something to offer: `offered`, else `offeredOf(result)`). A step that settles after its
 * take, or one never taken (`closeAll`), is written with `delivered: false`.
 */
function createPrepLedger() {
  const entries = [];
  const close = (entry) => {
    if (entry.closed || entry.result === undefined || entry.taken === null) return;
    entry.closed = true;
    entry.op.succeeded({ ...entry.result, delivered: entry.taken && entry.offered });
  };
  return {
    step(stage, op, offeredOf = () => true) {
      const entry = { stage, op, result: undefined, offered: false, taken: null, closed: false };
      entries.push(entry);
      return {
        opId: op.opId,
        started: (extra) => op.started(extra),
        succeeded: (result = {}, offered) => {
          entry.result = result;
          entry.offered = typeof offered === 'boolean' ? offered : Boolean(offeredOf(result));
          close(entry);
          return Promise.resolve();
        },
        failed: (code) => {
          entry.closed = true;
          return op.failed(code);
        },
        unknown: () => {
          entry.closed = true;
          return op.unknown();
        },
      };
    },
    take(stage, used) {
      for (const entry of entries) {
        if (entry.stage !== stage || entry.taken !== null) continue;
        entry.taken = Boolean(used);
        close(entry);
      }
    },
    closeAll() {
      for (const entry of entries) {
        if (entry.taken !== null) continue;
        entry.taken = false;
        close(entry);
      }
    },
  };
}

/**
 * `work()` with its preparation step `op` (createPrepLedger's, or null: no journal) around it:
 * `started` before, then `toResult(value)` -- `{ result, offered? }`, or `{ failed: code }` --
 * closes it; a throw is `failed` with `error` and rethrown.
 */
async function journalled(op, work, toResult) {
  if (!op) return work();
  await op.started();
  let value;
  try {
    value = await work();
  } catch (err) {
    op.failed(CODE.ERROR);
    throw err;
  }
  const closing = toResult(value) ?? {};
  if (typeof closing.failed === 'string') op.failed(closing.failed);
  else op.succeeded(closing.result ?? {}, closing.offered);
  return value;
}

/** The budget sections of a request's stats line that lost items: `{ section: dropped }`. */
function droppedSections(stats) {
  const out = {};
  for (const [name, entry] of Object.entries(stats ?? {})) {
    if (isPlainObject(entry) && Number.isFinite(entry.dropped) && entry.dropped > 0) out[name] = entry.dropped;
  }
  return out;
}

/**
 * The journal's usage of the reply request (the turn record and the request dump): the whole
 * prompt, its part read from the cache (`cached`), its part written to the cache (`cacheWrite`,
 * OpenRouter's `prompt_tokens_details.cache_write_tokens`, as on the `llm: usage` line), the
 * completion; each null when unreported.
 */
function journalUsage(completion) {
  const usage = completion?.usage ?? {};
  const count = (value) => (Number.isFinite(value) ? value : null);
  return {
    prompt: count(completion?.promptTokens) ?? count(usage.prompt_tokens),
    cached: count(usage.prompt_tokens_details?.cached_tokens),
    cacheWrite: count(usage.prompt_tokens_details?.cache_write_tokens),
    completion: count(usage.completion_tokens),
  };
}

/**
 * Whether a voice completion (`completion`, parsed and shaped as `parsed`) was cut off at its
 * output cap (finish reason `length`): null when it stopped on its own. A cut-off one logs `turn:
 * cut off` with the completion tokens, whether it came from the skill follow-up and whether
 * complete actions are kept (`kept`). Nothing is kept when the think never closed, the answer
 * left nothing to do (`empty`), or its one message is the untagged fallback text -- a fragment:
 * the caller then ends the turn `error` with reason `cut-off`, never a skip, and posts nothing.
 * @returns {{ kept: boolean }|null}
 */
function cutOffOf(completion, parsed, { channelId, empty, followUp }) {
  if (completion?.finishReason !== 'length') return null;
  const kept = !parsed.thinkOpen && !parsed.untagged && !empty;
  log.warn('turn: cut off', { channel: channelId, completionTokens: journalUsage(completion).completion, kept, followUp });
  return { kept };
}

/**
 * One attempt's `turn` record (src/memory/journal.js) from what the attempt noted in its
 * draft and the result it returned: `reason` is the attempt's skip code (`silence`, `nothing-to-do`:
 * SKIP_SILENCE, SKIP_NOTHING_TO_DO) or refusal code, else null (old skip records carry null too).
 */
function journalTurnRecord(draft, result) {
  const seen = draft.seen ?? { messageIds: [], parents: [], parts: { filePreviews: [] } };
  return {
    turnId: draft.started.turnId,
    attemptId: draft.started.attemptId,
    startedAt: draft.started.startedAt,
    channelId: draft.channelId,
    privateUserId: draft.privateUserId,
    mode: result?.mode ?? draft.mode ?? null,
    outcome: result?.outcome ?? 'error',
    reason: typeof result?.reason === 'string' ? result.reason : (draft.reason ?? null),
    seen,
    participants: draft.participants ?? [],
    sourceMessageIds: seen.messageIds,
    think: typeof draft.think === 'string' ? draft.think : null,
    posted: draft.posted ?? [],
    reactions: draft.reactions ?? [],
    actions: draft.actions ?? [],
    usage: draft.usage ?? null,
    budget: { dropped: draft.dropped ?? {} },
    limits: typeof draft.limits?.list === 'function' ? draft.limits.list() : [],
    // The skills a classifier named for this turn, each with the gateway's verdict (shadow, phase 0).
    ...(Array.isArray(draft.skillsProposed) && draft.skillsProposed.length > 0 ? { skillsProposed: draft.skillsProposed } : {}),
  };
}

/** How long a failed addressed turn is kept for her next request in the channel. */
export const FAILED_TURN_KEEP_MS = DAY_MS;

/** The statuses of a call that did not go well, as a `callFailed` fact names them. */
const CALL_STATUS_NAMES = new Set(['failed', 'partial', 'invalid', 'denied', 'not_configured', 'refused', 'unknown', 'timeout']);

/** The operation's own words of a call that did not work, as `{ text }` (one line, cut to `skills.markTextMaxChars`), or {}. */
function callTextOf(result, maxChars = 200) {
  const text = clampWithEllipsis(oneLine(typeof result?.data?.text === 'string' ? result.data.text : ''), maxChars);
  return text ? { text } : {};
}

/**
 * The `tasks` input of a turn's request (src/behavior/prompt.js#buildRequest)
 * and the calls it names as left to their own turns. `part`: the part of a
 * split message this turn answers; `queued()`: the calls still waiting in
 * this channel (read now; a throw counts as none, logged `turn: queued
 * failed`) -- the trigger author's own as `{ id, text }`, another member's as
 * `{ id, text, author }` (their display name); `added`: messages folded into
 * this call. The author's own calls count as named (`deferred`, their ids)
 * when the request can render them: in `labels.task.part`'s others on a part,
 * else under `labels.task.queued`; another member's under
 * `labels.task.queuedOthers`. A call the labels cannot name is not deferred:
 * the seen-in-history rule holds for it, as before. `missed`: a recovery
 * turn's earlier messages left unanswered (src/behavior/missed.js), `{ author,
 * text }` each, named under `labels.task.missed`. `failedEarlier`: the
 * addressed turns of this channel that failed with nothing posted
 * (`{ author, messageId, link, at, code }`), one `labels.task.failedEarlier`
 * line each. `diaryFailedEarlier`: the diary posts she asked for in an earlier addressed turn of
 * this channel that did not go out (`{ at, code }`), one `labels.task.diaryFailedEarlier` line each.
 * `input` is null when there is nothing to say.
 * @returns {{ input: { part: object|null, queued: string[], queuedOthers: { author: string, text: string }[],
 *   added: string[], missed: { author: string, text: string }[], failedEarlier: object[] }|null, deferred: Set<string> }}
 */
export function taskInput({ part, queued, added, missed = null, failedEarlier = null, diaryFailedEarlier = null, labels, channelId }) {
  let waiting = [];
  if (typeof queued === 'function') {
    try {
      const list = queued();
      waiting = Array.isArray(list) ? list.filter((call) => call && typeof call.text === 'string' && call.text) : [];
    } catch (err) {
      log.warn('turn: queued failed', { channel: channelId, error: err });
    }
  }
  const own = waiting.filter((call) => typeof call.author !== 'string');
  const others = waiting.filter((call) => typeof call.author === 'string');
  const addedTexts = Array.isArray(added) ? added.map((message) => message?.text).filter((text) => typeof text === 'string' && text) : [];
  const ownNamed = own.length > 0 && Boolean(part ? labels?.task?.part : labels?.task?.queued);
  const othersNamed = others.length > 0 && Boolean(labels?.task?.queuedOthers);
  const deferred = new Set([...(ownNamed ? own : []), ...(othersNamed ? others : [])].map((call) => call.id).filter(Boolean));
  const missedItems = Array.isArray(missed)
    ? missed.filter((item) => item && typeof item.text === 'string' && item.text).map((item) => ({ author: typeof item.author === 'string' ? item.author : '', text: item.text }))
    : [];
  const failedItems = Array.isArray(failedEarlier) && labels?.task?.failedEarlier ? failedEarlier.filter((entry) => entry?.messageId) : [];
  const diaryItems = Array.isArray(diaryFailedEarlier) && labels?.task?.diaryFailedEarlier ? diaryFailedEarlier.filter((entry) => entry && Number.isFinite(entry.at)) : [];
  if (!part && waiting.length === 0 && addedTexts.length === 0 && missedItems.length === 0 && failedItems.length === 0 && diaryItems.length === 0) return { input: null, deferred };
  return {
    input: {
      part: part ?? null,
      queued: own.map((call) => call.text),
      queuedOthers: others.map((call) => ({ author: call.author, text: call.text })),
      added: addedTexts,
      missed: missedItems,
      failedEarlier: failedItems,
      diaryFailedEarlier: diaryItems,
    },
    deferred,
  };
}

/**
 * `images` (src/llm/images.js#createImageGen) is optional: absent,
 * `features.imageGeneration` false, a `drawFailed` turn, or a channel where
 * the bot cannot attach files, the persona's `<draw>` is dropped and no
 * drawing line reaches `<senses>`.
 *
 * `lookup` (src/web/lookup.js#createLookup) is optional too: absent, or
 * `features.webLookup` not true, no link is read and no search is made.
 *
 * `recall` (src/behavior/recall-run.js#createRecall) is optional too: the
 * search of the server's own history beside the web search. Absent, or its
 * `available()` false, or a private chat without its partner (see runTurn),
 * no server search is made. The one
 * lookup classifier serves both (maybeLookup) and the request's `lookup`
 * input carries both parts: the web search's result as it is
 * (src/web/lookup.js#search, `{ query, text, sources, cached? }`), with a
 * `server` key (`{ text, stretch, people }`, recall's result) added only when
 * the server search found something; a server part alone is `{ server }`.
 * A web-only result is exactly the web search's object, as before recall.
 *
 * `now` (default Date.now) is the turn's clock: its own time, `{{today}}` of
 * the search classifier, the daily GIF counter and every `lastPostAt` stamp.
 *
 * `emoji` (interfaces/discord/emoji.js#createEmojiIndex) is optional: absent, or
 * `features.customEmoji` false (a missing key counts as on), no `:name:` is
 * turned into a custom emoji and a `<react>` with a custom one is dropped.
 *
 * `describer` (src/memory/describe.js#createDescriber) is optional: when
 * absent, or `features.mediaDescriptions` is off, no description request is
 * ever made — buildRequest simply renders every un-attached picture blind
 * (and every attached one with its bare marker). A neighbour channel's
 * pictures never cost a request: they get only the captions the cache
 * already holds (`describer.cachedDescriptions`), under the same switch. A
 * pulled channel's pictures (`<channel_view>`) get the cache's captions, and
 * fresh ones only once the turn is certain to run (interfaces/discord/pull-fetch.js).
 * Likewise, videos are only watched when `features.mediaDescriptions` AND
 * `features.videoDescriptions` (a missing key counts as on) are on and the describer has
 * `describeVideos`; otherwise they render without a watch.
 *
 * `getSelfName` (src/index.js) is the persona's display name in a guild;
 * default: the client's cached guild member, else the bot user's name.
 *
 * `isWarmingUp` (src/memory/warmup.js, wired in src/index.js; default: never)
 * ends a chain of parts before its next part (runChain): a warmup mutes the
 * persona, as a pause does.
 *
 * A call whose text passes the splitter's pre-filter (src/behavior/split.js)
 * asks the splitter (prompts/split.md) beside the turn's preparation, under
 * its deadline. `one`, a late, failed or unparsable answer, a missing prompt
 * or a labels file without `labels.task.part`: the turn goes on as if it had
 * never been asked. Parts in time: the turn sets its preparation aside and
 * runChain answers the parts one after another (see there).
 *
 * `routeChannels` (the route classifier's hook; src/index.js passes
 * src/behavior/route-channel.js#createChannelRouter's) is optional:
 * `({ guildId, channel, guild, partner, history, trigger, triggerKind, selfName, config }) => Promise<string[]>`,
 * the ids of channels the conversation is about; `triggerKind` is the turn's
 * TriggerKind (null on a turn without a trigger), so the hook can decline
 * kinds it does not serve (src/behavior/route.js#routeAllowed); `guild` is the
 * guild the ids are judged in, `partner` a private chat's partner (null on a
 * server turn). It is asked on a server turn, or a private chat with its
 * partner (features.privateLikeServer, see runTurn),
 * (never a drawFailed one) with features.channelPull on and the labels able
 * to render the block (`labels.pull.header`) while a
 * `<channel_view>` slot (`context.pull.maxChannels`) is left after the turn's
 * source and the explicit `<#id>` mentions; its ids are pulled after those
 * (src/behavior/pull.js#pullTargets). On a routed turn `history` is the source
 * channel's lines, not this chat. A throw or an answer that is not an array
 * counts as no id (a throw logs `pull: route failed`).
 *
 * Participation (src/memory/participation.js; features.participation and features.memory,
 * a missing key counts as on; never in a private chat or the diary channel): every message a
 * turn sends for real in a server channel is recorded in the guild's participation store with
 * the history lines before it and the line it replies to (recordOwnParticipation; a dry run
 * records nothing). A server turn that builds a reply request (not a diary post) hands the
 * store to buildRequest as `<participation>`; beside its preparation the pick classifier
 * (src/behavior/participation-pick.js, not on a drawFailed turn) chooses which stored episodes
 * of other channels come first, under the same deadline -- late, the newest are shown.
 *
 * The turn planner (src/behavior/planner.js; features.turnPlanner exactly true, read per turn):
 * one request (prompts/planner.md, role `analyzer`, purpose `planner`) stands in for
 * the route hook, the participation pick, the re-watch classifier and the search classifier,
 * none of which is asked then (createTurnPlan). Each answer block reaches the code its old
 * classifier fed; a block that is invalid or missing keeps that consumer's default (no channel,
 * the newest episodes, no second look), and the lookup block, or a failed call, takes the
 * search classifier's fallback.
 *
 * Everything a turn prepares before its reply request (the file previews, the
 * captions, the videos and their re-watch, the link reads, the search
 * classifier with its searches, the neighbours, the pulled channels) starts as soon as its inputs exist and runs alongside the
 * rest, under one deadline (paceSettings: `pace.prepareMs` from the turn's
 * start, `pace.prepareSearchMs` once the search classifier asked for a
 * search -- and at most that long while its verdict is still out --,
 * `pace.prepareMediaMs` for a direct call that brought media to look
 * at; the larger of the two with both). A helper still running then
 * contributes nothing to this turn --
 * its block is absent, as when it fails -- and keeps running for its cache.
 * A turn nobody waits for (unhurried, `pace.unpromptedWaits`) has no such
 * deadline and no bar: it waits for every helper. Every turn that reaches the reply request logs `turn: timings`.
 * `schedule(fn, ms)` (default: setTimeout) runs that deadline and the typing
 * indicator's refresh; it resolves a function that cancels it.
 * `activity` (src/behavior/activity.js#createActivity, fed by src/behavior/pipeline.js; optional)
 * tells when each person last wrote in each channel: a turn answering a person waits on it
 * (pace.settleMs, settleAuthor below); absent, no turn waits.
 * `journal` (src/memory/journal.js#createJournal; optional): with features.journal exactly
 * true (read at the moment of use), every attempt that passes the pause and attention rails
 * writes a `turn.start` line, and runTurn writes each attempt's `turn` record once it returns
 * (journalTurnRecord); `turn: model answered` then logs `thinkChars` instead of `think`.
 * Every side effect of such an attempt is a journal operation (journalOp): `started` before
 * it, then `succeeded`, `failed` or `unknown` -- the persona's posts, reactions, GIFs and
 * pictures (`by: 'persona'`; a dry run writes `started` and `succeeded` with `dryRun: true`),
 * and the engine's preparation (`by: 'engine'`: link reads, video watches, captions, the
 * searches; createPrepLedger says whether each result reached the request). A post's
 * `started` line carries its `intent` (the message it replies to, the first 80 characters of
 * its text) for the reconciliation after a restart (src/memory/journal.js#reconcile).
 * `record` (src/memory/record.js#createRecord; optional): with features.record exactly true
 * (read at the moment of use), every message of the persona that reached the chat is appended
 * to it as a `said` line (recordSaid), with the turn's and the post operation's ids when the
 * journal follows the attempt.
 *
 * Trigger links: every message a turn with a trigger posts (a message, a GIF, a picture) is
 * remembered in process with the id of that trigger (`seedTriggerLinks` adds the ones the journal
 * kept from before a restart). With features.triggerMarkers on (a missing key counts as on, read
 * per turn) the persona's own lines of the turn's history and of its pulled channels carry it
 * (src/format.js#withTriggers), so the request's `<chat>` and `<channel_view>` and every
 * helper transcript built from that history name the message that started the turn which posted
 * each line (`transcript.triggeredBy` / `triggeredByOlder`). The neighbours' lines show no `#n`
 * and carry none. A spontaneous turn, a diary post or a dry run links nothing.
 *
 * Call marks: every skill call she makes (runCall: its skill, status, target and the messages its
 * turn posted) is remembered in process, `seedCallMarks` adding the ones the journal kept from
 * before a restart; a message a call posted in another channel than its turn's remembers that
 * channel. With features.callMarkers on (a missing key counts as on, read per turn) the lines of
 * the turn's history and of its pulled channels carry them (src/format.js#withCalls,
 * linkCalls), so she sees what she called and how it went, in the channel where she called it.
 *
 * Skills and the interface: every effect of a reply -- a message with its reply target and
 * mentions, the GIF, the picture's publication after its generation, a diary set's pictures, a
 * reaction, the typing indicator -- is checked by src/skills/gateway.js#checkReplyEffect right
 * before it runs (`message.create`, a picture or GIF being one with its media or URL, and
 * `message.react.add`: carried over in the current conversation, refused only under the full stop
 * -- features.skills false, she goes silent; each refusal logs `skill: refused` (`skill`, `code`,
 * `reason`) and nothing is done; no picture or diary set is generated for a post the check
 * already refuses, and no typing indicator shows), then made through the interface port `port`
 * (src/interface/port.js; without one, the adapter `createPort({ client, lookupChannel })` builds
 * -- the Discord adapter's factory, as the tests and the tools pass it --, holding the channels the
 * turn hands it). Nothing counts as posted (journal, record, stats, lastPostAt) unless the port
 * answered `ok`; `unknown` is journaled as unknown and never sent again. A dry run calls neither
 * the gateway nor the port.
 *
 * Skill calls: her skills are the owner's /nep commands (src/skills/registry.js; `skills`: the
 * registry checked against, default skillRegistry()). The first top-level `<call>` of her output
 * (src/llm/parse.js; any later one, or a malformed first one, is logged `skills: extra-call` /
 * `skills: bad-call` and ignored; a diary post drops it) is planned before her reply is acted on
 * (planCall: on an immutable envelope built by code, callEnvelope; journaled `proposed` with its
 * invocation id, resolved on the server's side, checked) and made after it (runCall: checked
 * again right before, then run by src/skills/executors.js through `runCommand(key, args,
 * context)` -- src/admin.js#runCommand, the command's own path, the requester's rights checked
 * again; absent, a call is `not_configured`; her own expressive operations through
 * `runOwnCommand`, src/admin.js#runOwnCommand, her grant alone; an inner turn's calls through
 * `runInitiativeCommand`, src/admin.js#runInitiativeCommand, her grant alone). An operation's answer -- an error or a refusal
 * included -- or any call that did not succeed (never under features.skills off) brings one
 * follow-up request that continues the turn (followUp, features.followUpContinuation; a missing
 * key counts as on): the turn's request rebuilt over the channel as it stands then -- her posts of
 * the turn as her lines, this call's mark (how it went and why) on her line, what others wrote
 * meanwhile as later lines --, a read's data in a `<result>` block before `<task>`, and the
 * continue task; with the switch off, the reply request again with a `<result>` block (what she
 * already posted, then the outcome) before `<task>`. Its answer is acted on like the reply, a
 * `<call>` in it dropped and logged, never a second follow-up. A message or a
 * picture that went out is its own answer. A dry run only logs the call (`dry-run: would
 * call`).
 *
 * Reactors: `reactors` (interfaces/discord/reactors.js#createReactorStore, null: none) is the store of
 * who reacted to her messages; the turn's history fetch names them on her lines (historyOptions).
 *
 * Intentions: `intentions` (src/intentions/service.js#createIntentionService, null: none) gives the
 * `<intentions>` block of every turn but a diary post while features.intentions is exactly true.
 *
 * Discord:`discord` is the Discord interface's capabilities object
 * (interfaces/discord/index.js#createDiscordInterface, injected by src/index.js): the permission
 * checks, the history, reply-parent and neighbour fetches, the pulled channels and the audience
 * rules a turn asks Discord for. Nothing here imports the interface.
 */
export function createTurnRunner({
  hot,
  store,
  llm,
  calibrator,
  client,
  rng = Math.random,
  describer,
  fetchImpl = fetch,
  imageFetcher = createImageFetcher(),
  lookup,
  recall = null,
  images,
  emoji,
  getSelfName = (guildId) => client.guilds?.cache?.get(guildId)?.members?.me?.displayName ?? client.user?.username ?? 'bot',
  routeChannels,
  now: clock = Date.now,
  schedule = scheduleTimer,
  isWarmingUp = () => false,
  activity = null,
  journal = null,
  record = null,
  port = null,
  createPort = null,
  discord,
  skills = null,
  runCommand = null,
  runOwnCommand = null,
  runInitiativeCommand = null,
  around = null,
  reactors = null,
  errands = null,
  intentions = null,
  // The places view of the inner life (src/behavior/inner.js#places): `<places>` on an addressed turn with `context.places` on.
  places = null,
}) {
  const { audienceAllows, audienceOf, canAttach, canSend, captionPulled, channelDirectoryOf, checkPull, createPullViews, fetchHistory, fetchNeighbors, fetchPull, withTextPreviews } = discord;
  const busy = new Set();
  // The drawing agent's tool over the injected image client (src/errands/tools.js): every picture
  // of a turn, a diary post or a diary set is made through it.
  const drawing = images ? createDrawingTool({ images, hot, client, imageFetcher, now: clock }) : null;
  // Per guild: what the stable part of the reply showed from memory in the current cache bucket
  // (src/behavior/prompt.js#freezePerBucket), in process only; a restart starts afresh.
  const stableFreezes = new Map();
  const stableFreezeOf = (guildId) => {
    const key = String(guildId ?? '');
    if (!stableFreezes.has(key)) stableFreezes.set(key, new Map());
    return stableFreezes.get(key);
  };
  // The channels the default adapter may resolve by id without the client (the turn's own and a
  // pulled line's), in process, the oldest dropped past HELD_CHANNELS_MAX.
  const heldChannels = new Map();
  const iface = port ?? createPort({ client, lookupChannel: (id) => heldChannels.get(id) ?? null });

  /** The port reference of `channel` (the default adapter now holds that object). */
  function conversationOf(channel) {
    const id = String(channel.id);
    heldChannels.delete(id);
    heldChannels.set(id, channel);
    while (heldChannels.size > HELD_CHANNELS_MAX) heldChannels.delete(heldChannels.keys().next().value);
    return { iface: iface.iface, conversationId: id };
  }

  /** The port reference of message `messageId` in `channel`. */
  function messageOf(channel, messageId) {
    return { ...conversationOf(channel), messageId: String(messageId) };
  }

  /**
   * The gateway's verdict on one effect of the persona's reply in `channel`
   * (src/skills/gateway.js#checkReplyEffect, the live config read now): carried over in the
   * current conversation, refused only under the full stop. `args` and `trigger` name the effect
   * for the reader; the check needs neither. A refusal logs `skill: refused`.
   * @returns {{ ok: boolean, code?: string, reason?: string }}
   */
  function checkEffect(skill, _args, { channel }) {
    const verdict = checkReplyEffect({ skill, principal: PERSONA, config: hot.config });
    if (!verdict.ok) log.info('skill: refused', { skill, code: verdict.code, reason: verdict.reason, channel: channel.id });
    return verdict;
  }

  /**
   * What skills discovery gives a classifier (src/skills/discovery.js, the live config read by
   * the caller now): `index` fills its prompt's `{{skills}}` (skillsIndex over the registry and
   * `hot.prompts.skills`: static texts, no grant), `names` are the registry's skills its `skills:`
   * line may name. With discovery off, '' and none.
   * @returns {{ index: string, names: string[] }}
   */
  function discoveryPrompt(config) {
    if (!discoveryOn(config)) return { index: '', names: [] };
    // Her in-turn tools are hers to call (features.coreTools, where no classifier runs): never offered to one.
    // A skill whose feature switch is off is not offered either (src/skills/access.js#skillFeatureOn).
    const registry = new Map([...(skills ?? defaultSkills())].filter(([name]) => !IN_TURN_TOOLS.includes(name) && skillFeatureOn(name, config)));
    const names = [...registry.keys()];
    return { index: skillsIndex(registry, hot.prompts?.skills), names };
  }

  /**
   * What a classifier's `skills:` line (`answer`: parseSkillsLines' result, null when it gave
   * none) does on a turn someone asked for, with discovery on (read by the caller now). The
   * catalogue of this requester (`trigger`'s author) in `channel` (src/skills/gateway.js#listSkills,
   * the state read now) decides both: on `inventory` its rows are returned for the request's
   * `<skills>` (logged `skills: inventory` with counts); on named skills (at most four) each name
   * with the gateway's verdict is logged `skills: proposed` and noted in the draft's
   * `skillsProposed` (`{ name, allowed }`) for the journal's turn record, and their catalogue rows
   * are returned marked `proposed` (`<skills>` then shows the allowed ones and names the others).
   * Null otherwise. Names and codes only, never a message.
   * @returns {object[]|null}
   */
  function discoverSkills({ config, channel, trigger, answer, draft }) {
    if (!answer || !discoveryOn(config)) return null;
    const named = Array.isArray(answer.names) ? answer.names : [];
    if (answer.inventory !== true && named.length === 0) return null;
    const rows = listSkills({
      config,
      selfId: client?.user?.id ?? null,
      texts: hot.prompts?.skills,
      requester: requesterOf(trigger, channel),
      audience: { conversationId: String(channel.id) },
      registry: skills ?? defaultSkills(),
    });
    if (answer.inventory === true) {
      log.info('skills: inventory', { channel: channel.id, listed: rows.length, allowed: rows.filter((row) => row.allowed).length });
      return rows;
    }
    const proposals = proposalVerdicts(named, rows);
    log.info('skills: proposed', { channel: channel.id, count: proposals.length, proposals });
    if (draft) draft.skillsProposed = proposals.map(({ name, allowed }) => ({ name, allowed }));
    return proposedRows(proposals, rows);
  }

  /** The tasks `<tasks>` lists: her open errands and unread results (`errands.view`), the one `taskResult` brings left out. */
  function listedTasks({ guildId, channel, isPrivate, taskResult }) {
    let shown = [];
    try {
      shown = typeof errands?.view === 'function' ? errands.view({ guildId, privateChannelId: isPrivate ? String(channel.id) : null }) : [];
    } catch (err) {
      log.warn('turn: tasks view failed', { channel: channel.id, error: err });
    }
    return (Array.isArray(shown) ? shown : []).filter((task) => task?.id !== taskResult?.id);
  }

  /**
   * The request's `errands` input (buildRequest): the `<tasks>` body -- her open errands and the
   * finished ones she has not read (`errands.view`: a private chat's only in that chat; at most
   * `agents.unreadShown` of them), the one `taskResult` brings left out -- and, on the turn an
   * errand's end opened (`taskResult`, trigger kind `task`), the `<task_result>` body cut to
   * `agents.resultMaxChars` (read now). Showing a task marks nothing: it is read by the result
   * turn that completed (src/errands/turns.js) or by `task.read`. Null when there is nothing to show.
   */
  function errandsInputFor({ guildId, channel, isPrivate, taskResult, config, labels, now }) {
    const listed = listedTasks({ guildId, channel, isPrivate, taskResult });
    const tasks = tasksBlockText(listed, labels, { now, unreadShown: config.agents?.unreadShown });
    const result = taskResult ? taskResultText(taskResult, labels, { maxChars: config.agents?.resultMaxChars ?? DEFAULT_RESULT_MAX_CHARS }) : '';
    return tasks || result ? { tasks, result } : null;
  }

  /**
   * The request's `<intentions>` body (features.intentions exactly true, read now): her open
   * intentions and the candidates proposed from her lines (`intentions.view`: a private chat's
   * own only in that chat), cut to `context.caps.intentions` tokens (src/intentions/blocks.js).
   * '' with the switch off, without the service, or with nothing to show.
   */
  function intentionsInputFor({ guildId, channel, isPrivate, config, labels, now }) {
    if (!intentions || config.features?.intentions !== true) return '';
    let shown = [];
    try {
      shown = intentions.view(guildId, { privateChannelId: isPrivate ? String(channel.id) : null });
    } catch (err) {
      log.warn('turn: intentions view failed', { channel: channel.id, error: err });
      return '';
    }
    const channelNameOf = (id) => channel.guild?.channels?.cache?.get?.(String(id))?.name ?? null;
    const nameOf = (id) => (typeof store?.getUser === 'function' ? store.getUser(guildId, String(id))?.names?.[0] ?? null : null);
    return intentionsBlockText(shown, labels, {
      timezone: config.bot?.timezone ?? 'UTC',
      locale: labels?.locale,
      maxTokens: config.context?.caps?.intentions ?? DEFAULT_INTENTIONS_CAP,
      channelNameOf,
      nameOf,
      now,
      expiryNoticeDays: intentionSettings(config).expiryNoticeDays,
    });
  }

  /**
   * The request's `<places>` body (context.places exactly true, read now; src/behavior/wake.js#placesBlockText):
   * the first `innerLife.attention.placesInWake` places by recent activity (0: none), from the inner
   * life's places view. '' with the switch off, without the view, or when it fails.
   */
  function placesInputFor({ guildId, config, labels }) {
    if (config.context?.places !== true || typeof places !== 'function') return '';
    const size = innerSettings(config).attention.placesInWake;
    if (!(size > 0)) return '';
    try {
      return placesBlockText(places(guildId, { sort: 'recent', page: 1, pageSize: size }), labels);
    } catch (err) {
      log.warn('turn: places view failed', { guildId, error: err });
      return '';
    }
  }

  /** What a `<call>` of the persona is resolved against: callViewOf over this runner's store, id and registry. */
  function callView({ channel, guildId, idByIndex, lines, pulledIds, memoryOn, channelHandles = null, memberHandles = null, trigger = null, deletedIds = null }) {
    const fileOf = typeof errands?.fileOf === 'function' ? (handle) => errands.fileOf({ guildId, handle, privateChannelId: channel.guild ? null : String(channel.id) }) : null;
    return callViewOf({ channel, guildId, idByIndex, lines, pulledIds, memoryOn, store, selfId: client?.user?.id ?? null, skills: skills ?? defaultSkills(), channelHandles, memberHandles, fileOf, triggerText: typeof trigger?.content === 'string' ? trigger.content : null, deletedIds });
  }

  /**
   * The gateway's verdict on a resolved `<call>` (src/skills/gateway.js#checkSkill, the live
   * config read now): the persona as principal, the envelope's requester (callEnvelope), the
   * turn's channel as the audience, the last run of a destructive skill from the origin channel
   * (`destructiveRuns`), the image client's caps as the drawing budget. A refusal logs
   * `skill: refused`.
   */
  function checkCall(resolved, { channel, envelope, draft = null }) {
    const verdict = checkSkill({
      skill: resolved.skill,
      args: resolved.args,
      principal: PERSONA,
      requester: envelope.requester,
      audience: { conversationId: String(channel.id) },
      context: {
        config: hot.config,
        selfId: client?.user?.id ?? null,
        registry: skills ?? defaultSkills(),
        mixedRequesters: envelope.mixed,
        // An inner turn, or the result turn of her own errand, is her own initiative: nobody asked, her grants alone decide.
        ...(draft?.inner || draft?.ownInitiative ? { ownInitiative: true } : {}),
        lastRunAt: destructiveRuns.get(`${resolved.skill}:${envelope.originChannelId}`) ?? null,
        now: clock(),
        ...(images ? { images } : {}),
        // An errand's caps are its budget (src/errands/service.js#budget), in the turn's guild.
        ...(errands ? { tasks: { budget: (agent) => errands.budget({ guildId: channel.guild?.id ?? null, agent }) } } : {}),
      },
    });
    if (!verdict.ok) log.info('skill: refused', { skill: resolved.skill, code: verdict.code, reason: verdict.reason, channel: channel.id });
    return verdict;
  }

  /**
   * The persona's `<call>` (`call`: src/llm/parse.js's) planned before anything of her reply is
   * done: its journal operation (`skill`, by the persona) writes `proposed` with the skill, the
   * envelope's invocation id and the names of its arguments, then the call is resolved on the server's side (`view`: callView's)
   * and checked (checkCall). Resolves `{ call, op, resolved, refusal }`: `resolved` null and
   * `refusal` (`{ code, reason }`) when either said no -- a refusal of the resolution logs
   * `skill: refused` too; a body the skill takes no text for, left out by the resolution, logs
   * `skills: body ignored` (`skill`, never the text); one that fills the skill's body argument
   * logs `skills: body as argument` (`skill`, `arg`, never the text); one read as its arguments logs
   * `skills: body read as arguments` (`skill`, `count`, never the values). Nothing runs here.
   */
  async function planCall({ call, channel, envelope, draft, view }) {
    // A call of an inner turn in shadow mode is only proposed: its lines say so (no call mark is drawn from them).
    const op = journalOp(draft, 'skill', 'persona', { input: { skill: call.skill, invocationId: envelope.invocationId }, ...(draft?.inner?.shadow ? { shadow: true } : {}) });
    if (op.opId) await op.proposed({ input: { skill: call.skill, invocationId: envelope.invocationId, args: Object.keys(call.args ?? {}), body: Boolean(call.body) } });
    // An inner turn's tag that cannot act (src/behavior/inner-output.js): refused before anything is resolved or done.
    if (call.refuse) {
      log.info('skill: refused', { skill: call.skill, code: call.refuse.code, reason: call.refuse.reason, channel: channel.id });
      return { call, op, envelope, resolved: null, refusal: { code: call.refuse.code, reason: call.refuse.reason } };
    }
    const resolved = resolveCall(call, view);
    if (!resolved.ok) {
      log.info('skill: refused', { skill: call.skill, code: resolved.code, reason: resolved.reason, channel: channel.id });
      // An errand's file bound for a channel nobody named (src/skills/executors.js#resolveCall).
      if (resolved.code === CODE.FILE_ELSEWHERE) log.info('skills: file elsewhere refused', { skill: call.skill, code: resolved.code, reason: resolved.reason, channel: channel.id });
      // Several errand file handles written in the body (src/skills/executors.js#resolveCall).
      if (resolved.reason === 'file:several') log.info('skills: file handle in body', { skill: call.skill, code: resolved.code, reason: resolved.reason, channel: channel.id });
      return { call, op, envelope, resolved: null, refusal: { code: resolved.code, reason: resolved.reason } };
    }
    // Her comment in the body of a skill that takes no text: left out, the call goes on (never its text in the log).
    if (resolved.bodyIgnored) log.info('skills: body ignored', { skill: resolved.skill, channel: channel.id });
    // The body as the skill's main argument (an errand's goal, her text), the call leaving it out: named, never its text.
    if (resolved.bodyArg) log.info('skills: body as argument', { skill: resolved.skill, arg: resolved.bodyArg, channel: channel.id });
    // An errand's file handle written in the body: moved to the file argument (never the text).
    if (resolved.fileFromBody) log.info('skills: file handle in body', { skill: resolved.skill, code: CODE.MOVED, textLeft: resolved.args?.[resolved.command?.body] !== '', channel: channel.id });
    // Her arguments written in the body instead of as attributes: taken, counted (never the values).
    if (Number.isInteger(resolved.bodyArgs)) log.info('skills: body read as arguments', { skill: resolved.skill, count: resolved.bodyArgs, channel: channel.id });
    const verdict = checkCall(resolved, { channel, envelope, draft });
    return { call, op, envelope, resolved: verdict.ok ? resolved : null, refusal: verdict.ok ? null : { code: verdict.code, reason: verdict.reason } };
  }

  /** The ids a resolved call aims at (its channel, message, reply target, member), for its journal line: never its text. */
  function callTarget(args) {
    const out = {};
    for (const key of ['channel', 'message', 'reply', 'user']) if (typeof args?.[key] === 'string') out[key] = args[key];
    return out;
  }

  /**
   * What an inner turn's gate says of one call of hers (`inner`: the turn's `inner` parameter):
   * a read (its effect class) always runs; in shadow mode anything else is `proposed` and never
   * runs; live, a stopped inner life (`mayAct`, asked now) refuses it (`inner-stopped`). No count of posts refuses a call.
   * `public` says whether a call that runs is a public post.
   * @returns {{ proposed?: true, refusal?: { code: string, reason: string }, public?: boolean }|null}
   */
  function innerVerdict(inner, skill, { channel, args }) {
    const effects = (skills ?? defaultSkills()).get(skill)?.effects ?? null;
    if (effects === 'read') return null;
    if (inner.shadow) return { proposed: true };
    if (typeof inner.mayAct === 'function' && !inner.mayAct()) return { refusal: { code: CODE.INNER_STOPPED, reason: 'innerLife' } };
    const isPublic = POSTING_SKILLS.includes(skill) && (Boolean(channel.guild) || typeof args?.channel === 'string');
    return { public: isPublic };
  }

  /**
   * The planned call (planCall's) made, after her reply's own effects: a refusal at the plan is
   * closed `failed` with its code (status `invalid` or `denied`, refusalStatus); otherwise the
   * gateway is asked again right before the call (the owner may have revoked it meanwhile), the
   * operation writes `started` with the ids it aims at, a destructive one is stamped for its
   * cooldown, and src/skills/executors.js#executeCall runs it on the envelope through
   * `runCommand` (`skills.callTimeoutMs`, read now); her written text (`message.create`,
   * `message.edit`) is rendered first exactly as a `<msg>` of this turn (renderPost over the
   * turn's `handles`, or `lines`, `knownNames`, `directory`, and `idByIndex`, `pulledIds`), its mentions the only members
   * notified. The operation closes `succeeded` (with the
   * message id), `unknown` (never retried) or `failed` with the code. A message or picture that reached another conversation
   * stamps its lastPostAt, links its trigger, and a message is a `said` line of the record.
   * Logged `skills: called` (`skill`, `status`, `code`). Resolves the result with `skill` and
   * `followUp` (src/skills/executors.js#needsFollowUp). Never throws.
   * @returns {Promise<{ skill: string, status: string, code?: string, data?: object, followUp: boolean }>}
   */
  async function runCall(plan, { channel, trigger, guildId, draft, privateChat = false, idByIndex = null, pulledIds = null, lines = [], knownNames = [], directory = null, handles = null, channelHandles = null, timeoutMs = null, inTurn = null }) {
    const { call, op, envelope } = plan;
    const skill = call.skill;
    // Her written text (message.create / message.edit) rendered as a `<msg>` of this turn is.
    let rendered = null;
    const renderText = (text) => (rendered = renderPost(text, { channel, guildId, privateChat, idByIndex, pulledIds, lines, knownNames, directory, handles, channelHandles, limits: draft?.limits ?? null }));
    let result;
    // A refusal keeps its machine reason (a schema path, an option name): the call mark says why (outcomeDetail).
    const refusedWith = (refusal) => ({ status: refusalStatus(refusal.code), code: refusal.code, ...(refusal.reason ? { reason: refusal.reason } : {}) });
    // An inner turn (src/behavior/inner.js): anything but a read is only proposed in shadow mode,
    // refused once the kill switch stopped it (asked right here, before the action), and a public
    // post past the day's cap is refused too.
    const inner = draft?.inner ?? null;
    const innerGate = inner && !plan.refusal ? innerVerdict(inner, skill, { channel, args: plan.resolved?.args ?? {} }) : null;
    // Whether the call was dispatched (its operation ran, whatever it answered).
    let ran = false;
    if (plan.refusal) result = refusedWith(plan.refusal);
    else if (innerGate?.proposed) result = { status: 'ok', code: CODE.SHADOW };
    else if (innerGate?.refusal) result = refusedWith(innerGate.refusal);
    else {
      const verdict = checkCall(plan.resolved, { channel, envelope, draft });
      if (!verdict.ok) result = refusedWith(verdict);
      else {
        if (op.opId) await op.started({ target: callTarget(plan.resolved.args) });
        ran = true;
        // A destructive call counts from its dispatch, whatever comes back.
        if (plan.resolved.command && (skills ?? defaultSkills()).get(skill)?.effects === 'destructive') destructiveRuns.set(`${skill}:${envelope.originChannelId}`, clock());
        result = await executeCall(plan.resolved, {
          port: iface,
          refOf: (conversationId) => ({ iface: iface.iface, conversationId: String(conversationId) }),
          renderText,
          envelope,
          runCommand,
          runOwnCommand,
          runInitiativeCommand,
          opContext: { guildId, channelId: String(channel.id), ...(privateChat ? { privateChat: true } : {}) },
          timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : (hot.config.skills?.callTimeoutMs ?? 120000),
          // Her in-turn tools (features.coreTools): run here, in the turn, over its context.
          ...(inTurn ? { inTurn } : {}),
        });
      }
    }
    // What a read of hers returned is outside material her later lines of the turn may repeat.
    if (ran && result.status === 'ok' && typeof result.data?.text === 'string' && result.data.text && (skills ?? defaultSkills()).get(skill)?.effects === 'read') noteSeen(draft, result.data.text, { read: true });
    if (inner) {
      // The intention a call of hers named, however it went: the open-intentions line of the next
      // step (openIntentionsText) no longer lists it; the action record carries it, and the state
      // an intent.update set (`done`, `pending`), for the feedback facts (src/behavior/inner.js#feedbackFacts).
      const named = intentionNamed(skill, plan.resolved?.args ?? call.args ?? {});
      const state = skill === 'intent.update' ? (plan.resolved?.args?.state ?? call.args?.state ?? null) : null;
      (draft.innerActions ??= []).push({ skill, status: innerGate?.proposed ? 'proposed' : ran ? 'executed' : 'refused', result: result.status, ...(result.code ? { code: result.code } : {}), ...(result.status !== 'ok' ? callTextOf(result, hot.config.skills?.markTextMaxChars ?? 200) : {}), target: callTarget(plan.resolved?.args ?? {}), ...(named ? { intentionId: named } : {}), ...(typeof state === 'string' && state ? { state } : {}) });
      if (named) (draft.innerIntentIds ??= new Set()).add(named);
      // What a read of hers found, for the memory episode of the turn (src/memory/inner-episode.js).
      if (ran && result.status === 'ok' && typeof result.data?.text === 'string' && result.data.text && (skills ?? defaultSkills()).get(skill)?.effects === 'read') {
        (draft.innerFindings ??= []).push({ skill, args: { ...(plan.resolved?.args ?? {}) }, text: result.data.text });
      }
      // A proposed call never ran: the journal keeps its `proposed` line (marked shadow), no mark, no closing line.
      if (innerGate?.proposed) {
        log.info('skills: proposed', { channel: channel.id, skill, shadow: true });
        return { skill, ...result, followUp: false };
      }
    }
    if (op.opId) {
      if (result.status === 'ok') await op.succeeded(journalResultOf(result));
      else if (result.status === 'unknown') await op.unknown({ code: result.code ?? null, ...valuesOf(result) });
      else await op.failed(result.code ?? CODE.ERROR, { status: result.status, ...(typeof result.reason === 'string' && result.reason ? { reason: result.reason } : {}), ...valuesOf(result) });
    }
    const args = plan.resolved?.args ?? {};
    // A text that went out with its GIF failing (`partial`) was said all the same.
    const posted = (result.status === 'ok' || (result.status === 'partial' && result.code === CODE.GIF_FAILED)) && (skill === 'message.create' || skill === 'draw.create') && result.ref ? postedOf(result) : null;
    // Every message the turn posted, its follow-up's included (act adds them as they go out).
    const turnPosts = draft ? (draft.ownPosts ??= []) : [];
    const where = posted ? String(result.ref.conversationId ?? args.channel ?? channel.id) : null;
    if (posted) {
      lastPostAt.set(where, clock());
      noteTrigger(posted.id, trigger?.id);
      if (!turnPosts.includes(posted.id)) turnPosts.push(posted.id);
      if (where !== String(channel.id)) notePostedFrom(posted.id, String(channel.id));
      if (skill === 'message.create') {
        noteLineSources(draft, posted.id, args.text);
        recordSaid({ guildId, channel: { id: where }, privateChat: false, trigger, draft, op, posted, text: args.text, replyId: args.reply ?? null, repliedAuthorId: plan.resolved.repliedAuthorId ?? null, userIds: rendered?.userIds ?? [] });
      }
    }
    const idText = (value) => (typeof value === 'string' && value ? value : null);
    // A shadow inner turn leaves no lasting mark on her transcript (nobody saw it); its calls that
    // did not work are marked for the rest of this turn only (`draft.turnMarks`), so she hears why
    // and may correct the call within the loop.
    const markCall = inner?.shadow ? (mark) => (draft.turnMarks ??= []).push(mark) : noteCall;
    markCall({
      channelId: String(channel.id),
      at: clock(),
      skill,
      status: result.status,
      // Why it did not work, when it did not (the mark words it through labels.transcript.callReasons;
      // without a specific phrase, the operation's own message before the generic one: one line,
      // skills.markTextMaxChars, read now). In process only: the journal keeps the code and reason,
      // never that message.
      detail: outcomeDetail(result, { textChars: hot.config.skills?.markTextMaxChars ?? 200, argNames: (skills ?? defaultSkills()).get(skill)?.command?.options?.map((option) => option.name) ?? null }),
      target: { messageId: idText(args.message) ?? idText(args.reply), channelId: where ?? idText(args.channel) },
      postedId: posted?.id ?? null,
      posted: turnPosts,
    });
    log.info('skills: called', { channel: channel.id, skill, status: result.status, ...(result.code ? { code: result.code } : {}), ...(result.status !== 'ok' && result.error ? { error: portError(result) } : {}) });
    return { skill, ...result, followUp: needsFollowUp(skill, result) };
  }

  /**
   * The options of a turn's history fetch (interfaces/discord/collect.js#fetchHistory) under `config`:
   * with the reactor store (`reactors`), features.reactionNames and features.seeReactions on (a
   * missing key counts as on), the persona's lines carry who reacted to them, the missing reactors
   * fetched within `context.reactions.fetchTimeoutMs`.
   */
  function historyOptions(config, inner = false) {
    const namesOn = reactors && config.features?.reactionNames !== false && config.features?.seeReactions !== false;
    return {
      // An inner turn reads a bounded recent slice (innerLife.chatMessages).
      limit: inner ? innerSettings(config).chatMessages : config.context.channelMessages,
      selfId: client.user.id,
      embedTextChars: config.media?.embedTextChars,
      videoSites: config.media?.video?.sites,
      maxUrlChars: config.context?.maxUrlChars,
      reactors: namesOn
        ? { store: reactors, budgetMs: config.context.reactions?.fetchTimeoutMs ?? 2000, fetchUsers: config.context.reactions?.fetchUsers ?? 10 }
        : null,
    };
  }

  /**
   * The request that continues the turn after the persona's skill call (`called`, runCall's):
   * the turn's own request (`continuation.input`, buildRequest's input as the turn built it)
   * rebuilt over the channel as it stands now -- the turn's history, then a fresh fetch and her
   * posts of the turn (continuationHistory over act's `lines`), with her trigger links and call
   * marks put on again (linkTriggers, linkCalls: this call's mark, why it did not work included,
   * on her last line of the turn here, or a line of its own) -- at the clock's time, with
   * `labels.task.continue` as its task (buildRequest's `continuation`). An `ok` call's data (a
   * read's answer) comes apart from the transcript in a `<result>` block right before `<task>`
   * (skillResultBlock, cut to `skills.resultMaxChars`, read now -- a memory.search result to `recall.quoteMaxChars`, resultCharsFor; withSkillResult); a call that
   * did not work has none: its mark says how it went. A
   * failed fetch logs `skills: continuation fetch failed` and goes on with the turn's history and
   * her posts. Resolves the messages and
   * what act needs to act on the answer over the new transcript (`idByIndex`, `history`,
   * `lines` with the pulled lines shown, `pulledIds`, the mention `handles` of the rebuilt request).
   */
  async function continuationRequest({ called, channel, guildId, acted, continuation, results = null, label = null, own = null, turnMarks = null, open = '', names = null, dropped = null }) {
    const { input, history, shownLines = [] } = continuation;
    let fetched = [];
    try {
      fetched = await fetchHistory(channel, historyOptions(hot.config, input.mode === 'inner'));
    } catch (err) {
      log.warn('skills: continuation fetch failed', { channel: channel.id, error: err });
    }
    // The tool loop (toolLoop) hands every result of the turn so far, her posts of every step
    // and its own task label; the one follow-up after a call hands the call alone.
    const outcomes = results ?? [called];
    // `names`: the calls the step follows when they left no result to show (an inner turn's open follow-up).
    const skillNames = [...new Set((Array.isArray(names) && names.length > 0 ? names : outcomes.map((outcome) => outcome.skill)).filter(Boolean))].join(', ');
    const lines = linkCalls(linkTriggers(continuationHistory({ history, fetched, own: own ?? acted?.lines ?? [], selfName: input.selfName })), { channel, guildId, extra: turnMarks });
    const request = buildRequest({ ...input, history: lines, now: clock(), continuation: { skill: skillNames, ...(label ? { label } : {}), open: typeof open === 'string' ? open : '', ...(dropped ? { dropped } : {}) } });
    const labels = input.prompts?.labels ?? {};
    // Each read's data in its own block, in the order the calls were made: a later step only appends.
    const resultBlock = outcomes
      .filter((outcome) => outcome.status === 'ok' && outcome.data)
      .map((outcome) => skillResultBlock(outcome, labels, { maxChars: resultCharsFor(outcome, hot.config) }))
      .filter(Boolean)
      .join('\n\n');
    return {
      messages: withSkillResult([request.messages[0], request.messages[1]], resultBlock),
      routing: { idByIndex: request.idByIndex, history: lines, lines: [...shownLines, ...lines], pulledIds: request.pulledIds ?? new Map(), handles: request.handles ?? null, channelHandles: request.channelHandles ?? null },
    };
  }

  /**
   * The one follow-up request after a skill call (runCall's `called`, whose `followUp` is true).
   * With continuesTurn (features.followUpContinuation and the call marks on, read now; the
   * labels the turn's request was built with) and a `continuation` (the turn's request input,
   * its history and the pulled lines it showed) it continues the turn:
   * continuationRequest -- the channel as it stands now with this call's mark on her line, the
   * continue task, an `ok` call's data in `<result>` -- and act answers over that transcript.
   * Otherwise (the switch off: the earlier framing, kept to compare) the reply request as it was
   * sent (`sentMessages`) with the `<result>` block -- led by what the first pass (`acted`, act's
   * answer) already posted, one line each (firstPass) -- (src/behavior/prompt.js#skillResultBlock:
   * labels read now, the data cut to `skills.resultMaxChars`, read now) right before its `<task>`
   * (withSkillResult). Either way the parts before the tail are the reply's, so the cached parts
   * are reused. The answer is parsed and shaped like the reply (`shapeOutput`); a `<call>` in it
   * is dropped and logged (`skills: extra-call` with `followUp: true`, `continuation` when it
   * continued): no chains, never a second follow-up. What is left is acted on through `act`. The
   * request goes through the same client and rails as the reply; a failure (a rail, the
   * provider, the rebuild) logs `skills: follow-up failed` and posts nothing. An answer cut off at
   * its output cap keeps its complete actions; with none (cutOffOf) nothing is posted and it
   * resolves `{ cutOff: true }`. Resolves act's answer, or null.
   */
  async function followUp({ called, channel, guildId, draft, sentMessages, shapeOutput, acted = null, act: actOn, continuation = null }) {
    const continued = continuation !== null && continuesTurn(hot.config, continuation.input?.prompts?.labels);
    let messages = null;
    let routing = null;
    let completion;
    try {
      if (continued) ({ messages, routing } = await continuationRequest({ called, channel, guildId, acted, continuation, turnMarks: draft?.turnMarks ?? null }));
      else {
        const labels = hot.prompts?.labels ?? {};
        const block = skillResultBlock(called, labels, { maxChars: resultCharsFor(called, hot.config), posted: firstPass(acted, labels) });
        messages = withSkillResult(sentMessages, block);
      }
      completion = await llm.complete(messages, { ...REPLY_REQUEST, ...(draft?.started ? { limits: draft.limits } : {}) });
    } catch (err) {
      log.warn('skills: follow-up failed', { channel: channel.id, skill: called.skill, error: err });
      return null;
    }
    dumpTurnRequest(guildId, draft, messages, completion, 1);
    const parsed = shapeOutput(parseOutput(completion.text, { maxDrawChars: hot.config.image?.maxPromptChars, limits: draft?.limits ?? null }));
    if (parsed.call || parsed.callError) log.info('skills: extra-call', { channel: channel.id, count: 1, followUp: true, ...(continued ? { continuation: true } : {}) });
    parsed.call = null;
    parsed.gif = resolveGif(guildId, parsed.gif, channel.id, draft?.limits ?? null);
    log.info('skills: follow-up answered', {
      channel: channel.id,
      skill: called.skill,
      status: called.status,
      continuation: continued,
      usage: completion.usage,
      messages: parsed.messages.length,
      reactions: parsed.reactions.length,
      draw: Boolean(parsed.draw),
      gif: Boolean(parsed.gif),
    });
    const empty = parsed.skip || (parsed.messages.length === 0 && parsed.reactions.length === 0 && !parsed.draw && !parsed.gif);
    const cutOff = cutOffOf(completion, parsed, { channelId: channel.id, empty, followUp: true });
    if (cutOff && !cutOff.kept) return { cutOff: true };
    if (empty) return null;
    return actOn(parsed, routing);
  }

  /**
   * Her in-turn tools for one turn (features.coreTools, read now; src/skills/tools.js): skill name
   * -> `(args) => result`, run by src/skills/executors.js#executeCall in place of the operation's
   * command, over the turn's own context -- `web.search` through the turn's `lookup`, `web.read`
   * too (a `#N` message she names read as its first link in `history`: an embedded one, else one
   * written in its text), `media.look` through the turn's `describer` (a `#N` message she names
   * found in `history`; at most `media.look.maxPerTurn` second looks in the turn, read at each call),
   * `memory.search` through its `recall` over the served guild (`guild`; a private chat on its
   * `partner`'s behalf), the turn's `history` left out of the hits and her call marks on the
   * quoted lines (linkCalls). Null with the switch off.
   */
  function inTurnTools({ channel, guild, guildId, partner = null, selfId, selfName, history }) {
    if (!coreToolsOn(hot.config)) return null;
    // The second looks this turn took (media.look): every step of the loop shares the count.
    let looks = 0;
    return {
      'web.search': (args) => runWebSearch({ lookup: lookup ?? null, config: hot.config, labels: hot.prompts?.labels ?? {}, guildId, args }),
      'web.read': (args) =>
        runWebRead({
          lookup: lookup ?? null,
          config: hot.config,
          labels: hot.prompts?.labels ?? {},
          guildId,
          args,
          linkOf: (messageId) => {
            const message = (history ?? []).find((item) => String(item?.id) === String(messageId));
            return message ? (collectReadableLinks(message)[0]?.url ?? firstLinkIn(message.content)) : null;
          },
        }),
      'media.look': (args) =>
        runMediaLook({
          describer: describer ?? null,
          config: hot.config,
          labels: hot.prompts?.labels ?? {},
          guildId,
          args,
          mediaOf: (messageId) => (history ?? []).find((item) => String(item?.id) === String(messageId)) ?? null,
          takeTurnSlot: () => {
            if (looks >= lookPerTurn(hot.config)) return false;
            looks += 1;
            return true;
          },
        }),
      'memory.search': (args) =>
        runMemorySearch({
          recall,
          store,
          config: hot.config,
          labels: hot.prompts?.labels ?? {},
          guild,
          guildId,
          channel,
          partner,
          selfId,
          selfName,
          history,
          decorate: (lines) => linkCalls(lines, { channel, guildId }),
          args,
          now: clock(),
        }),
    };
  }

  // Trigger key -> the prefetch already started for it (startPrefetch): a later attempt of the
  // same turn, or the same part of a split message, reuses it instead of searching again.
  const prefetchMemo = new Map();
  /** The most triggers whose prefetch is remembered (the oldest forgotten first). */
  const PREFETCH_MEMO = 16;

  /**
   * The automatic memory prefetch of a turn (src/behavior/prefetch.js, read now): with prefetchOn
   * and the recall runner's `prefetch`, the lanes of this turn's trigger (prefetchLanes: none for
   * a turn no person's new message opened, nor for a trivial one -- logged `recall: prefetch
   * skipped` with its `reason`), searched once per trigger and text (`prefetchMemo`) over the
   * served guild (a private chat on its `partner`'s behalf), the persona's lines marked with her
   * calls (linkCalls). A journal step `memory-prefetch` of the stage `prefetch` (`input.lanes`;
   * `status`, `excerpts`, `ms`) when it starts. Resolves never rejecting. Null when nothing runs,
   * else `{ lanes, pending }`.
   */
  function startPrefetch({ config, channel, guildId, guild, partner, trigger, candidate, triggerKind, mode, history, selfId, selfName, nameOf, journalStep, wake = null }) {
    if (!prefetchOn(config) || typeof recall?.prefetch !== 'function' || !guild) return null;
    const settings = recallSettings(config)?.prefetch;
    if (!settings) return null;
    // An inner turn has no message: its lane is the purposes of the intentions it woke for.
    const purposes = mode === 'inner' ? (wake?.intentions ?? []).map((record) => record?.purpose) : null;
    const { lanes, skip } = purposes ? wakeLanes(purposes) : prefetchLanes({ trigger, candidate, triggerKind, mode, history, settings, selfId, selfName, selfNames: config.bot?.nameTriggers ?? [], nameOf });
    if (skip) {
      if (skip !== 'no-trigger') log.info('recall: prefetch skipped', { channel: channel.id, reason: skip });
      return null;
    }
    const key = purposes ? `${channel.id}:inner:${lanes[0]?.text ?? ''}` : `${channel.id}:${trigger.id}:${candidate?.content ?? ''}`;
    if (prefetchMemo.has(key)) return { lanes, pending: prefetchMemo.get(key) };
    const basis = lanes.map((lane) => lane.kind);
    const op = journalStep?.('prefetch', 'memory-prefetch', { input: { lanes: basis } }, (result) => result.excerpts > 0) ?? null;
    const pending = (async () => {
      await op?.started();
      try {
        const found = await recall.prefetch({ guild, guildId, channel, partner, selfId, selfName, history, lanes, decorate: (lines) => linkCalls(lines, { channel, guildId }) });
        op?.succeeded({ status: found?.status ?? null, excerpts: found?.excerpts?.length ?? 0, ms: found?.ms ?? null });
        return found;
      } catch (err) {
        log.warn('recall: prefetch failed', { channel: channel.id, stage: 'turn', name: err?.name ?? null });
        op?.failed(CODE.ERROR);
        return { status: 'unavailable', basis, excerpts: [] };
      }
    })();
    prefetchMemo.set(key, pending);
    while (prefetchMemo.size > PREFETCH_MEMO) prefetchMemo.delete(prefetchMemo.keys().next().value);
    return { lanes, pending };
  }

  /**
   * Whether a planned call (planCall's) of a tool-loop answer runs alongside the others: one
   * that passed its plan and whose skill is a read (src/skills/registry.js `kind`). A write, or a
   * refusal, runs after them in the order she wrote it.
   */
  function runsTogether(plan) {
    return Boolean(plan.resolved) && (skills ?? defaultSkills()).get(plan.call.skill)?.kind === 'read';
  }

  /**
   * The planned calls of one answer of the tool loop made (runCall over `context`): the reads
   * together, then the rest one after another in her order. Resolves the results in the order
   * of `plans`.
   */
  async function runCalls(plans, context) {
    const results = new Array(plans.length);
    await Promise.all(
      plans.map(async (plan, i) => {
        if (runsTogether(plan)) results[i] = await runCall(plan, context);
      }),
    );
    for (let i = 0; i < plans.length; i += 1) if (results[i] === undefined) results[i] = await runCall(plans[i], context);
    return results;
  }

  /**
   * The intention one call of an inner turn names: `args.id` of `intent.update` / `intent.cancel`,
   * or its body (`args.text`) when that is the id alone (src/ops/intent.js takes it the same way);
   * null for any other call.
   * @param {string} skill
   * @param {Record<string, unknown>} args
   * @returns {string|null}
   */
  function intentionNamed(skill, args) {
    if (!INTENT_ID_SKILLS.includes(skill)) return null;
    const id = typeof args?.id === 'string' && args.id.trim() ? args.id.trim() : isIntentionId(args?.text) ? String(args.text).trim() : null;
    return id;
  }

  /**
   * The open-intentions line of an inner turn's continuation (`labels.task.continueInnerOpen`,
   * `{list}`): the intentions the turn woke for (the wake's `intentionIds`, their records in
   * `wake.intentions`) that no `intent.*` call of the turn has named yet (intentionNamed), as
   * `<id>: <purpose>` items joined by `; `. '' when none is left or the label is missing.
   * @param {object|null} draft
   * @param {object} labels
   * @returns {string}
   */
  function openIntentionsText(draft, labels) {
    const template = labels?.task?.continueInnerOpen;
    const wake = draft?.inner?.wake;
    if (typeof template !== 'string' || !template.trim() || !wake) return '';
    const named = draft.innerIntentIds ?? new Set();
    const byId = new Map((Array.isArray(wake.intentions) ? wake.intentions : []).map((record) => [record?.id, record]));
    const ids = [...new Set((Array.isArray(wake.items) ? wake.items : []).flatMap((item) => (Array.isArray(item?.intentionIds) ? item.intentionIds : [])))];
    const items = ids.filter((id) => id && !named.has(id) && byId.has(id)).map((id) => `${id}: ${clampWithEllipsis(oneLine(byId.get(id)?.purpose ?? ''), WAKE_PURPOSE_CHARS)}`);
    return items.length > 0 ? fill(template, { list: items.join('; ') }) : '';
  }

  /**
   * The calls of one answer of the tool loop planned (planCall each, in order, before anything
   * of that answer is done): at most `skills.loop.maxCallsPerStep` (an inner turn's:
   * `innerLife.loop.maxCallsPerStep`; loopSettings, read now); the rest are dropped and logged
   * `skills: extra-call` (`count`, `loop: true`). Every call gets its own envelope
   * (`envelopeOf(index)`: callEnvelope's) and is resolved over `view`.
   */
  async function planCalls({ calls, channel, draft, view, envelopeOf }) {
    const { maxCallsPerStep } = loopSettings(hot.config, { inner: Boolean(draft?.inner) });
    const kept = calls.slice(0, maxCallsPerStep);
    if (calls.length > kept.length) {
      log.info('skills: extra-call', { channel: channel.id, count: calls.length - kept.length, loop: true });
      // Told in the next step when one follows (`labels.task.callsDropped`), else kept as a loopCut fact (toolLoop).
      if (draft) draft.pendingDropped = (draft.pendingDropped ?? 0) + (calls.length - kept.length);
    }
    const plans = [];
    for (const [index, call] of kept.entries()) plans.push(await planCall({ call, channel, envelope: envelopeOf(index), draft, view }));
    return plans;
  }

  /**
   * One step of the tool loop (toolLoop): the request that continues the turn with every result
   * she still has to see (`results`, in the order the calls were made; continuationRequest with
   * her posts of every step so far, `own`), its task `labels.task.continueTools`, or on her last
   * step (`last`: the steps or the time budget spent) `labels.task.continueToolsLast`, which
   * says no call will run. Without the continuation (features.followUpContinuation or the call
   * marks off) the reply request once more with the result blocks (the one follow-up's framing),
   * always her last step. Her answer is parsed and shaped like the reply; its calls are planned
   * over the rebuilt transcript (`planNext`) before the rest is acted on, unless it is her last
   * step: then they are dropped, logged `skills: loop cap` (`reason` `steps`, `time` or
   * `no-continuation`, `dropped`) and noted as a `loop-cap` limit of the turn. A failed request
   * logs `skills: follow-up failed` and ends the loop.
   *
   * An inner turn (`continuation.input.mode` `inner`, docs/inner-life.md) continues under
   * `task.continueInner`; the open-intentions line (openIntentionsText, `{open}`) is filled
   * after a step whose `message.create` went through or was proposed (`posted`),
   * the last step's label included. `names`: the calls the step follows when none of them left a
   * result to show (the `{skill}` of the label; the open follow-up's `message.create`).
   * Its last step is `task.continueInnerLast`, and one terminal action call in its answer
   * (INNER_TERMINAL_SKILLS: a post, an intention change; the first such) still runs, as
   * `next` with `terminal: true` (no step follows it); the other calls are dropped as above.
   * Resolves `{ acted, next, cutOff }` (`next`: planNext's `{ plans, context }` for the
   * next calls, or null) or null.
   */
  async function loopStep({ results, step, last, reason, own, channel, guildId, draft, sentMessages, shapeOutput, acted, actOn, continuation, planNext, posted = false, names = null }) {
    // The calls dropped by `maxCallsPerStep` since the last step: this step's task says how many and why.
    const dropped = draft?.pendingDropped > 0 ? { count: draft.pendingDropped, why: 'extra-call' } : null;
    const continued = continuation !== null && continuesTurn(hot.config, continuation.input?.prompts?.labels);
    const final = last || !continued;
    const innerTurn = continued && continuation.input?.mode === 'inner';
    let messages = null;
    let routing = null;
    let completion;
    try {
      if (continued) {
        // An inner turn continues under its own labels (no message started it, none of hers went out).
        const label = innerTurn ? (final ? 'continueInnerLast' : 'continueInner') : final ? 'continueToolsLast' : 'continueTools';
        const open = innerTurn && posted ? openIntentionsText(draft, continuation.input?.prompts?.labels ?? {}) : '';
        ({ messages, routing } = await continuationRequest({ called: results[0], results, channel, guildId, acted, continuation, own, label, turnMarks: draft?.turnMarks ?? null, open, names, dropped }));
      } else {
        const labels = hot.prompts?.labels ?? {};
        const blocks = results.map((result, i) => skillResultBlock(result, labels, { maxChars: resultCharsFor(result, hot.config), ...(i === 0 ? { posted: firstPass(acted, labels) } : {}) }));
        messages = withSkillResult(sentMessages, blocks.filter(Boolean).join('\n\n'));
      }
      completion = await llm.complete(messages, { ...REPLY_REQUEST, ...(draft?.started ? { limits: draft.limits } : {}) });
      // The answer completed with the line on: the dropped calls are told.
      if (continued && dropped) draft.pendingDropped = 0;
    } catch (err) {
      log.warn('skills: follow-up failed', { channel: channel.id, skill: results[0]?.skill ?? null, step, error: err });
      return null;
    }
    dumpTurnRequest(guildId, draft, messages, completion, step);
    const parsed = shapeOutput(parseOutput(completion.text, { maxDrawChars: hot.config.image?.maxPromptChars, limits: draft?.limits ?? null }));
    // An inner turn keeps each step's think for its memory episode.
    if (draft?.inner && parsed.think) (draft.innerThinks ??= []).push(parsed.think);
    const calls = Array.isArray(parsed.calls) ? parsed.calls : [];
    if (parsed.callError) log.info('skills: bad-call', { channel: channel.id, reason: parsed.callError, loop: true });
    parsed.call = null;
    parsed.calls = [];
    let next = null;
    if (calls.length > 0) {
      if (final) {
        // An inner turn's last step still takes one terminal action (its natural ending is a call).
        // Her lowered tags are her speech and all run; the bound is on her explicit calls.
        const tags = innerTurn ? calls.filter((call) => call?.lowered === true) : [];
        const explicit = calls.filter((call) => !tags.includes(call));
        const terminal = innerTurn ? (explicit.find((call) => INNER_TERMINAL_SKILLS.includes(call?.skill)) ?? null) : null;
        const dropped = explicit.length - (terminal ? 1 : 0);
        if (dropped > 0) {
          const capReason = continued ? reason : 'no-continuation';
          log.info('skills: loop cap', { channel: channel.id, reason: capReason, step, dropped });
          draft?.limits?.add({ kind: 'loop-cap', where: 'skills.loop', lost: dropped, detail: capReason });
          // An inner turn's result says how its loop ended (toolLoop's `draft.innerLoop`).
          if (draft) draft.loopCut = { reason: capReason, dropped: (draft.loopCut?.dropped ?? 0) + dropped };
        }
        if (terminal || tags.length > 0) next = { ...(await planNext([...tags, ...(terminal ? [terminal] : [])], routing)), terminal: true };
      } else {
        next = await planNext(calls, routing);
      }
    }
    parsed.gif = resolveGif(guildId, parsed.gif, channel.id, draft?.limits ?? null);
    log.info('skills: follow-up answered', {
      channel: channel.id,
      skill: results.map((result) => result.skill).join(','),
      status: results.map((result) => result.status).join(','),
      continuation: continued,
      step,
      calls: next?.plans.length ?? 0,
      usage: completion.usage,
      messages: parsed.messages.length,
      reactions: parsed.reactions.length,
      draw: Boolean(parsed.draw),
      gif: Boolean(parsed.gif),
    });
    const empty = parsed.skip || (parsed.messages.length === 0 && parsed.reactions.length === 0 && !parsed.draw && !parsed.gif);
    const more = (next?.plans.length ?? 0) > 0;
    const cutOff = cutOffOf(completion, parsed, { channelId: channel.id, empty: empty && !more, followUp: true });
    if (cutOff && !cutOff.kept && !more) return { acted: null, next: null, cutOff: true };
    const answered = empty ? null : await actOn(parsed, routing);
    return { acted: answered, next, cutOff: false };
  }

  /**
   * The tool loop of a turn (features.coreTools on; never a diary post): her planned calls
   * (`plans`, the reply's, over `context`, runCall's) made after the reply's own effects -- the
   * reads together (runCalls) --, then, while a result needs her to see it (needsFollowUp), one
   * more request that continues the turn with every such result so far (loopStep), whose own
   * calls run the same way, up to `skills.loop.maxSteps` follow-up requests and
   * `skills.loop.timeBudgetMs` from the first call (loopSettings, read when the loop starts):
   * once either is spent the next request is her last and says so. Each call runs at most for
   * what is left of the time budget (2 s at least) or `skills.callTimeoutMs`, the smaller. The
   * request stays append-only: its cached parts are the reply's, and a later step only adds
   * results after the earlier ones. Logs `skills: loop` (`steps`, `calls`, `ms`). Resolves the
   * answers act gave (`answers`), whether a step was cut off with nothing complete (`cutOff`)
   * and whether a call was its own answer (`delivered`: a message or a picture that went out,
   * an errand accepted).
   *
   * An inner turn (docs/inner-life.md) runs under its own bounds, `innerLife.loop` (loopSettings
   * with `inner`; nobody waits for it): its steps, time budget and calls per step, and each call
   * at most for what is left of that budget (2 s at least) or `innerLife.loop.callTimeoutMs`, the
   * smaller; a call that runs out of it is `unknown` as on every turn. It adds two things.
   * The open follow-up (the first): when the calls just run include a `message.create` that went through or
   * was proposed, none of them left a result to show, an intention the turn woke for is still
   * unnamed by any `intent.*` call of the turn (openIntentionsText) and steps remain, one more
   * step is made under `task.continueInner` with its open-intentions line -- once per turn -- and
   * the turn's result says so (`draft.innerOpenFollowUp`). No new request once the steps or the
   * time are spent. The terminal action: the one call her last step may still make (loopStep's
   * `next.terminal`) runs and nothing follows it.
   */
  async function toolLoop({ plans, context, channel, guildId, draft, sentMessages, shapeOutput, acted, actOn, continuation, planNext }) {
    const inner = Boolean(draft?.inner);
    const settings = loopSettings(hot.config, { inner });
    // The most one call may run: an inner turn's own (innerLife.loop.callTimeoutMs), else skills.callTimeoutMs (read now).
    const callTimeoutCap = inner ? settings.callTimeoutMs : (hot.config.skills?.callTimeoutMs ?? 120000);
    const startedAt = clock();
    const outcomes = [];
    const answers = [];
    const own = [...(acted?.lines ?? [])];
    const innerTurn = inner && continuation !== null && continuesTurn(hot.config, continuation.input?.prompts?.labels);
    let pending = { plans, context };
    let delivered = false;
    let cutOff = false;
    let steps = 0;
    let made = 0;
    // The failed results of the latest calls (they were not shown back to her when the step after them failed).
    let latestFailed = [];
    // The inner actions of the calls just run: marked `presented` once a request that showed their results completed.
    let ranActions = [];
    // The open follow-up due (an inner turn's, after a post with woken intentions still unnamed) and whether the turn had its one.
    let openDue = false;
    let openTaken = false;
    while (pending && pending.plans.length > 0) {
      // Whether a message.create of the calls just run went through or was proposed (the open-intentions line).
      let posted = false;
      // Whether the calls just run left a result she still has to see.
      let fresh = false;
      // The names of the calls just run (the label of a step they leave no result for).
      let names = null;
      if (pending && pending.plans.length > 0) {
        const leftMs = settings.timeBudgetMs - (clock() - startedAt);
        const callTimeoutMs = Math.min(callTimeoutCap, Math.max(LOOP_MIN_CALL_MS, leftMs));
        const actionsBefore = draft?.innerActions?.length ?? 0;
        const results = await runCalls(pending.plans, { ...pending.context, timeoutMs: callTimeoutMs });
        ranActions = draft?.innerActions?.slice(actionsBefore) ?? [];
        made += results.length;
        const terminal = pending.terminal === true;
        pending = null;
        if (results.some((result) => result.status === 'ok' && !result.followUp)) delivered = true;
        posted = results.some((result) => result.skill === 'message.create' && result.status === 'ok');
        names = results.map((result) => result.skill);
        const seen = results.filter((result) => result.followUp);
        outcomes.push(...seen);
        fresh = seen.length > 0;
        latestFailed = results.filter((result) => result.status !== 'ok');
        // The last step's terminal action: nothing follows it.
        if (terminal) break;
      }
      // A post with nothing to show back, an intention she woke for still untouched: one more step names it.
      openDue = innerTurn && posted && !fresh && !openTaken && openIntentionsText(draft, continuation.input?.prompts?.labels ?? {}) !== '';
      if (!fresh && !openDue) break;
      // The open follow-up alone never opens a step past the budget: no new request once spent.
      if (!fresh && (steps >= settings.maxSteps || clock() - startedAt >= settings.timeBudgetMs)) break;
      steps += 1;
      const stepsSpent = steps >= settings.maxSteps;
      const timeSpent = clock() - startedAt >= settings.timeBudgetMs;
      const answer = await loopStep({
        results: outcomes,
        step: steps,
        last: stepsSpent || timeSpent,
        reason: stepsSpent ? 'steps' : 'time',
        own,
        channel,
        guildId,
        draft,
        sentMessages,
        shapeOutput,
        acted,
        actOn,
        continuation,
        planNext,
        posted,
        names: fresh ? null : names,
      });
      if (openDue) {
        openTaken = true;
        draft.innerOpenFollowUp = true;
      }
      // The step after a failed call did not come: she never read how it went, so it is a fact (an inner turn's actions already are).
      if ((!answer || answer.cutOff) && !inner && draft) (draft.unseenFailed ??= []).push(...latestFailed.map((result) => ({ kind: 'callFailed', skill: result.skill, status: CALL_STATUS_NAMES.has(result.status) ? result.status : 'failed', code: typeof result.code === 'string' && result.code ? result.code : null, ...callTextOf(result, hot.config.skills?.markTextMaxChars ?? 200) })));
      if (answer) for (const action of ranActions) action.presented = true;
      if (!answer) break;
      if (answer.cutOff) {
        cutOff = true;
        break;
      }
      if (answer.acted) {
        answers.push(answer.acted);
        own.push(...(answer.acted.lines ?? []));
      }
      if ((answer.next?.plans.length ?? 0) > 0) pending = answer.next;
    }
    log.info('skills: loop', { channel: channel.id, steps, calls: made, ms: clock() - startedAt });
    // Calls dropped by the per-step bound that no step followed to tell her of: the loop's cut.
    if (draft && draft.pendingDropped > 0) {
      draft.loopCut = { reason: draft.loopCut?.reason ?? 'extra-call', dropped: (draft.loopCut?.dropped ?? 0) + draft.pendingDropped };
      draft.pendingDropped = 0;
    }
    if (draft) draft.loopSteps = steps;
    // An inner turn's loop end state, for its result (`inner.loop`): the steps made, the bound that
    // cut it with calls dropped (`steps`, `time`, `no-continuation`; null when none did), how many.
    if (inner) draft.innerLoop = { steps, cut: draft.loopCut?.reason ?? null, droppedCalls: draft.loopCut?.dropped ?? 0 };
    return { answers, cutOff, delivered };
  }

  // channelId -> the chain of parts running there (runChain): its author, its parts, the part
  // in progress (`next`, 1-based; 0 before the first) and the messages folded into a later part.
  const chains = new Map();
  // The facts kept for her next request in a conversation: the inner life keeps them in its state when it is on
  // (src/behavior/inner.js, `setFactsSource`), else they are kept in process. An addressed reply turn that ended
  // `error` or `refused` (`failedTurn`: `{ messageId, authorId, code }`, kept `FAILED_TURN_KEEP_MS` and at most
  // `context.failedTurnsKept`, told by `labels.task.failedEarlier`), a diary post she asked for that did not go out
  // (`diaryFailed`: `{ code }`, `labels.task.diaryFailedEarlier`) and what a turn lost (`sendFailed`, `loopCut`,
  // `callFailed`, `wakeDropped`, ...: `labels.wake.feedbackInTurn`). A fact is told once a completed answer carried it.
  let factsSource = null; // set via setFactsSource()
  const localFacts = createLocalFacts({ now: () => clock() });
  const facts = () => (factsSource?.enabled?.() === true ? factsSource : localFacts);
  // The channels known to be private chats (a deferred call names only its channel).
  const privateChannels = new Set();
  const failedKept = () => {
    const kept = hot.config.context?.failedTurnsKept;
    return Number.isInteger(kept) && kept >= 0 ? kept : 3;
  };
  /** The facts of `kind` of the conversation `scope` still in their window, oldest first. */
  function factsOfKind(guildId, scope, kind, at) {
    return facts().pending(guildId, scope).filter((fact) => fact.kind === kind && fact.channelId === scope.channelId && at - fact.at < FAILED_TURN_KEEP_MS);
  }
  /** A fact of `kind` kept (at most `failedKept()` of the kind per conversation, the newest; one per message). */
  function keepFact(guildId, scope, kind, payload, at) {
    const kept = failedKept();
    if (kept <= 0) return;
    const store = facts();
    if (payload.messageId) store.markTold(guildId, factsOfKind(guildId, scope, kind, at).filter((fact) => fact.messageId === payload.messageId).map((fact) => fact.id));
    store.add(guildId, { kind, ...scope, at, ...payload });
    const live = factsOfKind(guildId, scope, kind, at);
    const over = live.slice(0, Math.max(0, live.length - kept)).map((fact) => fact.id);
    if (over.length > 0) store.markTold(guildId, over);
  }
  let onDeferredFailure = null; // set via setOnDeferredFailure(): a deferred call of an inner turn that failed
  /**
   * What became of a call of hers that was queued for after her turn (`diary.post`) when it did
   * not go out: in an inner turn the inner life hears it as a feedback fact; in an addressed turn
   * the channel's next request names it (`diaryFailed`). Never throws.
   */
  function noteDeferred({ skill, guildId = null, channelId, ownInitiative = false, chainId = null, code = null, id = null, at = clock() }) {
    try {
      if (skill !== 'diary.post' || !channelId) return;
      if (ownInitiative) {
        Promise.resolve(onDeferredFailure?.({ guildId, channelId: String(channelId), chainId, skill, code, id })).catch((err) => log.warn('turn: deferred failure not handed on', { error: err }));
        return;
      }
      keepFact(guildId, { channelId: String(channelId), privateChat: privateChannels.has(String(channelId)) }, 'diaryFailed', { code: typeof code === 'string' && code ? code : CODE.ERROR }, at);
    } catch (err) {
      log.warn('turn: deferred outcome not kept', { error: err });
    }
  }
  const lastPostAt = new Map(); // channelId -> ts of the persona's last message
  // `${skill}:${originChannelId}` -> when a destructive skill call of hers was last dispatched
  // from that channel (skills.destructiveCooldownMinutes, src/skills/gateway.js); in process.
  const destructiveRuns = new Map();
  let onIdle = null; // set via setOnIdle(); see the finally block of runTurn below
  let onTurnEnd = null; // set via setOnTurnEnd(); see noteTurnEnd
  let idleWaiters = []; // resolvers for waitIdle() (/nep pause), notified once busy.size hits 0
  // channelId -> ids of the messages in the history of the last turn that spoke there; for a
  // channel the bot cannot write in, the lines its `<channel_view>` block showed in the last
  // turn that spoke anywhere while showing it (noteSpokeSaw). The pending-ping drain
  // (src/behavior/pipeline.js) skips a ping such a turn already had in view.
  const spokeSaw = new Map();
  // Whether the last turn that wanted prompts['follow-up'] found it missing or blank: `turn:
  // prompt missing` is warned once each time this turns true (the turn falls back to reply.md).
  let followUpPromptMissing = false;
  // The participation pick classifier (src/behavior/participation-pick.js): which stored
  // exchanges of other channels a turn's `<participation>` block shows first.
  const pickParticipation = createParticipationPicker({ hot, store, llm, now: clock, schedule });
  // The last view of each pulled channel shown in each channel, in process only: a channel
  // shown again says what of it is new since (createPullViews; `seenBefore` on the entry).
  const pullViews = createPullViews();
  // Posted message id -> the id of the message that started the turn which posted it, in
  // process (noteTrigger at each post, seedTriggerLinks at start from the journal); the oldest
  // links go first past TRIGGER_LINKS_MAX. Her transcript lines read it (linkTriggers).
  const triggerLinks = new Map();

  /**
   * Outside text the attempt `draft` has seen (src/intentions/sources.js): someone's message, the
   * retrieved memory, a read's result; `read` marks outside material (a read, a page, a lookup, an
   * errand's result). At most SOURCE_CHARS_MAX characters in all.
   */
  function noteSeen(draft, value, { read = false } = {}) {
    if (!draft) return;
    const left = SOURCE_CHARS_MAX - (draft.seenChars ?? 0);
    const texts = left > 0 ? textsOf(value, left) : [];
    if (texts.length === 0) return;
    (draft.seenTexts ??= []).push(...texts);
    draft.seenChars = (draft.seenChars ?? 0) + texts.reduce((sum, text) => sum + text.length, 0);
    if (read) draft.seenRead = true;
  }

  /**
   * Where her line `postedId` (its `text` as she wrote it) came from, noted with the intention
   * service for the candidates the analyzer may find in it (src/intentions/sources.js#lineSourcesOf:
   * what the turn had seen before it went out, its turn, an inner turn's chain). Never throws.
   */
  function noteLineSources(draft, postedId, text) {
    if (typeof intentions?.noteLine !== 'function' || typeof postedId !== 'string' || !postedId) return;
    try {
      intentions.noteLine(postedId, lineSourcesOf({ text, external: draft?.seenTexts ?? [], read: draft?.seenRead === true, turnId: draft?.started?.turnId ?? draft?.turnKey?.turnId ?? null, inner: Boolean(draft?.inner), chainId: draft?.inner?.wake?.chainId ?? null }));
    } catch (err) {
      log.warn('turn: line sources not noted', { error: err });
    }
  }

  /** Remember that `postedId` was posted by the turn `triggerId` started (a newer link wins). */
  function noteTrigger(postedId, triggerId) {
    if (typeof postedId !== 'string' || !postedId || typeof triggerId !== 'string' || !triggerId || postedId === triggerId) return;
    triggerLinks.delete(postedId);
    triggerLinks.set(postedId, triggerId);
    while (triggerLinks.size > TRIGGER_LINKS_MAX) triggerLinks.delete(triggerLinks.keys().next().value);
  }

  /**
   * `lines` with the persona's own lines carrying the message that started their turn
   * (src/format.js#withTriggers), so every transcript built from them names it;
   * `lines` as they are with features.triggerMarkers off (a missing key counts as on, read now).
   */
  function linkTriggers(lines) {
    if (hot.config.features?.triggerMarkers === false) return lines;
    return withTriggers(lines, triggerLinks);
  }

  // The persona's skill calls, in process (noteCall at each call, seedCallMarks at start from the
  // journal), oldest first, the oldest dropped past CALL_MARKS_MAX; and posted message id -> the
  // channel of the turn that posted it from another channel (notePostedFrom). Her transcript
  // lines read both (linkCalls).
  const callMarks = [];
  const postedFromLinks = new Map();

  /** Remember one skill call of hers (in src/format.js#withCalls's shape). */
  function noteCall(mark) {
    callMarks.push(mark);
    if (callMarks.length > CALL_MARKS_MAX) callMarks.splice(0, callMarks.length - CALL_MARKS_MAX);
  }

  /** Remember that `postedId` was posted by a turn of channel `originId` (a newer link wins). */
  function notePostedFrom(postedId, originId) {
    if (typeof postedId !== 'string' || !postedId || typeof originId !== 'string' || !originId) return;
    postedFromLinks.delete(postedId);
    postedFromLinks.set(postedId, originId);
    while (postedFromLinks.size > POSTED_FROM_MAX) postedFromLinks.delete(postedFromLinks.keys().next().value);
  }

  /**
   * `lines` with the persona's skill calls on her own lines (src/format.js#withCalls): the
   * channel names read live from the guild of `channel` (the turn's), the message links built in
   * `guildId` (`@me` for a message of the private chat itself). `lines` as they are with
   * features.callMarkers off (a missing key counts as on, read now).
   */
  function linkCalls(lines, { channel, guildId, extra = null }) {
    if (hot.config.features?.callMarkers === false) return lines;
    const turnMarks = Array.isArray(extra) ? extra : [];
    if (callMarks.length === 0 && turnMarks.length === 0 && postedFromLinks.size === 0) return lines;
    const privateId = channel.guild ? null : String(channel.id);
    return withCalls(
      lines,
      { calls: turnMarks.length > 0 ? [...callMarks, ...turnMarks] : callMarks, postedFrom: postedFromLinks },
      {
        nameOf: liveChannelName(channel),
        linkOf: (channelId, messageId) => messageLink(channelId === privateId ? '@me' : guildId, channelId, messageId),
      },
    );
  }

  /** Whether the journal is written now: one injected and features.journal exactly true (read now). */
  function journalOn() {
    return Boolean(journal) && hot.config.features?.journal === true;
  }

  /**
   * The journal's request dump (journal.keepRequests) of one request of the turn: the message
   * list as sent and the raw answer; `step` (1, 2, ...) for a request after a call (the
   * follow-up, the tool loop's steps), none for the reply's own. Fire-and-forget, only for a
   * started turn with the journal on; a failure is logged with a count of one, never the contents.
   */
  function dumpTurnRequest(guildId, draft, messages, completion, step = null) {
    if (!draft?.started || !journalOn() || typeof journal.dumpRequest !== 'function') return;
    Promise.resolve()
      .then(() =>
        journal.dumpRequest(guildId, {
          turnId: draft.started.turnId,
          attemptId: draft.started.attemptId,
          ...(step !== null ? { step } : {}),
          request: { messages },
          raw: completion.text,
          usage: journalUsage(completion),
          privateUserId: draft.privateUserId ?? null,
        }),
      )
      .catch((error) => log.warn('journal: dump failed', { code: error?.code ?? null, failed: 1, ...(step !== null ? { step } : {}) }));
  }

  // The persona's recent time away from the journal's system records, reused for a minute.
  const readOffPeriods = createOffPeriodsReader({ journal, now: clock });

  /**
   * The off periods `<now>` shows (src/memory/journal.js#offPeriods): read only with the journal
   * on and features.offPeriods on (a missing key counts as on), over the last
   * `journal.offWindowHours` hours (24 when unset), all read now; null otherwise. Never throws.
   */
  async function offPeriodsFor(guildId, config) {
    if (!journalOn() || config.features?.offPeriods === false) return null;
    return readOffPeriods(guildId, { windowHours: config.journal?.offWindowHours ?? 24 });
  }

  /** The turn records of runTurn's attempts, in order; a failed append is the journal's to log. */
  async function writeTurnRecords(attempts) {
    for (const { draft, result } of attempts) {
      await journal.turn(draft.guildId, journalTurnRecord(draft, result));
    }
  }

  /**
   * The persona's posted message `posted` as a `said` line of the record: `text` as she wrote
   * it, the message it replies to and that message's author, the members it mentions, the
   * turn's id and the post operation's (null when the journal does not follow the attempt). A
   * private chat's line goes to its partner's private record, and nowhere without a known
   * partner. Off unless a record is injected and features.record is exactly true (read now).
   * Not awaited; a refused append is logged as `turn: record failed` (counts only).
   */
  function recordSaid({ guildId, channel, privateChat, trigger, draft, op, posted, text, replyId, repliedAuthorId, userIds }) {
    if (!record || hot.config.features?.record !== true) return;
    if (typeof posted?.id !== 'string' || !posted.id) return;
    const privateUserId = privateChat ? (draft?.privateUserId ?? trigger?.authorId ?? channel.recipientId ?? null) : null;
    if (privateChat && !privateUserId) return;
    const line = toRecordLine(
      {
        id: posted.id,
        channelId: channel.id,
        content: text,
        ts: Number.isFinite(posted.createdTimestamp) ? posted.createdTimestamp : clock(),
        replyToId: replyId ?? null,
        replyToAuthorId: repliedAuthorId ?? null,
        mentionedUserIds: userIds,
      },
      { kind: 'said', now: clock, turnId: draft?.started?.turnId ?? null, opId: op?.opId ?? null },
    );
    const failed = (err) => log.warn('turn: record failed', { channel: channel.id, lines: 1, code: err?.code ?? null });
    try {
      Promise.resolve(record.append(guildId, [line], privateUserId ? { privateUserId } : {})).catch(failed);
    } catch (err) {
      failed(err);
    }
  }

  /**
   * One side effect of the attempt `draft` as a journal operation (src/memory/journal.js#op):
   * `name`, `by` (`persona`: her output asked for it; `engine`: preparation the engine runs on
   * its own) and `fields` (`input`, `intent`, `participants`, `sourceMessageIds`, `dryRun`).
   * NO_OP when the attempt is not journalled. Its opId joins the turn record's `actions` once
   * its `started` line is written.
   */
  function journalOp(draft, name, by, fields = {}) {
    if (!draft?.started || typeof journal?.op !== 'function') return NO_OP;
    const handle = journal.op(draft.guildId, {
      turnId: draft.started.turnId,
      name,
      by,
      channelId: draft.channelId,
      privateUserId: draft.privateUserId,
      ...fields,
    });
    const actions = (draft.actions ??= []);
    const note = () => {
      if (!actions.includes(handle.opId)) actions.push(handle.opId);
    };
    return {
      ...handle,
      proposed: (extra) => {
        note();
        return handle.proposed(extra);
      },
      started: (extra) => {
        note();
        return handle.started(extra);
      },
    };
  }

  /**
   * `text` with every transcript number `#n` of this turn's numbering (`idByIndex`, chat and
   * pulled lines) turned into the jump link of that message (src/memory/mentions.js#linkMessageNumbers):
   * features.messageLinks on (read now; a missing key counts as on). A pulled line links in its own
   * channel (`pulledIds`), any other in `channelId`; a private chat uses `@me` for the guild.
   */
  function withMessageLinks(text, { guildId, channelId, privateChat, idByIndex, pulledIds }) {
    if (hot.config.features?.messageLinks === false || !idByIndex) return text;
    const scope = privateChat || !guildId ? '@me' : guildId;
    return linkMessageNumbers(text, (n) => {
      const messageId = idByIndex.get(n);
      if (!messageId) return null;
      return `https://discord.com/channels/${scope}/${pulledIds?.get(messageId) ?? channelId}/${messageId}`;
    });
  }

  /**
   * `text` with every `#handle` of `channelHandles` (the request's handle -> channel id) and, with
   * features.channelLinks on (read now; a missing key counts as on), every `#name` of one of the
   * guild's text channels turned into its `<#id>` link (src/memory/mentions.js#linkChannels; a
   * handle first, exactly). A private chat has no guild: only its handles, if any, are linked.
   */
  function withChannelLinks(channel, text, channelHandles = null) {
    const handles = channelHandles instanceof Map ? channelHandles : null;
    if (hot.config.features?.channelLinks === false) return handles ? linkChannels(text, [], handles) : text;
    const cache = channel?.guild?.channels?.cache;
    if (!cache || typeof cache.values !== 'function') return handles ? linkChannels(text, [], handles) : text;
    const channels = [];
    for (const ch of cache.values()) {
      const textBased = typeof ch?.isTextBased === 'function' ? ch.isTextBased() : ch?.type === 0;
      if (textBased) channels.push({ id: ch.id, name: ch.name });
    }
    return linkChannels(text, channels, handles);
  }

  /** The custom emoji lookup, or null when there is no index or features.customEmoji is off (read now). */
  function emojiLookup() {
    return emoji && hot.config.features?.customEmoji !== false ? emoji.byName : null;
  }

  /**
   * The persona's `text` as it is posted -- a `<msg>`, or the text of her `message.create` /
   * `message.edit` call: with `handles` (the request's handle -> member id map,
   * features.mentionHandles on) only an exact `@handle` becomes a mention and no name is ever
   * matched (src/behavior/handles.js#resolveHandles; a handle-shaped token the map does not hold
   * stays text and is logged `turn: unknown handle` with `count`, unless `quiet`); without them
   * `@name` resolved over `lines`, then `knownNames`, then the fallback
   * `directory` (a thunk, only called when the text has an `@`; resolveMentions), custom
   * emoji after the mentions (`<@id>` has no `:name:` in it to break), transcript numbers into jump
   * links (withMessageLinks), channel names into channel links (withChannelLinks), then `link`
   * joined and the whole cut to one Discord message (withLink; `limits` told a cut). Resolves
   * `text` (as sent), `spoken` (before any link: what the typing time is taken from) and
   * `userIds` (the members it mentions: the only ones a send may notify, allowedMentions).
   * @returns {{ text: string, spoken: string, userIds: string[] }}
   */
  function renderPost(written, { channel, guildId, privateChat, idByIndex, pulledIds, lines, knownNames, directory = null, handles = null, channelHandles = null, link = null, limits = null, quiet = false }) {
    let mentioned;
    if (handles instanceof Map) {
      mentioned = resolveHandles(written, handles);
      if (mentioned.unknown > 0 && !quiet) log.info('turn: unknown handle', { channel: channel.id, count: mentioned.unknown });
    } else {
      const fallback = typeof directory === 'function' && String(written ?? '').includes('@') ? directory() : [];
      mentioned = resolveMentions(written, lines ?? [], knownNames ?? [], fallback);
    }
    const spoken = renderCustomEmoji(mentioned.text, emojiLookup());
    const text = withLink(withChannelLinks(channel, withMessageLinks(spoken, { guildId, channelId: channel.id, privateChat, idByIndex, pulledIds }), channelHandles), link, hot.prompts?.labels, limits);
    return { text, spoken, userIds: mentioned.userIds };
  }

  /**
   * Wait until `trigger`'s author has been quiet in `channelId` for pace.settleMs (read at every
   * check), never past pace.settleMaxMs from the trigger message's time (the start of the wait
   * when that is unknown), checking the activity again at least every SETTLE_STEP_MS so a new
   * message of theirs restarts the count; the pauses run on the injected `schedule`. Resolves
   * the milliseconds actually waited: 0 with no activity tracker, no trigger author or settle
   * off. Never rejects: a failing check ends the wait.
   */
  async function settleAuthor(channelId, trigger) {
    const authorId = trigger?.authorId;
    if (!activity || !authorId) return 0;
    const settleStartedAt = clock();
    const triggerAt = Number.isFinite(trigger.ts) ? trigger.ts : settleStartedAt;
    try {
      for (;;) {
        const { settleMs, settleMaxMs } = paceSettings(hot.config);
        const wait = settleWait({ now: clock(), triggerAt, lastAt: activity.lastAt(channelId, authorId), settleMs, settleMaxMs });
        if (!(wait > 0)) break;
        await new Promise((resolve) => {
          schedule(resolve, Math.min(wait, SETTLE_STEP_MS));
        });
      }
    } catch (err) {
      log.warn('turn: settle failed', { channel: channelId, error: err });
    }
    return clock() - settleStartedAt;
  }

  /**
   * The bare name of the diary channel (`diary.channelId`, in `config`: the turn's live config)
   * for `<senses>`: null with no channel set, `features.diary` off, or a channel the served
   * guild's cache (else the client's) does not know by name.
   */
  function diaryChannelName(guildId, config) {
    const id = config.diary?.channelId;
    if (!id || config.features?.diary === false) return null;
    const found = client.guilds?.cache?.get?.(guildId)?.channels?.cache?.get?.(id) ?? client.channels?.cache?.get?.(id) ?? null;
    return typeof found?.name === 'string' && found.name ? found.name : null;
  }

  /** One dry-run mirror message (src/behavior/limits.js#mirrorDryRun), `bot.dryRunChannelId` read now. */
  function mirror(header, body) {
    return mirrorDryRun({ client, dryRunChannelId: hot.config.bot?.dryRunChannelId || '', header, body });
  }

  /**
   * The typing indicator while a turn prepares and waits for its answer:
   * sent once now and again every few seconds until the returned function
   * stops it (the answer is in hand, the turn is dropped or failed). Only for a turn
   * answering a direct call (DIRECT_CALLS: no unprompted turn, no overheard
   * line), with features.typingSimulation and pace.typingWhilePreparing on
   * (`config`, the turn's live config), never in a dry run (read now), never
   * where the bot cannot send, never with features.skills off (read now: she
   * is silent). Sent through the port; one that does not answer `ok` logs
   * `turn: typing failed` and changes nothing else.
   * @returns {() => void}  Stops the indicator's refresh.
   */
  function typingWhilePreparing(channel, triggerKind, config) {
    const off = () => {};
    if (!DIRECT_CALLS.has(triggerKind) || config.features?.typingSimulation === false) return off;
    if (!paceSettings(config).typingWhilePreparing || hot.config.features?.dryRun === true || !skillsOn(hot.config)) return off;
    let sendable = false;
    try {
      sendable = typeof channel.sendTyping === 'function' && canSend(channel);
    } catch {
      sendable = false;
    }
    if (!sendable) return off;
    // A lease (src/interface/typing.js): refreshed until stopped, and lapsing on its own if nobody stops it.
    const send = () =>
      Promise.resolve()
        .then(() => iface.typing(conversationOf(channel)))
        .then((result) => {
          if (result?.status !== 'ok') log.warn('turn: typing failed', { channel: channel.id, preparing: true, error: portError(result) });
        })
        .catch((err) => log.warn('turn: typing failed', { channel: channel.id, preparing: true, error: err }));
    return startTypingLease({ send, schedule, refreshMs: PREPARE_TYPING_REFRESH_MS, now: clock, onExpire: () => log.info('turn: typing lease expired', { channel: channel.id }) });
  }

  /**
   * Dry-run stand-in for `act()`: does everything `act()` would have decided
   * to do, but never touches the target channel -- no sendTyping, no send, no
   * react, no artificial timing. Logs one line per would-be action and, when
   * `bot.dryRunChannelId` is configured, mirrors it there in plain language.
   * The same routing as act(): a reaction on a pulled line names its channel
   * (`source`) or is dropped where the bot may not react there, a message, the
   * GIF or the picture answering a pulled line carries its jump link
   * (`linkFor`) and no reply. Like act(), a reaction stamps no `lastPostAt`.
   * The mirror header names the mode, the trigger kind (none on a spontaneous
   * turn), then `react to <name>` for a reaction and `to <name>` for a message
   * that answers a line (a reply or a linked pulled line); nothing more for
   * one that answers none. A turn answering one part of a split message
   * names its part (`part <index>/<total>`) after the trigger kind. The
   * messages are the model's as written (nothing rewrites them); nothing is
   * counted or stamped: nothing was posted. The GIF picker runs as in act()
   * (pickGif, its request included): a GIF it picks is logged and mirrored
   * first, as the GIF that would be posted in place of the first message, then
   * the other messages. `history`: the chat lines the picker's `<context>`
   * reads; `trigger`: the message the turn answers (the picker's answered line).
   * @param {{ channel: object, guildId: string, parsed: object, idByIndex: Map<number, string>,
   *   history?: object[], mode: string, triggerKind: TriggerKind|null, trigger?: object|null, plain: boolean, selfName: string, pulledIds: Map<string, string>,
   *   lines: object[], knownNames: { name: string, id: string }[], directory?: (() => { name: string, id: string }[])|null,
   *   linkFor: (pulledId: string|null) => string|null, part?: { index: number, total: number }|null, setDraws?: object[]|null }} args
   *   `setDraws`: a diary set's drawings (in place of `parsed.draw`), each logged
   *   `dry-run: would draw` with `set: true` and mirrored with its place in the set.
   *   `plain`: the turn quotes no chat line (postsPlain); `lines`: the lines shown of the pulled
   *   channels, then this chat's history (names and authors); `knownNames`: the stored names
   *   `@name` resolves by too (storedNames); `directory`: the fallback behind them (mentionDirectory);
   *   `handles`: the request's handle -> member id map, in place of all three (renderPost).
   */
  async function dryAct({ channel, guildId, parsed, idByIndex, history = [], mode, triggerKind, trigger = null, plain, selfName, pulledIds, lines, knownNames, directory = null, handles = null, channelHandles = null, linkFor, part = null, gifPick = true, setDraws = null, draft = null }) {
    const channelName = channel.name ?? null;
    const where = mirrorChannelLabel(channel);
    // Every triggered turn shares the mode `reply`: the header names its
    // trigger kind (a call, a follow-up, an overheard line...); a spontaneous
    // turn has none.
    const partMark = part ? ` · part ${part.index}/${part.total}` : '';
    const head = `[dry-run] ${where} · ${mode}${triggerKind ? ` · ${triggerKind}` : ''}${partMark}`;
    const labels = hot.prompts?.labels;
    // The journal: every would-be action as an operation that started and succeeded, marked dryRun.
    const rehearse = async (name, fields = {}, result = {}) => {
      const op = journalOp(draft, name, 'persona', { ...fields, dryRun: true });
      if (!op.opId) return;
      await op.started();
      await op.succeeded(result);
    };

    for (const reaction of parsed.reactions) {
      const targetId = idByIndex.get(reaction.to);
      if (!targetId) continue;
      const route = reactionChannel(channel, targetId, pulledIds, discord);
      if (!route.target) {
        log.info('turn: reaction dropped', { channel: channel.id, source: route.source, reason: route.reason });
        continue;
      }
      await rehearse('react', { input: { to: targetId, emoji: reaction.emoji }, sourceMessageIds: [targetId] }, { to: targetId, emoji: reaction.emoji });
      const authorName = authorNameFor(lines, targetId) ?? '—';
      // The ONE deliberate exception to "never log message contents": this is
      // the persona's own output, not a user's, and only while dry-run is on.
      log.info('dry-run: would react', { channel: channel.id, channelName, source: route.source, to: targetId, emoji: reaction.emoji });
      const elsewhere = route.source ? ` in ${mirrorChannelLabel(route.target)}` : '';
      await mirror(`${head} · react to ${authorName}`, `reacts with ${reaction.emoji} to ${authorName}${elsewhere}`);
    }

    const dryGif = async (gif) => {
      const { replyId, pulledId } = replyTarget(gif.replyTo, { plain, idByIndex, pulledIds });
      const link = linkFor(pulledId);
      const { entry } = gif;
      // The persona's own pick from the library, dry-run only: the handle and the stored URL.
      await rehearse('gif', { input: { gif: entry.id }, sourceMessageIds: replyId ? [replyId] : [] });
      log.info('dry-run: would send gif', { channel: channel.id, channelName, mode, replyTo: replyId, link, gif: entry.id, kind: entry.kind, url: entry.url });
      await mirror(`${head} · gif ${entry.id}`, withLink(entry.url, link, labels));
      lastPostAt.set(channel.id, clock());
    };

    const picked = gifPick ? await pickGifSafely({ channelId: channel.id, guildId, messages: parsed.messages, gif: parsed.gif, history, selfName, idByIndex, trigger }) : null;
    // A picked GIF would be posted in place of the first message; the rest follow as written.
    if (picked) await dryGif(picked);
    const messages = picked ? parsed.messages.slice(1) : parsed.messages;
    const gif = picked ? null : parsed.gif;
    for (const message of messages) {
      const { replyId, pulledId } = replyTarget(message.replyTo, { plain, idByIndex, pulledIds });
      const answeredId = replyId ?? pulledId;
      const to = answeredId ? ` · to ${authorNameFor(lines, answeredId) ?? '—'}` : '';
      const link = linkFor(pulledId);
      // Same deliberate exception as above: the persona's own output, dry-run only.
      const { text } = renderPost(message.text, { channel, guildId, privateChat: false, idByIndex, pulledIds, lines, knownNames, directory, handles, channelHandles, link, limits: draft?.limits });
      await rehearse('post', { intent: { replyTo: replyId, text }, sourceMessageIds: replyId ? [replyId] : [] });
      log.info('dry-run: would send', { channel: channel.id, channelName, mode, trigger: triggerKind ?? null, replyTo: replyId, link, text });
      // The mirror shows @name as the model wrote it: resolving it to a real
      // mention here would ping someone in a channel meant to be invisible to them.
      await mirror(`${head}${to}`, withLink(renderCustomEmoji(message.text, emojiLookup()), link, labels));
      lastPostAt.set(channel.id, clock());
    }

    if (gif) await dryGif(gif);

    // A diary set (`setDraws`): every picture it would generate, in order, in place of the one drawing.
    const dryDraws = setDraws ?? (parsed.draw ? [parsed.draw] : []);
    for (const [index, drawn] of dryDraws.entries()) {
      const self = drawn.self === true;
      const { pulledId } = replyTarget(drawn.replyTo, { plain, idByIndex, pulledIds });
      const link = linkFor(pulledId);
      // The FULL image prompt (prompt files + the persona's request), so the
      // owner can check the prompt files in dry-run. Same deliberate exception:
      // the persona's own output, dry-run only. Nothing is generated.
      const prompt = drawPromptFor(selfName, drawn);
      await rehearse('draw', { input: { self, ...(setDraws ? { set: true } : {}) } });
      log.info('dry-run: would draw', { channel: channel.id, channelName, mode, self, link, prompt, ...(setDraws ? { set: true } : {}) });
      // A full prompt outgrows one Discord message: mirrored in numbered parts.
      const setMark = setDraws ? ` · set ${index + 1}/${setDraws.length}` : '';
      const header = `${head} · draw${self ? ' (self)' : ''}${setMark}${link ? ` · ${link}` : ''}`;
      const parts = splitForMirror(prompt, MIRROR_MAX_CHARS - header.length - MIRROR_PART_MARK_CHARS);
      for (const [i, part] of parts.entries()) {
        await mirror(parts.length > 1 ? `${header} (${i + 1}/${parts.length})` : header, part);
      }
      lastPostAt.set(channel.id, clock());
    }
  }

  /**
   * The image prompt for `draw` (parsed.draw), as the drawing agent builds it
   * (src/errands/tools.js#drawPromptOf): prompts read now, the request clamped to
   * image.maxPromptChars, the local date and time now (`bot.timezone`, read now) as its
   * `{{when}}` -- every picture, so its light and season follow the clock. Only the dry run
   * shows it; a live picture is made by `makePicture`.
   */
  function drawPromptFor(selfName, draw) {
    return drawPromptOf({ hot, selfName, scene: draw.text, self: draw.self === true, withTime: true, now: clock });
  }

  /**
   * One picture through the drawing agent (src/errands/tools.js#drawPicture): her scene verbatim
   * into the drawing prompt, the avatar reference for a picture she is in, one generation. A task
   * record of the agent when the errand service is there. `userId` is the member whose rail
   * counts it (null: nobody's); `avatar` the holder a diary set reuses the avatar through;
   * `guildId` the served guild of a private chat (a DM channel has none), whose task store
   * records the picture as it does her errands from that chat.
   * Throws what the image client throws (ImageCapError, ImageGenError).
   */
  function makePicture({ channel, guildId = null, scene, self, selfName, userId = null, avatar = null, messageId = null }) {
    return drawPicture({
      tool: drawing,
      errands,
      guildId: channel.guild?.id ?? guildId ?? null,
      input: { scene, selfName, self, withTime: true, userId, avatar },
      requester: { userId, kind: userId ? 'member' : 'persona' },
      origin: { channelId: channel.id, messageId },
      scope: channel.guild ? 'group' : 'dm',
    });
  }

  /**
   * The limit notice for a refused drawing (src/behavior/limits.js#postLimitNotice,
   * labels and dry-run read now), posted in `channel`, quoting the trigger
   * unless `plain` (a follow-up: never a Discord reply; a routed call: it lives
   * in another channel). Never throws.
   */
  async function notifyLimit(channel, limit, trigger, plain) {
    const posted = await postLimitNotice({
      channel,
      trigger,
      limit,
      asReply: !plain,
      labels: hot.prompts?.labels,
      config: hot.config,
      client,
    });
    if (posted === 'sent') lastPostAt.set(channel.id, clock());
  }

  /**
   * The persona's picture, after its messages: the draw prompt (prompts.draw,
   * read now) with the request clamped to `image.maxPromptChars`, the avatar as
   * reference for a picture the persona is in (`image.reference: 'avatar'`),
   * then one generation (through the drawing agent, src/errands/tools.js) and one upload. No typing indicator while it works.
   * Resolves `{ posted: true, pulledId, message }` when posted (`pulledId`: the pulled
   * line it answers, or null; `message`: postedOf the port's answer), `{ drawFailed: reason }`
   * otherwise (a generation failure keeps its reason, `empty` counts as
   * `error`; anything else, the upload included, is `error`). A refusal by an
   * image cap (`ImageCapError`) resolves `{}`: the senses line already told the
   * persona; on a turn someone asked for the limit notice tells the
   * requester, an unasked one (spontaneous, overheard: askedFor) stays silent
   * and only logs it. An unasked picture is charged to no member. A picture
   * answering a pulled line (`pulledIds`) posts plain (replyTarget); the link
   * `linkFor` gives it, asked once the picture is ready, is its content. On a
   * turn about another channel (`sourceId`) the trigger, if any, is a call
   * written there: the limit notice is posted here as a plain message, never as
   * a Discord reply across channels. `plain`: the turn quotes no chat line (postsPlain).
   * The publication is a `message.create` with the picture as its media (checkEffect): a
   * check that refuses it before the generation draws nothing, one that refuses it after
   * (the switch moved meanwhile) posts nothing; both resolve `{}`. The upload goes through
   * the port: anything but `ok` is `{ drawFailed: 'error' }`, journaled by its status, and the
   * picture is never generated again.
   */
  async function draw({ channel, guildId = null, parsed, idByIndex, pulledIds, linkFor, trigger, triggerKind, plain, selfName, sourceId = null, draft = null }) {
    const self = parsed.draw.self === true;
    const asked = askedFor(trigger, triggerKind);
    const { replyId, pulledId } = replyTarget(parsed.draw.replyTo, { plain, idByIndex, pulledIds });
    // Nothing is paid for a picture its publication may not have.
    if (!checkEffect('message.create', sendArgs({ media: imageFileName(null), replyId }), { channel, trigger }).ok) return {};
    // The journal: the picture is one operation from its generation to its post.
    const op = journalOp(draft, 'draw', 'persona', { input: { self } });
    if (op.opId) await op.started();
    try {
      const { picture, referenceMissing } = await makePicture({
        channel,
        guildId,
        scene: parsed.draw.text,
        self,
        selfName,
        userId: asked ? (trigger.authorId ?? null) : null,
        messageId: trigger?.id ?? null,
      });
      if (referenceMissing) log.warn('turn: avatar reference unavailable', { channel: channel.id });
      const link = linkFor(pulledId);
      const name = imageFileName(picture.mediaType);
      // Checked again right before the publication: generated or not, a refused picture is not posted.
      const verdict = checkEffect('message.create', sendArgs({ text: link, media: name, replyId }), { channel, trigger });
      if (!verdict.ok) {
        if (op.opId) await op.failed(verdict.code);
        return {};
      }
      const result = await iface.send(conversationOf(channel), {
        ...(link ? { text: link } : {}),
        attachments: [{ name, data: picture.buffer, contentType: picture.mediaType }],
        ...(replyId ? { replyTo: messageOf(channel, replyId) } : {}),
      });
      if (result.status !== 'ok') {
        if (op.opId) await closeResult(op, result);
        log.warn('turn: draw error', { channel: channel.id, error: portError(result) });
        return { drawFailed: 'error' };
      }
      const message = postedOf(result);
      if (op.opId) await op.succeeded({ messageId: message.id, bytes: picture.buffer?.length ?? 0 });
      lastPostAt.set(channel.id, clock());
      log.info('turn: drew', {
        channel: channel.id,
        seconds: picture.seconds,
        cost: picture.cost,
        self,
        bytes: picture.buffer?.length ?? 0,
        ...(link ? { link: true } : {}),
      });
      return { posted: true, pulledId, replyId, message, op };
    } catch (err) {
      if (op.opId) await op.failed(err instanceof ImageCapError ? CODE.IMAGE_CAP : err instanceof ImageGenError ? (err.reason ?? CODE.ERROR) : CODE.ERROR);
      if (err instanceof ImageCapError) {
        const limit = limitOf(err);
        log.info('turn: draw refused by a limit', {
          channel: channel.id,
          key: limit?.key ?? null,
          used: limit?.used ?? null,
          cap: limit?.cap ?? null,
          spontaneous: !trigger,
          // What decides the notice: an overheard turn has a trigger, yet nobody asked.
          asked,
        });
        if (!asked) return {};
        await notifyLimit(channel, limit, trigger, plain || Boolean(sourceId));
        return {};
      }
      if (err instanceof ImageGenError) {
        return { drawFailed: err.reason === 'empty' ? 'error' : err.reason };
      }
      log.warn('turn: draw error', { channel: channel.id, error: err });
      return { drawFailed: 'error' };
    }
  }

  /**
   * A diary set's pictures, generated one after another before anything of the
   * post is sent: for each of `draws` (already cut to `diary.set.pictures[1]`)
   * the draw prompt as draw() builds it, the avatar as reference for a picture
   * the persona is in (`image.reference: 'avatar'`, fetched once per set), charged
   * to no member (nobody asked). A refusal by an image cap (`ImageCapError`) ends
   * the generation (`turn: draw refused by a limit`, no notice); any other failure
   * skips that picture (`turn: draw error` with its `reason`) and goes on. The
   * generation also stops once the pictures left could no longer reach
   * `minPosted` (the set would not be posted: nothing more is paid for).
   * Resolves the pictures that came out, in order: `{ buffer, mediaType, seconds,
   * cost, self, text }` (`text`: the persona's scene).
   * @param {{ channel: object, draws: { text: string, self: boolean }[], selfName: string, minPosted: number }} args
   * @returns {Promise<object[]>}
   */
  async function generateSet({ channel, draws, selfName, minPosted }) {
    const pictures = [];
    // The avatar is fetched once for the whole set, by the first picture the persona is in.
    const avatar = {};
    for (const [index, drawn] of draws.entries()) {
      if (pictures.length + (draws.length - index) < minPosted) break;
      const self = drawn.self === true;
      try {
        const { picture, referenceMissing } = await makePicture({ channel, scene: drawn.text, self, selfName, avatar });
        if (referenceMissing) log.warn('turn: avatar reference unavailable', { channel: channel.id });
        pictures.push({ ...picture, self, text: drawn.text });
      } catch (err) {
        if (err instanceof ImageCapError) {
          const limit = limitOf(err);
          log.info('turn: draw refused by a limit', {
            channel: channel.id,
            key: limit?.key ?? null,
            used: limit?.used ?? null,
            cap: limit?.cap ?? null,
            spontaneous: true,
            asked: false,
            set: true,
          });
          break;
        }
        const reason = err instanceof ImageGenError ? (err.reason === 'empty' ? 'error' : err.reason) : 'error';
        log.warn('turn: draw error', { channel: channel.id, reason, set: true, error: err });
      }
    }
    return pictures;
  }

  /** Today's UTC date `YYYY-MM-DD` on the injected clock (the daily GIF counter). */
  function todayDate() {
    return utcDay(clock());
  }

  /** GIFs the persona posted today against `gifs.maxPerDay` (src/memory/gif-watch.js#gifPostsToday); reads only. */
  function gifsToday() {
    return gifPostsToday(store.state.data, hot.config, todayDate());
  }

  /** Count one posted GIF against `gifs.maxPerDay` (the counter restarts on a new UTC day). */
  function countGif() {
    countGifPost(store.state.data, clock());
    store.state.markDirty();
  }

  /**
   * The persona's `<gif>` resolved against the guild's library: `{ id,
   * replyTo, entry }`, or null (logged with its reason, never a URL) when
   * features.gifs is false, the handle is unknown, or `gifs.maxPerDay`
   * (default 40, read now) is spent -- the last told to `limits` (optional) as a `daily-cap`.
   */
  function resolveGif(guildId, gif, channelId, limits = null) {
    if (!gif) return null;
    let reason = null;
    let entry = null;
    if (hot.config.features?.gifs === false) reason = 'off';
    else {
      entry = store.findGif(guildId, gif.id);
      const posts = gifsToday();
      if (!entry) reason = 'unknown';
      else if (posts.used >= posts.cap) reason = 'daily';
    }
    if (reason) {
      if (reason === 'daily') limits?.add({ kind: 'daily-cap', where: 'gifs.maxPerDay' });
      log.info('turn: gif dropped', { channel: channelId, reason, usedToday: gifsToday().used });
      return null;
    }
    return { ...gif, entry };
  }

  /**
   * A fresh URL of an attached GIF: its original message is fetched again
   * (Discord attachment URLs expire) and the attachment found by id, in the
   * message itself or in a forwarded snapshot. Null when anything fails.
   */
  async function freshAttachmentUrl(channel, entry) {
    return sharedFreshAttachmentUrl({ client, channel, entry, onError: (err) => log.warn('turn: gif refetch failed', { channel: channel.id, gif: entry.id, error: err }) });
  }

  /**
   * Post the persona's GIF (after its messages, or in place of the first one
   * when the GIF picker chose it): a link GIF as its stored
   * URL (Discord embeds tenor/giphy links), an attached one as a fresh URL of
   * its attachment, the stored one when that fails. Counted against
   * `gifs.maxPerDay` once sent, and stamped on its library entry of
   * `guildId` (store.recordOwnGif: `ownLast`/`ownUses`, the `<gifs>` list's
   * own-post mark). Never throws; resolves `{ message, op }` once sent
   * (`message`: postedOf the port's answer; `op`: its journal operation),
   * else null. The post is a `message.create` with the URL as its text
   * (checkEffect, right before it; a refusal posts nothing and resolves null),
   * made through the port; its journal operation (`openOp()`, by sendGif)
   * starts only once the check passed.
   * `replyId`: the chat line it quotes as a Discord reply (replyTarget), or
   * null; `link`: the jump link it carries after its URL (withLink, so the
   * URL comes first and still embeds), or null; `trigger`: the turn's (the requester).
   * @returns {Promise<{ message: object, op: object }|null>}
   */
  async function postGif(channel, guildId, gif, replyId, link, { openOp = () => NO_OP, trigger = null } = {}) {
    const { entry } = gif;
    let op = NO_OP;
    try {
      const fresh = entry.kind === 'attachment' ? await freshAttachmentUrl(channel, entry) : null;
      const text = withLink(gifPostUrl(entry, fresh), link, hot.prompts?.labels);
      if (!checkEffect('message.create', sendArgs({ text, replyId }), { channel, trigger }).ok) return null;
      op = openOp();
      if (op.opId) await op.started();
      const result = await iface.send(conversationOf(channel), { text, ...(replyId ? { replyTo: messageOf(channel, replyId) } : {}) });
      if (result.status !== 'ok') {
        if (op.opId) await closeResult(op, result);
        log.warn('turn: gif failed', { channel: channel.id, gif: entry.id, error: portError(result) });
        return null;
      }
      const message = postedOf(result);
      if (op.opId) await op.succeeded({ messageId: message.id });
      countGif();
      if (entry.key && typeof store.recordOwnGif === 'function') store.recordOwnGif(guildId, entry.key, clock());
      lastPostAt.set(channel.id, clock());
      log.info('turn: gif sent', { channel: channel.id, gif: entry.id, kind: entry.kind, fresh: Boolean(fresh), ...(link ? { link: true } : {}) });
      return { message, op };
    } catch (err) {
      if (op.opId) await op.failed(CODE.ERROR);
      log.warn('turn: gif failed', { channel: channel.id, gif: entry.id, error: err });
      return null;
    }
  }



  /**
   * The GIF picker (src/behavior/gif-pick.js), on the turn's FIRST message as
   * the model wrote it (a picked GIF takes its place; the rest are posted as
   * written): with features.gifPicker and features.gifs on (a missing key counts as
   * on), prompts['gif-pick'] present, the guild's library readable, room left
   * under `gifs.maxPerDay` (gifsToday) and pickCandidates saying yes (a first
   * message of at most `gifs.pick.maxChars` code points, no `<gif>` of the
   * turn's own -- the model's own GIF is never second-guessed --, at least one
   * captioned entry), ONE helper request on the classifier model
   * (role `analyzer`, purpose `gif-pick`, its answer capped at
   * `gifs.pick.maxOutputTokens`): system = the prompt with `{{name}}`, user =
   * `<gifs>` (renderGifLibrary over the WHOLE captioned library in rank order, with no own-post
   * mark, `gifs.reactionChars` and `gifs.actionChars` read now: the stable bulk first, the part
   * tagged for the provider's prompt cache; with `features.promptCache` exactly true it is held
   * per cache bucket in the guild's stable freeze, like the reply's `<gifs>`, see
   * src/behavior/prompt.js#freezePerBucket, so a GIF post or a use that reranks the library
   * rewrites the cached prefix at most once per `llm.cache.ttl`), then the per-call tail:
   * `<gifs_recent>` (ownGifLines: the listed GIFs the persona posted within `gifs.ownMarkHours`,
   * with how long ago, from the live library), `<context>` (pickContext: the last `gifs.pick.contextMessages` lines of
   * `history`, preceded by the line the first message answers when that one is
   * older -- its `reply` target, else the trigger --, as classifierTranscript
   * renders them; no block for 0), `<reply>` (the first message, preceded by
   * `transcript.replyTo` naming the `#n` of the line it answers when that line
   * is in `<context>`). A handle it lists (parseGifPick) resolves through resolveGif,
   * replying where the first message would have; `none` or anything else
   * resolves null. Logs `gifs: picked` (`handle`: whether one was named,
   * `library`: how many entries were listed) or `gifs: pick failed` with the
   * rail's code. Counts only.
   * @param {{ channelId: string, guildId: string, messages: { text: string, replyTo?: number|null }[],
   *   gif: object|null, history: object[], selfName: string, idByIndex?: Map<number, string>,
   *   trigger?: object|null }} args  `gif`: the turn's own resolved GIF; `idByIndex`: the
   *   request's `#n` -> message id; `trigger`: the message the turn answers, if any.
   * @returns {Promise<object|null>}  The GIF to post in place of the first message (resolveGif's shape), or null.
   */
  async function pickGif({ channelId, guildId, messages, gif, history, selfName, idByIndex = new Map(), trigger = null }) {
    const config = hot.config;
    if (config.features?.gifPicker === false || config.features?.gifs === false) return null;
    const prompt = hot.prompts?.['gif-pick'];
    if (typeof prompt !== 'string' || prompt.trim() === '') return null;
    if (typeof store.getGifs !== 'function' || typeof store.findGif !== 'function' || messages.length === 0) return null;
    const settings = gifPickSettings(config);
    const first = messages[0];
    const gifsCfg = config.gifs ?? {};
    const chars = gifFieldChars(gifsCfg);
    const labels = hot.prompts?.labels;
    const at = clock();
    // The library as the first pick of this cache bucket rendered it (no clock in it); the
    // signature lets an edit of its labels or settings show at once.
    const freeze = config.features?.promptCache === true ? stableFreezeOf(guildId) : null;
    const { library, handles } = freezePerBucket(freeze, 'gif-pick', { now: at, bucketMs: cacheTtlMs(config), signature: JSON.stringify([labels?.gifs ?? null, gifsCfg]) }, () => {
      const mediaCache = typeof store.getMediaCache === 'function' ? (store.getMediaCache(guildId) ?? null) : null;
      const listed = captionedEntries(rankGifs(store.getGifs(guildId), gifsCfg.halfLifeDays ?? 30), mediaCache, chars.actionChars);
      return { library: renderGifLibrary(listed, mediaCache, labels, { now: 0, ownMarkHours: 0, ...chars }), handles: listed.map((entry) => entry.id) };
    });
    if (!pickCandidates({ text: first.text, postsGif: Boolean(gif), captioned: library.length }, settings)) return null;
    const posts = gifsToday();
    if (posts.used >= posts.cap) return null;
    // The line the first message answers: its reply target (a pulled line is not in `history`), else the trigger.
    const replyId = first.replyTo !== null && first.replyTo !== undefined ? (idByIndex.get(first.replyTo) ?? null) : null;
    const answeredId = replyId ?? trigger?.id ?? null;
    const context = pickContext(history, { contextMessages: settings.contextMessages, answeredId });
    const contextBody = context.messages.length > 0 ? classifierTranscript(context.messages, { config, selfName, labels }) : '';
    // The reply is marked as a transcript line replying to that line would be: its #n, author and a quote.
    const answersMark =
      context.answeredIndex !== null && labels?.transcript?.replyTo
        ? replyMarker(context.messages[context.answeredIndex - 1], context.answeredIndex, { labels, selfName, replyQuoteChars: config.context?.replyQuoteChars })
        : '';
    const replyBody = answersMark ? `${answersMark} ${first.text}` : first.text;
    // Which of the listed GIFs the persona posted lately, with how long ago: per call, in the tail.
    const recent = labels ? ownGifLines(store.getGifs(guildId), handles, labels, { ownMarkHours: gifsCfg.ownMarkHours ?? 24, now: at }) : [];
    let completion;
    try {
      completion = await llm.complete(
        [
          { role: 'system', content: fillPromptTemplate(prompt, { name: selfName ?? '' }) },
          { role: 'user', content: stableThenTail(block('gifs', library.join('\n')), [block('gifs_recent', recent.join('\n')), block('context', contextBody), block('reply', replyBody)], '\n\n') },
        ],
        {
          model: roleModel(config, 'analyzer', 'gif-pick'),
          ...helperRequestOptions(config, { role: 'analyzer', maxOutputTokens: settings.maxOutputTokens, purpose: 'gif-pick' }),
        },
      );
    } catch (err) {
      log.warn('gifs: pick failed', { channel: channelId, reason: railReason(err), status: err?.statusCode ?? null });
      return null;
    }
    const handle = parseGifPick(completion?.text, handles);
    log.info('gifs: picked', { channel: channelId, handle: handle !== null, library: library.length });
    if (handle === null) return null;
    return resolveGif(guildId, { id: handle, replyTo: first.replyTo ?? null }, channelId);
  }

  /**
   * What `picking` (pickGifSafely's promise) answers within `gifs.pick.graceMs` (gifPickSettings,
   * read now; on `schedule`) from now, else null: the picker is left behind for this turn, logged
   * `gifs: pick late` (`channel`, `graceMs`) and journaled as a `helper-timeout` limit on
   * `gif-pick`. An answer already there wins over a grace of 0. `graceMs` null -> `picking` itself.
   * @param {Promise<object|null>} picking
   * @param {{ channelId: string, draft: object|null }} where
   * @returns {Promise<object|null>}
   */
  async function pickedInTime(picking, { channelId, draft }) {
    const { graceMs } = gifPickSettings(hot.config);
    if (graceMs === null) return picking;
    const LATE = Symbol('late');
    let cancel = null;
    const timer = new Promise((resolve) => {
      cancel = schedule(() => resolve(LATE), graceMs);
    });
    const answer = await Promise.race([picking.then((value) => ({ value })), timer]);
    cancel?.();
    if (answer !== LATE) return answer.value;
    log.info('gifs: pick late', { channel: channelId, graceMs });
    draft?.limits?.add({ kind: 'helper-timeout', where: 'gif-pick' });
    return null;
  }

  /** pickGif that never rejects: an unexpected failure (`gifs: pick failed`) posts the messages as written. */
  function pickGifSafely(args) {
    return pickGif(args).catch((err) => {
      log.warn('gifs: pick failed', { channel: args.channelId, error: err });
      return null;
    });
  }

  /**
   * Post the turn for real. Resolves `{ delivered, answered }` -- whether
   * anything reached the chat (a reaction put, a message, the GIF or the
   * picture posted; a limit notice is not the persona's answer), and the ids
   * of the pulled lines what reached it answered (a reaction put on one, a
   * message, the GIF or the picture posted answering one: stampShownCalls) --
   * plus `drawFailed` from draw() when the persona's picture could not be
   * posted.
   *
   * Everything is posted in `channel`. A reaction on a pulled line
   * (`pulledIds`) is put in that line's channel when the bot may react there,
   * else dropped (`turn: reaction dropped`); a message, the GIF or the picture
   * answering a pulled line posts plain, never as a Discord reply across
   * channels, and each post carries the jump link `linkFor` gives it (a message
   * and the GIF through `labels.elsewhere.link`, read now; the picture as its
   * content). `@name` resolves over `lines`, then `knownNames`. Every message is cut to fit one
   * Discord message once its mentions and custom emoji are expanded (withLink).
   *
   * A message whose send fails ends the posting: `turn: send failed`
   * (`channel`, `index` -- 0-based among the turn's messages --, `error`), no
   * later message, GIF or picture, and the turn resolves what reached the chat
   * before it. So does a message the skill gateway refuses (checkEffect, before
   * its typing and again right before its send; `skill: refused`); a refused
   * reaction or GIF is skipped alone. Every effect goes through the port
   * (`iface`): a send it answers `unknown` is journaled so and never sent again.
   *
   * The messages are posted as the model wrote them: nothing rewrites them.
   * A member with pings off (store.isPingsOff) is mentioned and replied to
   * without a notification: only allowedMentions changes, never the text.
   * After the reactions, the GIF picker (pickGif) runs alongside the first
   * message's typing imitation: both start together, the first message waits
   * for both, the picker at most `gifs.pick.graceMs` (read now; 0 by default,
   * `null` = as long as it takes) past the end of that typing: a picker still
   * out then is left behind for this turn (its answer is ignored; `gifs: pick
   * late` with `graceMs`, a `helper-timeout` limit on `gif-pick` in the turn's
   * journal) and the first message goes as written. Without that typing (the
   * imitation off, or the first message refused) it waits for the answer as
   * before. A GIF it picks is posted in place of the first message (that
   * text is not sent), replying where it would have,
   * and the other messages follow in order, each waited for and typed; a
   * picked GIF that fails to send (`turn: gif failed`) leaves every message to
   * be posted as written, so nothing is lost.
   * @param {{ channel: object, guildId: string, privateChat: boolean, parsed: object,
   *   idByIndex: Map<number, string>, history: object[], startedAt: number, mode: string,
   *   triggerKind: TriggerKind|null, plain: boolean, trigger: object|null, selfName: string,
   *   pulledIds: Map<string, string>, lines: object[], knownNames: { name: string, id: string }[],
   *   linkFor: (pulledId: string|null) => string|null, sourceId: string|null }} args
   *   `plain`: the turn quotes no chat line (postsPlain); `lines`: the lines shown of the
   *   pulled channels, then `history` (a chat author wins a display name both share);
   *   `knownNames`: the stored names `@name` resolves by too (storedNames); `directory`: the
   *   fallback behind them (mentionDirectory, a thunk); `handles`: the request's handle -> member
   *   id map, in place of all three (renderPost);
   *   `sourceId`: the channel the turn is about (its `source`), logged on every message sent;
   *   with it a refused drawing's limit notice quotes nothing (the trigger of a routed turn
   *   lives in that channel); `gifPick`: false keeps the GIF picker from replacing the first
   *   message (a diary post); `participation` (`{ descriptions }`: the captions the turn had, or
   *   null): each message sent in a server channel is recorded in the participation store
   *   (recordOwnParticipation) with the lines of `history` before it.
   *   `set` (`{ pictures }`, a diary set's pictures from generateSet): posted after the messages in
   *   place of `parsed.draw`, as files with no text and no reply, split by chunkPictures over
   *   `diary.set.maxMessageBytes` (read now) and 10 files; `turn: drew` per picture (`set: true`),
   *   then `turn: set posted` (`pictures`, `messages`: the file messages sent). A file message that
   *   fails to send ends the set (`turn: send failed` with `set: true`).
   * Resolves `delivered`, `answered`, `messageIds` (the ids of the messages and the picture
   * posted, in order), `texts` (the messages posted, as the persona wrote them), `lines` (each
   * message posted as a transcript line of hers: its id, time and text as written), `gifs` (the
   * handles of the GIFs posted), `drew` (the
   * picture was posted) and `drawFailed` when the picture failed; with a `set`, `setPictures`
   * (the pictures posted) and `setScene` (the scene of the first one posted).
   */
  async function act({ channel, guildId, privateChat, parsed, idByIndex, history, startedAt, mode, triggerKind, plain, trigger, selfName, pulledIds, lines, knownNames, directory = null, handles = null, channelHandles = null, linkFor, sourceId, gifPick = true, participation = null, set = null, draft = null }) {
    const cfg = hot.config.typing;
    const typingOn = hot.config.features?.typingSimulation !== false;
    // The typing imitation of one message: the indicator, then the time its text takes to type.
    // Typed only once the message it precedes passed its check (checkEffect).
    const typeFor = async (spoken) => {
      // Only the indicator: a missing Send Messages shows up here first, so it is logged.
      const typed = await iface.typing(conversationOf(channel));
      if (typed.status !== 'ok') log.warn('turn: typing failed', { channel: channel.id, error: portError(typed) });
      await sleep(typingMs(spoken, cfg, rng));
    };
    // Every effect's skill call names the turn's channel and its trigger's author.
    const effect = { channel, trigger };
    // Whether anything reached the chat (the caller of a routed turn marks its call by it), and
    // the pulled lines it answered (the ring of calls marks them by it).
    let delivered = false;
    const answered = new Set();
    // For the journal: every post that reached the chat with the message it answers, every
    // reaction put with its target, each with the operation that made it (journalOp).
    const posts = [];
    const reacted = [];
    const opField = (op) => (op?.opId ? { opId: op.opId } : {});
    // Every post also remembers the message that started this turn (none on a turn without one).
    const notePost = (sent, replyTo = null, op = null) => {
      if (typeof sent?.id === 'string' && sent.id) {
        posts.push({ ...opField(op), messageId: sent.id, replyTo: replyTo ?? null });
        noteTrigger(sent.id, trigger?.id);
        if (draft) (draft.ownPosts ??= []).push(sent.id);
      }
    };

    for (const reaction of parsed.reactions) {
      const targetId = idByIndex.get(reaction.to);
      if (!targetId) continue;
      const route = reactionChannel(channel, targetId, pulledIds, discord);
      if (!route.target) {
        log.info('turn: reaction dropped', { channel: channel.id, source: route.source, reason: route.reason });
        continue;
      }
      if (typingOn) await sleep(between(cfg.reactionDelayMs, rng));
      // A reaction on a pulled line is checked as one of this turn's carried-over tags: she saw
      // that line in this turn's request.
      if (!checkEffect('message.react.add', { messageId: targetId, emoji: reaction.emoji }, effect).ok) continue;
      const op = journalOp(draft, 'react', 'persona', { input: { to: targetId, emoji: reaction.emoji }, sourceMessageIds: [targetId] });
      if (op.opId) await op.started();
      const result = await iface.react(messageOf(route.target, targetId), reaction.emoji);
      if (result.status === 'ok') {
        delivered = true;
        reacted.push({ ...opField(op), to: targetId, emoji: reaction.emoji });
        if (route.source) answered.add(targetId);
        if (op.opId) await op.succeeded({ to: targetId, emoji: reaction.emoji });
      } else {
        if (op.opId) await closeResult(op, result);
        log.warn('turn: reaction failed', { channel: channel.id, ...(route.source ? { source: route.source } : {}), emoji: reaction.emoji, error: portError(result) });
      }
    }

    // Each posted message as the next fetchHistory will normalize it (its own id and time, the
    // persona's text as written).
    const ownPosted = [];
    // The texts posted, as the persona wrote them, and the handles of the GIFs posted.
    const postedTexts = [];
    const postedGifs = [];
    let sendFailed = false;
    // The GIF picker starts first (its request is sent at once), then the first message's typing.
    // `pickDone` once it answered (null included): an answer already there needs no grace timer.
    let pickDone = false;
    const picking = (
      gifPick
        ? pickGifSafely({ channelId: channel.id, guildId, messages: parsed.messages, gif: parsed.gif, history, selfName, idByIndex, trigger })
        : Promise.resolve(null)
    ).then((value) => {
      pickDone = true;
      return value;
    });
    // The first message's typing waits for its check, made on its text before any jump link
    // (linkFor is asked once, when it is sent; no cut is told to the limits here). A refusal is
    // not checked again below: that message ends the posting.
    let firstRefused = false;
    let firstTyped = false;
    if (typingOn && parsed.messages.length > 0) {
      const head = parsed.messages[0];
      const { replyId } = replyTarget(head.replyTo, { plain, idByIndex, pulledIds });
      const { spoken: first, text: firstText } = renderPost(head.text, { channel, guildId, privateChat, idByIndex, pulledIds, lines, knownNames, directory, handles, channelHandles, quiet: true });
      firstRefused = !checkEffect('message.create', sendArgs({ text: firstText, replyId }), effect).ok;
      if (!firstRefused) {
        await typeFor(first);
        firstTyped = true;
      }
    }
    // Once that typing is over, a picker still out gets `gifs.pick.graceMs` more at most (pickedInTime).
    const picked = gifPick && firstTyped && !pickDone ? await pickedInTime(picking, { channelId: channel.id, draft }) : await picking;
    // One GIF post (the turn's own or the picked one), recorded like a message.
    const sendGif = async (gif) => {
      const { replyId, pulledId } = replyTarget(gif.replyTo, { plain, idByIndex, pulledIds });
      const openOp = () => journalOp(draft, 'gif', 'persona', { input: { gif: gif.entry?.id ?? null }, sourceMessageIds: replyId ? [replyId] : [] });
      const sent = await postGif(channel, guildId, gif, replyId, linkFor(pulledId), { openOp, trigger });
      if (sent) {
        delivered = true;
        if (pulledId) answered.add(pulledId);
        notePost(sent.message, replyId, sent.op);
        if (gif.entry?.id) postedGifs.push(gif.entry.id);
      }
      return sent?.message ?? null;
    };
    // A picked GIF is posted in place of the first message (typed above); the rest follow as written.
    // When it fails to send (`turn: gif failed`), the first message goes as written after all.
    const replaced = picked ? Boolean(await sendGif(picked)) : false;
    const messages = replaced ? parsed.messages.slice(1) : parsed.messages;
    const gif = picked ? null : parsed.gif;
    // Every message but the first one as written waits and is typed here; that one was typed alongside the picker.
    const typedAbove = (index) => index === 0 && !replaced;
    // Members who turned the persona's notifications off (`/nep pings off`), read from the store at
    // each send: their `<@id>` stays in the text but notifies nobody, and a reply to their line
    // does not ping them (server channels only).
    const pingsOff = (userId) =>
      !privateChat && Boolean(userId) && typeof store.isPingsOff === 'function' && store.isPingsOff(guildId, userId);
    // A message that did not go out ends the posting; the turn then ends `partial` with a `sendFailed` fact (its code, how many of how many went out).
    // A send whose answer never came (`unknown`: a timeout, a network error) may have gone out: it keeps the hash of its text, and her next turn here looks for it before telling.
    const failSend = (code, { unknown = false, text: sentText = '' } = {}) => {
      sendFailed = true;
      if (draft) draft.sendFailure = { code, n: ownPosted.length, total: messages.length, ...(unknown ? { unknown: true, hash: sendHash(sentText) } : {}) };
    };
    for (const [index, message] of messages.entries()) {
      if (!typedAbove(index) && typingOn) await sleep(between(cfg.betweenMessagesMs, rng));

      const { replyId, pulledId } = replyTarget(message.replyTo, { plain, idByIndex, pulledIds });
      const link = linkFor(pulledId);
      const repliedAuthorId = replyId ? (lines.find((line) => line.id === replyId)?.authorId ?? (trigger?.id === replyId ? trigger.authorId : null)) : null;
      // Links on the text sent; the typing time stays on the text before them.
      const { text, spoken, userIds } = renderPost(message.text, { channel, guildId, privateChat, idByIndex, pulledIds, lines, knownNames, directory, handles, channelHandles, link, limits: draft?.limits });
      const args = sendArgs({ text, replyId });
      // A first message refused before its typing above ends the posting (already logged).
      if (typedAbove(index) && firstRefused) {
        failSend(CODE.REFUSED);
        break;
      }
      // The first message was typed alongside the GIF picker, above; any other is checked before its typing.
      if (typingOn && !typedAbove(index)) {
        if (!checkEffect('message.create', args, effect).ok) {
          failSend(CODE.REFUSED);
          break;
        }
        await typeFor(spoken);
      }
      // Checked (again) right before the send: the owner's switch may have moved while she typed.
      if (!checkEffect('message.create', args, effect).ok) {
        failSend(CODE.REFUSED);
        break;
      }

      // The journal: the post's operation, with what the reconciliation after a restart looks for.
      const op = journalOp(draft, 'post', 'persona', {
        intent: { replyTo: replyId, text },
        participants: repliedAuthorId ? [repliedAuthorId] : [],
        sourceMessageIds: replyId ? [replyId] : [],
      });
      if (op.opId) await op.started();
      const result = await iface.send(conversationOf(channel), {
        text,
        ...(replyId ? { replyTo: messageOf(channel, replyId) } : {}),
        mentions: { users: userIds.filter((id) => !pingsOff(id)), repliedUser: !pingsOff(repliedAuthorId) },
      });
      if (result.status !== 'ok') {
        if (op.opId) await closeResult(op, result);
        log.warn('turn: send failed', { channel: channel.id, index: replaced ? index + 1 : index, error: portError(result) });
        failSend(typeof result.code === 'string' && result.code ? result.code : (result.error?.code ?? CODE.SEND_FAILED), { unknown: result.status === 'unknown', text });
        break;
      }
      const posted = postedOf(result);
      if (op.opId) await op.succeeded({ messageId: posted.id });
      recordSaid({ guildId, channel, privateChat, trigger, draft, op, posted, text: message.text, replyId, repliedAuthorId, userIds });
      noteLineSources(draft, posted?.id, message.text);
      delivered = true;
      if (pulledId) answered.add(pulledId);
      lastPostAt.set(channel.id, clock());
      notePost(posted, replyId, op);
      postedTexts.push(message.text);
      const ownLine = {
        id: posted?.id ?? null,
        ts: Number.isFinite(posted?.createdTimestamp) ? posted.createdTimestamp : clock(),
        channelId: channel.id,
        self: true,
        authorId: client.user?.id ?? '',
        content: message.text,
        replyToId: replyId,
      };
      // The persona's own exchange on this channel, kept for her turns elsewhere (a server channel only).
      if (participation && !privateChat) {
        recordOwnParticipation({ channel, guildId, history, earlier: ownPosted, own: ownLine, replyId, selfName, descriptions: participation.descriptions });
      }
      ownPosted.push(ownLine);
      log.info('turn: sent', {
        channel: channel.id,
        chars: text.length,
        secondsSinceTrigger: Math.round((clock() - startedAt) / 100) / 10,
        ...(triggerKind === 'followUp' ? { followUp: true } : {}),
        ...(triggerKind === 'overheard' ? { overheard: true } : {}),
        ...(sourceId ? { source: sourceId } : {}),
        ...(link ? { link: true } : {}),
      });
    }
    const messageIds = ownPosted.map((line) => line.id).filter((id) => typeof id === 'string' && id);
    const posted = { messageIds, texts: postedTexts, lines: ownPosted, gifs: postedGifs, drew: false, posts, reacted };
    if (sendFailed) return { delivered, answered, ...posted };

    // The turn's own GIF right after the messages.
    if (gif) {
      if (messages.length > 0 && typingOn) await sleep(between(cfg.betweenMessagesMs, rng));
      await sendGif(gif);
    }

    // A diary set's pictures come last, already generated: one message of files, more past
    // diary.set.maxMessageBytes (read now) or 10 files.
    if (set) {
      const chunks = chunkPictures(set.pictures, setSettings(hot.config.diary).maxMessageBytes);
      let setMessages = 0;
      let setPictures = 0;
      for (const [index, chunk] of chunks.entries()) {
        let message;
        const bytes = chunk.reduce((sum, picture) => sum + (picture.buffer?.length ?? 0), 0);
        const attachments = chunk.map((picture) => ({ name: imageFileName(picture.mediaType), data: picture.buffer, contentType: picture.mediaType }));
        // A message of files is a `message.create` with them as its media, checked right before it.
        if (!checkEffect('message.create', sendArgs({ media: attachments.map((attachment) => attachment.name).join(',') }), effect).ok) break;
        const op = journalOp(draft, 'draw', 'persona', { input: { set: true, pictures: chunk.length } });
        if (op.opId) await op.started();
        const result = await iface.send(conversationOf(channel), { attachments });
        if (result.status !== 'ok') {
          if (op.opId) await closeResult(op, result);
          log.warn('turn: send failed', { channel: channel.id, index: messages.length + index, set: true, error: portError(result) });
          break;
        }
        message = postedOf(result);
        if (op.opId) await op.succeeded({ messageId: message.id, bytes });
        delivered = true;
        lastPostAt.set(channel.id, clock());
        notePost(message, null, op);
        if (typeof message?.id === 'string' && message.id) messageIds.push(message.id);
        if (setPictures === 0) posted.setScene = chunk[0].text;
        setMessages += 1;
        setPictures += chunk.length;
        for (const picture of chunk) {
          log.info('turn: drew', { channel: channel.id, seconds: picture.seconds, cost: picture.cost, self: picture.self, bytes: picture.buffer?.length ?? 0, set: true });
        }
      }
      if (setMessages > 0) log.info('turn: set posted', { channel: channel.id, pictures: setPictures, messages: setMessages });
      posted.drew = setPictures > 0;
      posted.setPictures = setPictures;
      return { delivered, answered, ...posted };
    }

    // The picture comes last, once every message is out.
    if (!parsed.draw) return { delivered, answered, ...posted };
    const drawn = await draw({ channel, guildId, parsed, idByIndex, pulledIds, linkFor, trigger, triggerKind, plain, selfName, sourceId, draft });
    if (drawn.posted === true) {
      if (drawn.pulledId) answered.add(drawn.pulledId);
      notePost(drawn.message, drawn.replyId, drawn.op);
      if (typeof drawn.message?.id === 'string' && drawn.message.id) messageIds.push(drawn.message.id);
      posted.drew = true;
    }
    return { delivered: delivered || drawn.posted === true, answered, ...posted, ...(drawn.drawFailed ? { drawFailed: drawn.drawFailed } : {}) };
  }

  /**
   * The `<transcript>` block of a classifier request (re-watch, search) with
   * the media states this turn already has: renderClassifierContext over the
   * live labels (prompts.labels, read now).
   * @returns {{ triggerText: string, transcriptBlock: string }}
   */
  function classifierContext(params) {
    return renderClassifierContext({ ...params, labels: hot.prompts.labels });
  }

  /**
   * The second look on a question (features.videoRewatch for videos,
   * features.imageRelook for pictures): when the trigger asks about a video
   * watched, or a picture posted, in the last `media.video.rewatch.recentMessages`
   * messages (at most `media.video.rewatch.maxCandidates` of them, the videos
   * first, then the watched GIFs, then the pictures, each newest first), one cheap classifier call
   * (prompts.rewatch, on the analyzer model: roleModel for `analyzer` --
   * `models.byPurpose.rewatch`, else `models.helpers.analyzer`, else its default; its answer capped at
   * `media.video.rewatch.classifierMaxOutputTokens`) picks the item and
   * the question. For a video the describer looks at it again
   * (describer.rewatchVideo) and the answer joins that video's state as
   * `answer: { question, text }` -- mutating `videos` in place. For a picture
   * (`pictures`, relookCandidates; listed with the caption `descriptions`
   * holds for it) the describer looks at it again (describer.relookImage) and
   * the answer goes into `imageAnswers` under the picture's id. A watched GIF
   * (`gifs`, gifRewatchItems narrowed to the watched ones; `gifCaptions` holds
   * each one's watched caption) is listed as a `video`, status `watched`,
   * after the videos and before the pictures; the describer watches its clip
   * again (describer.rewatchGif) and the answer goes into `imageAnswers`
   * under the GIF's id (rendered as `videoAnswered`, see
   * src/media/classify.js#mediaLabelFor). A GIF takes a second-look slot and a
   * GIF watch slot (`videoCapsLeft().gif`), never a video one. Videos that
   * did not load (`error` state) are candidates too whenever the describer
   * can fetch one (describer.describeVideo): the classifier's `<n> | retry`
   * watches one again with `force` and its new state replaces the old one; a
   * retry never applies to a picture. The explicit request has its own slot,
   * apart from the `media.video.maxPerTurn` new videos this turn already
   * fetched; the describer's daily caps still apply. At most one second look
   * or retry per turn. The `<media>` lines are numbered 1.. in that order
   * (`<n> | <kind> | <name> | <status> | <summary>`) and the classifier
   * answers with that ordinal, mapped back here. A `<transcript>` block before
   * `<media>` carries the last `media.video.rewatch.contextMessages` messages before the
   * trigger (0 omits it), with the video states and captions this turn already has. Never throws: any failure leaves
   * `videos` and `imageAnswers` as they were. The question and the answer are data: never logged
   * (`rewatch: classified` names a picked GIF `target: 'gif'` and counts `offered.gifs`);
   * every early stop logs `rewatch: skipped` with its reason. The classifier is
   * not asked when its answer could not run (`reason: 'cap'`): the describer's
   * `videoCapsLeft()` (when it has one; read only) says no video can be
   * looked at or retried today (no video slot left, or no second-look slot
   * left and no failed video can be retried) and no picture can be looked
   * at (no second-look slot left -- one counter for every kind) and no GIF
   * can be re-watched (no second-look or no GIF watch slot left) -- with only
   * the second-look slots spent, only the videos that did not load are
   * offered. The classifier's request is a helper's (helperRequestOptions).
   */
  async function maybeRewatch({ config, guildId, channelId, selfName, history, trigger, videos, descriptions, candidates, gifs = [], gifCaptions = new Map(), pictures = [], imageAnswers }) {
    const prompt = hot.prompts?.rewatch;
    if (!prompt) {
      log.info('rewatch: skipped', { channel: channelId, reason: 'no-prompt' });
      return;
    }
    const offer = rewatchOffer({ config, channelId, history, videos, descriptions, candidates, gifs, gifCaptions, pictures });
    if (!offer) return;
    const system = fillPromptTemplate(prompt, { name: selfName ?? '' });
    const rewatchCfg = config.media?.video?.rewatch ?? {};
    // The chat around the question.
    const { triggerText, transcriptBlock } = classifierContext({
      config,
      selfName,
      history,
      trigger,
      contextMessages: Math.max(0, Math.floor(rewatchCfg.contextMessages ?? 50)),
      descriptions,
      videos,
    });
    const user = `${transcriptBlock}<media>\n${offer.lines.join('\n')}\n</media>\n<candidate>\n${trigger.authorName}: ${triggerText}\n</candidate>`;

    let completion;
    try {
      completion = await llm.complete(
        [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        {
          model: roleModel(config, 'analyzer', 'rewatch'),
          ...helperRequestOptions(config, { role: 'analyzer', maxOutputTokens: rewatchCfg.classifierMaxOutputTokens ?? 2000, purpose: 'rewatch' }),
        },
      );
    } catch (err) {
      log.warn('rewatch: classifier failed', { channel: channelId, status: err.statusCode ?? null, name: err.name });
      return;
    }
    const { pick, reason } = parseRewatchPickDetailed(completion.text, offer.listed.length);
    await applyRewatch({ guildId, channelId, offer, pick, reason, videos, imageAnswers });
  }

  /**
   * The `<media>` list of one second look (maybeRewatch's rules, shared with
   * the turn planner): the items offered, newest first within each kind and
   * capped at `media.video.rewatch.maxCandidates`, each judged against the
   * video states `videos`, `gifCaptions` and today's slots, rendered as
   * `<n> | <kind> | <name> | <status> | <summary>`. Null after logging
   * `rewatch: skipped` (`cap`, `no-window`, `no-watched`) when nothing can be
   * offered. `states` is the map the list was judged on; `canRetry` whether a
   * video that did not load may be tried again.
   * @returns {{ listed: { item: object, kind: string }[], lines: string[], states: Map<string, object>,
   *   canRetry: boolean }|null}
   */
  function rewatchOffer({ config, channelId, history, videos, descriptions, candidates, gifs = [], gifCaptions = new Map(), pictures = [] }) {
    // A retry requested by the person has its own slot, outside media.video.maxPerTurn.
    const canRetry = typeof describer.describeVideo === 'function';
    // Today's slots, when the describer can tell: a video's second look and a retry take a video
    // slot; a second look at a video or a picture takes the one second-look slot.
    const slots = typeof describer.videoCapsLeft === 'function' ? describer.videoCapsLeft() : null;
    const questionsOn = !slots || slots.rewatch > 0;
    const videoSlot = !slots || slots.video > 0;
    // A GIF's second look takes a GIF watch slot, never a video one (a describer without the count: no limit).
    const gifSlot = !slots || (slots.gif ?? Infinity) > 0;
    const gifsOn = questionsOn && gifSlot;
    if (slots && (!videoSlot || (!questionsOn && !canRetry)) && (pictures.length === 0 || !questionsOn) && (gifs.length === 0 || !gifsOn)) {
      log.info('rewatch: skipped', { channel: channelId, reason: 'cap' });
      return null;
    }
    const rewatchCfg = config.media?.video?.rewatch ?? {};
    const recent = Math.max(0, Math.floor(rewatchCfg.recentMessages ?? 60));
    if (recent === 0) {
      log.info('rewatch: skipped', { channel: channelId, reason: 'no-window' });
      return null;
    }
    const states = videos instanceof Map ? videos : new Map();
    // `candidates`, `gifs` and `pictures` are each newest first: the videos come first, then the
    // GIFs, and the cap over the merged list keeps the newest of each.
    const maxCandidates = Math.max(1, Math.floor(rewatchCfg.maxCandidates ?? 6));
    const recentIds = new Set(history.slice(-recent).map((m) => m.id));
    const seen = new Set();
    const listed = [];
    for (const item of videoSlot ? candidates : []) {
      if (listed.length >= maxCandidates) break;
      if (seen.has(item.itemId) || !recentIds.has(item.messageId)) continue;
      const state = states.get(item.itemId)?.state;
      if (!(state === 'watched' && questionsOn) && !(state === 'error' && canRetry)) continue;
      seen.add(item.itemId);
      listed.push({ item, kind: REWATCH_KIND_VIDEO });
    }
    for (const item of gifsOn ? gifs : []) {
      if (listed.length >= maxCandidates) break;
      if (seen.has(item.itemId) || !recentIds.has(item.messageId) || !gifCaptions.get(item.itemId)) continue;
      seen.add(item.itemId);
      listed.push({ item, kind: REWATCH_KIND_GIF });
    }
    for (const item of questionsOn ? pictures : []) {
      if (listed.length >= maxCandidates) break;
      if (seen.has(item.itemId) || !recentIds.has(item.messageId)) continue;
      seen.add(item.itemId);
      listed.push({ item, kind: REWATCH_KIND_PICTURE });
    }
    if (listed.length === 0) {
      log.info('rewatch: skipped', { channel: channelId, reason: 'no-watched', watched: 0, recent });
      return null;
    }

    const lines = listed.map(({ item, kind }, index) => {
      if (kind === REWATCH_KIND_PICTURE) {
        const caption = descriptions?.get(item.itemId);
        const summary = caption ? [...oneLine(caption)].slice(0, REWATCH_SUMMARY_CHARS).join('') : '';
        return `${index + 1} | ${kind} | ${oneLine(item.name)} | ${REWATCH_STATUS_DESCRIBED} | ${summary}`.trimEnd();
      }
      if (kind === REWATCH_KIND_GIF) {
        const summary = [...oneLine(gifCaptions.get(item.itemId))].slice(0, REWATCH_SUMMARY_CHARS).join('');
        return `${index + 1} | ${REWATCH_KIND_VIDEO} | ${oneLine(item.name)} | ${REWATCH_STATUS_WATCHED} | ${summary}`.trimEnd();
      }
      const video = states.get(item.itemId);
      const status = video.state === 'watched' ? REWATCH_STATUS_WATCHED : REWATCH_STATUS_NOT_LOADED;
      const summary = video.state === 'watched' ? [...oneLine(video.text)].slice(0, REWATCH_SUMMARY_CHARS).join('') : '';
      return `${index + 1} | ${kind} | ${oneLine(item.name)} | ${status} | ${summary}`.trimEnd();
    });
    return { listed, lines, states, canRetry };
  }

  /**
   * The second look a re-watch answer asked for (`pick`, read by
   * parseRewatchPickDetailed against `offer.listed`; `reason` its parse code)
   * on the item of `offer` it names: logged `rewatch: classified` (codes and
   * counts only), then -- for a usable pick -- the describer looks again and
   * the answer lands in `videos` (mutated in place: a video's answer, or a
   * retried video's new state) or `imageAnswers` (a picture's or a GIF's).
   * A retry is for a video that did not load, a question for a watched one, a
   * GIF or a picture, judged on the states the list was built from
   * (`offer.states`); anything else is ignored.
   */
  async function applyRewatch({ guildId, channelId, offer, pick, reason, videos, imageAnswers }) {
    const { listed, states, canRetry } = offer;
    const entry = pick ? listed[pick.n - 1] : null;
    const item = entry?.item ?? null;
    const isPicture = entry?.kind === REWATCH_KIND_PICTURE;
    const isGif = entry?.kind === REWATCH_KIND_GIF;
    const loaded = item && !isPicture && !isGif ? states.get(item.itemId)?.state === 'watched' : false;
    // A retry is for a video that did not load, a question for a watched one, a GIF or a picture; anything else is ignored.
    const usable = Boolean(item) && (isPicture || isGif ? !pick.retry : pick.retry !== loaded);
    const pictureCount = listed.filter((candidate) => candidate.kind === REWATCH_KIND_PICTURE).length;
    const gifCount = listed.filter((candidate) => candidate.kind === REWATCH_KIND_GIF).length;
    const watchedCount = listed.filter((candidate) => candidate.kind === REWATCH_KIND_VIDEO && states.get(candidate.item.itemId)?.state === 'watched').length;
    // Codes and counts only, never the question: an answer outside the format hints at a prompt mismatch.
    const level = reason === 'unknown-id' || reason === 'no-bar' ? 'warn' : 'info';
    log[level]('rewatch: classified', {
      channel: channelId,
      candidates: listed.length,
      offered: { watched: watchedCount, notLoaded: listed.length - watchedCount - pictureCount - gifCount, gifs: gifCount, pictures: pictureCount },
      retryAllowed: canRetry,
      parse: reason,
      kind: pick ? (pick.retry ? 'retry' : 'question') : null,
      target: entry?.kind ?? null,
      picked: usable,
    });
    if (!usable) return;

    if (isPicture) {
      const answer = await describer.relookImage(guildId, item, pick.question);
      if (answer) imageAnswers.set(item.itemId, answer);
      return;
    }
    if (isGif) {
      const answer = await describer.rewatchGif(guildId, item, pick.question);
      if (answer) imageAnswers.set(item.itemId, answer);
      return;
    }
    if (pick.retry) {
      const retried = await describer.describeVideo(guildId, item, { force: true });
      if (retried) videos.set(item.itemId, retried);
      return;
    }
    const answer = await describer.rewatchVideo(guildId, item, pick.question);
    if (answer) videos.set(item.itemId, { ...(videos.get(item.itemId) ?? states.get(item.itemId)), answer });
  }

  /**
   * Whether the server search (`recall`) could run now: wired, and its
   * `available()` (the switch, its prompt, the daily caps; read only) says
   * yes. A throw counts as no.
   */
  function recallAvailable() {
    if (typeof recall?.available !== 'function' || typeof recall.run !== 'function') return false;
    try {
      return recall.available() === true;
    } catch {
      return false;
    }
  }

  /**
   * The fallback directory of one turn (mentionDirectory) as a thunk, built on its first call
   * and kept for the turn: the served guild's member cache (the client's guild, else the
   * channel's; only the members Discord already sent, no fetch) and, with memory on, the stored
   * profiles. A failure to build it logs `turn: directory failed` and gives an empty one.
   * @returns {() => { name: string, id: string }[]}
   */
  function turnDirectory({ guildId, channel, memoryOn }) {
    let built = null;
    return () => {
      if (built) return built;
      try {
        const cache = (client.guilds?.cache?.get?.(guildId) ?? channel?.guild)?.members?.cache;
        const members = cache && typeof cache.values === 'function' ? [...cache.values()] : [];
        const profiles = memoryOn && typeof store.listUserProfiles === 'function' ? (store.listUserProfiles(guildId) ?? []) : [];
        built = mentionDirectory({ members, profiles, selfId: client?.user?.id ?? null });
      } catch (err) {
        log.warn('turn: directory failed', { guildId, error: err });
        built = [];
      }
      return built;
    };
  }

  /**
   * A private chat's partner as a member of the served guild (a discord.js
   * GuildMember), for a private chat that works like a server turn on their
   * behalf: features.privateLikeServer (read from `config`, the turn's live
   * config; a missing key counts as on, only false turns it off). The member
   * is fetched from the pinned guild (`guild.members.fetch`, the cache first).
   * Null with the switch off, without a user id, a cached guild or a member
   * fetch; a fetch that fails (the member left) logs `turn: partner failed`
   * and is null too. Never rejects.
   * @returns {Promise<object|null>}
   */
  async function privatePartner({ guildId, userId, config }) {
    if (config.features?.privateLikeServer === false || !userId) return null;
    const guild = client.guilds?.cache?.get?.(guildId) ?? null;
    if (typeof guild?.members?.fetch !== 'function') return null;
    try {
      return (await guild.members.fetch(userId)) ?? null;
    } catch (err) {
      log.warn('turn: partner failed', { guildId, userId, error: err });
      return null;
    }
  }

  /**
   * `work()` as a promise that never rejects: a throw or a rejection logs
   * `lookup: failed` with the `part` it was (`web` / `server`) and gives null.
   */
  function settleLookupPart(work, channelId, part) {
    return Promise.resolve()
      .then(work)
      .catch((err) => {
        log.warn('lookup: failed', { channel: channelId, part, error: err });
        return null;
      });
  }

  /**
   * One attempt's turn planner (src/behavior/planner.js, features.turnPlanner
   * exactly true): the one request that stands in for the route, the
   * participation pick, the re-watch and the search classifiers. The pull's
   * route step registers its channel list (`offerChannels`, ignored once the
   * planner started) and waits on `result` for its pick; the participation,
   * re-watch and lookup stages wait on `result` too. `start(inputs)` sends
   * the request once -- `transcriptBlock`, `candidateBlock`, the `episodes`
   * and `media` offers (`{ lines, ids }` / rewatchOffer's, null when not
   * offered) and `lookup` (true when the search classifier would have been
   * asked); later calls do nothing. `abandon(reason)` settles `result` with
   * every block missing when the planner never started (a deadline passed
   * first, or the attempt ended), so no stage waits forever. `early` is true
   * on a turn whose pull is awaited before its preparation (a source, or a
   * mode still to choose): its route step starts the planner itself.
   * `result` never rejects: askPlanner's `{ outcome, reason, blocks }` plus
   * `offer` (`channel`, `episodes`, `media`: the offers sent, null when not;
   * `lookup`: boolean), what each consumer maps the block's numbers back with.
   */
  function createTurnPlan({ config, channelId, selfName, triggerKind, limits, early }) {
    let channelOffer = null;
    let started = false;
    let settle;
    const result = new Promise((resolve) => {
      settle = resolve;
    });
    const unused = (reason) => ({ outcome: 'skipped', reason, blocks: parsePlannerAnswer(''), offer: { channel: null, episodes: null, media: null, lookup: false } });
    const offered = (offer) => (Array.isArray(offer?.lines) && offer.lines.length > 0 ? offer : null);
    return {
      early,
      result,
      get started() {
        return started;
      },
      offerChannels(offer) {
        if (!started) channelOffer = offered(offer);
      },
      start({ transcriptBlock = '', candidateBlock = null, episodes = null, media = null, lookup: lookupWanted = false }) {
        if (started) return;
        started = true;
        const offer = { channel: channelOffer, episodes: offered(episodes), media: offered(media), lookup: lookupWanted === true };
        const discovery = discoveryPrompt(config);
        askPlanner({
          llm,
          config,
          prompt: hot.prompts?.planner,
          selfName,
          today: zonedDay(clock(), config.bot?.timezone),
          skills: discovery.index,
          skillNames: discovery.names,
          offer: { channels: offer.channel?.lines, episodes: offer.episodes?.lines, episodeAges: offer.episodes?.ages, media: offer.media?.lines, lookup: offer.lookup },
          transcriptBlock,
          candidateBlock,
          channelId,
          kind: triggerKind,
          now: clock,
          limits,
        }).then(
          (asked) => settle({ ...asked, offer }),
          () => settle(unused('error')),
        );
      },
      abandon(reason = 'late') {
        if (started) return;
        started = true;
        settle(unused(reason));
      },
    };
  }

  /**
   * Which side of a lookup can run now (maybeLookup's gates, shared with the
   * turn planner's offer): the web side under `webOn` unless
   * `web.search.maxPerTurn` is below 1 (`no-slot`), the search has no key
   * (`no-key`) or its daily slots are spent (`cap`); `skip` is that code, or
   * `no-search`, when neither the web side nor the server side (`serverOn`)
   * can run, else null. Read only.
   * @returns {{ webCan: boolean, skip: string|null }}
   */
  function lookupGate({ config, webOn, serverOn }) {
    const searchCfg = config.web?.search ?? {};
    let webSkip = null;
    if (webOn) {
      if ((searchCfg.maxPerTurn ?? 1) < 1) webSkip = 'no-slot';
      else if (typeof lookup.hasSearch === 'function' && !lookup.hasSearch()) webSkip = 'no-key';
      else if (typeof lookup.webCapLeft === 'function' && !(lookup.webCapLeft() > 0)) webSkip = 'cap';
    }
    const webCan = Boolean(webOn) && webSkip === null;
    return { webCan, skip: !webCan && !serverOn ? (webSkip ?? 'no-search') : null };
  }

  /**
   * The searches on a question: the web search (`webOn`: features.webLookup,
   * web.search.enabled, a lookup with `search`) and the search of the
   * server's own history (`serverOn`: recall wired and available, a server
   * turn or a private chat with its `partner`; `guild` is the guild searched,
   * the served one in a private chat). One cheap classifier call (prompts.lookup, `{{name}}` = the
   * persona's display name, `{{today}}` = the injected clock's date
   * `YYYY-MM-DD` in `bot.timezone`, the zone its `when:` range is read in;
   * on the helper model (roleModel, role `analyzer`), its answer capped at
   * `web.search.classifierMaxOutputTokens`) reads the last
   * `web.search.contextMessages` messages of `history` before the trigger
   * (with the pictures' captions, the video states and the read links this
   * turn already has; on a routed turn the caller passes the source
   * channel's lines, where the call was written) and the trigger itself, and
   * answers `none` or labelled lines (src/behavior/recall.js#parseLookupAnswer,
   * `when:` read in `bot.timezone`, forms capped at `recall.maxForms`).
   * The web side runs only under its own gates: `web.search.maxPerTurn`
   * below 1 (`no-slot`), no search key (`no-key`), its daily slots spent
   * (`cap`: the lookup's `webCapLeft()`, when it has one; read only); the
   * classifier is not asked when neither side can run (`lookup: skipped`
   * with the web side's reason, or `no-prompt` without prompts.lookup). Then
   * what the answer asks for runs in parallel: a `web` query goes to
   * lookup.search (at most one per turn), a `server` part to `recall.run`
   * (`history` = `chatHistory`, the turn's own chat with its reply parents:
   * what `<chat>` shows; `context` = `history`, the lines this classifier
   * read, with their `descriptions`; `candidate` = the trigger); a part the answer asks for whose side cannot run is not run,
   * and a failing part logs `lookup: failed` and counts as nothing. Resolves
   * the `lookup` input of the request (see createTurnRunner) or null. The
   * query, the forms and the transcript are data: never logged (`lookup:
   * classified` carries codes and counts only); an empty or blank answer is
   * a failed call (`lookup: classifier failed`, `reason: 'empty'`). A failed
   * call (it threw, or answered nothing) on a direct call (`triggerKind` in
   * DIRECT_CALLS) with `serverOn` and recall.fallbackOnClassifierFailure on
   * runs the server search on the question's own words instead
   * (fallbackLookupPlan over the stored profiles; `lookup: fallback` with
   * `reason` `classifier-failed` | `empty` and the counts, a `helper-fallback`
   * entry on `limits`); never the web search; else no search. Its request is a helper's (helperRequestOptions). `onSearch()`
   * is called once the answer asks for a search that runs, before it starts
   * (the turn's deadline grows to pace.prepareSearchMs; until the answer the
   * turn holds its deadline on this call, see createDeadline's `hold`).
   * With the turn planner (`planned`: the attempt's createTurnPlan result)
   * no classifier is asked here: the planner's lookup block stands in for its
   * answer -- `ok` runs what it asks for; `none`, a planner that skipped or a
   * block it never offered run nothing; `invalid`, `missing` or a failed
   * planner call take the failed classifier's fallback above (`reason` the
   * state or the failure code; the `helper-fallback` entry is the planner's,
   * `where: 'planner:lookup'`).
   * Skills discovery (discoveryPrompt, read now): the classifier's `{{skills}}`
   * is filled with the registry's lines, and a `skills:` line of its answer
   * (parseLookupAnswer's `skills`) is handed to `onSkills` before any search
   * runs; with the planner the turn reads the planner's own `skills:` line.
   * An `agent:` line of the answer (a classifier prompt that still has one) is ignored: the
   * classifier never creates or suggests an errand, only the persona's own `task.run` call does.
   * `lookup: classified` carries `route` -- what runs: `fast` (a web search), `memory` (a server
   * search), `+`-joined in that order, else `none`.
   */
  async function maybeLookup({ config, guildId, channel, guild = channel.guild, partner = null, selfId, selfName, history, chatHistory, trigger, descriptions, videos, reads, webOn, serverOn, onSearch, onSkills = null, journalStep = null, triggerKind = null, limits = null, planned = null }) {
    const channelId = channel.id;
    const prompt = hot.prompts?.lookup;
    const searchCfg = config.web?.search ?? {};
    const { webCan, skip: gateSkip } = lookupGate({ config, webOn, serverOn });
    let skip = null;
    if (!planned && !prompt) skip = 'no-prompt';
    else skip = gateSkip;
    if (skip) {
      log.info('lookup: skipped', { channel: channelId, reason: skip });
      return null;
    }

    // The chat around the question, with the pages this turn already read.
    const { triggerText, user } = lookupClassifierInput({ config, labels: hot.prompts.labels, selfName, history, trigger, descriptions, videos, reads });
    if (planned) {
      if (planned.offer?.lookup !== true || planned.outcome === 'skipped') return null;
      if (planned.outcome === 'failed') return fallback(planned.reason);
      const answer = planned.blocks.lookup;
      if (answer.state === 'ok') return runSearches({ web: answer.web, server: answer.server });
      return answer.state === 'none' ? null : fallback(answer.state);
    }

    // Read once: the request and its empty-answer warning name the same model.
    const model = roleModel(config, 'analyzer', 'lookup');
    // Skills discovery: the registry's lines fill `{{skills}}`, its names bound the `skills:` line.
    const discovery = discoveryPrompt(config);
    let completion;
    try {
      completion = await llm.complete(
        [
          { role: 'system', content: fillPromptTemplate(prompt, { today: zonedDay(clock(), config.bot?.timezone), name: selfName ?? '', skills: discovery.index }) },
          { role: 'user', content: user },
        ],
        { model, ...helperRequestOptions(config, { role: 'analyzer', maxOutputTokens: searchCfg.classifierMaxOutputTokens ?? 2000, purpose: 'lookup' }) },
      );
    } catch (err) {
      log.warn('lookup: classifier failed', { channel: channelId, status: err.statusCode ?? null, name: err.name });
      return fallback('classifier-failed');
    }
    if (!String(completion.text ?? '').trim()) {
      // Nothing at all (typically a reasoning model that spent its whole
      // output cap thinking) is a failed call, not a silent "none".
      log.warn('lookup: classifier failed', { channel: channelId, reason: 'empty', model: model ?? null });
      return fallback('empty');
    }
    const parsed = parseLookupAnswer(completion.text, { timezone: config.bot?.timezone, now: clock(), maxForms: recallSettings(config)?.maxForms, skillNames: discovery.names });
    // The `skills:` line goes to the turn, whatever the searches do (src/skills/discovery.js).
    if (parsed.skills) onSkills?.(parsed.skills);
    const { web, server } = parsed;
    const route = [webCan && web ? 'fast' : null, serverOn && server ? 'memory' : null].filter(Boolean).join('+') || 'none';
    // Codes and counts only, never the query, a form or a name.
    log.info('lookup: classified', {
      channel: channelId,
      picked: Boolean(web || server),
      parse: parsed.reason,
      web: Boolean(parsed.web),
      server: Boolean(server),
      forms: server?.forms.length ?? 0,
      who: server?.who.length ?? 0,
      ranged: Boolean(server && (server.from !== null || server.to !== null)),
      route,
    });
    return runSearches({ web, server });

    /**
     * The failed classifier's fallback (`reason`: `classifier-failed` | `empty`): on a direct call
     * (DIRECT_CALLS) with the server search possible and recall.fallbackOnClassifierFailure on, a
     * recall on the question's own words (fallbackLookupPlan); never the web side. Null otherwise.
     */
    async function fallback(reason) {
      if (!serverOn || !DIRECT_CALLS.has(triggerKind)) return null;
      const settings = recallSettings(config);
      if (!settings?.fallbackOnClassifierFailure) return null;
      const plan = fallbackLookupPlan({ text: triggerText, profiles: store.listUserProfiles?.(guildId) ?? [], selfId, selfName, maxForms: settings.maxForms });
      if (!plan) return null;
      // Counts only, never a form or a name.
      log.info('lookup: fallback', { channel: channelId, reason, forms: plan.forms.length, who: plan.who.length });
      // The planner records its own fallen-back blocks (src/behavior/planner.js#askPlanner).
      if (!planned) limits?.add({ kind: 'helper-fallback', where: 'lookup', detail: reason });
      return runSearches({ web: null, server: plan });
    }

    /** The searches asked for (`web` query, `server` part), those whose side can run, in parallel. */
    async function runSearches({ web, server }) {
      const runWeb = webCan && Boolean(web);
      const runServer = serverOn && Boolean(server);
      if (!runWeb && !runServer) return null;
      onSearch?.();
      // The journal: each search the answer asks for is an operation of the engine (journalStep).
      const webOp = runWeb ? (journalStep?.('lookup', 'lookup', { input: { query: web } }) ?? null) : null;
      const recallOp = runServer
        ? (journalStep?.('lookup', 'recall', { input: { forms: server.forms, who: server.who, from: server.from, to: server.to } }, (result) => result.summaryChars > 0 || result.stretch === true) ?? null)
        : null;
      const [webResult, found] = await Promise.all([
        runWeb
          ? settleLookupPart(
              () =>
                journalled(webOp, () => lookup.search(guildId, web), (result) =>
                  result ? { result: { results: Array.isArray(result.sources) ? result.sources.length : 0 }, offered: Boolean(result.text) } : { failed: CODE.NO_RESULT },
                ),
              channelId,
              'web',
            )
          : null,
        runServer
          ? settleLookupPart(
              () =>
                recall.run({
                  ...(recallOp ? { op: recallOp } : {}),
                  guild,
                  guildId,
                  channel,
                  partner,
                  selfId,
                  selfName,
                  history: chatHistory,
                  context: history,
                  contextDescriptions: descriptions,
                  candidate: trigger,
                  server,
                  // Her lines in the found stretches show her skill calls like her chat lines.
                  decorate: (lines) => linkCalls(lines, { channel, guildId }),
                }),
              channelId,
              'server',
            )
          : null,
      ]);
      // A server search that found nothing leaves no server part.
      const serverPart =
        found && (found.text || found.stretch)
          ? { text: found.text ?? null, stretch: found.stretch ?? null, people: Array.isArray(found.people) ? found.people : [] }
          : null;
      if (!serverPart) return webResult ?? null;
      return { ...(webResult ?? {}), server: serverPart };
    }
  }

  /**
   * The splitter (src/behavior/split.js): whether the call `trigger` holds
   * several requests. One cheap classifier call (`prompt`, prompts/split.md,
   * `{{name}}` = the persona's display name, `{{maxTasks}}` = split.maxTasks;
   * on the `analyzer` helper model (roleModel), its answer capped at split.maxOutputTokens, a
   * helper's request: helperRequestOptions, purpose `split`) reads the last
   * `split.contextMessages` messages of `history` before the trigger (the
   * captions this turn has at its start) and the trigger itself, and answers
   * `one` or 2..maxTasks lines `- <part>` (parseSplitAnswer). Resolves the
   * parts, or null for one request: `one`, a failed call (`split: failed`
   * with the rail's code or `llm-error` and the HTTP status), an empty or
   * unparsable answer (`split: failed`, `empty` / `unparsed`). Every answer
   * that parsed logs `split: verdict` (`parts`: 1 for `one`, `ms`, and `late`
   * once the turn went on without it, `isLate()`). Codes and counts only,
   * never a part. Never throws.
   * @returns {Promise<string[]|null>}
   */
  async function maybeSplit({ config, channelId, selfName, history, trigger, descriptions, prompt, isLate }) {
    const settings = splitSettings(config);
    const startedAt = clock();
    let completion;
    try {
      const { triggerText, transcriptBlock } = classifierContext({
        config,
        selfName,
        history,
        trigger,
        contextMessages: settings.contextMessages,
        descriptions,
      });
      completion = await llm.complete(
        [
          { role: 'system', content: fillPromptTemplate(prompt, { name: selfName ?? '', maxTasks: settings.maxTasks }) },
          { role: 'user', content: `${transcriptBlock}<candidate>\n${trigger.authorName}: ${triggerText}\n</candidate>` },
        ],
        {
          model: roleModel(config, 'analyzer', 'split'),
          ...helperRequestOptions(config, { role: 'analyzer', maxOutputTokens: settings.maxOutputTokens, purpose: 'split' }),
        },
      );
    } catch (err) {
      log.warn('split: failed', { channel: channelId, reason: railReason(err), status: err?.statusCode ?? null });
      return null;
    }
    const { parts, reason } = parseSplitAnswer(completion?.text, settings);
    const late = isLate() ? { late: true } : {};
    if (reason === 'empty' || reason === 'unparsed') {
      log.warn('split: failed', { channel: channelId, reason, status: null, ...late });
      return null;
    }
    log.info('split: verdict', { channel: channelId, parts: parts?.length ?? 1, ms: clock() - startedAt, ...late });
    return parts;
  }

  /**
   * fetchPull (interfaces/discord/pull-fetch.js) that never throws: an unexpected
   * failure is logged (`pull: failed`) and counts as a skip with code `error`.
   */
  async function pullSafely(args) {
    try {
      return await fetchPull(args);
    } catch (err) {
      log.warn('pull: failed', { channel: args.destination?.id ?? null, source: args.channelId, pullReason: args.reason, error: err });
      return { pulled: null, skip: 'error' };
    }
  }

  /**
   * The route hook's picks as `{ id, direction }`: a non-empty string id (direction null) or
   * `{ id, direction: 'earlier' }` (the page before the last view of that channel); anything
   * else is dropped. A throw (`pull: route failed`) or a non-array answer is [].
   */
  async function routeIds(args) {
    try {
      const ids = await routeChannels(args);
      if (!Array.isArray(ids)) return [];
      return ids
        .map((pick) => (typeof pick === 'string' ? { id: pick, direction: null } : { id: pick?.id, direction: pick?.direction === 'earlier' ? 'earlier' : null }))
        .filter((pick) => typeof pick.id === 'string' && pick.id !== '');
    } catch (err) {
      log.warn('pull: route failed', { channel: args.channel.id, error: err });
      return [];
    }
  }

  /**
   * Whether a server turn in `channel` has the persona's participation store: features.memory
   * and features.participation on (`config`, the turn's live config; a missing key counts as on),
   * a server channel that is not the diary channel (`diary.channelId`), and a store that keeps
   * one. Recording, the pick classifier and the `<participation>` block all ask this.
   */
  function participationOn(channel, config) {
    const features = config.features ?? {};
    if (features.memory === false || features.participation === false) return false;
    if (!channel?.guild || typeof store.getParticipation !== 'function') return false;
    const diaryId = config.diary?.channelId;
    return !(diaryId && channel.id === diaryId);
  }

  /**
   * Which channels a turn in `channel` may show participation episodes from: a channel of its
   * guild whose audience passes the rail the neighbours and the pulls pass
   * (interfaces/discord/pull-fetch.js#audienceAllows, `context.pull.sameAudience`: everyone who can
   * read this channel can read that one). A channel the guild does not hold, or a check that
   * throws, is refused.
   * @returns {(channelId: string) => boolean}
   */
  function participationAudience(channel, config) {
    const cache = channel.guild?.channels?.cache;
    return (channelId) => {
      try {
        const other = cache?.get?.(channelId) ?? null;
        return Boolean(other) && audienceAllows(channel, other, config);
      } catch {
        return false;
      }
    };
  }

  /**
   * The live part of `<people_now>` (interfaces/discord/around.js): the snapshot of the voice channels and
   * of the statuses (the prompt builder derives each person's row from it) and the voice channels' names -- only those a member without any role may see, so
   * she never names who sits in a room this chat cannot see. Null without the store, with
   * `features.around` off (a missing key counts as on), in a private chat and in a diary post.
   * Read at the moment of the request; nothing of it is kept.
   */
  function aroundInputFor({ channel, config, mode, isPrivate }) {
    if (!around || config.features?.around === false || isPrivate || mode === 'diary') return null;
    const guild = channel.guild;
    return {
      snapshot: around.snapshot(),
      channelNameOf: (channelId) => {
        const voice = guild?.channels?.cache?.get?.(channelId);
        const visible = voice?.permissionsFor?.(guild.roles?.everyone)?.has?.('ViewChannel') === true;
        return visible && typeof voice.name === 'string' && voice.name ? voice.name : null;
      },
    };
  }

  /** A channel's live name in `channel`'s guild, for a participation episode whose channel has no stored note. */
  function liveChannelName(channel) {
    return (channelId) => {
      const name = channel.guild?.channels?.cache?.get?.(channelId)?.name;
      return typeof name === 'string' && name ? name : null;
    };
  }

  /**
   * One message of a turn's history in the participation store's shape
   * (src/memory/participation.js): the persona's own lines named `selfName`, a picture's
   * caption the turn already had (`descriptions`, the first captioned picture of the line).
   */
  function participationMessage(message, { selfName, descriptions }) {
    let caption = null;
    if (descriptions instanceof Map && descriptions.size > 0) {
      for (const item of collectPictures(message)) {
        const text = descriptions.get(item.itemId);
        if (typeof text === 'string' && text) {
          caption = text;
          break;
        }
      }
    }
    return {
      id: message.id,
      ts: message.ts,
      authorId: message.authorId ?? '',
      name: message.self ? selfName : (message.authorName ?? ''),
      self: message.self === true,
      text: typeof message.content === 'string' ? message.content : '',
      replyTo: message.replyToId ?? null,
      caption,
    };
  }

  /**
   * Record one message the persona just sent in `channel` in the guild's participation store
   * (src/memory/participation.js#recordOwnLine, settings read now): `own` her message, `before`
   * the last `participation.linesBefore` lines of the turn's `history` followed by what she
   * already sent this turn (`earlier`), `parent` the line it replies to when the history holds
   * it (the reply parents the turn fetched included; nothing is fetched here). Written only when
   * something changed, then logged `participation: recorded` (`channel`, `episodes`: how many
   * the store holds). Never throws: a failure logs `participation: failed` (`reason:
   * 'record-error'`).
   */
  function recordOwnParticipation({ channel, guildId, history, earlier, own, replyId, selfName, descriptions }) {
    try {
      const config = hot.config;
      if (!participationOn(channel, config)) return;
      const settings = participationSettings(config);
      const at = clock();
      const shape = (message) => participationMessage(message, { selfName, descriptions });
      const take = Math.max(0, Math.floor(settings.linesBefore));
      const before = take > 0 ? [...history, ...earlier].slice(-take).map(shape) : [];
      const parentLine = replyId ? (history.find((message) => message.id === replyId) ?? null) : null;
      const state = store.getParticipation(guildId);
      const next = recordOwnLine(
        state,
        { channelId: channel.id, own: shape(own), before, parent: parentLine ? shape(parentLine) : null },
        settings,
        at,
      );
      if (next === state) return;
      store.setParticipation(guildId, next, { settings, now: at });
      log.info('participation: recorded', { channel: channel.id, episodes: next.episodes.length });
    } catch (err) {
      log.warn('participation: failed', { channel: channel?.id ?? null, reason: 'record-error', name: err?.name ?? null });
    }
  }

  /**
   * The input of a turn's `<recent>` block (src/behavior/prompt.js#buildRequest
   * `recentLines` / `recentAudience`): the guild's recent lines inside the last
   * `memory.recentHours` (src/memory/store.js#getRecent, read now) and which
   * source channels this turn may show them from. On a server turn: the
   * channel the turn posts in, and every channel whose audience covers it
   * (interfaces/discord/collect.js#audienceOf, src/behavior/elsewhere.js#audienceCovers:
   * everyone who can read this channel can read that one). In a private chat:
   * the channels every member of the served guild can read. A channel the
   * guild does not hold is never covered. No live line: an empty list (the
   * block may still show the members' moments of those hours). Nothing
   * (`lines` undefined: no block at all) with features.recent off (a missing
   * key counts as on) or for a store without the recent store (tests' fakes);
   * a read that throws is logged (`recent: failed`) and is nothing either: the
   * block is never worth a turn.
   * @returns {{ lines: object[]|undefined, audience: ((channelId: string|null) => boolean)|undefined }}
   */
  function recentInput({ channel, guildId, isPrivate, config, now }) {
    const settings = recentSettings(config);
    if (!settings || typeof store.getRecent !== 'function') return NO_RECENT;
    try {
      const lines = liveRecent(store.getRecent(guildId)?.lines, { now, hours: settings.hours });
      if (lines.length === 0) return { lines, audience: undefined };
      const guild = isPrivate ? (client.guilds?.cache?.get?.(guildId) ?? null) : channel.guild;
      const here = isPrivate ? everyMemberAudience() : audienceOf(channel);
      const allowed = new Set();
      for (const id of new Set(lines.map((line) => line.channelId))) {
        if (typeof id !== 'string' || !id) continue;
        if (!isPrivate && id === channel.id) allowed.add(id);
        else if (audienceCovers(here, audienceOf(guild?.channels?.cache?.get?.(id) ?? null))) allowed.add(id);
      }
      return { lines, audience: (channelId) => allowed.has(channelId) };
    } catch (err) {
      log.warn('recent: failed', { channel: channel.id, error: err });
      return NO_RECENT;
    }
  }

  /**
   * A diary post's first step (mode `diary`), before its request is built:
   * the post history (store.getDiary), whether it may carry a picture (the
   * image client, `features.imageGeneration`, Attach Files here, the day's
   * diary pictures under `diary.maxPicturesPerDay` (2) and the image client's
   * own cap not spent), then the plan request (src/behavior/prompt.js#buildDiaryPlanRequest:
   * prompts/diary-plan.md on the classifier model, `diary.planMaxOutputTokens`
   * (300), `diary.planTimeoutMs` (20000), usage purpose `diary-plan`; when
   * `llm.hedge` hedges `analyzer`, the hedged call is limited by
   * `diary.planTimeoutMs` rather than `llm.hedge.timeoutMs`) with
   * `<seeds>` drawn from prompts/diary-seeds.md (`diary.seedSets`, 2) and,
   * with an owner's topic (`params.topic`, src/behavior/diary.js#diaryTopic),
   * a `<topic>` block after them; the topic also rides on the plan as its
   * `topic` field (the `<plan>` block of the post). The answer goes through parseJsonObject and src/behavior/diary.js#validatePlan
   * (a weighted random kind when it is missing, broken or names no weighted
   * kind; `diary.searchKinds`, `diary.pictureKinds`). While the post may not
   * carry a picture, the kinds in `diary.pictureKinds` are dropped before the
   * plan request and validatePlan (src/behavior/diary.js#withoutPictureKinds),
   * so neither the planner nor the random fallback picks one, and the
   * `diary: planned` line carries `picturesOff: true`. A forced kind
   * (`params.kind`) is the only kind offered and replaces the answer's kind,
   * its brief kept (a forced picture kind with pictures off never gets here:
   * runTurn refuses it first, diaryPictureGate). Then the search the plan asks for (lookup.search, its own
   * switch, cache and daily cap): its text is `found`; a failure or nothing
   * found logs `diary: search failed` and the post goes without it. A request
   * or token cap on the plan request throws (the turn is refused); any other
   * failure of it falls back. A planned kind in `diary.setKinds` (a set post) also draws
   * `diary.set.seedSets` (6) seed combinations for the compose request (`seeds`, the rendered
   * `<seeds>` body; '' for any other kind). Settings come from `config`, the turn's live config.
   * @returns {Promise<{ posts: object[], plan: { kind: string|null, brief: string, search: string,
   *   picture: boolean, fallback: boolean, topic?: string }, found: string|null, pictureAllowed: boolean, seeds: string }>}
   */
  async function prepareDiary({ config, guildId, channel, selfName, history, now, params, memoryOn, draft = null }) {
    const prompts = hot.prompts;
    const labels = prompts?.labels;
    const diaryCfg = config.diary ?? {};
    const stored = typeof store.getDiary === 'function' ? store.getDiary(guildId) : null;
    const posts = Array.isArray(stored?.posts) ? stored.posts : [];
    const forcedKind = typeof params?.kind === 'string' && params.kind ? params.kind : null;
    const topic = diaryTopic(params?.topic);
    const pictureAllowed = diaryPictureGate(config, channel, now).allowed;
    // Pictures off: only the text kinds are offered (a forced kind is offered alone).
    const picturesOff = !forcedKind && !pictureAllowed;
    const kinds = forcedKind
      ? { [forcedKind]: 1 }
      : picturesOff
        ? withoutPictureKinds(diaryCfg.kinds ?? {}, diaryCfg.pictureKinds)
        : (diaryCfg.kinds ?? {});

    let answer = null;
    const planPrompt = prompts?.['diary-plan'];
    if (typeof planPrompt === 'string' && planPrompt.trim() && labels) {
      const recent = memoryOn ? recentInput({ channel, guildId, isPrivate: false, config, now }) : NO_RECENT;
      const seedsText = renderSeedsBlock(pickSeeds(parseSeedFamilies(prompts['diary-seeds']), diaryCfg.seedSets ?? 2, rng), labels);
      const request = buildDiaryPlanRequest({
        config,
        prompts,
        calibrator,
        now,
        selfName,
        history,
        guildMemory: memoryOn ? store.getGuild(guildId) : null,
        channels: memoryOn ? store.listChannels(guildId) : [],
        loreEntries: memoryOn ? store.getLore(guildId) : [],
        currentChannelId: channel.id,
        recentLines: recent.lines ?? null,
        recentAudience: recent.audience ?? null,
        candidateProfiles: memoryOn ? store.listUserProfiles(guildId) : [],
        nameOf: memoryOn ? (id) => store.getUser(guildId, id)?.names?.[0] ?? null : null,
        posts,
        kinds,
        seedsText,
        topicText: renderTopicBlock(topic, labels),
      });
      const planTimeoutMs = diaryCfg.planTimeoutMs ?? 60000;
      // A hedged plan request gets the plan's own limit, not llm.hedge.timeoutMs.
      const hedge = hedgeSettings(config);
      const planHedge = hedge && hedge.afterMs > 0 && hedge.roles.includes('analyzer')
        ? { hedge: { afterMs: hedge.afterMs, timeoutMs: planTimeoutMs } }
        : {};
      let completion = null;
      try {
        completion = await llm.complete(request.messages, {
          model: roleModel(config, 'analyzer', 'diary-plan'),
          ...helperRequestOptions(config, {
            role: 'analyzer',
            maxOutputTokens: diaryCfg.planMaxOutputTokens ?? 2000,
            purpose: 'diary-plan',
            timeoutMs: planTimeoutMs,
          }),
          ...planHedge,
        });
      } catch (err) {
        if (err instanceof DailyCapError || err instanceof TokenLimitError) throw err;
        log.warn('diary: plan failed', { channel: channel.id, reason: railReason(err), status: err?.statusCode ?? null });
      }
      if (completion) {
        try {
          answer = parseJsonObject(completion.text);
        } catch {
          log.warn('diary: plan failed', { channel: channel.id, reason: 'unparsed', status: null });
        }
      }
    } else {
      log.warn('diary: plan failed', { channel: channel.id, reason: 'no-prompt', status: null });
    }
    if (forcedKind && answer && typeof answer === 'object' && !Array.isArray(answer)) answer = { ...answer, kind: forcedKind };
    const validated = validatePlan(answer, kinds, { pictureAllowed, searchKinds: diaryCfg.searchKinds, pictureKinds: diaryCfg.pictureKinds }, rng);
    // The owner's topic reaches the post even when the planner ignored it.
    const plan = topic ? { ...validated, topic } : validated;

    let found = null;
    if (plan.search && typeof lookup?.search === 'function') {
      // The journal: the plan's search is the engine's operation; what it found enters the post's request.
      const op = journalOp(draft, 'lookup', 'engine', { input: { query: plan.search } });
      if (op.opId) await op.started();
      try {
        const result = await lookup.search(guildId, plan.search);
        found = typeof result?.text === 'string' && result.text.trim() ? result.text.trim() : null;
        if (op.opId) await (result ? op.succeeded({ results: Array.isArray(result.sources) ? result.sources.length : 0, delivered: found !== null }) : op.failed(CODE.NO_RESULT));
        if (found === null) log.info('diary: search failed', { channel: channel.id, reason: result ? 'nothing' : 'refused' });
      } catch (err) {
        if (op.opId) await op.failed(CODE.ERROR);
        log.warn('diary: search failed', { channel: channel.id, reason: 'error', error: err });
      }
    }
    // A set post (diary.setKinds): its compose request gets diary.set.seedSets seed combinations.
    const seeds = isSetKind(plan.kind, diaryCfg.setKinds)
      ? renderSeedsBlock(pickSeeds(parseSeedFamilies(prompts?.['diary-seeds']), setSettings(diaryCfg).seedSets, rng), labels ?? {})
      : '';
    log.info('diary: planned', {
      channel: channel.id,
      kind: plan.kind,
      fallback: plan.fallback,
      picture: plan.picture,
      search: Boolean(plan.search),
      found: found !== null,
      forced: params?.forced === true,
      ...(picturesOff ? { picturesOff: true } : {}),
    });
    return { posts, plan, found, pictureAllowed, seeds };
  }

  /**
   * Whether a diary post in `channel` may carry a picture now, and which gate
   * closed when not, checked in this order: the image client, `features.imageGeneration`
   * (a missing key counts as on), Attach Files here (`limit: null` for these three), the
   * day's diary pictures under `diary.maxPicturesPerDay` (2), the image client's own
   * daily cap (`image.maxPerDay`); a closed cap names its key and counts. Settings come
   * from `config`, the turn's live config.
   * @returns {{ allowed: boolean, limit: { key: string, used: number, cap: number }|null }}
   */
  function diaryPictureGate(config, channel, now) {
    const closed = (limit = null) => ({ allowed: false, limit });
    const imageQuota = images && typeof images.quota === 'function' ? images.quota({}) : null;
    if (!imageQuota || config.features?.imageGeneration === false || !canAttach(channel)) return closed();
    const picturesToday = countToday(store.state.data, DIARY_PICTURES_DAILY, now);
    const diaryCap = config.diary?.maxPicturesPerDay ?? 8;
    if (picturesToday >= diaryCap) return closed({ key: 'diary.maxPicturesPerDay', used: picturesToday, cap: diaryCap });
    if (imageQuota.used >= imageQuota.cap) return closed({ key: 'image.maxPerDay', used: imageQuota.used, cap: imageQuota.cap });
    return { allowed: true, limit: null };
  }

  /**
   * A diary post's last step, once it reached the chat: the post recorded in
   * diary.json (store.appendDiaryPost, the newest `diary.historyPosts` (150)
   * kept) with its gist and its picture's scene cut to `diary.gistChars` (200),
   * its message ids and its search query; the day's diary post counted and,
   * when the picture was posted, the day's diary picture. A set post (`set`)
   * records the scene of its first picture posted with `pictures`, the count
   * posted; its pictures were counted when they were generated. Settings come
   * from `config`, the turn's live config. Returns the outcome's `diary` field
   * (`pictures`: the pictures posted).
   */
  function recordDiaryPost({ config, guildId, now, plan, parsed, acted, set = false }) {
    const diaryCfg = config.diary ?? {};
    const gistChars = diaryCfg.gistChars ?? 200;
    const texts = Array.isArray(acted.texts) ? acted.texts : [];
    const drew = acted.drew === true;
    const pictures = set ? (acted.setPictures ?? 0) : drew ? 1 : 0;
    const scene = set ? acted.setScene : parsed.draw?.text;
    if (typeof store.appendDiaryPost === 'function') {
      store.appendDiaryPost(
        guildId,
        {
          at: now,
          kind: plan.kind,
          gist: gistOf(texts.join(' '), gistChars),
          picture: drew && typeof scene === 'string' ? gistOf(scene, gistChars) : null,
          ...(set ? { pictures } : {}),
          messageIds: Array.isArray(acted.messageIds) ? acted.messageIds : [],
          search: plan.search || null,
        },
        { max: diaryCfg.historyPosts ?? 150 },
      );
    }
    bumpDaily(store.state.data, DIARY_DAILY, now);
    if (drew && !set) bumpDaily(store.state.data, DIARY_PICTURES_DAILY, now);
    store.state.markDirty();
    return { kind: plan.kind, picture: drew, search: Boolean(plan.search), messages: texts.length, pictures };
  }

  /**
   * The other channels a server turn shows in `<channel_view>`, each fetched
   * by fetchPull, in the order of src/behavior/pull.js#pullTargets: the
   * turn's `source` first and alone -- a turn about it does not go on
   * without it, so nothing else is fetched when it fails -- then the explicit
   * `<#id>` mentions of the trigger and of the last `context.pull.scanMessages`
   * messages, then the route hook's ids (routeIds; asked only with
   * features.channelPull on, not on a drawFailed turn, and while a slot is
   * left; on a routed turn it reads the source's lines; a pick marked
   * `earlier` fetches the page before the oldest line of the last view of that
   * channel shown here, pullViews within `context.pull.seenTtlMinutes`, else
   * the newest page -- the source itself is never paged back), at most
   * `context.pull.maxChannels` in all. features.channelPull off: the source
   * alone. Without `labelled` (no `labels.pull.header`: buildRequest renders
   * no `<channel_view>`) the source alone too, with no fresh caption, and one
   * `pull: skipped` (`reason: 'no-label'`) when the turn had a source, a
   * mention or a route hook to ask. Every candidate is judged once, without a
   * request, by the rails fetchPull checks first (checkPull); a refused one
   * logs `pull: skipped` (`channel`, `source` = its id, `reason` = the skip
   * code, `pullReason` = `mention` or `route`), one whose check throws logs
   * `pull: failed` and is not pulled. Every pull reads the ring of calls
   * (`state.json` `elsewherePings`) for its ping marks. Fresh captions only
   * with `certain` (no chooser can still end the turn as not-now), never on a
   * drawFailed turn. Settings come from `config`, the turn's live config.
   * `candidate` (default: the trigger) is what the route hook judges: on a
   * turn answering one part of a split message, the trigger with that part's text.
   * A private chat with its `partner` (privatePartner) pulls the same way from
   * `guild`, the served guild, every rail judged against the partner instead of
   * an audience (checkPull: their View Channel on the candidate); it has no
   * source. `routePlan` (the turn planner's route step, runTurnAttempt; null
   * without features.turnPlanner): `({ lines, routed }) => Promise<{ id,
   * direction }[]>`, asked where the route hook would be, instead of it.
   * @returns {Promise<{ pulled: object[], sourceSkip: string|null }>}  The PulledChannel records,
   *   source first; `sourceSkip` is the skip code of a source that could not be pulled.
   */
  async function pullChannels({ channel, guildId, guild = channel.guild, partner = null, history, trigger, candidate = trigger, triggerKind = null, source, selfId, selfName, config, now, certain, drawFailure, labelled, routePlan = null }) {
    const settings = pullSettings(config);
    const channelPull = channelPullOn(config) && labelled;
    // Every candidate judged once: its skip code (null = pullable) and why it was a candidate.
    const judged = new Map();
    let judging = 'mention';
    const judge = (id) => {
      try {
        return checkPull({ guild, channelId: id, destination: channel, partner, config, now }).skip;
      } catch (err) {
        log.warn('pull: failed', { channel: channel.id, source: id, pullReason: judging, error: err });
        return 'error';
      }
    };
    const isPullable = (id) => {
      if (!judged.has(id)) judged.set(id, { skip: judge(id), pullReason: judging });
      return judged.get(id).skip === null;
    };
    const targetsWith = (extra, { pullable = isPullable, more = channelPull } = {}) =>
      pullTargets({
        source,
        history,
        trigger,
        extra,
        currentChannelId: channel.id,
        scanMessages: settings.scanMessages,
        maxChannels: settings.maxChannels,
        isPullable: pullable,
        channelPull: more,
      });
    const logRefused = () => {
      for (const [id, { skip, pullReason }] of judged) {
        // A check that threw was logged as `pull: failed` already.
        if (skip && skip !== 'error') log.info('pull: skipped', { channel: channel.id, source: id, reason: skip, pullReason });
      }
    };
    if (!labelled) {
      // What the turn would have pulled with the label (unjudged: no check is wasted on it).
      const wanted = targetsWith([], { pullable: () => true, more: channelPullOn(config) });
      const hookWanted = typeof routeChannels === 'function' && channelPullOn(config) && !drawFailure && wanted.length < settings.maxChannels;
      if (wanted.length > 0 || hookWanted) log.info('pull: skipped', { channel: channel.id, reason: 'no-label' });
    }
    const pings = store.state.data.elsewherePings ?? [];
    // The route hook's channels asked for the page before their last view here.
    const earlierIds = new Set();
    const pageOf = (channelId) => {
      if (!earlierIds.has(channelId)) return {};
      const previous = pullViews.previous(channel.id, channelId, { now, ttlMinutes: settings.seenTtlMinutes });
      return { direction: 'earlier', beforeId: previous?.oldestId ?? null };
    };
    const pullOne = (target) =>
      pullSafely({
        guild,
        guildId,
        channelId: target.channelId,
        destination: channel,
        partner,
        reason: target.reason,
        trigger: target.reason === 'routed' ? trigger : null,
        ...pageOf(target.channelId),
        pings,
        config,
        selfId,
        now,
        describer: describer ?? null,
        turnCertain: certain && !drawFailure && labelled,
      });

    let targets = targetsWith([]);
    const sourceTarget = source ? (targets.find((target) => target.channelId === source.channelId) ?? null) : null;
    let sourcePulled = null;
    if (sourceTarget) {
      const result = await pullOne(sourceTarget);
      if (!result.pulled) {
        logRefused();
        return { pulled: [], sourceSkip: result.skip };
      }
      sourcePulled = result.pulled;
    }
    if ((routePlan || typeof routeChannels === 'function') && channelPull && !drawFailure && targets.length < settings.maxChannels) {
      const routedLines = source?.reason === 'routed' ? sourcePulled?.messages : null;
      // With the turn planner its channel block stands in for the route hook (never both).
      const picks = routePlan
        ? await routePlan({ lines: routedLines ?? history, routed: routedLines ? sourcePulled : null })
        : await routeIds({ guildId, channel, guild, partner, history: routedLines ?? history, trigger: candidate, triggerKind, selfName, config });
      judging = 'route';
      for (const pick of picks) if (pick.direction === 'earlier' && pick.id !== sourceTarget?.channelId) earlierIds.add(pick.id);
      if (picks.length > 0) targets = targetsWith(picks.map((pick) => pick.id));
    }
    const fetched = await Promise.all(targets.filter((target) => target.channelId !== sourceTarget?.channelId).map(pullOne));
    logRefused();
    return { pulled: [sourcePulled, ...fetched.map((result) => result.pulled)].filter(Boolean), sourceSkip: null };
  }

  /**
   * Fresh captions (interfaces/discord/pull-fetch.js#captionPulled) for channels
   * pulled before a chooser, once the turn is certain to run; only with
   * features.mediaDescriptions on and a describer. Never rejects: a channel
   * whose captions fail keeps the cached ones (`pull: captions failed`).
   */
  function captionAll(pulled, { guildId, config, destination }) {
    if (pulled.length === 0 || config.features?.mediaDescriptions !== true || !describer) return Promise.resolve(pulled);
    return Promise.all(
      pulled.map((entry) =>
        captionPulled(entry, { describer, guildId, config, destination }).catch((err) => {
          log.warn('pull: captions failed', { channel: destination.id, source: entry.channelId, error: err });
          return entry;
        }),
      ),
    );
  }

  /**
   * The pulled records with the last view of each shown in `destinationId`
   * (pullViews, within `context.pull.seenTtlMinutes` read now) as `seenBefore`,
   * new objects; a record without one is passed as it is. buildRequest reads
   * features.pullSeenMarker itself.
   * @param {object[]} pulled  The PulledChannel records.
   * @param {string} destinationId  The channel the turn speaks in.
   * @param {number} at  The turn's clock.
   * @returns {object[]}
   */
  function withSeenBefore(pulled, destinationId, at) {
    const { seenTtlMinutes } = pullSettings(hot.config);
    return pulled.map((entry) => {
      const seenBefore = pullViews.previous(destinationId, entry.channelId, { now: at, ttlMinutes: seenTtlMinutes });
      return seenBefore ? { ...entry, seenBefore } : entry;
    });
  }

  /**
   * Move the seen mark of each pulled channel whose block the request showed
   * (buildRequest's `pulledKept`) to the newest line shown, in `state.json`
   * `elsewhereSeen` (src/behavior/elsewhere.js#markSeen: never backwards). The
   * caller marks the state dirty.
   * @param {{ channelId: string, newestTs: number }[]} shown
   */
  function markPulledSeen(shown) {
    if (shown.length === 0) return;
    let seen = store.state.data.elsewhereSeen;
    for (const { channelId, newestTs } of shown) seen = markSeen(seen, channelId, newestTs);
    store.state.data.elsewhereSeen = seen;
  }

  /**
   * What a turn that spoke had in view (spokeAfterSeeing): this channel's
   * history under this channel, and the lines shown of each pulled channel
   * the bot cannot write in under that channel -- a call there is answered
   * here, so one queued meanwhile and already shown is not answered twice. A
   * pulled channel the bot can write in keeps its own record: a call written
   * there is answered there, not by being shown here. The calls the request
   * named as still waiting for their own turn (`deferred`: the author's queued
   * calls under `labels.task.queued` or a part's `{others}`) are left out: in
   * view, yet deliberately not answered by this turn.
   * @param {object} channel
   * @param {object[]} history
   * @param {{ channelId: string, ids: string[] }[]} shown  buildRequest's `pulledKept`.
   * @param {object[]} pulled  The PulledChannel records (their `readOnly`).
   * @param {Set<string>} [deferred]
   */
  function noteSpokeSaw(channel, history, shown, pulled, deferred = new Set()) {
    spokeSaw.set(channel.id, new Set(history.map((m) => m.id).filter((id) => !deferred.has(id))));
    const readOnly = readOnlyIdsOf(pulled);
    for (const { channelId, ids } of shown) {
      if (readOnly.has(channelId)) spokeSaw.set(channelId, new Set(ids));
    }
  }

  /** The ids of the pulled channels (PulledChannel records) the bot cannot write in. */
  function readOnlyIdsOf(pulled) {
    return new Set(pulled.filter((entry) => entry.readOnly === true).map((entry) => entry.channelId));
  }

  /**
   * The ring of calls (`state.json` `elsewherePings`, read by every later
   * pull) after a turn that reached a decision -- it chose silence, or it
   * spoke for real (a dry run that spoke reached nobody and stamps nothing):
   * every call of the ring among the lines it showed of a channel the bot
   * cannot write in (buildRequest's `pulledKept`) is stamped answered when
   * what reached the chat answered it (`answered`, from act), else skipped --
   * it was in view, so no later pull presents it as waiting for an answer
   * (src/behavior/elsewhere.js#stampPings: an answer wins over a skip, a stamp
   * never moves). A pulled channel the bot can write in is left alone (a call
   * there is answered there), and so is `exceptId`: a routed turn's own call,
   * which its caller (src/behavior/pipeline.js) stamps by the turn's outcome.
   * Nothing changes while paused (the owner may be editing data/). Each call
   * whose state changed logs `elsewhere: marked`; the state is marked dirty
   * once.
   * @param {{ shown: { channelId: string, ids: string[] }[], pulled: object[], answered: Set<string>,
   *   exceptId: string|null }} args
   */
  function stampShownCalls({ shown, pulled, answered, exceptId }) {
    const readOnly = readOnlyIdsOf(pulled);
    const stamps = shown
      .filter(({ channelId }) => readOnly.has(channelId))
      .flatMap(({ ids }) => ids.filter((id) => id !== exceptId).map((id) => ({ messageId: id, status: answered.has(id) ? 'answered' : 'skipped' })));
    const data = store.state.data;
    if (stamps.length === 0 || data.paused || !Array.isArray(data.elsewherePings)) return;
    const { ring, marked } = stampPings(data.elsewherePings, stamps, clock());
    if (marked.length === 0) return;
    data.elsewherePings = ring;
    store.state.markDirty();
    for (const { messageId, channelId, status } of marked) log.info('elsewhere: marked', { source: channelId, message: messageId, status });
  }

  /**
   * @param {object} params
   * @param {import('discord.js').TextBasedChannel} params.channel
   * @param {string} [params.guildId]  The served guild, used when `channel` has no guild (a
   *   private chat); a server channel always uses its own guild. Neither -> throws.
   * @param {'reply'|'interject'|'initiate'|'auto'|'diary'|'inner'} params.mode  'auto' lets `chooseMode` pick
   *   between interject/initiate/nothing once the history is known (spontaneous turns); 'inner'
   *   is an inner turn (with `params.inner`).
   * @param {{ wake: object, shadow: boolean, mayAct?: () => boolean, currentChannel?: string|null }|null} [params.inner]  An inner turn (src/behavior/inner.js,
   *   docs/inner-life.md), with `mode: 'inner'` and no trigger: nobody's message is fabricated; its
   *   request carries `<wake>` (src/behavior/wake.js over `wake`) and the task `prompts.inner`, its
   *   history is the last `innerLife.chatMessages` lines of `channel`, its prefetch searches the
   *   purposes of the intentions it woke for, no planner runs. What she writes in tags (a `<msg>`,
   *   a `<gif>`, a `<draw>`, a `<react to>`) is lowered into the calls they stand for, in the current channel
   *   (`currentChannel`: an id, or null for none, then a post is refused `destination-required`;
   *   absent: the turn's own channel; src/behavior/inner-output.js) and planned before her own; her calls pass
   *   the gateway as her own initiative (her grants alone) and then innerVerdict: a read runs; with
   *   `shadow` anything else is only proposed (journalled with `shadow: true`, never run, no call
   *   mark, nothing marked seen); live, `mayAct()` is asked right before each one (the kill switch)
   *   (no count of posts refuses one). An answer with no action ends
   *   `skip` with `reason: 'nothing-to-do'`; after a post that left nothing to show while an intention she woke for is
   *   still untouched, the tool loop makes one open follow-up step (toolLoop: `task.continueInner` with the open line,
   *   once per turn). The last loop step still runs one terminal action call of hers (a post, an
   *   intention change; loopStep). The tool loop of an inner turn runs under `innerLife.loop`
   *   (loopSettings with `inner`), not `skills.loop`. The result carries `inner: { actions, intentIds, loop,
   *   openFollowUp?, turnId, episode }` (`openFollowUp: true` when that
   *   step was made; `shadow: true` in shadow mode; `episode`: innerEpisodeOf's, for her memory). A
   *   call that did not work in shadow mode is marked for the rest of the turn only (`turnMarks`).
   * @param {object} [params.trigger]      Normalized message the turn answers (a call, or an
   *   overheard line).
   * @param {TriggerKind} [params.triggerKind]
   * @param {(history: object[], now: number, context: { pulled: object[] }) => string|null} [params.chooseMode]
   *   Called with this channel's history and the channels already pulled for the turn (the
   *   PulledChannel records of interfaces/discord/pull-fetch.js, the source first).
   * @param {{ channelId: string, reason: 'routed'|'noticed' }|null} [params.source]  The channel
   *   this turn is about when it is not `channel` (a call from a channel the bot cannot write in,
   *   a noticed comment): pulled before anything else and shown in `<channel_view>`. When it
   *   cannot be pulled a routed turn ends in `error` (`turn: source unavailable`), a noticed one
   *   in `not-now`. `channel` is where the words go and the one marked busy; the first post
   *   links to the routed call, or to the newest line of the source shown (none when the budget
   *   dropped its block). The drawFailed turn after a failed picture keeps it.
   * @param {object|null} [params.focus]  A normalized message of this chat put to everyone present
   *   (a room question): buildRequest appends `labels.room.focus` to the task.
   * @param {boolean} [params.forced]  True for a turn someone asked for (`/nep message create`; was `/nep interject`, `/nep
   *   initiate`) -- passed straight through to buildRequest, which appends prompts.forced (when
   *   present) to the task text so the model knows `<skip/>` is not the expected outcome this time.
   * @param {(() => { id: string, text: string, author?: string }[])|null} [params.queued]  The calls
   *   still waiting in the queue in this channel (src/behavior/pipeline.js), read when the request is
   *   built: the trigger author's own (no `author`) named under `labels.task.queued` (on a part, in
   *   `labels.task.part`'s `{others}`), another member's (`author`: their display name) under
   *   `labels.task.queuedOthers`, so the persona leaves them to their own turns; a call so named is
   *   not counted as answered by this turn (spokeAfterSeeing). Without its label a call is not
   *   named and the old rule holds for it.
   * @param {{ id: string, text: string, ts: number }[]|null} [params.added]  Later messages of the
   *   author folded into this call (src/behavior/pipeline.js): `labels.task.added` names them.
   * @param {{ author: string, text: string }[]|null} [params.missed]  A recovery turn's messages
   *   (trigger kind `missed`, src/behavior/missed.js), the trigger first: `labels.task.missed`
   *   names them.
   * @param {{ id: string, roleIds?: string[] }|null} [params.requester]  The person who asked for
   *   this turn when it is not the trigger's author (`/nep message create`, src/ops/message.js):
   *   the requester of any skill call she makes in it (callEnvelope).
   * @param {(() => boolean)|null} [params.stillDue]  Asked right before anything is posted (dry
   *   run included); false ends the turn `not-now` (`reason: 'answered-meanwhile'`), nothing posted.
   * @param {{ kind?: string|null, topic?: string|null, forced?: boolean }|null} [params.diary]  With `mode: 'diary'`
   *   (src/behavior/diary.js, in the diary channel, no trigger): the post is planned first
   *   (prepareDiary: the plan request, then the search it asks for; `kind` forces the kind --
   *   a picture kind while the post may not carry a picture is refused before any request,
   *   `{ outcome: 'refused', reason: 'pictures', limit }`, diaryPictureGate --
   *   `topic` is the owner's topic for the planner and the plan, `forced` also appends
   *   prompts.forced to the task), then composed with `prompts.diary` as
   *   the task and the `<world>`, `<diary>`, `<plan>` and `<found>` blocks. Its output keeps only
   *   `<msg>` (every reply attribute dropped, links removed, at most `diary.maxMessages` (3), a
   *   message left empty not posted), `<draw>` (only while the plan's picture check allowed it)
   *   and `<skip/>`; no reaction, no GIF, no GIF pick. A planned kind in `diary.setKinds` is a
   *   set post: the first `diary.set.pictures[1]` `<draw>` tags are generated (generateSet)
   *   before anything is sent and counted against the day's diary pictures; fewer than
   *   `diary.set.minPosted` and nothing is posted (`turn: set short`, `{ outcome: 'refused',
   *   reason: 'set-short' }`), else the messages go as usual and the pictures after them as
   *   files (act's `set`). A post that reached the chat is recorded (recordDiaryPost) and its
   *   outcome carries `diary: { kind, picture, search, messages, pictures }`; a dry run records
   *   nothing. A failed picture is only logged: nobody asked for it.
   *
   * A private chat (`channel` without a guild) works like a server turn on behalf of its partner
   * (the trigger's author, fetched as a member of the served guild: privatePartner) with
   * features.privateLikeServer on (a missing key counts as on): the explicit `<#id>` mentions and
   * the route hook's ids are pulled from the served guild when the partner has View Channel on
   * them (checkPull), and the search classifier may ask for the server search (recall), its hits
   * judged by the same rule. It never has neighbours, a source or a focus, and the channels it
   * shows move no seen mark, stamp no call of the ring and count for no pending ping there: the
   * persona answered in private, not on the server. The switch off, or no partner: no pull, no
   * route hook, no server search, as before.
   * @returns {Promise<{ outcome: TurnOutcome, mode?: string, dryRun?: boolean, drawFailed?: string,
   *   delivered?: boolean, reason?: string, limit?: { key: string, used: number, cap: number }|null }>}
   *   `drawFailed` (the reason) when the persona's picture could not be posted; `delivered` on a
   *   `spoke` turn posted for real: whether anything reached the chat (a reaction put, a message,
   *   the GIF or the picture posted -- by the drawFailed turn too; a send that fails stops the
   *   posting and the turn still ends `spoke` with what reached the chat); `limit` on `outcome:
   *   'refused'` (a request or token cap; a diary picture gate with `reason: 'pictures'`; a diary
   *   set short of `diary.set.minPosted` pictures has `reason: 'set-short'` and no `limit`), for
   *   the caller's limit notice. An answer of hers cut off at its output cap before any complete
   *   action (cutOffOf; the skill follow-up's too, when nothing of the turn reached the chat)
   *   ends `error` with `reason: 'cut-off'`, nothing of it posted. With the journal on (createTurnRunner's `journal`), a turn that
   *   started there carries its `turnId` and `attemptId` (not a message answered part by part,
   *   whose parts are journalled each as its own turn). A `skip`, or a `spoke`
   *   turn posted for real, stamps the calls of the ring it showed (stampShownCalls) -- every
   *   one but a routed turn's own call, which the caller stamps by this outcome.
   */
  async function runTurn(params) {
    // Every attempt that started in the journal (runTurnOnce), closed here, at the one exit.
    const attempts = [];
    // What every attempt posted in reply to and why it ended (runTurnOnce), for the end hook.
    const ends = { replyTargets: [], reasons: [], factsShown: null };
    const tracked = { ...params, journalAttempts: attempts, turnEnds: ends };
    let result;
    let thrown = null;
    try {
      const first = await runTurnOnce({ ...tracked, maySplit: true });
      result = first.outcome === 'split' ? await runChain(tracked, first) : await answerDrawFailure(tracked, first);
      return result;
    } catch (err) {
      thrown = err;
      throw err;
    } finally {
      noteFailedTurn(params, result, ends, thrown);
      if (attempts.length > 0) await writeTurnRecords(attempts);
      noteTurnEnd(params, result, ends);
    }
  }

  /**
   * An addressed reply turn: the facts its request showed, and the failure entry of the very message
   * it answered, are told once a completed answer carried them (any outcome but `error`, `busy`,
   * `paused`); one that ended `error` or `refused` is kept for her next request in the channel
   * (`failedTurn`). Never throws.
   */
  function noteFailedTurn(params, result, ends, thrown) {
    try {
      const { channel, trigger = null, triggerKind = null, mode = null } = params ?? {};
      if (!channel || mode !== 'reply' || !askedFor(trigger, triggerKind) || !trigger?.id) return;
      const guildId = params.guildId ?? channel.guild?.id ?? null;
      const scope = { channelId: String(channel.id), privateChat: !channel.guild };
      const at = clock();
      const outcome = result?.outcome ?? 'error';
      if (outcome !== 'error' && outcome !== 'busy' && outcome !== 'paused') {
        const own = factsOfKind(guildId, scope, 'failedTurn', at).filter((fact) => fact.messageId === String(trigger.id)).map((fact) => fact.id);
        const told = [...(ends.factsShown ?? []), ...own];
        if (told.length > 0) facts().markTold(guildId, told);
      }
      if (outcome !== 'error' && outcome !== 'refused') return;
      const code = typeof result?.reason === 'string' && result.reason ? result.reason : thrown ? errorCodeOf(thrown) : ends.reasons.includes('too-slow') ? 'too-slow' : (outcome === 'refused' ? ends.reasons.at(-1) : null) ?? outcome;
      keepFact(guildId, scope, 'failedTurn', { messageId: String(trigger.id), authorId: trigger.authorId ?? null, code }, at);
    } catch (err) {
      log.warn('turn: failed turn not kept', { error: err });
    }
  }

  /**
   * What an addressed turn lost, as facts for her next request in the conversation: a message that did
   * not go out (`sendFailed`), calls the loop dropped (`loopCut`) and failed calls she never read the
   * result of (`callFailed`). Never throws.
   */
  function recordTurnFacts(args, draft, result) {
    try {
      const channel = args.channel;
      if (!channel || result?.dryRun === true) return;
      const entries = [];
      if (draft.sendFailure) entries.push({ kind: 'sendFailed', ...draft.sendFailure });
      if (draft.loopCut?.dropped > 0) entries.push({ kind: 'loopCut', cut: draft.loopCut.reason, droppedCalls: draft.loopCut.dropped, steps: draft.loopSteps ?? 0 });
      entries.push(...(draft.unseenFailed ?? []));
      if (entries.length === 0) return;
      const guildId = args.guildId ?? channel.guild?.id ?? null;
      const at = clock();
      for (const entry of entries) facts().add(guildId, { ...entry, channelId: String(channel.id), privateChat: !channel.guild, at });
    } catch (err) {
      log.warn('turn: facts not kept', { error: err });
    }
  }

  /**
   * Tell the end hook (setOnTurnEnd; src/behavior/missed.js) how a turn ended, never awaited
   * and never thrown into the turn: its channel and guild, whether it was a private chat or
   * about another channel (`routed`), its trigger (`{ id, authorId, channelId, ts, content }`,
   * in process only) and kind, its outcome (`error` when it threw), its reason (the result's,
   * or `too-slow` for one dropped at its bar), the messages its posts replied to, whether it
   * was a rehearsal and its journal id.
   */
  function noteTurnEnd(params, result, ends) {
    if (typeof onTurnEnd !== 'function') return;
    const { channel, trigger = null, triggerKind = null, mode = null, source = null } = params ?? {};
    const outcome = result?.outcome ?? 'error';
    const reason = typeof result?.reason === 'string' ? result.reason : outcome === 'error' && ends.reasons.includes('too-slow') ? 'too-slow' : null;
    const end = {
      guildId: channel?.guild?.id ?? params?.guildId ?? null,
      channelId: channel?.id ?? null,
      privateChat: !channel?.guild,
      routed: Boolean(source),
      mode,
      trigger: trigger ? { id: trigger.id ?? null, authorId: trigger.authorId ?? null, channelId: trigger.channelId ?? channel?.id ?? null, ts: trigger.ts ?? null, content: trigger.content ?? '' } : null,
      triggerKind,
      outcome,
      reason,
      replyTargets: [...new Set(ends.replyTargets)],
      dryRun: result?.dryRun === true,
      turnId: result?.turnId ?? null,
    };
    Promise.resolve()
      .then(() => onTurnEnd(end))
      .catch((err) => log.warn('turn: onTurnEnd failed', { error: err }));
  }

  /**
   * After a turn whose picture failed (`first.drawFailed`): a failed picture
   * someone asked for gets its own turn, started only once the first one has
   * fully returned (and freed the channel), with the reason in the trigger
   * label; its own <draw> is dropped. The first turn held back its idle
   * notifications (see runTurnOnce's `finally`), so a pending ping is drained
   * only after this second turn -- never raced by it. Nobody asked on a
   * spontaneous or an overheard turn (askedFor, the same predicate as
   * runTurnOnce's hand-off): the failure is only logged. A turn about another
   * channel keeps its source: a routed call is still answered here, with the
   * call shown and linked -- what that turn posts reached the chat for the
   * call too (`delivered`). It posts plain when the first turn did (a
   * follow-up, a later part of a split message: `plainPosts`): it carries that
   * turn's kind. Inside a chain (`owned`) the second turn keeps the chain's
   * attention and leaves the idle notifications to it. Any other `first` comes
   * back as it is.
   */
  async function answerDrawFailure(params, first, { owned = false, plainPosts = false } = {}) {
    if (!first.drawFailed) return first;
    const { channel, guildId, trigger = null, triggerKind = null, source = null } = params;
    if (askedFor(trigger, triggerKind)) {
      try {
        const second = await runTurnOnce({
          channel,
          guildId,
          mode: 'reply',
          trigger,
          triggerKind: 'drawFailed',
          drawReason: first.drawFailed,
          drawFailedAfter: triggerKind,
          source,
          holdIdle: true,
          owned,
          plainPosts,
          // The journal: the same turn, its next attempt.
          journalAttempts: params.journalAttempts,
          turnEnds: params.turnEnds,
          journalTurn: first.turnId ? { turnId: first.turnId, attemptId: (first.attemptId ?? 1) + 1 } : null,
        });
        log.info('turn: draw failure answered', { channel: channel.id, reason: first.drawFailed, outcome: second.outcome });
        if (second.outcome === 'spoke' && second.delivered === true) return { ...first, delivered: true };
      } finally {
        if (!owned) notifyIdle();
      }
    } else {
      log.warn('turn: draw failed', { channel: channel.id, reason: first.drawFailed });
    }
    return first;
  }

  /** Why a chain ends before its next part: `paused` (/nep pause), `warmup` (a warmup run), or null. */
  function chainStop() {
    if (store.state.data.paused) return 'paused';
    try {
      return isWarmingUp() ? 'warmup' : null;
    } catch {
      return null;
    }
  }

  /**
   * A message that holds several requests (the splitter's `parts`), answered
   * part by part: one ordinary turn per part, in order, each with its own
   * deadline and bar. Turn k's helpers (the search classifier, recall, the
   * route hook, the re-watch) judge part k's text instead of the whole
   * message, and its request names the part and the others
   * (buildRequest's `tasks.part`, `labels.task.part`). The first part reuses
   * the history the whole message's turn fetched and replies as any turn
   * does; the later ones fetch it afresh (the earlier answers are in it) and
   * post plain. The persona may answer a part in any way a turn allows,
   * silence included; a part that fails, is dropped at its bar or refused
   * does not stop the next. The attention stays the chain's from the
   * whole message's turn to the end -- nothing else starts in between
   * (pending calls keep queueing) -- and the idle notifications fire once, at
   * the end. A pause or a warmup ends the chain before its next part (`turn:
   * chain stopped`). While it runs, the parts not started yet are the
   * author's waiting items (waitingParts); a later message of the author
   * folded into one of them (addToPart) reaches that part's request as
   * `tasks.added`. Every part logs `turn: part` with its outcome. Resolves one
   * result for the message (chainOutcome).
   */
  async function runChain(params, { parts, history }) {
    const { channel, trigger } = params;
    const total = parts.length;
    const chain = { authorId: trigger?.authorId ?? null, parts, next: 0, added: new Map() };
    chains.set(channel.id, chain);
    const results = [];
    try {
      for (let i = 0; i < total; i += 1) {
        const index = i + 1;
        const stop = i > 0 ? chainStop() : null;
        if (stop) {
          log.info('turn: chain stopped', { channel: channel.id, reason: stop, index, total });
          break;
        }
        // From here on this part is no longer waiting: nothing more is folded into it.
        chain.next = index;
        const plainPosts = i > 0;
        let result;
        try {
          const once = await runTurnOnce({
            ...params,
            owned: true,
            part: { index, total, parts },
            reuseHistory: i === 0 ? history : null,
            // Messages folded into the whole call before it split go with its first part.
            added: [...(i === 0 && Array.isArray(params.added) ? params.added : []), ...(chain.added.get(index) ?? [])],
            plainPosts,
          });
          result = await answerDrawFailure(params, once, { owned: true, plainPosts });
        } catch (err) {
          const code = errorCodeOf(err);
          log.error('turn: failed', { channel: channel.id, code, error: err });
          result = { outcome: 'error', reason: code };
        }
        log.info('turn: part', { channel: channel.id, index, total, outcome: result.outcome });
        results.push(result);
      }
    } finally {
      chains.delete(channel.id);
      busy.delete(channel.id);
      notifyIdle();
    }
    return chainOutcome(results);
  }

  /**
   * One result for a message answered part by part, as its caller counts a
   * turn: `spoke` when any part spoke (`delivered` when anything of any part
   * reached the chat; `dryRun` when every part that spoke was a rehearsal),
   * else the first part's `skip`, else the first part's result (a refusal
   * keeps its `limit`).
   */
  function chainOutcome(results) {
    const spoke = results.filter((result) => result.outcome === 'spoke');
    if (spoke.length > 0) {
      const real = spoke.filter((result) => result.dryRun !== true);
      return {
        outcome: 'spoke',
        mode: spoke[0].mode,
        ...(real.length === 0 ? { dryRun: true } : { delivered: real.some((result) => result.delivered === true) }),
      };
    }
    return results.find((result) => result.outcome === 'skip') ?? results[0] ?? { outcome: 'error' };
  }

  /**
   * Tell whoever waits that a turn has finished: onIdle (fire-and-forget, same
   * as the caller of runTurn itself: whatever wants to run next --
   * src/behavior/pipeline.js's pending-ping drain, wired in src/index.js -- must
   * never hold up, or throw into, the turn that just freed the channel), and
   * the waitIdle() waiters once no turn is in flight anywhere.
   */
  function notifyIdle() {
    if (onIdle) {
      Promise.resolve()
        .then(() => onIdle())
        .catch((err) => log.warn('turn: onIdle failed', { error: err }));
    }
    if (busy.size === 0 && idleWaiters.length > 0) {
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }

  /**
   * One turn, as described on runTurn. Internal for the `drawFailed` turn:
   * `drawReason`, `drawFailedAfter` (the first turn's trigger kind: the
   * second posts plain when the first did, postsPlain), and `holdIdle` --
   * leave the idle notifications to the caller (runTurn fires them once the
   * second turn is over). Internal for a split message: `maySplit` (runTurn's
   * first turn may ask the splitter; parts in time end it with the internal
   * outcome `split`, `{ parts, history }`, still holding the attention for
   * runChain), `owned` (a turn of the chain: the chain holds the attention and
   * fires the idle notifications), `part` (`{ index, total, parts }`: its
   * helpers judge that part's text, its request names it), `reuseHistory` (the
   * first part's history, already fetched) and `plainPosts` (a later part
   * posts plain).
   */
  async function runTurnOnce(args) {
    // `limits`: what bit during this attempt (src/llm/limits.js), for its turn record.
    const draft = { limits: createLimits() };
    let result;
    try {
      result = await runTurnAttempt(args, draft);
    } finally {
      // An attempt whose turn.start was written closes with its turn record at runTurn's exit,
      // whatever it returned (a throw counts as `error`).
      if (draft.started) args.journalAttempts?.push({ draft, result: result ?? { outcome: 'error' } });
      if (args.turnEnds) {
        args.turnEnds.replyTargets.push(...(draft.replyTargets ?? []));
        if (typeof draft.reason === 'string') args.turnEnds.reasons.push(draft.reason);
        if (draft.factsShown) args.turnEnds.factsShown = draft.factsShown;
      }
      // What an addressed turn lost, kept for her next request there (an inner turn's go to the inner life).
      if (!args.inner) recordTurnFacts(args, draft, result);
    }
    // An inner turn reports what it did and proposed, and its turn id (the errands it handed off name it).
    const innerTurnId = draft.started?.turnId ?? draft.turnKey?.turnId ?? null;
    const innerPart = args.inner ? { inner: { actions: draft.innerActions ?? [], intentIds: [...(draft.innerIntentIds ?? [])], loop: draft.innerLoop ?? { ...NO_LOOP }, ...(draft.innerOpenFollowUp === true ? { openFollowUp: true } : {}), turnId: innerTurnId, episode: innerEpisodeOf(args, draft, innerTurnId) }, ...(args.inner.shadow ? { shadow: true } : {}) } : {};
    return draft.started ? { ...result, ...innerPart, turnId: draft.started.turnId, attemptId: draft.started.attemptId } : { ...result, ...innerPart };
  }

  /**
   * What an inner turn (`args.inner`) did and found, for her memory (src/memory/inner-episode.js,
   * src/memory/update.js#observeInner): her thinks, what her reads found (`draft.innerFindings`:
   * skill, arguments, result text), her other calls with how each went, where it happened and
   * whether it was shadow. Null when the turn found nothing and has nothing to answer for (no
   * read found anything, no call other than a read, every call ended ok,
   * no loop cut: the scheduler's feedback facts ride this episode, src/behavior/inner.js),
   * or for a private chat whose partner is unknown (a private finding never goes to the server's
   * memory). No wording here.
   */
  function innerEpisodeOf(args, draft, turnId) {
    const findings = Array.isArray(draft.innerFindings) ? draft.innerFindings : [];
    const channel = args.channel;
    if (!args.inner || !channel) return null;
    const registry = skills ?? defaultSkills();
    const accountable = (draft.innerActions ?? []).some((action) => action.status !== 'executed' || action.result !== 'ok' || registry.get(action.skill)?.effects !== 'read');
    if (findings.length === 0 && !accountable && !draft.loopCut) return null;
    const privateChat = !channel.guild;
    const privateUserId = privateChat ? (draft.privateUserId ?? channel.recipientId ?? null) : null;
    if (privateChat && !privateUserId) return null;
    const guildId = args.guildId ?? channel.guild?.id ?? null;
    let selfName = null;
    try {
      selfName = guildId ? getSelfName(guildId) : null;
    } catch {
      selfName = null;
    }
    return {
      turnId: turnId ?? null,
      at: clock(),
      shadow: args.inner.shadow === true,
      channelId: String(channel.id),
      channelName: typeof channel.name === 'string' ? channel.name : null,
      privateUserId: privateUserId ? String(privateUserId) : null,
      selfId: client?.user?.id ?? null,
      selfName,
      thinks: Array.isArray(draft.innerThinks) ? [...draft.innerThinks] : [],
      findings: findings.map((finding) => ({ ...finding })),
      actions: (draft.innerActions ?? []).filter((action) => registry.get(action.skill)?.effects !== 'read').map((action) => ({ skill: action.skill, status: action.status, ...(action.delivery ? { delivery: true } : {}) })),
    };
  }

  /** runTurnOnce's body; `draft` collects what the journal's turn record needs (journalTurnRecord). */
  async function runTurnAttempt({
    channel,
    guildId: guildIdParam = null,
    mode,
    trigger = null,
    triggerKind = null,
    chooseMode = null,
    forced = false,
    source = null,
    focus = null,
    drawReason = null,
    drawFailedAfter = null,
    holdIdle = false,
    queued = null,
    added = null,
    maySplit = false,
    owned = false,
    part = null,
    reuseHistory = null,
    plainPosts = false,
    diary: diaryParams = null,
    journalTurn = null,
    missed = null,
    stillDue = null,
    requester: requesterParam = null,
    taskResult = null,
    inner = null,
  }, draft = {}) {
    // A server channel carries its guild; a private chat is served on behalf of the pinned one.
    const guildId = channel.guild?.id ?? guildIdParam;
    if (!guildId) throw new Error('runTurn: a channel without a guild needs a guildId');
    // The journal's preparation steps of this attempt (createPrepLedger): each an operation of
    // the engine, closed with whether its result reached the request.
    const prep = createPrepLedger();
    const prepStep = (stage, name, fields, offeredOf) => {
      const op = journalOp(draft, name, 'engine', fields);
      return op.opId ? prep.step(stage, op, offeredOf) : null;
    };
    const isPrivate = !channel.guild;
    // An inner turn (mode `inner`, src/behavior/inner.js): her calls pass its gate (innerVerdict).
    if (inner && mode === 'inner') draft.inner = inner;
    // The turn a finished errand of her own opens (asked in an inner turn: requester kind
    // `persona`, no person behind it) is her own initiative too: her grants alone decide her calls.
    if (taskResult?.requester?.kind === 'persona' && !taskResult.requester.userId) draft.ownInitiative = true;
    // Set when this turn hands off to a drawFailed turn: runTurn notifies after it.
    let handOff = false;
    // Set when this turn hands its message to a chain of parts: the chain keeps the attention.
    let chained = false;
    // /nep pause: the owner is editing data/ by hand -- no new turn may
    // start (a reply, an interject, an initiate, an eavesdrop, or a forced turn)
    // until /nep resume. A turn already in flight when the pause is
    // requested is left to finish naturally; admin.js's pause handler waits
    // for it via waitIdle() below instead of aborting it here.
    if (store.state.data.paused) return { outcome: 'paused' };
    // A turn of a chain runs under the attention the chain already holds.
    if (!owned) {
      if (busy.has(channel.id)) return { outcome: 'busy' };
      // One attention (config.mention.oneAtATime, default on): while a turn is
      // running anywhere else, nothing else may start. src/behavior/pipeline.js
      // is the only caller that turns a direct ping caught by this into a
      // pending one instead of just dropping it -- this rail applies to every
      // caller (a reply, an interject, an initiate, an eavesdrop) alike.
      const oneAtATime = hot.config.mention?.oneAtATime !== false;
      if (oneAtATime && busy.size > 0) return { outcome: 'busy' };
      busy.add(channel.id);
    }
    // The journal (features.journal, read now): the turn starts here, past the pause and
    // attention rails; a later attempt of the same turn (journalTurn) keeps its id.
    if (journalOn()) {
      draft.guildId = guildId;
      draft.channelId = channel.id;
      draft.privateUserId = isPrivate ? (trigger?.authorId ?? channel.recipientId ?? null) : null;
      draft.mode = mode;
      draft.started = journal.start(guildId, {
        channelId: channel.id,
        mode: journalMode(mode, triggerKind),
        trigger: trigger ? { kind: triggerKind ?? null, messageId: trigger.id ?? null, authorId: trigger.authorId ?? null } : draft.inner ? { kind: 'inner', messageId: null, authorId: null, wake: draft.inner.wake?.kind ?? null } : null,
        participants: trigger?.authorId ? [trigger.authorId] : [],
        sourceMessageIds: trigger?.id ? [trigger.id] : [],
        privateUserId: draft.privateUserId,
        turnId: journalTurn?.turnId ?? null,
        attemptId: journalTurn?.attemptId ?? null,
      });
    }
    // A turn answering a person first lets them finish writing (pace.settleMs), holding the
    // attention meanwhile; the turn's clocks (its deadline, its bar) start after this wait. The
    // first part of a split message reuses the history its message already waited for. The
    // author's activity is read in the trigger's own channel (a routed call's turn posts elsewhere).
    const settledMs = mode === 'reply' && !reuseHistory ? await settleAuthor(trigger?.channelId ?? channel.id, trigger) : 0;
    // The typing indicator, the preparation's deadline and the turn's bar, ended in `finally`
    // whatever the outcome; the start and the mode a dropped turn logs.
    let stopTyping = () => {};
    let deadline = null;
    let bar = null;
    // The attempt's turn planner (createTurnPlan), abandoned in `finally` if it never started.
    let planner = null;
    const turnStartedAt = clock();
    let turnMode = mode;
    try {
      const config = hot.config;
      const features = config.features ?? {};
      const memoryOn = features.memory !== false;
      const selfId = client.user.id;
      const selfName = getSelfName(guildId);
      const now = turnStartedAt;
      const startedAt = now;
      // A forced diary picture kind (/nep diary post <kind>) while the post may not carry a
      // picture is refused before any request, naming the gate that closed (diaryPictureGate).
      if (mode === 'diary' && typeof diaryParams?.kind === 'string' && isPictureKind(diaryParams.kind, config.diary?.pictureKinds)) {
        const gate = diaryPictureGate(config, channel, now);
        if (!gate.allowed) return { outcome: 'refused', reason: 'pictures', limit: gate.limit };
      }
      // The turn's pace. A turn nobody waits for (unhurried: a spontaneous or an overheard one,
      // with pace.unpromptedWaits on) has neither the bar nor the preparation's deadline below.
      const pace = paceSettings(config);
      const waitsForAll = unhurried(triggerKind, pace);
      // The bar (pace.dropAfterMs, from the turn's start; a drawFailed turn has its own): the
      // answer must be in hand by then, or the turn is dropped unposted. At the bar every wait
      // below gives up (beforeBar throws TOO_SLOW), the typing indicator stops, and the reply
      // request is aborted -- its client sends no retry once its signal is aborted.
      bar = createDeadline({ clock, startedAt, schedule, limitMs: waitsForAll ? null : pace.dropAfterMs });
      const barAbort = new AbortController();
      bar.reached.then(() => {
        stopTyping();
        barAbort.abort();
      });
      const beforeBar = (promise) =>
        bar.leftMs() === null
          ? promise
          : Promise.race([
              promise,
              bar.reached.then(() => {
                throw TOO_SLOW;
              }),
            ]);
      // The reply request's options (role `core`, purpose `reply`): with a bar, each attempt's
      // timeout is the smaller of llm.timeoutMs (read now) and the time left, and the bar's
      // signal aborts it; nothing is asked once no time is left. With a bar the request is also
      // hedged (pace.replyHedgeMs, read now): no answer by then, a second identical request is
      // sent and the first answer wins, the whole call still cut at the same timeout.
      const replyOptions = () => {
        // A journalled attempt's reply request tells its collector what it hit (src/llm/openrouter.js#complete).
        const journalLimits = draft.started ? { limits: draft.limits } : {};
        const left = bar.leftMs();
        if (left === null) return { ...REPLY_REQUEST, ...journalLimits };
        if (left <= 0) throw TOO_SLOW;
        const configured = hot.config.llm?.timeoutMs;
        const timeoutMs = Number.isFinite(configured) && configured > 0 ? Math.min(configured, left) : left;
        const hedgeMs = paceSettings(hot.config).replyHedgeMs;
        const hedge = hedgeMs !== null && hedgeMs < timeoutMs ? { hedge: { afterMs: hedgeMs, timeoutMs } } : {};
        return { ...REPLY_REQUEST, timeoutMs, signal: barAbort.signal, ...hedge, ...journalLimits };
      };
      // A drawFailed turn only says the picture failed: no classifier is paid for a second time.
      const answersDrawFailure = triggerKind === 'drawFailed';
      // Someone asked for this turn (askedFor): not a spontaneous or an overheard one.
      const asked = askedFor(trigger, triggerKind);
      // A turn a returned errand opened answers with its result: the engine's own search
      // (the classifier, the planner's lookup block) is not run on the original request, so no
      // <lookup> block stands beside the result. Her own recall call still runs.
      const answersTask = triggerKind === 'task';
      // features.coreTools (read now): she calls her own tools in the turn, so no search classifier
      // (nor the planner's lookup or skills block) runs before her reply; `<skills_tools>` shows them.
      const coreTools = coreToolsOn(config);
      // Skills discovery: the `skills:` line of the search classifier or the planner (parseSkillsLines).
      let skillsAnswer = null;
      // A direct call sees the persona typing while the turn prepares.
      stopTyping = typingWhilePreparing(channel, triggerKind, config);

      // A private chat's partner as a guild member (features.privateLikeServer), fetched beside
      // the history; null on a server turn, with the switch off or when the fetch fails.
      const partnerPending = isPrivate
        ? privatePartner({ guildId, userId: trigger?.authorId ?? channel.recipientId ?? null, config })
        : Promise.resolve(null);
      const historyStartedAt = clock();
      // The first part of a split message reuses the history its message's turn fetched.
      // Part of the history: the messages replies of the window answer from outside it
      // (context.fetchReplyParents), prepended as its oldest lines (withReplyParents). The
      // persona's own lines carry the message that started their turn (linkTriggers) and the
      // skill calls she made (linkCalls), so the request and every helper transcript built from
      // this history name them.
      const rawHistory = linkCalls(
        linkTriggers(
          reuseHistory ??
            (await beforeBar(
              fetchHistory(channel, historyOptions(config, Boolean(draft.inner))).then((lines) => withReplyParents(channel, lines, { trigger, selfId, config, discord })),
            )),
        ),
        { channel, guildId },
      );
      const historyMs = clock() - historyStartedAt;
      const partner = await beforeBar(partnerPending);
      // A private chat on its partner's behalf: pulls and the server search from the served guild.
      const likeServer = isPrivate && partner !== null;
      const servedGuild = isPrivate ? (likeServer ? (client.guilds?.cache?.get?.(guildId) ?? null) : null) : channel.guild;
      // What the helpers judge: the trigger, or on a part of a split message the trigger with
      // that part's text (same id, author and time).
      const candidate = part && trigger ? { ...trigger, content: part.parts[part.index - 1] ?? trigger.content } : trigger;
      // The history the request is built from: with its file previews once they are ready (below).
      let history = rawHistory;
      // The automatic memory prefetch (features.coreTools with features.memoryPrefetch): started now,
      // alongside the preparation, bounded by its own deadline (startPrefetch).
      const prefetching = startPrefetch({
        config,
        channel,
        guildId,
        guild: servedGuild,
        partner: isPrivate ? partner : null,
        trigger,
        candidate,
        triggerKind,
        mode,
        history: rawHistory,
        selfId,
        selfName,
        nameOf: memoryOn ? (id) => store.getUser(guildId, id)?.names?.[0] ?? null : null,
        journalStep: prepStep,
        wake: draft.inner?.wake ?? null,
      });
      // A diary post plans itself first (prepareDiary), alongside the preparation below; settled
      // into a value or an error so a refusal waits for its turn to be thrown.
      const diaryPending =
        mode === 'diary'
          ? prepareDiary({ config, guildId, channel, selfName, history: rawHistory, now, params: diaryParams, memoryOn, draft }).then(
              (value) => ({ value }),
              (error) => ({ error }),
            )
          : null;

      // The searches this turn may run (maybeLookup): the web search (features.webLookup -- unlike
      // the other switches a missing key counts as OFF: it costs money and the search needs a key)
      // and the server search (a private chat only on its partner's behalf). Asked once, so the
      // lookup stage, the planner's offer and `<senses>` agree.
      const webLookupOn = features.webLookup === true && Boolean(lookup);
      const webSearchOn = webLookupOn && config.web?.search?.enabled !== false && typeof lookup.search === 'function';
      const serverOn = (!isPrivate || likeServer) && recallAvailable();
      // The turn planner (features.turnPlanner exactly true, read now; never on a drawFailed turn,
      // which asks no classifier): one request for the route, the participation pick, the
      // re-watch and the search classifier, none of which is asked then. It starts in the pull's
      // route step on a turn that waits for its pull (a source, or a mode still to choose), else
      // once the file previews are in (below), like the search classifier did.
      planner = plannerOn(config) && !answersDrawFailure && !draft.inner
        ? createTurnPlan({ config, channelId: channel.id, selfName, triggerKind, limits: draft.limits ?? null, early: Boolean(source) || mode === 'auto' })
        : null;
      // The planner's `skills:` line, once it answered (skills discovery, read when the request is built).
      planner?.result.then((plan) => {
        if (!coreTools) skillsAnswer ??= plan?.blocks?.skills ?? null;
      });
      // What the planner is sent: the search classifier's transcript of `lines` (with the captions,
      // video states and page reads given) and candidate, the participation pick's episodes, the
      // re-watch's media (`media`, prepared by the caller) and whether a search could run.
      const plannerStart = ({ lines, descriptions, videos, reads, media = null }) => {
        const judged = routeCandidate(lines, candidate);
        const context = judged
          ? classifierContext({
              config,
              selfName,
              history: lines,
              trigger: judged,
              contextMessages: Math.max(0, Math.floor(config.web?.search?.contextMessages ?? 50)),
              descriptions,
              videos,
              reads,
            })
          : null;
        let episodes = null;
        if (participationOn(channel, config) && mode !== 'diary') {
          try {
            const units = hot.prompts?.labels?.units;
            episodes = participationEpisodeOffer({ store, guildId, channel, audience: participationAudience(channel, config), config, units, selfName, now: clock() });
          } catch (err) {
            log.warn('participation: failed', { channel: channel.id, reason: 'error', status: null, name: err?.name ?? null });
          }
        }
        const lookupWanted = asked && !answersTask && !coreTools && (webSearchOn || serverOn) && lookupGate({ config, webOn: webSearchOn, serverOn }).skip === null;
        planner.start({
          transcriptBlock: context?.transcriptBlock ?? '',
          candidateBlock: judged ? block('candidate', `${judged.authorName}: ${context.triggerText}`) : null,
          episodes,
          media,
          lookup: lookupWanted,
        });
      };
      // The planner's route step (pullChannels' routePlan): this turn's channel list as the route
      // hook would build it (features.channelRoute, routeAllowed, its candidate), then the pick of
      // the planner's channel block, mapped back to its id.
      const routePlan = planner
        ? async ({ lines, routed }) => {
            const settings = routeSettings(config);
            const allowed = channel.guild ? routeAllowed({ triggerKind }) : Boolean(servedGuild && partner) && triggerKind === 'private';
            const judged = routeCandidate(lines, candidate);
            if (settings && allowed && judged) {
              try {
                planner.offerChannels(routeChannelOffer({ store, guildId, channel, guild: servedGuild, partner, candidate: judged, config, settings, now: clock(), discord }));
              } catch (err) {
                log.warn('pull: route failed', { channel: channel.id, error: err });
              }
            }
            if (planner.early) plannerStart({ lines, descriptions: routed?.descriptions });
            const plan = await planner.result;
            const answer = plan.blocks.channel;
            const id = answer.state === 'ok' ? plan.offer.channel?.ids?.[answer.index - 1] : null;
            return typeof id === 'string' && id ? [{ id, direction: answer.direction === 'earlier' ? 'earlier' : null }] : [];
          }
        : null;

      // The other channels this turn shows (`<channel_view>`, pullChannels), found and fetched
      // before the mode is chosen so a chooser sees them. Fresh captions only for a turn certain
      // to run: with the fetch when no chooser can still say not-now, else once it chose
      // (captionAll). A turn about another channel, or one with a chooser, waits for them here;
      // any other turn fetches them alongside the preparation below. A private chat only on its
      // partner's behalf (likeServer), judged against the partner.
      // The block renders only under `labels.pull.header` (read now, as buildRequest reads it):
      // without it no channel is fetched for a mention or the route hook and no fresh caption
      // is paid for; a turn's source is still pulled (its chooser and a routed call's search
      // classifier read it).
      const certain = mode !== 'auto';
      const pullLabelled = Boolean(hot.prompts?.labels?.pull?.header);
      const pullStartedAt = clock();
      const pullsPending = isPrivate && !likeServer
        ? Promise.resolve({ pulled: [], sourceSkip: null })
        : pullChannels({ channel, guildId, guild: servedGuild, partner, history, trigger, candidate, triggerKind, source, selfId, selfName, config, now, certain, drawFailure: answersDrawFailure, labelled: pullLabelled, routePlan })
            // Never fails the turn: anything unexpected is no pull (and no source).
            .catch((err) => {
              log.warn('pull: failed', { channel: channel.id, error: err });
              return { pulled: [], sourceSkip: source ? 'error' : null };
            });
      const early = source || !certain ? await beforeBar(pullsPending) : null;
      if (early?.sourceSkip) {
        // Nothing to answer, or nothing to comment on: the source is gone or refused.
        if (source.reason !== 'routed') return { outcome: 'not-now' };
        log.warn('turn: source unavailable', { channel: channel.id, source: source.channelId, reason: early.sourceSkip });
        return { outcome: 'error' };
      }

      let finalMode = mode;
      if (mode === 'auto') {
        finalMode = chooseMode(history, now, { pulled: early.pulled });
        if (!finalMode) return { outcome: 'not-now' };
      }
      turnMode = finalMode;
      // Ready before the request is built; pulled ahead of a chooser, they get their fresh
      // captions now (only when the block can render).
      const pulledPending = !early
        ? pullsPending.then((pulls) => pulls.pulled)
        : certain || !pullLabelled
          ? Promise.resolve(early.pulled)
          : captionAll(early.pulled, { guildId, config, destination: channel });
      // A routed call lives in its source: the search classifier reads the source's lines around
      // it, with their captions, instead of this chat; the re-watch is not offered (below).
      const routedPull = source?.reason === 'routed' ? (early?.pulled.find((entry) => entry.channelId === source.channelId) ?? null) : null;

      // Everything below starts as soon as its inputs exist and runs alongside the rest; the turn
      // waits for all of it together, at most until the deadline (paceSettings, counted from the
      // turn's start; longer once the search classifier asked for a search -- held for its verdict
      // up to pace.prepareSearchMs while it is out -- or for a direct call that brought media to
      // look at). A stage still running then contributes nothing -- its block
      // is absent, as when it fails -- and keeps running for its cache; nothing it settles later
      // reaches this turn. A stage whose inputs were not ready by then is never started. An
      // unhurried turn has no deadline: it waits for every stage (a
      // search asked for leaves it so: extend never sets a limit on a deadline without one).
      deadline = createDeadline({ clock, startedAt, schedule, limitMs: waitsForAll ? null : pace.prepareMs });
      const stages = new Map();
      const track = (name, work, from = clock()) => {
        const stage = trackStage(work, {
          clock,
          startedAt: from,
          onError: (err) => log.warn('turn: stage failed', { channel: channel.id, stage: name, error: err }),
        });
        stages.set(name, stage);
        return stage;
      };
      // A chain that starts a stage once another settled: never rejects, never fails the turn.
      const chainFailed = (name) => (err) => log.warn('turn: stage failed', { channel: channel.id, stage: name, error: err });

      const prefetchStage = prefetching ? track('prefetch', () => prefetching.pending) : null;

      // Lazy, request-time only (see fetchTextPreview's header comment):
      // never fetched during plain normalization or while just buffered. Read by the
      // transcripts alone: the request's and the two classifiers'.
      const previews = track('previews', () => withTextPreviews(rawHistory, config.media?.filePreviewChars ?? 10000, fetchImpl));
      const previewed = () => (previews.done && Array.isArray(previews.value) ? previews.value : rawHistory);

      // The pictures of the window get a helper's caption, newest first, capped at
      // media.maxPerTurn; cached captions are free (see src/memory/describe.js). The caption is
      // the only way a picture reaches the persona: none goes into her request as an image. A
      // routed call's own pictures are captioned with its pulled channel instead.
      let captions = null;
      let captionCandidates = [];
      if (features.mediaDescriptions === true && describer) {
        captionCandidates = describableCandidates(rawHistory);
        const describeOp = captionCandidates.length > 0 ? prepStep('captions', 'describe', { input: { candidates: captionCandidates.length } }) : null;
        captions = track('captions', () =>
          journalled(describeOp, () => describer.describeMany(guildId, captionCandidates, { maxNew: config.media?.maxPerTurn ?? 6 }), (value) => {
            const count = value?.descriptions?.size ?? 0;
            return { result: { count }, offered: count > 0 };
          }),
        );
      }
      // The captions a classifier's transcript shows: this turn's once they are done, else what
      // the describer's cache holds at the classifier's start (a fresh caption lands there).
      const captionsSoFar = () => {
        if (!captions) return undefined;
        if (captions.done) return captions.value?.descriptions;
        try {
          return typeof describer.cachedDescriptions === 'function' ? describer.cachedDescriptions(guildId, captionCandidates) : undefined;
        } catch {
          return undefined;
        }
      };

      // The splitter (runTurn's first turn only): a call that may hold several requests asks it
      // now, beside everything else and under the same deadline. The turn waits for it as for any
      // stage; parts in time end the wait at once (below). Without prompts.split it is off
      // (`split: skipped`, `no-prompt`); without labels.task.part (an older labels file) it is
      // never asked. A routed call is read in its source, as the search classifier reads it.
      let splitStage = null;
      if (maySplit && !answersDrawFailure && splitCandidate(trigger, triggerKind, config)) {
        const splitPrompt = hot.prompts?.split;
        if (!splitPrompt) {
          log.info('split: skipped', { channel: channel.id, reason: 'no-prompt' });
        } else if (hot.prompts?.labels?.task?.part) {
          const shown = captionsSoFar();
          splitStage = track('split', () =>
            maybeSplit({
              config,
              channelId: channel.id,
              selfName,
              history: routedPull ? routedPull.messages : rawHistory,
              trigger,
              descriptions: routedPull ? new Map([...(shown ?? []), ...routedPull.descriptions]) : shown,
              prompt: splitPrompt,
              isLate: () => deadline.passed,
            }),
          );
        }
      }
      const hasParts = () => Boolean(splitStage?.done) && Array.isArray(splitStage.value);

      // Videos (attached, or linked from a known video site) may be watched
      // by the video describer, newest first, at most media.video.maxPerTurn
      // NEW ones per turn; cached results and limit/error states are free.
      let videoStage = null;
      let rewatchStage = null;
      let rewatchChain = null;
      let videoCandidates = [];
      // Both switches (isVideoVisionOn), like the senses line; a missing videoDescriptions counts as on.
      if (isVideoVisionOn(config) && typeof describer?.describeVideos === 'function') {
        const videoCfg = config.media?.video ?? {};
        for (let i = rawHistory.length - 1; i >= 0; i -= 1) {
          videoCandidates.push(...collectVideos(rawHistory[i], { videoSites: videoCfg.sites }));
        }
        const candidates = videoCandidates;
        const watchOp = candidates.length > 0 ? prepStep('videos', 'watch-video', { input: { candidates: candidates.length } }) : null;
        const watchStartedAt = clock();
        videoStage = track('videos', () =>
          journalled(watchOp, () => describer.describeVideos(guildId, candidates, { maxNew: videoCfg.maxPerTurn ?? 5 }), (value) => {
            const states = value?.videos instanceof Map ? [...value.videos.values()] : [];
            return {
              result: { seconds: Math.round((clock() - watchStartedAt) / 100) / 10, watched: states.filter((state) => state?.state === 'watched').length },
              offered: states.length > 0,
            };
          }),
        );
      }

      // A second look when the trigger asks about a watched video or a posted picture: a
      // direct address only (never a spontaneous or an overheard turn, never the drawFailed
      // turn). Videos under features.videoRewatch (with the video stage), watched GIFs under
      // features.videoRewatch and video vision, pictures under features.imageRelook (a missing
      // key counts as on, each; the look runs through the vision model), the persona's own
      // posted drawings included.
      // A routed call asks about its source, whose media no turn looks at: the media
      // here belong to another conversation, so nothing is offered or retried.
      // It needs the videos' states and its transcript the file previews; it works on a
      // copy of the states, so a late re-watch never touches what the request was built from.
      const videoRewatchOn = Boolean(videoStage) && features.videoRewatch !== false && typeof describer.rewatchVideo === 'function';
      const imageRelookOn = features.imageRelook !== false && typeof describer?.relookImage === 'function';
      // Watched GIFs under features.videoRewatch and video vision (they are watched as clips);
      // the describer's watchedGifs offers none while GIFs are not watched (media.gif.watch).
      const gifRewatchOn =
        isVideoVisionOn(config) && features.videoRewatch !== false && typeof describer?.rewatchGif === 'function' && typeof describer.watchedGifs === 'function';
      // The items a second look may be offered for (the re-watch, or the planner's `<media>`).
      // With features.coreTools no classifier picks a second look for her: she calls media.look.
      const mediaWanted = asked && !answersDrawFailure && (videoRewatchOn || imageRelookOn || gifRewatchOn) && !routedPull && !coreTools;
      const pictures = mediaWanted && imageRelookOn ? relookCandidates(rawHistory) : [];
      const gifItems = mediaWanted && gifRewatchOn ? gifRewatchItems(rawHistory) : [];
      if (asked && !answersDrawFailure && (videoRewatchOn || imageRelookOn || gifRewatchOn)) {
        if (coreTools) {
          log.info('rewatch: skipped', { channel: channel.id, reason: 'core-tools' });
        } else if (routedPull) {
          log.info('rewatch: skipped', { channel: channel.id, reason: 'routed' });
        } else if (planner) {
          // The planner's re-watch block picks the item and the question (its `<media>` built by
          // plannerMedia below); the second look itself waits for the video stage, as before.
          rewatchChain = planner.result
            .then(async (plan) => {
              const offer = plan.offer.media;
              const answer = plan.blocks.rewatch;
              if (!offer || answer.state !== 'ok') return undefined;
              await videoStage?.settled;
              if (deadline.passed) return undefined;
              rewatchStage = track('rewatch', async () => {
                const own = new Map(videoStage?.value?.videos ?? offer.states);
                const imageAnswers = new Map();
                try {
                  await applyRewatch({ guildId, channelId: channel.id, offer, pick: answer.pick, reason: answer.parse, videos: own, imageAnswers });
                } catch (err) {
                  log.warn('rewatch: failed', { channel: channel.id, error: err });
                }
                // The video states only when videos were offered; otherwise the video stage's stand.
                return { videos: offer.offersVideos ? own : null, imageAnswers };
              });
              return rewatchStage.settled;
            })
            .catch(chainFailed('rewatch'));
        } else {
          rewatchChain = Promise.all([videoStage?.settled, previews.settled])
            .then(() => {
              const watched = videoStage?.value?.videos;
              const offersVideos = videoRewatchOn && Boolean(watched);
              // Read from the cache now, after the stages above: a GIF watched meanwhile counts.
              const gifCaptions = gifItems.length > 0 ? describer.watchedGifs(guildId, gifItems) : new Map();
              const gifs = gifItems.filter((item) => gifCaptions.has(item.itemId));
              if (deadline.passed || (!offersVideos && !imageRelookOn && gifs.length === 0)) return undefined;
              rewatchStage = track('rewatch', async () => {
                const own = new Map(watched ?? []);
                const imageAnswers = new Map();
                try {
                  await maybeRewatch({
                    config,
                    guildId,
                    channelId: channel.id,
                    selfName,
                    history: previewed(),
                    trigger: candidate,
                    videos: own,
                    descriptions: captionsSoFar(),
                    candidates: offersVideos ? videoCandidates : [],
                    gifs,
                    gifCaptions,
                    pictures,
                    imageAnswers,
                  });
                } catch (err) {
                  log.warn('rewatch: failed', { channel: channel.id, error: err });
                }
                // The video states only when videos were offered; otherwise the video stage's stand.
                return { videos: offersVideos ? own : null, imageAnswers };
              });
              return rewatchStage.settled;
            })
            .catch(chainFailed('rewatch'));
        }
      }
      // A direct call that brought something to look at -- on its own message or the one it
      // replies to, captioned or watched by the stages above -- is about that thing: its deadline
      // grows to pace.prepareMediaMs (null: no extension). A search asked for later may grow it
      // further; extend keeps the larger limit, and never sets one on a deadline without one. The
      // hold for the search classifier's verdict (pace.prepareSearchMs) does nothing under a larger limit.
      if (trigger && DIRECT_CALLS.has(triggerKind) && pace.prepareMediaMs !== null && triggerBringsMedia(trigger, captionCandidates, videoCandidates)) {
        deadline.extend(pace.prepareMediaMs);
      }
      // The video states a classifier's transcript shows: this turn's once they are done (with the
      // re-watch's answer when it is done too), else what the describer's cache holds.
      const videosSoFar = async () => {
        if (!videoStage) return undefined;
        if (rewatchStage?.done && rewatchStage.value?.videos) return rewatchStage.value.videos;
        if (videoStage.done) return videoStage.value?.videos;
        try {
          return typeof describer.cachedVideos === 'function' ? await describer.cachedVideos(guildId, videoCandidates) : undefined;
        } catch {
          return undefined;
        }
      };

      // The web lookup (features.webLookup -- unlike the other switches a
      // missing key counts as OFF: it costs money and the search needs a
      // key). The links: the newest readable links of the history, at most
      // web.links.maxPerTurn NEW reads (cached excerpts are free). Beside them, on a
      // direct address only (not an overheard line), the search classifier
      // when the web search or the server search (recall; a private chat only
      // on its partner's behalf) can run, and what its answer asks for of the two, in parallel.
      let linksStage = null;
      const webCfg = config.web ?? {};
      // Cache only: no fetch, no model request, no daily slot (src/web/lookup.js#cachedReads).
      const cachedLinkReads = () => {
        if (!linksStage || typeof lookup?.cachedReads !== 'function') return undefined;
        try {
          return lookup.cachedReads(guildId, readableLinkCandidates(rawHistory, config.media?.video?.sites));
        } catch (err) {
          log.warn('lookup: links failed', { channel: channel.id, error: err });
          return undefined;
        }
      };
      if (webLookupOn && webCfg.links?.enabled !== false && typeof lookup.readLinks === 'function') {
        linksStage = track('links', async () => {
          try {
            const candidates = readableLinkCandidates(rawHistory, config.media?.video?.sites);
            // The journal: the link reads as one operation of the engine, hosts only.
            const readOp = candidates.length > 0 ? prepStep('links', 'read-link', { input: { hosts: linkHosts(candidates) } }) : null;
            const read = await journalled(readOp, () => lookup.readLinks(guildId, candidates, { maxNew: webCfg.links?.maxPerTurn ?? 2 }), (value) => {
              const reads = value?.reads instanceof Map ? value.reads : new Map();
              const chars = [...reads.values()].reduce((sum, text) => sum + (typeof text === 'string' ? text.length : 0), 0);
              return { result: { hosts: linkHosts(candidates.filter((link) => reads.has(link.id))), chars }, offered: reads.size > 0 };
            });
            return read.reads;
          } catch (err) {
            log.warn('lookup: links failed', { channel: channel.id, error: err });
            return undefined;
          }
        });
      }
      // The search classifier's transcript needs the file previews; the captions, video states and
      // page reads it shows are what this turn has at its start (captionsSoFar, videosSoFar, the
      // reads once done). A routed call is read in its source (routedPull), with its captions.
      let lookupStage = null;
      let lookupChain = null;
      // `serverOn` (above): the lookup stage runs the server search and `<senses>` says it exists.
      if (asked && !answersDrawFailure && !answersTask && coreTools && (webSearchOn || serverOn)) log.info('lookup: skipped', { channel: channel.id, reason: 'core-tools' });
      if (asked && !answersDrawFailure && !answersTask && !coreTools) {
        const webOn = webSearchOn;
        if (webOn || serverOn) {
          lookupChain = previews.settled
            .then(() => {
              if (deadline.passed) return undefined;
              lookupStage = track('lookup', async () => {
                try {
                  const chat = previewed();
                  const shown = captionsSoFar();
                  const videosShown = await videosSoFar();
                  return await maybeLookup({
                    config,
                    guildId,
                    channel,
                    guild: servedGuild,
                    partner,
                    selfId,
                    selfName,
                    history: routedPull ? routedPull.messages : chat,
                    chatHistory: chat,
                    trigger: candidate,
                    descriptions: routedPull ? new Map([...(shown ?? []), ...routedPull.descriptions]) : shown,
                    videos: videosShown,
                    // Link reads of this turn when they are in, else what the link cache already holds.
                    reads: linksStage?.done ? linksStage.value : cachedLinkReads(),
                    webOn,
                    serverOn,
                    onSearch: () => deadline.extend(pace.prepareSearchMs),
                    onSkills: (answer) => {
                      skillsAnswer = answer;
                    },
                    journalStep: prepStep,
                    triggerKind,
                    limits: draft.limits ?? null,
                    // With the planner its lookup block stands in for the search classifier.
                    planned: planner ? await planner.result : null,
                  });
                } catch (err) {
                  log.warn('lookup: failed', { channel: channel.id, error: err });
                  return null;
                }
              });
              // Until the classifier's verdict the deadline waits for it, at most until
              // pace.prepareSearchMs: a search it asks for has moved the deadline there by the time
              // the stage ends; no search lets a limit that passed meanwhile pass at once.
              deadline.hold(lookupStage.settled, pace.prepareSearchMs);
              return lookupStage.settled;
            })
            .catch(chainFailed('lookup'));
        }
      }

      // The turn planner, unless its route step started it already: once the file previews are in
      // (and, when a watched video may be offered a second look, once the video stage settled, as
      // the re-watch waited), with what this turn has then -- the search classifier's transcript
      // (a routed call read in its source) and the re-watch's `<media>` (plannerMedia). A deadline
      // already passed sends nothing: every block keeps its default.
      if (planner && !planner.started) {
        const plannerMedia = (watched) => {
          const offersVideos = videoRewatchOn && Boolean(watched);
          // Read from the cache now, after the stages above: a GIF watched meanwhile counts.
          const gifCaptions = gifItems.length > 0 ? describer.watchedGifs(guildId, gifItems) : new Map();
          const gifs = gifItems.filter((item) => gifCaptions.has(item.itemId));
          if (!offersVideos && !imageRelookOn && gifs.length === 0) return null;
          const offer = rewatchOffer({
            config,
            channelId: channel.id,
            history: previewed(),
            videos: new Map(watched ?? []),
            descriptions: captionsSoFar(),
            candidates: offersVideos ? videoCandidates : [],
            gifs,
            gifCaptions,
            pictures,
          });
          return offer ? { ...offer, offersVideos } : null;
        };
        const videosFirst = mediaWanted && videoRewatchOn && videoCandidates.length > 0 ? videoStage?.settled : null;
        Promise.all([previews.settled, videosFirst])
          .then(async () => {
            if (planner.started) return;
            if (deadline.passed) {
              planner.abandon('late');
              return;
            }
            const chat = previewed();
            const shown = captionsSoFar();
            const videosShown = await videosSoFar();
            plannerStart({
              lines: routedPull ? routedPull.messages : chat,
              descriptions: routedPull ? new Map([...(shown ?? []), ...routedPull.descriptions]) : shown,
              videos: videosShown,
              reads: linksStage?.done ? linksStage.value : cachedLinkReads(),
              media: mediaWanted ? plannerMedia(videosShown) : null,
            });
          })
          .catch((err) => {
            log.warn('turn: stage failed', { channel: channel.id, stage: 'planner', error: err });
            planner.abandon('error');
          });
      }

      // A private chat has no neighbouring channels. A neighbour passes the audience rail the
      // pulls pass (audienceAllows, context.pull.sameAudience): everyone who can read this channel
      // can read it. One refused takes no slot, costs no fetch, and never reaches `<server>`
      // either (buildRequest maps only the neighbours it is given); counted on the answer's log.
      const neighborsStage = isPrivate
        ? null
        : track('neighbors', async () => {
            let hidden = 0;
            const accept = (other) => {
              const allowed = audienceAllows(channel, other, config);
              if (!allowed) hidden += 1;
              return allowed;
            };
            const found = await fetchNeighbors(channel, config, selfId, now, { accept });
            return { neighbors: found, hidden };
          });
      // The pulled channels started earlier: timed from their own start.
      const pulledStage = isPrivate && !likeServer ? null : track('pulled', () => pulledPending, pullStartedAt);
      // `<participation>`: the persona's own exchanges on other channels this turn may show, and
      // the pick classifier's choice among them (src/behavior/participation-pick.js; it asks
      // nothing when there is no episode to offer). Late or failed, the newest are shown.
      const participationShown = participationOn(channel, config) && finalMode !== 'diary';
      const participationAudienceOf = participationShown ? participationAudience(channel, config) : null;
      const participationStage =
        participationShown && !answersDrawFailure
          ? track('participation', () =>
              planner
                ? // The planner's episodes block, mapped back to the episode ids it was offered.
                  planner.result.then((plan) => {
                    const answer = plan.blocks.episodes;
                    const ids = plan.offer.episodes?.ids ?? [];
                    return answer.state === 'ok' ? answer.indices.map((n) => ids[n - 1]).filter(Boolean) : [];
                  })
                : pickParticipation({ guildId, channel, history: rawHistory, trigger: candidate, triggerKind, mode: finalMode, selfName, audience: participationAudienceOf, limits: draft.limits }),
            )
          : null;

      // Parts in time end the wait at once: the whole message's preparation is set aside.
      const partsReady = splitStage ? splitStage.settled.then(() => (hasParts() ? undefined : new Promise(() => {}))) : null;
      await beforeBar(
        Promise.race([
          Promise.all([
            previews.settled,
            captions?.settled,
            videoStage?.settled,
            rewatchChain,
            linksStage?.settled,
            lookupChain,
            neighborsStage?.settled,
            pulledStage?.settled,
            participationStage?.settled,
            splitStage?.settled,
            prefetchStage?.settled,
          ]),
          deadline.reached,
          ...(partsReady ? [partsReady] : []),
        ]),
      );
      if (hasParts()) {
        // The message holds several requests: runChain answers them, this turn's attention kept.
        deadline.close();
        chained = true;
        return { outcome: 'split', parts: splitStage.value, history: rawHistory };
      }
      deadline.close();
      const prepareMs = clock() - startedAt;
      // What this turn has: a stage still running is left out (named in `late`).
      const late = PREPARE_STAGES.filter((name) => stages.has(name) && !stages.get(name).done);
      for (const name of late) {
        draft.limits?.add({ kind: 'helper-timeout', where: name });
        const stage = stages.get(name);
        stage.settled.then(() => log.info('turn: stage late', { channel: channel.id, stage: name, ms: stage.ms }));
      }
      const timings = { history: historyMs };
      for (const name of PREPARE_STAGES.slice(1)) timings[name] = stages.get(name)?.done ? stages.get(name).ms : null;
      history = previewed();
      // Messages deleted inside the window: the record's `deleted` lines over its span in this one
      // channel, each the history lacks put back as a placeholder at its own place (never in a
      // private chat); its read takes `timings.record`.
      timings.record = null;
      if (!isPrivate && record && features.record === true && typeof record.iterate === 'function') {
        const found = await deletedLinesOf({ record, guildId, channelId: channel.id, history, selfId, selfName, nameOf: memoryOn ? (id) => store.getUser(guildId, id)?.names?.[0] ?? null : null, max: deletedLinesMax(config.context), clock });
        timings.record = found.ms;
        if (found.failed) log.warn('turn: deleted lines failed', { channel: channel.id });
        draft.deletedIds = found.deletedIds;
        history = withDeletedLines(history, found.placeholders);
      }
      // A text attachment cut at media.filePreviewChars (interfaces/discord/collect.js#withTextPreviews).
      for (const message of history) {
        for (const attachment of message.attachments ?? []) {
          if (attachment?.previewLost > 0) draft.limits?.add({ kind: 'preview-cut', where: message.id, lost: attachment.previewLost, detail: attachment.id });
        }
      }
      const descriptions = captions?.done ? captions.value?.descriptions : undefined;
      // A video stage past the deadline: the cached states stay, and the videos it was still
      // watching render not watched (`pending`) instead of as a bare still frame.
      const videos =
        rewatchStage?.done && rewatchStage.value?.videos
          ? rewatchStage.value.videos
          : videoStage?.done
            ? videoStage.value?.videos
            : videoStage
              ? lateVideoStates(videoCandidates, await videosSoFar(), config.media?.video?.maxPerTurn ?? 5)
              : undefined;
      // A picture's second look on a question (features.imageRelook): rendered under its line.
      const imageAnswers = rewatchStage?.done && rewatchStage.value?.imageAnswers?.size > 0 ? rewatchStage.value.imageAnswers : null;
      const reads = linksStage?.done ? linksStage.value : undefined;
      const lookupResult = lookupStage?.done ? (lookupStage.value ?? null) : null;
      // A prefetch still out at the deadline: the request says so (`timeout`) instead of waiting.
      const prefetchResult = prefetching
        ? prefetchStage?.done
          ? (prefetchStage.value ?? null)
          : { status: 'timeout', basis: prefetching.lanes.map((lane) => lane.kind), excerpts: [] }
        : null;
      prep.take('prefetch', prefetchResult !== null);
      // What the turn has in front of it from outside, for where her lines came from (noteSeen):
      // someone's message she answers, the retrieved memory, pages read, a lookup, an errand's result.
      if (trigger && String(trigger.authorId ?? '') !== String(selfId)) noteSeen(draft, trigger.content);
      noteSeen(draft, prefetchResult?.excerpts);
      noteSeen(draft, reads, { read: true });
      noteSeen(draft, lookupResult, { read: true });
      noteSeen(draft, taskResult?.result, { read: true });
      // The journal: which preparation steps reached the request (the rest close as not delivered).
      prep.take('captions', Boolean(captions?.done));
      prep.take('videos', Boolean(videoStage?.done));
      prep.take('links', Boolean(linksStage?.done));
      prep.take('lookup', Boolean(lookupStage?.done));
      const neighborsFound = neighborsStage?.done ? neighborsStage.value : null;
      const neighbors = Array.isArray(neighborsFound?.neighbors) ? neighborsFound.neighbors : [];
      const neighborsHidden = neighborsFound?.hidden ?? 0;
      // Pulled ahead of a chooser, the channels keep their cached captions when the fresh ones are late.
      const pulled = pulledStage?.done && Array.isArray(pulledStage.value) ? pulledStage.value : (early?.pulled ?? []);

      // A neighbour's pictures get only the captions the cache already holds, under the
      // chat captions' switch: cachedDescriptions never sends a request or counts a day.
      // A diary post's plan, search and picture check (a request or token cap refuses the turn).
      let diaryPrep = null;
      if (diaryPending) {
        const settled = await beforeBar(diaryPending);
        if (settled.error) throw settled.error;
        diaryPrep = settled.value;
      }
      const neighborDescriptions =
        features.mediaDescriptions === true && typeof describer?.cachedDescriptions === 'function' && neighbors.length > 0
          ? describer.cachedDescriptions(guildId, neighbors.flatMap((neighbor) => describableCandidates(neighbor.messages, [])))
          : undefined;
      // Drawing (features.imageGeneration, a missing key counts as on) needs the image client
      // and Attach Files here; a drawFailed turn answers the failure and never draws again.
      // An unasked turn reads the quota for no member, like draw() charges none.
      // A diary post draws only while its picture check allowed it (its own daily cap and the image cap).
      const drawOn =
        Boolean(images) && features.imageGeneration !== false && triggerKind !== 'drawFailed' && canAttach(channel) && (!diaryPrep || diaryPrep.pictureAllowed);
      const drawQuota = drawOn ? images.quota({ userId: asked ? (trigger.authorId ?? null) : null }) : undefined;
      // Neighbours the bot can read but not write in, marked in `<server>` (a pulled channel's
      // record carries its own mark). A pulled channel whose block is shown is left out of the
      // neighbours by buildRequest itself.
      const readOnlyIds = new Set(neighbors.filter((neighbor) => neighbor.readOnly === true).map((neighbor) => neighbor.channelId));
      // Where a call from a read-only channel is answered, for `<senses>`.
      const destination = isPrivate ? null : usableDestination(channel.guild, config, { discord }).channel;
      // `<recent>`: the guild's live recent lines (none: an empty list) and the channels this turn may show them from.
      const recent = memoryOn ? recentInput({ channel, guildId, isPrivate, config, now }) : NO_RECENT;
      // The prompts this request is built from, read once: the task labels below decide what it names.
      const prompts = hot.prompts;
      // A part of a split message, the author's other calls still queued, the messages folded into this one.
      // Addressed turns of this channel that failed earlier, told once (first part only); cleared at the turn's end unless it fails too.
      const addressedHere = mode === 'reply' && askedFor(trigger, triggerKind) && (!part || part.index === 1);
      if (isPrivate) privateChannels.add(String(channel.id));
      const factScope = { channelId: String(channel.id), privateChat: isPrivate };
      let pendingFacts = addressedHere ? facts().pending(guildId, factScope) : [];
      // A send of hers that may have gone out is looked for in the channel's lines first: found, the fact is dropped; not, it is told as unclear.
      if (pendingFacts.some((fact) => fact.kind === 'sendFailed' && fact.unknown === true)) {
        const settled = settleUnknownSends(pendingFacts, history);
        if (settled.dropped.length > 0) {
          facts().markTold(guildId, settled.dropped.map((fact) => fact.id));
          log.info('turn: unknown send found in the channel', { channel: channel.id, count: settled.dropped.length });
        }
        pendingFacts = settled.kept;
      }
      const failedFacts = pendingFacts.filter((fact) => fact.kind === 'failedTurn' && fact.channelId === factScope.channelId && now - fact.at < FAILED_TURN_KEEP_MS && fact.messageId !== trigger.id);
      const failedEarlier = failedFacts.map((fact) => ({
        author: history.find((m) => m.authorId === fact.authorId)?.authorName ?? store.getUser?.(guildId, fact.authorId)?.names?.[0] ?? '',
        messageId: fact.messageId,
        link: messageLink(isPrivate ? '@me' : guildId, channel.id, fact.messageId),
        at: fact.at,
        code: fact.code,
      }));
      // The diary posts she asked for in an earlier addressed turn here that did not go out, told the same way.
      const diaryFacts = prompts?.labels?.task?.diaryFailedEarlier ? pendingFacts.filter((fact) => fact.kind === 'diaryFailed' && fact.channelId === factScope.channelId && now - fact.at < FAILED_TURN_KEEP_MS) : [];
      const diaryFailedEarlier = diaryFacts.map((fact) => ({ at: fact.at, code: fact.code }));
      // What else was kept for her (a drop, a hold, a call or a message that failed): a `<wake>`-shaped block before the task.
      const otherFacts = pendingFacts.filter((fact) => fact.kind !== 'failedTurn' && fact.kind !== 'diaryFailed').slice(0, FACTS_SHOWN_MAX);
      const factsText = otherFacts.length > 0 ? feedbackInTurnText(otherFacts.map(factPayload), prompts?.labels, { timezone: config.bot?.timezone ?? 'UTC', locale: prompts?.labels?.locale }) : '';
      const shownIds = [...failedFacts, ...diaryFacts, ...(factsText ? otherFacts : [])].map((fact) => fact.id);
      if (shownIds.length > 0) draft.factsShown = shownIds;
      const tasks = taskInput({ part, queued, added, missed, failedEarlier, diaryFailedEarlier, labels: prompts?.labels, channelId: channel.id });
      // What this turn had in view yet does not answer (spokeAfterSeeing): the queued calls it
      // named, and on a part of a split message every line after the message -- a call that came
      // while the chain ran waits for its own turn after the chain.
      const triggerAt = part && trigger ? history.findIndex((m) => m.id === trigger.id) : -1;
      const notAnswered =
        triggerAt === -1 ? tasks.deferred : new Set([...tasks.deferred, ...history.slice(triggerAt + 1).map((m) => m.id)]);
      const guildMemory = memoryOn ? store.getGuild(guildId) : null;
      // Whether the call tags the persona, read as decideMention reads it (pipeline.js decideAndLog):
      // an untagged reply takes the follow-up task (usesFollowUpTask).
      const taggedCall = trigger ? isTaggedCall(trigger, selfId) : null;
      if (usesFollowUpTask({ mode: finalMode, triggerKind, taggedCall, routed: source?.reason === 'routed', privateChat: isPrivate })) {
        const followUpPrompt = prompts?.['follow-up'];
        const missing = !(typeof followUpPrompt === 'string' && followUpPrompt.trim());
        if (missing && !followUpPromptMissing) log.warn('turn: prompt missing', { name: 'follow-up', reason: 'no-prompt', channel: channel.id });
        followUpPromptMissing = missing;
      }
      // `<now>`: the persona's recent time away (the journal's pauses and stops).
      const offPeriods = await offPeriodsFor(guildId, config);
      // Skills discovery on a turn someone asked for: the catalogue when the question was what the
      // persona can do; named skills only logged and journaled (shadow).
      const skillsInventory = asked && !answersDrawFailure ? discoverSkills({ config, channel, trigger, answer: skillsAnswer, draft }) : null;
      // Every input named (turnRequestInput throws on one left undefined); null marks an absent one.
      // Kept: a skill call's follow-up rebuilds this very request over the channel as it stands then.
      const requestInput = turnRequestInput({
        config,
        prompts,
        calibrator,
        mode: finalMode,
        forced: forced || (diaryPrep !== null && diaryParams?.forced === true),
        now,
        selfName,
        // `<directory>` never lists the persona's own profile.
        selfId,
        history,
        neighbors,
        trigger,
        triggerKind,
        taggedCall,
        guildMemory: guildMemory ?? {},
        interlocutor: memoryOn && trigger ? (store.getUser(guildId, trigger.authorId) ?? null) : null,
        // A private chat: the partner's private layer joins their public profile (only there).
        privateChat: isPrivate ? { userId: trigger?.authorId ?? null } : null,
        privateProfile: isPrivate && memoryOn && trigger ? (store.getPrivate(guildId, trigger.authorId) ?? null) : null,
        otherProfiles: memoryOn
          ? pickOtherProfiles(store, guildId, history, trigger?.authorId, config.context.otherProfiles)
          : [],
        candidateProfiles: memoryOn ? store.listUserProfiles(guildId) : [],
        nameOf: memoryOn ? (id) => store.getUser(guildId, id)?.names?.[0] ?? null : null,
        channels: memoryOn ? store.listChannels(guildId) : [],
        // `<channel_directory>`: every text channel the persona can read, with its handle (none in a private chat).
        channelDirectory: channelDirectoryOf(channel.guild, config.bot),
        loreEntries: memoryOn ? store.getLore(guildId) : [],
        currentChannelId: channel.id,
        descriptions: descriptions ?? null,
        neighborDescriptions: neighborDescriptions ?? null,
        videos: videos ?? null,
        imageAnswers,
        reads: reads ?? null,
        lookup: lookupResult ?? null,
        // `<retrieved>`: the automatic memory prefetch of this trigger (null: none ran).
        prefetch: prefetchResult,
        searchAvailable: features.webLookup === true && typeof lookup?.hasSearch === 'function' && lookup.hasSearch() === true,
        // The search of the server's own history: the value the lookup stage used.
        recallAvailable: serverOn,
        drawQuota: drawQuota ?? null,
        drawReason,
        // The `<emoji>` block: the index's emoji (ranked by guildMemory.emojiUsage) and their cached captions.
        customEmoji: emoji ? (emoji.list() ?? []) : [],
        // The `<gifs>` block and the transcript's GIF handles: the guild's library (features.gifs).
        gifs: features.gifs !== false && typeof store.getGifs === 'function' ? (store.getGifs(guildId) ?? null) : null,
        // The cached captions of both lists.
        mediaCache:
          emoji || (features.gifs !== false && typeof store.getGifs === 'function') ? (store.getMediaCache(guildId) ?? null) : null,
        // `<channel_view>`: the channels pulled into this turn (each with the last view of it
        // shown in this channel, when one is within context.pull.seenTtlMinutes), the one it is
        // about, the chat line put to the room, where a call from a read-only channel is answered.
        // The persona's lines there name the message that started their turn (linkTriggers) and
        // the skill calls she made there (linkCalls).
        pulled: withSeenBefore(
          pulled.map((entry) => (Array.isArray(entry?.messages) ? { ...entry, messages: linkCalls(linkTriggers(entry.messages), { channel, guildId }) } : entry)),
          channel.id,
          now,
        ),
        source,
        focus,
        tasks: tasks.input,
        elsewhereDestination: destination?.name ? { name: destination.name } : null,
        readOnlyIds,
        // `<recent>`: the last hours, its live lines and the members' moments (no block without the store).
        recentLines: recent.lines ?? null,
        recentAudience: recent.audience ?? null,
        // `<participation>`: the store read now, the classifier's picks when they came in time.
        participation: participationShown
          ? {
              state: store.getParticipation(guildId),
              pickedIds: participationStage?.done && Array.isArray(participationStage.value) ? participationStage.value : [],
              audience: participationAudienceOf,
              channelName: liveChannelName(channel),
            }
          : null,
        // `<senses>`: where the persona keeps its diary, when one is set.
        diaryChannel: diaryChannelName(guildId, config),
        // A diary post: its past posts, its plan and what its search found.
        diary: diaryPrep ? { posts: diaryPrep.posts, plan: diaryPrep.plan, found: diaryPrep.found, seeds: diaryPrep.seeds ?? '' } : null,
        offPeriods,
        skillsInventory,
        // `<skills_granted>`: the names of the skills granted to her, on every turn -- her grants
        // (the config read now) and the registry only, never this requester or channel.
        skillsGranted: grantedSkillNames({ config, selfId, registry: skills ?? defaultSkills() }),
        // `<skills_tools>` (features.coreTools): her own tools in full, by her grants only; an inner turn's also lists the posting skills its tags stand for.
        skillsTools: coreTools ? coreToolRows({ config, selfId, registry: skills ?? defaultSkills(), texts: prompts?.skills, inner: Boolean(draft.inner), unreadTasks: listedTasks({ guildId, channel, isPrivate, taskResult }).some((task) => task.state !== 'queued' && task.state !== 'running') }) : null,
        // `<people_now>`'s live part: the voice and status snapshot (null: none).
        around: aroundInputFor({ channel, config, mode: finalMode, isPrivate }),
        // `<tasks>` and `<task_result>`: her errands (none on a diary post).
        errands: finalMode === 'diary' ? null : errandsInputFor({ guildId, channel, isPrivate, taskResult, config, labels: prompts?.labels, now }),
        // `<intentions>`: hers and the proposed ones (features.intentions; none on a diary post).
        intentions: finalMode === 'diary' ? '' : intentionsInputFor({ guildId, channel, isPrivate, config, labels: prompts?.labels, now }),
        // `<wake>`: an inner turn's reason to be awake (src/behavior/wake.js); none on any other turn.
        wake: draft.inner ? wakeBlockText(draft.inner.wake, prompts?.labels, { locale: prompts?.labels?.locale }) : factsText || null,
        // `<places>`: the places page on an addressed server turn, only with `context.places` exactly true (an inner turn has it in `<wake>`).
        places: !draft.inner && !isPrivate && finalMode !== 'diary' ? placesInputFor({ guildId, config, labels: prompts?.labels }) : null,
        // The turn itself; its continuation after a skill call sets it (continuationRequest).
        continuation: null,
        // `<self_facts>` and `<gifs>` held per cache bucket, so a memory batch rewrites the cache once at most.
        stableFreeze: stableFreezeOf(guildId),
      });
      const request = buildRequest(requestInput);
      // What `<recent>` showed, held back or cut: counts only.
      if (request.recent) log.info('recent: shown', { channel: channel.id, ...request.recent });
      // The journal: what of the window went in, whose lines they were, what the budget dropped.
      if (draft.started && request.seen) {
        // The lines of the pulled channels whose block the request kept count as seen too, by channel.
        const pulledSeen = (request.pulledKept ?? []).map(({ channelId, ids }) => ({ channelId, messageIds: [...ids] }));
        const pulledIdsSeen = pulledSeen.flatMap((entry) => entry.messageIds);
        draft.seen = { ...request.seen, messageIds: [...new Set([...request.seen.messageIds, ...pulledIdsSeen])], pulled: pulledSeen };
        const keptIds = new Set(draft.seen.messageIds);
        const pulledLines = pulledSeen.flatMap(({ channelId }) => pulled.find((entry) => entry.channelId === channelId)?.messages ?? []);
        const authors = [...history, ...pulledLines].filter((message) => keptIds.has(message.id) && !message.self).map((message) => message.authorId);
        draft.participants = [...new Set([...authors, trigger?.authorId].filter((id) => typeof id === 'string' && id))];
        draft.dropped = droppedSections(request.stats);
        budgetDrops(request.stats, draft.limits);
      }

      // The request is text only (buildRequest never attaches a picture: the persona sees them
      // through the describer's captions), so nothing is downloaded or resent here.
      const messages = request.messages;

      let completion;
      // What the client was given, for the journal's request dump.
      const sentMessages = messages;
      const replyStartedAt = clock();
      try {
        completion = await beforeBar(llm.complete(messages, replyOptions()));
      } catch (err) {
        // The bar passed, or no time is left under it by the time the error lands: the turn is
        // dropped as too slow (an answer could not be asked for again), not reported as an error.
        if (err === TOO_SLOW || bar.passed || bar.leftMs() === 0) throw TOO_SLOW;
        throw err;
      } finally {
        // Where this turn's time went, answered or not: numbers and codes only.
        const end = clock();
        log.info('turn: timings', {
          channel: channel.id,
          mode: finalMode,
          triggerKind: triggerKind ?? null,
          settleMs: settledMs,
          prepareMs,
          late,
          stages: timings,
          replyMs: end - replyStartedAt,
          totalMs: end - startedAt,
        });
      }
      // The answer is in hand: the bar is met, and the typing imitation below (never shortened) takes over.
      bar.close();
      stopTyping();

      // The journal's request dump (journal.keepRequests): the request as sent and the raw answer.
      dumpTurnRequest(guildId, draft, sentMessages, completion);

      // The model's output as it is acted on: the feature switches drop parts of it first. The
      // same for the one follow-up request after a skill call (runCall).
      // The tool loop (features.coreTools, read now): her calls of the reply and of each step after it.
      const loopOn = coreToolsOn(hot.config);
      const shapeOutput = (parsed) => {
        if (features.reactions === false) {
          parsed.reactions = [];
          parsed.untargetedReactions = [];
        }
        // A custom emoji reaction resolves through the index; an unknown one (or the switch off) is dropped.
        const lookupEmoji = emojiLookup();
        parsed.reactions = parsed.reactions
          .map((reaction) => ({ ...reaction, emoji: resolveReactionEmoji(reaction.emoji, lookupEmoji) }))
          .filter((reaction) => reaction.emoji);
        if (features.multiMessage === false) parsed.messages = parsed.messages.slice(0, 1);
        // format.stripDashes (a missing key counts as on): no em/en dash in a <msg> text; a message
        // left empty is not posted. Hyphens, <draw>, <react>, <gif> and reply ids are untouched.
        if (hot.config.format?.stripDashes !== false) {
          const dashes = parsed.messages.reduce((sum, message) => sum + countDashes(message.text), 0);
          if (dashes > 0) {
            parsed.messages = parsed.messages.map((message) => ({ ...message, text: stripDashes(message.text) })).filter((message) => message.text !== '');
            log.info('turn: dashes stripped', { channel: channel.id, count: dashes });
          }
        }
        // No image client, drawing off, no Attach Files, or already answering a failed picture: the <draw> is dropped.
        if (!drawOn) parsed.draw = null;
        // An inner turn's tags are public actions in its current channel: lowered into the calls a
        // `message.create` / `draw.create` / `message.react.add` of hers would be and planned before
        // her own calls, in the order an addressed turn acts in (src/behavior/inner-output.js).
        if (draft.inner) {
          const current = draft.inner.currentChannel === undefined ? String(channel.id) : draft.inner.currentChannel;
          // Marked as tags: the last loop step runs every one of them (loopStep); only her explicit calls are bounded there.
          const lowered = innerOutputCalls(parsed, { current: current ? String(current) : null, turnChannel: String(channel.id) }).map((call) => ({ ...call, lowered: true }));
          parsed.calls = [...lowered, ...(Array.isArray(parsed.calls) ? parsed.calls : [])];
          parsed.call = parsed.calls[0] ?? null;
          if (lowered.length > 0) log.info('turn: inner output lowered', { channel: channel.id, calls: lowered.length });
          parsed.messages = [];
          parsed.reactions = [];
          parsed.untargetedReactions = [];
          parsed.gif = null;
          parsed.draw = null;
          parsed.draws = [];
        }
        // Every `<call>` past the first, and a malformed first one, is ignored (src/llm/parse.js);
        // the tool loop (features.coreTools, never a diary post) runs several (planCalls).
        if (parsed.extraCalls > 0 && !(loopOn && !diaryPrep)) log.info('skills: extra-call', { channel: channel.id, count: parsed.extraCalls });
        if (parsed.callError) log.info('skills: bad-call', { channel: channel.id, reason: parsed.callError });
        if (diaryPrep) {
          // A diary post: no reaction, no GIF, nothing posted as a reply, no link, no skill call, at most diary.maxMessages.
          parsed.reactions = [];
          parsed.gif = null;
          parsed.call = null;
          parsed.calls = [];
          parsed.messages = parsed.messages
            .map((message) => ({ ...message, replyTo: null, text: stripUrls(message.text) }))
            .filter((message) => message.text !== '')
            .slice(0, Math.max(0, config.diary?.maxMessages ?? 3));
          if (parsed.draw) parsed.draw = { ...parsed.draw, replyTo: null };
        }
        return parsed;
      };
      const parsed = shapeOutput(parseOutput(completion.text, { maxDrawChars: hot.config.image?.maxPromptChars, limits: draft.limits }));
      // A set post (the plan's kind in diary.setKinds): the first diary.set.pictures[1] <draw> tags
      // (none while drawing is off), never the single drawing.
      const setDraws =
        diaryPrep && isSetKind(diaryPrep.plan.kind, config.diary?.setKinds)
          ? (drawOn ? parsed.draws : []).slice(0, setSettings(config.diary).pictures[1]).map((drawn) => ({ ...drawn, replyTo: null }))
          : null;
      if (setDraws) parsed.draw = null;
      // features.gifs off, an unknown handle or gifs.maxPerDay spent: the <gif> is dropped.
      parsed.gif = resolveGif(guildId, parsed.gif, channel.id, draft.limits);
      const nothingToDo =
        parsed.messages.length === 0 && parsed.reactions.length === 0 && parsed.draw === null && parsed.gif === null && !(setDraws?.length > 0) && !parsed.call;
      // The journal keeps the think (journal.thinkChars); the log then carries its length only.
      if (draft.started) {
        draft.think = parsed.think;
        draft.usage = journalUsage(completion);
      }
      // An inner turn keeps its think for its memory episode (each step's too, loopStep).
      if (draft.inner && parsed.think) draft.innerThinks = [parsed.think];
      const thinkField = journalOn() ? { thinkChars: Array.from(parsed.think ?? '').length } : { think: parsed.think };

      log.info('turn: model answered', {
        mode: finalMode,
        trigger: triggerKind ?? null,
        // Only on a turn about another channel, with channels pulled, or with a line put to the room.
        ...(source ? { source: source.channelId ?? null } : {}),
        ...(pulled.length > 0 ? { pulled: pulled.length } : {}),
        ...(focus ? { focus: true } : {}),
        // Active neighbours the audience rail left out.
        ...(neighborsHidden > 0 ? { neighborsHidden } : {}),
        secondsToAnswer: Math.round((clock() - startedAt) / 100) / 10,
        channel: channel.id,
        estimated: completion.estimated,
        usage: completion.usage,
        calibration: Number(calibrator.ratio.toFixed(3)),
        budget: request.stats,
        // Per user-message part: length and a short hash, to see which part changes between turns (no content).
        segments: request.segments,
        ...thinkField,
        skip: parsed.skip || nothingToDo,
        messages: parsed.messages.length,
        reactions: parsed.reactions.length,
        draw: Boolean(parsed.draw),
        ...(setDraws ? { draws: setDraws.length } : {}),
        gif: Boolean(parsed.gif),
        ...(parsed.call ? { call: parsed.call.skill } : {}),
      });
      // The pulled channels whose block was in the request sent (a skip and a dry run included):
      // their seen marks move to the newest line shown; a block the budget dropped moves none.
      const shownPulled = request.pulledKept ?? [];
      // What a private chat showed of the server stays there: no seen mark, no stamp, no pending ping.
      const serverShown = isPrivate ? [] : shownPulled;
      markPulledSeen(serverShown);
      // This channel's view of each pulled channel the request showed, for the next view of it here.
      if (!isPrivate) pullViews.remember(channel.id, request.pulledViews ?? [], now);
      store.state.data.calibration = calibrator.ratio;
      store.state.markDirty();
      // The calls of the ring this turn showed follow its decision (stampShownCalls), except a
      // routed turn's own call: its caller stamps that one.
      const ownCallId = source?.reason === 'routed' ? (trigger?.id ?? null) : null;

      // Cut off at the output cap before any complete action: a lost answer, not her silence.
      const cutOff = cutOffOf(completion, parsed, { channelId: channel.id, empty: parsed.skip || nothingToDo, followUp: false });
      if (cutOff && !cutOff.kept) {
        draft.reason = 'cut-off';
        return { outcome: 'error', mode: finalMode, reason: 'cut-off' };
      }
      if (parsed.skip || nothingToDo) {
        stampShownCalls({ shown: serverShown, pulled, answered: new Set(), exceptId: ownCallId });
        // An inner turn that ends with no action: nothing to do, journalled as such.
        return { outcome: 'skip', mode: finalMode, reason: draft.inner ? SKIP_NOTHING_TO_DO : SKIP_SILENCE };
      }

      const idByIndex = request.idByIndex;
      // The output side of the pulled channels: which line lives where, whose @name resolves,
      // which post carries a jump link (one rule for act and dryAct). Names resolve over the
      // pulled lines the request showed, then this chat's history: resolveMentions keeps the
      // last author of a display name, so a chat author wins a name both share. The stored names
      // of the members whose profile the request kept and of the pulled lines' authors resolve
      // too, behind every display name: a pulled line fetched without its member carries the
      // global name while `<people>` reads the server nickname. Only then the fallback directory:
      // a member the model was not shown (another channel, a block the budget dropped) is
      // mentioned by a name nobody else in the served guild carries.
      const pulledIds = request.pulledIds ?? new Map();
      const shownLines = shownPulled.flatMap(({ channelId, ids }) => {
        const shownIds = new Set(ids);
        return (pulled.find((entry) => entry.channelId === channelId)?.messages ?? []).filter((message) => shownIds.has(message.id));
      });
      const lines = shownLines.length > 0 ? [...shownLines, ...history] : history;
      // With features.mentionHandles on (the request was built with it: `handles`), only her
      // `@handle` mentions anyone and no name is matched at all.
      const handles = request.handles ?? null;
      // The request's channel handles: her `#handle` links its channel exactly.
      const channelHandles = request.channelHandles ?? null;
      const knownNames = memoryOn && !handles ? storedNames(request.peopleShown, shownLines, (userId) => store.getUser(guildId, userId)) : [];
      // Behind those, every member of the served guild the bot knows (built once, on the first `@`).
      const directory = handles ? null : turnDirectory({ guildId, channel, memoryOn });
      const linkFor = createLinker({
        guildId,
        pulledIds,
        sourceTarget: isPrivate ? null : sourceLinkTarget({ source, trigger, pulledKept: shownPulled }),
      });
      // A follow-up or an overheard turn (postsPlain) never posts as a Discord reply -- the
      // model's reply="#n" quotes nothing --, nor does the drawFailed turn after one.
      // A later part of a split message posts plain too: the first part replied to the message.
      const plain = postsPlain(triggerKind) || postsPlain(drawFailedAfter) || plainPosts;
      const routing = { pulledIds, lines, knownNames, directory, handles, channelHandles, linkFor, plain };
      // Read fresh right here, not from the `features` snapshot taken at the
      // top of this turn: unlike the other switches this one defaults to OFF,
      // and whether to actually post is the very last decision of a turn.
      // A set below diary.set.minPosted (read now) is not posted at all: not even its messages.
      const setMinPosted = setDraws ? setSettings(hot.config.diary).minPosted : 0;
      const setShort = (pictures, extra = {}) => {
        log.info('turn: set short', { channel: channel.id, pictures, wanted: setMinPosted, ...extra });
        return { outcome: 'refused', mode: finalMode, reason: 'set-short', ...extra };
      };
      // A recovery turn (src/behavior/missed.js) asks right before anything is posted whether
      // its messages still wait for an answer (`stillDue`): the persona spoke in the channel
      // since it started, or another turn answered one of them -- nothing is posted.
      if (typeof stillDue === 'function' && !stillDue()) {
        log.info('turn: dropped', { channel: channel.id, mode: finalMode, triggerKind: triggerKind ?? null, reason: 'answered-meanwhile' });
        draft.reason = 'answered-meanwhile';
        return { outcome: 'not-now', mode: finalMode, reason: 'answered-meanwhile' };
      }
      if (hot.config.features?.dryRun === true) {
        // Nothing is generated: a set with fewer drawings than it needs would be short.
        if (setDraws && setDraws.length < setMinPosted) return setShort(setDraws.length, { dryRun: true });
        // A skill call in a dry run: logged as the persona wrote it, never checked, run or followed up.
        if (parsed.call) log.info('dry-run: would call', { channel: channel.id, skill: parsed.call.skill, args: parsed.call.args, body: parsed.call.body });
        await dryAct({ channel, guildId, parsed, idByIndex, history, mode: finalMode, triggerKind, trigger, selfName, part, ...routing, gifPick: !diaryPrep, setDraws, draft });
        noteSpokeSaw(channel, history, serverShown, pulled, notAnswered);
        // A rehearsed diary post is not recorded and counts for no daily cap.
        const rehearsedPictures = setDraws ? setDraws.length : parsed.draw ? 1 : 0;
        const rehearsed = diaryPrep
          ? {
              diary: {
                kind: diaryPrep.plan.kind,
                picture: rehearsedPictures > 0,
                search: Boolean(diaryPrep.plan.search),
                messages: parsed.messages.length,
                pictures: rehearsedPictures,
              },
            }
          : {};
        return { outcome: 'spoke', mode: finalMode, dryRun: true, ...rehearsed };
      }
      // A skill call is planned (journaled `proposed`, resolved, checked) before anything of the
      // reply is done, and made after it (runCall). With the tool loop (features.coreTools, not a
      // diary post) every call of the answer is, each with its own envelope (planCalls).
      const looping = loopOn && !diaryPrep;
      // Every call of the attempt: its turn (the journal's turn and attempt, else one id per attempt)
      // and its index, counted over every step of the attempt.
      draft.turnKey ??= draft.started ? { turnId: draft.started.turnId, attempt: draft.started.attemptId ?? 1 } : { turnId: randomUUID(), attempt: 1 };
      const envelopeOf = () => {
        const index = draft.callCount ?? 0;
        draft.callCount = index + 1;
        return callEnvelope({ trigger, channel, added, missed, requester: requesterParam, turnId: draft.turnKey.turnId, idempotencyKey: `${draft.turnKey.turnId}.${draft.turnKey.attempt}:${index}`, ownInitiative: Boolean(draft.inner) || draft.ownInitiative === true, chainId: draft.inner?.wake?.chainId ?? null });
      };
      const callPlan = parsed.call && !looping
        ? await planCall({ call: parsed.call, channel, envelope: envelopeOf(), draft, view: callView({ channel, guildId, idByIndex, lines, pulledIds, memoryOn, channelHandles, memberHandles: handles, trigger, deletedIds: draft.deletedIds }) })
        : null;
      const loopPlans = looping && parsed.calls.length > 0
        ? await planCalls({ calls: parsed.calls, channel, draft, view: callView({ channel, guildId, idByIndex, lines, pulledIds, memoryOn, channelHandles, memberHandles: handles, trigger, deletedIds: draft.deletedIds }), envelopeOf })
        : [];
      // A set's pictures are generated before anything of the post is sent, and counted
      // against the day's diary pictures as they were paid for, posted or not.
      let set = null;
      if (setDraws) {
        // Nothing is paid for pictures their publication may not have (`message.create`, checkEffect).
        const allowed = checkEffect('message.create', sendArgs({ media: imageFileName(null) }), { channel, trigger });
        if (!allowed.ok) return { outcome: 'refused', mode: finalMode, reason: allowed.code };
        const pictures = await generateSet({ channel, draws: setDraws, selfName, minPosted: setMinPosted });
        if (pictures.length > 0) {
          bumpDaily(store.state.data, DIARY_PICTURES_DAILY, now, pictures.length);
          store.state.markDirty();
        }
        if (pictures.length < setMinPosted) return setShort(pictures.length);
        set = { pictures };
      }
      const actArgs = {
        channel,
        guildId,
        privateChat: isPrivate,
        parsed,
        idByIndex,
        history,
        startedAt,
        mode: finalMode,
        triggerKind,
        trigger,
        selfName,
        ...routing,
        sourceId: isPrivate ? null : (source?.channelId ?? null),
        gifPick: !diaryPrep,
        participation: isPrivate ? null : { descriptions: descriptions ?? null },
        set,
        draft,
      };
      const acted = await act(actArgs);
      // The skill call, after the reply's own effects; its result comes back to the persona in
      // one more request when she needs it (a read, a failure): the same turn continued over the
      // channel as it stands then (followUp). What she answers is acted on like her reply -- over
      // that transcript's numbers when it continued -- with no further call.
      let followed = null;
      let called = null;
      let loopDelivered = false;
      // The calls of the reply and of every later step, run in the turn's context (runCall's).
      const callContext = { channel, trigger, guildId, draft, privateChat: isPrivate, idByIndex, pulledIds, lines, knownNames, directory, handles, channelHandles, inTurn: inTurnTools({ channel, guild: servedGuild, guildId, partner: isPrivate ? partner : null, selfId, selfName, history }) };
      if (loopPlans.length > 0) {
        // The next step's calls, planned over the transcript its request showed (`again`, continuationRequest's routing).
        const planNext = async (calls, again) => {
          const routed = again ?? { idByIndex, lines, pulledIds, handles, channelHandles };
          const plans = await planCalls({ calls, channel, draft, view: callView({ channel, guildId, idByIndex: routed.idByIndex, lines: routed.lines, pulledIds: routed.pulledIds, memoryOn, channelHandles: routed.channelHandles, trigger }), envelopeOf });
          return { plans, context: { ...callContext, idByIndex: routed.idByIndex, lines: routed.lines, pulledIds: routed.pulledIds, handles: routed.handles ?? null, channelHandles: routed.channelHandles ?? null } };
        };
        const looped = await toolLoop({
          plans: loopPlans,
          context: callContext,
          channel,
          guildId,
          draft,
          sentMessages,
          shapeOutput,
          acted,
          actOn: (parsedAgain, again = null) => act({ ...actArgs, parsed: parsedAgain, set: null, ...(again ?? {}) }),
          continuation: { input: requestInput, history, shownLines },
          planNext,
        });
        loopDelivered = looped.delivered;
        followed = mergedAnswers(looped.answers, looped.cutOff);
      } else if (callPlan) {
        called = await runCall(callPlan, { channel, trigger, guildId, draft, privateChat: isPrivate, idByIndex, pulledIds, lines, knownNames, directory, handles, channelHandles });
        if (called.followUp) {
          followed = await followUp({
            called,
            channel,
            guildId,
            draft,
            sentMessages,
            shapeOutput,
            acted,
            act: (parsedAgain, again = null) => act({ ...actArgs, parsed: parsedAgain, set: null, ...(again ?? {}) }),
            continuation: { input: requestInput, history, shownLines },
          });
        }
      }
      // The follow-up was cut off with nothing complete and nothing of the turn reached the chat: a lost answer.
      if (followed?.cutOff === true && acted.delivered !== true) {
        draft.reason = 'cut-off';
        return { outcome: 'error', mode: finalMode, reason: 'cut-off' };
      }
      noteSpokeSaw(channel, history, serverShown, pulled, notAnswered);
      const answeredAll = new Set([...(acted.answered ?? []), ...(followed?.answered ?? [])]);
      stampShownCalls({ shown: serverShown, pulled, answered: answeredAll, exceptId: ownCallId });
      if (draft.started) {
        draft.posted = [...(acted.posts ?? []), ...(followed?.posts ?? [])];
        draft.reactions = [...(acted.reacted ?? []), ...(followed?.reacted ?? [])];
      }
      // The messages its posts replied to, for the end hook (noteTurnEnd), journal or not.
      draft.replyTargets = [...(acted.posts ?? []), ...(followed?.posts ?? [])].map((post) => post?.replyTo).filter((id) => typeof id === 'string' && id);
      // A diary post that reached the chat is recorded and counted.
      const recorded =
        diaryPrep && acted.delivered === true
          ? { diary: recordDiaryPost({ config: hot.config, guildId, now, plan: diaryPrep.plan, parsed, acted, set: Boolean(set) }) }
          : {};
      const callDelivered = loopDelivered || (called?.status === 'ok' && !called.followUp);
      // An inner turn in shadow mode delivers nothing, whatever it proposed.
      const delivered = (acted.delivered === true || followed?.delivered === true || callDelivered) && draft.inner?.shadow !== true;
      const spoke = { outcome: 'spoke', mode: finalMode, delivered, ...recorded, ...(draft.sendFailure ? { partial: true } : {}) };
      if (!acted.drawFailed) return spoke;
      // The same predicate as runTurn's hand-off: an unasked turn notifies right here.
      handOff = asked;
      return { ...spoke, drawFailed: acted.drawFailed };
    } catch (err) {
      if (err === TOO_SLOW) {
        // Past the bar: nothing is posted; `error`, like a failed request (a routed call stays unanswered).
        log.warn('turn: dropped', {
          channel: channel.id,
          mode: turnMode,
          triggerKind: triggerKind ?? null,
          reason: 'too-slow',
          seconds: Math.round((clock() - turnStartedAt) / 100) / 10,
        });
        draft.reason = 'too-slow';
        return { outcome: 'error' };
      }
      if (err instanceof DailyCapError || err instanceof TokenLimitError) {
        log.warn('turn: refused by a safety rail', { channel: channel.id, error: err });
        draft.reason = railReason(err);
        if (err instanceof DailyCapError) draft.limits?.add({ kind: 'daily-cap', where: limitOf(err)?.key ?? 'llm.maxRequestsPerDay' });
        return { outcome: 'refused', limit: limitOf(err) };
      }
      const code = errorCodeOf(err);
      log.error('turn: failed', { channel: channel.id, code, error: err });
      return { outcome: 'error', reason: code };
    } finally {
      draft.mode = turnMode;
      prep.closeAll();
      planner?.abandon('ended');
      stopTyping();
      deadline?.close();
      bar?.close();
      // A turn of a chain, or one that hands its message to a chain, leaves the attention and
      // the notifications to the chain (runChain), which releases them once every part is done.
      if (!owned && !chained) busy.delete(channel.id);
      // A hand-off to the drawFailed turn (or that turn itself) leaves the
      // notifications to runTurn, which fires them once both are done.
      if (!handOff && !holdIdle && !owned && !chained) notifyIdle();
    }
  }

  return {
    runTurn,
    /**
     * Remember which message started the turn that posted each message of `pairs`
     * (`[postedId, triggerId]`, oldest first: src/memory/journal.js#triggerLinks at start), so
     * her lines posted before a restart name their trigger too. A malformed pair is skipped; a
     * link noted since is kept over a seeded one.
     * @param {Array<[string, string]>} pairs
     */
    seedTriggerLinks: (pairs) => {
      for (const pair of Array.isArray(pairs) ? pairs : []) {
        if (!Array.isArray(pair) || triggerLinks.has(pair[0])) continue;
        noteTrigger(pair[0], pair[1]);
      }
    },
    /**
     * Remember the persona's skill calls from before a restart (src/memory/journal.js#callMarks at
     * start: `calls` oldest first, `postedFrom` pairs), so her lines keep showing them -- a call
     * that did not work with why (its `code` and `reason` through outcomeDetail). They go
     * before the calls noted since; a post noted since keeps its channel.
     * @param {{ calls?: object[], postedFrom?: Array<[string, string]> }} marks
     */
    seedCallMarks: (marks) => {
      // A call that did not work keeps why (its journaled code and reason, outcomeDetail).
      const seeded = (Array.isArray(marks?.calls) ? marks.calls : [])
        .filter((mark) => mark && typeof mark === 'object')
        .map((mark) => (mark.detail ? mark : { ...mark, detail: outcomeDetail(mark) }));
      callMarks.unshift(...seeded.slice(-CALL_MARKS_MAX));
      if (callMarks.length > CALL_MARKS_MAX) callMarks.splice(0, callMarks.length - CALL_MARKS_MAX);
      for (const pair of Array.isArray(marks?.postedFrom) ? marks.postedFrom : []) {
        if (!Array.isArray(pair) || postedFromLinks.has(pair[0])) continue;
        notePostedFrom(pair[0], pair[1]);
      }
    },
    /**
     * The parts of the chain running in `channelId` not started yet, when its message is
     * `authorId`'s: `{ index, text }` in order (1-based indices). Empty otherwise. Read only.
     * @param {string} channelId
     * @param {string} authorId
     * @returns {{ index: number, text: string }[]}
     */
    waitingParts: (channelId, authorId) => {
      const chain = chains.get(channelId);
      if (!chain || chain.authorId !== authorId) return [];
      return chain.parts.map((text, i) => ({ index: i + 1, text })).filter(({ index }) => index > chain.next);
    },
    /**
     * Fold `message` (`{ id, text, ts }`) into part `index` of `authorId`'s chain in `channelId`,
     * so that part's request names it (`labels.task.added`). False -- nothing changed -- when no
     * such chain runs or the part has started.
     * @returns {boolean}
     */
    addToPart: (channelId, authorId, index, message) => {
      const chain = chains.get(channelId);
      if (!chain || chain.authorId !== authorId || !(index > chain.next) || index > chain.parts.length) return false;
      chain.added.set(index, [...(chain.added.get(index) ?? []), message]);
      return true;
    },
    isBusy: (channelId) => busy.has(channelId),
    isAnyBusy: () => busy.size > 0,
    /** The ids of the channels a turn is running in now (for log lines: where the attention is). */
    busyChannels: () => [...busy],
    lastPostAt: (channelId) => lastPostAt.get(channelId) ?? 0,
    notePost: (channelId, ts) => lastPostAt.set(channelId, ts),
    /**
     * Whether the last turn that spoke in `channelId` (this process, dry-run included) had
     * `messageId` in its channel history -- so a direct ping queued while that turn ran was
     * already in front of the model and is not answered a second time. For a channel the bot
     * cannot write in: whether the last turn that spoke while showing that channel's lines
     * (`<channel_view>`) showed `messageId`.
     * @param {string} channelId
     * @param {string} messageId
     * @returns {boolean}
     */
    spokeAfterSeeing: (channelId, messageId) => spokeSaw.get(channelId)?.has(messageId) ?? false,
    /**
     * Resolves once no turn is in flight anywhere -- immediately if that is
     * already true. Used by admin.js's `/nep pause` to wait out a turn
     * that was already running when the pause was requested, instead of
     * aborting it.
     * @returns {Promise<void>}
     */
    waitIdle: () => (busy.size === 0 ? Promise.resolve() : new Promise((resolve) => idleWaiters.push(resolve))),
    /** Called (never awaited by runTurn) every time a turn finishes anywhere, once the channel is freed. */
    setOnIdle: (fn) => {
      onIdle = fn;
    },
    noteDeferred,
    /** Called with a deferred call of an inner turn that did not go out (src/behavior/inner.js#noteLateFailure). */
    setOnDeferredFailure: (fn) => {
      onDeferredFailure = fn;
    },
    /**
     * The facts kept for her next request in a conversation (src/behavior/inner.js's `facts`: `enabled`, `add`,
     * `pending`, `markTold`); used while its `enabled()` says so, else the runner keeps its own in process.
     */
    setFactsSource: (source) => {
      factsSource = source ?? null;
    },
    /**
     * Called (never awaited, never thrown into the turn) once every runTurn has ended, with how
     * it ended (noteTurnEnd): src/behavior/missed.js resolves and records from it.
     * @param {(end: object) => void} fn
     */
    setOnTurnEnd: (fn) => {
      onTurnEnd = fn;
    },
    /**
     * The id of the message that started the turn which posted `postedId` (this process, or
     * seeded from the journal at start), or null.
     * @param {string} postedId
     * @returns {string|null}
     */
    triggerOf: (postedId) => triggerLinks.get(postedId) ?? null,
  };
}
