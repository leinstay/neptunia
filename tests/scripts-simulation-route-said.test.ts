// The line `simulationLlm` (scripts/lib/simulation-llm.ts) gives a paid script to print names the stored route in the
// route names: `core requests via claude-harness <model>`. keys.json keeps `backend: "claude"`. No CLI starts, no
// request leaves the process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulationLlm } from '../scripts/lib/simulation-llm.ts';
import type { CompleteResult } from '../src/llm/openrouter.ts';
import { writeKeysFile } from './fixtures/keys-file.ts';
import { fakeVendor } from './fixtures/fake-vendor.ts';
import { tempDir } from './fixtures/tmp.ts';

test('the script line says via claude-harness for a stored claude route', async () => {
  // Catches: the stderr line printing the stored word, so the owner reads a name he cannot type back.
  const dir = tempDir('nep-simulation-said-');
  writeKeysFile(dir, {
    extra: {},
    simulation: { key: null },
    subharness: {
      key: null,
      modes: {},
      core: null,
      simulation: { backend: 'claude', model: 'claude-opus-4-6', effort: null },
    },
  });
  fakeVendor(dir, 'claude', { loggedIn: true });
  const sim = simulationLlm('replay-cli', {
    env: { NEPTUNIA_DATA_DIR: dir },
    createDirect: () => ({
      complete: (): Promise<CompleteResult> => Promise.reject(new Error('no request is made')),
    }),
    getConfig: () => ({
      llm: {
        maxRequestTokens: 50_000,
        maxRequestsPerDay: 5000,
        subscription: { fallback: false, thinking: false, holdMs: 45_000 },
      },
    }),
    state: { data: {}, markDirty: () => {} },
    workDir: tempDir('nep-simulation-said-work-'),
  });
  try {
    assert.ok(sim.said.includes('core requests via claude-harness claude-opus-4-6'), sim.said);
    assert.equal(sim.said.includes('via claude '), false, sim.said);
  } finally {
    await sim.close();
  }
});
