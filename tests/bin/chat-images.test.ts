// bin/chat-images.ts: what the owner's chat makes of the core's answer about the files of a numbered line.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { join } from 'node:path';
import { lineFilesOf } from '../../bin/chat-images.ts';
import { rmSync, writeFileSync } from 'node:fs';
import { query, spawnCli, startUnitsCore, withRig } from '../fixtures/core-units.ts';
import { syntheticPng } from '../fixtures/synthetic-png.ts';
import { chainsOf } from '../fixtures/chains.ts';

const answerOf = (files: Array<{ name: string; kind: string; path: string | null; description: string | null }>) => ({
  text: JSON.stringify({ number: 7, files }),
  status: 'ok',
});

test('a kept path of a line becomes its path in the data folder, and a path outside the kept folder none', () => {
  // Bug: the opener gets a path relative to wherever the chat started, or a stored path that climbs out of `media/cli/`.
  const read = lineFilesOf(
    '/srv/data',
    answerOf([
      { name: 'clip.mp4', kind: 'video', path: 'media/cli/v1.mp4', description: 'A cat' },
      { name: 'odd', kind: 'file', path: '../etc/passwd', description: null },
      { name: 'lost.pdf', kind: 'file', path: null, description: null },
    ]),
    7
  );
  assert.equal(read.ok, true);
  assert.deepEqual(read.ok ? read.files.map((file) => file.path) : [], [
    path.join('/srv/data', 'media', 'cli', 'v1.mp4'),
    null,
    null,
  ]);
  const first = read.ok ? read.files[0] : undefined;
  assert.equal(first?.description, 'A cat');
});

test('an unknown line reads as a refusal that names its number', () => {
  // Bug: an unknown number reads as a line without files, or as a failure of the link.
  const read = lineFilesOf(
    '/srv/data',
    { text: 'refused: unknown-line', status: 'invalid', code: 'unknown-line' },
    9999
  );
  assert.deepEqual(read, { ok: false, reason: 'No line #9999 in this chat.' });
});

const VISION = { models: { routes: chainsOf({ vision: 'example/vision-model' }) } };

test('an invalid image is refused before anything reaches the core', async () => {
  // Bug: a text file named .png sends an empty image part and a turn over nothing.
  await withRig({ config: VISION }, async ({ dirs, llm, clis, cores }) => {
    cores.push(await startUnitsCore(dirs, llm));
    const file = join(dirs.root, 'not-an-image.png');
    writeFileSync(file, 'not-an-image');
    const cli = spawnCli(dirs, ['-p', 'Explain this chart.', '--attach', file]);
    clis.push(cli);
    const exit = await cli.exited;
    assert.notEqual(exit.code, 0);
    assert.notEqual(cli.stderr(), '', 'the failure is visible');
    assert.equal(
      cli.stderr().includes('neptunia doctor'),
      false,
      'the flag is understood: the refusal is the image, not the syntax'
    );
    assert.equal(llm.requests.length, 0);
    assert.deepEqual(query(dirs, 'SELECT text FROM sources WHERE text = ?', 'Explain this chart.'), []);
  });
});

test('a vanished file is refused the same way, with the caption unsent', async () => {
  // Bug: a file deleted between typing and sending goes out as a dangling attachment.
  await withRig({ config: VISION }, async ({ dirs, llm, clis, cores }) => {
    cores.push(await startUnitsCore(dirs, llm));
    const file = join(dirs.root, 'gone.png');
    writeFileSync(file, syntheticPng());
    rmSync(file);
    const cli = spawnCli(dirs, ['-p', 'Explain this chart.', '--attach', file]);
    clis.push(cli);
    assert.notEqual((await cli.exited).code, 0);
    assert.equal(
      cli.stderr().includes('neptunia doctor'),
      false,
      'the flag is understood: the refusal is the file, not the syntax'
    );
    assert.equal(llm.requests.length, 0);
  });
});
