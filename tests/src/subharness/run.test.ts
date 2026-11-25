// Tests for src/subharness/run.ts: the seam every agent run goes through. It settles the backend, model, effort, mode
// and key of a run from config.json and keys.json or from the route a task carried, and builds the child's environment:
// the host PATH, the one key of an OpenCode run, the Exa switch, and the engine proxy.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import type { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { runAgent, sandboxOfMode } from '../../../src/subharness/run.ts';
import type { AgentRun, RunDeps } from '../../../src/subharness/run.ts';
import { setUnitMode, setAgentModel } from '../../../src/subharness/control.ts';
import type { EnableDeps } from '../../../src/subharness/control.ts';
import { subharnessPlace } from '../../../src/subharness/place.ts';
import { childEnvOf, createAgentEngine, createBackend } from '../../../src/agent-runner/backend.ts';
import type { Backend, BackendResult, BackendRunOptions } from '../../../src/agent-runner/backend.ts';
import type { TaskRoute } from '../../../src/agent-runner/protocol.ts';
import { profileOf } from '../../../src/agent-runner/profiles.ts';
import type { BackendName } from '../../../src/agent-runner/profiles.ts';
import { PROXY_ENV_NAMES } from '../../../src/net/proxy.ts';
import { withCapturedLogs } from '../../fixtures/capture-logs.ts';
import { readKeysFile, writeKeysFile, keysPath } from '../../fixtures/keys-file.ts';
import { tempDir } from '../../fixtures/tmp.ts';
import { wrongly } from '../../fixtures/loose-types.ts';

// src/subharness/run.ts: the one seam every agent run goes through (the errands). It reads keys.json at
// the moment of the run, as Hermes' approval guard reads its mode on each check (hermes_cli/approval_mode.py), refuses
// with `subharness-off` while the subharness is off, maps the agent's mode to the backend's sandbox, passes the host
// PATH to the child in every mode, gives OpenCode its one key, and logs one line for a run without a sandbox.
// The backend is a fake that records what it was given; nothing is spawned.
const OC_SECRET = 'sk-or-v1-oc-secret-0123456789';

const CORE_SECRET = 'sk-or-v1-core-secret-9876543210';

const BRIEF = 'check the disk and report back, secret brief text';

const HOST_PATH = '/usr/local/bin:/usr/bin:/bin';

type Seen = { name: string; brief: string; options: BackendRunOptions };

function rig(subharness: { backend: 'codex' | 'claude' | 'opencode' | null; key?: string | null }) {
  const privateDir = tempDir('nep-run-priv-');
  writeKeysFile(privateDir, {
    core: [{ name: 'core-1', value: CORE_SECRET }],
    extra: { opencode: OC_SECRET },
    subharness: { backend: subharness.backend, key: subharness.key ?? null, modes: {} },
  });
  const seen: Array<Seen> = [];
  const result: BackendResult = { ok: true, text: 'done', exitCode: 0 };
  const deps: RunDeps = {
    privateDir,
    hostEnv: { PATH: HOST_PATH, HOME: '/home/x' },
    backendFactory: (name) => ({
      name,
      run: (brief: string, options: BackendRunOptions) => {
        seen.push({ name, brief, options });
        return Promise.resolve(result);
      },
    }),
  };
  return { deps, privateDir, seen };
}

const request = (agent: string, extra: Partial<AgentRun> = {}): AgentRun => ({
  agent,
  brief: BRIEF,
  cwd: '/tmp/x',
  timeoutMs: 1000,
  ...extra,
});

test('the modes map to the sandbox: read, workspace-write, and none for full and sudo', () => {
  // Bug: full or sudo mapped to "danger-full-access" (still a sandbox flag) or read mapped to workspace-write.
  assert.equal(sandboxOfMode('read'), 'read-only');
  assert.equal(sandboxOfMode('write'), 'workspace-write');
  assert.equal(sandboxOfMode('full'), 'none');
  assert.equal(sandboxOfMode('sudo'), 'none');
});

test('while the subharness is off every agent task is refused subharness-off and no backend is made', async () => {
  // Bug: an agent runs on the tracked default backend although the subharness was never turned on.
  const { deps, seen } = rig({ backend: null });
  let made = 0;
  const counting: RunDeps = { ...deps, backendFactory: (name) => (made++, deps.backendFactory?.(name) as Backend) };
  for (const agent of ['scout', 'server']) {
    const result = await runAgent(request(agent), counting);
    assert.equal(result.ok, false, agent);
    assert.equal(result.error, 'subharness-off', agent);
    assert.equal(result.exitCode, null, agent);
  }
  assert.equal(made, 0);
  assert.equal(seen.length, 0);
});

test('the route is read at each run: turning the subharness off between two runs refuses the second', async () => {
  // Bug: the backend is cached when the runner starts, so "subharness disable" changes nothing until a restart.
  // The route lives in `models.agents.via` of config.json, one entry per agent, so turning the subharness off clears
  // those entries.
  const { deps, privateDir } = rig({ backend: 'codex' });
  assert.equal((await runAgent(request('scout'), deps)).ok, true);
  const stored = readKeysFile(privateDir);
  writeKeysFile(privateDir, { ...stored, subharness: { ...stored.subharness, backend: null, uses: {} } });
  assert.equal((await runAgent(request('scout'), deps)).error, 'subharness-off');
});

test('a run goes to the stored backend with the sandbox of the default mode of its agent', async () => {
  // Bug: the server agent gets workspace-write because the profile or the backend default says so.
  const { deps, seen } = rig({ backend: 'codex' });
  for (const agent of ['server', 'scout']) await runAgent(request(agent), deps);
  assert.deepEqual(
    seen.map((one) => [one.name, one.options.sandbox]),
    [
      ['codex', 'read-only'],
      ['codex', 'workspace-write'],
    ]
  );
});

test('the mode set for the unit wins over the profile: server set to write runs workspace-write', async () => {
  // Bug: the profile's sandbox key overrides the mode, so "subharness mode server write" has no effect.
  const { deps, privateDir, seen } = rig({ backend: 'codex' });
  await setUnitMode(privateDir, 'server', 'write');
  await runAgent(request('server'), deps);
  const [firstRun] = seen;
  assert.equal(firstRun?.options.sandbox, 'workspace-write');
});

test('a mode change takes effect on the next run without a restart', async () => {
  // Bug: the mode is read once at start, so the scout stays in write after its mode was set to sudo.
  const { deps, privateDir, seen } = rig({ backend: 'codex' });
  await runAgent(request('scout'), deps);
  await setUnitMode(privateDir, 'scout', 'sudo');
  await runAgent(request('scout'), deps);
  assert.deepEqual(
    seen.map((one) => one.options.sandbox),
    ['workspace-write', 'none']
  );
});

test('a name that is no agent on disk does not run, whatever its source', async () => {
  // Bug: an unlisted agent falls through to an unsandboxed or writable mode.
  // A mode belongs to the unit an agent's profile names, so a name with no profile has no mode and no run.
  const { deps, privateDir, seen } = rig({ backend: 'codex' });
  const stored = readKeysFile(privateDir);
  writeKeysFile(privateDir, { ...stored, subharness: { ...stored.subharness, uses: { stranger: 'codex' } } });
  await runAgent(request('stranger'), deps);
  assert.equal(seen.length, 0);
});

