// Decides whether the persona reacts to being called at all — before any LLM
// money is spent. People do not answer every ping: the persona sometimes
// ignores one for no reason, ignores more when the same person keeps tagging
// it, and almost always ignores tag spam. The model gets a second veto later
// (<skip/>) for calls that are simply not interesting.

import { ignoreAdjustment } from '../memory/index.js';
import { occursAsWholeWord } from '../memory/mentions.js';
import { MINUTE_MS } from '../time.js';

/** How the persona was called. Order matters: a pinged reply is a 'reply', not a 'mention'. */
export function detectTrigger({ mentionsSelf, repliesToSelf, content, nameTriggers }) {
  if (repliesToSelf) return 'reply';
  if (mentionsSelf) return 'mention';
  const lowered = content.toLowerCase();
  // Whole word only, so a name trigger inside a longer word or URL does not count;
  // an empty trigger never matches.
  const named = nameTriggers.some((name) => occursAsWholeWord(lowered, name.toLowerCase()));
  return named ? 'name' : null;
}

/**
 * Length of the message text without `@selfName` and without every `<@id>`
 * token (any member's, not only the persona's) -- an empty rest means a bare
 * ping, so "@persona @friend" with nothing else counts as one too.
 * @param {string} content
 * @param {string} selfName
 * @returns {number}
 */
export function strippedLength(content, selfName) {
  return content.replaceAll(`@${selfName}`, '').replace(/<@!?\d+>/g, '').trim().length;
}

/**
 * Remembers when each user called the persona, to spot repeated tags and spam.
 * Deliberately in-memory only: a restart forgiving everyone is fine.
 */
export function createTagHistory() {
  const times = new Map();
  return {
    /** Register a call and return how many calls this user made within `windowMs`, this one included. */
    hit(userId, now, windowMs) {
      const recent = (times.get(userId) ?? []).filter((ts) => now - ts <= windowMs);
      recent.push(now);
      times.set(userId, recent);
      return recent.length;
    },
  };
}

/**
 * Whether `normalized` (interfaces/discord/collect.js#normalizeMessage) tags the
 * persona for real: `selfId` is among its mentioned users and not only
 * because of Discord's reply ping (`replyPingUserId`). A reply to the
 * persona that only carries the reply ping is untagged (decideMention).
 * @param {{ mentionedUserIds?: string[], replyPingUserId?: string|null }} normalized
 * @param {string} selfId
 * @returns {boolean}
 */
export function isTaggedCall(normalized, selfId) {
  const ids = normalized?.mentionedUserIds ?? [];
  return ids.includes(selfId) && normalized.replyPingUserId !== selfId;
}

/**
 * Whether the persona answers a call. The base ignore chance depends on the
 * kind: a follow-up -- kind `followUp` (an untagged line the address
 * classifier marked as said to the persona; `overheard` never reaches this
 * roll) or an untagged `reply` (a Discord reply to the persona's line with no
 * tag, `tagged` false) -- starts from `mention.followUpIgnoreChance`
 * (missing = 0), so the persona sometimes lets the other person have the last
 * word; a `mention`, a tagged `reply` (`tagged` true or not given) start
 * from `mention.ignoreChance`; a `name` call rolls
 * `mention.nameTriggerChance` alone. The spam threshold, the bare-ping chance,
 * the repeat penalty, the affinity adjustment and the 0.97 clamp apply on top
 * as for any call; neverIgnore always answers. An ignored follow-up's reason
 * is `ignored:follow-up` (or `ignored:repeat` / `ignored:spam` when those
 * set the chance).
 * @param {object} input
 * @param {'mention'|'reply'|'name'|'followUp'} input.kind
 * @param {boolean} [input.tagged]      A `reply` only: whether it tags the persona (isTaggedCall).
 * @param {number} input.textLength     Length of the message without the mention.
 * @param {number} input.recentCalls    Calls by this user within the repeat window, this one included.
 * @param {boolean} input.neverIgnore
 * @param {number} [input.affinityScore]  The caller's stored affinity score, if known
 *   (features.relationships). Nudges the ignore chance up for someone disliked, down
 *   for someone liked; never for neverIgnore, a name trigger, or tag spam.
 * @param {object} input.cfg            config.mention
 * @param {() => number} input.rng
 * @returns {{ respond: boolean, reason: string, ignoreChance: number, roll?: number }}  `roll`
 *   is the rng value drawn (absent for neverIgnore, which rolls nothing), for the decision log.
 */
