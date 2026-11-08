// src/media/staging.ts: an image kept for the core's URL-based readers until it is consumed, in a disposable folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createImageFetcher } from '../src/media/fetch-image.ts';
import { createImageStaging } from '../src/media/staging.ts';
import { syntheticPng } from './fixtures/synthetic-png.ts';
import { tempDir } from './fixtures/tmp.ts';

const FETCH = { maxBytes: 1_000_000, timeoutMs: 1000 };

function rig(over: { ttlMs?: number; maxBytes?: number } = {}) {
  const dir = tempDir('nep-staging-');
  let clock = 1000;
  let serial = 0;
  const staging = createImageStaging({
    dir,
    now: () => clock,
    newId: () => `id${(serial += 1)}`,
    ttlMs: over.ttlMs ?? 60_000,
    maxBytes: over.maxBytes ?? 1_000_000,
  });
  return { dir, staging, advance: (ms: number) => (clock += ms) };
}

const stagedOf = async (result: ReturnType<ReturnType<typeof rig>['staging']['stageBytes']>) => {
  const answer = await result;
  // The narrowing to the ok branch made `answer.code` below a type error; the code is the fact that matters.
  if (!answer.ok) throw new Error(answer.code);
  return answer.staged;
};

test('the real image fetcher reads exactly the staged bytes through the reference', async () => {
  // Bug: staging hands out a path or a scheme the URL-based media readers cannot open.
  const { staging } = rig();
  const png = syntheticPng(10);
  const staged = await stagedOf(staging.stageBytes(png, { name: 'chart.png' }));
  const fetched = await createImageFetcher({ fetchImpl: staging.fetch }).fetchAsDataUrl(staged.reference, FETCH);
  assert.equal(fetched?.dataUrl, `data:image/png;base64,${png.toString('base64')}`);
});

test('the content type comes from the bytes, whatever the name claims', async () => {
  // Bug: a PNG named .jpg is declared a JPEG and the provider refuses the request.
  const { staging } = rig();
  const staged = await stagedOf(staging.stageBytes(syntheticPng(), { name: 'photo.jpg' }));
  assert.equal(staged.contentType, 'image/png');
});

test('bytes that are no image, and no bytes at all, are refused with nothing kept', async () => {
  // Bug: an empty or text attachment is staged and fails only after the turn started.
  const { staging, dir } = rig();
  const invalid = await staging.stageBytes(Buffer.from('not-an-image'), { name: 'x.png' });
  const empty = await staging.stageBytes(Buffer.alloc(0), { name: 'y.png' });
  assert.deepEqual([invalid.ok, empty.ok], [false, false]);
  if (!invalid.ok) assert.equal(invalid.code, 'invalid-image');
  assert.deepEqual(fs.readdirSync(dir), []);
});

test('an image over the limit is refused, one at the limit is kept', async () => {
  // Bug: an off-by-one lets a picture through that the reader then drops, or refuses one it could read.
  const png = syntheticPng();
  const { staging } = rig({ maxBytes: png.length });
  assert.equal((await staging.stageBytes(png, { name: 'a.png' })).ok, true);
  const padded = Buffer.concat([png, Buffer.alloc(1)]);
  const over = await staging.stageBytes(padded, { name: 'b.png' });
  assert.equal(over.ok, false);
  if (!over.ok) assert.equal(over.code, 'too-large');
});

test('a file is read once at staging, so deleting the original afterwards changes nothing', async () => {
  // Bug: the reference points at the owner's file, which is gone or edited when the core reads it.
  const { staging } = rig();
  const source = path.join(tempDir('nep-staging-source-'), 'chart $(example).png');
  const png = syntheticPng(20);
  fs.writeFileSync(source, png);
  const answer = await staging.stageFile(source);
  assert.equal(answer.ok, true);
  if (!answer.ok) return;
  assert.equal(answer.staged.name, 'chart $(example).png');
  fs.rmSync(source);
  assert.deepEqual(await staging.read(answer.staged.id), new Uint8Array(png));
});

test('a vanished file answers vanished', async () => {
  // Bug: a missing path throws out of the chat, or stages nothing and reports ready.
  const { staging } = rig();
  const answer = await staging.stageFile(path.join(tempDir('nep-staging-source-'), 'gone.png'));
  assert.equal(answer.ok, false);
  if (!answer.ok) assert.equal(answer.code, 'vanished');
});

