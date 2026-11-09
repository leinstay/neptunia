// A launch asks nothing of a harness that carries her core (docs/setup.md, chat readiness): a harness is checked when it
// is installed or logged in and when a model is chosen on it, never when a chat opens. The private folder is a temp dir
// and the vendor CLI a fake that records each call, so no process of a real vendor starts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { evaluateReadiness, gatherHealth } from '../src/setup/readiness.ts';
import { writeKeysFile } from './fixtures/keys-file.ts';
import { fakeVendor } from './fixtures/fake-vendor.ts';
import { tempDir } from './fixtures/tmp.ts';

const CORE = { backend: 'claude', model: 'claude-opus-4-6', effort: null };

test('a launch reads a harness core as served and starts none of its CLI, logged out as it is', async () => {
  // Catches: every chat launch running the vendor's status command, a check at use the owner ruled out.
  const dir = tempDir('nep-readiness-harness-');
  writeKeysFile(dir, { subharness: { key: null, modes: {}, core: CORE } });
  const vendor = fakeVendor(dir, 'claude', { loggedIn: false });
  const health = await gatherHealth({
    privateDir: dir,
    dataDir: dir,
    unitDir: dir,
    link: () => Promise.resolve({ kind: 'down' }),
  });
  assert.deepEqual(vendor.calls(), []);
  assert.equal(health.model.harness, true);
  assert.equal(
    evaluateReadiness(health).failed.some((one) => one.requirement === 'core-model'),
    false
  );
});

test('a launch with her core on the API and no check recorded still names the missing check', async () => {
  // Catches: the harness rule read for every core, so a direct core with no checked model opens a chat that cannot answer.
  const dir = tempDir('nep-readiness-direct-');
  writeKeysFile(dir);
  const health = await gatherHealth({
    privateDir: dir,
    dataDir: dir,
    unitDir: dir,
    link: () => Promise.resolve({ kind: 'down' }),
  });
  const failure = evaluateReadiness(health).failed.find((one) => one.requirement === 'core-model');
  assert.equal(failure?.code, 'check-missing');
});

test('a launch reads a core whose chain starts on a harness as served', async () => {
  // Catches: readiness reading the old harness record alone, so a core set with /model set to a harness asks for a check.
  const dir = tempDir('nep-readiness-chain-');
  writeKeysFile(dir);
  fs.writeFileSync(
    path.join(dir, 'config', 'config.json'),
    JSON.stringify({ models: { routes: { core: [{ via: 'harness', backend: 'claude', model: 'claude-opus-4-6' }] } } })
  );
  const health = await gatherHealth({
    privateDir: dir,
    dataDir: dir,
    unitDir: dir,
    link: () => Promise.resolve({ kind: 'down' }),
  });
  assert.equal(health.model.harness, true);
});
