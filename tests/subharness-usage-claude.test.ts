// Claude's native usage (src/subharness/usage/claude.ts). A documented interactive `/usage` screen proves no unattended
// read, so the adapter hands off to the native screen and says the automatic view is unsupported. It never starts a model
// run to find out. A later change that proves a read-only interface for the installed version replaces this expectation
// in its own reviewed change.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readClaudeUsage } from '../src/subharness/usage/claude.ts';
import type { UsageChild } from '../src/subharness/usage.ts';
import { fakeVendor } from './fixtures/fake-vendor.ts';
import { tempDir } from './fixtures/tmp.ts';

const T0 = 1_790_000_000_000;

function refusingSpawn() {
  const spawned: Array<ReadonlyArray<string>> = [];
  const spawn = (_binary: string, args: ReadonlyArray<string>): UsageChild => {
    spawned.push(args);
    throw new Error('this test starts no child');
  };
  return { spawn, spawned };
}

test('an installed, logged-in Claude is unsupported for the automatic view and hands off to its own screen', async () => {
  // Catches: empty metrics that read as an unused account, with no word of where the real numbers are.
  const privateDir = tempDir('nep-usage-claude-');
  fakeVendor(privateDir, 'claude', { loggedIn: true });
  const { spawn } = refusingSpawn();
  const usage = await readClaudeUsage({ privateDir, now: () => T0, spawn });
  assert.equal(usage.source, 'claude');
  assert.equal(usage.variant, 'subscription');
  assert.equal(usage.availability, 'unsupported');
  assert.equal(usage.observedAt, T0);
  assert.deepEqual(usage.metrics, []);
  assert.ok(usage.handoff?.includes('/usage'), String(usage.handoff));
  assert.ok(usage.handoff?.includes('claude'), String(usage.handoff));
});

test('it spends no model run to learn its usage', async () => {
  // Catches: `claude -p "/usage"`, a generated turn on the persona's subscription.
  const privateDir = tempDir('nep-usage-claude-run-');
  const vendor = fakeVendor(privateDir, 'claude', { loggedIn: true });
  const { spawn, spawned } = refusingSpawn();
  await readClaudeUsage({ privateDir, now: () => T0, spawn });
  assert.deepEqual(spawned, []);
  for (const call of vendor.calls()) assert.ok(['auth status', '--help', '--version'].includes(call), call);
});

test('a missing install and a missing login are said apart from the unsupported view', async () => {
  // Catches: a hand-off to a screen that cannot open, because the backend is not there.
  const absent = tempDir('nep-usage-claude-absent-');
  const missing = await readClaudeUsage({ privateDir: absent, now: () => T0, spawn: refusingSpawn().spawn });
  assert.equal(missing.availability, 'unavailable');
  assert.deepEqual(
    missing.errors.map((one) => one.code),
    ['not-installed']
  );

  const out = tempDir('nep-usage-claude-out-');
  fakeVendor(out, 'claude');
  const loggedOut = await readClaudeUsage({ privateDir: out, now: () => T0, spawn: refusingSpawn().spawn });
  assert.equal(loggedOut.availability, 'unavailable');
  assert.deepEqual(
    loggedOut.errors.map((one) => one.code),
    ['not-logged-in']
  );
});
