// Tests for src/agent-runner/backend.ts: the recipes of the codex, claude and opencode backends at the spawn boundary,
// the child process they run, and the task engine of the runner (`createAgentEngine`). The binaries are the stub
// tests/fixtures/fake-cli.ts, disposable shell scripts or a fake spawn; no provider is called.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import {
  createBackend,
  createInstalledBackend,
  backendLimits,
  createAgentEngine,
} from '../../../src/agent-runner/backend.ts';
import type { BackendName, BackendRunOptions } from '../../../src/agent-runner/backend.ts';
import type { EffortLevel } from '../../../src/llm/roles.ts';
import type { TaskRoute } from '../../../src/agent-runner/protocol.ts';
import { subharnessPlace } from '../../../src/subharness/place.ts';
import { runAgent } from '../../../src/subharness/run.ts';
import type { RunDeps } from '../../../src/subharness/run.ts';
import { taskPrompt } from '../../../src/agent-runner/opencode.ts';
import { setUnitMode } from '../../../src/subharness/control.ts';
import { withCapturedLogs } from '../../fixtures/capture-logs.ts';
import { STUB, alive, reportOf, scratch } from '../../fixtures/backend-rig.ts';
import { writeKeysFile, keysPath } from '../../fixtures/keys-file.ts';
import { tempDir } from '../../fixtures/tmp.ts';
import { consumerRig, consumers } from '../../fixtures/agent-consumers.ts';
import { wrongly, present } from '../../fixtures/loose-types.ts';

// What the codex and claude backends of src/agent-runner/backend.ts share: the refusals before a spawn, the minimal
// child environment, the timeout that kills the process group, and the log line that never holds the brief.
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

// The effort of a run as each backend's own flag: codex takes `-c model_reasoning_effort=<level>`, claude `--effort <level>`, opencode the model variant
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
  // Every codex run carries `-c web_search="live"`, so the effort is found by its own value and not by the first -c.
  assert.equal(argv[argv.indexOf('model_reasoning_effort=high') - 1], '-c');
  assert.equal(
    (await argvOf('codex')).some((arg) => arg.startsWith('model_reasoning_effort')),
    false
  );
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

// The names of the backends (src/agent-runner/profiles.ts), and the refusal of a name that is none. The choice of a
// backend is the subharness switch of src/subharness/control.ts.

test('createBackend refuses a backend name that is none, so a typo never reaches a spawn', () => {
  // Bug: a typo such as "codx" becomes a command name that is looked up on the PATH.
  assert.throws(() => createBackend('codx' as unknown as BackendName), /codx/);
});

// The `codex` backend of src/agent-runner/backend.ts: `codex exec` as a child process. The binary is the stub
// tests/fixtures/fake-cli.ts, which writes the final message to the `-o` file and prints `tokens used` like the real one.
const codex = () => createBackend('codex', { binary: STUB });

test('returns the final message from the -o file, not the stdout banner, with the tokens of the tokens used line', async () => {
  // Bug: taking stdout as the answer returns the banner, the echoed brief and the message twice.
  const { dir, cleanup } = scratch();
  try {
    const result = await codex().run('say hi', { cwd: dir, timeoutMs: 20_000, env: { FAKE_FINAL: 'hi there' } });
    assert.equal(result.ok, true);
    assert.equal(result.text, 'hi there');
    assert.equal(result.exitCode, 0);
    assert.equal(result.tokens, 17065);
  } finally {
    cleanup();
  }
});

test('reads a token count with several comma groups as one number', async () => {
  // Bug: parseInt("1,234,567") gives 1 and the day's spend is under-counted a million fold.
  const { dir, cleanup } = scratch();
  try {
    const result = await codex().run('x', { cwd: dir, timeoutMs: 20_000, env: { FAKE_TOKENS: '1,234,567' } });
    assert.equal(result.tokens, 1234567);
  } finally {
    cleanup();
  }
});

test('reads the token count from stderr, where the real codex prints it on the line after the label', async () => {
  // Bug: only stdout was read, so the real run (banner and tokens on stderr) reported no tokens and the spend went uncounted.
  const { dir, cleanup } = scratch();
  try {
    const env = { FAKE_TOKENS_ON: 'stderr', FAKE_TOKENS: '2,083', FAKE_FINAL: 'ok' };
    const result = await codex().run('x', { cwd: dir, timeoutMs: 20_000, env });
    assert.equal(result.text, 'ok');
    assert.equal(result.tokens, 2083);
  } finally {
    cleanup();
  }
});

test('sends the brief to the child whole and starts it in the given cwd with exec, the git check off and a -o file', async () => {
  // Bug: a brief with quotes and newlines mangled by a shell, or run in the bot's own directory.
  const { dir, cleanup } = scratch();
  try {
    const brief = 'line one\n"quoted" $HOME `tick` --not-a-flag\nline three';
    const result = await codex().run(brief, { cwd: dir, timeoutMs: 20_000, env: { FAKE_MODE: 'report' } });
    const seen = reportOf(result.text);
    const delivered = seen.stdin === brief || seen.last === brief;
    assert.ok(delivered, 'the brief arrives on stdin or as the last argument, byte for byte');
    assert.equal(seen.argv[0], 'exec');
    assert.ok(seen.argv.includes('--skip-git-repo-check'));
    assert.ok(seen.argv.includes('-o'));
    assert.equal(seen.cwd, dir);
  } finally {
    cleanup();
  }
});

test('passes the sandbox with -s, read-only unless told otherwise, and each image with -i', async () => {
  // Bug: a research agent runs with write access, or an attached picture never reaches the model.
  const { dir, cleanup } = scratch();
  try {
    const env = { FAKE_MODE: 'report' };
    const plain = reportOf((await codex().run('x', { cwd: dir, timeoutMs: 20_000, env })).text);
    assert.equal(plain.argv[plain.argv.indexOf('-s') + 1], 'read-only');
    const full = reportOf(
      (
        await codex().run('x', {
          cwd: dir,
          timeoutMs: 20_000,
          env,
          sandbox: 'workspace-write',
          images: ['/tmp/a.png', '/tmp/b.png'],
        })
      ).text
    );
    assert.equal(full.argv[full.argv.indexOf('-s') + 1], 'workspace-write');
    const shown = full.argv.flatMap((arg, i) => (arg === '-i' ? [full.argv[i + 1]] : []));
    assert.deepEqual(shown, ['/tmp/a.png', '/tmp/b.png']);
  } finally {
    cleanup();
  }
});

test('reports a failed run with the exit code and no text', async () => {
  // Bug: a crashed codex (exit 3) reported as success with an empty answer.
  const { dir, cleanup } = scratch();
  try {
    const result = await codex().run('x', { cwd: dir, timeoutMs: 20_000, env: { FAKE_MODE: 'fail' } });
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 3);
    assert.equal(result.text, '');
  } finally {
    cleanup();
  }
});

test('reports ok false when the run exits 0 and writes no final message', async () => {
  // Bug: an empty answer delivered to the board as a finished task.
  const { dir, cleanup } = scratch();
  try {
    const result = await codex().run('x', { cwd: dir, timeoutMs: 20_000, env: { FAKE_MODE: 'silent' } });
    assert.equal(result.ok, false);
    assert.equal(result.exitCode, 0);
    assert.equal(result.text, '');
  } finally {
    cleanup();
  }
});

// The web search of the `codex` backend in src/agent-runner/backend.ts, against the stub tests/fixtures/fake-cli.ts.

test('turns web search on through -c web_search="live" and never the bare --search flag', async () => {
  // Bug: codex-cli 0.164.0 rejects `codex exec --search` with a usage error (exit 2), so every errand with search on failed in 40 ms.
  // Every codex run searches the web, so the run takes no search option.
  const { dir, cleanup } = scratch();
  try {
    const result = await createBackend('codex', { binary: STUB }).run('look it up', {
      cwd: dir,
      timeoutMs: 20_000,
      env: { FAKE_MODE: 'report' },
    });
    const { argv } = reportOf(result.text);
    assert.ok(!argv.includes('--search'), 'the bare --search flag is not a codex exec option');
    const at = argv.indexOf('web_search="live"');
    assert.ok(at > 0 && argv[at - 1] === '-c', 'the run passes -c web_search="live"');
  } finally {
    cleanup();
  }
});

// The codex flags of the sandbox values (src/agent-runner/backend.ts), against the stub binary
// (tests/fixtures/fake-cli.ts): `none` is the bypass flag the modes full and sudo map to (src/subharness/run.ts).

test('sandbox none runs codex with the bypass flag and no -s', async () => {
  // Bug: full and sudo still pass "-s workspace-write", so the mode set for the agent changes nothing.
  const { dir, cleanup } = scratch();
  try {
    const env = { FAKE_MODE: 'report' };
    const run = await codex().run('x', { cwd: dir, timeoutMs: 20_000, env, sandbox: 'none' });
    const { argv } = reportOf(run.text);
    assert.ok(argv.includes('--dangerously-bypass-approvals-and-sandbox'));
    assert.ok(!argv.includes('-s'));
  } finally {
    cleanup();
  }
});

test('read-only and workspace-write keep -s and never the bypass flag', async () => {
  // Bug: the bypass flag is added to every run, which removes the sandbox for the agents in read and write.
  const { dir, cleanup } = scratch();
  try {
    const env = { FAKE_MODE: 'report' };
    for (const sandbox of ['read-only', 'workspace-write'] as const) {
      const { argv } = reportOf((await codex().run('x', { cwd: dir, timeoutMs: 20_000, env, sandbox })).text);
      assert.equal(argv[argv.indexOf('-s') + 1], sandbox);
      assert.ok(!argv.includes('--dangerously-bypass-approvals-and-sandbox'));
    }
  } finally {
    cleanup();
  }
});

