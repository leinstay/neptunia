// The scout's own command (`web-search`) on every backend route of a scout run. The child is a real disposable shell
// started by a fake backend with the environment the backend would give it (childEnvOf of the run's options.env), so
// what it finds with `command -v` and what it reads from its environment is what a real claude, codex or opencode
// child would see. Contract under test: AgentRun.pathDirs (the profile's pathDirs) sit on the child's PATH right after
// the refusing `sudo` folder; a run whose profile has such dirs also gets its task key as OPENROUTER_API_KEY on any
// backend; every other run gets neither.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { childEnvOf, createAgentEngine } from '../src/agent-runner/backend.ts';
import type { BackendRunOptions } from '../src/agent-runner/backend.ts';
import { SCOUT_TOOLS_DIR, profileOf } from '../src/agent-runner/profiles.ts';
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

type Seen = {
  sudo: string;
  webSearch: string;
  key: string;
  path: string;
  bogus: { status: number | null; stderr: string };
};

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
        const bogus = spawnSync('/bin/sh', ['-c', 'web-search --bogus'], { env, cwd: base, encoding: 'utf8' });
        seen.push({
          sudo: sh('command -v sudo || true'),
          webSearch: sh('command -v web-search || true'),
          key: sh('printf %s "${OPENROUTER_API_KEY-}"'),
          path: sh('printf %s "$PATH"'),
          bogus: { status: bogus.status, stderr: bogus.stderr },
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

for (const name of ['claude', 'codex', 'opencode'] as const) {
  test(`a scout run on ${name} finds web-search first on PATH after the refusing sudo and the command runs`, async () => {
    // Catches: the subharness PATH drops the profile's pathDirs, so the agent answers `web-search: command not found` (exit 127).
    const { base, subharness, denyDir, seen } = rig();
    const outcome = await engineOf('scout', base, subharness).run(task(ROUTES[name]));
    assert.equal(outcome.status, 'done');
    assert.equal(seen[0]?.sudo, path.join(denyDir, 'sudo'));
    assert.equal(seen[0]?.webSearch, path.join(SCOUT_TOOLS_DIR, 'web-search'));
    assert.deepEqual(seen[0]?.path.split(':').slice(0, 2), [denyDir, SCOUT_TOOLS_DIR]);
    assert.equal(seen[0]?.bogus.stderr.trim(), 'web-search: bad-option');
    assert.equal(seen[0]?.bogus.status, 2);
  });

  test(`a scout run on ${name} has its task key as OPENROUTER_API_KEY so web-search can reach it`, async () => {
    // Catches: claude and codex children get no key, so the found command answers `web-search: no-key`.
    const { base, subharness, seen } = rig();
    await engineOf('scout', base, subharness).run(task(ROUTES[name]));
    assert.equal(seen[0]?.key, TASK_KEY);
  });
}

for (const name of ['claude', 'codex'] as const) {
  test(`a server run on ${name} gets neither the scout's folder on PATH nor a key`, async () => {
    // Catches: the tool folder or the key leaking to an agent whose profile has no commands of its own.
    const { base, subharness, denyDir, seen } = rig();
    await engineOf('server', base, subharness).run(task(ROUTES[name]));
    assert.equal(seen[0]?.webSearch, '');
    assert.equal(seen[0]?.key, '');
    assert.ok(!seen[0]?.path.split(':').includes(SCOUT_TOOLS_DIR));
    assert.equal(seen[0]?.path.split(':')[0], denyDir);
  });
}

test('a dev run through runAgent on claude has no extra PATH folder and no key', async () => {
  // Catches: pathDirs or the key becoming a default of every run.
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
  assert.equal(seen[0]?.webSearch, '');
  assert.equal(seen[0]?.key, '');
  assert.equal(seen[0]?.path, `${denyDir}:${HOST_PATH}`);
});

test('a run with pathDirs puts them between the refusing sudo folder and the host PATH', async () => {
  // Catches: the dirs placed after the host PATH (a host `web-search` would win) or before `sudo` (a tool folder could shadow the refusal).
  const { subharness, denyDir, seen } = rig();
  const tools = tempDir('nep-toolpath-tools-');
  fs.writeFileSync(path.join(tools, 'web-search'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  await runAgent(
    {
      agent: 'scout',
      brief: 'x',
      cwd: tempDir('nep-toolpath-cwd-'),
      timeoutMs: 1000,
      route: ROUTES.claude,
      pathDirs: [tools],
    },
    subharness
  );
  assert.equal(seen[0]?.path, `${denyDir}:${tools}:${HOST_PATH}`);
});

test('a run in sudo mode keeps its pathDirs ahead of the host PATH and adds no stand-in', async () => {
  // Catches: sudo mode dropping the tool folder.
  const { subharness, seen } = rig();
  const tools = tempDir('nep-toolpath-tools-');
  await runAgent(
    {
      agent: 'scout',
      brief: 'x',
      cwd: tempDir('nep-toolpath-cwd-'),
      timeoutMs: 1000,
      route: { ...ROUTES.claude, mode: 'sudo' },
      pathDirs: [tools],
    },
    subharness
  );
  assert.equal(seen[0]?.path, `${tools}:${HOST_PATH}`);
});
