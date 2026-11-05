// The orchestration of native usage (src/subharness/usage.ts): one source by request, every source with one failure held
// apart, API calls counted once across OpenCode and direct OpenRouter, an old observation that is stale or belongs to
// another account, and what `/usage` draws. No read generates a turn, and nothing invents a quota or a price.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createConsole } from '../src/interface/commands/console.ts';
import { apiAccounting, readAllUsage, readBackendUsage, reconcileUsage, usageLines } from '../src/subharness/usage.ts';
import type { BackendUsage, UsageDeps, UsageMetric } from '../src/subharness/usage.ts';
import { fakeVendor } from './fixtures/fake-vendor.ts';
import { writeKeysFile } from './fixtures/keys-file.ts';
import { fakeFetch } from './fixtures/keys-rig.ts';
import { tempDir } from './fixtures/tmp.ts';

const T0 = 1_790_000_000_000;
const HOUR = 3_600_000;

function rig(over: Partial<UsageDeps> = {}) {
  const privateDir = tempDir('nep-usage-');
  writeKeysFile(privateDir);
  const { fetch, calls } = fakeFetch(() => ({
    status: 200,
    body: { data: { usage: 2, limit: null, limit_remaining: null } },
  }));
  const deps: UsageDeps = {
    privateDir,
    now: () => T0,
    fetch,
    baseUrl: 'https://openrouter.test/api/v1',
    openRouterKey: { name: 'core one', value: 'or-value-secret' },
    spawn: () => {
      throw new Error('no child in this test');
    },
    exec: () => Promise.reject(new Error('no command in this test')),
    ...over,
  };
  return { deps, calls, privateDir };
}

const metric = (name: string, over: Partial<UsageMetric> = {}): UsageMetric => ({
  name,
  scope: 'account',
  unit: 'percent',
  value: 25,
  state: 'observed',
  ...over,
});
const subscription = (over: Partial<BackendUsage> = {}): BackendUsage => ({
  variant: 'subscription',
  source: 'codex',
  account: { label: 'one@example.test' },
  observedAt: T0,
  availability: 'available',
  metrics: [metric('primary.usedPercent')],
  errors: [],
  handoff: null,
  ...over,
});

test('a request reads the source it names and no other', async () => {
  // Catches: one `/usage` of OpenRouter starting every vendor CLI.
  const { deps, calls } = rig();
  const usage = await readBackendUsage({ source: 'openrouter' }, deps);
  assert.equal(usage.source, 'openrouter');
  assert.equal(usage.account.label, 'core one');
  assert.equal(calls.length, 1);
});

test('every source answers in a stable order, and one that throws leaves the others readable', async () => {
  // Catches: Promise.all rejecting the whole view on the first vendor that fails.
  const { deps, privateDir } = rig();
  fakeVendor(privateDir, 'codex', { loggedIn: true });
  const usages = await readAllUsage(deps);
  assert.deepEqual(
    usages.map((one) => one.source),
    ['claude', 'codex', 'opencode', 'openrouter']
  );
  assert.equal(usages.find((one) => one.source === 'codex')?.availability, 'unavailable');
  assert.equal(usages.find((one) => one.source === 'openrouter')?.availability, 'available');
  assert.equal(usages.find((one) => one.source === 'openrouter')?.metrics.find((m) => m.name === 'usage')?.value, 2);
});

test('reading everything sends no completion', async () => {
  // Catches: a hidden model call reached by any adapter.
  const { deps, calls } = rig();
  await readAllUsage(deps);
  assert.ok(calls.every((call) => !call.url.includes('/chat/completions') && !call.url.includes('/responses')));
});

test('no key value appears in any observation', async () => {
  // Catches: a credential on the screen through an error text.
  const { deps } = rig();
  assert.equal(JSON.stringify(await readAllUsage(deps)).includes('or-value-secret'), false);
});

// One API call counted once

