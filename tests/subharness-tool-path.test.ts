// The PATH and key of an agent's child on claude and codex routes. The child is a real disposable shell started by a
// fake backend with the environment the backend would give it (childEnvOf of the run's options.env). Contract under
// test: the PATH is the refusing `sudo` folder then the host PATH (the host PATH alone in `sudo` mode), and a claude or
// codex child has no OPENROUTER_API_KEY. Stage W removed the scout's own command folder (`pathDirs`); the scout's
// side of it is tests/scout-harness-search.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { childEnvOf, createAgentEngine } from '../src/agent-runner/backend.ts';
import type { BackendRunOptions } from '../src/agent-runner/backend.ts';
import { profileOf } from '../src/agent-runner/profiles.ts';
import type { BackendName } from '../src/agent-runner/profiles.ts';
import type { TaskRoute } from '../src/agent-runner/protocol.ts';
import { runAgent } from '../src/subharness/run.ts';
import type { RunDeps } from '../src/subharness/run.ts';
import { writeKeysFile } from './fixtures/keys-file.ts';
import { tempDir } from './fixtures/tmp.ts';

const TASK_KEY = 'sk-or-v1-task-secret-0123456789';
const HOST_PATH = `${path.dirname(process.execPath)}:/usr/bin:/bin`;

const ROUTES: Record<BackendName, TaskRoute> = {
  claude: { backend: 'claude', model: 'claude-opus-5-5', effort: 'medium', mode: 'write' },
  codex: { backend: 'codex', model: 'gpt-6-sol', effort: 'medium', mode: 'write' },
  opencode: { backend: 'opencode', model: null, effort: null, mode: 'write' },
};

type Seen = { sudo: string; key: string; path: string };

/** A fake backend that starts a real `sh` in the run's environment and records what the shell finds. */
function rig() {
  const base = tempDir('nep-toolpath-');
  const privateDir = path.join(base, 'private');
  writeKeysFile(privateDir, { subharness: { backends: [], key: null, modes: {} } });
  const denyDir = path.join(base, 'nosudo');
  const seen: Array<Seen> = [];
  const subharness: RunDeps = {
    privateDir,
    denyDir,
    hostEnv: { PATH: HOST_PATH },
    backendFactory: (name) => ({
      name,
      run: (_brief: string, options: BackendRunOptions) => {
        const env = childEnvOf(options.env);
        const sh = (script: string) =>
          execFileSync('/bin/sh', ['-c', script], { env, cwd: base, encoding: 'utf8' }).trim();
        seen.push({
          sudo: sh('command -v sudo || true'),
          key: sh('printf %s "${OPENROUTER_API_KEY-}"'),
          path: sh('printf %s "$PATH"'),
        });
        return Promise.resolve({ ok: true, text: 'answer', exitCode: 0 });
      },
    }),
  };
  return { base, subharness, denyDir, seen };
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
  test(`a server run on ${name} has the refusing sudo first on PATH and no key`, async () => {
    // Catches: a tool folder or the key leaking to a claude or codex child.
    const { base, subharness, denyDir, seen } = rig();
    await engineOf('server', base, subharness).run(task(ROUTES[name]));
    assert.equal(seen[0]?.sudo, path.join(denyDir, 'sudo'));
    assert.equal(seen[0]?.key, '');
    assert.equal(seen[0]?.path, `${denyDir}:${HOST_PATH}`);
  });
}

test('a dev run through runAgent on claude has no extra PATH folder and no key', async () => {
  // Catches: an extra PATH folder or the key becoming a default of every run.
  const { subharness, denyDir, seen } = rig();
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
  assert.equal(seen[0]?.path, `${denyDir}:${HOST_PATH}`);
});

test('a run in sudo mode has the host PATH alone and adds no stand-in', async () => {
  // Catches: sudo mode keeping the refusing stand-in on PATH.
  const { subharness, seen } = rig();
  await runAgent(
    {
      agent: 'dev',
      brief: 'x',
      cwd: tempDir('nep-toolpath-cwd-'),
      timeoutMs: 1000,
      route: { ...ROUTES.claude, mode: 'sudo' },
    },
    subharness
  );
  assert.equal(seen[0]?.path, HOST_PATH);
});
