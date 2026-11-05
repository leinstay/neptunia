// src/memory/addresses.ts: what a module holds natively as the ids the store addresses. A store with the database answers
// them; a stand-in store holds the native ids as given.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  accountOf,
  personOfMember,
  placeOfCommunity,
  placeOfConversation,
  sharedPlaceOf,
} from '../src/memory/addresses.ts';

const answering = {
  placeOfConversation: () => 'place:conversation',
  sharedPlaceOf: () => 'place:top',
  placeOfCommunity: () => 'place:community',
  accountOf: () => 'account:one',
  personOfAccount: (account: string) => `person-of-${account}`,
};

test('a store that answers is asked, and its ids come back', () => {
  // Bug: a module keeps the native id beside a store that knows the canonical one, and writes under the wrong collection.
  assert.equal(placeOfConversation(answering, { id: 'c1' }), 'place:conversation');
  assert.equal(sharedPlaceOf(answering, { id: 'c1', rootId: 'g1' }), 'place:top');
  assert.equal(placeOfCommunity(answering, 'g1'), 'place:community');
  assert.equal(accountOf(answering, 'u1'), 'account:one');
  assert.equal(personOfMember(answering, 'u1'), 'person-of-account:one');
});

test('a stand-in store holds the native ids, the community before the conversation', () => {
  // Bug: a test's store without the database gets an empty id, and every place shares one collection.
  assert.equal(placeOfConversation({}, { id: 'c1' }), 'c1');
  assert.equal(sharedPlaceOf({}, { id: 'c1', rootId: 'g1' }), 'g1');
  assert.equal(sharedPlaceOf(null, { id: 'd1', rootId: null }), 'd1');
  assert.equal(placeOfCommunity(undefined, 'g1'), 'g1');
  assert.equal(accountOf({}, 'u1'), 'u1');
});
