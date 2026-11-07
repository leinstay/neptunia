// The recent store, pure: short dated lines about the last few days that fit
// no long-term kind of memory (an episode, lore, a self fact, a lesson) yet
// matter for the next days. src/memory/store.ts keeps them in data/places/<id>/recent.json and runs every
// write through `mergeRecent`. The clock is passed in (`now`); only a missing
// one falls back to the wall clock.
//
// One number rules a line's life (the lead's ruling: no separate, longer
// retention): it lives `memory.recentHours` after its moment (`at`, the time of
// the message it is about) and is dropped at the next write past that, never on
// read. So a hot LOWERING of `memory.recentHours` narrows the view at once and,
// at the next write (the analyzer's next batch), deletes every line older than
// the new number; raising it again brings none of them back. Besides expiry a
// line leaves only through the storage cap (`memory.maxRecentStored`: when a
// write adds lines, the lightest, then the oldest go), an explicit remove of its
// id (the analyzer takes back a line that is wrong), a forget of a member it
// names (`purgeRecentFor`) or a wipe of the place (src/memory/store.ts). A line
// is never promoted: nothing here copies or moves it into another store.
//
// Every line records the channel it comes from (`placeId`): a later view
// shows a line only where that channel's audience allows it, so a line without
// one is never stored (counted `noChannel`). `who` (the member ids its `<@id>`
// tokens name) is computed from the text here, never taken from the model.
//
// `foldText` is the project's one diacritic fold (lower case, NFD, combining
// marks removed, whitespace collapsed): the duplicate test here, and any later
// text matching that must ignore accents, use this copy. Besides accents it
// folds letters that NFD splits into a base letter and a mark, e.g. U+0451
// into U+0435 and U+0439 into U+0438: harmless for duplicates, but it widens a
// whole-word match.
//
// `recentView` is the view by time a turn shows as `<recent>` (built by
// src/behavior/prompt.js): the live lines a caller's audience predicate lets
// through, then the moments of members (src/memory/episodes.ts) that fall inside
// the same window, read from the profiles by reference and never copied here.
// It only ranks; the request builder renders, caps and re-orders by time. A
// stored moment has no time of its own, only its `date` (the day the model
// wrote, in the server's zone) and `addedAt` (when the analyzer stored it):
// both have to fall in the window
// (see `momentAt`).

import { isRecord, isFiniteNumber, isIntegerNumber } from './types.ts';
import { HOUR_MS } from '../time.ts';
import { clampText, oneLine, stripUrls } from './clamp.ts';
import { isWordChar, occursAsWholeWord, tokenIds } from './mentions.ts';
import { MEMORY_LIMITS } from './text-limits.ts';
import type { Untyped } from './types.ts';

/**
 * config.json's own values for the recent layer's settings, the code fallbacks
 * when a deployment's config lacks a key: `memory.recentHours` (`hours`),
 * `memory.maxRecentStored` (`maxStored`), `memory.maxNewRecent` (`maxNew`),
 * `memory.recentChars` (`chars`) and `memory.recentShown` (`shown`, the live
 * lines the analyzer is shown).
 */
export const RECENT_DEFAULTS = Object.freeze({ hours: 72, maxStored: 150, maxNew: 3, chars: 160, shown: 12 });

/** The lightest and heaviest weight a line can carry, and the weight it gets when none (or no integer) is given. */
const MIN_WEIGHT = 1;
const MAX_WEIGHT = 3;
const DEFAULT_WEIGHT = 2;

/** The fewest letters and digits a member name (once folded) needs for a purge to match it as a
 * word: symbols and underscores do not count, so a name like `-_-` matches nothing. */
const MIN_PURGE_NAME = 3;

/**
 * The recent layer's settings (MEMORY_LIMITS of src/memory/text-limits.ts), spread into the options of
 * `mergeRecent` and src/memory/store.ts#applyRecentOps. The live config holds none of them.
 */
export const recentSettings: (config?: unknown) => {
  hours: number;
  maxStored: number;
  maxNew: number;
  chars: number;
  shown: number;
  clampTolerance: number;
} = () => ({
  hours: MEMORY_LIMITS.recentHours,
  maxStored: MEMORY_LIMITS.maxRecentStored,
  maxNew: MEMORY_LIMITS.maxNewRecent,
  chars: MEMORY_LIMITS.recentChars,
  shown: MEMORY_LIMITS.recentShown,
  clampTolerance: MEMORY_LIMITS.clampTolerance,
});

/** One line of the recent store: a message-sized note of the last days, with the members its text names. */
export type RecentLine = {
  id: number;
  at: number;
  addedAt: string | null;
  placeId: string;
  text: string;
  who: Array<string>;
  weight: number;
  itemId?: string;
};

/**
 * The store of a place nothing was written to yet.
 */
