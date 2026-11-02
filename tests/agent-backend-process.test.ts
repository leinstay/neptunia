// What the codex and claude backends of src/agent-runner/backend.ts share: the refusals before a spawn, the minimal
// child environment, the timeout that kills the process group, and the log line that never holds the brief.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { spawn } from 'node:child_process';
import { createBackend } from '../src/agent-runner/backend.ts';
import type { BackendName } from '../src/agent-runner/backend.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import { STUB, alive, reportOf, scratch } from './fixtures/backend-rig.ts';

const NAMES: Array<BackendName> = ['codex', 'claude'];

/** A spawn that fails the test when it is called. */
const noSpawn = (() => {
  throw new Error('spawn must not be called');
}) as unknown as typeof spawn;

for (const name of NAMES) {
  test(`${name}: refuses to start when the binary is missing and spawns nothing`, async () => {
    // Bug: a missing CLI surfaces as a generic spawn failure, or as a hang, instead of a clear backend-missing.
    const { dir, cleanup } = scratch();
    try {
      const backend = createBackend(name, { binary: path.join(dir, 'no-such-binary'), spawnImpl: noSpawn });
      const result = await backend.run('do it', { cwd: dir, timeoutMs: 20_000 });
      assert.equal(result.ok, false);
      assert.equal(result.error, 'backend-missing');
      assert.equal(result.exitCode, null);
    } finally {
      cleanup();
    }
  });

  test(`${name}: refuses an empty or blank brief and spawns nothing`, async () => {
    // Bug: an empty task from the board runs a paid model call with nothing to do.
    const { dir, cleanup } = scratch();
    try {
      const backend = createBackend(name, { binary: STUB, spawnImpl: noSpawn });
      for (const brief of ['', '   \n\t ']) {
        const result = await backend.run(brief, { cwd: dir, timeoutMs: 20_000 });
        assert.equal(result.ok, false);
        assert.equal(result.error, 'empty-brief');
      }
    } finally {
      cleanup();
    }
  });

  test(`${name}: the child gets a minimal environment and none of the parent's keys`, async () => {
    // Bug: the bot's .env (OpenRouter keys, the Discord token) leaks into an agent that can run shell commands.
    const { dir, cleanup } = scratch();
    const planted: Record<string, string> = {
      OPENROUTER_API_KEY: 'sk-or-parent-secret',
      OPENROUTER_CORE_KEY: 'sk-or-core-secret',
      DISCORD_TOKEN: 'discord-parent-secret',
      NODE_OPTIONS: '--no-warnings',
    };
    const saved = Object.fromEntries(Object.keys(planted).map((key) => [key, process.env[key]]));
    Object.assign(process.env, planted);
    try {
      const backend = createBackend(name, { binary: STUB });
      const result = await backend.run('x', { cwd: dir, timeoutMs: 20_000, env: { FAKE_MODE: 'report' } });
      const seen = reportOf(result.text).env;
      for (const [key, value] of Object.entries(planted)) {
        assert.equal(seen[key], undefined, `${key} reached the child`);
        assert.ok(!Object.values(seen).includes(value), `the value of ${key} reached the child`);
      }
      const allowed = new Set(['PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'LC_CTYPE', 'FAKE_MODE']);
      assert.deepEqual(
        Object.keys(seen).filter((key) => !allowed.has(key)),
        []
      );
      assert.equal(seen.PATH, process.env.PATH);
      assert.equal(seen.HOME, process.env.HOME);
    } finally {
      for (const [key, value] of Object.entries(saved)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
      cleanup();
    }
  });

  test(`${name}: a timeout kills the child and what it spawned, and answers timeout`, async () => {
    // Bug: a hung CLI keeps running (and billing) after the task has failed, because only the direct child was killed.
    const { dir, cleanup } = scratch();
    const pidFile = path.join(dir, 'grandchild.pid');
    let grandchild = 0;
    try {
      const backend = createBackend(name, { binary: STUB });
      const started = Date.now();
      const result = await backend.run('x', {
        cwd: dir,
        timeoutMs: 400,
        env: { FAKE_MODE: 'hang', FAKE_PID_FILE: pidFile },
      });
      assert.equal(result.ok, false);
      assert.equal(result.error, 'timeout');
      assert.ok(Date.now() - started < 15_000, 'returns soon after the timeout');
      grandchild = Number(fs.readFileSync(pidFile, 'utf8'));
      assert.ok(grandchild > 0);
      const deadline = Date.now() + 5_000;
      while (alive(grandchild) && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50));
      assert.equal(alive(grandchild), false, 'the grandchild is dead');
    } finally {
      if (grandchild && alive(grandchild)) process.kill(grandchild, 'SIGKILL');
      cleanup();
    }
  });
}

test('logs the backend, exit code, duration and tokens of a run, never the brief or the result text', async () => {
  // Bug: the log line carries the brief (a private task) or the result, or lacks the numbers the spend check needs.
  const { dir, cleanup } = scratch();
  try {
    let calls = 0;
    const now = () => (calls++ === 0 ? 1000 : 1250);
    const backend = createBackend('codex', { binary: STUB, now });
    const { result, logs } = await withCapturedLogs(() =>
      backend.run('BRIEF-MARKER-4471 summarise the thread', {
        cwd: dir,
        timeoutMs: 20_000,
        env: { FAKE_FINAL: 'RESULT-MARKER-9023' },
      })
    );
    assert.equal(result.text, 'RESULT-MARKER-9023');
    const entry = logs.find((line) => line.msg === 'agent-runner: backend run');
    assert.ok(entry, 'one backend run line');
    assert.equal(entry.backend, 'codex');
    assert.equal(entry.exitCode, 0);
    assert.equal(entry.durationMs, 250);
    assert.equal(entry.tokens, 17065);
    const everything = JSON.stringify(logs);
    assert.ok(!everything.includes('BRIEF-MARKER-4471'));
    assert.ok(!everything.includes('RESULT-MARKER-9023'));
  } finally {
    cleanup();
  }
});
