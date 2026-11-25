// src/behavior/own-messages.ts: the persona's own messages of a chat, read through the interface's `history`.
// The tests cover what the journal's reconciliation needs of it (the text as written, the reply target, the rejection
// when the history cannot be read) and the edges of the list itself.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownMessagesOf } from '../../../src/behavior/own-messages.ts';
import { IFACE, SELF_ID, channel, message, rig } from '../../fixtures/reads-rig.ts';

const room = channel('c1');
const T0 = Date.UTC(2026, 9, 13, 12, 0, 0);

test("gives an empty list when the chat holds nothing of the persona's", async () => {
  const { reads, fake } = rig();
  fake.seedChat(room);
  fake.seedEvent(message(room, 'm1', T0, 'hello', { authorId: 'u1' }));
  assert.deepEqual(await ownMessagesOf(reads, IFACE)('c1', 20), []);
});

test("gives the persona's messages in the order the history gives them, oldest first", async () => {
  const { reads, fake } = rig();
  fake.seedChat(room);
  fake.seedEvent(message(room, 'm1', T0, 'one', { authorId: SELF_ID }));
  fake.seedEvent(message(room, 'm2', T0 + 1000, 'two', { authorId: 'u1' }));
  fake.seedEvent(message(room, 'm3', T0 + 2000, 'three', { authorId: SELF_ID }));
  const own = await ownMessagesOf(reads, IFACE)('c1', 20);
  assert.deepEqual(
    own.map((item) => item.id),
    ['m1', 'm3']
  );
});

const DAY = Date.UTC(2026, 9, 13, 23, 59, 50);

test("gives the persona's own messages of a chat and none of anyone else's", async () => {
  const { reads, fake } = rig();
  fake.seedChat(room);
  fake.seedEvent(message(room, 'm1', DAY - 3000, 'hello', { authorId: 'u1' }));
  fake.seedEvent(message(room, 'm2', DAY - 2000, 'hi back', { authorId: SELF_ID }));
  fake.seedEvent(message(room, 'm3', DAY - 1000, 'thanks', { authorId: 'u1' }));
  const own = await ownMessagesOf(reads, IFACE)('c1', 20);
  assert.deepEqual(
    own.map((item) => item.id),
    ['m2']
  );
});

test("gives the text as written, with the mention in the core's grammar, and the reply target and the time", async () => {
  const { reads, fake } = rig();
  fake.seedChat(room);
  fake.seedEvent(
    message(room, 'm9', DAY - 500, 'hi @Eleni', {
      authorId: SELF_ID,
      sourceText: 'hi <@u1>',
      replyToId: 'm1',
    })
  );
  const [own] = await ownMessagesOf(reads, IFACE)('c1', 20);
  assert.deepEqual(own, { id: 'm9', content: 'hi <@u1>', replyToId: 'm1', createdAt: DAY - 500 });
});

test("reads the last `count` messages of the chat, mixed authors included, before it keeps the persona's", async () => {
  const { reads, fake, asked } = rig();
  fake.seedChat(room);
  fake.seedEvent(message(room, 'm1', DAY - 4000, 'one', { authorId: SELF_ID }));
  fake.seedEvent(message(room, 'm2', DAY - 3000, 'two', { authorId: 'u1' }));
  fake.seedEvent(message(room, 'm3', DAY - 2000, 'three', { authorId: SELF_ID }));
  const own = await ownMessagesOf(reads, IFACE)('c1', 2);
  assert.deepEqual(
    own.map((item) => item.id),
    ['m3']
  );
  assert.deepEqual(asked('history'), [{ iface: IFACE, chatId: 'c1' }]);
});

test('fails when the interface cannot give the history, so the operation is left unknown', async () => {
  const { reads } = rig({ reads: ['messages.fetch'] });
  await assert.rejects(ownMessagesOf(reads, IFACE)('c1', 20));
});
