// The pure rules of a read of another conversation: the `context.pull` settings (`sameAudience`) with the age limit of
// a conversation one may read, and which pictures of a span of lines may get a fresh caption and which only a cached
// one. No I/O, no platform SDK: callers pass plain normalized messages and the clock.

import { collectEmojiItems, collectPictures, isDescribable } from '../media/classify.ts';
import { DAY_MS } from '../time.ts';
import type { Untyped } from '../tools/types.ts';

/**
 * The measures of a read: production values of the config cut of 2026-10-31, and the fallback of the key
 * `context.pull.sameAudience`. `maxAgeDays` 0 means no age limit.
 */
export const PULL_DEFAULTS = Object.freeze({
  maxPictures: 10,
  maxAgeDays: 0,
  sameAudience: true,
});

/** An integer from a finite `value` of at least `min` (floored), else `fallback`. */
function intAtLeast<TFallback>(value: unknown, fallback: TFallback, min: number): number | TFallback {
  return typeof value === 'number' && Number.isFinite(value) && value >= min ? Math.floor(value) : fallback;
}

/** A finite `value` of at least `min`, else `fallback`. */
function numberAtLeast<TFallback>(value: unknown, fallback: TFallback, min: number): number | TFallback {
  return typeof value === 'number' && Number.isFinite(value) && value >= min ? value : fallback;
}

/**
 * The pull settings: PULL_DEFAULTS, with `context.pull.sameAudience` (only `false` turns it off) read from the live
 * config.
 * @param config  The live config.
 */
export function pullSettings(config: { context?: { pull?: Record<string, unknown> } } | null | undefined): {
  maxPictures: number;
  maxAgeDays: number;
  sameAudience: boolean;
} {
  const p = config?.context?.pull ?? {};
  return { ...PULL_DEFAULTS, sameAudience: p.sameAudience !== false };
}

/**
 * Whether a channel whose anchor (its newest message, or an explicit anchor)
 * was written at `anchorTs` is too old to pull at `now`: only with a positive
 * `maxAgeDays`, and only when strictly older than that many days. 0 (the
 * default) never refuses; an unknown `anchorTs` or `now` is not judged here.
 */
export function isTooOld(
  anchorTs: number | null,
  { maxAgeDays, now }: { maxAgeDays?: number; now?: number } = {}
): boolean {
  const days = numberAtLeast(maxAgeDays, PULL_DEFAULTS.maxAgeDays, 0);
  if (days <= 0 || anchorTs === null || !Number.isFinite(anchorTs) || now === undefined || !Number.isFinite(now))
    return false;
  return now - anchorTs > days * DAY_MS;
}

/**
 * The describable items of a pulled window, for its captions. Pictures: the
 * picture items of each message (collectPictures) the describer can caption
 * (isDescribable), newest message first and each message in its own order,
 * each picture (`itemId`) once at its newest message; the first
 * `maxPictures` are `items` (the only ones a fresh caption may be requested
 * for), the others, in the same order, are `rest` (a cached caption only),
 * and `overflow` is `rest.length`. Every picture of the window is in `items`
 * or `rest`, so the cache can be asked for all of them. `emoji`: the
 * window's custom emoji (collectEmojiItems), in the same order and once
 * each -- not pictures, never counted toward `maxPictures` or `overflow`,
 * returned for the cached captions the transcript renders. Unusable
 * `maxPictures` falls back to PULL_DEFAULTS.
 * @param messages  Normalized messages, oldest first.
 */
export function pullPictures(
  messages: Array<Record<string, Untyped>>,
  maxPictures: number
): {
  items: Array<Record<string, Untyped>>;
  rest: Array<Record<string, Untyped>>;
  overflow: number;
  emoji: Array<Record<string, Untyped>>;
} {
  const limit = intAtLeast(maxPictures, PULL_DEFAULTS.maxPictures, 0);
  const list = Array.isArray(messages) ? messages : [];
  const items: Array<Untyped> = [];
  const rest: Array<Untyped> = [];
  const emoji = [];
  const seen = new Set();
  /** A describable item met for the first time (the newest message's copy wins). */
  const firstDescribable = (item: Record<string, unknown>) => {
    if (!isDescribable(item) || seen.has(item.itemId)) return false;
    seen.add(item.itemId);
    return true;
  };
  for (let i = list.length - 1; i >= 0; i -= 1) {
    if (!list[i]) continue;
    for (const item of collectPictures(list[i])) {
      if (firstDescribable(item)) (items.length < limit ? items : rest).push(item);
    }
    for (const item of collectEmojiItems(list[i])) {
      if (firstDescribable(item)) emoji.push(item);
    }
  }
  return { items, rest, overflow: rest.length, emoji };
}
