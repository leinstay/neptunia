// `neptunia doctor` carries the `routes` check of src/setup/route-health.ts: every part checked for real on what it runs
// on (owner, 2026-11-08). The provider here is an address that refuses every connection, so nothing leaves the machine
// and a core key reads as unreachable.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { folders, runCli } from './fixtures/core-units.ts';
import { writeKeysFile } from './fixtures/keys-file.ts';

const VALUE = 'sk-or-v1-doctor-routes-secret';

test('doctor fails the routes check when the core key cannot be reached, and prints no key value', async () => {
  // Catches: a doctor that reads the keys from disk and calls them fine without asking the provider.
  const dirs = folders({ llm: { baseUrl: 'http://127.0.0.1:9/api/v1' } });
  writeKeysFile(dirs.privateDir, { core: [{ name: 'core-1', value: VALUE }] });
  const run = await runCli(dirs, ['doctor', '--json']);
  const parsed = JSON.parse(run.stdout) as { checks: Array<{ name: string; status: string; detail: string }> };
  const check = parsed.checks.find((one) => one.name === 'routes');
  assert.equal(check?.status, 'fail');
  assert.ok(check.detail.includes('core-1'), check.detail);
  assert.equal((run.stdout + run.stderr).includes(VALUE), false);
});
