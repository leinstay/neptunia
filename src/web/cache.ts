// Functions over the shared media cache (data/places/<id>/media.json, a plain
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

/** The most characters of a link's read text a transcript shows. Production value, config cut of 2026-10-31. */
export const LINK_EXCERPT_CHARS = 700;

/** The entries of a place's media cache that nothing links are capped at this. Production value, config cut of 2026-10-31. */
export const MEDIA_CACHE_ENTRIES = 5000;

/**
 * Drop the oldest entries once `cache` holds more than `maxEntries`, the entries of `linked` aside: an attachment id or its
 * video summary (`video:<id>`) that a stored line or a diary post links stays, however old. `linked` is asked only when
 * something is to go, and with every entry linked the cache stays over the cap.
 */
export function trimCache(
  cache: Record<string, unknown>,
  maxEntries: number,
  linked?: (() => ReadonlySet<string>) | null
): void {
  const keys = Object.keys(cache);
  let overflow = keys.length - Math.max(0, maxEntries);
  if (overflow <= 0) return;
  let kept: ReadonlySet<string> | null;
  try {
    kept = linked?.() ?? null;
  } catch {
    // The links cannot be read now, so nothing can be told apart: the entries wait for the next trim.
    return;
  }
  for (const key of keys) {
    if (overflow === 0) break;
    if (kept?.has(key.replace(/^video:/, ''))) continue;
    delete cache[key];
    overflow -= 1;
  }
}

/**
 * A cache key for free text that must not be stored as is: `<prefix>:` and
 * the first 16 hex characters of the sha1 of `text`, taken as given (the
 * caller normalises it first).
 */
export function hashedKey(prefix: string, text: string): string {
  return `${prefix}:${createHash('sha1').update(String(text)).digest('hex').slice(0, 16)}`;
}
