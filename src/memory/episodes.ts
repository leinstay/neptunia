// A member's remembered episodes, the moments the persona recalls about the two
// of them: the display order (`sortEpisodesForDisplay`, also behind the owner's
// view in src/admin.js) and the top-N choice for a member asked about
// (`topEpisodes`), both used by src/behavior/prompt.js.
//
// It is also the one home of the episode rules: the text limits
// (`EPISODE_CHARS`), the date rule (`episodeDate`, to store a date or, with
// no clock, to test one) and the duplicate rule (`isSameEpisode`). This
// module stays a leaf toward src/behavior/prompt.js: importing it would close
// an import cycle (prompt.js imports this module).

import { normalizeTopic } from './interests.ts';
import { utcDay } from '../time.ts';
import { isIntegerNumber } from './types.ts';
import type { StoredRecord } from './types.ts';

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
 * @param [nowMs]  Epoch ms; omit to test `raw` alone.
 */
export function episodeDate(raw: unknown, nowMs?: number): string {
  if (typeof raw === 'string' && DATE_RE.test(raw)) return raw;
  return nowMs === undefined ? '' : utcDay(nowMs);
}

/**
 * Whether two episodes are the same moment: the same `date` and the same
 * `what` by src/memory/interests.ts#normalizeTopic (trimmed, whitespace
 * collapsed, lower-cased), or the same non-empty `quote`, compared verbatim.
 * Symmetric. Anything that is not an object is no episode and matches nothing.
 */
export function isSameEpisode(a: StoredRecord, b: StoredRecord): boolean {
  if (!a || !b || typeof a !== 'object' || typeof b !== 'object') return false;
  if (a.date === b.date && normalizeTopic(a.what) === normalizeTopic(b.what)) return true;
  return Boolean(a.quote && b.quote && a.quote === b.quote);
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