test('the brief, the cwd, the timeout, images and the signal reach the backend unchanged', async () => {
  // Bug: the seam drops an option, so the scout loses its pictures or a cancel never kills the child.
  const { deps, seen } = rig({ backend: 'codex' });
  const signal = new AbortController().signal;
  await runAgent(request('scout', { images: ['/a.png'], signal }), deps);
  const options = seen[0]?.options;
  assert.equal(seen[0]?.brief, BRIEF);
  assert.equal(options?.cwd, '/tmp/x');
  assert.equal(options?.timeoutMs, 1000);
  assert.deepEqual(options?.images, ['/a.png']);
  assert.equal(options?.signal, signal);
});

test('in every mode the child gets the host PATH unchanged', async () => {
  // The engine puts no folder of its own before the host PATH; the unit stops sudo in read, write and full.
  // Bug: a folder of the engine's comes before the host PATH, between the agent and the system.
  for (const mode of ['read', 'write', 'full', 'sudo'] as const) {
    const { deps, privateDir, seen } = rig({ backend: 'codex' });
    await setUnitMode(privateDir, 'scout', mode);
    await runAgent(request('scout'), deps);
    const [firstRun] = seen;
    const runEnv = firstRun?.options.env;
    assert.equal(runEnv?.PATH, HOST_PATH, mode);
  }
});

test('a run in full or sudo writes one log line naming the agent and the mode, and none holds the brief', async () => {
  // Bug: nothing shows who worked without a sandbox, or the log line carries the brief.
  const { deps, privateDir } = rig({ backend: 'codex' });
  await setUnitMode(privateDir, 'server', 'sudo');
  await setUnitMode(privateDir, 'scout', 'full');
  const { logs } = await withCapturedLogs(async () => {
    await runAgent(request('server'), deps);
    await runAgent(request('scout'), deps);
    // The sandboxed run is the scout's, back in read.
    await setUnitMode(privateDir, 'scout', 'read');
    await runAgent(request('scout'), deps);
  });
  const lines = logs.filter((line) => line.mode !== undefined);
  assert.deepEqual(
    lines.map((line): [unknown, unknown] => [line.agent, line.mode]),
    [
      ['server', 'sudo'],
      ['scout', 'full'],
    ]
  );
  assert.equal(JSON.stringify(logs).includes(BRIEF), false);
});

test('the line is written even when the run fails', async () => {
  // Bug: the line is written after the run, so a crashing unsandboxed run leaves no trace.
  const { deps, privateDir } = rig({ backend: 'codex' });
  await setUnitMode(privateDir, 'scout', 'sudo');
  const failing: RunDeps = {
    ...deps,
    backendFactory: (name) => ({ name, run: () => Promise.reject(new Error('boom')) }),
  };
  const { logs } = await withCapturedLogs(async () => {
    await runAgent(request('scout'), failing).catch(() => undefined);
  });
  assert.equal(logs.filter((line) => line.mode === 'sudo').length, 1);
});

test('opencode gets the one named key as OPENROUTER_API_KEY and no core key anywhere', async () => {
  // Bug: OpenCode inherits a core key from the environment, or the extra key it was enabled with is not passed.
  const { deps, seen } = rig({ backend: 'opencode', key: 'opencode' });
  await runAgent(request('scout'), deps);
  const [firstRun] = seen;
  const env = firstRun?.options.env ?? {};
  assert.equal(env.OPENROUTER_API_KEY, OC_SECRET);
  assert.equal(JSON.stringify(seen).includes(CORE_SECRET), false);
});

test('codex and claude get no key in their environment', async () => {
  // Bug: the OpenCode key leaks into a CLI backend that brings its own login.
  for (const backend of ['codex', 'claude'] as const) {
    const { deps, seen } = rig({ backend });
    await runAgent(request('scout'), deps);
    const [firstRun] = seen;
    assert.equal(JSON.stringify(firstRun?.options.env ?? {}).includes('sk-or'), false, backend);
  }
});

test('opencode enabled on a key that has since left the store is refused instead of run keyless', async () => {
  // Bug: the key was removed with "keys extra remove" and OpenCode starts with an empty key, or on a leftover one.
  const { deps, privateDir, seen } = rig({ backend: 'opencode', key: 'opencode' });
  const stored = readKeysFile(privateDir);
  writeKeysFile(privateDir, { ...stored, extra: {} });
  const result = await runAgent(request('scout'), deps);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'subharness-off');
  assert.equal(seen.length, 0);
});

// A backend lives in the persona's private layer: with no test factory the run starts the binary of `<private>/subharness/<backend>/` with that folder's home, and is refused while it is absent.

/** The rig with the real backend factory and the host PATH of this process, so a shell script can run. */
function realRig(backend: 'codex' | 'claude') {
  const { privateDir } = rig({ backend });
  const deps: RunDeps = { privateDir, hostEnv: { PATH: process.env.PATH ?? '/usr/bin:/bin' } };
  return { deps, privateDir };
}

test('an agent run is refused not-installed while the stored backend is not in the private folder', async () => {
  // Catches: runAgent creates the backend by name, so the codex on the user's PATH runs on the user's own login.
  const { deps } = realRig('codex');
  const result = await runAgent(request('scout'), deps);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'not-installed');
});

test('an agent run starts the binary in the private folder with its home in the environment', async () => {
  // Catches: the seam passes the mode's PATH but drops the place's environment, so claude writes the user's ~/.claude.
  const { deps, privateDir } = realRig('claude');
  const place = subharnessPlace(privateDir, 'claude');
  fs.mkdirSync(path.dirname(place.binary), { recursive: true });
  fs.writeFileSync(place.binary, '#!/bin/sh\ncat >/dev/null\necho "home=$CLAUDE_CONFIG_DIR"\n', { mode: 0o755 });
  fs.chmodSync(place.binary, 0o755);
  const result = await runAgent(request('scout', { cwd: tempDir('nep-run-cwd-') }), deps);
  assert.equal(result.ok, true);
  assert.equal(result.text, `home=${place.env.CLAUDE_CONFIG_DIR ?? ''}`);
});

// Several subharnesses: an agent runs through the backend `subharness.uses` names for it, else
// through the first connected one; a named backend that is not connected refuses the run.

/** A rig whose keys.json holds the list `backends` and the agents' `uses`. */
function listRig(
  backends: Array<'codex' | 'claude' | 'opencode'>,
  uses: Record<string, 'codex' | 'claude' | 'opencode'>
) {
  const r = rig({ backend: null });
  writeKeysFile(r.privateDir, {
    core: [{ name: 'core-1', value: CORE_SECRET }],
    extra: { opencode: OC_SECRET },
    // The old single field stays beside the list, as in a store written before it: the list is what counts.
    subharness: { backend: backends[0] ?? null, backends, uses, key: null, modes: {} },
  });
  return r;
}

test('an agent runs through the backend named for it when that one is connected', async () => {
  // Catches: the run always takes the first backend, so an agent set to claude still runs on codex.
  const { deps, seen } = listRig(['codex', 'claude'], { server: 'claude' });
  await runAgent(request('server'), deps);
  assert.equal(seen[0]?.name, 'claude');
});

