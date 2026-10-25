// Pure merge logic for a member's remembered episodes -- moments the persona
// recalls about the two of them, appended by the analyzer (never rewritten)
// and evicted by weight then age once the per-person cap is exceeded, the
// newest few (`memory.keepNewestEpisodes`) spared so a light moment of a busy
// member is not thrown out the moment it arrives. See
// docs/prompt-contract.md ("episodes" in "The analyzer") and
// src/memory/update.js#applyMemoryUpdate, which routes the model's
// `users.<id>.episodes` through this module via src/memory/store.js#addEpisodes.
// Plus the display order (`sortEpisodesForDisplay`, also behind the owner's
// view in src/admin.js) and the top-N choice for a member asked about
// (`topEpisodes`), both used by src/behavior/prompt.js.
//
// It is also the one home of the episode rules the two-stage analyzer
// (src/memory/voice.js#splitDecision) must apply exactly as the store does, so
// a feeling item's address equals the stored episode: the text limits
// (`EPISODE_CHARS`), the date rule (`episodeDate`, to store a date or, with
// no clock, to test one) and the duplicate rule
// (`isSameEpisode`). This module therefore stays a leaf toward voice.js and
// src/behavior/prompt.js: importing either would close an import cycle
// (prompt.js imports this module, voice.js imports prompt.js).

import { clampText, stripUrls } from './clamp.js';
import { normalizeTopic } from './interests.js';
import { utcDay } from '../time.js';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

/**
 * The character limits of an episode's texts: `what` and `feeling` before
 * `memory.clampTolerance`, `quote` always a hard cut (the person's own words).
 */
export const EPISODE_CHARS = Object.freeze({ what: 200, quote: 120, feeling: 120 });

/**
 * The one rule of an episode's date: a stored date is a `YYYY-MM-DD` string and nothing else.
 * It has two forms, told apart by whether a clock is passed:
 *
 * - With a clock (`nowMs` given): the date an episode is stored with. `raw` when it is a stored
 *   date, else the UTC day of `nowMs` (a missing or malformed date from the model is dated by the
 *   clock). A clock that is given but is no time (NaN, a string) throws a RangeError
 *   (src/time.js#utcDay) once the fallback is needed.
 * - Without one (`nowMs` undefined): a test of a stored date. `raw` when it is a stored date, else
 *   `''`, which no stored date is, so `episodeDate(raw) !== ''` tells a dated episode from an
 *   undated one. An undefined clock is not an error: a caller that means to date an episode must
 *   pass its clock, since a forgotten one is read as this form and yields `''`.
 *
 * A usable date never reads the clock, in either form.
 * @param {unknown} raw
 * @param {number} [nowMs]  Epoch ms; omit to test `raw` alone.
 * @returns {string}
 */
export function episodeDate(raw, nowMs) {
  if (typeof raw === 'string' && DATE_RE.test(raw)) return raw;
  return nowMs === undefined ? '' : utcDay(nowMs);
}

/**
 * Whether two episodes are the same moment: the same `date` and the same
 * `what` by src/memory/interests.js#normalizeTopic (trimmed, whitespace
 * collapsed, lower-cased), or the same non-empty `quote`, compared verbatim.
 * Symmetric. Anything that is not an object is no episode and matches nothing.
 * @param {object} a
 * @param {object} b
 * @returns {boolean}
 */
export function isSameEpisode(a, b) {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (a.date === b.date && normalizeTopic(a.what) === normalizeTopic(b.what)) return true;
  return Boolean(a.quote && b.quote && a.quote === b.quote);
}

function clampWeight(raw) {
  const n = Number.isInteger(raw) ? raw : 3;
  return Math.min(5, Math.max(1, n));
}

/**
 * Validate and clamp one raw episode from the model. Returns null when it has
 * no usable `what` (the one required field). `what`/`feeling` are free prose,
 * clamped tolerantly via src/memory/clamp.js; `quote` is the person's own
 * words verbatim, so it gets a hard cut (`tolerance: 1`) at a clean boundary
 * instead -- see docs/prompt-contract.md, "Limits are soft for the
 * model, clean in code". Limits: `EPISODE_CHARS`; date: `episodeDate`. All
 * three lose their links first (src/memory/clamp.js#stripUrls).
 */
