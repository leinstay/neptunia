// The cached file of a library GIF (src/media/gif-files.ts): the bytes under `media/gifs/`, named by their hash.
// Attachment links expire, so the file is the record. Plan 2026-11-04-cli-and-memory, stage B7.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { cacheGifFile } from '../src/media/gif-files.ts';
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
