// `/keys check memory` and `neptunia keys check memory` (stage T.2 of the master plan) check the path her memory writer
// runs on now and name it. On the direct path the check is the one request on the memory key. On a subharness path
// (`claude` or `codex`, src/subharness/memory-path.ts) it is the probe through that backend, and no request goes out on
// the OpenRouter key. The deps `memoryPath` and `probeMemory` carry what the core reads from keys.json and what
// `memoryProbe` (src/subharness/memory-probe.ts) answers. The provider is a fake fetch.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createKeysCommands } from '../src/keys/commands.ts';
import type { KeysDeps } from '../src/keys/commands.ts';
import { createKeyStore } from '../src/keys/store.ts';
import { BASE_URL, SECRET, chainRing, everyKeyChains, fakeFetch, fakePause } from './fixtures/keys-rig.ts';
import { tempDir } from './fixtures/tmp.ts';

const T0 = Date.parse('2026-11-05T09:00:00Z');

type Probe = Awaited<ReturnType<NonNullable<KeysDeps['probeMemory']>>>;

function rig({
  path,
  probe,
  withKey = true,
}: {
  path: NonNullable<ReturnType<NonNullable<KeysDeps['memoryPath']>>>;
  probe: Probe;
  withKey?: boolean;
}) {
  const store = createKeyStore({ privateDir: tempDir('keys-memory-') });
  if (withKey) store.add({ name: 'core-1', value: SECRET });
  // Changed: every role runs on its chain (slice 4); here every role's chain names every key of the store.
  const chainOf = everyKeyChains(store, (role) => `current/${role}`);
  const ring = chainRing(store, chainOf);
  const { fetch, calls } = fakeFetch();
  const probes: Array<number> = [];
  const recorded: Array<string> = [];
  const keys = createKeysCommands({
    store,
    ring,
    chainOf,
    saveRoutes: () => Promise.resolve(),
    fetch,
    baseUrl: () => BASE_URL,
    defaults: {},
    currentModel: () => 'x/memory',
    saveModel: () => Promise.resolve(),
    pause: fakePause(null),
    memoryPath: () => path,
    probeMemory: () => {
      probes.push(1);
      return Promise.resolve(probe);
    },
    recordCheck: (role) => recorded.push(role),
  });
  return { keys, calls, probes, recorded };
}

const CLAUDE = { kind: 'subharness', backend: 'claude', model: 'sonnet' } as const;

test('with memory on claude, the check runs the probe, sends nothing to OpenRouter and names the path', async () => {
  // Catches: the check proves the direct key while the writer runs through claude, so a dead login reads as healthy.
  const { keys, calls, probes } = rig({ path: CLAUDE, probe: { ok: true, at: T0 } });
  const answer = await keys.run('keys.check', { role: 'memory' }, null);
  assert.equal(answer.status, 'ok', answer.text);
  assert.deepEqual(calls, []);
  assert.equal(probes.length, 1);
  assert.match(answer.text, /claude/);
  assert.match(answer.text, /sonnet/);
});

test('with memory on claude, a failed probe is a failed check that names the path and the code', async () => {
  // Catches: a logged-out claude reports ok because the unused direct key still answers.
  const { keys } = rig({ path: CLAUDE, probe: { ok: false, code: 'not-logged-in', at: T0 } });
  const answer = await keys.run('keys.check', { role: 'memory' }, null);
  assert.equal(answer.status, 'failed');
  assert.match(answer.text, /claude/);
  assert.match(answer.text, /not-logged-in/);
});

test('with memory on claude and no core key, the check still runs and is not refused for a missing key', async () => {
  // Catches: the check demands an OpenRouter key for a writer that does not use one.
  const { keys, probes } = rig({ path: CLAUDE, probe: { ok: true, at: T0 }, withKey: false });
  const answer = await keys.run('keys.check', { role: 'memory' }, null);
  assert.equal(answer.status, 'ok', answer.text);
  assert.equal(probes.length, 1);
});

test('the check of the subharness path records no direct selection for the memory role', async () => {
  // Catches: readiness keeps a direct-route check for a path the writer is not on.
  const { keys, recorded } = rig({ path: CLAUDE, probe: { ok: true, at: T0 } });
  await keys.run('keys.check', { role: 'memory' }, null);
  assert.deepEqual(recorded, []);
});

test('with memory on the direct path, the check is one request on the memory key and the answer says direct', async () => {
  // Catches: the fix routes every memory check to the probe and the direct route is never proved again.
  const { keys, calls, probes } = rig({ path: { kind: 'direct' }, probe: { ok: true, at: T0 } });
  const answer = await keys.run('keys.check', { role: 'memory' }, null);
  assert.equal(answer.status, 'ok', answer.text);
  assert.equal(calls.length, 1);
  assert.equal(calls[0]?.auth, SECRET);
  assert.deepEqual(probes, []);
  assert.match(answer.text, /direct/);
});

test('a check of another role is the same request whatever the memory path is', async () => {
  // Catches: the memory path leaks into the check of the analyzer role.
  const { keys, calls, probes } = rig({ path: CLAUDE, probe: { ok: true, at: T0 } });
  const answer = await keys.run('keys.check', { role: 'analyzer' }, null);
  assert.equal(answer.status, 'ok', answer.text);
  assert.equal(calls.length, 1);
  assert.deepEqual(probes, []);
});
