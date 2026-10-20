// Turns the raw stream of Discord messages into long-term memory. Every
// message the persona sees is buffered (`observe`); once enough have piled up
// (`isDue`), a periodic tick (`tick`, called by index.js every 60s) asks the
// LLM to merge what happened into per-user profiles, server-wide patterns and
// facts the persona has claimed about itself (`run`, via `buildMemoryRequest`
// + `applyMemoryUpdate`). A batch writes to its own authors; members who did
// not write in it are listed in a roster only so that an alias stated about
// one of them can still be stored (aliases only, never another field).
// Direct messages (private chat) go to a per-member
// private buffer instead and are analyzed into that member's private layer
// only (`runPrivate`/`analyzePrivate`, via `applyPrivateUpdate`): nothing said
// in private ever reaches the public profile, the server notes or the lore.
// With `features.memoryTwoStage` on (and its two prompts present, see
// `analyzerMode`) a batch, guild or private, is stage A of the two-stage
// analyzer instead: prompts/memory-decide.md returns neutral decisions plus
// short briefs for every text written in the persona's voice; the neutral part
// is stored at once through the same apply functions, the briefs go into the
// guild's voice queue (src/memory/voice.js) for the voice model to word later.
// That is the voice run (`runVoice`, stage B): one request per run on
// `models.core` (the role `core`), right after a stage A batch and from the tick while
// queued items are due, its texts written by id into what stage A stored.
// A guild batch also sees the live lines of the recent store (src/memory/recent.js,
// `<recent_notes>`) only so it does not write one moment twice, and its `recent`
// field adds or removes such lines (`features.recent`); a line is never copied
// into a long-term store, and a private batch neither sees nor writes one.
// Memory is persistent: nothing here ever wipes it — a failed update just
// leaves the buffer alone and backs off for a while.

import { createHash, randomUUID } from 'node:crypto';
import { isPlainObject } from '../config.js';
import { fitSections, requestTokenLimit, sectionCost, SectionsTooLargeError } from '../llm/budget.js';
import { formatClock, formatDate, formatTranscript, renderTranscript } from '../format.js';
import { parseJsonObject } from '../llm/parse.js';
import { DailyCapError, MEMORY_VOICE_REQUEST, TokenLimitError, dailyCapOf, railReason } from '../llm/openrouter.js';
import { roleModel } from '../llm/roles.js';
import { createLimits } from '../llm/limits.js';
import { isDescribable, mediaParts, stickerUrl } from '../media/classify.js';
import { log } from '../log.js';
import { DAY_MS, HOUR_MS, MINUTE_MS, bumpDaily, dailyCounter } from '../time.js';
import { emptyAffinity, roundScore, affinityBand, applyDelta, relationshipStaleOf } from './affinity.js';
import { emptyChannel } from './store.js';
import { messagesSince } from './channels.js';
import { keywordMatches } from './lore.js';
import { isOpen, normalizeInterests, normalizeTopic } from './interests.js';
import { normalizeDetails } from './details.js';
import { applyAliasOps } from './aliases.js';
import { DEFAULT_ADDRESS_HALF_LIFE_DAYS, addressCandidates, countAddressUses, rankAddressed } from './addressed.js';
import { emojiUsageOpts } from './emoji-usage.js';
import { gifOpts } from './gifs.js';
import { topByRank } from './ranking.js';
import { topEpisodes } from './episodes.js';
import { ID_DIGITS, occursAsWholeWord, teacherToken, toTokens, fromTokens, tokenIds } from './mentions.js';
import { INJOKE_CHARS, MEMORY_LIMIT_DEFAULTS, SELF_CHARS } from './text-limits.js';
import { clampText } from './clamp.js';
import { recordLinks, toRecordLine } from './record.js';
import { acceptProse } from './prose.js';
import { RECENT_DEFAULTS, foldText, liveRecent, recentSettings } from './recent.js';
import { videoStateFromCache } from './describe.js';
import { isVideoVisionOn } from './youtube-check.js';
import { block, fillPromptTemplate, hasRequiredLabels, renderProfile } from '../behavior/prompt.js';
import { intentionSettings } from '../intentions/model.js';
import { innerEpisodeLines, innerMemorySettings } from './inner-episode.js';
import { effectiveAffinity } from '../behavior/private.js';
import {
  applyVoiceItems,
  buildVoiceRequest,
  buildVoiceRetry,
  degradedApply,
  dueItems,
  expireItems,
  mergeIntoQueue,
  parseVoiceAnswer,
  removeItems,
  retryDelayMs,
  retryLater,
  splitDecision,
  voiceLimits,
  voiceSettings,
} from './voice.js';
// A call-time cycle (portrait.js imports errorNameOf from here): both sides are function declarations.
import { stampMs, storedCount } from './portrait.js';

const BACKOFF_MS = 15 * 60_000;
const MIN_LIVE_BATCH = 20; // the live analyzer never shrinks below this many messages
const CHANNEL_FIELDS = ['purpose', 'topics', 'tone']; // the analyzer's own fields of a channel entry
// The statuses a `note_reviews` item may carry (docs/prompt-contract.md, analyzer JSON).
const NOTE_REVIEW_STATUSES = new Set(['updated', 'confirmed', 'insufficient_evidence']);

/**
 * The temperature of every analyzer-role request: the stream analyzer here, and the warmup's
 * channel/profile/server requests and the portrait refresh (src/memory/warmup.js). The one
 * reader of `memory.temperature`; called at each request, so a live edit reaches the next one.
 * @param {object} [config]  The live config.
 * @returns {number}  `memory.temperature` when it is a finite number, else 0.3 (config.json's value).
 */
export function analyzerTemperature(config) {
  const temperature = config?.memory?.temperature;
  return Number.isFinite(temperature) ? temperature : 0.3;
}

// The prompts the two-stage analyzer needs: stage A's system message, and the voice model's,
// without which the queue stage A fills could never be worded.
const TWO_STAGE_PROMPTS = ['memory-decide', 'memory-voice'];

/**
 * The prompt keys of TWO_STAGE_PROMPTS that are missing or blank in `prompts`.
 * @param {object} [prompts]
 * @returns {string[]}
 */
function missingTwoStagePrompts(prompts) {
  return TWO_STAGE_PROMPTS.filter((key) => !hasContent(prompts?.[key]));
}

/**
 * Which analyzer a batch runs: `two` (stage A, prompts/memory-decide.md, then the voice queue)
 * only when `features.memoryTwoStage` is exactly true (a missing key counts as off) AND both
 * `prompts['memory-decide']` and `prompts['memory-voice']` are non-blank; anything else runs
 * today's single-stage `prompts.memory` request. Pure; read at each batch, so a live edit of
 * the switch or of either prompt reaches the next one.
 * @param {object} [config]   The live config.
 * @param {object} [prompts]  The live prompts.
 * @returns {'single'|'two'}
 */
export function analyzerMode(config, prompts) {
  if (config?.features?.memoryTwoStage !== true) return 'single';
  return missingTwoStagePrompts(prompts).length === 0 ? 'two' : 'single';
}

/**
 * Whether a request's provider-counted prompt tokens may feed the shared calibration ratio
 * (src/llm/tokens.js): only when the request goes out on the voice model (`models.core`), the
 * model whose tokenizer the ratio tracks; a request on any other model passes
 * `skipCalibration: true`. Its budget is still checked against the same calibrated estimate.
 * @param {object} [config]  The live config.
 * @param {string|null} [model]  The model the request names; empty, null or undefined = the
 *   request goes out on `models.core`.
 * @returns {boolean}
 */
export function feedsCalibration(config, model) {
  const voice = roleModel(config, 'core');
  return (model || voice) === voice;
}

/**
 * The `llm.complete` options of one analyzer batch (`analyze` / `analyzePrivate`), from the live
 * config at the moment of use. With `features.memoryTwoStage` off the request goes out as it
 * always did: on `models.helpers.extractor`, without `skipCalibration` or `reasoning`. With it on:
 * - `two` (stage A, the neutral decisions): on `models.helpers.extractor`, plus `memory.reasoning` when that
 *   is a plain object (sent verbatim, src/llm/openrouter.js; a reasoning model otherwise spends
 *   the output budget on reasoning);
 * - `single` (a two-stage prompt is missing, see `analyzerMode`): today's request words every
 *   text in the persona's voice, which two-stage mode keeps on the voice model, so it goes out on
 *   `models.core`, never on `models.helpers.extractor`, as a memory-wording request
 *   (src/llm/openrouter.js#MEMORY_VOICE_REQUEST: role `core`, purpose `memory-voice`, no
 *   cache marker) like the voice run's (`voiceRequestOptions`), so the voice role's provider
 *   route (`/nep route`, src/llm/openrouter.js#matchRoute) covers it, and under the same daily
 *   rail, `memory.voice.maxPerDay` (`analyzeBatch`): every request of purpose `memory-voice`
 *   counts there;
 * and both pass `skipCalibration` per `feedsCalibration`.
 * @param {object} config  The live config.
 * @param {'single'|'two'} stage  The batch's `analyzerMode`.
 * @returns {object}
 */
function batchRequestOptions(config, stage) {
  const cfg = config.memory ?? {};
  const twoStageOn = config.features?.memoryTwoStage === true;
  const onVoiceModel = twoStageOn && stage !== 'two';
  const options = {
    // On the voice model: no `model`, so the request goes out on `models.core`.
    ...(onVoiceModel ? MEMORY_VOICE_REQUEST : { model: roleModel(config, 'extractor'), role: 'extractor' }),
    maxOutputTokens: cfg.maxOutputTokens,
    temperature: analyzerTemperature(config),
    // A 150-message batch with an 8000-token answer on a large model can
    // take longer than the chat timeout -- the analyzer gets its own,
    // much larger budget (see docs/prompt-contract.md, "The analyzer").
    timeoutMs: cfg.timeoutMs ?? config.llm?.timeoutMs,
  };
  if (!twoStageOn) return options;
  // Off the voice model the provider's prompt count says nothing about the ratio the other
  // requests are checked with.
  options.skipCalibration = !feedsCalibration(config, options.model);
  if (stage === 'two' && isPlainObject(cfg.reasoning)) options.reasoning = cfg.reasoning;
  return options;
}

/**
 * The `llm.complete` options of one voice request (stage B, `runVoice`), from the live config at
 * the moment of use: on `models.core` (never `models.helpers.extractor`), as a memory-wording request
 * (src/llm/openrouter.js#MEMORY_VOICE_REQUEST: role `core`, the `/nep model` role, so a
 * `<prefix>@voice` provider route applies; purpose `memory-voice`; no cache marker), at most
 * `memory.voice.maxOutputTokens` (src/memory/voice.js#voiceSettings, the budget
 * buildVoiceRequest fitted the items to), the analyzer's temperature, its own timeout
 * `memory.voice.timeoutMs` (a number above 0, else config.json's 120000; never the batch's much
 * larger `memory.timeoutMs`, so a hung voice request cannot hold the guild for its retries x
 * 15 minutes), and the calibration fed (`models.core` is the model it tracks). No
 * `reasoning`: that setting is stage A's.
 * @param {object} config  The live config.
 * @returns {object}
 */
function voiceRequestOptions(config) {
  const timeoutMs = config.memory?.voice?.timeoutMs;
  return {
    ...MEMORY_VOICE_REQUEST,
    maxOutputTokens: voiceSettings(config).maxOutputTokens,
    temperature: analyzerTemperature(config),
    timeoutMs: Number.isFinite(timeoutMs) && timeoutMs > 0 ? timeoutMs : 120000,
    // On `models.core`, the model the calibration tracks.
    skipCalibration: false,
  };
}

// The per-day count of voice requests in state.json, capped by `memory.voice.maxPerDay`.
export const VOICE_DAILY = { dayKey: 'voiceDay', countKey: 'voiceCount' };

/** The `running` key of one guild's voice run (a guild id and a `private:` key never collide with it). */
const voiceKey = (guildId) => `voice:${guildId}`;

// The fallbacks of the memory-prompt placeholders below (and of the guild `learned` limits and
// the affinity rails) live in src/memory/text-limits.js, equal to config.json's own defaults;
// re-exported here for src/memory/warmup.js and the tests, which import them from this module.
export { MEMORY_LIMIT_DEFAULTS };

/**
 * The limit an apply clamps a relationship text to: `relationshipChars` (the caller's live
 * `relationships.textChars`), else `relationships.textChars` of the `relationships` argument, by
 * src/memory/voice.js#voiceLimits' rule -- the one copy (a finite number above 0, else
 * config.json's 600), so the analyzer's `{{relationshipChars}}`, the voice request's `limit` and
 * every store clamp of the text agree.
 * @param {unknown} relationshipChars
 * @param {object} [relationships]
 * @returns {number}
 */
function relationshipLimitOf(relationshipChars, relationships) {
  return voiceLimits({ relationships: { textChars: relationshipChars ?? relationships?.textChars } }).relationship;
}

/**
 * The log/outcome `detail` of a failed request: `error?.message`, trimmed to
 * 200 chars. Only for errors raised before an answer exists (the provider,
 * the network, the request budget), never for an answer that failed to parse
 * -- see `errorNameOf`. Shared with src/memory/warmup.js.
 * @param {unknown} err
 * @returns {string|undefined}
 */
export function detailOf(err) {
  return err?.message ? String(err.message).slice(0, 200) : undefined;
}

/**
 * The log/outcome `detail` of an answer that failed to parse or to apply: the
 * error's name only (`SyntaxError`, `TypeError`, `Error`). A JSON.parse
 * message quotes the model's text, which is message contents. Shared with
 * src/memory/warmup.js.
 * @param {unknown} err
 * @returns {string}
 */
export function errorNameOf(err) {
  return typeof err?.name === 'string' && err.name ? err.name : 'Error';
}

/**
 * Whether a completion looks cut off by the output token cap: the provider
 * said so (`finish_reason: 'length'`), or the text has no closing `}` for
 * its first `{` (the same condition `parseJsonObject` fails on). Shared with
 * src/memory/warmup.js.
 * @param {string} text
 * @param {string|undefined} finishReason
 * @returns {boolean}
 */
export function looksTruncated(text, finishReason) {
  if (finishReason === 'length') return true;
  const start = String(text ?? '').indexOf('{');
  if (start === -1) return false;
  const end = String(text ?? '').lastIndexOf('}');
  return end <= start;
}

/**
 * Whether the buffered messages of one guild are ready for a memory update.
 * @param {object[]} buffer  Buffered slim messages, oldest first.
 * @param {number} nowMs
 * @param {object} cfg       `config.memory`.
 * @param {object} [relationshipsCfg]  `config.relationships`, only when the feature is on. A
 *   pile-up of messages addressed to the persona (`direct: true`) triggers an update early,
 *   so reactions to how people talk TO it do not wait for a full batch.
 * @param {{ maxAgeMinutes?: number }} [options]  `maxAgeMinutes`: a buffer that is not empty is
 *   also due once its oldest message is this old, however few lines it holds -- the private path
 *   (`memory.privateMaxAgeMinutes`, `runDuePrivate`), so a short direct chat is analyzed too. Not
 *   a positive number (0 included) or omitted (the guild path) -> no such rule.
 * @returns {boolean}
 */
export function isDue(buffer, nowMs, cfg, relationshipsCfg, { maxAgeMinutes } = {}) {
  if (buffer.length >= cfg.batchMessages) return true;
  if (buffer.length >= cfg.minBatchMessages) {
    const oldest = buffer[0];
    if (oldest && nowMs - oldest.ts >= cfg.maxBatchAgeMinutes * MINUTE_MS) return true;
  }
  if (relationshipsCfg?.directTriggerCount > 0) {
    const directCount = buffer.reduce((count, message) => count + (message.direct ? 1 : 0), 0);
    if (directCount >= relationshipsCfg.directTriggerCount) return true;
  }
  if (typeof maxAgeMinutes === 'number' && maxAgeMinutes > 0 && buffer.length > 0) {
    if (nowMs - buffer[0].ts >= maxAgeMinutes * MINUTE_MS) return true;
  }
  return false;
}

/** A notes stamp in epoch ms: an ISO string (src/memory/portrait.js#stampMs) or a finite number;
 * null for anything else (missing, cleared, hand-broken). */
function notesStampMs(value) {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  return stampMs(value);
}

/**
 * Whether a server or channel note is due for a re-check: stale when the later of its two stamps
 * -- the last real change of its text (`updatedAt`) and the last batch that was asked to look at
 * it again (`checkedAt`) -- is missing or at least `staleDays` days old. A stamp that is no time
 * counts as missing, so notes never stamped are stale. Pure.
 * @param {{ updatedAt?: unknown, checkedAt?: unknown }} stamps  ISO strings or epoch ms.
 * @param {number} nowMs
 * @param {number} staleDays  `memory.notesStaleDays`; not a number above 0 (0 = off) -> never stale.
 * @returns {{ days: number|null }|null}  null when fresh (or off); else `days`, the whole days
 *   since the text last changed, null when it never did.
 */
export function notesStale({ updatedAt, checkedAt } = {}, nowMs, staleDays) {
  if (typeof staleDays !== 'number' || !Number.isFinite(staleDays) || staleDays <= 0 || !Number.isFinite(nowMs)) return null;
  const updatedMs = notesStampMs(updatedAt);
  const latest = Math.max(updatedMs ?? -Infinity, notesStampMs(checkedAt) ?? -Infinity);
  if (latest > -Infinity && nowMs - latest < staleDays * DAY_MS) return null;
  return { days: updatedMs === null ? null : Math.floor((nowMs - updatedMs) / DAY_MS) };
}

/**
 * The notes staleness settings, read at each request, each a number of at least 0, else
 * config.json's value: `staleDays` = `memory.notesStaleDays` (7; 0 sends no marker);
 * `batchLines` = `memory.notesBatchLines` (8): the batch lines a channel, or the whole batch for
 * the server notes, needs before its notes are flagged; `minMessages` = `memory.notesMinMessages`
 * (30) and `guildMinMessages` = `memory.notesGuildMinMessages` (100): the messages a channel, or
 * every stored channel together, accumulated since the notes last changed or were last checked
 * (src/memory/channels.js#messagesSince); `retryHours` = `memory.notesRetryHours` (24): how long
 * a flag that earned no check stamp waits before it goes out again.
 * @param {object} [config]  The live config.
 * @returns {{ staleDays: number, batchLines: number, minMessages: number, guildMinMessages: number, retryHours: number }}
 */
function notesSettings(config) {
  const atLeastZero = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback);
  return {
    staleDays: atLeastZero(config?.memory?.notesStaleDays, 7),
    batchLines: atLeastZero(config?.memory?.notesBatchLines, 8),
    minMessages: atLeastZero(config?.memory?.notesMinMessages, 30),
    guildMinMessages: atLeastZero(config?.memory?.notesGuildMinMessages, 100),
    retryHours: atLeastZero(config?.memory?.notesRetryHours, 24),
  };
}

/**
 * The `{{fieldChars}}`/`{{maxDetails}}`/... placeholders `prompts.memory` may use, filled from
 * the live config so a prompt states the same limits the code actually clamps to. Missing config
 * keys fall back to MEMORY_LIMIT_DEFAULTS (config.json's own defaults), `{{relationshipChars}}`
 * to src/memory/voice.js#voiceLimits' (the limit stage B states for the same text), the recent
 * layer's `{{recentHours}}` / `{{maxNewRecent}}` / `{{recentChars}}` to src/memory/recent.js'
 * RECENT_DEFAULTS. With `features.recent` off the answer's `recent` field is ignored, so
 * `{{maxNewRecent}}` is 0 (the number of notes the code takes) and the other two are filled as
 * usual; an unknown placeholder in the prompt is left untouched by fillPromptTemplate regardless.
 * @param {object} config  Live config (`config.memory`, `config.relationships`, `config.lore`).
 * @param {string} selfName
 */
function memoryTemplateValues(config, selfName) {
  const memoryCfg = config.memory ?? {};
  const fieldChars = memoryCfg.fieldChars ?? MEMORY_LIMIT_DEFAULTS.fieldChars;
  return {
    name: selfName,
    fieldChars,
    guildFieldChars: fieldChars * 2,
    maxDetails: memoryCfg.maxDetails ?? MEMORY_LIMIT_DEFAULTS.maxDetails,
    maxInjokes: memoryCfg.maxInjokes ?? MEMORY_LIMIT_DEFAULTS.maxInjokes,
    maxSelfFacts: memoryCfg.maxSelfFacts ?? MEMORY_LIMIT_DEFAULTS.maxSelfFacts,
    maxNewEpisodes: memoryCfg.maxNewEpisodes ?? MEMORY_LIMIT_DEFAULTS.maxNewEpisodes,
    maxEpisodes: memoryCfg.maxEpisodes ?? MEMORY_LIMIT_DEFAULTS.maxEpisodes,
    maxDeltaPerUpdate: config.relationships?.maxDeltaPerUpdate ?? MEMORY_LIMIT_DEFAULTS.maxDeltaPerUpdate,
    maxInterests: memoryCfg.maxInterests ?? MEMORY_LIMIT_DEFAULTS.maxInterests,
    interestTopicChars: memoryCfg.interestTopicChars ?? MEMORY_LIMIT_DEFAULTS.interestTopicChars,
    interestNoteChars: memoryCfg.interestNoteChars ?? MEMORY_LIMIT_DEFAULTS.interestNoteChars,
    loreTextChars: config.lore?.textChars ?? MEMORY_LIMIT_DEFAULTS.loreTextChars,
    maxLearned: memoryCfg.maxLearned ?? MEMORY_LIMIT_DEFAULTS.maxLearned,
    learnedChars: memoryCfg.learnedChars ?? MEMORY_LIMIT_DEFAULTS.learnedChars,
    relationshipChars: voiceLimits(config).relationship,
    recentHours: memoryCfg.recentHours ?? RECENT_DEFAULTS.hours,
    maxNewRecent: recentSettings(config)?.maxNew ?? 0,
    recentChars: memoryCfg.recentChars ?? RECENT_DEFAULTS.chars,
  };
}

/**
 * `prompts.labels`, or a throw: a deployment with no/broken labels.json must fail loudly, not
 * send a broken prompt. The test is src/behavior/prompt.js#hasRequiredLabels, the one every
 * request builder and the startup check use. Shared with every warmup request builder
 * (src/memory/warmup.js).
 * @param {object} prompts
 * @returns {object}
 */
export function requireLabels(prompts) {
  const labels = prompts?.labels;
  if (!hasRequiredLabels(labels)) {
    throw new Error('prompts.labels is missing or incomplete: labels.transcript is required');
  }
  return labels;
}

/** Only the fields the memory prompt is allowed to see/update for a user profile.
 * `interests`/`details` are validated via normalizeInterests/normalizeDetails
 * (defensive; store.getUser already normalises on read). */
function pickProfileFields(profile) {
  const { names = [], character = '', style = '', relationship = '' } = profile ?? {};
  const interests = normalizeInterests(profile?.interests);
  const details = normalizeDetails(profile?.details).items;
  return { names, character, interests, style, details, relationship };
}

/** `YYYY-MM-DD` of an ISO timestamp, or `undefined` (so JSON.stringify omits
 * the key entirely) when the date is unknown -- see
 * docs/prompt-contract.md, "The input view of a stored item". */
function dateOnly(iso) {
  return typeof iso === 'string' && iso ? iso.slice(0, 10) : undefined;
}

/** `fromTokens(text, nameOf, 'analyzer')`, tolerating a non-string `text` (returned as-is). */
function resolveText(text, nameOf) {
  return typeof text === 'string' ? fromTokens(text, nameOf, 'analyzer') : text;
}

/** `resolveText` mapped over an array; non-arrays pass through untouched. */
function resolveTextArray(values, nameOf) {
  return Array.isArray(values) ? values.map((value) => resolveText(value, nameOf)) : values;
}

/** The `<existing_profiles>` view of one person's interests: only the top
 * `maxInterests` by rank (src/memory/ranking.js#topByRank, decayed with
 * `halfLifeDays`), in rank order -- `{ topic, note, seen, last }` (`seen` =
 * weight, `last` = the date-only lastSeen, omitted when unknown). `note` is
 * resolved (`<@id>` tokens -> `name (id:...)`) via `nameOf` -- see
 * docs/prompt-contract.md, "Members are referred to by id, never by
 * nickname". `maxInterests` not an integer -> every stored interest
 * (unlimited, matching the behaviour before this feature); `halfLifeDays` not
 * a positive number -> no decay, ranked by weight alone. See
 * docs/prompt-contract.md, "The analyzer" and "More is stored than
 * shown, and rank decays with age". Open items only; `itemId` (what a
 * `supersedes`/`conflict` op names), `from` (`validFrom`) and `conflict`
 * (`conflictSetId`) are present only when the item has them -- see
 * docs/prompt-contract.md, "Validity". */
function existingInterestsView(interests, maxInterests, halfLifeDays, nameOf) {
  const list = Array.isArray(interests) ? interests.filter(isOpen) : [];
  return topByRank(list, maxInterests, halfLifeDays).map(({ itemId, topic, note, weight, lastSeen, validFrom, conflictSetId }) => ({
    itemId: itemId || undefined,
    topic,
    note: resolveText(note, nameOf),
    seen: weight,
    last: dateOnly(lastSeen),
    from: validFrom || undefined,
    conflict: conflictSetId || undefined,
  }));
}

/** The `<existing_profiles>` view of one person's details: only the top
 * `maxDetails` by rank, in rank order -- `{ id, text, seen, last }` (`seen` =
 * weight, `last` = the date-only lastSeen, omitted when unknown). `text` is
 * resolved via `nameOf`, same as `existingInterestsView` above, and carries
 * `itemId`/`from`/`conflict` the same way. */
function existingDetailsView(details, maxDetails, halfLifeDays, nameOf) {
  const list = Array.isArray(details) ? details.filter(isOpen) : [];
  return topByRank(list, maxDetails, halfLifeDays).map(({ id, itemId, text, weight, lastSeen, validFrom, conflictSetId }) => ({
    id,
    itemId: itemId || undefined,
    text: resolveText(text, nameOf),
    seen: weight,
    last: dateOnly(lastSeen),
    from: validFrom || undefined,
    conflict: conflictSetId || undefined,
  }));
}

/** The `<existing_profiles>` view of one person's aliases: a plain list of
 * names, top `maxAliases` by rank -- see docs/prompt-contract.md,
 * "Aliases". Alias names are never token-resolved: they are literal
 * nicknames, not free text that could name a member by id. Stored JSON is
 * hand-editable: an item without a string `name` is skipped, never thrown on
 * (it would otherwise fail every batch whose roster or authors include its member). */
function existingAliasesView(aliases, maxAliases, halfLifeDays) {
  const list = Array.isArray(aliases) ? aliases.filter((item) => typeof item?.name === 'string' && isOpen(item)) : [];
  return topByRank(list, maxAliases, halfLifeDays).map((item) => item.name);
}

/**
 * The `closed` key of one `<existing_profiles>` view: the claims of `closed` (a profile's or
 * private layer's `closed` list, see src/memory/store.js#storeClosed) whose identity -- an
 * interest's topic, a detail's text, an alias's or a real name's name -- occurs as a whole word or phrase
 * (src/memory/mentions.js#occursAsWholeWord, case-insensitive) in the batch's texts, in stored
 * order, each with its days: `from` (`validFrom`, else the day of `firstSeen`; omitted when
 * unknown) and `to` (`validTo`). So the analyzer sees what was already closed on the topics it
 * is looking at and does not add it again. `[]` when none matches. See
 * docs/prompt-contract.md, "Validity".
 * @param {unknown} closed
 * @param {string} batchLower  The batch's texts, joined and lowercased.
 * @param {(id: string) => (string|null)} nameOf
 * @returns {object[]}
 */
function closedClaimsView(closed, batchLower, nameOf) {
  const out = [];
  for (const item of Array.isArray(closed) ? closed : []) {
    if (!isPlainObject(item)) continue;
    const identity = item.kind === 'interest' ? item.topic : item.kind === 'detail' ? item.text : item.kind === 'alias' || item.kind === 'realName' ? item.name : null;
    if (typeof identity !== 'string' || !occursAsWholeWord(batchLower, normalizeTopic(resolveText(identity, nameOf)))) continue;
    const view = { kind: item.kind };
    if (item.kind === 'interest') Object.assign(view, { topic: item.topic, note: resolveText(item.note ?? '', nameOf) });
    else if (item.kind === 'detail') view.text = resolveText(item.text, nameOf);
    else view.name = item.name;
    view.from = item.validFrom || dateOnly(item.firstSeen);
    view.to = item.validTo ?? undefined;
    out.push(view);
  }
  return out;
}

/**
 * `memory.aliasRosterSize`: how many members the analyzer's `<known_members>` roster lists at
 * most; 0 = no roster. Missing or not a non-negative integer -> 40, config.json's value. Read
 * at each request (buildMemoryRequest, and analyze() before it lists the stored profiles).
 * @param {object} [config]  The live config.
 * @returns {number}
 */
function aliasRosterSize(config) {
  const size = config?.memory?.aliasRosterSize;
  return Number.isInteger(size) && size >= 0 ? size : 40;
}

/**
 * `memory.analyzerEpisodes`: how many of one member's stored episodes `<existing_profiles>` shows
 * the analyzer at most -- the first ones of the reply side's order
 * (src/memory/episodes.js#topEpisodes), so the moments most likely to be told again are the ones
 * it sees; 0 = none. Only the view is capped: the stored list keeps every episode, and a new one
 * is checked for a duplicate against all of them (src/memory/episodes.js#mergeEpisodes). Missing
 * or not a non-negative integer -> 8, config.json's value. Read at each request.
 * @param {object} [config]  The live config.
 * @returns {number}
 */
export function analyzerEpisodes(config) {
  const count = config?.memory?.analyzerEpisodes;
  return Number.isInteger(count) && count >= 0 ? count : 8;
}

/**
 * How many lines each author has in `lines` (the persona's own skipped), keyed by id as a
 * string, plus the index of each author's first line there.
 * @param {object[]} lines
 * @returns {{ counts: Map<string, number>, first: Map<string, number> }}
 */
function authorLineCounts(lines) {
  const counts = new Map();
  const first = new Map();
  lines.forEach((m, index) => {
    if (!m || m.self) return;
    const id = String(m.authorId);
    counts.set(id, (counts.get(id) ?? 0) + 1);
    if (!first.has(id)) first.set(id, index);
  });
  return { counts, first };
}

