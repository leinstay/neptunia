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
import type { EffortLevel } from '../src/llm/roles.ts';

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

// The `claude` backend of src/agent-runner/backend.ts: `claude -p` as a child process, the stub as its binary.

const claude = () => createBackend('claude', { binary: STUB });

test('runs claude -p with the brief and returns the trimmed stdout as the text', async () => {
  // Bug: the claude backend started the codex command line (exec, -o) or kept the trailing newline in the answer.
  const { dir, cleanup } = scratch();
  try {
    const result = await claude().run('hello', { cwd: dir, timeoutMs: 20_000, env: { FAKE_FINAL: 'an answer' } });
    assert.equal(result.ok, true);
    assert.equal(result.text, 'an answer');
    assert.equal(result.exitCode, 0);
    assert.equal(result.tokens, undefined);
    const seen = reportOf(
      (await claude().run('hello', { cwd: dir, timeoutMs: 20_000, env: { FAKE_MODE: 'report' } })).text
    );
    assert.ok(seen.argv.includes('-p'));
    assert.notEqual(seen.argv[0], 'exec');
    assert.ok(seen.stdin === 'hello' || seen.last === 'hello');
    assert.equal(seen.cwd, dir);
  } finally {
    cleanup();
  }
});

test('reports a failed claude run with its exit code', async () => {
  // Bug: a non-zero exit read as an answer made of whatever reached stdout.
  const { dir, cleanup } = scratch();
  try {
    const result = await claude().run('x', { cwd: dir, timeoutMs: 20_000, env: { FAKE_MODE: 'fail' } });
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 3);
  } finally {
    cleanup();
  }
});

test('claude takes the step limit as --max-turns, and without one runs with no such flag', async () => {
  // Bug: the scout's profile says 25 steps and nothing enforces it, so a run that loops spends until its timeout.
  const { dir, cleanup } = scratch();
  try {
    const env = { FAKE_MODE: 'report' };
    const limited = reportOf((await claude().run('x', { cwd: dir, timeoutMs: 20_000, env, maxSteps: 25 })).text);
    const free = reportOf((await claude().run('x', { cwd: dir, timeoutMs: 20_000, env })).text);
    assert.deepEqual(limited.argv.slice(limited.argv.indexOf('--max-turns'), limited.argv.indexOf('--max-turns') + 2), [
      '--max-turns',
      '25',
    ]);
    assert.equal(free.argv.includes('--max-turns'), false);
  } finally {
    cleanup();
  }
});

// The effort of a run as each backend's own flag (src/agent-runner/backend.ts, spec 2026-11-02 PR 5 "A path per
// role"): codex takes `-c model_reasoning_effort=<level>`, claude `--effort <level>`, opencode the model variant
// `--variant <level>`. Against the stub binary (tests/fixtures/fake-cli.ts) in mode `report`, which answers with the argv
// it was given.

/** The argv one run of `name` on the stub is given, with `effort` when there is one. */
async function argvOf(name: BackendName, effort?: EffortLevel): Promise<Array<string>> {
  const { dir, cleanup } = scratch();
  try {
    const backend = createBackend(name, { binary: STUB });
    const run = await backend.run('x', {
      cwd: dir,
      timeoutMs: 20_000,
      env: { FAKE_MODE: 'report' },
      model: 'some-model',
      ...(effort === undefined ? {} : { effort }),
    });
    return reportOf(run.text).argv;
  } finally {
    cleanup();
  }
}

test('codex gets the effort as -c model_reasoning_effort, and no -c without one', async () => {
  // Catches: the effort never reaches codex, or "model_reasoning_effort=undefined" on a run without an effort.
  const argv = await argvOf('codex', 'high');
  assert.equal(argv[argv.indexOf('-c') + 1], 'model_reasoning_effort=high');
  assert.equal((await argvOf('codex')).includes('-c'), false);
});

test('claude gets the effort as --effort, and no --effort without one', async () => {
  // Catches: claude given the codex form, which it refuses, or "--effort undefined" on a run without an effort.
  const argv = await argvOf('claude', 'low');
  assert.equal(argv[argv.indexOf('--effort') + 1], 'low');
  assert.equal(argv.includes('-c'), false);
  assert.equal((await argvOf('claude')).includes('--effort'), false);
});

test('opencode gets the effort as its model variant, and no variant without one', async () => {
  // Catches: opencode run without the variant, or "--variant undefined" on a run without an effort.
  const argv = await argvOf('opencode', 'medium');
  assert.equal(argv[argv.indexOf('--variant') + 1], 'medium');
  assert.equal((await argvOf('opencode')).includes('--variant'), false);
});

// What is left of the choice of a backend (src/agent-runner/backend.ts, src/agent-runner/profiles.ts): the names, and
// the refusal of a name that is none. The choice itself is the owner's subharness switch (tests/subharness-control.test.ts).

test('createBackend refuses a backend name that is none, so a typo never reaches a spawn', () => {
  // Bug: a typo such as "codx" becomes a command name that is looked up on the PATH.
  assert.throws(() => createBackend('codx' as unknown as BackendName), /codx/);
});
