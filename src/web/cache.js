// Functions over the shared media cache (data/guilds/<id>/media.json, a plain
// object whose key order is its recency): the web lookup's link reads and
// searches live in it next to the media describer's entries, and the
// describer (src/memory/describe.js) keeps its entries and question keys
// with the same functions. Pure: they only touch the object handed in.

import { createHash } from 'node:crypto';

/**
 * Move `key` to the end of `cache` (most-recently-used), inserting it if new.
 * @param {object} cache
 * @param {string} key
 * @param {unknown} value
 */
export function touchKey(cache, key, value) {
  delete cache[key];
  cache[key] = value;
}

/**
 * Drop the oldest entries once `cache` holds more than `maxEntries`.
 * @param {object} cache
 * @param {number} maxEntries
 */
export function trimCache(cache, maxEntries) {
  const keys = Object.keys(cache);
  const overflow = keys.length - Math.max(0, maxEntries);
  for (let i = 0; i < overflow; i += 1) delete cache[keys[i]];
}

/**
 * A cache key for free text that must not be stored as is: `<prefix>:` and
 * the first 16 hex characters of the sha1 of `text`, taken as given (the
 * caller normalises it first).
 * @param {string} prefix
 * @param {string} text
 * @returns {string}
 */
export function hashedKey(prefix, text) {
  return `${prefix}:${createHash('sha1').update(String(text)).digest('hex').slice(0, 16)}`;
}
