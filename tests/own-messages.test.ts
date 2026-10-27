// src/behavior/own-messages.ts: the persona's own messages of a conversation, read through the interface's `history`.
// What the journal's reconciliation needs of it (the text as written, the reply target, the rejection when the history
// cannot be read) is in journal-reconcile-read.test.ts; these are the edges of the list itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownMessagesOf } from '../src/behavior/own-messages.ts';
import { IFACE, SELF_ID, channel, message, rig } from './fixtures/reads-rig.ts';

const room = channel('c1');
const T0 = Date.UTC(2026, 9, 13, 12, 0, 0);

test('gives an empty list when the conversation holds nothing of hers', async () => {
  const { reads, fake } = rig();
  fake.seedConversation(room);
  fake.seedEvent(message(room, 'm1', T0, 'hello', { authorId: 'u1' }));
  assert.deepEqual(await ownMessagesOf(reads, IFACE)('c1', 20), []);
});

test('gives her messages in the order the history gives them, oldest first', async () => {
  const { reads, fake } = rig();
  fake.seedConversation(room);
  fake.seedEvent(message(room, 'm1', T0, 'one', { authorId: SELF_ID }));
  fake.seedEvent(message(room, 'm2', T0 + 1000, 'two', { authorId: 'u1' }));
  fake.seedEvent(message(room, 'm3', T0 + 2000, 'three', { authorId: SELF_ID }));
  const own = await ownMessagesOf(reads, IFACE)('c1', 20);
  assert.deepEqual(
    own.map((item) => item.id),
    ['m1', 'm3']
  );
});
