// Which of the server's custom emoji the members actually use, counted
// deterministically (no LLM) from every analyzer batch and kept in place.json
// as `emojiUsage: { [id]: { name, count, last } }`. The media pick
// (src/behavior/media-pick.ts) offers the top-ranked ones, so the classifier sees
// the server's habits instead of a random slice of a long emoji list. Rank is
// the shared one of src/memory/ranking.ts: `count` is the weight, `last` (the
// ts of the latest use) drives the decay.

import { isRecord, isFiniteNumber, isIntegerNumber } from './types.ts';
import { sortRanked } from './ranking.ts';
import type { StoredRecord } from './types.ts';

// Production values, config cut of 2026-10-31.
/** The custom emoji whose use the store counts. */
export const EMOJI_STORE_MAX = 200;
/** The half-life in days of an emoji's use in its rank. */
export const EMOJI_HALF_LIFE_DAYS = 30;

/**
 * The `mergeEmojiUsage` options: `storeMax` and `halfLifeDays`. Shared by the live observer (src/memory/update.ts)
 * and the history backfill.
 */
export function emojiUsageOpts(): { storeMax: number; halfLifeDays: number } {
  return { storeMax: EMOJI_STORE_MAX, halfLifeDays: EMOJI_HALF_LIFE_DAYS };
}

/**
 * A stored `emojiUsage` map made safe to read: anything but a plain object
 * becomes `{}`; an entry without a positive count is dropped, a missing name
 * becomes `''`, a missing `last` becomes 0. Never mutates `value`.
 */
export function normalizeEmojiUsage(value: unknown): Record<string, { name: string; count: number; last: number }> {
  if (!isRecord(value)) return {};
  const out: Record<string, { name: string; count: number; last: number }> = {};
  for (const [id, entry] of Object.entries(value)) {
    if (!id || !isRecord(entry)) continue;
    const count = isFiniteNumber(entry.count) ? Math.floor(entry.count) : 0;
    if (count < 1) continue;
    out[id] = {
      name: typeof entry.name === 'string' ? entry.name : '',
      count,
      last: isFiniteNumber(entry.last) ? entry.last : 0,
    };
  }
  return out;
}

/**
 * The custom emoji uses in `messages`: one use per emoji per message (the
 * message's own `emojis`, not its forwarded snapshots -- a forward shares
 * someone else's words). The persona's own messages are
 * skipped, like everywhere the analyzer counts members.
 * @param messages  Slim buffered messages; `self`/`bot`/`ts`/`emojis` read.
 */
export function countEmojiUses(
  messages: Array<StoredRecord>
): Map<string, { name: string; count: number; last: number }> {
  const uses = new Map();
  for (const message of Array.isArray(messages) ? messages : []) {
    if (!message || message.self) continue;
    const ts = isFiniteNumber(message.ts) ? message.ts : 0;
    const seen = new Set();
    for (const emoji of Array.isArray(message.emojis) ? message.emojis : []) {
      const id = emoji?.id == null ? '' : String(emoji.id);
      if (!id || typeof emoji.name !== 'string' || !emoji.name || seen.has(id)) continue;
      seen.add(id);
      const use = uses.get(id) ?? { name: emoji.name, count: 0, last: 0 };
      use.count += 1;
      if (ts >= use.last) {
        use.last = ts;
        use.name = emoji.name;
      }
      uses.set(id, use);
    }
  }
  return uses;
}

/**
 * `usage` as `[{ id, name, count, last }]`, best first:
 * `rank = log2(count + 0.5) + last / (halfLifeDays * 86_400_000)` (see
 * src/memory/ranking.ts#rank; `halfLifeDays` not a positive number -> count
 * alone). Ties go to the more recent use.
 * @param usage  A stored `emojiUsage` map (normalised here).
 */
export function rankEmojiUsage(
  usage: unknown,
  halfLifeDays?: number
): Array<{ id: string; name: string; count: number; last: number }> {
  const items = Object.entries(normalizeEmojiUsage(usage)).map(([id, entry]) => ({
    id,
    ...entry,
    weight: entry.count,
    lastSeen: entry.last > 0 ? new Date(entry.last).toISOString() : null,
  }));
  return sortRanked(items, halfLifeDays).map(({ id, name, count, last }) => ({ id, name, count, last }));
}

/**
 * `usage` with the uses of `messages` added (see `countEmojiUses`): counts
 * accumulate, `last` and `name` follow the latest use. Past `storeMax`
 * entries the lowest-ranked are evicted (`storeMax` not a non-negative
 * integer -> no cap). Never mutates `usage`.
 */
export function mergeEmojiUsage(
  usage: unknown,
  messages: Array<StoredRecord>,
  { storeMax, halfLifeDays }: { storeMax?: number; halfLifeDays?: number } = {}
): { usage: Record<string, { name: string; count: number; last: number }>; counted: number } {
  const next = normalizeEmojiUsage(usage);
  let counted = 0;
  for (const [id, use] of countEmojiUses(messages)) {
    const before = next[id];
    const newer = !before || use.last >= before.last;
    // Re-inserted so a just-used emoji sits last: an exact rank tie keeps it (see sortByRank).
    delete next[id];
    next[id] = {
      name: newer ? use.name : before.name,
      count: (before?.count ?? 0) + use.count,
      last: newer ? use.last : before.last,
    };
    counted += use.count;
  }
  const ids = Object.keys(next);
  if (isIntegerNumber(storeMax) && storeMax >= 0 && ids.length > storeMax) {
    const kept = new Set(
      rankEmojiUsage(next, halfLifeDays)
        .slice(0, storeMax)
        .map((entry) => entry.id)
    );
    for (const id of ids) if (!kept.has(id)) delete next[id];
  }
  return { usage: next, counted };
}
