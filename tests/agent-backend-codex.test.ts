// The `codex` backend of src/agent-runner/backend.ts: `codex exec` as a child process. The binary is the stub
// tests/fixtures/fake-cli.ts, which writes the final message to the `-o` file and prints `tokens used` like the real one.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBackend } from '../src/agent-runner/backend.ts';
import { STUB, reportOf, scratch } from './fixtures/backend-rig.ts';

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

// The search switch of the `codex` backend in src/agent-runner/backend.ts, against the stub tests/fixtures/fake-cli.ts.

const argvOf = async (search: boolean | undefined): Promise<Array<string>> => {
  const { dir, cleanup } = scratch();
  try {
    const env = { FAKE_MODE: 'report' };
    const result = await createBackend('codex', { binary: STUB }).run('look it up', {
      cwd: dir,
      timeoutMs: 20_000,
      env,
      ...(search === undefined ? {} : { search }),
    });
    return reportOf(result.text).argv;
  } finally {
    cleanup();
  }
};

test('turns web search on through -c web_search="live" and never the bare --search flag', async () => {
  // Bug: codex-cli 0.164.0 rejects `codex exec --search` with a usage error (exit 2), so every errand with search on failed in 40 ms.
  const argv = await argvOf(true);
  assert.ok(!argv.includes('--search'), 'the bare --search flag is not a codex exec option');
  const at = argv.indexOf('web_search="live"');
  assert.ok(at > 0 && argv[at - 1] === '-c', 'the run passes -c web_search="live"');
});

test('passes no search setting when search is false or unset', async () => {
  // Bug: every agent gets live web access, or the flag leaks into runs that did not ask for search.
  for (const search of [false, undefined]) {
    const argv = await argvOf(search);
    assert.ok(!argv.includes('--search'));
    assert.ok(!argv.some((arg) => arg.startsWith('web_search=')));
  }
});

// The codex flags of the sandbox values (src/agent-runner/backend.ts), against the stub binary
// (tests/fixtures/fake-cli.ts): `none` is the bypass flag the modes full and sudo map to (src/subharness/run.ts).

test('sandbox none runs codex with the bypass flag and no -s', async () => {
  // Bug: full and sudo still pass "-s workspace-write", so the mode the owner set changes nothing.
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
  // Bug: the model the owner chose per agent is dropped, or "-m undefined" is passed.
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