test('a request recorded by both OpenCode and the direct account counts once, under OpenCode', () => {
  // Catches: an API-backed run doubling the reported spend.
  const totals = apiAccounting([
    { requestId: 'r1', runId: 'run-1', source: 'opencode', usd: 0.5, tokens: 100 },
    { requestId: 'r1', runId: null, source: 'openrouter', usd: 0.5, tokens: 100 },
    { requestId: 'r2', runId: null, source: 'openrouter', usd: 0.25, tokens: 40 },
  ]);
  assert.deepEqual(totals.opencode, { requests: 1, usd: 0.5, tokens: 100, unknownUsd: 0 });
  assert.deepEqual(totals.openrouter, { requests: 1, usd: 0.25, tokens: 40, unknownUsd: 0 });
});

test('one request reported twice by a retry counts once', () => {
  // Catches: a replayed record inflating the sum.
  const one = { requestId: 'r1', runId: 'run-1', source: 'opencode', usd: 0.5, tokens: 100 } as const;
  assert.equal(apiAccounting([one, one]).opencode.requests, 1);
});

test('a request with no reported price is counted as unknown, not as free', () => {
  // Catches: a missing cost adding zero, the total quietly too low.
  const totals = apiAccounting([
    { requestId: 'r1', runId: null, source: 'openrouter', usd: null, tokens: 10 },
    { requestId: 'r2', runId: null, source: 'openrouter', usd: 1, tokens: 10 },
  ]);
  assert.equal(totals.openrouter.usd, 1);
  assert.equal(totals.openrouter.unknownUsd, 1);
});

test('no records add up to nothing, with no invented row', () => {
  // Catches: a throw on an idle day.
  const totals = apiAccounting([]);
  assert.deepEqual(totals.opencode, { requests: 0, usd: 0, tokens: 0, unknownUsd: 0 });
});

// Old observations

test('a failed read keeps the last observation of the same account, marked stale with its own time', () => {
  // Catches: old numbers passed off as current, or a brief failure blanking the view.
  const previous = subscription({ observedAt: T0 - HOUR });
  const fresh = subscription({
    observedAt: T0,
    availability: 'unavailable',
    metrics: [],
    errors: [{ code: 'read-failed' }],
  });
  const kept = reconcileUsage(previous, fresh);
  assert.equal(kept.observedAt, T0 - HOUR);
  assert.equal(kept.metrics[0]?.value, 25);
  assert.equal(kept.metrics[0]?.state, 'stale');
  assert.deepEqual(kept.errors, [{ code: 'read-failed' }]);
});

test('an account change drops what the old account observed', () => {
  // Catches: the old login's quota drawn under the new login.
  const previous = subscription({ observedAt: T0 - HOUR });
  const fresh = subscription({
    account: { label: 'two@example.test' },
    availability: 'unavailable',
    metrics: [],
    errors: [{ code: 'read-failed' }],
  });
  assert.deepEqual(reconcileUsage(previous, fresh), fresh);
});

test('a logout drops the old observation even though no new account is known', () => {
  // Catches: a logged-out backend still showing its quota as if nothing happened.
  const previous = subscription({ observedAt: T0 - HOUR });
  const fresh = subscription({
    account: { label: null },
    availability: 'unavailable',
    metrics: [],
    errors: [{ code: 'not-logged-in' }],
  });
  assert.deepEqual(reconcileUsage(previous, fresh), fresh);
});

test('a fresh successful read replaces the old one, and with no previous the fresh one stands', () => {
  // Catches: an old stale mark surviving a read that worked.
  const fresh = subscription();
  assert.deepEqual(reconcileUsage(subscription({ observedAt: T0 - HOUR }), fresh), fresh);
  assert.deepEqual(reconcileUsage(null, fresh), fresh);
});

// What is drawn

test('each block names its source and account, and its observation time', () => {
  // Catches: two accounts' numbers side by side with nothing to tell them apart.
  const text = usageLines([subscription()], T0).join('\n');
  assert.ok(text.includes('codex'), text);
  assert.ok(text.includes('one@example.test'), text);
  assert.ok(text.includes(new Date(T0).toISOString().slice(0, 16)), text);
  assert.ok(text.includes('25'), text);
});

