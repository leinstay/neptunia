// Tests for the diary channel's mark in the server map: src/memory/channels.js#renderChannel
// (`diary` option, `labels.server.diary`) and the persona's own lines counting as a writer of
// that one channel (src/memory/update.js#touchMemory).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { renderChannel } from '../src/memory/channels.js';
import { touchMemory } from '../src/memory/update.js';
import { createStore } from '../src/memory/store.js';
import { labels } from './fixtures/labels.js';
import { tempDir } from './fixtures/tmp.js';

const channel = { id: 'c1', name: 'journal', category: null, topic: null, purpose: '', topics: '', tone: '' };

test('renderChannel: marks the diary channel before the read-only line', () => {
  const text = renderChannel(channel, labels, { activity: 'slow', readOnly: true, diary: true });
  const lines = text.split('\n');
  const diaryLine = labels.server.diary.replace('{channel}', 'journal');
  assert.ok(lines.includes(diaryLine), text);
  assert.equal(lines.indexOf(diaryLine) + 1, lines.indexOf(labels.server.readOnly), 'right before the read-only line');
});

test('renderChannel: does not mark other channels', () => {
  assert.ok(!renderChannel(channel, labels, { activity: 'slow', readOnly: true }).includes('diary'));
  assert.ok(!renderChannel(channel, labels, { activity: 'slow', diary: false }).includes('diary'));
});

test('renderChannel: the diary mark is omitted when its label is missing', () => {
  const bare = { ...labels, server: { ...labels.server, diary: undefined } };
  assert.equal(
    renderChannel(channel, bare, { activity: 'slow', diary: true }),
    renderChannel(channel, bare, { activity: 'slow' })
  );
});

function withStore(fn) {
  const dir = tempDir('nep-diary-map-');
  try {
    return fn(createStore({ dataDir: dir }));
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}

const own = (channelId) => ({
  id: 'm1',
  channelId,
  channelName: 'x',
  authorId: 'self1',
  authorName: 'bot',
  self: true,
  bot: false,
  content: 'a post',
  ts: Date.UTC(2026, 8, 20, 12),
});

test("touchMemory: the persona's lines count as a writer only in the diary channel", () => {
  withStore((store) => {
    touchMemory(store, 'g1', own('diary'), { diaryChannelId: 'diary' });
    touchMemory(store, 'g1', own('other'), { diaryChannelId: 'diary' });
    touchMemory(store, 'g1', own('nowhere'), {});
    assert.deepEqual(store.getChannel('g1', 'diary').topWriters, [{ id: 'self1', count: 1 }]);
    assert.deepEqual(store.getChannel('g1', 'other').topWriters, []);
    assert.deepEqual(store.getChannel('g1', 'nowhere').topWriters, []);
    assert.equal(store.getChannel('g1', 'diary').days['2026-09-20'], 1, 'the day tally counts the post');
  });
});

test('touchMemory: other bots never count, even in the diary channel', () => {
  withStore((store) => {
    touchMemory(store, 'g1', { ...own('diary'), self: false, bot: true, authorId: 'b2' }, { diaryChannelId: 'diary' });
    assert.deepEqual(store.getChannel('g1', 'diary').topWriters, []);
  });
});
