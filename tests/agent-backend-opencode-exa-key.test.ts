// src/agent-runner/backend.ts#createAgentEngine over a real backend with a fake spawn: the task's `secrets.searchKey` is
// the child's `EXA_API_KEY`, beside `OPENCODE_ENABLE_EXA=1`, for an OpenCode run whose search provider is `exa` and for
// no other run. The key never appears in the child's arguments. The child is a fake; no request goes out.
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

type Task = Parameters<ReturnType<typeof createAgentEngine>['run']>[0];

const OR_KEY = 'sk-or-v1-task-secret-0123456789';
const EXA_KEY = 'exa-task-secret-9876543210';
const route = (backend: TaskRoute['backend']): TaskRoute => ({ backend, model: null, effort: null, mode: 'read' });
const TASK = { id: 't1', goal: 'find the release notes', context: {} } as unknown as Task;

type Seen = { env: Record<string, string>; args: Array<string> };

/** One engine run of a profile with `defaultSearchProvider` and the task `extra`; returns what each child saw. */
async function runOnce(profileProvider: string | null, extra: Record<string, unknown>): Promise<Array<Seen>> {
  const base = tempDir('nep-oc-exakey-');
  const binary = path.join(base, 'fake-binary');
  fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const prompt = path.join(base, 'agent.md');
  fs.writeFileSync(prompt, 'You are an errand agent.');
  const seen: Array<Seen> = [];
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

test('an opencode run with exa and a searchKey gets EXA_API_KEY and OPENCODE_ENABLE_EXA, and the key is in no argument', async () => {
  // Catches: the stored key reaching the task but not the child, or leaking into the command line where ps shows it.
  const [child] = await runOnce('exa', {
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

test('an opencode run with exa and no searchKey runs keyless: OPENCODE_ENABLE_EXA and no EXA_API_KEY', async () => {
  // Catches: an empty EXA_API_KEY set for a deployment with no stored key, which the endpoint would reject.
  const [child] = await runOnce('exa', { id: 'k2', route: route('opencode'), secrets: { openrouterKey: OR_KEY } });
  assert.ok(child, 'the child was spawned');
  assert.equal(child.env.OPENCODE_ENABLE_EXA, '1');
  assert.equal(Object.hasOwn(child.env, 'EXA_API_KEY'), false);
});

test('an opencode run whose search provider is not exa gets no EXA_API_KEY although the task carries one', async () => {
  // Catches: the key handed to a run that never uses Exa.
  const [child] = await runOnce('brave', {
    id: 'k3',
    route: route('opencode'),
    secrets: { openrouterKey: OR_KEY, searchKey: EXA_KEY },
  });
  assert.ok(child, 'the child was spawned');
  assert.equal(Object.hasOwn(child.env, 'EXA_API_KEY'), false);
});

for (const backend of ['claude', 'codex'] as const) {
  test(`a ${backend} run whose task carries a searchKey gets no EXA_API_KEY`, async () => {
    // Catches: the Exa key reaching a Claude or Codex child, which have web tools of their own.
    const [child] = await runOnce('exa', {
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
