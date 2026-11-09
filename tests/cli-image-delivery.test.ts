// An image from the command line to the real media consumer: `neptunia -p <caption> --attach <file>` as a child process
// over the real socket, the core in the test process, its real describer and image fetcher, and a scripted model. The
// bytes the vision request carries are what the file held. No chip and no wire round trip stands in for that.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ANSWER, query, spawnCli, startUnitsCore, until, withRig } from './fixtures/core-units.ts';
import { syntheticPng } from './fixtures/synthetic-png.ts';
import { chainsOf } from './fixtures/chains.ts';

const VISION = { models: { routes: chainsOf({ vision: 'example/vision-model' }) } };

const visionRequests = (llm: { requests: Array<unknown>; options: Array<unknown> }): Array<string> =>
  llm.requests.flatMap((request, index) =>
    (llm.options[index] as { role?: string } | null)?.role === 'vision' ? [JSON.stringify(request)] : []
  );

test('a caption with an image reaches her turn, and the vision request carries exactly the bytes of the file', async () => {
  // Bug: the chip says ready and the wire carries a reference no reader of the core can open.
  const png = syntheticPng(77);
  await withRig({ config: VISION }, async ({ dirs, llm, clis, cores }) => {
    cores.push(await startUnitsCore(dirs, llm));
    const file = join(dirs.root, 'chart $(example).png');
    writeFileSync(file, png);
    const cli = spawnCli(dirs, ['-p', 'Explain this chart.', '--attach', file]);
    clis.push(cli);
    await until(
      () => visionRequests(llm).some((request) => request.includes(png.toString('base64'))),
      () => `the vision request; stderr:\n${cli.stderr().slice(-1000)}`
    );
    assert.deepEqual(await cli.exited, { code: 0, signal: null });
    assert.ok(cli.stdout().includes(ANSWER), 'her reply is printed');
    const caption = query(dirs, 'SELECT text FROM sources WHERE text = ?', 'Explain this chart.');
    assert.equal(caption.length, 1, 'the caption is one stored line');
    const stored = JSON.stringify(query(dirs, 'SELECT * FROM sources'));
    assert.equal(
      stored.includes(png.toString('base64')),
      false,
      'memory keeps the identity of the image, not its bytes'
    );
  });
});

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