// The model id of an agent on opencode: opencode names a model by its provider, and the one provider it has is
// OpenRouter (it gets OPENROUTER_API_KEY and nothing else), so `opencode run -m google/x` exits 1 where
// `-m openrouter/google/x` answers. A typed `/model set <agent> <id> --via opencode` stores the id with `openrouter/`, and
// a bare id already in keys.json or in a task's route runs with it. The binaries are fakes, no request goes out.

const KEY = 'sk-or-v1-helpers-fake-0123456789';

/** A private dir whose opencode is installed and logged in on the extra key `helpers`, with the scout's stored path. */
function installed(models: Record<string, string> = {}): string {
  const dir = tempDir('nep-oc-model-');
  writeKeysFile(dir, {
    extra: { helpers: KEY },
    subharness: { key: 'helpers', modes: {}, models, uses: { scout: 'opencode' } },
  });
  const { binary } = subharnessPlace(dir, 'opencode');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, '#!/bin/sh\nexit 9\n', { mode: 0o755 });
  return dir;
}

/** Run deps whose backend records the options it was started with. */
function recording(dir: string): { deps: RunDeps; seen: Array<BackendRunOptions> } {
  const seen: Array<BackendRunOptions> = [];
  return {
    seen,
    deps: {
      privateDir: dir,
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

const scoutRun = (dir: string): AgentRun => ({ agent: 'scout', brief: 'B', cwd: dir, timeoutMs: 5_000 });

test('a bare opencode model stored in keys.json runs with openrouter/', async () => {
  // Bug: a deployment that stored the bare id keeps failing until the model is set again.
  const dir = installed({ scout: 'google/gemini-4-argon' });
  const { deps, seen } = recording(dir);
  const done = await runAgent(scoutRun(dir), deps);
  assert.equal(done.ok, true);
  assert.equal(seen[0]?.model, 'openrouter/google/gemini-4-argon');
});

test('a bare opencode model in a task route runs with openrouter/', async () => {
  // Bug: the runner unit, which never opens keys.json, starts opencode with the route's bare id and exits 1.
  const dir = installed();
  const { deps, seen } = recording(dir);
  const done = await runAgent(
    {
      ...scoutRun(dir),
      route: { backend: 'opencode', model: 'google/gemini-4-argon', effort: null, mode: 'write' },
      routeKey: KEY,
    },
    deps
  );
  assert.equal(done.ok, true);
  assert.equal(seen[0]?.model, 'openrouter/google/gemini-4-argon');
});

test('a codex model in a task route runs as stored, with no openrouter/', async () => {
  // Bug: the prefix is put on every backend's model, and codex refuses `openrouter/gpt-6-sol`.
  const dir = installed();
  const { deps, seen } = recording(dir);
  await runAgent(
    { ...scoutRun(dir), route: { backend: 'codex', model: 'gpt-6-sol', effort: null, mode: 'write' } },
    deps
  );
  assert.equal(seen[0]?.model, 'gpt-6-sol');
});

// src/subharness/run.ts with a route the core decided and sent inside the task. The scout unit hides keys.json from the
// runner, so a run with a route takes everything from the route. The backend is a fake that records what it was given.
const STORE_SECRET = 'sk-or-v1-store-secret-0123456789';

const TASK_SECRET = 'sk-or-v1-task-secret-9876543210';

const ROUTE: TaskRoute = { backend: 'claude', model: 'claude-opus-5-5', effort: 'medium', mode: 'read' };

const OPENCODE: TaskRoute = { backend: 'opencode', model: null, effort: null, mode: 'write' };

/** keys.json says the opposite of ROUTE on every field, so a run that reads it is visible. */
function routeRig() {
  const privateDir = tempDir('nep-route-priv-');
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
    hostEnv: { PATH: '/usr/bin:/bin' },
    backendFactory: (name) => ({
      name,
      run: (_brief: string, options: BackendRunOptions) => {
        seen.push({ name, options });
        return Promise.resolve({ ok: true, text: 'done', exitCode: 0 });
      },
    }),
  };
  return { deps, privateDir, seen };
}

const routeRequest = (extra: Partial<AgentRun>): AgentRun => ({
  agent: 'scout',
  brief: 'look at the disk',
  cwd: '/tmp/x',
  timeoutMs: 1000,
  ...extra,
});

test('a route runs its own backend, model, effort and mode over what keys.json says', async () => {
  // Catches: keys.json still decides one of the four fields, so the errand runs on another model or sandbox than the core chose.
  const { deps, seen } = routeRig();
  const result = await runAgent(routeRequest({ route: ROUTE }), deps);
  assert.equal(result.ok, true);
  assert.equal(seen[0]?.name, 'claude');
  const [firstRun] = seen;
  assert.equal(firstRun?.options.model, 'claude-opus-5-5');
  assert.equal(firstRun?.options.effort, 'medium');
  assert.equal(firstRun?.options.sandbox, 'read-only');
});

test('a route runs when keys.json is absent, as it is under the scout unit', async () => {
  // Catches: the run reads keys.json first, finds the empty store of ENOENT, and every scout errand fails subharness-off.
  const { deps, seen, privateDir } = routeRig();
  fs.rmSync(keysPath(privateDir));
  const result = await runAgent(routeRequest({ route: ROUTE }), deps);
  assert.equal(result.ok, true);
  assert.equal(seen[0]?.name, 'claude');
});

test('a route runs when keys.json is no JSON, because a run with a route does not read it', async () => {
  // Catches: the store is read before the route is looked at, so a broken file refuses a run that needs nothing from it.
  const { deps, seen, privateDir } = routeRig();
  fs.writeFileSync(keysPath(privateDir), '{not json');
  const result = await runAgent(routeRequest({ route: ROUTE }), deps);
  assert.equal(result.ok, true);
  assert.equal(seen[0]?.name, 'claude');
});

test('a route with no model and no effort passes neither, whatever keys.json names for the agent', async () => {
  // Catches: a null field falls through to the stored model, so the backend's default becomes a model the core did not choose.
  const { deps, seen } = routeRig();
  await runAgent(routeRequest({ route: { backend: 'claude', model: null, effort: null, mode: 'write' } }), deps);
  assert.equal(seen[0]?.name, 'claude');
  assert.equal(Object.hasOwn(seen[0]?.options ?? {}, 'model'), false);
  assert.equal(Object.hasOwn(seen[0]?.options ?? {}, 'effort'), false);
});

for (const [mode, sandbox] of [
  ['read', 'read-only'],
  ['write', 'workspace-write'],
  ['full', 'none'],
  ['sudo', 'none'],
] as const) {
  test(`a route in mode ${mode} sets the sandbox ${sandbox} by the route's mode`, async () => {
    // The PATH is the host's in every mode, so only the sandbox follows the route's mode.
    // Catches: the sandbox follows keys.json instead of the route.
    const { deps, seen, privateDir } = routeRig();
    await setUnitMode(privateDir, 'scout', mode === 'sudo' ? 'read' : 'sudo');
    await runAgent(routeRequest({ route: { ...ROUTE, mode } }), deps);
    assert.equal(seen[0]?.name, 'claude');
    const [firstRun] = seen;
    assert.equal(firstRun?.options.sandbox, sandbox);
  });
}

test('a route in full writes the log line of a run without a sandbox', async () => {
  // Catches: the route path skips the line, so the log stops showing who worked without a sandbox.
  const { deps } = routeRig();
  const { logs } = await withCapturedLogs(() => runAgent(routeRequest({ route: { ...ROUTE, mode: 'full' } }), deps));
  const line = logs.find((entry) => JSON.stringify(entry).includes('without a sandbox'));
  assert.equal(line?.mode, 'full');
  assert.equal(line?.agent, 'scout');
});

test("an opencode route takes the task's key, not the key keys.json holds", async () => {
  // Catches: the run reaches for the store's extra key, which the scout unit hides, or spends another key than the task brought.
  const { deps, seen } = routeRig();
  const result = await runAgent(routeRequest({ route: OPENCODE, routeKey: TASK_SECRET }), deps);
  assert.equal(result.ok, true);
  assert.equal(seen[0]?.name, 'opencode');
  const [firstRun] = seen;
  const runEnv = firstRun?.options.env;
  assert.equal(runEnv?.OPENROUTER_API_KEY, TASK_SECRET);
});

test('an opencode route gets no step limit in its inline config', async () => {
  // OpenCode gets no step cap, because at the cap it appends an assistant turn that Gemini and Anthropic refuse. Catches: the route path brings the cap back.
  const { deps, seen } = routeRig();
  await runAgent(routeRequest({ route: OPENCODE, routeKey: TASK_SECRET, maxSteps: 7 }), deps);
  const [firstRun] = seen;
  const runEnv = firstRun?.options.env;
  assert.equal(runEnv?.OPENCODE_CONFIG_CONTENT, undefined);
});

test('an opencode route with no key fails route-no-key and starts nothing, though keys.json holds one', async () => {
  // Catches: the run falls back to the store's key, or starts opencode with no key and reports a provider error instead of the cause.
  const { deps, seen } = routeRig();
  const result = await runAgent(routeRequest({ route: OPENCODE }), deps);
  assert.equal(result.ok, false);
  assert.equal(result.error, 'route-no-key');
  assert.equal(result.exitCode, null);
  assert.equal(seen.length, 0);
});

test('a claude route gives the child no key, though the task brought one', async () => {
  // Catches: the key of the task reaches a CLI that brings its own login, so a model key sits in the environment of its commands.
  const { deps, seen } = routeRig();
  await runAgent(routeRequest({ route: ROUTE, routeKey: TASK_SECRET }), deps);
  assert.equal(seen[0]?.name, 'claude');
  const [firstRun] = seen;
  const runEnv = firstRun?.options.env;
  assert.equal(runEnv?.OPENROUTER_API_KEY, undefined);
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
    const { deps, seen } = routeRig();
    const result = await runAgent(routeRequest({ route: route as unknown as TaskRoute }), deps);
    assert.equal(result.ok, false);
    assert.equal(result.error, 'bad-route');
    assert.equal(result.exitCode, null);
    assert.equal(seen.length, 0);
  });
}

// The PATH and key of an agent's child on claude and codex routes. The child is a real disposable shell started by a
// fake backend with the environment the backend would give it (childEnvOf of the run's options.env). The PATH is the
// host PATH in every mode, and a claude or codex child has no OPENROUTER_API_KEY.
const TASK_KEY = 'sk-or-v1-task-secret-0123456789';

const CHILD_HOST_PATH = `${path.dirname(process.execPath)}:/usr/bin:/bin`;

const ROUTES: Record<BackendName, TaskRoute> = {
  claude: { backend: 'claude', model: 'claude-opus-5-5', effort: 'medium', mode: 'write' },
  codex: { backend: 'codex', model: 'gpt-6-sol', effort: 'medium', mode: 'write' },
  opencode: { backend: 'opencode', model: null, effort: null, mode: 'write' },
};

type ToolSeen = { key: string; path: string };

/** A fake backend that starts a real `sh` in the run's environment and records what the shell finds. */
function toolRig() {
  const base = tempDir('nep-toolpath-');
  const privateDir = path.join(base, 'private');
  writeKeysFile(privateDir, { subharness: { backends: [], key: null, modes: {} } });
  const seen: Array<ToolSeen> = [];
  const subharness: RunDeps = {
    privateDir,
    hostEnv: { PATH: CHILD_HOST_PATH },
    backendFactory: (name) => ({
      name,
      run: (_brief: string, options: BackendRunOptions) => {
        const env = childEnvOf(options.env);
        const sh = (script: string) =>
          execFileSync('/bin/sh', ['-c', script], { env, cwd: base, encoding: 'utf8' }).trim();
        seen.push({
          key: sh('printf %s "${OPENROUTER_API_KEY-}"'),
          path: sh('printf %s "$PATH"'),
        });
        return Promise.resolve({ ok: true, text: 'answer', exitCode: 0 });
      },
    }),
  };
  return { base, subharness, seen };
}

/** An engine over the real profile of `agent`, with a prompt file that exists. */
function engineOf(agent: string, base: string, subharness: RunDeps) {
  const real = profileOf(agent);
  assert.ok(real, `profile ${agent}`);
  const prompt = path.join(base, `${agent}.md`);
  fs.writeFileSync(prompt, 'You are an errand agent.');
  return createAgentEngine({ profile: { ...real, promptFiles: [prompt] }, outDir: path.join(base, 'out'), subharness });
}

const task = (route: TaskRoute) =>
  ({ id: 't1', goal: 'look it up', context: {}, route, secrets: { openrouterKey: TASK_KEY } }) as unknown as Parameters<
    ReturnType<typeof createAgentEngine>['run']
  >[0];

for (const name of ['claude', 'codex'] as const) {
  test(`a server run on ${name} has the host PATH and no key`, async () => {
    // Catches: a tool folder or the key leaking to a claude or codex child.
    const { base, subharness, seen } = toolRig();
    await engineOf('server', base, subharness).run(task(ROUTES[name]));
    assert.equal(seen[0]?.key, '');
    // The child gets the host PATH unchanged; the unit, not the engine, stops sudo.
    assert.equal(seen[0]?.path, CHILD_HOST_PATH);
  });
}

test('a dev run through runAgent on claude has no extra PATH folder and no key', async () => {
  // Catches: an extra PATH folder or the key becoming a default of every run.
  const { subharness, seen } = toolRig();
  const done = await runAgent(
    {
      agent: 'dev',
      brief: 'x',
      cwd: tempDir('nep-toolpath-cwd-'),
      timeoutMs: 1000,
      route: ROUTES.claude,
      routeKey: TASK_KEY,
    },
    subharness
  );
  assert.equal(done.ok, true);
  assert.equal(seen[0]?.key, '');
  // The child gets the host PATH unchanged; the unit, not the engine, stops sudo.
  assert.equal(seen[0]?.path, CHILD_HOST_PATH);
});

// An errand agent searches with its harness's own tools. An OpenRouter key exists inside an agent only on the OpenCode
// route, with that route's model and key. The child is a real disposable shell started by a fake backend with the
// environment the backend would give it (childEnvOf of the run's options.env), so what it finds on PATH and in its
// environment is what a real claude, codex or opencode child would see.
type ScoutSeen = { env: Record<string, string>; webSearch: string; path: string };

function scoutRig() {
  const base = tempDir('nep-scout-search-');
  const privateDir = path.join(base, 'private');
  writeKeysFile(privateDir, { subharness: { backends: [], key: null, modes: {} } });
  const seen: Array<ScoutSeen> = [];
  const subharness: RunDeps = {
    privateDir,
    hostEnv: { PATH: CHILD_HOST_PATH },
    backendFactory: (name) => ({
      name,
      run: (_brief: string, options: BackendRunOptions) => {
        const env = childEnvOf(options.env);
        const sh = (script: string) =>
          execFileSync('/bin/sh', ['-c', script], { env, cwd: base, encoding: 'utf8' }).trim();
        seen.push({ env, webSearch: sh('command -v web-search || true'), path: sh('printf %s "$PATH"') });
        return Promise.resolve({ ok: true, text: 'answer', exitCode: 0 });
      },
    }),
  };
  return { base, subharness, seen };
}

async function runScout(backend: BackendName) {
  const { base, subharness, seen } = scoutRig();
  const real = profileOf('scout');
  assert.ok(real, 'profile scout');
  const prompt = path.join(base, 'scout.md');
  fs.writeFileSync(prompt, 'You are an errand agent.');
  const engine = createAgentEngine({
    profile: { ...real, promptFiles: [prompt] },
    outDir: path.join(base, 'out'),
    subharness,
  });
  const outcome = await engine.run({
    id: 't1',
    goal: 'look it up',
    context: {},
    route: ROUTES[backend],
    secrets: { openrouterKey: TASK_KEY },
  } as unknown as Parameters<typeof engine.run>[0]);
  return { outcome, seen: seen[0] };
}

for (const backend of ['claude', 'codex'] as const) {
  test(`a scout run on ${backend} has no OpenRouter key of any name in its child environment`, async () => {
    // Catches: the task key reaching a harness that searches with its own tools (it leaked to feed a shell command).
    const { outcome, seen } = await runScout(backend);
    assert.equal(outcome.status, 'done');
    assert.ok(seen);
    const named = Object.keys(seen.env).filter((k) => /openrouter/i.test(k));
    assert.deepEqual(named, []);
    assert.ok(!Object.values(seen.env).some((v) => v.includes(TASK_KEY)));
  });
}

test('a scout run on opencode gets the route key as OPENROUTER_API_KEY and no web-search command', async () => {
  // Catches: removing the shell command also removing the key the opencode route needs for its own websearch tool.
  const { seen } = await runScout('opencode');
  assert.ok(seen);
  assert.equal(seen.env.OPENROUTER_API_KEY, TASK_KEY);
  assert.equal(seen.webSearch, '');
  // The child gets the host PATH unchanged; the unit, not the engine, stops sudo.
  assert.equal(seen.path, CHILD_HOST_PATH);
});

// src/agent-runner/backend.ts#createAgentEngine over a real backend with a fake spawn: the task's `secrets.searchKey` is
// the child's `EXA_API_KEY`, beside `OPENCODE_ENABLE_EXA=1`, for an OpenCode run whose search provider is `exa` and for
// no other run. The key never appears in the child's arguments. The child is a fake; no request goes out.
type Task = Parameters<ReturnType<typeof createAgentEngine>['run']>[0];

const OR_KEY = 'sk-or-v1-task-secret-0123456789';

const EXA_KEY = 'exa-task-secret-9876543210';

const route = (backend: TaskRoute['backend']): TaskRoute => ({ backend, model: null, effort: null, mode: 'read' });

const TASK = { id: 't1', goal: 'find the release notes', context: {} } as unknown as Task;

type KeySeen = { env: Record<string, string>; args: Array<string> };

/** One engine run of the task `extra`; returns what each child saw. */
async function keyRunOnce(extra: Record<string, unknown>): Promise<Array<KeySeen>> {
  const base = tempDir('nep-oc-exakey-');
  const binary = path.join(base, 'fake-binary');
  fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const prompt = path.join(base, 'agent.md');
  fs.writeFileSync(prompt, 'You are an errand agent.');
  const seen: Array<KeySeen> = [];
  const impl = (_binary: string, args: Array<string>, options: { env: Record<string, string> }) => {
    seen.push({ env: options.env, args });
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      pid: undefined,
      kill: () => true,
    });
    child.stdin.resume();
    setImmediate(() => child.emit('close', 0));
    return child;
  };
  const profile = {
    name: 'scout',
    agentId: 'errand-scout',
    promptFiles: [prompt],
    defaultLimits: { steps: 5, seconds: 30 },
    sandbox: 'read-only',
    unit: 'scout',
  };
  const engine = createAgentEngine({
    profile: profile as unknown as Parameters<typeof createAgentEngine>[0]['profile'],
    outDir: path.join(base, 'out'),
    subharness: {
      privateDir: path.join(base, 'private'),
      hostEnv: { PATH: '/usr/bin' },
      backendFactory: (name) => createBackend(name, { binary, spawnImpl: wrongly<typeof spawn>(impl) }),
    },
  });
  await engine.run({ ...TASK, ...extra });
  return seen;
}