function sanitizeEpisode(raw, nowMs, clampTolerance) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const what = typeof raw.what === 'string' ? clampText(stripUrls(raw.what), EPISODE_CHARS.what, { tolerance: clampTolerance }) : '';
  if (!what) return null;
  const quote = typeof raw.quote === 'string' ? clampText(stripUrls(raw.quote), EPISODE_CHARS.quote, { tolerance: 1 }) : '';
  const feeling = typeof raw.feeling === 'string' ? clampText(stripUrls(raw.feeling), EPISODE_CHARS.feeling, { tolerance: clampTolerance }) : '';
  const weight = clampWeight(raw.weight);
  const date = episodeDate(raw.date, nowMs);
  return { date, what, quote, feeling, weight };
}

/** Whether `candidate` is the same moment (`isSameEpisode`) as one of `stored`. */
function isDuplicate(candidate, stored) {
  return stored.some((s) => isSameEpisode(s, candidate));
}

/** Ascending sort key for eviction: lowest weight first, then oldest first among equals. */
function evictionOrder(a, b) {
  return (
    a.ep.weight - b.ep.weight ||
    (a.ep.date < b.ep.date ? -1 : a.ep.date > b.ep.date ? 1 : 0) ||
    String(a.ep.addedAt ?? '').localeCompare(String(b.ep.addedAt ?? '')) ||
    a.index - b.index
  );
}

/**
 * How many of the newest entries eviction spares: `keepNewest` rounded down and clamped to
 * `[0, cap - 1]`, so one entry is always left to evict. Anything that is not a number counts as 0.
 */
function keptNewestCount(keepNewest, cap) {
  const count = typeof keepNewest === 'number' && !Number.isNaN(keepNewest) ? Math.floor(keepNewest) : 0;
  return Math.max(0, Math.min(count, cap - 1));
}

/**
 * Indices of the `count` most recently added entries of `list`, whose entries from `storedLength`
 * on are the ones this merge accepted: those first whatever their stamp (a caller's clock may be
 * behind the stored stamps), then the latest `addedAt` (an entry with none counts as the oldest),
 * a later position first among equals (one merge stamps all its entries alike, in the model's
 * order).
 */
function newestIndices(list, count, storedLength) {
  if (count <= 0) return new Set();
  const byRecency = list
    .map((ep, index) => ({ addedAt: String(ep?.addedAt ?? ''), index, arrived: Number(index >= storedLength) }))
    .sort((a, b) => b.arrived - a.arrived || b.addedAt.localeCompare(a.addedAt) || b.index - a.index);
  return new Set(byRecency.slice(0, count).map((o) => o.index));
}

/**
 * Merge freshly-extracted episodes into a member's stored list. Pure:
 * `existing` is never mutated, surviving entries keep their original fields
 * and relative order (eviction only ever removes entries, never reorders or
 * rewrites the ones that remain). Tolerates a profile written before this
 * feature existed (`existing` undefined/not an array).
 *
 * Over `maxEpisodes`, the `K` most recently added entries are exempt from
 * eviction, `K` = `keepNewest` clamped to `maxEpisodes - 1`: this call's own
 * entries first, then by `addedAt`, then position; the rest go lowest weight
 * first, then oldest. `keepNewest` 0 (the default) = eviction by weight then age
 * alone. With `K` above 0 a moment is never evicted on arrival (unless one call
 * brings more than `K`: then only its last `K` are spared), whatever the
 * caller's `now`. It then stays safe while fewer than `K` entries rank newer
 * (a later call's own, or a later `addedAt`); from then on it ranks by weight
 * then age with the rest. Its `addedAt` is the caller's `now`: a caller that
 * passes the time of the last message it read instead of the clock stores
 * moments that can rank below moments stored after that message and live
 * shorter than the survival below once they have arrived. Expected survival: a light
 * moment of a member at the cap whose stored moments are all heavier lives for
 * exactly `K` later moments and goes in the merge that stores the `K`-th -- at
 * `memory.keepNewestEpisodes` 5 and `memory.maxNewEpisodes` 3, at least two
 * more batches that add moments for that member. The light end of the list
 * turns over at the same rate as before; what changes is that every moment is
 * stored and can be seen before it goes.
 *
 * @param {object[]|undefined} existing  Stored episodes, oldest-appended order.
 * @param {unknown} incoming             Untrusted, model-extracted episodes.
 * @param {{ maxEpisodes: number, maxNew: number, now?: number, clampTolerance?: number, keepNewest?: number }} opts
 *   `keepNewest`: `memory.keepNewestEpisodes` (see src/memory/update.js#episodeOptions);
 *   omitted, negative or not a number = 0.
 * @returns {{ episodes: object[], added: number, dropped: object[] }}  `added` counts every
 *   accepted entry, one evicted again by the same merge included. `dropped`: every entry the
 *   eviction removed, in list order -- a stored one as stored (its `itemId` included), an
 *   accepted one as it was about to be stored; `[]` when none went.
 */
