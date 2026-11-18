// The media prefill of an observed line (src/pipeline/media-prefill.ts): when a message with a library GIF appears, the
// file of the GIF is downloaded once from its direct media address and kept on the library entry. Spec 2026-11-18, the
// library without the keeper. A real store over a temp folder, a fake download, no describer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createMediaPrefill } from '../src/pipeline/media-prefill.ts';
import { createStore } from '../src/memory/store.ts';
import { memDataDir } from './fixtures/store-kit.ts';
import type { GifBytes } from '../src/media/gif-files.ts';

const NOW = Date.parse('2026-11-18T12:00:00.000Z');
const PLACE = 'place:room-1';
const PAGE = 'https://gifs.example/view/cat-123';
const MEDIA = 'https://media.gifs.example/cat-123.mp4';
const ATTACHED = 'https://cdn.chat.example/attachments/1/a1/wave.gif';
const BYTES = new Uint8Array([71, 73, 70, 56, 57, 97, 4, 5]);

async function until(check: () => boolean): Promise<void> {
  for (let i = 0; i < 400 && !check(); i += 1) await new Promise((resolve) => setImmediate(resolve));
}

function rig() {
  const { dir, memoryDb } = memDataDir();
  const store = createStore({ dataDir: dir, memoryDb });
  const asked: Array<string> = [];
  const fetchBytes = (url: string): Promise<GifBytes> => {
    asked.push(url);
    return Promise.resolve({ bytes: BYTES, contentType: 'image/gif' });
  };
  const prefill = createMediaPrefill({
    hot: { config: {}, prompts: {} },
    describer: null,
    lookup: null,
    now: () => NOW,
    store,
    dataDir: dir,
    fetchBytes,
  } as unknown as Parameters<typeof createMediaPrefill>[0]);
  return { dir, store, asked, prefill };
}

const line = (fields: object) => ({
  id: 'm1',
  placeId: PLACE,
  ts: NOW,
  authorId: 'u1',
  attachments: [],
  links: [],
  ...fields,
});

/** The message as the handler sees it: the prefill starts first, and the memory updater counts the GIF in the same tick. */
function sighted(r: ReturnType<typeof rig>, message: ReturnType<typeof line>) {
  void r.prefill.warmMediaCache(PLACE, message);
  r.store.recordGifs(PLACE, [message]);
}

test('a message with a GIF embed downloads its file once from the animation address, never the page link', async () => {
  const r = rig();
  const embed = {
    id: 'm1#e0',
    kind: 'gif',
    site: 'Gifs',
    title: '',
    text: '',
    url: PAGE,
    thumbnailUrl: 'https://media.gifs.example/cat-123.png',
    animationUrl: MEDIA,
  };
  sighted(r, line({ links: [embed] }));
  await until(() => Object.values(r.store.getGifs().entries).some((entry) => entry.file));
  assert.deepEqual(r.asked, [MEDIA]);
  const [entry] = Object.values(r.store.getGifs().entries);
  assert.ok(entry.hash);
  assert.ok(entry.file && fs.existsSync(path.join(r.dir, entry.file)));
});

test("a message with an attached GIF downloads its file from the attachment's own address", async () => {
  const r = rig();
  const attachment = { id: 'a1', kind: 'gif', name: 'wave.gif', url: ATTACHED, contentType: 'image/gif' };
  sighted(r, line({ attachments: [attachment] }));
  await until(() => Object.values(r.store.getGifs().entries).some((entry) => entry.file));
  assert.deepEqual(r.asked, [ATTACHED]);
  assert.ok(Object.values(r.store.getGifs().entries)[0].file);
});
