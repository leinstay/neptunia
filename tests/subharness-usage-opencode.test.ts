// OpenCode's statistics (src/subharness/usage/opencode.ts): `opencode stats` under the persona's backend home, read through
// a fake runner with a synthetic copy of the printed table. Its dollars are API accounting, its absent rows stay unknown.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readOpenCodeUsage } from '../src/subharness/usage/opencode.ts';
import type { UsageExec } from '../src/subharness/usage.ts';
import { subharnessPlace, vendorEnv } from '../src/subharness/place.ts';
import { writeKeysFile } from './fixtures/keys-file.ts';
import { tempDir } from './fixtures/tmp.ts';

const T0 = 1_790_000_000_000;

const STATS = `
┌────────────────────────────────────────────────────────┐
│                       OVERVIEW                         │
├────────────────────────────────────────────────────────┤
│Sessions                                             12 │
│Messages                                             80 │
│Days                                                  3 │
└────────────────────────────────────────────────────────┘
┌────────────────────────────────────────────────────────┐
│                    COST & TOKENS                       │
├────────────────────────────────────────────────────────┤
│Total Cost                                        $1.23 │
│Input                                             50.0K │
│Output                                            10.0K │
└────────────────────────────────────────────────────────┘
`;

function rig(output: { code: number; stdout: string }, keyValue = 'oc-value-secret') {
  const privateDir = tempDir('nep-usage-opencode-');
  writeKeysFile(privateDir, { extra: { oc: keyValue }, subharness: { key: 'oc', modes: {} } });
  const { binary } = subharnessPlace(privateDir, 'opencode');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const calls: Array<{ args: ReadonlyArray<string>; env: Readonly<Record<string, string>> }> = [];
  const exec: UsageExec = (_binary, args, options) => {
    calls.push({ args, env: options.env });
    return Promise.resolve({ ...output, stderr: '' });
  };
  return { privateDir, calls, exec };
}

const named = (usage: Awaited<ReturnType<typeof readOpenCodeUsage>>, name: string) =>
  usage.metrics.find((one) => one.name === name);

test('the statistics are API accounting from the source that reported them, under its key name', async () => {
  // Catches: OpenCode dollars presented as a subscription, or under another source's account.
  const { privateDir, exec } = rig({ code: 0, stdout: STATS });
  const usage = await readOpenCodeUsage({ privateDir, now: () => T0, exec });
  assert.equal(usage.source, 'opencode');
  assert.equal(usage.variant, 'api');
  assert.equal(usage.availability, 'available');
  assert.equal(usage.account.label, 'oc');
  assert.equal(named(usage, 'totalCost')?.value, 1.23);
  assert.equal(named(usage, 'totalCost')?.unit, 'usd');
  assert.equal(named(usage, 'sessions')?.value, 12);
});

test('a row the table lacks stays unknown', async () => {
  // Catches: a release that drops a row reading as no spend at all.
  const { privateDir, exec } = rig({
    code: 0,
    stdout: STATS.replace('│Total Cost                                        $1.23 │\n', ''),
  });
  const usage = await readOpenCodeUsage({ privateDir, now: () => T0, exec });
  assert.equal(named(usage, 'totalCost')?.value, null);
  assert.equal(named(usage, 'totalCost')?.state, 'unknown');
});

test('it runs only the stats command under the persona home', async () => {
  // Catches: a generated turn for a number, or the installing user's statistics shown as hers.
  const { privateDir, exec, calls } = rig({ code: 0, stdout: STATS });
  await readOpenCodeUsage({ privateDir, now: () => T0, exec });
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.args[0], 'stats');
  assert.equal(calls[0]?.args.includes('run'), false);
  const home = vendorEnv(privateDir, 'opencode', {});
  for (const [name, value] of Object.entries(home)) assert.equal(calls[0]?.env[name], value, name);
});

test('the key value appears nowhere in the observation', async () => {
  // Catches: the extra key read for its name and returned with the account.
  const { privateDir, exec } = rig({ code: 0, stdout: STATS });
  const usage = await readOpenCodeUsage({ privateDir, now: () => T0, exec });
  assert.equal(JSON.stringify(usage).includes('oc-value-secret'), false);
});

test('output that cannot be read is unavailable with its reason, never zeros', async () => {
  // Catches: a changed table printing as a successful read of nothing.
  const { privateDir, exec } = rig({ code: 0, stdout: 'a format nobody has seen' });
  const usage = await readOpenCodeUsage({ privateDir, now: () => T0, exec });
  assert.equal(usage.availability, 'unavailable');
  assert.deepEqual(
    usage.errors.map((one) => one.code),
    ['unreadable']
  );
  assert.deepEqual(usage.metrics, []);
});

test('a failing command and a missing install are said apart', async () => {
  // Catches: two different repairs behind one message.
  const failing = rig({ code: 1, stdout: '' });
  const failed = await readOpenCodeUsage({ privateDir: failing.privateDir, now: () => T0, exec: failing.exec });
  assert.deepEqual(
    failed.errors.map((one) => one.code),
    ['read-failed']
  );

  const absentDir = tempDir('nep-usage-opencode-absent-');
  writeKeysFile(absentDir);
  const calls: Array<unknown> = [];
  const exec: UsageExec = (...given) => {
    calls.push(given);
    return Promise.resolve({ code: 0, stdout: STATS, stderr: '' });
  };
  const absent = await readOpenCodeUsage({ privateDir: absentDir, now: () => T0, exec });
  assert.deepEqual(
    absent.errors.map((one) => one.code),
    ['not-installed']
  );
  assert.deepEqual(calls, []);
});
