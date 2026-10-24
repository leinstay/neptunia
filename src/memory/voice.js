// The pure core of the two-stage analyzer (`features.memoryTwoStage`). Stage A, a reasoning model
// on `models.base.extractor`, returns neutral decisions; every text that must read in the persona's own
// voice comes back from it as a short factual BRIEF instead. Stage B, the voice model
// (`models.base.core`, the role `core`), words those briefs later, many per request. This module is everything
// between the two that needs no I/O:
//
//   splitDecision     a stage A answer -> its neutral part, stored at once (the attitude delta and
//                     the episode with an empty feeling included, so an outage of the voice model
//                     never freezes scores or hides moments), plus one voice item per brief
//   mergeIntoQueue    items into the guild's queue (a per-guild list the store persists in
//                     data/guilds/<id>/voice.json, normalised on read by `normalizeQueue`, changed
//                     only by a synchronous read-modify-write in src/memory/store.js
//                     (`updateVoiceQueue`) or a forget / wipe): one relationship / patterns /
//                     starters item per target (briefs appended), one character item per member
//                     (the newer replaces), a lesson or self fact already queued not queued again,
//                     the rest appended; past `memory.voice.queueMax` the oldest non-character
//                     overflow
//   dueItems          what the next voice request carries (`memory.voice.maxItems`, oldest first,
//                     one audience per request)
//   buildVoiceRequest / parseVoiceAnswer   the stage B request, fitted to the input cap AND to
//                     what `memory.voice.maxOutputTokens` can answer, and its answer, by request id
//   applyVoiceItems   worded texts -> store writes (plain data), by item id; a rewrite over its
//                     limit is never cut: it is not written and comes back in `overItems`
//   buildVoiceRetry   the one follow-up request for those items: the first request, the first
//                     answer as an assistant turn, then an `<over_limit>` block
//   retryLater / expireItems / degradedApply   exponential back-off from `memory.voice.retryMinutes`
//                     up to `memory.voice.queueHours`; an item too old or left out of too many
//                     answers takes the degraded path -- except a `character` item, which is never
//                     expired, overflowed or dropped: it stays queued until it is worded
//
// A private batch (a DM, src/memory/update.js#analyzePrivate) is split the same way. Its items
// carry `layer: 'private'`: they never merge with a public item, never share a request with
// anything but the same member's private items (what was said in private never sits beside what
// is worded for the server), and their writes name the layer, so they land in that member's
// private layer only. The feature switches are read at the moment of use: an item of a kind
// switched off since it was queued (`features.relationships`, `features.episodes`) is never sent
// or written, only counted.
//
// Pure: no store, no network, no clock. `nowMs` is passed in, store reads come in as injected
// lookups (`nameOf`, `oldTextOf`, `hasMember`, `tokenize`, `isKnownId`), store writes go out as
// plain objects the caller runs. Every function returns new arrays and never mutates its input,
// so a caller can keep each queue change a synchronous read-modify-write. No model-facing prose:
// the system message is prompts/memory-voice.md, everything else is JSON keys and kind codes.

import { isPlainObject } from '../config.js';
import { fitSections, requestTokenLimit, sectionCost } from '../llm/budget.js';
import { estimateTokens } from '../llm/tokens.js';
import { parseJsonObject } from '../llm/parse.js';
import { block, fillPromptTemplate } from '../behavior/prompt.js';
import { HOUR_MS, MINUTE_MS } from '../time.js';
import { REASON_CHARS, deltaCapOf } from './affinity.js';
import { clampText } from './clamp.js';
import { EPISODE_CHARS, episodeDate, isSameEpisode } from './episodes.js';
import { normalizeTopic } from './interests.js';
import { TEACHER_TOKEN_RE, fromTokens, teacherToken } from './mentions.js';
import { MEMORY_LIMIT_DEFAULTS, SELF_CHARS } from './text-limits.js';
import { acceptProse, overLimitOf } from './prose.js';

/**
 * Code fallbacks of the `memory.voice.*` keys this module and the voice run read, equal to
 * config.json; read only through `voiceSettings`, which validates the live value first.
 * `memory.voice.maxPerDay` is not here: it is a daily rail, read through
 * src/llm/openrouter.js#dailyCapOf (a value that is not a number refuses, never spends).
 */
const VOICE_DEFAULTS = Object.freeze({ maxItems: 24, maxOutputTokens: 3000, retryMinutes: 15, maxAttempts: 4, queueMax: 100, queueHours: 24 });

/**
 * Every kind of text stage B words (DECISIONS-R4, ruling 2): a member's `relationship` text, the
 * `reason` an attitude moved, the `feeling` of an episode, a `learned` lesson, a `self` fact, the
 * server's `patterns` and `starters` notes, a member's `character` portrait. Everything else
 * stage A writes directly.
 */
export const VOICE_KINDS = Object.freeze(['relationship', 'reason', 'feeling', 'learned', 'self', 'patterns', 'starters', 'character']);

// The kinds written about one member (`userId`), and those whose stored text goes back to the
// voice model as `old`, so a rewrite is a merge.
const MEMBER_KINDS = new Set(['relationship', 'reason', 'feeling', 'character']);
const OLD_TEXT_KINDS = new Set(['relationship', 'patterns', 'starters', 'character']);
// The kinds a private batch can make: the private layer holds a relationship, an attitude and
// episodes (src/memory/update.js#applyPrivateUpdate), nothing of the server's and no portrait.
const PRIVATE_KINDS = new Set(['relationship', 'reason', 'feeling']);
// One queued item per target: a later brief is appended to the queued one.
const MERGED_KINDS = new Set(['relationship', 'patterns', 'starters']);
// Never queued twice: stage A does not see the queue, so while the voice model is late it
// proposes the same lesson or self fact again batch after batch.
const DEDUPED_KINDS = new Set(['learned', 'self']);
const MAX_BRIEFS = 3;

// The clamps the store already applies to these texts (tests/voice.test.js measures them on the
// store's own functions): src/memory/affinity.js#applyDelta (reason),
// src/memory/episodes.js#sanitizeEpisode (feeling; an episode's `what` soft, its `quote` hard),
// src/memory/update.js#applyMemoryUpdate's `self` list. Each has one home (affinity.js,
// episodes.js, text-limits.js); the three below are re-exported for the store's voice writes
// (src/memory/store.js#fillAffinityReason, #fillEpisodeFeeling, #applySelfOps), so a voice text
// is cut at one limit wherever it is written.
export { REASON_CHARS, SELF_CHARS };
/** How long an episode's feeling may be, in characters (before `memory.clampTolerance`). */
export const FEELING_CHARS = EPISODE_CHARS.feeling;

// What the answer adds around its texts, in raw tokens: `{"items":{ ... }}` (with a code fence
// the model may wrap it in), and per item its `"24": "",` key and quotes.
const ANSWER_OVERHEAD = 16;
const ANSWER_ITEM_OVERHEAD = 8;
// Any character past ASCII: an answer text is priced at src/llm/tokens.js#estimateTokens'
// costlier rate, since the persona's language need not be written in Latin script.
const NON_ASCII = '\u00e9';

const identity = (text) => text;

/** Whether a stage A value is there at all (null and undefined are not). */
function given(value) {
  return value !== undefined && value !== null;
}

/**
 * Whether the feature `kind` belongs to is on, read from the live config at the moment of use:
 * relationship and reason belong to `features.relationships`, feeling to `features.episodes`.
 * The other kinds have no switch here: `features.memory` off stops the whole memory tick
 * (src/index.js), and `features.portraitRefresh` gates only the portrait scheduler, never the
 * owner's `/nep memory refresh`, whose character item must still be worded.
 */
