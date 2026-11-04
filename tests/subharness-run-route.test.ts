// src/subharness/run.ts with a route the core decided and sent inside the task. The scout unit hides keys.json from the
// runner, so a run with a route takes everything from the route. The backend is a fake that records what it was given.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runAgent } from '../src/subharness/run.ts';
import type { AgentRun, RunDeps } from '../src/subharness/run.ts';
import { setAgentMode } from '../src/subharness/control.ts';
import type { BackendRunOptions } from '../src/agent-runner/backend.ts';
import type { TaskRoute } from '../src/agent-runner/protocol.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import { keysPath, writeKeysFile } from './fixtures/keys-file.ts';
import { tempDir } from './fixtures/tmp.ts';

const STORE_SECRET = 'sk-or-v1-store-secret-0123456789';
const TASK_SECRET = 'sk-or-v1-task-secret-9876543210';

const ROUTE: TaskRoute = { backend: 'claude', model: 'claude-opus-5-5', effort: 'medium', mode: 'read' };
const OPENCODE: TaskRoute = { backend: 'opencode', model: null, effort: null, mode: 'write' };

/** keys.json says the opposite of ROUTE on every field, so a run that reads it is visible. */
function rig() {
  const privateDir = tempDir('nep-route-priv-');
  const denyDir = path.join(tempDir('nep-route-deny-'), 'nosudo');
  writeKeysFile(privateDir, {
    extra: { opencode: STORE_SECRET },
    subharness: {
      backends: ['codex'],
      key: 'opencode',
      modes: { scout: 'write' },
      models: { scout: 'gpt-6-sol' },
      efforts: { scout: 'high' },
    },
  });
  const seen: Array<{ name: string; options: BackendRunOptions }> = [];
  const deps: RunDeps = {
    privateDir,
    denyDir,
    hostEnv: { PATH: '/usr/bin:/bin' },
    backendFactory: (name) => ({
      name,
      run: (_brief: string, options: BackendRunOptions) => {
        seen.push({ name, options });
        return Promise.resolve({ ok: true, text: 'done', exitCode: 0 });
      },
    }),
  };
  return { deps, privateDir, denyDir, seen };
}

const request = (extra: Partial<AgentRun>): AgentRun => ({
  agent: 'scout',
  brief: 'look at the disk',
  cwd: '/tmp/x',
  timeoutMs: 1000,
  ...extra,
});

test('a route runs its own backend, model, effort and mode over what keys.json says', async () => {
  // Catches: keys.json still decides one of the four fields, so the errand runs on another model or sandbox than the core chose.
  const { deps, seen } = rig();
  const result = await runAgent(request({ route: ROUTE }), deps);
  assert.equal(result.ok, true);
  assert.equal(seen[0]?.name, 'claude');
  assert.equal(seen[0]?.options.model, 'claude-opus-5-5');
  assert.equal(seen[0]?.options.effort, 'medium');
  assert.equal(seen[0]?.options.sandbox, 'read-only');
});

test('a route runs when keys.json is absent, as it is under the scout unit', async () => {
  // Catches: the run reads keys.json first, finds the empty store of ENOENT, and every scout errand fails subharness-off.
  const { deps, seen, privateDir } = rig();
  fs.rmSync(keysPath(privateDir));
  const result = await runAgent(request({ route: ROUTE }), deps);
  assert.equal(result.ok, true);
  assert.equal(seen[0]?.name, 'claude');
});

test('a route runs when keys.json is no JSON, because a run with a route does not read it', async () => {
  // Catches: the store is read before the route is looked at, so a broken file refuses a run that needs nothing from it.
  const { deps, seen, privateDir } = rig();
  fs.writeFileSync(keysPath(privateDir), '{not json');
  const result = await runAgent(request({ route: ROUTE }), deps);
  assert.equal(result.ok, true);
  assert.equal(seen[0]?.name, 'claude');
});

test('a route with no model and no effort passes neither, whatever keys.json names for the agent', async () => {
  // Catches: a null field falls through to the stored model, so the backend's default becomes a model the core did not choose.
  const { deps, seen } = rig();
  await runAgent(request({ route: { backend: 'claude', model: null, effort: null, mode: 'write' } }), deps);
  assert.equal(seen[0]?.name, 'claude');
  assert.equal(Object.hasOwn(seen[0]?.options ?? {}, 'model'), false);
  assert.equal(Object.hasOwn(seen[0]?.options ?? {}, 'effort'), false);
});

