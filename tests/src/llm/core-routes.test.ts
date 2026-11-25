// Tests for src/llm/core-routes.ts: the core's reads of its chains. The key a reader of a role's key gets is the key of
// the role's chain, the path of a role is its harness while a harness route is in force, and a request before the
// clients are handed over is refused. The key store is a fake; no request leaves the process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createCoreRoutes } from '../../../src/llm/core-routes.ts';
import type { KeyStore } from '../../../src/keys/store.ts';
import { startCore } from '../../../src/core.ts';
import { writeKeysFile } from '../../fixtures/keys-file.ts';
import { fakeVendor } from '../../fixtures/fake-vendor.ts';
import { runCli, settle, withRig } from '../../fixtures/core-units.ts';
import type { Core, Dirs, Llm } from '../../fixtures/core-units.ts';

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
  // The routes read the value of a named key alone, and the ring is their own.
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
  // Catches: a request in the start-up window sent nowhere and hanging the persona's first turn.
  const routes = routesOver(CONFIG);
  await assert.rejects(routes.client.complete([], { role: 'analyzer' }), /before the model clients were built/);
});

test("a request of the diary's director role goes to the memory writer's client, which runs it on a harness", async () => {
  // Catches: a scene route on claude sent to the direct client, which posts a harness model id to the API.
  const routes = routesOver({
    models: { routes: { 'director': [{ via: 'harness', backend: 'claude', model: 'claude-opus-4-8' }] } },
  });
  const reached: Array<string> = [];
  const client = (name: string) => ({
    complete: () => {
      reached.push(name);
      return Promise.resolve({ text: '{}', usage: {}, estimated: 0 });
    },
  });
  routes.serve({ core: client('core'), memory: client('memory'), direct: client('direct') });
  await routes.client.complete([], { role: 'director' });
  assert.deepEqual(reached, ['memory']);
  assert.equal(routes.harnessOf('director'), 'claude');
});

const T0 = Date.parse('2026-11-06T09:00:00Z');
const VALUE = 'sk-or-v1-SECRETVALUE-harness-1111';
const ON_CLAUDE = { backend: 'claude', model: 'claude-opus-4-6', effort: null };

/** The core of the units rig with an empty environment: its keys can only come from `keys.json`. */
function start(dirs: Dirs, llm: Llm): Promise<Core> {
  return startCore({
    paths: dirs.paths,
    env: {},
    interfaces: [],
    llm,
    embedder: { embed: () => Promise.resolve([]) },
    now: () => T0,
  });
}

/** keys.json with one core key (unless `keys` is false) and, when `harness` is set, the core role on claude. */
function store(dirs: Dirs, harness: boolean, keys = true): void {
  writeKeysFile(dirs.privateDir, {
    core: keys ? [{ name: 'core-1', value: VALUE }] : [],
    subharness: { key: null, modes: {}, ...(harness ? { core: ON_CLAUDE } : {}) },
  });
  // The core probes the harness the persona's turns run on at start and sleeps with core-down when it cannot answer,
  // so a harness core here has its CLI installed and logged in: the fake vendor, which runs no model.
  if (harness) fakeVendor(dirs.privateDir, 'claude', { loggedIn: true });
}

const p = (dirs: Dirs, line: string): ReturnType<typeof runCli> => runCli(dirs, ['-p', line]);

test('a core with a harness route and no core key starts and stays running, not paused', async () => {
  // Catches: a start that treats the empty key list as a reason to pause or to refuse, for a core that needs no key.
  await withRig({}, async ({ dirs, llm, cores }) => {
    store(dirs, true, false);
    cores.push(await start(dirs, llm));
    await settle();
    const status = await p(dirs, '/status');
    assert.equal(status.code, 0, status.stderr.slice(-1000));
    assert.ok(!status.stdout.includes('paused'), status.stdout);
    assert.ok(!status.stdout.includes('no-core-route'), status.stdout);
  });
});
