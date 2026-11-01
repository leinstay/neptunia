// Functions over the shared media cache (data/guilds/<id>/media.json, a plain
// object whose key order is its recency): the web lookup's link reads and
// searches live in it next to the media describer's entries, and the
// describer (src/memory/describe.ts) keeps its entries and question keys
// with the same functions. Pure: they only touch the object handed in.

import { createHash } from 'node:crypto';

/** Move `key` to the end of `cache` (most-recently-used), inserting it if new. */
export function touchKey(cache: Record<string, unknown>, key: string, value: unknown): void {
  delete cache[key];
  cache[key] = value;
}

/** The entries a guild's media cache keeps. Production value, config cut of 2026-10-31. */
export const MEDIA_CACHE_ENTRIES = 5000;

/** Drop the oldest entries once `cache` holds more than `maxEntries`. */
export function trimCache(cache: Record<string, unknown>, maxEntries: number): void {
  const keys = Object.keys(cache);
  const overflow = keys.length - Math.max(0, maxEntries);
  for (let i = 0; i < overflow; i += 1) delete cache[keys[i]];
}

/**
 * A cache key for free text that must not be stored as is: `<prefix>:` and
 * the first 16 hex characters of the sha1 of `text`, taken as given (the
 * caller normalises it first).
 */
export function hashedKey(prefix: string, text: string): string {
  return `${prefix}:${createHash('sha1').update(String(text)).digest('hex').slice(0, 16)}`;
}
