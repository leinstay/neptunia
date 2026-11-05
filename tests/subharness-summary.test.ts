// src/subharness/summary.ts: the rows that say what is off, the shape of Hermes' tool-availability rows
// (hermes_cli/setup_summary.py: name, available, hint) that its doctor and its setup summary both print. Here the rows
// come from keys.json, and `neptunia doctor` carries them as one `features` check: off is a warning with the command
// that turns it on, never a failure.
import { test } from 'node:test';
import { readdirSync } from 'node:fs';
import assert from 'node:assert/strict';
import { featureRows } from '../src/subharness/summary.ts';
import { folders, runCli } from './fixtures/core-units.ts';
import { writeKeysFile } from './fixtures/keys-file.ts';
import { fakeVendor } from './fixtures/fake-vendor.ts';
import { tempDir } from './fixtures/tmp.ts';

test('both features off: two unavailable rows, each hint names the command that turns it on', async () => {
  // Bug: an off feature is listed without the way to turn it on, so the owner has to search the docs.
  const dir = tempDir('nep-summary-');
  writeKeysFile(dir);
  const rows = await featureRows(dir);
  assert.deepEqual(
    rows.map((row) => [row.name, row.available]),
    [
      ['subharness', false],
      ['simulation', false],
    ]
  );
  // Changed: the account command makes a source available.
  assert.ok(rows[0]?.hint?.includes('neptunia subharness codex|claude|opencode login'));
  assert.ok(rows[1]?.hint?.includes('simulation enable'));
});

test('both features on: available rows with no hint', async () => {
  // Bug: a feature that is on still prints a hint to enable it.
  const dir = tempDir('nep-summary-');
  writeKeysFile(dir, {
    extra: { sim: 'sk-or-v1-sim' },
    subharness: { backend: 'codex', key: null, modes: {} },
    simulation: { key: 'sim' },
  });
  // Changed: on is a source that is installed and logged in, not a stored name.
  fakeVendor(dir, 'codex', { loggedIn: true });
  assert.deepEqual(await featureRows(dir), [
    { name: 'subharness', available: true, hint: null },
    { name: 'simulation', available: true, hint: null },
  ]);
});

test('a simulation switched on for a key that has left the store reads as unavailable', async () => {
  // Bug: the row says on, and the first paid script fails with a missing key.
  const dir = tempDir('nep-summary-');
  writeKeysFile(dir, { simulation: { key: 'gone' } });
  const rows = await featureRows(dir);
  assert.equal(rows[1]?.available, false);
});

test('no keys.json at all reads as both off and creates nothing', async () => {
  // Bug: a read of the summary creates keys.json, or throws before setup has run.
  const dir = tempDir('nep-summary-');
  const rows = await featureRows(dir);
  assert.equal(
    rows.every((row) => !row.available),
    true
  );
  assert.deepEqual(readdirSync(dir), [], 'a read writes nothing');
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
  assert.ok(check.detail.includes('subharness') && check.detail.includes('simulation'));
});

test('doctor reports the features ok when both are on, and prints no key value', async () => {
  // Bug: the check prints the key it found, or stays a warning with everything on.
  const dirs = folders();
  writeKeysFile(dirs.privateDir, {
    extra: { sim: 'sk-or-v1-sim-secret' },
    subharness: { backend: 'codex', key: null, modes: {} },
    simulation: { key: 'sim' },
  });
  // Changed: on is a source that is installed and logged in, not a stored name.
  fakeVendor(dirs.privateDir, 'codex', { loggedIn: true });
  const run = await runCli(dirs, ['doctor', '--json']);
  const parsed = JSON.parse(run.stdout) as { checks: Array<{ name: string; status: string }> };
  assert.equal(parsed.checks.find((one) => one.name === 'features')?.status, 'ok');
  assert.equal((run.stdout + run.stderr).includes('sk-or-v1-sim-secret'), false);
});
