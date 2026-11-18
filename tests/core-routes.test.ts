// Tests for src/llm/core-routes.ts: the core's reads of its chains. The key a reader of a role's key gets is the key of
// the role's chain, the path of a role is its harness while a harness route is in force, and a request before the
// clients are handed over is refused. The key store is a fake; no request leaves the process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCoreRoutes } from '../src/llm/core-routes.ts';
import type { KeyStore } from '../src/keys/store.ts';

const VALUES: Record<string, string> = { main: 'sk-main-0001', helpers: 'sk-helpers-0002' };
const CONFIG = {
  models: {
    routes: {
      core: [{ via: 'harness', backend: 'claude', model: 'claude-opus-4-6' }],
      analyzer: [{ via: 'api', key: 'helpers', model: 'anthropic/claude-sonnet-6.1' }],
    },
  },
};

function routesOver(config: unknown) {
  // Changed: the routes read the value of a named key alone, and the ring is their own (slice 4).
  const store = { valueOf: (name: string) => VALUES[name] ?? null } as unknown as KeyStore; // the one method read
  return createCoreRoutes({ store, getConfig: () => config, now: () => 0 });
}

test("a reader of a role's key gets the key of the role's chain, not the ring's first core key", () => {
  // Catches: the probes and the status reading the first core key while the analyzer's chain names helpers.
  const routes = routesOver(CONFIG);
  assert.deepEqual(routes.ring.route('analyzer'), { name: 'helpers', value: VALUES.helpers });
  assert.equal(routes.ring.route('core'), null, 'a core on a harness alone has no key');
});

test('a role on a harness route reads as that harness, a role on a key as the API', () => {
  // Catches: the header calling a core on claude `direct-api`, so its lost login goes unseen.
  const routes = routesOver(CONFIG);
  assert.deepEqual(routes.pathOf('core'), {
    kind: 'subharness',
    via: 'harness',
    backend: 'claude',
    model: 'claude-opus-4-6',
    effort: null,
  });
  assert.equal(routes.harnessOf('core'), 'claude');
  assert.equal(routes.harnessOf('analyzer'), null);
  assert.equal(routes.modelOf('analyzer'), 'anthropic/claude-sonnet-6.1');
});

test('a request before the clients are handed over is refused', async () => {
  // Catches: a request in the start-up window sent nowhere and hanging her first turn.
  const routes = routesOver(CONFIG);
  await assert.rejects(routes.client.complete([], { role: 'analyzer' }), /before the model clients were built/);
});

test("a request of the diary's director role goes to the memory writer's client, which runs it on a harness", async () => {
  // Catches: a scene route on claude sent to the direct client, which posts a harness model id to the API.
  const routes = routesOver({
    models: { routes: { 'diary.director': [{ via: 'harness', backend: 'claude', model: 'claude-opus-4-8' }] } },
  });
  const reached: Array<string> = [];
  const client = (name: string) => ({
    complete: () => {
      reached.push(name);
      return Promise.resolve({ text: '{}', usage: {}, estimated: 0 });
    },
  });
  routes.serve({ core: client('core'), memory: client('memory'), direct: client('direct') });
  await routes.client.complete([], { role: 'diary.director' });
  assert.deepEqual(reached, ['memory']);
  assert.equal(routes.harnessOf('diary.director'), 'claude');
});