test('a hostile name stays a name: nothing is written outside the folder', async () => {
  // Bug: `../../x.png` escapes the staging folder, or the reference exposes the owner's paths.
  const { staging, dir } = rig();
  const staged = await stagedOf(staging.stageBytes(syntheticPng(), { name: '../../escape.png' }));
  assert.equal(staged.name, '../../escape.png');
  assert.equal(fs.existsSync(path.join(dir, '..', '..', 'escape.png')), false);
  assert.equal(staged.reference.includes(dir), false);
});

test('a staged image survives a sweep inside its lifetime and a repeated read, and goes after it', async () => {
  // Bug: the sweep removes an image before its turn reads it, or a retried read finds nothing, or staging grows forever.
  const { staging, advance } = rig({ ttlMs: 1000 });
  const png = syntheticPng(30);
  const staged = await stagedOf(staging.stageBytes(png, { name: 'a.png' }));
  advance(999);
  assert.equal(await staging.sweep(), 0);
  assert.deepEqual(await staging.read(staged.id), new Uint8Array(png));
  assert.deepEqual(await staging.read(staged.id), new Uint8Array(png));
  advance(2);
  assert.equal(await staging.sweep(), 1);
  assert.equal(await staging.read(staged.id), null);
});

test('release removes one image and leaves the other', async () => {
  // Bug: removing an attachment from a draft keeps its bytes, or removes its neighbour.
  const { staging } = rig();
  const one = await stagedOf(staging.stageBytes(syntheticPng(40), { name: 'a.png' }));
  const two = await stagedOf(staging.stageBytes(syntheticPng(41), { name: 'b.png' }));
  await staging.release(one.id);
  assert.equal(await staging.read(one.id), null);
  assert.ok((await staging.read(two.id))?.byteLength);
  await staging.release('unknown');
});

test('an unknown or released reference answers 404 through the fetch, never a throw', async () => {
  // Bug: the describer dies on a released image instead of caching a miss.
  const { staging } = rig();
  const staged = await stagedOf(staging.stageBytes(syntheticPng(), { name: 'a.png' }));
  await staging.release(staged.id);
  const answer = await staging.fetch(staged.reference);
  assert.equal(answer.status, 404);
});

test('the staging folder and its files are private', async () => {
  // Bug: another user of the server reads what the owner attached.
  const { staging, dir } = rig();
  await stagedOf(staging.stageBytes(syntheticPng(), { name: 'a.png' }));
  assert.equal(fs.statSync(dir).mode & 0o777, 0o700);
  for (const name of fs.readdirSync(dir)) assert.equal(fs.statSync(path.join(dir, name)).mode & 0o777, 0o600);
});

test('a file of any kind is staged for the command line, typed by its name when its bytes are no image', async () => {
  // Bug: the owner can attach only pictures, so a voice note or a document never reaches her.
  const { dir, staging } = rig();
  const file = path.join(dir, '..', `voice-${process.pid}.ogg`);
  fs.writeFileSync(file, Uint8Array.from([0x4f, 0x67, 0x67, 0x53, 1, 2]));
  try {
    const answer = await staging.stageAttachment(file);
    if (!answer.ok) throw new Error(answer.code);
    assert.deepEqual([answer.staged.name, answer.staged.contentType], [`voice-${process.pid}.ogg`, 'audio/ogg']);
    assert.deepEqual(await staging.read(answer.staged.id), Uint8Array.from([0x4f, 0x67, 0x67, 0x53, 1, 2]));
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('a picture staged as an attachment keeps the type its bytes declare', async () => {
  const { dir, staging } = rig();
  const file = path.join(dir, '..', `named-${process.pid}.txt`);
  fs.writeFileSync(file, syntheticPng());
  try {
    const answer = await staging.stageAttachment(file);
    if (!answer.ok) throw new Error(answer.code);
    assert.equal(answer.staged.contentType, 'image/png');
  } finally {
    fs.rmSync(file, { force: true });
  }
});

test('a file whose name claims a picture its bytes are not is refused as an attachment', async () => {
  // Bug: a text file named .png reaches the core as a picture, and the describer reads nothing.
  const { dir, staging } = rig();
  const file = path.join(dir, '..', `fake-${process.pid}.png`);
  fs.writeFileSync(file, 'not-an-image');
  try {
    const answer = await staging.stageAttachment(file);
    assert.equal(answer.ok ? 'staged' : answer.code, 'invalid-image');
  } finally {
    fs.rmSync(file, { force: true });
  }
});
