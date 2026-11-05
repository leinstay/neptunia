// OpenCode runs without a step cap (measured on 2026-11-05): at the cap OpenCode appends an assistant turn, and Gemini
// ("Requests ending with a model turn are not supported") and Anthropic ("does not support assistant message prefill")
// refuse it, so the run died with exit 1 instead of ending. The time limit of the task bounds the run. The scout's
// search time is 300 seconds. A stub binary reports what it was started with; no backend or provider is started.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createBackend } from '../src/agent-runner/backend.ts';
import { runAgent } from '../src/subharness/run.ts';
import type { RunDeps } from '../src/subharness/run.ts';
import { alive, reportOf, scratch, STUB } from './fixtures/backend-rig.ts';

/** `deps` that start the stub in place of every backend. */
function depsIn(dir: string): RunDeps {
  return {
    privateDir: dir,
    denyDir: path.join(dir, 'deny'),
    hostEnv: { PATH: process.env.PATH },
    backendFactory: (backend) => createBackend(backend, { binary: STUB }),
  };
}

/** What `steps` the OpenCode config content of a child carries, undefined when it has none. */
function stepsIn(content: string | undefined): unknown {
  const inline = JSON.parse(content ?? '{}') as { agent?: { build?: { steps?: number } } };
  const build = inline.agent?.build;
  return build?.steps;
}

test('an opencode child asked for a step count gets no steps cap in its inline config', async () => {
  // Catches: the profile's 25 steps reach OpenCode, which ends the run on an assistant turn the providers refuse.
  const { dir, cleanup } = scratch();
  try {
    const result = await runAgent(
      {
        agent: 'scout',
        brief: 'look',
        cwd: dir,
        timeoutMs: 20_000,
        maxSteps: 25,
        env: { FAKE_MODE: 'report' },
        route: { backend: 'opencode', model: 'x/model', effort: null, mode: 'read' },
        routeKey: 'route-key',
      },
      depsIn(dir)
    );
    assert.equal(result.ok, true);
    assert.equal(stepsIn(reportOf(result.text).env.OPENCODE_CONFIG_CONTENT), undefined);
  } finally {
    cleanup();
  }
});

test('an opencode child with system instructions has no steps in either of its configs', async () => {
  // Catches: the config file that carries the agent prompt brings a cap along with it.
  const { dir, cleanup } = scratch();
  try {
    const result = await runAgent(
      {
        agent: 'scout',
        brief: 'look',
        system: 'be careful',
        cwd: dir,
        timeoutMs: 20_000,
        maxSteps: 25,
        env: { FAKE_MODE: 'report' },
        route: { backend: 'opencode', model: 'x/model', effort: null, mode: 'read' },
        routeKey: 'route-key',
      },
      depsIn(dir)
    );
    const { env } = reportOf(result.text);
    assert.equal(stepsIn(env.OPENCODE_CONFIG_CONTENT), undefined);
    assert.doesNotMatch(env.OPENCODE_CONFIG_CONTENT ?? '', /"steps"/);
  } finally {
    cleanup();
  }
});

test('the time limit ends an opencode run that asked for steps and never answers', async () => {
  // Catches: with the step cap gone nothing bounds a looping run, and it spends until someone notices.
  const { dir, cleanup } = scratch();
  const pidFile = path.join(dir, 'grandchild.pid');
  let grandchild = 0;
  try {
    const started = Date.now();
    const result = await runAgent(
      {
        agent: 'scout',
        brief: 'look',
        cwd: dir,
        timeoutMs: 400,
        maxSteps: 25,
        env: { FAKE_MODE: 'hang', FAKE_PID_FILE: pidFile },
        route: { backend: 'opencode', model: 'x/model', effort: null, mode: 'read' },
        routeKey: 'route-key',
      },
      depsIn(dir)
    );
    assert.equal(result.ok, false);
    assert.equal(result.error, 'timeout');
    assert.ok(Date.now() - started < 15_000, 'returns soon after the time limit');
    grandchild = Number(fs.readFileSync(pidFile, 'utf8'));
  } finally {
    if (grandchild > 0 && alive(grandchild)) process.kill(grandchild, 'SIGKILL');
    cleanup();
  }
});

test('the scout profile gives a run 300 seconds', () => {
  // Catches: a search that needs several fetches is cut at the old shorter limit.
  const file = path.join(import.meta.dirname, '..', 'agents', 'scout', 'profile.json');
  const profile = JSON.parse(fs.readFileSync(file, 'utf8')) as { limits: { seconds: number } };
  assert.equal(profile.limits.seconds, 300);
});