function kindOn(kind, config) {
  if (kind === 'relationship' || kind === 'reason') return config?.features?.relationships !== false;
  if (kind === 'feeling') return config?.features?.episodes !== false;
  return true;
}

/** A finite number above 0, else `fallback`. */
function positive(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;
}

/** An integer of at least 1, else `fallback`. */
function count(value, fallback) {
  return Number.isInteger(value) && value >= 1 ? value : fallback;
}

/** A non-negative integer, else 0. */
function tally(value) {
  return Number.isInteger(value) && value >= 0 ? value : 0;
}

/**
 * The `memory.voice.*` settings, each a valid value or its config.json fallback (VOICE_DEFAULTS).
 * Read at the moment of use: pass the live config.
 * @param {object} [config]  The live config.
 * @returns {{ maxItems: number, maxOutputTokens: number, retryMinutes: number, maxAttempts: number,
 *   queueMax: number, queueHours: number }}
 */
export function voiceSettings(config) {
  const voice = isPlainObject(config?.memory?.voice) ? config.memory.voice : {};
  return {
    maxItems: count(voice.maxItems, VOICE_DEFAULTS.maxItems),
    maxOutputTokens: count(voice.maxOutputTokens, VOICE_DEFAULTS.maxOutputTokens),
    retryMinutes: positive(voice.retryMinutes, VOICE_DEFAULTS.retryMinutes),
    maxAttempts: count(voice.maxAttempts, VOICE_DEFAULTS.maxAttempts),
    queueMax: count(voice.queueMax, VOICE_DEFAULTS.queueMax),
    queueHours: positive(voice.queueHours, VOICE_DEFAULTS.queueHours),
  };
}

/**
 * The character limit of each kind's text: what the request states as `limit` and what
 * `applyVoiceItems` clamps to, the same limits the store applies (`relationships.textChars` for a
 * relationship, `memory.fieldChars` for a portrait and twice it for the server notes, as the
 * analyzer's `{{guildFieldChars}}`, `memory.learnedChars` for a lesson, 200 for a reason and a
 * self fact, 120 for a feeling). Missing keys fall back to config.json's values.
 * @param {object} [config]  The live config.
 * @returns {Record<string, number>}  Keyed by kind.
 */
export function voiceLimits(config) {
  const fieldChars = positive(config?.memory?.fieldChars, MEMORY_LIMIT_DEFAULTS.fieldChars);
  return {
    relationship: positive(config?.relationships?.textChars, MEMORY_LIMIT_DEFAULTS.relationshipChars),
    reason: REASON_CHARS,
    feeling: EPISODE_CHARS.feeling,
    learned: positive(config?.memory?.learnedChars, MEMORY_LIMIT_DEFAULTS.learnedChars),
    self: SELF_CHARS,
    patterns: fieldChars * 2,
    starters: fieldChars * 2,
    character: fieldChars,
  };
}

/**
 * @typedef {object} VoiceItem  One queued text for stage B.
 * @property {string} id         Unique in the queue. A merged item gets a fresh one, so an answer
 *   to a request sent before the merge never lands on the changed item.
 * @property {string} kind       One of VOICE_KINDS.
 * @property {string} [userId]   The member the text is about (relationship, reason, feeling, character).
 * @property {'private'} [layer] Set only on an item of a private batch (relationship, reason,
 *   feeling): its text belongs to the member's private layer. Absent = the public profile or the
 *   server's memory.
 * @property {string[]|object} brief  Stage A's neutral notes, oldest first, at most 3, `<@id>`
 *   tokens for members. Empty only for a feeling whose episode came without a tone, or a
 *   relationship item with `rewrite`. A `character`
 *   item's brief is whatever the portrait refresh queued (an object of lists), passed on as is.
 * @property {true} [rewrite]  Only on a relationship item: the member's stored text is flagged
 *   for a forced rewrite (the profile's `relationshipRewrite`), so the item is worded even with
 *   an empty brief. A merge keeps it.
 * @property {object} [payload]  reason: `{ delta, at }`; feeling: `{ at, date, what, quote }`;
 *   learned: `{ seenAt?, from?, sure? }`. `at` is the ISO stamp stage A stored the attitude move
 *   (its history entry's `ts`) or the episode (its `addedAt`) under: the address of the write,
 *   with a feeling's `date` and `what` exactly as the store keeps them.
 * @property {number} createdAt  Epoch ms the item was first queued; a merge keeps it.
 * @property {number} attempts   Failed tries (a failed request or an answer without the item):
 *   drives the back-off.
 * @property {number} misses     Answers that came back without the item: `memory.voice.maxAttempts`
 *   of them send it to the degraded path. A failed request never counts here.
 * @property {number} nextAt     Epoch ms before which the item is not due.
 */

/** `value` as a non-empty id string, or ''. */
function idString(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return typeof value === 'string' ? value.trim() : '';
}

/** A brief as stored: the strings of `value` (one string is a list of one), trimmed, non-empty,
 * the newest MAX_BRIEFS. */
function briefList(value) {
  const list = typeof value === 'string' ? [value] : Array.isArray(value) ? value : [];
  return list
    .filter((brief) => typeof brief === 'string')
    .map((brief) => brief.trim())
    .filter(Boolean)
    .slice(-MAX_BRIEFS);
}

/** The brief of a `kind` item, or null when it has none it could be worded from. */
function cleanBrief(kind, value) {
  if (kind === 'character' && isPlainObject(value)) return Object.keys(value).length > 0 ? value : null;
  const briefs = briefList(value);
  return briefs.length > 0 || kind === 'feeling' ? briefs : null;
}

/** The payload of a `kind` item: an object, `undefined` for a kind without one, or null when a
 * required field is missing (a reason or a feeling without its address). */
function cleanPayload(kind, value) {
  const raw = isPlainObject(value) ? value : {};
  if (kind === 'reason') {
    const delta = Number(raw.delta);
    if (!Number.isFinite(delta) || typeof raw.at !== 'string' || !raw.at) return null;
    return { delta, at: raw.at };
  }
  if (kind === 'feeling') {
    if (typeof raw.at !== 'string' || !raw.at || episodeDate(raw.date) === '' || typeof raw.what !== 'string' || !raw.what.trim()) return null;
    return { at: raw.at, date: raw.date, what: raw.what, quote: typeof raw.quote === 'string' ? raw.quote : '' };
  }
  if (kind === 'learned') {
    const payload = {};
    if (Number.isFinite(raw.seenAt)) payload.seenAt = raw.seenAt;
    if (typeof raw.from === 'string' && TEACHER_TOKEN_RE.test(raw.from)) payload.from = raw.from;
    if (raw.sure === false) payload.sure = false;
    return payload;
  }
  return undefined;
}

/**
 * One item validated, without its id; null when unusable. `createdAt` falls back to
 * `defaultCreatedAt` (an item being queued now); a stored item without one is unusable. A layer
 * other than `private`, or a private item of a kind the private layer lacks, is unusable too:
 * such an item is dropped, never kept as a public one.
 */
