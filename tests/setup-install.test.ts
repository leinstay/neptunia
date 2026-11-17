// src/setup/install.ts: the units and what `subharness mode` answers about them. The units are rendered from the real
// templates of deploy/ into a temp folder through the injected runner; no systemctl runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { deferModeToUnit, installUnits, removeRetiredUnits, unitText } from '../src/setup/install.ts';
import type { RunResult, UnitTarget } from '../src/setup/install.ts';
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

test('inside the core a mode change names neptunia setup for the unit, and runs nothing', () => {
  // Catches: the core answers a stored mode as if its unit were updated, so the owner never re-renders it.
  // Changed: a mode belongs to a unit, so every unit has a line and no name goes without one.
  for (const unit of ['web', 'host'] as const) assert.ok(deferModeToUnit(unit).includes('neptunia setup'), unit);
});

test('setup stops, disables and removes the per-agent units it finds, and leaves a folder without them alone', async () => {
  // Bug: an upgraded install keeps running the old scout runner beside the web runner, on a socket nothing reads.
  const { target, run, calls, unitDir } = rig();
  fs.writeFileSync(path.join(unitDir, 'neptunia-agent-scout.service'), '[Unit]\n');
  const done = await removeRetiredUnits(target, run);
  assert.deepEqual(done, { ok: true, removed: ['neptunia-agent-scout.service'] });
  assert.equal(fs.existsSync(path.join(unitDir, 'neptunia-agent-scout.service')), false);
  assert.deepEqual(calls, [
    'systemctl --user disable --now neptunia-agent-scout.service',
    'systemctl --user daemon-reload',
  ]);
  calls.length = 0;
  assert.deepEqual(await removeRetiredUnits(target, run), { ok: true, removed: [] });
  assert.deepEqual(calls, []);
});

test("the units take the backend from keys.json, so the agent units bind that backend's folder in her private layer", async () => {
  // Catches: installUnits renders the agent units without the stored backend, and scout keeps no write access to codex.
  const { target, run, unitDir, privateDir } = rig();
  writeKeysFile(privateDir, { subharness: { backend: 'codex', key: null, modes: {} } });
  const done = await installUnits(target, run, ['neptunia-agent-web.service']);
  assert.equal(done.ok, true);
  const text = fs.readFileSync(path.join(unitDir, 'neptunia-agent-web.service'), 'utf8');
  const writable = text
    .split('\n')
    .filter((line) => line.startsWith('ReadWritePaths=') || line.startsWith('BindPaths='))
    .flatMap((line) => line.slice(line.indexOf('=') + 1).split(/\s+/))
    .map((one) => one.replace(/^-/, ''));
  assert.ok(writable.includes(path.join(privateDir, 'subharness', 'codex')), writable.join(' '));
});

// The units of the agents that follow a mode (src/setup/install.ts#unitText over src/setup/units.ts): `NoNewPrivileges=yes`
// stays in `read`, `write` and `full`, and only `sudo` drops it.

const DEPLOY = path.join(fileURLToPath(new URL('..', import.meta.url)), 'deploy');
// Changed: the development unit and the agent `dev` are gone (maintainer, 2026-11-16).
// Changed: a mode belongs to a unit, so the store names the unit.
const UNITS = [
  ['neptunia-agent-web.service', 'web'],
  ['neptunia-agent-host.service', 'host'],
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
