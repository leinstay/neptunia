// The mentor's sandbox. A sandbox run takes an invented chat excerpt (a
// "situation"; or a real moment of the chat stored with a case, replayed from
// its normalized messages), builds the request a real turn would build --
// live prompts, live config, live stored memory -- asks the model, parses the
// answer, and stops there: nothing reaches Discord and nothing is written to
// memory. It reproduces the reply path (src/behavior/prompt.js#buildRequest,
// src/behavior/turn.js) as the turn it was: a real moment keeps its mode and
// trigger kind (an overheard line, a follow-up, a name call, an unasked
// turn), the call it answered from a channel the persona cannot write in and
// the other channels it was shown (`<channel_view>`,
// src/mentor/anchor.js#pulledFromStored); an invented situation is a reply
// -- a mention unless it names another kind -- and is shown no other channel.
// The last hours (`<recent>`) are the view's recent lines of the channel the
// turn is in, as they stood at the turn's time.
// Every input of buildRequest is named here (`sandboxRequestInput`); the ones
// a sandbox turn leaves out on purpose are `SANDBOX_OMITS`, each with its
// reason, so a new input of the request builder cannot go missing unseen.
// Outside that request it never reproduces the address classifier (whether
// the persona answers at all), the analyzer prompts, or a private chat.
//
// Every read of prompts, config and memory goes through a `view` (see
// `liveView`), never through `hot` or the store directly, so a caller can hand
// in another view of the same shape (a real moment's, src/mentor/moment.js).
// The private layer is out of bounds: a view has no accessor for it and no
// private chat is ever built.

import { buildRequest, userText as userTextOf } from '../behavior/prompt.js';
import { isTaggedCall } from '../behavior/mention.js';
import { MINUTE_MS } from '../time.js';
import { pickOtherProfiles } from '../behavior/turn.js';
import { REPLY_REQUEST, cacheTtlFor } from '../llm/openrouter.js';
import { parseOutput } from '../llm/parse.js';
import { log } from '../log.js';
import { findGif } from '../memory/gifs.js';
import { liveRecent, recentSettings } from '../memory/recent.js';
import { anchorKind, anchorMode, isSpontaneous, pulledFromStored, storedTrigger } from './anchor.js';

// Token estimates taken as they are: the calibrator of a view built without a live one.
const IDENTITY_CALIBRATOR = Object.freeze({ ratio: 1, apply: (n) => n, observe: () => 1 });
// pickOtherProfiles takes a guild id; the view serves one guild, so this only fills the argument.
const SANDBOX_GUILD = 'sandbox';
/** The trigger kinds an invented situation may name (`kind`); `drawFailed` needs a failure reason none has. */
const INVENTED_KINDS = new Set(['mention', 'reply', 'name', 'followUp', 'overheard']);
/**
 * A cache breakpoint on the user part. A JSON field, not prompt text: the llm client
 * (src/llm/openrouter.js#withCacheMarker) gives it its own TTL, or removes it when the
 * request is not cached.
 */
const USER_CACHE_MARKER = Object.freeze({ type: 'ephemeral' });

/**
 * The inputs of src/behavior/prompt.js#buildRequest a sandbox turn leaves
 * out on purpose, each with its reason: `sandboxRequestInput` passes them in
 * the form buildRequest reads as absent (null; `neighbors` an empty list,
 * which buildRequest needs). Every other input is passed.
 * @type {Readonly<Record<string, string>>}
 */
