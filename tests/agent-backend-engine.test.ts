// The task engine of the runner (src/agent-runner/backend.ts#createAgentEngine) runs every task through the subharness
// seam (src/subharness/run.ts): refused while the subharness is off, run in the mode of the profile's agent otherwise.
import { consumers, consumerRig } from './fixtures/agent-consumers.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createAgentEngine } from '../src/agent-runner/backend.ts';
import type { BackendRunOptions } from '../src/agent-runner/backend.ts';
import type { RunDeps } from '../src/subharness/run.ts';
import { setAgentMode } from '../src/subharness/control.ts';
import { writeKeysFile } from './fixtures/keys-file.ts';
import { tempDir } from './fixtures/tmp.ts';

/** An engine over a fake profile whose prompt file exists, and a recording backend. */
function engineRig(backend: 'codex' | 'claude' | 'opencode' | null, agent: string) {
  const base = tempDir('nep-engine-');
  const prompt = path.join(base, 'agent.md');
  fs.writeFileSync(prompt, 'You are an errand agent.');
  const privateDir = path.join(base, 'private');
  writeKeysFile(privateDir, { subharness: { backend, key: null, modes: {} } });
  const calls: Array<BackendRunOptions> = [];
  const subharness: RunDeps = {
    privateDir,
    denyDir: path.join(base, 'nosudo'),
    hostEnv: { PATH: '/usr/bin' },
    backendFactory: (name) => ({
      name,
      run: (_brief: string, options: BackendRunOptions) => {
        calls.push(options);
        return Promise.resolve({ ok: true, text: 'answer', exitCode: 0 });
      },
    }),
  };
  const profile = {
    name: agent,
    agentId: `errand-${agent}`,
    promptFiles: [prompt],
    modelRole: agent,
    defaultModel: 'x',
    defaultLimits: { steps: 5, seconds: 30 },
    sandbox: 'read-only',
    search: false,
    buildConfig: () => ({ agent: {} }),
  };
  const engine = createAgentEngine({
    profile: profile as unknown as Parameters<typeof createAgentEngine>[0]['profile'],
    outDir: path.join(base, 'out'),
    subharness,
  });
  return { engine, calls, privateDir };
}

const TASK = { id: 't1', goal: 'look at the disk', context: {} } as unknown as Parameters<
  ReturnType<typeof createAgentEngine>['run']
>[0];

test('a task while the subharness is off fails with subharness-off and starts no backend', async () => {
  // Bug: the errand runner keeps working through a cached backend after the owner disabled the subharness.
  const { engine, calls } = engineRig(null, 'scout');
  const outcome = await engine.run(TASK);
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.error, 'subharness-off');
  assert.equal(calls.length, 0);
});

test("a task runs in the mode of its profile's agent, not in the profile's own sandbox key", async () => {
  // Bug: the server profile says read-only, the owner set server to write, and the engine still passes read-only.
  const { engine, calls, privateDir } = engineRig('codex', 'server');
  await engine.run(TASK);
  await setAgentMode(privateDir, 'server', 'write');
  await engine.run({ ...TASK, id: 't2' });
  assert.deepEqual(
    calls.map((one) => one.sandbox),
    ['read-only', 'workspace-write']
  );
});

test('a running engine reads personal prompts and limits afresh while retaining subharness selections', async () => {
  const rig = consumerRig();
  rig.override({ limits: { seconds: 17 } });
  fs.writeFileSync(path.join(rig.personal, 'prompt.md'), 'PERSONAL-WORKER-FIRST');
  const engine = consumers.engine({
    profile: rig.profile,
    agentPaths: rig.options,
    outDir: path.join(rig.base, 'out'),
    subharness: rig.subharness,
  });
  const task = {
    id: 'first',
    goal: 'inspect synthetic files',
    context: {},
    signal: new AbortController().signal,
    onProgress: () => {},
  };
  try {
    assert.equal(engine.checkPrompt(), 'PERSONAL-WORKER-FIRST');
    assert.equal((await engine.run(task)).status, 'done');
    rig.override({ limits: { seconds: 29 } });
    fs.writeFileSync(path.join(rig.personal, 'prompt.md'), 'PERSONAL-WORKER-SECOND');
    assert.equal(engine.checkPrompt(), 'PERSONAL-WORKER-SECOND');
    assert.equal((await engine.run({ ...task, id: 'second' })).status, 'done');
    assert.deepEqual(
      rig.calls.map(({ name, options }) => [name, options.model, options.effort, options.timeoutMs]),
      [
        ['codex', 'worker-selected-model', 'high', 17000],
        ['codex', 'worker-selected-model', 'high', 29000],
      ]
    );
    assert.match(rig.calls[0]?.brief ?? '', /PERSONAL-WORKER-FIRST/);
    assert.match(rig.calls[1]?.brief ?? '', /PERSONAL-WORKER-SECOND/);
    for (const call of rig.calls) assert.doesNotMatch(call.brief, /PRIVATE-DECOY-MARKER|shared marker/);
    fs.unlinkSync(path.join(rig.personal, 'prompt.md'));
    assert.equal(engine.checkPrompt(), 'shared marker');
    assert.equal((await engine.run({ ...task, id: 'fallback' })).status, 'done');
    assert.match(rig.calls[2]?.brief ?? '', /shared marker/);
    assert.deepEqual(
      [rig.calls[2]?.name, rig.calls[2]?.options.model, rig.calls[2]?.options.effort],
      ['codex', 'worker-selected-model', 'high']
    );
  } finally {
    rig.close();
  }
});

test('a running engine refuses an invalid personal definition instead of using its captured profile', async () => {
  const rig = consumerRig();
  rig.override({ limits: { seconds: 17 } });
  const engine = consumers.engine({
    profile: rig.profile,
    agentPaths: rig.options,
    outDir: path.join(rig.base, 'out'),
    subharness: rig.subharness,
  });
  const task = {
    id: 'valid',
    goal: 'inspect synthetic files',
    context: {},
    signal: new AbortController().signal,
    onProgress: () => {},
  };
  try {
    assert.equal((await engine.run(task)).status, 'done');
    rig.override({ limits: { seconds: 0 } });
    assert.throws(() => engine.checkPrompt());
    // The public runner may reject the definition or return a failed outcome. Both must stop before the backend.
    const invalid = await engine.run({ ...task, id: 'invalid' }).then(
      (outcome) => outcome.status,
      () => 'failed'
    );
    assert.equal(invalid, 'failed');
    assert.equal(rig.calls.length, 1);
  } finally {
    rig.close();
  }
});

test("the profile's step limit reaches the run, and a task's own limit wins", async () => {
  // Bug: `limits.steps` stays a field nobody passes on, while `limits.seconds` is enforced.
  const { engine, calls } = engineRig('claude', 'scout');
  await engine.run(TASK);
  await engine.run({ ...TASK, id: 't2', limits: { steps: 2 } });
  assert.deepEqual(
    calls.map((one) => one.maxSteps),
    [5, 2]
  );
});
