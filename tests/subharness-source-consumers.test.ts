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
import { readKeys, writeKeys } from '../src/keys/file.ts';
import { subharnessCommand } from '../src/interface/commands/subharness.ts';
import { unitText } from '../src/setup/install.ts';
import type { UnitTarget } from '../src/setup/install.ts';
import { watcherStep } from '../src/setup/watcher.ts';
import { serviceFamily } from '../src/service/commands.ts';
import type { EnableDeps } from '../src/subharness/control.ts';
import { routeOfAgent } from '../src/subharness/control.ts';
import { updateSubharness } from '../src/subharness/install.ts';
import { memoryProbe } from '../src/subharness/memory-probe.ts';
import { runMemoryWriter } from '../src/subharness/memory-writer.ts';
import { subharnessPlace } from '../src/subharness/place.ts';
import { runAgent } from '../src/subharness/run.ts';
import { featureRows } from '../src/subharness/summary.ts';
import { fakeVendor, treeOf } from './fixtures/fake-vendor.ts';
import { readKeysFile, writeKeysFile } from './fixtures/keys-file.ts';
import type { KeysFile } from './fixtures/keys-file.ts';
import { fakeFetch } from './fixtures/keys-rig.ts';
import { tempDir } from './fixtures/tmp.ts';

const ROOT = path.join(import.meta.dirname, '..');

function storeWith(subharness: Partial<KeysFile['subharness']>): string {
  const privateDir = tempDir('nep-sources-');
  writeKeysFile(privateDir, { subharness: { key: null, modes: {}, ...subharness } });
  return privateDir;
}

// Migration of the stored list

test('a stored list becomes the role of every agent that named no backend, and models, efforts and modes stay', () => {
  // Catches: dropping the list silently moves an agent that ran through backends[0] onto nothing.
  const privateDir = storeWith({
    backends: ['codex', 'claude'],
    uses: { scout: 'claude' },
    models: { dev: 'gpt-6.1-sol' },
    efforts: { dev: 'high' },
    modes: { dev: 'full' },
  });
  const { subharness } = readKeys(privateDir);
  assert.deepEqual(subharness.uses, {
    scout: 'claude',
    server: 'codex',
    dev: 'codex',
    watcher: 'codex',
    thinker: 'codex',
  });
  assert.deepEqual(subharness.models, { dev: 'gpt-6.1-sol' });
  assert.deepEqual(subharness.efforts, { dev: 'high' });
  assert.deepEqual(subharness.modes, { dev: 'full' });
});

test('the single backend of the oldest store migrates the same way', () => {
  // Catches: the store written before the list reads as no assignment, so a restored persona loses her agents.
  const privateDir = storeWith({ backend: 'claude' });
  assert.equal(readKeys(privateDir).subharness.uses.dev, 'claude');
});

test('the next write leaves no enabled list in the file, and reading it again changes nothing', () => {
  // Catches: the list survives a write, so an old consumer can go on reading a flag nobody maintains.
  const privateDir = storeWith({ backends: ['codex'], modes: { server: 'read' } });
  const first = readKeys(privateDir);
  writeKeys(privateDir, first);
  const onDisk = readKeysFile(privateDir).subharness;
  assert.equal(Object.hasOwn(onDisk, 'backends'), false);
  assert.equal(Object.hasOwn(onDisk, 'backend'), false);
  assert.deepEqual(readKeys(privateDir), first);
  // An empty list invents no default for a persona that never chose one, and opencode keeps its key's name.
  const empty = readKeys(storeWith({ backends: [], key: 'oc-1' })).subharness;
  assert.deepEqual(empty.uses, {});
  assert.equal(empty.key, 'oc-1');
});

// Runner selection

test('routeOfAgent follows the role assignment when the old list omits that backend', () => {
  // Catches: a valid login left out of the old list keeps the agent refused.
  const privateDir = storeWith({ backends: ['codex'], uses: { dev: 'claude' }, models: { dev: 'sonnet' } });
  assert.deepEqual(routeOfAgent(privateDir, 'dev'), {
    backend: 'claude',
    model: 'sonnet',
    effort: null,
    mode: 'write',
  });
});

test('the runner starts the assigned backend when the old list omits it', async () => {
  // Catches: the runner's own read of the list answers subharness-off for a source that works.
  const privateDir = storeWith({ backends: ['codex'], uses: { dev: 'claude' } });
  const vendor = fakeVendor(privateDir, 'claude', { loggedIn: true });
  const done = await runAgent(
    { agent: 'dev', brief: 'the brief', cwd: privateDir, timeoutMs: 5000 },
    { privateDir, denyDir: tempDir('nep-deny-'), hostEnv: { PATH: '/usr/bin:/bin' } }
  );
  assert.equal(done.error, undefined);
  assert.equal(done.ok, true);
  // Changed: the installed backend reads its own --help before a run, which is no model run.
  assert.equal(vendor.calls().filter((one) => one !== '--help').length, 1);
});

