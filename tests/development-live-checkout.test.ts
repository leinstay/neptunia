// The run-time half of the live-checkout guard (src/development/edges.ts, docs/selfimprovement.md): setup refuses the folder
// the running engine was started from as the development checkout, and the worker refuses it again when it is built, so a
// config edited by hand cannot send the executor's branches, worktrees and test runs into the live persona's code. The
// folder is compared by real path, so a symlink does not help, and `liveDir` is the engine's own root unless a test names
// another. Temp folders only. Each test names the bug it catches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { developmentEdges } from '../src/development/edges.ts';
import { tempDir } from './fixtures/tmp.ts';

const ENGINE_ROOT = fs.realpathSync(path.join(import.meta.dirname, '..'));

function build(checkout: string, liveDir?: string): ReturnType<typeof developmentEdges> {
  const data = tempDir('nep-live-data-');
  return developmentEdges({
    checkout,
    ...(liveDir === undefined ? {} : { liveDir }),
    privateDir: data,
    dataDir: data,
    env: { PATH: '/usr/bin:/bin' },
    denyDir: path.join(tempDir('nep-live-deny-'), 'nosudo'),
    tmpDir: os.tmpdir(),
  });
}

test('the worker refuses a checkout that is the live folder and proposes the sibling', () => {
  // Catches: a hand-edited selfimprovement.checkout aims the executor at the folder the engine reads her code from.
  const live = fs.realpathSync(tempDir('nep-live-'));
  assert.throws(
    () => build(live, live),
    (error: Error) => error.message.includes(`${live}-dev`)
  );
});

test('the worker refuses a symlink to the live folder', () => {
  // Catches: the run-time guard compares strings, and a link to the live checkout walks past it.
  const live = fs.realpathSync(tempDir('nep-live-'));
  const link = path.join(tempDir('nep-live-link-'), 'elsewhere');
  fs.symlinkSync(live, link);
  assert.throws(
    () => build(link, live),
    (error: Error) => error.message.includes(`${live}-dev`)
  );
});

test('the live folder defaults to the root of the engine that is running, so a checkout of that root is refused', () => {
  // Catches: the guard needs a setting nobody passes, and the default lets the engine's own folder through.
  assert.throws(
    () => build(ENGINE_ROOT),
    (error: Error) => error.message.includes(`${ENGINE_ROOT}-dev`)
  );
});

test('a folder beside the live one builds', () => {
  // Catches: the guard refuses the proposed sibling, or every checkout that shares a name prefix with the live folder.
  const parent = fs.realpathSync(tempDir('nep-live-parent-'));
  const live = path.join(parent, 'engine');
  const sibling = path.join(parent, 'engine-dev');
  fs.mkdirSync(live);
  fs.mkdirSync(sibling);
  assert.equal(build(sibling, live).repoDir, sibling);
});
