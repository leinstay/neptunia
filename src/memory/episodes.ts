// A member's remembered episodes, the moments the persona recalls about the two
// of them: the display order (`sortEpisodesForDisplay`, read by the request
// builder in src/turn/request/profiles.ts and the memory operations in
// src/tools/operations/memory.ts) and the top-N choice for a member asked about
// (`topEpisodes`, read by src/turn/request/profiles.ts).
//
// It is also the home of the episode date rule (`episodeDate`, to store a
// date or, with no clock, to test one), read by src/behavior/recall.ts.

import { utcDay } from '../time.ts';
import { isIntegerNumber } from './types.ts';
import type { StoredRecord } from './types.ts';

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

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
 * @param [nowMs]  Epoch ms; omit to test `raw` alone.
 */
export function episodeDate(raw: unknown, nowMs?: number): string {
  if (typeof raw === 'string' && DATE_RE.test(raw)) return raw;
  return nowMs === undefined ? '' : utcDay(nowMs);
}

/**
 * Order episodes for rendering: heaviest weight first, then newest (by
 * `date`, `addedAt` as a tiebreaker) -- see docs/prompt-contract.md,
 * `<people>` and `profile.episode(s)`. Pure, does not mutate `episodes`.
 */
export function sortEpisodesForDisplay(episodes: Array<StoredRecord>): Array<object> {
  return [...(episodes ?? [])].sort(
    (a, b) =>
      b.weight - a.weight ||
      (a.date < b.date ? 1 : a.date > b.date ? -1 : 0) ||
      String(b.addedAt ?? '').localeCompare(String(a.addedAt ?? ''))
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
 * @param max  Not a positive integer (0 = off) -> none.
 */
export function topEpisodes(episodes: Array<StoredRecord> | undefined, max: number): Array<object> {
  if (!Array.isArray(episodes) || !isIntegerNumber(max) || max < 1) return [];
  return sortEpisodesForDisplay(episodes).slice(0, max);
}
