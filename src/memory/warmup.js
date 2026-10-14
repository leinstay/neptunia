// THE way memory starts (docs/prompt-contract.md, "The warmup").
// Sampling: up to `warmup.messagesPerPerson` of a member's own messages
// (newest-heavy but spread over `warmup.lookbackDays`, one channel capped
// at `warmup.maxChannelShare` unless it is a main channel), a little
// conversational context around each, asked of `prompts/profile.md` one
// person at a time; `prompts/channel.md` does the same for a channel's newest
// `warmup.messagesPerChannel` messages; `prompts/server.md` closes a run
// with one request over every channel's notes, a line per profiled member and
// the newest `warmup.serverSampleMessages` messages of the main channels.
// All three are read the same way the stream analyzer's `memory.md` is
// (formatTranscript's 'memory' mode, the same character card, the same
// clampText/toTokens/fromTokens helpers).
//
// The operations tool tools/warmup.mjs drives it with the bot stopped (the
// subcommands named below) and resumes its own unfinished run; the bot never
// starts or resumes a run, and `/nep memory refresh`
// uses the sampled notes refresh (`refreshChannelNotes`/`refreshServerNotes`). `peopleReport` stays read-only (never touches the store)
// for `people`. `createWarmup().run()` is the write path: channels →
// people → server, in order, resumable (progress in `state.warmup`,
// flushed after every request), muting the persona for as long as it is in
// flight (`isWarmingUp()`, wired into src/discord/events.js,
// src/behavior/spontaneous.js and src/admin.js). `runPerson`/`runChannel`/
// `runServer` (re)do exactly one target now, synchronously, for `users
// --user` / `channels --channel` / `server` (and `/nep memory refresh
// kind:channel|server`); `runUsers`/`runChannels` (re)do EVERY qualifying
// member/every readable channel now, sharing `running` and every rail with
// `run()`, for `users`/`channels` given with no member/channel -- a redo
// always re-processes its targets regardless of `state.warmup.done`, then
// marks them done, so `status` reports the same progress either way.
// `refreshPortrait()` rewrites only `character`/`style` from the member's own
// lines since their last portrait (never older than the profile's `firstSeen`
// unless the owner forces it), with the stored portrait as the `<draft>`;
// it is started by src/memory/portrait.js's scheduler (by counters), by the
// stream analyzer's cue (src/memory/update.js's `onPortraitRequest`) and by
// `/nep memory refresh`, all under one daily cap. `refreshChannelNotes()` /
// `refreshServerNotes()` re-ask `channel.md` / `server.md` on a sample spread
// over recent days, the stored notes shown as claims (`<existing_notes>`);
// they are started by src/memory/notes-refresh.js's scheduler.
//
// Two-stage mode (`features.memoryTwoStage`, DECISIONS-R4): no text in the
// persona's voice is asked of `roles.extractor` (`warmupRoute`). The portrait
// refresh splits like the stream analyzer: stage A (`prompts/portrait.md` on
// `roles.extractor`) returns the merged `style`, stored at once, and lists about
// the character that become one voice item for the voice run
// (src/memory/voice.js, src/memory/update.js#runVoice), which words it on
// `roles.voice` (the role `voice`) and only then stamps the portrait. While that item waits,
// only the owner's forced refresh asks stage A for the member again (any other
// refresh stands down, `voice-pending`, and src/memory/portrait.js's scheduler
// does not pick the member); a newer portrait decision stored here meanwhile
// (that forced refresh, a single-mode refresh after the switch was turned off,
// a warmup person run) takes the item out of the queue unworded. The warmup's
// person and server requests, which word a portrait, episode feelings and the server's
// notes, go out on `roles.voice` whole; its channel requests (neutral
// notes) stay on `roles.extractor`. A missing `prompts.profile` /
// `prompts.channel` / `prompts.server` is reported (reason `no-prompt`), never
// thrown; a missing or broken labels.json fails loudly (a throw), exactly as it
// does for the stream analyzer. An in-memory-only `activity` snapshot (`{ phase,
// detail, lastActivityAt }`, never persisted) tracks what a run is doing
// right now -- fetching history, describing a channel, profiling a person
// (with a chunk count when its sample does not fit one request), building
// the server notes, waiting out a provider rate limit, paused, finished or
// aborted -- exposed through `status()` for the tool's `status`.

import { readableChannels, fetchHistoryWindow } from '../discord/collect.js';
import { formatTranscript, renderTranscript } from '../discord/format.js';
import { fitSections, requestTokenLimit, sectionCost, SectionsTooLargeError } from '../llm/budget.js';
import { estimateMessages } from '../llm/tokens.js';
import { parseJsonObject } from '../llm/parse.js';
import { isPlainObject } from '../config.js';
import {
  MEMORY_LIMIT_DEFAULTS,
  analyzerTemperature,
  applyMemoryUpdate,
  characterText,
  detailOf,
  errorNameOf,
  feedsCalibration,
  looksTruncated,
  mainChannelSet,
  requireLabels,
} from './update.js';
import { block, fillPromptTemplate } from '../behavior/prompt.js';
import { topByRank } from './ranking.js';
import { clampText } from './clamp.js';
import { acceptProse, overLimitOf } from './prose.js';
import { INJOKE_CHARS } from './text-limits.js';
import { normalizeTopic } from './interests.js';
import { toTokens, fromTokens } from './mentions.js';
import {
  PORTRAIT_SLOTS,
  hasText,
  isQueuedPortrait,
  llmCapReached,
  portraitMode,
  portraitSettings,
  stampMs,
  storedCount,
  waitingPortraits,
} from './portrait.js';
import { mergeIntoQueue } from './voice.js';
import { selectSpreadSample } from './sample.js';
import { DailyCapError, MEMORY_VOICE_REQUEST, RETRY_STATUS, TokenLimitError } from '../llm/openrouter.js';
import { roleModel } from '../llm/roles.js';
import { log } from '../log.js';
import { DAY_MS, HOUR_MS, MINUTE_MS, bumpDaily, dailyCounter, utcDay } from '../time.js';

const CACHE_TTL_MS = 15 * MINUTE_MS;

// Only when warmup.maxRequestTokens is missing (config.json always has it, the same value).
const WARMUP_MAX_REQUEST_TOKENS_FALLBACK = 120000;

// How much of the sample a portrait refresh keeps each time its request is over the cap.
const PORTRAIT_SHRINK = 0.8;

// A portrait refresh's outcomes that drop an answer on purpose rather than fail (see refreshPortrait).
const PORTRAIT_STOOD_DOWN = new Set(['paused', 'warming-up', 'gone', 'changed']);

/** Whether a request error is the provider's or the network's passing trouble rather than an
 * answer: a status the client itself retries (src/llm/openrouter.js#RETRY_STATUS, read from
 * `statusCode`) or a timed-out / aborted attempt (`TimeoutError`, `AbortError`). */
function isTransientProviderError(err) {
  if (RETRY_STATUS.has(err?.statusCode)) return true;
  return err?.name === 'TimeoutError' || err?.name === 'AbortError';
}

// The owner-facing message of a portrait refresh with no prompt to send (`no-prompt`).
const PROFILE_PROMPT_MISSING = 'prompt file missing: prompts/profile.md (or prompts.local/profile.md) is not configured yet';

// The four lists of a stage A portrait answer: `keep` and `add` hold notes, `revise` holds
// `{ old, now }`, `drop` holds `{ old }` (see clampPortraitDecision).
const PORTRAIT_LISTS = ['keep', 'revise', 'add', 'drop'];

// Bumped whenever `state.warmup`'s shape changes incompatibly -- a stored
// object whose `version` does not match this is foreign (written by an older
// version of this project) and is discarded wholesale by `warmupState()`
// below, never healed field by field.
const WARMUP_STATE_VERSION = 3;

/** `err?.statusCode === 429` — the one rate-limit signal src/llm/openrouter.js#complete surfaces
 * (it already retries a 429 a couple of times itself; this is for the SUSTAINED case where the
 * provider keeps refusing across the retries too). */
function isRateLimited(err) {
  return err?.statusCode === 429;
}

// ---------------------------------------------------------------------------
// Small pure helpers local to this module. From src/memory/update.js come
// `characterText` (so a `/nep rule add` reaches every `<character>` block the
// same way it reaches the chat prompt), the failure helpers `detailOf`,
// `errorNameOf` and `looksTruncated`, and MEMORY_LIMIT_DEFAULTS (config.json's
// own defaults, used only when a key is missing); `block` and `fillPromptTemplate`
// are the request builders' shared ones (src/behavior/prompt.js); `hasText`,
// `portraitMode` and the voice queue's character rule (`isQueuedPortrait`,
// `waitingPortraits`) are src/memory/portrait.js's, which its scheduler reads too.
// ---------------------------------------------------------------------------

function isoDateOrDash(ts) {
  return Number.isFinite(ts) ? utcDay(ts) : '-';
}

/** Only the fields of a clamped answer that say something (a non-blank string, a non-empty
 * array): an answer that leaves a field out or empty never blanks what is stored, the same rule
 * the stream analyzer follows (src/memory/update.js#applyMemoryUpdate). */
function nonEmptyFields(fields) {
  return Object.fromEntries(
    Object.entries(fields).filter(([, value]) => (typeof value === 'string' ? value.trim() !== '' : Array.isArray(value) && value.length > 0)),
  );
}

/** The sample refresh settings of the channel and server notes, read from the live config at the
 * moment of use; every fallback equals config.json. */
function notesSampleSettings(config) {
  const memoryCfg = config?.memory ?? {};
  return {
    days: memoryCfg.notesSampleDays ?? 30,
    max: memoryCfg.notesSampleMessages ?? 160,
    maxAuthorShare: memoryCfg.notesSampleMaxAuthorShare ?? 0.35,
    minMessages: memoryCfg.notesMinMessages ?? 30,
  };
}

/** Whole days from an ISO stamp to `nowMs` (`writtenDaysAgo` of `<existing_notes>`), null when
 * the stamp does not read as a time. */
function daysSince(stamp, nowMs) {
  const ms = typeof stamp === 'string' ? Date.parse(stamp) : NaN;
  return Number.isFinite(ms) ? Math.max(0, Math.floor((nowMs - ms) / DAY_MS)) : null;
}

/** The counts a notes refresh reports about its sample: lines, distinct authors, distinct UTC days. */
function sampleCounts(sample) {
  return {
    sample: sample.length,
    authors: new Set(sample.map((m) => String(m.authorId))).size,
    days: new Set(sample.filter((m) => Number.isFinite(m.ts)).map((m) => utcDay(m.ts))).size,
  };
}

// A notes refresh's failures that stamp `notesAttemptAt`, so the scheduler backs off the target.
const NOTES_ATTEMPT_REASONS = new Set(['too-few', 'conflict', 'bad-json', 'llm-error', 'over-limit']);

/** A notes refresh's reason and detail for a failed processChannel / processServer outcome: a
 * request that does not fit even with the fewest lines (`over-cap`) is a `token-limit`, with the
 * original reason as `detail`; every other reason is the refresh's own, its `detail` and the
 * `fields` of an `over-limit` kept. */
function notesRefreshReason(outcome) {
  if (outcome.reason === 'over-cap') return { reason: 'token-limit', detail: 'over-cap' };
  return { reason: outcome.reason, detail: outcome.detail, fields: outcome.fields };
}

/** The version history settings a memory write passes to the store, read from the live config
 * (fallbacks: config.json's `features.versions` and `memory.versionsKept`). */
function versionSettings(config) {
  return { enabled: config?.features?.versions !== false, kept: config?.memory?.versionsKept ?? 20 };
}

/** Whether a refresh re-asks an answer whose rewrite is over a prose limit, once
 * (`memory.overLimitRetries`; fallback config.json's 1). */
function overLimitRetryOn(config) {
  return (config?.memory?.overLimitRetries ?? 1) > 0;
}

/** The retry of a refresh whose answer is over a prose limit: the same `messages`, then the
 * model's own answer as it was returned (`answerText`, an assistant turn), then a user turn holding
 * only `<over_limit>` (JSON, src/memory/prose.js#overLimitOf). Pure. */
function withOverLimit(messages, answerText, overLimit) {
  return [
    ...messages,
    { role: 'assistant', content: answerText },
    { role: 'user', content: block('over_limit', JSON.stringify(overLimit)) },
  ];
}

/** src/memory/prose.js#acceptProse over the prose fields of one refresh answer (`answer`: field ->
 * text, `''` when the answer has none): `accepted` holds what is stored for every field that said
 * something (a first write clamped as before, a rewrite within its limit as is, an identical text
 * as stored), `over` the trimmed texts of the rewrites over their limits -- never cut. Pure. */
function judgeProse(answer, stored, limits, config) {
  const tolerance = config?.memory?.clampTolerance;
  const accepted = {};
  const over = {};
  for (const [field, text] of Object.entries(answer)) {
    const verdict = acceptProse(stored[field], text, limits[field], { tolerance });
    if (verdict.outcome === 'over') over[field] = text.trim();
    else if (verdict.outcome !== 'empty') accepted[field] = verdict.text;
  }
  return { accepted, over };
}

/** formatTranscript's 'memory'-mode options for a warmup request (channel, person, server,
 * portrait), from the live config -- the same mode the stream analyzer renders in. */
function memoryFormatOptions(config, selfName, labels) {
  return {
    timezone: config?.bot?.timezone ?? 'UTC',
    gapMinutes: config?.context?.gapMarkerMinutes ?? 20,
    maxChars: config?.context?.maxMessageChars ?? 2000,
    selfName,
    mode: 'memory',
    labels,
    seeReactions: config?.features?.seeReactions !== false,
    reactionsPerMessage: config?.context?.reactionsPerMessage,
  };
}

/** The `<member>` line of a profile.md request (a warmup person or a portrait refresh). */
function memberLine(member) {
  return `${member.name} (id:${member.id}), ${member.messages} messages in the window, first ${isoDateOrDash(member.firstTs)}, last ${isoDateOrDash(member.lastTs)}`;
}

/**
 * The placeholder values of a `profile.md` request (a warmup person run, a single-mode portrait
 * refresh) and of a two-stage refresh's `portrait.md`: `{{name}}`, `{{fieldChars}}`,
 * `{{maxInterests}}`, `{{maxDetails}}`, `{{interestTopicChars}}`, `{{interestNoteChars}}`,
 * `{{maxNewEpisodes}}`, read from the live config; every fallback is config.json's value. Pure.
 * @param {object} [config]  The live config.
 * @param {string} [selfName]  The persona's display name.
 * @returns {Record<string, string|number>}
 */
export function profileTemplateValues(config, selfName) {
  const memoryCfg = config?.memory ?? {};
  return {
    name: selfName,
    fieldChars: memoryCfg.fieldChars ?? MEMORY_LIMIT_DEFAULTS.fieldChars,
    maxInterests: memoryCfg.maxInterests ?? MEMORY_LIMIT_DEFAULTS.maxInterests,
    maxDetails: memoryCfg.maxDetails ?? MEMORY_LIMIT_DEFAULTS.maxDetails,
    interestTopicChars: memoryCfg.interestTopicChars ?? MEMORY_LIMIT_DEFAULTS.interestTopicChars,
    interestNoteChars: memoryCfg.interestNoteChars ?? MEMORY_LIMIT_DEFAULTS.interestNoteChars,
    maxNewEpisodes: memoryCfg.maxNewEpisodes ?? MEMORY_LIMIT_DEFAULTS.maxNewEpisodes,
  };
}

/**
 * The model, role and calibration flag of one request of the warmup's family (its channel, person
 * and server requests and the portrait refresh), read from the live config at the moment of use.
 * With `features.memoryTwoStage` off (read `=== true`): `roles.extractor` as
 * role `extractor`, as always. With it on, no text in the persona's voice is asked of
 * `roles.extractor` (DECISIONS-R4): a request whose answer holds one (`voice: true`: a portrait's
 * `character`, an episode's `feeling`, the server's `patterns` and `starters`) goes out on
 * `roles.voice` as a memory-wording request (src/llm/openrouter.js#MEMORY_VOICE_REQUEST: role
 * `voice`, the role whose provider route the owner pins; purpose `memory-voice`; no cache
 * marker), as the stream analyzer's are (src/memory/update.js); a neutral one (channel notes,
 * the portrait refresh's stage A) stays on `roles.extractor` as role `extractor` with the settings of
 * the stream analyzer's stage A: `memory.reasoning` when that is a plain object, and
 * `memory.maxOutputTokens` as its output budget (a reasoning model spends that budget on its
 * reasoning too); both skip calibration off the voice model (src/memory/update.js#feedsCalibration).
 * The voice-role requests of this module are not counted in `memory.voice.maxPerDay` (that rail is
 * src/memory/update.js's, for its voice runs and its batches' fallback): the warmup's person and
 * server requests are railed by `warmup.maxTokens`, the portrait refresh's fallback by
 * `memory.portraitRefreshPerDay` and `llm.maxRequestsPerDay`. Pure.
 * @param {object} [config]  The live config.
 * @param {{ voice?: boolean }} [opts]
 * @returns {{ model: string|undefined, role: 'extractor'|'voice', purpose?: 'memory-voice', cache?: false,
 *   skipCalibration?: boolean, reasoning?: object, maxOutputTokens?: number }}  `maxOutputTokens`
 *   only on the neutral two-stage route (the caller's own budget otherwise).
 */
export function warmupRoute(config, { voice = false } = {}) {
  const memoryCfg = config?.memory ?? {};
  if (config?.features?.memoryTwoStage !== true) return { model: roleModel(config, 'extractor'), role: 'extractor' };
  if (voice) {
    const model = roleModel(config, 'voice');
    return { model, ...MEMORY_VOICE_REQUEST, skipCalibration: !feedsCalibration(config, model) };
  }
  const model = roleModel(config, 'extractor');
  const route = { model, role: 'extractor', skipCalibration: !feedsCalibration(config, model), maxOutputTokens: memoryCfg.maxOutputTokens ?? 20000 };
  if (isPlainObject(memoryCfg.reasoning)) route.reasoning = memoryCfg.reasoning;
  return route;
}