function normalizeItem(raw, defaultCreatedAt) {
  if (!isPlainObject(raw) || !VOICE_KINDS.includes(raw.kind)) return null;
  const { kind } = raw;
  const item = { kind };
  if (MEMBER_KINDS.has(kind)) {
    const userId = idString(raw.userId);
    if (!userId) return null;
    item.userId = userId;
  }
  if (given(raw.layer)) {
    if (raw.layer !== 'private' || !PRIVATE_KINDS.has(kind)) return null;
    item.layer = 'private';
  }
  const rewrite = kind === 'relationship' && raw.rewrite === true;
  const brief = cleanBrief(kind, raw.brief) ?? (rewrite ? [] : null);
  if (brief === null) return null;
  item.brief = brief;
  if (rewrite) item.rewrite = true;
  const payload = cleanPayload(kind, raw.payload);
  if (payload === null) return null;
  if (payload !== undefined) item.payload = payload;
  const createdAt = Number.isFinite(raw.createdAt) ? raw.createdAt : defaultCreatedAt;
  if (!Number.isFinite(createdAt)) return null;
  item.createdAt = createdAt;
  item.attempts = tally(raw.attempts);
  item.misses = tally(raw.misses);
  item.nextAt = Number.isFinite(raw.nextAt) ? raw.nextAt : createdAt;
  return item;
}

/**
 * The stored queue validated on read (src/memory/store.js): not an array -> `[]`; an item with an
 * unknown kind, no id, no usable brief (an empty one is usable only on a feeling and on a
 * relationship item with `rewrite`), no member for a member kind, a reason or feeling without
 * its address, no `createdAt`, an unknown layer or a private item of a kind the private layer
 * lacks is dropped, and so is a second item with an id already seen. `layer: 'private'` is kept.
 * Counters and `nextAt` are repaired. Never throws.
 * @param {unknown} raw
 * @returns {VoiceItem[]}
 */
export function normalizeQueue(raw) {
  if (!Array.isArray(raw)) return [];
  const seen = new Set();
  const out = [];
  for (const entry of raw) {
    const id = idString(entry?.id);
    if (!id || seen.has(id)) continue;
    const item = normalizeItem(entry, undefined);
    if (!item) continue;
    seen.add(id);
    out.push({ id, ...item });
  }
  return out;
}

/** Whether a stage A value says something (portrait keys are counted only then). */
function present(value) {
  if (value === undefined || value === null) return false;
  return typeof value === 'string' ? value.trim() !== '' : true;
}

/**
 * Split one stage A answer (the JSON prompts/memory-decide.md asks for) into what is stored at
 * once and what waits for the voice model. Untrusted input: any shape of `decision` gives a
 * result, never a throw (a missing `nowMs` is a caller bug and throws).
 *
 * `neutral` is in src/memory/update.js#applyMemoryUpdate's input shape: every key passes on as
 * given except that each `users.<id>` entry loses `relationship` (queued), `character`, `style`
 * and `portrait` (dropped and counted: a portrait is never written from a stream batch here),
 * keeps `affinity` as `{ delta, reason: '' }` (the score moves now, the stored reason stays until
 * the worded one arrives) and keeps its `episodes` with `feeling: ''` (date defaulted to the UTC
 * day of `nowMs`, `what` tokenized, `what` and `quote` clamped as the store clamps them, a repeat
 * inside the batch left out by the store's own duplicate rule, at most `memory.maxNewEpisodes`);
 * `guild` loses `patterns`, `starters` and `learned.add` (queued); the top-level `self` is never
 * in it (its `remove` list comes back as `selfRemove`, its `add` list is queued). Nothing in
 * `neutral` needs stage B. A `__proto__` key is never passed on.
 *
 * With `layer: 'private'` (a private batch, for src/memory/update.js#applyPrivateUpdate) every
 * item is stamped `layer: 'private'`, and `guild` and `self` pass on untouched: a private batch
 * never queues a server note, a lesson or a self fact (the private apply drops and counts them).
 *
 * Every item is queued at `nowMs`, its brief tokenized. A reason item (a non-zero integer delta,
 * clamped to `relationships.maxDeltaPerUpdate` as the store clamps it, with an `event`) and a
 * feeling item address what stage A stores by the ISO stamp of `nowMs`: the caller must store the
 * neutral part with that same clock (`relationships.now`, `episodes.now`), and before
 * mergeIntoQueue drop a reason item whose member got no attitude history entry stamped `at` (the
 * score did not move: at its bound, or damped to nothing) and a feeling item whose episode was not
 * stored (a repeat of one stored earlier): neither has anything to fill. Member-bound items are
 * made only for members in `knownUserIds` (the batch's authors) when given; a roster member's
 * entry passes on for applyMemoryUpdate to judge. With `features.relationships` off,
 * `relationship` and `affinity` are dropped; with `features.episodes` off, `episodes`.
 *
 * `rewriteIds`: the members whose profile went to stage A with `relationshipStale` cause
 * `rewrite`. Each of them (when `knownUserIds` allows and relationships are on) gets a
 * relationship item flagged `rewrite: true`, with the brief the answer gave, or an empty one
 * when the answer gave none or left the member out: the forced rewrite never waits for a shift.
 *
 * @param {unknown} decision  The parsed stage A answer.
 * @param {object} opts
 * @param {object} opts.config  The live config (`features.relationships`, `features.episodes`,
 *   `memory.maxNewEpisodes`, `memory.clampTolerance`, `relationships.maxDeltaPerUpdate`).
 * @param {number} opts.nowMs   Epoch ms of stage A's apply.
 * @param {Set<string>} [opts.knownUserIds]  The members who may get member-bound items; omitted = any.
 * @param {(text: string) => string} [opts.tokenize]  `name (id:...)` -> `<@id>` for known members
 *   (the analyzer's own tokenizer); omitted = text kept as written.
 * @param {(id: string) => boolean} [opts.isKnownId]  Whether a lesson's teacher is a known member;
 *   omitted = none is (the teacher is left out).
 * @param {number} [opts.seenAt]  When the batch's lessons were seen (its newest message); omitted = `nowMs`.
 * @param {'private'} [opts.layer]  `private` for a private batch; omitted = a guild batch.
 * @param {Set<string>} [opts.rewriteIds]  Members whose relationship text is due a forced rewrite.
 * @returns {{ neutral: object, selfRemove: string[], items: object[],
 *   dropped: { portrait: number, off: number, foreign: number, shape: number } }}
 *   `items` carry no id yet (mergeIntoQueue gives them one). `dropped.portrait`: non-empty
 *   `character`/`style`/`portrait` keys; `off`: voice fields of a switched-off feature (each
 *   episode counts); `foreign`: member-bound items not made for a member outside `knownUserIds`;
 *   `shape`: what the split cannot read and so drops (a `self` that is not an object, a whole list
 *   included; a `learned` or `affinity` that is not an object; a relationship, patterns, starters
 *   or event that is not a string; `episodes`, `learned.add`, `self.add` or `self.remove` that is
 *   not a list; an entry of those lists it cannot read; a `__proto__` key).
 * @throws {TypeError} `nowMs` is missing, or `layer` is neither omitted nor `private`.
 */