test('a model reaches each backend as its own flag, and no flag is added without one', async () => {
  // Bug: the model chosen per agent is dropped, or "-m undefined" is passed.
  const { dir, cleanup } = scratch();
  try {
    const env = { FAKE_MODE: 'report' };
    const withModel = reportOf((await codex().run('x', { cwd: dir, timeoutMs: 20_000, env, model: 'gpt-x' })).text);
    assert.equal(withModel.argv[withModel.argv.indexOf('-m') + 1], 'gpt-x');
    const without = reportOf((await codex().run('x', { cwd: dir, timeoutMs: 20_000, env })).text);
    assert.equal(without.argv.includes('-m'), false);
  } finally {
    cleanup();
  }
});

// The tool flags of `claude -p` (src/agent-runner/backend.ts, the claude recipe), seen at the spawn boundary: a
// disposable shell script stands where claude is installed and records the arguments it was started with. A run
// reaches it through `runAgent` (src/subharness/run.ts) with a route.
// Contract: every run gets Read, Grep, Glob, Bash, WebFetch and WebSearch, a write mode adds Edit and Write, and the
// list goes to `--tools` and `--allowedTools`; full and sudo pass `--dangerously-skip-permissions` instead.
const SKIP = '--dangerously-skip-permissions';

/** A private folder whose claude is a script that records its arguments, one per line, and answers `ok`. */
function claudeToolsRig() {
  const base = tempDir('nep-claude-tools-');
  const privateDir = path.join(base, 'private');
  const record = path.join(base, 'argv');
  const { binary } = subharnessPlace(privateDir, 'claude');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(
    binary,
    [
      '#!/bin/sh',
      `for arg in "$@"; do printf '%s\\n' "$arg"; done > '${record}'`,
      'cat > /dev/null',
      'echo ok',
      '',
    ].join('\n'),
    { mode: 0o755 }
  );
  writeKeysFile(privateDir, { subharness: { backends: ['claude'], key: null, modes: {} } });
  const deps: RunDeps = { privateDir, hostEnv: { PATH: process.env.PATH } };
  const argv = (): Array<string> => fs.readFileSync(record, 'utf8').split('\n').slice(0, -1);
  return { base, privateDir, deps, argv };
}

const claudeRoute = (mode: TaskRoute['mode']): TaskRoute => ({ backend: 'claude', model: null, effort: null, mode });

/** The tool names after `flag`: its values up to the next flag, split on commas and spaces. */
function namesOf(argv: ReadonlyArray<string>, flag: string): Array<string> {
  const at = argv.indexOf(flag);
  assert.notEqual(at, -1, `${flag} is missing from: ${argv.join(' ')}`);
  const values: Array<string> = [];
  for (const arg of argv.slice(at + 1)) {
    if (arg.startsWith('-')) break;
    values.push(...arg.split(/[\s,]+/).filter(Boolean));
  }
  return values.sort();
}

/** One run of `agent` in `mode`; the arguments claude was started with. */
async function launch(agent: string, mode: TaskRoute['mode']) {
  const { deps, argv } = claudeToolsRig();
  const outcome = await runAgent(
    {
      agent,
      brief: 'look',
      cwd: tempDir('nep-claude-cwd-'),
      timeoutMs: 20_000,
      route: claudeRoute(mode),
    },
    deps
  );
  assert.equal(outcome.ok, true);
  return argv();
}

test('a read run of any agent names the shell and web tools in --tools and --allowedTools, and no edit tool', async () => {
  // Bug: the claude recipe passed no tool flags, so a read agent's shell command was denied.
  // The prompt is an agent's only limit, so every run gets the web tools too.
  const argv = await launch('server', 'read');
  const expected = ['Bash', 'Glob', 'Grep', 'Read', 'WebFetch', 'WebSearch'];
  assert.deepEqual(namesOf(argv, '--tools'), expected);
  assert.deepEqual(namesOf(argv, '--allowedTools'), expected);
  assert.equal(argv.includes(SKIP), false);
});

test('a write run adds Edit and Write to both lists', async () => {
  // Bug: an agent run reached the model but its edits were denied.
  // Every run gets the web tools.
  const argv = await launch('dev', 'write');
  const expected = ['Bash', 'Edit', 'Glob', 'Grep', 'Read', 'WebFetch', 'WebSearch', 'Write'];
  assert.deepEqual(namesOf(argv, '--tools'), expected);
  assert.deepEqual(namesOf(argv, '--allowedTools'), expected);
  assert.equal(argv.includes(SKIP), false);
});

for (const mode of ['full', 'sudo'] as const) {
  test(`a ${mode} run passes --dangerously-skip-permissions`, async () => {
    // Bug: a run without a sandbox still had its tools denied.
    assert.ok((await launch('dev', mode)).includes(SKIP));
  });
}

for (const mode of ['read', 'write'] as const) {
  test(`a ${mode} run never passes --dangerously-skip-permissions or a bypass mode`, async () => {
    // Bug: the bypass flag spreading to the held modes would leave the unit's sandbox the only guard.
    const argv = await launch('scout', mode);
    assert.equal(argv.includes(SKIP), false);
    assert.equal(argv.includes('--allow-dangerously-skip-permissions'), false);
    assert.equal(argv.includes('bypassPermissions'), false);
  });
}

// The backends as installed in the persona's private layer: `createInstalledBackend` starts the binary of
// `<private>/subharness/<backend>/` with that folder's home in the environment, and refuses with `not-installed` when the
// folder holds no binary, whatever is on PATH. The installed binary is a link to the stub tests/fixtures/fake-cli.ts,
// which reports its environment.
/** Puts the stub where `backend` is installed in `privateDir`. */
function install(privateDir: string, backend: BackendName): void {
  const { binary } = subharnessPlace(privateDir, backend);
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.symlinkSync(STUB, binary);
}

test('a backend that is not in the private folder is refused not-installed and nothing is spawned, though PATH has one', async () => {
  // Catches: the run falls back to the claude of the user's own ~/.local/bin, logged in to the user's account and not
  // the persona's.
  const privateDir = tempDir('nep-installed-');
  const userBin = tempDir('nep-user-bin-');
  fs.writeFileSync(path.join(userBin, 'claude'), '#!/bin/sh\necho from-the-user\n', { mode: 0o755 });
  fs.chmodSync(path.join(userBin, 'claude'), 0o755);
  let spawned = 0;
  const counting = ((...args: Parameters<typeof spawn>) => {
    spawned += 1;
    return spawn(...args);
  }) as typeof spawn; // the counter forwards every argument to the real spawn unchanged
  const { dir, cleanup } = scratch();
  try {
    const result = await createInstalledBackend('claude', privateDir, { spawnImpl: counting }).run('hello', {
      cwd: dir,
      timeoutMs: 20_000,
      env: { PATH: `${userBin}:${process.env.PATH ?? ''}` },
    });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'not-installed');
    assert.equal(result.exitCode, null);
    assert.equal(result.text, '');
    assert.equal(spawned, 0);
  } finally {
    cleanup();
  }
});

test('each installed backend runs from the private folder with its home in the environment', async () => {
  // Catches: the binary runs with the user's HOME alone, so codex reads ~/.codex, claude ~/.claude and OpenCode ~/.config.
  for (const backend of ['claude', 'codex', 'opencode'] as const) {
    const privateDir = tempDir('nep-installed-');
    install(privateDir, backend);
    const { dir, cleanup } = scratch();
    try {
      const result = await createInstalledBackend(backend, privateDir).run('hello', {
        cwd: dir,
        timeoutMs: 20_000,
        env: { FAKE_MODE: 'report' },
      });
      assert.equal(result.ok, true, backend);
      const seen = reportOf(result.text).env;
      for (const [name, value] of Object.entries(subharnessPlace(privateDir, backend).env))
        assert.equal(seen[name], value, `${backend} ${name}`);
    } finally {
      cleanup();
    }
  }
});

test("the private home wins over a home the caller passes, so a run never reaches the user's ~/.codex", async () => {
  // Catches: options.env is laid over the place's environment and a caller's CODEX_HOME=~/.codex points codex home.
  const privateDir = tempDir('nep-installed-');
  install(privateDir, 'codex');
  const { dir, cleanup } = scratch();
  try {
    const result = await createInstalledBackend('codex', privateDir).run('hello', {
      cwd: dir,
      timeoutMs: 20_000,
      env: { FAKE_MODE: 'report', CODEX_HOME: '/home/alice/.codex' },
    });
    assert.equal(reportOf(result.text).env.CODEX_HOME, subharnessPlace(privateDir, 'codex').env.CODEX_HOME);
  } finally {
    cleanup();
  }
});

// What each backend can bound, and proof at the spawn boundary. `backendLimits` says which step and output limits a
// backend enforces and through what; a fake executable reports the argv and environment it was really started with, so
// a claim without a control fails. Codex has neither control in this adapter, and says so: the timeout alone bounds it,
// and a run that asked for a cap carries a gap. Claude's JSON gives a run's real usage, which reaches the errand's usage.
// No backend, provider or core is started.
const STEP_CAP = 7;