// ---------------------------------------------------------------------------
// pickPeople / memberStats -- who qualifies right now
// ---------------------------------------------------------------------------

/**
 * @typedef {{ id: string, name: string, category: string|null, topic: string|null, messages: object[] }} ChannelWindow
 *   `messages` are normalized (src/discord/collect.js#normalizeMessage), oldest first.
 */

/** Per-author counters over every window's own (non-bot, non-self) messages, keyed by author id;
 * messages older than `sinceTs` are left out. */
function collectAuthorStats(windows, sinceTs = -Infinity) {
  const authors = new Map();
  for (const window of windows ?? []) {
    for (const message of window.messages ?? []) {
      if (message.bot || message.self) continue;
      if (message.ts < sinceTs) continue;
      const id = String(message.authorId);
      let entry = authors.get(id);
      if (!entry) {
        entry = { id, name: message.authorName, nameTs: message.ts, messages: 0, firstTs: message.ts, lastTs: message.ts, byChannel: {} };
        authors.set(id, entry);
      }
      entry.messages += 1;
      entry.firstTs = Math.min(entry.firstTs, message.ts);
      entry.lastTs = Math.max(entry.lastTs, message.ts);
      entry.byChannel[window.id] = (entry.byChannel[window.id] ?? 0) + 1;
      // The most recent nick seen for this author wins -- display names drift.
      if (message.ts >= entry.nameTs) {
        entry.nameTs = message.ts;
        entry.name = message.authorName;
      }
    }
  }
  return authors;
}

/**
 * Members who qualify for the warmup sample right now: at least
 * `cfg.minMessages` own messages across `windows`, most active first, top
 * `cfg.maxPeople`. Bots and the persona's own messages are excluded (see
 * collectAuthorStats). Pure.
 * @param {ChannelWindow[]} windows
 * @param {{ minMessages?: number, maxPeople?: number }} cfg
 * @returns {{ id: string, name: string, messages: number, firstTs: number, lastTs: number, byChannel: Record<string, number> }[]}
 */
export function pickPeople(windows, cfg = {}) {
  const authors = collectAuthorStats(windows);
  const minMessages = Number.isFinite(cfg.minMessages) && cfg.minMessages > 0 ? cfg.minMessages : 0;
  const maxPeople = Number.isInteger(cfg.maxPeople) && cfg.maxPeople >= 0 ? cfg.maxPeople : Infinity;
  return [...authors.values()]
    .filter((a) => a.messages >= minMessages)
    .sort((a, b) => b.messages - a.messages || a.id.localeCompare(b.id))
    .slice(0, maxPeople)
    .map(({ nameTs: _nameTs, ...rest }) => rest);
}

/** One member's stats (see pickPeople), with no threshold/cap applied -- `null` when they wrote
 * nothing in `windows` at all. Used by `tools/warmup.mjs users --user <id>` to report on exactly the
 * member asked for, regardless of `warmup.minMessages`. `sinceTs` (optional) counts only messages
 * from then on: a portrait refresh's `<member>` line counts the lines since the last portrait. */
export function memberStats(windows, memberId, sinceTs = -Infinity) {
  const entry = collectAuthorStats(windows, sinceTs).get(String(memberId));
  if (!entry) return null;
  const { nameTs: _nameTs, ...rest } = entry;
  return rest;
}

// ---------------------------------------------------------------------------
// sampleMember -- newest-heavy but spread, channel-share capped, with context
// ---------------------------------------------------------------------------

/** `count` items spread evenly over `pool` (chronological), deterministic: no rng. */
function evenlySpread(pool, count) {
  if (count <= 0 || pool.length === 0) return [];
  if (count >= pool.length) return pool.slice();
  const used = new Set();
  const step = pool.length / count;
  const result = [];
  for (let i = 0; i < count; i += 1) {
    let idx = Math.floor(i * step);
    while (used.has(idx) && idx < pool.length - 1) idx += 1;
    used.add(idx);
    result.push(pool[idx]);
  }
  return result;
}

/**
 * Up to `total` of `sortedAsc` (one author's own messages, chronological),
 * newest-heavy but spread over the whole window: half from the newest third,
 * the rest evenly spread over the older two-thirds -- falling back to
 * whichever pool actually has enough messages when one of the two is short.
 * Deterministic (no rng), oldest-first on return. Pure.
 * @param {object[]} sortedAsc
 * @param {number} total
 * @returns {object[]}
 */
export function splitNewestOlder(sortedAsc, total) {
  const wantTotal = Math.min(Math.max(0, total), sortedAsc.length);
  if (wantTotal <= 0) return [];

  const thirdStart = Math.floor((sortedAsc.length * 2) / 3);
  const newestPool = sortedAsc.slice(thirdStart);
  const olderPool = sortedAsc.slice(0, thirdStart);

  let newestWant = Math.ceil(wantTotal / 2);
  let olderWant = wantTotal - newestWant;
  if (newestWant > newestPool.length) {
    olderWant += newestWant - newestPool.length;
    newestWant = newestPool.length;
  }
  if (olderWant > olderPool.length) {
    newestWant = Math.min(newestPool.length, newestWant + (olderWant - olderPool.length));
    olderWant = olderPool.length;
  }

  const chosenNewest = newestPool.slice(newestPool.length - newestWant);
  const chosenOlder = evenlySpread(olderPool, olderWant);
  return [...chosenOlder, ...chosenNewest];
}

/**
 * Sample one member's own messages for `profile.md`, plus a little
 * conversational context around each: up to `cfg.messagesPerPerson`, spread
 * per `splitNewestOlder`, at most `cfg.maxChannelShare` of them from one
 * channel UNLESS that channel is listed in `mainChannelIds` (main channels
 * are quota-filled first, uncapped). Every chosen message brings its
 * `cfg.contextBefore` immediately preceding channel messages (any author) and
 * its reply target when that is inside the fetched window; overlapping
 * context is merged (a `Set` per channel). The returned messages are grouped
 * by channel (main channels first, each by activity), chronological within a
 * channel. `cfg.since` (epoch ms, optional) leaves the member's own messages
 * older than that out of the pool -- a portrait refresh samples only what was
 * written since the last portrait -- while context lines may still be older.
 * Pure.
 * @param {ChannelWindow[]} windows
 * @param {string} memberId
 * @param {{ messagesPerPerson?: number, contextBefore?: number, maxChannelShare?: number, since?: number }} cfg
 * @param {Set<string>|string[]} [mainChannelIds]
 * @returns {{ messages: object[], ownIds: Set<string>, channels: string[], ownCount: number, contextCount: number }}
 */
export function sampleMember(windows, memberId, cfg = {}, mainChannelIds = []) {
  const mainIds = mainChannelIds instanceof Set ? mainChannelIds : new Set((mainChannelIds ?? []).map(String));
  const messagesPerPerson = Number.isInteger(cfg.messagesPerPerson) && cfg.messagesPerPerson > 0 ? cfg.messagesPerPerson : 0;
  const contextBefore = Number.isInteger(cfg.contextBefore) && cfg.contextBefore >= 0 ? cfg.contextBefore : 0;
  const maxChannelShare = Number.isFinite(cfg.maxChannelShare) && cfg.maxChannelShare > 0 && cfg.maxChannelShare <= 1 ? cfg.maxChannelShare : 1;
  const since = Number.isFinite(cfg.since) ? cfg.since : -Infinity;

  const id = String(memberId);
  const channelPools = new Map(); // channelId -> this member's own messages, chronological
  const indexById = new Map(); // channelId -> Map(messageId -> index in that window)
  const windowById = new Map(); // channelId -> the ChannelWindow

  for (const window of windows ?? []) {
    windowById.set(window.id, window);
    const idx = new Map();
    (window.messages ?? []).forEach((m, i) => idx.set(m.id, i));
    indexById.set(window.id, idx);
    const own = (window.messages ?? []).filter((m) => String(m.authorId) === id && !m.bot && !m.self && !(m.ts < since));
    if (own.length > 0) channelPools.set(window.id, own);
  }

  if (channelPools.size === 0 || messagesPerPerson === 0) {
    return { messages: [], ownIds: new Set(), channels: [], ownCount: 0, contextCount: 0 };
  }

  const shareCap = Math.max(1, Math.floor(messagesPerPerson * maxChannelShare));
  const byActivityDesc = (a, b) => channelPools.get(b).length - channelPools.get(a).length || a.localeCompare(b);
  const mainOrder = [...channelPools.keys()].filter((cid) => mainIds.has(cid)).sort(byActivityDesc);
  const otherOrder = [...channelPools.keys()].filter((cid) => !mainIds.has(cid)).sort(byActivityDesc);

  const quotas = new Map();
  let remaining = messagesPerPerson;
  for (const cid of mainOrder) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, channelPools.get(cid).length);
    if (take > 0) quotas.set(cid, take);
    remaining -= take;
  }
  for (const cid of otherOrder) {
    if (remaining <= 0) break;
    const take = Math.min(remaining, shareCap, channelPools.get(cid).length);
    if (take > 0) quotas.set(cid, take);
    remaining -= take;
  }

  const orderedChannels = [...mainOrder, ...otherOrder].filter((cid) => quotas.has(cid));

  const ownIdsByChannel = new Map();
  const ownIds = new Set();
  for (const cid of orderedChannels) {
    const chosen = splitNewestOlder(channelPools.get(cid), quotas.get(cid));
    const own = new Set(chosen.map((m) => m.id));
    ownIdsByChannel.set(cid, own);
    for (const oid of own) ownIds.add(oid);
  }

  const messages = [];
  let contextCount = 0;
  for (const cid of orderedChannels) {
    const own = ownIdsByChannel.get(cid);
    const idx = indexById.get(cid);
    const windowMessages = windowById.get(cid).messages;

    const included = new Set(own);
    for (const oid of own) {
      const i = idx.get(oid);
      for (let k = Math.max(0, i - contextBefore); k < i; k += 1) {
        included.add(windowMessages[k].id);
      }
      const replyToId = windowMessages[i].replyToId;
      if (replyToId && idx.has(replyToId)) included.add(replyToId);
    }

    const orderedIndexes = [...included].map((mid) => idx.get(mid)).sort((a, b) => a - b);
    for (const i of orderedIndexes) {
      const message = windowMessages[i];
      messages.push(message);
      if (!own.has(message.id)) contextCount += 1;
    }
  }

  return { messages, ownIds, channels: orderedChannels, ownCount: ownIds.size, contextCount };
}

/** The newest `messagesPerChannel` of `messages` (chronological, oldest first) -- everything when
 * `messagesPerChannel` is not a positive integer. Pure. */
export function selectChannelMessages(messages, messagesPerChannel) {
  const list = messages ?? [];
  const n = Number.isInteger(messagesPerChannel) && messagesPerChannel > 0 ? messagesPerChannel : list.length;
  return list.length > n ? list.slice(list.length - n) : list.slice();
}

// ---------------------------------------------------------------------------
// Transcript marking -- own vs context lines (labels.warmup.ownMark / .contextMark)
// ---------------------------------------------------------------------------

/**
 * Prefix each formatTranscript item's last line (the actual `[hh:mm] nick:
 * text` line, as opposed to a `## #channel` heading or a gap/date marker
 * pushed before it) with `labels.warmup.ownMark` when its message id is in
 * `ownIds`, else `labels.warmup.contextMark`. Either label missing ->
 * `''`, i.e. no prefix at all for that side -- every item is still returned
 * (nothing is ever skipped for lack of a marker). Pure.
 * @param {{ id: string, text: string }[]} items  formatTranscript's output.
 * @param {Set<string>} ownIds
 * @param {object} labels
 */
export function markOwnContext(items, ownIds, labels) {
  const ownMark = labels?.warmup?.ownMark ?? '';
  const contextMark = labels?.warmup?.contextMark ?? '';
  if (!ownMark && !contextMark) return items;
  return items.map((item) => {
    const mark = ownIds.has(item.id) ? ownMark : contextMark;
    if (!mark) return item;
    const lines = item.text.split('\n');
    lines[lines.length - 1] = `${mark}${lines[lines.length - 1]}`;
    return { ...item, text: lines.join('\n') };
  });
}

// ---------------------------------------------------------------------------
// Request building -- profile.md / channel.md, fitted under the token cap
// ---------------------------------------------------------------------------

/** Drop the OLDEST items of `items` until `[...fixedItems, ...items]` fits `limit` under `cost` --
 * never trims `fixedItems` (throws SectionsTooLargeError if those alone do not fit). Returns the
 * surviving suffix of `items`, in their original order. */
function fitNewest(fixedItems, items, limit, cost) {
  const { kept } = fitSections(
    [
      { name: 'fixed', required: true, items: fixedItems.filter(Boolean) },
      { name: 'rest', keep: 'newest', items },
    ],
    limit,
    cost,
  );
  return items.slice(items.length - kept.rest.length);
}

/**
 * The placeholder values of a `channel.md` request: `{{fieldChars}}`, the limit
 * `clampChannelResult` cuts each note to, read from the live config (fallback: config.json's
 * value). Pure.
 * @param {object} [config]  The live config.
 * @returns {{ fieldChars: number }}
 */
export function channelTemplateValues(config) {
  return { fieldChars: config?.memory?.fieldChars ?? MEMORY_LIMIT_DEFAULTS.fieldChars };
}

/**
 * Build one `channel.md` request. Pure, mirrors the per-chunk request `processPerson` builds for
 * `profile.md` inline (see its own header comment).
 * @param {object} input
 * @param {object} input.prompts   `prompts.channel` is the system message.
 * @param {object} input.config    Live config.
 * @param {object} input.calibrator
 * @param {{ id: string, name: string, category: string|null, topic: string|null }} input.channel
 * @param {object[]} input.messages  Already selected (see selectChannelMessages), chronological.
 * @param {boolean} input.isMain
 * @param {string} [input.selfName]
 * @param {{ purpose: string, topics: string, tone: string, writtenDaysAgo: number|null }} [input.existing]
 *   The stored notes a sample refresh shows as claims: an `<existing_notes>` block after
 *   `<channel>`, before `<messages>`. Absent on a warmup pass.
 * @returns {{ messages: {role: string, content: string}[], stats: { kept: number, dropped: number, estimatedTokens: number } }}
 */
export function buildChannelRequest({ prompts, config, calibrator, channel, messages: channelMessages, isMain, selfName = '', existing = null }) {
  const labels = requireLabels(prompts);
  const system = fillPromptTemplate(prompts?.channel, channelTemplateValues(config));
  const channelLine = [
    `${channel.name} (id:${channel.id})`,
    channel.category ? `category: ${channel.category}` : null,
    channel.topic ? `topic: ${channel.topic}` : null,
    isMain ? 'main: true' : null,
  ]
    .filter(Boolean)
    .join(', ');
  const channelBlock = block('channel', channelLine);
  const existingBlock = existing ? block('existing_notes', JSON.stringify(existing)) : '';

  const formatOptions = memoryFormatOptions(config, selfName, labels);
  const items = formatTranscript(channelMessages, formatOptions);
  const transcriptTexts = items.map((item) => item.text);

  const cost = sectionCost(calibrator);
  const limit = requestTokenLimit(config);
  const keptTexts = fitNewest([system, channelBlock, existingBlock], transcriptTexts, limit, cost);
  const keptItems = items.slice(items.length - keptTexts.length);

  const messagesBlock = block('messages', renderTranscript(keptItems, formatOptions.timezone, labels));
  const user = [channelBlock, existingBlock, messagesBlock].filter(Boolean).join('\n\n');
  const messages = [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ];

  return {
    messages,
    stats: {
      kept: keptItems.length,
      dropped: items.length - keptItems.length,
      estimatedTokens: calibrator.apply(estimateMessages(messages)),
    },
  };
}

// ---------------------------------------------------------------------------
// Result clamping -- same helpers the stream analyzer uses; the callers store the result
// ---------------------------------------------------------------------------

function makeTokenizer(nameOf) {
  const isKnownId = (id) => typeof nameOf(id) === 'string' && nameOf(id).length > 0;
  const namesOf = (id) => {
    const name = nameOf(id);
    return name ? [name] : [];
  };
  return (text) => (typeof text === 'string' ? toTokens(text, isKnownId, namesOf) : text);
}

/** Tokenize a stray `Name (id:123)` form the model wrote, clamp, then resolve back to
 * `name (id:123)` display text -- same order src/memory/update.js#applyMemoryUpdate uses. */
function clampResolvedField(raw, limit, tolerance, tokenize, nameOf) {
  if (typeof raw !== 'string') return '';
  return fromTokens(clampText(tokenize(raw), limit, { tolerance }), nameOf, 'analyzer');
}

function clampedTimes(value) {
  return Number.isInteger(value) ? Math.min(5, Math.max(1, value)) : 1;
}

/** Merge interest-shaped items (`{ topic, note, times }`) sharing the same normalized topic:
 * the first note wins unless it is empty, `times` is the max seen. */
function dedupeByIdentity(items, identityField) {
  const byKey = new Map();
  for (const item of items) {
    const key = normalizeTopic(item[identityField]);
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, item);
      continue;
    }
    byKey.set(key, {
      ...existing,
      note: existing.note || item.note,
      times: Math.max(existing.times, item.times),
    });
  }
  return [...byKey.values()];
}

/**
 * Validate and clamp the model's `profile.md` JSON with the same helpers the
 * stream analyzer uses (clampText, normalizeTopic, toTokens/fromTokens).
 * Pure: this function writes nothing, but its result is what gets stored -- a
 * warmup person run writes it whole (`writePersonAnswer`). A portrait refresh
 * never clamps a rewrite (refreshWithSlot judges it). `null` on garbage input.
 * @param {unknown} raw
 * @param {object} config  Live config (`config.memory`).
 * @param {(id: string) => (string|null)} nameOf
 */
