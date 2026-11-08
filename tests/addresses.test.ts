// src/memory/addresses.ts: what a module holds natively as the ids the store addresses. A store with the database answers
// them; a stand-in store holds the native ids as given.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountOf, personOfMember, placeOfRoot, placeOfChat, sharedPlaceOf } from '../src/memory/addresses.ts';

const answering = {
  placeOfChat: () => 'place:chat',
  sharedPlaceOf: () => 'place:top',
  placeOfRoot: () => 'place:root',
  accountOf: () => 'account:one',
  personOfAccount: (account: string) => `person-of-${account}`,
};

test('a store that answers is asked, and its ids come back', () => {
  // Bug: a module keeps the native id beside a store that knows the canonical one, and writes under the wrong collection.
  assert.equal(placeOfChat(answering, { id: 'c1' }), 'place:chat');
  assert.equal(sharedPlaceOf(answering, { id: 'c1', rootId: 'g1' }), 'place:top');
  assert.equal(placeOfRoot(answering, 'g1'), 'place:root');
  assert.equal(accountOf(answering, 'u1'), 'account:one');
  assert.equal(personOfMember(answering, 'u1'), 'person-of-account:one');
});

test('a stand-in store holds the native ids, the root before the chat', () => {
  // Bug: a test's store without the database gets an empty id, and every place shares one collection.
  assert.equal(placeOfChat({}, { id: 'c1' }), 'c1');
  assert.equal(sharedPlaceOf({}, { id: 'c1', rootId: 'g1' }), 'g1');
  assert.equal(sharedPlaceOf(null, { id: 'd1', rootId: null }), 'd1');
  assert.equal(placeOfRoot(undefined, 'g1'), 'g1');
  assert.equal(accountOf({}, 'u1'), 'u1');
});