export function mergeEpisodes(
  existing,
  incoming,
  { maxEpisodes, maxNew = Infinity, now: nowMs = Date.now(), clampTolerance, keepNewest = 0 } = {},
) {
  const stored = Array.isArray(existing) ? existing : [];
  if (!Array.isArray(incoming) || incoming.length === 0) return { episodes: stored, added: 0, dropped: [] };

  const sanitized = incoming
    .map((raw) => sanitizeEpisode(raw, nowMs, clampTolerance))
    .filter(Boolean)
    .slice(0, maxNew);

  const accepted = [];
  for (const candidate of sanitized) {
    if (isDuplicate(candidate, stored)) continue;
    accepted.push({ ...candidate, addedAt: new Date(nowMs).toISOString() });
  }
  if (accepted.length === 0) return { episodes: stored, added: 0, dropped: [] };

  let merged = [...stored, ...accepted];
  let dropped = [];
  const cap = Number.isInteger(maxEpisodes) ? maxEpisodes : Infinity;
  if (merged.length > cap) {
    const dropCount = merged.length - cap;
    const exempt = newestIndices(merged, keptNewestCount(keepNewest, cap), stored.length);
    const order = merged
      .map((ep, index) => ({ ep, index }))
      .filter((o) => !exempt.has(o.index))
      .sort(evictionOrder);
    const dropIndices = new Set(order.slice(0, dropCount).map((o) => o.index));
    dropped = merged.filter((_, index) => dropIndices.has(index));
    merged = merged.filter((_, index) => !dropIndices.has(index));
  }

  return { episodes: merged, added: accepted.length, dropped };
}

/**
 * Order episodes for rendering: heaviest weight first, then newest (by
 * `date`, `addedAt` as a tiebreaker) -- see docs/prompt-contract.md,
 * `<people>` and `profile.episode(s)`. Pure, does not mutate `episodes`.
 * @param {object[]} episodes
 */
export function sortEpisodesForDisplay(episodes) {
  return [...(episodes ?? [])].sort(
    (a, b) =>
      b.weight - a.weight ||
      (a.date < b.date ? 1 : a.date > b.date ? -1 : 0) ||
      String(b.addedAt ?? '').localeCompare(String(a.addedAt ?? '')),
  );
}

/**
 * The at most `max` episodes a member is shown by when the persona is asked
 * about them (`context.askedAboutEpisodes`): heaviest weight first, then
 * newest, as `sortEpisodesForDisplay` orders them. An upper bound, not what a
 * request shows: under a tight `<people>` budget src/behavior/prompt.js keeps
 * only a prefix of this list (the lightest dropped first), possibly none, so
 * a block that must not repeat the shown ones has to take them from what was
 * rendered, not from this list. Pure, does not mutate `episodes`.
 * @param {object[]|undefined} episodes
 * @param {number} max  Not a positive integer (0 = off) -> none.
 * @returns {object[]}
 */
export function topEpisodes(episodes, max) {
  if (!Array.isArray(episodes) || !Number.isInteger(max) || max < 1) return [];
  return sortEpisodesForDisplay(episodes).slice(0, max);
}
