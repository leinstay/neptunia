// Node's compile cache for the engine's processes (owner's approval, 2026-11-08): every Node process strips the types of
// about 800 engine modules afresh, about 0.4 s of a `neptunia -p`, unless `NODE_COMPILE_CACHE` names a folder it may
// write. The units `neptunia setup` renders get a systemd cache folder and the variable that names it. The `neptunia`
// command's entry sets the variable when it is unset, before the engine is loaded, and keeps one that is set.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { UNIT_FILES, renderUnit } from '../src/setup/units.ts';
import type { UnitVars } from '../src/setup/units.ts';
import { tempDir } from './fixtures/tmp.ts';

const ROOT = path.join(import.meta.dirname, '..');
const VARS: UnitVars = {
  user: 'alice',
  group: 'alice',
  home: '/home/alice',
  rootDir: '/srv/engine',
  privateDir: '/srv/engine-data',
  dataDir: '/srv/engine-data',
  node: '/usr/bin/node',
};
const SERVICES = UNIT_FILES.filter((name) => name.endsWith('.service'));

const rendered = (name: string, scope: 'user' | 'system', mode?: UnitVars['mode']): Array<string> =>
  renderUnit(fs.readFileSync(path.join(ROOT, 'deploy', name), 'utf8'), scope, { ...VARS, ...(mode ? { mode } : {}) })
    .split('\n')
    .map((line) => line.trim());

for (const scope of ['user', 'system'] as const)
  test(`every ${scope} service names a compile cache in the cache folder systemd makes writable for it`, () => {
    // Catches: a cache path the sandbox (ProtectSystem=strict, ProtectHome=tmpfs) keeps read-only, so Node silently
    // compiles every module again at each start.
    for (const name of SERVICES) {
      const lines = rendered(name, scope);
      assert.ok(lines.includes('CacheDirectory=neptunia-compile'), `${name}: ${lines.join(' | ')}`);
      assert.ok(lines.includes('Environment=NODE_COMPILE_CACHE=%C/neptunia-compile'), name);
    }
  });

test('an agent unit keeps its compile cache in the modes that drop the mount sandbox', () => {
  // Catches: the cache dropped with the sandbox lines, so a full or sudo agent starts slower than a read one.
  for (const mode of ['full', 'sudo'] as const) {
    const lines = rendered('neptunia-agent-server.service', 'system', mode);
    assert.ok(lines.includes('Environment=NODE_COMPILE_CACHE=%C/neptunia-compile'), mode);
  }
});

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
  // Catches: an owner's command that compiles every module afresh because nothing names a cache.
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