const OUTPUT_CAP = 1200;

/** One run of `name` through the seam every agent run uses, on the stub; what the stub saw, and the result. */
async function runOn(name: BackendName, dir: string) {
  const deps: RunDeps = {
    privateDir: dir,
    hostEnv: { PATH: process.env.PATH },
    backendFactory: (backend) => createBackend(backend, { binary: STUB }),
  };
  const result = await runAgent(
    {
      agent: 'scout',
      brief: 'look',
      cwd: dir,
      timeoutMs: 20_000,
      maxSteps: STEP_CAP,
      maxOutputTokens: OUTPUT_CAP,
      env: { FAKE_MODE: 'report' },
      route: { backend: name, model: 'x/model', effort: null, mode: 'read' },
      ...(name === 'opencode' ? { routeKey: 'route-key' } : {}),
    },
    deps
  );
  return { result, seen: reportOf(result.text) };
}

test('claude claims its step and output limits, and the spawned process carries both', async () => {
  // Bug: the capability says enforced while the flag or the variable never reaches the child.
  assert.deepEqual(backendLimits('claude'), {
    steps: { enforced: true, via: '--max-turns' },
    output: { enforced: true, via: 'CLAUDE_CODE_MAX_OUTPUT_TOKENS' },
  });
  const { dir, cleanup } = scratch();
  try {
    const { seen, result } = await runOn('claude', dir);
    assert.equal(seen.argv[seen.argv.indexOf('--max-turns') + 1], String(STEP_CAP));
    assert.equal(seen.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, String(OUTPUT_CAP));
    assert.deepEqual(result.gaps ?? [], []);
  } finally {
    cleanup();
  }
});

test('opencode claims its output limit and no step limit, and the spawned process carries the output cap', async () => {
  // Bug: the output cap of the memory writer's sibling path is dropped on the floor and nobody can tell.
  // OpenCode gets no step cap, because at the cap it appends an assistant turn that Gemini and Anthropic refuse. Like Codex, only the timeout bounds it.
  assert.deepEqual(backendLimits('opencode'), {
    steps: { enforced: false, bound: 'timeout' },
    output: { enforced: true, via: 'OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX' },
  });
  const { dir, cleanup } = scratch();
  try {
    const { seen, result } = await runOn('opencode', dir);
    assert.equal(seen.env.OPENCODE_CONFIG_CONTENT, undefined);
    assert.equal(seen.env.OPENCODE_EXPERIMENTAL_OUTPUT_TOKEN_MAX, String(OUTPUT_CAP));
    assert.deepEqual(result.gaps ?? [], ['step-limit-not-enforced']);
  } finally {
    cleanup();
  }
});

test('codex claims no cap, gets no flag for one, and a run that asked for caps reports the gap', async () => {
  // Bug: the scout's 25 steps read as enforced on codex, where only the timeout ends a run that loops.
  assert.deepEqual(backendLimits('codex'), {
    steps: { enforced: false, bound: 'timeout' },
    output: { enforced: false, bound: 'timeout' },
  });
  const { dir, cleanup } = scratch();
  try {
    const { seen, result } = await runOn('codex', dir);
    assert.equal(seen.argv.includes('--max-turns'), false);
    assert.equal(seen.env.CLAUDE_CODE_MAX_OUTPUT_TOKENS, undefined);
    assert.deepEqual([...(result.gaps ?? [])].sort(), ['output-limit-not-enforced', 'step-limit-not-enforced']);
  } finally {
    cleanup();
  }
});

/** A stand-in for `claude -p --output-format json`: prints `FAKE_ENVELOPE` and reads the brief. */
function envelopeBinary(dir: string): string {
  const file = path.join(dir, 'claude-json');
  fs.writeFileSync(file, '#!/bin/sh\ncat >/dev/null\nprintf "%s" "$FAKE_ENVELOPE"\n', { mode: 0o755 });
  return file;
}

const ENVELOPE = {
  type: 'result',
  subtype: 'success',
  is_error: false,
  result: 'an answer',
  num_turns: 3,
  usage: { input_tokens: 120, cache_read_input_tokens: 30, cache_creation_input_tokens: 10, output_tokens: 45 },
};

test('a claude run reads its answer and its real usage out of the JSON it printed', async () => {
  // Bug: every claude run reports zero usage, because the plain text form carries none.
  const { dir, cleanup } = scratch();
  try {
    const backend = createBackend('claude', { binary: envelopeBinary(dir) });
    const result = await backend.run('hello', {
      cwd: dir,
      timeoutMs: 20_000,
      env: { FAKE_ENVELOPE: JSON.stringify(ENVELOPE) },
    });
    assert.equal(result.ok, true);
    assert.equal(result.text, 'an answer');
    // BackendUsage carries dollars for OpenCode's step costs; claude reports none, so its usd is 0.
    assert.deepEqual(result.usage, { input: 160, cached: 30, output: 45, steps: 3, usd: 0 });
    const seen = reportOf(
      (
        await createBackend('claude', { binary: STUB }).run('hello', {
          cwd: dir,
          timeoutMs: 20_000,
          env: { FAKE_MODE: 'report' },
        })
      ).text
    );
    // stream-json with --verbose, not json: json prints only the last message as `result`, so a final answer claude
    // resumed after the output cap lost its head (session-bugs row 33).
    assert.equal(seen.argv[seen.argv.indexOf('--output-format') + 1], 'stream-json');
    assert.ok(seen.argv.includes('--verbose'));
  } finally {
    cleanup();
  }
});

/** One line of claude's stream-json for a message's content block. */
const assistantLine = (id: string, block: Record<string, unknown>, stop: string): string =>
  JSON.stringify({ type: 'assistant', message: { id, role: 'assistant', content: [block], stop_reason: stop } });

test('a claude run resumed after the output cap answers with its whole final answer, not the last message', async () => {
  // Bug: the answer read from `result`, which holds only the message after claude's own resume prompt, so the errand
  // delivers the tail of its answer. The lines follow the shape of claude's transcripts: a tool round with its
  // narration, a final message cut at max_tokens, the resume prompt, and a second message that ends the answer.
  const { dir, cleanup } = scratch();
  try {
    const stream = [
      JSON.stringify({ type: 'system', subtype: 'init', model: 'x/model' }),
      assistantLine('msg_1', { type: 'text', text: 'Looking it up.' }, 'tool_use'),
      assistantLine('msg_1', { type: 'tool_use', id: 'toolu_1', name: 'WebSearch', input: {} }, 'tool_use'),
      JSON.stringify({
        type: 'user',
        message: { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'toolu_1', content: 'found' }] },
      }),
      assistantLine('msg_2', { type: 'thinking', thinking: '' }, 'max_tokens'),
      assistantLine('msg_2', { type: 'text', text: 'The head of the answer, ' }, 'max_tokens'),
      JSON.stringify({ type: 'user', message: { role: 'user', content: 'Output token limit hit. Resume directly.' } }),
      assistantLine('msg_3', { type: 'text', text: 'and its tail.' }, 'end_turn'),
      JSON.stringify({ ...ENVELOPE, result: 'and its tail.' }),
    ].join('\n');
    const backend = createBackend('claude', { binary: envelopeBinary(dir) });
    const result = await backend.run('hello', { cwd: dir, timeoutMs: 20_000, env: { FAKE_ENVELOPE: stream } });
    assert.equal(result.ok, true);
    assert.equal(result.text, 'The head of the answer, and its tail.');
  } finally {
    cleanup();
  }
});

test('a claude run whose JSON says is_error failed, whatever its exit code', async () => {
  // Bug: the error text of a refused run is delivered as the errand's answer.
  const { dir, cleanup } = scratch();
  try {
    const backend = createBackend('claude', { binary: envelopeBinary(dir) });
    const result = await backend.run('hello', {
      cwd: dir,
      timeoutMs: 20_000,
      env: { FAKE_ENVELOPE: JSON.stringify({ ...ENVELOPE, is_error: true, result: 'Credit balance is too low' }) },
    });
    assert.equal(result.ok, false);
    assert.equal(result.text, '');
  } finally {
    cleanup();
  }
});

test('the usage of a run reaches the errand, with its steps', async () => {
  // Bug: the engine throws the backend's numbers away and the errand reads input 0, steps 0.
  const rig = consumerRig();
  const engine = consumers.engine({
    profile: rig.profile,
    agentPaths: rig.options,
    outDir: path.join(rig.base, 'out'),
    subharness: {
      ...rig.subharness,
      backendFactory: (name) => ({
        name,
        run: () =>
          Promise.resolve({
            ok: true,
            text: 'done',
            exitCode: 0,
            usage: { input: 160, cached: 30, output: 45, steps: 3, usd: 0 },
          }),
      }),
    },
  });
  try {
    const done = await engine.run({
      id: 'usage',
      agent: 'scout',
      goal: 'inspect synthetic files',
      context: {},
      signal: new AbortController().signal,
    });
    assert.equal(done.usage.input, 160);
    assert.equal(done.usage.output, 45);
    assert.equal(done.usage.steps, 3);
  } finally {
    rig.close();
  }
});

// src/agent-runner/backend.ts: an opencode run pinned to an OpenRouter provider. OpenCode reads its config from the file
// `OPENCODE_CONFIG` and from the inline `OPENCODE_CONFIG_CONTENT` and merges the two, so the test merges them the same
// way at the moment of the spawn and asserts on the result. OpenRouter's request body gets the model's `options`
// (the `openrouter` key of the AI SDK provider options), so `provider.openrouter.models.<id>.options.provider` is the
// block that reaches OpenRouter. The child is a fake; no request goes out.
type Json = Record<string, unknown>;

