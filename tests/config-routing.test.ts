// Which part of Neptunia runs on what lives in the private config.json, and keys.json holds secrets alone
// (docs/keys.md): a route chosen with `/model set`, a key bound with `/keys bind` and the simulation's key land under
// `models.harness`, `models.agents`, `llm.boundKeys` and `llm.simulationKey`, and no write of the code leaves `roles`,
// `subharness` or `simulation` in keys.json. The private folder is a temp dir; the backend runner, the vendor CLI and
// fetch are fakes, so no model is asked and no request leaves the process.
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readRouting, updateRouting } from '../src/subharness/routing.ts';
import { readKeys, writeKeys } from '../src/keys/file.ts';
import type { KeyStore } from '../src/keys/file.ts';
import { createKeysCommands } from '../src/keys/commands.ts';
import { createKeyRing } from '../src/keys/ring.ts';
import { createKeyStore } from '../src/keys/store.ts';
import { createKeyFailover } from '../src/llm/key-failover.ts';
import { roleKeyCheck } from '../src/llm/role-health.ts';
import { setAgentModel, setAgentMode } from '../src/subharness/control.ts';
import type { EnableDeps } from '../src/subharness/control.ts';
import { setMemoryPath } from '../src/subharness/memory-path.ts';
import { harnessBackend, setSubscriptionPath } from '../src/subharness/subscription-path.ts';
import { enableSimulation } from '../src/simulation/key.ts';
import { moneyKeysOf } from '../src/watcher/money.ts';
import { BASE_URL, SECRET, SECRET_3, fakeFetch, fakePause } from './fixtures/keys-rig.ts';
import { fakeVendor } from './fixtures/fake-vendor.ts';
import { tempDir } from './fixtures/tmp.ts';

/** The sections keys.json may hold: the secrets and what describes them. */
const SECRET_SECTIONS = ['core', 'extra', 'services', 'variables'];

const keysText = (dir: string): string => fs.readFileSync(path.join(dir, 'keys.json'), 'utf8');
const keysSections = (dir: string): Array<string> => Object.keys(JSON.parse(keysText(dir)) as object);
const configOf = (dir: string): Record<string, Record<string, unknown>> =>
  JSON.parse(fs.readFileSync(path.join(dir, 'config', 'config.json'), 'utf8')) as Record<
    string,
    Record<string, unknown>
  >;

/** A private folder with one core key and one extra key, claude and codex installed and logged in. */
function rig() {
  const dir = tempDir('nep-config-routing-');
  const store = createKeyStore({ privateDir: dir });
  store.addCore({ name: 'core-1', value: SECRET });
  store.addExtra({ name: 'art', value: SECRET_3 });
  fakeVendor(dir, 'claude', { loggedIn: true });
  fakeVendor(dir, 'codex', { loggedIn: true });
  const deps: EnableDeps = {
    privateDir: dir,
    runBackend: () => Promise.resolve({ ok: true, text: 'ok', exitCode: 0 }),
    fetch: () => Promise.resolve(new Response('{}', { status: 200 })),
    helpOf: () => Promise.resolve('Usage: claude [options]\n  --effort <level>\n'),
  };
  return { dir, store, deps };
}

test("her core's route chosen with model set --via lands in config.json and leaves keys.json as it was", async () => {
  // Catches: the route written into keys.json beside the keys, the secrets file the owner backs up and never edits.
  const { dir, deps } = rig();
  const before = keysText(dir);
  const result = await setSubscriptionPath(deps, 'core', 'claude', 'claude-opus-4-6', 'low');
  assert.equal(result.ok, true);
  assert.deepEqual(configOf(dir).models?.harness, {
    core: { backend: 'claude', model: 'claude-opus-4-6', effort: 'low' },
  });
  assert.equal(keysText(dir), before);
});

