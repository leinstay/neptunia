// The pure pieces of the door (src/pipeline/handle-message.ts): how a line carries the interface's flags, the attention
// window and the per-author rail in front of a turn, and the answers of the address classifier. A flag is a fact an
// interface reports; whether the line was said to her is the classifier's verdict.

import { strictJsonObject } from '../llm/parse.ts';
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

/** The words of a text, case-folded: runs of letters and digits. */
const wordsOf = (text: string | null | undefined): Array<string> =>
  (text ?? '')
    .normalize('NFC')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);

/**
 * Whether `text` names one of `aliases`: its words, each through `stemmer` when there is one, hold the words of an alias
 * in a row. Without a stemmer a word must equal the alias's word, so a short alias never matches inside a longer word.
 */
export function namesAlias(
  text: string | null | undefined,
  aliases: ReadonlyArray<string>,
  stemmer: { stem: (word: string) => string } | null
): boolean {
  const key = (word: string): string => (stemmer ? stemmer.stem(word) : word);
  const words = wordsOf(text).map(key);
  return aliases.some((alias) => {
    const wanted = wordsOf(alias).map(key);
    if (wanted.length === 0) return false;
    for (let i = 0; i + wanted.length <= words.length; i += 1)
      if (wanted.every((word, j) => words[i + j] === word)) return true;
    return false;
  });
}

/** Whether her post at `lastPostAt` still holds attention at `now`: the window excludes its own edge. */
export function inAttention(lastPostAt: number | undefined, now: number, minutes: number): boolean {
  return lastPostAt !== undefined && now - lastPostAt < minutes * MINUTE_MS;
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

/** The three answers of the address classifier (docs/prompt-contract.md). */
const ADDRESS_ANSWERS: ReadonlySet<unknown> = new Set(['yes', 'overheard', 'no']);

/**
 * The address classifier's answer (prompts/address.md): the text is the JSON
 * object `{ "answer": ... }` and its `answer` is `yes`, `overheard` or `no`,
 * exactly. Anything else is null: text that is not JSON (a bare word or a
 * code fence included), JSON that is not an object, an object without
 * `answer`, or a value outside the three. The caller treats null as a failed call.
 */
export function parseAddressAnswer(text: unknown): 'yes' | 'overheard' | 'no' | null {
  const answer = strictJsonObject(text)?.answer;
  return ADDRESS_ANSWERS.has(answer) ? (answer as 'yes' | 'overheard' | 'no') : null;
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

/** The video settings of a config (`media.video`). */
const videoOf = (config: Untyped) => config?.media?.video;

const DEPRECATED_MODEL_KEYS = [
  { key: 'llm.classifierModel', use: 'models.routes.analyzer', read: (c: Untyped) => c?.llm?.classifierModel },
  { key: 'mention.followUpModel', use: 'models.routes.analyzer', read: (c: Untyped) => c?.mention?.followUpModel },
  { key: 'media.model', use: 'models.routes.vision', read: (c: Untyped) => c?.media?.model },
  { key: 'media.video.model', use: 'models.routes.video', read: (c: Untyped) => videoOf(c)?.model },
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
