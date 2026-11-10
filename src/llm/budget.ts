// Decides what goes into an LLM request and what is cut so the request stays
// under the token cap. Sections are handed over in PRIORITY order (most
// important first); each takes what it needs from the remaining budget, up to
// its own optional cap, and whatever does not fit is dropped item by item.
// Rendering order is the caller's business — priority and position in the
// prompt are independent.
//
// The two things every request builder hands to `fitSections` live here too, so
// there is one copy of each: `requestTokenLimit` (the limit) and `sectionCost`
// (the price of one item).

import { objOf } from '../tools/types.ts';
import type { LimitsSink } from './limits.ts';
import { estimateTokens } from './tokens.ts';

/** The share of the token cap a request may fill. Production value, config cut of 2026-10-31. */
export const SAFETY_MARGIN = 0.9;
// What a broken or missing `llm.maxRequestTokens` counts as: config.json's value.
const DEFAULT_MAX_REQUEST_TOKENS = 100000;

export type Section = {
  name: string;
  /** Independent pieces; one is kept or dropped whole. */
  items: Array<string>;
  /** Which items survive trimming. 'first' (the default) walks from the start, skips an item that does not fit and tries the next (ranked lists, gaps allowed). 'newest' keeps a contiguous run from the end (chat logs): it stops at the first item, walking backwards, that does not fit. 'oldest' keeps a contiguous run from the start: it stops at the first item that does not fit, so nothing behind a dropped item is ever kept. */
  keep?: 'first' | 'newest' | 'oldest';
  /** Max tokens this section may take. */
  cap?: number;
  /** Required sections are never trimmed; if they alone exceed the limit, fitSections throws. */
  required?: boolean;
  /**
   * Item counts the section may be cut to, in any order. A section that cannot keep all its items keeps the largest step
   * not above what fits, so two turns with nothing new between them keep the same items; below the smallest step it keeps
   * what fits.
   */
  steps?: ReadonlyArray<number>;
};

/**
 * Thrown by `fitSections` when the sections marked `required` alone already
 * exceed `limit` — i.e. the request cannot be built at all, not even by
 * trimming. A dedicated class (rather than matching the message text) lets a
 * caller reliably tell this apart from a
 * generic build/provider error and classify it as the same 'token-limit'
 * reason as a `TokenLimitError` from src/llm/openrouter.ts.
 */
export class SectionsTooLargeError extends Error {}

/**
 * The input budget of one request: `floor(maxRequestTokens * SAFETY_MARGIN)`. A token cap that is not a positive
 * finite number counts as 100000 (config.json's value), so a partial or broken config still gives a limit
 * `fitSections` accepts.
 * @param config The live config; `config.llm` may be missing.
 * @param maxRequestTokens The token cap to use instead of `config.llm.maxRequestTokens`
 *   (a caller with a cap of its own).
 * @returns A finite integer >= 0.
 */
export function requestTokenLimit(
  config: unknown,
  maxRequestTokens: unknown = objOf(objOf(config).llm).maxRequestTokens
): number {
  const cap =
    typeof maxRequestTokens === 'number' && Number.isFinite(maxRequestTokens) && maxRequestTokens > 0
      ? maxRequestTokens
      : DEFAULT_MAX_REQUEST_TOKENS;
  return Math.floor(cap * SAFETY_MARGIN);
}

/**
 * The `cost` function request builders pass to `fitSections`: the calibrated token estimate of
 * an item plus a flat 2 per item. The calibrator is read at each call, so the price follows its
 * ratio.
 * @param calibrator See src/llm/tokens.ts#createCalibrator.
 */
export function sectionCost(calibrator: { apply: (rawEstimate: number) => number }): (text: string) => number {
  return (text) => calibrator.apply(estimateTokens(text)) + 2;
}

/** The largest of `steps` (whole counts above 0) not above `count`; null when there is none. */
function stepBelow(steps: ReadonlyArray<number> | undefined, count: number): number | null {
  const fitting = (steps ?? []).filter((step) => Number.isInteger(step) && step > 0 && step <= count);
  return fitting.length > 0 ? Math.max(...fitting) : null;
}