/** The distinct non-self author ids of `messages`, as strings, in first-seen order. */
function batchAuthorIds(messages) {
  return [...new Set((messages ?? []).filter((m) => !m?.self).map((m) => String(m.authorId)))];
}

/** The distinct channel ids of `messages` (a missing one skipped), in first-seen order. */
function batchChannelIds(messages) {
  return [...new Set((messages ?? []).map((m) => m?.channelId).filter((id) => id != null))];
}

/**
 * The `<known_members>` roster: stored members who are NOT among `authorIds`, most recently
 * seen (`lastSeen`) first, at most `size` of them. Each entry is the member's id plus one
 * `"<id>":{"names":[...],"aliases":[...]}` fragment holding exactly what `<existing_profiles>`
 * shows for names and aliases -- every stored display name, newest first, and the
 * `existingAliasesView` list (key omitted when empty) -- and nothing else. A profile with
 * neither a name nor an alias gives the analyzer nothing to match and is left out.
 * @param {object[]} [pool]  Stored profiles (store.listUserProfiles): `id`, `names`, `aliases`, `lastSeen` read.
 * @param {Set<string>} authorIds
 * @param {number} size
 * @param {object} memoryCfg  `config.memory` (`maxAliases`, `aliasHalfLifeDays`).
 * @returns {{ id: string, text: string }[]}
 */
function aliasRoster(pool, authorIds, size, memoryCfg) {
  if (size <= 0 || !Array.isArray(pool)) return [];
  const listed = new Set();
  const members = [];
  for (const profile of pool) {
    const id = profile?.id === undefined || profile?.id === null ? '' : String(profile.id);
    if (!id || authorIds.has(id) || listed.has(id)) continue;
    listed.add(id);
    const usable = (name) => typeof name === 'string' && name.trim() !== '';
    const names = (Array.isArray(profile.names) ? profile.names : []).filter(usable);
    const aliases = existingAliasesView(profile.aliases, memoryCfg.maxAliases, memoryCfg.aliasHalfLifeDays).filter(usable);
    if (names.length === 0 && aliases.length === 0) continue;
    const lastSeenMs = Date.parse(profile.lastSeen ?? '');
    members.push({ id, names, aliases, lastSeenMs: Number.isFinite(lastSeenMs) ? lastSeenMs : -Infinity });
  }
  // Newest first; an unknown lastSeen last; ties by id, so the order never depends on the pool's.
  members.sort((a, b) => b.lastSeenMs - a.lastSeenMs || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0));
  return members.slice(0, size).map(({ id, names, aliases }) => {
    const view = aliases.length > 0 ? { names, aliases } : { names };
    return { id, text: `${JSON.stringify(id)}:${JSON.stringify(view)}` };
  });
}

/** The `<existing_guild>` view of the things people taught the persona: only
 * the top `maxLearned` by rank (decayed with `halfLifeDays`), in rank order
 * -- `{ id, text, from, seen, last }` (`seen` = weight, `last` = the
 * date-only lastSeen, omitted when unknown; `from` omitted when the item has
 * no teacher). `text` and `from` are resolved via `nameOf`, same as
 * `existingDetailsView` above. Stored JSON is validated first (defensive;
 * store.getGuild already normalises on read). */
function existingLearnedView(guildMemory, maxLearned, halfLifeDays, nameOf) {
  const learned = normalizeDetails(guildMemory?.learned, guildMemory?.learnedNextId).items;
  return topByRank(learned, maxLearned, halfLifeDays).map(({ id, text, from, weight, lastSeen }) => {
    const view = { id, text: resolveText(text, nameOf) };
    if (from) view.from = resolveText(from, nameOf);
    view.seen = weight;
    view.last = dateOnly(lastSeen);
    return view;
  });
}

/** Only the fields the memory prompt is allowed to see/update for guild
 * memory, with every free-text field resolved (`<@id>` -> `name (id:...)`)
 * via `nameOf`. `memoryCfg` (`config.memory`) sizes the `learned` view
 * (`maxLearned`, `learnedHalfLifeDays`, config.json's defaults when absent). */
function pickGuildFields(guildMemory, nameOf, memoryCfg = {}) {
  const { patterns = '', starters = '', injokes = [], self = [] } = guildMemory ?? {};
  return {
    patterns: resolveText(patterns, nameOf),
    starters: resolveText(starters, nameOf),
    injokes: resolveTextArray(injokes, nameOf),
    self: resolveTextArray(self, nameOf),
    learned: existingLearnedView(
      guildMemory,
      memoryCfg.maxLearned ?? MEMORY_LIMIT_DEFAULTS.maxLearned,
      memoryCfg.learnedHalfLifeDays ?? MEMORY_LIMIT_DEFAULTS.learnedHalfLifeDays,
      nameOf,
    ),
  };
}

/** Only the fields the memory prompt is allowed to see/update for a channel
 * entry, with `purpose`/`topics`/`tone` resolved via `nameOf`. */
function pickChannelFields(channel, nameOf) {
  const { name = '', category = null, topic = null, purpose = '', topics = '', tone = '' } = channel ?? {};
  return {
    name,
    category,
    topic,
    purpose: resolveText(purpose, nameOf),
    topics: resolveText(topics, nameOf),
    tone: resolveText(tone, nameOf),
  };
}

/**
 * Normalized set of `config.memory.mainChannelIds`, compared as strings --
 * see docs/prompt-contract.md, "Main channels are the source of the
 * portrait". Garbage config (not an array, non-string entries) never throws:
 * a non-array collapses to an empty set, every entry is coerced with String().
 * Shared with src/memory/warmup.js.
 * @param {unknown} mainChannelIds
 * @returns {Set<string>}
 */
export function mainChannelSet(mainChannelIds) {
  return new Set((Array.isArray(mainChannelIds) ? mainChannelIds : []).map((id) => String(id)));
}

/**
 * The `<existing_lore>` input: ALL stored titles with their keys (titles+keys
 * only, capped to the 200 most recently updated -- so the analyzer never
 * creates a duplicate title it just cannot see), plus the full text of
 * entries the batch's own messages touch (so those can be updated with
 * context). '' when the lorebook is empty. See docs/prompt-contract.md,
 * "The analyzer".
 * @param {object[]} loreEntries   Every stored entry for the guild.
 * @param {string[]} batchTexts    Plain message contents of this batch.
 * @param {(id: string) => (string|null)} nameOf  Resolves `text`'s `<@id>` tokens
 *   to `name (id:...)`; `title`/`keys` are never token content, left untouched.
 */
function existingLoreBlock(loreEntries, batchTexts, nameOf) {
  const entries = Array.isArray(loreEntries) ? loreEntries : [];
  if (entries.length === 0) return '';
  const titles = [...entries]
    .sort((a, b) => String(b.updatedAt ?? '').localeCompare(String(a.updatedAt ?? '')))
    .slice(0, 200)
    .map((entry) => ({ title: entry.title, keys: entry.keys }));
  const matched = keywordMatches(entries, batchTexts).map((entry) => ({
    title: entry.title,
    keys: entry.keys,
    text: resolveText(entry.text, nameOf),
  }));
  return block('existing_lore', JSON.stringify({ titles, matched }));
}

/**
 * The character card followed by the owner's live rules (`prompts.rules`) -- exactly how the chat
 * system prompt composes the same two files (src/behavior/prompt.js#buildRequest): both
 * placeholders filled the same way, joined by a blank line; rules absent/empty -> the card alone.
 * Shared by this module's own `<character>` block and every request src/memory/warmup.js sends
 * that carries one, so a `/nep rule add` reaches memory work the same turn it reaches the chat
 * prompt, not just the live persona.
 * @param {object} prompts  Live prompts (`hot.prompts`, or a fixture with the same shape).
 * @param {string} selfName
 * @returns {string}
 */
export function characterText(prompts, selfName) {
  const nameFill = (text) => fillPromptTemplate(text, { name: selfName });
  return [prompts['character-card'], prompts.rules].map(nameFill).filter(Boolean).join('\n\n');
}

/**
 * The `<recent_notes>` candidates of a guild batch: the lines of the recent store still inside
 * `memory.recentHours` of `now` (src/memory/recent.js#liveRecent), the newest
 * `memory.recentShown` of them by moment, oldest first. Each is one JSON item `{ id, when, text }`:
 * `when` the moment in the transcript's own date and clock (`formatDate` + `formatClock`), `text`
 * with every `<@id>` token as `name (id:...)` like every other analyzer view. None with
 * `features.recent` false, `memory.recentShown` 0, no clock or no live line.
 * @param {unknown} lines  The store's lines (src/memory/store.js#getRecent).
 * @param {{ config: object, now: number, timezone: string, locale?: string,
 *   nameOf: (id: string) => (string|null) }} opts
 * @returns {{ id: number, text: string }[]}
 */
function recentNoteItems(lines, { config, now, timezone, locale, nameOf }) {
  const settings = recentSettings(config);
  if (!settings || !Number.isFinite(now)) return [];
  const shown = Number.isInteger(settings.shown) && settings.shown >= 0 ? settings.shown : RECENT_DEFAULTS.shown;
  if (shown === 0) return [];
  const live = liveRecent(lines, { now, hours: settings.hours })
    .filter((line) => Number.isInteger(line.id) && typeof line.text === 'string' && line.text.trim() !== '')
    .sort((a, b) => a.at - b.at || a.id - b.id);
  return live.slice(-shown).map((line) => ({
    id: line.id,
    text: JSON.stringify({
      id: line.id,
      when: `${formatDate(line.at, timezone, locale)} ${formatClock(line.at, timezone, locale)}`,
      text: resolveText(line.text, nameOf),
    }),
  }));
}

/**
 * Build one memory-update LLM request. Pure: no I/O, no clock reads besides
 * what is already baked into `messages`.
 *
 * @param {object} input
 * @param {object} input.prompts      Live prompts; `prompts.memory` is the system message.
 * @param {object} input.config       Live config.
 * @param {object} input.calibrator   From createCalibrator().
 * @param {object} input.profiles     Stored profiles of the batch's distinct non-self authors, keyed by user id.
 *   Each goes into `<existing_profiles>` whole or compact. Whole: the prose fields and the attitude
 *   as stored, the ranked top of interests, details and aliases (`memory.maxInterests`,
 *   `maxDetails`, `maxAliases`) and of episodes (`memory.analyzerEpisodes`, see
 *   `analyzerEpisodes`); the stored profile is never trimmed. Compact: `names` (a guild batch),
 *   `affinity` (relationships on) and `compact: true`, nothing else. Every profile is compact at
 *   first; whole ones take what the transcript left (after the roster, before the recent notes),
 *   offered only for authors with a line shown, the most lines shown first, so a heavy batch
 *   sends its quieter authors compact rather than costing a line or failing.
 * @param {object} input.guildMemory  Stored guild memory.
 * @param {object} [input.channels]   Stored channel entries of the batch's distinct channels, keyed by channel id.
 * @param {object[]} input.messages   Slim buffered messages (oldest first) to summarize.
 * @param {string} input.selfName     The persona's display name in this guild.
 * @param {object[]} [input.loreEntries]  Every stored lorebook entry of the guild (store.getLore),
 *   for the `<existing_lore>` input; omitted or `features.lore: false` -> no block at all.
 * @param {Map<string, string>} [input.descriptions]  Item id -> describer caption
 *   (src/memory/describe.js), for pictures the analyzer cannot see itself.
 * @param {Map<string, object>} [input.videos]  Item id -> video state read from the video
 *   describer's cache (src/memory/describe.js#describeVideo), for videos it cannot watch itself.
 * @param {Map<string, string>} [input.reads]  Link id -> the excerpt the web lookup read from that
 *   page (src/web/lookup.js), read from the same cache.
 * @param {(id: string) => (string|null)} [input.nameOf]  Resolves a member id to their
 *   current stored name (`profile.names[0]`), for turning every `<@id>` token this
 *   request's views carry into `name (id:...)` -- see
 *   docs/prompt-contract.md, "Members are referred to by id, never by
 *   nickname". Omitted -> every token is left exactly as stored (no I/O of its own;
 *   the caller, src/memory/update.js#analyze, injects a store-backed lookup).
 * @param {{ publicProfile: object|null, now?: number }} [input.privateChat]  A private-chat
 *   batch (see `analyzePrivate`): `profiles` then holds ONLY the partner's private layer (its
 *   `affinity` already the effective view), rendered without names/character/style/aliases;
 *   `labels.memory.privateNote` goes in a `<private>` block, `publicProfile` is rendered
 *   read-only into `<public_profile>` (src/behavior/prompt.js#renderProfile, `now` drives its
 *   unsure/stale marks), `<existing_channels>` is left out and every transcript line sits under
 *   `labels.memory.privateChannel` instead of a channel name. Omitted -> the guild request.
 * @param {object[]} [input.rosterProfiles]  Every stored member profile of the guild
 *   (store.listUserProfiles): the pool of the `<known_members>` roster, the members who did NOT
 *   write in this batch (see `aliasRoster`), so the analyzer can give one of them an alias.
 *   Omitted, a private batch, or `memory.aliasRosterSize` 0 -> no roster. The roster is its own
 *   section, ranked after the transcript's oldest line and before the rest of it; never required,
 *   and it never takes the room of that first line, so it can never make the request fail.
 *   Entries that do not fit are skipped in newest-first order (budget.js, `keep: 'first'`): a
 *   long entry can be skipped while a shorter, older one still fits, so the roster sent may have
 *   gaps anywhere, not only a cut tail.
 * @param {'single'|'decide'} [input.stage]  `decide` = stage A of the two-stage analyzer:
 *   the system message is `prompts['memory-decide']` (the same placeholders filled), and a guild
 *   profile's view leaves `style` out (stage A writes no portrait; `character` stays as
 *   context). Everything else -- blocks, roster, recent notes, markers, the fit and the return
 *   value -- is the single-stage request's. Omitted or `single` -> `prompts.memory`.
 * @param {object[]} [input.recentLines]  The guild's recent lines (store.getRecent(guildId).lines):
 *   the live ones go into `<recent_notes>` (see `recentNoteItems`), so the analyzer does not write
 *   a moment twice and can take back a wrong line by id. Their own section, ranked AFTER the
 *   transcript and never required: on a heavy batch the notes are cut first (the oldest first) and
 *   can never fail the request or cost a transcript line. Rendered after `<known_members>`, right
 *   before `<new_messages>`. Omitted, a private batch or `features.recent` false -> no block.
 * @param {number} [input.now]  The clock (epoch ms) the recent window and the notes' staleness are
 *   measured from; omitted -> the batch's newest message.
 *
 * @param {object[]} [input.guildChannels]  Every stored channel entry of the guild
 *   (store.listChannels): their `days` tallies are the server's activity for the server notes'
 *   marker. Omitted -> the entries of `channels`.
 *
 * Stale notes (guild batches only): a channel entry of `<existing_channels>` whose channel has at
 * least `memory.notesBatchLines` lines among the lines the request shows, main or not, carries
 * `"stale": { "days": n }` when its channel accumulated at least `memory.notesMinMessages`
 * messages (its `days` tally, src/memory/channels.js#messagesSince) since the later of its
 * `updatedAt` and `notesCheckedAt`, its notes are stale (`notesStale`: its `updatedAt`, which
 * only a real change of purpose/topics/tone stamps, and its `notesCheckedAt`) and no flag went out
 * within `memory.notesRetryHours` (`notesFlaggedAt`); `<existing_guild>` carries the same once the
 * request shows at least `memory.notesBatchLines` lines, every channel of `guildChannels` together
 * accumulated `memory.notesGuildMinMessages` since the later of `notesUpdatedAt` and
 * `notesCheckedAt`, the server notes are stale and their `notesFlaggedAt` waited as long. `n` =
 * whole days since the text last changed, null when never. `memory.notesStaleDays` 0 sends no
 * marker. A JSON field only: the wording that asks for a re-check is the prompt's.
 * @returns {{ messages: object[], consumed: number, shown: number, deferred: number, rosterIds: string[],
 *   rosterCandidates: number, rosterTokens: number, profilesWhole: number, profilesCompact: number,
 *   profilesTokens: number, staleRelationships: number, relationshipRewrites: number,
 *   rewriteIds: string[], recentShown: number,
 *   recentIds: number[], staleNotes: { channels: string[], guild: boolean } }}
 *   `shown`: the oldest lines of the batch, contiguous, that fit the token cap -- what
 *   `<new_messages>` carries and the only lines this request consumes (`consumed === shown`); the
 *   other `deferred` are left for the next batch, never consumed unseen (`shown + deferred` is the
 *   batch). A batch with lines of which none fits throws SectionsTooLargeError (`token-limit`).
 *   `staleNotes`: the targets sent with a stale marker (channel ids in the order sent, and whether
 *   the server notes were), for `store.markNotesFlagged` and `reconcileNoteReviews` once the batch is applied.
 *   `rosterIds`: the members the request's `<known_members>` actually carries, in the order
 *   sent -- the only non-authors an answer may give an alias (applyMemoryUpdate's `aliasOnlyIds`).
 *   `rosterCandidates`: the roster entries offered to the budget (after `memory.aliasRosterSize`),
 *   sent or not; `rosterTokens`: the estimated tokens the sent entries took from the request.
 *   `profilesWhole` / `profilesCompact`: the profiles `<existing_profiles>` carries whole and
 *   compact; `profilesTokens`: the estimated tokens of that block.
 *   `staleRelationships`: the whole profiles sent with a `relationshipStale` marker (a compact one carries none)
 *   (src/memory/affinity.js#relationshipStaleOf, settings `relationships.rewriteOnBandChange`,
 *   `bandHysteresis`, `rewriteOnDrift`, `rewriteAfterMoves`); 0 with relationships off.
 *   `relationshipRewrites`: how many of those markers carry cause `rewrite` (a forced rewrite);
 *   `rewriteIds`: their member ids, for stage A to queue their voice items (applyDecision).
 *   `recentShown`: the recent lines `<recent_notes>` actually carries; `recentIds`: their ids, in
 *   the order sent -- the only lines an answer may remove (applyMemoryUpdate's `recent.shownIds`).
 */
export function buildMemoryRequest({ prompts, config, calibrator, profiles, guildMemory, channels, messages, selfName, loreEntries, descriptions, videos, reads, nameOf, privateChat, rosterProfiles, recentLines, now, guildChannels, stage = 'single' }) {
  const { timezone } = config.bot;
  const labels = requireLabels(prompts);
  if (privateChat && (!labels.memory?.privateNote || !labels.memory?.privateChannel)) {
    throw new Error('prompts.labels is incomplete: memory.privateNote and memory.privateChannel are required for a private batch');
  }
  const decide = stage === 'decide';
  const relationships = config.features?.relationships !== false;
  const episodesOn = config.features?.episodes !== false;
  const loreOn = config.features?.lore !== false;
  const resolveName = typeof nameOf === 'function' ? nameOf : () => null;
  const base = fillPromptTemplate(decide ? prompts['memory-decide'] : prompts.memory, memoryTemplateValues(config, selfName));
  // A guild batch with features.intentions exactly true also asks for intention candidates from
  // the persona's own lines (prompts/memory-intentions.md, appended whole; absent or blank: not
  // asked). Off, the system message is the analyzer's as it was.
  const intentionsAsked = !privateChat && config.features?.intentions === true && hasContent(prompts['memory-intentions']);
  const system = intentionsAsked ? `${base}\n\n${fillPromptTemplate(prompts['memory-intentions'], { maxCandidates: intentionSettings(config).maxCandidates })}` : base;
  const characterBlock = relationships ? block('character', characterText(prompts, selfName)) : '';

  // Each profile twice: whole (what the analyzer rewrites, its lists capped to their ranked top)
  // and compact (id, names, attitude), sent when the whole one does not fit (see the fit below).
  const profileViews = [];
  // The batch's texts, for the closed claims a whole view carries (closedClaimsView).
  const batchLower = messages.map((m) => (typeof m?.content === 'string' ? m.content : '')).join('\n').toLowerCase();
  const episodeCap = analyzerEpisodes(config);
  // The moment the `addressedAs` order is read at: `now`, else the batch's newest message.
  const viewNow = Number.isFinite(now) ? now : Math.max(0, ...messages.map((m) => (Number.isFinite(m?.ts) ? m.ts : 0)));
  for (const [id, profile] of Object.entries(profiles ?? {})) {
    const fields = pickProfileFields(profile);
    if (privateChat) {
      // The private layer has no names or portrait of its own (they live in the public
      // profile, shown read-only in <public_profile>): nothing to offer for editing here.
      delete fields.names;
      delete fields.character;
      delete fields.style;
    } else {
      fields.character = resolveText(fields.character, resolveName);
      if (decide) delete fields.style;
      else fields.style = resolveText(fields.style, resolveName);
    }
    fields.relationship = resolveText(fields.relationship, resolveName);
    fields.interests = existingInterestsView(fields.interests, config.memory?.maxInterests, config.memory?.interestHalfLifeDays, resolveName);
    fields.details = existingDetailsView(fields.details, config.memory?.maxDetails, config.memory?.detailHalfLifeDays, resolveName);
    if (!privateChat && Array.isArray(profile?.aliases) && profile.aliases.length > 0) {
      const aliases = existingAliasesView(profile.aliases, config.memory?.maxAliases, config.memory?.aliasHalfLifeDays);
      if (aliases.length > 0) fields.aliases = aliases;
    }
    // The real name as its name; the names people use for them, most used first (no scores).
    if (!privateChat && typeof profile?.realName?.name === 'string' && profile.realName.name) fields.realName = profile.realName.name;
    if (!privateChat) {
      const addressedAs = rankAddressed(profile?.addressedAs, viewNow, config.memory?.addressHalfLifeDays ?? DEFAULT_ADDRESS_HALF_LIFE_DAYS);
      if (addressedAs.length > 0) fields.addressedAs = addressedAs;
    }
    const closedClaims = closedClaimsView(profile?.closed, batchLower, resolveName);
    if (closedClaims.length > 0) fields.closed = closedClaims;
    if (relationships) {
      const affinity = profile?.affinity ?? emptyAffinity();
      const score = Number.isFinite(affinity.score) ? affinity.score : 0;
      // The analyzer sees the integer score, same as the owner (see roundScore); band thresholds
      // and the ignore-chance maths, not the analyzer, are what need the precise value.
      const band = affinityBand(score);
      fields.affinity = { score: roundScore(score), band, reason: resolveText(affinity.reason, resolveName) };
      // The stored relationship text no longer matches the score -- a slow drift never looks like
      // a shift from inside one batch: flag it with its cause (`rewrite`, `first`, `band`, `drift`,
      // `moves`, see relationshipStaleOf) so the analyzer rewrites it. `rewrite` is the owner's
      // forced rewrite (the public profile's `relationshipRewrite`; a private layer has none). Measured from the score and the
      // moment the text was written (`relationshipScore`, missing = 0; `relationshipWrittenAt`).
      // An EMPTY text is flagged `first` once the profile has something a first version could be
      // written from: a non-zero score, a non-empty reason, or stored episodes (the "dealing with
      // each other in this batch" trigger is left to the model). A private view's affinity is the
      // effective score with the private layer's own history (analyzePrivate): its text counts
      // the private moves since it was written. The history is read here, never shown.
      const stale = relationshipStaleOf(
        {
          text: fields.relationship,
          score,
          writtenScore: profile?.relationshipScore,
          writtenAt: profile?.relationshipWrittenAt,
          history: affinity.history,
          hasReason: typeof affinity.reason === 'string' && affinity.reason.trim() !== '',
          hasEpisodes: Array.isArray(profile?.episodes) && profile.episodes.length > 0,
          rewrite: !privateChat && profile?.relationshipRewrite === true,
        },
        config.relationships,
      );
      if (stale) fields.relationshipStale = stale;
    }
    // The reply side's top episodes only (heaviest, then newest): the stored list keeps them all.
    const episodes = episodesOn ? topEpisodes(profile?.episodes, episodeCap) : [];
    if (episodes.length > 0) {
      fields.episodes = episodes.map(({ date, what, quote, weight }) => ({ date, what: resolveText(what, resolveName), quote, weight }));
    }
    const compact = privateChat ? {} : { names: fields.names };
    if (fields.affinity) compact.affinity = fields.affinity;
    compact.compact = true;
    profileViews.push({ id, whole: fields, compact, text: `${JSON.stringify(id)}:${JSON.stringify(fields)}` });
  }
  /** The `<existing_profiles>` block: the members of `wholeIds` whole, every other one compact. */
  const profilesBlockOf = (wholeIds) =>
    block('existing_profiles', JSON.stringify(Object.fromEntries(profileViews.map((view) => [view.id, wholeIds.has(view.id) ? view.whole : view.compact]))));
  const loreBlock = loreOn ? existingLoreBlock(loreEntries, messages.map((m) => m.content).filter(Boolean), resolveName) : '';

  // The clock of the recent window and of the notes' staleness.
  const clock = Number.isFinite(now) ? now : Math.max(...messages.map((m) => (Number.isFinite(m?.ts) ? m.ts : -Infinity)));
  // Server and channel notes nothing has changed or re-checked for `memory.notesStaleDays`, guild
  // batches only, once the lines the request shows are enough to judge them by (see the JSDoc
  // above). Fitted with the markers of the whole batch, then built again from the lines shown: a
  // marker can only drop, so the request only gets smaller.
  const notes = notesSettings(config);
  const guildFields = pickGuildFields(guildMemory, resolveName, config.memory ?? {});
  const mainChannels = mainChannelSet(config.memory?.mainChannelIds);
  const channelFields = Object.entries(channels ?? {}).map(([id, channel]) => {
    const fields = pickChannelFields(channel, resolveName);
    if (mainChannels.has(String(id))) fields.main = true;
    return { id, channel, fields };
  });
  // Messages accumulated since the later of a note's two stamps (null = never stamped: the whole
  // tally), and whether a flag that earned no check stamp waited `memory.notesRetryHours`.
  const accumulatedSince = (entries, updatedAt, checkedAt) => {
    const since = Math.max(notesStampMs(updatedAt) ?? -Infinity, notesStampMs(checkedAt) ?? -Infinity);
    return entries.reduce((sum, entry) => sum + messagesSince(entry, Number.isFinite(since) ? since : null, clock).count, 0);
  };
  const waited = (flaggedAt) => {
    const ms = notesStampMs(flaggedAt);
    return ms === null || clock - ms >= notes.retryHours * HOUR_MS;
  };
  const serverChannels = (Array.isArray(guildChannels) ? guildChannels : Object.values(channels ?? {})).filter(isPlainObject);
  const notesBlocks = (lines) => {
    const staleNotes = { channels: [], guild: false };
    const linesIn = new Map();
    if (!privateChat) {
      for (const m of lines) linesIn.set(String(m.channelId), (linesIn.get(String(m.channelId)) ?? 0) + 1);
    }
    const guildView = { ...guildFields };
    if (
      !privateChat &&
      lines.length >= notes.batchLines &&
      waited(guildMemory?.notesFlaggedAt) &&
      accumulatedSince(serverChannels, guildMemory?.notesUpdatedAt, guildMemory?.notesCheckedAt) >= notes.guildMinMessages
    ) {
      const stale = notesStale({ updatedAt: guildMemory?.notesUpdatedAt, checkedAt: guildMemory?.notesCheckedAt }, clock, notes.staleDays);
      if (stale) {
        guildView.stale = stale;
        staleNotes.guild = true;
      }
    }
    const existingChannels = {};
    for (const { id, channel, fields } of channelFields) {
      const view = { ...fields };
      if (
        !privateChat &&
        (linesIn.get(String(id)) ?? 0) >= notes.batchLines &&
        waited(channel?.notesFlaggedAt) &&
        accumulatedSince([channel], channel?.updatedAt, channel?.notesCheckedAt) >= notes.minMessages
      ) {
        const stale = notesStale({ updatedAt: channel?.updatedAt, checkedAt: channel?.notesCheckedAt }, clock, notes.staleDays);
        if (stale) {
          view.stale = stale;
          staleNotes.channels.push(String(id));
        }
      }
      existingChannels[id] = view;
    }
    return {
      guildBlock: block('existing_guild', JSON.stringify(guildView)),
      channelsBlock: privateChat ? '' : block('existing_channels', JSON.stringify(existingChannels)),
      staleNotes,
    };
  };

  const privateBlock = privateChat ? block('private', labels.memory.privateNote) : '';
  const publicProfileBlock = privateChat
    ? block(
        'public_profile',
        renderProfile(privateChat.publicProfile, labels, {
          interlocutor: true,
          episodes: { enabled: episodesOn },
          maxInterests: config.memory?.maxInterests,
          maxDetails: config.memory?.maxDetails,
          maxAliases: config.memory?.maxAliases,
          aliasHalfLifeDays: config.memory?.aliasHalfLifeDays,
          addressHalfLifeDays: config.memory?.addressHalfLifeDays,
          interestHalfLifeDays: config.memory?.interestHalfLifeDays,
          detailHalfLifeDays: config.memory?.detailHalfLifeDays,
          confirmAfter: config.memory?.confirmAfter,
          staleDays: config.memory?.interestStaleDays,
          now: privateChat.now,
          nameOf: resolveName,
        }),
      )
    : '';
  /** The fixed blocks in the order the user message carries them. */
  const fixedBlocksOf = (profilesBlock, notesView) =>
    [privateBlock, characterBlock, profilesBlock, publicProfileBlock, loreBlock, notesView.guildBlock, notesView.channelsBlock].filter(Boolean);

  const formatOptions = {
    timezone,
    gapMinutes: config.context.gapMarkerMinutes,
    maxChars: config.context.maxMessageChars,
    selfName,
    mode: 'memory',
    labels,
    seeReactions: config.features?.seeReactions !== false,
    reactionsPerMessage: config.context.reactionsPerMessage,
    descriptions,
    videos,
    reads,
  };
  // A direct-message channel has no name worth showing: the whole private batch sits under
  // one `labels.memory.privateChannel` heading, same line format as a guild channel.
  const transcriptMessages = privateChat ? messages.map((m) => ({ ...m, channelName: labels.memory.privateChannel })) : messages;
  const transcriptItems = formatTranscript(transcriptMessages, formatOptions);
  const transcriptTexts = transcriptItems.map((item) => item.text);

  // The `<known_members>` roster, guild batches only: stored members who did not write in this
  // batch, so an alias stated about one of them has an id to land on.
  const rosterEntries = privateChat
    ? []
    : aliasRoster(rosterProfiles, new Set([...batchAuthorIds(messages), ...Object.keys(profiles ?? {})]), aliasRosterSize(config), config.memory ?? {});

  // The live recent lines, guild batches only: what the store already holds, so the analyzer
  // does not write the same moment again.
  const recentItems = privateChat ? [] : recentNoteItems(recentLines, { config, now: clock, timezone, locale: labels.locale, nameOf: resolveName });

  const cost = sectionCost(calibrator);
  const batchNotes = notesBlocks(messages);
  // Every profile compact is the required floor; a whole profile is an upgrade over it, priced at
  // its full text (the compact one stays counted too, so the real request is never larger).
  const allCompact = profilesBlockOf(new Set());
  const fit = (upgrades) =>
    fitSections(
      [
        {
          name: 'fixed',
          required: true,
          items: [system, ...fixedBlocksOf(allCompact, batchNotes)].filter(Boolean),
        },
        // The batch's oldest line, ranked before the roster: whatever the roster would take, the
        // request carries a line whenever one fits at all.
        { name: 'oldestLine', items: transcriptTexts.slice(0, 1) },
        // Ranked before the rest of the transcript, so a heavy batch cannot starve it; not
        // required, so it never raises a token-limit failure: an entry that does not fit is skipped
        // and the next, older one is still tried, so what is sent may have gaps.
        { name: 'roster', keep: 'first', items: rosterEntries.map((entry) => entry.text) },
        // The rest, oldest first and contiguous: the first line that does not fit ends what is
        // shown, and it and every later line stay in the buffer for the next batch.
        { name: 'transcript', keep: 'oldest', items: transcriptTexts.slice(1) },
        // Whole profiles take what the transcript left, the authors with the most lines shown
        // first: memory is sent for the chat the request reads, never in its place. One that does
        // not fit is skipped and stays compact, a smaller one after it is still tried.
        { name: 'profiles', keep: 'first', items: upgrades.map((view) => view.text) },
        // Ranked after the transcript and the profiles: it takes only what they left, so it is cut
        // first and never costs a transcript line; not required, so it never fails the request.
        // The newest notes survive a cut.
        { name: 'recent', keep: 'newest', items: recentItems.map((item) => item.text) },
      ],
      requestTokenLimit(config),
      cost,
    );
  // One transcript item per message, so the lines shown are the batch's first `shown` messages.
  const shownOf = (kept) => (kept.oldestLine.length === 0 ? 0 : 1 + leadingRun(transcriptTexts.slice(1), kept.transcript));

  // Every section before the profiles is the same in both fits, so the first one (no whole
  // profile) already settles the lines shown. Only an author with a line among them can be
  // written by this request: those are offered whole, the most lines shown first (then the
  // earliest line, then the input order). A private batch's one profile is the partner's,
  // offered whether or not a line of their own is shown.
  const reach = shownOf(fit([]).kept);
  if (reach === 0 && messages.length > 0) {
    throw new SectionsTooLargeError('no transcript line fits the token limit beside the required prompt sections');
  }
  const { counts, first } = authorLineCounts(messages.slice(0, reach));
  const upgrades = profileViews
    .map((view, index) => ({ view, index, lines: counts.get(view.id) ?? 0, at: first.get(view.id) ?? Infinity }))
    .filter((entry) => entry.lines > 0 || privateChat)
    .sort((a, b) => b.lines - a.lines || a.at - b.at || a.index - b.index)
    .map((entry) => entry.view);
  const { kept, stats } = fit(upgrades);
  const shown = shownOf(kept);

  const keptProfileTexts = new Set(kept.profiles);
  const wholeIds = new Set(upgrades.filter((view) => keptProfileTexts.has(view.text)).map((view) => view.id));
  const profilesBlock = profilesBlockOf(wholeIds);
  const staleRelationships = profileViews.filter((view) => wholeIds.has(view.id) && view.whole.relationshipStale).length;
  const rewriteIds = profileViews.filter((view) => wholeIds.has(view.id) && view.whole.relationshipStale?.cause === 'rewrite').map((view) => view.id);
  const shownNotes = notesBlocks(messages.slice(0, shown));

  const keptRosterTexts = new Set(kept.roster);
  const keptRoster = rosterEntries.filter((entry) => keptRosterTexts.has(entry.text));
  const rosterBlock = keptRoster.length > 0 ? block('known_members', `{${keptRoster.map((entry) => entry.text).join(',')}}`) : '';

  const keptRecent = recentItems.slice(recentItems.length - kept.recent.length);
  const recentBlock = keptRecent.length > 0 ? block('recent_notes', `[${keptRecent.map((item) => item.text).join(',')}]`) : '';

  const keptTranscriptItems = transcriptItems.slice(0, shown);
  const newMessagesBlock = block('new_messages', renderTranscript(keptTranscriptItems, timezone, labels));

  const user = [...fixedBlocksOf(profilesBlock, shownNotes), rosterBlock, recentBlock, newMessagesBlock].filter(Boolean).join('\n\n');

  return {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    // Only what the model saw is consumed; the lines the cap left out are not lost unseen, they
    // lead the next batch.
    consumed: shown,
    shown,
    deferred: messages.length - shown,
    rosterIds: keptRoster.map((entry) => entry.id),
    // How many the roster offered and what the sent ones cost: whether `deferred` grew because
    // of the roster, and how often the roster itself was cut.
    rosterCandidates: rosterEntries.length,
    rosterTokens: stats.roster?.used ?? 0,
    // How many profiles went whole and how many compact, and what the block cost.
    profilesWhole: wholeIds.size,
    profilesCompact: profileViews.length - wholeIds.size,
    profilesTokens: cost(profilesBlock),
    staleRelationships,
    relationshipRewrites: rewriteIds.length,
    rewriteIds,
    recentShown: keptRecent.length,
    recentIds: keptRecent.map((item) => item.id),
    staleNotes: shownNotes.staleNotes,
  };
}

