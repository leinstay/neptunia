// The OpenRouter provider of an opencode route: `/model set <agent> <model> --via opencode --provider <slug>` stores it
// in keys.json (`subharness.providers`, by agent), `/subharness status` shows it, `routeOfAgent` puts it into the task's
// route, and `runAgent` hands it to the backend. The binaries are fakes, no request goes out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { BackendRunOptions } from '../src/agent-runner/backend.ts';
import { createConsole } from '../src/interface/commands/console.ts';
import { subharnessCommand } from '../src/interface/commands/subharness.ts';
import { routeOfAgent, setAgentModel } from '../src/subharness/control.ts';
import type { EnableDeps } from '../src/subharness/control.ts';
import { subharnessPlace } from '../src/subharness/place.ts';
import { runAgent } from '../src/subharness/run.ts';
import type { AgentRun, RunDeps } from '../src/subharness/run.ts';
import { fakeVendor } from './fixtures/fake-vendor.ts';
import { readKeysFile, writeKeysFile } from './fixtures/keys-file.ts';
import { fakeFetch } from './fixtures/keys-rig.ts';
import { tempDir } from './fixtures/tmp.ts';

const KEY = 'sk-or-v1-provider-fake-0123456789';
const MODEL = 'anthropic/claude-sonnet-5';
const OWNER = { id: 'owner' };

/** The providers keys.json holds, by agent; the section is absent while nobody pinned one. */
const providersOf = (dir: string): unknown => (readKeysFile(dir).subharness as Record<string, unknown>).providers;

/** A private dir whose opencode is installed and logged in on the extra key `helpers`. */
function installed(): string {
  const dir = tempDir('nep-provider-');
  writeKeysFile(dir, { extra: { helpers: KEY }, subharness: { key: 'helpers', modes: {} } });
  const { binary } = subharnessPlace(dir, 'opencode');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, '#!/bin/sh\nexit 9\n', { mode: 0o755 });
  return dir;
}

const selectionDeps = (dir: string): EnableDeps => ({
  privateDir: dir,
  baseUrl: 'https://openrouter.test/api/v1',
  runBackend: () => Promise.resolve({ ok: true, text: 'ok', exitCode: 0 }),
  fetch: () => Promise.resolve(new Response('{}', { status: 200 })),
});

/** The console over `dir`, as the owner's chat reaches it. */
function consoleOver(dir: string) {
  return createConsole({
    runOp: () => Promise.resolve({ status: 'ok', code: '', summary: '', data: null }),
    ownerReads: { lessons: () => '', aliases: () => '' },
    places: () => ['g1'],
    selfId: () => 'self-1',
    hot: { config: { bot: { owners: [] } } },
    privateDir: dir,
    dataDir: dir,
    memoryDb: null,
    usage: null,
    metrics: null,
    conversationLines: () => [],
    now: () => 0,
    subharness: {
      runBackend: () => Promise.resolve({ ok: true, text: 'ok', exitCode: 0 }),
      fetch: fakeFetch().fetch,
      helpOf: () => Promise.resolve('Options:\n  --effort <level>\n'),
    },
  });
}

/** Run deps whose backend records the options it was started with. */
function recording(dir: string): { deps: RunDeps; seen: Array<BackendRunOptions> } {
  const seen: Array<BackendRunOptions> = [];
  return {
    seen,
    deps: {
      privateDir: dir,
      denyDir: tempDir('nep-provider-deny-'),
      backendFactory: (name) => ({
        name,
        run: (_brief, options) => {
          seen.push(options);
          return Promise.resolve({ ok: true, text: 'ok', exitCode: 0 });
        },
      }),
    },
  };
}

const devRun = (dir: string, extra: Partial<AgentRun> = {}): AgentRun => ({
  agent: 'dev',
  brief: 'B',
  cwd: dir,
  timeoutMs: 5_000,
  ...extra,
});

// setAgentModel

test('setAgentModel stores the provider of an opencode route beside its model', async () => {
  // Catches: `--provider` accepted and dropped, so the route is written without the pin the owner asked for.
  const dir = installed();
  const result = await setAgentModel(selectionDeps(dir), 'dev', MODEL, undefined, 'opencode', 'anthropic');
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(providersOf(dir), { dev: 'anthropic' });
  assert.equal(readKeysFile(dir).subharness.models?.dev, `openrouter/${MODEL}`);
});

test('the answer of a pinned selection says which provider the agent is pinned to', async () => {
  // Catches: the owner sets a pin and the reply reads like an unpinned selection, so he cannot tell it took.
  const dir = installed();
  const result = await setAgentModel(selectionDeps(dir), 'dev', MODEL, undefined, 'opencode', 'google-vertex');
  assert.ok(result.message.includes('google-vertex'), result.message);
});