// The memory path

function probeOf(privateDir: string, ran: Array<string>) {
  const { fetch, calls } = fakeFetch();
  return {
    calls,
    deps: {
      privateDir,
      route: () => ({ name: 'core-1', value: 'value' }),
      fetch,
      baseUrl: 'https://openrouter.test/api/v1',
      model: () => 'x/memory',
      runBackend: (name: 'codex' | 'claude') => {
        ran.push(name);
        return Promise.resolve({ ok: true, text: 'ok', exitCode: 0 });
      },
    },
  };
}

test('the memory probe reaches a selected backend the old list omits', async () => {
  // Catches: the writer's selected Claude reads as subharness-off, so she sleeps with a working login.
  const privateDir = storeWith({
    backends: [],
    memory: { backend: 'claude', model: 'claude-opus-4-6', effort: null },
  });
  fakeVendor(privateDir, 'claude', { loggedIn: true });
  const ran: Array<string> = [];
  const result = await memoryProbe(probeOf(privateDir, ran).deps, 1000);
  // Changed: claude enforces the output cap, so its probe carries no gap.
  assert.deepEqual(result, { ok: true, at: 1000, gaps: [] });
  assert.deepEqual(ran, ['claude']);
});

test('the memory writer runs a selected backend the old list omits', async () => {
  // Catches: the writer's own gate refuses every sweep with subharness-off after the list is gone.
  const privateDir = storeWith({ backends: [] });
  fakeVendor(privateDir, 'claude', { loggedIn: true });
  const completion = await runMemoryWriter(
    { kind: 'subharness', backend: 'claude', model: 'claude-opus-4-6', effort: null },
    { system: 'SYSTEM', user: 'USER', timeoutMs: 5000 },
    {
      privateDir,
      workDir: tempDir('nep-memory-work-'),
      runChild: () =>
        Promise.resolve({ exitCode: 0, stdout: JSON.stringify({ is_error: false, result: 'text' }), stderr: '' }),
    }
  );
  assert.equal(completion.text, 'text');
});

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

test('the watcher step takes an installed, authenticated source the old list omits', async () => {
  // Catches: setup refuses a logged-in backend because the enable step that fed the list is gone.
  const privateDir = storeWith({ backends: [] });
  fakeVendor(privateDir, 'claude', { loggedIn: true });
  const outcome = await watcherStep(
    { rootDir: ROOT, privateDir },
    watcherRig(privateDir, ['on', 'every 6h', 'claude', 'sonnet'])
  );
  assert.equal(outcome.state, 'done');
  assert.equal(readKeys(privateDir).subharness.uses.watcher, 'claude');
});

test('the watcher step refuses a source that is installed and not logged in', async () => {
  // Catches: installed alone passes as available, so the watcher is switched on over a backend that cannot answer.
  const privateDir = storeWith({ backends: ['claude'] });
  fakeVendor(privateDir, 'claude');
  const outcome = await watcherStep(
    { rootDir: ROOT, privateDir },
    watcherRig(privateDir, ['on', 'every 6h', 'claude', 'sonnet'])
  );
  assert.equal(outcome.state, 'refused');
});

test('/service reads the watcher ready when its role names a source, whatever the old list holds', async () => {
  // Catches: status keeps reporting "no backend is connected" from a list nothing writes any more.
  const privateDir = storeWith({ uses: { watcher: 'claude' } });
  fakeVendor(privateDir, 'claude', { loggedIn: true });
  const answer = await serviceFamily(
    {
      rootDir: ROOT,
      privateDir,
      dataDir: privateDir,
      config: () => ({}),
      now: () => 0,
      env: { NEPTUNIA_UNIT_SCOPE: 'user' },
      run: () => Promise.resolve({ code: 0, stdout: 'inactive', stderr: '' }),
      coreUp: false,
      report: () => ({ text: '', status: 'ok' }),
    },
    'service.watcher.status',
    {}
  );
  assert.equal(answer.text.includes('no subharness backend is connected'), false);
});

test('the features row reads the subharness on with an authenticated source and names no enable command', async () => {
  // Catches: doctor tells the owner to run a command that no longer exists.
  const on = storeWith({});
  fakeVendor(on, 'claude', { loggedIn: true });
  const row = (await featureRows(on)).find((one) => one.name === 'subharness');
  assert.equal(row?.available, true);
  const off = storeWith({});
  const none = (await featureRows(off)).find((one) => one.name === 'subharness');
  assert.equal(none?.available, false);
  assert.equal(none?.hint?.includes('subharness enable'), false);
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