test('an unknown value is drawn unknown, never zero', () => {
  // Catches: `String(value ?? 0)` at the very last step.
  const text = usageLines(
    [subscription({ metrics: [metric('primary.usedPercent', { value: null, state: 'unknown' })] })],
    T0
  ).join('\n');
  assert.ok(text.includes('unknown'), text);
  assert.equal(/\b0\b/.test(text.replaceAll(new Date(T0).toISOString().slice(0, 16), '')), false, text);
});

test('a stale value says it is stale', () => {
  // Catches: the stale mark set by the reconciler and lost by the drawing.
  const text = usageLines([subscription({ metrics: [metric('primary.usedPercent', { state: 'stale' })] })], T0).join(
    '\n'
  );
  assert.ok(text.includes('stale'), text);
});

test('an unsupported source shows its hand-off, a failed one its code', () => {
  // Catches: both vanishing from the view, so the owner thinks the backend is not there.
  const text = usageLines(
    [
      subscription({ source: 'claude', availability: 'unsupported', metrics: [], handoff: 'claude, then /usage' }),
      subscription({ availability: 'unavailable', metrics: [], errors: [{ code: 'timeout' }] }),
    ],
    T0
  ).join('\n');
  assert.ok(text.includes('claude, then /usage'), text);
  assert.ok(text.includes('timeout'), text);
});

test('a subscription block prints no price', () => {
  // Catches: an API rate multiplied in at the view, where the adapter test does not look.
  const text = usageLines(
    [subscription({ metrics: [metric('lifetimeTokens', { unit: 'tokens', value: 1000 })] })],
    T0
  ).join('\n');
  assert.equal(text.includes('$'), false, text);
});

// /usage

function deskWith(backendUsage: () => Promise<ReadonlyArray<BackendUsage>>) {
  const checks: Array<string> = [];
  const zero = { requests: 0, promptTokens: 0, cachedTokens: 0, completionTokens: 0, cost: 0 };
  const privateDir = tempDir('nep-usage-desk-');
  const desk = createConsole({
    runOp: () => Promise.resolve({ status: 'ok', code: '', summary: '', data: null }),
    ownerReads: { lessons: () => '', aliases: () => '' },
    guildId: () => 'g1',
    selfId: () => 'self-1',
    hot: { config: { bot: { owners: [] } } },
    privateDir,
    dataDir: privateDir,
    memoryDb: null,
    usage: {
      byRole: () => [],
      sumDays: () => ({ rows: [], interfaces: [], total: zero, since: '2026-11-05', partial: false }),
    },
    metrics: null,
    conversationLines: () => [],
    now: () => T0,
    backendUsage,
    subharness: {
      runBackend: (name) => {
        checks.push(name);
        return Promise.resolve({ ok: true, text: 'ok', exitCode: 0 });
      },
      fetch: fakeFetch().fetch,
      helpOf: () => Promise.resolve(''),
      applyMode: () => Promise.resolve(''),
    },
  });
  return { desk, checks };
}

test('/usage carries the native blocks beside the engine accounting, with no backend run', async () => {
  // Catches: native data replacing the engine's own numbers, or a model run behind a read.
  const { desk, checks } = deskWith(() => Promise.resolve([subscription()]));
  const answer = await desk.run('usage', { window: '' }, { id: 'owner' });
  assert.equal(answer.status, 'ok');
  assert.ok(answer.text.includes('one@example.test'), answer.text);
  assert.ok(answer.text.includes('2026-11-05'), answer.text);
  assert.deepEqual(checks, []);
});

test('/usage survives a native read that rejects, and says so', async () => {
  // Catches: a vendor problem taking the engine's own accounting down with it.
  const { desk } = deskWith(() => Promise.reject(new Error('sk-leaky-detail')));
  const answer = await desk.run('usage', { window: '' }, { id: 'owner' });
  assert.equal(answer.status, 'ok');
  assert.ok(answer.text.includes('2026-11-05'), answer.text);
  assert.equal(answer.text.includes('sk-leaky-detail'), false, answer.text);
});
