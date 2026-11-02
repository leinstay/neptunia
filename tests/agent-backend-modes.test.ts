// The codex flags of the sandbox values (src/agent-runner/backend.ts), against the stub binary
// (tests/fixtures/fake-cli.ts): `none` is the bypass flag the modes full and sudo map to (src/subharness/run.ts).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBackend } from '../src/agent-runner/backend.ts';
import { STUB, reportOf, scratch } from './fixtures/backend-rig.ts';

const codex = () => createBackend('codex', { binary: STUB });

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

test('with no sandbox given codex still runs read-only', async () => {
  // Bug: dropping the default while adding "none" leaves a run with no sandbox argument at all.
  const { dir, cleanup } = scratch();
  try {
    const { argv } = reportOf(
      (await codex().run('x', { cwd: dir, timeoutMs: 20_000, env: { FAKE_MODE: 'report' } })).text
    );
    assert.equal(argv[argv.indexOf('-s') + 1], 'read-only');
  } finally {
    cleanup();
  }
});
