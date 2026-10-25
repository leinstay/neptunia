// Shared ranking for stored interests/details (src/memory/interests.js,
// src/memory/details.js): how "alive" one atomic item still is, combining how
// often it was confirmed (`weight`) with how long ago it was last mentioned,
// so a frequent-and-recent item outranks an ancient heavy one and a newcomer
// can gather weight in the unseen tail instead of being evicted the moment it
// arrives -- see docs/prompt-contract.md, "More is stored than shown,
// and rank decays with age". Used by the storage-eviction code in
// interests.js/details.js, the chat-facing renderer (src/behavior/prompt.js)
// and `/nep memory show` (src/admin.js) -- every place that decides what is
// shown or what survives an eviction goes through the SAME function, so a
// history backfill and the live bot agree on what matters.

import { DAY_MS } from '../time.js';

/** `lastSeen`, falling back to `firstSeen`, else the epoch (0) -- see
 * `rank` below. An unparsable date string is treated the same as a missing
 * one, never throws. */
function resolvedDateMs(item) {
  const iso = item?.lastSeen ?? item?.firstSeen ?? null;
  const ms = iso ? Date.parse(iso) : NaN;
  return Number.isFinite(ms) ? ms : 0;
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
 * @param {{ weight?: number, lastSeen?: string|null, firstSeen?: string|null }} item
 * @param {number} [halfLifeDays]
 * @returns {number}
 */
export function rank(item, halfLifeDays) {
  const weight = Number.isFinite(item?.weight) ? item.weight : 0;
  const base = Math.log2(weight + 0.5);
  if (!Number.isFinite(halfLifeDays) || halfLifeDays <= 0) return base;
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
 * @param {object[]} items
 * @param {number} [halfLifeDays]
 * @returns {object[]}
 */
export function sortByRank(items, halfLifeDays) {
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

/**
 * The top `n` items by rank (see `sortByRank`), best first. `n` not a
 * non-negative integer -> every item (no cap).
 * @param {object[]} items
 * @param {number} [n]
 * @param {number} [halfLifeDays]
 * @returns {object[]}
 */
export function topByRank(items, n, halfLifeDays) {
  const cap = Number.isInteger(n) && n >= 0 ? n : items.length;
  return sortByRank(items, halfLifeDays).slice(0, cap);
}
