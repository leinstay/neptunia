// Codex's native usage (src/subharness/usage/codex.ts): the app-server's account reads after its initialization, through
// a fake child speaking the documented JSON lines (learn.chatgpt.com/docs/app-server). A native value survives unchanged,
// a null stays unknown, and no method that could start a model turn is ever sent.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import { readCodexUsage } from '../src/subharness/usage/codex.ts';
import type { UsageChild } from '../src/subharness/usage.ts';
import { fakeVendor } from './fixtures/fake-vendor.ts';
import { tempDir } from './fixtures/tmp.ts';

const T0 = 1_790_000_000_000;

const ACCOUNT = {
  account: { type: 'chatgpt', email: 'someone@example.test', planType: 'pro' },
  requiresOpenaiAuth: true,
};
const LIMITS = {
  rateLimits: {
    limitId: 'codex',
    limitName: null,
    primary: { usedPercent: 25, windowDurationMins: 300, resetsAt: 1730947200 },
    secondary: null,
    rateLimitReachedType: null,
  },
};
const USAGE = {
  summary: {
    lifetimeTokens: 1234567,
    peakDailyTokens: null,
    longestRunningTurnSec: 540,
    currentStreakDays: 8,
    longestStreakDays: 14,
  },
  dailyUsageBuckets: [{ startDate: '2026-06-18', tokens: 12345 }],
};

type Reply = { result: unknown } | { error: { code: number; message: string } } | null;

/** A fake app-server: it answers `answers[method]`, refuses anything before `initialized`, and records every method. */
function appServer(answers: Record<string, Reply>) {
  const methods: Array<string> = [];
  const spawned: Array<{ args: ReadonlyArray<string>; env: Readonly<Record<string, string>> }> = [];
  let killed = 0;
  const spawn = (
    _binary: string,
    args: ReadonlyArray<string>,
    options: { env: Readonly<Record<string, string>> }
  ): UsageChild => {
    spawned.push({ args, env: options.env });
    const stdin = new PassThrough();
    const stdout = new PassThrough();
    const events = new EventEmitter();
    let ready = false;
    let buffer = '';
    stdin.on('data', (chunk: Buffer) => {
      buffer += String(chunk);
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const message = JSON.parse(line) as { id?: number; method: string };
        methods.push(message.method);
        if (message.method === 'initialized') {
          ready = true;
          continue;
        }
        if (message.id === undefined) continue;
        if (message.method === 'initialize') {
          stdout.write(
            `${JSON.stringify({ id: message.id, result: { userAgent: 'fake', platformFamily: 'unix', platformOs: 'linux' } })}\n`
          );
          continue;
        }
        if (!ready) {
          stdout.write(`${JSON.stringify({ id: message.id, error: { code: -32002, message: 'Not initialized' } })}\n`);
          continue;
        }
        const reply = answers[message.method];
        if (reply === null) continue;
        stdout.write(
          `${JSON.stringify({ id: message.id, ...(reply ?? { error: { code: -32601, message: 'unknown' } }) })}\n`
        );
      }
    });
    return {
      stdin,
      stdout,
      once: (event, listener) => {
        events.once(event, listener);
      },
      kill: () => {
        killed += 1;
        events.emit('exit', null, 'SIGTERM');
        return true;
      },
    };
  };
  return { spawn, methods, spawned, killed: () => killed };
}

function rig(answers: Record<string, Reply>, loggedIn = true) {
  const privateDir = tempDir('nep-usage-codex-');
  const vendor = fakeVendor(privateDir, 'codex', { loggedIn });
  const server = appServer(answers);
  return { ...server, vendor, deps: { privateDir, now: () => T0, spawn: server.spawn, timeoutMs: 100 } };
}

const FULL = {
  'account/read': { result: ACCOUNT },
  'account/rateLimits/read': { result: LIMITS },
  'account/usage/read': { result: USAGE },
};

const metric = (usage: Awaited<ReturnType<typeof readCodexUsage>>, name: string) => {
  const found = usage.metrics.find((one) => one.name === name);
  assert.ok(found, `metric ${name} in ${JSON.stringify(usage.metrics)}`);
  return found;
};

test('native percentage, reset time and daily activity survive unchanged, qualified by source and account', async () => {
  // Catches: a percentage recomputed or rounded, a reset rebased to another clock, or an observation with no source.
  const { deps } = rig(FULL);
  const usage = await readCodexUsage(deps);
  assert.equal(usage.source, 'codex');
  assert.equal(usage.variant, 'subscription');
  assert.equal(usage.availability, 'available');
  assert.equal(usage.observedAt, T0);
  assert.ok(usage.account.label?.includes('someone@example.test'));
  assert.equal(metric(usage, 'primary.usedPercent').value, 25);
  assert.equal(metric(usage, 'primary.usedPercent').unit, 'percent');
  assert.equal(metric(usage, 'primary.resetsAt').value, 1730947200);
  assert.equal(metric(usage, 'lifetimeTokens').value, 1234567);
  assert.equal(metric(usage, 'daily.2026-06-18.tokens').value, 12345);
});