/**
 * How many of `items` lead `kept` in the same order: the contiguous prefix a fit kept. With
 * budget.js's `keep: 'oldest'` that is every kept item; a fit that skips an item that does not fit
 * and goes on (`keep: 'first'`) may keep later ones, which are not counted here. A later item equal to
 * a skipped one is skipped too (same price, less room), so comparing texts never counts past the
 * first gap.
 * @param {string[]} items
 * @param {string[]} kept
 * @returns {number}
 */
function leadingRun(items, kept) {
  let n = 0;
  while (n < kept.length && n < items.length && kept[n] === items[n]) n += 1;
  return n;
}

/** How many characters (code points) of `text`, trimmed, `kept` left out; 0 when nothing was. */
function lostChars(text, kept) {
  if (typeof text !== 'string') return 0;
  return Math.max(0, [...text.trim()].length - [...(typeof kept === 'string' ? kept : '')].length);
}

/**
 * `clampText(text, limit)`, and a cut told to `limits` (src/llm/limits.js#createLimits, may be
 * null) as a `clamp` of `field` with the characters lost: a stored text is never cut silently.
 * @returns {string}
 */
function clampReported(text, limit, tolerance, limits, field) {
  const kept = clampText(text, limit, { tolerance });
  const lost = lostChars(text, kept);
  if (lost > 0) limits?.add({ kind: 'clamp', where: field, lost });
  return kept;
}

/**
 * A prose verdict (src/memory/prose.js#acceptProse) told to `limits` (may be null): a rewrite
 * refused over its limit as an `over-limit` of `field` (`lost`: the characters over it), a first
 * write cut to its limit as a `clamp` (`lost`: the characters cut).
 */
function reportProse(limits, field, verdict, next, limit) {
  if (!limits || typeof next !== 'string') return;
  if (verdict.outcome === 'over') limits.add({ kind: 'over-limit', where: field, lost: Math.max(0, [...next.trim()].length - Number(limit)) });
  else if (verdict.outcome === 'first') {
    const lost = lostChars(next, verdict.text);
    if (lost > 0) limits.add({ kind: 'clamp', where: field, lost });
  }
}

/**
 * An analyzer-written list (the guild's `injokes`, a single-stage `self`) as it is stored: each
 * string `clampText`-ed to `maxChars`, non-strings and results left empty by clamping (e.g. a lone
 * token dropped whole) filtered out. Past `maxItems`, the items new against `stored` (compared by
 * src/memory/interests.js#normalizeTopic) are kept first, then the carried ones fill the cap in the
 * order returned; the ones that come last leave, and the returned order is kept. So a new item the
 * model appends after the full list it carries forward enters, instead of being cut every time.
 * @param {unknown[]} value  The answer's list, already tokenized.
 * @param {number} maxChars
 * @param {number} maxItems  Not a finite number -> no cap.
 * @param {number} [tolerance]  `memory.clampTolerance`.
 * @param {unknown} [stored]  The list stored now (its non-strings ignored).
 * @param {{ limits?: { add: Function }|null, field?: string }} [report]  Where an item cut by the
 *   clamp is told (`clampReported`).
 * @returns {string[]}
 */
function clampStringArray(value, maxChars, maxItems, tolerance, stored, { limits = null, field = null } = {}) {
  const cleaned = value.map((item) => (typeof item === 'string' ? clampReported(item, maxChars, tolerance, limits, field) : '')).filter(Boolean);
  const cap = Number.isFinite(maxItems) ? Math.max(0, Math.floor(maxItems)) : Infinity;
  if (cleaned.length <= cap) return cleaned;
  const storedKeys = new Set((Array.isArray(stored) ? stored : []).filter((item) => typeof item === 'string').map(normalizeTopic));
  const isNew = cleaned.map((item) => !storedKeys.has(normalizeTopic(item)));
  let newRoom = Math.min(cap, isNew.filter(Boolean).length);
  let carriedRoom = cap - newRoom;
  return cleaned.filter((_, i) => {
    if (isNew[i]) {
      if (newRoom === 0) return false;
      newRoom -= 1;
      return true;
    }
    if (carriedRoom === 0) return false;
    carriedRoom -= 1;
    return true;
  });
}

/**
 * The analyzer's `guild.learned` ops (`{ add, seen, remove }`), validated for
 * src/memory/store.js#applyLearnedOps. `add` items are a bare string or
 * `{ text, from?, sure? }`: `text` is tokenized and clamped to `learnedChars`
 * (an empty result drops the item); `from` is kept only when it is exactly one
 * `<@id>` token or one `name (id:123)` reference whose id `isKnownId` accepts,
 * normalised to the token (src/memory/mentions.js#teacherToken, the rule both
 * analyzer modes share) -- anything else is dropped, never guessed from the
 * text or the batch; `sure: false` travels on. `seen`/`remove` keep positive
 * integer ids only. Untrusted input: any shape -> `null` or a valid subset,
 * never a throw.
 * @param {unknown} raw
 * @param {{ tokenize: (text: string) => string, isKnownId: (id: string) => boolean,
 *   learnedChars: number, clampTolerance?: number, limits?: { add: Function }|null }} deps
 *   `limits`: where a text cut by the clamp is told (`clampReported`, field `guild.learned`).
 * @returns {{ ops: { add: object[], seen: number[], remove: number[] }, added: number }|null}
 */
function parseLearnedOps(raw, { tokenize, isKnownId, learnedChars, clampTolerance, limits = null }) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;

  const add = [];
  for (const item of Array.isArray(raw.add) ? raw.add : []) {
    const isObj = item && typeof item === 'object' && !Array.isArray(item);
    const rawText = isObj ? item.text : item;
    if (typeof rawText !== 'string') continue;
    const text = clampReported(tokenize(rawText), learnedChars, clampTolerance, limits, 'guild.learned');
    if (!text) continue;
    const op = { text };
    const from = isObj ? teacherToken(item.from, isKnownId) : undefined;
    if (from) op.from = from;
    if (isObj && item.sure === false) op.sure = false;
    add.push(op);
  }
  const ids = (value) => (Array.isArray(value) ? value.filter((id) => Number.isInteger(id) && id >= 1) : []);
  const seen = ids(raw.seen);
  const remove = ids(raw.remove);

  if (add.length === 0 && seen.length === 0 && remove.length === 0) return null;
  return { ops: { add, seen, remove }, added: add.length };
}

/**
 * Per-user sighting time for one analyzer batch, for dating `interests`/
 * `details` by the MESSAGE, not the wall clock the analyzer happens to run
 * at (see docs/prompt-contract.md, "Dates come from the messages").
 * `seenAtByUser` holds, for each non-self author, the timestamp of THAT
 * user's newest message in the batch; `seenAt` is the batch's own newest
 * message overall, the fallback used when a particular user is somehow
 * missing from the map. Used by the live analyzer.
 * @param {object[]} messages  Slim buffered messages (any order); `ts`/`authorId`/`self` read.
 * @returns {{ seenAtByUser: Map<string, number>, seenAt: number }}
 */
export function computeSeenAt(messages) {
  const seenAtByUser = new Map();
  let batchNewest = 0;
  for (const m of messages ?? []) {
    if (!Number.isFinite(m?.ts)) continue;
    batchNewest = Math.max(batchNewest, m.ts);
    if (m.self) continue; // the persona's own line is never a profile
    const id = String(m.authorId);
    const current = seenAtByUser.get(id);
    if (current === undefined || m.ts > current) seenAtByUser.set(id, m.ts);
  }
  return { seenAtByUser, seenAt: batchNewest || Date.now() };
}

/**
 * Author id -> the nick THIS batch's transcript used for them (their latest
 * message wins when it changed mid-batch) -- feeds `applyMemoryUpdate`'s
 * name-aware `Name (id:...)` normalization (see src/memory/mentions.js#toTokens)
 * so a member is recognised even before their stored profile has caught up
 * to a brand-new display name.
 * @param {object[]} messages  Slim buffered messages (oldest first); `authorId`/`authorName`/`self` read.
 * @returns {Map<string, string>}
 */
export function batchAuthorNamesMap(messages) {
  const names = new Map();
  for (const m of messages ?? []) {
    if (m?.self || !m?.authorName) continue;
    names.set(String(m.authorId), m.authorName);
  }
  return names;
}

/** `value` (an answer's `HH:MM`, or a `formatClock` reading) as four digits for comparison, a
 * missing leading zero tolerated (`9:05` = `09:05`); '' when it is no clock. */
function clockKey(value) {
  if (typeof value !== 'string') return '';
  const digits = value.replace(/\D/g, '');
  if (digits.length === 3) return `0${digits}`;
  return digits.length === 4 ? digits : '';
}

// A channel reference that carries its id: a `<#id>` mention, or the transcript heading's
// `#name (id:...)` form (src/format.js), whose id decides.
const CHANNEL_MENTION_RE = /^<#([^>]+)>$/;
const HEADING_ID_RE = /\(id:([^)]+)\)$/;

/**
 * The batch channel an answer's `channel` names, read as a reference: a known id as it stands, a
 * `<#id>` mention or the heading's `#name (id:...)` form by its id alone, else a channel name with
 * or without its leading `#`, compared case-insensitively with the names `dated` carries.
 * `undefined` when no channel is given (missing, null or blank); null when one is given but names
 * no single batch channel (an unknown id or name, a name two batch channels share, a value that
 * is no reference).
 * @param {unknown} channel
 * @param {Set<string>} known  The batch's channel ids.
 * @param {object[]} dated  The batch's messages in `known` channels (`channelId`, `channelName` read).
 * @returns {string|null|undefined}
 */
function channelOfRef(channel, known, dated) {
  if (channel === undefined || channel === null) return undefined;
  if (typeof channel !== 'string' && typeof channel !== 'number') return null;
  const ref = String(channel).trim();
  if (ref === '') return undefined;
  if (known.has(ref)) return ref;
  const withId = CHANNEL_MENTION_RE.exec(ref) ?? HEADING_ID_RE.exec(ref);
  if (withId) {
    const id = withId[1].trim();
    return known.has(id) ? id : null;
  }
  const bare = ref.replace(/^#/, '');
  if (known.has(bare)) return bare;
  const name = bare.toLowerCase();
  const matches = new Set(dated.filter((m) => typeof m.channelName === 'string' && m.channelName.toLowerCase() === name).map((m) => String(m.channelId)));
  return matches.size === 1 ? [...matches][0] : null;
}

/**
 * Where and when a recent line the analyzer wrote happened, from the batch it was written from
 * (its moment and source channel: the channel decides who may later be shown the line). The
 * messages considered are those of `channelIds` (the batch's channels) with a finite `ts`.
 * - The source channel is the one `channel` names (`channelOfRef`: an id, `<#id>`, `#name`, a
 *   name). A `channel` that names no single batch channel gives no channel: the time never
 *   stands in for it. With none given, only a batch of one channel says where the line comes
 *   from; in a batch of several there is no channel. No channel is `channelId: null`, at the
 *   batch's newest message (or `now`): the store takes no line without one.
 * - The moment is the source channel's first message whose clock (`formatClock` in `timezone` /
 *   `locale`, as the transcript wrote it) equals `time`, else its newest message, else `now`.
 *   When `time` matches none of that channel's messages but matches a message of another batch
 *   channel, the two disagree and either may be wrong: no channel, so a line is never filed
 *   under a channel whose audience may differ from its true source's.
 * Pure; never throws on an untrusted `time` / `channel`.
 * @param {object[]} messages  The batch (slim messages: `ts`, `channelId`, `channelName` read).
 * @param {{ time?: unknown, channel?: unknown }} ref  The answer's `time` and `channel`.
 * @param {{ timezone: string, locale?: string, channelIds: Set<string>, now: number }} opts
 *   `channelIds` not a Set = no channel is known (every line comes out without one).
 * @returns {{ at: number, channelId: string|null }}
 */
export function resolveMoment(messages, { time, channel } = {}, { timezone, locale, channelIds, now }) {
  const known = channelIds instanceof Set ? channelIds : new Set();
  const dated = (Array.isArray(messages) ? messages : []).filter((m) => Number.isFinite(m?.ts) && known.has(String(m.channelId)));
  const wanted = clockKey(time);
  const atTime = (m) => wanted !== '' && clockKey(formatClock(m.ts, timezone, locale)) === wanted;
  const newest = (list) => list.reduce((best, m) => (best === null || m.ts > best.ts ? m : best), null);
  const noChannel = { at: newest(dated)?.ts ?? now, channelId: null };

  let source = channelOfRef(channel, known, dated);
  if (source === undefined) {
    const batchChannels = new Set(dated.map((m) => String(m.channelId)));
    source = batchChannels.size === 1 ? [...batchChannels][0] : null;
  }
  if (source === null) return noChannel;
  const own = dated.filter((m) => String(m.channelId) === source);
  const ownHit = own.find(atTime);
  if (ownHit) return { at: ownHit.ts, channelId: source };
  // The minute exists only in other channels: following either the channel or the minute could
  // file a line from a restricted channel under a public one.
  if (dated.some(atTime)) return noChannel;
  return { at: newest(own)?.ts ?? now, channelId: source };
}

/**
 * The token helpers every analyzer answer goes through before it is stored.
 * A member is written as `<@id>` in every free-text field the analyzer
 * returns (see docs/prompt-contract.md, "Members are referred to by id, never
 * by nickname"); `tokenize` normalizes the fallback shape the model sometimes
 * writes instead, `Name (id:123...)`, into the token -- but only for an id
 * this guild actually knows (one of `knownUserIds`, or an existing stored
 * profile), an unrecognised id is left exactly as written.
 * @param {object} store
 * @param {string} guildId
 * @param {Set<string>} knownUserIds
 * @param {Map<string, string>} [batchAuthorNames]  See `batchAuthorNamesMap`.
 */
function makeTokenizers(store, guildId, knownUserIds, batchAuthorNames) {
  const isKnownId = (id) => {
    const key = String(id);
    return knownUserIds.has(key) || store.getUser(guildId, key) != null;
  };
  // The known names for one id, stored profile names first, the batch's own
  // nick for them appended -- see toTokens' name-aware matching, which needs
  // the FULL name (however many words) to convert e.g. "Al Sus (id:...)"
  // correctly instead of guessing a word count.
  const namesOf = (id) => {
    const key = String(id);
    const stored = store.getUser(guildId, key)?.names ?? [];
    const batchNick = batchAuthorNames?.get?.(key);
    return batchNick ? [...stored, batchNick] : stored;
  };
  const tokenize = (text) => (typeof text === 'string' ? toTokens(text, isKnownId, namesOf) : text);
  const tokenizeArray = (values) => (Array.isArray(values) ? values.map(tokenize) : values);
  /** `ops.add`/`ops.update` items' `note` field, tokenized in place. */
  const tokenizeNoted = (items) =>
    Array.isArray(items)
      ? items.map((item) => (item && typeof item === 'object' && !Array.isArray(item) ? { ...item, note: tokenize(item.note) } : item))
      : items;
  /** A `details.add` entry, a bare string or `{ text, sure? }`, `text` tokenized. */
  const tokenizeDetail = (item) => {
    if (typeof item === 'string') return tokenize(item);
    if (item && typeof item === 'object' && !Array.isArray(item)) return { ...item, text: tokenize(item.text) };
    return item;
  };
  /** `raw.interests`/`raw.details` (ops objects, the only shape accepted) into store ops, tokenized. */
  const tokenizeItemOps = (raw, ops) => {
    if (raw.interests && typeof raw.interests === 'object' && !Array.isArray(raw.interests)) {
      ops.interests = {
        ...raw.interests,
        add: tokenizeNoted(raw.interests.add),
        update: tokenizeNoted(raw.interests.update),
      };
    }
    if (raw.details && typeof raw.details === 'object' && !Array.isArray(raw.details)) {
      ops.details = { ...raw.details, add: Array.isArray(raw.details.add) ? raw.details.add.map(tokenizeDetail) : raw.details.add };
    }
  };
  /** `raw.episodes` with `what`/`feeling` tokenized; `quote` is the person's own words verbatim, never. */
  const tokenizeEpisodes = (episodes) =>
    episodes.map((ep) => (ep && typeof ep === 'object' && !Array.isArray(ep) ? { ...ep, what: tokenize(ep.what), feeling: tokenize(ep.feeling) } : ep));
  return { isKnownId, tokenize, tokenizeArray, tokenizeNoted, tokenizeDetail, tokenizeItemOps, tokenizeEpisodes };
}

/** `applyProfileOps` / `applyPrivateOps` options from `config.memory`. */
function profileOpsOptions(cfg, nowMs, seenAt) {
  return {
    fieldChars: cfg.fieldChars,
    maxInterests: cfg.maxInterests,
    maxInterestsStored: cfg.maxInterestsStored,
    topicChars: cfg.interestTopicChars,
    noteChars: cfg.interestNoteChars,
    interestHalfLifeDays: cfg.interestHalfLifeDays,
    maxDetails: cfg.maxDetails,
    maxDetailsStored: cfg.maxDetailsStored,
    detailHalfLifeDays: cfg.detailHalfLifeDays,
    maxAliases: cfg.maxAliases,
    maxAliasesStored: cfg.maxAliasesStored,
    aliasHalfLifeDays: cfg.aliasHalfLifeDays,
    maxClosedStored: cfg.maxClosedStored,
    confirmGapHours: cfg.confirmGapHours,
    clampTolerance: cfg.clampTolerance,
    now: nowMs,
    seenAt,
  };
}

/** `store.applyLearnedOps` options from `config.memory`, the lesson dated `seenAt`: every writer
 * of a lesson here (the single-stage apply, the voice queue's degraded path) uses the same limits. */
function learnedOpsOptions(cfg, seenAt) {
  return {
    maxLearned: cfg.maxLearned ?? MEMORY_LIMIT_DEFAULTS.maxLearned,
    maxLearnedStored: cfg.maxLearnedStored ?? MEMORY_LIMIT_DEFAULTS.maxLearnedStored,
    learnedChars: cfg.learnedChars ?? MEMORY_LIMIT_DEFAULTS.learnedChars,
    learnedHalfLifeDays: cfg.learnedHalfLifeDays ?? MEMORY_LIMIT_DEFAULTS.learnedHalfLifeDays,
    confirmGapHours: cfg.confirmGapHours,
    clampTolerance: cfg.clampTolerance,
    seenAt,
  };
}

/** `store.applySelfOps` options from `config.memory`: `maxSelfFacts` validated (the store refuses
 * anything but a number of at least 0; config.json's 20 otherwise), stamped `nowMs`. */
function selfOpsOptions(cfg, nowMs) {
  const max = cfg.maxSelfFacts;
  return {
    maxSelfFacts: typeof max === 'number' && Number.isFinite(max) && max >= 0 ? max : MEMORY_LIMIT_DEFAULTS.maxSelfFacts,
    clampTolerance: cfg.clampTolerance,
    now: nowMs,
  };
}

// The `(id:...)` marker of a member reference `toTokens` left as written (an id it did not know).
const ID_MARKER_RE = new RegExp(`\\(id:${ID_DIGITS}\\)`);

/**
 * The lowercased display names a new self claim must not contain: every `names` entry of every
 * stored profile of the guild (`store.listUserProfiles`, when the store has it), of the batch's
 * authors (`getUser`, so a store without the listing still checks them) and the nicks the batch's
 * transcript used (`batchAuthorNames`). Aliases are left out: too many of them are common words.
 * A profile listing that cannot be read leaves the batch with its authors' names, never fails it.
 */
function memberNamesOf(store, guildId, knownUserIds, batchAuthorNames) {
  const profiles = [];
  if (typeof store.listUserProfiles === 'function') {
    try {
      profiles.push(...(store.listUserProfiles(guildId) ?? []));
    } catch (err) {
      log.warn('memory: member names left out', { guildId, reason: 'store-error', error: errorNameOf(err) });
    }
  }
  for (const id of knownUserIds ?? []) profiles.push(store.getUser(guildId, String(id)));
  const names = new Set();
  const take = (name) => {
    if (typeof name === 'string' && name.trim()) names.add(name.trim().toLowerCase());
  };
  for (const profile of profiles) for (const name of Array.isArray(profile?.names) ? profile.names : []) take(name);
  for (const nick of batchAuthorNames instanceof Map ? batchAuthorNames.values() : []) take(nick);
  return [...names];
}

/**
 * A test telling a self claim that is about a member: a `<@id>` token, an `(id:...)` marker, or
 * a member's display name (`memberNamesOf`) as a whole word, case-insensitive. What the persona
 * feels about a member lives in that member's attitude and relationship, never among the
 * persona's standing facts, where every later reply would read it back. The names are read on the
 * first claim that needs them.
 * @returns {(text: unknown) => boolean}
 */
function memberClaimTest(store, guildId, knownUserIds, batchAuthorNames) {
  let names = null;
  return (text) => {
    if (typeof text !== 'string' || !text) return false;
    if (tokenIds(text).length > 0 || ID_MARKER_RE.test(text)) return true;
    names ??= memberNamesOf(store, guildId, knownUserIds, batchAuthorNames);
    const lower = text.toLowerCase();
    return names.some((name) => occursAsWholeWord(lower, name));
  };
}

/** One log line per update for the self claims about a member `memberClaimTest` dropped; counts only. */
function logSelfDropped(guildId, count) {
  if (count > 0) log.info('memory: self claim about a member dropped', { guildId, count });
}

/** `adjustAffinity` / `adjustPrivateAffinity` options from the `relationships` argument. */
function affinityOptions(relationships, cfg) {
  return {
    // The model's verdict is never applied unclamped, even if the config block is missing.
    maxDelta: relationships.maxDeltaPerUpdate ?? MEMORY_LIMIT_DEFAULTS.maxDeltaPerUpdate,
    historySize: relationships.historySize ?? MEMORY_LIMIT_DEFAULTS.historySize,
    now: relationships.now,
    clampTolerance: cfg.clampTolerance,
    // relationships.damping: a missing key counts as on, like features.*.
    damping: relationships.damping !== false,
    // relationships.dampingPower: garbage/absent falls back to 1 inside applyDelta itself.
    dampingPower: relationships.dampingPower,
  };
}

/** The affinity score after this batch's own `raw.affinity` delta, without storing anything: the
 * same `applyDelta` call `adjustAffinity` / `adjustPrivateAffinity` make, or the stored score when
 * relationships are off or the batch carries no delta. Missing/malformed = 0. */
function scoreAfterBatch(affinity, raw, relationships, cfg) {
  if (relationships?.enabled && isPlainObject(raw?.affinity)) {
    return applyDelta(affinity, raw.affinity.delta, '', affinityOptions(relationships, cfg)).score;
  }
  return Number.isFinite(affinity?.score) ? affinity.score : 0;
}

/** `addEpisodes` / `addPrivateEpisodes` options from the `episodes` argument and `cfg`
 * (`config.memory`): `keepNewest` = `memory.keepNewestEpisodes`, 5 (config.json's value) when the
 * key is missing, 0 = eviction by weight then age alone (src/memory/episodes.js#mergeEpisodes).
 * The guild apply, the private apply and the warmup's person run (whose `cfg` spreads
 * `config.memory`) all merge through here, and none of them loses a moment on arrival. The
 * warmup stamps its moments with the member's last sampled message, not the clock, so once
 * stored they may rank below later stream moments (see mergeEpisodes). */
function episodeOptions(episodes, cfg) {
  return {
    maxEpisodes: episodes.maxEpisodes,
    maxNew: episodes.maxNew,
    now: episodes.now,
    clampTolerance: cfg.clampTolerance,
    keepNewest: cfg.keepNewestEpisodes ?? 5,
  };
}

// An alias that names a member by id instead of being a nickname: a `<@id>` token or the
// `Name (id:...)` reference form (see src/memory/mentions.js).
const ALIAS_REF_RE = /<@|\(id:/;

/** `name` lower-cased, with spaces and punctuation gone (letters, their marks and digits stay):
 * how a proposed alias is compared with the member's own display names, so `nick 42` matches
 * the display name `Nick-42%`. */
function looseNameKey(name) {
  return String(name ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}]/gu, '');
}

/** The identity the store keeps `name` under as an alias, for comparison only: clamped the
 * store's own way (worked out through applyAliasOps, as `/nep alias add` does, so the clamp is
 * never copied here) and case-insensitive. '' for a name the store would not take. */
function aliasIdentity(name) {
  return typeof name === 'string' ? normalizeTopic(applyAliasOps([], { add: [name] }, [])[0]?.name ?? '') : '';
}