const MODEL = 'anthropic/claude-sonnet-5';

const STEPS_CONFIG = JSON.stringify({ agent: { build: { steps: 12 } } });

const isJson = (value: unknown): value is Json => typeof value === 'object' && value !== null && !Array.isArray(value);

/** OpenCode's merge: objects join key by key, anything else is replaced by the later file. */
function merged(base: Json, over: Json): Json {
  const out: Json = { ...base };
  for (const [key, value] of Object.entries(over)) {
    const before = out[key];
    out[key] = isJson(before) && isJson(value) ? merged(before, value) : value;
  }
  return out;
}

type Spawned = { config: Json; file: string | undefined; args: ReadonlyArray<string> };

/** One run on a fake child; the config the child would load is read while it runs. */
async function pinRunOnce(
  name: BackendName,
  options: Partial<BackendRunOptions>
): Promise<{ spawned: Array<Spawned>; error: string | undefined }> {
  const base = tempDir('nep-oc-provider-');
  const binary = path.join(base, 'fake-binary');
  fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const spawned: Array<Spawned> = [];
  const impl = (_binary: string, args: Array<string>, spawnOptions: { env: Record<string, string> }) => {
    const { OPENCODE_CONFIG: file, OPENCODE_CONFIG_CONTENT: inline } = spawnOptions.env;
    const fromFile = file === undefined ? {} : (JSON.parse(fs.readFileSync(file, 'utf8')) as Json);
    const fromEnv = inline === undefined ? {} : (JSON.parse(inline) as Json);
    spawned.push({ config: merged(fromFile, fromEnv), file, args });
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
  const backend = createBackend(name, { binary, spawnImpl: wrongly<typeof spawn>(impl) });
  const result = await backend.run('the task', { cwd: base, timeoutMs: 20_000, ...options });
  return { spawned, error: result.error };
}

/** The `options` OpenCode would hand OpenRouter for `model`, or undefined. */
function optionsOf(config: Json, model: string): unknown {
  const provider = config.provider;
  const openrouter = isJson(provider) ? provider.openrouter : undefined;
  const models = isJson(openrouter) ? openrouter.models : undefined;
  const entry = isJson(models) ? models[model] : undefined;
  return isJson(entry) ? entry.options : undefined;
}

test('a pinned opencode run sends OpenRouter the provider order with that provider alone and no fallback', async () => {
  // Catches: the pin never reaches the child, or it lists a provider as a preference while fallbacks stay on, so an
  // Anthropic model still runs at Bedrock when Anthropic is busy.
  const { spawned } = await pinRunOnce('opencode', { model: `openrouter/${MODEL}`, provider: 'anthropic' });
  assert.equal(spawned.length, 1);
  assert.deepEqual(optionsOf(spawned[0].config, MODEL), { provider: { order: ['anthropic'], allow_fallbacks: false } });
});

test('the pin is keyed by the model id without the openrouter/ prefix opencode is started with', async () => {
  // Catches: the block filed under `openrouter/anthropic/...`, a key OpenCode never looks up, so the pin does nothing.
  const { spawned } = await pinRunOnce('opencode', { model: `openrouter/${MODEL}`, provider: 'anthropic' });
  const { config } = spawned[0];
  const provider = config.provider;
  const openrouter = isJson(provider) ? provider.openrouter : undefined;
  const models = isJson(openrouter) ? openrouter.models : undefined;
  assert.deepEqual(Object.keys(isJson(models) ? models : {}), [MODEL]);
});

test('the pin goes to the model of the run and to no other', async () => {
  // Catches: the block written for a wildcard or for every model, so a second model in the same config is pinned too.
  const { spawned } = await pinRunOnce('opencode', { model: 'openrouter/deepseek/deepseek-v4', provider: 'deepinfra' });
  assert.equal(optionsOf(spawned[0].config, MODEL), undefined);
  assert.deepEqual(optionsOf(spawned[0].config, 'deepseek/deepseek-v4'), {
    provider: { order: ['deepinfra'], allow_fallbacks: false },
  });
});

test('an opencode run with no provider sends no provider block at all', async () => {
  // Catches: an empty or default block on every run, which changes how all unpinned errands are routed.
  const { spawned } = await pinRunOnce('opencode', { model: `openrouter/${MODEL}` });
  assert.equal(Object.hasOwn(spawned[0].config, 'provider'), false);
});

test('a pin keeps the system prompt of the build agent in the same config', async () => {
  // Catches: the pin overwrites the config file that carries the preamble, or the preamble overwrites the pin.
  const { spawned } = await pinRunOnce('opencode', {
    model: `openrouter/${MODEL}`,
    provider: 'anthropic',
    system: 'SYSTEM',
  });
  const { config } = spawned[0];
  assert.deepEqual(config.agent, { build: { prompt: 'SYSTEM' } });
  assert.deepEqual(optionsOf(spawned[0].config, MODEL), { provider: { order: ['anthropic'], allow_fallbacks: false } });
});

test('a pin keeps the step cap that runAgent passes in OPENCODE_CONFIG_CONTENT', async () => {
  // Catches: the pin replaces the inline config, so the run loses its steps cap and can loop past it.
  const { spawned } = await pinRunOnce('opencode', {
    model: `openrouter/${MODEL}`,
    provider: 'anthropic',
    env: { OPENCODE_CONFIG_CONTENT: STEPS_CONFIG },
  });
  const { config } = spawned[0];
  assert.deepEqual(config.agent, { build: { steps: 12 } });
  assert.deepEqual(optionsOf(spawned[0].config, MODEL), { provider: { order: ['anthropic'], allow_fallbacks: false } });
});

test('the config file of a pinned run is gone when the run ends', async () => {
  // Catches: the config left in the temp folder after the run, one file per errand.
  const { spawned } = await pinRunOnce('opencode', { model: `openrouter/${MODEL}`, provider: 'anthropic' });
  const file = spawned[0].file;
  // The pin may travel in the file or inline; only a file there is has to be removed.
  assert.equal(file === undefined ? false : fs.existsSync(file), false);
});

test('the pin adds no argument to the opencode command line', async () => {
  // Catches: the provider passed as a flag opencode does not have, so the child exits 1 on every pinned run.
  const pinned = await pinRunOnce('opencode', { model: `openrouter/${MODEL}`, provider: 'anthropic' });
  const plain = await pinRunOnce('opencode', { model: `openrouter/${MODEL}` });
  const [pinnedChild] = pinned.spawned;
  const [plainChild] = plain.spawned;
  assert.deepEqual(pinnedChild.args, plainChild.args);
});

for (const name of ['claude', 'codex'] as const) {
  test(`a provider on a ${name} run is refused as provider-unsupported and nothing is spawned`, async () => {
    // Catches: the pin silently dropped, so the run goes out unpinned while the route says it is pinned.
    const { spawned, error } = await pinRunOnce(name, { model: 'some-model', provider: 'anthropic' });
    assert.equal(error, 'provider-unsupported');
    assert.deepEqual(spawned, []);
  });
}

// OpenCode's permission keys (https://opencode.ai/docs/permissions, v1): `"*"` sets every permission, a later key
// overrides it, `edit` gates write, edit and apply_patch, and `external_directory` gates a path outside the folder.
const PERMISSIONS = [
  { sandbox: 'read-only', permission: { '*': 'allow', edit: 'deny' } },
  { sandbox: 'workspace-write', permission: { '*': 'allow' } },
  { sandbox: 'none', permission: { '*': 'allow' } },
] as const;

for (const { sandbox, permission } of PERMISSIONS) {
  test(`an opencode run in the ${sandbox} sandbox writes a permission block that never asks`, async () => {
    // Catches: the sandbox ignored, so OpenCode keeps its default "ask" for a path outside the run's folder and a
    // headless run refuses the call and ends with no text.
    const { spawned } = await pinRunOnce('opencode', { sandbox });
    const { config } = spawned[0];
    assert.deepEqual(config.permission, permission);
    const written = JSON.stringify(config.permission);
    assert.equal(written.includes('ask'), false);
  });
}

test('an opencode run with no sandbox writes no permission block', async () => {
  // Catches: a permission block forced on a caller that passes no sandbox, which changes what that run may do.
  const { spawned } = await pinRunOnce('opencode', {});
  const { config } = spawned[0];
  assert.equal(Object.hasOwn(config, 'permission'), false);
});

// src/agent-runner/backend.ts: an OpenCode run prints its events as JSON lines (`opencode run --format json`). Each
// `tool_use` event of the `websearch` tool whose `part.state.status` is `error` (Exa's 429, for one) is a failed web
// search. The backend counts them into `BackendResult.searchFailures` (absent when there are none), logs the count with no
// contents, and keeps the answer: the text of the run is the `text` events' `part.text`. The engine
// (`createAgentEngine`) puts the count on the task's `result.searchFailures`. The child is a fake; no request goes out.
type Task = Parameters<ReturnType<typeof createAgentEngine>['run']>[0];

const ANSWER = 'The release notes are at the project site.';

const ERROR_TEXT = 'Too Many Requests: rate limit reached for the free Exa endpoint';

const QUERY = 'zebra-crossing-release-notes-query';

const tool = (name: string, status: string, error?: string) =>
  JSON.stringify({
    type: 'tool_use',
    timestamp: 1,
    sessionID: 'ses_1',
    part: {
      type: 'tool',
      tool: name,
      callID: `call-${name}-${status}`,
      state: { status, input: { query: QUERY }, ...(error === undefined ? {} : { error }) },
    },
  });

const text = (words: string) => JSON.stringify({ type: 'text', part: { type: 'text', text: words } });

/** The stdout of an OpenCode run: two failed web searches among other events and a line that is no JSON. */
const EVENTS = [
  tool('websearch', 'error', ERROR_TEXT),
  tool('websearch', 'completed'),
  tool('webfetch', 'error', 'connection reset'),
  'opencode: a log line that is not an event',
  tool('websearch', 'error', ERROR_TEXT),
  text(ANSWER),
].join('\n');

/** A fake spawn whose child prints `stdout` and exits with `code`. */
function eventSpawn(stdout: string, code = 0): typeof spawn {
  const impl = () => {
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      pid: undefined,
      kill: () => true,
    });
    child.stdin.resume();
    setImmediate(() => {
      child.stdout.write(`${stdout}\n`);
      setImmediate(() => child.emit('close', code));
    });
    return child;
  };
  return wrongly<typeof spawn>(impl);
}