test('an opencode run with exa and a searchKey gets EXA_API_KEY and OPENCODE_ENABLE_EXA, and the key is in no argument', async () => {
  // Catches: the stored key reaching the task but not the child, or leaking into the command line where ps shows it.
  const [child] = await keyRunOnce({
    id: 'k1',
    route: route('opencode'),
    secrets: { openrouterKey: OR_KEY, searchKey: EXA_KEY },
  });
  assert.ok(child, 'the child was spawned');
  assert.equal(child.env.EXA_API_KEY, EXA_KEY);
  assert.equal(child.env.OPENCODE_ENABLE_EXA, '1');
  assert.equal(
    child.args.some((arg) => arg.includes(EXA_KEY)),
    false
  );
});

test('an opencode run whose task names another search provider gets no EXA_API_KEY although the task carries one', async () => {
  // Catches: the key handed to a run that never uses Exa.
  const [child] = await keyRunOnce({
    id: 'k3',
    route: route('opencode'),
    searchProvider: 'brave',
    secrets: { openrouterKey: OR_KEY, searchKey: EXA_KEY },
  });
  assert.ok(child, 'the child was spawned');
  assert.equal(Object.hasOwn(child.env, 'EXA_API_KEY'), false);
});

for (const backend of ['claude', 'codex'] as const) {
  test(`a ${backend} run whose task carries a searchKey gets no EXA_API_KEY`, async () => {
    // Catches: the Exa key reaching a Claude or Codex child, which have web tools of their own.
    const [child] = await keyRunOnce({
      id: `k-${backend}`,
      route: route(backend),
      searchProvider: 'exa',
      secrets: { searchKey: EXA_KEY },
    });
    assert.ok(child, 'the child was spawned');
    assert.equal(Object.hasOwn(child.env, 'EXA_API_KEY'), false);
    assert.equal(
      Object.values(child.env).some((value) => value.includes(EXA_KEY)),
      false
    );
  });
}