test('a model set with no provider drops the provider stored for that agent', async () => {
  // Catches: a provider chosen for one model staying on the next model, which that provider may not serve at all.
  const dir = installed();
  await setAgentModel(selectionDeps(dir), 'dev', MODEL, undefined, 'opencode', 'anthropic');
  assert.deepEqual(providersOf(dir), { dev: 'anthropic' }, 'the pin was stored first');
  const result = await setAgentModel(selectionDeps(dir), 'dev', 'deepseek/deepseek-v4', undefined, 'opencode');
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(providersOf(dir) ?? {}, {});
});

test('a provider of one agent is not stored for another', async () => {
  // Catches: the providers held in one slot, so dev's pin also pins scout.
  const dir = installed();
  await setAgentModel(selectionDeps(dir), 'dev', MODEL, undefined, 'opencode', 'anthropic');
  await setAgentModel(selectionDeps(dir), 'scout', 'deepseek/deepseek-v4', undefined, 'opencode', 'deepinfra');
  assert.deepEqual(providersOf(dir), { dev: 'anthropic', scout: 'deepinfra' });
});

test('moving an agent to claude drops its provider', async () => {
  // Catches: a stale pin kept under a backend that cannot honour it, which the next route then refuses as bad-route.
  const dir = installed();
  fakeVendor(dir, 'claude', { loggedIn: true });
  await setAgentModel(selectionDeps(dir), 'dev', MODEL, undefined, 'opencode', 'anthropic');
  assert.deepEqual(providersOf(dir), { dev: 'anthropic' }, 'the pin was stored first');
  const result = await setAgentModel(selectionDeps(dir), 'dev', 'sonnet', undefined, 'claude');
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(providersOf(dir) ?? {}, {});
});

for (const backend of ['claude', 'codex'] as const) {
  test(`a provider with --via ${backend} is refused as provider-unsupported and writes nothing`, async () => {
    // Catches: a pin stored for a backend that has no such control, so it is ignored without a word.
    const dir = installed();
    fakeVendor(dir, backend, { loggedIn: true });
    const before = JSON.stringify(readKeysFile(dir));
    const result = await setAgentModel(selectionDeps(dir), 'dev', 'sonnet', undefined, backend, 'anthropic');
    assert.equal(result.ok, false);
    assert.equal(result.code, 'provider-unsupported');
    assert.equal(JSON.stringify(readKeysFile(dir)), before);
  });
}

test('a provider on an agent whose stored source is claude is refused when --via is left out', async () => {
  // Catches: the check looking at `--via` alone, so a pin slips onto an agent that already runs through claude.
  const dir = installed();
  fakeVendor(dir, 'claude', { loggedIn: true });
  await setAgentModel(selectionDeps(dir), 'dev', 'sonnet', undefined, 'claude');
  const result = await setAgentModel(selectionDeps(dir), 'dev', 'opus', undefined, undefined, 'anthropic');
  assert.equal(result.code, 'provider-unsupported');
});

for (const provider of ['two words', '--flag', 'Upper']) {
  test(`setAgentModel refuses the provider ${JSON.stringify(provider)} as bad-provider and writes nothing`, async () => {
    // Catches: a free-form string stored and later written into the child's config.
    const dir = installed();
    const before = JSON.stringify(readKeysFile(dir));
    const result = await setAgentModel(selectionDeps(dir), 'dev', MODEL, undefined, 'opencode', provider);
    assert.equal(result.code, 'bad-provider');
    assert.equal(JSON.stringify(readKeysFile(dir)), before);
  });
}

// the route

test('the route of an agent carries the provider stored for it', async () => {
  // Catches: the pin kept in keys.json and never put into the task, so every errand runs unpinned.
  const dir = installed();
  await setAgentModel(selectionDeps(dir), 'dev', MODEL, undefined, 'opencode', 'anthropic');
  assert.deepEqual(routeOfAgent(dir, 'dev'), {
    backend: 'opencode',
    model: `openrouter/${MODEL}`,
    effort: null,
    mode: 'write',
    provider: 'anthropic',
  });
});

test('the route of an agent with no provider has no provider key', () => {
  // Catches: a null or undefined provider on every route, which the strict route parser then refuses as bad-route.
  const dir = installed();
  const stored = readKeysFile(dir);
  writeKeysFile(dir, {
    ...stored,
    subharness: { ...stored.subharness, uses: { dev: 'opencode' }, models: { dev: `openrouter/${MODEL}` } },
  });
  assert.deepEqual(Object.keys(routeOfAgent(dir, 'dev') ?? {}).sort(), ['backend', 'effort', 'mode', 'model']);
});