/**
 * One member's `users.<id>.aliases` answer as store ops, guarded for every member: an alias
 * that is not a string, holds a `<@` token or an `(id:` marker is dropped, and so is one equal
 * to any of the member's stored display names once case, spaces and punctuation are ignored.
 * The ops object (`{ add, remove }`) passes on with both of its creating lists (`add`,
 * `update`) filtered. An `add` item may also be `{ name, supersedes?, validFrom?, conflict? }` (see
 * docs/prompt-contract.md, "Validity"), guarded by its `name`. A bare list -- the shape of the input view -- is read as an add of the
 * names NOT stored yet (compared by the identity the store keeps, clamp included): echoing the
 * stored list back is never a sighting. Untrusted input: any shape -> a result, never a throw.
 * @param {unknown} raw
 * @param {object|null} profile  The member's stored profile (`names`, `aliases` read).
 * @returns {{ ops: object|null, dropped: number }}  `ops` for store.applyProfileOps, null when
 *   there is nothing to hand over; `dropped`: the proposed items the guards held back (in a bare
 *   list also a name already stored or listed twice).
 */
function guardedAliasOps(raw, profile) {
  const ownNames = new Set((Array.isArray(profile?.names) ? profile.names : []).map(looseNameKey).filter(Boolean));
  // An add may also be an object whose `name` is one (it may carry supersedes / validFrom / conflict).
  const acceptable = (raw, key = 'add') => {
    const name = key === 'add' && isPlainObject(raw) ? raw.name : raw;
    return typeof name === 'string' && !ALIAS_REF_RE.test(name) && !ownNames.has(looseNameKey(name));
  };
  if (Array.isArray(raw)) {
    const known = new Set((Array.isArray(profile?.aliases) ? profile.aliases : []).map((item) => aliasIdentity(item?.name)));
    const add = [];
    for (const name of raw) {
      const key = acceptable(name) ? aliasIdentity(name) : '';
      if (!key || known.has(key)) continue;
      known.add(key);
      add.push(name);
    }
    return { ops: add.length > 0 ? { add } : null, dropped: raw.length - add.length };
  }
  if (!isPlainObject(raw)) return { ops: null, dropped: 0 };
  const ops = { ...raw };
  let dropped = 0;
  for (const key of ['add', 'update']) {
    if (!Array.isArray(ops[key])) continue;
    const kept = ops[key].filter((raw) => acceptable(raw, key));
    dropped += ops[key].length - kept.length;
    ops[key] = kept;
  }
  return { ops, dropped };
}

/**
 * One member's `users.<id>.realName` answer as the store op (src/memory/store.js#applyProfileOps):
 * a string, or `{ name, supersedes?, validFrom? }` (`supersedes` / `validFrom` kept only as
 * strings), the name trimmed and non-empty and holding no `<@` token or `(id:` marker. Anything
 * else -- missing, empty, another shape -- is null: nothing changes.
 * @param {unknown} raw
 * @returns {string|{ name: string, supersedes?: string, validFrom?: string }|null}
 */
function guardedRealName(raw) {
  const name = isPlainObject(raw) ? raw.name : raw;
  if (typeof name !== 'string' || !name.trim() || ALIAS_REF_RE.test(name)) return null;
  if (!isPlainObject(raw)) return name.trim();
  const op = { name: name.trim() };
  if (typeof raw.supersedes === 'string' && raw.supersedes.trim()) op.supersedes = raw.supersedes.trim();
  if (typeof raw.validFrom === 'string' && raw.validFrom.trim()) op.validFrom = raw.validFrom.trim();
  return op;
}

/** The strings of a list the analyzer wrote (`self`, `learned.add`, a stage A brief list): a
 * bare string or an object's `text`; anything else is skipped. */
function listTexts(list) {
  return (Array.isArray(list) ? list : []).map((item) => (isPlainObject(item) ? item.text : item)).filter((text) => typeof text === 'string');
}

/** A `recent.remove` entry as a stored line id: a positive integer, or a string of digits (once
 * trimmed) naming one; else null. The recent store's own rule (src/memory/recent.js#lineIdOf,
 * not exported), copied exactly so an entry that is no id is counted here instead of being
 * ignored by the store: keep the two in step. */
function recentLineIdOf(raw) {
  const n = typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : raw;
  return Number.isInteger(n) && n >= 1 ? n : null;
}

/**
 * An analyzer answer's `recent` field as its two lists: a bare list is read as `add`, an object as
 * itself (a key that is not a list as an empty one), anything else as nothing. The one reading of
 * the field's shape, for the guild apply and the private drop count alike. Untrusted, never a throw.
 * @param {unknown} raw
 * @returns {{ add: unknown[], remove: unknown[] }}
 */
function recentFieldOf(raw) {
  const field = Array.isArray(raw) ? { add: raw } : isPlainObject(raw) ? raw : {};
  return { add: Array.isArray(field.add) ? field.add : [], remove: Array.isArray(field.remove) ? field.remove : [] };
}

/**
 * One guild update's `recent` field (`recentFieldOf`), applied through the recent store
 * (src/memory/store.js#applyRecentOps, src/memory/recent.js#mergeRecent), always as one write so
 * the lines past `recent.hours` expire at each batch. Untrusted, never a throw. An add that is not
 * an object with a non-blank string `text` is skipped (`recentInvalid`); the rest are tokenized,
 * and one whose folded text (src/memory/recent.js#foldText) equals a long-term entry of the same
 * update (`longTerm`: what this update proposed to a long-term store, whether or not the store
 * keeps it; R-7) is dropped and counted in `recentOverlap` before the store's cap; the others are
 * dated and placed by `resolveMoment` over `recent.messages`. The store clamps them, refuses one
 * with no channel, one already past the window, one equal to a live line and those over
 * `recent.maxNew`, and evicts past `recent.maxStored`. A remove takes only a line id
 * (`recentLineIdOf`) the request showed (`recent.shownIds`, when given; any other entry, one that is
 * no id included, counts in `recentUnshown`). Nothing goes anywhere but the recent store.
 * @returns {{ recentAdded: number, recentOverlap: number, recentRemoved: number, recentExpired: number,
 *   recentEvicted: number, recentDropped: number, recentInvalid: number, recentNoChannel: number,
 *   recentStale: number, recentDuplicate: number, recentOverCap: number, recentUnshown: number }}
 *   Every add of the field ends in exactly one of `recentAdded`, `recentOverlap`, `recentInvalid`
 *   (here or the store's: a text that clamps to nothing), `recentNoChannel`, `recentStale`,
 *   `recentDuplicate` and `recentOverCap` (a new line the storage cap takes at once included).
 *   `recentRemoved` counts stored lines a remove took, `recentUnshown` remove entries held back
 *   because they name no line the request showed (an entry that is no id included); a repeated
 *   shown id, or a shown one no line holds any more, is not counted.
 *   `recentExpired` / `recentEvicted`: stored lines gone past `recent.hours` / the storage cap.
 *   `recentDropped`: what the code threw away, the sum of the five drop reasons and `recentUnshown`.
 */
function applyRecentField(store, guildId, raw, { recent, tokenize, knownChannelIds, longTerm }) {
  const field = recentFieldOf(raw);
  let recentOverlap = 0;
  let invalid = 0;
  const adds = [];
  for (const item of field.add) {
    if (!isPlainObject(item) || typeof item.text !== 'string' || item.text.trim() === '') {
      invalid += 1;
      continue;
    }
    const text = tokenize(item.text);
    if (longTerm.has(foldText(text))) {
      recentOverlap += 1;
      continue;
    }
    const { at, channelId } = resolveMoment(
      recent.messages,
      { time: item.time, channel: item.channel },
      { timezone: recent.timezone, locale: recent.locale, channelIds: knownChannelIds, now: recent.now },
    );
    adds.push({ text, at, channelId, weight: item.weight });
  }
  // Each entry is read as a line id first (`'2'` names line 2; `true`, `'1e0'` name none), then
  // checked against the lines the request showed.
  const shown = recent.shownIds instanceof Set ? recent.shownIds : null;
  const removeIds = field.remove.map(recentLineIdOf).filter((id) => id !== null && (shown === null || shown.has(id)));
  const unshown = field.remove.length - removeIds.length;
  const counts = store.applyRecentOps(guildId, adds, {
    now: recent.now,
    hours: recent.hours,
    maxStored: recent.maxStored,
    maxNew: recent.maxNew,
    chars: recent.chars,
    clampTolerance: recent.clampTolerance,
    removeIds,
  });
  return {
    recentAdded: counts.added,
    recentOverlap,
    recentRemoved: counts.removed,
    recentExpired: counts.expired,
    recentEvicted: counts.evicted,
    recentDropped: invalid + unshown + counts.dropped,
    recentInvalid: invalid + counts.invalid,
    recentNoChannel: counts.noChannel,
    recentStale: counts.stale,
    recentDuplicate: counts.duplicate,
    recentOverCap: counts.overCap,
    recentUnshown: unshown,
  };
}

/**
 * Which flagged notes earned their `notesCheckedAt` stamp this batch. `confirmed` counts;
 * `updated` counts only when the target's text really changed (else `identical`); a flagged
 * target with no review is `missing`; a review for an unflagged target is `unflagged`. Pure.
 * @param {{ flagged?: { channels?: string[], guild?: boolean }, reviews?: object, changedChannels?: string[], guildChanged?: boolean }} input
 *   `flagged`: buildMemoryRequest's `staleNotes`; `reviews`: applyMemoryUpdate's `noteReviews`;
 *   `changedChannels` / `guildChanged`: what really changed in this batch.
 * @returns {{ stamp: { channels: string[], guild: boolean }, counts: { updated: number, confirmed: number,
 *   insufficient: number, missing: number, identical: number, unflagged: number } }}
 */
export function reconcileNoteReviews({ flagged, reviews, changedChannels, guildChanged }) {
  const counts = { updated: 0, confirmed: 0, insufficient: 0, missing: 0, identical: 0, unflagged: 0 };
  const stamp = { channels: [], guild: false };
  const changed = new Set(changedChannels ?? []);
  const judge = (target, didChange) => {
    const status = reviews?.[target];
    if (status === undefined) { counts.missing += 1; return false; }
    if (status === 'confirmed') { counts.confirmed += 1; return true; }
    if (status === 'insufficient_evidence') { counts.insufficient += 1; return false; }
    if (didChange) { counts.updated += 1; return true; }
    counts.identical += 1;
    return false;
  };
  for (const id of flagged?.channels ?? []) if (judge(id, changed.has(id))) stamp.channels.push(id);
  if (flagged?.guild) stamp.guild = judge('guild', guildChanged === true);
  const flaggedSet = new Set([...(flagged?.channels ?? []), ...(flagged?.guild ? ['guild'] : [])]);
  for (const target of Object.keys(reviews ?? {})) if (!flaggedSet.has(target)) counts.unflagged += 1;
  return { stamp, counts };
}

/**
 * Validate and store the model's memory-update JSON. Never throws on garbage
 * input, never drops a field that was not part of the update. A user id is
 * taken in full only when it is in `knownUserIds` (the batch's authors); one
 * in `options.aliasOnlyIds` instead gets its `aliases` and nothing else, and
 * only when it already has a stored profile. Every other id is dropped.
 *
 * @param {object} store
 * @param {string} guildId
 * @param {unknown} update         Parsed model output; treated as untrusted.
 * @param {object} cfg             `config.memory`.
 * @param {Set<string>} knownUserIds
 * @param {object} [options]  Everything else, each optional:
 * @param {Set<string>} [options.knownChannelIds]  Channel ids present in the batch; a channel outside
 *   this set is rejected, mirroring `knownUserIds`. Omitted -> no channel is accepted.
 * @param {Set<string>} [options.aliasOnlyIds]  The `<known_members>` roster ids the request carried
 *   (buildMemoryRequest's `rosterIds`): members who wrote nothing in the batch. For such an id
 *   (not an author) with a stored profile, ONLY `aliases` is applied (dated like any member with
 *   no line in the batch: `timing.seenAt`); every other key is dropped and counted in
 *   `droppedFields`; a profile is never created for it. Omitted (the warmup and the portrait
 *   refresh) -> only `knownUserIds` are written, as before.
 * @param {{ enabled: boolean, maxDeltaPerUpdate: number, historySize: number, damping?: boolean, dampingPower?: number, now?: number }} [options.relationships]
 *   Only when `enabled`, `raw.affinity` (a `{ delta, reason }` change) is folded into the
 *   stored score via `store.adjustAffinity`. Absent/disabled -> affinity is ignored entirely.
 *   `damping` missing counts as on, `dampingPower` missing/garbage falls back to `1` (see
 *   src/memory/affinity.js#applyDelta).
 * @param {{ enabled: boolean, maxEpisodes: number, maxNew: number, now?: number }} [options.episodes]
 *   Only when `enabled`, each user's `raw.episodes` (a new-moments array) is folded in via
 *   `store.addEpisodes` (src/memory/episodes.js#mergeEpisodes), sparing the newest
 *   `cfg.keepNewestEpisodes` (missing = 5) from eviction. Absent/disabled -> ignored entirely.
 * @param {{ enabled: boolean, maxEntries: number, now?: number }} [options.lore]
 *   Only when `enabled`, `update.lore` (the server's lorebook) is folded in via `store.setLore`
 *   (src/memory/lore.js#upsertLore, source: 'analyzer'). Absent/disabled -> ignored entirely.
 * @param {{ seenAtByUser?: Map<string, number>, seenAt?: number }} [options.timing]  From `computeSeenAt`
 *   above; missing/absent falls back to `relationships.now`/`episodes.now`/the wall clock, same
 *   as before this option existed.
 * @param {Map<string, string>} [options.batchAuthorNames]  Author id -> the nick this batch's transcript
 *   used for them (see `batchAuthorNamesMap` below), so the `Name (id:...)` normalization below
 *   recognises a name even for someone whose stored profile has not caught up yet. Omitted ->
 *   only the stored profile's own `names` are known.
 * @param {boolean} [options.portraitFields]  `true` only from the portrait writers of
 *   src/memory/warmup.js: the warmup's person run (`profile.md`) and the portrait refresh (single
 *   stage `profile.md`; in two-stage mode prompts/portrait.md's `style`, its `character` going to
 *   the voice queue). The voice run writes a worded `character` itself, straight through
 *   `store.applyProfileOps` (`runVoiceWrites`), never through here. Omitted or false (every
 *   stream batch) -> an author's `character`/`style` are dropped and each non-blank one is
 *   counted in `portraitDropped`, so a batch can never rewrite a portrait outside the refresh's
 *   counters, daily cap and merge.
 * @param {number} [options.relationshipChars]  The relationship text's limit (`relationships.textChars`,
 *   the `{{relationshipChars}}` the request stated), read by the caller at the moment of use, so it
 *   holds with `features.relationships` off too. Omitted -> `relationships.textChars`; either
 *   validated by src/memory/voice.js#voiceLimits' rule (not a number above 0 -> 600).
 *   A written text is clamped to it and stamped `relationshipScore` (the score after this batch's
 *   delta) and `relationshipWrittenAt` (the batch clock, `relationships.now`, the time this batch's
 *   attitude move is stamped with) -- see src/memory/store.js#applyProfileOps.
 * @param {{ enabled: boolean, now?: number, hours?: number, maxStored?: number, maxNew?: number, chars?: number,
 *   clampTolerance?: number, messages?: object[], timezone?: string, locale?: string, shownIds?: Set<number>,
 *   taken?: string[] }} [options.recent]
 *   `memorySwitches`' `recent` (`features.recent` on; the settings of src/memory/recent.js#recentSettings
 *   and the clock), plus what analyze() adds over the batch: `messages`, `timezone` and `locale`
 *   (where and when each line happened, `resolveMoment`), `shownIds` (the request's `recentIds`: the
 *   only lines a remove may take) and, from stage A, `taken` (the lesson and self briefs the voice
 *   queue gets, long-term entries of this update too). Only when `enabled` (and the store has
 *   `applyRecentOps`) is `update.recent` applied (`applyRecentField`), the lines past `hours`
 *   expiring in the same write, an answer without the field included; an add equal to an episode,
 *   a lesson, a self fact or a lore entry this update proposed to a long-term store (whether or
 *   not the store keeps it, R-7; episodes and self facts only within the store's own per-batch
 *   caps, `episodes.maxNew` and `cfg.maxSelfFacts`) is dropped (`recentOverlap`). Absent (the
 *   warmup, the portrait refresh, `features.recent` off) -> the field is ignored and nothing
 *   expires.
 * @param {string} [options.by]  Who the store's version records name for a replaced prose text
 *   (src/memory/store.js#recordVersion). Omitted -> `'analyzer'`.
 * @param {{ enabled: boolean, kept: number }} [options.versions]  The version history settings the
 *   store writers get: `features.versions` and `memory.versionsKept`, read by the caller at the
 *   moment of use. Omitted -> on, `cfg.versionsKept` (missing = 20, config.json's value).
 * @param {{ add: Function }|null} [options.limits]  A collector (src/llm/limits.js#createLimits)
 *   told every prose rewrite refused over its limit (`over-limit`, the field and the characters
 *   over) and every text cut on its way in (`clamp`: a first prose write, a learned text, an
 *   in-joke, a self fact; the field and the characters cut). Omitted -> nothing is told.
 *
 * Every prose field (a channel's purpose / topics / tone at `cfg.fieldChars`, the server notes'
 * patterns / starters at `cfg.fieldChars * 2`, a relationship at its limit, a portrait writer's
 * character / style at `cfg.fieldChars`, a lore text at `lore.textChars`) goes through
 * src/memory/prose.js#acceptProse against the stored text: a first write is clamped, a rewrite
 * within the limit is written as given, a rewrite over it is left out whole (the stored text
 * stays, a lore entry's keys still change) and counted in `overLimit` / `overLimitFields`.
 * @returns {{ users: number, guild: boolean, self: boolean, affinity: number, relationships: number, channels: number, episodes: number, lore: number,
 *   learned: number, interestsChanged: number, aliasesChanged: number, aliasOnly: number, aliasesDropped: number,
 *   droppedUsers: number, droppedFields: number, portraitDropped: number, portraitRequests: { userId: string, reason: string }[],
 *   selfDropped: number, recentAdded: number, recentOverlap: number, recentRemoved: number, recentExpired: number, recentEvicted: number,
 *   recentDropped: number, recentInvalid: number, recentNoChannel: number, recentStale: number, recentDuplicate: number,
 *   recentOverCap: number, recentUnshown: number, noteReviews: { [target: string]: string }, changedChannels: string[], guildChanged: boolean,
 *   overLimit: number, overLimitFields: string[] }}
 *   `overLimit`: prose field changes refused for running over their limit; `overLimitFields`: one
 *   `<kind>.<field>` name per refusal (`channels.topics`, `guild.patterns`, `users.relationship`,
 *   `users.character`, `lore.text`; no ids), in the order they were met, a name repeated once per
 *   refused occurrence.
 *   `noteReviews`: the answer's `note_reviews`, keyed `guild` or a channel id, only the three valid
 *   statuses, the first item for a target wins (see `reconcileNoteReviews`). `changedChannels`: the
 *   ids whose stored channel text changed; `guildChanged`: the same as `guild`.
 *   `users`: authors written. `guild`: patterns/starters/injokes changed. `self`: the stored self list changed
 *   (a list returned unchanged is false). Past `cfg.maxInjokes` / `cfg.maxSelfFacts` the items new against the
 *   stored list are kept first (`clampStringArray`). `channels`/`lore`: entries whose stored values changed
 *   (an identical re-send, compared after clamping, counts 0). `learned`: how many valid `guild.learned` add ops were
 *   handed to `store.applyLearnedOps` (a re-add of a stored item counts too -- it is a sighting).
 *   `aliasesChanged`: members (authors and roster) whose stored alias list really changed; `aliasOnly`: roster
 *   members among them. `aliasesDropped`: proposed aliases the guards held back (a member reference, the member's
 *   own display name, a non-string; in a bare list also a name already stored), authors and roster members alike --
 *   a proposal that was dropped, told apart from none. `droppedUsers`: entries for an id that is neither an author
 *   nor a roster member with a stored profile. `droppedFields`: non-empty keys other than `aliases` dropped from
 *   roster members' entries. `portraitDropped`: authors' non-blank `character`/`style` dropped without `portraitFields`.
 *   `selfDropped`: new self claims about a member dropped (`memberClaimTest`), logged once per update.
 *   `recentAdded` / `recentRemoved` / `recentExpired`: recent lines stored, taken back by id, gone past
 *   `recent.hours`; `recentOverlap`: adds dropped as equal to a long-term entry of this update;
 *   `recentEvicted`, `recentDropped` and its reasons (`recentInvalid`, `recentNoChannel`,
 *   `recentStale`, `recentDuplicate`, `recentOverCap`, `recentUnshown`): see `applyRecentField`
 *   (all 0 without `options.recent`).
 */
export function applyMemoryUpdate(
  store,
  guildId,
  update,
  cfg,
  knownUserIds,
  { knownChannelIds = new Set(), aliasOnlyIds = new Set(), relationships, episodes, lore, recent, timing, batchAuthorNames, portraitFields = false, relationshipChars, by = 'analyzer', versions, limits = null } = {},
) {
  const result = {
    users: 0,
    guild: false,
    self: false,
    affinity: 0,
    relationships: 0,
    channels: 0,
    episodes: 0,
    lore: 0,
    learned: 0,
    interestsChanged: 0,
    aliasesChanged: 0,
    aliasOnly: 0,
    aliasesDropped: 0,
    droppedUsers: 0,
    droppedFields: 0,
    portraitDropped: 0,
    portraitRequests: [],
    selfDropped: 0,
    noteReviews: {},
    changedChannels: [],
    guildChanged: false,
    recentAdded: 0,
    recentOverlap: 0,
    recentRemoved: 0,
    recentExpired: 0,
    recentEvicted: 0,
    recentDropped: 0,
    recentInvalid: 0,
    recentNoChannel: 0,
    recentStale: 0,
    recentDuplicate: 0,
    recentOverCap: 0,
    recentUnshown: 0,
    overLimit: 0,
    overLimitFields: [],
  };
  if (!update || typeof update !== 'object' || Array.isArray(update)) return result;

  const { isKnownId, tokenize, tokenizeArray, tokenizeItemOps, tokenizeEpisodes } = makeTokenizers(store, guildId, knownUserIds, batchAuthorNames);
  const relationshipLimit = relationshipLimitOf(relationshipChars, relationships);
  // Who wrote and the version settings, on every store write below.
  const writeOpts = { by, versions: versions ?? { enabled: true, kept: cfg.versionsKept ?? 20 } };
  // The text to write for one prose field, or null when nothing is written: a blank or identical
  // answer, or a rewrite over its limit -- left out whole and counted, never cut.
  const accepted = (name, previous, next, limit) => {
    const verdict = acceptProse(previous, next, limit, { tolerance: cfg.clampTolerance });
    reportProse(limits, name, verdict, next, limit);
    if (verdict.outcome === 'over') {
      result.overLimit += 1;
      result.overLimitFields.push(name);
    }
    return verdict.outcome === 'first' || verdict.outcome === 'replaced' ? verdict.text : null;
  };
  // The folded texts of the long-term entries this update proposed to a long-term store, whether
  // or not the store keeps them (R-7), within the store's own per-batch caps: a recent add equal
  // to one of them has its home there already (one home per moment).
  const longTerm = new Set();
  const takeLongTerm = (text) => {
    if (typeof text === 'string' && text.trim() !== '') longTerm.add(foldText(text));
  };

  if (update.users && typeof update.users === 'object' && !Array.isArray(update.users)) {
    for (const [userId, raw] of Object.entries(update.users)) {
      const id = String(userId);
      const author = knownUserIds.has(id);
      // A member the request showed only in its `<known_members>` roster: aliases only, and
      // only onto a profile that already exists -- never a new one.
      const aliasOnly = !author && aliasOnlyIds.has(id) && store.getUser(guildId, id) != null;
      if (!author && !aliasOnly) {
        result.droppedUsers += 1;
        continue;
      }
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;

      const profileOpsNow = relationships?.now ?? episodes?.now ?? Date.now();
      const seenAt = timing?.seenAtByUser?.get(id) ?? timing?.seenAt ?? profileOpsNow;
      const beforeAliases = JSON.stringify(store.getUser(guildId, id)?.aliases ?? []);
      const { ops: aliasOps, dropped: aliasesDropped } = guardedAliasOps(raw.aliases, store.getUser(guildId, id));
      result.aliasesDropped += aliasesDropped;

      if (aliasOnly) {
        result.droppedFields += Object.entries(raw).filter(([key, value]) => key !== 'aliases' && hasContent(value)).length;
        if (!hasContent(aliasOps)) continue;
        store.applyProfileOps(guildId, id, { aliases: aliasOps }, { ...profileOpsOptions(cfg, profileOpsNow, seenAt), ...writeOpts });
        if (JSON.stringify(store.getUser(guildId, id)?.aliases ?? []) !== beforeAliases) {
          result.aliasesChanged += 1;
          result.aliasOnly += 1;
        }
        continue;
      }

      // Incremental profile ops (see docs/prompt-contract.md, "The
      // analyzer"): a prose field is written only when `accepted` takes it
      // (a first write clamped, a rewrite over its limit refused). `interests`/
      // `details` are ops objects, the only shape accepted.
      // `character`/`style` stay plain prose (see docs/prompt-contract.md,
      // "Data model"): the stream analyzer never edits them directly -- here
      // they are written only for the warmup's person run and the portrait
      // refresh (profile.md, or portrait.md's `style` in two-stage mode), which
      // pass `portraitFields`; the voice run writes a worded `character` itself
      // (runVoiceWrites). From any other caller they are dropped and counted,
      // never stored.
      const ops = {};
      for (const key of ['character', 'style', 'relationship']) {
        if (typeof raw[key] !== 'string') continue;
        if (key !== 'relationship' && !portraitFields) {
          if (raw[key].trim()) result.portraitDropped += 1;
          continue;
        }
        const limit = key === 'relationship' ? relationshipLimit : cfg.fieldChars;
        const previous = store.getUser(guildId, userId)?.[key];
        const next = tokenize(raw[key]);
        const text = accepted(`users.${key}`, previous, next, limit);
        if (text !== null) ops[key] = text;
        // An identical relationship text still confirms it: written again, it renews its stamps
        // (relationshipStale counts from them), as before; the store records no version for it.
        else if (key === 'relationship' && sameProse(previous, next)) ops[key] = previous;
      }

      // `portrait`: the stream analyzer's cue that this member's stored
      // character/style misses or contradicts something the batch showed --
      // never stored here, just collected for the caller (analyze()) to hand
      // to an injected refresh callback; see docs/prompt-contract.md,
      // "Data model".
      if (typeof raw.portrait === 'string') {
        const reason = clampText(tokenize(raw.portrait), 200, { tolerance: cfg.clampTolerance });
        if (reason) result.portraitRequests.push({ userId: String(userId), reason });
      }

      tokenizeItemOps(raw, ops);

      // Aliases are literal nicknames, never a `<@id>` reference to someone
      // else -- never tokenized, only guarded (`guardedAliasOps`), see
      // docs/prompt-contract.md, "Aliases".
      if (aliasOps) ops.aliases = aliasOps;
      // A real name is literal too: never tokenized, guarded like an alias (`guardedRealName`).
      const realName = guardedRealName(raw.realName);
      if (realName !== null) ops.realName = realName;

      const beforeInterests = JSON.stringify(store.getUser(guildId, userId)?.interests ?? []);
      const beforeRelationship = store.getUser(guildId, userId)?.relationship ?? '';

      // A written relationship text is stamped with the score this batch lands on, after its own
      // delta (computed with the same pure maths adjustAffinity runs below), and with this
      // batch's clock (`profileOpsNow`), which also stamps that delta's history entry.
      const relationshipWritten = typeof ops.relationship === 'string' && ops.relationship.trim() !== '';
      const profileOpts = { ...profileOpsOptions(cfg, profileOpsNow, seenAt), ...writeOpts };
      profileOpts.relationshipChars = relationshipLimit;
      if (relationshipWritten) profileOpts.relationshipScore = scoreAfterBatch(store.getUser(guildId, userId)?.affinity, raw, relationships, cfg);
      store.applyProfileOps(guildId, userId, ops, profileOpts);
      result.users += 1;

      const afterInterests = JSON.stringify(store.getUser(guildId, userId)?.interests ?? []);
      if (afterInterests !== beforeInterests) result.interestsChanged += 1;
      if (JSON.stringify(store.getUser(guildId, userId)?.aliases ?? []) !== beforeAliases) result.aliasesChanged += 1;
      // Diagnostic: how many members had their stored relationship text rewritten.
      if ((store.getUser(guildId, userId)?.relationship ?? '') !== beforeRelationship) result.relationships += 1;

      if (relationships?.enabled && raw.affinity && typeof raw.affinity === 'object' && !Array.isArray(raw.affinity)) {
        const before = store.getUser(guildId, userId)?.affinity?.score ?? 0;
        const after = store.adjustAffinity(guildId, userId, raw.affinity.delta, tokenize(raw.affinity.reason), affinityOptions(relationships, cfg));
        if (after.score !== before) result.affinity += 1;
      }

      if (episodes?.enabled && Array.isArray(raw.episodes) && raw.episodes.length > 0) {
        const tokenizedEpisodes = tokenizeEpisodes(raw.episodes);
        const added = store.addEpisodes(guildId, userId, tokenizedEpisodes, episodeOptions(episodes, cfg));
        result.episodes += added;
        // The proposals the store considers (src/memory/episodes.js#mergeEpisodes: the usable ones,
        // at most `episodes.maxNew`); one past that cap is no home for a recent line.
        const considered = tokenizedEpisodes
          .filter((ep) => isPlainObject(ep) && typeof ep.what === 'string' && ep.what.trim() !== '')
          .slice(0, episodes.maxNew === undefined ? Infinity : episodes.maxNew);
        for (const ep of considered) takeLongTerm(ep.what);
      }
    }
  }

  if (lore?.enabled && Array.isArray(update.lore) && update.lore.length > 0) {
    // `title`/`keys` are the identity a person actually types, never tokenized.
    const tokenizedLore = update.lore.map((entry) =>
      entry && typeof entry === 'object' && !Array.isArray(entry) ? { ...entry, text: tokenize(entry.text) } : entry,
    );
    // The text judged against the stored entry of the same title (identity: the trimmed lowercase
    // title, as src/memory/lore.js#upsertLore matches). A refused text is replaced by the stored
    // one, so the entry's keys still change; an owner entry is left to upsertLore, which never
    // lets the analyzer touch it.
    const storedLore = typeof store.getLore === 'function' ? store.getLore(guildId) : [];
    const identity = (title) => String(title ?? '').trim().toLowerCase();
    const textChars = Number.isFinite(lore.textChars) && lore.textChars > 0 ? lore.textChars : MEMORY_LIMIT_DEFAULTS.loreTextChars;
    const judgedLore = tokenizedLore.map((entry) => {
      if (!isPlainObject(entry) || typeof entry.title !== 'string' || typeof entry.text !== 'string' || !entry.text.trim()) return entry;
      const stored = (Array.isArray(storedLore) ? storedLore : []).find((item) => identity(item?.title) === identity(entry.title));
      if (stored?.source === 'owner') return entry;
      const previous = typeof stored?.text === 'string' ? stored.text : '';
      const text = accepted('lore.text', previous, entry.text, textChars);
      return { ...entry, text: text ?? previous };
    });
    result.lore = store.setLore(guildId, judgedLore, {
      source: 'analyzer',
      now: lore.now,
      maxEntries: lore.maxEntries,
      textChars: lore.textChars,
      clampTolerance: cfg.clampTolerance,
      ...writeOpts,
    });
    for (const entry of tokenizedLore) takeLongTerm(entry?.text);
  }

  if (update.channels && typeof update.channels === 'object' && !Array.isArray(update.channels)) {
    for (const [channelId, raw] of Object.entries(update.channels)) {
      if (!knownChannelIds.has(String(channelId))) continue;
      if (!raw || typeof raw !== 'object' || Array.isArray(raw)) continue;

      const stored = store.getChannel(guildId, channelId);
      const fields = {};
      for (const key of CHANNEL_FIELDS) {
        // A blank field says nothing: it never blanks the stored text.
        if (typeof raw[key] !== 'string' || raw[key].trim() === '') continue;
        const text = accepted(`channels.${key}`, stored?.[key], tokenize(raw[key]), cfg.fieldChars);
        if (text !== null) fields[key] = text;
      }

      // Counted only when the stored text moves: an identical re-send is no change (and unstamped).
      const before = fieldsSnapshot(stored ?? emptyChannel(String(channelId)), CHANNEL_FIELDS);
      if (fieldsSnapshot(store.updateChannel(guildId, channelId, fields, writeOpts), CHANNEL_FIELDS) !== before) {
        result.channels += 1;
        result.changedChannels.push(String(channelId));
      }
    }
  }

  const guildFields = {};
  if (update.guild && typeof update.guild === 'object' && !Array.isArray(update.guild)) {
    const g = update.guild;
    for (const key of ['patterns', 'starters']) {
      if (typeof g[key] !== 'string' || !g[key].trim()) continue;
      const text = accepted(`guild.${key}`, store.getGuild(guildId)[key], tokenize(g[key]), cfg.fieldChars * 2);
      if (text !== null) guildFields[key] = text;
    }
    if (Array.isArray(g.injokes) && g.injokes.length) {
      // A new in-joke enters a full list, the last carried one leaves (clampStringArray).
      const injokes = clampStringArray(tokenizeArray(g.injokes), INJOKE_CHARS, cfg.maxInjokes, cfg.clampTolerance, store.getGuild(guildId).injokes, { limits, field: 'guild.injokes' });
      if (injokes.length) guildFields.injokes = injokes;
    }
  }
  if (Object.keys(guildFields).length > 0) {
    const keys = Object.keys(guildFields);
    const before = fieldsSnapshot(store.getGuild(guildId), keys);
    result.guild = fieldsSnapshot(store.updateGuild(guildId, guildFields, writeOpts), keys) !== before;
  }
  result.guildChanged = result.guild;

  // The stale-note reviews: kept raw for reconcileNoteReviews (run() decides what earns a stamp).
  if (Array.isArray(update.note_reviews)) {
    for (const item of update.note_reviews) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) continue;
      const target = item.target === 'guild' ? 'guild' : typeof item.target === 'string' && item.target !== '' ? item.target : null;
      if (target === null || !NOTE_REVIEW_STATUSES.has(item.status) || Object.hasOwn(result.noteReviews, target)) continue;
      result.noteReviews[target] = item.status;
    }
  }

  // Things people taught the persona: incremental ops, same mechanics as a
  // member's details (see src/memory/store.js#applyLearnedOps), dated by the
  // batch's newest message.
  const guildRaw = update.guild && typeof update.guild === 'object' && !Array.isArray(update.guild) ? update.guild : null;
  const learned = parseLearnedOps(guildRaw?.learned, {
    tokenize,
    isKnownId,
    learnedChars: cfg.learnedChars ?? MEMORY_LIMIT_DEFAULTS.learnedChars,
    clampTolerance: cfg.clampTolerance,
    limits,
  });
  if (learned) {
    store.applyLearnedOps(guildId, learned.ops, learnedOpsOptions(cfg, timing?.seenAt ?? relationships?.now ?? episodes?.now ?? Date.now()));
    result.learned = learned.added;
    for (const text of listTexts(guildRaw.learned.add)) takeLongTerm(tokenize(text));
  }

  if (Array.isArray(update.self) && update.self.length > 0) {
    const storedSelf = store.getGuild(guildId).self;
    // A NEW claim about a member is dropped (memberClaimTest); one carried from the stored list,
    // compared as the store compares facts, stays: taking it back is a removal, the model's call.
    const storedKeys = new Set((Array.isArray(storedSelf) ? storedSelf : []).filter((fact) => typeof fact === 'string').map(normalizeTopic));
    const aboutMember = memberClaimTest(store, guildId, knownUserIds, batchAuthorNames);
    const proposed = tokenizeArray(update.self).filter((item) => {
      if (typeof item !== 'string') return true;
      const fact = clampText(item, SELF_CHARS, { tolerance: cfg.clampTolerance });
      if (!fact || storedKeys.has(normalizeTopic(fact)) || !aboutMember(fact)) return true;
      result.selfDropped += 1;
      return false;
    });
    logSelfDropped(guildId, result.selfDropped);
    // The single-stage list replaces the stored one; a new fact enters a full list (clampStringArray).
    const self = clampStringArray(proposed, SELF_CHARS, cfg.maxSelfFacts, cfg.clampTolerance, storedSelf, { limits, field: 'guild.self' });
    if (self.length > 0) {
      // Counted only when the stored list moves: a list returned unchanged is no change (and unstamped).
      const before = fieldsSnapshot(store.getGuild(guildId), ['self']);
      result.self = fieldsSnapshot(store.updateGuild(guildId, { self }, writeOpts), ['self']) !== before;
      // The facts kept, not the ones past `cfg.maxSelfFacts`.
      for (const text of self) takeLongTerm(text);
    }
  }

  // Last, once every long-term entry of this update is known. A fake store without the recent
  // store (tests) is left alone.
  if (recent?.enabled && typeof store.applyRecentOps === 'function') {
    for (const text of listTexts(recent.taken)) takeLongTerm(tokenize(text));
    Object.assign(result, applyRecentField(store, guildId, update.recent, { recent, tokenize, knownChannelIds, longTerm }));
  }

  return result;
}

