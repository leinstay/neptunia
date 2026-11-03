// The `claude` backend of src/agent-runner/backend.ts: `claude -p` as a child process, the stub as its binary.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBackend } from '../src/agent-runner/backend.ts';
import { STUB, reportOf, scratch } from './fixtures/backend-rig.ts';

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
