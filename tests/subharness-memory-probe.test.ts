// The memory probe and her sleep (spec 2026-11-02 PR 5, "She sleeps while her memory is down"): one minimal request on
// the direct key or one one-word reply through the subharness; a failed probe pauses her as `memory-down`, the next
// passing one resumes her, and neither touches a pause of the owner. The probe runs at start, once per
// `memory.probeMinutes`, and at once after a refused writer run. keys.json in a temp dir, fetch and the backend runner
// fakes, the clock injected; nothing leaves the process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MEMORY_DOWN, createMemoryWatch, memoryProbe, probeMinutes } from '../src/subharness/memory-probe.ts';
import type { MemoryProbeDeps, ProbeResult } from '../src/subharness/memory-probe.ts';
import type { EffortLevel } from '../src/llm/roles.ts';
import { BASE_URL, SECRET, fakeFetch, fakePause, healthy } from './fixtures/keys-rig.ts';
import type { Call, Reply } from './fixtures/keys-rig.ts';
import { writeKeysFile } from './fixtures/keys-file.ts';
import type { KeysFile } from './fixtures/keys-file.ts';
import { tempDir } from './fixtures/tmp.ts';
import { createAdmin } from '../src/admin.ts';
import { reasonedPause } from '../src/keys/commands.ts';
import { makeStore } from './fixtures/admin-store.ts';

const T0 = Date.parse('2026-11-02T12:00:00Z');
const MINUTE = 60_000;

type Ran = { name: string; brief: string; model: string | undefined; effort: EffortLevel | undefined };

/** Probe deps over a temp keys.json; the backend answers `replies`, fetch answers `answer`. */
function probeRig(
  options: {
    subharness?: Partial<KeysFile['subharness']>;
    answer?: (call: Call) => Reply;
    replies?: boolean;
    route?: { name: string; value: string } | null;
  } = {}
) {
  const privateDir = tempDir('nep-memory-probe-');
  writeKeysFile(privateDir, {
    subharness: { backends: ['codex', 'claude'], key: null, modes: {}, models: {}, uses: {}, ...options.subharness },
  });
  const { fetch, calls } = fakeFetch(options.answer ?? healthy);
  const ran: Array<Ran> = [];
  const replies = options.replies ?? true;
  const deps: MemoryProbeDeps = {
    privateDir,
    route: () => (options.route === undefined ? { name: 'core-1', value: SECRET } : options.route),
    fetch,
    baseUrl: BASE_URL,
    model: () => 'x/memory',
    runBackend: (name, brief, model, effort) => {
      ran.push({ name, brief, model, effort });
      return Promise.resolve(replies ? { ok: true, text: 'ok', exitCode: 0 } : { ok: false, text: '', exitCode: 1 });
    },
  };
  return { deps, calls, ran };
}

const VIA_CLAUDE = { memory: { backend: 'claude', model: 'claude-opus-4-6', effort: 'high' } };

// one probe

test('a direct probe sends the one minimal request of keys check memory on the memory key', async () => {
  // Catches: the probe asking another model or key than the writer uses, so it passes while the writer fails.
  const { deps, calls, ran } = probeRig();
  const result = await memoryProbe(deps, T0);
  assert.deepEqual(result, { ok: true, at: T0 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `${BASE_URL}/chat/completions`);
  assert.equal(calls[0].auth, SECRET);
  assert.equal(calls[0].body?.model, 'x/memory');
  assert.deepEqual(ran, []);
});

test('a direct probe whose request is refused answers model-failed', async () => {
  // Catches: a 402 from a spent key read as a pass, so she keeps running with a writer that writes nothing.
  const { deps } = probeRig({ answer: () => ({ status: 402, body: { error: { message: 'insufficient credits' } } }) });
  const result = await memoryProbe(deps, T0);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'model-failed');
});

test('a direct probe with no memory key answers no-memory-key and sends nothing', async () => {
  // Catches: a request sent with an empty bearer, which the provider bills to nobody and answers 401 at random.
  const { deps, calls } = probeRig({ route: null });
  const result = await memoryProbe(deps, T0);
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'no-memory-key');
  assert.equal(calls.length, 0);
});

