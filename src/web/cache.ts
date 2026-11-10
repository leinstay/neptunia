// The keys and the excerpt length of the shared media cache (src/memory/store-media.ts): the web lookup's link reads and
// searches (src/web/lookup.ts) live in it next to the media describer's entries (src/memory/describe.ts). Pure.

import { createHash } from 'node:crypto';

/** The most characters of a link's read text a transcript shows. Production value, config cut of 2026-10-31. */
export const LINK_EXCERPT_CHARS = 700;

/**
 * A cache key for free text that must not be stored as is: `<prefix>:` and
 * the first 16 hex characters of the sha1 of `text`, taken as given (the
 * caller normalises it first).
 */
export function hashedKey(prefix: string, text: string): string {
  return `${prefix}:${createHash('sha1').update(String(text)).digest('hex').slice(0, 16)}`;
}
