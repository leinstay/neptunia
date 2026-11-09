// Tests for src/llm/route-chain.ts: a role's chain read from `models.routes`, and from the old settings
// (`models.base`, `models.harness`, `llm.boundKeys`, `llm.subscription.fallback`, `llm.reasoningByRole`,
// `web.quickSearch.model` and the core key names) while a role has none; which failure makes a route unavailable;
// and the per-role choice of the route in force, with the retry window after a switch. The clock is injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRouteChain, routesOf, unavailableCode } from '../src/llm/route-chain.ts';
import type { Route } from '../src/llm/route-text.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';

const T0 = Date.parse('2026-11-09T09:00:00Z');
const MINUTE = 60_000;
const HARNESS = { backend: 'claude', model: 'claude-opus-4-6', effort: null };

const api = (key: string, model: string, effort: string | null = null): Route =>
  ({ via: 'api', key, model, effort }) as Route;
const harness = (model: string): Route => ({ via: 'harness', backend: 'claude', model, effort: null });

test('a role with its own chain in models.routes takes it whole and ignores the old settings', () => {
  // Catches: a saved chain still overridden by `llm.boundKeys`, so `/model set` changes nothing.
  const config = {
    models: {
      base: { analyzer: 'openai/gpt-6.1-sol' },
      routes: { analyzer: [{ via: 'api', key: 'tools', model: 'anthropic/claude-sonnet-6.1', effort: 'low' }] },
    },
    llm: { boundKeys: { analyzer: 'helpers' } },
  };
  assert.deepEqual(routesOf(config, 'analyzer', ['main']), [api('tools', 'anthropic/claude-sonnet-6.1', 'low')]);
});

test('an empty chain in models.routes leaves the role with no route', () => {
  // Catches: an empty array read as absent, so an optional role the owner turned off comes back on its default.
  assert.deepEqual(routesOf({ models: { routes: { vision: [] } } }, 'vision', ['main']), []);
});

test('a role bound to a key goes out on it alone, with its model and its reasoning effort', () => {
  // Catches: the translation dropping `llm.reasoningByRole`, so the analyzer's requests lose their `reasoning`.
  const config = {
    models: { base: { analyzer: 'anthropic/claude-sonnet-5.5' } },
    llm: { boundKeys: { analyzer: 'helpers' }, reasoningByRole: { analyzer: { effort: 'low' } } },
  };
  assert.deepEqual(routesOf(config, 'analyzer', ['main', 'spare']), [
    api('helpers', 'anthropic/claude-sonnet-5.5', 'low'),
  ]);
});

test('an unbound role takes one route per core key, in the order of the key list', () => {
  // Catches: the failover over the core keys lost, so a spent first key fails every request.
  const config = { models: { base: { vision: 'google/gemini-4-argon' } } };
  assert.deepEqual(routesOf(config, 'vision', ['main', 'spare']), [
    api('main', 'google/gemini-4-argon'),
    api('spare', 'google/gemini-4-argon'),
  ]);
});

test('a role switched off or with no key has no route', () => {
  // Catches: an off role given a route on its default model, so it spends a key the owner did not want spent.
  assert.deepEqual(routesOf({ models: { base: { vision: null } } }, 'vision', ['main']), []);
  assert.deepEqual(routesOf({ models: { base: { analyzer: 'openai/gpt-6.1-sol' } } }, 'analyzer', []), []);
});

test('a core on a harness has that route alone while the fallback is off', () => {
  // Catches: the core's API model appended behind the harness, so a spent window spends a key nobody chose.
  const config = { models: { base: { core: 'anthropic/claude-opus-4.6' }, harness: { core: HARNESS } } };
  assert.deepEqual(routesOf(config, 'core', ['main']), [harness('claude-opus-4-6')]);
});

test('a core on a harness with the fallback on goes to its API routes after the harness', () => {
  // Catches: `llm.subscription.fallback` lost in the translation, so a spent window fails her turn.
  const config = {
    models: { base: { core: 'anthropic/claude-opus-4.6' }, harness: { core: HARNESS } },
    llm: { subscription: { fallback: true } },
  };
  assert.deepEqual(routesOf(config, 'core', ['main', 'spare']), [
    harness('claude-opus-4-6'),
    api('main', 'anthropic/claude-opus-4.6'),
    api('spare', 'anthropic/claude-opus-4.6'),
  ]);
});

test('a memory writer on a harness never falls back to a key, whatever the core fallback says', () => {
  // Catches: the core's fallback applied to the memory writer, which has no fallback today.
  const config = { models: { harness: { memory: HARNESS } }, llm: { subscription: { fallback: true } } };
  assert.deepEqual(routesOf(config, 'memory', ['main']), [harness('claude-opus-4-6')]);
});

test('quick search takes the model of web.quickSearch.model and the key bound to search', () => {
  // Catches: search translated with the analyzer's model, so the quick search answers with a different model.
  const config = {
    models: { base: { analyzer: 'anthropic/claude-sonnet-5.5' } },
    llm: { boundKeys: { search: 'helpers' } },
    web: { quickSearch: { model: 'openai/gpt-6.1-sol' } },
  };
  assert.deepEqual(routesOf(config, 'search', ['main']), [api('helpers', 'openai/gpt-6.1-sol')]);
  assert.deepEqual(routesOf({ web: { quickSearch: { model: null } } }, 'search', ['main']), []);
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
