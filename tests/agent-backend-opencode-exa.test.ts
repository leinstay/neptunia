// src/agent-runner/backend.ts#createAgentEngine over a real backend with a fake spawn: OpenCode's own `websearch` tool
// (Exa's free hosted endpoint, no key) is switched on by `OPENCODE_ENABLE_EXA=1` in the child's environment, and only for
// an OpenCode run whose search provider is `exa`, from the profile (`defaultSearchProvider`) or from the task. The
// child is a fake; no request goes out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import fs from 'node:fs';
import path from 'node:path';
import type { spawn } from 'node:child_process';
import { createAgentEngine, createBackend } from '../src/agent-runner/backend.ts';
import type { TaskRoute } from '../src/agent-runner/protocol.ts';
import { wrongly } from './fixtures/loose-types.ts';
import { tempDir } from './fixtures/tmp.ts';

type Json = Record<string, unknown>;
type Task = Parameters<ReturnType<typeof createAgentEngine>['run']>[0];

const KEY = 'sk-or-v1-task-secret-0123456789';
const route = (backend: TaskRoute['backend']): TaskRoute => ({ backend, model: null, effort: null, mode: 'read' });
const TASK = { id: 't1', goal: 'find the release notes', context: {} } as unknown as Task;

const isJson = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

/** What the fake child saw: its environment and the config file it would load, read while it ran. */
type Seen = { env: Record<string, string>; config: Json };

/** One engine run of a profile with `defaultSearchProvider` and the task `extra`; returns what each spawned child saw. */
async function runOnce(profileProvider: string | null, extra: Record<string, unknown>): Promise<Array<Seen>> {
  const base = tempDir('nep-oc-exa-');
  const binary = path.join(base, 'fake-binary');
  fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const prompt = path.join(base, 'agent.md');
  fs.writeFileSync(prompt, 'You are an errand agent.');
  const seen: Array<Seen> = [];
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
    modelRole: 'scout',
    defaultModel: 'x',
    defaultLimits: { steps: 5, seconds: 30 },
    defaultSearchProvider: profileProvider,
    sandbox: 'read-only',
    search: false,
    buildConfig: () => ({ agent: {} }),
  };
  const engine = createAgentEngine({
    profile: profile as unknown as Parameters<typeof createAgentEngine>[0]['profile'],
    outDir: path.join(base, 'out'),
    subharness: {
      privateDir: path.join(base, 'private'),
      denyDir: path.join(base, 'nosudo'),
      hostEnv: { PATH: '/usr/bin' },
      backendFactory: (name) => createBackend(name, { binary, spawnImpl: wrongly<typeof spawn>(impl) }),
    },
  });
  await engine.run({ ...TASK, ...extra });
  return seen;
}

test('an opencode run of an agent whose profile searches with exa gets OPENCODE_ENABLE_EXA and no Exa key', async () => {
  // Catches: OpenCode agents keep only webfetch and bash because the allowlisted child environment never switches websearch on.
  const [child] = await runOnce('exa', { id: 'e1', route: route('opencode'), secrets: { openrouterKey: KEY } });
  assert.ok(child, 'the child was spawned');
  assert.equal(child.env.OPENCODE_ENABLE_EXA, '1');
  assert.equal(Object.hasOwn(child.env, 'EXA_API_KEY'), false);
});

test('an opencode run whose task names exa gets OPENCODE_ENABLE_EXA although the profile has no provider', async () => {
  // Catches: only the profile's default is read, so a task's own searchProvider is ignored.
  const [child] = await runOnce(null, {
    id: 'e2',
    route: route('opencode'),
    secrets: { openrouterKey: KEY },
    searchProvider: 'exa',
  });
  assert.ok(child, 'the child was spawned');
  assert.equal(child.env.OPENCODE_ENABLE_EXA, '1');
  assert.equal(Object.hasOwn(child.env, 'EXA_API_KEY'), false);
});

test('an opencode run with no search provider gets neither OPENCODE_ENABLE_EXA nor EXA_API_KEY', async () => {
  // Catches: the switch is set for every OpenCode run, giving websearch to agents whose profile asked for none.
  const [child] = await runOnce(null, { id: 'e3', route: route('opencode'), secrets: { openrouterKey: KEY } });
  assert.ok(child, 'the child was spawned');
  assert.equal(Object.hasOwn(child.env, 'OPENCODE_ENABLE_EXA'), false);
  assert.equal(Object.hasOwn(child.env, 'EXA_API_KEY'), false);
});

for (const backend of ['claude', 'codex'] as const) {
  test(`a ${backend} run of an agent that searches with exa never gets OPENCODE_ENABLE_EXA`, async () => {
    // Catches: the Exa switch leaks into a backend that has its own web tools.
    const [child] = await runOnce('exa', { id: `e-${backend}`, route: route(backend), searchProvider: 'exa' });
    assert.ok(child, 'the child was spawned');
    assert.equal(Object.hasOwn(child.env, 'OPENCODE_ENABLE_EXA'), false);
    assert.equal(Object.hasOwn(child.env, 'EXA_API_KEY'), false);
  });
}

test('an opencode run with exa does not deny websearch in the permissions written for the run', async () => {
  // Catches: the run's permission block, where one is written, still denies websearch, so the tool OpenCode now shows cannot be used.
  const [child] = await runOnce('exa', { id: 'e4', route: route('opencode'), secrets: { openrouterKey: KEY } });
  assert.ok(child, 'the child was spawned');
  const permission = child.config.permission;
  if (isJson(permission)) assert.equal(permission.websearch, 'allow');
});
