// src/agent-runner/backend.ts#createAgentEngine with a task that carries the route the core decided. Most tests use a
// fake backend whose keys.json connects codex, so a run that reads it is visible. The last two start a real disposable
// executable where claude is installed: it records its arguments and environment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createAgentEngine } from '../src/agent-runner/backend.ts';
import type { BackendRunOptions } from '../src/agent-runner/backend.ts';
import type { TaskRoute } from '../src/agent-runner/protocol.ts';
import { subharnessPlace } from '../src/subharness/place.ts';
import type { RunDeps } from '../src/subharness/run.ts';
import { keysPath, writeKeysFile } from './fixtures/keys-file.ts';
import { tempDir } from './fixtures/tmp.ts';

const ROUTE: TaskRoute = { backend: 'claude', model: 'claude-opus-5-5', effort: 'medium', mode: 'read' };
const OPENCODE: TaskRoute = { backend: 'opencode', model: null, effort: null, mode: 'write' };
const TASK_KEY = 'sk-or-v1-task-secret-0123456789';

const TASK = { id: 't1', goal: 'look at the disk', context: {} } as unknown as Parameters<
  ReturnType<typeof createAgentEngine>['run']
>[0];

/** An engine of the agent scout over `subharness`, with a prompt file that exists. */
function engineOver(base: string, subharness: RunDeps) {
  const prompt = path.join(base, 'agent.md');
  fs.writeFileSync(prompt, 'You are an errand agent.');
  const profile = {
    name: 'scout',
    agentId: 'errand-scout',
    promptFiles: [prompt],
    modelRole: 'scout',
    defaultModel: 'x',
    defaultLimits: { steps: 5, seconds: 30 },
    sandbox: 'read-only',
    search: false,
    buildConfig: () => ({ agent: {} }),
  };
  return createAgentEngine({
    profile: profile as unknown as Parameters<typeof createAgentEngine>[0]['profile'],
    outDir: path.join(base, 'out'),
    subharness,
  });
}

/** An engine with a recording backend; keys.json connects codex on a model of its own. */
function fakeRig() {
  const base = tempDir('nep-engine-route-');
  const privateDir = path.join(base, 'private');
  writeKeysFile(privateDir, {
    subharness: { backends: ['codex'], key: null, modes: {}, models: { scout: 'gpt-6-sol' } },
  });
  const calls: Array<{ name: string; options: BackendRunOptions }> = [];
  const engine = engineOver(base, {
    privateDir,
    denyDir: path.join(base, 'nosudo'),
    hostEnv: { PATH: '/usr/bin' },
    backendFactory: (name) => ({
      name,
      run: (_brief: string, options: BackendRunOptions) => {
        calls.push({ name, options });
        return Promise.resolve({ ok: true, text: 'answer', exitCode: 0 });
      },
    }),
  });
  return { engine, calls };
}

test("a task's route picks the backend, model, effort and sandbox of the run, over keys.json and the task's role model", async () => {
  // Catches: the engine drops the route, or the role model of the line beats the model the owner set.
  const { engine, calls } = fakeRig();
  const outcome = await engine.run({ ...TASK, id: 'r1', model: 'role-model', route: ROUTE });
  assert.equal(outcome.status, 'done');
  assert.equal(calls[0]?.name, 'claude');
  assert.equal(calls[0]?.options.model, 'claude-opus-5-5');
  assert.equal(calls[0]?.options.effort, 'medium');
  assert.equal(calls[0]?.options.sandbox, 'read-only');
});

test("an opencode route runs on the key of the task's secrets", async () => {
  // Catches: the engine still withholds a task's secrets from every backend, so an opencode errand under the scout unit has no key.
  const { engine, calls } = fakeRig();
  const outcome = await engine.run({ ...TASK, id: 'r2', route: OPENCODE, secrets: { openrouterKey: TASK_KEY } });
  assert.equal(outcome.status, 'done');
  assert.equal(calls[0]?.name, 'opencode');
  assert.equal(calls[0]?.options.env?.OPENROUTER_API_KEY, TASK_KEY);
});

