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
  const put = (placeId: string, key: string, entry: object) => store.putMediaEntry(placeId, key, entry);
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
          put(placeId, String(item.itemId), { text: 'μια γάτα χορεύει', ts: T0 });
        }
        return Promise.resolve({});
      },
    },
    log: SILENT,
  });
  return { dir, store, put, keeper, embedded, described };
}

test('a counted GIF gets its caption, its vector and its file, and the search then finds it', async () => {
  const { dir, store, keeper, embedded, described } = rig();
  const message = attached('m1');
  store.recordGifs(PLACE, [message]);
  await keeper.keep(PLACE, message);
  assert.deepEqual(described, ['att-1']);
  assert.deepEqual(embedded, ['μια γάτα χορεύει']);
  const [entry] = Object.values(store.getGifs().entries);
  // The owner on 2026-11-17: a GIF is stored as one text.
  assert.equal(entry.description, 'μια γάτα χορεύει');
  assert.ok(!Object.hasOwn(entry, 'caption'));
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
  // The owner on 2026-11-17: a GIF is stored as one text.
  assert.equal(entry.description, 'μια γάτα χορεύει');
  assert.equal(entry.file, undefined);
});

test('settle fills an entry from the cache with no message and no second description', async () => {
  const { store, put, keeper, described, embedded } = rig();
  store.recordGifs(PLACE, [attached('m1')]);
  put(PLACE, 'att-1', { text: 'μια γάτα', ts: T0 });
  await keeper.settle(PLACE);
  assert.deepEqual(described, []);
  assert.deepEqual(embedded, ['μια γάτα']);
  // The owner on 2026-11-17: a GIF is stored as one text.
  assert.equal(Object.values(store.getGifs().entries)[0].description, 'μια γάτα');
});

test('nothing runs while paused', async () => {
  const { store, keeper, described } = rig();
  const message = attached('m1');
  store.recordGifs(PLACE, [message]);
  store.state.data.paused = true;
  await keeper.keep(PLACE, message);
  assert.deepEqual(described, []);
});

// The start-up pass over a library with dead links (report 2026-11-18-gif-vectors): an entry whose file cannot be fetched
// still gets its vector, the pass's budget of 50 counts work done, and a failed file waits before it is fetched again.
const MINUTE = 60_000;

type Kind = 'dead-vector' | 'dead-bare' | 'live-bare';

/** One library entry of `kind` per id, ranked as the keeper ranks them on production: dead entries with a vector seen
 *  twice and later, the rest once and earlier. Each has its description in the cache; `dead-vector` also has its vector. */
function library(kinds: Array<[string, Kind]>) {
  const fetched: Array<string> = [];
  const embedded: Array<string> = [];
  const { dir, memoryDb } = memDataDir();
  const store = createStore({ dataDir: dir, memoryDb });
  const urlOf = (id: string) => `https://cdn.example/${id}.gif`;
  const dead = new Set(kinds.filter(([, kind]) => kind !== 'live-bare').map(([id]) => urlOf(id)));
  kinds.forEach(([id, kind], index) => {
    const ts = kind === 'dead-vector' ? T0 + index * MINUTE : T0 - 30 * 24 * 60 * MINUTE + index * MINUTE;
    const message = (n: number) => ({
      id: `m-${id}-${n}`,
      placeId: PLACE,
      ts: ts + n,
      links: [],
      attachments: [{ id, kind: 'gif', name: `${id}.gif`, url: urlOf(id), contentType: 'image/gif' }],
    });
    store.recordGifs(PLACE, kind === 'dead-vector' ? [message(0), message(1)] : [message(0)]);
    store.putMediaEntry(PLACE, id, { text: `about ${id}`, ts: T0 });
    if (kind === 'dead-vector') store.setGifDescribed(id, { description: `about ${id}`, vector: [0.6, 0.8] });
  });
  /** A new start of the engine at `at`: a fresh keeper over the same store. */
  const start = (at: number) =>
    createGifKeeper({
      store,
      dataDir: dir,
      now: () => at,
      fetchBytes: (url: string): Promise<GifBytes> => {
        fetched.push(url);
        if (dead.has(url)) return Promise.reject(new Error('http-404'));
        return Promise.resolve({ bytes: new Uint8Array([...BYTES, ...Buffer.from(url)]), contentType: 'image/gif' });
      },
      embed: (text: string) => {
        embedded.push(text);
        return Promise.resolve(new Float32Array([0.6, 0.8]));
      },
      log: SILENT,
    });
  const lacking = () => kinds.filter(([id]) => !store.getGifVectors().has(id)).map(([id]) => id);
  return { store, start, fetched, embedded, lacking, urlOf };
}

const many = (prefix: string, count: number, kind: Kind): Array<[string, Kind]> =>
  Array.from({ length: count }, (_, n): [string, Kind] => [`${prefix}${n}`, kind]);

test('settle gives a vector to an entry with a dead file when fifty dead entries with vectors rank above it', async () => {
  const { start, lacking } = library([...many('dv', 50, 'dead-vector'), ['bare', 'dead-bare']]);
  await start(T0).settle(PLACE);
  assert.deepEqual(lacking(), []);
});

test('settle fetches the file of an entry that has its vector and no file', async () => {
  const { store, start, fetched, urlOf } = library([['lv', 'live-bare']]);
  store.setGifDescribed('lv', { description: 'about lv', vector: [0.6, 0.8] });
  await start(T0).settle(PLACE);
  assert.deepEqual(fetched, [urlOf('lv')]);
  assert.ok(Object.values(store.getGifs().entries)[0].file);
});

test('repeated starts give every entry its vector over a library larger than the budget, never past it in one start', async () => {
  const kinds = [...many('dv', 60, 'dead-vector'), ...many('db', 40, 'dead-bare'), ...many('lb', 30, 'live-bare')];
  const { start, fetched, embedded, lacking } = library(kinds);
  for (let run = 0; run < 6; run += 1) {
    fetched.length = 0;
    embedded.length = 0;
    await start(T0 + run * MINUTE).settle(PLACE);
    const worked = new Set([
      ...fetched.map((url) => url.replace(/^.*\/|\.gif$/g, '')),
      ...embedded.map((text) => text.slice(6)),
    ]);
    assert.ok(worked.size <= 50, `start ${run} worked on ${worked.size} entries`);
  }
  assert.deepEqual(lacking(), []);
});

test('a start soon after a failed download does not fetch that file again', async () => {
  const { start, fetched, urlOf } = library([['dead', 'dead-bare']]);
  await start(T0).settle(PLACE);
  assert.deepEqual(fetched, [urlOf('dead')]);
  fetched.length = 0;
  await start(T0 + 60 * MINUTE).settle(PLACE);
  assert.deepEqual(fetched, []);
});

test('a start long after a failed download fetches that file again', async () => {
  const { start, fetched, urlOf } = library([['dead', 'dead-bare']]);
  await start(T0).settle(PLACE);
  fetched.length = 0;
  await start(T0 + 30 * 24 * 60 * MINUTE).settle(PLACE);
  assert.deepEqual(fetched, [urlOf('dead')]);
});