export const SANDBOX_OMITS = Object.freeze({
  neighbors: 'no neighbouring channel is fetched: no <other_channels>',
  neighborDescriptions: 'no neighbouring channel, so no captions of one',
  privateChat: 'never a private chat: the private layer is out of bounds',
  privateProfile: 'never a private chat: the private layer is out of bounds',
  reads: 'no web lookup: no link is read',
  lookup: 'no web lookup: no search is run',
  imageAnswers: 'no second look at a picture is run: no imageAnswered line',
  recallAvailable: 'no server search is run: <senses> does not offer it',
  drawQuota: 'no drawing is offered: a sandbox never draws, so <senses> has no drawing line',
  drawReason: 'a failed drawing\'s reason is not stored with a moment',
  focus: 'no room question: a live turn has no caller for it either',
  tasks: 'no part of a split message, no queued or folded call: a stored moment records none',
  recentAudience: 'no guild to compare audiences in: <recent> shows the lines of the turn\'s own channel only',
  participation: 'no guild to compare audiences in: no <participation> block of the persona\'s exchanges elsewhere',
  diaryChannel: 'no diary is offered: a sandbox turn never posts, so <senses> has no diary line',
  diary: 'never a diary post: no <world>, <diary>, <plan> or <found> block',
});

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
 * A situation as normalized channel messages (the shape of
 * src/discord/collect.js#normalizeMessage), oldest first. Pure.
 *
 * Line n (0-based) gets id `sb-<n+1>`; `authorId: 'self'` is the persona
 * (`selfId`, `selfName`, `self: true`). `ts` is `at - minutesBefore` minutes
 * (`at`: the moment the situation is answered at, in ms);
 * a line without `minutesBefore` sits one minute per remaining line before
 * `at` (the last one a minute before it); a line that would go back in time
 * gets the previous line's ts + 1 second. `replyTo` (a 0-based index of an
 * earlier line) becomes that line's id in `replyToId`. The last line is the
 * trigger. Its `triggerKind` is the situation's `kind` when it names one of
 * `mention`, `name`, `followUp`, `overheard` (an overheard line talks about
 * the persona to someone else), or `reply` when the last line does reply to
 * a line of the persona; otherwise the guess: 'reply' when it replies to a
 * line of the persona, else 'mention'. Only a 'mention' mentions `selfId`.
 * @param {{ title?: string, kind?: string, lines: { authorId: string, authorName?: string, text: string,
 *   replyTo?: number|null, minutesBefore?: number }[] }} situation
 * @param {{ selfId: string, selfName: string, at: number,
 *   channel: { id: string, name?: string|null, category?: string|null, topic?: string|null } }} options
 * @returns {{ history: object[], trigger: object, triggerKind: 'reply'|'mention'|'name'|'followUp'|'overheard' }}
 * @throws {Error} fewer than 2 lines, a last line by 'self', a replyTo that is not an earlier line.
 */
export function situationToHistory(situation, { selfId, selfName, at, channel }) {
  const lines = Array.isArray(situation?.lines) ? situation.lines : [];
  if (lines.length < 2) throw new Error('situation: at least 2 lines are needed');
  if (lines[lines.length - 1]?.authorId === 'self') throw new Error('situation: the last line must not be by self');

  const history = [];
  let previousTs = -Infinity;
  lines.forEach((line, n) => {
    const replyTo = line.replyTo ?? null;
    if (replyTo !== null && !(Number.isInteger(replyTo) && replyTo >= 0 && replyTo < n)) {
      throw new Error(`situation: line ${n} replies to ${replyTo}, which is not an earlier line`);
    }
    const minutes = Number.isFinite(line.minutesBefore) ? line.minutesBefore : lines.length - n;
    let ts = at - minutes * MINUTE_MS;
    if (ts < previousTs) ts = previousTs + 1000;
    previousTs = ts;
    const self = line.authorId === 'self';
    history.push({
      id: `sb-${n + 1}`,
      channelId: channel.id,
      channelName: channel.name ?? null,
      channelCategory: channel.category ?? null,
      channelTopic: channel.topic ?? null,
      authorId: self ? selfId : line.authorId,
      authorName: self ? selfName : line.authorName,
      self,
      bot: false,
      content: line.text,
      ts,
      mentionedUserIds: [],
      replyToId: replyTo === null ? null : `sb-${replyTo + 1}`,
      forwardedFrom: null,
      attachments: [],
      links: [],
      forwarded: [],
      stickers: [],
      emojis: [],
      reactions: [],
    });
  });

  const trigger = history[history.length - 1];
  const lastReplyTo = lines[lines.length - 1].replyTo ?? null;
  const repliesToSelf = lastReplyTo !== null && lines[lastReplyTo].authorId === 'self';
  const named = INVENTED_KINDS.has(situation?.kind) && (situation.kind !== 'reply' || repliesToSelf) ? situation.kind : null;
  const triggerKind = named ?? (repliesToSelf ? 'reply' : 'mention');
  if (triggerKind === 'mention') trigger.mentionedUserIds = [selfId];
  return { history, trigger, triggerKind };
}

