// The search switch of the `codex` backend in src/agent-runner/backend.ts, against the stub tests/fixtures/fake-cli.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBackend } from '../src/agent-runner/backend.ts';
import { STUB, reportOf, scratch } from './fixtures/backend-rig.ts';

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