test('a subharness probe asks its backend for one reply on the path model and effort, and sends no request', async () => {
  // Catches: the probe checking the direct key while the writer runs on the subscription, whose limit then goes unseen.
  const { deps, calls, ran } = probeRig({ subharness: VIA_CLAUDE });
  const result = await memoryProbe(deps, T0);
  assert.equal(result.ok, true);
  assert.equal(ran.length, 1);
  assert.equal(ran[0].name, 'claude');
  assert.equal(ran[0].model, 'claude-opus-4-6');
  assert.equal(ran[0].effort, 'high');
  assert.equal(calls.length, 0);
});

test('a subharness probe with no reply answers a failure', async () => {
  // Catches: the five-hour limit of the subscription, the one signal of it, read as a pass.
  const { deps } = probeRig({ subharness: VIA_CLAUDE, replies: false });
  const result = await memoryProbe(deps, T0);
  assert.equal(result.ok, false);
});

// the setting

test('the probe interval is memory.probeMinutes when it is a positive number', () => {
  // Catches: the setting ignored, so the owner cannot make the probe rarer on a metered key.
  assert.equal(probeMinutes({ memory: { probeMinutes: 7 } }), 7);
});

test('a probe interval that is no positive number falls back to the one an absent setting gives', () => {
  // Catches: 0 or a string taken as the interval, which probes at every tick and spends a request a minute.
  const fallback = probeMinutes({});
  assert.ok(fallback > 0);
  for (const bad of [0, -5, 'ten', null]) assert.equal(probeMinutes({ memory: { probeMinutes: bad } }), fallback);
});

// the watch: timing

/** A watch over a scripted probe and a clock the test moves; `probes` holds the time of each probe. */
function watchRig(options: { results?: Array<boolean>; reason?: string | null; minutes?: number } = {}) {
  let clock = T0;
  const probes: Array<number> = [];
  const results = [...(options.results ?? [])];
  const pause = fakePause(options.reason ?? null);
  const watch = createMemoryWatch({
    probe: (now) => {
      probes.push(now);
      const ok = results.length > 0 ? (results.shift() ?? true) : true;
      const result: ProbeResult = ok ? { ok: true, at: now } : { ok: false, code: 'model-failed', at: now };
      return Promise.resolve(result);
    },
    pause,
    now: () => clock,
    config: () => ({ memory: { probeMinutes: options.minutes ?? 30 } }),
  });
  return {
    watch,
    pause,
    probes,
    at: (ms: number) => {
      clock = ms;
    },
  };
}

test('the start probes once at once', async () => {
  // Catches: a core that starts on a dead memory path and runs for half an hour before anything notices.
  const { watch, probes } = watchRig();
  await watch.start();
  assert.deepEqual(probes, [T0]);
});

test('a tick before the interval has passed probes nothing', async () => {
  // Catches: a probe at every minute tick, a paid request a minute on the direct key.
  const { watch, probes, at } = watchRig({ minutes: 30 });
  await watch.start();
  at(T0 + 30 * MINUTE - 1);
  assert.equal(await watch.tick(), null);
  assert.deepEqual(probes, [T0]);
});

test('ticks probe once per interval', async () => {
  // Catches: the interval never re-armed after its first probe, or two probes in one interval.
  const { watch, probes, at } = watchRig({ minutes: 30 });
  await watch.start();
  for (let minute = 1; minute <= 90; minute += 1) {
    at(T0 + minute * MINUTE);
    await watch.tick();
  }
  assert.deepEqual(probes, [T0, T0 + 30 * MINUTE, T0 + 60 * MINUTE, T0 + 90 * MINUTE]);
});

test('the interval is read from the live config at each tick', async () => {
  // Catches: the interval cached at start, so a changed setting needs a restart.
  let minutes = 30;
  const probes: Array<number> = [];
  let clock = T0;
  const watch = createMemoryWatch({
    probe: (now) => {
      probes.push(now);
      return Promise.resolve({ ok: true, at: now });
    },
    pause: fakePause(),
    now: () => clock,
    config: () => ({ memory: { probeMinutes: minutes } }),
  });
  await watch.start();
  minutes = 5;
  clock = T0 + 5 * MINUTE;
  await watch.tick();
  assert.deepEqual(probes, [T0, T0 + 5 * MINUTE]);
});

test('a refused writer run probes at once, before the interval', async () => {
  // Catches: a limit hit right after a probe found only half an hour later, every sweep meanwhile refused.
  const { watch, probes, at } = watchRig({ minutes: 30 });
  await watch.start();
  at(T0 + MINUTE);
  await watch.refused();
  assert.deepEqual(probes, [T0, T0 + MINUTE]);
});

