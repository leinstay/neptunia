// Tests for the heartbeat of the inner life (src/behavior/inner/heartbeat.ts): the moment of the next heartbeat.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { drawHeartbeatAt } from '../../../../src/behavior/inner/heartbeat.ts';
import { MINUTE_MS, HOUR_MS } from '../../../../src/time.ts';
import { NOW, SILENT, clock, fakeTurns, hotWith, intention, setup } from '../../../fixtures/inner-rig.ts';
import { coalesceGroup, heartbeatWake, wakeOfDue, createInnerLife } from '../../../../src/behavior/inner.ts';
import { createIntentionStores } from '../../../../src/intentions/store.ts';
import { createIntentionService } from '../../../../src/intentions/service.ts';
import { tempDir } from '../../../fixtures/tmp.ts';
import { useIface, world } from '../../../fixtures/turn-world.ts';
import type { Untyped } from '../../../../src/tools/types.ts';
import { wrongly, present } from '../../../fixtures/loose-types.ts';
import { createEventDoor } from '../../../../src/interface/door.ts';

test('drawHeartbeatAt: the interval with an even jitter either way, never less than a minute', () => {
  const draw = (r: number, extra = {}) =>
    drawHeartbeatAt({ from: NOW, everyMinutes: 180, jitterMinutes: 60, rng: () => r, ...extra });
  assert.equal(draw(0), NOW + 120 * MINUTE_MS);
  assert.equal(draw(0.5), NOW + 180 * MINUTE_MS);
  assert.ok(draw(0.999999) <= NOW + 240 * MINUTE_MS && draw(0.999999) > NOW + 239 * MINUTE_MS);
  assert.equal(draw(0, { everyMinutes: 10, jitterMinutes: 60 }), NOW + MINUTE_MS);
});

/** What a tick's `drained` answer holds, whichever of its forms it took. */
type Drained = { outcome?: string; feedback?: string; deferred?: string; wakes?: number };

const drainedOf = (answer: { drained?: unknown }): Drained => wrongly<Drained>(answer.drained);

useIface('fake');

const settle = () => new Promise((resolve) => setImmediate(resolve));

test.beforeEach(() => void (clock.t = NOW));

// --- The heartbeat ------------------------------------------------------------------------------

const BEAT = { enabled: true, everyMinutes: 180, jitterMinutes: 60 };

const sayings = () => ({
  async *iterate() {
    yield { kind: 'said', occurredAt: new Date(NOW - HOUR_MS).toISOString(), scope: { channel: 'c3' } };
  },
});

test('heartbeat: the first tick draws the moment with the jitter and keeps it in the state; it survives a restart', async () => {
  const dataDir = tempDir('nep-inner-');
  const run = setup({ dataDir, record: sayings(), hot: hotWith({ heartbeat: BEAT }), rng: () => 0.5 });
  await run.inner.tick();
  const calls = run.turns.calls;
  assert.equal(calls.length, 0);
  assert.deepEqual(run.inner.state().heartbeat, { nextAt: NOW + 180 * MINUTE_MS, lastAt: null });
  assert.deepEqual(run.inner.status().heartbeat, { nextAt: NOW + 180 * MINUTE_MS, lastAt: null });
  const again = setup({ dataDir, record: sayings(), hot: hotWith({ heartbeat: BEAT }), rng: () => 0 });
  assert.equal(present(again.inner.state().heartbeat).nextAt, NOW + 180 * MINUTE_MS);
  await again.inner.tick();
  assert.equal(
    present(again.inner.state().heartbeat).nextAt,
    NOW + 180 * MINUTE_MS,
    'a drawn moment is not drawn again'
  );
  await settle();
  assert.equal(run.journal.filter((r) => r.event === 'heartbeat-drawn').length, 1);
});

test('heartbeat: off draws nothing and wakes nobody; the status says so', async () => {
  const run = setup({ hot: hotWith({ heartbeat: { enabled: false } }) });
  await run.inner.tick();
  assert.equal(run.inner.state().heartbeat, null);
  assert.equal(run.inner.status().heartbeat, null);
});