// src/agent-runner/backend.ts#createAgentEngine over a real backend with a fake spawn: OpenCode's own `websearch` tool
// (Exa's free hosted endpoint, no key) is switched on by `OPENCODE_ENABLE_EXA=1` in the child's environment, and only for
// an OpenCode run whose search provider is `exa`, the task's or else the default `exa`. The
// child is a fake; no request goes out.
type Json = Record<string, unknown>;

/** What the fake child saw: its environment and the config file it would load, read while it ran. */
type ExaSeen = { env: Record<string, string>; config: Json };

/** One engine run of the task `extra`; returns what each spawned child saw. */
async function exaRunOnce(extra: Record<string, unknown>): Promise<Array<ExaSeen>> {
  const base = tempDir('nep-oc-exa-');
  const binary = path.join(base, 'fake-binary');
  fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const prompt = path.join(base, 'agent.md');
  fs.writeFileSync(prompt, 'You are an errand agent.');
  const seen: Array<ExaSeen> = [];
  const impl = (_binary: string, _args: Array<string>, options: { env: Record<string, string> }) => {
    const file = options.env.OPENCODE_CONFIG;
    seen.push({
      env: options.env,
      config: file === undefined ? {} : (JSON.parse(fs.readFileSync(file, 'utf8')) as Json),
    });
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      pid: undefined,
      kill: () => true,
    });
    child.stdin.resume();
    child.stdin.on('end', () => setImmediate(() => child.emit('close', 0)));
    setImmediate(() => child.emit('close', 0));
    return child;
  };
  const profile = {
    name: 'scout',
    agentId: 'errand-scout',
    promptFiles: [prompt],
    defaultLimits: { steps: 5, seconds: 30 },
    sandbox: 'read-only',
    unit: 'scout',
  };
  const engine = createAgentEngine({
    profile: profile as unknown as Parameters<typeof createAgentEngine>[0]['profile'],
    outDir: path.join(base, 'out'),
    subharness: {
      privateDir: path.join(base, 'private'),
      hostEnv: { PATH: '/usr/bin' },
      backendFactory: (name) => createBackend(name, { binary, spawnImpl: wrongly<typeof spawn>(impl) }),
    },
  });
  await engine.run({ ...TASK, ...extra });
  return seen;
}

