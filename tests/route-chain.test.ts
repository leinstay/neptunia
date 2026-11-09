// Tests for src/llm/route-chain.ts: a role's chain read from `models.routes`, which failure makes a route unavailable,
// and the per-role choice of the route in force, with the retry window after a switch. The clock is injected.
// Changed: the old settings and their translation are gone (spec 2026-11-09-model-routes, slice 4), so the tests of the
// translation are deleted and `routesOf` takes the config alone.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRouteChain, routesOf, unavailableCode } from '../src/llm/route-chain.ts';
import type { Route } from '../src/llm/route-text.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';

const T0 = Date.parse('2026-11-09T09:00:00Z');
const MINUTE = 60_000;

const api = (key: string, model: string, effort: string | null = null): Route =>
  ({ via: 'api', key, model, effort }) as Route;
const harness = (model: string): Route => ({ via: 'harness', backend: 'claude', model, effort: null });

test('a role with its own chain in models.routes takes it whole', () => {
  // Catches: a saved chain read partly, so a fallback the owner added with `/model add` is never tried.
  const config = {
    models: {
      routes: {
        analyzer: [
          { via: 'api', key: 'tools', model: 'anthropic/claude-sonnet-6.1', effort: 'low' },
          { via: 'api', key: 'main', model: 'openai/gpt-6.1-sol', effort: null },
        ],
      },
    },
  };
  assert.deepEqual(routesOf(config, 'analyzer'), [
    api('tools', 'anthropic/claude-sonnet-6.1', 'low'),
    api('main', 'openai/gpt-6.1-sol'),
  ]);
});

test('an empty chain in models.routes leaves the role with no route', () => {
  // Catches: an empty array read as absent, so an optional role the owner turned off comes back on its default.
  assert.deepEqual(routesOf({ models: { routes: { vision: [] } } }, 'vision'), []);
});

test('a harness record of models.routes is read as a harness route', () => {
  // Catches: a harness route of the memory writer dropped by the reader, so her memory session spends a key.
  const config = { models: { routes: { memory: [{ via: 'harness', backend: 'claude', model: 'claude-opus-4-6' }] } } };
  assert.deepEqual(routesOf(config, 'memory'), [harness('claude-opus-4-6')]);
});

test('a 401, a 402 and a 429 that names credits make an API route unavailable, other failures do not', () => {
  // Catches: a 400 switching routes, so a request that fails everywhere spends every key; or a spent key not switching.
  const route = api('main', 'openai/gpt-6.1-sol');
  const http = (statusCode: number, body = '') => Object.assign(new Error('http'), { statusCode, body });
  assert.equal(unavailableCode(route, http(401)), 'http-401');
  assert.equal(unavailableCode(route, http(402)), 'http-402');
  assert.equal(unavailableCode(route, http(429, '{"error":{"message":"Insufficient credits"}}')), 'http-429');
  for (const err of [http(400), http(404), http(500), http(429, 'Rate limit exceeded'), new Error('timed out')])
    assert.equal(unavailableCode(route, err), null, err.message);
});

test('every subscription code makes a harness route unavailable, a rail refusal does not', () => {
  // Catches: a logout or a spent window kept on the harness, or a token-cap refusal repeated on the API.
  const route = harness('claude-opus-4-6');
  for (const code of ['not-installed', 'subscription-exhausted', 'subscription-login', 'subscription-failed'])
    assert.equal(unavailableCode(route, Object.assign(new Error(code), { code })), code);
  assert.equal(unavailableCode(route, Object.assign(new Error('cap'), { key: 'llm.maxRequestTokens' })), null);
});

function chain(retryMinutes = 30) {
  const clock = { at: T0 };
  return { clock, chain: createRouteChain({ now: () => clock.at, retryMs: () => retryMinutes * MINUTE }) };
}

const ROUTES = [
  harness('claude-opus-4-6'),
  api('main', 'anthropic/claude-opus-4.6'),
  api('spare', 'anthropic/claude-opus-4.6'),
];

test('the first route is in force until it fails, then the next one is, and the switch is logged by name', async () => {
  // Catches: a switch that forgets itself, so every request first waits on the spent harness again.
  const { chain: routes } = chain();
  assert.equal(routes.inForce('core', ROUTES), 0);
  const { logs } = await withCapturedLogs(() => routes.failed('core', ROUTES, 0, 'subscription-exhausted'));
  assert.equal(routes.inForce('core', ROUTES), 1);
  const line = logs.find((entry) => entry.msg === 'llm: route switched');
  assert.equal(line?.role, 'core');
  assert.equal(line?.from, 'harness:claude/claude-opus-4-6');
  assert.equal(line?.to, 'main/anthropic/claude-opus-4.6');
  assert.equal(line?.code, 'subscription-exhausted');
});

test('the role tries the first route again once the retry window has passed', () => {
  // Catches: a role left on its fallback for the life of the process after one spent window.
  const { clock, chain: routes } = chain(30);
  routes.failed('core', ROUTES, 0, 'subscription-exhausted');
  clock.at += 29 * MINUTE;
  assert.equal(routes.inForce('core', ROUTES), 1);
  clock.at += 2 * MINUTE;
  assert.equal(routes.inForce('core', ROUTES), 0);
});

test('a failure of the last route wraps to the first unless the first failed within the last minute', () => {
  // Catches: a chain that stops at its end although the first route has had time to recover.
  const { clock, chain: routes } = chain(30);
  const two = ROUTES.slice(0, 2);
  routes.failed('core', two, 0, 'subscription-exhausted');
  clock.at += 30 * 1000;
  routes.failed('core', two, 1, 'http-402');
  assert.equal(routes.inForce('core', two), 1, 'the first failed 30 s ago, so the role stays where it is');
  clock.at += 2 * MINUTE;
  routes.failed('core', two, 1, 'http-402');
  assert.equal(routes.inForce('core', two), 0);
});

test('a failure of a route that is not in force moves nothing', () => {
  // Catches: a late answer of a concurrent request moving the role past the route that works.
  const { chain: routes } = chain();
  routes.failed('core', ROUTES, 0, 'subscription-exhausted');
  routes.failed('core', ROUTES, 0, 'subscription-exhausted');
  assert.equal(routes.inForce('core', ROUTES), 1);
});

test('a chain that changed under the role starts again at its first route', () => {
  // Catches: an index kept across a `/model set`, so the role runs on a route of the old chain's position.
  const { chain: routes } = chain();
  routes.failed('core', ROUTES, 0, 'subscription-exhausted');
  assert.equal(routes.inForce('core', [api('helpers', 'anthropic/claude-opus-4.6'), api('main', 'x/y')]), 0);
});