test("the memory writer's path and an agent's route land in config.json and keys.json gains nothing", async () => {
  // Catches: one of the two writers left on keys.json, so half of the routing moves and half stays behind.
  const { dir, deps } = rig();
  const before = keysText(dir);
  assert.equal((await setMemoryPath(deps, 'codex', 'gpt-6.1-sol')).ok, true);
  assert.equal((await setAgentModel(deps, 'dev', 'claude-sonnet-5-5', 'high', 'claude')).ok, true);
  assert.equal((await setAgentMode(dir, 'dev', 'full')).ok, true);
  const { models } = configOf(dir);
  assert.deepEqual((models?.harness as Record<string, unknown>).memory, {
    backend: 'codex',
    model: 'gpt-6.1-sol',
    effort: null,
  });
  assert.deepEqual(models?.agents, {
    via: { dev: 'claude' },
    model: { dev: 'claude-sonnet-5-5' },
    effort: { dev: 'high' },
    mode: { dev: 'full' },
  });
  assert.equal(keysText(dir), before);
});

test('a key bound with keys bind and the simulation key land in config.json, never in keys.json', async () => {
  // Catches: the binding kept as a `roles` section of keys.json, which the deploy moved out and nothing reads any more.
  const { dir, store } = rig();
  const ring = createKeyRing({ store, failover: createKeyFailover({ now: () => 0 }) });
  const keys = createKeysCommands({
    store,
    ring,
    fetch: fakeFetch().fetch,
    baseUrl: () => BASE_URL,
    defaults: {},
    currentModel: () => '',
    saveModel: () => Promise.resolve(),
    pause: fakePause(null),
  });
  assert.equal((await keys.run('keys.bind', { role: 'drawing', name: 'art' }, null)).status, 'ok');
  assert.equal(enableSimulation(dir, 'art').ok, true);
  assert.deepEqual(configOf(dir).llm, { boundKeys: { drawing: 'art' }, simulationKey: 'art' });
  assert.deepEqual(keysSections(dir).sort(), ['core', 'extra', 'variables']);
  assert.equal(store.boundTo('drawing'), 'art');
  assert.equal((await keys.run('keys.unbind', { role: 'drawing' }, null)).status, 'ok');
  assert.equal(configOf(dir).llm?.boundKeys, undefined);
});

test('a write of keys.json drops the routing sections an older file still carries', () => {
  // Catches: the store's spread of the old file writing `roles` and `subharness` back, so the secrets file never sheds them.
  const dir = tempDir('nep-config-routing-old-');
  const old = {
    core: [{ name: 'core-1', value: SECRET }],
    extra: { art: SECRET_3 },
    roles: { drawing: 'art' },
    subharness: { key: 'art', uses: { dev: 'claude' } },
    simulation: { key: 'art' },
  };
  fs.writeFileSync(path.join(dir, 'keys.json'), JSON.stringify(old), { mode: 0o600 });
  createKeyStore({ privateDir: dir }).addExtra({ name: 'sim', value: 'sk-or-v1-OTHER' });
  for (const section of keysSections(dir)) assert.ok(SECRET_SECTIONS.includes(section), section);
  const store: KeyStore = { ...readKeys(dir), ...{ roles: { vision: 'art' } } };
  writeKeys(dir, store);
  for (const section of keysSections(dir)) assert.ok(SECRET_SECTIONS.includes(section), section);
});

test('the routing reads back what updateRouting wrote, and an empty section leaves config.json', () => {
  // Catches: a cleared record kept as an empty object, which the reader then takes for a route with no backend.
  const dir = tempDir('nep-config-routing-rw-');
  updateRouting(dir, (routing) => ({
    ...routing,
    roles: { search: 'art' },
    subharness: { ...routing.subharness, key: 'oc', providers: { scout: 'amazon-bedrock' } },
  }));
  const read = readRouting(dir);
  assert.deepEqual(read.roles, { search: 'art' });
  assert.equal(read.subharness.key, 'oc');
  assert.deepEqual(read.subharness.providers, { scout: 'amazon-bedrock' });
  assert.equal(read.subharness.core, null);
  updateRouting(dir, (routing) => ({ ...routing, roles: {}, subharness: { ...routing.subharness, providers: {} } }));
  assert.equal(configOf(dir).llm, undefined);
  assert.deepEqual(configOf(dir).models, { agents: { opencodeKey: 'oc' } });
});