export function decideMention({ kind, tagged, textLength, recentCalls, neverIgnore, affinityScore, cfg, rng }) {
  if (neverIgnore) return { respond: true, reason: 'never-ignore', ignoreChance: 0 };

  if (kind === 'name') {
    const roll = rng();
    const respond = roll < cfg.nameTriggerChance;
    return { respond, reason: respond ? 'name' : 'name-unnoticed', ignoreChance: 1 - cfg.nameTriggerChance, roll };
  }

  const followUp = kind === 'followUp' || (kind === 'reply' && tagged === false);
  let ignoreChance = followUp ? (cfg.followUpIgnoreChance ?? 0) : cfg.ignoreChance;
  let reason = followUp ? 'follow-up' : 'random';
  if (recentCalls >= cfg.spamThreshold) {
    ignoreChance = cfg.spamIgnoreChance;
    reason = 'spam';
  } else {
    if (kind === 'mention' && textLength === 0) {
      ignoreChance = cfg.emptyMentionIgnoreChance;
      reason = 'bare-ping';
    }
    if (recentCalls > 1) {
      ignoreChance += cfg.repeatPenalty * (recentCalls - 1);
      reason = 'repeat';
    }
    ignoreChance += ignoreAdjustment(affinityScore, cfg);
  }
  ignoreChance = Math.min(0.97, Math.max(0, ignoreChance));

  const roll = rng();
  const respond = roll >= ignoreChance;
  return { respond, reason: respond ? 'respond' : `ignored:${reason}`, ignoreChance, roll };
}

/**
 * The window in which repeated calls by one member add up (`mention.repeatWindowMinutes`), in ms.
 * @param {{ repeatWindowMinutes: number }} cfg  config.mention
 * @returns {number}
 */
export const repeatWindowMs = (cfg) => cfg.repeatWindowMinutes * MINUTE_MS;

// --- The address classifier --------------------------------------------------
// After the persona answers in a channel, a conversation window stays open for
// a little while: an UNTAGGED message inside it is not answered blindly, it is
// checked by a cheap classifier first (see pipeline.js and
// docs/prompt-contract.md, "The address classifier"). The functions
// below are the pure pieces of that decision.

/**
 * Whether a follow-up window (per channel; see pipeline.js) is currently open:
 * the persona answered recently enough, and has not been ignored
 * `cfg.followUpNoStreak` times in a row since.
 * @param {{ lastAnswerAt: number, noStreak: number }|null|undefined} state
 * @param {number} now
 * @param {{ followUpMinutes?: number, followUpNoStreak?: number }} cfg  config.mention
 */
export function isFollowUpOpen(state, now, cfg) {
  if (!state) return false;
  const minutes = cfg?.followUpMinutes ?? 15;
  const noStreakLimit = cfg?.followUpNoStreak ?? 5;
  return now - state.lastAnswerAt < minutes * MINUTE_MS && state.noStreak < noStreakLimit;
}

/**
 * A mention of another member (not the persona) is always `no` before the
 * classifier is ever asked — see the prompt contract. A reply to another
 * member's message goes to the classifier like plain text; the reply ping
 * Discord adds for the replied-to author (`replyPingUserId`) is not a
 * mention. With `mention.followUpClassifyReplies` false (a missing key counts
 * as on) any reply is `no` as well. `normalized` is the shape
 * interfaces/discord/collect.js's `normalizeMessage` produces.
 * @param {{ replyToId: string|null, mentionedUserIds: string[], replyPingUserId?: string|null }} normalized
 * @param {string} selfId
 * @param {{ followUpClassifyReplies?: boolean }} [cfg]  config.mention, read by the caller now
 * @returns {boolean} true = never the persona's: the answer is "no" without asking the model
 */
export function followUpPreFilter(normalized, selfId, cfg) {
  const isReply = Boolean(normalized.replyToId);
  if (isReply && cfg?.followUpClassifyReplies === false) return true;
  const replyPing = isReply ? (normalized.replyPingUserId ?? null) : null;
  return (normalized.mentionedUserIds ?? []).some((id) => id !== selfId && id !== replyPing);
}