/**
 * The history a situation is answered from. A real moment of the chat (a
 * situation with `history`, see src/mentor/anchor.js#anchorSituations) is
 * replayed from its stored normalized messages as they are. Its trigger is
 * src/mentor/anchor.js#storedTrigger's (the message its `triggerId` names, in
 * the history or in a stored window of another channel; else the last
 * message) and its `triggerKind` the stored `kind` when it is one a turn has
 * (src/mentor/anchor.js#anchorKind), else the guess an invented situation
 * gets: 'reply' when the trigger replies to a message of the persona in that
 * history, else 'mention'. A spontaneous moment (`mode` `interject` /
 * `initiate`) has neither: trigger and kind are null. Invented lines go
 * through `situationToHistory`. Pure.
 * @param {{ history?: object[], lines?: object[], triggerId?: string|null, kind?: string|null,
 *   mode?: string|null, pulled?: object[] }} situation
 * @param {{ selfId: string, selfName?: string, at?: number, channel?: object }} options
 * @returns {{ history: object[], trigger: object|null, triggerKind: string|null }}
 * @throws {Error} an empty stored history or a trigger by the persona; see `situationToHistory`.
 */
export function situationHistory(situation, options) {
  if (!Array.isArray(situation?.history)) return situationToHistory(situation, options);
  const history = situation.history;
  if (history.length === 0) throw new Error('situation: the stored history is empty');
  if (isSpontaneous(situation.mode)) return { history, trigger: null, triggerKind: null };
  const trigger = storedTrigger(situation);
  if (!trigger || trigger.self === true) throw new Error('situation: the stored trigger must not be by self');
  const target = trigger.replyToId ? history.find((message) => message?.id === trigger.replyToId) : null;
  return { history, trigger, triggerKind: anchorKind(situation.kind) ?? (target?.self === true ? 'reply' : 'mention') };
}

/** The mode a situation is answered in: a stored moment's (`interject`, `initiate`, `reply`), else `reply`. */
function situationMode(situation) {
  return Array.isArray(situation?.history) ? (anchorMode(situation.mode) ?? 'reply') : 'reply';
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
 * `onUsage(usage, estimated)` follows every completion: what a completion
 * costs is the caller's (the mentor's budget) to weigh.
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
 * recent store, and when the read fails: that is logged (`mentor: recent
 * failed`) and never ends a run, as a live turn goes on without the block.
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
    log.warn('mentor: recent failed', { error: err });
    return null;
  }
}