test('a role on a harness counts as served with no key at all, and a direct role with no key does not', () => {
  // Catches: the served check still reading keys.json, so a harness core with no key is marked down after the move.
  const dir = tempDir('nep-config-routing-served-');
  updateRouting(dir, (routing) => ({
    ...routing,
    subharness: { ...routing.subharness, core: { backend: 'claude', model: 'claude-opus-4-6', effort: null } },
  }));
  const hasKey = roleKeyCheck({
    hot: { config: {} },
    env: {},
    mainKey: '',
    served: (role) => harnessBackend(dir, role) !== null,
  });
  assert.equal(hasKey('core'), true);
  assert.equal(hasKey('analyzer'), false);
});

test('model set of a direct role with no key is refused at the choice and saves nothing', async () => {
  // Catches: a direct model saved with no key under it, so the role is found broken only when a turn needs it.
  const dir = tempDir('nep-config-routing-nokey-');
  const store = createKeyStore({ privateDir: dir });
  const ring = createKeyRing({ store, failover: createKeyFailover({ now: () => 0 }) });
  const { fetch, calls } = fakeFetch();
  const saved: Array<string> = [];
  const keys = createKeysCommands({
    store,
    ring,
    fetch,
    baseUrl: () => BASE_URL,
    defaults: {},
    currentModel: () => 'openai/gpt-6.1-sol',
    saveModel: (role) => {
      saved.push(role);
      return Promise.resolve();
    },
    pause: fakePause(null),
  });
  const answer = await keys.run('model.set', { role: 'analyzer', model: 'openai/gpt-6.1-sol' }, null);
  assert.equal(answer.status, 'failed');
  assert.deepEqual(saved, []);
  assert.equal(calls.length, 0);
});

test("keys bind checks the role's model on the new key and binds nothing when the provider refuses it", async () => {
  // Catches: a binding saved unchecked, so the role first fails at a turn on a key that cannot serve its model.
  const dir = tempDir('nep-config-routing-bind-');
  const store = createKeyStore({ privateDir: dir });
  store.addCore({ name: 'core-1', value: SECRET });
  store.addExtra({ name: 'art', value: SECRET_3 });
  const ring = createKeyRing({ store, failover: createKeyFailover({ now: () => 0 }) });
  const refuse = fakeFetch(() => ({ status: 403, body: { error: { message: 'no access' } } }));
  const run = (fetch: typeof globalThis.fetch) =>
    createKeysCommands({
      store,
      ring,
      fetch,
      baseUrl: () => BASE_URL,
      defaults: {},
      currentModel: (role) => `current/${role}`,
      saveModel: () => Promise.resolve(),
      pause: fakePause(null),
    }).run('keys.bind', { role: 'vision', name: 'art' }, null);
  assert.equal((await run(refuse.fetch)).status, 'failed');
  assert.equal(refuse.calls.length, 1);
  assert.equal(refuse.calls[0]?.auth, SECRET_3);
  assert.equal(store.boundTo('vision'), null);
  const accept = fakeFetch();
  assert.equal((await run(accept.fetch)).status, 'ok');
  assert.equal(store.boundTo('vision'), 'art');
});

test("the watcher's money read lists the simulation's key once, by its name, and never sends the name as a key", () => {
  // Catches: the simulation's key name read as a key value, so the balance read goes to OpenRouter with a name as bearer.
  const dir = tempDir('nep-config-routing-money-');
  const old = { core: [], extra: { sim: SECRET_3 }, simulation: { key: 'sim' } };
  fs.writeFileSync(path.join(dir, 'keys.json'), JSON.stringify(old), { mode: 0o600 });
  const keys = moneyKeysOf(readKeys(dir));
  assert.deepEqual(
    keys.map((one) => one.slot),
    ['sim']
  );
  assert.ok(keys.every((one) => one.value !== 'sim'));
});
