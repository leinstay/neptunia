// A deployment still on `.env` and the grant a new core key carries: the first add moves the old keys into the store
// and says so by name, `keys core add` asks the grant and reset day, and spend recorded under the old variable counts
// for the imported key. The store is a temp folder, the provider a fake fetch, the chat a scripted dialog.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKeysCommands } from '../src/keys/commands.ts';
import { importKeys } from '../src/keys/import.ts';
import { createKeyRing } from '../src/keys/ring.ts';
import { createKeyStore } from '../src/keys/store.ts';
import { createKeyFailover } from '../src/llm/key-failover.ts';
import { coreKeyBalances } from '../src/llm/key-grants.ts';
import { BASE_URL, SECRET, SECRET_2, SECRET_3, fakeFetch, fakePause, scriptedDialog } from './fixtures/keys-rig.ts';
import { tempDir } from './fixtures/tmp.ts';

const T0 = Date.parse('2026-11-02T09:00:00Z');
const ENV = { OPENROUTER_CORE_KEY: 'v-core-AAA1', OPENROUTER_ART_KEY: 'v-art-BBB2', DISCORD_TOKEN: 'v-discord-CCC3' };

function rig(legacy: boolean) {
  const privateDir = tempDir('keys-legacy-');
  const store = createKeyStore({ privateDir });
  const ring = createKeyRing({ store, failover: createKeyFailover({ now: () => T0 }) });
  const keys = createKeysCommands({
    store,
    ring,
    fetch: fakeFetch().fetch,
    baseUrl: () => BASE_URL,
    defaults: {},
    currentModel: () => '',
    saveModel: () => Promise.resolve(),
    pause: fakePause(),
    ...(legacy ? { importLegacy: () => importKeys({ env: ENV, config: {}, store }) } : {}),
  });
  return { keys, store, ring };
}

test('the first extra add on a deployment with no keys.json moves the .env keys first and names them', async () => {
  const { keys, store } = rig(true);
  const answer = await keys.run('keys.extra.add', { name: 'sim' }, scriptedDialog([SECRET_3]).dialog);
  assert.equal(answer.status, 'ok');
  // Bug caught: the add creating a keys.json with one key, so the core loses the keys it ran on.
  assert.deepEqual(store.coreNames(), ['core-1']);
  assert.deepEqual(
    store
      .list()
      .extra.map((row) => row.name)
      .sort(),
    ['art', 'sim']
  );
  assert.ok(answer.text.includes('core-1') && answer.text.includes('art'), 'it names what it moved');
  assert.ok(!answer.text.includes('AAA1') && !answer.text.includes('v-discord'));
});

test('a refused add with no dialog moves nothing', async () => {
  const { keys, store } = rig(true);
  assert.equal((await keys.run('keys.extra.add', { name: 'sim' }, null)).status, 'invalid');
  assert.deepEqual(store.list(), { core: [], extra: [] });
});

test('a later core add asks the grant and the reset day, and the listing shows them', async () => {
  const { keys, store } = rig(false);
  store.addCore({ name: 'core-1', value: SECRET });
  await keys.run('keys.core.add', { name: 'core-2' }, scriptedDialog([SECRET_2, '75.5', '15']).dialog);
  await keys.run('keys.core.add', { name: 'core-3' }, scriptedDialog([SECRET_3, 'none']).dialog);
  assert.deepEqual(
    store.list().core.map((row) => [row.name, row.grant, row.resetDay]),
    [
      ['core-1', null, null],
      ['core-2', 75.5, 15],
      ['core-3', null, null],
    ]
  );
  const listed = await keys.run('keys.core.list', {}, null);
  assert.ok(listed.text.includes('75.5') && listed.text.includes('15'));
});

test('a grant that is not a number, or a reset day outside 1 to 31, is refused and nothing is saved', async () => {
  const { keys, store } = rig(false);
  store.addCore({ name: 'core-1', value: SECRET });
  assert.equal(
    (await keys.run('keys.core.add', { name: 'core-2' }, scriptedDialog([SECRET_2, 'lots']).dialog)).status,
    'invalid'
  );
  assert.equal(
    (await keys.run('keys.core.add', { name: 'core-2' }, scriptedDialog([SECRET_2, '10', '40']).dialog)).status,
    'invalid'
  );
  assert.deepEqual(store.coreNames(), ['core-1']);
});

test('spend recorded under the old variable counts for the imported key, and new spend under its name', () => {
  const { store, ring } = rig(false);
  importKeys({ env: ENV, config: { llm: { keys: { OPENROUTER_CORE_KEY: { grant: 100, resetDay: 1 } } } }, store });
  const spent: Record<string, number> = { OPENROUTER_CORE_KEY: 30, 'core-1': 5 };
  const llm = {
    keyNames: (role: string) => ring.names(role),
    keyGrants: () => ring.grants(),
    keyVariables: () => ring.variables(),
  };
  const usage = { keyCost: (name: string) => spent[name] ?? 0 };
  const [row] = coreKeyBalances({ llm, usage, config: {}, now: T0 });
  // Bug caught: the month's spend before the import forgotten, so the key shows a full grant again.
  assert.equal(row?.left, 65);
});
