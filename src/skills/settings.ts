// The `skills` section of the settings: `reviewDays`, the days a skill may go unread before `/skills` marks it for
// review. A missing value or one that is not a positive whole number takes the default. Read at each call, never
// cached.

import { objOf } from '../tools/types.ts';

// Decision of 2026-10-31 (PR 7e): a month without a read is long enough to ask whether the skill still earns its line.
export const SKILLS_DEFAULTS = Object.freeze({ reviewDays: 30 });
// Decision of 2026-11-03 for the skill executor: a minute covers an API call and a file; a megabyte is far over any answer
// a turn can use.
export const SKILL_RUN_DEFAULTS = Object.freeze({ timeoutMs: 60_000, maxOutputBytes: 1_000_000 });

/** The limits of one `skill.run`, read at the moment of use. */
export function skillRunSettings(config: unknown): { timeoutMs: number; maxOutputBytes: number } {
  const run = objOf(objOf(objOf(config).skills).run);
  const positive = (value: unknown, fallback: number): number =>
    typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : fallback;
  return {
    timeoutMs: positive(run.timeoutMs, SKILL_RUN_DEFAULTS.timeoutMs),
    maxOutputBytes: positive(run.maxOutputBytes, SKILL_RUN_DEFAULTS.maxOutputBytes),
  };
}

export function skillsSettings(config: unknown): { reviewDays: number } {
  const days = objOf(objOf(config).skills).reviewDays;
  return {
    reviewDays: typeof days === 'number' && Number.isInteger(days) && days > 0 ? days : SKILLS_DEFAULTS.reviewDays,
  };
}
