// The pure pieces of the door (src/pipeline/handle-message.ts): how a line carries the interface's flags, the attention
// window and the per-author rail in front of a turn, and the answers of the address classifier. A flag is a fact an
// interface reports; whether the line was said to her is the classifier's verdict.

import { MINUTE_MS } from '../time.ts';
import type { Untyped } from '../tools/types.ts';

/** How a line carries the interface's flags. Order matters: a pinged reply is a 'reply', not a 'mention'. */
export function detectTrigger({
  mentionsSelf,
  repliesToSelf,
}: {
  mentionsSelf: unknown;
  repliesToSelf: unknown;
}): 'reply' | 'mention' | null {
  if (repliesToSelf) return 'reply';
  return mentionsSelf ? 'mention' : null;
}

/**
 * Length of the message text without `@selfName` and without every `<@id>`
 * token (any member's, not only the persona's) -- an empty rest means a bare
 * ping, so "@persona @friend" with nothing else counts as one too.
 */
export function strippedLength(content: string, selfName: string): number {
  return content
    .replaceAll(`@${selfName}`, '')
    .replace(/<@!?\d+>/g, '')
    .trim().length;
}

/**
 * Remembers when a turn started under a key, for the per-author rail (decideTurn). Deliberately in-memory only: a
 * restart forgiving everyone is fine.
 */
export function createTagHistory(): {
  count(key: string, now: number, windowMs: number): number;
  hit(key: string, now: number, windowMs: number): number;
} {
  const times = new Map<string, Array<number>>();
  const recentOf = (key: string, now: number, windowMs: number) =>
    (times.get(key) ?? []).filter((ts) => now - ts < windowMs);
  return {
    /** How many hits `key` has within `windowMs`. */
    count: (key, now, windowMs) => recentOf(key, now, windowMs).length,
    /** Register a hit and return how many `key` has within `windowMs`, this one included. */
    hit(key, now, windowMs) {
      const recent = recentOf(key, now, windowMs);
      recent.push(now);
      times.set(key, recent);
      return recent.length;
    },
  };
}

/**
 * Whether `normalized` (src/protocol/events.js#Message) tags the
 * persona for real: `selfId` is among its mentioned users and not only
 * because of the platform's reply ping (`replyPingAccountId`). A reply to the
 * persona that only carries the reply ping is untagged (decideMention).
 */
export function isTaggedCall(
  normalized: { mentionedAccountIds?: Array<string>; replyPingAccountId?: string | null },
  selfId: string
): boolean {
  const ids = normalized?.mentionedAccountIds ?? [];
  return ids.includes(selfId) && normalized.replyPingAccountId !== selfId;
}

/**
 * The per-author rail in front of a turn the classifier asked for: past `limit` started turns (`turns`, of one author
 * in one place within `address.attentionMinutes`) a turn is refused. `limit` 0 switches the rail off, and an author in
 * `mention.neverIgnore` is never refused.
 */
export function decideTurn({ turns, limit, neverIgnore }: { turns: number; limit: number; neverIgnore: boolean }): {
  respond: boolean;
  reason: 'never-ignore' | 'respond' | 'refused';
} {
  if (neverIgnore) return { respond: true, reason: 'never-ignore' };
  return limit > 0 && turns >= limit ? { respond: false, reason: 'refused' } : { respond: true, reason: 'respond' };
}

/** Whether her post at `lastPostAt` still holds attention at `now`: the window excludes its own edge. */
export function inAttention(lastPostAt: number | undefined, now: number, minutes: number): boolean {
  return lastPostAt !== undefined && now - lastPostAt < minutes * MINUTE_MS;
}

/**
 * The names of the `## Aliases` section of the character card, one per line, a list bullet dropped. Empty for a card
 * without the section, whose heading ends at the next `## ` heading.
 */
export function cardAliases(card: unknown): Array<string> {
  if (typeof card !== 'string') return [];
  const found = /^## Aliases[ \t]*$/m.exec(card);
  if (!found) return [];
  const rest = card.slice(found.index + found[0].length);
  const next = /^## /m.exec(rest);
  return (next ? rest.slice(0, next.index) : rest)
    .split('\n')
    .map((line) => line.replace(/^\s*[-*]\s+/, '').trim())
    .filter(Boolean);
}

/**
 * An unflagged line that mentions another member (not the persona) is `no` before the
 * classifier is ever asked — see the prompt contract. A reply to another
 * member's message goes to the classifier like plain text; the reply ping
 * the platform adds for the replied-to author (`replyPingAccountId`) is not a
 * mention. `normalized` is the shape of src/protocol/events.js#Message.
 * @returns true = never the persona's: the answer is "no" without asking the model
 */
export function followUpPreFilter(
  normalized: { replyToId: string | null; mentionedAccountIds: Array<string>; replyPingAccountId?: string | null },
  selfId: string
): boolean {
  const isReply = Boolean(normalized.replyToId);
  const replyPing = isReply ? (normalized.replyPingAccountId ?? null) : null;
  return (normalized.mentionedAccountIds ?? []).some((id) => id !== selfId && id !== replyPing);
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
 */
export function parseAddressAnswer(text: unknown): 'yes' | 'overheard' | 'no' {
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
 */
export function parseFollowUpVerdict(text: unknown): 'yes' | 'no' {
  return parseAddressAnswer(text) === 'no' ? 'no' : 'yes';
}

/**
 * The trigger kind an address-classifier answer starts: null for `no`,
 * `followUp` for `yes`, `overheard` for `overheard`.
 */
export function followUpTriggerKind(answer: 'yes' | 'overheard' | 'no'): 'followUp' | 'overheard' | null {
  if (answer === 'yes') return 'followUp';
  return answer === 'overheard' ? 'overheard' : null;
}

// The model roles are resolved by src/llm/roles.js#roleModel (one resolver for every model role).
// The per-feature model keys older than the `classifier` block are never read;
// deprecatedModelKeys lets startup warn about them.

const DEPRECATED_MODEL_KEYS = [
  { key: 'llm.classifierModel', use: 'models.base.analyzer', read: (c: Untyped) => c?.llm?.classifierModel },
  { key: 'mention.followUpModel', use: 'models.base.analyzer', read: (c: Untyped) => c?.mention?.followUpModel },
  { key: 'media.model', use: 'models.base.vision', read: (c: Untyped) => c?.media?.model },
  { key: 'media.video.model', use: 'models.base.video', read: (c: Untyped) => c?.media?.video?.model },
];

/**
 * The old model keys set (non-null) in `config`, each with the key that
 * replaced it -- they are ignored, so startup warns about them. Key names
 * only, never a value.
 * @param config  the full hot config
 */
export function deprecatedModelKeys(config: Record<string, Untyped> | undefined): Array<{ key: string; use: string }> {
  return DEPRECATED_MODEL_KEYS.filter(({ read }) => read(config) != null).map(({ key, use }) => ({ key, use }));
}
