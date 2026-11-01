// Tests for src/web/cache.ts: the media cache helpers of the web lookup (LRU order, trimming).
// Pure: plain objects in, plain objects out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { touchKey, trimCache } from '../src/web/cache.ts';

test('touchKey: a new key is appended; an existing one moves to the end with its new value', () => {
  const cache = { a: 1, b: 2, c: 3 };
  touchKey(cache, 'a', 10);
  assert.deepEqual(Object.keys(cache), ['b', 'c', 'a']);
  assert.equal(cache.a, 10);
  touchKey(cache, 'd', 4);
  assert.deepEqual(Object.keys(cache), ['b', 'c', 'a', 'd']);
});

test('trimCache: drops the oldest entries past maxEntries; a negative max empties it', () => {
  const cache = { a: 1, b: 2, c: 3, d: 4 };
  trimCache(cache, 2);
  assert.deepEqual(cache, { c: 3, d: 4 });
  trimCache(cache, 5);
  assert.deepEqual(cache, { c: 3, d: 4 });
  trimCache(cache, Infinity);
  assert.deepEqual(cache, { c: 3, d: 4 });
  trimCache(cache, -1);
  assert.deepEqual(cache, {});
});