test('an opencode run of any agent gets OPENCODE_ENABLE_EXA and no Exa key', async () => {
  // Catches: OpenCode agents keep only webfetch and bash because the allowlisted child environment never switches websearch on.
  const [child] = await exaRunOnce({ id: 'e1', route: route('opencode'), secrets: { openrouterKey: TASK_KEY } });
  assert.ok(child, 'the child was spawned');
  assert.equal(child.env.OPENCODE_ENABLE_EXA, '1');
  assert.equal(Object.hasOwn(child.env, 'EXA_API_KEY'), false);
});

test('an opencode run whose task names exa gets OPENCODE_ENABLE_EXA', async () => {
  // Catches: a task's own searchProvider is ignored.
  const [child] = await exaRunOnce({
    id: 'e2',
    route: route('opencode'),
    secrets: { openrouterKey: TASK_KEY },
    searchProvider: 'exa',
  });
  assert.ok(child, 'the child was spawned');
  assert.equal(child.env.OPENCODE_ENABLE_EXA, '1');
  assert.equal(Object.hasOwn(child.env, 'EXA_API_KEY'), false);
});

test('an opencode run whose task names another search provider gets neither OPENCODE_ENABLE_EXA nor EXA_API_KEY', async () => {
  // Catches: the default exa overrides the provider the task named.
  const [child] = await exaRunOnce({
    id: 'e3',
    route: route('opencode'),
    secrets: { openrouterKey: TASK_KEY },
    searchProvider: 'brave',
  });
  assert.ok(child, 'the child was spawned');
  assert.equal(Object.hasOwn(child.env, 'OPENCODE_ENABLE_EXA'), false);
  assert.equal(Object.hasOwn(child.env, 'EXA_API_KEY'), false);
});

for (const backend of ['claude', 'codex'] as const) {
  test(`a ${backend} run never gets OPENCODE_ENABLE_EXA`, async () => {
    // Catches: the Exa switch leaks into a backend that has its own web tools.
    const [child] = await exaRunOnce({ id: `e-${backend}`, route: route(backend), searchProvider: 'exa' });
    assert.ok(child, 'the child was spawned');
    assert.equal(Object.hasOwn(child.env, 'OPENCODE_ENABLE_EXA'), false);
    assert.equal(Object.hasOwn(child.env, 'EXA_API_KEY'), false);
  });
}

// The task engine of the runner (src/agent-runner/backend.ts#createAgentEngine) takes every key from the task: the
// OpenRouter key and the proxy from `task.secrets`, never from the runner's environment. OPENROUTER_ERRAND_KEY,
// OPENCODE_WEBSEARCH_KEY and PROXY_URL set in the process, in the engine's `env` or in the subharness `hostEnv` change
// nothing. The profiles declare no such names. The child is a fake; no request goes out.
const ENV_KEY = 'sk-env-ERRAND-SECRET';

const ENV_SEARCH = 'env-SEARCH-SECRET';

const ENV_PROXY = 'http://envlogin:envpw@env-proxy.example:8080';

const POISON = {
  OPENROUTER_ERRAND_KEY: ENV_KEY,
  OPENCODE_WEBSEARCH_KEY: ENV_SEARCH,
  PROXY_URL: ENV_PROXY,
  OPENROUTER_API_KEY: ENV_KEY,
  HTTPS_PROXY: ENV_PROXY,
  HTTP_PROXY: ENV_PROXY,
};

const TASK_PROXY = 'http://tasklogin:taskpw@task-proxy.example:3128';

/** Runs `body` with the poisoned variables set in this process, and restores them. */
async function withPoisonedProcess<T>(body: () => Promise<T>): Promise<T> {
  const before = Object.fromEntries(Object.keys(POISON).map((name) => [name, process.env[name]]));
  Object.assign(process.env, POISON);
  try {
    return await body();
  } finally {
    for (const [name, value] of Object.entries(before)) {
      if (value === undefined) delete process.env[name];
      else process.env[name] = value;
    }
  }
}

/** One engine run with the poison in the process, the engine's `env` and the host env; returns the environment of each child and the outcome. */
async function poisonedRun(extra: Record<string, unknown>) {
  return withPoisonedProcess(async () => {
    const base = tempDir('nep-no-env-keys-');
    const binary = path.join(base, 'fake-binary');
    fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
    const prompt = path.join(base, 'agent.md');
    fs.writeFileSync(prompt, 'You are an errand agent.');
    const children: Array<Record<string, string>> = [];
    const impl = (_binary: string, _args: Array<string>, options: { env: Record<string, string> }) => {
      children.push(options.env);
      const child = Object.assign(new EventEmitter(), {
        stdout: new PassThrough(),
        stderr: new PassThrough(),
        stdin: new PassThrough(),
        pid: undefined,
        kill: () => true,
      });
      child.stdin.resume();
      child.stdin.on('end', () => setImmediate(() => child.emit('close', 0)));
      setImmediate(() => child.emit('close', 0));
      return child;
    };
    const profile = {
      name: 'scout',
      agentId: 'errand-scout',
      promptFiles: [prompt],
      defaultLimits: { steps: 5, seconds: 30 },
      defaultSearchProvider: 'exa',
      sandbox: 'read-only',
      unit: 'scout',
    };
    const engine = createAgentEngine({
      profile: profile as unknown as Parameters<typeof createAgentEngine>[0]['profile'],
      outDir: path.join(base, 'out'),
      env: POISON,
      subharness: {
        privateDir: path.join(base, 'private'),
        hostEnv: { PATH: '/usr/bin', ...POISON },
        backendFactory: (name) => createBackend(name, { binary, spawnImpl: wrongly<typeof spawn>(impl) }),
      },
    });
    const outcome = await engine.run({ ...TASK, ...extra });
    return { children, outcome };
  });
}

