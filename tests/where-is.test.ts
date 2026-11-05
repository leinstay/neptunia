// The native channel is `conversationId`: tests/guild-lexical-inventory.test.ts keeps `channelId` in the adapter.
// `whereIs` answers where a turn happens from what the turn already holds: its interface and its conversation. Pure, and
// the seed of her knowing where she is, so a wake answers nothing rather than a guess.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { whereIs } from '../src/turn/where-is.ts';

test('a channel answers its interface, its server and itself', () => {
  assert.deepEqual(
    whereIs({
      iface: 'discord',
      conversation: { id: 'c1', kind: 'channel', rootId: 'g1', name: 'general', parentId: 'g1', parentKind: 'server' },
    }),
    {
      kind: 'channel',
      interfaceId: 'discord',
      serverId: 'g1',
      conversationId: 'c1',
      threadId: null,
      channelName: 'general',
    }
  );
});

test('a channel inside a category stays the channel, the category is no thread', () => {
  // Bug: `parentId` read as the channel of a thread answers the category as the place she is in.
  assert.deepEqual(
    whereIs({
      iface: 'discord',
      conversation: { id: 'c1', kind: 'channel', rootId: 'g1', name: null, parentId: 'cat1', parentKind: 'category' },
    }),
    { kind: 'channel', interfaceId: 'discord', serverId: 'g1', conversationId: 'c1', threadId: null, channelName: null }
  );
});

test('a thread answers the channel it sits in and itself', () => {
  assert.deepEqual(
    whereIs({
      iface: 'discord',
      conversation: { id: 't1', kind: 'thread', rootId: 'g1', name: 'a thread', parentId: 'c1' },
    }),
    {
      kind: 'channel',
      interfaceId: 'discord',
      serverId: 'g1',
      conversationId: 'c1',
      threadId: 't1',
      channelName: 'a thread',
    }
  );
});

test('a group chat is a channel with no server', () => {
  assert.deepEqual(
    whereIs({ iface: 'telegram', conversation: { id: 'g9', kind: 'channel', chatType: 'group_dm', name: null } }),
    {
      kind: 'channel',
      interfaceId: 'telegram',
      serverId: null,
      conversationId: 'g9',
      threadId: null,
      channelName: null,
    }
  );
});

test('a direct chat answers the DM with its partner and no server', () => {
  assert.deepEqual(
    whereIs({
      iface: 'discord',
      conversation: { id: 'd1', kind: 'dm', chatType: 'dm', partnerId: 'u1', rootId: null },
    }),
    { kind: 'dm', interfaceId: 'discord', partnerId: 'u1' }
  );
});

test('a direct chat whose partner is unknown still answers the DM', () => {
  assert.deepEqual(whereIs({ iface: 'discord', conversation: { id: 'd1', kind: 'dm', partnerId: null } }), {
    kind: 'dm',
    interfaceId: 'discord',
    partnerId: null,
  });
});

test('the command line answers the command line, though its conversation is a DM', () => {
  // Bug: the chat reads as a DM of an interface, so she says she is in a private chat somewhere on a server's platform.
  assert.deepEqual(
    whereIs({ iface: 'cli', conversation: { id: 'cli:dm:owner', kind: 'dm', chatType: 'dm', partnerId: 'owner' } }),
    { kind: 'cli' }
  );
});

test('a wake is nowhere', () => {
  // Bug: a wake inherits the last channel from somewhere, and she believes she is standing in a room she is not in.
  assert.equal(whereIs({ iface: 'discord', conversation: null }), null);
  assert.equal(whereIs({ iface: null, conversation: null }), null);
});