/**
 * Fit `sections` into `limit` tokens. `cost(text)` returns the token price of
 * one item. Returns `{ kept, stats, used }` where `kept[name]` is the surviving
 * items in their original order. A section with `steps` that cannot keep all its items is cut to the
 * largest step not above what fits. With `options.limits` (src/llm/limits.ts#createLimits),
 * every section that lost items is reported there as a `budget-drop` (`budgetDrops`).
 * @param sections In priority order.
 * @param limit A finite number >= 0.
 * @throws `limit` is not a finite number >= 0. A NaN limit would otherwise trim
 *   nothing and never report required sections as too large: every comparison with NaN is false.
 * @throws The required sections alone exceed `limit`.
 */
export function fitSections(
  sections: Array<Section>,
  limit: number,
  cost: (text: string) => number,
  { limits = null }: { limits?: LimitsSink | null } = {}
): {
  kept: Record<string, Array<string>>;
  stats: Record<string, { used: number; kept: number; dropped: number }>;
  used: number;
} {
  // Number.isFinite is false for anything that is not a number, a numeric string included.
  if (!Number.isFinite(limit) || limit < 0) {
    throw new TypeError(`the token limit must be a finite number >= 0, got ${String(limit)}`);
  }
  const kept: Record<string, Array<string>> = {};
  const stats: Record<string, { used: number; kept: number; dropped: number }> = {};
  let remaining = limit;

  for (const section of sections) {
    if (!section.required) continue;
    const used = section.items.reduce((sum, item) => sum + cost(item), 0);
    remaining -= used;
    kept[section.name] = [...section.items];
    stats[section.name] = { used, kept: section.items.length, dropped: 0 };
  }
  if (remaining < 0) {
    throw new SectionsTooLargeError(`required prompt sections exceed the token limit by ${-remaining}`);
  }

  for (const section of sections) {
    if (section.required) continue;
    const budget = Math.min(section.cap ?? Infinity, remaining);
    const order = section.keep === 'newest' ? [...section.items].reverse() : section.items;
    // 'newest' and 'oldest' must stay contiguous: once one item does not fit, stop.
    const contiguous = section.keep === 'newest' || section.keep === 'oldest';
    const taken: Array<string> = [];
    let used = 0;
    for (const item of order) {
      const price = cost(item);
      if (used + price > budget) {
        if (contiguous) break;
        continue;
      }
      taken.push(item);
      used += price;
    }
    if (section.keep === 'newest') taken.reverse();
    const step = taken.length < section.items.length ? stepBelow(section.steps, taken.length) : null;
    if (step !== null && step < taken.length) {
      const cut = section.keep === 'newest' ? taken.slice(taken.length - step) : taken.slice(0, step);
      taken.splice(0, taken.length, ...cut);
      used = taken.reduce((sum, item) => sum + cost(item), 0);
    }
    remaining -= used;
    kept[section.name] = taken;
    stats[section.name] = { used, kept: taken.length, dropped: section.items.length - taken.length };
  }

  if (limits) budgetDrops(stats, limits);
  return { kept, stats, used: limit - remaining };
}

/**
 * One `budget-drop` limit per section of a `fitSections` stats line that lost items (`where`:
 * the section, `lost`: the items dropped), in the stats' order, added to `limits`
 * (src/llm/limits.ts#createLimits). The one place a dropped section becomes a limit entry.
 */
export function budgetDrops(stats: Record<string, { dropped?: number }> | null | undefined, limits: LimitsSink): void {
  for (const [name, entry] of Object.entries(stats ?? {})) {
    const dropped = entry && typeof entry === 'object' ? entry.dropped : null;
    if (typeof dropped === 'number' && Number.isFinite(dropped) && dropped > 0)
      limits.add({ kind: 'budget-drop', where: name, lost: dropped });
  }
}
