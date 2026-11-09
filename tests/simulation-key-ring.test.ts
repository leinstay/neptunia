// The simulation's key ring (src/simulation/key.ts#simulationRoute, #simulationRing): a paid script routes every role
// through a key ring as the core does, and that ring holds the simulation key alone, so a script spends exactly that key
// whatever `llm.boundKeys` binds and whatever core keys keys.json holds. scripts/lib/cli.ts#simulationLlm hands the ring
// to the script's direct client, and scripts/memory-session.ts gives it to her session. keys.json lives in a temp dir,
// the client's fetch is a fake, and no request leaves the process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { simulationRing, simulationRoute } from '../src/simulation/key.ts';
import { simulationLlm } from '../scripts/lib/cli.ts';
import type { KeyRing } from '../src/keys/ring.ts';
import { createLlm } from '../src/llm/openrouter.ts';
import type { CompleteResult } from '../src/llm/openrouter.ts';
import { CODES, memoryKeyState, refusalOf } from '../src/memory/db/session.ts';
import { baseConfig, prompts } from './fixtures/memory-db/session-rig.ts';
import { writeKeysFile } from './fixtures/keys-file.ts';
import { tempDir } from './fixtures/tmp.ts';

const SIM = 'sk-or-v1-sim-secret-0123456789';
const CORE = 'sk-or-v1-core-secret-9876543210';
const MEMORY = 'sk-or-v1-memory-secret-5555555555';

/** A private dir with a core key, the memory role bound to its own extra key, and `sim` as the simulation key. */
function privateDir(): string {
  const dir = tempDir('nep-sim-ring-');
  writeKeysFile(dir, {
    core: [{ name: 'core-1', value: CORE }],
    extra: { sim: SIM, 'mem-own': MEMORY },
    roles: { memory: 'mem-own' },
    simulation: { key: 'sim' },
  });
  return dir;
}

/** A client on `ring` whose fetch records the bearer of each request and answers one short completion. */
function clientOn(ring: KeyRing) {
  const bearers: Array<string> = [];
  const llm = createLlm({
    apiKey: '',
    keys: ring,
    getConfig: () => ({
      models: { base: { core: 'x/core', memory: 'x/memory' } },
      llm: {
        baseUrl: 'https://openrouter.ai/api/v1',
        temperature: 1,
        maxOutputTokens: 100,
        maxRequestTokens: 1000,
        maxRequestsPerDay: 300,
        timeoutMs: 5000,
        retries: 0,
      },
    }),
    calibrator: { apply: (n: number) => n, observe() {} },
    state: { data: {}, markDirty() {} },
    // The fake answers the few members of a Response the client reads.
    fetchImpl: ((_url: unknown, init: { headers: Record<string, string> }) => {
      bearers.push(init.headers.Authorization ?? '');
      return Promise.resolve({
        ok: true,
        status: 200,
        json: () => Promise.resolve({ choices: [{ message: { content: 'ok' } }], usage: { prompt_tokens: 5 } }),
      });
    }) as unknown as typeof fetch,
  });
  return { llm, bearers };
}

test('the simulation route names the simulation key and carries its value', () => {
  // Catches: the route reading the memory binding or the first core key in place of llm.simulationKey.
  assert.deepEqual(simulationRoute(privateDir()), { name: 'sim', value: SIM });
});

test('the simulation route refuses with simulation-off while the simulation is off', () => {
  // Catches: a script falling back to a core key when nobody switched the simulation on.
  const dir = tempDir('nep-sim-ring-off-');
  writeKeysFile(dir, { core: [{ name: 'core-1', value: CORE }], extra: { sim: SIM }, simulation: { key: null } });
  assert.throws(
    () => simulationRoute(dir),
    (err: unknown) => (err as { code?: string }).code === 'simulation-off'
  );
});

test('the simulation ring routes every role to the simulation key, the bound memory role included', () => {
  // Catches: the memory session of the tool spending the memory binding of production, or a core role a core key.
  const ring = simulationRing(simulationRoute(privateDir()));
  for (const role of ['memory', 'core', 'embedding', 'analyzer'])
    assert.deepEqual(ring.route(role), { name: 'sim', value: SIM }, role);
  assert.deepEqual(ring.names('memory'), ['sim']);
});

test('a budget error on the simulation key has no other key to move to', () => {
  // Catches: a failover that repeats a script's request on a core key after the simulation key ran out of credit.
  const ring = simulationRing(simulationRoute(privateDir()));
  assert.equal(ring.failed('memory', 'sim', 402), null);
  assert.deepEqual(ring.route('memory'), { name: 'sim', value: SIM });
});

test('a memory request of a client on the simulation ring goes out on the simulation key', async () => {
  // Catches: the client reading its own apiKey or another ring entry, so the tool spends a key it was never given.
  const { llm, bearers } = clientOn(simulationRing(simulationRoute(privateDir())));
  await llm.complete([{ role: 'user', content: 'hello' }], { role: 'memory' });
  await llm.complete([{ role: 'user', content: 'hello' }], { role: 'core' });
  assert.deepEqual(bearers, [`Bearer ${SIM}`, `Bearer ${SIM}`]);
});

test('the memory session on the simulation ring is ready and names the simulation key', () => {
  // Catches: every sweep of scripts/memory-session.ts refused not_configured once the .env slot is gone.
  const ring = simulationRing(simulationRoute(privateDir()));
  assert.deepEqual(memoryKeyState(baseConfig(), null, ring), { ok: true, name: 'sim' });
  assert.equal(refusalOf(baseConfig(), null, prompts, ring), null);
});

test('without a key ring the memory session on the direct path is refused, whatever the settings and .env hold', () => {
  // Catches: the retired llm.keyByRole slot and its .env variable still letting a session go out on a key.
  const config = baseConfig({}, { llm: { keyByRole: { memory: 'OPENROUTER_MEMORY_KEY' } } });
  const env = { OPENROUTER_MEMORY_KEY: MEMORY };
  assert.deepEqual(memoryKeyState(config, env, null), { ok: false, name: null });
  assert.equal(refusalOf(config, env, prompts, null), CODES.NOT_CONFIGURED);
});

test("a paid script's direct client is built on the simulation ring", async () => {
  // Catches: simulationLlm handing the script a bare key, so the memory role of its client has no route.
  const dir = privateDir();
  const rings: Array<KeyRing> = [];
  const sim = simulationLlm('memory-session', {
    env: { NEPTUNIA_DATA_DIR: dir },
    createDirect: (_apiKey: string, ring: KeyRing) => {
      rings.push(ring);
      return { complete: (): Promise<CompleteResult> => Promise.resolve({ text: 'ok', usage: {}, estimated: 0 }) };
    },
    getConfig: () => ({ llm: {} }),
    state: { data: {}, markDirty: () => {} },
  });
  assert.equal(rings.length, 1);
  assert.deepEqual(rings[0]?.route('memory'), { name: 'sim', value: SIM });
  assert.deepEqual(sim.ring?.route('memory'), { name: 'sim', value: SIM });
  await sim.close();
});