// Slice 5: a service has no chat (no stand-in, no recent channel), and the heartbeat's facts left with
// heartbeatLines, since `<meanwhile>`, `<memory>` and `<inner>` carry them; their key list is no longer the wake's.
test('heartbeat: at its moment one turn runs nowhere, with no current channel and its own chain; the next moment is drawn from the run', async () => {
  const run = setup({ record: sayings(), hot: hotWith({ heartbeat: BEAT }), rng: () => 0.5 });
  await run.inner.tick();
  const due = NOW + 180 * MINUTE_MS;
  clock.t = due + MINUTE_MS;
  await run.inner.tick();
  const calls = run.turns.calls;
  assert.equal(calls.length, 1);
  const call = calls[0];
  const wake = call.inner.wake;
  assert.equal(wake.kind, 'heartbeat');
  assert.equal(call.chat, null);
  assert.equal(call.inner.currentChannel, null);
  assert.equal(wake.chainId, `heartbeat:${due}`);
  await run.inner.tick();
  assert.deepEqual(run.inner.state().heartbeat, { nextAt: clock.t + 180 * MINUTE_MS, lastAt: due + MINUTE_MS });
  const calls2 = run.turns.calls;
  assert.equal(calls2.length, 1, 'once per moment');
  // The next one is a wake of its own id and chain.
  clock.t = present(present(run.inner.state().heartbeat).nextAt) + MINUTE_MS;
  await run.inner.tick();
  const calls3 = run.turns.calls;
  assert.equal(calls3.length, 2);
  const wake2 = call.inner.wake;
  const inner = calls3[1].inner;
  assert.notEqual(inner.wake.chainId, wake2.chainId);
});

// The heartbeat runs on the service lane beside the chat lane, so the intention
// due with it runs in the same tick, in a turn of its own.
test('heartbeat: never coalesced with another wake and never held behind one: it goes alone first, the intention beside it', async () => {
  const run = setup({
    records: [intention('i1', { placeId: 'c1', dueAt: NOW + 181 * MINUTE_MS })],
    record: sayings(),
    hot: hotWith({ heartbeat: BEAT }),
    rng: () => 0.5,
  });
  await run.inner.tick();
  clock.t = NOW + 182 * MINUTE_MS;
  await run.inner.tick();
  await run.inner.tick();
  const calls = run.turns.calls;
  assert.deepEqual(
    calls.map(({ inner: { wake } }) => wake.items.map((item) => item.kind)),
    [['heartbeat'], ['intention_due']]
  );
  assert.deepEqual(
    coalesceGroup([
      wakeOfDue({ intention: intention('i2'), reason: 'due', at: 1 }),
      // Slice 5: the review that followed here is gone.
      heartbeatWake(2),
    ]).map((wake) => wake.kind),
    ['heartbeat']
  );
});

