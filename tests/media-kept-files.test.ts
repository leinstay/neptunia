// src/media/kept-files.ts: the files of the command line chat kept in the persona's data folder, the reference that
// names each one, the fetch that opens such a reference, and the line that tells the owner where a file lies.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createKeptFetch, keepFile, keptLocation, keptPathOf, openableLine } from '../src/media/kept-files.ts';

type Context = { after: (fn: () => void) => void };

const PNG = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 1, 2, 3]);
const OGG = Uint8Array.from([0x4f, 0x67, 0x67, 0x53, 9, 9, 9]);

function dataDir(t: Context): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'kept-files-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

const refused = (): Promise<Response> => Promise.reject(new Error('the network is not asked in this test'));

test('a kept picture is opened again by its reference after the process that kept it is gone', async (t) => {
  // Bug: a picture of the command line lives only in the staging folder and is gone a week later.
  const dir = dataDir(t);
  const kept = keepFile({ dataDir: dir, id: 'a1', bytes: PNG, name: 'kite.png', contentType: 'image/png' });
  const response = await createKeptFetch({ dataDir: dir, next: refused })(kept.reference);
  assert.equal(response.status, 200);
  assert.equal(response.headers.get('content-type'), 'image/png');
  assert.deepEqual(new Uint8Array(await response.arrayBuffer()), PNG);
});

test('the kept file lies under media/cli of the data folder', (t) => {
  // Bug: the copy lands outside the persona's data folder, so a backup of the folder misses it.
  const dir = dataDir(t);
  const kept = keepFile({ dataDir: dir, id: 'a2', bytes: OGG, name: 'voice.ogg', contentType: 'audio/ogg' });
  assert.equal(kept.path, 'media/cli/a2.ogg');
  assert.deepEqual(new Uint8Array(fs.readFileSync(path.join(dir, kept.path))), OGG);
});

test('a reference that climbs out of the kept folder names no file', (t) => {
  // Bug: a crafted reference reads any file of the data folder.
  const dir = dataDir(t);
  assert.equal(keptPathOf('neptunia-media:///media/cli/../../memory.db'), null);
  assert.equal(keptLocation(dir, 'neptunia-media:///media/selfreflection/x.png'), null);
});

test('a reference whose file was removed answers not found', async (t) => {
  // Bug: a missing copy throws inside the describer instead of reading as a miss.
  const dir = dataDir(t);
  const response = await createKeptFetch({ dataDir: dir, next: refused })('neptunia-media:///media/cli/gone.png');
  assert.equal(response.status, 404);
});

test('a file the terminal cannot show is named by the path the owner can open', (t) => {
  // Bug: a voice note she sends reads "not kept" and the owner has no way to hear it.
  const dir = dataDir(t);
  const kept = keepFile({ dataDir: dir, id: 'a3', bytes: OGG, name: 'voice.ogg', contentType: 'audio/ogg' });
  const line = openableLine(dir, { name: 'voice.ogg', data: OGG, url: kept.reference });
  const shown = line?.split(' ').at(-1) ?? '';
  assert.equal(shown, path.join(dir, 'media', 'cli', 'a3.ogg'));
  assert.ok(fs.existsSync(shown));
});

test('a file with no kept reference has no openable line', (t) => {
  assert.equal(openableLine(dataDir(t), { name: 'voice.ogg', data: OGG }), null);
});
