// The `skills` section of the settings: `reviewDays`, the days a skill may go unread before `/skills` marks it for
// review. A missing value or one that is not a positive whole number takes the default. Read at each call, never
// cached.

import { objOf } from '../tools/types.ts';

// Decision of 2026-10-31 (PR 7e): a month without a read is long enough to ask whether the skill still earns its line.
export const SKILLS_DEFAULTS = Object.freeze({ reviewDays: 30 });

export function skillsSettings(config: unknown): { reviewDays: number } {
  const days = objOf(objOf(config).skills).reviewDays;
  return {
    reviewDays: typeof days === 'number' && Number.isInteger(days) && days > 0 ? days : SKILLS_DEFAULTS.reviewDays,
  };
}