// Protocol token of the address classifier (docs/en/prompt-contract.md), not
// wording: the answer for a line that talks about the persona to someone else
// or to the room. Trailing punctuation is tolerated, nothing before the word.
const OVERHEARD_ANSWER = /^overheard[.,;:!?\u2026]*$/;

/**
 * The address classifier's answer (prompts/address.md): its first
 * whitespace-separated word, lower-cased. `yes` when it starts with 'y';
 * `overheard` when it is `overheard` (trailing punctuation allowed);
 * anything else, empty included, `no`. Quotes or markup around the word
 * are not stripped.
 * @param {unknown} text
 * @returns {'yes'|'overheard'|'no'}
 */
export function parseAddressAnswer(text) {
  const firstWord = (String(text ?? '').trim().split(/\s+/)[0] ?? '').toLowerCase();
  if (firstWord.startsWith('y')) return 'yes';
  return OVERHEARD_ANSWER.test(firstWord) ? 'overheard' : 'no';
}

/**
 * The two-way projection of parseAddressAnswer: `overheard` counts as `yes`,
 * so every two-word answer parses exactly as before the third answer. The
 * bot itself reads parseAddressAnswer; this stays for the classifier bench,
 * which scores yes / no.
 * @param {unknown} text
 * @returns {'yes'|'no'}
 */
export function parseFollowUpVerdict(text) {
  return parseAddressAnswer(text) === 'no' ? 'no' : 'yes';
}

/**
 * The trigger kind an address-classifier answer starts: null for `no`,
 * `followUp` for `yes`, `overheard` for `overheard` -- or `followUp` when
 * `mention.followUpOverheard` is false (a missing key counts as on).
 * @param {'yes'|'overheard'|'no'} answer
 * @param {{ followUpOverheard?: boolean }} [cfg]  config.mention, read by the caller now
 * @returns {'followUp'|'overheard'|null}
 */
export function followUpTriggerKind(answer, cfg) {
  if (answer === 'yes') return 'followUp';
  if (answer !== 'overheard') return null;
  return cfg?.followUpOverheard === false ? 'followUp' : 'overheard';
}

// --- Room questions ------------------------------------------------------------
// Outside a conversation window, an untagged line put to everyone present may
// get a higher chance of an unprompted answer (spontaneous.roomQuestionChance,
// src/behavior/pipeline.js): a cheap classifier (prompts/room.md) is asked first.
// The check below runs before any money is spent on it.

/**
 * Whether `normalized` may be a line put to the whole room, before the room
 * classifier is asked: it has text (non-empty after trim), replies to nothing
 * and mentions no member. `normalized` is the shape
 * interfaces/discord/collect.js's `normalizeMessage` produces.
 * @param {{ content?: string, replyToId?: string|null, mentionedUserIds?: string[] }} normalized
 * @returns {boolean}
 */
export function roomPreFilter(normalized) {
  if (String(normalized?.content ?? '').trim() === '') return false;
  if (normalized.replyToId) return false;
  return (normalized.mentionedUserIds ?? []).length === 0;
}

// The helper models are resolved by src/llm/roles.js#roleModel (one resolver for every role).
// The per-feature model keys older than the `classifier` block are never read;
// deprecatedModelKeys lets startup warn about them.

const DEPRECATED_MODEL_KEYS = [
  { key: 'llm.classifierModel', use: 'roles.analyzer', read: (c) => c?.llm?.classifierModel },
  { key: 'mention.followUpModel', use: 'roles.analyzer', read: (c) => c?.mention?.followUpModel },
  { key: 'media.model', use: 'roles.vision', read: (c) => c?.media?.model },
  { key: 'media.video.model', use: 'roles.video', read: (c) => c?.media?.video?.model },
];

/**
 * The old model keys set (non-null) in `config`, each with the key that
 * replaced it -- they are ignored, so startup warns about them. Key names
 * only, never a value.
 * @param {object|undefined} config  the full hot config
 * @returns {Array<{ key: string, use: string }>}
 */
export function deprecatedModelKeys(config) {
  return DEPRECATED_MODEL_KEYS.filter(({ read }) => read(config) != null).map(({ key, use }) => ({ key, use }));
}
