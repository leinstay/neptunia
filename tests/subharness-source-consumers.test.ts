// PR 1, sources without an enable step: what every consumer of the old connected-backends list does once availability
// is installed and authenticated. The stored list `subharness.backends` migrates into the role assignments and stops
// deciding anything: keys.json (src/keys/file.ts), `routeOfAgent`, the runner's path (src/subharness/run.ts), the memory
// probe and writer, the unit binds, the watcher's setup, `/service` readiness and the features row. Backends are
// disposable executables, keys.json lives in a temp dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { chatPanel } from '../bin/chat-panels.ts';

import { subharnessCommand } from '../src/interface/commands/subharness.ts';
import { unitText } from '../src/setup/install.ts';
import type { UnitTarget } from '../src/setup/install.ts';
import { watcherStep } from '../src/setup/watcher.ts';
import type { EnableDeps } from '../src/subharness/control.ts';

import { updateSubharness } from '../src/subharness/install.ts';

import { subharnessPlace } from '../src/subharness/place.ts';

import { fakeVendor, treeOf } from './fixtures/fake-vendor.ts';
import { writeKeysFile } from './fixtures/keys-file.ts';
import type { KeysFile } from './fixtures/keys-file.ts';
import { fakeFetch } from './fixtures/keys-rig.ts';
import { tempDir } from './fixtures/tmp.ts';

const ROOT = path.join(import.meta.dirname, '..');

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
    rootDir: ROOT,
    privateDir: dataDir,
    dataDir,
    node: '/usr/bin/node',
  };
}

const scoutUnit = (dataDir: string): string => {
  const file = 'neptunia-agent-scout.service';
  return unitText(target(dataDir), fs.readFileSync(path.join(ROOT, 'deploy', file), 'utf8'), file);
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
    uses: { scout: 'claude', server: 'claude', dev: 'claude', watcher: 'claude', thinker: 'claude' },
  });
  assert.equal(scoutUnit(dataDir).includes(subharnessPlace(dataDir, 'codex').dir), false);
});

// Setup validation and readiness lines

function watcherRig(privateDir: string, answers: Array<string>) {
  return { ask: () => Promise.resolve(answers.shift() ?? '') };
}

test('the watcher step refuses a source that is installed and not logged in', async () => {
  // Catches: installed alone passes as available, so the watcher is switched on over a backend that cannot answer.
  const privateDir = storeWith({ backends: ['claude'] });
  fakeVendor(privateDir, 'claude');
  const outcome = await watcherStep({ rootDir: ROOT, privateDir }, watcherRig(privateDir, ['claude', 'sonnet']));
  assert.equal(outcome.state, 'refused');
});

test('the setup panel offers the login of each backend and never the retired enable', async () => {
  // Catches: the panel prefills a command that now exits 2.
  const panel = await chatPanel('/setup', () => Promise.resolve({ status: 'ok', text: '' }), []);
  const prefills = (panel?.rows ?? []).map((row) => row.prefill ?? '');
  assert.equal(
    prefills.some((line) => line.startsWith('/subharness enable')),
    false
  );
  for (const backend of ['codex', 'claude', 'opencode'])
    assert.ok(
      prefills.some((line) => line.startsWith(`/subharness ${backend} login`)),
      backend
    );
});

// The plain status

function enableDeps(privateDir: string): { deps: EnableDeps; runs: Array<string> } {
  const runs: Array<string> = [];
  return {
    runs,
    deps: {
      privateDir,
      fetch: fakeFetch().fetch,
      runBackend: (name) => {
        runs.push(name);
        return Promise.resolve({ ok: true, text: 'ok', exitCode: 0 });
      },
    },
  };
}

const rowOf = (text: string, role: string): string =>
  text.split('\n').find((line) => line.trim().startsWith(`${role} `)) ?? '';

test('/subharness status lists the source, model, effort and mode of every role with no model run', async () => {
  // Catches: the status hides a role behind the list, or spends a request on a read.
  const privateDir = storeWith({
    uses: { dev: 'claude', thinker: 'codex' },
    models: { dev: 'sonnet', thinker: 'gpt-6-luna' },
    efforts: { dev: 'high' },
    modes: { dev: 'full' },
    memory: { backend: 'claude', model: 'claude-opus-4-6', effort: 'high' },
  });
  fakeVendor(privateDir, 'claude', { loggedIn: true });
  fakeVendor(privateDir, 'codex', { loggedIn: true });
  const { deps, runs } = enableDeps(privateDir);
  const answer = await subharnessCommand(deps, 'subharness.status', {});
  assert.equal(answer.status, 'ok');
  const dev = rowOf(answer.text, 'dev');
  for (const word of ['claude', 'sonnet', 'high', 'full']) assert.ok(dev.includes(word), `dev: ${word} in "${dev}"`);
  assert.ok(rowOf(answer.text, 'thinker').includes('gpt-6-luna'));
  const memory = rowOf(answer.text, 'memory');
  for (const word of ['claude', 'claude-opus-4-6', 'high']) assert.ok(memory.includes(word), memory);
  for (const agent of ['scout', 'server', 'watcher']) assert.notEqual(rowOf(answer.text, agent), '', agent);
  assert.deepEqual(runs, []);
});

test('after a logout the status shows the selected source unavailable and names no other source', async () => {
  // Catches: the row falls back to OpenRouter or to the first available source once its own login is gone.
  const privateDir = storeWith({ uses: { dev: 'claude' }, models: { dev: 'sonnet' } });
  fakeVendor(privateDir, 'claude');
  fakeVendor(privateDir, 'codex', { loggedIn: true });
  const { deps } = enableDeps(privateDir);
  const dev = rowOf((await subharnessCommand(deps, 'subharness.status', {})).text, 'dev');
  assert.ok(dev.includes('claude'), dev);
  assert.ok(dev.includes('sonnet'), dev);
  assert.ok(dev.includes('unavailable'), dev);
  assert.equal(dev.includes('codex'), false, dev);
  assert.equal(dev.includes('openrouter'), false, dev);
});

// A failed update

test('a failed update keeps the binary, the home and the rollback the last update left', async () => {
  // Catches: the failed attempt deletes `previous/` before it knows the outcome, so the owner loses his way back.
  const privateDir = storeWith({});
  const vendor = fakeVendor(privateDir, 'codex', { loggedIn: true });
  const { dir } = subharnessPlace(privateDir, 'codex');
  const hostEnv = { PATH: '/usr/bin:/bin' };
  const first = await updateSubharness({ privateDir, backend: 'codex', hostEnv, version: '2.0.0' }, vendor.install);
  assert.equal(first.state, 'done');
  const kept = treeOf(path.join(dir, 'previous'));
  const installedText = fs.readFileSync(vendor.binary, 'utf8');
  const failed = await updateSubharness({ privateDir, backend: 'codex', hostEnv, version: '3.0.0' }, () =>
    Promise.resolve({ code: 1, stdout: '', stderr: 'npm: the registry refused' })
  );
  assert.equal(failed.state, 'failed');
  assert.equal(fs.readFileSync(vendor.binary, 'utf8'), installedText);
  assert.equal(vendor.loggedIn(), true);
  assert.deepEqual(treeOf(path.join(dir, 'previous')), kept);
});