export function splitDecision(decision, { config, nowMs, knownUserIds, tokenize = identity, isKnownId = () => false, seenAt, layer, rewriteIds } = {}) {
  if (layer !== undefined && layer !== 'private') throw new TypeError('splitDecision: layer must be omitted or private');
  const dropped = { portrait: 0, off: 0, foreign: 0, shape: 0 };
  const result = { neutral: {}, selfRemove: [], items: [], dropped };
  if (!isPlainObject(decision)) return result;
  if (!Number.isFinite(nowMs)) throw new TypeError('splitDecision needs nowMs');

  const isPrivate = layer === 'private';
  const relationshipsOn = kindOn('relationship', config);
  const episodesOn = kindOn('feeling', config);
  const maxNew = count(config?.memory?.maxNewEpisodes, MEMORY_LIMIT_DEFAULTS.maxNewEpisodes);
  const maxDelta = deltaCapOf(config?.relationships?.maxDeltaPerUpdate ?? MEMORY_LIMIT_DEFAULTS.maxDeltaPerUpdate);
  const tolerance = config?.memory?.clampTolerance;
  const at = new Date(nowMs).toISOString();
  const text = (value) => (typeof value === 'string' ? String(tokenize(value) ?? '').trim() : '');
  const mayGet = (id) => !(knownUserIds instanceof Set) || knownUserIds.has(id);
  const stamp = isPrivate ? { layer: 'private' } : {};
  const queue = (fields) => result.items.push({ ...fields, ...stamp, createdAt: nowMs, attempts: 0, misses: 0, nextAt: nowMs });
  /** Count `value` as unreadable when it is there but `fits` says no. */
  const expect = (value, fits) => {
    if (given(value) && !fits(value)) dropped.shape += 1;
  };
  const isString = (value) => typeof value === 'string';
  const rewrites = rewriteIds instanceof Set && relationshipsOn ? new Set([...rewriteIds].map(String).filter(mayGet)) : new Set();
  /** Queue a relationship item, flagged when its member is due a forced rewrite (that one once). */
  const queueRelationship = (id, brief) => {
    if (!rewrites.has(id)) return queue({ kind: 'relationship', userId: id, brief });
    rewrites.delete(id);
    return queue({ kind: 'relationship', userId: id, brief, rewrite: true });
  };

  const { users, guild, self, ...rest } = decision;

  if (users !== undefined) result.neutral.users = isPlainObject(users) ? {} : users;
  for (const [userId, raw] of Object.entries(isPlainObject(users) ? users : {})) {
    // An own `__proto__` key (JSON.parse makes one) would set the prototype of `neutral.users`.
    if (userId === '__proto__') {
      dropped.shape += 1;
      continue;
    }
    if (!isPlainObject(raw)) {
      result.neutral.users[userId] = raw;
      continue;
    }
    const id = String(userId);
    const member = mayGet(id);
    const { relationship, affinity, episodes, character, style, portrait, ...entry } = raw;
    dropped.portrait += [character, style, portrait].filter(present).length;

    expect(relationship, isString);
    const relationshipBrief = text(relationship);
    if (relationshipBrief) {
      if (!relationshipsOn) dropped.off += 1;
      else if (!member) dropped.foreign += 1;
      else queueRelationship(id, [relationshipBrief]);
    } else if (rewrites.has(id)) {
      queueRelationship(id, []);
    }

    expect(affinity, isPlainObject);
    if (isPlainObject(affinity)) {
      if (!relationshipsOn) {
        dropped.off += 1;
      } else {
        entry.affinity = { delta: affinity.delta, reason: '' };
        const delta = Math.max(-maxDelta, Math.min(maxDelta, Math.trunc(Number(affinity.delta))));
        expect(affinity.event, isString);
        const event = text(affinity.event);
        if (Number.isFinite(delta) && delta !== 0 && event) {
          if (member) queue({ kind: 'reason', userId: id, brief: [event], payload: { delta, at } });
          else dropped.foreign += 1;
        }
      }
    }

    expect(episodes, Array.isArray);
    if (Array.isArray(episodes)) {
      if (!episodesOn) {
        dropped.off += episodes.length;
      } else {
        const stored = [];
        for (const episode of episodes) {
          if (stored.length >= maxNew) break;
          expect(episode, isPlainObject);
          if (!isPlainObject(episode)) continue;
          // Clamped exactly as src/memory/episodes.js#sanitizeEpisode will (idempotent there), so
          // the feeling item's `what` equals the stored one: one episode, one address.
          const what = clampText(text(episode.what), EPISODE_CHARS.what, { tolerance });
          if (!what) continue;
          const date = episodeDate(episode.date, nowMs);
          const quote = typeof episode.quote === 'string' ? clampText(episode.quote, EPISODE_CHARS.quote, { tolerance: 1 }) : '';
          // All of a batch's episodes share the stamp `at`: a repeat would be stored twice under
          // one address (the store compares only with what was stored before the batch).
          if (stored.some((kept) => isSameEpisode(kept, { date, what, quote }))) continue;
          const neutralEpisode = { date, what, quote };
          if (episode.weight !== undefined) neutralEpisode.weight = episode.weight;
          stored.push({ ...neutralEpisode, feeling: '' });
          const tone = text(episode.tone);
          if (member) queue({ kind: 'feeling', userId: id, brief: tone ? [tone] : [], payload: { at, date, what, quote } });
          else dropped.foreign += 1;
        }
        if (stored.length > 0) entry.episodes = stored;
      }
    }

    result.neutral.users[userId] = entry;
  }
  // A forced rewrite the answer left out (no entry, or one that is not an object) is queued anyway.
  for (const id of [...rewrites]) queueRelationship(id, []);

  if (isPrivate) {
    if (guild !== undefined) result.neutral.guild = guild;
    if (self !== undefined) result.neutral.self = self;
  } else {
    if (isPlainObject(guild)) {
      const { patterns, starters, learned, ...guildRest } = guild;
      for (const [kind, value] of [['patterns', patterns], ['starters', starters]]) {
        expect(value, isString);
        const brief = text(value);
        if (brief) queue({ kind, brief: [brief] });
      }
      expect(learned, isPlainObject);
      if (isPlainObject(learned)) {
        const { add, ...learnedRest } = learned;
        if (Object.keys(learnedRest).length > 0) guildRest.learned = learnedRest;
        expect(add, Array.isArray);
        for (const lesson of Array.isArray(add) ? add : []) {
          const object = isPlainObject(lesson);
          if (object ? !isString(lesson.brief) : given(lesson) && !isString(lesson)) dropped.shape += 1;
          const brief = text(object ? lesson.brief : lesson);
          if (!brief) continue;
          const payload = { seenAt: Number.isFinite(seenAt) ? seenAt : nowMs };
          const from = object ? teacherToken(lesson.from, isKnownId) : undefined;
          if (from) payload.from = from;
          if (object && lesson.sure === false) payload.sure = false;
          queue({ kind: 'learned', brief: [brief], payload });
        }
      }
      result.neutral.guild = guildRest;
    } else if (guild !== undefined) {
      result.neutral.guild = guild;
    }

    // A list (the single-stage shape, which replaces every fact) is never applied from stage A.
    expect(self, isPlainObject);
    if (isPlainObject(self)) {
      const lists = [
        [self.remove, (claim) => result.selfRemove.push(claim)],
        [self.add, (claim) => queue({ kind: 'self', brief: [claim] })],
      ];
      for (const [list, take] of lists) {
        expect(list, Array.isArray);
        for (const value of Array.isArray(list) ? list : []) {
          expect(value, isString);
          const claim = text(value);
          if (claim) take(claim);
        }
      }
    }
  }

  // Own keys only: `Object.assign` would run a `__proto__` key as a prototype change and let an
  // untrusted answer smuggle unsplit `users` / `guild` / `self` past the split.
  for (const [key, value] of Object.entries(rest)) {
    if (key === '__proto__') dropped.shape += 1;
    else result.neutral[key] = value;
  }
  return result;
}

