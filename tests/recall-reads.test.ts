// src/behavior/recall-reads.ts: what the recall runner does with the interface's reads that needs none of its state. The
// search plan written for the interface, the wait on a read that cannot be cancelled, and a history read turned into lines.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { hitFrom, inCommunity, linesOf, searchQueryOf, untilAborted } from '../src/behavior/recall-reads.ts';
import { IFACE, SELF_ID, channel, message, privateChannel, rig } from './fixtures/reads-rig.ts';

test('writes a form or who query as the text to find and an author query as the author', () => {
  assert.deepEqual(searchQueryOf({ kind: 'form', content: 'rabbit' }), { text: 'rabbit' });
  assert.deepEqual(searchQueryOf({ kind: 'who', content: 'Eleni' }), { text: 'Eleni' });
  assert.deepEqual(searchQueryOf({ kind: 'author', authorId: 'u1' }), { authorId: 'u1' });
});

test('carries the time bounds that are numbers and the offset only when it is a positive whole number', () => {
  const bounds = { kind: 'form', content: 'x', after: 1000, before: 2000 };
  assert.deepEqual(searchQueryOf({ ...bounds, offset: 25 }), { text: 'x', after: 1000, before: 2000, offset: 25 });
  assert.deepEqual(searchQueryOf({ ...bounds, offset: 0 }), { text: 'x', after: 1000, before: 2000 });
  assert.deepEqual(searchQueryOf({ kind: 'form', content: 'x', after: Number.NaN }), { text: 'x' });
});

test('reads a hit as a line of the clustering with no query yet attached', () => {
  const hit = {
    ref: { iface: IFACE, conversationId: 'c1', messageId: 'm7' },
    at: 5000,
    text: 'hello',
    author: { id: 'u1', handle: 'eleni', displayName: 'Eleni', bot: true },
  };
  const read = hitFrom(hit);
  assert.deepEqual(
    { ...read, queries: [...read.queries] },
    {
      id: 'm7',
      channelId: 'c1',
      ts: 5000,
      authorId: 'u1',
      bot: true,
      username: 'eleni',
      queries: [],
    }
  );
});

test('tells a conversation of a community from a private chat', () => {
  assert.equal(inCommunity(channel('c1')), true);
  assert.equal(inCommunity({ ...privateChannel('c4', []), communityId: null }), false);
  assert.equal(inCommunity(null), false);
});

test('gives the value of the read when it settles before the signal aborts', async () => {
  assert.equal(await untilAborted(new AbortController().signal, Promise.resolve('done')), 'done');
});

test('gives null when the signal aborts first, and leaves the late read behind', async () => {
  const controller = new AbortController();
  const late = new Promise<string>((resolve) => setTimeout(() => resolve('late'), 20));
  const waiting = untilAborted(controller.signal, late);
  controller.abort();
  assert.equal(await waiting, null);
  assert.equal(await untilAborted(controller.signal, Promise.resolve('too late')), null);
});

test('gives null when the read fails', async () => {
  assert.equal(await untilAborted(new AbortController().signal, Promise.reject(new Error('boom'))), null);
});

test('gives the lines of a history read oldest first, and null when the history cannot be read', async () => {
  const { reads, fake } = rig();
  const room = channel('c1');
  fake.seedConversation(room);
  fake.seedEvent(message(room, 'm1', 1000, 'one', { authorId: 'u1' }));
  fake.seedEvent(message(room, 'm2', 2000, 'two', { authorId: SELF_ID }));
  const lines = await linesOf(reads, { iface: IFACE, id: 'c1' }, { limit: 10 });
  assert.deepEqual(
    lines?.map((line) => line.id),
    ['m1', 'm2']
  );
  const blind = rig({ reads: ['messages.fetch'] });
  assert.equal(await linesOf(blind.reads, { iface: IFACE, id: 'c1' }, { limit: 10 }), null);
});