// the commands

test('/model set <agent> <model> --via opencode --provider stores the provider and /subharness status shows it', async () => {
  // The lead: routes are named direct-api, claude-harness, codex-harness and opencode-harness (owner, 2026-11-06).
  // Catches: the console still refusing `--provider` for an agent, or the status leaving the pin out so the owner cannot check it.
  const dir = installed();
  const answer = await consoleOver(dir).run(
    'model.set',
    { role: 'dev', model: MODEL, via: 'opencode-harness', provider: 'google-vertex' },
    OWNER
  );
  assert.equal(answer.status, 'ok', answer.text);
  assert.deepEqual(providersOf(dir), { dev: 'google-vertex' });
  const status = await subharnessCommand(selectionDeps(dir), 'subharness.status', {});
  const row = status.text.split('\n').find((line) => line.trim().startsWith('dev ')) ?? '';
  assert.ok(row.includes('google-vertex'), status.text);
});

test('/subharness status shows no provider on the row of an agent that has none', async () => {
  // Catches: a "provider none" or empty column on every row, which reads like a pin that is not there.
  const dir = installed();
  await setAgentModel(selectionDeps(dir), 'dev', MODEL, undefined, 'opencode', 'anthropic');
  await setAgentModel(selectionDeps(dir), 'scout', 'deepseek/deepseek-v4', undefined, 'opencode');
  const status = await subharnessCommand(selectionDeps(dir), 'subharness.status', {});
  const row = status.text.split('\n').find((line) => line.trim().startsWith('scout ')) ?? '';
  assert.equal(row.includes('provider'), false, row);
});

test('/model set <agent> <model> --provider with no --via on a claude agent is refused with provider-unsupported', async () => {
  // The lead: routes are named direct-api, claude-harness, codex-harness and opencode-harness (owner, 2026-11-06).
  // Catches: the old blanket refusal text with no code, or the pin stored for an agent whose source takes none.
  const dir = installed();
  fakeVendor(dir, 'claude', { loggedIn: true });
  await consoleOver(dir).run('model.set', { role: 'dev', model: 'sonnet', via: 'claude-harness' }, OWNER);
  const answer = await consoleOver(dir).run('model.set', { role: 'dev', model: 'opus', provider: 'anthropic' }, OWNER);
  assert.equal(answer.code, 'provider-unsupported');
  assert.deepEqual(providersOf(dir) ?? {}, {});
});

// the run

test('a run with a route that names a provider hands it to the backend', async () => {
  // Catches: the route is parsed with its pin and the pin is dropped before the backend options are built.
  const dir = installed();
  const { deps, seen } = recording(dir);
  const route = {
    backend: 'opencode',
    model: `openrouter/${MODEL}`,
    effort: null,
    mode: 'write',
    provider: 'anthropic',
  } as const;
  const result = await runAgent(devRun(dir, { route, routeKey: KEY }), deps);
  assert.equal(result.ok, true);
  assert.equal(seen[0].provider, 'anthropic');
});

test('a run from keys.json hands the stored provider to the backend', async () => {
  // Catches: only the route path carries the pin, so a run on the owner's own machine (no route) goes out unpinned.
  const dir = installed();
  await setAgentModel(selectionDeps(dir), 'dev', MODEL, undefined, 'opencode', 'anthropic');
  const { deps, seen } = recording(dir);
  const result = await runAgent(devRun(dir), deps);
  assert.equal(result.ok, true);
  assert.equal(seen[0].provider, 'anthropic');
});

test('a run with no provider hands the backend no provider option', async () => {
  // Catches: an empty string or null passed down, which a backend would write as a pin to nothing.
  const dir = installed();
  const { deps, seen } = recording(dir);
  const route = { backend: 'opencode', model: `openrouter/${MODEL}`, effort: null, mode: 'write' } as const;
  await runAgent(devRun(dir, { route, routeKey: KEY }), deps);
  assert.equal(Object.hasOwn(seen[0], 'provider'), false);
});

test('a run whose route puts a provider on claude is refused as bad-route and starts nothing', async () => {
  // Catches: the runner honouring a pin it cannot apply, so the errand runs at whatever provider claude uses.
  const dir = installed();
  const { deps, seen } = recording(dir);
  const route = { backend: 'claude', model: 'sonnet', effort: null, mode: 'write', provider: 'anthropic' } as const;
  const result = await runAgent(devRun(dir, { route }), deps);
  assert.equal(result.error, 'bad-route');
  assert.deepEqual(seen, []);
});