/** A queue id unique against `taken` (which it joins): the base-36 time and a counter. */
function freshId(nowMs, taken) {
  const stamp = (Number.isFinite(nowMs) ? Math.max(0, Math.floor(nowMs)) : 0).toString(36);
  for (let n = 0; ; n += 1) {
    const id = `${stamp}-${n.toString(36)}`;
    if (!taken.has(id)) {
      taken.add(id);
      return id;
    }
  }
}

/** Whether `queued` holds the one slot `item` merges into or replaces: same kind, member and
 * layer (a private item never merges into a public one, nor the reverse). */
function sameSlot(queued, item) {
  if (queued.kind !== item.kind) return false;
  if (!MERGED_KINDS.has(item.kind) && item.kind !== 'character') return false;
  return (queued.userId ?? '') === (item.userId ?? '') && (queued.layer ?? '') === (item.layer ?? '');
}

/** A brief as a repeat is compared: each note normalised (src/memory/interests.js#normalizeTopic,
 * the rule src/memory/store.js#applySelfOps tells a stored self fact by), in order. */
function briefKey(brief) {
  return JSON.stringify((Array.isArray(brief) ? brief : []).map(normalizeTopic));
}

/** Whether `queued` already holds `item`'s lesson (same brief and teacher) or self fact (same brief). */
function alreadyQueued(queued, item) {
  if (!DEDUPED_KINDS.has(item.kind) || queued.kind !== item.kind) return false;
  if (briefKey(queued.brief) !== briefKey(item.brief)) return false;
  return item.kind !== 'learned' || (queued.payload?.from ?? '') === (item.payload?.from ?? '');
}

/**
 * Queue `items` (splitDecision's, or a portrait refresh's `{ kind: 'character', userId, brief }`).
 * A relationship item of a member already queued (in the same layer), and a patterns or starters
 * item, is merged into the queued one: its new briefs appended (the newest MAX_BRIEFS kept), a
 * relationship's `rewrite` flag carried over, its age and counters kept, a fresh id when anything
 * changed. A character item replaces the member's
 * queued one. A lesson (same brief and teacher) or a self fact (same brief) already queued is not
 * queued again: the queued one is kept untouched. Every other item is appended with a fresh id.
 * Then, past `memory.voice.queueMax`, the oldest items that are not `character` leave as
 * `overflow` (for degradedApply); character items never do, so a queue of only those may stay
 * above the cap.
 * @param {VoiceItem[]} queue  The stored queue (normalised); not mutated.
 * @param {object[]} items     Not mutated; an unusable one is skipped.
 * @param {number} nowMs
 * @param {object} config      The live config.
 * @returns {{ queue: VoiceItem[], overflow: VoiceItem[], added: number, merged: number }}
 *   `added`: items that grew the queue; `merged`: items folded into, replacing or already held by
 *   a queued one.
 */
export function mergeIntoQueue(queue, items, nowMs, config) {
  const { queueMax } = voiceSettings(config);
  const next = Array.isArray(queue) ? [...queue] : [];
  const taken = new Set(next.map((queued) => queued.id));
  let added = 0;
  let merged = 0;

  for (const raw of Array.isArray(items) ? items : []) {
    const item = normalizeItem(raw, nowMs);
    if (!item) continue;
    if (next.some((queued) => alreadyQueued(queued, item))) {
      merged += 1;
      continue;
    }
    const slot = next.findIndex((queued) => sameSlot(queued, item));
    if (slot !== -1 && MERGED_KINDS.has(item.kind)) {
      const queued = next[slot];
      const briefs = Array.isArray(queued.brief) ? queued.brief : [];
      const fresh = item.brief.filter((brief) => !briefs.includes(brief));
      const flagged = item.rewrite === true && queued.rewrite !== true;
      if (fresh.length > 0 || flagged) {
        next[slot] = { ...queued, id: freshId(nowMs, taken), brief: [...briefs, ...fresh].slice(-MAX_BRIEFS) };
        if (flagged) next[slot].rewrite = true;
      }
      merged += 1;
      continue;
    }
    if (slot !== -1) {
      next.splice(slot, 1);
      merged += 1;
    } else {
      added += 1;
    }
    next.push({ id: freshId(nowMs, taken), ...item });
  }

  const overflow = [];
  while (next.length > queueMax) {
    let oldest = -1;
    next.forEach((queued, index) => {
      if (queued.kind === 'character') return;
      if (oldest === -1 || queued.createdAt < next[oldest].createdAt) oldest = index;
    });
    if (oldest === -1) break;
    overflow.push(...next.splice(oldest, 1));
  }
  return { queue: next, overflow, added, merged };
}

/** Who an item's text is for: the server (public), or one member's private layer. */
function audienceOf(item) {
  return item.layer === 'private' ? `private:${item.userId}` : 'public';
}

/**
 * The items the next voice request carries: due (`nextAt` reached) and of a kind whose feature is
 * on now, oldest `createdAt` first (queue order between equals), all of ONE audience, the oldest
 * due item's (public items, or one member's private items: a request never carries what was said
 * in private beside anything else), at most `memory.voice.maxItems`. The other audiences wait for
 * the next run.
 * @param {VoiceItem[]} queue
 * @param {number} nowMs
 * @param {object} config  The live config.
 * @returns {VoiceItem[]}
 */
export function dueItems(queue, nowMs, config) {
  const { maxItems } = voiceSettings(config);
  const due = (Array.isArray(queue) ? queue : [])
    .map((item, index) => ({ item, index }))
    .filter(({ item }) => !(item.nextAt > nowMs) && kindOn(item.kind, config))
    .sort((a, b) => a.item.createdAt - b.item.createdAt || a.index - b.index)
    .map(({ item }) => item);
  if (due.length === 0) return [];
  const audience = audienceOf(due[0]);
  return due.filter((item) => audienceOf(item) === audience).slice(0, maxItems);
}

/**
 * How long an item waits after its `attempts`-th failed try: `memory.voice.retryMinutes`,
 * doubled per further try, never longer than `memory.voice.queueHours`.
 * @param {number} attempts  1 for the first retry.
 * @param {object} config    The live config.
 * @returns {number}  Milliseconds.
 */
export function retryDelayMs(attempts, config) {
  const { retryMinutes, queueHours } = voiceSettings(config);
  const tries = Math.max(1, Math.floor(Number(attempts)) || 1);
  const minutes = retryMinutes * 2 ** Math.min(tries - 1, 30);
  return Math.min(minutes * MINUTE_MS, queueHours * HOUR_MS);
}

/**
 * Back off the items `ids` names: `attempts` + 1 and `nextAt` = `nowMs` + `retryDelayMs`.
 * `missed: true` (the answer came back without them) also counts a miss; every item of a failed
 * request is retried without it. Ids not in the queue are ignored.
 * @param {VoiceItem[]} queue  Not mutated.
 * @param {string[]} ids
 * @param {number} nowMs
 * @param {object} config      The live config.
 * @param {{ missed?: boolean }} [opts]
 * @returns {VoiceItem[]}
 */
export function retryLater(queue, ids, nowMs, config, { missed = false } = {}) {
  const wanted = new Set((Array.isArray(ids) ? ids : []).map(String));
  return (Array.isArray(queue) ? queue : []).map((item) => {
    if (!wanted.has(item.id)) return item;
    const attempts = tally(item.attempts) + 1;
    return { ...item, attempts, misses: tally(item.misses) + (missed ? 1 : 0), nextAt: nowMs + retryDelayMs(attempts, config) };
  });
}