for (const [mode, sandbox, standIn] of [
  ['read', 'read-only', true],
  ['write', 'workspace-write', true],
  ['full', 'none', true],
  ['sudo', 'none', false],
] as const) {
  test(`a route in mode ${mode} sets the sandbox ${sandbox} and the sudo stand-in by the route's mode`, async () => {
    // Catches: the sandbox follows the route and the PATH still follows keys.json (or the reverse), so sudo opens or stays shut wrongly.
    const { deps, denyDir, seen, privateDir } = rig();
    await setAgentMode(privateDir, 'scout', mode === 'sudo' ? 'read' : 'sudo');
    await runAgent(request({ route: { ...ROUTE, mode } }), deps);
    assert.equal(seen[0]?.name, 'claude');
    assert.equal(seen[0]?.options.sandbox, sandbox);
    assert.equal(seen[0]?.options.env?.PATH?.startsWith(`${denyDir}:`) ?? false, standIn);
  });
}

test('a route in full writes the log line of a run without a sandbox', async () => {
  // Catches: the route path skips the line, so the log no longer shows who worked without a sandbox.
  const { deps } = rig();
  const { logs } = await withCapturedLogs(() => runAgent(request({ route: { ...ROUTE, mode: 'full' } }), deps));
  const line = logs.find((entry) => JSON.stringify(entry).includes('without a sandbox'));
  assert.equal(line?.mode, 'full');
  assert.equal(line?.agent, 'scout');
});

test("an opencode route takes the task's key, not the key keys.json holds", async () => {
  // Catches: the run reaches for the store's extra key, which the scout unit hides, or spends another key than the task brought.
  const { deps, seen } = rig();
  const result = await runAgent(request({ route: OPENCODE, routeKey: TASK_SECRET }), deps);
  assert.equal(result.ok, true);
  assert.equal(seen[0]?.name, 'opencode');
  assert.equal(seen[0]?.options.env?.OPENROUTER_API_KEY, TASK_SECRET);
});

test('an opencode route still gets its step limit through its inline config', async () => {
  // Catches: the route path skips OPENCODE_CONFIG_CONTENT, so an opencode errand runs with no step limit.
  const { deps, seen } = rig();
  await runAgent(request({ route: OPENCODE, routeKey: TASK_SECRET, maxSteps: 7 }), deps);
  const config = JSON.parse(seen[0]?.options.env?.OPENCODE_CONFIG_CONTENT ?? '{}') as {
    agent?: { build?: { steps?: number } };
  };
  assert.equal(config.agent?.build?.steps, 7);
});

test('an opencode route with no key fails route-no-key and starts nothing, though keys.json holds one', async () => {
  // Catches: the run falls back to the store's key, or starts opencode with no key and reports a provider error instead of the cause.
  const { deps, seen } = rig();
  const result = await runAgent(request({ route: OPENCODE }), deps);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'route-no-key');
  assert.equal(result.exitCode, null);
  assert.equal(seen.length, 0);
});

test('a claude route gives the child no key, though the task brought one', async () => {
  // Catches: the key of the task reaches a CLI that brings its own login, so a model key sits in the environment of its commands.
  const { deps, seen } = rig();
  await runAgent(request({ route: ROUTE, routeKey: TASK_SECRET }), deps);
  assert.equal(seen[0]?.name, 'claude');
  assert.equal(seen[0]?.options.env?.OPENROUTER_API_KEY, undefined);
});

for (const [name, route] of [
  ['an unknown backend', { ...ROUTE, backend: 'gemini' }],
  ['an unknown mode', { ...ROUTE, mode: 'root' }],
  ['an unknown effort', { ...ROUTE, effort: 'extreme' }],
  ['a missing mode', { backend: 'claude', model: null, effort: null }],
  ['null', null],
] as const) {
  test(`a route with ${name} fails bad-route and does not fall back to the connected backend`, async () => {
    // Catches: a bad route is treated as no route, so the errand runs on the backend of keys.json.
    const { deps, seen } = rig();
    const result = await runAgent(request({ route: route as unknown as TaskRoute }), deps);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'bad-route');
    assert.equal(result.exitCode, null);
    assert.equal(seen.length, 0);
  });
}
