// The `skills.run` section of the settings: the limits of one `skill.run`. A missing value or one that is not a positive
// whole number takes the default. Read at each call, never cached.

import { objOf } from '../tools/types.ts';

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
