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

import {
  audienceOf,
  canAttach,
  canReact,
  canSend,
  fetchHistory,
  fetchReplyParents,
  fetchNeighbors,
  isWritableChannel,
  withTextPreviews,
} from '../discord/collect.js';
import { audienceAllows, captionPulled, checkPull, fetchPull } from '../discord/pull-fetch.js';
import { block, buildDiaryPlanRequest, buildDrawPrompt, buildRequest, classifierTranscript, fillPromptTemplate, gifFieldChars, stableThenTail, usesFollowUpTask } from './prompt.js';
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
import { classifierTextModel, isTaggedCall } from './mention.js';
import { parseLookupAnswer, recallSettings } from './recall.js';
import { parseSplitAnswer, splitCandidate, splitSettings } from './split.js';
import { captionedEntries, gifPickSettings, parseGifPick, pickCandidates, pickContext, renderGifLibrary } from './gif-pick.js';
import { turnRequestInput } from './turn-input.js';
import { parseJsonObject, parseOutput } from '../llm/parse.js';
import { DailyCapError, REPLY_REQUEST, TokenLimitError, RETRY_STATUS, hedgeSettings, helperRequestOptions, railReason, sleep } from '../llm/openrouter.js';
import { ImageCapError, ImageGenError } from '../llm/images.js';
import { limitOf, mirrorChannelLabel, mirrorDryRun, postLimitNotice } from './limits.js';
import { between, typingMs } from './random.js';
import { settleWait } from './activity.js';
import {
  collectPictures,
  collectEmojiItems,
  collectVideos,
  collectReadableLinks,
  isDescribable,
  lateVideoStates,
  selectPictures,
} from '../discord/media.js';
import { avatarReference, createImageFetcher } from '../discord/fetch-image.js';
import { renderCustomEmoji, resolveReactionEmoji } from '../discord/emoji.js';
import { fill, formatNow, replyMarker } from '../discord/format.js';
import { log } from '../log.js';
import { clampAtBoundary, clampChars, countDashes, oneLine, stripDashes } from '../memory/clamp.js';
import { gifPostsToday } from '../memory/gif-watch.js';
import { linkChannels } from '../memory/mentions.js';
import { rankGifs } from '../memory/gifs.js';
import { liveRecent, recentSettings } from '../memory/recent.js';
import { participationSettings, recordOwnLine } from '../memory/participation.js';
import { createParticipationPicker } from './participation-pick.js';
import { isVideoVisionOn } from '../memory/youtube-check.js';
import { bumpDaily, countToday, utcDay, zonedDay } from '../time.js';
import { isPlainObject } from '../config.js';
import { budgetDrops } from '../llm/budget.js';
import { createLimits } from '../llm/limits.js';

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
 * Why a reply turn runs: a `@mention`, a Discord reply to the persona, a
 * name trigger, a follow-up the address classifier said "yes" to, a line the
 * address classifier found to be about the persona but said to someone else
 * or to the room (`overheard`), a private chat message, or the second turn
 * after a drawing that failed. Each has a `labels.triggers` entry.
 * @typedef {'mention'|'reply'|'name'|'followUp'|'overheard'|'private'|'drawFailed'} TriggerKind
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

/** `mentor.anchor.ledgerSize` when it is missing or unusable: config.json's value. */
const POST_LEDGER_SIZE_FALLBACK = 300;

/**
 * How many entries the post ledger (`state.json` `postLedger`) keeps:
 * `mentor.anchor.ledgerSize` read from `config` (the live config), floored;
 * 0 keeps none; missing or not a non-negative number -> 300 (config.json's value).
 * @param {object} config
 * @returns {number}
 */
export function postLedgerSize(config) {
  const size = config?.mentor?.anchor?.ledgerSize;
  return Number.isFinite(size) && size >= 0 ? Math.floor(size) : POST_LEDGER_SIZE_FALLBACK;
}

/**
 * The post ledger with `entry` appended, cut to its newest `size` entries.
 * The ledger tells the mentor (src/mentor/anchor.js#ledgerEntryFor) which
 * turn a posted message of the persona belonged to. A value that is not a
 * list counts as an empty ledger. Pure: the given list is not changed.
 * @param {unknown} ledger
 * @param {{ messageId: string, channelId: string, mode: string, triggerKind: string|null,
 *   triggerId: string|null, newestHistoryId: string|null, sourceChannelId: string|null, at: number }} entry
 * @param {number} size
 * @returns {object[]}
 */
export function appendPostLedger(ledger, entry, size) {
  if (!(size > 0)) return [];
  const list = Array.isArray(ledger) ? ledger : [];
  return [...list, entry].slice(-size);
}

/** `pace` when a key is missing: config.json's values. */
const PACE_FALLBACK = Object.freeze({ prepareMs: 6000, prepareSearchMs: 12000, prepareMediaMs: 20000, dropAfterMs: 60000, replyHedgeMs: 20000, typingWhilePreparing: false, unpromptedWaits: true, settleMs: 0, settleMaxMs: 15000 });

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

/** The stages of a turn's preparation, in the order `turn: timings` names them. */
const PREPARE_STAGES = Object.freeze(['history', 'previews', 'captions', 'videos', 'rewatch', 'links', 'lookup', 'neighbors', 'pulled', 'participation']);

/**
 * The trigger kinds that are a direct call (a private chat message included): the typing
 * indicator may show while such a turn prepares and waits for its answer, and its preparation
 * keeps the deadline and the bar (see unhurried).
 */
const DIRECT_CALLS = new Set(['mention', 'reply', 'name', 'followUp', 'private']);

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
 * Turn `@nick` written by the model into real mentions for people the request showed: the
 * authors of `history` (the lines shown), then the stored names in `knownNames` (the members
 * whose profile the request showed, the authors of the pulled lines shown). A transcript
 * author wins a name a stored profile shares, the last author of a display name wins, and of
 * two stored profiles sharing a name the first handed over wins. Longer names are matched
 * first, so a multi-word name is never cut at a shorter one it starts with.
 * @param {string} text
 * @param {object[]} history  Normalized lines (`authorName`, `authorId`, `self`, `bot`).
 * @param {Iterable<{ name: string, id: string }>} [knownNames]
 * @returns {{ text: string, userIds: string[] }}  `userIds`: the members pinged (allowedMentions).
 */