const leaked = (env: Record<string, string>): Array<string> =>
  Object.entries(env)
    .filter(([, value]) => [ENV_KEY, ENV_SEARCH, ENV_PROXY].some((secret) => value.includes(secret)))
    .map(([name]) => name);

test('an opencode task with no key in its secrets fails route-no-key and starts no child, whatever the environment holds', async () => {
  // Bug: the runner falls back to OPENROUTER_ERRAND_KEY from its environment and runs on a key the core never sent.
  const { children, outcome } = await poisonedRun({ id: 'n1', route: route('opencode') });
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.error, 'route-no-key');
  assert.equal(children.length, 0);
});

test('an opencode task with a key in its secrets runs on that key, with no variable of the environment in the child', async () => {
  // Bug: OPENCODE_WEBSEARCH_KEY or PROXY_URL from the runner's environment reaches the child beside the task's key.
  const { children } = await poisonedRun({ id: 'n2', route: route('opencode'), secrets: { openrouterKey: TASK_KEY } });
  assert.equal(children.length, 1);
  const child = children[0] ?? {};
  assert.equal(child.OPENROUTER_API_KEY, TASK_KEY);
  assert.deepEqual(leaked(child), []);
  for (const name of ['OPENROUTER_ERRAND_KEY', 'OPENCODE_WEBSEARCH_KEY', 'PROXY_URL'])
    assert.equal(Object.hasOwn(child, name), false, name);
  for (const name of PROXY_ENV_NAMES) assert.equal(Object.hasOwn(child, name), false, name);
});

