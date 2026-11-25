// The compile cache of the `neptunia` command's entry (bin/neptunia-launch.ts): the entry sets `NODE_COMPILE_CACHE`
// when it is unset, before the engine is loaded, and keeps one that is set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from '../fixtures/tmp.ts';

const ROOT = path.join(import.meta.dirname, '..', '..');

/** Runs the `neptunia` entry with a word it refuses, which loads the engine and exits 2 without reaching a core. */
function launch(env: Record<string, string>): number | null {
  const run = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'neptunia-launch.ts'), 'no-such-word'], {
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', ...env },
    encoding: 'utf8',
    timeout: 60_000,
  });
  return run.status;
}

const filled = (dir: string): boolean => fs.existsSync(dir) && fs.readdirSync(dir).length > 0;

test('the neptunia entry puts the compile cache in the user cache folder when no cache is named', () => {
  // Catches: a command of the owner that compiles every module afresh because nothing names a cache.
  const home = tempDir('nep-launch-home-');
  assert.equal(launch({ HOME: home }), 2);
  assert.equal(filled(path.join(home, '.cache', 'neptunia-compile')), true);
});

test('the neptunia entry keeps a compile cache that is named already', () => {
  // Catches: the unit's cache folder replaced by the home's, which ProtectHome=tmpfs throws away at every start.
  const home = tempDir('nep-launch-home-');
  const named = tempDir('nep-launch-cache-');
  assert.equal(launch({ HOME: home, NODE_COMPILE_CACHE: named }), 2);
  assert.equal(filled(named), true);
  assert.equal(fs.existsSync(path.join(home, '.cache', 'neptunia-compile')), false);
});
