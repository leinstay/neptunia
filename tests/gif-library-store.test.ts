// The shared GIF library in the store (src/memory/store.ts over memory.db): one unit, not one per place, read with no
// place at all and surviving a new store over the same database. Plan 2026-11-04-cli-and-memory, stage B7.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/memory/store.ts';
import { memDataDir } from './fixtures/store-kit.ts';

const A = 'place:room-1';
const B = 'place:room-2';
const T0 = Date.UTC(2026, 10, 1);
const TENOR = 'https://tenor.com/view/cat-dance-123';

function linkMessage(id: string, placeId: string) {
  return {
    id,
    placeId,
    ts: T0,
    attachments: [],
    links: [{ id: `${id}#e0`, kind: 'gif', site: 'Tenor', title: '', text: '', url: TENOR }],
  };
}

function rig() {
  const { dir, memoryDb } = memDataDir();
  const store = createStore({ dataDir: dir, memoryDb });
  return { store, dir, memoryDb };
}

test('two places record into one library, read with no place', () => {
  const { store } = rig();
  store.recordGifs(A, [linkMessage('m1', A)]);
  store.recordGifs(B, [linkMessage('m2', B)]);
  const entries = Object.values(store.getGifs().entries);
  assert.equal(entries.length, 1);
  assert.equal(entries[0].places[A].count, 1);
  assert.equal(entries[0].places[B].count, 1);
});

test('a handle finds the same GIF from any place', () => {
  const { store } = rig();
  store.recordGifs(A, [linkMessage('m1', A)]);
  const found = store.findGif('g1');
  assert.ok(found);
  assert.equal(found.url, TENOR);
});

test('an own post is stamped on the place it went to', () => {
  const { store } = rig();
  store.recordGifs(A, [linkMessage('m1', A)]);
  const [key] = Object.keys(store.getGifs().entries);
  assert.equal(store.recordOwnGif(B, key, T0 + 1), true);
  assert.equal(store.getGifs().entries[key].places[B].ownLast, T0 + 1);
});

test('the library survives a new store over the same database', async () => {
  const { store, dir, memoryDb } = rig();
  store.recordGifs(A, [linkMessage('m1', A)]);
  store.recordGifs(B, [linkMessage('m2', B)]);
  store.flush();
  await store.flushSettled({});
  const again = createStore({ dataDir: dir, memoryDb });
  const entries = Object.values(again.getGifs().entries);
  assert.equal(entries.length, 1);
  assert.deepEqual(Object.keys(entries[0].places).sort(), [A, B]);
});

test('the emoji rails of a place survive a new store and stay apart from another place', async () => {
  const { store, dir, memoryDb } = rig();
  const rails = { repliesSince: 1, lastUsed: { wave: T0 } };
  store.setEmojiRails(A, rails);
  store.flush();
  await store.flushSettled({});
  const again = createStore({ dataDir: dir, memoryDb });
  assert.deepEqual(again.getEmojiRails(A), rails);
  assert.equal(again.getEmojiRails(B), null);
});