export function emptyRecent(): { nextId: number; lines: Array<RecentLine> } {
  return { nextId: 1, lines: [] };
}

/**
 * `text` folded for comparison: lower case, NFD, combining marks (`\p{M}`)
 * removed, every run of whitespace one space, trimmed. Never stored. A
 * null/undefined `text` folds to ''.
 */
export function foldText(text: unknown): string {
  return String(text ?? '')
    .toLowerCase()
    .normalize('NFD')
    .replace(/\p{M}+/gu, '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/** `raw` as a line's weight: an integer clamped to 1..3, anything else 2. */
function weightOf(raw: unknown): number {
  if (!isIntegerNumber(raw)) return DEFAULT_WEIGHT;
  return Math.min(MAX_WEIGHT, Math.max(MIN_WEIGHT, raw));
}

/** `raw` as a channel id: a non-empty string, trimmed; anything else null. */
function channelIdOf(raw: Untyped) {
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

/** A finite number of at least 0, floored, or `fallback`. */
function countOr<TFallback>(raw: unknown, fallback: TFallback): number | TFallback {
  return typeof raw === 'number' && isFiniteNumber(raw) && raw >= 0 ? Math.floor(raw) : fallback;
}

/** The start of the window `hours` back from `now` (epoch ms): `hours` a finite number of at
 * least 0, else `RECENT_DEFAULTS.hours`; `now` a finite number, else the wall clock. */
function windowStart(now: number, hours: unknown) {
  const span = typeof hours === 'number' && isFiniteNumber(hours) && hours >= 0 ? hours : RECENT_DEFAULTS.hours;
  return now - span * HOUR_MS;
}

/** `raw` as a clock reading: a finite number, else the wall clock. */
function nowOf(raw: unknown): number {
  return isFiniteNumber(raw) ? raw : Date.now();
}

/** `raw` as a stored line id: a positive integer, or a string of digits naming one; else null. */
function lineIdOf(raw: Untyped) {
  const n = typeof raw === 'string' && /^\d+$/.test(raw.trim()) ? Number(raw.trim()) : raw;
  return isIntegerNumber(n) && n >= 1 ? n : null;
}

/**
 * A stored value (untrusted: possibly hand-edited while paused, or from an
 * older version) as the store holds it. A line that is not an object, or lacks
 * a positive integer `id`, a finite `at`, a non-empty `text` or a non-empty
 * string `placeId`, is dropped. A line whose id an earlier line already holds
 * gets a fresh id: the stored `nextId` or the one after the highest id,
 * whichever is larger, so a healed line never takes an id a gone line once held.
 * `text` is kept on one line, `weight` clamped (see `mergeRecent`), `who`
 * recomputed from the text, `addedAt` kept when it is a string, else null,
 * an optional non-empty string `itemId` kept (never added).
 * `nextId` ends above every id. Pure: `value` is never mutated, and the result
 * normalises to itself.
 */
export function normalizeRecent(value: unknown): { nextId: number; lines: Array<RecentLine> } {
  const source = isRecord(value) ? value : {};
  const valid: Array<RecentLine> = [];
  for (const raw of Array.isArray(source.lines) ? source.lines : []) {
    if (!isRecord(raw)) continue;
    const id = isIntegerNumber(raw.id) && raw.id >= 1 ? raw.id : null;
    const text = typeof raw.text === 'string' ? oneLine(raw.text) : '';
    const placeId = channelIdOf(raw.placeId);
    if (id === null || !isFiniteNumber(raw.at) || !text || placeId === null) continue;
    const line: RecentLine = {
      id,
      at: raw.at,
      addedAt: typeof raw.addedAt === 'string' ? raw.addedAt : null,
      placeId,
      text,
      who: tokenIds(text),
      weight: weightOf(raw.weight),
    };
    if (typeof raw.itemId === 'string' && raw.itemId) line.itemId = raw.itemId;
    valid.push(line);
  }
  const storedNext = lineIdOf(source.nextId) ?? 1;
  let lastId = Math.max(storedNext - 1, ...valid.map((line) => line.id));
  const seen = new Set();
  const lines = valid.map((line) => {
    if (!seen.has(line.id)) {
      seen.add(line.id);
      return line;
    }
    lastId += 1;
    seen.add(lastId);
    return { ...line, id: lastId };
  });
  return { nextId: lastId + 1, lines };
}

/** Ascending sort key for eviction: the lightest first, then the oldest moment, then the lowest id. */
function evictionOrder(a: { id: number; at: number; weight: number }, b: { id: number; at: number; weight: number }) {
  return a.weight - b.weight || a.at - b.at || a.id - b.id;
}

/**
 * One write of the recent store: expiry, the analyzer's removes, then its new
 * lines. Pure: `stored` is never mutated. The steps, in order:
 *   1. lines whose moment is older than `now - hours` are dropped (`expired`);
 *   2. the stored lines whose ids `removeIds` lists are dropped (`removed`; an id
 *      not stored, or given to a line by this same call, removes nothing);
 *   3. each incoming item `{ text, at, placeId, weight }` is sanitized:
 *      `text` without its links (src/memory/clamp.ts#stripUrls), kept on one line and cut to `chars` at a clean boundary
 *      (src/memory/clamp.ts#clampText with `clampTolerance`), `weight` an integer
 *      clamped to 1..3 (else 2), `at` a finite number (else `now`). An item that
 *      is not an object or whose text comes out empty is dropped (`invalid`),
 *      then one that names no channel (`noChannel`), then one whose moment is
 *      already past the window (`stale`). Anything else the item carries (`who`,
 *      `id`, `addedAt`) is ignored;
 *   4. an item whose folded text (`foldText`) equals a remaining stored line's
 *      or an earlier kept item's is dropped (`duplicate`);
 *   5. the first `maxNew` items are kept, the rest dropped (`overCap`);
 *   6. when items are kept and the store would hold more than `maxStored`, the
 *      lightest, then the oldest moment, then the lowest id go, a kept item
 *      ranking after every stored line of the same weight and moment: a stored
 *      line that goes counts in `evicted`, a kept item that goes at once is not
 *      added and counts in `overCap`. The rest keep their order. A cap lowered
 *      while nothing is kept cuts nothing;
 *   7. each item still kept gets the next id, `addedAt` (the ISO time of `now`)
 *      and `who` (src/memory/mentions.ts#tokenIds of its text), appended in
 *      order (`added`). An id is never used up by an item that is not added.
 * Missing options fall back to `RECENT_DEFAULTS` (config.json's values); a
 * non-finite `now` reads the wall clock.
 * @param stored     The store's value (normalised first, see `normalizeRecent`).
 * @param incoming   New items; anything but an array adds nothing.
 * @returns `added`, `removed`, `expired` and
 *   `evicted` count stored lines (the store holds `before - expired - removed - evicted + added`);
 *   `dropped` counts the incoming items not added, the sum of `invalid`, `noChannel`, `stale`,
 *   `duplicate` and `overCap`. `droppedLines`: the stored lines that left, as normalised (their
 *   `itemId` included) -- the expired, then the removed, then the evicted, each in stored order.
 */
export function mergeRecent(
  stored: unknown,
  incoming: unknown,
  opts: {
    now?: number;
    hours?: number;
    maxStored?: number;
    maxNew?: number;
    chars?: number;
    clampTolerance?: number;
    removeIds?: Array<unknown>;
  } = {}
): {
  value: { nextId: number; lines: Array<RecentLine> };
  added: number;
  removed: number;
  expired: number;
  evicted: number;
  dropped: number;
  invalid: number;
  noChannel: number;
  stale: number;
  duplicate: number;
  overCap: number;
  droppedLines: Array<RecentLine>;
} {
  const options = isRecord(opts) ? opts : {};
  const now = nowOf(options.now);
  const cutoff = windowStart(now, options.hours);
  const maxStored = countOr(options.maxStored, RECENT_DEFAULTS.maxStored);
  const maxNew = countOr(options.maxNew, RECENT_DEFAULTS.maxNew);
  const chars = options.chars ?? RECENT_DEFAULTS.chars;

  const base = normalizeRecent(stored);
  const live = base.lines.filter((line) => line.at >= cutoff);
  const expired = base.lines.length - live.length;
  const expiredLines = base.lines.filter((line) => line.at < cutoff);

  const removing = new Set(
    (Array.isArray(options.removeIds) ? options.removeIds : []).map(lineIdOf).filter((id) => id !== null)
  );
  const kept = live.filter((line) => !removing.has(line.id));
  const removed = live.length - kept.length;
  const removedLines = live.filter((line) => removing.has(line.id));

  const items = Array.isArray(incoming) ? incoming : [];
  const held = new Set(kept.map((line) => foldText(line.text)));
  const fresh: Array<{ at: number; placeId: string; text: string; weight: number }> = [];
  const why = { invalid: 0, noChannel: 0, stale: 0, duplicate: 0, overCap: 0 };
  for (const raw of items) {
    const text =
      isRecord(raw) && typeof raw.text === 'string'
        ? clampText(oneLine(stripUrls(raw.text)), chars, { tolerance: options.clampTolerance })
        : '';
    const placeId = isRecord(raw) ? channelIdOf(raw.placeId) : null;
    const at = isRecord(raw) && isFiniteNumber(raw.at) ? raw.at : now;
    const key = foldText(text);
    const reason = !text
      ? 'invalid'
      : placeId === null
        ? 'noChannel'
        : at < cutoff
          ? 'stale'
          : held.has(key)
            ? 'duplicate'
            : fresh.length >= maxNew
              ? 'overCap'
              : null;
    // `reason` is "noChannel" for a missing channel, so `placeId` is a string when the line is kept.
    if (reason) {
      why[reason] += 1;
      continue;
    }
    held.add(key);
    fresh.push({ at, placeId: placeId as string, text, weight: weightOf(raw.weight) });
  }

  // The storage cap ranks a kept item by a provisional id from `base.nextId` on, above every stored
  // id (normalizeRecent); only the items it leaves get their real ids, so one it takes at once uses
  // none up.
  let survivors: Array<{
    id: number;
    at: number;
    placeId: string;
    text: string;
    weight: number;
    addedAt?: string | null;
    who?: Array<string>;
    itemId?: string;
  }> = [...kept, ...fresh.map((item, i) => ({ ...item, id: base.nextId + i }))];
  let evicted = 0;
  let evictedLines: Array<RecentLine> = [];
  if (fresh.length > 0 && survivors.length > maxStored) {
    const going = new Set(
      [...survivors]
        .sort(evictionOrder)
        .slice(0, survivors.length - maxStored)
        .map((line) => line.id)
    );
    evictedLines = kept.filter((line) => going.has(line.id));
    evicted = evictedLines.length;
    why.overCap += going.size - evicted;
    survivors = survivors.filter((line) => !going.has(line.id));
  }

  let nextId = base.nextId;
  let added = 0;
  const addedAt = new Date(now).toISOString();
  const lines = survivors.map((line) => {
    // A line below `base.nextId` is a stored one, a whole `RecentLine`.
    if (line.id < base.nextId) return line as RecentLine;
    const id = nextId;
    nextId += 1;
    added += 1;
    return {
      id,
      at: line.at,
      addedAt,
      placeId: line.placeId,
      text: line.text,
      who: tokenIds(line.text),
      weight: line.weight,
    };
  });

  const dropped = why.invalid + why.noChannel + why.stale + why.duplicate + why.overCap;
  const droppedLines = [...expiredLines, ...removedLines, ...evictedLines];
  return { value: { nextId, lines }, added, removed, expired, evicted, dropped, ...why, droppedLines };
}

/**
 * The lines still inside the window: a moment at or after `now - hours`, in
 * stored order. Reading only -- nothing is removed (expiry is `mergeRecent`'s,
 * at a write). `hours` falls back to `RECENT_DEFAULTS.hours`; a non-finite `now`
 * reads the wall clock.
 */
export function liveRecent(lines: unknown, { now, hours }: { now?: number; hours?: number } = {}): Array<RecentLine> {
  if (!Array.isArray(lines)) return [];
  const cutoff = windowStart(nowOf(now), hours);
  return lines.filter((line) => isRecord(line) && isFiniteNumber(line.at) && line.at >= cutoff);
}

/**
 * The store without the lines about one member, for a forget: a line goes when
 * its `who` holds `accountId`, its text holds the token `<@accountId>` (the one case
 * `who` misses: an id outside the snowflake range forms no token), or its
 * folded text holds one of `names` (the member's stored names and aliases,
 * folded, each with at least 3 letters or digits: a name of symbols alone
 * would match symbol runs in anyone's line) as a whole word
 * (src/memory/mentions.ts#occursAsWholeWord). Pure: `stored` is never mutated;
 * `nextId` is kept.
 */
export function purgeRecentFor(
  stored: unknown,
  accountId: string,
  names: Array<unknown> = []
): { value: { nextId: number; lines: Array<RecentLine> }; removed: number } {
  const base = normalizeRecent(stored);
  const id = String(accountId);
  const token = `<@${id}>`;
  const folded = [
    ...new Set((Array.isArray(names) ? names : []).filter((name) => typeof name === 'string').map(foldText)),
  ].filter((name) => [...name].filter((ch) => isWordChar(ch) && ch !== '_').length >= MIN_PURGE_NAME);
  const lines = base.lines.filter((line) => {
    if (line.who.includes(id) || line.text.includes(token)) return false;
    const text = foldText(line.text);
    return !folded.some((name) => occursAsWholeWord(text, name));
  });
  return { value: { nextId: base.nextId, lines }, removed: base.lines.length - lines.length };
}

/**
 * An id (a member's, a profile's, a channel's, a message's) as a string: a
 * finite number as its decimal form, a non-empty string as it is, anything
 * else null. The one copy for the recent view, the request builder
 * (src/behavior/prompt.js) and src/behavior/elsewhere.ts.
 */
export function accountIdOf(raw: unknown): string | null {
  if (typeof raw === 'number' && isFiniteNumber(raw)) return String(raw);
  return typeof raw === 'string' && raw !== '' ? raw : null;
}
