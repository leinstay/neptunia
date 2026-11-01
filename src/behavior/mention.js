// Decides whether the persona reacts to being called at all — before any LLM
// money is spent: she almost always ignores tag spam. The model gets a second veto later
// (<skip/>) for calls that are simply not interesting.

import { occursAsWholeWord } from '../memory/mentions.ts';
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
  return content
    .replaceAll(`@${selfName}`, '')
    .replace(/<@!?\d+>/g, '')
    .trim().length;
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
 * Whether `normalized` (src/protocol/events.ts#Message) tags the
 * persona for real: `selfId` is among its mentioned users and not only
 * because of the platform's reply ping (`replyPingUserId`). A reply to the
 * persona that only carries the reply ping is untagged (decideMention).
 * @param {{ mentionedUserIds?: string[], replyPingUserId?: string|null }} normalized
 * @param {string} selfId
 * @returns {boolean}
 */
export function isTaggedCall(normalized, selfId) {
  const ids = normalized?.mentionedUserIds ?? [];
  return ids.includes(selfId) && normalized.replyPingUserId !== selfId;
}

// The call decision's measures. Production values, config cut of 2026-10-31.
/** The calls by one member inside SPAM_WINDOW_MINUTES from which on they are spam. */
const SPAM_THRESHOLD = 50;
/** The chance a spam call is ignored. */
const SPAM_IGNORE_CHANCE = 0.9;
/** The chance a call by her name is noticed. */
const NAME_TRIGGER_CHANCE = 1;
/** The window in which one member's calls add up for the spam count, in minutes. */
const SPAM_WINDOW_MINUTES = 10;

/**
 * Whether the persona answers a call. A `name` call is noticed at NAME_TRIGGER_CHANCE; any other call is answered
 * unless it is tag spam (SPAM_THRESHOLD calls by the member inside the window, ignored at SPAM_IGNORE_CHANCE);
 * neverIgnore always answers. An ignored call's reason is `ignored:spam`.
 * @param {object} input
 * @param {'mention'|'reply'|'name'|'followUp'} input.kind
 * @param {number} input.recentCalls    Calls by this user within the spam window, this one included.
 * @param {boolean} input.neverIgnore
 * @param {() => number} input.rng
 * @returns {{ respond: boolean, reason: string, ignoreChance: number, roll?: number }}  `roll`
 *   is the rng value drawn (absent for neverIgnore, which rolls nothing), for the decision log.
 */
export function decideMention({ kind, recentCalls, neverIgnore, rng }) {
  if (neverIgnore) return { respond: true, reason: 'never-ignore', ignoreChance: 0 };

  if (kind === 'name') {
    const roll = rng();
    const respond = roll < NAME_TRIGGER_CHANCE;
    return { respond, reason: respond ? 'name' : 'name-unnoticed', ignoreChance: 1 - NAME_TRIGGER_CHANCE, roll };
  }

  const ignoreChance = recentCalls >= SPAM_THRESHOLD ? SPAM_IGNORE_CHANCE : 0;
  const roll = rng();
  const respond = roll >= ignoreChance;
  return { respond, reason: respond ? 'respond' : 'ignored:spam', ignoreChance, roll };
}

/** The window in which one member's calls add up for the spam count, in ms. */
export const SPAM_WINDOW_MS = SPAM_WINDOW_MINUTES * MINUTE_MS;

// --- The address classifier --------------------------------------------------
// Production values, config cut of 2026-10-31.
/** How long a follow-up window stays open after her answer, in minutes. */
export const FOLLOW_UP_MINUTES = 15;
/** The "no" verdicts in a row that close a follow-up window. */
export const FOLLOW_UP_NO_STREAK = 5;

// After the persona answers in a channel, a conversation window stays open for
// a little while: an UNTAGGED message inside it is not answered blindly, it is
// checked by a cheap classifier first (see pipeline.js and
// docs/prompt-contract.md, "The address classifier"). The functions
// below are the pure pieces of that decision.

/**
 * Whether a follow-up window (per channel; see pipeline.js) is currently open:
 * the persona answered within FOLLOW_UP_MINUTES, and has not been ignored
 * FOLLOW_UP_NO_STREAK times in a row since.
 * @param {{ lastAnswerAt: number, noStreak: number }|null|undefined} state
 * @param {number} now
 */
export function isFollowUpOpen(state, now) {
  if (!state) return false;
  return now - state.lastAnswerAt < FOLLOW_UP_MINUTES * MINUTE_MS && state.noStreak < FOLLOW_UP_NO_STREAK;
}

/**
 * A mention of another member (not the persona) is always `no` before the
 * classifier is ever asked — see the prompt contract. A reply to another
 * member's message goes to the classifier like plain text; the reply ping
 * the platform adds for the replied-to author (`replyPingUserId`) is not a
 * mention. `normalized` is the shape of src/protocol/events.ts#Message.
 * @param {{ replyToId: string|null, mentionedUserIds: string[], replyPingUserId?: string|null }} normalized
 * @param {string} selfId
 * @returns {boolean} true = never the persona's: the answer is "no" without asking the model
 */
export function followUpPreFilter(normalized, selfId) {
  const isReply = Boolean(normalized.replyToId);
  const replyPing = isReply ? (normalized.replyPingUserId ?? null) : null;
  return (normalized.mentionedUserIds ?? []).some((id) => id !== selfId && id !== replyPing);
}

// Protocol token of the address classifier (docs/prompt-contract.md), not
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
  const firstWord = (
    String(text ?? '')
      .trim()
      .split(/\s+/)[0] ?? ''
  ).toLowerCase();
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
 * `followUp` for `yes`, `overheard` for `overheard`.
 * @param {'yes'|'overheard'|'no'} answer
 * @returns {'followUp'|'overheard'|null}
 */
export function followUpTriggerKind(answer) {
  if (answer === 'yes') return 'followUp';
  return answer === 'overheard' ? 'overheard' : null;
}

// The model roles are resolved by src/llm/roles.ts#roleModel (one resolver for every model role).
// The per-feature model keys older than the `classifier` block are never read;
// deprecatedModelKeys lets startup warn about them.

const DEPRECATED_MODEL_KEYS = [
  { key: 'llm.classifierModel', use: 'models.base.analyzer', read: (c) => c?.llm?.classifierModel },
  { key: 'mention.followUpModel', use: 'models.base.analyzer', read: (c) => c?.mention?.followUpModel },
  { key: 'media.model', use: 'models.base.vision', read: (c) => c?.media?.model },
  { key: 'media.video.model', use: 'models.base.video', read: (c) => c?.media?.video?.model },
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
