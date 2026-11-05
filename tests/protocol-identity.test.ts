// The neutral addresses of src/protocol/identity.ts: a place and an account are named by the interface, the authority
// inside it and the native id, and the generation for an account. Equal native ids stay apart until the owner links them.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { nativeAuthorityOf } from '../src/memory/db/ids.ts';
import { accountKey, conversationAddressOf, conversationKey } from '../src/protocol/identity.ts';
import type { AccountAddress, ConversationAddress } from '../src/protocol/identity.ts';

const PLACE: ConversationAddress = { interfaceId: 'one', authorityId: 'one/global', placeId: 'same' };
const ACCOUNT: AccountAddress = { interfaceId: 'one', authorityId: 'one/global', nativeId: 'same', generation: 1 };

test('a conversation key differs when only the interface, the authority or the place differs', () => {
  // Bug: state keyed by the native id alone mixes two chats of two interfaces, or two tenants of one interface.
  const keys = [
    PLACE,
    { ...PLACE, interfaceId: 'two' },
    { ...PLACE, authorityId: 'one/tenant-b' },
    { ...PLACE, placeId: 'other' },
  ].map(conversationKey);
  assert.equal(new Set(keys).size, 4);
});

test('a conversation key cannot be forged by a delimiter inside a native id', () => {
  // Bug: joining with a separator lets `a:b` + `c` collide with `a` + `b:c`, and a platform id may hold any character.
  const left = { interfaceId: 'one', authorityId: 'a:b', placeId: 'c' };
  const right = { interfaceId: 'one', authorityId: 'a', placeId: 'b:c' };
  assert.notEqual(conversationKey(left), conversationKey(right));
  const quoted = { interfaceId: 'one', authorityId: 'a","b', placeId: 'c' };
  const split = { interfaceId: 'one', authorityId: 'a', placeId: 'b","c' };
  assert.notEqual(conversationKey(quoted), conversationKey(split));
});

test('a conversation key is the same for the same address whatever the order of its fields', () => {
  // Bug: a route written from one object shape misses a read that builds the address in another.
  const reordered = { placeId: 'same', interfaceId: 'one', authorityId: 'one/global' };
  assert.equal(conversationKey(reordered), conversationKey(PLACE));
});

test('an account key differs when only the interface, the authority, the native id or the generation differs', () => {
  // Bug: a reused native id, a new generation of it, inherits the person of its previous holder.
  const keys = [
    ACCOUNT,
    { ...ACCOUNT, interfaceId: 'two' },
    { ...ACCOUNT, authorityId: 'one/tenant-b' },
    { ...ACCOUNT, nativeId: 'other' },
    { ...ACCOUNT, generation: 2 },
  ].map(accountKey);
  assert.equal(new Set(keys).size, 5);
});

test('an event with no declared authority is addressed under the authority the memory stores', () => {
  // Bug: the protocol and the memory spell one place differently, so a route never matches its stored place.
  for (const iface of ['other', 'cli']) {
    const address = conversationAddressOf({ iface, conversation: { id: 'c1', kind: 'channel', rootId: 'g1' } });
    assert.deepEqual(address, { interfaceId: iface, authorityId: nativeAuthorityOf(iface), placeId: 'c1' });
  }
});

test('an interface that declares two authorities gets two addresses for one native conversation id', () => {
  // Bug: two tenants served by one link collapse into one place because only the interface name is read.
  const of = (authorityId: string) =>
    conversationAddressOf({ iface: 'one', conversation: { id: 'c1', kind: 'channel', authorityId } });
  assert.equal(of('one/tenant-a').authorityId, 'one/tenant-a');
  assert.notEqual(conversationKey(of('one/tenant-a')), conversationKey(of('one/tenant-b')));
});

test('a DM is addressed without any community', () => {
  // Bug: an address built from the home community names a place the DM has nothing to do with.
  const address = conversationAddressOf({
    iface: 'other',
    conversation: { id: 'd1', kind: 'dm', rootId: null, partnerId: 'u1' },
  });
  assert.deepEqual(address, { interfaceId: 'other', authorityId: 'other/global', placeId: 'd1' });
});
