// Tests for `nativeOfAny` (src/memory/db/ids.ts): the native id inside a person, account or place id of any
// interface, which the mappers of the legacy files read the ids they wrote with.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountId, channelPlaceId, dmPlaceId, nativeOfAny, personId } from '../src/memory/db/ids.ts';

test('reads the native id back out of the ids of any interface', () => {
  for (const iface of ['discord', 'cli', 'fake']) {
    assert.equal(nativeOfAny(personId(iface, 'u1')), 'u1', iface);
    assert.equal(nativeOfAny(accountId(iface, 'u1')), 'u1', iface);
    assert.equal(nativeOfAny(channelPlaceId(iface, 'c1')), 'c1', iface);
    assert.equal(nativeOfAny(dmPlaceId(iface, 'u1')), 'u1', iface);
  }
});

test('answers null for the persona and for a source id, which name no native id', () => {
  assert.equal(nativeOfAny('person:self'), null);
  assert.equal(nativeOfAny('src:discord:400:1:seen'), null);
  assert.equal(nativeOfAny(undefined), null);
});
