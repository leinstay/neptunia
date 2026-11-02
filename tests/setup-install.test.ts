// src/setup/install.ts#applyModeToUnit: `subharness mode` renders the one unit again and reloads it through the injected
// runner. The units are rendered from the real templates of deploy/ into a temp folder; no systemctl runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { applyModeToUnit } from '../src/setup/install.ts';
import type { RunResult, UnitTarget } from '../src/setup/install.ts';
import { setAgentMode } from '../src/subharness/control.ts';
import { writeKeysFile } from './fixtures/keys-file.ts';
import { tempDir } from './fixtures/tmp.ts';

const ROOT = path.join(import.meta.dirname, '..');

function rig() {
  const base = tempDir('nep-install-');
  const unitDir = path.join(base, 'units');
  fs.mkdirSync(unitDir);
  const privateDir = path.join(base, 'private');
  writeKeysFile(privateDir);
  const target: UnitTarget = {
    system: false,
    user: 'alice',
    group: 'alice',
    home: path.join(base, 'home'),
    rootDir: ROOT,
    privateDir,
    dataDir: path.join(base, 'data'),
    node: '/usr/bin/node',
    unitDir,
  };
  const calls: Array<string> = [];
  const run = (command: string, args: ReadonlyArray<string>): Promise<RunResult> => {
    calls.push([command, ...args].join(' '));
    return Promise.resolve({ code: 0, stdout: '', stderr: '' });
  };
  return { target, run, calls, unitDir, privateDir };
}

test('an agent with no unit of its own is left alone', async () => {
  // Bug: dev gets a unit file written that nothing starts.
  const { target, run, calls } = rig();
  assert.equal(await applyModeToUnit(target, run, 'dev'), null);
  assert.deepEqual(calls, []);
});

test('a unit that is not installed is not written, and the answer says the mode holds from the next run', async () => {
  // Bug: a mode change creates unit files on a machine that never installed them.
  const { target, run, calls, unitDir } = rig();
  const line = await applyModeToUnit(target, run, 'scout');
  assert.ok(line?.includes('not installed'));
  assert.deepEqual(calls, []);
  assert.deepEqual(fs.readdirSync(unitDir), []);
});

test('an installed unit is rendered again for the new mode, the manager reloads and the unit restarts if it runs', async () => {
  // Bug: the mode is stored and the unit keeps NoNewPrivileges, so sudo mode cannot use sudo.
  const { target, run, calls, unitDir, privateDir } = rig();
  const file = path.join(unitDir, 'neptunia-agent-scout.service');
  fs.writeFileSync(file, 'old');
  await setAgentMode(privateDir, 'scout', 'sudo');
  await applyModeToUnit(target, run, 'scout');
  assert.equal(/^NoNewPrivileges=/m.test(fs.readFileSync(file, 'utf8')), false);
  assert.deepEqual(calls, [
    'systemctl --user daemon-reload',
    'systemctl --user try-restart neptunia-agent-scout.service',
  ]);
});
