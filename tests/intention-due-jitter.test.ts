// Tests for the due jitter of heartbeat intentions (src/intentions/model.ts#wakeTimeOf): an
// intention a heartbeat set wakes her at its due time moved by a deterministic random offset;
// every other intention stays exact; the offset never reaches before the moment the record was
// last seen as not yet due, never past its expiry, and the scheduler fires the shifted moment.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIntention, dueList, wakeTimeOf, HEARTBEAT_ORIGIN } from '../src/intentions/model.ts';
import { createInnerLife } from '../src/behavior/inner.ts';
import { createEventDoor } from '../src/interface/door.ts';
import { createIntentionStores } from '../src/intentions/store.ts';
import { createIntentionService } from '../src/intentions/service.ts';
import { HOUR_MS, MINUTE_MS } from '../src/time.ts';
import { tempDir } from './fixtures/tmp.ts';
import { useIface, world } from './fixtures/turn-world.ts';
import type { Untyped } from '../src/tools/types.ts';
import { present, wrongly } from './fixtures/loose-types.ts';

// The chat she wakes in is held by a fake interface named `fake`.
useIface('fake');

const T0 = Date.parse('2026-10-24T10:00:00Z');
const J = 20;
const SILENT = { info() {}, warn() {}, error() {} };

function beat(id: Untyped, dueAt: Untyped, extra = {}) {
  const made = createIntention({
    purpose: 'look at the thread',
    provenance: { kind: 'self', turnId: 't1' },
    dueAt,
    origin: HEARTBEAT_ORIGIN,
    now: T0,
    id,
    ...extra,
  });
  assert.equal(made.ok, true, wrongly(made.code));
  return made.intention;
}

test('the offset is the same for the same id and due time, and differs across ids', () => {
  const due = T0 + 6 * HOUR_MS;
  assert.equal(wakeTimeOf(beat('a', due), J), wakeTimeOf(beat('a', due), J));
  assert.notEqual(wakeTimeOf(beat('a', due), J), wakeTimeOf(beat('a', due + MINUTE_MS), J) - MINUTE_MS);
});

test('offsets spread over [-J, +J] minutes and never leave it', () => {
  const due = T0 + 6 * HOUR_MS;
  const offsets = [];
  for (let i = 0; i < 400; i += 1) offsets.push((wakeTimeOf(beat(`id-${i}`, due), J) - due) / MINUTE_MS);
  assert.ok(offsets.every((value) => value >= -J && value <= J));
  assert.ok(Math.min(...offsets) < -J * 0.8 && Math.max(...offsets) > J * 0.8);
  assert.ok(offsets.filter((value) => value < 0).length > 120 && offsets.filter((value) => value > 0).length > 120);
});

test('a short lead scales the offset: 1 minute stays within 15 s and never before createdAt; right away does not move', () => {
  for (let i = 0; i < 200; i += 1) {
    const record = beat(`s-${i}`, T0 + MINUTE_MS);
    const at = wakeTimeOf(record, J);
    assert.ok(Math.abs(at - present(record.dueAt)) <= 15000);
    assert.ok(at >= record.createdAt);
  }
  assert.equal(wakeTimeOf(beat('now', T0), J), T0);
});

test('a record updated later counts its lead from the update, so the wake is never before it', () => {
  const record = { ...beat('u', T0 + 6 * HOUR_MS), updatedAt: T0 + 6 * HOUR_MS - 4 * MINUTE_MS };
  for (let i = 0; i < 100; i += 1) assert.ok(wakeTimeOf({ ...record, id: `u-${i}` }, J) >= record.updatedAt);
});

test('zero jitter disables it; a non-heartbeat intention and one without a due time stay exact', () => {
  const due = T0 + 6 * HOUR_MS;
  assert.equal(wakeTimeOf(beat('z', due), 0), due);
  const own = createIntention({
    purpose: 'tell her',
    provenance: { kind: 'self', turnId: 't1' },
    dueAt: due,
    now: T0,
    id: 'own',
  }).intention;
  assert.equal(wakeTimeOf(wrongly(own), J), due);
  assert.ok(Number.isNaN(wakeTimeOf(beat('n', null), J)));
});

test('a positive offset never reaches expiresAt', () => {
  for (let i = 0; i < 300; i += 1) {
    const due = T0 + 6 * HOUR_MS;
    const record = beat(`e-${i}`, due, { expiresAt: due + 2 * MINUTE_MS });
    assert.ok(wakeTimeOf(record, J) < record.expiresAt);
  }
  const past = { ...beat('p', T0 + 6 * HOUR_MS), expiresAt: T0 + 6 * HOUR_MS - 1 };
  assert.equal(wakeTimeOf(past, J), past.dueAt, 'a due past the expiry stays as it is; the sweep expires it first');
});

