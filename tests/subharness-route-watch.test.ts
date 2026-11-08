// src/subharness/route-watch.ts: the probes of the three parts she cannot work without, her core, the analyzer and the
// memory writer, each on the route it runs on now (its key, or its harness). A failed probe puts her to sleep with the
// part's own reason through the reasoned pause, and the next passing probe of that part wakes her. The owner's word of
// 2026-11-08: the memory probe stays and the same probe applies to the core and the analyzer. keys.json in a temp dir,
// fetch, the vendor and the backend runner are fakes, the clock is injected; nothing leaves the process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ANALYZER_DOWN, CORE_DOWN, createRouteWatches } from '../src/subharness/route-watch.ts';
import type { WatchedRole } from '../src/subharness/route-watch.ts';
import { MEMORY_DOWN } from '../src/subharness/memory-probe.ts';
import type { EffortLevel } from '../src/llm/roles.ts';
import { BASE_URL, SECRET, fakeFetch, fakePause, healthy } from './fixtures/keys-rig.ts';
import type { Call, Reply } from './fixtures/keys-rig.ts';
import { writeKeysFile } from './fixtures/keys-file.ts';
import type { KeysFile } from './fixtures/keys-file.ts';
import { fakeVendor } from './fixtures/fake-vendor.ts';
import { tempDir } from './fixtures/tmp.ts';

const T0 = Date.parse('2026-11-08T12:00:00Z');
const MINUTE = 60_000;
const MODELS: Readonly<Record<WatchedRole, string>> = { core: 'x/core', analyzer: 'x/analyzer', memory: 'x/memory' };

type Ran = { name: string; model: string | undefined; effort: EffortLevel | undefined };

/** Watches over a temp keys.json; `down` names the parts whose provider refuses them, changed by the test. */
function rig(
  options: {
    subharness?: Partial<KeysFile['subharness']>;
    models?: Partial<Record<WatchedRole, string | null>>;
    session?: 'apply' | 'off';
    offline?: boolean;
  } = {}
) {
  const privateDir = tempDir('nep-route-watch-');
  writeKeysFile(privateDir, { subharness: { key: null, modes: {}, ...options.subharness } });
  const down = new Set<string>();
  const answer = (call: Call): Reply =>
    down.has(String(call.body?.model)) ? { status: 401, body: { error: { message: 'no' } } } : healthy(call);
  const { fetch, calls } = fakeFetch(answer);
  const ran: Array<Ran> = [];
  let clock = T0;
  const pause = fakePause(null);
  const models = { ...MODELS, ...options.models };
  const watches = createRouteWatches({
    privateDir,
    fetch: options.offline === true ? null : fetch,
    baseUrl: () => BASE_URL,
    route: () => ({ name: 'core-1', value: SECRET }),
    model: (role) => models[role] ?? null,
    runBackend: (name, _brief, model, effort) => {
      ran.push({ name, model, effort });
      return Promise.resolve({ ok: true, text: 'ok', exitCode: 0 });
    },
    pause,
    now: () => clock,
    config: () => ({ memory: { probeMinutes: 30 }, memoryDb: { session: { mode: options.session ?? 'apply' } } }),
  });
  const asked = (role: WatchedRole): number => calls.filter((call) => call.body?.model === MODELS[role]).length;
  return {
    privateDir,
    watches,
    pause,
    ran,
    down,
    asked,
    later: (minutes: number) => {
      clock += minutes * MINUTE;
    },
  };
}

test('a core whose key the provider refuses puts her to sleep with core-down, and its next passing probe wakes her', async () => {
  // Catches: a core that cannot answer left awake, so every turn fails while the header and the pause say nothing.
  const { watches, pause, down, later } = rig();
  down.add(MODELS.core);
  await watches.start();
  assert.deepEqual(pause.pauses, [CORE_DOWN]);
  assert.equal(watches.last('core')?.ok, false);
  down.clear();
  later(30);
  await watches.tick();
  assert.equal(pause.resumes, 1);
  assert.equal(watches.last('core')?.ok, true);
});

