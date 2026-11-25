// The GIF library as a request shows it: the line of a GIF of the library in media.find's result, and the per-bucket
// hold of what memory changes in the stable part. buildRequest (src/behavior/prompt.js) and the persona's GIF tools
// (src/tools/tools.ts) read them.

import { fill, formatDuration } from '../../format.ts';
import { HOUR_MS } from '../../time.ts';
import type { Labels } from './types.ts';

/** One entry of the describer's cache, read only: a caption or a miss. */
export type MediaCacheEntry = { readonly miss?: unknown; readonly text?: unknown };

/** Entries of the describer cache a caller holds (store.mediaEntries), read only, per item id. */
export type MediaCache = { readonly [itemId: string]: MediaCacheEntry | undefined };

/** A read of the describer's cache by key (store.mediaEntry). */
export type MediaLookup = (key: string) => MediaCacheEntry | undefined;

/** The read by key of a cache as its callers hand it: a lookup as it is, an object of entries by its own keys. */
export function mediaLookupOf(given: MediaLookup | object | null | undefined): MediaLookup | null {
  if (typeof given === 'function') return given as MediaLookup;
  if (!given || typeof given !== 'object') return null;
  const cache = given as MediaCache;
  return (key) => (Object.hasOwn(cache, key) ? cache[key] : undefined);
}

/** One GIF of the library (src/memory/gifs.ts): its handle, its media item and when the persona last posted it. */
export type GifEntry = { readonly id: string; readonly itemId: string; readonly ownLast?: number };

/** The entry of `itemId` in the describer cache as its callers hand it (mediaLookupOf). */
const cachedOf = (mediaCache: MediaLookup | object | null | undefined, itemId: string): MediaCacheEntry | undefined =>
  mediaLookupOf(mediaCache)?.(itemId);

/** What freezePerBucket holds under a key for the bucket it was computed in. */
export type Held<T> = { bucket: number; signature: string; value: T };

/**
 * `compute()`, held in `freeze` under `key` for the time bucket of `now`
 * (`Math.floor(now / bucketMs)`, buckets aligned to the epoch): within one
 * bucket, and while `signature` stays the same, every call returns what the
 * first call of the bucket computed; the first call of the next bucket (or
 * one with another signature) computes again and holds that. The reply's
 * stable part renders what memory changes through this (`<self_facts>`), with `bucketMs` the cache TTL (src/llm/openrouter.ts#cacheTtlMs):
 * a memory batch or a GIF post then rewrites the cached prefix at most once
 * per TTL, and the persona sees the change at the next bucket edge. `signature`
 * names the settings the value is rendered with (labels, config), so an
 * operator's edit shows at once. No Map, or `now`/`bucketMs` unusable ->
 * `compute()` every time. An array value is returned as a copy, so a caller
 * never changes what is held. Mutates `freeze` only.
 */
export function freezePerBucket<T>(
  freeze: Map<string, Held<unknown>> | null | undefined,
  key: string,
  { now, bucketMs, signature = '' }: { now: number; bucketMs: number; signature?: string },
  compute: () => T
): T {
  if (!(freeze instanceof Map) || !Number.isFinite(now) || !Number.isFinite(bucketMs) || bucketMs <= 0)
    return compute();
  const bucket = Math.floor(now / bucketMs);
  // Each key holds one kind of value, the one its compute gives.
  let held = freeze.get(key) as Held<T> | undefined;
  if (!held || held.bucket !== bucket || held.signature !== signature) {
    held = { bucket, signature, value: compute() };
    freeze.set(key, held);
  }
  // A copy of a held array is the same kind of value.
  return Array.isArray(held.value) ? ([...(held.value as Array<unknown>)] as T) : held.value;
}

/**
 * The description of a GIF library entry: the text cached under its `itemId` (the describer's cache; a `miss` entry has
 * none), whole; '' when there is none.
 */
function gifDescription(
  entry: { readonly itemId: string },
  mediaCache: MediaLookup | object | null | undefined
): string {
  const cached = cachedOf(mediaCache, entry?.itemId);
  return cached && !cached.miss && typeof cached.text === 'string' ? cached.text : '';
}

/**
 * One line of a GIF library entry, as media.find lists it: its whole description (gifDescription) through
 * `labels.gifs.entry` (`{id}`, `{text}`), else `labels.gifs.entryNoText` (`{id}`). A GIF the persona itself posted
 * (`ownLast`) no longer than `ownMarkHours` (0 = never) before `now` gets ` ` + `labels.gifs.ownMark` appended,
 * `{ago}` = that time through formatDuration (`labels.units`); no mark without that label. The caller checks that
 * `labels.gifs` carries `entryNoText`. Pure.
 */
export function gifLine(
  entry: GifEntry,
  mediaCache: MediaLookup | object | null | undefined,
  labelsGiven: object,
  { ownMarkHours, now }: { ownMarkHours: number; now: number }
): string {
  const labels = labelsGiven as Labels;
  // The caller checks that `labels.gifs` carries `entryNoText`.
  const g = labels.gifs!;
  const text = gifDescription(entry, mediaCache);
  const line = text && g.entry ? fill(g.entry, { id: entry.id, text }) : fill(g.entryNoText, { id: entry.id });
  const age = g.ownMark && labels.units ? ownPostAge(entry, { ownMarkHours, now }) : null;
  if (age === null) return line;
  return `${line} ${fill(g.ownMark, { ago: formatDuration(age, labels.units) })}`;
}

/** How long ago the persona posted `entry` when that is within `ownMarkHours` (0 = never) of `now`, else null. */
function ownPostAge(entry: GifEntry, { ownMarkHours, now }: { ownMarkHours: number; now: number }): number | null {
  // A GIF the persona never posted has no `ownLast`: no age, so no mark.
  const ownLast = entry.ownLast ?? NaN;
  const age = Math.max(0, now - ownLast);
  if (!Number.isFinite(ownMarkHours) || ownMarkHours <= 0 || !(ownLast > 0) || age > ownMarkHours * HOUR_MS)
    return null;
  return age;
}