test('heartbeat: an intention it makes due now is not run inside the heartbeat; the next tick wakes the persona for it as an ordinary intention_due turn', async () => {
  const dataDir = tempDir('nep-inner-');
  const hot = hotWith({ heartbeat: BEAT });
  const service = createIntentionService({
    stores: createIntentionStores({ dataDir, now: () => clock.t }),
    hot,
    now: () => clock.t,
    log: SILENT,
  });
  const lines: Array<Untyped> = [];
  const log = {
    info: (msg: string, fields: Record<string, Untyped>) => lines.push({ msg, ...fields }),
    warn() {},
    error() {},
  };
  const turns = fakeTurns({
    answer: (params: Record<string, Untyped>) => {
      const wake = params.inner.wake;
      if (wake.kind === 'heartbeat') {
        const made: Record<string, Untyped> = service.set({
          purpose: 'look at the thread',
          dueAt: clock.t,
          destination: 'c1',
          origin: 'heartbeat',
        });
        const later: Record<string, Untyped> = service.set({
          purpose: 'share the find',
          dueAt: clock.t + 86_400_000,
          destination: 'c1',
          origin: 'heartbeat',
        });
        return {
          outcome: 'spoke',
          inner: {
            actions: [
              { skill: 'intention.set', status: 'executed', result: 'ok', createdId: made.intention.id },
              { skill: 'intention.set', status: 'executed', result: 'ok', createdId: later.intention.id },
            ],
            intentIds: [],
            turnId: 't-beat',
          },
        };
      }
      return { outcome: 'skip', reason: 'nothing-to-do', inner: { actions: [], intentIds: [], turnId: 't-due' } };
    },
  });
  const run = setup({ service, turns, record: sayings(), hot, rng: () => 0.5, dataDir, log });
  await run.inner.tick();
  clock.t = NOW + 182 * MINUTE_MS;
  await run.inner.tick();
  assert.deepEqual(
    turns.calls.map(({ inner }) => inner.wake.kind),
    ['heartbeat'],
    'the heartbeat turn ran alone'
  );
  const outcome = lines.find((line) => line.msg === 'inner: heartbeat outcome');
  // Changed: the line named one change. A heartbeat takes several intention changes, and the line names each.
  // Bug caught: the line names the first change alone, so the second intention of a heartbeat leaves no trace.
  assert.deepEqual([outcome.result, outcome.openFromHeartbeat, outcome.refused], ['change', 2, []]);
  const ids = service.list({ all: true }).map((intention: Record<string, Untyped>) => intention.id);
  assert.deepEqual(
    outcome.changes,
    ids.map((intentionId: string) => ({ skill: 'intention.set', intentionId }))
  );
  await run.inner.tick();
  assert.deepEqual(
    turns.calls.map(({ inner }) => inner.wake.kind),
    ['heartbeat', 'intention_due']
  );
  const secondCall = turns.calls[1];
  const wake2 = secondCall.inner.wake;
  const intention2 = wake2.intentions[0];
  assert.equal(intention2.origin, 'heartbeat');
  const due = lines.find((line) => line.msg === 'inner: heartbeat intention due');
  assert.deepEqual([due.intentionId, due.result, due.recurring], [ids[0], 'no-op', false]);
});

test('heartbeat: a running turn holds it to the next tick, due time kept; its chain cap is its own, so a chain of another kind at its cap does not touch it', async () => {
  const turns = fakeTurns();
  const run = setup({
    turns,
    record: sayings(),
    hot: hotWith({ heartbeat: BEAT, wakes: { caps: { perChain: 1 } } }),
    rng: () => 0.5,
  });
  await run.inner.tick();
  clock.t = NOW + 181 * MINUTE_MS;
  turns.busy = true;
  const held = await run.inner.tick();
  assert.equal(turns.calls.length, 0);
  assert.equal(drainedOf(held).deferred, 'busy');
  assert.equal(run.inner.state().queue[0].kind, 'heartbeat');
  turns.busy = false;
  await run.inner.tick();
  assert.equal(turns.calls.length, 1);
  assert.deepEqual(run.inner.state().queue, []);
  await run.inner.tick();
  clock.t = present(present(run.inner.state().heartbeat).nextAt) + MINUTE_MS;
  await run.inner.tick();
  assert.equal(turns.calls.length, 2, 'a perChain of 1 holds no second heartbeat: each has its own chain');
});

useIface('fake');

const ROOT = 'g1';

const MINUTE = 60_000;

const HOUR = 60 * MINUTE;

const DAY = 24 * HOUR;

const SERVICE_MECHANICS_SILENT = { info() {}, warn() {}, error() {}, debug() {} };

const at = (iso: string): number => Date.parse(iso);

type Call = { inner: { wake: { kind: string; chainId: string } } };

