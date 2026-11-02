// The effort of a run as each backend's own flag (src/agent-runner/backend.ts, spec 2026-11-02 PR 5 "A path per
// role"): codex takes `-c model_reasoning_effort=<level>`, claude `--effort <level>`, opencode the model variant
// `--variant <level>`. Against the stub binary (tests/fixtures/fake-cli.ts) in mode `report`, which answers with the argv
// it was given.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBackend } from '../src/agent-runner/backend.ts';
import type { BackendName } from '../src/agent-runner/backend.ts';
import type { EffortLevel } from '../src/llm/roles.ts';
import { STUB, reportOf, scratch } from './fixtures/backend-rig.ts';

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
