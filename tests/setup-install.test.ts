// src/setup/install.ts#applyModeToUnit: `subharness mode` renders the one unit again and reloads it through the injected
// runner. The units are rendered from the real templates of deploy/ into a temp folder; no systemctl runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { applyModeToUnit, deferModeToUnit, installUnits, unitText } from '../src/setup/install.ts';
import type { RunResult, UnitTarget } from '../src/setup/install.ts';
import { setAgentMode } from '../src/subharness/control.ts';
import { writeKeysFile } from './fixtures/keys-file.ts';
import { tempDir } from './fixtures/tmp.ts';
import { fileURLToPath } from 'node:url';

const ROOT = path.join(import.meta.dirname, '..');

function rig() {
  const base = tempDir('nep-install-');
  const unitDir = path.join(base, 'units');
  fs.mkdirSync(unitDir);
  // Setup's internal private alias selects the same canonical persona root as dataDir.
  const privateDir = path.join(base, 'data');
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
  assert.equal(await applyModeToUnit(target, run, 'nobody'), null);
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

test('the units take the backend from keys.json, and the core names no home of the user for it', async () => {
  // Catches: the core unit names ~/.claude from the stored backend, a folder that may not exist, and fails to start.
  // Changed for spec 2026-11-02 PR 5: the backend lives in <private>/subharness/<backend>/, which the core writes
  // through its private folder; the agent units' bind of it is the test on the scout unit below.
  const { target, run, unitDir, privateDir } = rig();
  writeKeysFile(privateDir, { subharness: { backend: 'claude', key: null, modes: {} } });
  const done = await installUnits(target, run, ['neptunia-core.service']);
  assert.equal(done.ok, true);
  const text = fs.readFileSync(path.join(unitDir, 'neptunia-core.service'), 'utf8');
  const writable = text
    .split('\n')
    .filter((line) => line.startsWith('ReadWritePaths='))
    .flatMap((line) => line.slice('ReadWritePaths='.length).split(/\s+/))
    .map((one) => one.replace(/^-/, ''));
  assert.equal(writable.includes(path.join(target.home, '.claude')), false);
  assert.ok(writable.includes(privateDir), writable.join(' '));
});

// `subharness mode` inside the core (spec 2026-11-02, follow-up 8): the core runs under NoNewPrivileges, so it never
// tries sudo; it stores the mode and answers that `neptunia setup units` puts it into the unit.

test('inside the core a mode change names neptunia setup for an agent with a unit, and runs nothing', () => {
  // Catches: the core answers a stored mode as if its unit were updated, so the owner never re-renders it.
  // Changed: the step word left the public command, and the one flow re-renders the units.
  for (const agent of ['scout', 'server']) assert.ok(deferModeToUnit(agent)?.includes('neptunia setup'), agent);
});

test('inside the core an agent with no unit, or no agent, gets no unit line', () => {
  // Catches: dev, which runs in no unit of its own, is told to re-render a unit that does not exist.
  // Changed: the watcher runs inside the core's unit (owner, 2026-11-09), so its mode needs no unit rendered.
  assert.equal(deferModeToUnit('watcher'), null);
  // dev now has a unit of its own, so a mode change names it.
  assert.equal(
    deferModeToUnit('dev'),
    'neptunia-development.service takes the mode when you run "neptunia setup" in a shell'
  );
  assert.equal(deferModeToUnit('nobody'), null);
});

test("the units take the backend from keys.json, so the agent units bind that backend's folder in her private layer", async () => {
  // Catches: installUnits renders the agent units without the stored backend, and scout keeps no write access to codex.
  const { target, run, unitDir, privateDir } = rig();
  writeKeysFile(privateDir, { subharness: { backend: 'codex', key: null, modes: {} } });
  const done = await installUnits(target, run, ['neptunia-agent-scout.service']);
  assert.equal(done.ok, true);
  const text = fs.readFileSync(path.join(unitDir, 'neptunia-agent-scout.service'), 'utf8');
  const writable = text
    .split('\n')
    .filter((line) => line.startsWith('ReadWritePaths=') || line.startsWith('BindPaths='))
    .flatMap((line) => line.slice(line.indexOf('=') + 1).split(/\s+/))
    .map((one) => one.replace(/^-/, ''));
  assert.ok(writable.includes(path.join(privateDir, 'subharness', 'codex')), writable.join(' '));
});

// The units of the agents that follow a mode (src/setup/install.ts#unitText over src/setup/units.ts): `NoNewPrivileges=yes`
// stays in `read`, `write` and `full`, and only `sudo` drops it. The renderer can already do that for any template, but
// the development unit is not on `UNIT_AGENTS`, so it renders the default mode whatever the owner set for `dev`.

const DEPLOY = path.join(fileURLToPath(new URL('..', import.meta.url)), 'deploy');
const UNITS = [
  ['neptunia-development.service', 'dev'],
  ['neptunia-agent-scout.service', 'scout'],
  ['neptunia-agent-server.service', 'server'],
] as const;

function rendered(file: string, agent: string, mode: string): string {
  const dataDir = tempDir('nep-unit-modes-');
  writeKeysFile(dataDir, { subharness: { backends: [], key: null, modes: { [agent]: mode }, models: {}, uses: {} } });
  const target = {
    user: 'alice',
    group: 'alice',
    home: '/home/alice',
    rootDir: '/srv/engine',
    privateDir: dataDir,
    dataDir,
    node: '/home/alice/.nvm/bin/node',
    developmentCheckout: '/srv/checkout',
    system: false,
  };
  return unitText(target, fs.readFileSync(path.join(DEPLOY, file), 'utf8'), file);
}

const hasGuard = (text: string): boolean => /^NoNewPrivileges=yes$/m.test(text);

test('the units keep NoNewPrivileges in read, write and full, and only sudo drops it', () => {
  // Bug: the guard goes with `full`, which should give up the mount sandbox and nothing else, or stays under `sudo`.
  for (const [file, agent] of UNITS) {
    const guarded = ['read', 'write', 'full', 'sudo'].map((mode) => [mode, hasGuard(rendered(file, agent, mode))]);
    assert.deepEqual(
      guarded,
      [
        ['read', true],
        ['write', true],
        ['full', true],
        ['sudo', false],
      ],
      file
    );
  }
});