/** Whether `next` repeats the non-blank stored text `previous` (acceptProse's `same`, trimmed). */
function sameProse(previous, next) {
  return typeof previous === 'string' && previous.trim() !== '' && typeof next === 'string' && next.trim() === previous.trim();
}

/** The listed fields of a stored entry as one comparable string, taken before and after a store
 * write: equal means the write changed nothing (the store compares the same JSON form). */
function fieldsSnapshot(value, keys) {
  return JSON.stringify(keys.map((key) => value?.[key]));
}

/** Whether an analyzer value says anything: a non-blank string, a non-empty array or object. */
function hasContent(value) {
  if (typeof value === 'string') return value.trim() !== '';
  if (Array.isArray(value)) return value.length > 0;
  if (isPlainObject(value)) return Object.values(value).some(hasContent);
  return value != null && value !== false;
}

/**
 * Validate and store a PRIVATE batch's answer (see `analyzePrivate`): only
 * `update.users[userId]` is applied, and only to that member's private layer
 * -- `relationship`/`interests`/`details` via `store.applyPrivateOps`,
 * `affinity` via `store.adjustPrivateAffinity`, `episodes` via
 * `store.addPrivateEpisodes`, with the same options `applyMemoryUpdate` uses.
 * `character`, `style`, `aliases` and `portrait` are public-only and ignored:
 * the private layer has no portrait, and no caller can make this path write
 * one (only the portrait refresh and the warmup write `character`/`style`,
 * through `applyMemoryUpdate`); a non-blank `character`/`style` is counted
 * in `dropped.portrait`. Every other user, `guild`, `channels`, `lore`,
 * `self` and `recent` (the recent store is server memory: nothing from a private
 * chat goes there) is dropped and only counted in `dropped` (never an id). Never throws
 * on garbage input.
 * @param {object} store
 * @param {string} guildId
 * @param {string} userId       The DM partner.
 * @param {unknown} update      Parsed model output; untrusted.
 * @param {object} cfg          `config.memory`.
 * @param {{ relationships?: object, episodes?: object, timing?: object, batchAuthorNames?: Map<string, string>,
 *   relationshipChars?: number }} [options]
 *   As for `applyMemoryUpdate` (`timing` from `computeSeenAt`, `batchAuthorNames` from
 *   `batchAuthorNamesMap`, `relationshipChars` the text's limit, `limits` the collector told a
 *   refused or clamped relationship text); there is no channel, lore or guild here. A written
 *   private relationship is stamped in the private layer: the EFFECTIVE
 *   score after this batch's delta and the batch clock (`relationshipWrittenAt`), the clock this
 *   batch's private move is stamped with, so the move is not one since the text.
 * A relationship text goes through src/memory/prose.js#acceptProse against the stored private
 * one, as in `applyMemoryUpdate`: a first write clamped, a rewrite over the limit refused whole.
 * @returns {{ users: number, affinity: number, relationships: number, episodes: number, interestsChanged: number,
 *   overLimit: number, overLimitFields: string[],
 *   dropped: { users: number, guild: boolean, channels: number, lore: number, self: number, portrait: number, recent: number } }}
 *   `overLimit` / `overLimitFields`: a relationship rewrite refused for its length (`private.relationship`).
 *   `dropped.recent`: the items of a `recent` field (`add` and `remove` entries; a bare list's
 *   items), read as the guild apply reads the field (`recentFieldOf`).
 */
export function applyPrivateUpdate(store, guildId, userId, update, cfg, { relationships, episodes, timing, batchAuthorNames, relationshipChars, limits = null } = {}) {
  const id = String(userId);
  const result = {
    users: 0,
    affinity: 0,
    relationships: 0,
    episodes: 0,
    interestsChanged: 0,
    overLimit: 0,
    overLimitFields: [],
    dropped: { users: 0, guild: false, channels: 0, lore: 0, self: 0, portrait: 0, recent: 0 },
  };
  if (!isPlainObject(update)) return result;

  const users = isPlainObject(update.users) ? update.users : {};
  result.dropped.users = Object.keys(users).filter((key) => key !== id).length;
  result.dropped.guild = hasContent(update.guild);
  result.dropped.channels = isPlainObject(update.channels) ? Object.keys(update.channels).length : 0;
  result.dropped.lore = Array.isArray(update.lore) ? update.lore.length : 0;
  result.dropped.self = Array.isArray(update.self) ? update.self.length : 0;
  const recentField = recentFieldOf(update.recent);
  result.dropped.recent = recentField.add.length + recentField.remove.length;

  const raw = users[id];
  if (!isPlainObject(raw)) return result;
  result.dropped.portrait = ['character', 'style'].filter((key) => typeof raw[key] === 'string' && raw[key].trim()).length;

  const { tokenize, tokenizeItemOps, tokenizeEpisodes } = makeTokenizers(store, guildId, new Set([id]), batchAuthorNames);
  const before = store.getPrivate(guildId, id);
  const relationshipLimit = relationshipLimitOf(relationshipChars, relationships);
  const ops = {};
  if (typeof raw.relationship === 'string') {
    // A rewrite over the limit is refused whole, never cut (the store cuts only a first write); an
    // identical text is written again, renewing its stamps, as in applyMemoryUpdate.
    const next = tokenize(raw.relationship);
    const verdict = acceptProse(before?.relationship, next, relationshipLimit, { tolerance: cfg.clampTolerance });
    reportProse(limits, 'private.relationship', verdict, next, relationshipLimit);
    if (verdict.outcome === 'first' || verdict.outcome === 'replaced' || verdict.outcome === 'same') ops.relationship = verdict.text;
    if (verdict.outcome === 'over') {
      result.overLimit += 1;
      result.overLimitFields.push('private.relationship');
    }
  }
  tokenizeItemOps(raw, ops);

  const opsNow = relationships?.now ?? episodes?.now ?? Date.now();
  const seenAt = timing?.seenAtByUser?.get(id) ?? timing?.seenAt ?? opsNow;
  const beforeInterests = JSON.stringify(before?.interests ?? []);
  const beforeRelationship = before?.relationship ?? '';

  // The private analyzer sees the EFFECTIVE affinity (public + private), so a written private
  // relationship is stamped with the effective score this batch lands on.
  const relationshipWritten = typeof ops.relationship === 'string' && ops.relationship.trim() !== '';
  const privateOpts = profileOpsOptions(cfg, opsNow, seenAt);
  privateOpts.relationshipChars = relationshipLimit;
  if (relationshipWritten) {
    const privateScore = scoreAfterBatch(before?.affinity, raw, relationships, cfg);
    privateOpts.relationshipScore = effectiveAffinity(store.getUser?.(guildId, id)?.affinity, { score: privateScore }).score;
  }
  const after = store.applyPrivateOps(guildId, id, ops, privateOpts);
  result.users = 1;
  if (JSON.stringify(after.interests) !== beforeInterests) result.interestsChanged = 1;
  if (after.relationship !== beforeRelationship) result.relationships = 1;

  if (relationships?.enabled && isPlainObject(raw.affinity)) {
    const scoreBefore = store.getPrivate(guildId, id)?.affinity?.score ?? 0;
    const next = store.adjustPrivateAffinity(guildId, id, raw.affinity.delta, tokenize(raw.affinity.reason), affinityOptions(relationships, cfg));
    if (next.score !== scoreBefore) result.affinity = 1;
  }

  if (episodes?.enabled && Array.isArray(raw.episodes) && raw.episodes.length > 0) {
    result.episodes = store.addPrivateEpisodes(guildId, id, tokenizeEpisodes(raw.episodes), episodeOptions(episodes, cfg));
  }

  return result;
}

/**
 * Whether stage A stored what a reason or a feeling item fills in later, so the item has an
 * address: a reason item needs an attitude history entry stamped its `payload.at` (none when the
 * score did not move -- at its bound, damped to nothing -- or no history is kept), a feeling item
 * a stored episode added at `payload.at` with exactly its `date` and `what` (none for a repeat of
 * a moment stored earlier, or one evicted on arrival). Every other kind needs nothing stored.
 * @param {object} item  An item of src/memory/voice.js#splitDecision.
 * @param {(item: object) => (object|null)} holderOf  The stored profile, or private layer, it is about.
 * @returns {boolean}
 */
function hasVoiceAddress(item, holderOf) {
  if (item.kind !== 'reason' && item.kind !== 'feeling') return true;
  const holder = holderOf(item);
  const { at, date, what } = item.payload ?? {};
  if (item.kind === 'reason') {
    const history = holder?.affinity?.history;
    return Array.isArray(history) && history.some((move) => move?.ts === at);
  }
  const stored = holder?.episodes;
  return Array.isArray(stored) && stored.some((ep) => ep?.addedAt === at && ep.date === date && ep.what === what);
}

/**
 * Run voice writes (the plain-data `writes` of src/memory/voice.js#applyVoiceItems, or of
 * #degradedApply for items that left the queue unworded) through the store method of each kind,
 * every text already tokenized and clamped:
 * - relationship: `applyProfileOps`, stamped with the score stage A already moved and the clock
 *   `nowMs`; a private one `applyPrivateOps`, stamped with the effective (public + private)
 *   score, as a private batch stamps it;
 * - reason: `fillAffinityReason`, feeling: `fillEpisodeFeeling`, in the write's layer (both write
 *   nothing when the address is gone, and are safe to run twice);
 * - learned: `applyLearnedOps`, dated when it was taught; self: `applySelfOps`;
 * - patterns / starters: `updateGuild`;
 * - character: `applyProfileOps` (the portrait stamps are `stampVoicePortraits`').
 * A write of any other kind, or a character write with a layer, is skipped. Every prose write
 * goes out with `by: 'voice'` and the version history settings (`features.versions`,
 * `memory.versionsKept`), so a replaced text keeps its previous version.
 * @param {object} store
 * @param {string} guildId
 * @param {object[]} writes
 * @param {object} config  The live config.
 * @param {number} nowMs   When the writes happen (stamps a relationship text and a changed self list).
 * @returns {number}  The writes that landed (an address filled, a fact added, a text written).
 */
function runVoiceWrites(store, guildId, writes, config, nowMs) {
  const cfg = config.memory ?? {};
  const limits = voiceLimits(config);
  const writeOpts = { by: 'voice', versions: { enabled: config.features?.versions !== false, kept: cfg.versionsKept ?? 20 } };
  const textOpts = { fieldChars: limits.character, relationshipChars: limits.relationship, clampTolerance: cfg.clampTolerance, now: nowMs, ...writeOpts };
  let landed = 0;
  for (const write of writes) {
    const layer = write.layer === 'private' ? 'private' : undefined;
    if (write.kind === 'relationship') {
      if (layer) {
        const score = effectiveAffinity(store.getUser(guildId, write.userId)?.affinity, store.getPrivate(guildId, write.userId)?.affinity).score;
        store.applyPrivateOps(guildId, write.userId, { relationship: write.text }, { ...textOpts, relationshipScore: score });
      } else {
        store.applyProfileOps(guildId, write.userId, { relationship: write.text }, textOpts);
      }
      landed += 1;
    } else if (write.kind === 'character' && !layer) {
      store.applyProfileOps(guildId, write.userId, { character: write.text }, textOpts);
      landed += 1;
    } else if (write.kind === 'reason') {
      if (store.fillAffinityReason(guildId, write.userId, write.at, write.text, { layer, clampTolerance: cfg.clampTolerance })) landed += 1;
    } else if (write.kind === 'feeling') {
      const episode = { at: write.at, date: write.date, what: write.what };
      if (store.fillEpisodeFeeling(guildId, write.userId, episode, write.text, { layer, clampTolerance: cfg.clampTolerance })) landed += 1;
    } else if (write.kind === 'learned') {
      const add = { text: write.text };
      if (write.from) add.from = write.from;
      if (write.sure === false) add.sure = false;
      store.applyLearnedOps(guildId, { add: [add], seen: [], remove: [] }, learnedOpsOptions(cfg, write.seenAt));
      landed += 1;
    } else if (write.kind === 'self') {
      landed += store.applySelfOps(guildId, { add: [write.text] }, selfOpsOptions(cfg, nowMs)).added;
    } else if (write.kind === 'patterns' || write.kind === 'starters') {
      store.updateGuild(guildId, { [write.kind]: write.text }, writeOpts);
      landed += 1;
    }
  }
  return landed;
}

/**
 * The portrait stamps of the character items a voice run just applied (DECISIONS-R4: written
 * when the item is APPLIED, never when the refresh queued it, so a portrait merge the voice model
 * has not worded yet leaves the member due): `portraitRefreshedAt` = when the item was queued
 * (`createdAt`, the closest the queue keeps to the moment the refresh read the history, so the
 * next sample misses no line written while the item waited), `portraitMessageCount` = the
 * member's message count now, and no pending attempt -- the fields
 * src/memory/warmup.js#stampPortrait writes.
 * @param {object} store
 * @param {string} guildId
 * @param {object[]} items       The sent items still queued (one character item per member).
 * @param {string[]} portraits   applyVoiceItems' `portraits`: members whose character item was applied.
 * @returns {number}  Portraits stamped.
 */
function stampVoicePortraits(store, guildId, items, portraits) {
  let stamped = 0;
  for (const userId of portraits) {
    const item = items.find((queued) => queued.kind === 'character' && queued.userId === userId);
    if (!item) continue;
    store.updateUser(guildId, item.userId, {
      portraitRefreshedAt: new Date(item.createdAt).toISOString(),
      portraitMessageCount: storedCount(store.getUser(guildId, item.userId)?.messageCount),
      portraitAttemptAt: null,
      // The member left the queue with this portrait: the waiting stamp starts over next time.
      portraitDueAt: null,
    });
    stamped += 1;
  }
  return stamped;
}

/** The stored text a relationship, patterns, starters or character item rewrites (with `<@id>`
 * tokens; the member's private layer's for a private item), '' when none: buildVoiceRequest's
 * `oldTextOf`, so a rewrite is a merge. */
function voiceOldText(store, guildId, item) {
  if (item.kind === 'patterns' || item.kind === 'starters') return store.getGuild(guildId)?.[item.kind] ?? '';
  const holder = item.layer === 'private' ? store.getPrivate(guildId, item.userId) : store.getUser(guildId, item.userId);
  return holder?.[item.kind] ?? '';
}

/** Whether a voice item's member still has what its text belongs to: their public profile, or
 * (`private`) their private layer. applyVoiceItems' and degradedApply's `hasMember`. */
function voiceMemberCheck(store, guildId) {
  return (userId, layer) => (layer === 'private' ? store.getPrivate(guildId, userId) : store.getUser(guildId, userId)) != null;
}

/**
 * The voice half of one stage A batch, run right after its neutral part was stored on the clock
 * `nowMs` the split used: drops the reason and feeling items that have nothing to fill
 * (`hasVoiceAddress`), folds the rest into the guild's voice queue in one synchronous
 * read-modify-write (store.updateVoiceQueue with src/memory/voice.js#mergeIntoQueue, so an item a
 * portrait refresh queued meanwhile stays), and sends what that pushed past
 * `memory.voice.queueMax` down the degraded path at once (logged as `memory: voice dropped`,
 * counts only). Nothing here waits for the voice model.
 * @param {object} store
 * @param {string} guildId
 * @param {{ items: object[], dropped: { off: number, foreign: number, shape: number } }} split
 *   splitDecision's result.
 * @param {object} config  The live config.
 * @param {number} nowMs
 * @returns {{ voiceQueued: number, voiceOverflow: number, voiceDegraded: number, voiceDropped: number }}
 *   `voiceQueued`: items put in the queue, new or folded into a queued one; `voiceOverflow`:
 *   queued items pushed out past the cap; `voiceDegraded`: their degraded writes that landed;
 *   `voiceDropped`: briefs never queued (a switched-off feature, a member who is not an author of
 *   the batch, a shape the split cannot read, nothing stored to fill).
 */
function queueStageA(store, guildId, split, config, nowMs) {
  const holderOf = (item) => (item.layer === 'private' ? store.getPrivate(guildId, item.userId) : store.getUser(guildId, item.userId));
  const items = split.items.filter((item) => hasVoiceAddress(item, holderOf));
  const { off, foreign, shape } = split.dropped;
  const counts = { voiceQueued: 0, voiceOverflow: 0, voiceDegraded: 0, voiceDropped: off + foreign + shape + split.items.length - items.length };
  if (items.length === 0) return counts;

  const { overflow, added, merged } = store.updateVoiceQueue(guildId, (queue) => mergeIntoQueue(queue, items, nowMs, config));
  counts.voiceQueued = added + merged;
  counts.voiceOverflow = overflow.length;
  if (overflow.length > 0) {
    const { writes } = degradedApply(overflow, { config, hasMember: voiceMemberCheck(store, guildId) });
    counts.voiceDegraded = runVoiceWrites(store, guildId, writes, config, nowMs);
    log.info('memory: voice dropped', { guildId, expired: 0, overflow: overflow.length, degraded: counts.voiceDegraded });
  }
  return counts;
}

/**
 * Stage A of a guild batch (the two-stage analyzer, see `analyzerMode`): split the parsed
 * prompts/memory-decide.md answer (src/memory/voice.js#splitDecision), store its neutral part at
 * once through `applyMemoryUpdate` with the options a single-stage batch gets (round 2's roster
 * rules included: a `<known_members>` member gets an alias and nothing else), the attitude delta
 * and the episodes (feeling empty) among it; apply its `self.remove` list; then queue the briefs
 * (`queueStageA`). `nowMs` is the batch's one clock value: the split addresses a reason and a
 * feeling by it, so `options.relationships.now` and `options.episodes.now` must be it too. The
 * `recent` field is neutral data: it passes the split untouched and is written here, with no
 * voice item; the lesson and self briefs queued from the same answer count as its long-term
 * entries (`options.recent.taken`), so a recent add equal to one is dropped as an overlap.
 * @param {object} store
 * @param {string} guildId
 * @param {unknown} decision  The parsed stage A answer; untrusted.
 * @param {object} config     The live config.
 * @param {Set<string>} knownUserIds  The batch's authors.
 * @param {object} options    `applyMemoryUpdate`'s options, plus `rewriteIds` (a Set: the members
 *   sent with a forced-rewrite marker, splitDecision's `rewriteIds`).
 * @param {number} nowMs
 * @returns {object}  `applyMemoryUpdate`'s result (its `portraitDropped` also counting the
 *   `character` / `style` / `portrait` keys the split dropped, `self` true when a stored self fact
 *   was removed, `selfDropped` the `self.add` claims about a member never queued) plus `queueStageA`'s counts,
 *   and `guildBriefQueued`: a `patterns` / `starters` brief went to the voice queue (the server notes'
 *   text changes later, in the voice run, so a stale-note review counts it as a change -- run()).
 */
function applyDecision(store, guildId, decision, config, knownUserIds, options, nowMs) {
  const cfg = config.memory ?? {};
  const { tokenize, isKnownId } = makeTokenizers(store, guildId, knownUserIds, options.batchAuthorNames);
  const decided = splitDecision(decision, { config, nowMs, knownUserIds, tokenize, isKnownId, seenAt: options.timing?.seenAt, rewriteIds: options.rewriteIds });
  // A self claim about a member is never queued (memberClaimTest); `self.remove` is not filtered.
  const aboutMember = memberClaimTest(store, guildId, knownUserIds, options.batchAuthorNames);
  const split = { ...decided, items: decided.items.filter((item) => !(item.kind === 'self' && aboutMember(item.brief?.[0]))) };
  const selfDropped = decided.items.length - split.items.length;
  const briefs = split.items.filter((item) => item.kind === 'learned' || item.kind === 'self').map((item) => item.brief?.[0]);
  const recent = options.recent ? { ...options.recent, taken: [...listTexts(options.recent.taken), ...listTexts(briefs)] } : options.recent;
  const result = applyMemoryUpdate(store, guildId, split.neutral, cfg, knownUserIds, { ...options, recent });
  result.portraitDropped += split.dropped.portrait;
  result.selfDropped += selfDropped;
  logSelfDropped(guildId, selfDropped);
  if (split.selfRemove.length > 0) {
    result.self = store.applySelfOps(guildId, { remove: split.selfRemove }, selfOpsOptions(cfg, nowMs)).removed > 0;
  }
  const queued = queueStageA(store, guildId, split, config, nowMs);
  const guildBriefQueued = queued.voiceQueued > 0 && split.items.some((item) => item.kind === 'patterns' || item.kind === 'starters');
  return { ...result, ...queued, guildBriefQueued };
}

/**
 * Stage A of a private batch: the same split (`layer: 'private'`), its neutral part stored in the
 * member's private layer only through `applyPrivateUpdate` (which drops and counts every public
 * key, so nothing said in private reaches the public profile or the server), its briefs queued as
 * private items of that member (`queueStageA`). `nowMs` as for `applyDecision`.
 * @param {object} store
 * @param {string} guildId
 * @param {string} userId     The DM partner.
 * @param {unknown} decision  The parsed stage A answer; untrusted.
 * @param {object} config     The live config.
 * @param {object} options    `applyPrivateUpdate`'s options.
 * @param {number} nowMs
 * @returns {object}  `applyPrivateUpdate`'s result (`dropped.portrait` also counting the portrait
 *   keys the split dropped, `dropped.self` also the claims of a stage A `self` object's `add` and
 *   `remove` lists, which applyPrivateUpdate counts only in the single-stage list shape) plus
 *   `queueStageA`'s counts.
 */
function applyPrivateDecision(store, guildId, userId, decision, config, options, nowMs) {
  const id = String(userId);
  const knownUserIds = new Set([id]);
  const { tokenize, isKnownId } = makeTokenizers(store, guildId, knownUserIds, options.batchAuthorNames);
  const split = splitDecision(decision, { config, nowMs, knownUserIds, tokenize, isKnownId, seenAt: options.timing?.seenAt, layer: 'private' });
  const result = applyPrivateUpdate(store, guildId, id, split.neutral, config.memory ?? {}, options);
  result.dropped.portrait += split.dropped.portrait;
  const { self } = split.neutral;
  if (isPlainObject(self)) {
    for (const list of [self.add, self.remove]) if (Array.isArray(list)) result.dropped.self += list.length;
  }
  return { ...result, ...queueStageA(store, guildId, split, config, nowMs) };
}

/**
 * Count which names a consumed guild batch calls members by (src/memory/addressed.js) and fold
 * the uses into each member's `addressedAs` (`store.recordAddressUses`, `cfg.addressHalfLifeDays`,
 * 30 when missing). The candidates are every stored profile of the guild; other bots' lines are
 * skipped, the persona's own count. A store without `listUserProfiles` / `recordAddressUses` (a
 * test fake) counts nothing.
 * @param {object} store
 * @param {string} guildId
 * @param {object[]} messages  The consumed slim messages.
 * @param {object} [cfg]  `config.memory`, read at the moment of use.
 * @returns {number}  The uses recorded.
 */
export function recordAddressing(store, guildId, messages, cfg = {}) {
  if (typeof store?.listUserProfiles !== 'function' || typeof store?.recordAddressUses !== 'function') return 0;
  const lines = (Array.isArray(messages) ? messages : []).filter((m) => m && !m.bot);
  if (lines.length === 0) return 0;
  const uses = countAddressUses(lines, addressCandidates(store.listUserProfiles(guildId)));
  let recorded = 0;
  for (const [userId, list] of uses) {
    if (store.recordAddressUses(guildId, userId, list, { halfLifeDays: cfg?.addressHalfLifeDays ?? DEFAULT_ADDRESS_HALF_LIFE_DAYS })) recorded += list.length;
  }
  return recorded;
}