function backendOf(name: BackendName, stdout: string) {
  const base = tempDir('nep-oc-sfail-');
  const binary = path.join(base, 'fake-binary');
  fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return { base, binary, backend: createBackend(name, { binary, spawnImpl: eventSpawn(stdout) }) };
}

const OPTIONS = (cwd: string) => ({ cwd, timeoutMs: 5_000, env: { OPENCODE_ENABLE_EXA: '1' } });

test('an opencode run counts its failed websearch calls and ignores the completed websearch and the failed webfetch', async () => {
  // Catches: a failed web search going unseen (the run reads as a clean answer), or other failed tools inflating the count.
  const { base, backend } = backendOf('opencode', EVENTS);
  const result = await backend.run('find the release notes', OPTIONS(base));
  assert.equal(result.searchFailures, 2);
});

test('an opencode run with failed searches still answers with the text events', async () => {
  // Catches: reading events instead of plain text drops the answer, so every run ends empty-answer.
  const { base, backend } = backendOf('opencode', EVENTS);
  const result = await backend.run('find the release notes', OPTIONS(base));
  assert.equal(result.ok, true);
  assert.equal(result.text, ANSWER);
});

test('an opencode run with no failed websearch has no searchFailures field', async () => {
  // Catches: a zero count carried on every result, which would print a failure notice for a clean run.
  const { base, backend } = backendOf('opencode', [tool('websearch', 'completed'), text(ANSWER)].join('\n'));
  const result = await backend.run('find the release notes', OPTIONS(base));
  assert.equal(Object.hasOwn(result, 'searchFailures'), false);
  assert.equal(result.text, ANSWER);
});

test('a codex run whose output looks like OpenCode events reports no searchFailures', async () => {
  // Catches: the event reader applied to every backend, so a codex answer that quotes JSON is counted as failures.
  const { base, backend } = backendOf('codex', EVENTS);
  const result = await backend.run('find the release notes', OPTIONS(base));
  assert.equal(Object.hasOwn(result, 'searchFailures'), false);
});

test('the backend run log line carries the count of failed searches and none of their contents', async () => {
  // Catches: the failure going unlogged, or the error text or the query leaking into the journal.
  const { base, backend } = backendOf('opencode', EVENTS);
  const { logs } = await withCapturedLogs(() => backend.run('find the release notes', OPTIONS(base)));
  const line = logs.find((entry) => entry.msg === 'agent-runner: backend run');
  assert.ok(line, 'the run was logged');
  assert.equal(JSON.stringify(line).includes('"searchFailures":2'), true);
  const journal = JSON.stringify(logs);
  assert.equal(journal.includes(ERROR_TEXT), false);
  assert.equal(journal.includes(QUERY), false);
});

test('the engine puts the count on the task result of an opencode run', async () => {
  // Catches: the count stopping at the backend, so the errand's result never says the search failed.
  const base = tempDir('nep-oc-sfail-engine-');
  const binary = path.join(base, 'fake-binary');
  fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const prompt = path.join(base, 'agent.md');
  fs.writeFileSync(prompt, 'You are an errand agent.');
  const profile = {
    name: 'scout',
    agentId: 'errand-scout',
    promptFiles: [prompt],
    defaultLimits: { steps: 5, seconds: 30 },
    defaultSearchProvider: 'exa',
    sandbox: 'read-only',
    unit: 'scout',
  };
  const engine = createAgentEngine({
    profile: profile as unknown as Parameters<typeof createAgentEngine>[0]['profile'],
    outDir: path.join(base, 'out'),
    subharness: {
      privateDir: path.join(base, 'private'),
      hostEnv: { PATH: '/usr/bin' },
      backendFactory: (name) => createBackend(name, { binary, spawnImpl: eventSpawn(EVENTS) }),
    },
  });
  const task = {
    id: 'sf1',
    goal: 'find the release notes',
    context: {},
    route: { backend: 'opencode', model: null, effort: null, mode: 'read' },
    secrets: { openrouterKey: 'sk-or-v1-task-secret-0123456789' },
  } as unknown as Task;
  const outcome = await engine.run(task);
  assert.equal(outcome.status, 'done');
  assert.equal(outcome.result.text, ANSWER);
  assert.equal(outcome.result.searchFailures, 2);
});

const stepFinish = (part: Record<string, unknown>) =>
  JSON.stringify({ type: 'step_finish', part: { type: 'step-finish', reason: 'stop', ...part } });

/** Two model steps with invented counts and costs. */
const STEP_EVENTS = [
  stepFinish({ tokens: { input: 7, output: 40, reasoning: 5, cache: { write: 1000, read: 0 } }, cost: 0.25 }),
  text(ANSWER),
  stepFinish({ tokens: { input: 2, output: 10, reasoning: 0, cache: { write: 30, read: 1000 } }, cost: 0.125 }),
].join('\n');

test('an opencode run sums the tokens, cached tokens, steps and dollars of its step_finish events', async () => {
  // Catches: OpenCode runs recording zero usage, or the cache counts left out of the input.
  const { base, backend } = backendOf('opencode', STEP_EVENTS);
  const result = await backend.run('find the release notes', OPTIONS(base));
  assert.deepEqual(result.usage, { input: 2039, cached: 1000, output: 55, steps: 2, usd: 0.375 });
});

test('an opencode run with no step_finish event has no usage', async () => {
  // Catches: a zero usage invented for a run that reported none.
  const { base, backend } = backendOf('opencode', text(ANSWER));
  const result = await backend.run('find the release notes', OPTIONS(base));
  assert.equal(result.usage, undefined);
});

test('a step_finish with no cost and no tokens counts as zeros and still counts as a step', async () => {
  // Catches: a partial event dropping the step or turning the sums into NaN.
  const { base, backend } = backendOf('opencode', [stepFinish({}), text(ANSWER)].join('\n'));
  const result = await backend.run('find the release notes', OPTIONS(base));
  assert.deepEqual(result.usage, { input: 0, cached: 0, output: 0, steps: 1, usd: 0 });
});

test('the engine puts the dollars and steps of an opencode run on the task usage', async () => {
  // Catches: the dollars stopping at the backend, so the errand record keeps usd 0.
  const base = tempDir('nep-oc-usage-engine-');
  const binary = path.join(base, 'fake-binary');
  fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const prompt = path.join(base, 'agent.md');
  fs.writeFileSync(prompt, 'You are an errand agent.');
  const profile = {
    name: 'scout',
    agentId: 'errand-scout',
    promptFiles: [prompt],
    defaultLimits: { steps: 5, seconds: 30 },
    defaultSearchProvider: 'exa',
    sandbox: 'read-only',
    unit: 'scout',
  };
  const engine = createAgentEngine({
    profile: profile as unknown as Parameters<typeof createAgentEngine>[0]['profile'],
    outDir: path.join(base, 'out'),
    subharness: {
      privateDir: path.join(base, 'private'),
      hostEnv: { PATH: '/usr/bin' },
      backendFactory: (name) => createBackend(name, { binary, spawnImpl: eventSpawn(STEP_EVENTS) }),
    },
  });
  const task = {
    id: 'u1',
    goal: 'find the release notes',
    context: {},
    route: { backend: 'opencode', model: null, effort: null, mode: 'read' },
    secrets: { openrouterKey: 'sk-or-v1-task-secret-0123456789' },
  } as unknown as Task;
  const outcome = await engine.run(task);
  assert.equal(outcome.usage.usd, 0.375);
  assert.equal(outcome.usage.steps, 2);
  assert.equal(outcome.usage.input, 2039);
});

// OpenCode's own `websearch` stays usable on an engine run: the permission block written for the run does not deny it.
// The child is a fake; no request goes out.
const EXA_RUN_KEY = 'sk-or-v1-task-secret-0123456789';

const exaRoute = (backend: TaskRoute['backend']): TaskRoute => ({ backend, model: null, effort: null, mode: 'read' });

const EXA_TASK = { id: 't1', goal: 'find the release notes', context: {} } as unknown as Task;

/** What the fake child saw: its environment and the config file it would load, read while it ran. */
type ExaSeen = { env: Record<string, string>; config: Json };

