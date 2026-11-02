// Tests for src/llm/key-failover.ts: what counts as a budget error, and the in-memory choice of a role's current key
// among its list. A switch moves the role to the next key, the last key falls back to the first once its failure is
// older than a minute, and a list whose keys all failed within a minute is exhausted. The clock is injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKeyFailover, isBudgetError } from '../src/llm/key-failover.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';

const T0 = Date.parse('2026-11-02T09:00:00Z');
const SECOND = 1000;
const MINUTE = 60 * SECOND;
const NAMES = ['OPENROUTER_CORE_KEY', 'OPENROUTER_CORE_BACKUP_KEY'] as const;

function failover() {
  const clock = { at: T0 };
  return { clock, keys: createKeyFailover({ now: () => clock.at }) };
}

test('isBudgetError: a 402 is one whatever it says; a 429 only when its body names credits or balance', () => {
  assert.equal(isBudgetError(402, ''), true, 'a payment error needs no text');
  assert.equal(isBudgetError(402, 'anything'), true);
  assert.equal(isBudgetError(429, '{"error":{"message":"Your credit balance is too low"}}'), true);
  assert.equal(isBudgetError(429, '{"error":{"message":"Insufficient credits"}}'), true);
  // Bug caught: a rate limit or a daily provider quota switching the key, burning the backup for nothing.
  assert.equal(isBudgetError(429, '{"error":{"message":"Rate limit exceeded: too many requests per minute"}}'), false);
  assert.equal(isBudgetError(429, ''), false);
});

test('isBudgetError: other statuses never are, even with credit words in the body', () => {
  // Bug caught: matching the body alone, so a 400 or 500 that echoes the word "credits" switches the key.
  for (const status of [200, 400, 401, 404, 500, 503])
    assert.equal(isBudgetError(status, 'credit balance exhausted'), false, String(status));
  assert.equal(isBudgetError(undefined, 'credit balance exhausted'), false);
  assert.equal(isBudgetError(402, undefined), true);
});

test('the first key is current until a budget error; the failure moves the role to the next key and records when', () => {
  const { keys } = failover();
  assert.equal(keys.current('core', NAMES), NAMES[0]);
  assert.equal(
    keys.states().find((s) => s.role === 'core'),
    undefined,
    'a role that never switched has no record'
  );
  const next = keys.failed('core', NAMES, NAMES[0], 402);
  assert.equal(next, NAMES[1]);
  assert.equal(keys.current('core', NAMES), NAMES[1], 'every later request goes on the new key');
  assert.deepEqual(
    keys.states().find((s) => s.role === 'core'),
    { role: 'core', key: NAMES[1], switchedAt: T0 }
  );
});

test('the last key falls back to the first when the first failed more than a minute ago', () => {
  const { clock, keys } = failover();
  keys.failed('core', NAMES, NAMES[0], 402);
  clock.at += 2 * MINUTE; // the first key's credits may have reset
  assert.equal(keys.failed('core', NAMES, NAMES[1], 402), NAMES[0]);
  assert.equal(keys.current('core', NAMES), NAMES[0]);
  assert.equal(keys.states().find((s) => s.role === 'core')?.switchedAt, T0 + 2 * MINUTE);
});

test('a list whose keys all failed within a minute is exhausted: null, and the role stays on its key', () => {
  const { clock, keys } = failover();
  keys.failed('core', NAMES, NAMES[0], 402);
  clock.at += 5 * SECOND;
  // Bug caught: ping-ponging between two empty keys forever, one request per switch.
  assert.equal(keys.failed('core', NAMES, NAMES[1], 429), null);
  assert.equal(keys.current('core', NAMES), NAMES[1]);
});

test('a failure reported for a key the role already left does not switch again', () => {
  const { clock, keys } = failover();
  keys.failed('core', NAMES, NAMES[0], 402);
  clock.at += 10 * SECOND;
  // Bug caught: two requests in flight on the first key both failing, the second switch undoing the first.
  assert.equal(keys.failed('core', NAMES, NAMES[0], 402), NAMES[1], 'the answer is the key already current');
  assert.equal(keys.current('core', NAMES), NAMES[1]);
  assert.equal(keys.states().find((s) => s.role === 'core')?.switchedAt, T0, 'the switch time is the first one');
});

test('three keys are walked in order; the third failing within a minute of the others is exhausted', () => {
  const { clock, keys } = failover();
  const three = ['OPENROUTER_A', 'OPENROUTER_B', 'OPENROUTER_C'];
  assert.equal(keys.failed('core', three, three[0], 402), three[1]);
  clock.at += SECOND;
  assert.equal(keys.failed('core', three, three[1], 402), three[2]);
  clock.at += SECOND;
  assert.equal(keys.failed('core', three, three[2], 402), null);
});

test('a role with one key is never failed over, and roles keep separate state', () => {
  const { keys } = failover();
  assert.equal(keys.failed('core', ['OPENROUTER_ONLY'], 'OPENROUTER_ONLY', 402), null);
  keys.failed('core', NAMES, NAMES[0], 402);
  assert.equal(keys.current('analyzer', ['OPENROUTER_X', 'OPENROUTER_Y']), 'OPENROUTER_X', 'another role is untouched');
});

test('a config edit that drops the current key puts the role back on the first of the new list', () => {
  const { keys } = failover();
  keys.failed('core', NAMES, NAMES[0], 402);
  // Bug caught: a stale current name outside the list resolving to no key at all.
  assert.equal(keys.current('core', ['OPENROUTER_NEW_KEY', 'OPENROUTER_NEW_BACKUP']), 'OPENROUTER_NEW_KEY');
});

test('the switch is logged by key name with the role and the status, never a value', async () => {
  const { keys } = failover();
  const { logs } = await withCapturedLogs(() => keys.failed('core', NAMES, NAMES[0], 402));
  const entry = logs.find((line) => line.msg === 'llm: key switched');
  assert.ok(entry, 'one line for the switch');
  assert.equal(entry.role, 'core');
  assert.equal(entry.from, NAMES[0]);
  assert.equal(entry.to, NAMES[1]);
  assert.equal(entry.status, 402);
});