/**
 * Record that a normalized message happened, for the counters kept on a
 * user's profile and a channel's map entry: `touchUser` (skipped for the
 * persona's own messages) and `touchChannel`, whose `topWriters` tally also
 * skips the persona's own messages and other bots. Used by `observe()`, the
 * live pipeline; the memory warmup (src/memory/warmup.js) computes a
 * profiled member's counters, and a channel's own counters/top writers, the
 * same way but from the fetched history window directly (via
 * `store.setChannelFacts`), rather than through this shared helper.
 * @param {object} store
 * @param {string} guildId
 * @param {object} normalized  A normalized message (see interfaces/discord/collect.js);
 *   callers are expected to have already dropped other bots' messages.
 * @param {object} [memoryCfg]  The live `config.memory`, for the tally's settings
 *   (`channelWritersStored`, `channelWritersHalfLifeDays`); omitted -> the store's fallbacks.
 *   `diaryChannelId` (the caller adds `diary.channelId`) names the one channel where the persona's
 *   own messages count as a writer.
 */
export function touchMemory(store, guildId, normalized, memoryCfg) {
  if (!normalized.self) {
    store.touchUser(guildId, normalized.authorId, normalized.authorName, normalized.ts);
  }
  // The persona's own messages and other bots never count toward a channel's
  // top writers -- see src/memory/store.js#touchChannel.
  // The one exception is the configured diary channel (`memoryCfg.diaryChannelId`, from
  // `diary.channelId`): the persona is its writer, so the map does not show it as dead.
  const diaryChannelId = memoryCfg?.diaryChannelId || null;
  const inDiary = diaryChannelId !== null && normalized.channelId === diaryChannelId;
  const writerId = !normalized.bot && (!normalized.self || inDiary) ? normalized.authorId : null;
  store.touchChannel(
    guildId,
    normalized.channelId,
    { name: normalized.channelName, category: normalized.channelCategory, topic: normalized.channelTopic },
    normalized.ts,
    writerId,
    memoryCfg,
  );
}

/**
 * The media of one normalized message part (the message itself or one
 * forwarded snapshot) as the memory buffer keeps it. No URL ever survives
 * into the buffer -- but the item `id` does, so the live analyzer can look up
 * a describer caption already warmed into the cache by src/behavior/pipeline.js
 * (see analyze() below). A sticker keeps `id`/`name`/`format` (its URL is
 * rebuilt from those via stickerUrl when needed); a custom emoji keeps only
 * `id`/`name` (its URL is rebuilt via emojiUrl).
 */
function slimMedia(part) {
  return {
    attachments: (part.attachments ?? []).map((a) => ({ kind: a.kind, name: a.name, id: a.id, durationSec: a.durationSec ?? null })),
    links: (part.links ?? []).map((l) => ({ kind: l.kind, name: l.title || l.site || '', id: l.id, durationSec: null })),
    stickers: (part.stickers ?? []).map((s) => ({ id: s.id, name: s.name, format: s.format })),
    emojis: (part.emojis ?? []).map((e) => ({ id: e.id, name: e.name })),
  };
}

/**
 * One normalized message as the memory buffer keeps it: ids, author, content, `ts`, the
 * reply target and its media without any URL (slimMedia), the forwarded snapshots stripped
 * the same way, and `direct`; a message whose links carry a preview title or description also
 * keeps them as `linkCards` (src/memory/record.js#recordLinks: URL, title, description, site),
 * which only the record reads. The one shape `observe()` pushes and the late-embed fold
 * (src/behavior/pipeline.js#onMessageUpdate) writes back over a buffered entry.
 * @param {object} normalized  A normalized message (interfaces/discord/collect.js#normalizeMessage).
 * @param {boolean} [direct]   Whether the message was addressed to the persona.
 * @returns {object}
 */
export function slimMessage(normalized, direct = false) {
  const linkCards = recordLinks(normalized.links);
  const forwarded = (normalized.forwarded ?? []).map((snapshot) => ({
    content: snapshot.content ?? '',
    ...slimMedia(snapshot),
  }));
  return {
    id: normalized.id,
    channelId: normalized.channelId,
    channelName: normalized.channelName,
    authorId: normalized.authorId,
    authorName: normalized.authorName,
    self: normalized.self,
    bot: normalized.bot,
    content: normalized.content,
    ts: normalized.ts,
    replyToId: normalized.replyToId,
    // The members the message mentions (the record's `mentions`); absent when none.
    ...(Array.isArray(normalized.mentionedUserIds) && normalized.mentionedUserIds.length > 0 ? { mentionedUserIds: [...normalized.mentionedUserIds] } : {}),
    ...slimMedia(normalized),
    // The link previews the record keeps (toRecordLine's `links`); absent when none.
    ...(linkCards.length > 0 ? { linkCards } : {}),
    // A forwarded message's snapshots (interfaces/discord/collect.js
    // #normalizeSnapshot), stripped the same way, so the analyzer's
    // transcript renders a forward like the live one. Absent for a message
    // with no forward: the buffer entry stays as it was.
    ...(forwarded.length > 0 ? { forwardedFrom: normalized.forwardedFrom ?? null, forwarded } : {}),
    direct: Boolean(direct),
  };
}

/**
 * The stored profiles/channels an analyzer batch needs, plus the distinct
 * non-self author ids and channel ids of `messages` (the `knownUserIds` /
 * `knownChannelIds` of `applyMemoryUpdate`). The lookups are passed in, so
 * the caller decides where profiles and channels are read from.
 * @param {object[]} messages  Slim or normalized messages; `self`/`authorId`/`channelId` read.
 * @param {(id: string) => (object|null)} getUser     A stored profile, null when none.
 * @param {(id: string) => (object|null)} getChannel  A stored channel entry, null when none.
 * @returns {{ authorIds: string[], profiles: object, channelIds: string[], channels: object }}
 */
function batchContext(messages, getUser, getChannel) {
  const authorIds = batchAuthorIds(messages);
  const profiles = {};
  for (const id of authorIds) {
    const profile = getUser(id);
    if (profile) profiles[id] = profile;
  }

  const channelIds = batchChannelIds(messages);
  const channels = {};
  for (const id of channelIds) {
    const channel = getChannel(id);
    if (channel) channels[id] = channel;
  }

  return { authorIds, profiles, channelIds, channels };
}

/**
 * The `relationships`/`episodes`/`lore`/`recent` arguments of the apply functions,
 * from `config` (read by the caller at the moment of use). `now` is the clock
 * (a function), read once per enabled switch. `recent` is
 * src/memory/recent.js#recentSettings' (`features.recent`, a missing key counts as on) with
 * `enabled` and the clock; only a guild batch passes it on (a private batch never writes the
 * recent store). Exported as a test seam (tests/memory-update.test.js builds the `recent` option
 * with it); no other module uses it.
 * @param {object} config
 * @param {() => number} now
 * @returns {{ relationships?: object, episodes?: object, lore?: object, recent?: object }}
 */
export function memorySwitches(config, now) {
  const cfg = config.memory;
  const relationshipsOn = config.features?.relationships !== false;
  const relationships = relationshipsOn ? { enabled: true, ...config.relationships, now: now() } : undefined;
  const episodesOn = config.features?.episodes !== false;
  const episodes = episodesOn ? { enabled: true, maxEpisodes: cfg.maxEpisodes, maxNew: cfg.maxNewEpisodes, now: now() } : undefined;
  const loreOn = config.features?.lore !== false;
  const lore = loreOn
    ? { enabled: true, maxEntries: config.lore?.maxEntries ?? Infinity, textChars: config.lore?.textChars, now: now() }
    : undefined;
  const recentOn = recentSettings(config);
  const recent = recentOn ? { enabled: true, ...recentOn, now: now() } : undefined;
  return { relationships, episodes, lore, recent };
}

/** `{ stage }` of an analyzer outcome for a log line, or nothing: an outcome carries `stage` only
 * while `features.memoryTwoStage` was on for its batch, so with the switch off a line is as before. */
function stageField(outcome) {
  return outcome?.stage ? { stage: outcome.stage } : {};
}

/** `stageField` plus `voiceQueued` (the briefs the batch put in the voice queue, 0 when the
 * single-stage path ran), for an applied-update line. */
function stageLogFields(outcome) {
  return outcome?.stage ? { ...stageField(outcome), voiceQueued: outcome.result?.voiceQueued ?? 0 } : {};
}

/** `nameOf` for buildMemoryRequest's token resolution: a member's current
 * stored name, or null when the guild has no profile for that id -- see
 * docs/prompt-contract.md, "Members are referred to by id, never by
 * nickname". The one place `analyze()` touches the store for this. */
function storeNameOf(store, guildId) {
  return (id) => store.getUser(guildId, id)?.names?.[0] ?? null;
}

/** How many hex characters an episode's journal `key` keeps. */
const EPISODE_KEY_CHARS = 12;
/** The guild fields a memory record's `changed.guild` compares: the server notes and what the persona keeps about itself and was taught. */
const TRACED_GUILD_FIELDS = ['patterns', 'starters', 'injokes', 'self', 'learned'];

/**
 * The journal `key` of a stored episode: the first EPISODE_KEY_CHARS hex characters of the
 * sha256 of `date|what`. Names an episode stored before episodes carried an `itemId`.
 * @param {{ date?: string, what?: string }} episode
 * @returns {string}
 */
export function episodeKey(episode) {
  const text = `${episode?.date ?? ''}|${episode?.what ?? ''}`;
  return createHash('sha256').update(text).digest('hex').slice(0, EPISODE_KEY_CHARS);
}

/** The profile a trace reads for `userId`: the member's private layer in a private trace, else the public profile. */
function tracedHolder(store, guildId, userId, privateUserId) {
  return privateUserId ? (store.getPrivate?.(guildId, userId) ?? null) : (store.getUser(guildId, userId) ?? null);
}

/**
 * What a memory record compares, read right before an apply: per member of `userIds` the profile
 * (the private layer in a private trace) as JSON, its episode keys and its attitude score; for a
 * guild trace the server notes, the self facts and the learned items. Synchronous with the apply
 * that follows, so every difference is that apply's.
 * @param {object} store
 * @param {string} guildId
 * @param {string[]} userIds
 * @param {string|null} privateUserId  The DM partner of a private trace, else null.
 * @returns {object}  For `traceAfter`.
 */
function traceBefore(store, guildId, userIds, privateUserId = null) {
  const users = new Map();
  for (const id of userIds) {
    const holder = tracedHolder(store, guildId, id, privateUserId);
    users.set(id, {
      json: JSON.stringify(holder),
      episodes: new Set((Array.isArray(holder?.episodes) ? holder.episodes : []).map(episodeKey)),
      score: holder?.affinity?.score ?? 0,
    });
  }
  const guild = privateUserId ? null : store.getGuild(guildId);
  return {
    privateUserId,
    users,
    guildJson: guild ? JSON.stringify(TRACED_GUILD_FIELDS.map((key) => guild[key])) : null,
    learnedIds: new Set((Array.isArray(guild?.learned) ? guild.learned : []).map((item) => item?.id)),
    self: new Set((Array.isArray(guild?.self) ? guild.self : []).filter((fact) => typeof fact === 'string')),
  };
}

/**
 * What changed since `traceBefore`, read from the store right after the apply: the members whose
 * profile changed, the episodes stored new (`itemId` when the episode carries one, else null, and
 * its `key`), the attitude moves (`delta` asked, `applied`, `reason` from the newest history
 * entry; the score difference when no history is kept), the self facts and learned items added,
 * and whether the guild fields changed.
 * @returns {{ users: string[], guild: boolean, episodes: object[], attitude: object[], self: string[],
 *   learned: { id: unknown, text: string }[] }}
 */
function traceAfter(store, guildId, before) {
  const out = { users: [], guild: false, episodes: [], attitude: [], self: [], learned: [] };
  for (const [id, prev] of before.users) {
    const holder = tracedHolder(store, guildId, id, before.privateUserId);
    if (JSON.stringify(holder) !== prev.json) out.users.push(id);
    for (const episode of Array.isArray(holder?.episodes) ? holder.episodes : []) {
      const key = episodeKey(episode);
      if (prev.episodes.has(key)) continue;
      const itemId = typeof episode?.itemId === 'string' && episode.itemId ? episode.itemId : null;
      out.episodes.push({ userId: id, itemId, key, what: episode?.what ?? '', weight: Number.isFinite(episode?.weight) ? episode.weight : null });
    }
    const score = holder?.affinity?.score ?? 0;
    if (score !== prev.score) {
      const history = Array.isArray(holder?.affinity?.history) ? holder.affinity.history : [];
      const last = history.at(-1);
      out.attitude.push({
        userId: id,
        delta: Number.isFinite(last?.delta) ? last.delta : null,
        applied: Number.isFinite(last?.appliedDelta) ? last.appliedDelta : roundScore(score - prev.score),
        reason: typeof last?.reason === 'string' ? last.reason : (holder?.affinity?.reason ?? ''),
      });
    }
  }
  if (before.guildJson !== null) {
    const guild = store.getGuild(guildId);
    out.guild = JSON.stringify(TRACED_GUILD_FIELDS.map((key) => guild[key])) !== before.guildJson;
    out.self = (Array.isArray(guild.self) ? guild.self : []).filter((fact) => typeof fact === 'string' && !before.self.has(fact));
    out.learned = (Array.isArray(guild.learned) ? guild.learned : [])
      .filter((item) => item && !before.learnedIds.has(item.id))
      .map((item) => ({ id: item.id, text: item.text }));
  }
  return out;
}

/**
 * The member ids a memory record names: the given ones, then the `<@id>` tokens of its texts,
 * each once, in order.
 * @param {string[]} ids
 * @param {unknown[]} texts
 * @returns {string[]}
 */
function namedIds(ids, texts) {
  const out = new Set(ids.filter((id) => typeof id === 'string' && id));
  for (const text of texts) for (const id of tokenIds(text)) out.add(id);
  return [...out];
}

/**
 * @param {object} deps
 * @param {object} deps.hot          Live config + prompts; read at the moment of use.
 * @param {object} deps.store
 * @param {object} deps.llm          From createLlm().
 * @param {object} deps.calibrator   From createCalibrator().
 * @param {(guildId: string) => string} deps.getSelfName
 * @param {() => number} [deps.now]
 * @param {(guildId: string, userId: string, reason: string) => void} [deps.onPortraitRequest]
 *   Called once per user for every `raw.portrait` cue a successful `analyze()` collected (see
 *   docs/prompt-contract.md, "Data model") -- src/index.js wires this to
 *   src/memory/warmup.js#createWarmup's `refreshPortrait`, which does the actual rewrite
 *   (`profile.md`, `<draft>`/`<hint>`); this module only reports the cue, never awaits the result.
 *   Omitted -> no-op.
 * @param {{ append: Function }|null} [deps.record]  src/memory/record.js#createRecord: with
 *   features.record exactly true (read at each run) every batch is appended to it as `seen` lines
 *   before it is analyzed (recordBatch); a refused append keeps the batch in the buffer.
 * @param {object|null} [deps.journal]  src/memory/journal.js#createJournal (optional). With
 *   `features.journal` exactly true (read at the moment of use) every applied batch writes one
 *   `memory` record (`writeMemoryRecord`) -- a guild batch to the guild's journal, a private one
 *   to the partner's private journal -- and so does every group of voice writes (stage `voice`);
 *   while `journal.stalled()` says the append store's retry queue is full, no batch and no voice
 *   run is applied (`memory: paused`, reason `append-stalled`, once per streak): the buffers and
 *   the voice queue keep everything until the disk answers. Chat turns are not affected.
 * @param {() => string} [deps.uuid]  Ids of batches (`b-`) and applied results (`r-`).
 * @param {{ stats: (guildId: string) => { pending: number } }|null} [deps.archive]
 *   src/memory/archive.js#createArchive (optional). With `features.archive` exactly true (read at
 *   the moment of use), while its pending queue holds more than `archive.pendingMax` entries (read
 *   then too; config.json's 500) no batch and no voice run is applied (`memory: archive stalled`,
 *   once per streak, and one `notify` line): the buffers keep everything until the drain empties
 *   the queue. What the store archived for a batch's writes (src/memory/store.js#settleArchive)
 *   fills the journal record's `archived`, confirmed copies only; entries sent to the pending
 *   queue instead are logged as `memory: archive deferred` (counts).
 * @param {((text: string) => unknown)|null} [deps.notify]  A status line for the development channel
 *   (src/index.js posts it to `bot.dryRunChannelId`); its failure is ignored.
 * @param {((guildId: string, raw: unknown[], messages: object[]) => unknown)|null} [deps.onIntentionCandidates]
 *   With `features.intentions` exactly true (read at the moment of use), a guild batch's answer
 *   `intentions` and the lines the model saw (src/intentions/service.js#addCandidates); not awaited,
 *   its failure logged.
 * @param {((messageId: string) => object|null)|null} [deps.lineSourcesOf]  Where a line of the
 *   persona's came from (src/intentions/sources.js, the intention service's `lineSources`): taken
 *   with her line into the buffer as its `sources`, so her intention candidates are judged by it
 *   after a restart too.
 */
