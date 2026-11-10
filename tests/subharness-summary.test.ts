// src/subharness/summary.ts: the rows that say what is off, the shape of Hermes' tool-availability rows
// (hermes_cli/setup_summary.py: name, available, hint) that its doctor and its setup summary both print. Here the rows
// come from keys.json, and `neptunia doctor` carries them as one `features` check: off is a warning with the command
// that turns it on, never a failure.
import { test } from 'node:test';

import assert from 'node:assert/strict';
import { featureRows } from '../src/subharness/summary.ts';
import { folders, runCli } from './fixtures/core-units.ts';
import { writeKeysFile } from './fixtures/keys-file.ts';
import { fakeVendor } from './fixtures/fake-vendor.ts';
import { tempDir } from './fixtures/tmp.ts';

test('the subharness off: an unavailable row whose hint names the command that turns it on', async () => {
  // Bug: an off feature is listed without the way to turn it on, so the owner has to search the docs.
  const dir = tempDir('nep-summary-');
  writeKeysFile(dir);
  const rows = await featureRows(dir);
  assert.deepEqual(
    rows.map((row) => [row.name, row.available]),
    [['subharness', false]]
  );
  // Changed: the account command makes a source available.
  assert.ok(rows[0]?.hint?.includes('neptunia subharness codex|claude|opencode login'));
});

test('the subharness on: an available row with no hint', async () => {
  // Bug: a feature that is on still prints a hint to enable it.
  const dir = tempDir('nep-summary-');
  writeKeysFile(dir, { subharness: { backend: 'codex', key: null, modes: {} } });
  // Changed: on is a source that is installed and logged in, not a stored name.
  fakeVendor(dir, 'codex', { loggedIn: true });
  assert.deepEqual(await featureRows(dir), [{ name: 'subharness', available: true, hint: null }]);
});

test('doctor reports the off features as one warning and exits 0 for them', async () => {
  // Bug: an off feature fails doctor, so a fresh install never passes its own check.
  const dirs = folders();
  writeKeysFile(dirs.privateDir);
  const run = await runCli(dirs, ['doctor', '--json']);
  const parsed = JSON.parse(run.stdout) as { checks: Array<{ name: string; status: string; detail: string }> };
  const check = parsed.checks.find((one) => one.name === 'features');
  assert.ok(check, 'doctor has a features check');
  assert.equal(check.status, 'warn');
  assert.ok(check.detail.includes('subharness'));
});

test('doctor reports the features ok when the subharness is on, and prints no key value', async () => {
  // Bug: the check prints a key of the store, or stays a warning with everything on.
  const dirs = folders();
  writeKeysFile(dirs.privateDir, {
    extra: { sim: 'sk-or-v1-sim-secret' },
    subharness: { backend: 'codex', key: null, modes: {} },
  });
  // Changed: on is a source that is installed and logged in, not a stored name.
  fakeVendor(dirs.privateDir, 'codex', { loggedIn: true });
  const run = await runCli(dirs, ['doctor', '--json']);
  const parsed = JSON.parse(run.stdout) as { checks: Array<{ name: string; status: string }> };
  assert.equal(parsed.checks.find((one) => one.name === 'features')?.status, 'ok');
  assert.equal((run.stdout + run.stderr).includes('sk-or-v1-sim-secret'), false);
});
