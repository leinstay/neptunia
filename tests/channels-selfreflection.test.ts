// Tests for the diary channel's mark in the server map: src/memory/channels.ts#renderChannel
// (`selfreflection` option, `labels.server.selfreflection`) and the persona's own lines counting as a writer of
// that one channel (src/memory/update.ts#touchMemory).
import { placeOfConversation } from '../src/memory/addresses.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { renderChannel } from '../src/memory/channels.ts';
import { touchMemory } from '../src/memory/update.ts';
import { createStore } from '../src/memory/store.ts';
import { labels } from './fixtures/labels.ts';
import { tempDir } from './fixtures/tmp.ts';
import { openTestMemory } from './fixtures/memory-db/service.ts';
import { seedMirror } from './fixtures/selfreflection-mirror.ts';
import { selfreflectionConversationIds } from '../src/behavior/mirror.ts';

const channel = { id: 'c1', name: 'journal', category: null, topic: null, purpose: '', topics: '', tone: '' };

test('renderChannel: marks the diary channel before the read-only line', () => {
  const text = renderChannel(channel, labels, { activity: 'slow', readOnly: true, selfreflection: true });
  const lines = text.split('\n');
  const selfreflectionLine = labels.server.selfreflection.replace('{channel}', 'journal');
  assert.ok(lines.includes(selfreflectionLine), text);
  assert.equal(
    lines.indexOf(selfreflectionLine) + 1,
    lines.indexOf(labels.server.readOnly),
    'right before the read-only line'
  );
});

test('renderChannel: does not mark other channels', () => {
  assert.ok(!renderChannel(channel, labels, { activity: 'slow', readOnly: true }).includes('selfreflection'));
  assert.ok(!renderChannel(channel, labels, { activity: 'slow', selfreflection: false }).includes('selfreflection'));
});

test('renderChannel: the diary mark is omitted when its label is missing', () => {
  const bare = { ...labels, server: { ...labels.server, selfreflection: undefined } };
  assert.equal(
    renderChannel(channel, bare, { activity: 'slow', selfreflection: true }),
    renderChannel(channel, bare, { activity: 'slow' })
  );
});

function withStore<T>(fn: (store: ReturnType<typeof createStore>) => T): T {
  const dir = tempDir('nep-diary-map-');
  try {
    return fn(createStore({ dataDir: dir }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const own = (placeId: string) => ({
  id: 'm1',
  placeId,
  channelName: 'x',
  authorId: 'self1',
  authorName: 'bot',
  self: true,
  bot: false,
  content: 'a post',
  ts: Date.UTC(2026, 8, 20, 12),
});

// Stage 3 design, section 5: the diary's places are its mirrors in memory, no longer `diary.placeId`; the caller
// passes them as `selfreflectionChannelIds` (src/behavior/mirror.ts#selfreflectionConversationIds).
test("touchMemory: the persona's lines count as a writer only in the diary channel", async () => {
  const memory = await openTestMemory();
  try {
    seedMirror(memory.memoryDb, { iface: 'fake', conversationId: 'selfreflection', at: Date.UTC(2026, 8, 20) });
    const selfreflectionChannelIds = selfreflectionConversationIds(memory.memoryDb);
    withStore((store) => {
      touchMemory(store, 'g1', own('selfreflection'), { selfreflectionChannelIds });
      touchMemory(store, 'g1', own('other'), { selfreflectionChannelIds });
      touchMemory(store, 'g1', own('nowhere'), {});
      assert.deepEqual(store.getChannel(placeOfConversation(store, { id: 'selfreflection' }))?.topWriters, [
        { id: 'self1', count: 1 },
      ]);
      assert.deepEqual(store.getChannel(placeOfConversation(store, { id: 'other' }))?.topWriters, []);
      assert.deepEqual(store.getChannel(placeOfConversation(store, { id: 'nowhere' }))?.topWriters, []);
      assert.equal(
        store.getChannel(placeOfConversation(store, { id: 'selfreflection' }))?.days['2026-09-20'],
        1,
        'the day tally counts the post'
      );
    });
  } finally {
    await memory.close();
  }
});

test('touchMemory: other bots never count, even in the diary channel', () => {
  withStore((store) => {
    touchMemory(
      store,
      'g1',
      { ...own('selfreflection'), self: false, bot: true, authorId: 'b2' },
      { selfreflectionChannelId: 'selfreflection' }
    );
    assert.deepEqual(store.getChannel(placeOfConversation(store, { id: 'selfreflection' }))?.topWriters, []);
  });
});