export function resolveMentions(text, history, knownNames = []) {
  const people = new Map();
  for (const { name, id } of knownNames) {
    if (typeof name !== 'string' || !name.trim() || id === undefined || id === null || people.has(name)) continue;
    people.set(name, String(id));
  }
  for (const message of history) {
    if (!message.self && !message.bot && message.authorName) people.set(message.authorName, message.authorId);
  }
  const names = [...people.keys()].sort((a, b) => b.length - a.length);
  const userIds = new Set();
  let resolved = text;
  for (const name of names) {
    if (!resolved.includes(`@${name}`)) continue;
    resolved = resolved.replaceAll(`@${name}`, `<@${people.get(name)}>`);
    userIds.add(people.get(name));
  }
  return { text: resolved, userIds: [...userIds] };
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
 * Also used by the mentor's reply sandbox (src/mentor/sandbox.js) with a store-shaped reader.
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
 * null for a chat line.
 * @returns {{ target: object|null, source: string|null, reason: 'not-found'|'cannot-react'|null }}
 */
function reactionChannel(channel, targetId, pulledIds) {
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

const REWATCH_QUESTION_CHARS = 300;
const REWATCH_SUMMARY_CHARS = 200;
// Protocol tokens of the re-watch classifier (docs/en/prompt-contract.md), not wording:
// the kind and status columns of a `<media>` line and the answer that asks for a retry.
const REWATCH_KIND_VIDEO = 'video';
const REWATCH_KIND_PICTURE = 'picture';
// A watched GIF: listed to the classifier as a video (REWATCH_KIND_VIDEO); `gif` is the internal
// candidate kind and the log's code, never written into `<media>`.
const REWATCH_KIND_GIF = 'gif';
const REWATCH_STATUS_WATCHED = 'watched';
const REWATCH_STATUS_NOT_LOADED = 'not loaded';
const REWATCH_STATUS_DESCRIBED = 'described';
const REWATCH_RETRY = /^retry$/i;
// The ordinal column: `<n>`, tolerating a `#` before it or a `.` after it.
const REWATCH_ORDINAL = /^#?\s*(\d+)\.?$/;

/**
 * Parse the re-watch classifier's answer (prompts/rewatch.md): ONE line,
 * `none` or `<n> | <question>` (`<n> | retry` asks to try a video that did
 * not load again), where `<n>` is the 1-based ordinal of a `<media>` line
 * (1 = the first line: the newest video, the pictures after the videos;
 * ordinals, not ids, because the model miscopies long ids).
 * `#1` and `1.` are accepted as `1`. Only the first non-empty line counts;
 * `none` (any case), anything unparsable, an ordinal outside 1..`count` or an
 * empty question -> no pick. The question is trimmed and cut to 300
 * characters; `retry` is true when it is exactly `retry` (any case). The
 * caller maps `n` back to its candidate (`candidates[n - 1]`). `reason` is a
 * code safe to log: `none` (the model answered none), `empty` (no non-empty
 * line), `no-bar`, `unknown-id` (not an ordinal within 1..`count`; the name
 * predates ordinals and is kept for log continuity), `no-question` or `ok`.
 * @param {string} raw
 * @param {number} count  How many lines the `<media>` block listed.
 * @returns {{ pick: { n: number, question: string, retry: boolean }|null,
 *   reason: 'none'|'empty'|'no-bar'|'unknown-id'|'no-question'|'ok' }}
 */
export function parseRewatchPickDetailed(raw, count) {
  const line = String(raw ?? '')
    .split('\n')
    .map((l) => l.trim())
    .find(Boolean);
  if (!line) return { pick: null, reason: 'empty' };
  if (/^none$/i.test(line)) return { pick: null, reason: 'none' };
  const bar = line.indexOf('|');
  if (bar === -1) return { pick: null, reason: 'no-bar' };
  const ordinal = REWATCH_ORDINAL.exec(line.slice(0, bar).trim());
  const n = ordinal ? Number(ordinal[1]) : NaN;
  const question = [...line.slice(bar + 1).trim()].slice(0, REWATCH_QUESTION_CHARS).join('').trim();
  if (!Number.isSafeInteger(n) || n < 1 || n > count) return { pick: null, reason: 'unknown-id' };
  if (!question) return { pick: null, reason: 'no-question' };
  return { pick: { n, question, retry: REWATCH_RETRY.test(question) }, reason: 'ok' };
}

/**
 * The link items of `history` the web lookup may read (src/discord/media.js#collectReadableLinks:
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
 * (src/discord/collect.js#fetchReplyParents): the parent of `trigger` when it lives in this
 * channel, one level of that parent's own parent, and the parents of the last
 * `context.replyParentsFor` lines, at most `context.replyParentsMax` in all, each marked
 * `replyParent: true`. Off with
 * `context.fetchReplyParents` false (a missing key counts as on); `history` as it is then.
 * @param {object} channel
 * @param {object[]} history
 * @param {{ trigger: object|null, selfId: string, config: object }} options
 * @returns {Promise<object[]>}
 */
async function withReplyParents(channel, history, { trigger, selfId, config }) {
  const context = config.context ?? {};
  if (context.fetchReplyParents === false) return history;
  const own = trigger && (!trigger.channelId || trigger.channelId === channel.id) ? trigger : null;
  const parents = await fetchReplyParents(channel, history, {
    trigger: own,
    recent: context.replyParentsFor ?? 3,
    max: context.replyParentsMax ?? 4,
    selfId,
    embedTextChars: config.media?.embedTextChars,
    videoSites: config.media?.video?.sites,
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
 * emoji — see src/discord/media.js#isDescribable) of `history` that are NOT
 * among `picked` (the ones already attached as image_url parts), newest
 * message first — so a per-turn cap spends its budget on what the persona
 * just saw. Pictures (collectPictures) come before that message's emoji.
 *
 * With `includePicked` (features.attachedDescriptions), the attached pictures
 * are candidates too and come FIRST, newest first: they are what the turn is
 * about. A picked `link` thumbnail stays out -- its attached form
 * (frameAttached) never shows a caption, so one would be spent for nothing.
 */
function describableCandidates(history, picked, { includePicked = false } = {}) {
  const pickedIds = new Set(picked.map((p) => p.itemId));
  const out = includePicked ? [...picked].reverse().filter((item) => item.kind !== 'link' && isDescribable(item)) : [];
  for (let i = history.length - 1; i >= 0; i -= 1) {
    for (const item of [...collectPictures(history[i]), ...collectEmojiItems(history[i])]) {
      if (pickedIds.has(item.itemId) || !isDescribable(item)) continue;
      out.push(item);
    }
  }
  return out;
}

/** The picture kinds (src/discord/media.js) that make a direct call's own media something to look at. */
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
 * `guild` the persona may write in (src/discord/collect.js#isWritableChannel:
 * a text channel, not a thread, allowed by `bot.channels`, never the dry-run
 * mirror, its history readable, the bot can send) and not `exceptId` (the
 * channel the words are about). The one copy of the rule: `<senses>` names
 * this channel, and whatever routes a call there asks the same function.
 * @param {object|null} guild  The discord.js guild; none (a private chat) has no destination.
 * @param {object} config      The live config.
 * @param {{ exceptId?: string|null }} [options]
 * @returns {{ channel: object, reason: null } | { channel: null, reason: 'off'|'no-destination' }}
 *   `reason` is resolveDestination's code: `off` with features.elsewhere false, else `no-destination`.
 */
export function usableDestination(guild, config, { exceptId = null } = {}) {
  const channelOf = (id) => guild?.channels?.cache?.get?.(id) ?? null;
  const usable = (id) => {
    const target = channelOf(id);
    return Boolean(target) && id !== exceptId && typeof target.isTextBased === 'function' && isWritableChannel(target, config?.bot ?? {});
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
 * src/discord/pull-fetch.js#audienceAllows). The one copy of the route of a
 * routed call and of a noticed comment.
 * @param {object} source  A discord.js guild channel.
 * @param {object} config  The live config.
 * @returns {{ destination: object, reason: null } | { destination: null, reason: 'off'|'no-destination'|'audience' }}
 */
export function routeFor(source, config) {
  const { channel: destination, reason } = usableDestination(source.guild, config, { exceptId: source.id });
  if (!destination) return { destination: null, reason };
  if (!audienceAllows(destination, source, config)) return { destination: null, reason: 'audience' };
  return { destination, reason: null };
}

/** The mode a journal's `turn.start` names: a follow-up or an overheard line by its kind, else the turn's mode. */
function journalMode(mode, triggerKind) {
  return triggerKind === 'followUp' || triggerKind === 'overheard' ? triggerKind : (mode ?? null);
}

/** A journal operation that writes nothing: an attempt the journal does not follow. */
const NO_OP = Object.freeze({
  opId: null,
  started: async () => {},
  succeeded: async () => {},
  failed: async () => {},
  unknown: async () => {},
});

/**
 * How a Discord call that threw closes its journal operation: refused by Discord (an HTTP 4xx
 * answer) is `failed` with `http-<status>`; anything else (a network error, a timeout, a 5xx)
 * may have taken effect anyway, so its outcome is `unknown` (the restart's reconciliation looks
 * for a post; nothing is ever sent again).
 */
function closeThrown(op, err) {
  const status = err?.status ?? err?.statusCode;
  if (Number.isInteger(status) && status >= 400 && status < 500) return op.failed(`http-${status}`);
  return op.unknown();
}

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
    op.failed('error');
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

/** The journal's usage of the reply request: the whole prompt, its cached part, the completion (null when unreported). */
function journalUsage(completion) {
  const usage = completion?.usage ?? {};
  const count = (value) => (Number.isFinite(value) ? value : null);
  return {
    prompt: count(completion?.promptTokens) ?? count(usage.prompt_tokens),
    cached: count(usage.prompt_tokens_details?.cached_tokens),
    completion: count(usage.completion_tokens),
  };
}

/**
 * One attempt's `turn` record (src/memory/journal.js) from what the attempt noted in its
 * draft and the result it returned: `reason` is the attempt's skip or refusal code, else null.
 */
function journalTurnRecord(draft, result) {
  const seen = draft.seen ?? { messageIds: [], parents: [], parts: { images: [], filePreviews: [] } };
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
  };
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
 * the seen-in-history rule holds for it, as before. `input` is null when
 * there is nothing to say.
 * @returns {{ input: { part: object|null, queued: string[], queuedOthers: { author: string, text: string }[],
 *   added: string[] }|null, deferred: Set<string> }}
 */
function taskInput({ part, queued, added, labels, channelId }) {
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
  if (!part && waiting.length === 0 && addedTexts.length === 0) return { input: null, deferred };
  return {
    input: {
      part: part ?? null,
      queued: own.map((call) => call.text),
      queuedOthers: others.map((call) => ({ author: call.author, text: call.text })),
      added: addedTexts,
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
 * the search classifier, the daily GIF counter, every `lastPostAt` stamp and
 * the post ledger's times.
 *
 * With features.mentor true every message, GIF and picture a turn posts in a
 * server channel is recorded in `state.json` `postLedger` (recordPost; at
 * most `mentor.anchor.ledgerSize`, nothing while paused or in a dry run): `{
 * messageId, channelId, mode, triggerKind, triggerId, newestHistoryId,
 * sourceChannelId, at }`, read by src/mentor/anchor.js#ledgerEntryFor.
 *
 * `emoji` (src/discord/emoji.js#createEmojiIndex) is optional: absent, or
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
 * fresh ones only once the turn is certain to run (src/discord/pull-fetch.js).
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
 * `activity` (src/behavior/activity.js#createActivity, fed by src/discord/events.js; optional)
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
}) {
  const busy = new Set();
  // channelId -> the chain of parts running there (runChain): its author, its parts, the part
  // in progress (`next`, 1-based; 0 before the first) and the messages folded into a later part.
  const chains = new Map();
  const lastPostAt = new Map(); // channelId -> ts of the persona's last message
  let onIdle = null; // set via setOnIdle(); see the finally block of runTurn below
  let idleWaiters = []; // resolvers for waitIdle() (/nep pause), notified once busy.size hits 0
  // channelId -> ids of the messages in the history of the last turn that spoke there; for a
  // channel the bot cannot write in, the lines its `<channel_view>` block showed in the last
  // turn that spoke anywhere while showing it (noteSpokeSaw). The pending-ping drain
  // (src/discord/events.js) skips a ping such a turn already had in view.
  const spokeSaw = new Map();
  // Whether the last turn that wanted prompts['follow-up'] found it missing or blank: `turn:
  // prompt missing` is warned once each time this turns true (the turn falls back to reply.md).
  let followUpPromptMissing = false;
  // The participation pick classifier (src/behavior/participation-pick.js): which stored
  // exchanges of other channels a turn's `<participation>` block shows first.
  const pickParticipation = createParticipationPicker({ hot, store, llm, now: clock });

  /** Whether the journal is written now: one injected and features.journal exactly true (read now). */
  function journalOn() {
    return Boolean(journal) && hot.config.features?.journal === true;
  }

  /** The turn records of runTurn's attempts, in order; a failed append is the journal's to log. */
  async function writeTurnRecords(attempts) {
    for (const { draft, result } of attempts) {
      await journal.turn(draft.guildId, journalTurnRecord(draft, result));
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
    return {
      ...handle,
      started: (extra) => {
        if (!actions.includes(handle.opId)) actions.push(handle.opId);
        return handle.started(extra);
      },
    };
  }

  /**
   * `text` with every `#name` of one of the guild's text channels turned into its `<#id>` link
   * (src/memory/mentions.js#linkChannels): features.channelLinks on (read now; a missing key counts
   * as on) and a guild channel -- a private chat has no guild, its text is returned as is.
   */
  function withChannelLinks(channel, text) {
    if (hot.config.features?.channelLinks === false) return text;
    const cache = channel?.guild?.channels?.cache;
    if (!cache || typeof cache.values !== 'function') return text;
    const channels = [];
    for (const ch of cache.values()) {
      const textBased = typeof ch?.isTextBased === 'function' ? ch.isTextBased() : ch?.type === 0;
      if (textBased) channels.push({ id: ch.id, name: ch.name });
    }
    return linkChannels(text, channels);
  }

  /** The custom emoji lookup, or null when there is no index or features.customEmoji is off (read now). */
  function emojiLookup() {
    return emoji && hot.config.features?.customEmoji !== false ? emoji.byName : null;
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
   * where the bot cannot send. A failed send logs `turn: typing failed` and
   * changes nothing else.
   * @returns {() => void}  Stops the indicator's refresh.
   */
  function typingWhilePreparing(channel, triggerKind, config) {
    const off = () => {};
    if (!DIRECT_CALLS.has(triggerKind) || config.features?.typingSimulation === false) return off;
    if (!paceSettings(config).typingWhilePreparing || hot.config.features?.dryRun === true) return off;
    let sendable = false;
    try {
      sendable = typeof channel.sendTyping === 'function' && canSend(channel);
    } catch {
      sendable = false;
    }
    if (!sendable) return off;
    let stopped = false;
    let cancel = null;
    const send = () => {
      cancel = null;
      if (stopped) return;
      Promise.resolve()
        .then(() => channel.sendTyping())
        .catch((err) => log.warn('turn: typing failed', { channel: channel.id, preparing: true, error: err }));
      cancel = schedule(send, PREPARE_TYPING_REFRESH_MS);
    };
    send();
    return () => {
      stopped = true;
      cancel?.();
      cancel = null;
    };
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
   *   lines: object[], knownNames: { name: string, id: string }[], linkFor: (pulledId: string|null) => string|null,
   *   part?: { index: number, total: number }|null, setDraws?: object[]|null }} args
   *   `setDraws`: a diary set's drawings (in place of `parsed.draw`), each logged
   *   `dry-run: would draw` with `set: true` and mirrored with its place in the set.
   *   `plain`: the turn quotes no chat line (postsPlain); `lines`: the lines shown of the pulled
   *   channels, then this chat's history (names and authors); `knownNames`: the stored names
   *   `@name` resolves by too (storedNames).
   */
  async function dryAct({ channel, guildId, parsed, idByIndex, history = [], mode, triggerKind, trigger = null, plain, selfName, pulledIds, lines, knownNames, linkFor, part = null, gifPick = true, setDraws = null, draft = null }) {
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
      const route = reactionChannel(channel, targetId, pulledIds);
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
      const text = withLink(withChannelLinks(channel, renderCustomEmoji(resolveMentions(message.text, lines, knownNames).text, emojiLookup())), link, labels, draft?.limits);
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
   * The image prompt for `draw` (parsed.draw): prompts read now, the request clamped to
   * image.maxPromptChars, the local date and time now (`bot.timezone`, read now) as its
   * `{{when}}` -- every picture, so its light and season follow the clock.
   */
  function drawPromptFor(selfName, draw) {
    return buildDrawPrompt(drawPromptArgs(selfName, draw));
  }

  /** What drawPromptFor fills draw.md with, read now. */
  function drawPromptArgs(selfName, draw) {
    const timezone = hot.config.bot?.timezone;
    return {
      prompts: hot.prompts,
      selfName,
      request: clampAtBoundary(draw.text, hot.config.image?.maxPromptChars),
      self: draw.self === true,
      when: timezone ? formatNow(clock(), timezone, hot.prompts?.labels?.locale) : '',
    };
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
   * then one generation and one upload. No typing indicator while it works.
   * Resolves `{ posted: true, pulledId, message }` when posted (`pulledId`: the pulled
   * line it answers, or null; `message`: what channel.send resolved), `{ drawFailed: reason }`
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
   */
  async function draw({ channel, parsed, idByIndex, pulledIds, linkFor, trigger, triggerKind, plain, selfName, sourceId = null, draft = null }) {
    const config = hot.config;
    const self = parsed.draw.self === true;
    const prompt = drawPromptFor(selfName, parsed.draw);
    const asked = askedFor(trigger, triggerKind);
    // The journal: the picture is one operation from its generation to its post.
    const op = journalOp(draft, 'draw', 'persona', { input: { self } });
    let sending = false;
    if (op.opId) await op.started();
    try {
      let reference = null;
      if (self && config.image?.reference === 'avatar') {
        reference = await avatarReference({ client, imageFetcher, config });
        if (!reference) log.warn('turn: avatar reference unavailable', { channel: channel.id });
      }

      const picture = await images.generate({ prompt, reference, userId: asked ? (trigger.authorId ?? null) : null });
      const { replyId, pulledId } = replyTarget(parsed.draw.replyTo, { plain, idByIndex, pulledIds });
      const link = linkFor(pulledId);
      sending = true;
      const message = await channel.send({
        ...(link ? { content: link } : {}),
        files: [{ attachment: picture.buffer, name: imageFileName(picture.mediaType) }],
        reply: replyId ? { messageReference: replyId, failIfNotExists: false } : undefined,
        allowedMentions: { parse: [] },
      });
      sending = false;
      if (op.opId) await op.succeeded({ messageId: message?.id ?? null, bytes: picture.buffer?.length ?? 0 });
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
      if (op.opId) {
        if (sending) await closeThrown(op, err);
        else await op.failed(err instanceof ImageCapError ? 'image-cap' : err instanceof ImageGenError ? (err.reason ?? 'error') : 'error');
      }
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
    const config = hot.config;
    const pictures = [];
    let reference;
    for (const [index, drawn] of draws.entries()) {
      if (pictures.length + (draws.length - index) < minPosted) break;
      const self = drawn.self === true;
      try {
        if (self && config.image?.reference === 'avatar' && reference === undefined) {
          reference = await avatarReference({ client, imageFetcher, config });
          if (!reference) log.warn('turn: avatar reference unavailable', { channel: channel.id });
        }
        const prompt = drawPromptFor(selfName, drawn);
        const picture = await images.generate({ prompt, reference: self ? (reference ?? null) : null, userId: null });
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
    bumpDaily(store.state.data, { dayKey: 'gifDay', countKey: 'gifCount' }, clock());
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
    if (!entry.messageId) return null;
    try {
      const source = entry.channelId && entry.channelId !== channel.id ? await client.channels.fetch(entry.channelId) : channel;
      const message = await source?.messages?.fetch(entry.messageId);
      const own = message?.attachments?.get?.(entry.itemId);
      if (own?.url) return own.url;
      for (const snapshot of message?.messageSnapshots?.values?.() ?? []) {
        const forwarded = snapshot?.attachments?.get?.(entry.itemId);
        if (forwarded?.url) return forwarded.url;
      }
      return null;
    } catch (err) {
      log.warn('turn: gif refetch failed', { channel: channel.id, gif: entry.id, error: err });
      return null;
    }
  }

  /**
   * Post the persona's GIF (after its messages, or in place of the first one
   * when the GIF picker chose it): a link GIF as its stored
   * URL (Discord embeds tenor/giphy links), an attached one as a fresh URL of
   * its attachment, the stored one when that fails. Counted against
   * `gifs.maxPerDay` once sent, and stamped on its library entry of
   * `guildId` (store.recordOwnGif: `ownLast`/`ownUses`, the `<gifs>` list's
   * own-post mark). Never throws; resolves what channel.send resolved (an
   * object, `{}` when it resolved nothing) once sent, else null.
   * `replyId`: the chat line it quotes as a Discord reply (replyTarget), or
   * null; `link`: the jump link it carries after its URL (withLink, so the
   * URL comes first and still embeds), or null.
   * @returns {Promise<object|null>}
   */
  async function postGif(channel, guildId, gif, replyId, link, op = NO_OP) {
    const { entry } = gif;
    let sending = false;
    try {
      const fresh = entry.kind === 'attachment' ? await freshAttachmentUrl(channel, entry) : null;
      sending = true;
      const message = await channel.send({
        content: withLink(fresh ?? entry.url, link, hot.prompts?.labels),
        reply: replyId ? { messageReference: replyId, failIfNotExists: false } : undefined,
        allowedMentions: { parse: [] },
      });
      sending = false;
      if (op.opId) await op.succeeded({ messageId: message?.id ?? null });
      countGif();
      if (entry.key && typeof store.recordOwnGif === 'function') store.recordOwnGif(guildId, entry.key, clock());
      lastPostAt.set(channel.id, clock());
      log.info('turn: gif sent', { channel: channel.id, gif: entry.id, kind: entry.kind, fresh: Boolean(fresh), ...(link ? { link: true } : {}) });
      return message ?? {};
    } catch (err) {
      if (op.opId) await (sending ? closeThrown(op, err) : op.failed('error'));
      log.warn('turn: gif failed', { channel: channel.id, gif: entry.id, error: err });
      return null;
    }
  }

  /**
   * Record one message the persona posted in the post ledger (`state.json`
   * `postLedger`, appendPostLedger, capped at postLedgerSize): `post` (the
   * turn's mode, trigger kind and id, the newest line of its history, its
   * source channel) with the posted message's id and the time. Only with
   * features.mentor true (read now, like the size), never while paused (the
   * owner may be editing data/), never without a message id; marks the state
   * dirty. The mentor reads it to replay a moment as the turn it was.
   */
  function recordPost(sent, post) {
    if (hot.config.features?.mentor !== true) return;
    const data = store.state.data;
    const messageId = sent?.id;
    if (data.paused || typeof messageId !== 'string' || !messageId) return;
    data.postLedger = appendPostLedger(data.postLedger, { messageId, ...post, at: clock() }, postLedgerSize(hot.config));
    store.state.markDirty();
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
   * (role `classifier.text`, purpose `gif-pick`, its answer capped at
   * `gifs.pick.maxOutputTokens`): system = the prompt with `{{name}}`, user =
   * `<gifs>` (renderGifLibrary over the WHOLE library in rank order, own-marked entries last,
   * `gifs.reactionChars`, `gifs.actionChars` and `gifs.ownMarkHours` read now: the stable bulk first,
   * for the provider's prompt cache), `<context>` (pickContext: the last `gifs.pick.contextMessages` lines of
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
    const mediaCache = typeof store.getMediaCache === 'function' ? (store.getMediaCache(guildId) ?? null) : null;
    const listed = captionedEntries(rankGifs(store.getGifs(guildId), gifsCfg.halfLifeDays ?? 30), mediaCache, chars.actionChars);
    const labels = hot.prompts?.labels;
    const library = renderGifLibrary(listed, mediaCache, labels, { now: clock(), ownMarkHours: gifsCfg.ownMarkHours ?? 24, ...chars });
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
    let completion;
    try {
      completion = await llm.complete(
        [
          { role: 'system', content: fillPromptTemplate(prompt, { name: selfName ?? '' }) },
          { role: 'user', content: stableThenTail(block('gifs', library.join('\n')), [block('context', contextBody), block('reply', replyBody)], '\n\n') },
        ],
        {
          model: classifierTextModel(config),
          ...helperRequestOptions(config, { role: 'classifier.text', maxOutputTokens: settings.maxOutputTokens, purpose: 'gif-pick' }),
        },
      );
    } catch (err) {
      log.warn('gifs: pick failed', { channel: channelId, reason: railReason(err), status: err?.statusCode ?? null });
      return null;
    }
    const handle = parseGifPick(completion?.text, listed.map((entry) => entry.id));
    log.info('gifs: picked', { channel: channelId, handle: handle !== null, library: library.length });
    if (handle === null) return null;
    return resolveGif(guildId, { id: handle, replyTo: first.replyTo ?? null }, channelId);
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
   * before it.
   *
   * In a server channel every posted message, GIF and picture is recorded in
   * the post ledger (recordPost) with `mode`, the trigger, the newest line of
   * `history` and `sourceId`.
   *
   * The messages are posted as the model wrote them: nothing rewrites them.
   * A member with pings off (store.isPingsOff) is mentioned and replied to
   * without a notification: only allowedMentions changes, never the text.
   * After the reactions, the GIF picker (pickGif) runs alongside the first
   * message's typing imitation: both start together, the first message waits
   * for both; a GIF it picks is posted in place of the first message (that
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
   *   `knownNames`: the stored names `@name` resolves by too (storedNames);
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
   * posted, in order), `texts` (the messages posted, as the persona wrote them), `drew` (the
   * picture was posted) and `drawFailed` when the picture failed; with a `set`, `setPictures`
   * (the pictures posted) and `setScene` (the scene of the first one posted).
   */
  async function act({ channel, guildId, privateChat, parsed, idByIndex, history, startedAt, mode, triggerKind, plain, trigger, selfName, pulledIds, lines, knownNames, linkFor, sourceId, gifPick = true, participation = null, set = null, draft = null }) {
    const cfg = hot.config.typing;
    const typingOn = hot.config.features?.typingSimulation !== false;
    // The typing imitation of one message: the indicator, then the time its text takes to type.
    const typeFor = async (spoken) => {
      // Only the indicator: a missing Send Messages shows up here first, so it is logged.
      await channel.sendTyping().catch((err) => log.warn('turn: typing failed', { channel: channel.id, error: err }));
      await sleep(typingMs(spoken, cfg, rng));
    };
    // Whether anything reached the chat (the caller of a routed turn marks its call by it), and
    // the pulled lines it answered (the ring of calls marks them by it).
    let delivered = false;
    const answered = new Set();
    // What the post ledger records of each post of this turn (server channels only).
    const ledgerPost = privateChat
      ? null
      : {
          channelId: channel.id,
          mode,
          triggerKind: triggerKind ?? null,
          triggerId: trigger?.id ?? null,
          newestHistoryId: history.at(-1)?.id ?? null,
          sourceChannelId: sourceId ?? null,
        };
    const record = (sent) => {
      if (ledgerPost) recordPost(sent, ledgerPost);
    };
    // For the journal: every post that reached the chat with the message it answers, every
    // reaction put with its target, each with the operation that made it (journalOp).
    const posts = [];
    const reacted = [];
    const opField = (op) => (op?.opId ? { opId: op.opId } : {});
    const notePost = (sent, replyTo = null, op = null) => {
      if (typeof sent?.id === 'string' && sent.id) posts.push({ ...opField(op), messageId: sent.id, replyTo: replyTo ?? null });
    };

    for (const reaction of parsed.reactions) {
      const targetId = idByIndex.get(reaction.to);
      if (!targetId) continue;
      const route = reactionChannel(channel, targetId, pulledIds);
      if (!route.target) {
        log.info('turn: reaction dropped', { channel: channel.id, source: route.source, reason: route.reason });
        continue;
      }
      if (typingOn) await sleep(between(cfg.reactionDelayMs, rng));
      const op = journalOp(draft, 'react', 'persona', { input: { to: targetId, emoji: reaction.emoji }, sourceMessageIds: [targetId] });
      if (op.opId) await op.started();
      try {
        const target = await route.target.messages.fetch(targetId);
        await target.react(reaction.emoji);
        delivered = true;
        reacted.push({ ...opField(op), to: targetId, emoji: reaction.emoji });
        if (route.source) answered.add(targetId);
        if (op.opId) await op.succeeded({ to: targetId, emoji: reaction.emoji });
      } catch (err) {
        if (op.opId) await closeThrown(op, err);
        log.warn('turn: reaction failed', { channel: channel.id, ...(route.source ? { source: route.source } : {}), emoji: reaction.emoji, error: err });
      }
    }

    // Each posted message as the next fetchHistory will normalize it (its own id and time, the
    // persona's text as written).
    const ownPosted = [];
    // The texts posted, as the persona wrote them.
    const postedTexts = [];
    let sendFailed = false;
    // The GIF picker starts first (its request is sent at once), then the first message's typing.
    const picking = gifPick
      ? pickGifSafely({ channelId: channel.id, guildId, messages: parsed.messages, gif: parsed.gif, history, selfName, idByIndex, trigger })
      : Promise.resolve(null);
    if (typingOn && parsed.messages.length > 0) {
      const first = renderCustomEmoji(resolveMentions(parsed.messages[0].text, lines, knownNames).text, emojiLookup());
      await typeFor(first);
    }
    const picked = await picking;
    // One GIF post (the turn's own or the picked one), recorded like a message.
    const sendGif = async (gif) => {
      const { replyId, pulledId } = replyTarget(gif.replyTo, { plain, idByIndex, pulledIds });
      const op = journalOp(draft, 'gif', 'persona', { input: { gif: gif.entry?.id ?? null }, sourceMessageIds: replyId ? [replyId] : [] });
      if (op.opId) await op.started();
      const sent = await postGif(channel, guildId, gif, replyId, linkFor(pulledId), op);
      if (sent) {
        delivered = true;
        if (pulledId) answered.add(pulledId);
        record(sent);
        notePost(sent, replyId, op);
      }
      return sent;
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
    for (const [index, message] of messages.entries()) {
      if (!typedAbove(index) && typingOn) await sleep(between(cfg.betweenMessagesMs, rng));

      const { replyId, pulledId } = replyTarget(message.replyTo, { plain, idByIndex, pulledIds });
      const link = linkFor(pulledId);
      const mentioned = resolveMentions(message.text, lines, knownNames);
      const { userIds } = mentioned;
      const repliedAuthorId = replyId ? (lines.find((line) => line.id === replyId)?.authorId ?? (trigger?.id === replyId ? trigger.authorId : null)) : null;
      // Custom emoji after the mentions: `<@id>` has no `:name:` in it to break.
      const spoken = renderCustomEmoji(mentioned.text, emojiLookup());
      // Channel links on the text sent; the typing time stays on the text as written.
      const text = withLink(withChannelLinks(channel, spoken), link, hot.prompts?.labels, draft?.limits);
      // The first message was typed alongside the GIF picker, above.
      if (typingOn && !typedAbove(index)) await typeFor(spoken);

      // The journal: the post's operation, with what the reconciliation after a restart looks for.
      const op = journalOp(draft, 'post', 'persona', {
        intent: { replyTo: replyId, text },
        participants: repliedAuthorId ? [repliedAuthorId] : [],
        sourceMessageIds: replyId ? [replyId] : [],
      });
      if (op.opId) await op.started();
      let posted;
      try {
        posted = await channel.send({
          content: text,
          reply: replyId ? { messageReference: replyId, failIfNotExists: false } : undefined,
          allowedMentions: { parse: [], users: userIds.filter((id) => !pingsOff(id)), repliedUser: !pingsOff(repliedAuthorId) },
        });
      } catch (err) {
        if (op.opId) await closeThrown(op, err);
        log.warn('turn: send failed', { channel: channel.id, index: replaced ? index + 1 : index, error: err });
        sendFailed = true;
        break;
      }
      if (op.opId) await op.succeeded({ messageId: posted?.id ?? null });
      delivered = true;
      if (pulledId) answered.add(pulledId);
      lastPostAt.set(channel.id, clock());
      record(posted);
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
    const posted = { messageIds, texts: postedTexts, drew: false, posts, reacted };
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
        const op = journalOp(draft, 'draw', 'persona', { input: { set: true, pictures: chunk.length } });
        if (op.opId) await op.started();
        try {
          message = await channel.send({
            files: chunk.map((picture) => ({ attachment: picture.buffer, name: imageFileName(picture.mediaType) })),
            allowedMentions: { parse: [] },
          });
        } catch (err) {
          if (op.opId) await closeThrown(op, err);
          log.warn('turn: send failed', { channel: channel.id, index: messages.length + index, set: true, error: err });
          break;
        }
        if (op.opId) await op.succeeded({ messageId: message?.id ?? null, bytes });
        delivered = true;
        lastPostAt.set(channel.id, clock());
        record(message);
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
    const drawn = await draw({ channel, parsed, idByIndex, pulledIds, linkFor, trigger, triggerKind, plain, selfName, sourceId, draft });
    if (drawn.posted === true) {
      if (drawn.pulledId) answered.add(drawn.pulledId);
      record(drawn.message);
      notePost(drawn.message, drawn.replyId, drawn.op);
      if (typeof drawn.message?.id === 'string' && drawn.message.id) messageIds.push(drawn.message.id);
      posted.drew = true;
    }
    return { delivered: delivered || drawn.posted === true, answered, ...posted, ...(drawn.drawFailed ? { drawFailed: drawn.drawFailed } : {}) };
  }

  /**
   * The `<transcript>` block of a classifier request (re-watch, search): the
   * last `contextMessages` messages of `history` before the trigger, rendered
   * by src/behavior/prompt.js#classifierTranscript (as the route classifier's)
   * with the media states this turn already has, plus the trigger's text cut to
   * `context.maxMessageChars`. `transcriptBlock` is '' (no block) for a
   * window of 0 or no earlier message.
   * @returns {{ triggerText: string, transcriptBlock: string }}
   */
  function classifierContext({ config, selfName, history, trigger, contextMessages, descriptions, videos, reads }) {
    const triggerText = [...String(trigger.content ?? '')].slice(0, config.context?.maxMessageChars ?? 800).join('');
    const context = contextMessages > 0 ? history.filter((m) => m.id !== trigger.id).slice(-contextMessages) : [];
    if (context.length === 0) return { triggerText, transcriptBlock: '' };
    const body = classifierTranscript(context, { config, selfName, labels: hot.prompts.labels, descriptions, videos, reads });
    return { triggerText, transcriptBlock: `<transcript>\n${body}\n</transcript>\n` };
  }

  /**
   * The second look on a question (features.videoRewatch for videos,
   * features.imageRelook for pictures): when the trigger asks about a video
   * watched, or a picture posted, in the last `media.video.rewatch.recentMessages`
   * messages (at most `media.video.rewatch.maxCandidates` of them, the videos
   * first, then the watched GIFs, then the pictures, each newest first), one cheap classifier call
   * (prompts.rewatch, on the classifier model: classifierTextModel --
   * `classifier.text`, else the media model; its answer capped at
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
   * src/discord/media.js#mediaLabelFor). A GIF takes a second-look slot and a
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
      return;
    }
    const system = fillPromptTemplate(prompt, { name: selfName ?? '' });
    const mediaCfg = config.media ?? {};
    const rewatchCfg = mediaCfg.video?.rewatch ?? {};
    const recent = Math.max(0, Math.floor(rewatchCfg.recentMessages ?? 60));
    if (recent === 0) {
      log.info('rewatch: skipped', { channel: channelId, reason: 'no-window' });
      return;
    }
    // `candidates`, `gifs` and `pictures` are each newest first: the videos come first, then the
    // GIFs, and the cap over the merged list keeps the newest of each.
    const maxCandidates = Math.max(1, Math.floor(rewatchCfg.maxCandidates ?? 6));
    const recentIds = new Set(history.slice(-recent).map((m) => m.id));
    const seen = new Set();
    const listed = [];
    for (const item of videoSlot ? candidates : []) {
      if (listed.length >= maxCandidates) break;
      if (seen.has(item.itemId) || !recentIds.has(item.messageId)) continue;
      const state = videos.get(item.itemId)?.state;
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
      return;
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
      const video = videos.get(item.itemId);
      const status = video.state === 'watched' ? REWATCH_STATUS_WATCHED : REWATCH_STATUS_NOT_LOADED;
      const summary = video.state === 'watched' ? [...oneLine(video.text)].slice(0, REWATCH_SUMMARY_CHARS).join('') : '';
      return `${index + 1} | ${kind} | ${oneLine(item.name)} | ${status} | ${summary}`.trimEnd();
    });
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
    const user = `${transcriptBlock}<media>\n${lines.join('\n')}\n</media>\n<candidate>\n${trigger.authorName}: ${triggerText}\n</candidate>`;

    let completion;
    try {
      completion = await llm.complete(
        [
          { role: 'system', content: system },
          { role: 'user', content: user },
        ],
        {
          model: classifierTextModel(config),
          ...helperRequestOptions(config, { role: 'classifier.text', maxOutputTokens: rewatchCfg.classifierMaxOutputTokens ?? 120, purpose: 'rewatch' }),
        },
      );
    } catch (err) {
      log.warn('rewatch: classifier failed', { channel: channelId, status: err.statusCode ?? null, name: err.name });
      return;
    }
    const { pick, reason } = parseRewatchPickDetailed(completion.text, listed.length);
    const entry = pick ? listed[pick.n - 1] : null;
    const item = entry?.item ?? null;
    const isPicture = entry?.kind === REWATCH_KIND_PICTURE;
    const isGif = entry?.kind === REWATCH_KIND_GIF;
    const loaded = item && !isPicture && !isGif ? videos.get(item.itemId).state === 'watched' : false;
    // A retry is for a video that did not load, a question for a watched one, a GIF or a picture; anything else is ignored.
    const usable = Boolean(item) && (isPicture || isGif ? !pick.retry : pick.retry !== loaded);
    const pictureCount = listed.filter((candidate) => candidate.kind === REWATCH_KIND_PICTURE).length;
    const gifCount = listed.filter((candidate) => candidate.kind === REWATCH_KIND_GIF).length;
    const watchedCount = listed.filter((candidate) => candidate.kind === REWATCH_KIND_VIDEO && videos.get(candidate.item.itemId).state === 'watched').length;
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
    if (answer) videos.set(item.itemId, { ...videos.get(item.itemId), answer });
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
   * The searches on a question: the web search (`webOn`: features.webLookup,
   * web.search.enabled, a lookup with `search`) and the search of the
   * server's own history (`serverOn`: recall wired and available, a server
   * turn or a private chat with its `partner`; `guild` is the guild searched,
   * the served one in a private chat). One cheap classifier call (prompts.lookup, `{{name}}` = the
   * persona's display name, `{{today}}` = the injected clock's date
   * `YYYY-MM-DD` in `bot.timezone`, the zone its `when:` range is read in;
   * on classifierTextModel, its answer capped at
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
   * a failed call (`lookup: classifier failed`, `reason: 'empty'`), no
   * search. Its request is a helper's (helperRequestOptions). `onSearch()`
   * is called once the answer asks for a search that runs, before it starts
   * (the turn's deadline grows to pace.prepareSearchMs; until the answer the
   * turn holds its deadline on this call, see createDeadline's `hold`).
   */
  async function maybeLookup({ config, guildId, channel, guild = channel.guild, partner = null, selfId, selfName, history, chatHistory, trigger, descriptions, videos, reads, webOn, serverOn, onSearch, journalStep = null }) {
    const channelId = channel.id;
    const prompt = hot.prompts?.lookup;
    const searchCfg = config.web?.search ?? {};
    let webSkip = null;
    if (webOn) {
      if ((searchCfg.maxPerTurn ?? 1) < 1) webSkip = 'no-slot';
      else if (typeof lookup.hasSearch === 'function' && !lookup.hasSearch()) webSkip = 'no-key';
      else if (typeof lookup.webCapLeft === 'function' && !(lookup.webCapLeft() > 0)) webSkip = 'cap';
    }
    const webCan = webOn && webSkip === null;
    let skip = null;
    if (!prompt) skip = 'no-prompt';
    else if (!webCan && !serverOn) skip = webSkip ?? 'no-search';
    if (skip) {
      log.info('lookup: skipped', { channel: channelId, reason: skip });
      return null;
    }

    // The chat around the question, with the pages this turn already read.
    const { triggerText, transcriptBlock } = classifierContext({
      config,
      selfName,
      history,
      trigger,
      contextMessages: Math.max(0, Math.floor(searchCfg.contextMessages ?? 50)),
      descriptions,
      videos,
      reads,
    });
    const user = `${transcriptBlock}<candidate>\n${trigger.authorName}: ${triggerText}\n</candidate>`;

    // Read once: the request and its empty-answer warning name the same model.
    const model = classifierTextModel(config);
    let completion;
    try {
      completion = await llm.complete(
        [
          { role: 'system', content: fillPromptTemplate(prompt, { today: zonedDay(clock(), config.bot?.timezone), name: selfName ?? '' }) },
          { role: 'user', content: user },
        ],
        { model, ...helperRequestOptions(config, { role: 'classifier.text', maxOutputTokens: searchCfg.classifierMaxOutputTokens ?? 200, purpose: 'lookup' }) },
      );
    } catch (err) {
      log.warn('lookup: classifier failed', { channel: channelId, status: err.statusCode ?? null, name: err.name });
      return null;
    }
    if (!String(completion.text ?? '').trim()) {
      // Nothing at all (typically a reasoning model that spent its whole
      // output cap thinking) is a failed call, not a silent "none".
      log.warn('lookup: classifier failed', { channel: channelId, reason: 'empty', model: model ?? null });
      return null;
    }
    const parsed = parseLookupAnswer(completion.text, { timezone: config.bot?.timezone, now: clock(), maxForms: recallSettings(config)?.maxForms });
    const server = parsed.server;
    // Codes and counts only, never the query, a form or a name.
    log.info('lookup: classified', {
      channel: channelId,
      picked: Boolean(parsed.web || server),
      parse: parsed.reason,
      web: Boolean(parsed.web),
      server: Boolean(server),
      forms: server?.forms.length ?? 0,
      who: server?.who.length ?? 0,
      ranged: Boolean(server && (server.from !== null || server.to !== null)),
    });
    const runWeb = webCan && Boolean(parsed.web);
    const runServer = serverOn && Boolean(server);
    if (!runWeb && !runServer) return null;
    onSearch?.();
    // The journal: each search the answer asks for is an operation of the engine (journalStep).
    const webOp = runWeb ? (journalStep?.('lookup', 'lookup', { input: { query: parsed.web } }) ?? null) : null;
    const recallOp = runServer
      ? (journalStep?.('lookup', 'recall', { input: { forms: server.forms, who: server.who, from: server.from, to: server.to } }, (result) => result.summaryChars > 0 || result.stretch === true) ?? null)
      : null;
    const [webResult, found] = await Promise.all([
      runWeb
        ? settleLookupPart(
            () =>
              journalled(webOp, () => lookup.search(guildId, parsed.web), (result) =>
                result ? { result: { results: Array.isArray(result.sources) ? result.sources.length : 0 }, offered: Boolean(result.text) } : { failed: 'no-result' },
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

  /**
   * The splitter (src/behavior/split.js): whether the call `trigger` holds
   * several requests. One cheap classifier call (`prompt`, prompts/split.md,
   * `{{name}}` = the persona's display name, `{{maxTasks}}` = split.maxTasks;
   * on classifierTextModel, its answer capped at split.maxOutputTokens, a
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
          model: classifierTextModel(config),
          ...helperRequestOptions(config, { role: 'classifier.text', maxOutputTokens: settings.maxOutputTokens, purpose: 'split' }),
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
   * fetchPull (src/discord/pull-fetch.js) that never throws: an unexpected
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

  /** The route hook's channel ids (non-empty strings); a throw (`pull: route failed`) or a non-array answer is []. */
  async function routeIds(args) {
    try {
      const ids = await routeChannels(args);
      return Array.isArray(ids) ? ids.filter((id) => typeof id === 'string' && id !== '') : [];
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
   * (src/discord/pull-fetch.js#audienceAllows, `context.pull.sameAudience`: everyone who can
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
   * (src/discord/collect.js#audienceOf, src/behavior/elsewhere.js#audienceCovers:
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
   * `llm.hedge` hedges `classifier.text`, the hedged call is limited by
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
      const planTimeoutMs = diaryCfg.planTimeoutMs ?? 20000;
      // A hedged plan request gets the plan's own limit, not llm.hedge.timeoutMs.
      const hedge = hedgeSettings(config);
      const planHedge = hedge && hedge.afterMs > 0 && hedge.roles.includes('classifier.text')
        ? { hedge: { afterMs: hedge.afterMs, timeoutMs: planTimeoutMs } }
        : {};
      let completion = null;
      try {
        completion = await llm.complete(request.messages, {
          model: classifierTextModel(config),
          ...helperRequestOptions(config, {
            role: 'classifier.text',
            maxOutputTokens: diaryCfg.planMaxOutputTokens ?? 300,
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
        if (op.opId) await (result ? op.succeeded({ results: Array.isArray(result.sources) ? result.sources.length : 0, delivered: found !== null }) : op.failed('no-result'));
        if (found === null) log.info('diary: search failed', { channel: channel.id, reason: result ? 'nothing' : 'refused' });
      } catch (err) {
        if (op.opId) await op.failed('error');
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
    const diaryCap = config.diary?.maxPicturesPerDay ?? 2;
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
   * left; on a routed turn it reads the source's lines), at most
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
   * source.
   * @returns {Promise<{ pulled: object[], sourceSkip: string|null }>}  The PulledChannel records,
   *   source first; `sourceSkip` is the skip code of a source that could not be pulled.
   */
  async function pullChannels({ channel, guildId, guild = channel.guild, partner = null, history, trigger, candidate = trigger, triggerKind = null, source, selfId, selfName, config, now, certain, drawFailure, labelled }) {
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
    const pullOne = (target) =>
      pullSafely({
        guild,
        guildId,
        channelId: target.channelId,
        destination: channel,
        partner,
        reason: target.reason,
        trigger: target.reason === 'routed' ? trigger : null,
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
    if (typeof routeChannels === 'function' && channelPull && !drawFailure && targets.length < settings.maxChannels) {
      const routedLines = source?.reason === 'routed' ? sourcePulled?.messages : null;
      const ids = await routeIds({ guildId, channel, guild, partner, history: routedLines ?? history, trigger: candidate, triggerKind, selfName, config });
      judging = 'route';
      if (ids.length > 0) targets = targetsWith(ids);
    }
    const fetched = await Promise.all(targets.filter((target) => target.channelId !== sourceTarget?.channelId).map(pullOne));
    logRefused();
    return { pulled: [sourcePulled, ...fetched.map((result) => result.pulled)].filter(Boolean), sourceSkip: null };
  }

  /**
   * Fresh captions (src/discord/pull-fetch.js#captionPulled) for channels
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
   * which its caller (src/discord/events.js) stamps by the turn's outcome.
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
   * @param {'reply'|'interject'|'initiate'|'auto'} params.mode  'auto' lets `chooseMode` pick
   *   between interject/initiate/nothing once the history is known (spontaneous turns).
   * @param {object} [params.trigger]      Normalized message the turn answers (a call, or an
   *   overheard line).
   * @param {TriggerKind} [params.triggerKind]
   * @param {(history: object[], now: number, context: { pulled: object[] }) => string|null} [params.chooseMode]
   *   Called with this channel's history and the channels already pulled for the turn (the
   *   PulledChannel records of src/discord/pull-fetch.js, the source first).
   * @param {{ channelId: string, reason: 'routed'|'noticed' }|null} [params.source]  The channel
   *   this turn is about when it is not `channel` (a call from a channel the bot cannot write in,
   *   a noticed comment): pulled before anything else and shown in `<channel_view>`. When it
   *   cannot be pulled a routed turn ends in `error` (`turn: source unavailable`), a noticed one
   *   in `not-now`. `channel` is where the words go and the one marked busy; the first post
   *   links to the routed call, or to the newest line of the source shown (none when the budget
   *   dropped its block). The drawFailed turn after a failed picture keeps it.
   * @param {object|null} [params.focus]  A normalized message of this chat put to everyone present
   *   (a room question): buildRequest appends `labels.room.focus` to the task.
   * @param {boolean} [params.forced]  True for an owner-forced turn (`/nep interject`, `/nep
   *   initiate`) -- passed straight through to buildRequest, which appends prompts.forced (when
   *   present) to the task text so the model knows `<skip/>` is not the expected outcome this time.
   * @param {(() => { id: string, text: string, author?: string }[])|null} [params.queued]  The calls
   *   still waiting in the queue in this channel (src/discord/events.js), read when the request is
   *   built: the trigger author's own (no `author`) named under `labels.task.queued` (on a part, in
   *   `labels.task.part`'s `{others}`), another member's (`author`: their display name) under
   *   `labels.task.queuedOthers`, so the persona leaves them to their own turns; a call so named is
   *   not counted as answered by this turn (spokeAfterSeeing). Without its label a call is not
   *   named and the old rule holds for it.
   * @param {{ id: string, text: string, ts: number }[]|null} [params.added]  Later messages of the
   *   author folded into this call (src/discord/events.js): `labels.task.added` names them.
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
   *   the caller's limit notice. With the journal on (createTurnRunner's `journal`), a turn that
   *   started there carries its `turnId` and `attemptId` (not a message answered part by part,
   *   whose parts are journalled each as its own turn). A `skip`, or a `spoke`
   *   turn posted for real, stamps the calls of the ring it showed (stampShownCalls) -- every
   *   one but a routed turn's own call, which the caller stamps by this outcome.
   */
  async function runTurn(params) {
    // Every attempt that started in the journal (runTurnOnce), closed here, at the one exit.
    const attempts = [];
    const tracked = { ...params, journalAttempts: attempts };
    try {
      const first = await runTurnOnce({ ...tracked, maySplit: true });
      if (first.outcome === 'split') return await runChain(tracked, first);
      return await answerDrawFailure(tracked, first);
    } finally {
      if (attempts.length > 0) await writeTurnRecords(attempts);
    }
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
          log.error('turn: failed', { channel: channel.id, error: err });
          result = { outcome: 'error' };
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
   * src/discord/events.js's pending-ping drain, wired in src/index.js -- must
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
    }
    return draft.started ? { ...result, turnId: draft.started.turnId, attemptId: draft.started.attemptId } : result;
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
      // running anywhere else, nothing else may start. src/discord/events.js
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
        trigger: trigger ? { kind: triggerKind ?? null, messageId: trigger.id ?? null, authorId: trigger.authorId ?? null } : null,
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
      // The reply request's options (role `voice`, purpose `reply`): with a bar, each attempt's
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
      // (context.fetchReplyParents), prepended as its oldest lines (withReplyParents).
      const rawHistory =
        reuseHistory ??
        (await beforeBar(
          fetchHistory(channel, {
            limit: config.context.channelMessages,
            selfId,
            embedTextChars: config.media?.embedTextChars,
            videoSites: config.media?.video?.sites,
          }).then((lines) => withReplyParents(channel, lines, { trigger, selfId, config })),
        ));
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
      // A diary post plans itself first (prepareDiary), alongside the preparation below; settled
      // into a value or an error so a refusal waits for its turn to be thrown.
      const diaryPending =
        mode === 'diary'
          ? prepareDiary({ config, guildId, channel, selfName, history: rawHistory, now, params: diaryParams, memoryOn, draft }).then(
              (value) => ({ value }),
              (error) => ({ error }),
            )
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
        : pullChannels({ channel, guildId, guild: servedGuild, partner, history, trigger, candidate, triggerKind, source, selfId, selfName, config, now, certain, drawFailure: answersDrawFailure, labelled: pullLabelled })
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

      // Lazy, request-time only (see fetchTextPreview's header comment):
      // never fetched during plain normalization or while just buffered. Read by the
      // transcripts alone: the request's and the two classifiers'.
      const previews = track('previews', () => withTextPreviews(rawHistory, config.media?.filePreviewChars ?? 500, fetchImpl));
      const previewed = () => (previews.done && Array.isArray(previews.value) ? previews.value : rawHistory);

      // Pictures NOT selected to be attached as image_url may still get a
      // helper's caption, newest first, capped at media.maxPerTurn; cached
      // captions are free (see src/memory/describe.js). With
      // features.attachedDescriptions (a missing key counts as on) the
      // attached ones get one too, ahead of the rest, shown next to their
      // attachment marker. Only this channel's pictures are attached, as
      // buildRequest picks them: a routed call's own pictures are captioned
      // with its pulled channel instead.
      let captions = null;
      let captionCandidates = [];
      if (features.mediaDescriptions === true && describer) {
        const visionCfg = config.context.vision ?? {};
        const picked = features.vision !== false ? selectPictures({ trigger, history: rawHistory, visionCfg, now, channelId: channel.id }) : [];
        const includePicked = features.attachedDescriptions !== false;
        captionCandidates = describableCandidates(rawHistory, picked, { includePicked });
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
          journalled(watchOp, () => describer.describeVideos(guildId, candidates, { maxNew: videoCfg.maxPerTurn ?? 1 }), (value) => {
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
      // features.videoRewatch and video vision, pictures under
      // features.imageRelook and features.vision (a missing key counts as on, each), the
      // persona's own posted drawings included.
      // A routed call asks about its source, whose media no turn looks at: the media
      // here belong to another conversation, so nothing is offered or retried.
      // It needs the videos' states and its transcript the file previews; it works on a
      // copy of the states, so a late re-watch never touches what the request was built from.
      const videoRewatchOn = Boolean(videoStage) && features.videoRewatch !== false && typeof describer.rewatchVideo === 'function';
      const imageRelookOn = features.imageRelook !== false && features.vision !== false && typeof describer?.relookImage === 'function';
      // Watched GIFs under features.videoRewatch and video vision (they are watched as clips);
      // the describer's watchedGifs offers none while GIFs are not watched (media.gif.watch).
      const gifRewatchOn =
        isVideoVisionOn(config) && features.videoRewatch !== false && typeof describer?.rewatchGif === 'function' && typeof describer.watchedGifs === 'function';
      if (asked && !answersDrawFailure && (videoRewatchOn || imageRelookOn || gifRewatchOn)) {
        if (routedPull) {
          log.info('rewatch: skipped', { channel: channel.id, reason: 'routed' });
        } else {
          const pictures = imageRelookOn ? relookCandidates(rawHistory) : [];
          const gifItems = gifRewatchOn ? gifRewatchItems(rawHistory) : [];
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
      const webLookupOn = features.webLookup === true && Boolean(lookup);
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
      // The server search is possible this turn (a private chat only on its partner's behalf): the
      // lookup stage runs it and `<senses>` says it exists. Asked once, so both agree.
      const serverOn = (!isPrivate || likeServer) && recallAvailable();
      if (asked && !answersDrawFailure) {
        const webOn = webLookupOn && webCfg.search?.enabled !== false && typeof lookup.search === 'function';
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
                    journalStep: prepStep,
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
              pickParticipation({ guildId, channel, history: rawHistory, trigger: candidate, triggerKind, mode: finalMode, selfName, audience: participationAudienceOf }),
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
      // A text attachment cut at media.filePreviewChars (src/discord/collect.js#withTextPreviews).
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
              ? lateVideoStates(videoCandidates, await videosSoFar(), config.media?.video?.maxPerTurn ?? 1)
              : undefined;
      // A picture's second look on a question (features.imageRelook): rendered under its line.
      const imageAnswers = rewatchStage?.done && rewatchStage.value?.imageAnswers?.size > 0 ? rewatchStage.value.imageAnswers : null;
      const reads = linksStage?.done ? linksStage.value : undefined;
      const lookupResult = lookupStage?.done ? (lookupStage.value ?? null) : null;
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
      const destination = isPrivate ? null : usableDestination(channel.guild, config).channel;
      // `<recent>`: the guild's live recent lines (none: an empty list) and the channels this turn may show them from.
      const recent = memoryOn ? recentInput({ channel, guildId, isPrivate, config, now }) : NO_RECENT;
      // The prompts this request is built from, read once: the task labels below decide what it names.
      const prompts = hot.prompts;
      // A part of a split message, the author's other calls still queued, the messages folded into this one.
      const tasks = taskInput({ part, queued, added, labels: prompts?.labels, channelId: channel.id });
      // What this turn had in view yet does not answer (spokeAfterSeeing): the queued calls it
      // named, and on a part of a split message every line after the message -- a call that came
      // while the chain ran waits for its own turn after the chain.
      const triggerAt = part && trigger ? history.findIndex((m) => m.id === trigger.id) : -1;
      const notAnswered =
        triggerAt === -1 ? tasks.deferred : new Set([...tasks.deferred, ...history.slice(triggerAt + 1).map((m) => m.id)]);
      const guildMemory = memoryOn ? store.getGuild(guildId) : null;
      // Whether the call tags the persona, read as decideMention reads it (events.js decideAndLog):
      // an untagged reply takes the follow-up task (usesFollowUpTask).
      const taggedCall = trigger ? isTaggedCall(trigger, selfId) : null;
      if (usesFollowUpTask({ mode: finalMode, triggerKind, taggedCall, routed: source?.reason === 'routed', privateChat: isPrivate })) {
        const followUpPrompt = prompts?.['follow-up'];
        const missing = !(typeof followUpPrompt === 'string' && followUpPrompt.trim());
        if (missing && !followUpPromptMissing) log.warn('turn: prompt missing', { name: 'follow-up', reason: 'no-prompt', channel: channel.id });
        followUpPromptMissing = missing;
      }
      // Every input named (turnRequestInput throws on one left undefined); null marks an absent one.
      const request = buildRequest(
        turnRequestInput({
          config,
          prompts,
          calibrator,
          mode: finalMode,
          forced: forced || (diaryPrep !== null && diaryParams?.forced === true),
          now,
          selfName,
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
          loreEntries: memoryOn ? store.getLore(guildId) : [],
          currentChannelId: channel.id,
          descriptions: descriptions ?? null,
          neighborDescriptions: neighborDescriptions ?? null,
          videos: videos ?? null,
          imageAnswers,
          reads: reads ?? null,
          lookup: lookupResult ?? null,
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
          // `<channel_view>`: the channels pulled into this turn, the one it is about, the chat
          // line put to the room, where a call from a read-only channel is answered.
          pulled,
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
        }),
      );
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

      // A Discord CDN image the provider cannot fetch must not cost the
      // persona the reply -- the provider's own fetcher gets a 403 from
      // Discord on some CDN hosts, so every image_url part is downloaded HERE
      // and replaced by its data: URL before the model ever sees a Discord
      // URL. Because the transcript text refers to attached pictures by
      // number, a turn where ANY download failed is sent with
      // request.textFallback and NO pictures at all -- simple and always
      // consistent, rather than renumbering around a gap.
      let messages = request.messages;
      const userMessage = messages[1];
      if (Array.isArray(userMessage?.content)) {
        const visionCfg = config.context.vision ?? {};
        let allDownloaded = true;
        const resolvedContent = await beforeBar(
          Promise.all(
            userMessage.content.map(async (part) => {
              if (part.type !== 'image_url') return part;
              const downloaded = await imageFetcher.fetchAsDataUrl(part.image_url.url, {
                maxBytes: visionCfg.maxBytes,
                timeoutMs: visionCfg.fetchTimeoutMs,
              });
              if (!downloaded) {
                allDownloaded = false;
                return part;
              }
              return { type: 'image_url', image_url: { url: downloaded.dataUrl } };
            }),
          ),
        );
        messages = [messages[0], { ...userMessage, content: allDownloaded ? resolvedContent : request.textFallback }];
        if (!allDownloaded && draft.seen) draft.seen = { ...draft.seen, parts: { ...draft.seen.parts, images: [] } };
      }

      let completion;
      const replyStartedAt = clock();
      try {
        completion = await beforeBar(llm.complete(messages, replyOptions()));
      } catch (err) {
        // The bar passed (or no time was left to ask): the turn is dropped, nothing is resent.
        if (err === TOO_SLOW || bar.passed) throw TOO_SLOW;
        // Second line of defence: the picture downloaded fine on our end but
        // the provider still rejects the request for some 4xx reason.
        // request.textFallback is a full re-render of the same user message
        // with every imageAttached/frameAttached tag dropped back to its
        // blind/described form -- resending the ORIGINAL text (still
        // claiming a picture is attached) alongside no actual image would be
        // worse than the error itself.
        // A 408 or 429 (timeout, rate limit, quota) says nothing about the
        // pictures and the client has already retried it (RETRY_STATUS): a
        // resend would only double a doomed request while the persona's one
        // attention waits, so it propagates like any error without pictures.
        const aboutThePictures = err.statusCode >= 400 && err.statusCode < 500 && !RETRY_STATUS.has(err.statusCode);
        if (Array.isArray(request.textFallback) && aboutThePictures) {
          const textOnly = messages.map((m) => (Array.isArray(m.content) ? { ...m, content: request.textFallback } : m));
          if (draft.seen) draft.seen = { ...draft.seen, parts: { ...draft.seen.parts, images: [] } };
          completion = await beforeBar(llm.complete(textOnly, replyOptions()));
        } else {
          throw err;
        }
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

      const parsed = parseOutput(completion.text, { maxDrawChars: hot.config.image?.maxPromptChars, limits: draft.limits });
      // Feature switches drop parts of the model's output before it is acted on.
      if (features.reactions === false) parsed.reactions = [];
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
      if (diaryPrep) {
        // A diary post: no reaction, no GIF, nothing posted as a reply, no link, at most diary.maxMessages.
        parsed.reactions = [];
        parsed.gif = null;
        parsed.messages = parsed.messages
          .map((message) => ({ ...message, replyTo: null, text: stripUrls(message.text) }))
          .filter((message) => message.text !== '')
          .slice(0, Math.max(0, config.diary?.maxMessages ?? 3));
        if (parsed.draw) parsed.draw = { ...parsed.draw, replyTo: null };
      }
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
        parsed.messages.length === 0 && parsed.reactions.length === 0 && parsed.draw === null && parsed.gif === null && !(setDraws?.length > 0);
      // The journal keeps the think (journal.thinkChars); the log then carries its length only.
      if (draft.started) {
        draft.think = parsed.think;
        draft.usage = journalUsage(completion);
      }
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
      });
      // The pulled channels whose block was in the request sent (a skip and a dry run included):
      // their seen marks move to the newest line shown; a block the budget dropped moves none.
      const shownPulled = request.pulledKept ?? [];
      // What a private chat showed of the server stays there: no seen mark, no stamp, no pending ping.
      const serverShown = isPrivate ? [] : shownPulled;
      markPulledSeen(serverShown);
      store.state.data.calibration = calibrator.ratio;
      store.state.markDirty();
      // The calls of the ring this turn showed follow its decision (stampShownCalls), except a
      // routed turn's own call: its caller stamps that one.
      const ownCallId = source?.reason === 'routed' ? (trigger?.id ?? null) : null;

      if (parsed.skip || nothingToDo) {
        stampShownCalls({ shown: serverShown, pulled, answered: new Set(), exceptId: ownCallId });
        return { outcome: 'skip', mode: finalMode };
      }

      const idByIndex = request.idByIndex;
      // The output side of the pulled channels: which line lives where, whose @name resolves,
      // which post carries a jump link (one rule for act and dryAct). Names resolve over the
      // pulled lines the request showed, then this chat's history: resolveMentions keeps the
      // last author of a display name, so a chat author wins a name both share, and nobody the
      // model was not shown (a block the budget dropped) is pinged. The stored names of the
      // members whose profile the request kept and of the pulled lines' authors resolve too,
      // behind every display name: a pulled line fetched without its member carries the global
      // name while `<people>` reads the server nickname.
      const pulledIds = request.pulledIds ?? new Map();
      const shownLines = shownPulled.flatMap(({ channelId, ids }) => {
        const shownIds = new Set(ids);
        return (pulled.find((entry) => entry.channelId === channelId)?.messages ?? []).filter((message) => shownIds.has(message.id));
      });
      const lines = shownLines.length > 0 ? [...shownLines, ...history] : history;
      const knownNames = memoryOn ? storedNames(request.peopleShown, shownLines, (userId) => store.getUser(guildId, userId)) : [];
      const linkFor = createLinker({
        guildId,
        pulledIds,
        sourceTarget: isPrivate ? null : sourceLinkTarget({ source, trigger, pulledKept: shownPulled }),
      });
      // A follow-up or an overheard turn (postsPlain) never posts as a Discord reply -- the
      // model's reply="#n" quotes nothing --, nor does the drawFailed turn after one.
      // A later part of a split message posts plain too: the first part replied to the message.
      const plain = postsPlain(triggerKind) || postsPlain(drawFailedAfter) || plainPosts;
      const routing = { pulledIds, lines, knownNames, linkFor, plain };
      // Read fresh right here, not from the `features` snapshot taken at the
      // top of this turn: unlike the other switches this one defaults to OFF,
      // and whether to actually post is the very last decision of a turn.
      // A set below diary.set.minPosted (read now) is not posted at all: not even its messages.
      const setMinPosted = setDraws ? setSettings(hot.config.diary).minPosted : 0;
      const setShort = (pictures, extra = {}) => {
        log.info('turn: set short', { channel: channel.id, pictures, wanted: setMinPosted, ...extra });
        return { outcome: 'refused', mode: finalMode, reason: 'set-short', ...extra };
      };
      if (hot.config.features?.dryRun === true) {
        // Nothing is generated: a set with fewer drawings than it needs would be short.
        if (setDraws && setDraws.length < setMinPosted) return setShort(setDraws.length, { dryRun: true });
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
      // A set's pictures are generated before anything of the post is sent, and counted
      // against the day's diary pictures as they were paid for, posted or not.
      let set = null;
      if (setDraws) {
        const pictures = await generateSet({ channel, draws: setDraws, selfName, minPosted: setMinPosted });
        if (pictures.length > 0) {
          bumpDaily(store.state.data, DIARY_PICTURES_DAILY, now, pictures.length);
          store.state.markDirty();
        }
        if (pictures.length < setMinPosted) return setShort(pictures.length);
        set = { pictures };
      }
      const acted = await act({
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
      });
      noteSpokeSaw(channel, history, serverShown, pulled, notAnswered);
      stampShownCalls({ shown: serverShown, pulled, answered: acted.answered ?? new Set(), exceptId: ownCallId });
      if (draft.started) {
        draft.posted = acted.posts ?? [];
        draft.reactions = acted.reacted ?? [];
      }
      // A diary post that reached the chat is recorded and counted.
      const recorded =
        diaryPrep && acted.delivered === true
          ? { diary: recordDiaryPost({ config: hot.config, guildId, now, plan: diaryPrep.plan, parsed, acted, set: Boolean(set) }) }
          : {};
      const spoke = { outcome: 'spoke', mode: finalMode, delivered: acted.delivered === true, ...recorded };
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
      log.error('turn: failed', { channel: channel.id, error: err });
      return { outcome: 'error' };
    } finally {
      draft.mode = turnMode;
      prep.closeAll();
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
  };
}