export function clampProfileResult(raw, config, nameOf = () => null) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const memoryCfg = config?.memory ?? {};
  const tolerance = memoryCfg.clampTolerance;
  const fieldChars = memoryCfg.fieldChars ?? MEMORY_LIMIT_DEFAULTS.fieldChars;
  const topicChars = memoryCfg.interestTopicChars ?? MEMORY_LIMIT_DEFAULTS.interestTopicChars;
  const noteChars = memoryCfg.interestNoteChars ?? MEMORY_LIMIT_DEFAULTS.interestNoteChars;
  const maxNewEpisodes = memoryCfg.maxNewEpisodes ?? MEMORY_LIMIT_DEFAULTS.maxNewEpisodes;
  const tokenize = makeTokenizer(nameOf);
  const resolve = (text, limit) => clampResolvedField(text, limit, tolerance, tokenize, nameOf);

  const character = resolve(raw.character, fieldChars);
  const style = resolve(raw.style, fieldChars);

  const interests = dedupeByIdentity(
    (Array.isArray(raw.interests) ? raw.interests : [])
      .map((it) => {
        if (!it || typeof it !== 'object' || Array.isArray(it)) return null;
        const topic = typeof it.topic === 'string' ? clampText(it.topic, topicChars, { tolerance: 1 }) : '';
        if (!topic) return null;
        return { topic, note: resolve(it.note, noteChars), times: clampedTimes(it.times) };
      })
      .filter(Boolean),
    'topic',
  );

  const details = dedupeByIdentity(
    (Array.isArray(raw.details) ? raw.details : [])
      .map((d) => {
        if (!d || typeof d !== 'object' || Array.isArray(d)) return null;
        const text = resolve(d.text, fieldChars);
        if (!text) return null;
        return { topic: text, text, times: clampedTimes(d.times) };
      })
      .filter(Boolean),
    'topic',
  ).map(({ text, times }) => ({ text, times }));

  const episodes = (Array.isArray(raw.episodes) ? raw.episodes : [])
    .slice(0, maxNewEpisodes)
    .map((ep) => {
      if (!ep || typeof ep !== 'object' || Array.isArray(ep)) return null;
      const what = resolve(ep.what, fieldChars);
      if (!what) return null;
      const quote = typeof ep.quote === 'string' ? clampText(ep.quote, 120, { tolerance: 1 }) : '';
      const feeling = resolve(ep.feeling, fieldChars);
      const date = typeof ep.date === 'string' ? ep.date.slice(0, 10) : '';
      // `weight` is clamped where it is stored (src/memory/episodes.js).
      return { date, what, quote, feeling, weight: ep.weight };
    })
    .filter(Boolean);

  // An alias is clamped where it is stored (src/memory/aliases.js).
  const aliases = (Array.isArray(raw.aliases) ? raw.aliases : []).filter((a) => typeof a === 'string' && a.trim());

  return { character, style, interests, details, episodes, aliases };
}

/**
 * Validate and clamp a two-stage refresh's stage A answer (prompts/portrait.md): `{ "style":
 * "<the whole merged text>", "character": { "keep": [""], "revise": [{ "old": "", "now": "" }],
 * "add": [""], "drop": [{ "old": "" }] } }`. `style` is clamped and resolved like
 * `clampProfileResult`'s (the refresh itself stores its own unclamped judgement of it, see
 * refreshWithSlot); every note of the lists is tokenized (`name
 * (id:...)` -> `<@id>`, the form a voice item's brief keeps) and clamped to `memory.fieldChars`;
 * a blank note, a `revise` entry without `now` and a `drop` entry without `old` are left out (a
 * bare string in `drop` is its `old`). `brief`: only the lists that say something, the
 * character voice item's brief. `changed`: whether the character needs the voice model at all --
 * something to revise, add or drop, or, with no stored portrait (`storedCharacter` blank), any
 * note; `keep` alone restates the stored text (prompts/portrait.md's shape for "nothing
 * changed"). `null` when `raw` or its `character` is not a plain object: that answer cannot be
 * read. Nothing here is stored. Pure.
 * @param {unknown} raw
 * @param {object} config  Live config (`memory.fieldChars`, `memory.clampTolerance`).
 * @param {(id: string) => (string|null)} [nameOf]
 * @param {{ storedCharacter?: string }} [opts]
 * @returns {{ style: string, brief: Record<string, Array<string|{ old?: string, now?: string }>>, changed: boolean } | null}
 */
export function clampPortraitDecision(raw, config, nameOf = () => null, { storedCharacter = '' } = {}) {
  if (!isPlainObject(raw) || !isPlainObject(raw.character)) return null;
  const memoryCfg = config?.memory ?? {};
  const tolerance = memoryCfg.clampTolerance;
  const fieldChars = memoryCfg.fieldChars ?? MEMORY_LIMIT_DEFAULTS.fieldChars;
  const tokenize = makeTokenizer(nameOf);
  const note = (value) => (typeof value === 'string' ? clampText(String(tokenize(value.trim()) ?? ''), fieldChars, { tolerance }) : '');
  const entries = (value) => (Array.isArray(value) ? value : []);

  const lists = {
    keep: entries(raw.character.keep).map(note).filter(Boolean),
    revise: entries(raw.character.revise)
      .map((entry) => {
        const now = isPlainObject(entry) ? note(entry.now) : '';
        if (!now) return null;
        const old = note(entry.old);
        return old ? { old, now } : { now };
      })
      .filter(Boolean),
    add: entries(raw.character.add).map(note).filter(Boolean),
    drop: entries(raw.character.drop)
      .map((entry) => ({ old: note(isPlainObject(entry) ? entry.old : entry) }))
      .filter((entry) => entry.old),
  };
  const brief = Object.fromEntries(PORTRAIT_LISTS.filter((key) => lists[key].length > 0).map((key) => [key, lists[key]]));
  const changed = lists.revise.length + lists.add.length + lists.drop.length > 0 || (lists.keep.length > 0 && !hasText(storedCharacter));
  return { style: clampResolvedField(raw.style, fieldChars, tolerance, tokenize, nameOf), brief, changed };
}

/** Validate and clamp the model's `channel.md` JSON. `null` on garbage input; nothing stored.
 * A warmup pass only: a sample refresh never clamps a rewrite (settleNotesRefresh). */
export function clampChannelResult(raw, config) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const memoryCfg = config?.memory ?? {};
  const tolerance = memoryCfg.clampTolerance;
  const fieldChars = memoryCfg.fieldChars ?? MEMORY_LIMIT_DEFAULTS.fieldChars;
  return {
    purpose: typeof raw.purpose === 'string' ? clampText(raw.purpose, fieldChars, { tolerance }) : '',
    topics: typeof raw.topics === 'string' ? clampText(raw.topics, fieldChars, { tolerance }) : '',
    tone: typeof raw.tone === 'string' ? clampText(raw.tone, fieldChars, { tolerance }) : '',
  };
}

/** The limits of a `server.md` answer, read from the live config (fallbacks: config.json's
 * values): the one reading behind both the prompt's placeholders (`serverTemplateValues`) and
 * the clamp (`clampServerResult`), so the prompt states the limits the code cuts to.
 * `guildFieldChars` (the server notes `patterns` and `starters`) is twice `memory.fieldChars`, the
 * same rule as the stream analyzer's and the voice run's guild fields. */
function serverLimits(config) {
  const memoryCfg = config?.memory ?? {};
  const fieldChars = memoryCfg.fieldChars ?? MEMORY_LIMIT_DEFAULTS.fieldChars;
  return {
    fieldChars,
    guildFieldChars: fieldChars * 2,
    maxInjokes: memoryCfg.maxInjokes ?? MEMORY_LIMIT_DEFAULTS.maxInjokes,
    loreTextChars: config?.lore?.textChars ?? MEMORY_LIMIT_DEFAULTS.loreTextChars,
  };
}

/**
 * The placeholder values of a `server.md` request: `{{name}}`, `{{fieldChars}}`,
 * `{{guildFieldChars}}` (the limit of the server notes `patterns` and `starters`, twice
 * `memory.fieldChars`), `{{maxInjokes}}` and `{{loreTextChars}}` -- the limits
 * `clampServerResult` cuts to. Pure.
 * @param {object} [config]  The live config.
 * @param {string} [selfName]  The persona's display name.
 * @returns {{ name: string|undefined, fieldChars: number, guildFieldChars: number, maxInjokes: number, loreTextChars: number }}
 */
export function serverTemplateValues(config, selfName) {
  return { name: selfName, ...serverLimits(config) };
}

/** Validate and clamp the model's `server.md` JSON (a warmup pass; a sample refresh takes only
 * its in-jokes from here, see settleNotesRefresh). Never `null` -- an empty/garbage answer just
 * yields empty fields; `processServer` writes only the non-empty ones (`nonEmptyFields`), so an
 * empty field never blanks what is stored, and `store.setLore` only ever adds or updates.
 * `patterns`/`starters` are cut to `guildFieldChars`, the lore texts to `loreTextChars`, at most
 * `maxInjokes` in-jokes (`serverLimits`). */
export function clampServerResult(raw, config, nameOf = () => null) {
  const tolerance = config?.memory?.clampTolerance;
  const { guildFieldChars, maxInjokes, loreTextChars } = serverLimits(config);
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { patterns: '', starters: '', injokes: [], lore: [] };

  const tokenize = makeTokenizer(nameOf);
  const resolve = (text, limit) => clampResolvedField(text, limit, tolerance, tokenize, nameOf);

  const patterns = resolve(raw.patterns, guildFieldChars);
  const starters = resolve(raw.starters, guildFieldChars);
  const injokes = (Array.isArray(raw.injokes) ? raw.injokes : [])
    .map((s) => (typeof s === 'string' ? clampText(tokenize(s), INJOKE_CHARS, { tolerance }) : ''))
    .filter(Boolean)
    .slice(0, maxInjokes);

  const lore = (Array.isArray(raw.lore) ? raw.lore : [])
    .map((entry) => {
      if (!entry || typeof entry !== 'object' || Array.isArray(entry)) return null;
      // The title is clamped where it is stored (src/memory/lore.js).
      const title = typeof entry.title === 'string' ? entry.title.trim() : '';
      if (!title) return null;
      const keys = Array.isArray(entry.keys) ? entry.keys.filter((k) => typeof k === 'string' && k.trim()).map((k) => k.trim()) : [];
      const text = resolve(entry.text, loreTextChars);
      return { title, keys, text };
    })
    .filter(Boolean);

  return { patterns, starters, injokes, lore };
}

/**
 * Greedily take the longest PREFIX of `items` (already in the order they must be sent, typically
 * chronological) whose costs sum to at most `budget` -- the opposite of `fitNewest` above, which
 * drops the oldest to fit ONE request; this instead leaves the rest for a FOLLOWING request, so a
 * member's sample that does not fit in one request is cut into the fewest chronological chunks
 * that do (docs/prompt-contract.md, "The warmup"). Always takes at least one item when
 * `items` is non-empty, even if that single item alone exceeds `budget` -- progress must be made;
 * the resulting request may then exceed the cap for that one oversized item, an edge case rather
 * than the common path. Pure.
 * @param {object[]} items
 * @param {number} budget
 * @param {(item: object) => number} cost
 * @returns {{ taken: object[], rest: object[] }}
 */
export function takeFittingPrefix(items, budget, cost) {
  if (!Array.isArray(items) || items.length === 0) return { taken: [], rest: [] };
  let used = 0;
  let count = 0;
  for (; count < items.length; count += 1) {
    const c = cost(items[count]);
    if (count > 0 && used + c > budget) break;
    used += c;
  }
  if (count === 0) count = 1;
  return { taken: items.slice(0, count), rest: items.slice(count) };
}

/** How many `takeFittingPrefix` calls it takes to exhaust `items` under `budget` -- a display-only
 * estimate for the warmup's own progress reporting (a person's `activity.detail.chunk`), using
 * the SAME budget for every future chunk even though a later chunk's fixed blocks (the `<draft>`)
 * may shrink it slightly; harmless since it is recomputed fresh on every chunk. Pure. */
function countChunks(items, budget, cost) {
  let rest = items;
  let count = 0;
  while (rest.length > 0) {
    ({ rest } = takeFittingPrefix(rest, budget, cost));
    count += 1;
  }
  return count;
}

/**
 * The per-iteration `users.<id>` op payloads that write one `profile.md` answer through
 * src/memory/update.js#applyMemoryUpdate -- reused so every existing clamp/token/eviction/
 * confirmation rule applies for free (docs/prompt-contract.md, "The warmup").
 *
 * `character`/`style`/`aliases`/`episodes` are written once, on the first iteration. `interests`/
 * `details` need their stored WEIGHT to land exactly on the answer's `times` (1..5) -- since one
 * `applyMemoryUpdate` call only ever bumps an item's weight by 1 (one sighting per call, see
 * src/memory/interests.js), this returns `max(times)` iterations; an item with `times: T` is
 * included in the first `T` of them, so after all iterations run (each a fresh "sighting" of the
 * SAME item) its stored weight is exactly `T`. Pure: returns iteration payloads, touches nothing.
 * @param {{ character?: string, style?: string, interests?: {topic:string,note:string,times:number}[],
 *   details?: {text:string,times:number}[], episodes?: object[], aliases?: string[] }} answer  From
 *   `clampProfileResult`.
 * @returns {object[]} `ops` objects, each suitable as `update.users.<id>` for `applyMemoryUpdate`.
 */
export function buildPersonWriteIterations(answer) {
  const interests = Array.isArray(answer?.interests) ? answer.interests : [];
  const details = Array.isArray(answer?.details) ? answer.details : [];
  const times = [1, ...interests.map((it) => it.times ?? 1), ...details.map((d) => d.times ?? 1)];
  const maxTimes = Math.max(...times);

  const iterations = [];
  for (let i = 1; i <= maxTimes; i += 1) {
    const ops = {};
    const interestAdd = interests.filter((it) => (it.times ?? 1) >= i).map((it) => ({ topic: it.topic, note: it.note }));
    if (interestAdd.length > 0) ops.interests = { add: interestAdd };
    const detailAdd = details.filter((d) => (d.times ?? 1) >= i).map((d) => d.text);
    if (detailAdd.length > 0) ops.details = { add: detailAdd };
    if (i === 1) {
      if (typeof answer?.character === 'string' && answer.character) ops.character = answer.character;
      if (typeof answer?.style === 'string' && answer.style) ops.style = answer.style;
      if (Array.isArray(answer?.aliases) && answer.aliases.length > 0) ops.aliases = { add: answer.aliases };
      if (Array.isArray(answer?.episodes) && answer.episodes.length > 0) ops.episodes = answer.episodes;
    }
    if (Object.keys(ops).length > 0) iterations.push(ops);
  }
  return iterations;
}

// ---------------------------------------------------------------------------
// Factory -- the only place that touches discord.js and the LLM client
// ---------------------------------------------------------------------------

/** The latest author name seen for each id across `windows`, for `fromTokens`/`toTokens` -- never
 * touches the store (see the module header). */
function buildNameIndex(windows) {
  const latest = new Map();
  for (const window of windows ?? []) {
    for (const message of window.messages ?? []) {
      const id = String(message.authorId);
      const current = latest.get(id);
      if (!current || message.ts >= current.ts) latest.set(id, { name: message.authorName, ts: message.ts });
    }
  }
  return (id) => latest.get(String(id))?.name ?? null;
}

/** The warmup's progress (`state.warmup`, see docs/en/warmup.md) for a WRITE path,
 * created and self-healed in place -- garbage left by an old shape never crashes a read. A stored
 * object whose `version` is not `WARMUP_STATE_VERSION` was written by an older, differently-shaped
 * version of this project: it is foreign, replaced wholesale (nothing carried over) rather than
 * healed field by field, logged once, and the store marked dirty so the fresh object is flushed.
 * An object already at the current version is healed field by field. Reads use `progressView`. */
function warmupState(store) {
  const data = store.state.data;
  if (isForeignProgress(data.warmup)) {
    if (data.warmup !== undefined) {
      log.info('warmup: discarded progress written by an older version, memory is untouched', {});
    }
    data.warmup = { version: WARMUP_STATE_VERSION };
    store.state.markDirty();
  }
  return healProgress(data.warmup);
}

/** The same progress `warmupState` would heal, as a normalised COPY: never writes or dirties
 * state.json (`status()`/`summary()` are reads). */
function progressView(store) {
  const stored = store.state.data.warmup;
  return healProgress(isForeignProgress(stored) ? { version: WARMUP_STATE_VERSION } : structuredClone(stored));
}

/** Whether a stored `state.warmup` must be replaced rather than healed: missing, not an object,
 * or written at another `WARMUP_STATE_VERSION`. */
function isForeignProgress(value) {
  return !value || typeof value !== 'object' || Array.isArray(value) || value.version !== WARMUP_STATE_VERSION;
}

/** Fill every missing or invalid field of a current-version progress object, in place. */
function healProgress(progress) {
  if (typeof progress.startedAt !== 'string') progress.startedAt = null;
  if (typeof progress.finishedAt !== 'string') progress.finishedAt = null;
  if (!Number.isFinite(progress.tokensUsed)) progress.tokensUsed = 0;
  if (!Number.isFinite(progress.requests)) progress.requests = 0;
  if (!progress.done || typeof progress.done !== 'object' || Array.isArray(progress.done)) progress.done = {};
  if (!Array.isArray(progress.done.channels)) progress.done.channels = [];
  if (!Array.isArray(progress.done.people)) progress.done.people = [];
  if (typeof progress.done.server !== 'boolean') progress.done.server = false;
  if (progress.aborted !== null && typeof progress.aborted !== 'string') progress.aborted = null;
  // The portrait refresh counter lived here once; it has its own state keys now (refreshPortrait).
  delete progress.refreshDay;
  delete progress.refreshCount;
  return progress;
}

/**
 * @param {object} deps
 * @param {object} deps.hot       Live config + prompts; read at the moment of use.
 * @param {object} deps.store     From createStore() (src/memory/store.js).
 * @param {import('discord.js').Client} deps.client
 * @param {object} deps.llm       From createLlm() (src/llm/openrouter.js).
 * @param {object} deps.calibrator  From createCalibrator().
 * @param {(guildId: string) => string} deps.getSelfName
 * @param {() => number} [deps.now]
 * @param {(ms: number) => Promise<void>} [deps.sleep]  Used only for a sustained-rate-limit wait
 *   (`warmup.rateLimitWaitMinutes`) -- injectable so tests never actually sleep.
 */