/** One engine run of the task `extra`; returns what each spawned child saw. */
async function exaRunOnce(extra: Record<string, unknown>): Promise<Array<ExaSeen>> {
  const base = tempDir('nep-oc-exa-');
  const binary = path.join(base, 'fake-binary');
  fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const prompt = path.join(base, 'agent.md');
  fs.writeFileSync(prompt, 'You are an errand agent.');
  const seen: Array<ExaSeen> = [];
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
    defaultLimits: { steps: 5, seconds: 30 },
    sandbox: 'read-only',
    unit: 'scout',
  };
  const engine = createAgentEngine({
    profile: profile as unknown as Parameters<typeof createAgentEngine>[0]['profile'],
    outDir: path.join(base, 'out'),
    subharness: {
      privateDir: path.join(base, 'private'),
      hostEnv: { PATH: '/usr/bin' },
      backendFactory: (name) => createBackend(name, { binary, spawnImpl: wrongly<typeof spawn>(impl) }),
    },
  });
  await engine.run({ ...EXA_TASK, ...extra });
  return seen;
}

test('an opencode run with exa does not deny websearch in the permissions written for the run', async () => {
  // Catches: the run's permission block, where one is written, still denies websearch, so the tool OpenCode shows cannot be used.
  const [child] = await exaRunOnce({ id: 'e4', route: exaRoute('opencode'), secrets: { openrouterKey: EXA_RUN_KEY } });
  assert.ok(child, 'the child was spawned');
  const permission = child.config.permission;
  // The block may allow websearch through `"*"` (every permission), which OpenCode applies when no later key names it.
  if (isJson(permission)) assert.equal(permission.websearch ?? permission['*'], 'allow');
});

// Where a task's preamble and the agent's own prompt reach the child of each backend: src/agent-runner/backend.ts
// (createAgentEngine, the recipes) through src/subharness/run.ts. The system instructions are the preamble first, then
// the agent's prompt; the prompt text is the task alone. The forms per backend, read off the installed binaries:
//   claude    `--system-prompt <text>` or `--system-prompt-file <path>`, which replace the built-in system prompt;
//   codex     `-c model_instructions_file=<path>`, which replaces codex's base instructions;
//   opencode  the run agent's `prompt` (the `build` agent unless `--agent` names another) in OPENCODE_CONFIG_CONTENT or
//             in the file OPENCODE_CONFIG names, inline or as `{file:<path>}`; OpenCode puts it before everything else.
// The children are a fake spawn that refuses, like Linux, any one argument or environment entry over 131071 bytes
// (measured on this server: 131072 bytes fail with E2BIG), so a long preamble must take a file form and arrive whole.
/** The longest single argument or `NAME=value` environment entry execve takes here, in bytes. */
const MAX_ARG_BYTES = 131_071;

const AGENT_PROMPT = 'AGENT-PROMPT: you are an errand agent; leave your findings in the working folder.';

const PREAMBLE = 'PREAMBLE-LAYER: the deployment speaks first.\nKeep answers short.';

const GOAL = 'look at the disk';

const CONTEXT = { recent: [{ author: 'someone', text: 'how full is it?' }] };

const BACKENDS: ReadonlyArray<BackendName> = ['claude', 'codex', 'opencode'];

/** What the fake child was given, read while it ran (a file form is read before the run removes it). */
type PreambleSeen = {
  system: string | null;
  prompt: string;
  /** stdin and every argument except the value of claude's `--system-prompt`: what the model may read as the user's */
  userSide: string;
  files: Array<string>;
  steps: unknown;
};

/** The value after `flag` in `args`, or undefined. */
const after = (args: ReadonlyArray<string>, flag: string): string | undefined => {
  const at = args.indexOf(flag);
  return at === -1 ? undefined : args[at + 1];
};

/** A TOML string value as codex reads it from `-c key=value`: basic or literal quotes, else the raw text. */
function tomlString(raw: string): string {
  if (raw.startsWith('"')) return JSON.parse(raw) as string;
  if (raw.startsWith("'") && raw.endsWith("'")) return raw.slice(1, -1);
  return raw;
}

/** An OpenCode config value that may point at a file: `{file:<path>}` reads the file. */
function opencodeText(value: unknown, files: Array<string>): string | null {
  if (typeof value !== 'string') return null;
  const match = /^\{file:(.+)\}$/.exec(value);
  if (!match) return value;
  files.push(match[1]);
  return fs.readFileSync(match[1], 'utf8');
}

/** The system instructions and the prompt text the child of `name` received. */
function seenBy(
  name: BackendName,
  args: ReadonlyArray<string>,
  env: Record<string, string>,
  stdin: string
): PreambleSeen {
  const seen = seenSystem(name, args, env, stdin);
  const userSide = [stdin, ...args.filter((_, at) => args[at - 1] !== '--system-prompt')].join('\n');
  return { ...seen, userSide };
}

/** The system instructions and the prompt text, as `seenBy` without the user side. */
function seenSystem(
  name: BackendName,
  args: ReadonlyArray<string>,
  env: Record<string, string>,
  stdin: string
): Omit<PreambleSeen, 'userSide'> {
  const files: Array<string> = [];
  if (name === 'claude') {
    const inline = after(args, '--system-prompt');
    const file = after(args, '--system-prompt-file');
    if (file !== undefined) files.push(file);
    const system = inline ?? (file === undefined ? null : fs.readFileSync(file, 'utf8'));
    return { system, prompt: stdin, files, steps: undefined };
  }
  if (name === 'codex') {
    const setting = args
      .filter((_, at) => at > 0 && (args[at - 1] === '-c' || args[at - 1] === '--config'))
      .find((value) => value.startsWith('model_instructions_file='));
    let system: string | null = null;
    if (setting !== undefined) {
      const file = tomlString(setting.slice('model_instructions_file='.length));
      files.push(file);
      system = fs.readFileSync(file, 'utf8');
    }
    return { system, prompt: stdin, files, steps: undefined };
  }
  const agentName = after(args, '--agent') ?? 'build';
  const configs: Array<Record<string, unknown>> = [];
  if (env.OPENCODE_CONFIG !== undefined) {
    files.push(env.OPENCODE_CONFIG);
    configs.push(JSON.parse(fs.readFileSync(env.OPENCODE_CONFIG, 'utf8')) as Record<string, unknown>);
  }
  if (env.OPENCODE_CONFIG_CONTENT !== undefined)
    configs.push(JSON.parse(env.OPENCODE_CONFIG_CONTENT) as Record<string, unknown>);
  let system: string | null = null;
  let steps: unknown;
  for (const config of configs) {
    const agent = (config.agent as Record<string, Record<string, unknown>> | undefined)?.[agentName];
    if (agent === undefined) continue;
    system = opencodeText(agent.prompt, files) ?? system;
    steps = agent.steps ?? steps;
  }
  return { system, prompt: args.at(-1) ?? '', files, steps };
}

/** A spawn that records what each child got and answers as the backend would; it refuses an over-long argument. */
function preambleSpawn(name: BackendName, seen: Array<PreambleSeen>) {
  const impl = (_binary: string, args: Array<string>, options: { env: Record<string, string> }) => {
    const tooLong = [...args, ...Object.entries(options.env).map(([key, value]) => `${key}=${value}`)].some(
      (entry) => Buffer.byteLength(entry, 'utf8') > MAX_ARG_BYTES
    );
    if (tooLong) throw Object.assign(new Error('spawn E2BIG'), { code: 'E2BIG' });
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      pid: undefined,
      kill: () => true,
    });
    let stdin = '';
    child.stdin.setEncoding('utf8');
    child.stdin.on('data', (chunk: string) => {
      stdin += chunk;
    });
    child.stdin.on('end', () => {
      seen.push(seenBy(name, args, options.env, stdin));
      if (name === 'claude') child.stdout.write(JSON.stringify({ type: 'result', result: 'done', is_error: false }));
      else if (name === 'codex') fs.writeFileSync(after(args, '-o') ?? '', 'done');
      else child.stdout.write('done');
      setImmediate(() => child.emit('close', 0));
    });
    return child;
  };
  return wrongly<typeof spawn>(impl);
}

/** An engine of the agent scout whose every run goes to the fake child of `name`, on a route that names it. */
function preambleRig(name: BackendName) {
  const base = tempDir('nep-preamble-system-');
  const promptFile = path.join(base, 'agent.md');
  fs.writeFileSync(promptFile, AGENT_PROMPT);
  const binary = path.join(base, 'fake-binary');
  fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const seen: Array<PreambleSeen> = [];
  const profile = {
    name: 'scout',
    agentId: 'errand-scout',
    promptFiles: [promptFile],
    defaultLimits: { steps: 5, seconds: 30 },
    sandbox: 'read-only',
    unit: 'scout',
  };
  const engine = createAgentEngine({
    profile: profile as unknown as Parameters<typeof createAgentEngine>[0]['profile'],
    outDir: path.join(base, 'out'),
    subharness: {
      privateDir: path.join(base, 'private'),
      hostEnv: { PATH: '/usr/bin' },
      backendFactory: (backend) => createBackend(backend, { binary, spawnImpl: preambleSpawn(backend, seen) }),
    },
  });
  const route: TaskRoute = { backend: name, model: null, effort: null, mode: 'read' };
  const task = (id: string, preamble?: string) =>
    ({
      id,
      goal: GOAL,
      context: CONTEXT,
      route,
      secrets: { openrouterKey: 'sk-or-v1-test-0123456789' },
      ...(preamble === undefined ? {} : { preamble }),
    }) as unknown as Parameters<typeof engine.run>[0];
  return { engine, seen, task };
}

