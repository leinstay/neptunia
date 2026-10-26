// Tests for the conversation directory of the core (src/interface/directory.ts): the names of the conversations
// an interface reported through `conversation.changed`, read by the inner life when it names a channel.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConversationDirectory } from '../src/interface/directory.ts';
import type { ConversationChanged } from '../src/protocol/events.js';

function changed(change: ConversationChanged['change'], id: string, name: string | null): ConversationChanged {
  return {
    kind: 'conversation.changed',
    iface: 'discord',
    at: 1,
    id: `discord:conversation:${id}:${change}:${name}`,
    conversation: { id, kind: 'channel', communityId: 'g1', name },
    change,
  };
}

test('names a conversation after its creation is applied', () => {
  const directory = createConversationDirectory();
  directory.apply(changed('created', 'c1', 'general'));
  assert.equal(directory.nameOf('c1'), 'general');
});

test('names a conversation not seen before when the first event is an update', () => {
  const directory = createConversationDirectory();
  directory.apply(changed('updated', 'c2', 'music'));
  assert.equal(directory.nameOf('c2'), 'music');
});

test('reads the new name once a rename is applied', () => {
  const directory = createConversationDirectory();
  directory.apply(changed('created', 'c1', 'general'));
  directory.apply(changed('updated', 'c1', 'lounge'));
  assert.equal(directory.nameOf('c1'), 'lounge');
});

test('forgets a conversation once its deletion is applied', () => {
  const directory = createConversationDirectory();
  directory.apply(changed('created', 'c1', 'general'));
  directory.apply(changed('deleted', 'c1', 'general'));
  assert.equal(directory.nameOf('c1'), null);
  assert.deepEqual(directory.ids(), []);
});

test('answers null for an id it was never told about', () => {
  const directory = createConversationDirectory();
  directory.apply(changed('created', 'c1', 'general'));
  assert.equal(directory.nameOf('c9'), null);
});

test('lists every conversation it knows by id', () => {
  const directory = createConversationDirectory();
  directory.apply(changed('created', 'c1', 'general'));
  directory.apply(changed('created', 'c2', 'music'));
  directory.apply(changed('updated', 'c1', 'lounge'));
  assert.deepEqual([...directory.ids()].sort(), ['c1', 'c2']);
});

test('ignores the deletion of a conversation it never knew', () => {
  const directory = createConversationDirectory();
  directory.apply(changed('created', 'c1', 'general'));
  directory.apply(changed('deleted', 'c9', 'ghost'));
  assert.deepEqual(directory.ids(), ['c1']);
});