/** An inner life over the settings given, a clock of its own and a turn runner that records and answers skip. */
function lifeWith(sections: Record<string, unknown>, start: number, rng: () => number = () => 0.5) {
  const clock = { t: start };
  world().channel({ id: 'c1', name: 'chan-c1', placeId: ROOT, permissions: { send: true } });
  const hot = {
    config: {
      bot: { timezone: 'UTC' },
      features: { wakes: true, intentions: true, journal: true },
      mention: { oneAtATime: true },
      wakes: { mode: 'shadow', tickSeconds: 60, review: { enabled: false, historyDays: 14 }, caps: { perChain: 3 } },
      heartbeat: { enabled: false },
      ...sections,
    },
  };
  const service = createIntentionService({
    stores: createIntentionStores({ dataDir: tempDir('nep-svc-'), now: () => clock.t, log: SERVICE_MECHANICS_SILENT }),
    hot,
    now: () => clock.t,
    log: SERVICE_MECHANICS_SILENT,
  });
  const calls: Array<Call> = [];
  const turns = {
    isAnyBusy: () => false,
    runTurn: (params: Call) => {
      calls.push(params);
      return Promise.resolve({
        outcome: 'skip',
        reason: 'nothing-to-do',
        inner: { actions: [], turnId: `t-${calls.length}` },
      });
    },
  };
  let life: ReturnType<typeof createInnerLife> | null = null;
  const door = createEventDoor({
    handlers: { 'inner.wake': (event: object) => life?.onWake(event) },
    log: SERVICE_MECHANICS_SILENT,
  });
  life = createInnerLife({
    hot,
    dataDir: tempDir('nep-svc-inner-'),
    turns,
    intentions: service,
    journal: { inner: () => Promise.resolve(), read: () => [] },
    reads: world().reads,
    iface: () => 'fake',
    chatName: (id: string) => `chan-${id}`,
    submit: (event: object) => door.submit(event),
    store: { state: { data: {} } },
    meter: { run: async (fn: () => unknown) => ({ result: await fn(), usd: 0, requests: 1, voice: 0 }) },
    rng,
    now: () => clock.t,
    log: SERVICE_MECHANICS_SILENT,
  });
  return { clock, life, calls };
}

const wakesOf = (calls: ReadonlyArray<Call>, kind: string): Array<Call> =>
  calls.filter(({ inner }) => inner.wake.kind === kind);

// ---- the heartbeat -----------------------------------------------------------------------------------------------------

test('heartbeat every 4h draws its moment on that interval, with the jitter of the setting', async () => {
  // Catches: the schedule is saved and the timer goes on reading the old interval.
  const start = at('2026-11-04T05:00:00Z');
  const low = lifeWith({ heartbeat: { schedule: 'every 4h', jitterMinutes: 45 } }, start, () => 0);
  await low.life.tick();
  assert.equal(low.life.state().heartbeat?.nextAt, start + 4 * HOUR - 45 * MINUTE);
  const middle = lifeWith({ heartbeat: { schedule: 'every 4h', jitterMinutes: 45 } }, start, () => 0.5);
  await middle.life.tick();
  assert.equal(middle.life.state().heartbeat?.nextAt, start + 4 * HOUR);
});

test('heartbeat at daily times takes the next slot exactly, with no jitter on it', async () => {
  // Catches: a jitter moves a time the owner named, or only the first slot of the day is read.
  const start = at('2026-11-04T07:00:00Z');
  const run = lifeWith({ heartbeat: { schedule: 'at 06:00,18:00', jitterMinutes: 60 } }, start, () => 0);
  await run.life.tick();
  assert.equal(run.life.state().heartbeat?.nextAt, at('2026-11-04T18:00:00Z'));
});

for (const schedule of ['every 4h', 'at 06:00,18:00']) {
  test(`heartbeat ${schedule}: days overdue give at most one wake, and the next moment lies ahead`, async () => {
    // Catches: the timer walks its slots one by one from the old moment, so a downtime comes back as a row of wakes.
    const start = at('2026-11-04T05:00:00Z');
    const run = lifeWith({ heartbeat: { schedule, jitterMinutes: 0 } }, start);
    await run.life.tick();
    run.clock.t = start + 3 * DAY;
    for (let i = 0; i < 5; i += 1) {
      await run.life.tick();
      run.clock.t += MINUTE;
    }
    assert.ok(wakesOf(run.calls, 'heartbeat').length <= 1, String(run.calls.length));
    const next = run.life.state().heartbeat?.nextAt ?? 0;
    assert.ok(next > run.clock.t - 5 * MINUTE, 'the next moment is drawn from now, never from a missed slot');
    if (schedule === 'every 4h') {
      const last = run.life.state().heartbeat?.lastAt ?? 0;
      assert.ok(next - last >= 4 * HOUR && next - last <= 4 * HOUR + 10 * MINUTE, String(next - last));
    } else assert.ok(['06:00', '18:00'].includes(new Date(next).toISOString().slice(11, 16)));
  });
}