// the watch: the two transitions

test('a failed probe while she runs pauses her as memory-down', async () => {
  // Catches: she keeps answering people while nothing she hears is remembered.
  const { watch, pause } = watchRig({ results: [false] });
  await watch.start();
  assert.deepEqual(pause.pauses, [MEMORY_DOWN]);
  assert.equal(pause.reason(), 'memory-down');
});

test('a passing probe after a memory-down pause resumes her', async () => {
  // Catches: she sleeps until the owner notices, though her memory came back on its own.
  const { watch, pause, at } = watchRig({ results: [false, true] });
  await watch.start();
  at(T0 + 30 * MINUTE);
  await watch.tick();
  assert.equal(pause.resumes, 1);
  assert.equal(pause.reason(), null);
});

test('a passing probe while she runs touches no pause', async () => {
  // Catches: a resume at every passing probe, which runs the resume drain and its catch-up each half hour.
  const { watch, pause } = watchRig({ results: [true] });
  await watch.start();
  assert.deepEqual(pause.pauses, []);
  assert.equal(pause.resumes, 0);
});

test('a second failed probe while memory is down does not pause her again', async () => {
  // Catches: a pause at every failed probe, each one a journal record and a flush of her state.
  const { watch, pause, at } = watchRig({ results: [false, false] });
  await watch.start();
  at(T0 + 30 * MINUTE);
  await watch.tick();
  assert.deepEqual(pause.pauses, [MEMORY_DOWN]);
});

test('a failed probe while the owner paused her leaves his pause as it is', async () => {
  // Catches: the owner's pause relabelled memory-down, so the next passing probe wakes her against his word.
  const { watch, pause } = watchRig({ results: [false], reason: 'owner' });
  await watch.start();
  assert.deepEqual(pause.pauses, []);
  assert.equal(pause.reason(), 'owner');
});

test('a passing probe never lifts a pause of the owner', async () => {
  // Catches: the probe resuming whatever pause it finds, waking her while the owner edits data/.
  const { watch, pause } = watchRig({ results: [true], reason: 'owner' });
  await watch.start();
  assert.equal(pause.resumes, 0);
  assert.equal(pause.reason(), 'owner');
});

test('a passing probe never lifts the no-core-route pause', async () => {
  // Catches: a subharness probe passing while no core key is left, which wakes her with no key for her turns.
  const { watch, pause } = watchRig({ results: [true], reason: 'no-core-route' });
  await watch.start();
  assert.equal(pause.resumes, 0);
  assert.equal(pause.reason(), 'no-core-route');
});

test('a probe that throws counts as failed and pauses her', async () => {
  // Catches: an exception out of the probe killing the timer, so memory is never checked again.
  const pause = fakePause();
  const watch = createMemoryWatch({
    probe: () => Promise.reject(new Error('boom')),
    pause,
    now: () => T0,
    config: () => ({ memory: { probeMinutes: 30 } }),
  });
  const result = await watch.start();
  assert.equal(result.ok, false);
  if (!result.ok) assert.equal(result.code, 'probe-error');
  assert.deepEqual(pause.pauses, [MEMORY_DOWN]);
});

test('an owner pause given over memory-down stays when the next probe passes', async () => {
  // Catches: the owner's /pause while she sleeps as memory-down keeps that reason, so a passing probe wakes her against
  // his word while he edits data/.
  const store = makeStore();
  const admin = createAdmin({ hot: { config: { bot: { owners: [] } }, prompts: {} }, store });
  const pause = reasonedPause({ run: (op, args) => admin.run(op, args, {}), store });
  let clock = T0;
  const results = [false, true];
  const watch = createMemoryWatch({
    probe: (now) =>
      Promise.resolve(results.shift() === false ? { ok: false, code: 'model-failed', at: now } : { ok: true, at: now }),
    pause,
    now: () => clock,
    config: () => ({ memory: { probeMinutes: 30 } }),
  });
  await watch.start();
  assert.equal(pause.reason(), MEMORY_DOWN);
  await admin.run('bot.pause', {}, {});
  clock = T0 + 30 * MINUTE;
  await watch.tick();
  assert.equal(store.state.data.paused, true);
  assert.equal(pause.reason(), 'owner');
});
