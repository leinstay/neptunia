// The memory probe and the persona's sleep while their memory is down (src/subharness/memory-probe.ts): one minimal
// request on the direct key or one one-word reply through the subharness. A failed probe pauses the persona as
// `memory-down`, the next passing one resumes them, and neither touches a pause of the owner. The probe runs at start,
// once per `memory.probeMinutes`, and at once after a refused writer run. keys.json in a temp dir, fetch and the backend
// runner fakes, the clock injected; nothing leaves the process.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MEMORY_DOWN, createMemoryWatch, probeMinutes, routeProbe } from '../../../src/subharness/memory-probe.ts';
import type { MemoryProbeDeps, ProbeResult } from '../../../src/subharness/memory-probe.ts';
import { memoryPath } from '../../../src/subharness/memory-path.ts';
import { MEMORY_ROLE } from '../../../src/llm/roles.ts';
import type { EffortLevel } from '../../../src/llm/roles.ts';
import { BASE_URL, SECRET, fakeFetch, fakePause, healthy } from '../../fixtures/keys-rig.ts';
import type { Call, Reply } from '../../fixtures/keys-rig.ts';
import { writeKeysFile, readKeysFile } from '../../fixtures/keys-file.ts';
import type { KeysFile } from '../../fixtures/keys-file.ts';
import { tempDir } from '../../fixtures/tmp.ts';
import fs from 'node:fs';
import path from 'node:path';
import { fakeVendor } from '../../fixtures/fake-vendor.ts';
import { createAdmin } from '../../../src/admin.ts';
import { reasonedPause } from '../../../src/keys/commands.ts';
import { makeStore } from '../../fixtures/admin-store.ts';

/** One probe of the writer's path as config.json names it now, as the route watch runs it for the memory role. */
const memoryProbe = (deps: MemoryProbeDeps, now: number) =>
  routeProbe({ ...deps, role: MEMORY_ROLE, path: () => memoryPath(deps.privateDir) }, now);

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
  const sentBody = calls[0].body;
  assert.equal(sentBody?.model, 'x/memory');
  assert.deepEqual(ran, []);
});

