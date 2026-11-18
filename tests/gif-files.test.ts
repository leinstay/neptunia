// The cached file of a library GIF (src/media/gif-files.ts): the bytes under `media/gifs/`, named by their hash.
// Attachment links expire, so the file is the record. Plan 2026-11-04-cli-and-memory, stage B7.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { cacheGifFile, fileGifs } from '../src/media/gif-files.ts';
import type { GifBytes } from '../src/media/gif-files.ts';
import { createStore } from '../src/memory/store.ts';
import { memDataDir } from './fixtures/store-kit.ts';
import { tempDir } from './fixtures/tmp.ts';

const BYTES = new Uint8Array([71, 73, 70, 56, 57, 97, 1, 2, 3]);
const URL_ONE = 'https://cdn.example/one.gif';
const SHA = createHash('sha256').update(BYTES).digest('hex');
const fetched = () => Promise.resolve({ bytes: BYTES, contentType: 'image/gif' });

test('the bytes are written under media/gifs and the hash names them', async () => {
  const dataDir = tempDir('nep-gif-files-');
  const cached = await cacheGifFile({ url: URL_ONE, dataDir, fetchBytes: fetched });
  assert.ok(cached);
  assert.equal(cached.hash, SHA);
  assert.ok(cached.file.startsWith('media/gifs/'), cached.file);
  assert.deepEqual(new Uint8Array(fs.readFileSync(path.join(dataDir, cached.file))), BYTES);
});

test('the same bytes from another link are one file', async () => {
  const dataDir = tempDir('nep-gif-files-');
  const one = await cacheGifFile({ url: URL_ONE, dataDir, fetchBytes: fetched });
  const two = await cacheGifFile({ url: 'https://cdn.example/two.gif', dataDir, fetchBytes: fetched });
  assert.deepEqual(two, one);
  assert.equal(fs.readdirSync(path.join(dataDir, 'media', 'gifs')).length, 1);
});

test('a failed fetch answers null and writes nothing', async () => {
  const dataDir = tempDir('nep-gif-files-');
  const answers = await Promise.all([
    cacheGifFile({ url: URL_ONE, dataDir, fetchBytes: () => Promise.reject(new Error('http-404')) }),
    cacheGifFile({ url: URL_ONE, dataDir, fetchBytes: () => Promise.resolve(null) }),
    cacheGifFile({ url: URL_ONE, dataDir, fetchBytes: () => Promise.resolve({ bytes: new Uint8Array() }) }),
  ]);
  assert.deepEqual(answers, [null, null, null]);
  const folder = path.join(dataDir, 'media', 'gifs');
  assert.equal(fs.existsSync(folder) ? fs.readdirSync(folder).length : 0, 0);
});

// Spec 2026-11-18, the library without the keeper: the file of a library GIF is downloaded once, from the direct media
// address stored on its entry (`fileUrl`), never from the page link. A real store over a temp folder, a fake download.

const PAGE = 'https://gifs.example/view/cat-123';
const MEDIA = 'https://media.gifs.example/cat-123.mp4';
const PLACE = 'place:room-1';

function libraryRig(animationUrl: string | null = MEDIA) {
  const { dir, memoryDb } = memDataDir();
  const store = createStore({ dataDir: dir, memoryDb });
  const link = {
    id: 'm1#e0',
    kind: 'gif',
    site: 'Gifs',
    title: '',
    text: '',
    url: PAGE,
    thumbnailUrl: 'https://media.gifs.example/cat-123.png',
    ...(animationUrl ? { animationUrl } : {}),
  };
  store.recordGifs(PLACE, [{ id: 'm1', placeId: PLACE, ts: 1, attachments: [], links: [link] }]);
  const asked: Array<string> = [];
  const answering =
    (answer: () => Promise<GifBytes>) =>
    (url: string): Promise<GifBytes> => {
      asked.push(url);
      return answer();
    };
  return { dir, store, asked, answering };
}

const onlyEntry = (store: ReturnType<typeof createStore>) => Object.values(store.getGifs().entries)[0];

test('a library GIF is downloaded from its stored media address, never its page link, and gets its file and hash', async () => {
  const { dir, store, asked, answering } = libraryRig();
  await fileGifs({ store, dataDir: dir, fetchBytes: answering(fetched), itemIds: ['m1#e0'] });
  assert.deepEqual(asked, [MEDIA]);
  const entry = onlyEntry(store);
  assert.equal(entry.hash, SHA);
  assert.ok(entry.file && fs.existsSync(path.join(dir, entry.file)));
  assert.equal(entry.fileUrl, MEDIA);
});

test('a library GIF with no stored media address downloads nothing', async () => {
  const { dir, store, asked, answering } = libraryRig(null);
  await fileGifs({ store, dataDir: dir, fetchBytes: answering(fetched), itemIds: ['m1#e0'] });
  assert.deepEqual(asked, []);
  assert.equal(onlyEntry(store).file, undefined);
});

test('a failed download leaves the media address and no file, and the next sighting tries the address again', async () => {
  const { dir, store, asked, answering } = libraryRig();
  await fileGifs({
    store,
    dataDir: dir,
    fetchBytes: answering(() => Promise.reject(new Error('http-503'))),
    itemIds: ['m1#e0'],
  });
  assert.equal(onlyEntry(store).file, undefined);
  assert.equal(onlyEntry(store).fileUrl, MEDIA);
  await fileGifs({ store, dataDir: dir, fetchBytes: answering(fetched), itemIds: ['m1#e0'] });
  assert.deepEqual(asked, [MEDIA, MEDIA]);
  assert.equal(onlyEntry(store).hash, SHA);
});

test('a sighting of a library GIF that has its file downloads nothing', async () => {
  const { dir, store, asked, answering } = libraryRig();
  await fileGifs({ store, dataDir: dir, fetchBytes: answering(fetched), itemIds: ['m1#e0'] });
  await fileGifs({ store, dataDir: dir, fetchBytes: answering(fetched), itemIds: ['m1#e0'] });
  assert.deepEqual(asked, [MEDIA]);
});
