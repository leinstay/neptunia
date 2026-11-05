// The keeper of the GIF library (src/memory/gif-keeper.ts): who writes what the candidate search reads and what the post
// sends. A real store over a temp folder, a fake download, a fake embedder and a fake describer. Plan
// 2026-11-04-cli-and-memory, stage B7.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createGifKeeper } from '../src/memory/gif-keeper.ts';
import { searchGifs } from '../src/memory/gifs.ts';
import { createStore } from '../src/memory/store.ts';
import { memDataDir } from './fixtures/store-kit.ts';
import type { MediaItem } from '../src/memory/describe.ts';
import type { GifBytes } from '../src/media/gif-files.ts';

const PLACE = 'place:room-1';
const T0 = Date.UTC(2026, 10, 1);
const BYTES = new Uint8Array([71, 73, 70, 56, 57, 97]);
const SILENT = { info() {}, warn() {}, error() {} };

function attached(id: string) {
  return {
    id,
    placeId: PLACE,
    ts: T0,
    links: [],
    attachments: [
      { id: 'att-1', kind: 'gif', name: 'φάση.gif', url: 'https://cdn.example/att-1.gif', contentType: 'image/gif' },
    ],
  };
}

function rig({
  fetchBytes = (): Promise<GifBytes> => Promise.resolve({ bytes: BYTES, contentType: 'image/gif' }),
} = {}) {
  const { dir, memoryDb } = memDataDir();
  const store = createStore({ dataDir: dir, memoryDb });
  const cacheOf = (placeId: string) => store.getMediaCache(placeId) as Record<string, unknown>;
  const embedded: Array<string> = [];
  const described: Array<string> = [];
  const keeper = createGifKeeper({
    store,
    dataDir: dir,
    fetchBytes,
    embed: (text: string) => {
      embedded.push(text);
      return Promise.resolve(new Float32Array([0.6, 0.8]));
    },
    describer: {
      describeMany: (placeId: string, items: Array<MediaItem>) => {
        for (const item of items) {
          described.push(String(item.itemId));
          cacheOf(placeId)[String(item.itemId)] = { text: 'μια γάτα χορεύει', ts: T0 };
        }
        return Promise.resolve({});
      },
    },
    log: SILENT,
  });
  return { dir, store, cacheOf, keeper, embedded, described };
}

test('a counted GIF gets its caption, its vector and its file, and the search then finds it', async () => {
  const { dir, store, keeper, embedded, described } = rig();
  const message = attached('m1');
  store.recordGifs(PLACE, [message]);
  await keeper.keep(PLACE, message);
  assert.deepEqual(described, ['att-1']);
  assert.deepEqual(embedded, ['μια γάτα χορεύει']);
  const [entry] = Object.values(store.getGifs().entries);
  assert.equal(entry.caption, 'μια γάτα χορεύει');
  const vector = store.getGifVectors().get(entry.itemId);
  assert.ok(vector && Math.abs(vector[0] - 0.6) < 0.01);
  assert.ok(fs.existsSync(path.join(dir, String(entry.file))));
  assert.equal(searchGifs(store.getGifs(), { words: 'γάτα', vector: null, cap: 5 }).length, 1);
  assert.equal(
    searchGifs(store.getGifs(), { words: 'χαρά', vector: [0.6, 0.8], cap: 5, vectors: store.getGifVectors() }).length,
    1,
    'the search finds it by the vector kept apart'
  );
});

test('a failed download and a failed embedding leave the caption the search can read', async () => {
  const { store, keeper } = rig({ fetchBytes: () => Promise.reject(new Error('http-404')) });
  const message = attached('m1');
  store.recordGifs(PLACE, [message]);
  await keeper.keep(PLACE, message);
  const [entry] = Object.values(store.getGifs().entries);
  assert.equal(entry.caption, 'μια γάτα χορεύει');
  assert.equal(entry.file, undefined);
});

test('settle fills an entry from the cache with no message and no second description', async () => {
  const { store, cacheOf, keeper, described, embedded } = rig();
  store.recordGifs(PLACE, [attached('m1')]);
  cacheOf(PLACE)['att-1'] = { text: 'μια γάτα', ts: T0 };
  await keeper.settle(PLACE);
  assert.deepEqual(described, []);
  assert.deepEqual(embedded, ['μια γάτα']);
  assert.equal(Object.values(store.getGifs().entries)[0].caption, 'μια γάτα');
});

test('nothing runs while paused', async () => {
  const { store, keeper, described } = rig();
  const message = attached('m1');
  store.recordGifs(PLACE, [message]);
  store.state.data.paused = true;
  await keeper.keep(PLACE, message);
  assert.deepEqual(described, []);
});
