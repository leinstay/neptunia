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

import { estimateTokens } from './tokens.js';

// What a broken or missing setting counts as: config.json's `llm.safetyMargin`
// and `llm.maxRequestTokens`.
const DEFAULT_SAFETY_MARGIN = 0.9;
const DEFAULT_MAX_REQUEST_TOKENS = 50000;

/**
 * @typedef {object} Section
 * @property {string} name
 * @property {string[]} items        Independent pieces; one is kept or dropped whole.
 * @property {'first'|'newest'|'oldest'} [keep]  Which items survive trimming. 'first' (the
 *   default) walks from the start, skips an item that does not fit and tries the next (ranked
 *   lists, gaps allowed). 'newest' keeps a contiguous run from the end (chat logs): it stops at
 *   the first item, walking backwards, that does not fit. 'oldest' keeps a contiguous run from
 *   the start: it stops at the first item that does not fit, so nothing behind a dropped item is
 *   ever kept.
 * @property {number} [cap]          Max tokens this section may take.
 * @property {boolean} [required]    Required sections are never trimmed; if they
 *   alone exceed the limit, fitSections throws.
 */

/**
 * Thrown by `fitSections` when the sections marked `required` alone already
 * exceed `limit` — i.e. the request cannot be built at all, not even by
 * trimming. A dedicated class (rather than matching the message text) lets a
 * caller — src/memory/update.js#analyze — reliably tell this apart from a
 * generic build/provider error and classify it as the same 'token-limit'
 * reason as a `TokenLimitError` from src/llm/openrouter.js.
 */
export class SectionsTooLargeError extends Error {}

/**
 * `llm.safetyMargin` of `config`: a number in (0, 1], else 0.9 (config.json's value).
 * @param {object} config  The live config; `config.llm` may be missing.
 * @returns {number}
 */
export function safetyMarginOf(config) {
  const given = config?.llm?.safetyMargin;
  return Number.isFinite(given) && given > 0 && given <= 1 ? given : DEFAULT_SAFETY_MARGIN;
}

/**
 * The input budget of one request: `floor(maxRequestTokens * llm.safetyMargin)`. A margin that
 * is not a number in (0, 1] counts as 0.9 and a token cap that is not a positive finite number
 * as 50000 (config.json's values), so a partial or broken config still gives a limit
 * `fitSections` accepts.
 * @param {object} config  The live config; `config.llm` may be missing.
 * @param {number} [maxRequestTokens]  The token cap to use instead of `config.llm.maxRequestTokens`
 *   (a caller with a cap of its own).
 * @returns {number}  A finite integer >= 0.
 */
export function requestTokenLimit(config, maxRequestTokens = config?.llm?.maxRequestTokens) {
  const margin = safetyMarginOf(config);
  const cap = Number.isFinite(maxRequestTokens) && maxRequestTokens > 0 ? maxRequestTokens : DEFAULT_MAX_REQUEST_TOKENS;
  return Math.floor(cap * margin);
}

/**
 * The `cost` function request builders pass to `fitSections`: the calibrated token estimate of
 * an item plus a flat 2 per item. The calibrator is read at each call, so the price follows its
 * ratio.
 * @param {{ apply: (rawEstimate: number) => number }} calibrator  See src/llm/tokens.js#createCalibrator.
 * @returns {(text: string) => number}
 */
export function sectionCost(calibrator) {
  return (text) => calibrator.apply(estimateTokens(text)) + 2;
}

/**
 * Fit `sections` into `limit` tokens. `cost(text)` returns the token price of
 * one item. Returns `{ kept, stats, used }` where `kept[name]` is the surviving
 * items in their original order. With `options.limits` (src/llm/limits.js#createLimits),
 * every section that lost items is reported there as a `budget-drop` (`budgetDrops`).
 * @param {Section[]} sections  In priority order.
 * @param {number} limit  A finite number >= 0.
 * @param {(text: string) => number} cost
 * @param {{ limits?: { add: Function } }} [options]
 * @returns {{ kept: Record<string, string[]>, stats: Record<string, { used: number, kept: number, dropped: number }>, used: number }}
 * @throws {TypeError} `limit` is not a finite number >= 0. A NaN limit would otherwise trim
 *   nothing and never report required sections as too large: every comparison with NaN is false.
 * @throws {SectionsTooLargeError} The required sections alone exceed `limit`.
 */
export function fitSections(sections, limit, cost, { limits = null } = {}) {
  // Number.isFinite is false for anything that is not a number, a numeric string included.
  if (!Number.isFinite(limit) || limit < 0) {
    throw new TypeError(`the token limit must be a finite number >= 0, got ${String(limit)}`);
  }
  const kept = {};
  const stats = {};
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
    const taken = [];
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
 * (src/llm/limits.js#createLimits). The one place a dropped section becomes a limit entry.
 * @param {Record<string, { dropped?: number }>|null|undefined} stats
 * @param {{ add: Function }} limits
 */
export function budgetDrops(stats, limits) {
  for (const [name, entry] of Object.entries(stats ?? {})) {
    const dropped = entry && typeof entry === 'object' ? entry.dropped : null;
    if (Number.isFinite(dropped) && dropped > 0) limits.add({ kind: 'budget-drop', where: name, lost: dropped });
  }
}