test('an opencode route in a task without secrets fails route-no-key and starts no backend', async () => {
  // Catches: a role with no key of its own runs opencode with an empty key, and the errand reports a provider's refusal.
  const { engine, calls } = fakeRig();
  const outcome = await engine.run({ ...TASK, id: 'r3', route: OPENCODE });
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.error, 'route-no-key');
  assert.equal(calls.length, 0);
});

test('a task with an unknown route fails bad-route and does not run on the connected backend', async () => {
  // Catches: a bad route is taken for no route, so the errand runs on another backend than the core sent.
  const { engine, calls } = fakeRig();
  const route = { ...ROUTE, backend: 'gemini' } as unknown as TaskRoute;
  const outcome = await engine.run({ ...TASK, id: 'r4', route });
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.error, 'bad-route');
  assert.equal(calls.length, 0);
});

/**
 * A real engine with no fake backend: a disposable shell script stands where claude is installed and records its
 * arguments and environment. The private folder holds no keys.json until a test writes one.
 */
function spawnRig() {
  const base = tempDir('nep-engine-spawn-');
  const privateDir = path.join(base, 'private');
  const record = path.join(base, 'record');
  fs.mkdirSync(record);
  const { binary, env: home } = subharnessPlace(privateDir, 'claude');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  const script = [
    '#!/bin/sh',
    `for arg in "$@"; do printf '%s\\n' "$arg"; done > '${record}/argv'`,
    `env > '${record}/env'`,
    'cat > /dev/null',
    'echo answer',
    '',
  ].join('\n');
  fs.writeFileSync(binary, script, { mode: 0o755 });
  const engine = engineOver(base, {
    privateDir,
    denyDir: path.join(base, 'nosudo'),
    hostEnv: { PATH: process.env.PATH },
  });
  const argv = (): Array<string> => fs.readFileSync(path.join(record, 'argv'), 'utf8').trim().split('\n');
  const env = (): string => fs.readFileSync(path.join(record, 'env'), 'utf8');
  return { engine, privateDir, argv, env, home };
}

/** The value after `flag` in `argv`, or null. */
const flagValue = (argv: ReadonlyArray<string>, flag: string): string | null => {
  const at = argv.indexOf(flag);
  return at === -1 ? null : (argv[at + 1] ?? null);
};

test('a claude child gets the --model and --effort of the route when the runner has no keys.json', async () => {
  // Catches: the defect of the scout unit, where the persona folder is hidden and a run that needs keys.json never starts.
  const { engine, privateDir, argv, env, home } = spawnRig();
  assert.equal(fs.existsSync(keysPath(privateDir)), false);
  const outcome = await engine.run({ ...TASK, id: 's1', route: ROUTE, secrets: { openrouterKey: TASK_KEY } });
  assert.equal(outcome.status, 'done');
  assert.equal(outcome.result?.text, 'answer');
  assert.equal(flagValue(argv(), '--model'), 'claude-opus-5-5');
  assert.equal(flagValue(argv(), '--effort'), 'medium');
  assert.ok(env().split('\n').includes(`CLAUDE_CONFIG_DIR=${home.CLAUDE_CONFIG_DIR}`));
  assert.ok(!env().includes(TASK_KEY), "the task's key stays out of a CLI that brings its own login");
  assert.ok(!env().includes('keys.json'));
});

test('a run with a route never opens keys.json, and nothing of the file reaches the child', async (t) => {
  // Catches: the store is still read at each run where the file is readable (the server unit), and its values reach the child.
  const { engine, privateDir, argv, env } = spawnRig();
  const STORED = 'sk-or-v1-stored-secret-9876543210';
  writeKeysFile(privateDir, {
    extra: { opencode: STORED },
    subharness: { backends: ['codex'], key: 'opencode', modes: {}, models: { scout: 'gpt-6-sol' } },
  });
  const reads = t.mock.method(fs, 'readFileSync');
  const outcome = await engine.run({ ...TASK, id: 's2', route: ROUTE });
  const opened = reads.mock.calls.filter((call) => String(call.arguments[0]).endsWith('keys.json'));
  t.mock.restoreAll();
  assert.equal(outcome.status, 'done');
  assert.equal(opened.length, 0);
  assert.equal(flagValue(argv(), '--model'), 'claude-opus-5-5');
  assert.ok(!env().includes(STORED));
  assert.ok(!env().includes('keys.json'));
});
