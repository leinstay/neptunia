// Tests for src/llm/role-health.ts: which model roles are globally failing, kept in memory per role. A role is
// down when its model is switched off (an empty chain in `models.routes.<role>`), when its key is missing, after a 401, 402 or
// 404, after a 429 that says the daily limit is spent, or after three malformed answers in a row. One failed
// request of another kind is not global. A failing role is retried on a backoff of 1, 5, 15 and then 60 minutes
// and clears on its first success. The errors are shaped as src/llm/openrouter.ts throws them (`statusCode`,
// `body`); the clock is injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoleHealth } from '../src/llm/role-health.ts';
import { chainsOnDefaults } from './fixtures/chains.ts';

const T0 = Date.parse('2026-10-31T09:00:00Z');
const MINUTE = 60_000;
const CONFIG = {
  models: { routes: chainsOnDefaults({ core: 'x/core', drawing: 'x/draw', vision: 'x/eyes', speech: 'x/voice' }) },
};

/** An error of a non-ok answer, as the chat and image clients throw it. */
function httpError(status: number, body = ''): Error {
  return Object.assign(new Error(`OpenRouter HTTP ${status}`), { statusCode: status, body });
}

/** The body of a 429 from the provider account behind the route, with the provider's own text. */
function upstream429(raw: string): string {
  return JSON.stringify({
    error: { code: 429, metadata: { limit_source: 'upstream_provider_account', provider_name: 'Example', raw } },
  });
}

/** A tracker on a clock the test moves. */
function tracker(hasKey: (role: string) => boolean = () => true) {
  const clock = { at: T0 };
  const health = createRoleHealth({ now: () => clock.at, hasKey });
  return { clock, health };
}

test('a role goes globally failing on a 401, a 402, a 404 and a daily 429, with the reason of each', () => {
  const cases: Array<[Error, string]> = [
    [httpError(401), 'unauthorized'],
    [httpError(402), 'payment'],
    [httpError(404), 'not-found'],
    [httpError(429, upstream429('Quota exceeded: requests per day')), 'daily-limit'],
  ];
  for (const [err, reason] of cases) {
    const { health } = tracker();
    health.failed('drawing', err);
    assert.equal(health.down(CONFIG, 'drawing')?.reason, reason, reason);
    assert.deepEqual(
      health.failing(CONFIG).map((row) => [row.role, row.reason]),
      [['drawing', reason]],
      reason
    );
  }
});

test('one 500, a rate-limit 429 or a network failure leaves the role up', () => {
  const { health } = tracker();
  health.failed('drawing', httpError(500));
  health.failed('drawing', httpError(429, upstream429('Too many requests per minute')));
  health.failed('drawing', Object.assign(new TypeError('fetch failed'), {}));
  assert.equal(health.down(CONFIG, 'drawing'), null);
  assert.deepEqual(health.failing(CONFIG), []);
});

test('three malformed answers in a row put the role down, a success between them starts the count again', () => {
  const { health } = tracker();
  health.malformed('vision');
  health.malformed('vision');
  health.succeeded('vision');
  health.malformed('vision');
  health.malformed('vision');
  assert.equal(health.down(CONFIG, 'vision'), null, 'two in a row since the success');
  health.malformed('vision');
  assert.equal(health.down(CONFIG, 'vision')?.reason, 'malformed');
});

test('a role switched off in the config or without its key is down with no retry time; a null model is off', () => {
  const { health } = tracker((role) => role !== 'speech');
  const config = {
    models: { routes: chainsOnDefaults({ core: 'x/core', vision: false, video: null, speech: 'x/voice' }) },
  };
  assert.deepEqual(health.down(config, 'vision'), { role: 'vision', reason: 'no-model', retryAt: null });
  assert.deepEqual(health.down(config, 'speech'), { role: 'speech', reason: 'no-key', retryAt: null });
  assert.deepEqual(health.down(config, 'video'), { role: 'video', reason: 'no-model', retryAt: null }, 'null is off');
  assert.deepEqual(
    health.failing(config).map((row) => [row.role, row.reason]),
    [
      ['vision', 'no-model'],
      ['video', 'no-model'],
      ['speech', 'no-key'],
    ],
    'in the display order of the base roles'
  );
});

test('a failing role is retried after 1, 5, 15 and then every 60 minutes, and clears on the first success', () => {
  const { clock, health } = tracker();
  health.failed('drawing', httpError(401));
  assert.equal(health.down(CONFIG, 'drawing')?.retryAt, T0 + MINUTE);

  clock.at = T0 + MINUTE - 1;
  assert.deepEqual(
    health.down(CONFIG, 'drawing'),
    { role: 'drawing', reason: 'unauthorized', retryAt: T0 + MINUTE },
    'not called before its retry is due'
  );
  clock.at = T0 + MINUTE;
  assert.equal(health.down(CONFIG, 'drawing'), null, 'the retry is due: the role may be called once');
  assert.deepEqual(
    health.failing(CONFIG).map((row) => row.role),
    ['drawing'],
    'still failing on /status until a call succeeds'
  );

  // Each failed retry waits the next step of the backoff, measured from that retry.
  let at = clock.at;
  for (const minutes of [5, 15, 60, 60]) {
    health.failed('drawing', httpError(401));
    assert.equal(health.down(CONFIG, 'drawing')?.retryAt, at + minutes * MINUTE, `${minutes} minutes`);
    at += minutes * MINUTE;
    clock.at = at;
    assert.equal(health.down(CONFIG, 'drawing'), null, `due after ${minutes} minutes`);
  }

  health.succeeded('drawing');
  assert.equal(health.down(CONFIG, 'drawing'), null);
  assert.deepEqual(health.failing(CONFIG), []);
  health.failed('drawing', httpError(401));
  assert.equal(health.down(CONFIG, 'drawing')?.retryAt, clock.at + MINUTE, 'a new failure starts at one minute');
});

// The chain client's code replaces keys-exhausted (spec 2026-11-09-model-routes): every route of the chain unavailable.
/** The error the chain client throws once every route of a role's chain was unavailable. */
const keysExhausted = (): Error =>
  Object.assign(new Error('llm: every route of the role is unavailable'), { code: 'routes-exhausted' });

test('routes-exhausted puts the role down until the next UTC day, whatever the backoff would say', () => {
  const { clock, health } = tracker();
  health.failed('core', keysExhausted());
  const down = health.down(CONFIG, 'core');
  assert.equal(down?.reason, 'routes-exhausted');
  assert.equal(down?.retryAt, Date.parse('2026-11-01T00:00:00Z'));
  // Bug caught: the 1-minute backoff of a payment error waking her against two empty keys every minute.
  clock.at += 14 * 60 * MINUTE;
  assert.equal(health.down(CONFIG, 'core')?.reason, 'routes-exhausted', '23:00 UTC is still the same day');
  clock.at = Date.parse('2026-11-01T00:00:00Z');
  assert.equal(health.down(CONFIG, 'core'), null, 'a call is let through at 00:00 UTC');
});

test('routes-exhausted lists in failing() and clears on the first success', () => {
  const { health } = tracker();
  health.failed('core', keysExhausted());
  assert.deepEqual(
    health.failing(CONFIG).map((row) => [row.role, row.reason]),
    [['core', 'routes-exhausted']]
  );
  health.succeeded('core');
  assert.equal(health.down(CONFIG, 'core'), null);
});
