// The task engine of the runner (src/agent-runner/backend.ts#createAgentEngine) runs every task through the subharness
// seam (src/subharness/run.ts): refused while the subharness is off, run in the mode of the profile's agent otherwise.
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