/** The one child a run started; fails when the run started none (a refused spawn, an unread system form). */
function onlyChild(seen: Array<PreambleSeen>): PreambleSeen {
  assert.equal(seen.length, 1, 'the run started exactly one child');
  return seen[0];
}

/** Asserts `system` is `preamble`, then the agent's prompt, with only blank space between them. */
function assertLayers(given: string | null, preamble: string): void {
  const system = present(given, 'system instructions in the form of its backend');
  assert.ok(system.startsWith(preamble), 'the preamble opens the system instructions, whole');
  assert.ok(system.endsWith(AGENT_PROMPT), "the agent's own prompt follows the preamble");
  assert.equal(system.slice(preamble.length, system.length - AGENT_PROMPT.length).trim(), '', 'nothing between them');
}

for (const name of BACKENDS) {
  test(`${name}: the preamble opens the system instructions, the agent's prompt follows, the prompt is the task alone`, async () => {
    // Catches: the preamble and the agent's prompt still ride in the prompt text, where the model reads them as the
    // user's words, or the agent's prompt comes before the preamble.
    const { engine, seen, task } = preambleRig(name);
    const outcome = await engine.run(task('p1', PREAMBLE));
    assert.equal(outcome.status, 'done');
    const child = onlyChild(seen);
    assertLayers(child.system, PREAMBLE);
    assert.equal(child.prompt.trim(), taskPrompt(GOAL, CONTEXT));
    assert.ok(!child.userSide.includes('PREAMBLE-LAYER'), 'the preamble never appears on the user side');
    assert.ok(!child.userSide.includes('AGENT-PROMPT'), "the agent's prompt is not repeated on the user side");
  });

  test(`${name}: without a preamble the system instructions are the agent's prompt alone`, async () => {
    // Catches: a run with no preamble gets an empty first layer, a stray separator, or no system instructions at all.
    const { engine, seen, task } = preambleRig(name);
    const outcome = await engine.run(task('p2'));
    assert.equal(outcome.status, 'done');
    const child = onlyChild(seen);
    assert.equal(child.system, AGENT_PROMPT);
    assert.equal(child.prompt.trim(), taskPrompt(GOAL, CONTEXT));
  });

  test(`${name}: a preamble too long for one argument arrives whole, and its files are gone after the run`, async () => {
    // Catches: a long preamble passed inline fails the spawn with E2BIG, or is cut to fit, or a file holding the
    // deployment's private text stays in the temporary folder. 70000 two-byte characters are 140000 bytes, past the
    // 131071-byte limit of one argument though far under 100000 characters.
    const long = `LONG-START ${'é'.repeat(70_000)} ${'x'.repeat(60_000)} LONG-END`;
    const { engine, seen, task } = preambleRig(name);
    const outcome = await engine.run(task('p3', long));
    assert.equal(outcome.status, 'done', 'the child started');
    const child = onlyChild(seen);
    assertLayers(child.system, long);
    assert.ok(!child.userSide.includes('LONG-START'), 'the preamble never appears on the user side');
    for (const file of child.files) assert.equal(fs.existsSync(file), false, 'no file of the run is left behind');
  });
}

// The file that carries a run's system instructions (src/agent-runner/backend.ts, `BackendRunOptions.system`): the
// deployment's private preamble lands on disk for the length of one run, so it is mode 600 in a folder of mode 700,
// and it is gone when the run ends, whether the child succeeded, failed or never started.
const SYSTEM = 'PRIVATE-PREAMBLE: the deployment speaks first.';

/** The path of the file that holds the system instructions, as the child of `name` is told it. */
function systemPathOf(name: BackendName, args: ReadonlyArray<string>, env: Record<string, string>): string {
  if (name === 'claude') return args[args.indexOf('--system-prompt-file') + 1];
  if (name === 'codex') {
    const setting = args.find((value) => value.startsWith('model_instructions_file=')) ?? '';
    return JSON.parse(setting.slice('model_instructions_file='.length)) as string;
  }
  return env.OPENCODE_CONFIG;
}

type SystemFileSeen = { file: string; fileMode: number; dirMode: number; holds: boolean };

/** A spawn that records the system file while the child runs, then exits with `exitCode`, or throws when `refuse`. */
function systemFileSpawn(
  name: BackendName,
  seen: Array<SystemFileSeen>,
  { exitCode, refuse }: { exitCode: number; refuse: boolean }
) {
  const impl = (_binary: string, args: Array<string>, options: { env: Record<string, string> }) => {
    const file = systemPathOf(name, args, options.env);
    seen.push({
      file,
      fileMode: fs.statSync(file).mode & 0o777,
      dirMode: fs.statSync(path.dirname(file)).mode & 0o777,
      holds: fs.readFileSync(file, 'utf8').includes(SYSTEM),
    });
    if (refuse) throw Object.assign(new Error('spawn E2BIG'), { code: 'E2BIG' });
    const child = Object.assign(new EventEmitter(), {
      stdout: new PassThrough(),
      stderr: new PassThrough(),
      stdin: new PassThrough(),
      pid: undefined,
      kill: () => true,
    });
    child.stdin.resume();
    child.stdin.on('end', () => setImmediate(() => child.emit('close', exitCode)));
    return child;
  };
  return wrongly<typeof spawn>(impl);
}

/** One run of `name` with the system instructions, on a fake child that exits or refuses as told. */
async function systemFileRun(name: BackendName, how: { exitCode: number; refuse: boolean }) {
  const base = tempDir('nep-system-file-');
  const binary = path.join(base, 'fake-binary');
  fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const seen: Array<SystemFileSeen> = [];
  const backend = createBackend(name, { binary, spawnImpl: systemFileSpawn(name, seen, how) });
  const result = await backend.run('the task', { cwd: base, timeoutMs: 20_000, system: SYSTEM });
  assert.equal(seen.length, 1, 'the run reached the spawn once');
  return { result, file: seen[0] };
}

for (const name of BACKENDS) {
  test(`${name}: the system file is mode 600 in a folder of mode 700, and gone after a run that succeeded`, async () => {
    // Catches: the preamble written with the default umask (readable by other users of the host), or into a shared
    // folder, or left on disk once the run is over.
    const { file: written } = await systemFileRun(name, { exitCode: 0, refuse: false });
    assert.equal(written.holds, true, 'the file holds the system instructions');
    assert.equal(written.fileMode, 0o600);
    assert.equal(written.dirMode, 0o700);
    assert.equal(fs.existsSync(written.file), false, 'the file is removed');
    assert.equal(fs.existsSync(path.dirname(written.file)), false, 'its folder is removed');
  });

  test(`${name}: the system file is gone after a run whose child failed`, async () => {
    // Catches: the cleanup runs only on the success path, so every failed run leaves the preamble behind.
    const { result, file: written } = await systemFileRun(name, { exitCode: 1, refuse: false });
    assert.equal(result.ok, false);
    assert.equal(fs.existsSync(path.dirname(written.file)), false);
  });

  test(`${name}: the system file is gone after a run whose spawn was refused`, async () => {
    // Catches: a spawn that throws skips the cleanup, so the preamble stays when the child never started.
    const { result, file: written } = await systemFileRun(name, { exitCode: 0, refuse: true });
    assert.equal(result.ok, false);
    assert.equal(result.error, 'spawn');
    assert.equal(fs.existsSync(path.dirname(written.file)), false);
  });
}

// OpenCode runs without a step cap: at the cap OpenCode appends an assistant turn, and Gemini ("Requests ending with a
// model turn are not supported") and Anthropic ("does not support assistant message prefill") refuse it, so the run
// would die with exit 1 instead of ending. The time limit of the task bounds the run. A stub binary reports what it was
// started with; no backend or provider is started.
/** `deps` that start the stub in place of every backend. */
function depsIn(dir: string): RunDeps {
  return {
    privateDir: dir,
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

// The task engine of the runner (src/agent-runner/backend.ts#createAgentEngine) runs every task through the subharness
// seam (src/subharness/run.ts): refused while the subharness is off, run in the mode of the profile's agent otherwise.
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
    defaultLimits: { steps: 5, seconds: 30 },
    sandbox: 'read-only',
    unit: agent,
  };
  const engine = createAgentEngine({
    profile: profile as unknown as Parameters<typeof createAgentEngine>[0]['profile'],
    outDir: path.join(base, 'out'),
    subharness,
  });
  return { engine, calls, privateDir };
}

const ENGINE_TASK = { id: 't1', agent: 'scout', goal: 'look at the disk', context: {} } as unknown as Parameters<
  ReturnType<typeof createAgentEngine>['run']
>[0];

test('a task while the subharness is off fails with subharness-off and starts no backend', async () => {
  // Bug: the errand runner keeps working through a cached backend after the subharness was disabled.
  const { engine, calls } = engineRig(null, 'scout');
  const outcome = await engine.run(ENGINE_TASK);
  assert.equal(outcome.status, 'failed');
  assert.equal(outcome.error, 'subharness-off');
  assert.equal(calls.length, 0);
});