for (const backend of ['claude', 'codex', 'opencode'] as const) {
  test(`a ${backend} task with no proxy in its secrets gets no proxy variable, although the environment sets one`, async () => {
    // Bug: the runner's own HTTPS_PROXY or PROXY_URL is inherited by the child, so a run meant to go direct goes out through the proxy.
    const { children } = await poisonedRun({
      id: `p-${backend}`,
      route: route(backend),
      ...(backend === 'opencode' ? { secrets: { openrouterKey: TASK_KEY } } : {}),
    });
    assert.equal(children.length, 1);
    for (const name of [...PROXY_ENV_NAMES, 'PROXY_URL'])
      assert.equal(Object.hasOwn(children[0] ?? {}, name), false, name);
  });

  test(`a ${backend} task with a proxy in its secrets gets that proxy and never the environment's`, async () => {
    // Bug: the environment's proxy wins over the task's, or the task's reaches only some of the variable spellings.
    const { children } = await poisonedRun({
      id: `q-${backend}`,
      route: route(backend),
      secrets: { ...(backend === 'opencode' ? { openrouterKey: TASK_KEY } : {}), proxy: TASK_PROXY },
    });
    assert.equal(children.length, 1);
    const child = children[0] ?? {};
    for (const name of ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy'])
      assert.equal(child[name], TASK_PROXY, name);
    assert.deepEqual(leaked(child), []);
  });
}

// Every harness child reaches the network through the engine proxy while it is in force, as HTTPS_PROXY and HTTP_PROXY
// in the http form, and gets no proxy variable on the direct path. A fake backend records what it was given.
const PROXY = 'socks5h://login:pass-word@proxy.example:1080';

const HTTP_FORM = 'http://login:pass-word@proxy.example:1080';

const PROXY_NAMES = ['HTTPS_PROXY', 'HTTP_PROXY', 'https_proxy', 'http_proxy'];

const CLAUDE: TaskRoute = { backend: 'claude', model: 'claude-opus-5-5', effort: 'medium', mode: 'read' };

function recordingDeps(): { deps: RunDeps; seen: Array<BackendRunOptions> } {
  const base = tempDir('nep-proxy-harness-');
  const privateDir = path.join(base, 'private');
  writeKeysFile(privateDir, { subharness: { backends: ['codex'], key: null, modes: {} } });
  const seen: Array<BackendRunOptions> = [];
  const deps: RunDeps = {
    privateDir,
    hostEnv: { PATH: '/usr/bin', HTTPS_PROXY: 'http://host-proxy.invalid:9' },
    backendFactory: (name) => ({
      name,
      run: (_brief: string, options: BackendRunOptions) => {
        seen.push(options);
        return Promise.resolve({ ok: true, text: 'done', exitCode: 0 });
      },
    }),
  };
  return { deps, seen };
}

const RUN = { agent: 'dev', brief: 'look', cwd: '/tmp/x', timeoutMs: 1000 };

test('a run with the engine proxy gives the child every proxy variable in the http form', async () => {
  // Catches: a harness child talks to its vendor straight from the server's address while the proxy is on.
  const { deps, seen } = recordingDeps();
  await runAgent({ ...RUN, route: CLAUDE, proxy: PROXY }, deps);
  const [firstRun] = seen;
  for (const name of PROXY_NAMES) assert.equal(firstRun?.env?.[name], HTTP_FORM, name);
});

test('a run without the engine proxy gives the child no proxy variable, not even the host one', async () => {
  // Catches: after the switch to direct, a child still inherits a proxy variable and fails on the dead proxy.
  const { deps, seen } = recordingDeps();
  await runAgent({ ...RUN, route: CLAUDE }, deps);
  const [firstRun] = seen;
  for (const name of PROXY_NAMES) assert.equal(firstRun?.env?.[name], undefined, name);
});

test('the engine proxy beats a proxy variable the caller put into the run environment', async () => {
  // Catches: a stale HTTPS_PROXY in `run.env` wins over the proxy the core decided for this run.
  const { deps, seen } = recordingDeps();
  await runAgent({ ...RUN, route: CLAUDE, proxy: PROXY, env: { HTTPS_PROXY: 'http://stale.invalid:1' } }, deps);
  const [firstRun] = seen;
  assert.equal(firstRun?.env?.HTTPS_PROXY, HTTP_FORM);
});

// While the proxy is on, every harness child carries NO_PROXY and no_proxy with openrouter.ai beside the local hosts,
// so OpenRouter is reached around the proxy.
/** The entries of a comma list. */
const entriesOf = (list: string | undefined): Array<string> => (list ?? '').split(',').map((entry) => entry.trim());

test('a harness child started with the proxy gets openrouter.ai in NO_PROXY and no_proxy', async () => {
  // Catches: the child's environment is built somewhere other than proxyEnvOf and misses the exception.
  const base = tempDir('nep-proxy-openrouter-');
  const privateDir = path.join(base, 'private');
  writeKeysFile(privateDir, { subharness: { backends: ['codex'], key: null, modes: {} } });
  const seen: Array<BackendRunOptions> = [];
  const deps: RunDeps = {
    privateDir,
    hostEnv: { PATH: '/usr/bin' },
    backendFactory: (name) => ({
      name,
      run: (_brief: string, options: BackendRunOptions) => {
        seen.push(options);
        return Promise.resolve({ ok: true, text: 'done', exitCode: 0 });
      },
    }),
  };
  await runAgent({ agent: 'dev', brief: 'look', cwd: '/tmp/x', timeoutMs: 1000, route: CLAUDE, proxy: PROXY }, deps);
  const childEnv = seen[0]?.env;
  for (const name of ['NO_PROXY', 'no_proxy']) assert.ok(entriesOf(childEnv?.[name]).includes('openrouter.ai'), name);
});

// The runner passes the stored model of each agent on.
test('the runner passes the stored model of the agent and none for an agent without one', async () => {
  // Bug: every agent runs on the one model, or an agent with none gets "undefined" as a flag.
  const dir = tempDir('nep-models-run-');
  writeKeysFile(dir, { subharness: { backend: 'codex', key: null, modes: {}, models: { server: 'gpt-x' } } });
  const seen: Array<BackendRunOptions> = [];
  const deps = {
    privateDir: dir,
    hostEnv: { PATH: '/usr/bin' },
    backendFactory: (name: 'codex' | 'claude' | 'opencode'): Backend => ({
      name,
      run: (_brief, options) => {
        seen.push(options);
        return Promise.resolve({ ok: true, text: 'x', exitCode: 0 });
      },
    }),
  };
  for (const agent of ['server', 'scout']) await runAgent({ agent, brief: 'b', cwd: dir, timeoutMs: 1000 }, deps);
  assert.deepEqual(
    seen.map((one) => one.model),
    ['gpt-x', undefined]
  );
});

// A path per role on the subharness side (spec 2026-11-02 PR 5, "A path per role"): `model set <agent> <model> [--effort
// <level>]` names its model and effort after one reply on the source the store names for it, the status lists each agent's path, and the six direct roles have no subharness path. keys.json lives
// in a temp dir; the backend runner and fetch are fakes, so no process starts and no request goes out.
// Changed: the agent `dev` is gone with the development agents (maintainer, 2026-11-16),
// so the agent checks use `server`.

// the run and the status

test('the runner passes the stored effort of the agent and none for an agent without one', async () => {
  // Catches: the effort is stored but never reaches the CLI, or every agent runs at one agent's effort.
  const dir = tempDir('nep-paths-run-');
  writeKeysFile(dir, {
    subharness: { backends: ['codex'], key: null, modes: {}, models: {}, efforts: { server: 'high' } },
  });
  const seen: Array<BackendRunOptions> = [];
  const deps = {
    privateDir: dir,
    hostEnv: { PATH: '/usr/bin' },
    backendFactory: (name: 'codex' | 'claude' | 'opencode'): Backend => ({
      name,
      run: (_brief, options) => {
        seen.push(options);
        return Promise.resolve({ ok: true, text: 'x', exitCode: 0 });
      },
    }),
  };
  for (const agent of ['server', 'scout']) await runAgent({ agent, brief: 'b', cwd: dir, timeoutMs: 1000 }, deps);
  assert.deepEqual(
    seen.map((one) => one.effort),
    ['high', undefined]
  );
});

// The OpenRouter provider of an opencode route: `/model set <agent> <model> --via opencode --provider <slug>` stores it
// in keys.json (`subharness.providers`, by agent), `/subharness status` shows it, `routeOfAgent` puts it into the task's
// route, and `runAgent` hands it to the backend. The binaries are fakes, no request goes out.
// Changed: the agent `dev` is gone with the development agents (maintainer, 2026-11-16),
// so the agent checks use `server`.

const SUBHARNESS_PROVIDER_KEY = 'sk-or-v1-provider-fake-0123456789';
const MODEL = 'anthropic/claude-sonnet-5';

/** A private dir whose opencode is installed and logged in on the extra key `helpers`. */
function subharnessProviderInstalled(): string {
  const dir = tempDir('nep-provider-');
  writeKeysFile(dir, { extra: { helpers: SUBHARNESS_PROVIDER_KEY }, subharness: { key: 'helpers', modes: {} } });
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

/** Run deps whose backend records the options it was started with. */
function subharnessProviderRecording(dir: string): { deps: RunDeps; seen: Array<BackendRunOptions> } {
  const seen: Array<BackendRunOptions> = [];
  return {
    seen,
    deps: {
      privateDir: dir,
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
  agent: 'server',
  brief: 'B',
  cwd: dir,
  timeoutMs: 5_000,
  ...extra,
});

// the run

test('a run with a route that names a provider hands it to the backend', async () => {
  // Catches: the route is parsed with its pin and the pin is dropped before the backend options are built.
  const dir = subharnessProviderInstalled();
  const { deps, seen } = subharnessProviderRecording(dir);
  const route = {
    backend: 'opencode',
    model: `openrouter/${MODEL}`,
    effort: null,
    // Changed: the agent is the server, whose default mode is `read`, the agent `dev` being gone (2026-11-16).
    mode: 'read',
    provider: 'anthropic',
  } as const;
  const result = await runAgent(devRun(dir, { route, routeKey: SUBHARNESS_PROVIDER_KEY }), deps);
  assert.equal(result.ok, true);
  assert.equal(seen[0].provider, 'anthropic');
});

test('a run from keys.json hands the stored provider to the backend', async () => {
  // Catches: only the route path carries the pin, so a run on the owner's own machine (no route) goes out unpinned.
  const dir = subharnessProviderInstalled();
  await setAgentModel(selectionDeps(dir), 'server', MODEL, undefined, 'opencode', 'anthropic');
  const { deps, seen } = subharnessProviderRecording(dir);
  const result = await runAgent(devRun(dir), deps);
  assert.equal(result.ok, true);
  assert.equal(seen[0].provider, 'anthropic');
});

test('a run with no provider hands the backend no provider option', async () => {
  // Catches: an empty string or null passed down, which a backend would write as a pin to nothing.
  const dir = subharnessProviderInstalled();
  const { deps, seen } = subharnessProviderRecording(dir);
  const route = { backend: 'opencode', model: `openrouter/${MODEL}`, effort: null, mode: 'write' } as const;
  await runAgent(devRun(dir, { route, routeKey: SUBHARNESS_PROVIDER_KEY }), deps);
  assert.equal(Object.hasOwn(seen[0], 'provider'), false);
});

test('a run whose route puts a provider on claude is refused as bad-route and starts nothing', async () => {
  // Catches: the runner honouring a pin it cannot apply, so the errand runs at whatever provider claude uses.
  const dir = subharnessProviderInstalled();
  const { deps, seen } = subharnessProviderRecording(dir);
  const route = { backend: 'claude', model: 'sonnet', effort: null, mode: 'write', provider: 'anthropic' } as const;
  const result = await runAgent(devRun(dir, { route }), deps);
  assert.equal(result.error, 'bad-route');
  assert.deepEqual(seen, []);
});