test('an analyzer the provider refuses puts her to sleep with analyzer-down', async () => {
  // Catches: the analyzer left out of the probes, so she runs with nothing to read her messages.
  const { watches, pause, down } = rig();
  down.add(MODELS.analyzer);
  await watches.start();
  assert.deepEqual(pause.pauses, [ANALYZER_DOWN]);
});

test('an analyzer switched off is not asked and passes', async () => {
  // Catches: a probe of a model the owner switched off, which fails and puts her to sleep for nothing.
  const { watches, pause, asked } = rig({ models: { analyzer: null } });
  await watches.start();
  assert.equal(asked('analyzer'), 0);
  assert.equal(watches.last('analyzer')?.ok, true);
  assert.deepEqual(pause.pauses, []);
});

test('a core on a harness is probed through that harness with its model, and no key is asked for it', async () => {
  // Catches: the API key probed for a core that runs on a subscription, so a dead harness passes and a missing key fails.
  const { privateDir, watches, ran, asked } = rig({
    subharness: { core: { backend: 'claude', model: 'claude-opus-4-6', effort: 'low' } },
  });
  fakeVendor(privateDir, 'claude', { loggedIn: true });
  await watches.start();
  assert.deepEqual(ran, [{ name: 'claude', model: 'claude-opus-4-6', effort: 'low' }]);
  assert.equal(asked('core'), 0);
  assert.equal(watches.last('core')?.ok, true);
});

test('a core on a harness that is logged out fails its probe with no model run', async () => {
  // Catches: a reply asked of a CLI with no login, or a logged-out harness core left awake.
  const { privateDir, watches, ran, pause } = rig({
    subharness: { core: { backend: 'claude', model: 'claude-opus-4-6', effort: null } },
  });
  fakeVendor(privateDir, 'claude', { loggedIn: false });
  await watches.start();
  assert.deepEqual(ran, []);
  assert.deepEqual(watches.last('core'), { ok: false, code: 'not-logged-in', at: T0 });
  assert.deepEqual(pause.pauses, [CORE_DOWN]);
});

test('when one sleep lifts while another part still fails, she sleeps again with that part reason', async () => {
  // Catches: the core's passing probe waking her while the memory writer is still down, for a whole probe interval.
  const { watches, pause, down, later } = rig();
  down.add(MODELS.core);
  down.add(MODELS.memory);
  await watches.start();
  down.delete(MODELS.core);
  later(30);
  await watches.tick();
  assert.deepEqual(pause.pauses, [CORE_DOWN, MEMORY_DOWN]);
  assert.equal(pause.reason(), MEMORY_DOWN);
});

test('a refused writer run probes the memory writer at once and no other part', async () => {
  // Catches: a refused run that waits for the interval, or one that spends a request on every part.
  const { watches, asked } = rig();
  await watches.start();
  await watches.refused('memory');
  assert.deepEqual([asked('core'), asked('analyzer'), asked('memory')], [1, 1, 2]);
});

test('a memory session that is off is not probed and passes', async () => {
  // Catches: a writer that does not run probed anyway, so a missing memory key puts her to sleep for nothing.
  const { watches, asked } = rig({ session: 'off' });
  await watches.start();
  assert.equal(asked('memory'), 0);
  assert.equal(watches.last('memory')?.ok, true);
});

test('with no fetch the parts on the API pass with no request, and a harness part is still probed', async () => {
  // Catches: a core with an injected model client that probes the real provider, or puts her to sleep for want of it.
  const { privateDir, watches, pause, ran, asked } = rig({
    offline: true,
    subharness: { memory: { backend: 'claude', model: 'claude-opus-4-6', effort: null } },
  });
  fakeVendor(privateDir, 'claude', { loggedIn: true });
  await watches.start();
  assert.deepEqual([asked('core'), asked('analyzer')], [0, 0]);
  assert.equal(ran.length, 1);
  assert.deepEqual(pause.pauses, []);
});