test("a task runs in the mode of its agent's unit", async () => {
  // Bug: the server unit runs read-only, its mode is set to write, and the engine still passes read-only. The mode
  // belongs to the unit, which is the server agent's own.
  const { engine, calls, privateDir } = engineRig('codex', 'server');
  await engine.run(ENGINE_TASK);
  await setUnitMode(privateDir, 'server', 'write');
  await engine.run({ ...ENGINE_TASK, id: 't2' });
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
    agent: 'scout',
    goal: 'inspect synthetic files',
    context: {},
    signal: new AbortController().signal,
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
    // The agent's prompt is part of the system instructions and stays out of the brief (see the preamble cases above),
    // so these read `options.system`.
    const [firstCall, secondCall] = rig.calls;
    assert.match(firstCall?.options.system ?? '', /PERSONAL-WORKER-FIRST/);
    assert.match(secondCall?.options.system ?? '', /PERSONAL-WORKER-SECOND/);
    for (const call of rig.calls) assert.doesNotMatch(call.options.system ?? '', /PRIVATE-DECOY-MARKER|shared marker/);
    fs.unlinkSync(path.join(rig.personal, 'prompt.md'));
    assert.equal(engine.checkPrompt(), 'shared marker');
    assert.equal((await engine.run({ ...task, id: 'fallback' })).status, 'done');
    const fallbackCall = rig.calls[2];
    assert.match(fallbackCall?.options.system ?? '', /shared marker/);
    assert.deepEqual(
      [fallbackCall?.name, fallbackCall?.options.model, fallbackCall?.options.effort],
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
    agent: 'scout',
    goal: 'inspect synthetic files',
    context: {},
    signal: new AbortController().signal,
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
  await engine.run(ENGINE_TASK);
  await engine.run({ ...ENGINE_TASK, id: 't2', limits: { steps: 2 } });
  assert.deepEqual(
    calls.map((one) => one.maxSteps),
    [5, 2]
  );
});

test('a run of any agent hands back the file it left in its folder', async () => {
  // Bug: the runner keeps the files of an agent its profile marks as answering in text, and the file the agent made
  // never reaches the errand, so nobody can see it to fix the agent's prompt.
  const base = tempDir('nep-engine-files-');
  const prompt = path.join(base, 'agent.md');
  fs.writeFileSync(prompt, 'You are an errand agent.');
  const privateDir = path.join(base, 'private');
  writeKeysFile(privateDir, { subharness: { key: null, modes: {}, uses: { scout: 'codex' } } });
  const saveAPicture = (_brief: string, options: BackendRunOptions) => {
    fs.writeFileSync(path.join(options.cwd, 'picture.png'), 'not really a picture');
    return Promise.resolve({ ok: true, text: 'answer', exitCode: 0 });
  };
  const subharness: RunDeps = {
    privateDir,
    hostEnv: { PATH: '/usr/bin' },
    backendFactory: (name) => ({ name, run: saveAPicture }),
  };
  const profile = { name: 'scout', unit: 'scout', promptFiles: [prompt], defaultLimits: { steps: 5, seconds: 30 } };
  const engine = createAgentEngine({
    profile: profile as unknown as Parameters<typeof createAgentEngine>[0]['profile'],
    outDir: path.join(base, 'out'),
    subharness,
  });
  const { result } = await engine.run(ENGINE_TASK);
  assert.equal(result.files.length, 1);
});

// src/agent-runner/backend.ts#createAgentEngine with a task that carries the route the core decided. Most tests use a
// fake backend whose keys.json connects codex, so a run that reads it is visible. The last two start a real disposable
// executable where claude is installed: it records its arguments and environment.
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
    defaultLimits: { steps: 5, seconds: 30 },
    sandbox: 'read-only',
    unit: 'scout',
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

// The run line carries no role model, so the route is the one source of the model.
test("a task's route picks the backend, model, effort and sandbox of the run, over keys.json", async () => {
  // Catches: the engine drops the route, so the run goes out on another backend or model than the route names.
  const { engine, calls } = fakeRig();
  const outcome = await engine.run({ ...TASK, id: 'r1', route: ROUTE });
  assert.equal(outcome.status, 'done');
  const [firstCall] = calls;
  assert.equal(firstCall?.name, 'claude');
  assert.equal(firstCall?.options.model, 'claude-opus-5-5');
  assert.equal(firstCall?.options.effort, 'medium');
  assert.equal(firstCall?.options.sandbox, 'read-only');
});

test("an opencode route runs on the key of the task's secrets", async () => {
  // Catches: the engine still withholds a task's secrets from every backend, so an opencode errand under the scout unit has no key.
  const { engine, calls } = fakeRig();
  const outcome = await engine.run({ ...TASK, id: 'r2', route: OPENCODE, secrets: { openrouterKey: TASK_KEY } });
  assert.equal(outcome.status, 'done');
  const [firstCall] = calls;
  assert.equal(firstCall?.name, 'opencode');
  const callEnv = firstCall?.options.env;
  assert.equal(callEnv?.OPENROUTER_API_KEY, TASK_KEY);
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
  const readCalls = reads.mock.calls;
  const opened = readCalls.filter((call) => String(call.arguments[0]).endsWith('keys.json'));
  t.mock.restoreAll();
  assert.equal(outcome.status, 'done');
  assert.equal(opened.length, 0);
  assert.equal(flagValue(argv(), '--model'), 'claude-opus-5-5');
  assert.ok(!env().includes(STORED));
  assert.ok(!env().includes('keys.json'));
});

// The runner's engine hands the proxy of a task's secrets to `runAgent`, which writes it into the child's environment.
// A fake backend records what it was given; nothing is spawned and nothing goes out.
const HTTP_FORM = 'http://login:pass-word@proxy.example:1080';

const CLAUDE: TaskRoute = { backend: 'claude', model: 'claude-opus-5-5', effort: 'medium', mode: 'read' };

function recordingDeps(): { deps: RunDeps; seen: Array<BackendRunOptions> } {
  const base = tempDir('nep-proxy-harness-');
  const privateDir = path.join(base, 'private');
  writeKeysFile(privateDir, { subharness: { backends: ['codex'], key: null, modes: {} } });
  const seen: Array<BackendRunOptions> = [];
  const deps: RunDeps = {
    privateDir,
    hostEnv: { PATH: '/usr/bin', HTTPS_PROXY: 'http://host-proxy.invalid:9' },
    backendFactory: (name) => ({
      name,
      run: (_brief: string, options: BackendRunOptions) => {
        seen.push(options);
        return Promise.resolve({ ok: true, text: 'done', exitCode: 0 });
      },
    }),
  };
  return { deps, seen };
}

test("the runner's engine passes the task's proxy to the child of every backend", async () => {
  // Catches: the engine keeps passing only the OpenRouter key, so the scout and server units run their children direct.
  const { deps, seen } = recordingDeps();
  const base = tempDir('nep-proxy-engine-');
  const prompt = path.join(base, 'agent.md');
  fs.writeFileSync(prompt, 'You are an errand agent.');
  const profile = {
    name: 'server',
    agentId: 'errand-server',
    promptFiles: [prompt],
    defaultLimits: { steps: 5, seconds: 30 },
    sandbox: 'read-only',
    unit: 'scout',
  };
  const engine = createAgentEngine({
    profile: profile as unknown as Parameters<typeof createAgentEngine>[0]['profile'],
    outDir: path.join(base, 'out'),
    subharness: deps,
  });
  const task = {
    id: 'e1',
    goal: 'look',
    context: {},
    route: CLAUDE,
    secrets: { proxy: HTTP_FORM },
  } as unknown as Parameters<typeof engine.run>[0];
  const outcome = await engine.run(task);
  assert.equal(outcome.status, 'done');
  const [firstRun] = seen;
  assert.equal(firstRun?.env?.HTTPS_PROXY, HTTP_FORM);
});

/** Calls `onRead(file)` before each read of a file by path, then reads it as asked; `undo` puts `fs` back. */
function atEachRead(onRead: (file: string) => void): { undo: () => void } {
  const original = fs.readFileSync;
  const wrapped = (file: unknown, ...rest: Array<unknown>): unknown => {
    if (typeof file === 'string') onRead(file);
    return Reflect.apply(original, fs, [file, ...rest]);
  };
  // The modules under test read through this object; a test replaces the one method for the length of one call.
  Object.assign(fs, { readFileSync: wrapped });
  return { undo: () => Object.assign(fs, { readFileSync: original }) };
}

test('new reproduction: a prompt swapped for a link after the check does not reach the brief', async () => {
  // Bug: the engine validates the definition, then opens the prompt by path, so a link placed in between sends the
  // contents of any readable file to the model as its instructions.
  const rig = consumerRig();
  const prompt = path.join(rig.personal, 'prompt.md');
  fs.mkdirSync(rig.personal, { recursive: true });
  fs.writeFileSync(prompt, 'PERSONAL-PROMPT');
  const outside = path.join(rig.base, 'outside-secret.txt');
  fs.writeFileSync(outside, 'OUTSIDE-SECRET-MARKER');
  const engine = consumers.engine({
    profile: rig.profile,
    agentPaths: rig.options,
    outDir: path.join(rig.base, 'out'),
    subharness: rig.subharness,
  });
  let swapped = false;
  const hook = atEachRead((read) => {
    if (read !== prompt || swapped) return;
    swapped = true;
    fs.rmSync(prompt);
    fs.symlinkSync(outside, prompt);
  });
  try {
    await engine.run({
      id: 'swapped',
      agent: 'scout',
      goal: 'inspect synthetic files',
      context: {},
      signal: new AbortController().signal,
    });
    for (const call of rig.calls) assert.doesNotMatch(call.brief, /OUTSIDE-SECRET-MARKER/);
  } finally {
    hook.undo();
    rig.close();
  }
});