test('dueList lists a heartbeat intention at its shifted moment, naming the chosen due time', () => {
  const record = beat('l', T0 + 6 * HOUR_MS);
  const at = wakeTimeOf(record, J);
  assert.notEqual(at, record.dueAt);
  assert.deepEqual(dueList([record], at - 1, J), []);
  const listed = dueList([record], at, J);
  assert.equal(listed.length, 1);
  assert.equal(listed[0].at, record.dueAt);
  assert.equal(dueList([record], wrongly(record.dueAt), 0).length, 1);
});

test('the scheduler wakes a shifted heartbeat intention at its shifted time and not before; one wake', async () => {
  const clock = { t: T0 };
  const dataDir = tempDir('nep-due-jitter-');
  const hot = {
    config: {
      bot: { timezone: 'UTC' },
      // PR 7d: the switches are code and the due jitter is the constant 20 minutes (J).
      intentions: { expiresDays: 14, recurringExpiresDays: 30, maxOpen: 20, candidateExpiresHours: 48 },
      wakes: {
        mode: 'shadow',
        tickSeconds: 60,
        review: { historyDays: 14 },
        caps: { perChain: 3 },
      },
      heartbeat: { enabled: false },
    },
  };
  const service = createIntentionService({
    stores: createIntentionStores({ dataDir, now: () => clock.t, log: SILENT }),
    hot,
    now: () => clock.t,
    log: SILENT,
    uuid: () => 'fixed-jitter-id',
  });
  const due = T0 + 6 * HOUR_MS;
  const set = service.set({
    purpose: 'look at the thread',
    dueAt: due,
    destination: 'c1',
    origin: HEARTBEAT_ORIGIN,
  });
  assert.equal(set.ok, true, wrongly(set.code));
  const id = set.intention.id;
  const at = wakeTimeOf(wrongly(service.list().find((record) => record.id === id)), J);
  assert.notEqual(at, due);
  const calls: Array<Untyped> = [];
  const turns = {
    busy: false,
    isAnyBusy: () => false,
    runTurn: async (params: Record<string, Untyped>) => {
      calls.push(params);
      return { outcome: 'skip', reason: 'nothing-to-do', inner: { actions: [], turnId: `t-${calls.length}` } };
    },
  };
  let inner: ReturnType<typeof createInnerLife>;
  const door = createEventDoor({ handlers: { 'inner.wake': (event) => inner.onWake(event) }, log: SILENT });
  world().channel({ id: 'c1', name: 'chan', placeId: 'g1' });
  inner = createInnerLife({
    hot,
    dataDir,
    turns,
    intentions: service,
    record: null,
    journal: { inner: async () => {} },
    reads: world().reads,
    iface: () => 'fake',
    submit: (event) => door.submit(event),
    store: { state: { data: {} } },
    peopleWaiting: () => false,
    meter: { run: async (fn) => ({ result: await fn(), usd: 0.1, requests: 1, voice: 1 }) },
    rng: () => 0.5,
    now: () => clock.t,
    log: SILENT,
  });
  clock.t = at - 1;
  assert.equal((await inner.tick()).submitted ?? 0, 0);
  assert.equal(present(inner.status().next).at, at);
  clock.t = at;
  assert.equal((await inner.tick()).submitted, 1);
  assert.equal((await inner.tick()).submitted ?? 0, 0);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(calls.length, 1);
  assert.equal(calls[0].inner.wake.kind, 'intention_due');
  assert.equal(
    present(service.list().find((record) => record.id === id)).dueAt,
    due,
    'what she sees keeps the time she chose'
  );
});

test('a recurring heartbeat intention woken early still advances to the next occurrence', () => {
  const clock = { t: T0 };
  const hot = {
    config: {
      features: { intentions: true },
      bot: { timezone: 'UTC' },
      intentions: {
        expiresDays: 14,
        recurringExpiresDays: 30,
        maxOpen: 20,

        waitHours: 2,
      },
      wakes: { heartbeat: { dueJitterMinutes: J } },
    },
  };
  const service = createIntentionService({
    stores: createIntentionStores({ dataDir: tempDir('nep-due-jitter-'), now: () => clock.t, log: SILENT }),
    hot,
    now: () => clock.t,
    log: SILENT,
    uuid: () => 'early-id',
  });
  const due = T0 + 6 * HOUR_MS;
  const set = service.set({
    purpose: 'look at the thread',
    dueAt: due,
    every: { period: 'day', at: null },
    destination: 'c1',
    origin: HEARTBEAT_ORIGIN,
  });
  assert.equal(set.ok, true, wrongly(set.code));
  const record = service.list()[0];
  const at = wakeTimeOf(record, J);
  clock.t = at - 1;
  assert.equal(service.due().length, 0);
  assert.equal(service.advance(record.id).changed, false);
  clock.t = at;
  assert.equal(service.due().length, 1);
  const advanced = service.advance(record.id);
  assert.equal(advanced.changed, true);
  assert.equal(present(advanced.intention).dueAt, due + 24 * HOUR_MS);
});