/**
 * The input of src/behavior/prompt.js#buildRequest for one sandbox turn, every
 * key named: the turn `situation` was (`situationHistory`: its trigger and
 * kind; its mode, `reply` for an invented situation or a moment stored
 * without one; for a stored moment, the other channels it showed and the
 * routed call's source, src/mentor/anchor.js#pulledFromStored), memory
 * through `view.memory` as in a real turn (`features.memory` off leaves it
 * out, the recent lines included: `recentLinesOf`), tokens measured with
 * `view.calibrator`, and the caller's lists and `<senses>` inputs. The inputs
 * left out on purpose are `SANDBOX_OMITS`, passed as absent. Never an
 * owner-forced turn: a stored moment records no such flag. The view is read
 * now and nothing is written.
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
  const { history, trigger, triggerKind } = situationHistory(situation, { selfId, selfName, at, channel });
  // Only a stored moment was shown other channels; an invented situation is shown none.
  const { pulled, source, readOnlyIds } = pulledFromStored(Array.isArray(situation?.history) ? situation : null);
  // pickOtherProfiles reads a store-shaped object; this one reads the view.
  const viewAsStore = { getUser: (guildId, id) => memory.getUser(id) };
  return {
    config,
    prompts: view.prompts,
    calibrator: view.calibrator ?? IDENTITY_CALIBRATOR,
    mode: situationMode(situation),
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
    pulled,
    source,
    elsewhereDestination: typeof elsewhereDestination?.name === 'string' && elsewhereDestination.name ? { name: elsewhereDestination.name } : null,
    readOnlyIds,
    // `<recent>`: the last hours as the view holds them (no block without a recent store).
    recentLines: memoryOn ? recentLinesOf(view, at) : null,
    // SANDBOX_OMITS, as buildRequest reads them absent.
    neighbors: [],
    neighborDescriptions: null,
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
 * The reply sandbox: the request a real turn would send for `situation`
 * (buildRequest over `sandboxRequestInput`: a stored moment as the turn it
 * was -- its mode, trigger kind, a routed call's source and the other
 * channels it showed -- an invented situation as a reply; memory through
 * `view.memory`, tokens measured with `view.calibrator`, so the caps trim
 * what a real turn trims), `samples` completions, each parsed with
 * parseOutput and trimmed by `features.reactions` / `features.multiMessage`
 * like a real turn. The server's custom emoji (`<emoji>`) and GIF library
 * (`<gifs>`, the transcript's GIF handles) render as in a real turn when the
 * caller hands in the same sources the turn uses (`customEmoji`, `gifs`,
 * `mediaCache`; buildRequest applies `features.customEmoji` /
 * `features.gifs`); so do `<senses>`' line on where a call from a read-only
 * channel is answered (`elsewhereDestination`) and its search line
 * (`searchAvailable`). `<recent>` shows the view's recent lines of this
 * channel inside `memory.recentHours` at `at` and the members' moments of
 * those hours (`recentLinesOf`; a real moment's view holds the lines added
 * before it, src/mentor/moment.js). Left out, unlike a real turn: every input
 * of `SANDBOX_OMITS` (neighbours, the web lookup, the server search, a drawing offer, a room
 * question, the recent lines of other channels, a private chat), pictures (a
 * user message with image parts is sent as its text-only re-render), an
 * owner-forced turn's text, the daily GIF cap, and a custom-emoji reaction is
 * kept as written (not resolved through the emoji index); nothing is sent and
 * nothing is stored. Media render with their labels only, unless the caller hands in
 * what the persona saw of them (a real moment's `descriptions` / `videos`,
 * see src/mentor/anchor.js#replayMedia; its other channels' captions are
 * stored with them): nothing is described or watched here. Every completion
 * passes `role: 'voice'`, `purpose: 'reply'` (`REPLY_REQUEST`), `origin: 'mentor'`, `countAgainstDailyCap: false`
 * and `skipCalibration: true`; the per-request token cap stays in force.
 * With `samples` > 1 and a request the llm client caches
 * (src/llm/openrouter.js#cacheTtlFor: `features.promptCache`, role `voice`,
 * the model), the user message is one text part carrying a cache marker, so
 * samples 2..N read the cache instead of paying for it again.
 * An answer's `gif` (a handle of the library, `features.gifs` on) and `draw`
 * (`features.imageGeneration` on) count as actions, as in a real turn; an
 * unknown handle or a switched-off kind is dropped (null). `skip` is true
 * when the model skipped or left nothing to do (as a real turn treats it).
 * @param {object} input
 * @param {object} input.view        From `liveView` (or a view of the same shape, e.g. src/mentor/moment.js#momentView).
 * @param {object} input.situation   Invented lines (see `situationToHistory`) or a stored moment (see `situationHistory`).
 * @param {string} input.selfId
 * @param {string} input.selfName
 * @param {{ id: string, name?: string, category?: string, topic?: string }} input.channel
 * @param {{ complete: Function }} input.llm
 * @param {number} input.samples
 * @param {number} input.at          The moment the situation is answered at (ms).
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
    options: { ...REPLY_REQUEST, origin: 'mentor', countAgainstDailyCap: false, skipCalibration: true, signal },
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