/**
 * Take out the items whose time is up: queued at least `memory.voice.queueHours` ago, left out
 * of `memory.voice.maxAttempts` answers (failed requests alone never count), or of a kind whose
 * feature was switched off since (degradedApply counts those `off`, never writes them). A
 * `character` item never expires (a portrait merge is never lost; it stays queued and due,
 * backed off at most `queueHours`).
 * @param {VoiceItem[]} queue  Not mutated.
 * @param {number} nowMs
 * @param {object} config      The live config.
 * @returns {{ queue: VoiceItem[], expired: VoiceItem[] }}  `expired` goes to degradedApply.
 */
export function expireItems(queue, nowMs, config) {
  const { queueHours, maxAttempts } = voiceSettings(config);
  const kept = [];
  const expired = [];
  for (const item of Array.isArray(queue) ? queue : []) {
    const old = nowMs - item.createdAt >= queueHours * HOUR_MS;
    const missedOut = tally(item.misses) >= maxAttempts;
    if (item.kind !== 'character' && (old || missedOut || !kindOn(item.kind, config))) expired.push(item);
    else kept.push(item);
  }
  return { queue: kept, expired };
}

/**
 * The queue without the items `ids` names (applied or gone ones, after a voice request: re-read
 * the queue, then remove only these, so an item queued during the request stays).
 * @param {VoiceItem[]} queue  Not mutated.
 * @param {string[]} ids
 * @returns {VoiceItem[]}
 */
export function removeItems(queue, ids) {
  const gone = new Set((Array.isArray(ids) ? ids : []).map(String));
  return (Array.isArray(queue) ? queue : []).filter((item) => !gone.has(item.id));
}

/**
 * The queue without what is queued about one member. By default everything (`/nep memory
 * forget`, which deletes the private layer too): items about them, public and private, and the
 * lessons they taught (`payload.from`). With `layer: 'private'` (`/nep private forget`) only
 * their private items.
 * @param {VoiceItem[]} queue  Not mutated.
 * @param {string} userId
 * @param {{ layer?: 'private' }} [opts]
 * @returns {{ queue: VoiceItem[], removed: number }}
 */
export function forgetMember(queue, userId, { layer } = {}) {
  const id = String(userId);
  const token = `<@${id}>`;
  const list = Array.isArray(queue) ? queue : [];
  const forgotten =
    layer === 'private'
      ? (item) => item.layer === 'private' && item.userId === id
      : (item) => item.userId === id || item.payload?.from === token;
  const kept = list.filter((item) => !forgotten(item));
  return { queue: kept, removed: list.length - kept.length };
}

/** `<@id>` tokens in every string of `value` (strings, arrays, plain objects) -> `name (id:...)`. */
function resolveDeep(value, nameOf) {
  if (typeof value === 'string') return fromTokens(value, nameOf, 'analyzer');
  if (Array.isArray(value)) return value.map((entry) => resolveDeep(entry, nameOf));
  if (isPlainObject(value)) return Object.fromEntries(Object.entries(value).map(([key, entry]) => [key, resolveDeep(entry, nameOf)]));
  return value;
}

/** What the voice model sees of one item, without its request id. */
function itemView(item, { limits, nameOf, oldTextOf }) {
  const view = { kind: item.kind };
  if (item.userId) view.member = fromTokens(`<@${item.userId}>`, nameOf, 'analyzer');
  if (item.layer === 'private') view.layer = 'private';
  if (item.kind === 'learned' && item.payload?.from) view.from = fromTokens(item.payload.from, nameOf, 'analyzer');
  if (OLD_TEXT_KINDS.has(item.kind)) {
    const old = oldTextOf(item);
    if (typeof old === 'string' && old.trim()) view.old = fromTokens(old.trim(), nameOf, 'analyzer');
  }
  if (item.kind === 'relationship' && item.rewrite === true) view.rewrite = true;
  if (item.kind === 'reason') view.delta = item.payload.delta;
  if (item.kind === 'feeling') {
    view.what = fromTokens(item.payload.what, nameOf, 'analyzer');
    if (item.payload.quote) view.quote = item.payload.quote;
  }
  view.brief = resolveDeep(item.brief, nameOf);
  view.limit = limits[item.kind];
  return view;
}

/**
 * Per kind, the calibrated tokens of the longest answer text one item may get back: its limit
 * overshot by `memory.clampTolerance` (what applyVoiceItems still keeps; missing or not at least
 * 1 = config.json's 1.25), priced as non-ASCII text, plus its JSON key and quotes. Pessimistic
 * on purpose.
 */
function answerPrices(limits, tolerance, calibrator) {
  const overshoot = Number.isFinite(tolerance) && tolerance >= 1 ? tolerance : MEMORY_LIMIT_DEFAULTS.clampTolerance;
  const prices = {};
  for (const [kind, chars] of Object.entries(limits)) {
    prices[kind] = calibrator.apply(estimateTokens(NON_ASCII.repeat(Math.ceil(chars * overshoot))) + ANSWER_ITEM_OVERHEAD);
  }
  return prices;
}

/**
 * Build one stage B request. System: prompts/memory-voice.md with `{{name}}`, `{{fieldChars}}`,
 * `{{guildFieldChars}}`, `{{relationshipChars}}`, `{{learnedChars}}` filled (voiceLimits). User:
 * the `<character>` block, then `<items>`: a JSON array, one object per item, `id` = its position
 * in the request ("1", "2", ...), `kind`, then the fields of that kind (`member` for the member
 * kinds, `layer: "private"` for a private item, `from` for a taught lesson, `old` for
 * relationship / patterns / starters / character when a text is stored, `rewrite: true` for a
 * relationship item due a forced rewrite (its brief may be empty), `delta` for a reason,
 * `what` and `quote` for a feeling), `brief`, `limit`; every `<@id>` token resolved to
 * `name (id:...)` except in a quote.
 *
 * Items are fitted in the order given (dueItems: oldest first) under two budgets, and one that
 * does not fit either is skipped (a later, smaller one may still go) and stays queued untouched:
 * the input, `floor(llm.maxRequestTokens * llm.safetyMargin)` (a margin that is not a number in
 * (0, 1] counts as 0.9, a missing token cap as 50000, as for a chat turn); and the answer,
 * `memory.voice.maxOutputTokens` less the answer's own JSON. An item's answer is priced at the
 * longest text it may get back (its kind's limit x `memory.clampTolerance`, non-ASCII, plus its
 * JSON key), calibrated: an answer cut by the output cap fails every item sent with it, and the
 * same items would be sent together again. The first item that fits the input always goes, even
 * alone over the answer budget. Pure.
 * @param {object} input
 * @param {object} input.prompts      Live prompts; `prompts['memory-voice']` must be non-empty.
 * @param {object} input.config       The live config.
 * @param {object} input.calibrator   From createCalibrator().
 * @param {VoiceItem[]} input.items   dueItems' list.
 * @param {string} input.selfName     The persona's display name in this guild.
 * @param {string} [input.character]  The card followed by the rules: src/memory/update.js#characterText
 *   (passed in, not imported: update.js wires this module in).
 * @param {(id: string) => (string|null)} [input.nameOf]  A member's current stored name.
 * @param {(item: VoiceItem) => (string|null)} [input.oldTextOf]  The stored text a relationship,
 *   patterns, starters or character item rewrites (with `<@id>` tokens), the member's private
 *   layer's for a private item; '' or null = none.
 * @returns {{ messages: object[], sent: string[], outputTokens: number }}  `sent`: the queue ids
 *   carried, in request order (request id `String(i + 1)` is `sent[i]`); empty = send nothing.
 *   `outputTokens`: the calibrated estimate of the longest answer `sent` can get (0 when empty),
 *   for the log line.
 * @throws {Error} the voice prompt is missing; {SectionsTooLargeError} the system message and the
 *   character block alone exceed the cap.
 */
