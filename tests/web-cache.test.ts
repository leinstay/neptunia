// The keys of the shared media cache (src/web/cache.ts): a page read and a search are stored under a key made from
// their text, and a stored entry is found again only while the key comes out the same.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hashedKey } from '../src/web/cache.ts';

// Bug: a changed hash or cut gives every page read and search a new key, so the stored entries are never found again
// and each is fetched and paid for anew.
test('a text keeps the key it was stored under: the prefix and 16 hex characters of its sha1', () => {
  assert.equal(hashedKey('page', 'https://example.invalid/page'), 'page:c9b243af7f06fc93');
});