export function createMemoryUpdater({ hot, store, llm, calibrator, getSelfName, now = Date.now, onPortraitRequest, record = null, journal = null, uuid = randomUUID, archive = null, notify = null, onIntentionCandidates = null, lineSourcesOf = null }) {
  const running = new Set();
  let idleWaiters = []; // resolvers for waitIdle() (/nep pause), notified once running.size hits 0
  const backoffUntil = new Map();
  // Per-guild in-memory factor on the live batch size (1 = normal). Halved on
  // a 'truncated'/'bad-json'/'token-limit' failure so the next attempt for that guild asks
  // for less, floored at MIN_LIVE_BATCH messages (a batch at the floor is
  // backed off too, see recordFailure); deleted (back to 1) on the
  // next success. Never persisted: a restart always starts at normal size.
  const sizeFactors = new Map();
  // Whether the two-stage switch is on while its prompts are not there (the batches run single):
  // `memory: two-stage unavailable` is logged once each time this turns true.
  let twoStageUnavailable = false;
  // The voice run (`runVoice`), per guild: the back-off after failed requests (`failures` in a
  // row, `until` epoch ms), so an outage does not send every due item in turn; when each
  // `memory: voice skipped` reason was last logged; whether the voice prompt was missing at the
  // last run that looked (warned once per change). In memory: a restart starts without them.
  const voiceBackoff = new Map();
  const voiceSkipLogged = new Map();
  let voicePromptMissing = false;
  // Whether the last look found the journal's append store stalled: `memory: paused` is logged
  // once each time this turns true.
  let appendStalled = false;
  // The guilds whose archive queue the last look found over archive.pendingMax: `memory: archive
  // stalled` is logged (and sent to the development channel) once each time a guild enters it.
  const archiveStalled = new Set();
  // The fact ledger (src/behavior/inner.js's `facts`, set by `setFactsSource`) a failed batch is told through, and the
  // batches (a guild's buffer or a member's private buffer, by their key) that already have a `memoryFailed` fact:
  // one per failing batch, not one per back-off retry; the entry goes when that batch is applied or gone.
  let factsSource = null;
  const failedTold = new Set();

  /** Whether memory records are written now: a journal injected and features.journal exactly true (read now). */
  function journalOn() {
    return Boolean(journal) && hot.config.features?.journal === true;
  }

  /**
   * Whether memory application waits for the journal's append store (its retry queue full): only
   * with the journal on. Logs `memory: paused` (reason `append-stalled`) once per streak.
   */
  function appendPaused(guildId) {
    const stalled = journalOn() && typeof journal.stalled === 'function' && journal.stalled() === true;
    if (stalled && !appendStalled) log.warn('memory: paused', { guildId, reason: 'append-stalled' });
    appendStalled = stalled;
    return stalled;
  }

  /**
   * Whether memory application waits for the archive: with features.archive exactly true and an
   * archive injected, its pending queue for the guild holds more than `archive.pendingMax` entries
   * (both read now). Logs `memory: archive stalled` and sends one `notify` line once per streak.
   */
  function archivePaused(guildId) {
    const on = Boolean(archive) && typeof archive.stats === 'function' && hot.config.features?.archive === true;
    const pending = on ? Number(archive.stats(guildId)?.pending) || 0 : 0;
    const pendingMax = hot.config.archive?.pendingMax ?? 500;
    const stalled = on && pending > pendingMax;
    if (stalled && !archiveStalled.has(guildId)) {
      log.warn('memory: archive stalled', { guildId, pending, pendingMax });
      if (typeof notify === 'function') {
        Promise.resolve()
          .then(() => notify(`memory: archive stalled pending=${pending} pendingMax=${pendingMax}`))
          .catch(() => {});
      }
    }
    if (stalled) archiveStalled.add(guildId);
    else archiveStalled.delete(guildId);
    return stalled;
  }

  /**
   * What the store archived for the writes between two marks (src/memory/store.js#settleArchive):
   * `{ archived, deferred }`; nothing to wait for without marks or without a store that archives.
   * A deferral is logged as `memory: archive deferred` (counts).
   */
  async function settleArchive(guildId, marks) {
    if (!marks || marks.from === marks.to || typeof store.settleArchive !== 'function') return { archived: [], deferred: 0 };
    const settled = await store.settleArchive(guildId, marks);
    if (settled.deferred > 0) log.warn('memory: archive deferred', { guildId, deferred: settled.deferred, archived: settled.archived.length });
    return settled;
  }

  /** The store's archive mark now, or null for a store without one. */
  function archiveMark(guildId) {
    return typeof store.archiveMark === 'function' ? store.archiveMark(guildId) : null;
  }

  /**
   * `recordAddressing` over a consumed batch with the live `config.memory`; a store that cannot
   * be read (a hand-broken profile) costs the count, never the batch: logged, 0 returned.
   */
  function recordAddressingSafely(guildId, consumed) {
    try {
      // Her inner-turn lines (src/memory/inner-episode.js) are no chat: no name in them is an address.
      return recordAddressing(store, guildId, consumed.filter((message) => !message?.inner), hot.config.memory ?? {});
    } catch (err) {
      log.warn('memory: address count left out', { guildId, reason: 'store-error', error: errorNameOf(err) });
      return 0;
    }
  }

  /**
   * `runVoiceWrites`, journalled: with the journal on, the writes are grouped by audience (the
   * server's, or one member's private layer, whose record goes to that member's private journal),
   * each group traced around its writes and recorded as one `memory` record of stage `voice`
   * (not awaited: the journal never rejects). `limits` (a collector, optional): what the voice
   * request behind the writes hit; a voice request serves one audience, so its list goes on each
   * group's record.
   * @returns {number}  runVoiceWrites' count.
   */
  function voiceWrites(guildId, writes, config, nowMs, limits = null) {
    if (!journalOn() || writes.length === 0) return runVoiceWrites(store, guildId, writes, config, nowMs);
    const groups = new Map();
    for (const write of writes) {
      const key = write.layer === 'private' && write.userId != null ? String(write.userId) : '';
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(write);
    }
    let landed = 0;
    for (const [key, group] of groups) {
      const privateUserId = key || null;
      const ids = privateUserId ? [privateUserId] : [...new Set(group.map((write) => write.userId).filter((id) => id != null).map(String))];
      const before = traceBefore(store, guildId, ids, privateUserId);
      const from = archiveMark(guildId);
      landed += runVoiceWrites(store, guildId, group, config, nowMs);
      const to = archiveMark(guildId);
      const trace = traceAfter(store, guildId, before);
      const input = { batchId: `b-${uuid()}`, stage: 'voice', messages: [], trace, limits: limits?.list() ?? [], privateUserId };
      // Without archive entries the record goes at once; with some, once the archive answered.
      if (from === to) writeMemoryRecord(guildId, input);
      else {
        settleArchive(guildId, { from, to })
          .then(({ archived }) => writeMemoryRecord(guildId, { ...input, archived }))
          .catch((err) => log.warn('memory: journal record failed', { guildId, stage: 'voice', error: errorNameOf(err) }));
      }
    }
    return landed;
  }

  /**
   * One `memory` journal record from an applied result (see createMemoryUpdater's `journal`).
   * Never rejects (the journal logs a failed append).
   * @param {string} guildId
   * @param {{ batchId: string, stage: string, messages: object[], trace: object, result?: object|null,
   *   limits?: object[], privateUserId?: string|null, archived?: object[] }} input
   *   `messages`: the lines the batch consumed (none for voice writes); `trace`: traceAfter's;
   *   `archived`: settleArchive's confirmed entries.
   */
  function writeMemoryRecord(guildId, { batchId, stage, messages, trace, result = null, limits = [], privateUserId = null, archived = [] }) {
    const messageIds = messages.map((message) => message?.id).filter((id) => typeof id === 'string' && id);
    const named = [...trace.users, ...trace.episodes.map((ep) => ep.userId), ...trace.attitude.map((move) => move.userId), ...batchAuthorIds(messages)];
    const texts = [...trace.episodes.map((ep) => ep.what), ...trace.attitude.map((move) => move.reason), ...trace.self, ...trace.learned.map((item) => item.text)];
    return journal.memory(guildId, {
      batchId,
      stage,
      appliedRevision: `r-${uuid()}`,
      batch: { messageIds, consumed: messages.length },
      changed: {
        users: trace.users,
        guild: trace.guild || result?.guild === true,
        channels: Array.isArray(result?.changedChannels) ? [...result.changedChannels] : [],
        lore: Number.isFinite(result?.lore) ? result.lore : 0,
      },
      episodes: trace.episodes,
      attitude: trace.attitude,
      self: trace.self,
      learned: trace.learned,
      consolidation: [],
      // Only the copies the archive confirmed (store.settleArchive).
      archived: archived.map(({ itemId, revisionId }) => ({ itemId, revisionId, confirmed: true })),
      limits,
      promptsHash: hot.hashes?.promptsHash ?? null,
      configHash: hot.hashes?.configHash ?? null,
      participants: namedIds(privateUserId ? [privateUserId, ...named] : named, texts),
      sourceMessageIds: messageIds,
      privateUserId,
    });
  }

  /**
   * The analyzer one batch runs (`analyzerMode`), read from the live config and prompts at the
   * moment of use. With the switch on and a prompt missing it runs today's single-stage path (on
   * the voice model, see `batchRequestOptions`) and warns once per change of that state (again
   * only after the prompts came back and went again).
   * @returns {'single'|'two'}
   */
  function stageOfBatch() {
    const stage = analyzerMode(hot.config, hot.prompts);
    const unavailable = hot.config.features?.memoryTwoStage === true && stage === 'single';
    if (unavailable && !twoStageUnavailable) {
      log.warn('memory: two-stage unavailable', { reason: 'no-prompt', missing: missingTwoStagePrompts(hot.prompts) });
    }
    twoStageUnavailable = unavailable;
    return stage;
  }

  /**
   * Called for every guild message the persona sees, including its own.
   * `direct` marks a message addressed to the persona (a trigger), so the
   * analyzer can tell how people talk TO it apart from general chatter.
   * `private` (the DM partner's id, also for the persona's own DM lines)
   * routes the message into that member's private buffer instead: no public
   * counters, no channel map entry, no guild buffer.
   */
  function observe(guildId, normalized, { direct = false, private: privateUserId = null } = {}) {
    // /nep pause: nothing may make the store dirty while paused.
    if (store.state.data.paused) return;
    if (normalized.bot) return;
    if (!privateUserId) {
      touchMemory(store, guildId, normalized, { ...hot.config.memory, diaryChannelId: hot.config.diary?.channelId || null });
    }
    // The GIF library (src/memory/gifs.js) is fed here, not after the batch:
    // it needs the GIF's URL, and no URL survives into the buffer below. A
    // private chat never feeds it; the persona's own GIFs are skipped there.
    if (!privateUserId && hot.config.features?.gifs !== false) {
      const gifs = store.recordGifs(guildId, [normalized], gifOpts(hot.config));
      if (gifs > 0) log.info('memory: gifs recorded', { guildId, gifs });
    }

    const slim = slimMessage(normalized, direct);
    // Her own line keeps where it came from (src/intentions/sources.js): her intention candidates
    // are judged by it. Never on a private line (no candidates come from a private chat).
    if (normalized.self === true && !privateUserId && typeof lineSourcesOf === 'function') {
      try {
        const sources = lineSourcesOf(String(normalized.id ?? ''));
        if (sources) slim.sources = sources;
      } catch {
        // No note: the candidate check asks again, and counts a line with none as external.
      }
    }
    const cfg = hot.config.memory;
    // The cap drops the oldest buffered messages before any analyzer saw them (the analyzer
    // is failing or backed off): say so, with the count only. A private line never names the member.
    if (privateUserId) {
      const dropped = store.pushPrivateBuffer(guildId, String(privateUserId), slim, cfg.batchMessages * 3);
      if (dropped > 0) log.info('memory: private buffer trimmed', { guildId, dropped });
    } else {
      const dropped = store.pushBuffer(guildId, slim, cfg.batchMessages * 3);
      if (dropped > 0) log.info('memory: buffer trimmed', { guildId, dropped });
    }
  }

  /**
   * What the persona did and found on her own in an inner turn (`episode`:
   * src/behavior/turn.js#innerEpisodeOf, handed over by src/behavior/inner.js), as lines of hers in
   * the memory buffer (src/memory/inner-episode.js#innerEpisodeLines, `innerLife.memory` and
   * `labels.memory.inner` read now): the next analyzer batch builds memory from them like from
   * any line of hers. A private chat's episode goes to that member's private buffer only, never
   * the server's. Nothing while paused, with `innerLife.memory.enabled` false or nothing found.
   * Logs counts only. Never throws.
   * @returns {number}  The lines buffered.
   */
  function observeInner(guildId, episode) {
    try {
      if (store.state.data.paused || !guildId || !episode) return 0;
      const lines = innerEpisodeLines(episode, { labels: hot.prompts?.labels ?? {}, settings: innerMemorySettings(hot.config), maxChars: hot.config.context?.maxMessageChars ?? 0 });
      if (lines.length === 0) return 0;
      const batch = hot.config.memory?.batchMessages;
      const cap = Number.isFinite(batch) && batch > 0 ? batch * 3 : Infinity;
      const privateUserId = episode.privateUserId ? String(episode.privateUserId) : null;
      let dropped = 0;
      for (const line of lines) dropped += privateUserId ? store.pushPrivateBuffer(guildId, privateUserId, line, cap) : store.pushBuffer(guildId, line, cap);
      const sources = lines.reduce((sum, line) => sum + (line.inner?.sources?.length ?? 0), 0);
      log.info('memory: inner episode buffered', { guildId, lines: lines.length, sources, shadow: episode.shadow === true, ...(privateUserId ? { private: true } : {}), ...(dropped > 0 ? { dropped } : {}) });
      return lines.length;
    } catch (err) {
      log.warn('memory: inner episode left out', { guildId, error: errorNameOf(err) });
      return 0;
    }
  }

  /**
   * The stored profiles/channels `analyze()` needs for `messages`, plus the
   * distinct author/channel ids they were built from. Read before the request
   * is fitted, so it covers the whole batch; the apply takes its
   * `knownUserIds`/`knownChannelIds` from the consumed lines only.
   */
  function collectContext(guildId, messages) {
    return batchContext(
      messages,
      (id) => store.getUser(guildId, id),
      (id) => store.getChannel(guildId, id),
    );
  }

  /**
   * The one analyzer code path: build the memory-update request from
   * `messages`, send it to the LLM, parse the reply and apply it to the
   * store. Used by `run()` (a batch shifted off the live buffer); the memory
   * warmup (src/memory/warmup.js) does not go through this path at all
   * — it calls `profile.md`/`channel.md`/`server.md` and applyMemoryUpdate
   * directly. Never touches the live buffer and never throws — a failure is
   * reported in the returned `error`, not raised.
   *
   * `usage`/`estimated` reflect a completion whenever one was actually
   * received from the provider — including when `ok: false` because parsing
   * or applying the answer failed afterwards, since those tokens were billed
   * regardless. Only a failure before/without a completion (a build error,
   * `TokenLimitError`, a network/provider error, a missing prompt) reports
   * `usage: null, estimated: 0`: nothing was spent.
   *
   * A success also carries `consumed`/`shown`/`deferred`: the oldest `shown` of `messages`, the
   * lines the request's transcript held, are the only ones consumed (`consumed === shown`; the
   * caller removes those from its buffer), the other `deferred` did not fit the token cap and wait
   * for the next batch; the answer is applied against the consumed lines only (authors, channels,
   * dates). `roster`: how many members the request's `<known_members>` carried, i.e. members
   * who did not write in the batch (see `buildMemoryRequest`), of
   * `rosterCandidates` offered, taking `rosterTokens`. Of the non-authors,
   * only those sent may get anything from the answer: an alias.
   * `profilesWhole` / `profilesCompact` / `profilesTokens`: how many profiles went whole and
   * compact, and the tokens of `<existing_profiles>` (see `buildMemoryRequest`).
   * `staleRelationships`: how many profiles went with a `relationshipStale` marker;
   * `relationshipRewrites`: how many of them with cause `rewrite`.
   * `staleNotes`: the channel ids and whether the server notes went with a stale marker.
   * `recentShown`: how many live recent lines the request's `<recent_notes>` carried (read from
   * the store only while `features.recent` is on); the answer's `recent` field may remove only
   * those, and its adds are dated and placed by this batch's messages (`resolveMoment`).
   *
   * With `features.memoryTwoStage` on, the request is stage A (see `analyzerMode`,
   * `applyDecision`): its neutral part is stored at once, its briefs are queued for the voice
   * model, and `result` also carries the queue counts (`voiceQueued`, `voiceOverflow`,
   * `voiceDegraded`, `voiceDropped`). Every outcome then carries `stage`: the analyzer that ran
   * (`two`, or `single` when a two-stage prompt is missing: today's request, sent on the voice
   * model). With the switch off there is no `stage` and everything is as before.
   *
   * @param {string} guildId
   * @param {object[]} messages  Slim messages (oldest first) to summarize; NOT read from or removed off any buffer.
   * @returns {Promise<{ ok: boolean, usage: object|null, estimated: number, result: object|null, consumed?: number,
   *   shown?: number, deferred?: number, roster?: number, rosterCandidates?: number, rosterTokens?: number,
   *   profilesWhole?: number, profilesCompact?: number, profilesTokens?: number, staleRelationships?: number, relationshipRewrites?: number, recentShown?: number, staleNotes?: { channels: string[], guild: boolean },
   *   error?: Error, stage?: 'single'|'two' }>}
   */
  async function analyze(guildId, messages) {
    return analyzeBatch(
      guildId,
      messages,
      () => {
        const context = collectContext(guildId, messages);
        // The roster's pool: every stored profile, listed only while the roster is on. A stored
        // profile that cannot be read (hand-edited while paused) costs this batch its roster,
        // never the batch: this runs outside analyzeBatch's try.
        let rosterProfiles = [];
        if (aliasRosterSize(hot.config) > 0) {
          try {
            rosterProfiles = store.listUserProfiles(guildId);
          } catch (err) {
            log.warn('memory: alias roster left out', { guildId, reason: 'store-error', error: errorNameOf(err) });
          }
        }
        // The live recent lines the analyzer is shown, read only while the layer is on; a fake
        // store without the recent store (tests) shows none.
        const recentLines = recentSettings(hot.config) && typeof store.getRecent === 'function' ? store.getRecent(guildId).lines : [];
        // Every stored channel, for the server notes' accumulated activity; a fake store without
        // the list (tests) counts the batch's channels.
        // A channel that cannot be read costs the server notes their marker, never the batch.
        let guildChannels;
        if (typeof store.listChannels === 'function') {
          try {
            guildChannels = store.listChannels(guildId);
          } catch (err) {
            guildChannels = [];
            log.warn('memory: guild channels left out', { guildId, reason: 'store-error', error: errorNameOf(err) });
          }
        }
        return { profiles: context.profiles, channels: context.channels, guildChannels, rosterProfiles, recentLines, now: now() };
      },
      (update, { relationships, episodes, lore, recent }, { rosterIds, recentIds, rewriteIds, stage, nowMs, consumed, limits }) => {
        const cfg = hot.config.memory;
        // Only the lines the model saw (`consumed`, the batch's oldest): an author or a channel
        // whose lines were all deferred is written by the batch that shows them.
        const knownUserIds = new Set(batchAuthorIds(consumed));
        const knownChannelIds = new Set(batchChannelIds(consumed).map(String));
        const options = {
          knownChannelIds,
          aliasOnlyIds: new Set(rosterIds),
          relationships,
          episodes,
          lore,
          // Where and when each line happened is read off this batch; a remove takes only a line
          // the request showed.
          recent: recent && {
            ...recent,
            messages: consumed,
            timezone: hot.config.bot?.timezone,
            locale: hot.prompts.labels?.locale,
            shownIds: new Set(recentIds),
          },
          timing: computeSeenAt(consumed),
          batchAuthorNames: batchAuthorNamesMap(consumed),
          relationshipChars: voiceLimits(hot.config).relationship,
          by: 'analyzer',
          versions: { enabled: hot.config.features?.versions !== false, kept: hot.config.memory?.versionsKept ?? 20 },
          limits,
        };
        // The intention candidates of the persona's own lines (features.intentions exactly true,
        // read now): the answer's `intentions` and the lines the model saw go to the intentions
        // service, which anchors, filters and stores them as `proposed` (src/intentions/service.js).
        if (hot.config.features?.intentions === true && typeof onIntentionCandidates === 'function' && Array.isArray(update?.intentions) && update.intentions.length > 0) {
          Promise.resolve()
            .then(() => onIntentionCandidates(guildId, update.intentions, consumed))
            .catch((err) => log.warn('memory: intention candidates failed', { guildId, error: errorNameOf(err) }));
        }
        // Stage A drops every portrait key, the `portrait` cue included: nothing to report.
        // A forced rewrite is queued for the voice run even when stage A gave no brief for it.
        if (stage === 'two') return applyDecision(store, guildId, update, hot.config, knownUserIds, { ...options, rewriteIds: new Set(rewriteIds) }, nowMs);
        const result = applyMemoryUpdate(store, guildId, update, cfg, knownUserIds, options);

        if (typeof onPortraitRequest === 'function') {
          for (const { userId, reason } of result.portraitRequests) onPortraitRequest(guildId, userId, reason);
        }
        return result;
      },
    );
  }

  /**
   * The private-chat analyzer path, same shape and same guarantees as
   * `analyze()` (never throws, never touches a buffer, same LLM options):
   * `messages` are one member's direct messages with the persona. The request
   * (see `buildMemoryRequest`'s `privateChat`) carries ONLY that member's
   * private layer, with the effective affinity (src/behavior/private.js
   * #effectiveAffinity) carrying the private layer's own attitude history (only
   * `relationshipStale`'s `moves` reads it; the model sees score, band and
   * reason), plus their public profile as read-only prose and the
   * usual read-only guild/lore context; only `users[userId]` of the answer is
   * applied, to the private layer (`applyPrivateUpdate`). A success stamps the
   * private layer's `lastSeen` (and `firstSeen` the first time). With
   * `features.memoryTwoStage` on, the same split as `analyze()`'s
   * (`applyPrivateDecision`): the neutral part lands in the private layer
   * only, the briefs are queued as that member's private items, and the
   * outcome carries `stage` and `result` the queue counts, as `analyze()`'s.
   * @param {string} guildId
   * @param {string} userId  The DM partner.
   * @param {object[]} messages  Slim buffered direct messages, oldest first.
   * @returns {Promise<{ ok: boolean, usage: object|null, estimated: number, result: object|null, consumed?: number,
   *   shown?: number, deferred?: number, roster?: number, rosterCandidates?: number, rosterTokens?: number,
   *   profilesWhole?: number, profilesCompact?: number, profilesTokens?: number, staleRelationships?: number, recentShown?: number, staleNotes?: { channels: string[], guild: boolean },
   *   error?: Error, stage?: 'single'|'two' }>}
   *   `consumed`/`shown`/`deferred` as `analyze()`'s. The `roster*` counts and `recentShown` are
   *   always 0 here and `staleNotes` empty: a private batch carries no `<known_members>`, no
   *   `<recent_notes>` and no notes marker, and its `recent` field is dropped and counted.
   *   `staleRelationships` is 0 or 1: the partner's private text went with a marker or not.
   */
  async function analyzePrivate(guildId, userId, messages) {
    const id = String(userId);
    return analyzeBatch(
      guildId,
      messages,
      () => {
        const publicProfile = store.getUser(guildId, id);
        const privateProfile = store.getPrivate(guildId, id) ?? {};
        // The private moves and the private text's `relationshipWrittenAt` are both stamped on
        // the private batch clock (applyPrivateUpdate), so `moves` compares like with like; a
        // public move reaches the private text only through the effective score.
        const privateHistory = Array.isArray(privateProfile.affinity?.history) ? privateProfile.affinity.history : [];
        const affinity = { ...effectiveAffinity(publicProfile?.affinity, privateProfile.affinity), history: privateHistory };
        const view = { ...privateProfile, affinity };
        return { profiles: { [id]: view }, channels: {}, privateChat: { publicProfile, now: now() } };
      },
      (update, { relationships, episodes }, { stage, nowMs, consumed, limits }) => {
        const options = {
          relationships,
          episodes,
          timing: computeSeenAt(consumed),
          batchAuthorNames: batchAuthorNamesMap(consumed),
          relationshipChars: voiceLimits(hot.config).relationship,
          limits,
        };
        const result =
          stage === 'two'
            ? applyPrivateDecision(store, guildId, id, update, hot.config, options, nowMs)
            : applyPrivateUpdate(store, guildId, id, update, hot.config.memory, options);
        store.touchPrivateSeen(guildId, id, now());
        return result;
      },
      { privateUserId: id },
    );
  }

  /**
   * The picture/video/page captions the media cache already holds for the
   * items of `messages` (see `analyze()`), each `null` when its switch is off.
   */
  function cachedMedia(guildId, messages) {
    // The live analyzer never triggers a NEW description request itself --
    // the buffered messages carry no URL to describe from anyway (see
    // observe() above). It only reads whatever src/behavior/pipeline.js has
    // already warmed into the cache for these item ids, fire-and-forget, as
    // the messages came in; a cache miss just renders blind.
    let descriptions = null;
    if (hot.config.features?.mediaDescriptions === true) {
      const cache = store.getMediaCache(guildId);
      descriptions = new Map();
      // A forwarded snapshot's items are looked up exactly like the
      // message's own (see mediaParts).
      for (const part of messages.flatMap(mediaParts)) {
        for (const item of [...(part.attachments ?? []), ...(part.links ?? [])]) {
          if (item.id == null || !isDescribable(item)) continue;
          const cached = cache[item.id];
          if (cached && !cached.miss) descriptions.set(item.id, cached.text);
        }
        // Stickers/emoji keep no URL in the buffer (see observe() above) --
        // stickerUrl rebuilds it from id/format only to tell a Lottie
        // sticker (never describable) apart, the cache is still looked up by
        // the stable `sticker:<id>` / `emoji:<id>` key alone.
        for (const sticker of part.stickers ?? []) {
          if (!stickerUrl(sticker.id, sticker.format)) continue;
          const itemId = `sticker:${sticker.id}`;
          const cached = cache[itemId];
          if (cached && !cached.miss) descriptions.set(itemId, cached.text);
        }
        for (const emoji of part.emojis ?? []) {
          const itemId = `emoji:${emoji.id}`;
          const cached = cache[itemId];
          if (cached && !cached.miss) descriptions.set(itemId, cached.text);
        }
      }
    }

    // Videos the video describer already watched (or refused for good) are
    // read from the same cache under `video:<item id>`, by the describer's own
    // rules (videoStateFromCache); an error miss or no entry at all renders the
    // plain form. Never a request from here. Video vision must be on, like the
    // senses line (isVideoVisionOn).
    let videos = null;
    if (isVideoVisionOn(hot.config)) {
      const cache = store.getMediaCache(guildId);
      videos = new Map();
      for (const part of messages.flatMap(mediaParts)) {
        const items = [...(part.attachments ?? []).filter((a) => a.kind === 'video'), ...(part.links ?? [])];
        for (const item of items) {
          if (item.id == null) continue;
          const state = videoStateFromCache(cache[`video:${item.id}`], hot.config, item);
          if (state) videos.set(item.id, state);
        }
      }
    }

    // Pages the web lookup already read (src/web/lookup.js) are read from the
    // same cache under `read:<link id>`; a miss or no entry renders the plain
    // link. Never a request from here. features.webLookup: unlike the other
    // switches a missing key counts as OFF.
    let reads = null;
    if (hot.config.features?.webLookup === true && hot.config.web?.links?.enabled !== false) {
      const cache = store.getMediaCache(guildId);
      reads = new Map();
      for (const part of messages.flatMap(mediaParts)) {
        for (const link of part.links ?? []) {
          if (link.id == null) continue;
          const cached = cache[`read:${link.id}`];
          if (cached && !cached.miss && typeof cached.text === 'string') reads.set(link.id, cached.text);
        }
      }
    }
    return { descriptions, videos, reads };
  }

  /** The `relationships`/`episodes`/`lore`/`recent` arguments of the apply functions, from the live config (see memorySwitches). */
  function applySwitches() {
    return memorySwitches(hot.config, now);
  }

  /**
   * Build, send, parse, apply: the body shared by `analyze()` and
   * `analyzePrivate()`. `requestInput()` (called only once a memory prompt is
   * configured) returns the mode-specific `buildMemoryRequest` fields;
   * `applyUpdate(update, switches, { rosterIds, recentIds, rewriteIds, stage, nowMs, consumed })` stores the parsed answer and
   * returns the result to report (`rosterIds` / `recentIds`: the roster members and the recent
   * lines the request carried, see `buildMemoryRequest`; `rewriteIds`: in the `two` stage only, the
   * members sent with a forced-rewrite marker; `stage`: `analyzerMode`'s; `nowMs`: in the
   * `two` stage only, the one clock value the switches carry as `now`, for the split
   * and the neutral write alike; `consumed`: the batch's oldest messages the request showed, the
   * only ones the answer is applied against). A failure's `reason`: 'no-prompt', 'token-limit',
   * 'daily-cap' (the llm's daily request cap, or the voice model's), 'llm-error' (nothing billed),
   * 'truncated', 'bad-json' (the answer did not parse) or 'apply-error' (it parsed, the store
   * refused it) -- the same in both stages, so a failed stage A batch is halved or backed off
   * exactly as today.
   * With `features.memoryTwoStage` on, every outcome carries `stage`, and the request goes out
   * on the model `batchRequestOptions` names: stage A on `models.helpers.extractor`, the single-stage
   * fallback (a two-stage prompt missing) on the voice model as a memory-wording request
   * (purpose `memory-voice`), which counts
   * against `memory.voice.maxPerDay` like a voice run's request (`countVoiceRequest`): with
   * the rail reached nothing is sent and the reason is 'daily-cap' (backed off, not halved); a
   * request the llm refuses before sending gives its count back.
   */
  async function analyzeBatch(guildId, messages, requestInput, applyUpdate, { privateUserId = null } = {}) {
    const stage = stageOfBatch();
    // The journal's view of this batch (read once, before the request): what bit, what changed.
    const limits = journalOn() ? createLimits() : null;
    // Said only while the switch is on: with it off, outcomes and log lines are as before.
    const marker = hot.config.features?.memoryTwoStage === true ? { stage } : {};
    const promptText = stage === 'two' ? hot.prompts['memory-decide'] : hot.prompts.memory;
    if (!promptText) {
      log.warn('memory: no memory prompt configured, skipping', { guildId });
      return { ok: false, usage: null, estimated: 0, result: null, reason: 'no-prompt', ...marker };
    }

    const input = requestInput();
    const { descriptions, videos, reads } = cachedMedia(guildId, messages);

    let completion;
    let fit; // the request's { consumed, shown, deferred, roster, rosterCandidates, rosterTokens, profilesWhole, profilesCompact, profilesTokens, staleRelationships, relationshipRewrites, recentShown, staleNotes }, reported with a success
    let rosterIds = []; // the roster members the request carried: the only non-authors an answer may give an alias
    let recentIds = []; // the recent lines the request carried: the only ones an answer may remove
    let rewriteIds = []; // the members sent with a forced-rewrite marker: stage A queues their voice items
    let consumedMessages = []; // the oldest messages the request showed: the only ones the answer is applied against
    let voiceDay = null; // the UTC day a memory-wording request counts for (the single-stage fallback)
    try {
      const {
        messages: llmMessages,
        consumed,
        shown,
        deferred,
        rosterIds: sentRoster,
        rosterCandidates,
        rosterTokens,
        profilesWhole,
        profilesCompact,
        profilesTokens,
        staleRelationships,
        relationshipRewrites,
        rewriteIds: sentRewrites,
        recentShown,
        recentIds: sentRecent,
        staleNotes,
      } = buildMemoryRequest({
        prompts: hot.prompts,
        config: hot.config,
        calibrator,
        guildMemory: store.getGuild(guildId),
        messages,
        selfName: getSelfName(guildId),
        loreEntries: store.getLore(guildId),
        descriptions,
        videos,
        reads,
        nameOf: storeNameOf(store, guildId),
        ...input,
        stage: stage === 'two' ? 'decide' : 'single',
      });
      fit = { consumed, shown, deferred, roster: sentRoster.length, rosterCandidates, rosterTokens, profilesWhole, profilesCompact, profilesTokens, staleRelationships, relationshipRewrites, recentShown, staleNotes };
      rosterIds = sentRoster;
      rewriteIds = sentRewrites ?? [];
      recentIds = sentRecent;
      consumedMessages = messages.slice(0, consumed);

      const options = limits ? { ...batchRequestOptions(hot.config, stage), limits } : batchRequestOptions(hot.config, stage);
      if (options.purpose === MEMORY_VOICE_REQUEST.purpose) {
        const sendMs = now();
        if (voiceRailReached(sendMs)) return { ok: false, usage: null, estimated: 0, result: null, reason: 'daily-cap', ...marker };
        voiceDay = countVoiceRequest(sendMs);
      }
      completion = await llm.complete(llmMessages, options);
    } catch (err) {
      // Refused before sending: a memory-wording request that never went out does not count.
      if (voiceDay !== null && (err instanceof DailyCapError || err instanceof TokenLimitError)) releaseVoiceRequest(voiceDay);
      // Nothing was billed: the request never left this process, or the
      // provider never returned a completion. `status` (the HTTP status when
      // the error carries one, e.g. 429) lets a caller tell a rate limit apart
      // from a genuine failure without parsing `detail`.
      // A `SectionsTooLargeError` (buildMemoryRequest's fitSections could not
      // even fit the required sections -- the prompt, the notes and every
      // author's compact profile -- or not one transcript line beside them) is the
      // same kind of failure as a `TokenLimitError` from the provider call
      // itself: the request does not fit the per-request token cap, full stop.
      // Both surface as 'token-limit' so a caller can split the batch instead
      // of retrying it unchanged. The llm's daily cap is 'daily-cap' (backed
      // off, not halved), anything else 'llm-error'.
      const reason = err instanceof SectionsTooLargeError ? 'token-limit' : railReason(err);
      return { ok: false, usage: null, estimated: 0, result: null, error: err, reason, detail: detailOf(err), status: err?.statusCode, ...marker };
    }

    const usage = completion.usage ?? null;
    const estimated = completion.estimated ?? 0;
    let update;
    try {
      update = parseJsonObject(completion.text);
    } catch (err) {
      // The completion arrived (and was billed) but its answer was garbage:
      // report the real usage/estimated so a caller charging a budget still
      // charges it. `reason` tells a cut-off completion (never going to
      // parse, no matter how many times it is retried) from plain bad JSON.
      const reason = looksTruncated(completion.text, completion.finishReason) ? 'truncated' : 'bad-json';
      return { ok: false, usage, estimated, result: null, error: err, reason, detail: errorNameOf(err), ...marker };
    }

    try {
      let result;
      // Read right before the apply, with nothing awaited in between: every difference is its own.
      const traceIds = privateUserId ? [privateUserId] : [...new Set([...(isPlainObject(update?.users) ? Object.keys(update.users) : []), ...batchAuthorIds(consumedMessages)])];
      const before = limits ? traceBefore(store, guildId, traceIds, privateUserId) : null;
      const archiveFrom = archiveMark(guildId);
      if (stage === 'two') {
        // One clock read for the whole stage A apply: the split addresses the attitude move and
        // the episodes it stores by this instant, so the switches stamp them with it too.
        const nowMs = now();
        result = applyUpdate(update, memorySwitches(hot.config, () => nowMs), { rosterIds, recentIds, rewriteIds, stage, nowMs, consumed: consumedMessages, limits });
      } else {
        result = applyUpdate(update, applySwitches(), { rosterIds, recentIds, stage, consumed: consumedMessages, limits });
      }
      const journalled = before ? { trace: traceAfter(store, guildId, before), limits: limits.list() } : {};
      const archiveMarks = { from: archiveFrom, to: archiveMark(guildId) };
      return { ok: true, usage, estimated, result, ...fit, ...marker, ...journalled, archiveMarks };
    } catch (err) {
      // A parsed answer the store failed to take: not the answer's size, so the batch is not
      // halved (see recordFailure). Logged by the error's name only.
      log.warn('memory: the analyzer answer could not be applied', { guildId, reason: 'apply-error', error: errorNameOf(err), ...marker });
      return { ok: false, usage, estimated, result: null, error: err, reason: 'apply-error', detail: errorNameOf(err), ...marker };
    }
  }

  /**
   * Resolve the waiters of `waitIdle()` once nothing is in flight any more.
   * @param {string} key  A guild id, or a `privateKey`.
   */
  function settle(key) {
    running.delete(key);
    if (running.size === 0 && idleWaiters.length > 0) {
      const waiters = idleWaiters;
      idleWaiters = [];
      for (const resolve of waiters) resolve();
    }
  }

  /** How many buffered messages the next batch for `key` takes (see `sizeFactors`). */
  function batchTake(key, bufferLength) {
    const cfg = hot.config.memory;
    const factor = sizeFactors.get(key) ?? 1;
    const normalTake = cfg.batchMessages * 2;
    // Only the degraded (factor < 1) path is floored at MIN_LIVE_BATCH; the
    // normal size is left exactly as configured either way.
    const desired = factor === 1 ? normalTake : Math.max(MIN_LIVE_BATCH, Math.floor(normalTake * factor));
    return Math.min(bufferLength, desired);
  }

  /**
   * The batch for `key` that could not be applied, told to her once as a `memoryFailed` fact (the code and how many
   * lines wait); a private batch's only in that private chat. Nothing while the ledger is off or absent (then it is
   * a log line only). Never throws.
   * @param {string} key
   * @param {{ reason: string }} outcome
   * @param {{ guildId: string, waiting: number, channelId?: string|null, privateChat?: boolean }} where
   */
  function tellFailure(key, outcome, { guildId, waiting, channelId = null, privateChat = false }) {
    if (failedTold.has(key)) return;
    try {
      if (factsSource?.enabled?.() !== true) return;
      factsSource.add(guildId, { kind: 'memoryFailed', code: outcome.reason, waiting, channelId, privateChat, at: now() });
      failedTold.add(key);
    } catch (err) {
      log.warn('memory: the failure could not be told', { guildId, code: err?.code ?? null });
    }
  }

  /**
   * A failed batch for `key`: halve the next batch or back off, and log it. A size failure
   * ('truncated', 'bad-json', 'token-limit') of a batch already at the floor (`sent` at most
   * MIN_LIVE_BATCH messages) is backed off as well: halving cannot shrink it any more, so the
   * next tick would send, and pay for, the same batch again. The buffer is kept either way.
   * @param {string} key
   * @param {object} outcome  From `analyze()` / `analyzePrivate()`.
   * @param {string} what     The log message prefix.
   * @param {object} fields   Extra log fields (counts and the guild id only).
   * @param {number} sent     How many buffered messages the failed batch took.
   */
  function recordFailure(key, outcome, what, fields, sent, tell = null) {
    if (outcome.reason === 'apply-error' && tell) tellFailure(key, outcome, tell);
    const sizeFailure = outcome.reason === 'truncated' || outcome.reason === 'bad-json' || outcome.reason === 'token-limit';
    if (sizeFailure && sent <= MIN_LIVE_BATCH) {
      // Still halved, so the batch after the back-off stays at the floor instead of the normal size.
      sizeFactors.set(key, (sizeFactors.get(key) ?? 1) / 2);
      backoffUntil.set(key, now() + BACKOFF_MS);
      log.warn(`${what} failed, backing off`, {
        ...fields,
        reason: outcome.reason,
        detail: outcome.detail,
        atFloor: true,
        backoffMs: BACKOFF_MS,
      });
    } else if (sizeFailure) {
      // Retrying the same-size batch can never succeed: 'truncated'/'bad-json'
      // means the completion is being cut by the output cap, and 'token-limit'
      // means the request itself (the compact profiles of its authors
      // included) does not fit the per-request cap -- neither is transient
      // bad luck. A plain back-off would just retry the exact same buffer
      // forever: halve the batch size for next time instead, same as the
      // output-cap case, so the following attempt asks for fewer messages and
      // pulls in fewer distinct authors. Whole profiles never fail a request:
      // one that does not fit is sent compact (buildMemoryRequest).
      sizeFactors.set(key, (sizeFactors.get(key) ?? 1) / 2);
      log.warn(`${what} failed, halving the batch size for next time`, {
        ...fields,
        reason: outcome.reason,
        detail: outcome.detail,
      });
    } else {
      backoffUntil.set(key, now() + BACKOFF_MS);
      log.warn(`${what} failed, backing off`, {
        ...fields,
        reason: outcome.reason,
        detail: outcome.detail,
        // An apply error is reported by name only (see analyzeBatch).
        error: outcome.reason === 'apply-error' ? undefined : outcome.error,
      });
    }
  }

  /**
   * Append the batch `messages` to the record (src/memory/record.js) as `seen` lines, with
   * features.record exactly true (read now) and a record injected; a line already recorded (a
   * batch retried after a failure) is refused there. The reply target's author is taken from
   * `buffer` when the replied message is in it. A private batch (`privateUserId`) goes to the
   * member's private record. Resolves false when the append was refused (`memory: record
   * failed`, counts only): the batch must stay in the buffer, unanalyzed, for the next run.
   * @param {string} guildId
   * @param {object[]} messages  The batch's slim messages.
   * @param {object[]} buffer    The whole buffer the batch was taken from.
   * @param {string|null} [privateUserId]
   * @returns {Promise<boolean>}
   */
  async function recordBatch(guildId, messages, buffer, privateUserId = null) {
    // The record keeps the chat: her inner-turn lines (src/memory/inner-episode.js) were never said.
    messages = messages.filter((message) => !message?.inner);
    if (!record || hot.config.features?.record !== true || messages.length === 0) return true;
    const authors = new Map();
    for (const message of buffer) if (message?.id != null) authors.set(String(message.id), message.authorId ?? null);
    const lines = messages.map((message) => {
      const replyToAuthorId = message?.replyToId ? (authors.get(String(message.replyToId)) ?? null) : null;
      return toRecordLine(replyToAuthorId ? { ...message, replyToAuthorId } : message, { now });
    });
    try {
      await record.append(guildId, lines, privateUserId ? { privateUserId } : {});
      return true;
    } catch (err) {
      log.warn('memory: record failed', {
        guildId,
        lines: lines.length,
        ...(privateUserId ? { private: true } : {}),
        code: err?.code ?? null,
      });
      return false;
    }
  }

  /**
   * Run a memory update for one guild if its buffer is due and it is not busy/backed off. Only
   * the lines the request showed are consumed (`outcome.consumed`, the batch's oldest); the
   * deferred rest stays in the buffer and leads the next batch. The server and channel notes the
   * request flagged stale are stamped flagged (`store.markNotesFlagged`, at `now()`); only those
   * the answer's `note_reviews` really reviewed (`reconcileNoteReviews`) are stamped re-checked
   * (`store.markNotesChecked`), the rest wait `memory.notesRetryHours` before the next flag. A
   * stage A batch that was stored is followed by one voice run for the guild (`runVoice`), still
   * under the guild's own `running` key, so the tick never starts a second one beside it.
   */
  async function run(guildId) {
    running.add(guildId);
    try {
      // The journal cannot take a record, or the archive is too far behind: the batch waits in the
      // buffer, nothing is sent.
      if (appendPaused(guildId) || archivePaused(guildId)) return;
      const buffer = store.getBuffer(guildId);
      const messages = buffer.slice(0, batchTake(guildId, buffer.length));
      if (messages.length === 0) failedTold.delete(guildId); // nothing waits any more: a failure later is a new one
      // The batch reaches the record before anything consumes it; a refused append keeps it.
      if (!(await recordBatch(guildId, messages, buffer))) return;
      const batchId = `b-${uuid()}`;

      const analyzeStartedAt = now();
      const outcome = await analyze(guildId, messages);
      if (outcome.ok) {
        sizeFactors.delete(guildId); // back to normal size after a success
        failedTold.delete(guildId);
        const consumed = messages.slice(0, outcome.consumed);
        // Counted only once the lines are consumed: a failed batch, or a deferred line, stays in
        // the buffer and is counted when a batch shows it.
        const emojiUsage = store.recordEmojiUsage(guildId, consumed, emojiUsageOpts(hot.config));
        // Which names the consumed lines call members by (no model involved), counted the same once.
        const addressUses = recordAddressingSafely(guildId, consumed);
        store.shiftBuffer(guildId, consumed);
        const { channels: flaggedChannels, guild: flaggedGuild } = outcome.staleNotes;
        const notesFlagged = flaggedChannels.length + (flaggedGuild ? 1 : 0);
        // Counts only: a portrait cue's text is the analyzer's prose about a member; the review
        // map and the change list feed the reconciliation below, not the log line.
        const { portraitRequests, noteReviews, changedChannels, guildChanged, guildBriefQueued, ...counts } = outcome.result;
        const { archived } = await settleArchive(guildId, outcome.archiveMarks);
        if (outcome.trace) {
          await writeMemoryRecord(guildId, { batchId, stage: outcome.stage ?? 'single', messages: consumed, trace: outcome.trace, result: outcome.result, limits: outcome.limits, archived });
        }
        let noteCounts = null;
        if (notesFlagged > 0) {
          // A store without a stamp (an older store module) leaves the markers to come again.
          if (typeof store.markNotesFlagged === 'function') store.markNotesFlagged(guildId, { channels: flaggedChannels, guild: flaggedGuild }, now());
          // In stage A the server notes' patterns / starters are briefs worded later by the voice
          // run: a brief queued in this batch is the change an `updated` review promised.
          const reconciled = reconcileNoteReviews({
            flagged: outcome.staleNotes,
            reviews: noteReviews,
            changedChannels,
            guildChanged: guildChanged === true || guildBriefQueued === true,
          });
          noteCounts = reconciled.counts;
          if ((reconciled.stamp.channels.length > 0 || reconciled.stamp.guild) && typeof store.markNotesChecked === 'function') {
            store.markNotesChecked(guildId, reconciled.stamp, now());
          }
        }
        store.flush();
        log.info('memory: update applied', {
          guildId,
          // The batch's time: the request, the parse and the writes.
          ms: now() - analyzeStartedAt,
          consumed: consumed.length,
          shown: outcome.shown,
          // Left in the buffer for the next batch: they did not fit this request.
          deferred: outcome.deferred,
          roster: outcome.roster,
          rosterCandidates: outcome.rosterCandidates,
          rosterTokens: outcome.rosterTokens,
          // Profiles sent whole and compact (the ones that did not fit), and the block's tokens.
          profilesWhole: outcome.profilesWhole,
          profilesCompact: outcome.profilesCompact,
          profilesTokens: outcome.profilesTokens,
          // Relationship markers sent; `relationships` (in counts) = texts actually rewritten.
          staleRelationships: outcome.staleRelationships,
          // Of those, the forced rewrites (cause `rewrite`).
          relationshipRewrites: outcome.relationshipRewrites,
          // Notes markers sent (channels plus the server notes); `channels` / `guild` (in counts)
          // say whether a text really changed. With markers sent, how the answer reviewed them:
          // a stamp went to the updated (really changed) and confirmed ones only.
          notesFlagged,
          ...(noteCounts
            ? {
                notesUpdated: noteCounts.updated,
                notesConfirmed: noteCounts.confirmed,
                notesInsufficient: noteCounts.insufficient,
                notesMissing: noteCounts.missing,
                notesIdentical: noteCounts.identical,
                notesUnflagged: noteCounts.unflagged,
              }
            : {}),
          // Recent lines the request carried; the answer's `recentAdded`, `recentOverlap`,
          // `recentRemoved`, what the code dropped (`recentDropped` and its reasons) and the
          // batch's `recentExpired` / `recentEvicted` come with the counts (applyRecentField).
          recentShown: outcome.recentShown,
          ...counts,
          portraitRequests: portraitRequests.length,
          emojiUsage,
          addressUses,
          ...stageLogFields(outcome),
        });
        if (outcome.stage === 'two') await runVoice(guildId);
        return;
      }
      recordFailure(guildId, outcome, 'memory: update', { guildId, ...stageField(outcome) }, messages.length, { guildId, waiting: buffer.length });
    } finally {
      settle(guildId);
    }
  }

  /** The `running`/`backoffUntil`/`sizeFactors` key of one member's private buffer. */
  const privateKey = (guildId, userId) => `private:${guildId}:${userId}`;

  /**
   * Run a private update for one member's buffered direct messages. The
   * buffer is shifted only after a success, and only by the lines the request
   * showed (the deferred rest leads the next batch); a failure keeps it and backs off
   * or halves the next batch, exactly like `run()`. Never runs twice at once
   * for the same member. Logs carry counts only, never a member id.
   * @param {string} guildId
   * @param {string} userId
   */
  async function runPrivate(guildId, userId) {
    const key = privateKey(guildId, userId);
    if (running.has(key)) return;
    running.add(key);
    try {
      if (appendPaused(guildId) || archivePaused(guildId)) return;
      const buffer = store.getPrivateBuffer(guildId, userId);
      const messages = buffer.slice(0, batchTake(key, buffer.length));
      if (messages.length === 0) {
        failedTold.delete(key);
        return;
      }
      if (!(await recordBatch(guildId, messages, buffer, userId))) return;
      const batchId = `b-${uuid()}`;

      const analyzeStartedAt = now();
      const outcome = await analyzePrivate(guildId, userId, messages);
      if (outcome.ok) {
        sizeFactors.delete(key);
        failedTold.delete(key);
        const consumed = messages.slice(0, outcome.consumed);
        store.shiftPrivateBuffer(guildId, userId, consumed);
        store.flush();
        const { archived } = await settleArchive(guildId, outcome.archiveMarks);
        if (outcome.trace) {
          const privateUserId = String(userId);
          await writeMemoryRecord(guildId, { batchId, stage: outcome.stage ?? 'single', messages: consumed, trace: outcome.trace, result: outcome.result, limits: outcome.limits, privateUserId, archived });
        }
        log.info('memory: private update applied', {
          guildId,
          ms: now() - analyzeStartedAt,
          consumed: consumed.length,
          shown: outcome.shown,
          deferred: outcome.deferred,
          staleRelationships: outcome.staleRelationships,
          ...outcome.result,
          ...stageLogFields(outcome),
        });
        return;
      }
      recordFailure(key, outcome, 'memory: private update', { guildId, ...stageField(outcome) }, messages.length, { guildId, waiting: buffer.length, channelId: messages[0]?.channelId ?? null, privateChat: true });
    } finally {
      settle(key);
    }
  }

  let privatePass = false; // true while a tick is working through the private buffers

  /**
   * Every due private buffer of every guild, one at a time (a DM batch is
   * small; the private pass never runs concurrently with itself, even across
   * ticks). Stops as soon as the persona is paused. Besides the guild rules, a
   * buffer is due once its oldest line is `memory.privateMaxAgeMinutes` old
   * (config.json's 360 when missing, 0 = off; read at each look), so a short
   * direct chat is analyzed too.
   */
  async function runDuePrivate() {
    if (privatePass) return;
    privatePass = true;
    try {
      for (const guildId of store.listGuilds()) {
        for (const userId of store.listPrivate(guildId)) {
          if (store.state.data.paused) return;
          const key = privateKey(guildId, userId);
          if (running.has(key)) continue;
          const nowMs = now();
          if (nowMs < (backoffUntil.get(key) ?? 0)) continue;
          if (store.privateBufferInfo(guildId, userId).size === 0) continue;
          const relationshipsCfg = hot.config.features?.relationships !== false ? hot.config.relationships : undefined;
          const maxAgeMinutes = hot.config.memory?.privateMaxAgeMinutes ?? 360;
          if (!isDue(store.getPrivateBuffer(guildId, userId), nowMs, hot.config.memory, relationshipsCfg, { maxAgeMinutes })) continue;
          await runPrivate(guildId, userId);
        }
      }
    } finally {
      privatePass = false;
    }
  }

  /** `memory: voice skipped` for `reason`, at most once an hour per guild and reason. */
  function logVoiceSkip(guildId, reason, nowMs) {
    const key = `${guildId}:${reason}`;
    const last = voiceSkipLogged.get(key);
    if (last !== undefined && nowMs - last < HOUR_MS) return;
    voiceSkipLogged.set(key, nowMs);
    log.info('memory: voice skipped', { guildId, reason });
  }

  /** One more failed voice request for the guild: it waits src/memory/voice.js#retryDelayMs of
   * the failures in a row (`memory.voice.retryMinutes`, doubling, at most `queueHours`). */
  function backOffVoice(guildId, nowMs) {
    const failures = (voiceBackoff.get(guildId)?.failures ?? 0) + 1;
    const delay = retryDelayMs(failures, hot.config);
    voiceBackoff.set(guildId, { failures, until: nowMs + delay });
    return delay / MINUTE_MS;
  }

  /**
   * Whether this UTC day's `memory.voice.maxPerDay` requests on the voice model went out already
   * (`voiceDay` / `voiceCount` in state.json, read at the moment of use; a value that is not a
   * number refuses, src/llm/openrouter.js#dailyCapOf, and 0 never sends).
   * @param {number} nowMs
   * @returns {boolean}
   */
  function voiceRailReached(nowMs) {
    const cap = dailyCapOf(hot.config.memory?.voice?.maxPerDay, 'memory.voice.maxPerDay');
    const today = dailyCounter(store.state.data, VOICE_DAILY, nowMs);
    if (today.rolled) store.state.markDirty();
    return today.count >= cap;
  }

  /**
   * Count one memory-wording request (purpose `memory-voice`) about to go out (a voice run's, or a
   * batch's single-stage fallback) against `memory.voice.maxPerDay`; the caller checked
   * `voiceRailReached` with nothing awaited since.
   * @param {number} nowMs
   * @returns {string}  The UTC day it counts for (for `releaseVoiceRequest`).
   */
  function countVoiceRequest(nowMs) {
    const { day } = bumpDaily(store.state.data, VOICE_DAILY, nowMs);
    store.state.markDirty();
    return day;
  }

  /** Give back the count `countVoiceRequest` took on `day` for a request refused before it
   * went out, unless the day has turned since. */
  function releaseVoiceRequest(day) {
    const state = store.state.data;
    if (state.voiceDay !== day || !(state.voiceCount > 0)) return;
    state.voiceCount -= 1;
    store.state.markDirty();
  }

  /**
   * Take the expired items out of the guild's queue (src/memory/voice.js#expireItems: queued
   * `memory.voice.queueHours`, left out of `memory.voice.maxAttempts` answers, or of a kind
   * switched off since; never a `character` item) and run their degraded writes (#degradedApply).
   * @returns {number}  Items expired.
   */
  function expireVoice(guildId, config, nowMs) {
    const { expired } = store.updateVoiceQueue(guildId, (queue) => expireItems(queue, nowMs, config));
    if (expired.length === 0) return 0;
    const { writes } = degradedApply(expired, { config, hasMember: voiceMemberCheck(store, guildId) });
    const degraded = voiceWrites(guildId, writes, config, nowMs);
    store.flush();
    log.info('memory: voice dropped', { guildId, expired: expired.length, overflow: 0, degraded });
    return expired.length;
  }

  /** A voice request that failed: every item it carried (`ids`, those still queued) waits
   * src/memory/voice.js#retryLater's back-off without counting a miss, the guild backs off. */
  function voiceFailed(guildId, ids, { reason, detail, status }) {
    const failedMs = now();
    const config = hot.config;
    store.updateVoiceQueue(guildId, (queue) => retryLater(queue, ids, failedMs, config));
    store.flush();
    const backoffMinutes = backOffVoice(guildId, failedMs);
    const queued = store.getVoiceQueue(guildId).length;
    log.warn('memory: voice failed', { guildId, reason, detail, status, sent: ids.length, queued, backoffMinutes });
    return { reason, sent: ids.length, applied: 0 };
  }

  /**
   * Write one parsed voice answer. The queue is read again first (the request was awaited): only
   * the sent items STILL queued are written, so an item merged, replaced or forgotten meanwhile
   * never takes a stale text; each text is judged against the stored text it rewrites
   * (src/memory/voice.js#applyVoiceItems with `voiceOldText`). Then, in one synchronous
   * read-modify-write, the applied, gone and switched-off ids leave the queue and the missing ones
   * are backed off as misses -- an item queued during the request is left as it is. A rewrite over
   * its limit (`overItems`) stays queued untouched for the caller to ask once more, unless
   * `dropOver`, when it leaves (`over-limit`: the stored text stays). With `only` (the retry), only
   * those ids are written, any other worded id is ignored (the first answer applied it), and an
   * item of `only` left out of the answer leaves as over the limit too, never as a miss.
   * @param {string} guildId
   * @param {string[]} sent         buildVoiceRequest's `sent`.
   * @param {Map<string, string>} worded  parseVoiceAnswer's map.
   * @param {{ only?: Set<string>, dropOver?: boolean, limits?: object|null }} [opts]
   *   `limits`: the request's collector (journal on), told each item that leaves over its limit
   *   (`over-limit`, `voice.<kind>`, the characters over) before the writes are recorded.
   * @returns {{ result: object, still: object[], landed: number, portraits: number, overLimit: number }}
   *   `overLimit`: items that left the queue over the limit.
   */
  function writeVoiceAnswer(guildId, sent, worded, { only, dropOver = false, limits = null } = {}) {
    const doneMs = now();
    const config = hot.config;
    const wanted = only ?? new Set(sent);
    const still = store.getVoiceQueue(guildId).filter((item) => wanted.has(item.id));
    const answer = only ? new Map([...worded].filter(([id]) => only.has(id))) : worded;
    const { tokenize } = makeTokenizers(store, guildId, new Set(still.map((item) => item.userId).filter(Boolean)));
    const result = applyVoiceItems(answer, still, {
      config,
      tokenize,
      hasMember: voiceMemberCheck(store, guildId),
      oldTextOf: (item) => voiceOldText(store, guildId, item),
    });
    const overIds = dropOver ? result.overItems.map((over) => over.id) : [];
    if (limits) {
      for (const over of dropOver ? result.overItems : []) {
        const kind = still.find((item) => item.id === over.id)?.kind ?? 'item';
        limits.add({ kind: 'over-limit', where: `voice.${kind}`, lost: Number(over.chars) - Number(over.limit) });
      }
    }
    const landed = voiceWrites(guildId, result.writes, config, doneMs, limits);
    const portraits = stampVoicePortraits(store, guildId, still, result.portraits);
    const missedOver = only ? result.missing : [];
    const missed = only ? [] : result.missing;
    const leaving = [...result.applied, ...result.gone, ...result.off, ...overIds, ...missedOver];
    store.updateVoiceQueue(guildId, (queue) => retryLater(removeItems(queue, leaving), missed, doneMs, config, { missed: true }));
    store.flush();
    return { result, still, landed, portraits, overLimit: overIds.length + missedOver.length };
  }

  /**
   * The one retry of the rewrites a voice answer returned over their limit
   * (src/memory/voice.js#buildVoiceRetry: the first request, its answer as the assistant's turn,
   * then `<over_limit>`), counted against `memory.voice.maxPerDay` like any voice request and
   * checked by the same rails. Its answer is written for those items only; an item still over,
   * left out, or carried by a retry that failed (refused, an llm error, an unreadable answer)
   * leaves the queue with the stored text untouched. A failed retry backs nothing off: the first
   * answer was read. A pause during it writes nothing and leaves the items queued as they were.
   * @param {string} guildId
   * @param {{ messages: object[], sent: string[] }} request  The first request (buildVoiceRequest's).
   * @param {string} answer  The first answer's text, as returned.
   * @param {{ id: string, chars: number, limit: number }[]} overItems
   * @returns {Promise<{ paused?: true, written?: object, reason?: string }>}  `reason`: why the
   *   retry gave no usable answer (`daily-cap`, `token-limit`, `llm-error`, `bad-json`, `truncated`).
   */
  async function retryOverLimit(guildId, request, answer, overItems) {
    const only = new Set(overItems.map((over) => over.id));
    const startMs = now();
    // The retry's own collector (journal on): what this second request hit.
    const limits = journalOn() ? createLimits() : null;
    let completion;
    let reason;
    if (voiceRailReached(startMs)) {
      reason = 'daily-cap';
      limits?.add({ kind: 'daily-cap', where: 'memory.voice.maxPerDay' });
    } else {
      const day = countVoiceRequest(startMs);
      try {
        const options = limits ? { ...voiceRequestOptions(hot.config), limits } : voiceRequestOptions(hot.config);
        completion = await llm.complete(buildVoiceRetry(request.messages, answer, overItems, request.sent), options);
      } catch (err) {
        if (err instanceof DailyCapError || err instanceof TokenLimitError) releaseVoiceRequest(day);
        reason = railReason(err);
      }
    }
    // As after the first request: a pause during it wins, nothing is written.
    if (store.state.data.paused) return { paused: true };
    let worded = new Map();
    if (!reason) {
      try {
        worded = parseVoiceAnswer(completion.text, request.sent);
      } catch {
        reason = looksTruncated(completion.text, completion.finishReason) ? 'truncated' : 'bad-json';
      }
    }
    return { written: writeVoiceAnswer(guildId, request.sent, worded, { only, dropOver: true, limits }), reason };
  }

  /**
   * `memory: voice applied` for one voice run: the first answer's counts plus the retry's
   * (`overLimitRetried`: items sent again; `overLimit`: items that left the queue over the limit,
   * the stored text kept; `retryFailed`: why the retry gave no usable answer, only when it did not).
   * @returns {{ sent: number, applied: number }}
   */
  function logVoiceApplied(guildId, sent, first, retry, { outputTokens, overLimitRetried, retryFailed }) {
    const parts = retry ? [first, retry] : [first];
    const sum = (count) => parts.reduce((total, part) => total + count(part), 0);
    const byKind = { ...first.result.byKind };
    for (const [kind, count] of Object.entries(retry?.result.byKind ?? {})) byKind[kind] = (byKind[kind] ?? 0) + count;
    const applied = sum((part) => part.result.applied.length);
    log.info('memory: voice applied', {
      guildId,
      sent: sent.length,
      applied,
      missing: first.result.missing.length,
      gone: sum((part) => part.result.gone.length),
      off: sum((part) => part.result.off.length),
      // Sent, but no longer queued as sent once the answer came: merged, replaced or forgotten meanwhile.
      stale: sent.length - first.still.length + (retry ? overLimitRetried - retry.still.length : 0),
      ignored: first.result.ignored,
      landed: sum((part) => part.landed),
      portraits: sum((part) => part.portraits),
      // Rewrites over their limit: how many were asked once more, and how many were refused in the
      // end (the stored text stays).
      overLimit: sum((part) => part.overLimit),
      overLimitRetried,
      ...(retryFailed ? { retryFailed } : {}),
      // Applied per kind, and the answer size the request was fitted to (calibrated tokens).
      byKind,
      outputTokens,
      queued: store.getVoiceQueue(guildId).length,
    });
    return { sent: sent.length, applied };
  }

  /** The body of `runVoice`, under its `running` key. */
  async function voiceRun(guildId) {
    const idle = (reason) => ({ reason, sent: 0, applied: 0 });
    const startMs = now();
    if (store.state.data.paused) {
      logVoiceSkip(guildId, 'paused', startMs);
      return idle('paused');
    }

    // The journal cannot take a record: the queue keeps every item, nothing expires or is sent.
    if (appendPaused(guildId)) return idle('append-stalled');
    // The archive is too far behind: the queue keeps every item until the drain catches up.
    if (archivePaused(guildId)) return idle('archive-stalled');
    const config = hot.config;
    // Local work, no request: on time whatever the switch, the voice prompt or the guild's
    // back-off say (an item's age is not the model's fault), so a rollback of the switch or a
    // missing prompt never strands what the queue holds.
    expireVoice(guildId, config, startMs);
    if (config.features?.memoryTwoStage !== true) return idle('off');
    if (!hasContent(hot.prompts?.['memory-voice'])) {
      if (!voicePromptMissing) log.warn('memory: voice skipped', { guildId, reason: 'no-prompt' });
      voicePromptMissing = true;
      return idle('no-prompt');
    }
    voicePromptMissing = false;

    if (startMs < (voiceBackoff.get(guildId)?.until ?? 0)) return idle('backoff');
    const due = dueItems(store.getVoiceQueue(guildId), startMs, config);
    if (due.length === 0) return idle('nothing-due');
    if (voiceRailReached(startMs)) {
      logVoiceSkip(guildId, 'daily-cap', startMs);
      return idle('daily-cap');
    }

    const selfName = getSelfName(guildId);
    let request;
    try {
      request = buildVoiceRequest({
        prompts: hot.prompts,
        config,
        calibrator,
        items: due,
        selfName,
        character: characterText(hot.prompts, selfName),
        nameOf: storeNameOf(store, guildId),
        oldTextOf: (item) => voiceOldText(store, guildId, item),
      });
    } catch (err) {
      // The system message and the character block alone are over the cap: nothing can be sent.
      if (!(err instanceof SectionsTooLargeError)) throw err;
      return voiceFailed(guildId, due.map((item) => item.id), { reason: 'token-limit', detail: detailOf(err) });
    }
    // No due item fits the request even alone.
    if (request.sent.length === 0) return voiceFailed(guildId, due.map((item) => item.id), { reason: 'token-limit' });

    // Counted only once there is something to send; a request that went out counts even when it fails.
    const day = countVoiceRequest(startMs);
    // What this request hit, for the memory records of its writes (journal on).
    const limits = journalOn() ? createLimits() : null;
    let completion;
    let failure = null;
    try {
      completion = await llm.complete(request.messages, limits ? { ...voiceRequestOptions(config), limits } : voiceRequestOptions(config));
    } catch (err) {
      // Refused before sending: the request never went out, so it does not count.
      if (err instanceof DailyCapError || err instanceof TokenLimitError) releaseVoiceRequest(day);
      failure = { reason: railReason(err), detail: detailOf(err), status: err?.statusCode };
    }

    // Right before any write, with no await left until it is done: a pause during the request
    // wins (/nep pause waits for this run, then the owner edits data/): nothing is written, the
    // items stay exactly as they were.
    if (store.state.data.paused) {
      log.info('memory: voice skipped', { guildId, reason: 'paused', sent: request.sent.length });
      return { reason: 'paused', sent: request.sent.length, applied: 0 };
    }
    if (failure) return voiceFailed(guildId, request.sent, failure);

    let worded;
    try {
      worded = parseVoiceAnswer(completion.text, request.sent);
    } catch (err) {
      // Billed, but unusable: by the error's name only, never the answer.
      const reason = looksTruncated(completion.text, completion.finishReason) ? 'truncated' : 'bad-json';
      return voiceFailed(guildId, request.sent, { reason, detail: errorNameOf(err) });
    }
    // A parsed answer ends the guild's back-off.
    voiceBackoff.delete(guildId);
    // Read at the moment of use: 0 (or anything not above 0) drops an over item at once.
    const retrying = Number(hot.config.memory?.overLimitRetries ?? 1) > 0;
    const first = writeVoiceAnswer(guildId, request.sent, worded, { dropOver: !retrying, limits });
    const over = first.result.overItems;
    if (!retrying || over.length === 0) {
      return logVoiceApplied(guildId, request.sent, first, null, { outputTokens: request.outputTokens, overLimitRetried: 0 });
    }
    const retry = await retryOverLimit(guildId, request, completion.text, over);
    if (retry.paused) {
      // The first answer is written; the over items stay queued exactly as they were.
      log.info('memory: voice skipped', { guildId, reason: 'paused', sent: over.length });
      const counts = logVoiceApplied(guildId, request.sent, first, null, { outputTokens: request.outputTokens, overLimitRetried: over.length });
      return { ...counts, reason: 'paused' };
    }
    return logVoiceApplied(guildId, request.sent, first, retry.written, {
      outputTokens: request.outputTokens,
      overLimitRetried: over.length,
      retryFailed: retry.reason,
    });
  }

  /**
   * The voice run of one guild (stage B of the two-stage analyzer): ONE request on
   * `models.core` (never `models.helpers.extractor`; role `core`, purpose `memory-voice`) that words the
   * guild's due queued items (src/memory/voice.js#dueItems: oldest first, one audience -- the
   * server's items, or one member's private ones -- at most `memory.voice.maxItems`), built from
   * prompts/memory-voice.md (#buildVoiceRequest) and applied by id through the store
   * (`runVoiceWrites`). Before it, the expired items take the degraded path (`expireVoice`, local
   * work that sends nothing), also while the guild backs off, with `features.memoryTwoStage` off
   * or with the voice prompt missing.
   *
   * Does nothing at all while paused. Sends nothing with `features.memoryTwoStage` off, with the
   * voice prompt missing (warned once per change), while the guild backs off after a failed
   * request, with no item due, or once `memory.voice.maxPerDay` requests went out this UTC day
   * (`voiceDay` / `voiceCount` in state.json, shared with a batch's single-stage fallback; 0, or a
   * value that is not a number, never sends). A failed request (`token-limit`,
   * `daily-cap`, `llm-error`, `bad-json`, `truncated`) backs off every item it carried and the
   * guild (`voiceFailed`); a pause during the request writes nothing at all. A rewrite the answer
   * returns over its limit is never cut: with `memory.overLimitRetries` above 0 (read at the
   * moment of use; config.json's 1) it is asked ONE more time (`retryOverLimit`, a second
   * counted request); still over, left out, or with no usable retry answer -- or at once with 0 --
   * it leaves the queue (`over-limit`) and the stored text stays. A character item is never
   * dropped otherwise, and its portrait stamps are written only when it is applied. Its `running`
   * key (`voice:<guildId>`) makes `waitIdle()` -- `/nep pause` -- wait for it. Never throws:
   * anything unexpected is logged by name and backs the guild off.
   * @param {string} guildId
   * @returns {Promise<{ sent: number, applied: number, reason?: string }>}  `reason` when it did
   *   not apply an answer: `busy`, `off`, `paused`, `append-stalled`, `archive-stalled`, `no-prompt`, `backoff`, `nothing-due`,
   *   `daily-cap`, `token-limit`, `llm-error`, `bad-json`, `truncated`, `apply-error`.
   */
  async function runVoice(guildId) {
    const key = voiceKey(guildId);
    if (running.has(key)) return { reason: 'busy', sent: 0, applied: 0 };
    running.add(key);
    try {
      return await voiceRun(guildId);
    } catch (err) {
      const backoffMinutes = backOffVoice(guildId, now());
      log.warn('memory: voice failed', { guildId, reason: 'apply-error', error: errorNameOf(err), backoffMinutes });
      return { reason: 'apply-error', sent: 0, applied: 0 };
    } finally {
      settle(key);
    }
  }

  /**
   * The voice runs one tick starts: one per guild whose queue holds anything, that has no voice
   * run in flight and no batch in flight (that batch runs the voice itself once stored, see
   * `run`). Retries need no new batch. Whatever `features.memoryTwoStage` says: with it off (a
   * rollback), the voice prompt missing or the guild backing off, the run only expires old items
   * down the degraded path and sends nothing (`runVoice`), so no queued text is stranded.
   * @returns {Promise<object>[]}
   */
  function dueVoiceRuns() {
    const runs = [];
    for (const guildId of store.listGuilds()) {
      if (running.has(guildId) || running.has(voiceKey(guildId))) continue;
      if (store.getVoiceQueue(guildId).length === 0) continue;
      runs.push(runVoice(guildId));
    }
    return runs;
  }

  /**
   * Check every guild and every private buffer, and kick off a memory update for the ones that
   * are due, then the voice runs (`dueVoiceRuns`).
   */
  async function tick() {
    // /nep pause: the live analyzer never runs while paused.
    if (store.state.data.paused) return;
    const nowMs = now();
    const cfg = hot.config.memory;
    const relationshipsCfg = hot.config.features?.relationships !== false ? hot.config.relationships : undefined;
    const jobs = [];
    for (const guildId of store.listGuilds()) {
      if (running.has(guildId)) continue;
      if (nowMs < (backoffUntil.get(guildId) ?? 0)) continue;
      if (!isDue(store.getBuffer(guildId), nowMs, cfg, relationshipsCfg)) continue;
      jobs.push(run(guildId));
    }
    jobs.push(runDuePrivate());
    jobs.push(...dueVoiceRuns());
    await Promise.all(jobs);
  }

  /**
   * Resolves once no `run()` / `runPrivate()` / `runVoice()` is in flight -- immediately if
   * that is already true. Never starts a new run itself. Used by admin.js's
   * `/nep pause` to wait out a live-analyzer or voice run that was already in
   * flight when the pause was requested (an LLM call can take 30-90s; a voice
   * answer that arrives once paused writes nothing, see `runVoice`): its
   * result must land on disk BEFORE the pause flushes and drops the store's
   * caches, or the eventual `applyMemoryUpdate` would re-read a profile from
   * disk, mutate it and mark it dirty after the owner started editing files
   * under data/ -- exactly the overwrite this feature exists to prevent.
   * @returns {Promise<void>}
   */
  function waitIdle() {
    return running.size === 0 ? Promise.resolve() : new Promise((resolve) => idleWaiters.push(resolve));
  }

  /**
   * The fact ledger a batch that cannot be applied is told through (src/behavior/inner.js's `facts`: `enabled`,
   * `add`), the way the turn runner's `setFactsSource` takes it; without one (or while its `enabled()` is false) the
   * failure stays a log line.
   */
  function setFactsSource(source) {
    factsSource = source ?? null;
  }

  return { observe, observeInner, tick, run, runPrivate, runVoice, analyze, analyzePrivate, waitIdle, setFactsSource };
}