test('every Codex metric is scoped to the account', async () => {
  // Catches: account-wide numbers read as this engine's own, or split per agent.
  const { deps } = rig(FULL);
  const usage = await readCodexUsage(deps);
  assert.ok(usage.metrics.length > 0);
  assert.ok(usage.metrics.every((one) => one.scope === 'account'));
});

test('a null native field stays unknown and never becomes zero', async () => {
  // Catches: `?? 0` turning an unreported quota into a free one.
  const { deps } = rig(FULL);
  const usage = await readCodexUsage(deps);
  const peak = metric(usage, 'peakDailyTokens');
  assert.equal(peak.value, null);
  assert.equal(peak.state, 'unknown');
  const secondary = metric(usage, 'secondary.usedPercent');
  assert.equal(secondary.value, null);
  assert.equal(secondary.state, 'unknown');
});

test('the summary and the daily buckets may both be null without inventing activity', async () => {
  // Catches: a read that throws on the documented null, or an empty day drawn as zero tokens.
  const { deps } = rig({ ...FULL, 'account/usage/read': { result: { summary: null, dailyUsageBuckets: null } } });
  const usage = await readCodexUsage(deps);
  assert.equal(usage.availability, 'available');
  assert.equal(metric(usage, 'lifetimeTokens').state, 'unknown');
  assert.equal(
    usage.metrics.some((one) => one.name.startsWith('daily.')),
    false
  );
});

test('it initializes first and sends account reads only, under the persona home, and ends its child', async () => {
  // Catches: a model turn spent to read a quota, the installing user's home read instead of hers, or a leaked process.
  const { deps, methods, spawned, vendor, killed } = rig(FULL);
  await readCodexUsage(deps);
  assert.deepEqual(methods.slice(0, 2), ['initialize', 'initialized']);
  assert.deepEqual(methods.slice(2).sort(), ['account/rateLimits/read', 'account/read', 'account/usage/read']);
  assert.equal(spawned.length, 1);
  assert.deepEqual(spawned[0]?.args, ['app-server']);
  assert.equal(spawned[0]?.env.CODEX_HOME, vendor.home);
  assert.equal(killed(), 1);
  assert.deepEqual(vendor.calls(), []);
});

test('one refused read leaves the others readable and names the failure', async () => {
  // Catches: an older CLI without usage/read blanking the limits it does report.
  const { deps } = rig({ ...FULL, 'account/usage/read': { error: { code: -32601, message: 'unknown method' } } });
  const usage = await readCodexUsage(deps);
  assert.equal(usage.availability, 'available');
  assert.equal(metric(usage, 'primary.usedPercent').value, 25);
  assert.deepEqual(
    usage.errors.map((one) => one.code),
    ['usage-read-failed']
  );
});

test('no price is attached to subscription tokens', async () => {
  // Catches: tokens multiplied by an API price and shown as what the subscription cost.
  const { deps } = rig(FULL);
  const usage = await readCodexUsage(deps);
  assert.equal(
    usage.metrics.some((one) => one.unit === 'usd'),
    false
  );
});

test('an account with no login is not available, and its absent numbers are not metrics', async () => {
  // Catches: a logged-out backend drawn as an unused one, zero percent of nothing.
  const { deps } = rig({ ...FULL, 'account/read': { result: { account: null, requiresOpenaiAuth: true } } });
  const usage = await readCodexUsage(deps);
  assert.equal(usage.availability, 'unavailable');
  assert.deepEqual(
    usage.errors.map((one) => one.code),
    ['not-logged-in']
  );
  assert.deepEqual(usage.metrics, []);
});

test('a backend that is not installed answers so and starts nothing', async () => {
  // Catches: a spawn error surfacing as a crash of /usage.
  const privateDir = tempDir('nep-usage-codex-absent-');
  const server = appServer(FULL);
  const usage = await readCodexUsage({ privateDir, now: () => T0, spawn: server.spawn, timeoutMs: 100 });
  assert.equal(usage.availability, 'unavailable');
  assert.deepEqual(
    usage.errors.map((one) => one.code),
    ['not-installed']
  );
  assert.deepEqual(server.spawned, []);
});

test('an app-server that never answers is ended at the deadline and read as unavailable', async () => {
  // Catches: /usage hanging on a stuck child, with the process left behind.
  const { deps, killed } = rig({ 'account/read': null, 'account/rateLimits/read': null, 'account/usage/read': null });
  const usage = await readCodexUsage(deps);
  assert.equal(usage.availability, 'unavailable');
  assert.deepEqual(
    usage.errors.map((one) => one.code),
    ['timeout']
  );
  assert.equal(killed(), 1);
});
