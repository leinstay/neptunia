// The task engine of the runner (src/agent-runner/backend.ts#createAgentEngine) takes every key from the task: the
// OpenRouter key and the proxy from `task.secrets`, never from the runner's environment. OPENROUTER_ERRAND_KEY,
// OPENCODE_WEBSEARCH_KEY and PROXY_URL set in the process, in the engine's `env` or in the subharness `hostEnv` change
// nothing. The profiles declare no such names. The child is a fake; no request goes out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import type { spawn } from 'node:child_process';
import { createAgentEngine, createBackend } from '../src/agent-runner/backend.ts';
import type { TaskRoute } from '../src/agent-runner/protocol.ts';
import { profileOf } from '../src/agent-runner/profiles.ts';
import { PROXY_ENV_NAMES } from '../src/net/proxy.ts';
import { wrongly } from './fixtures/loose-types.ts';
import { tempDir } from './fixtures/tmp.ts';

type Task = Parameters<ReturnType<typeof createAgentEngine>['run']>[0];

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
const TASK_KEY = 'sk-or-v1-task-secret-0123456789';
const TASK_PROXY = 'http://tasklogin:taskpw@task-proxy.example:3128';
const route = (backend: TaskRoute['backend']): TaskRoute => ({ backend, model: null, effort: null, mode: 'read' });
const TASK = { id: 't1', goal: 'find the release notes', context: {} } as unknown as Task;

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
async function runOnce(extra: Record<string, unknown>) {
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
      modelRole: 'scout',
      defaultModel: 'x',
      defaultLimits: { steps: 5, seconds: 30 },
      defaultSearchProvider: 'exa',
      sandbox: 'read-only',
      search: false,
      buildConfig: () => ({ agent: {} }),
    };
    const engine = createAgentEngine({
      profile: profile as unknown as Parameters<typeof createAgentEngine>[0]['profile'],
      outDir: path.join(base, 'out'),
      env: POISON,
      subharness: {
        privateDir: path.join(base, 'private'),
        denyDir: path.join(base, 'nosudo'),
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
  const { children, outcome } = await runOnce({ id: 'n1', route: route('opencode') });
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.error, 'route-no-key');
  assert.equal(children.length, 0);
});

test('an opencode task with a key in its secrets runs on that key, with no variable of the environment in the child', async () => {
  // Bug: OPENCODE_WEBSEARCH_KEY or PROXY_URL from the runner's environment reaches the child beside the task's key.
  const { children } = await runOnce({ id: 'n2', route: route('opencode'), secrets: { openrouterKey: TASK_KEY } });
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
    const { children } = await runOnce({
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
    const { children } = await runOnce({
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

test('the scout and server profiles declare no environment names', () => {
  // Bug: the profile keeps naming OPENROUTER_ERRAND_KEY, OPENCODE_WEBSEARCH_KEY and PROXY_URL as the runner's inputs.
  assert.deepEqual([...(profileOf('scout')?.envNames ?? ['missing'])], []);
  assert.deepEqual([...(profileOf('server')?.envNames ?? ['missing'])], []);
});
