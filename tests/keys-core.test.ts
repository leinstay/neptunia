// The key store inside a real core (tests/fixtures/core-units.ts): a core with a `keys.json` starts with no key in its
// environment, the `/keys` commands over the owner's chat list and remove keys without printing a value, and removing the
// last core key pauses her with the reason `no-core-route` until the owner's own `/resume`. `fetch` is never reached: no
// command here checks a key.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { startCore } from '../src/core.ts';
import { createKeyStore } from '../src/keys/store.ts';
import { runCli, withRig } from './fixtures/core-units.ts';
import type { Core, Dirs, Llm } from './fixtures/core-units.ts';

const T0 = Date.parse('2026-11-02T09:00:00Z');
const VALUE_1 = 'sk-or-v1-SECRETVALUE-core-one-1111';
const VALUE_2 = 'sk-or-v1-SECRETVALUE-core-two-2222';

/** The core of the units rig, with an empty environment: its keys can only come from `keys.json`. */
function startOnKeyStore(dirs: Dirs, llm: Llm): Promise<Core> {
  return startCore({
    paths: dirs.paths,
    env: {},
    interfaces: [],
    llm,
    embedder: { embed: () => Promise.resolve([]) },
    now: () => T0,
  });
}

const p = (dirs: Dirs, line: string): ReturnType<typeof runCli> => runCli(dirs, ['-p', line]);

// Changed: her core runs on its chain (spec 2026-11-09-model-routes, slice 4), here one route on each of the two keys.
const ON_BOTH_KEYS = {
  models: {
    routes: {
      core: [
        { via: 'api', key: 'core-1', model: 'x/core', effort: null },
        { via: 'api', key: 'core-2', model: 'x/core', effort: null },
      ],
    },
  },
};

test('a core with a keys.json starts without a key in its environment, lists keys by name and last four, and the last removal pauses her', async () => {
  await withRig({ config: ON_BOTH_KEYS }, async ({ dirs, llm, cores }) => {
    const store = createKeyStore({ privateDir: dirs.privateDir });
    store.add({ name: 'core-1', value: VALUE_1 });
    store.add({ name: 'core-2', value: VALUE_2 });
    // Bug caught: the core refusing to start for want of OPENROUTER_CORE_KEY although the key store holds the keys.
    cores.push(await startOnKeyStore(dirs, llm));

    const listed = await p(dirs, '/keys list');
    assert.equal(listed.code, 0, listed.stderr.slice(-1000));
    assert.ok(listed.stdout.includes('core-1') && listed.stdout.includes('1111') && listed.stdout.includes('2222'));
    assert.ok(!listed.stdout.includes('SECRETVALUE'));

    assert.equal((await p(dirs, '/keys remove core-2')).code, 0);
    assert.ok(!(await p(dirs, '/status')).stdout.includes('no-core-route'), 'one key is left: she runs');

    assert.equal((await p(dirs, '/keys remove core-1')).code, 0);
    const paused = await p(dirs, '/status');
    // Bug caught: the last removal leaving her running with no key, or pausing without saying why.
    assert.ok(paused.stdout.includes('paused') && paused.stdout.includes('no-core-route'), paused.stdout);
    assert.deepEqual(store.names(), []);

    assert.equal((await p(dirs, '/resume')).code, 0);
    assert.ok(!(await p(dirs, '/status')).stdout.includes('no-core-route'));
    assert.equal((await p(dirs, '/pause')).code, 0);
    // Bug caught: the reason of an earlier pause kept in the state, so the owner's own pause reads as a missing key.
    const again = await p(dirs, '/status');
    assert.ok(again.stdout.includes('paused'));
    assert.ok(!again.stdout.includes('no-core-route'), again.stdout);
  });
});

test('a key command that asks for a value with no terminal to ask in is refused and writes nothing', async () => {
  await withRig({}, async ({ dirs, llm, cores }) => {
    createKeyStore({ privateDir: dirs.privateDir }).add({ name: 'core-1', value: VALUE_1 });
    cores.push(await startOnKeyStore(dirs, llm));
    const run = await p(dirs, '/keys add art');
    assert.equal(run.code, 1);
    assert.deepEqual(createKeyStore({ privateDir: dirs.privateDir }).names(), ['core-1']);
  });
});