export function buildVoiceRequest({ prompts, config, calibrator, items, selfName, character = '', nameOf, oldTextOf }) {
  const template = prompts?.['memory-voice'];
  if (typeof template !== 'string' || !template.trim()) throw new Error('prompts.memory-voice is missing or empty');
  const limits = voiceLimits(config);
  const resolveName = typeof nameOf === 'function' ? nameOf : () => null;
  const oldOf = typeof oldTextOf === 'function' ? oldTextOf : () => '';
  const system = fillPromptTemplate(template, {
    name: selfName,
    fieldChars: limits.character,
    guildFieldChars: limits.patterns,
    relationshipChars: limits.relationship,
    learnedChars: limits.learned,
  });
  const characterBlock = block('character', character);

  const list = (Array.isArray(items) ? items : []).filter((item) => item?.id && VOICE_KINDS.includes(item.kind));
  const views = list.map((item) => itemView(item, { limits, nameOf: resolveName, oldTextOf: oldOf }));
  // Sized with the widest request id the list can need, so renumbering after the fit never grows it.
  const widest = String(Math.max(1, list.length)).replace(/\d/g, '9');
  const drafts = views.map((view) => JSON.stringify({ id: widest, ...view }));

  const cost = sectionCost(calibrator);
  const limit = requestTokenLimit(config);
  // The fixed part is required: alone over the cap it throws, and nothing can be sent.
  const { used } = fitSections(
    [{ name: 'fixed', required: true, items: [system, characterBlock, block('items', '[]')].filter(Boolean) }],
    limit,
    cost,
  );

  // `keep: 'first'` on two budgets at once: walk the items in order, skip one that does not fit.
  const answerOf = answerPrices(limits, config?.memory?.clampTolerance, calibrator);
  const wrapper = calibrator.apply(ANSWER_OVERHEAD);
  let inputLeft = limit - used;
  let outputLeft = voiceSettings(config).maxOutputTokens - wrapper;
  const chosen = [];
  drafts.forEach((draft, index) => {
    const price = cost(draft);
    const answer = answerOf[list[index].kind];
    if (price > inputLeft) return;
    if (chosen.length > 0 && answer > outputLeft) return;
    chosen.push(index);
    inputLeft -= price;
    outputLeft -= answer;
  });
  const body = chosen.map((index, position) => JSON.stringify({ id: String(position + 1), ...views[index] })).join(',\n');
  const user = [characterBlock, block('items', body ? `[\n${body}\n]` : '[]')].filter(Boolean).join('\n\n');

  return {
    messages: [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ],
    sent: chosen.map((index) => list[index].id),
    outputTokens: chosen.length > 0 ? chosen.reduce((sum, index) => sum + answerOf[list[index].kind], wrapper) : 0,
  };
}

/**
 * Read a stage B answer, `{ "items": { "<request id>": "<text>" } }`: request ids map back to
 * queue ids through `sent`; an id that was not sent, an empty string and a non-string are
 * ignored (the item counts as missing). Code fences and chatter around the object are tolerated
 * (src/llm/parse.js#parseJsonObject).
 * @param {unknown} text  The model's reply.
 * @param {string[]} sent  buildVoiceRequest's `sent`.
 * @returns {Map<string, string>}  Queue id -> trimmed text.
 * @throws {Error} no JSON object, or no `items` object in it: a bad answer, not missing items.
 */
export function parseVoiceAnswer(text, sent) {
  const answer = parseJsonObject(text);
  if (!isPlainObject(answer?.items)) throw new Error('the voice answer has no items object');
  const ids = Array.isArray(sent) ? sent : [];
  const worded = new Map();
  for (const [key, value] of Object.entries(answer.items)) {
    if (!/^\d+$/.test(key)) continue;
    const queueId = ids[Number(key) - 1];
    if (queueId === undefined || typeof value !== 'string' || !value.trim()) continue;
    worded.set(queueId, value.trim());
  }
  return worded;
}

/**
 * The one follow-up request for the items whose rewrite came back over its limit (applyVoiceItems'
 * `overItems`), as a dialogue: the first request's messages unchanged, the first answer as the
 * assistant's turn, exactly as returned, then a user turn with only `<over_limit>`: a JSON object
 * keyed by the request id the model saw for the item (`String(i + 1)` for `sent[i]`), each value
 * `{ chars, limit }` (prompts/memory-voice.md). Its answer reads with parseVoiceAnswer and the same
 * `sent`. An item not in `sent` is left out. Pure: a new array, the input never mutated.
 * @param {object[]} messages  buildVoiceRequest's `messages`.
 * @param {string} answer      The first answer's text.
 * @param {{ id: string, chars: number, limit: number }[]} overItems
 * @param {string[]} sent      buildVoiceRequest's `sent`.
 * @returns {object[]}
 */
export function buildVoiceRetry(messages, answer, overItems, sent) {
  const ids = Array.isArray(sent) ? sent : [];
  const overLimit = {};
  for (const over of Array.isArray(overItems) ? overItems : []) {
    const at = ids.indexOf(over?.id);
    if (at === -1) continue;
    overLimit[String(at + 1)] = { chars: over.chars, limit: over.limit };
  }
  return [
    ...messages,
    { role: 'assistant', content: typeof answer === 'string' ? answer : '' },
    { role: 'user', content: block('over_limit', JSON.stringify(overLimit)) },
  ];
}

/**
 * @typedef {object} VoiceWrite  One store write, for the caller to run. A write with
 *   `layer: 'private'` (relationship, reason, feeling) goes to the member's private layer, never
 *   to the public profile; without it, to the public profile or the server's memory.
 *   relationship `{ id, kind, userId, layer?, text }`: the member's relationship text, its score
 *     stamp = the current score (stage A already moved it);
 *   reason `{ id, kind, userId, layer?, at, text }`: the reason of the attitude history entry
 *     stamped `at`, and `affinity.reason` when that entry is the newest; no such entry -> nothing;
 *   feeling `{ id, kind, userId, layer?, at, date, what, text }`: the feeling of the episode added
 *     at `at` whose stored `date` and `what` EQUAL these (splitDecision clamped `what` the store's
 *     way and kept one episode per address); none -> nothing;
 *   learned `{ id, kind, text, seenAt, from?, sure? }`: one `applyLearnedOps` add;
 *   self `{ id, kind, text }`: one self fact added;
 *   patterns / starters `{ id, kind, text }`: the server note replaced;
 *   character `{ id, kind, userId, text }`: the portrait replaced, and the portrait stamps
 *     (`portraitRefreshedAt`, `portraitMessageCount`) written now.
 *   The src/memory/store.js method each runs through: relationship `applyProfileOps` /
 *   `applyPrivateOps`; reason `fillAffinityReason`; feeling `fillEpisodeFeeling` (both take
 *   `{ layer }`, write nothing when the address is not found, and are safe to run twice);
 *   learned `applyLearnedOps`; self `applySelfOps`; patterns / starters `updateGuild`; character
 *   `applyProfileOps` (the text) plus `updateUser` (`portraitRefreshedAt`,
 *   `portraitMessageCount` and `portraitAttemptAt: null`, as src/memory/warmup.js#stampPortrait
 *   writes them; `applyProfileOps` cannot). The queue itself changes only through
 *   `store.updateVoiceQueue` (a synchronous read-modify-write), never from a copy kept across an
 *   await.
 */

