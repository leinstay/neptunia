// Shared ranking for stored interests/details (src/memory/interests.ts,
// src/memory/details.ts): how "alive" one atomic item still is, combining how
// often it was confirmed (`weight`) with how long ago it was last mentioned,
// so a frequent-and-recent item outranks an ancient heavy one and a newcomer
// can gather weight in the unseen tail instead of being evicted the moment it
// arrives -- see docs/prompt-contract.md, "More is stored than shown,
// and rank decays with age". Used by the storage-eviction code in
// interests.ts/details.ts, the chat-facing renderer (src/behavior/prompt.js)
// and `/nep memory show` (src/admin.js) -- every place that decides what is
// shown or what survives an eviction goes through the SAME function, so a
// history backfill and the live bot agree on what matters.

import { DAY_MS } from '../time.js';
import { isFiniteNumber, isIntegerNumber } from './types.ts';

/** `lastSeen`, falling back to `firstSeen`, else the epoch (0) -- see
 * `rank` below. An unparsable date string is treated the same as a missing
 * one, never throws. */
// A GIF entry's `firstSeen` is an epoch number, read the same way as an ISO string (Date.parse of its text).
type Ranked = { weight?: number; lastSeen?: string | null; firstSeen?: string | number | null };

function resolvedDateMs(item: Ranked): number {
  const iso = item?.lastSeen ?? item?.firstSeen ?? null;
  const ms = iso ? Date.parse(String(iso)) : NaN;
  return isFiniteNumber(ms) ? ms : 0;
}

/**
 * `rank(item, halfLifeDays) = log2(weight + 0.5) + lastSeenMs / (halfLifeDays * 86_400_000)`.
 * `lastSeen` unknown falls back to `firstSeen`, else 0 (the epoch). Deliberately
 * uses the ABSOLUTE timestamp, not an age relative to "now": rank is meant to
 * compare two items against each other, and the difference between their
 * ranks must not depend on when the comparison happens -- the same function
 * therefore serves a history backfill and the live bot alike. One
 * half-life of silence costs exactly 1 off the rank -- the same as it takes
 * for `weight` to double (a unit in log2). `halfLifeDays` not a positive,
 * finite number disables decay entirely: rank is pure `log2(weight + 0.5)`.
 */
export function rank(item: Ranked, halfLifeDays?: number): number {
  const weight = typeof item?.weight === 'number' && isFiniteNumber(item.weight) ? item.weight : 0;
  const base = Math.log2(weight + 0.5);
  if (typeof halfLifeDays !== 'number' || !isFiniteNumber(halfLifeDays) || halfLifeDays <= 0) return base;
  return base + resolvedDateMs(item) / (halfLifeDays * DAY_MS);
}

/**
 * `items` ordered best (highest rank) first -- never mutates `items`, does
 * not resolve equal-rank ties by re-reading a fresh `Date.now()`. A tie in
 * rank (identical weight and date, or both decay-off with equal weight) is
 * broken by whichever item's resolved date (`lastSeen`/`firstSeen`) is newer;
 * a further tie (including two items that both lack any date) keeps whichever
 * sits LATER in `items` ahead -- a just-touched item in this very call is at
 * least as fresh as one nothing happened to, so it is treated as the newer of
 * the two. See docs/prompt-contract.md, "More is stored than shown,
 * and rank decays with age".
 */
export function sortRanked<TItem extends Ranked>(items: Array<TItem>, halfLifeDays?: number): Array<TItem> {
  return items
    .map((item, index) => ({ item, index }))
    .sort((a, b) => {
      const rankDiff = rank(b.item, halfLifeDays) - rank(a.item, halfLifeDays);
      if (rankDiff !== 0) return rankDiff;
      const dateDiff = resolvedDateMs(b.item) - resolvedDateMs(a.item);
      if (dateDiff !== 0) return dateDiff;
      return b.index - a.index;
    })
    .map(({ item }) => item);
}

/** `sortRanked` for a caller that does not read the items' fields back: the same order, as plain objects. */
export function sortByRank(items: Array<object>, halfLifeDays?: number): Array<object> {
  return sortRanked(items, halfLifeDays);
}

/**
 * The top `n` items by rank (see `sortByRank`), best first. `n` not a
 * non-negative integer -> every item (no cap).
 */
export function topRanked<TItem extends Ranked>(items: Array<TItem>, n?: number, halfLifeDays?: number): Array<TItem> {
  const cap = typeof n === 'number' && isIntegerNumber(n) && n >= 0 ? n : items.length;
  return sortRanked(items, halfLifeDays).slice(0, cap);
}

/** `topRanked` as plain objects. */
export function topByRank(items: Array<object>, n?: number, halfLifeDays?: number): Array<object> {
  return topRanked(items, n, halfLifeDays);
}
