// src/setup/install.ts: the units and what `subharness mode` answers about them. The units are rendered from the real
// templates of deploy/ into a temp folder through the injected runner; no systemctl runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { deferModeToUnit, installUnits, removeRetiredUnits, unitText } from '../../../src/setup/install.ts';
import type { RunResult, UnitTarget } from '../../../src/setup/install.ts';
import { writeKeysFile } from '../../fixtures/keys-file.ts';
import type { KeysFile } from '../../fixtures/keys-file.ts';
import { tempDir } from '../../fixtures/tmp.ts';
import { fileURLToPath } from 'node:url';
import { subharnessPlace } from '../../../src/subharness/place.ts';

const ROOT = path.join(import.meta.dirname, '..', '..', '..');

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
  // The backend lives in <private>/subharness/<backend>/, which the core writes
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

// `subharness mode` inside the core: the core runs under NoNewPrivileges, so it never
// tries sudo; it stores the mode and answers that `neptunia setup units` puts it into the unit.

test('inside the core a mode change names neptunia setup for the unit, and runs nothing', () => {
  // Catches: the core answers a stored mode as if its unit were updated, so the owner never re-renders it.
  // A mode belongs to a unit, so every unit has a line and no name goes without one.
  for (const unit of ['server', 'scout', 'code'] as const)
    assert.ok(deferModeToUnit(unit).includes('neptunia setup'), unit);
});

test('setup stops, disables and removes the shared agent units it finds, and leaves a folder without them alone', async () => {
  // Bug: an upgraded install keeps running the old web runner beside the scout runner, on a socket nothing reads.
  // The retired units are the shared ones, `web` and `host`.
  const { target, run, calls, unitDir } = rig();
  fs.writeFileSync(path.join(unitDir, 'neptunia-agent-web.service'), '[Unit]\n');
  const done = await removeRetiredUnits(target, run);
  assert.deepEqual(done, { ok: true, removed: ['neptunia-agent-web.service'] });
  assert.equal(fs.existsSync(path.join(unitDir, 'neptunia-agent-scout.service')), false);
  assert.deepEqual(calls, [
    'systemctl --user disable --now neptunia-agent-web.service',
    'systemctl --user daemon-reload',
  ]);
  calls.length = 0;
  assert.deepEqual(await removeRetiredUnits(target, run), { ok: true, removed: [] });
  assert.deepEqual(calls, []);
});

test("the units take the backend from keys.json, so the agent units bind that backend's folder in the persona's private layer", async () => {
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
// stays in `read`, `write` and `full`, and only `sudo` drops it.

const DEPLOY = path.join(fileURLToPath(new URL('../../..', import.meta.url)), 'deploy');
// A mode belongs to a unit, so the store names the unit.
const UNITS = [
  ['neptunia-agent-scout.service', 'scout'],
  ['neptunia-agent-code.service', 'code'],
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

// PR 1, sources without an enable step: what every consumer of the old connected-backends list does once availability
// is installed and authenticated. The stored list `subharness.backends` migrates into the role assignments and stops
// deciding anything: keys.json (src/keys/file.ts), `routeOfAgent`, the runner's path (src/subharness/run.ts), the memory
// probe and writer, the unit binds, `/service` readiness and the features row. Backends are
// disposable executables, keys.json lives in a temp dir.

const SUBHARNESS_SOURCE_CONSUMERS_ROOT = path.join(import.meta.dirname, '../../..');

function storeWith(subharness: Partial<KeysFile['subharness']>): string {
  const privateDir = tempDir('nep-sources-');
  writeKeysFile(privateDir, { subharness: { key: null, modes: {}, ...subharness } });
  return privateDir;
}

// Unit binds

function target(dataDir: string): UnitTarget {
  return {
    system: false,
    user: 'alice',
    group: 'alice',
    home: tempDir('nep-home-'),
    rootDir: SUBHARNESS_SOURCE_CONSUMERS_ROOT,
    privateDir: dataDir,
    dataDir,
    node: '/usr/bin/node',
  };
}

const scoutUnit = (dataDir: string): string => {
  const file = 'neptunia-agent-scout.service';
  return unitText(
    target(dataDir),
    fs.readFileSync(path.join(SUBHARNESS_SOURCE_CONSUMERS_ROOT, 'deploy', file), 'utf8'),
    file
  );
};

test('a unit binds a source a role names before it is installed, as a restored installation has it', () => {
  // Catches: a restored persona whose role names claude starts its runner with the folder hidden from the service account.
  const dataDir = storeWith({ uses: { scout: 'claude' } });
  assert.ok(scoutUnit(dataDir).includes(`BindPaths=-${subharnessPlace(dataDir, 'claude').dir}`));
});

test('a unit binds no folder for a name the old list holds with no role and no install', () => {
  // Catches: the list goes on deciding the sandbox, so a backend gone from the machine stays writable by the agent.
  const dataDir = storeWith({
    backends: ['codex'],
    // Changed: the agents `dev`, `thinker` and `watcher` are gone (maintainer, 2026-11-16).
    uses: { scout: 'claude', server: 'claude' },
  });
  assert.equal(scoutUnit(dataDir).includes(subharnessPlace(dataDir, 'codex').dir), false);
});