export function createWarmup({ hot, store, client, llm, calibrator, getSelfName, now = Date.now, sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms)) }) {
  const cache = new Map(); // guildId -> { fetchedAt, windows }
  const fetching = new Map(); // guildId -> the fetchGuildWindows promise in flight, see getWindows
  // Fetched windows -> when their history read began (epoch ms): a portrait drawn from them is
  // stamped with it, so the next refresh samples whatever was written after that read.
  const readAtOf = new WeakMap();
  let running = false; // a full run() or one-off runXxx() in flight -- see isWarmingUp()
  let refreshing = 0; // portrait refreshes in flight: waitIdle() waits for them, isWarmingUp() does not
  let notesRefreshing = false; // a notes refresh in flight (one at a time); isWarmingUp() does not see it
  const refreshingUsers = new Set(); // members whose portrait refresh is in flight (one at a time each)
  let idleWaiters = []; // resolvers for waitIdle(), notified once nothing above is in flight
  let consecutiveFailures = 0; // resets on any successful request; 3 in a row aborts the run (resumable)
  let stopRequested = false; // a stop (Ctrl+C in tools/warmup.mjs) -- see `stop()` and run()'s own checkpoints
  let currentAbort = null; // the AbortController for whichever model call is in flight right now
  // (callWithRails), or null between calls -- `stop()` aborts it so the request itself is cancelled,
  // not just the loop stopped after it finishes.
  // Whether the two-stage switch is on while a portrait prompt of that mode is missing (refreshes
  // then send the single request, see portraitMode): warned once each time this turns true.
  let portraitTwoStageUnavailable = false;

  // In-memory-only run activity: exposed via status() as `activity` so `tools/warmup.mjs
  // status` can show WHICH phase a run is actually in right now (fetching history, describing a
  // channel, profiling a person, building the server notes, waiting out a provider rate limit,
  // paused, finished, aborted) instead of just "running" for minutes at a time, and progress
  // fields staying "?"/"-" while the windows cache is still being filled. Never persisted, never
  // read back, never affects the run itself -- a fresh factory always starts at `idle`.
  function freshActivity() {
    return { phase: 'idle', detail: null, lastActivityAt: null };
  }
  let activity = freshActivity();

  /** Replace the activity snapshot with `phase`/`detail` plus a fresh `lastActivityAt`. */
  function touchActivity(phase, detail = null) {
    activity = { phase, detail, lastActivityAt: now() };
  }

  /** Bump `lastActivityAt` without changing the current phase/detail (a completed request). */
  function bumpActivity() {
    activity = { ...activity, lastActivityAt: now() };
  }

  /** (Re-)fetch every readable channel's window, sequentially -- see the module header;
   * `warmup.lookbackDays`/`fetchLimitPerChannel` are read fresh, never cached. */
  async function fetchGuildWindows(guild, cfg) {
    const channels = readableChannels(guild, hot.config.bot);
    const minTs = now() - (cfg.lookbackDays ?? 60) * DAY_MS;
    const selfId = client.user?.id;
    const windows = [];
    touchActivity('fetching', { channelsFetched: 0, channelsTotal: channels.length });
    for (let i = 0; i < channels.length; i += 1) {
      const channel = channels[i];
      let messages = [];
      try {
        messages = await fetchHistoryWindow(channel, {
          limit: cfg.fetchLimitPerChannel ?? 15000,
          minTs,
          selfId,
          embedTextChars: hot.config.media?.embedTextChars,
          videoSites: hot.config.media?.video?.sites,
          maxUrlChars: hot.config.context?.maxUrlChars,
        });
      } catch (err) {
        log.warn('warmup: channel fetch failed, skipping it for this round', { channelId: channel.id, error: err });
      }
      log.info('warmup: channel fetched', { channelId: channel.id, messages: messages.length });
      windows.push({ id: channel.id, name: channel.name, category: channel.parent?.name ?? null, topic: channel.topic ?? null, messages, channel });
      touchActivity('fetching', { channelsFetched: i + 1, channelsTotal: channels.length });
    }
    return windows;
  }

  /** Cached windows for `guildId`, refetched once the 15-minute cache entry has gone stale. A
   * fetch already in flight is shared: concurrent callers (several portrait cues of one batch)
   * wait for the same history read instead of each starting their own. */
  function getWindows(guildId, guild, cfg) {
    const cached = cache.get(guildId);
    if (cached && now() - cached.fetchedAt < CACHE_TTL_MS) return Promise.resolve(cached.windows);
    let pending = fetching.get(guildId);
    if (!pending) {
      const startedAt = now();
      pending = fetchGuildWindows(guild, cfg)
        .then((windows) => {
          readAtOf.set(windows, startedAt);
          cache.set(guildId, { fetchedAt: now(), windows });
          return windows;
        })
        .finally(() => fetching.delete(guildId));
      fetching.set(guildId, pending);
    }
    return pending;
  }

  function resolvedGuild(guildId) {
    return client.guilds?.cache?.get(guildId) ?? null;
  }

  /** `tools/warmup.mjs people`: who currently qualifies, plus totals. Never calls the model. */
  async function peopleReport(guildId) {
    const guild = resolvedGuild(guildId);
    if (!guild) return { ok: false, message: 'no guild resolved yet' };

    const cfg = hot.config.warmup ?? {};
    const windows = await getWindows(guildId, guild, cfg);
    const everyone = pickPeople(windows, { minMessages: 0, maxPeople: Infinity });
    const qualifyingUncapped = pickPeople(windows, { minMessages: cfg.minMessages, maxPeople: Infinity });
    const people = pickPeople(windows, cfg);

    return {
      ok: true,
      people,
      totals: {
        channelsRead: windows.length,
        messagesRead: windows.reduce((sum, w) => sum + w.messages.length, 0),
        belowThreshold: everyone.length - qualifyingUncapped.length,
      },
    };
  }

  // -------------------------------------------------------------------
  // Write path: run() / runXxx() / refreshPortrait() -- see the module header.
  // -------------------------------------------------------------------

  function notifyIdle() {
    if (running || refreshing > 0) return;
    const waiters = idleWaiters;
    idleWaiters = [];
    for (const resolve of waiters) resolve();
  }

  /** Resolves once no run()/runXxx() and no portrait refresh is in flight -- immediately if that
   * is already true. Used by `/nep pause` (src/admin.js), the same shape as
   * src/memory/update.js#createMemoryUpdater's own `waitIdle`; a refresh that finishes after the
   * pause writes nothing (see refreshPortrait). */
  function waitIdle() {
    return running || refreshing > 0 ? new Promise((resolve) => idleWaiters.push(resolve)) : Promise.resolve();
  }

  function isWarmingUp() {
    return running;
  }

  /** A stop (Ctrl+C in tools/warmup.mjs): ENDS any warmup work for good, not just after the request in
   * flight -- sets `stopRequested`, which the same checkpoints in `run()`/`startBulk()` that
   * already honour `store.state.data.paused` also check before starting a new target, AND aborts
   * the model call for the target actually in flight right now (`currentAbort`, see
   * `callWithRails`), so no further tokens are spent past this moment and nothing partial is
   * written for that target (activity ends up `stopped`, progress kept, nothing marks
   * `state.warmup` aborted). Every entry point (`run()`, `runOneTarget()`, `startBulk()`) clears
   * the flag again on its own next start. A no-op, reported as such, when no run is in flight. */
  function stop() {
    if (!running) return { ok: false };
    stopRequested = true;
    currentAbort?.abort();
    return { ok: true };
  }

  function markDone(kind, id) {
    const progress = warmupState(store);
    if (kind === 'server') {
      progress.done.server = true;
    } else if (!progress.done[kind].includes(id)) {
      progress.done[kind].push(id);
    }
    store.state.markDirty();
    store.flush();
  }

  /** `warmup.maxRequestTokens`, the warmup's own (much larger) per-request cap, read now -- the
   * one reading behind both the fitting and the cap a request is sent under. */
  function warmupMaxRequestTokens() {
    return hot.config.warmup?.maxRequestTokens ?? WARMUP_MAX_REQUEST_TOKENS_FALLBACK;
  }

  /** The live config with `llm.maxRequestTokens` overridden to the warmup's own cap -- so
   * buildChannelRequest fits under IT, not the global per-request rail
   * (docs/prompt-contract.md, "The warmup"). */
  function requestConfig() {
    return { ...hot.config, llm: { ...hot.config.llm, maxRequestTokens: warmupMaxRequestTokens() } };
  }

  /** The warmup's per-request token cap after `llm.safetyMargin`, read now. */
  function warmupRequestCap() {
    return requestTokenLimit(hot.config, warmupMaxRequestTokens());
  }

  /** The `llm.complete` options every warmup request shares, read at the call: the model, role
   * and calibration flag of `warmupRoute` (`voice`: the answer words a text in the persona's
   * voice), the analyzer temperature (`memory.temperature`), `warmup.maxOutputTokens` (the
   * route's own budget on the neutral two-stage route), the warmup's request cap and
   * `memory.timeoutMs` (a profile.md answer can take as long as a stream batch). */
  function analyzerRequestOptions({ voice = false } = {}) {
    const route = warmupRoute(hot.config, { voice });
    return {
      ...route,
      temperature: analyzerTemperature(hot.config),
      maxOutputTokens: route.maxOutputTokens ?? hot.config.warmup?.maxOutputTokens ?? 6000,
      maxRequestTokens: warmupRequestCap(),
      timeoutMs: hot.config.memory?.timeoutMs ?? hot.config.llm?.timeoutMs,
    };
  }

  /** A portrait refresh's options: the warmup's, minus its request cap -- a refresh is live
   * behaviour, so `llm.maxRequestTokens` (the 50k rail) and the daily request cap apply. */
  function portraitRequestOptions({ voice = false } = {}) {
    const { maxRequestTokens: _warmupCap, ...options } = analyzerRequestOptions({ voice });
    return options;
  }

  /** One notes refresh request (see refreshChannelNotes): live behaviour, so it is sent like a
   * portrait refresh's -- the 50k rail and `llm.maxRequestsPerDay` apply, the warmup's budget,
   * progress and failure counter are never touched. Never throws: `daily-cap` (DailyCapError),
   * `token-limit` (TokenLimitError), `llm-error` with `detail` for anything else.
   * @returns {Promise<{ ok: true, completion: object } | { ok: false, reason: string, detail?: string }>}
   */
  async function sendNotesRequest(messages, { voice = false } = {}) {
    try {
      return { ok: true, completion: await llm.complete(messages, portraitRequestOptions({ voice })) };
    } catch (err) {
      if (err instanceof DailyCapError) return { ok: false, reason: 'daily-cap' };
      if (err instanceof TokenLimitError) return { ok: false, reason: 'token-limit' };
      return { ok: false, reason: 'llm-error', detail: detailOf(err) };
    }
  }

  /**
   * The end of a notes refresh (processChannel / processServer with `refresh`) once its answer is
   * parsed. Every prose field goes through `judgeProse` against the stored text and its limit,
   * never clamped. A rewrite over its limit re-asks once (`memory.overLimitRetries` > 0): the same
   * request, the first answer (`text`, as returned) and `<over_limit>` listing the over fields
   * (withOverLimit); that answer is
   * judged the same way, whole. An answer with a field still over is `over-limit` (`fields`: the
   * names) and nothing of it is written: the answer is one object, accepted or refused whole.
   * `standDown` runs before a retry is sent and right before the write, with no await left until
   * the write is done (a pause, a forget, newer notes win); `write(accepted, answer)` stores.
   * A retry that fails is the retry's own outcome (`sendNotesRequest`'s reasons, `bad-json`).
   */
  async function settleNotesRefresh({ messages, text, parsed, voice = false, logFields, limits, read, storedOf, standDown, write }) {
    let answer = parsed;
    for (let retried = false; ; retried = true) {
      const stoodDown = standDown();
      if (stoodDown) return stoodDown;
      const { accepted, over } = judgeProse(read(answer), storedOf(), limits, hot.config);
      const overFields = Object.keys(over);
      if (overFields.length === 0) return write(accepted, answer);
      if (retried || !overLimitRetryOn(hot.config)) return { ok: false, reason: 'over-limit', fields: overFields };
      const result = await sendNotesRequest(withOverLimit(messages, text, overLimitOf(over, limits)), { voice });
      if (!result.ok) return result;
      try {
        answer = parseJsonObject(result.completion.text);
      } catch (err) {
        log.warn('warmup: notes retry answer could not be parsed', { ...logFields, detail: errorNameOf(err) });
        return { ok: false, reason: 'bad-json' };
      }
    }
  }

  /**
   * One analyzer-role call, with every warmup rail applied: the token budget
   * (`warmup.maxTokens`, a "stop here, resumable" outcome, never a throw), the per-request cap
   * override, a sustained-429 wait (`rateLimitWaitMinutes` × up to `rateLimitMaxWaits`, then abort,
   * resumable), and the 3-consecutive-other-failures abort. Progress (`tokensUsed`/`requests`) is
   * persisted after every completed request. Never throws: every outcome is reported. Every
   * `warmup.*` rail is read at the call, never from the run's start, so `/nep set` reaches a run
   * already in flight. `voice`: the answer words a text in the persona's voice (see warmupRoute).
   * @returns {Promise<{ ok: true, completion: object } | { ok: false, stop?: boolean, reason: string, error?: Error }>}
   */
  async function callWithRails(messages, { voice = false } = {}) {
    const progress = warmupState(store);
    const estimate = calibrator.apply(estimateMessages(messages));
    const configuredMax = hot.config.warmup?.maxTokens;
    const maxTokens = Number.isFinite(configuredMax) ? configuredMax : Infinity;
    if (progress.tokensUsed + estimate > maxTokens) {
      log.info('warmup: token budget reached, stopping the run (resumable)', { tokensUsed: progress.tokensUsed, estimate, maxTokens });
      progress.aborted = 'budget';
      store.state.markDirty();
      store.flush();
      touchActivity('aborted', { reason: 'budget' });
      return { ok: false, stop: true, reason: 'budget' };
    }

    let waits = 0;
    for (;;) {
      // Honour a stop requested while this target was queued (e.g. between rate-limit waits,
      // or a fresh chunk of the same person's sample) before spending a request on it at all.
      if (stopRequested) {
        touchActivity('stopped');
        return { ok: false, stop: true, reason: 'stopped' };
      }

      let completion;
      const controller = new AbortController();
      currentAbort = controller;
      try {
        completion = await llm.complete(messages, { ...analyzerRequestOptions({ voice }), countAgainstDailyCap: false, signal: controller.signal });
      } catch (err) {
        currentAbort = null;
        // a stop (Ctrl+C in tools/warmup.mjs) aborted THIS call -- report it as a clean stop, never a failure
        // (never retried, never counted towards the 3-consecutive-failures abort).
        if (stopRequested) {
          log.info('warmup: the in-flight request was cancelled by a stop', {});
          touchActivity('stopped');
          return { ok: false, stop: true, reason: 'stopped' };
        }
        if (isRateLimited(err)) {
          waits += 1;
          const cfg = hot.config.warmup ?? {};
          const maxWaits = Number.isFinite(cfg.rateLimitMaxWaits) ? cfg.rateLimitMaxWaits : 36;
          if (waits > maxWaits) {
            log.warn('warmup: rate limit outlasted the wait budget, aborting the run (resumable)', { waits });
            progress.aborted = 'rate-limit';
            store.state.markDirty();
            store.flush();
            touchActivity('aborted', { reason: 'rate-limit' });
            return { ok: false, stop: true, reason: 'rate-limit' };
          }
          log.warn('warmup: rate limited, waiting before retrying', { attempt: waits, waitMinutes: cfg.rateLimitWaitMinutes ?? 10 });
          const waitMs = (cfg.rateLimitWaitMinutes ?? 10) * MINUTE_MS;
          touchActivity('waiting-rate-limit', { until: now() + waitMs, waits });
          await sleep(waitMs);
          continue;
        }

        consecutiveFailures += 1;
        log.warn('warmup: request failed', { detail: detailOf(err), consecutiveFailures });
        if (consecutiveFailures >= 3) {
          log.warn('warmup: three consecutive failures, aborting the run (resumable)');
          progress.aborted = 'failures';
          store.state.markDirty();
          store.flush();
          touchActivity('aborted', { reason: 'failures' });
          return { ok: false, stop: true, reason: 'failures', error: err };
        }
        return { ok: false, stop: false, reason: 'llm-error', error: err };
      }

      currentAbort = null;
      consecutiveFailures = 0;
      progress.tokensUsed += completion.usage?.total_tokens ?? completion.estimated ?? estimate;
      progress.requests += 1;
      store.state.markDirty();
      store.flush();
      bumpActivity();
      return { ok: true, completion };
    }
  }

  /** A fresh 30-newest-UTC-date histogram of `messages` -- mirrors src/memory/store.js's own
   * (private) `trimDays`, computed once from the whole window instead of accumulated incrementally;
   * the highest date key present is always the newest message's date, so trimming to the newest 30
   * KEYS is the same as trimming "relative to the newest message". Pure. */
  function dayHistogram(messages) {
    const days = {};
    for (const message of messages ?? []) {
      if (!Number.isFinite(message?.ts)) continue;
      const key = utcDay(message.ts);
      days[key] = (days[key] ?? 0) + 1;
    }
    const keys = Object.keys(days).sort();
    for (const key of keys.slice(0, Math.max(0, keys.length - 30))) delete days[key];
    return days;
  }

  /** Up to 5 `{ id, count }` of who wrote most in `messages`, most active first -- bots and the
   * persona's own messages excluded, same as `collectAuthorStats` above. Pure. */
  function topWritersOf(messages) {
    const counts = new Map();
    for (const message of messages ?? []) {
      if (message?.bot || message?.self) continue;
      const id = String(message.authorId);
      counts.set(id, (counts.get(id) ?? 0) + 1);
    }
    return [...counts.entries()]
      .map(([id, count]) => ({ id, count }))
      .sort((a, b) => b.count - a.count || a.id.localeCompare(b.id))
      .slice(0, 5);
  }

  /** The `store.setChannelFacts` payload for one channel, from the messages it actually had
   * (`messages` -- the deeper-fetched set when `processChannel` used one): count, min/max ts, a
   * fresh 30-day histogram and the top 5 writers. Zeros and empty lists when the channel had no
   * messages at all. Pure. */
  function channelFactsFromMessages(window, messages) {
    const list = messages ?? [];
    const timestamps = list.map((m) => m.ts).filter(Number.isFinite);
    return {
      name: window.name,
      category: window.category,
      topic: window.topic,
      messageCount: list.length,
      firstMessageAt: timestamps.length ? Math.min(...timestamps) : null,
      lastMessageAt: timestamps.length ? Math.max(...timestamps) : null,
      days: dayHistogram(list),
      topWriters: topWritersOf(list),
    };
  }

  /** Sets `messageCount`/`firstSeen`/`lastSeen`/`names` on the stored profile FROM the fetched
   * window (`member`, see pickPeople/memberStats: `messages` = count in the window, `firstTs`/
   * `lastTs` = min/max, `name` = the newest nick) -- SET, never added, so a redo (`tools/warmup.mjs
   * users`, with or without `--user <id>`, reprocessing an already-profiled member) lands on the
   * same counters as a first write instead of doubling them (unlike src/memory/store.js#touchUser,
   * built for the live pipeline's one-message-at-a-time calls, which this deliberately does NOT use
   * here). */
  function touchUserFromWindows(guildId, member) {
    const existing = store.getUser(guildId, member.id);
    const names = existing?.names?.length
      ? [member.name, ...existing.names.filter((n) => n !== member.name)].slice(0, 5)
      : [member.name];
    store.updateUser(guildId, member.id, {
      names,
      firstSeen: new Date(member.firstTs).toISOString(),
      lastSeen: new Date(member.lastTs).toISOString(),
      messageCount: member.messages,
    });
  }

  /** Writes one `profile.md` answer for `member` through applyMemoryUpdate (see
   * `buildPersonWriteIterations`) -- attitude/relationship untouched. An answer that carries a
   * portrait stamps it like a refresh does (`portraitRefreshedAt` = `readAtMs`, when the run's
   * history read began, and `portraitMessageCount` = the message count this run just SET from its
   * window, see src/memory/portrait.js), and settles a character item a two-stage refresh queued
   * for the member (see stampPortrait). An answer without one moves an existing count stamp by
   * as much as the SET moved the count, so the own messages since the last portrait stay what
   * they were. */
  function writePersonAnswer(guildId, member, answer, readAtMs) {
    const before = store.getUser(guildId, member.id);
    const ownBefore = Number.isFinite(before?.portraitMessageCount)
      ? Math.max(0, storedCount(before.messageCount) - storedCount(before.portraitMessageCount))
      : null;
    touchUserFromWindows(guildId, member);

    const knownUserIds = new Set([String(member.id)]);
    const batchAuthorNames = new Map([[String(member.id), member.name]]);
    const seenAt = Number.isFinite(member.lastTs) ? member.lastTs : now();
    const timing = { seenAtByUser: new Map([[String(member.id), seenAt]]), seenAt };
    const cfgForOps = { ...hot.config.memory, confirmGapHours: 0 };
    const episodesCfg = { enabled: true, maxEpisodes: hot.config.memory?.maxEpisodes, maxNew: Infinity, now: seenAt };

    const iterations = buildPersonWriteIterations(answer);
    for (const ops of iterations) {
      applyMemoryUpdate(
        store,
        guildId,
        { users: { [member.id]: ops } },
        cfgForOps,
        knownUserIds,
        // No relationships (attitude is never warmed up) and no lore: not a per-person field.
        // A person run is one of the two writers of a portrait.
        { episodes: episodesCfg, timing, batchAuthorNames, portraitFields: true, by: 'warmup', versions: versionSettings(hot.config) },
      );
    }
    if (answer?.character || answer?.style) {
      // A newer portrait: a character merge still queued for the voice model is settled with it.
      stampPortrait(guildId, member.id, readAtMs);
    } else if (ownBefore !== null) {
      const count = storedCount(store.getUser(guildId, member.id)?.messageCount);
      store.updateUser(guildId, member.id, { portraitMessageCount: Math.max(0, count - ownBefore) });
    }
    store.flush();
    return { iterations: iterations.length };
  }

  /** The stamps of a portrait decision just stored (a portrait written, or a two-stage check that
   * changes nothing): `portraitRefreshedAt` = `readAtMs`, when the history it was drawn from
   * began to be read (the next refresh samples own lines from then on, so a line written after
   * that read is never skipped; now when not given), the member's message count it covers (read
   * now, see src/memory/portrait.js#portraitDue), no pending attempt, and no longer waiting
   * (`portraitDueAt`, the scheduler's stamp). In the same synchronous
   * step the member's queued character item goes (`dropQueuedCharacter`): it is older than this
   * decision, which read every line it was drawn from. */
  function stampPortrait(guildId, userId, readAtMs) {
    store.updateUser(guildId, userId, {
      portraitRefreshedAt: new Date(Number.isFinite(readAtMs) ? readAtMs : now()).toISOString(),
      portraitMessageCount: storedCount(store.getUser(guildId, userId)?.messageCount),
      portraitAttemptAt: null,
      portraitDueAt: null,
    });
    dropQueuedCharacter(guildId, userId);
  }

  /** Take the member's public `character` voice item (a two-stage refresh's brief the voice model
   * has not worded yet) out of the guild's queue, in one synchronous read-modify-write
   * (`store.updateVoiceQueue`; nothing changes, and nothing is written, when none is queued).
   * Called whenever a newer portrait decision is stored for the member, so the voice run never
   * merges the stale brief over it nor dates the portrait back to the item's `createdAt`; an
   * answer for the item already in flight is dropped too, since the voice run writes only the
   * sent items still queued (src/memory/update.js#applyVoiceAnswer). */
  function dropQueuedCharacter(guildId, userId) {
    const id = String(userId);
    store.updateVoiceQueue(guildId, (queue) => queue.filter((item) => !(isQueuedPortrait(item) && item.userId === id)));
  }

  /** Stamp an attempt that ended without a stored portrait, so the member backs off
   * `memory.portraitRetryHours` -- only onto a profile that exists (never creates one). */
  function stampAttempt(guildId, userId, value = new Date(now()).toISOString()) {
    if (!store.getUser(guildId, userId)) return;
    store.updateUser(guildId, userId, { portraitAttemptAt: value });
  }

  // Outcomes of processChannel / processPerson / processServer. `{ ok: true, ... }` on a write (the
  // target is marked done). Every other outcome carries a `reason`: `no-prompt`, the rails'
  // `budget`/`rate-limit`/`failures`/`stopped`/`paused` (all with `stop: true`: the run ends,
  // resumable), `llm-error`, `over-cap` (the fixed blocks alone exceed the request cap, nothing
  // sent), `bad-json`, `unparsable` and `nothing-to-sample`. The one rule for marking done: a
  // target is marked done after a write or a final skip (`skipped: true`: `nothing-to-sample`,
  // or `unparsable` -- no usable answer even after the half-sample retry). Every other failure
  // leaves it to the next run.

  /** One channel → `channel.md` → `store.updateChannel`. See `callWithRails` for the stop/failure
   * contract and the comment above for the outcomes; `{ ok: true }` on a clean write. A single
   * bad answer is `bad-json`, retried by the next run.
   * `progress` (`{ index, total }`, both 1-based/count, optional) is this channel's position among
   * the run's eligible channels -- purely for `activity.detail`, a one-off `tools/warmup.mjs channels
   * channel:` call omits it.
   * `refresh` (`{ sample, existing, version }`, a sample refresh, see refreshChannelNotes): the
   * request reads `sample` as it is (no deeper fetch) with the stored notes `existing` as
   * `<existing_notes>`; the answer is dropped as `conflict` when the channel's `updatedAt` is no
   * longer `version`, and otherwise written like a pass's, but without the channel facts or the
   * warmup progress: `{ ok: true, changed }`, the review stamped either way. */
  async function processChannel(guildId, window, cfg, mainChannelIds, progress, { refresh } = {}) {
    if (!refresh) touchActivity('channel', { id: window.id, name: window.name, index: progress?.index ?? null, total: progress?.total ?? null });
    if (!hot.prompts?.channel) {
      return { ok: false, stop: true, reason: 'no-prompt', message: 'prompt file missing: prompts/channel.md (or prompts.local/channel.md) is not configured yet' };
    }
    const isMain = mainChannelIds.has(String(window.id));
    // A channel quiet in the lookback window is described from its newest messages regardless of
    // age (a diary or a topical channel must be on the map before it wakes up); a channel with no
    // history at all is described from its name, category and topic alone.
    let source = window.messages;
    const wanted = cfg.messagesPerChannel ?? 200;
    if (!refresh && source.length < wanted && window.channel) {
      try {
        source = await fetchHistoryWindow(window.channel, { limit: wanted, minTs: 0, selfId: client.user?.id, embedTextChars: hot.config.media?.embedTextChars, videoSites: hot.config.media?.video?.sites, maxUrlChars: hot.config.context?.maxUrlChars });
        log.info('warmup: quiet channel fetched deeper', { channelId: window.id, messages: source.length });
      } catch (err) {
        log.warn('warmup: deeper fetch failed, describing from the window', { channelId: window.id, error: err });
      }
    }
    const selected = refresh ? refresh.sample : selectChannelMessages(source, cfg.messagesPerChannel);
    const selfName = getSelfName(guildId);

    let built;
    try {
      // A refresh is fitted under the live per-request rail it is sent under (sendNotesRequest).
      built = buildChannelRequest({ prompts: hot.prompts, config: refresh ? hot.config : requestConfig(), calibrator, channel: window, messages: selected, isMain, selfName, existing: refresh?.existing ?? null });
    } catch (err) {
      if (err instanceof SectionsTooLargeError) {
        log.warn('warmup: channel request does not fit even the minimum, skipping this round', { channelId: window.id });
        return { ok: false, reason: 'over-cap' };
      }
      throw err;
    }

    const result = refresh ? await sendNotesRequest(built.messages) : await callWithRails(built.messages);
    if (!result.ok) return result;

    let parsed;
    try {
      parsed = parseJsonObject(result.completion.text);
    } catch (err) {
      log.warn('warmup: channel answer could not be parsed, will retry next run', { channelId: window.id, detail: errorNameOf(err) });
      return { ok: false, reason: 'bad-json' };
    }

    if (refresh) {
      const fieldChars = hot.config.memory?.fieldChars ?? MEMORY_LIMIT_DEFAULTS.fieldChars;
      const notesOf = (record) => ({ purpose: record?.purpose ?? '', topics: record?.topics ?? '', tone: record?.tone ?? '' });
      const textOf = (value) => (typeof value === 'string' ? value : '');
      return settleNotesRefresh({
        messages: built.messages,
        text: result.completion.text,
        parsed,
        logFields: { channelId: window.id },
        limits: { purpose: fieldChars, topics: fieldChars, tone: fieldChars },
        read: (answer) => ({ purpose: textOf(answer?.purpose), topics: textOf(answer?.topics), tone: textOf(answer?.tone) }),
        storedOf: () => notesOf(store.getChannel(guildId, window.id)),
        // A pause, a forget or a newer note wins.
        standDown: () => {
          if (store.state.data.paused) return { ok: false, reason: 'paused' };
          const current = store.getChannel(guildId, window.id);
          if (!current) return { ok: false, reason: 'gone' };
          if ((current.updatedAt ?? null) !== refresh.version) return { ok: false, reason: 'conflict' };
          return null;
        },
        write: (fields) => {
          const snapshot = () => JSON.stringify(notesOf(store.getChannel(guildId, window.id)));
          const before = snapshot();
          if (Object.keys(fields).length > 0) store.updateChannel(guildId, window.id, fields, { by: 'refresh', versions: versionSettings(hot.config) });
          const changed = snapshot() !== before;
          store.markNotesSampled(guildId, window.id, now(), { outcome: 'reviewed' });
          store.flush();
          return { ok: true, changed, channel: { id: window.id, name: window.name }, result: fields };
        },
      });
    }
    const clamped = clampChannelResult(parsed, hot.config);
    const fields = nonEmptyFields(clamped);
    if (Object.keys(fields).length > 0) store.updateChannel(guildId, window.id, fields, { by: 'warmup', versions: versionSettings(hot.config) });
    // A channel note without its counters/top writers looks dead and
    // anonymous until live traffic slowly fills them in (see the module
    // header and docs/prompt-contract.md) -- fill them now from the
    // same messages the note itself was written from.
    const facts = channelFactsFromMessages(window, source);
    store.setChannelFacts(guildId, window.id, facts);
    markDone('channels', window.id);
    return { ok: true, channel: { id: window.id, name: window.name }, result: clamped, facts };
  }

  /** One person → `profile.md`, chunked chronologically when the sample does not fit one request
   * (each chunk after the first carries the previous answer as `<draft>`) → the store, via
   * `writePersonAnswer`. See `callWithRails` for the stop/failure contract and the comment above
   * `processChannel` for the outcomes. A bad-json/truncated answer is retried once with half the
   * sample; a second failure is a final skip (`unparsable`, marked done). `progress` (`{ index, total }`, optional) is this person's position among the run's
   * eligible people, carried through the half-sample retry -- purely for `activity.detail`, a
   * one-off `tools/warmup.mjs users --user` call omits it. */
  async function processPerson(guildId, windows, member, cfg, mainChannelIds, sampleCfgOverride, progress) {
    touchActivity('person', { id: member.id, name: member.name, index: progress?.index ?? null, total: progress?.total ?? null, chunk: null });
    if (!hot.prompts?.profile) {
      return { ok: false, stop: true, reason: 'no-prompt', message: 'prompt file missing: prompts/profile.md (or prompts.local/profile.md) is not configured yet' };
    }
    const sampleCfg = sampleCfgOverride ?? cfg;
    const sample = sampleMember(windows, member.id, sampleCfg, mainChannelIds);
    if (sample.messages.length === 0) {
      markDone('people', member.id);
      return { ok: false, skipped: true, reason: 'nothing-to-sample' };
    }

    const selfName = getSelfName(guildId);
    const labels = requireLabels(hot.prompts);
    const formatOptions = memoryFormatOptions(hot.config, selfName, labels);
    const { timezone } = formatOptions;
    const items = markOwnContext(formatTranscript(sample.messages, formatOptions), sample.ownIds, labels);

    const limit = warmupRequestCap();
    const cost = sectionCost(calibrator);
    const system = fillPromptTemplate(hot.prompts.profile, profileTemplateValues(hot.config, selfName));
    const characterBlock = block('character', characterText(hot.prompts, selfName));
    const memberBlock = block('member', memberLine(member));
    const nameOf = buildNameIndex(windows);

    let remaining = items;
    let draft = null;
    let answer = null;
    let chunksDone = 0; // completed chunks so far -- feeds the "chunk k/n" detail below
    let tokensUsed = 0; // summed across every chunk -- surfaced to `tools/warmup.mjs users --user <id>`'s reply

    while (remaining.length > 0) {
      if (store.state.data.paused) {
        touchActivity('paused');
        return { ok: false, stop: true, reason: 'paused' };
      }

      const draftBlock = draft ? block('draft', JSON.stringify(draft)) : '';
      const fixedTexts = [system, characterBlock, memberBlock, draftBlock].filter(Boolean);
      const fixedCost = fixedTexts.reduce((sum, text) => sum + cost(text), 0);
      const budget = limit - fixedCost;
      if (budget <= 0) {
        log.warn('warmup: the fixed profile blocks alone exceed the request cap, skipping this person', { userId: member.id });
        return { ok: false, reason: 'over-cap' };
      }

      const itemCost = (item) => cost(item.text);
      // Display-only: how many chunks THIS person's sample takes in total, estimated fresh on every
      // chunk (see countChunks) -- only shown once it is actually more than one.
      const chunksEstimate = chunksDone + countChunks(remaining, budget, itemCost);
      const chunk = chunksEstimate > 1 ? { k: chunksDone + 1, n: chunksEstimate } : null;
      touchActivity('person', { id: member.id, name: member.name, index: progress?.index ?? null, total: progress?.total ?? null, chunk });

      const { taken, rest } = takeFittingPrefix(remaining, budget, itemCost);
      remaining = rest;
      chunksDone += 1;
      const snippetsBlock = block('snippets', renderTranscript(taken, timezone, labels));
      const user = [characterBlock, memberBlock, draftBlock, snippetsBlock].filter(Boolean).join('\n\n');
      const messages = [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ];

      // A profile answer words the character and each episode's feeling: the persona's voice.
      const result = await callWithRails(messages, { voice: true });
      if (!result.ok) {
        if (result.stop) return result;
        return { ok: false, reason: result.reason }; // llm-error, not (yet) a run-aborting streak -- retry this person next run
      }
      tokensUsed += result.completion.usage?.total_tokens ?? result.completion.estimated ?? 0;

      let parsed;
      try {
        parsed = parseJsonObject(result.completion.text);
      } catch (err) {
        if (!sampleCfgOverride) {
          const truncated = looksTruncated(result.completion.text, result.completion.finishReason);
          const halved = { ...cfg, messagesPerPerson: Math.max(1, Math.floor((sampleCfg.messagesPerPerson ?? sample.messages.length) / 2)) };
          log.warn('warmup: person answer could not be parsed, retrying with half the sample', { userId: member.id, truncated, detail: errorNameOf(err) });
          return processPerson(guildId, windows, member, halved, mainChannelIds, halved, progress);
        }
        log.warn('warmup: person answer still bad after a retry, skipping this person', { userId: member.id, detail: errorNameOf(err) });
        markDone('people', member.id);
        return { ok: false, skipped: true, reason: 'unparsable' };
      }

      const clamped = clampProfileResult(parsed, hot.config, nameOf);
      draft = clamped;
      answer = clamped;
    }

    writePersonAnswer(guildId, member, answer, readAtOf.get(windows));
    markDone('people', member.id);
    return {
      ok: true,
      member,
      answer,
      sample: { ownCount: sample.ownCount, contextCount: sample.contextCount },
      tokensUsed,
      chunks: chunksDone,
    };
  }

  /** The server-wide `server.md` request: `<channels>` = stored channel notes, `<members>` = one
   * line per profiled member, `<messages>` = newest `serverSampleMessages` of the main channels (or
   * the single busiest channel when none is marked main) → `store.updateGuild`/`store.setLore`.
   * Outcomes as for `processChannel`: a bad answer is `bad-json`, retried by the next run.
   * `refresh` (`{ sample, existing, version }`, a sample refresh, see refreshServerNotes):
   * `<messages>` is `sample` as it is, the stored notes `existing` go in an `<existing_notes>`
   * block before it; the answer is dropped as `conflict` when the guild's `notesUpdatedAt` is no
   * longer `version`, otherwise only `patterns`/`starters`/`injokes` are written (lore has its own
   * path), the warmup progress untouched: `{ ok: true, changed }`, the review stamped either way. */
  async function processServer(guildId, windows, cfg, mainChannelIds, people, { refresh } = {}) {
    if (!refresh) touchActivity('server');
    if (!hot.prompts?.server) {
      return { ok: false, stop: true, reason: 'no-prompt', message: 'prompt file missing: prompts/server.md (or prompts.local/server.md) is not configured yet' };
    }
    const selfName = getSelfName(guildId);
    const labels = requireLabels(hot.prompts);
    const formatOptions = memoryFormatOptions(hot.config, selfName, labels);
    const { timezone } = formatOptions;

    const system = fillPromptTemplate(hot.prompts.server, serverTemplateValues(hot.config, selfName));
    const characterBlock = block('character', characterText(hot.prompts, selfName));

    const channelsView = {};
    for (const window of windows) {
      const stored = store.getChannel(guildId, window.id);
      channelsView[window.id] = {
        name: stored?.name || window.name,
        category: stored?.category ?? window.category,
        topic: stored?.topic ?? window.topic,
        purpose: stored?.purpose ?? '',
        topics: stored?.topics ?? '',
        tone: stored?.tone ?? '',
      };
    }
    const channelsBlock = block('channels', JSON.stringify(channelsView));

    const memberLines = people.map((person) => {
      const profile = store.getUser(guildId, person.id);
      const character = String(profile?.character ?? '').slice(0, 150);
      const topInterests = topByRank(profile?.interests ?? [], 5).map((it) => it.topic);
      const interestsPart = topInterests.length > 0 ? ` | interests: ${topInterests.join(', ')}` : '';
      return `${person.name} (id:${person.id}): ${character}${interestsPart}`;
    });
    const membersBlock = block('members', memberLines.join('\n'));

    const mainWindows = windows.filter((window) => mainChannelIds.has(String(window.id)));
    const sourceWindows = mainWindows.length > 0 ? mainWindows : [...windows].sort((a, b) => b.messages.length - a.messages.length).slice(0, 1);
    const pooled = sourceWindows.flatMap((window) => window.messages).sort((a, b) => a.ts - b.ts);
    const newest = refresh ? refresh.sample : selectChannelMessages(pooled, cfg.serverSampleMessages);
    const items = formatTranscript(newest, formatOptions);
    const messagesBlock = block('messages', renderTranscript(items, timezone, labels));
    const existingBlock = refresh?.existing ? block('existing_notes', JSON.stringify(refresh.existing)) : '';

    const user = [characterBlock, channelsBlock, membersBlock, existingBlock, messagesBlock].filter(Boolean).join('\n\n');
    const messages = [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];

    // A server answer words the patterns and starters notes: the persona's voice.
    const result = refresh ? await sendNotesRequest(messages, { voice: true }) : await callWithRails(messages, { voice: true });
    if (!result.ok) return result;

    let parsed;
    try {
      parsed = parseJsonObject(result.completion.text);
    } catch (err) {
      log.warn('warmup: server answer could not be parsed, will retry next run', { detail: errorNameOf(err) });
      return { ok: false, reason: 'bad-json' };
    }

    const nameOf = buildNameIndex(windows);
    if (refresh) {
      const { guildFieldChars } = serverLimits(hot.config);
      const tokenize = makeTokenizer(nameOf);
      // Resolved as on a warmup pass (clampResolvedField), without the cut.
      const textOf = (value) => (typeof value === 'string' ? fromTokens(tokenize(value), nameOf, 'analyzer') : '');
      return settleNotesRefresh({
        messages,
        text: result.completion.text,
        parsed,
        voice: true,
        logFields: {},
        limits: { patterns: guildFieldChars, starters: guildFieldChars },
        read: (answer) => ({ patterns: textOf(answer?.patterns), starters: textOf(answer?.starters) }),
        storedOf: () => {
          const stored = store.getGuild(guildId);
          return { patterns: stored.patterns ?? '', starters: stored.starters ?? '' };
        },
        // A pause or newer notes win.
        standDown: () => {
          if (store.state.data.paused) return { ok: false, reason: 'paused' };
          if ((store.getGuild(guildId).notesUpdatedAt ?? null) !== refresh.version) return { ok: false, reason: 'conflict' };
          return null;
        },
        write: (fields, answer) => {
          // The in-jokes are a list, not prose: each is cut to its hard limit, as on a warmup pass.
          const guildFields = { ...fields, ...nonEmptyFields({ injokes: clampServerResult(answer, hot.config, nameOf).injokes }) };
          const snapshot = () => {
            const stored = store.getGuild(guildId);
            return JSON.stringify([stored.patterns ?? '', stored.starters ?? '', stored.injokes ?? []]);
          };
          const before = snapshot();
          if (Object.keys(guildFields).length > 0) store.updateGuild(guildId, guildFields, { by: 'refresh', versions: versionSettings(hot.config) });
          const changed = snapshot() !== before;
          store.markNotesSampled(guildId, 'guild', now(), { outcome: 'reviewed' });
          store.flush();
          return { ok: true, changed };
        },
      });
    }
    const clamped = clampServerResult(parsed, hot.config, nameOf);
    const guildFields = nonEmptyFields({ patterns: clamped.patterns, starters: clamped.starters, injokes: clamped.injokes });
    const written = { by: 'warmup', versions: versionSettings(hot.config) };
    if (Object.keys(guildFields).length > 0) store.updateGuild(guildId, guildFields, written);
    if (clamped.lore.length > 0) {
      store.setLore(guildId, clamped.lore, {
        source: 'analyzer',
        now: now(),
        maxEntries: hot.config.lore?.maxEntries,
        textChars: hot.config.lore?.textChars,
        clampTolerance: hot.config.memory?.clampTolerance,
        ...written,
      });
    }
    markDone('server');
    return {
      ok: true,
      counts: {
        patternsChars: clamped.patterns.length,
        startersChars: clamped.starters.length,
        injokes: clamped.injokes.length,
        lore: clamped.lore.length,
      },
    };
  }

  /** The whole run, in order (channels → people → server), resuming whatever `state.warmup.done`
   * already covers. Stops (never throws) on: pause, a missing prompt file, the token budget, a
   * sustained rate limit, or three consecutive other failures -- all resumable by calling `run`
   * again. Refuses while another run/one-off target is already in flight. */
  async function run(guildId) {
    if (running) return { ok: false, message: 'a warmup run is already in flight' };
    const guild = resolvedGuild(guildId);
    if (!guild) return { ok: false, message: 'no guild resolved yet' };

    running = true;
    consecutiveFailures = 0;
    stopRequested = false;
    const progress = warmupState(store);
    if (!progress.startedAt) progress.startedAt = new Date(now()).toISOString();
    progress.finishedAt = null;
    progress.aborted = null;
    store.state.markDirty();
    store.flush();
    log.info('warmup: run starting', { guildId });

    try {
      const cfg = hot.config.warmup ?? {};
      const windows = await getWindows(guildId, guild, cfg);
      const mainChannelIds = mainChannelSet(hot.config.memory?.mainChannelIds);

      const eligibleChannels = windows; // every readable channel gets a note: the map must cover channels that may wake up later
      for (let i = 0; i < eligibleChannels.length; i += 1) {
        const window = eligibleChannels[i];
        if (store.state.data.paused) {
          touchActivity('paused');
          return { ok: false, message: 'paused' };
        }
        if (stopRequested) {
          touchActivity('stopped');
          return { ok: false, message: 'stopped' };
        }
        if (progress.done.channels.includes(window.id)) continue;
        const outcome = await processChannel(guildId, window, cfg, mainChannelIds, { index: i + 1, total: eligibleChannels.length });
        if (outcome.stop) return { ok: false, message: outcome.message ?? outcome.reason };
      }

      const people = pickPeople(windows, cfg);
      for (let i = 0; i < people.length; i += 1) {
        const person = people[i];
        if (store.state.data.paused) {
          touchActivity('paused');
          return { ok: false, message: 'paused' };
        }
        if (stopRequested) {
          touchActivity('stopped');
          return { ok: false, message: 'stopped' };
        }
        if (progress.done.people.includes(person.id)) continue;
        const outcome = await processPerson(guildId, windows, person, cfg, mainChannelIds, undefined, { index: i + 1, total: people.length });
        if (outcome.stop) return { ok: false, message: outcome.message ?? outcome.reason };
      }

      if (!progress.done.server) {
        if (store.state.data.paused) {
          touchActivity('paused');
          return { ok: false, message: 'paused' };
        }
        if (stopRequested) {
          touchActivity('stopped');
          return { ok: false, message: 'stopped' };
        }
        const outcome = await processServer(guildId, windows, cfg, mainChannelIds, people);
        if (outcome.stop) return { ok: false, message: outcome.message ?? outcome.reason };
      }

      progress.finishedAt = new Date(now()).toISOString();
      store.state.markDirty();
      store.flush();
      touchActivity('finished');
      log.info('warmup: run finished', { guildId, tokensUsed: progress.tokensUsed, requests: progress.requests });
      return { ok: true };
    } finally {
      running = false;
      notifyIdle();
    }
  }

  /** `tools/warmup.mjs users --user <id>` / `channels --channel <id>` / `server`: (re)do exactly
   * one target right now, synchronously.
   * Refused while a run (full, another one-off, or a `users`/`channels` bulk redo) is already in
   * flight, or while paused. */
  async function runOneTarget(guildId, kind, id) {
    if (running) return { ok: false, message: 'a warmup run is already in flight' };
    if (store.state.data.paused) return { ok: false, message: 'paused -- run /nep resume first' };
    const guild = resolvedGuild(guildId);
    if (!guild) return { ok: false, message: 'no guild resolved yet' };

    running = true;
    consecutiveFailures = 0;
    stopRequested = false;
    try {
      const cfg = hot.config.warmup ?? {};
      const windows = await getWindows(guildId, guild, cfg);
      const mainChannelIds = mainChannelSet(hot.config.memory?.mainChannelIds);

      if (kind === 'channel') {
        const window = windows.find((w) => w.id === String(id));
        if (!window) return { ok: false, message: 'channel not found, not readable, or not in this guild' };
        const outcome = await processChannel(guildId, window, cfg, mainChannelIds);
        return outcome.ok ? { ok: true, outcome } : { ok: false, message: outcome.message ?? outcome.reason ?? 'failed', outcome };
      }
      if (kind === 'person') {
        const member = memberStats(windows, id);
        if (!member) return { ok: false, message: 'no messages in the window' };
        const outcome = await processPerson(guildId, windows, member, cfg, mainChannelIds);
        return outcome.ok ? { ok: true, outcome } : { ok: false, message: outcome.message ?? outcome.reason ?? 'failed', outcome };
      }
      if (kind === 'server') {
        const people = pickPeople(windows, cfg);
        const outcome = await processServer(guildId, windows, cfg, mainChannelIds, people);
        return outcome.ok ? { ok: true, outcome } : { ok: false, message: outcome.message ?? outcome.reason ?? 'failed', outcome };
      }
      return { ok: false, message: `unknown target: ${kind}` };
    } finally {
      running = false;
      notifyIdle();
    }
  }

  /**
   * `tools/warmup.mjs users`/`channels`: (re)do EVERY qualifying member (`pickPeople`)
   * or every readable channel now, sharing `running` (and so every rail: mute, pause/resume,
   * `state.warmup.done`) with `run()` -- a redo re-processes every target regardless of `done`,
   * then marks it done either way (processChannel/processPerson already do, idempotently). Resolves
   * once the target COUNT is known and the background loop has been started, NOT once the loop
   * itself finishes, so the caller can report "started N …" at once; progress from then on is
   * `tools/warmup.mjs status`'s job. Refused (before starting anything) while a run/one-off target is
   * already in flight, or while paused.
   * @param {string} guildId
   * @param {'people'|'channels'} kind
   */
  async function startBulk(guildId, kind) {
    if (running) return { ok: false, message: 'a warmup run is already in flight' };
    if (store.state.data.paused) return { ok: false, message: 'paused -- run /nep resume first' };
    const guild = resolvedGuild(guildId);
    if (!guild) return { ok: false, message: 'no guild resolved yet' };

    // Claimed before the history fetch, like run(): a second redo started meanwhile is refused and
    // the persona is muted for the fetch too. Released at once when there is nothing to loop over.
    running = true;
    consecutiveFailures = 0;
    stopRequested = false;
    const release = () => {
      running = false;
      notifyIdle();
    };

    const cfg = hot.config.warmup ?? {};
    let windows;
    try {
      windows = await getWindows(guildId, guild, cfg);
    } catch (err) {
      release();
      throw err;
    }
    const mainChannelIds = mainChannelSet(hot.config.memory?.mainChannelIds);
    const targets = kind === 'channels' ? windows : pickPeople(windows, cfg);
    if (targets.length === 0) {
      release();
      return { ok: true, count: 0 };
    }

    (async () => {
      try {
        for (let i = 0; i < targets.length; i += 1) {
          if (store.state.data.paused) {
            touchActivity('paused');
            return;
          }
          if (stopRequested) {
            touchActivity('stopped');
            return;
          }
          const outcome =
            kind === 'channels'
              ? await processChannel(guildId, targets[i], cfg, mainChannelIds, { index: i + 1, total: targets.length })
              : await processPerson(guildId, windows, targets[i], cfg, mainChannelIds, undefined, { index: i + 1, total: targets.length });
          if (outcome.stop) return;
        }
        touchActivity('finished');
      } catch (err) {
        log.error(`warmup: ${kind} redo failed`, { error: err });
      } finally {
        release();
      }
    })();

    return { ok: true, count: targets.length };
  }

  // -------------------------------------------------------------------
  // Notes refresh: one channel's or the server's notes re-described from a spread sample
  // -------------------------------------------------------------------

  /** A refresh's own history read: the last `days` of `channel` (at most
   * `warmup.fetchLimitPerChannel`), without the persona's and other bots' lines. */
  async function fetchNotesHistory(channel, days) {
    const messages = await fetchHistoryWindow(channel, {
      limit: hot.config.warmup?.fetchLimitPerChannel ?? 15000,
      minTs: now() - days * DAY_MS,
      selfId: client.user?.id,
      embedTextChars: hot.config.media?.embedTextChars,
      videoSites: hot.config.media?.video?.sites,
      maxUrlChars: hot.config.context?.maxUrlChars,
    });
    return messages.filter((m) => !m.self && !m.bot);
  }

  /**
   * The shared frame of refreshChannelNotes / refreshServerNotes: the guards (a warmup run in
   * flight or another refresh, paused, no prompt, the guild or the target gone, the LLM's daily
   * cap), one refresh at a time (`notesRefreshing`, never `running`: a refresh does not mute the
   * persona, `isWarmingUp()` stays false), the attempt stamp on a failure the target is to back
   * off from (NOTES_ATTEMPT_REASONS) and the one log line. `work` reads, samples and asks; it
   * resolves to processChannel's / processServer's outcome plus the sample's counts. A refresh is
   * not a warmup phase: the activity snapshot is left alone.
   */
  async function refreshNotes({ guildId, target, channelId, promptKey, resolveTarget, work }) {
    const logFields = target === 'channel' ? { target, channelId } : { target };
    const stampTarget = target === 'channel' ? channelId : 'guild';
    const fail = (reason, detail, fields) => {
      if (NOTES_ATTEMPT_REASONS.has(reason)) store.markNotesSampled(guildId, stampTarget, now(), { outcome: 'attempt' });
      const over = Array.isArray(fields) ? { fields } : {};
      log.info('warmup: notes refresh failed', { ...logFields, reason, ...over });
      return detail === undefined ? { ok: false, reason, ...over } : { ok: false, reason, detail, ...over };
    };
    if (running || notesRefreshing) return fail('running');
    if (store.state.data.paused) return fail('paused');
    if (!hot.prompts?.[promptKey]) return fail('no-prompt');
    const guild = resolvedGuild(guildId);
    const resolved = guild ? resolveTarget(guild) : null;
    if (!resolved) return fail('gone');
    if (llmCapReached(store.state.data, hot.config, now())) return fail('daily-cap');

    notesRefreshing = true;
    try {
      const outcome = await work(resolved, notesSampleSettings(hot.config));
      if (!outcome.ok) {
        const { reason, detail, fields } = notesRefreshReason(outcome);
        return fail(reason, detail, fields);
      }
      const counts = sampleCounts(outcome.sample);
      log.info('warmup: notes refreshed', { ...logFields, changed: outcome.changed, ...counts });
      return { ok: true, changed: outcome.changed, ...counts };
    } finally {
      notesRefreshing = false;
    }
  }

  /**
   * Re-describe one channel's notes (`purpose`/`topics`/`tone`) from a sample spread over the last
   * `memory.notesSampleDays` (src/memory/sample.js#selectSpreadSample: `memory.notesSampleMessages`
   * lines at most, one author at most `memory.notesSampleMaxAuthorShare` of them), the stored notes
   * shown as claims in `<existing_notes>` (`writtenDaysAgo`: whole days since their text last
   * changed). Fewer than `memory.notesMinMessages` lines is `too-few`. The answer is written only
   * when the channel's notes did not change while the request was in flight (`conflict`
   * otherwise); `changed` says whether the text moved. Never sets the channel facts nor marks
   * warmup progress. Stamps: `notesSampleReviewedAt` on a clean answer (changed or not),
   * `notesAttemptAt` on `too-few`, `conflict`, `bad-json`, `llm-error`, `over-limit`. A rewrite over its
   * limit is never cut: the request is re-asked once with `<over_limit>`, and an answer still over
   * is `over-limit` (`fields`), nothing of it written (see settleNotesRefresh). The request goes through the
   * live rails (sendNotesRequest: the 50k request cap, `llm.maxRequestsPerDay`), never the
   * warmup's budget. Started by src/memory/notes-refresh.js's scheduler.
   * @param {string} guildId
   * @param {string} channelId
   * @returns {Promise<{ ok: true, changed: boolean, sample: number, authors: number, days: number } |
   *   { ok: false, reason: 'running'|'paused'|'gone'|'too-few'|'conflict'|'bad-json'|'llm-error'|'token-limit'|'daily-cap'|'no-prompt'|'over-limit', detail?: string, fields?: string[] }>}
   *   `detail`: the provider error of an `llm-error`, or `over-cap` for a `token-limit` found while fitting.
   */
  function refreshChannelNotes(guildId, channelId) {
    const id = String(channelId);
    return refreshNotes({
      guildId,
      target: 'channel',
      channelId: id,
      promptKey: 'channel',
      resolveTarget: (guild) => {
        if (!store.getChannel(guildId, id)) return null;
        return readableChannels(guild, hot.config.bot).find((channel) => String(channel.id) === id) ?? null;
      },
      work: async (channel, settings) => {
        const messages = await fetchNotesHistory(channel, settings.days);
        if (store.state.data.paused) return { ok: false, reason: 'paused' };
        const sample = selectSpreadSample(messages, { max: settings.max, maxAuthorShare: settings.maxAuthorShare, nowMs: now() });
        if (sample.length < settings.minMessages) return { ok: false, reason: 'too-few' };
        const record = store.getChannel(guildId, id);
        if (!record) return { ok: false, reason: 'gone' };
        const existing = { purpose: record.purpose ?? '', topics: record.topics ?? '', tone: record.tone ?? '', writtenDaysAgo: daysSince(record.updatedAt, now()) };
        const window = { id, name: channel.name, category: channel.parent?.name ?? null, topic: channel.topic ?? null, messages, channel };
        const mainChannelIds = mainChannelSet(hot.config.memory?.mainChannelIds);
        const outcome = await processChannel(guildId, window, hot.config.warmup ?? {}, mainChannelIds, undefined, {
          refresh: { sample, existing, version: record.updatedAt ?? null },
        });
        return { ...outcome, sample };
      },
    });
  }

  /**
   * Re-describe the server notes (`patterns`/`starters`/`injokes`) the way refreshChannelNotes
   * does a channel's: the sample is spread over the main channels' pooled history
   * (`memory.mainChannelIds`; with none, the readable channel with the most stored messages),
   * `<channels>` and `<members>` as on a warmup pass, the stored notes in `<existing_notes>`
   * (member tokens as the analyzer reads them), the version is the guild's `notesUpdatedAt`. Lore
   * in the answer is ignored (it has its own path). Stamps go on the guild. Same outcomes;
   * `patterns`/`starters` are judged against twice `memory.fieldChars`.
   * @param {string} guildId
   * @returns {Promise<{ ok: true, changed: boolean, sample: number, authors: number, days: number } |
   *   { ok: false, reason: string, detail?: string }>}
   */
  function refreshServerNotes(guildId) {
    return refreshNotes({
      guildId,
      target: 'server',
      promptKey: 'server',
      resolveTarget: (guild) => guild,
      work: async (guild, settings) => {
        const readable = readableChannels(guild, hot.config.bot);
        const mainChannelIds = mainChannelSet(hot.config.memory?.mainChannelIds);
        let sources = readable.filter((channel) => mainChannelIds.has(String(channel.id)));
        if (sources.length === 0) {
          const stored = (channel) => store.getChannel(guildId, channel.id)?.messageCount ?? 0;
          sources = [...readable].sort((a, b) => stored(b) - stored(a)).slice(0, 1);
        }
        const fetched = new Map();
        for (const channel of sources) fetched.set(String(channel.id), await fetchNotesHistory(channel, settings.days));
        if (store.state.data.paused) return { ok: false, reason: 'paused' };
        const pooled = [...fetched.values()].flat().sort((a, b) => a.ts - b.ts);
        const sample = selectSpreadSample(pooled, { max: settings.max, maxAuthorShare: settings.maxAuthorShare, nowMs: now() });
        if (sample.length < settings.minMessages) return { ok: false, reason: 'too-few' };

        const windows = readable.map((channel) => ({
          id: String(channel.id),
          name: channel.name,
          category: channel.parent?.name ?? null,
          topic: channel.topic ?? null,
          messages: fetched.get(String(channel.id)) ?? [],
          channel,
        }));
        const record = store.getGuild(guildId);
        const nameOf = buildNameIndex(windows);
        const notesNameOf = (memberId) => nameOf(memberId) ?? store.getUser(guildId, memberId)?.names?.[0] ?? null;
        const resolve = (text) => fromTokens(typeof text === 'string' ? text : '', notesNameOf, 'analyzer');
        const existing = {
          patterns: resolve(record.patterns),
          starters: resolve(record.starters),
          injokes: (Array.isArray(record.injokes) ? record.injokes : []).map(resolve),
          writtenDaysAgo: daysSince(record.notesUpdatedAt, now()),
        };
        const warmupCfg = hot.config.warmup ?? {};
        const outcome = await processServer(guildId, windows, warmupCfg, mainChannelIds, pickPeople(windows, warmupCfg), {
          refresh: { sample, existing, version: record.notesUpdatedAt ?? null },
        });
        return { ...outcome, sample };
      },
    });
  }

  /** Cheap, synchronous summary for `/nep status` -- never fetches Discord history, never writes
   * state.json (a read-only view of the progress, see `progressView`). */
  function summary() {
    const progress = progressView(store);
    return {
      running,
      startedAt: progress.startedAt,
      finishedAt: progress.finishedAt,
      tokensUsed: progress.tokensUsed,
      requests: progress.requests,
      doneChannels: progress.done.channels.length,
      donePeople: progress.done.people.length,
      doneServer: progress.done.server,
      aborted: progress.aborted,
    };
  }

  /** `tools/warmup.mjs status`: `summary()` plus totals, the next target and `activity` (this
   * module's own in-memory "what is it doing right now" snapshot -- see `touchActivity` above).
   * Synchronous, read-only (`progressView`), never fetches: the totals come from the windows cache when a
   * run or a recent command filled it, otherwise they are reported as unknown (null) -- `activity`
   * explains what is happening meanwhile (fetching history, and so on) so the command still answers
   * at once and still means something while the cache is still empty. */
  function status(guildId) {
    const progress = progressView(store);
    const base = summary();
    let channelsEligible = null;
    let peopleEligible = null;
    let nextTarget = null;

    // Totals come from whatever windows were fetched last, however old: a run keeps working from
    // them long after the 15-minute refetch window, and a stale count beats a "?".
    const cached = cache.get(guildId);
    if (cached) {
      const cfg = hot.config.warmup ?? {};
      const windows = cached.windows;
      const eligibleChannels = windows; // every readable channel gets a note: the map must cover channels that may wake up later
      const people = pickPeople(windows, cfg);
      channelsEligible = eligibleChannels.length;
      peopleEligible = people.length;
      // "Next" means after the target in flight: the one being worked on is shown by the phase line.
      const inFlightId = activity.phase === 'channel' || activity.phase === 'person' ? String(activity.detail?.id ?? '') : '';
      const nextChannel = eligibleChannels.find((window) => !progress.done.channels.includes(window.id) && String(window.id) !== inFlightId);
      const nextPerson = people.find((person) => !progress.done.people.includes(person.id) && String(person.id) !== inFlightId);
      if (nextChannel) nextTarget = `channel: ${nextChannel.name} (id:${nextChannel.id})`;
      else if (nextPerson) nextTarget = `person: ${nextPerson.name} (id:${nextPerson.id})`;
      else if (!progress.done.server) nextTarget = 'server';
    }

    const phase = running ? 'running' : !base.startedAt ? 'not started' : base.finishedAt ? 'finished' : base.aborted ? `aborted (${base.aborted})` : 'idle';
    return { ...base, phase, channelsEligible, peopleEligible, nextTarget, activity: { ...activity }, stopRequested };
  }

  /** `tools/warmup.mjs reset`: clears `state.warmup` (progress only, never any profile/channel/
   * guild/lore data already written). Refused while a run is in flight. */
  function reset() {
    if (running) return { ok: false, message: 'a warmup run is in flight -- pause or wait for it first' };
    delete store.state.data.warmup;
    store.state.markDirty();
    store.flush();
    activity = freshActivity();
    return { ok: true };
  }

  /** Take one of today's portrait-refresh slots (`state.portraitDay` / `portraitCount`, kept
   * apart from `state.warmup` so `tools/warmup.mjs reset` and a warmup-state version bump never zero
   * it). Synchronous. The UTC day the slot was taken on, or null when `perDay` is used up. */
  function reservePortraitSlot(perDay) {
    const data = store.state.data;
    const { count, rolled } = dailyCounter(data, PORTRAIT_SLOTS, now());
    if (rolled) store.state.markDirty();
    if (count >= perDay) return null;
    const { day } = bumpDaily(data, PORTRAIT_SLOTS, now());
    store.state.markDirty();
    return day;
  }

  /** Give back a slot `reservePortraitSlot` took on `day`, unless the day has turned since. */
  function releasePortraitSlot(day) {
    const data = store.state.data;
    if (data[PORTRAIT_SLOTS.dayKey] !== day || !(data[PORTRAIT_SLOTS.countKey] > 0)) return;
    data[PORTRAIT_SLOTS.countKey] -= 1;
    store.state.markDirty();
  }

  /** Give back the slot of a refresh that sent nothing; once only, whoever asks. */
  function giveBackSlot(slot) {
    if (slot.released) return;
    slot.released = true;
    releasePortraitSlot(slot.day);
  }

  /** Log a refresh that stored nothing and return its outcome. `sent`: whether a request (and a
   * daily slot) was spent on it -- a failure after sending is a warning, everything else (an
   * answer dropped on purpose included, see PORTRAIT_STOOD_DOWN) info. The field names of an
   * `over-limit` (`extra.fields`) are logged too. */
  function portraitNotDone(userId, reason, { sent = false, detail, ...extra } = {}) {
    const fields = { userId, reason, sent };
    if (detail !== undefined) fields.detail = detail;
    if (Array.isArray(extra.fields)) fields.fields = extra.fields;
    if (sent && !PORTRAIT_STOOD_DOWN.has(reason)) log.warn('warmup: portrait refresh failed', fields);
    else log.info('warmup: portrait refresh skipped', fields);
    return { ok: false, reason, ...extra };
  }

  /** The history a refresh reads: the injected `windows`, else one read shared through `crawl`
   * (an object one scheduler cycle hands to every refresh it starts, so a cycle crawls at most
   * once even past the 15-minute cache), else the cached/shared `getWindows`. */
  function portraitWindows(guildId, guild, givenWindows, crawl) {
    if (givenWindows) return Promise.resolve(givenWindows);
    if (crawl?.windows) return crawl.windows;
    const pending = getWindows(guildId, guild, hot.config.warmup ?? {});
    if (crawl) crawl.windows = pending;
    return pending;
  }

  /**
   * Rewrite one member's portrait (`character`/`style` only). Single mode (the switch off, or the
   * fallback below) asks `profile.md`, two-stage mode `portrait.md` (below), from the same blocks:
   * `<draft>` = the stored portrait (the base the answer merges into), `<hint>` = `reason` when given (member
   * tokens resolved as in the draft), `<snippets>` = the member's own lines since their last
   * portrait (`portraitRefreshedAt`) and never older than the profile (`firstSeen`: a profile
   * re-created after a forget or wipe does not read the lines from before it); every line of the
   * window when `force`d. A little context, sampled like the warmup
   * (`memory.portraitRefreshMessages`, main channels first).
   * Interests/details/episodes/aliases of the answer are ignored; they keep flowing through the
   * stream analyzer's own ops (docs/en/prompt-contract.md, "Data model"). Started by
   * src/memory/portrait.js's scheduler, the stream analyzer's cue and `/nep memory refresh`
   * (`force`).
   *
   * Two-stage mode (`portraitMode`: `features.memoryTwoStage` on, prompts/portrait.md and
   * prompts/memory-voice.md present): the same blocks go to prompts/portrait.md on `roles.extractor`
   * (stage A, `warmupRoute`'s neutral route), whose answer (`clampPortraitDecision`) is the merged
   * `style`, stored at once, and four lists about the character. When the lists change anything,
   * they become ONE `character` voice item (the brief; its `old` is the stored portrait, read when
   * the voice run words it) queued in one synchronous step (`store.updateVoiceQueue`, replacing a
   * queued character item of the member; nothing the queue held is pushed out, see
   * queueCharacter), dated when the history was read; the voice run (src/memory/update.js#runVoice,
   * on `roles.voice`) words it, writes `character` and only then the portrait stamps, so the
   * member keeps its attempt stamp meanwhile, and no refresh but a forced one asks stage A again
   * while the item waits (`voice-pending`). When they
   * change nothing, nothing is queued and the member is stamped as checked (the portrait stamps,
   * dated when the history was read). An answer with neither a style nor a change is
   * `empty-answer`; one that is cut, does not parse or has no `character` object stores nothing
   * (`truncated`, `bad-json`); a forced refresh of a member with no profile whose answer brings no
   * style queues nothing (`no-profile`: no profile for the item to land in). With the switch on
   * but a portrait prompt missing, the single request goes out instead, on the voice model, warned
   * once per change of that state (`warmup: portrait two-stage unavailable`). The mode is decided
   * after the history read, in the same synchronous stretch as the request's prompt and route; a
   * prompt gone by then is `no-prompt` (the slot goes back, no back-off).
   *
   * Every portrait decision stored here or by a warmup person run (a portrait written, a check
   * that changes nothing) takes the member's queued character item out of the queue (see
   * stampPortrait): it is older than the decision, which read every line the item came from.
   *
   * Rails: never while a warmup run is in flight or paused; one refresh per member at a time;
   * unless `force`d, only for a member with a stored profile, not within
   * `memory.portraitRefreshHours` of the last refresh nor `memory.portraitRetryHours` of the last
   * attempt, and in two-stage mode not while the member's character item still waits in the voice
   * queue (`voice-pending`: no slot, no history read, no attempt stamp; another stage A answer would
   * only replace that item); nothing at all once today's LLM requests reached `llm.maxRequestsPerDay`
   * (src/memory/portrait.js#llmCapReached, checked before any history read);
   * `memory.portraitRefreshPerDay` per UTC day for the whole server (`PORTRAIT_SLOTS`, a slot
   * reserved before the first await and given back whenever nothing was sent, a throw before the
   * request included); the request is fitted under `llm.maxRequestTokens` x `llm.safetyMargin` by
   * shrinking the sample (never below `warmup.minMessages` own lines) and sent under the live
   * rails (the 50k request cap, `llm.maxRequestsPerDay`).
   *
   * Nothing is written for a member whose stored profile is not the one the refresh started from
   * (`gone`: `/nep memory forget` or `wipe` removed it, or it was reloaded from disk), when a
   * warmup run is in flight as the answer lands (`warming-up`), when the stored portrait changed
   * while the request was in flight (`changed`: a warmup person run wrote one), or when paused;
   * `waitIdle()` waits for refreshes in flight.
   *
   * Stamps: `portraitAttemptAt` when the request is sent and on every outcome that ends without a
   * stored portrait for the member's own reasons (`nothing-to-sample`, `thin-sample`, `over-cap`,
   * `token-limit`, a failed or unusable answer), so they back off; a success that stored the
   * portrait decision (single mode, or a two-stage check that changes nothing) stamps
   * `portraitRefreshedAt` (when the history the sample came from began to be read, so the next
   * sample misses nothing written since), `portraitMessageCount` and clears the attempt. A
   * two-stage success that queued a character item (`characterQueued`) writes none of these: the
   * voice run does once it applies the item, and the member keeps the attempt stamp meanwhile. An
   * answer that is empty or cut (`empty-answer`, `truncated`) is never stored.
   * @param {string} guildId
   * @param {string} userId
   * @param {string} [reason]  The analyzer's one-line cue, used as `<hint>`; '' for none.
   * @param {{ force?: boolean, windows?: ChannelWindow[], crawl?: object }} [opts]
   *   `force: true` (the owner's `/nep memory refresh`): no hours, retry or `voice-pending` rail,
   *   no stored profile needed, and the whole window is sampled; never the daily caps.
   *   `windows`: the history to sample (no guild check, no fetch). `crawl`: an object shared by
   *   the refreshes of one scheduler cycle, see portraitWindows.
   * @returns {Promise<{ ok: true, userId: string, own: number, context: number, shrunk: number,
   *   stage?: 'single'|'two', characterQueued?: boolean } |
   *   { ok: false, reason: string, cap?: 'portrait'|'llm', message?: string }>}
   *   `stage` and `characterQueued` only while `features.memoryTwoStage` is on (`stage` single:
   *   the fallback, which wrote the portrait itself).
   *   `reason`: `warming-up`, `paused`, `busy`, `no-profile`, `too-soon`, `retry-wait`,
   *   `no-prompt`, `voice-pending`, `no-guild`, `daily-cap` (`cap`: whose), `gone`,
   *   `nothing-to-sample`, `thin-sample`, `over-cap`, `token-limit`, `llm-error`, `bad-json`,
   *   `truncated`, `empty-answer`, `changed`.
   */
  async function refreshPortrait(guildId, userId, reason, { force = false, windows: givenWindows, crawl } = {}) {
    const id = String(userId);
    if (running) return portraitNotDone(id, 'warming-up');
    if (store.state.data.paused) return portraitNotDone(id, 'paused');
    if (refreshingUsers.has(id)) return portraitNotDone(id, 'busy');

    const settings = portraitSettings(hot.config);
    const profile = store.getUser(guildId, id);
    if (!force) {
      // A member the owner just forgot (or never seen) is never brought back by a refresh.
      if (!profile) return portraitNotDone(id, 'no-profile');
      const refreshedAt = stampMs(profile.portraitRefreshedAt);
      if (refreshedAt !== null && now() - refreshedAt < (hot.config.memory?.portraitRefreshHours ?? 24) * HOUR_MS) {
        return portraitNotDone(id, 'too-soon');
      }
      const attemptAt = stampMs(profile.portraitAttemptAt);
      if (attemptAt !== null && now() - attemptAt < settings.retryHours * HOUR_MS) return portraitNotDone(id, 'retry-wait');
    }

    // A first look, so a refresh with no prompt to send takes no slot and reads no history. The
    // mode itself is decided after the read (refreshWithSlot), together with the request's route.
    const firstLook = portraitModeNow();
    if (!portraitTemplate(firstLook)) {
      log.info('warmup: portrait refresh skipped', { userId: id, reason: 'no-prompt', sent: false });
      return { ok: false, reason: 'no-prompt', message: PROFILE_PROMPT_MISSING };
    }
    // Stage A again while the member's character text still waits for the voice model would
    // only replace that item: no slot, no history read, no request, and no back-off (nothing
    // went wrong for the member). The single request writes the portrait itself and settles the
    // item, and the owner's forced refresh asks anyway.
    if (!force && firstLook.stage === 'two' && waitingPortraits(store.getVoiceQueue(guildId)).has(id)) {
      return portraitNotDone(id, 'voice-pending');
    }
    const labels = requireLabels(hot.prompts);
    const guild = givenWindows ? null : resolvedGuild(guildId);
    if (!givenWindows && !guild) return portraitNotDone(id, 'no-guild');

    // The LLM's own daily cap, before any history read: a refused request would cost a crawl.
    if (llmCapReached(store.state.data, hot.config, now())) return portraitNotDone(id, 'daily-cap', { cap: 'llm' });

    // The daily slot, reserved synchronously before the first await so concurrent refreshes can
    // never overshoot `memory.portraitRefreshPerDay`; given back whenever nothing was sent.
    const slotDay = reservePortraitSlot(settings.perDay);
    if (!slotDay) return portraitNotDone(id, 'daily-cap', { cap: 'portrait' });
    const slot = { day: slotDay, sent: false, released: false };

    refreshing += 1;
    refreshingUsers.add(id);
    try {
      return await refreshWithSlot({ guildId, id, reason, force, givenWindows, crawl, guild, labels, slot, startProfile: profile });
    } catch (err) {
      // A throw before the request went out (the history read, a hot-reloaded labels.json the
      // transcript cannot render, the calibrator): nothing was sent, the slot goes back.
      if (!slot.sent) giveBackSlot(slot);
      throw err;
    } finally {
      refreshing -= 1;
      refreshingUsers.delete(id);
      notifyIdle();
    }
  }

  /** `portraitMode` now, warning once each time the two-stage switch is on while a prompt of that
   * mode is missing (the refreshes then send the single request on the voice model). */
  function portraitModeNow() {
    const mode = portraitMode(hot.config, hot.prompts);
    const unavailable = mode.missing.length > 0;
    if (unavailable && !portraitTwoStageUnavailable) {
      log.warn('warmup: portrait two-stage unavailable', { reason: 'no-prompt', missing: mode.missing });
    }
    portraitTwoStageUnavailable = unavailable;
    return mode;
  }

  /** The system template a refresh in `mode` sends, read now: prompts/portrait.md for stage A
   * (non-blank whenever portraitMode says `two`), prompts/profile.md otherwise; '' when that one
   * is missing (`no-prompt`). */
  function portraitTemplate(mode) {
    return (mode.stage === 'two' ? hot.prompts?.portrait : hot.prompts?.profile) || '';
  }

  /** Queue one member's `character` voice item (a two-stage refresh's lists as its brief), in one
   * synchronous read-modify-write of the guild's queue (src/memory/voice.js#mergeIntoQueue: it
   * replaces a character item of the member queued earlier), dated `createdAt` (when the history
   * the brief came from was read: the voice run stamps the portrait with it). An item it would
   * push out past `memory.voice.queueMax` stays queued: the stream analyzer's next merge sends it
   * down the degraded path (src/memory/update.js), which this module cannot run. */
  function queueCharacter(guildId, userId, brief, createdAt) {
    store.updateVoiceQueue(guildId, (queue) => {
      const merged = mergeIntoQueue(queue, [{ kind: 'character', userId, brief, createdAt }], now(), hot.config);
      return { ...merged, queue: [...merged.overflow, ...merged.queue] };
    });
  }

  /** refreshPortrait's work once its daily slot is held; see refreshPortrait. `startProfile`: the
   * stored profile when the refresh started (null for a forced refresh of a member with none). */
  async function refreshWithSlot({ guildId, id, reason, force, givenWindows, crawl, guild, labels, slot, startProfile }) {
    /** Nothing was sent: the slot goes back; `stamp` -- the member backs off. */
    const unsent = (why, { stamp = true, ...extra } = {}) => {
      giveBackSlot(slot);
      if (stamp) stampAttempt(guildId, id);
      return portraitNotDone(id, why, extra);
    };
    // Whether the stored profile is still the object this refresh started from: forget, wipe
    // and a reload from disk (pause/resume) all replace or remove it.
    const sameProfile = () => store.getUser(guildId, id) === startProfile;

    const startedAt = now();
    const windows = await portraitWindows(guildId, guild, givenWindows, crawl);
    if (store.state.data.paused) return unsent('paused', { stamp: false });
    if (!sameProfile()) return unsent('gone', { stamp: false });
    // Fetched windows carry when their read began; injected ones are as of this call.
    const readAt = readAtOf.get(windows) ?? startedAt;

    // The mode, its system template and (portraitRequestOptions, at the send) the request's route
    // are read from here on with no await until the request goes out: one config and one set of
    // prompts, however long the history read took and whatever a hot reload changed meanwhile.
    const mode = portraitModeNow();
    const template = portraitTemplate(mode);
    if (!template) return unsent('no-prompt', { stamp: false, message: PROFILE_PROMPT_MISSING });

    const config = hot.config;
    const settings = portraitSettings(config);
    const profile = startProfile;
    // Own lines since the last portrait, and never from before the profile itself (`firstSeen`):
    // a profile re-created by a new message after `/nep memory forget` or `wipe` starts there, so
    // a refresh never rebuilds a portrait from the lines the owner had the persona forget. Only
    // the owner's forced refresh (and a warmup person run) reads the whole window on purpose.
    const since = force
      ? -Infinity
      : Math.max(stampMs(profile?.portraitRefreshedAt) ?? -Infinity, stampMs(profile?.firstSeen) ?? -Infinity);
    const mainChannelIds = mainChannelSet(config.memory?.mainChannelIds);
    const member = memberStats(windows, id, since) ?? { id, name: profile?.names?.[0] ?? id, messages: 0, firstTs: null, lastTs: now() };
    const minOwn = Math.max(1, Math.floor(settings.firstMessages) || 0);
    const limit = requestTokenLimit(config);

    const selfName = getSelfName(guildId);
    const formatOptions = memoryFormatOptions(config, selfName, labels);
    const nameOf = buildNameIndex(windows);
    // The stored portrait and the cue as the analyzer reads ids: `name (id:...)`
    // (docs/en/prompt-contract.md).
    const draftNameOf = (memberId) => nameOf(memberId) ?? store.getUser(guildId, memberId)?.names?.[0] ?? null;
    const stored = { character: profile?.character ?? '', style: profile?.style ?? '' };
    const draft = {
      character: fromTokens(stored.character, draftNameOf, 'analyzer'),
      style: fromTokens(stored.style, draftNameOf, 'analyzer'),
    };
    // Stage A (two-stage mode) reads the same blocks under its own system message.
    const system = fillPromptTemplate(template, profileTemplateValues(config, selfName));
    const fixedBlocks = [
      block('character', characterText(hot.prompts, selfName)),
      block('member', memberLine(member)),
      block('draft', JSON.stringify(draft)),
      reason ? block('hint', fromTokens(reason, draftNameOf, 'analyzer')) : '',
    ];

    // Fit under the live per-request rail: shrink the sample (main channels are filled first, so
    // they stay) until the calibrated estimate fits, never below `minOwn` own lines.
    let perPerson = Math.floor(settings.messages);
    let shrunk = 0;
    let sample;
    let messages;
    for (;;) {
      sample = sampleMember(windows, id, { ...config.warmup, messagesPerPerson: perPerson, since }, mainChannelIds);
      if (sample.ownCount === 0) return unsent('nothing-to-sample');
      if (sample.ownCount < minOwn) return unsent('thin-sample');
      const items = markOwnContext(formatTranscript(sample.messages, formatOptions), sample.ownIds, labels);
      const snippets = block('snippets', renderTranscript(items, formatOptions.timezone, labels));
      messages = [
        { role: 'system', content: system },
        { role: 'user', content: [...fixedBlocks, snippets].filter(Boolean).join('\n\n') },
      ];
      if (calibrator.apply(estimateMessages(messages)) <= limit) break;
      const next = Math.floor(Math.min(perPerson, sample.ownCount) * PORTRAIT_SHRINK);
      if (next < minOwn) return unsent('over-cap');
      perPerson = next;
      shrunk += 1;
    }

    // Stamped when sent: a crash or a pause mid-request still backs the member off.
    const previousAttempt = profile?.portraitAttemptAt ?? null;
    stampAttempt(guildId, id);
    slot.sent = true;
    let completion;
    try {
      completion = await llm.complete(messages, portraitRequestOptions({ voice: mode.voice }));
    } catch (err) {
      if (err instanceof DailyCapError) {
        // The LLM's daily cap says nothing about this member: no back-off.
        if (!store.state.data.paused && sameProfile()) stampAttempt(guildId, id, previousAttempt);
        return unsent('daily-cap', { stamp: false, cap: 'llm' });
      }
      if (err instanceof TokenLimitError) return unsent('token-limit', { stamp: false });
      if (isTransientProviderError(err)) {
        // A rate limit, a gateway error or a timeout says nothing about this member and produced
        // no answer: the day's slot goes back and the member keeps its place (no back-off).
        giveBackSlot(slot);
        if (!store.state.data.paused && sameProfile()) stampAttempt(guildId, id, previousAttempt);
        return portraitNotDone(id, 'llm-error', { sent: true, slotReturned: true, detail: detailOf(err) });
      }
      return portraitNotDone(id, 'llm-error', { sent: true, detail: detailOf(err) });
    }

    // Before a retry is sent and right before the write, with no await left until it is done:
    // what happened while a request was in flight wins -- a pause, a warmup run, a forget/wipe, a
    // newer portrait.
    const standDown = () => {
      if (store.state.data.paused) return portraitNotDone(id, 'paused', { sent: true });
      if (running) return portraitNotDone(id, 'warming-up', { sent: true });
      if (!sameProfile()) return portraitNotDone(id, 'gone', { sent: true });
      if ((profile?.character ?? '') !== stored.character || (profile?.style ?? '') !== stored.style) {
        return portraitNotDone(id, 'changed', { sent: true });
      }
      return null;
    };

    // The prose of an answer is judged as the store keeps it (member tokens) against the stored
    // portrait (judgeProse): a rewrite over `memory.fieldChars` is never cut. `style` in both
    // modes, `character` in the single one (stage A's character is lists for the voice model).
    // One over re-asks once (`memory.overLimitRetries` > 0, a second request, the same daily slot):
    // the same request, the first answer as returned, then `<over_limit>` (withOverLimit); that answer is taken
    // whole and judged the same way, and one still over ends `over-limit`: nothing written, the
    // attempt stamp (set at the send) backs the member off.
    const twoStage = mode.stage === 'two';
    const proseNames = twoStage ? draftNameOf : nameOf;
    const proseKeys = twoStage ? ['style'] : ['character', 'style'];
    const proseTokenize = makeTokenizer(proseNames);
    const proseOf = (answer) =>
      Object.fromEntries(proseKeys.map((key) => [key, typeof answer?.[key] === 'string' ? proseTokenize(answer[key]) : '']));
    let parsed;
    let decision = null;
    let accepted;
    for (let retried = false; ; retried = true) {
      if (completion.finishReason === 'length') return portraitNotDone(id, 'truncated', { sent: true });
      try {
        parsed = parseJsonObject(completion.text);
      } catch (err) {
        const why = looksTruncated(completion.text, completion.finishReason) ? 'truncated' : 'bad-json';
        return portraitNotDone(id, why, { sent: true, detail: errorNameOf(err) });
      }
      if (twoStage) {
        decision = clampPortraitDecision(parsed, hot.config, draftNameOf, { storedCharacter: stored.character });
        if (!decision) return portraitNotDone(id, 'bad-json', { sent: true });
      }
      const fieldChars = hot.config.memory?.fieldChars ?? MEMORY_LIMIT_DEFAULTS.fieldChars;
      const limits = Object.fromEntries(proseKeys.map((key) => [key, fieldChars]));
      const judged = judgeProse(proseOf(parsed), stored, limits, hot.config);
      const overFields = Object.keys(judged.over);
      if (overFields.length === 0) {
        accepted = judged.accepted;
        break;
      }
      if (retried || !overLimitRetryOn(hot.config)) return portraitNotDone(id, 'over-limit', { sent: true, fields: overFields });
      const stoodDown = standDown();
      if (stoodDown) return stoodDown;
      try {
        completion = await llm.complete(withOverLimit(messages, completion.text, overLimitOf(judged.over, limits)), portraitRequestOptions({ voice: mode.voice }));
      } catch (err) {
        // The first answer was received: the slot stays spent and the attempt stamp stays.
        if (err instanceof DailyCapError) return portraitNotDone(id, 'daily-cap', { sent: true, cap: 'llm' });
        if (err instanceof TokenLimitError) return portraitNotDone(id, 'token-limit', { sent: true });
        return portraitNotDone(id, 'llm-error', { sent: true, detail: detailOf(err) });
      }
    }
    // Resolved back to `name (id:...)` as before: applyMemoryUpdate tokenizes what it stores.
    const proseText = (key) => (accepted[key] ? fromTokens(accepted[key], proseNames, 'analyzer') : '');
    const seenAt = Number.isFinite(member.lastTs) ? member.lastTs : now();
    const writePortrait = (ops) =>
      applyMemoryUpdate(store, guildId, { users: { [id]: ops } }, hot.config.memory ?? {}, new Set([id]), {
        timing: { seenAtByUser: new Map([[id, seenAt]]), seenAt },
        batchAuthorNames: new Map([[id, member.name]]),
        portraitFields: true,
        by: 'portrait',
        versions: versionSettings(hot.config),
      });
    // `stage` and `characterQueued` are said only while the two-stage switch was on when the
    // refresh started (stage A, or the fallback on the voice model): with it off, as before.
    const marker = (characterQueued) => (mode.stage === 'two' || mode.voice ? { stage: mode.stage, characterQueued } : {});
    const done = (characterQueued) => {
      const counts = { own: sample.ownCount, context: sample.contextCount, shrunk };
      log.info('warmup: portrait refreshed', { userId: id, hinted: Boolean(reason), forced: force, ...counts, ...marker(characterQueued) });
      return { ok: true, userId: id, ...counts, ...marker(characterQueued) };
    };

    if (twoStage) {
      const style = proseText('style');
      if (!style && !decision.changed) return portraitNotDone(id, 'empty-answer', { sent: true });
      const stoodDown = standDown();
      if (stoodDown) return stoodDown;
      // The style is neutral: stored at once. The character waits for the voice model, and so do
      // the portrait stamps (the voice run writes them once it is applied); a check that changes
      // nothing is stamped now, so the member is not due again at once (and an older character
      // item still queued goes, see stampPortrait).
      if (style) writePortrait({ style });
      // A forced refresh of a member with no profile whose answer brought no style to start one:
      // the voice run would find no profile for the character item and drop it as gone.
      if (!store.getUser(guildId, id)) return portraitNotDone(id, 'no-profile', { sent: true });
      if (decision.changed) queueCharacter(guildId, id, decision.brief, readAt);
      else stampPortrait(guildId, id, readAt);
      store.flush();
      return done(decision.changed);
    }

    const ops = {};
    for (const key of proseKeys) {
      const text = proseText(key);
      if (text) ops[key] = text;
    }
    if (Object.keys(ops).length === 0) return portraitNotDone(id, 'empty-answer', { sent: true });
    const stoodDown = standDown();
    if (stoodDown) return stoodDown;
    writePortrait(ops);
    // Also settles a character item an earlier two-stage refresh queued (see stampPortrait).
    stampPortrait(guildId, id, readAt);
    store.flush();
    return done(false);
  }

  return {
    peopleReport,
    run,
    stop,
    runPerson: (guildId, userId) => runOneTarget(guildId, 'person', userId),
    runChannel: (guildId, channelId) => runOneTarget(guildId, 'channel', channelId),
    runServer: (guildId) => runOneTarget(guildId, 'server', null),
    runUsers: (guildId) => startBulk(guildId, 'people'),
    runChannels: (guildId) => startBulk(guildId, 'channels'),
    summary,
    status,
    reset,
    refreshPortrait,
    refreshChannelNotes,
    refreshServerNotes,
    isWarmingUp,
    waitIdle,
  };
}
