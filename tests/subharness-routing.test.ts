// Which agent runs on what lives in the private config.json, and keys.json holds secrets alone (docs/keys.md): an
// agent's route chosen with `/model set` lands under `models.agents`, and no write of the code leaves `roles`,
// `subharness` or an older file's `simulation` in keys.json. The private folder is a temp dir; the backend runner, the
// vendor CLI and fetch are fakes, so no model is asked and no request leaves the process.
// Changed: the model roles run on their chains in `models.routes` (spec 2026-11-09-model-routes, slice 4), so the
// tests of `models.harness`, `llm.boundKeys` and the direct `model set` of a model role are deleted with them, and
// keys.json holds named keys under `keys`.
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readRouting, updateRouting } from '../src/subharness/routing.ts';
import { readKeys, writeKeys } from '../src/keys/file.ts';
import type { KeyStore } from '../src/keys/file.ts';
import { createKeyStore } from '../src/keys/store.ts';
import { setAgentModel, setAgentMode } from '../src/subharness/control.ts';
import type { EnableDeps } from '../src/subharness/control.ts';
import { moneyKeysOf } from '../src/watcher/money.ts';
import { SECRET, SECRET_3 } from './fixtures/keys-rig.ts';
import { fakeVendor } from './fixtures/fake-vendor.ts';
import { tempDir } from './fixtures/tmp.ts';

/** The sections keys.json may hold: the secrets. */
const SECRET_SECTIONS = ['keys', 'services', 'management'];

const keysText = (dir: string): string => fs.readFileSync(path.join(dir, 'keys.json'), 'utf8');
const keysSections = (dir: string): Array<string> => Object.keys(JSON.parse(keysText(dir)) as object);
const configOf = (dir: string): Record<string, Record<string, unknown>> =>
  JSON.parse(fs.readFileSync(path.join(dir, 'config', 'config.json'), 'utf8')) as Record<
    string,
    Record<string, unknown>
  >;

/** A private folder with two named keys, claude and codex installed and logged in. */
function rig() {
  const dir = tempDir('nep-config-routing-');
  const store = createKeyStore({ privateDir: dir });
  store.add({ name: 'core-1', value: SECRET });
  store.add({ name: 'art', value: SECRET_3 });
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

test("an agent's route lands in config.json and keys.json gains nothing", async () => {
  // Catches: the agents' writer left on keys.json, so the routing moves back into the secrets file.
  const { dir, deps } = rig();
  const before = keysText(dir);
  assert.equal((await setAgentModel(deps, 'dev', 'claude-sonnet-5-5', 'high', 'claude')).ok, true);
  assert.equal((await setAgentMode(dir, 'dev', 'full')).ok, true);
  const { models } = configOf(dir);
  assert.deepEqual(models?.agents, {
    via: { dev: 'claude' },
    model: { dev: 'claude-sonnet-5-5' },
    effort: { dev: 'high' },
    mode: { dev: 'full' },
  });
  assert.equal(keysText(dir), before);
});

test('a write of keys.json drops the routing sections an older file still carries', () => {
  // Catches: the store's spread of the old file writing `roles` and `subharness` back, so the secrets file never sheds them.
  const dir = tempDir('nep-config-routing-old-');
  const old = {
    keys: { 'core-1': SECRET, art: SECRET_3 },
    roles: { drawing: 'art' },
    subharness: { key: 'art', uses: { dev: 'claude' } },
    simulation: { key: 'art' },
  };
  fs.writeFileSync(path.join(dir, 'keys.json'), JSON.stringify(old), { mode: 0o600 });
  createKeyStore({ privateDir: dir }).add({ name: 'sim', value: 'sk-or-v1-OTHER' });
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
    subharness: { ...routing.subharness, key: 'oc', providers: { scout: 'amazon-bedrock' } },
  }));
  const read = readRouting(dir);
  assert.equal(read.subharness.key, 'oc');
  assert.deepEqual(read.subharness.providers, { scout: 'amazon-bedrock' });
  updateRouting(dir, (routing) => ({ ...routing, subharness: { ...routing.subharness, providers: {} } }));
  assert.equal(configOf(dir).llm, undefined);
  assert.deepEqual(configOf(dir).models, { agents: { opencodeKey: 'oc' } });
});

test("the watcher's money read lists a named key once, by its name, past an older file's simulation section", () => {
  // Catches: the key name an older file's `simulation` section holds read as a key value, so the balance read goes to
  // OpenRouter with a name as bearer.
  const dir = tempDir('nep-config-routing-money-');
  const old = { keys: { sim: SECRET_3 }, simulation: { key: 'sim' } };
  fs.writeFileSync(path.join(dir, 'keys.json'), JSON.stringify(old), { mode: 0o600 });
  const keys = moneyKeysOf(readKeys(dir));
  assert.deepEqual(
    keys.map((one) => one.slot),
    ['sim']
  );
  assert.ok(keys.every((one) => one.value !== 'sim'));
});