/** The write of `item` with its (tokenized, clamped) `text`. */
function writeOf(item, text) {
  const write = { id: item.id, kind: item.kind };
  if (item.userId) write.userId = item.userId;
  if (item.layer === 'private') write.layer = 'private';
  if (item.kind === 'reason') write.at = item.payload.at;
  if (item.kind === 'feeling') Object.assign(write, { at: item.payload.at, date: item.payload.date, what: item.payload.what });
  if (item.kind === 'learned') {
    if (item.payload?.from) write.from = item.payload.from;
    if (item.payload?.sure === false) write.sure = false;
    write.seenAt = Number.isFinite(item.payload?.seenAt) ? item.payload.seenAt : item.createdAt;
  }
  write.text = text;
  return write;
}

/**
 * Turn a parsed stage B answer into store writes, by item id. Pass the sent items that are STILL
 * queued (re-read the queue after the request): an item merged or expired meanwhile is then not
 * written from a stale answer. An item of a kind whose feature was switched off meanwhile is
 * counted `off` and never written, worded or not. Each worded text is `tokenize`d and judged
 * against the stored text it rewrites (`oldTextOf`) by src/memory/prose.js#acceptProse at its
 * kind's limit (voiceLimits): a first text (nothing stored, and every kind without an old text)
 * is clamped (`memory.clampTolerance`); a rewrite within the limit is taken as it is; a rewrite
 * over it is not written and comes back in `overItems` (neither applied nor missing: the caller
 * asks once more or drops it). One left empty counts as missing. Pure.
 * @param {Map<string, string>} worded  parseVoiceAnswer's map.
 * @param {VoiceItem[]} items
 * @param {object} opts
 * @param {object} opts.config  The live config (`features.relationships`, `features.episodes`).
 * @param {(text: string) => string} [opts.tokenize]  `name (id:...)` -> `<@id>`; omitted = as written.
 * @param {(userId: string, layer?: 'private') => boolean} [opts.hasMember]  Whether the member
 *   still has a profile (with `private`: still has a private layer); omitted = always.
 * @param {(item: VoiceItem) => (string|null)} [opts.oldTextOf]  As buildVoiceRequest's: the stored
 *   text a relationship, patterns, starters or character item rewrites; omitted = none.
 * @returns {{ writes: VoiceWrite[], applied: string[], missing: string[], gone: string[],
 *   off: string[], ignored: number, portraits: string[], byKind: Record<string, number>,
 *   overItems: { id: string, chars: number, limit: number }[] }}
 *   `applied`, `gone` and `off` leave the queue (removeItems); `missing` stays queued (retryLater
 *   with `missed: true`); `ignored`: worded ids matching none of `items`; `portraits`: members
 *   whose character item was applied (stamp their portrait now); `byKind`: applied per kind;
 *   `overItems`: rewrites over their limit, nothing written (`chars` in code points of the
 *   tokenized text, as it would be stored).
 */
export function applyVoiceItems(worded, items, { config, tokenize = identity, hasMember = () => true, oldTextOf } = {}) {
  const texts = worded instanceof Map ? worded : new Map();
  const limits = voiceLimits(config);
  const tolerance = config?.memory?.clampTolerance;
  const oldOf = typeof oldTextOf === 'function' ? oldTextOf : () => '';
  const result = { writes: [], applied: [], missing: [], gone: [], off: [], ignored: 0, portraits: [], byKind: {}, overItems: [] };
  const seen = new Set();
  for (const item of Array.isArray(items) ? items : []) {
    if (!item?.id || !VOICE_KINDS.includes(item.kind) || seen.has(item.id)) continue;
    seen.add(item.id);
    if (!kindOn(item.kind, config)) {
      result.off.push(item.id);
      continue;
    }
    if (item.userId && !hasMember(item.userId, item.layer)) {
      result.gone.push(item.id);
      continue;
    }
    const raw = texts.get(item.id);
    const next = typeof raw === 'string' ? String(tokenize(raw.trim()) ?? '') : '';
    const previous = OLD_TEXT_KINDS.has(item.kind) ? oldOf(item) : '';
    const verdict = acceptProse(previous, next, limits[item.kind], { tolerance });
    if (verdict.outcome === 'over') {
      const over = overLimitOf({ text: next.trim() }, { text: limits[item.kind] }).text;
      result.overItems.push({ id: item.id, ...over });
      continue;
    }
    const text = verdict.outcome === 'empty' ? '' : verdict.text;
    if (!text) {
      result.missing.push(item.id);
      continue;
    }
    result.writes.push(writeOf(item, text));
    result.applied.push(item.id);
    result.byKind[item.kind] = (result.byKind[item.kind] ?? 0) + 1;
    if (item.kind === 'character') result.portraits.push(item.userId);
  }
  result.ignored = [...texts.keys()].filter((id) => !seen.has(id)).length;
  return result;
}

/**
 * The degraded path of items that expired or overflowed: a feeling keeps stage A's tone (its
 * brief) as the feeling; a lesson and a self fact are stored from the brief; a reason is dropped
 * (stage A already moved the score; the stored reason, `affinity.reason`, is left as it was and
 * nothing words this move later); relationship, patterns and starters are dropped and their
 * stored texts stay as they were: no stale marker brings a dropped note back (the server notes
 * have none; a relationship's, src/memory/affinity.js#relationshipStaleOf, fires on how far the
 * score moved since its text was written, never because an item was dropped), so only a later
 * batch that proposes the note again rewrites it. An item of a member gone since is dropped too.
 * An item of a kind whose feature is switched off now is counted `off` and never written. A
 * `character` item is never dropped: it comes back in `kept` for the caller to keep queued
 * (expireItems and mergeIntoQueue never hand one over). Every text it writes is a first text (the
 * kinds it keeps have nothing stored to rewrite), clamped through acceptProse as
 * applyVoiceItems clamps one. Pure.
 * @param {VoiceItem[]} items
 * @param {object} opts
 * @param {object} opts.config  The live config.
 * @param {(userId: string, layer?: 'private') => boolean} [opts.hasMember]  As applyVoiceItems';
 *   omitted = always.
 * @returns {{ writes: VoiceWrite[], degraded: string[], dropped: string[], off: string[],
 *   kept: string[] }}  Ids.
 */
export function degradedApply(items, { config, hasMember = () => true } = {}) {
  const limits = voiceLimits(config);
  const tolerance = config?.memory?.clampTolerance;
  const result = { writes: [], degraded: [], dropped: [], off: [], kept: [] };
  for (const item of Array.isArray(items) ? items : []) {
    if (!item?.id || !VOICE_KINDS.includes(item.kind)) continue;
    if (item.kind === 'character') {
      result.kept.push(item.id);
      continue;
    }
    if (!kindOn(item.kind, config)) {
      result.off.push(item.id);
      continue;
    }
    const keepsBrief = item.kind === 'feeling' || item.kind === 'learned' || item.kind === 'self';
    const brief = keepsBrief && Array.isArray(item.brief) ? (item.brief.at(-1) ?? '') : '';
    const text = brief && !(item.userId && !hasMember(item.userId, item.layer)) ? acceptProse('', brief, limits[item.kind], { tolerance }).text : '';
    if (!text) {
      result.dropped.push(item.id);
      continue;
    }
    result.writes.push(writeOf(item, text));
    result.degraded.push(item.id);
  }
  return result;
}