test('a direct probe whose request is refused answers model-failed', async () => {
  // Catches: a 402 from a spent key read as a pass, so the persona keeps running with a writer that writes nothing.
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

test('a failed probe while the persona runs pauses them as memory-down', async () => {
  // Catches: the persona keeps answering people while nothing they hear is remembered.
  const { watch, pause } = watchRig({ results: [false] });
  await watch.start();
  assert.deepEqual(pause.pauses, [MEMORY_DOWN]);
  assert.equal(pause.reason(), 'memory-down');
});

test('a passing probe after a memory-down pause resumes the persona', async () => {
  // Catches: the persona sleeps until the owner notices, though their memory came back on its own.
  const { watch, pause, at } = watchRig({ results: [false, true] });
  await watch.start();
  at(T0 + 30 * MINUTE);
  await watch.tick();
  assert.equal(pause.resumes, 1);
  assert.equal(pause.reason(), null);
});

test('a passing probe while the persona runs touches no pause', async () => {
  // Catches: a resume at every passing probe, which runs the resume drain and its catch-up each half hour.
  const { watch, pause } = watchRig({ results: [true] });
  await watch.start();
  assert.deepEqual(pause.pauses, []);
  assert.equal(pause.resumes, 0);
});

test('a second failed probe while memory is down does not pause the persona again', async () => {
  // Catches: a pause at every failed probe, each one a journal record and a flush of the persona's state.
  const { watch, pause, at } = watchRig({ results: [false, false] });
  await watch.start();
  at(T0 + 30 * MINUTE);
  await watch.tick();
  assert.deepEqual(pause.pauses, [MEMORY_DOWN]);
});

test('a failed probe while the owner paused the persona leaves that pause as it is', async () => {
  // Catches: the owner's pause relabelled memory-down, so the next passing probe wakes the persona against the owner's word.
  const { watch, pause } = watchRig({ results: [false], reason: 'owner' });
  await watch.start();
  assert.deepEqual(pause.pauses, []);
  assert.equal(pause.reason(), 'owner');
});

test('a passing probe never lifts a pause of the owner', async () => {
  // Catches: the probe resuming whatever pause it finds, waking the persona while the owner edits data/.
  const { watch, pause } = watchRig({ results: [true], reason: 'owner' });
  await watch.start();
  assert.equal(pause.resumes, 0);
  assert.equal(pause.reason(), 'owner');
});

test('a passing probe never lifts the no-core-route pause', async () => {
  // Catches: a subharness probe passing while no core key is left, which wakes the persona with no key for their turns.
  const { watch, pause } = watchRig({ results: [true], reason: 'no-core-route' });
  await watch.start();
  assert.equal(pause.resumes, 0);
  assert.equal(pause.reason(), 'no-core-route');
});

test('a probe that throws counts as failed and pauses the persona', async () => {
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

// PR 3, memory path parity: the memory writer proved at the spawn boundary, with a disposable executable that records the
// argv, the environment and stdin it really got (`runChildProcess`, src/agent-runner/backend.ts). Claude 2.1.317 enforces
// `CLAUDE_CODE_MAX_OUTPUT_TOKENS`, measured live: with 20 a run ended is_error at 80 output tokens, with none 436 end_turn.
// So the writer passes it. Codex lists no such control, so there `maxOutputTokens` stays a reported gap. The installed releases
// list no output-token control in their help (claude 2.1.317, codex 0.164.0), so `maxOutputTokens` is a reported capability
// gap: nothing invents a flag and nothing trims the persona's text. The tests also pin what the writer's parity consists of, how a
// failed selection and a failed source behave, and what `session_runs` records as the path that really ran.

/** One probe of the writer's path as config.json names it now, as the route watch runs it for the memory role. */
const subharnessMemoryBoundaryMemoryProbe = (deps: MemoryProbeDeps, now: number) =>
  routeProbe({ ...deps, role: MEMORY_ROLE, path: () => memoryPath(deps.privateDir) }, now);

function probeDeps(privateDir: string, ran: Array<string>, answer: { ok: boolean; detail?: string }) {
  const { fetch, calls } = fakeFetch();
  return {
    calls,
    deps: {
      privateDir,
      route: () => ({ name: 'core-1', value: 'value' }),
      fetch,
      baseUrl: 'https://openrouter.test/api/v1',
      model: () => 'x/memory',
      runBackend: (name: 'codex' | 'claude') => {
        ran.push(name);
        return Promise.resolve({ ok: answer.ok, text: answer.ok ? 'ok' : '', exitCode: answer.ok ? 0 : 1 });
      },
    },
  };
}

function selectedClaude(loggedIn: boolean) {
  const privateDir = tempDir('nep-memory-boundary-');
  writeKeysFile(privateDir, {
    subharness: {
      backends: ['claude'],
      key: null,
      modes: {},
      memory: { backend: 'claude', model: 'claude-opus-4-6', effort: null },
    },
  });
  const vendor = fakeVendor(privateDir, 'claude', { loggedIn });
  return { privateDir, vendor };
}

test('a passing probe carries the gap of its backend, so a green probe on codex claims no parity', async () => {
  // Catches: "memory: ok" read as full parity by status and by the operator.
  // Changed: claude enforces the cap now, so its probe carries no gap.
  const onClaude = selectedClaude(true);
  const claude = await subharnessMemoryBoundaryMemoryProbe(probeDeps(onClaude.privateDir, [], { ok: true }).deps, 1);
  assert.deepEqual(claude.ok && claude.gaps, []);
  const dir = tempDir('nep-memory-boundary-');
  writeKeysFile(dir, {
    subharness: { key: null, modes: {}, memory: { backend: 'codex', model: 'gpt-6.1-sol', effort: null } },
  });
  fakeVendor(dir, 'codex', { loggedIn: true });
  const codex = await subharnessMemoryBoundaryMemoryProbe(probeDeps(dir, [], { ok: true }).deps, 1);
  assert.deepEqual(codex.ok && codex.gaps, ['maxOutputTokens']);
});

// A failed source

test('a selected source that logged out fails the probe with its code and runs no model', async () => {
  // Catches: a probe that spends a run to learn what the login state already says, or a misleading no-reply.
  const { privateDir } = selectedClaude(false);
  const ran: Array<string> = [];
  const result = await subharnessMemoryBoundaryMemoryProbe(probeDeps(privateDir, ran, { ok: true }).deps, 1);
  assert.deepEqual(result, { ok: false, code: 'not-logged-in', at: 1 });
  assert.deepEqual(ran, []);
});

test('a failed selected source pauses the persona, chooses no other model, and the next pass resumes the persona', async () => {
  // Catches: a fallback to the OpenRouter memory key, or to another backend, when the chosen writer is down.
  const { privateDir, vendor } = selectedClaude(false);
  const before = readKeysFile(privateDir).subharness.memory;
  const ran: Array<string> = [];
  const { deps, calls } = probeDeps(privateDir, ran, { ok: true });
  const pause = fakePause();
  const watch = createMemoryWatch({
    probe: (now) => subharnessMemoryBoundaryMemoryProbe(deps, now),
    pause,
    now: () => 1,
    config: () => ({}),
  });
  assert.equal((await watch.start()).ok, false);
  assert.deepEqual(pause.pauses, [MEMORY_DOWN]);
  assert.deepEqual(calls, []);
  assert.deepEqual(readKeysFile(privateDir).subharness.memory, before);
  fs.mkdirSync(vendor.home, { recursive: true });
  fs.writeFileSync(path.join(vendor.home, 'credentials'), '');
  assert.equal((await watch.refused()).ok, true);
  assert.equal(pause.resumes, 1);
  assert.deepEqual(ran, ['claude']);
});

// The memory probe and the persona's sleep: one minimal request on
// the direct key or one one-word reply through the subharness; a failed probe pauses the persona as `memory-down`, the next
// passing one resumes the persona, and neither touches a pause of the owner. The probe runs at start, once per
// `memory.probeMinutes`, and at once after a refused writer run. keys.json in a temp dir, fetch and the backend runner
// fakes, the clock injected; nothing leaves the process.

const SUBHARNESS_MEMORY_PROBE_T0 = Date.parse('2026-11-02T12:00:00Z');
const SUBHARNESS_MEMORY_PROBE_MINUTE = 60_000;

test('an owner pause given over memory-down stays when the next probe passes', async () => {
  // Catches: the owner's /pause while the persona sleeps as memory-down keeps that reason, so a passing probe wakes the persona against
  // the owner's word while the owner edits data/.
  const store = makeStore();
  const admin = createAdmin({
    hot: { config: { bot: { owners: [] } }, prompts: {} },
    store,
  });
  const pause = reasonedPause({ run: (op, args) => admin.run(op, args, {}), store });
  let clock = SUBHARNESS_MEMORY_PROBE_T0;
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
  clock = SUBHARNESS_MEMORY_PROBE_T0 + 30 * SUBHARNESS_MEMORY_PROBE_MINUTE;
  await watch.tick();
  const { data } = store.state;
  assert.equal(data.paused, true);
  assert.equal(pause.reason(), 'owner');
});
