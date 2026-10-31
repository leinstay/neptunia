// The inner life over the wake queue in the memory database (spec 2026-10-27-stage-4-cut, PR B, and the owner's answer
// of 2026-10-27 on sleep). The drain claims a wake in the database before the turn asks the model, and completes it
// after: no transaction is open while the model is asked. A wake cut off by a restart runs again under the turn id of
// its first run, so its effect keys stay the same. A wake that falls due while the core is down or paused sleeps: it
// becomes `slept` and never runs, the status counts it, and the one-off intention it was for is cancelled with a
// `sleptAt` mark, so her calls on it answer `slept`. A recurring intention loses only the occurrence that slept: its
// history records `slept`, and the next occurrence comes due and runs. A real memory database on the calling thread, a real intention
// service and event door, a fake turn runner standing in for the model call; the clock injected as `now`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createInnerLife } from '../src/behavior/inner.ts';
import type { InnerTurnParams } from '../src/behavior/inner/types.ts';
import { createEventDoor } from '../src/interface/door.js';
import { createIntentionService } from '../src/intentions/service.ts';
import { createIntentionStores } from '../src/intentions/store.ts';
import { leaseOf, wakeOf } from '../src/memory/db/wake-queue.ts';
import { openTestMemory } from './fixtures/memory-db/service.js';
import { tempDir } from './fixtures/tmp.js';
import { useIface, world } from './fixtures/turn-world.ts';

useIface('fake');
const GUILD = 'g1';
const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const T = Date.parse('2026-10-31T12:00:00Z');
const LEASE_MS = MINUTE;
const SILENT = { info() {}, warn() {}, error() {}, debug() {} };

type Memory = Awaited<ReturnType<typeof openTestMemory>>;
type Answer = (params: InnerTurnParams) => Promise<unknown>;
/** The pause flags of the store (`/nep pause` sets them in state.json). */
type PauseFlags = { paused?: boolean; pausedAt?: string };

/** The answer of a turn that ran and said nothing. */
const skipped = (): Promise<unknown> =>
  Promise.resolve({ outcome: 'skip', reason: 'nothing-to-do', inner: { actions: [], turnId: 't-inner' } });

function hotOf() {
  return {
    config: {
      bot: { timezone: 'UTC' },
      context: { turnLeaseMs: LEASE_MS },
      features: { innerLife: true, intentions: true, journal: false },
      mention: { oneAtATime: true },
      innerLife: {
        mode: 'shadow',
        tickSeconds: 60,
        queueMax: 20,
        chatMessages: 30,
        review: { enabled: false, historyDays: 14 },
        heartbeat: { enabled: false, dueJitterMinutes: 0 },
        caps: { perChain: 3 },
      },
    },
  };
}

/**
 * One core over a data directory: a memory database opened there, an inner life with its door, and what the core
 * keeps across a restart (the clock, the intentions, the store's pause flags). `restart()` closes the database and
 * opens a new one and a new inner life over the same directory, as a new process would.
 */
async function core() {
  world().channel({ id: 'c1', name: 'chan-c1', guildId: GUILD, permissions: { send: true } });
  const clock = { t: T };
  const hot = hotOf();
  const dataDir = tempDir('nep-inner-wakes-');
  const flags: PauseFlags = {};
  const store = { state: { data: flags } };
  const service = createIntentionService({
    stores: createIntentionStores({ now: () => clock.t, log: SILENT }),
    hot,
    getGuildId: () => GUILD,
    now: () => clock.t,
    log: SILENT,
  });
  const turns = { busy: false, calls: [] as Array<InnerTurnParams>, answer: skipped as Answer };
  const open = async () => {
    const memory = await openTestMemory({
      dataDir,
      config: { context: { turnLeaseMs: LEASE_MS } },
      now: () => clock.t,
    });
    let life: ReturnType<typeof createInnerLife> | null = null;
    const door = createEventDoor({ handlers: { 'inner.wake': (event: object) => life?.onWake(event) }, log: SILENT });
    life = createInnerLife({
      hot,
      dataDir,
      turns: {
        isAnyBusy: () => turns.busy,
        runTurn: (params: InnerTurnParams) => {
          turns.calls.push(params);
          return turns.answer(params);
        },
      },
      intentions: service,
      reads: world().reads,
      iface: () => 'fake',
      conversationName: (id: string) => `chan-${id}`,
      submit: (event: object) => door.submit(event),
      store,
      getGuildId: () => GUILD,
      meter: { run: async (fn: () => unknown) => ({ result: await fn(), usd: 0, requests: 1, voice: 0 }) },
      memoryDb: memory.memoryDb,
      rng: () => 0.5,
      now: () => clock.t,
      log: SILENT,
    });
    return { memory, life };
  };
  let current = await open();
  return {
    clock,
    flags,
    service,
    turns,
    get life() {
      return current.life;
    },
    get memory(): Memory {
      return current.memory;
    },
    async restart() {
      await current.memory.close();
      current = await open();
    },
    close: () => current.memory.close(),
  };
}

type Core = Awaited<ReturnType<typeof core>>;

/** A one-off intention of hers in c1 due at `dueAt`, and the id of the wake it gives. */
function dueIntention(run: Core, dueAt: number): { id: string; wakeId: string } {
  const made = run.service.set(GUILD, { purpose: 'ask how the trip went', dueAt, channelId: 'c1', scope: 'group' });
  if (!made.ok) throw new Error(`intention not set: ${made.code}`);
  return { id: made.intention.id, wakeId: `inner.wake:intention_due:${made.intention.id}:${dueAt}` };
}

/** The service's read connection, which its JS source leaves untyped; refused when the database is not open. */
function readHandleOf(memory: Memory): { db: object } {
  const handle: unknown = memory.memoryDb.readHandle();
  const db: unknown = typeof handle === 'object' && handle !== null ? Reflect.get(handle, 'db') : null;
  if (typeof db !== 'object' || db === null) throw new Error('the memory database is not open');
  return { db };
}

/** Whether the writer connection holds an open transaction (on the calling thread it is the read connection too). */
function inTransaction(memory: Memory): unknown {
  return Reflect.get(readHandleOf(memory).db, 'isTransaction');
}

test('the drain claims the wake with a lease before the turn asks the model, and completes it as handled after', async () => {
  const run = await core();
  try {
    const { wakeId } = dueIntention(run, T - MINUTE);
    const seen: Array<{ state: unknown; token: unknown; holder: unknown; lease: ReturnType<typeof leaseOf> }> = [];
    run.turns.answer = () => {
      const read = readHandleOf(run.memory);
      const wake = wakeOf(read, wakeId);
      seen.push({
        state: wake?.state,
        token: wake?.leaseToken,
        holder: wake?.leaseHolder,
        lease: leaseOf(read, `wake:${wakeId}`),
      });
      return skipped();
    };
    await run.life.tick();
    assert.equal(run.turns.calls.length, 1);
    const [during] = seen;
    assert.equal(during?.state, 'running');
    assert.ok(Number(during?.token) >= 1, 'a granted token');
    assert.equal(during?.lease?.token, during?.token, 'the wake carries the token of its lease');
    assert.equal(during?.lease?.holder, during?.holder);
    assert.equal(during?.lease?.expiresAt, T + LEASE_MS, 'the lease lasts context.turnLeaseMs');
    const after = wakeOf(readHandleOf(run.memory), wakeId);
    assert.equal(after?.state, 'handled');
    assert.equal(after?.outcome, 'skip');
  } finally {
    await run.close();
  }
});

test('no transaction is open on the writer while the turn asks the model', async () => {
  const run = await core();
  try {
    const { wakeId } = dueIntention(run, T - MINUTE);
    const during: Array<{ open: unknown; state: unknown }> = [];
    run.turns.answer = () => {
      during.push({ open: inTransaction(run.memory), state: wakeOf(readHandleOf(run.memory), wakeId)?.state });
      return skipped();
    };
    await run.life.tick();
    assert.deepEqual(during, [{ open: false, state: 'running' }], 'the claim is committed and the writer is idle');
  } finally {
    await run.close();
  }
});

test('a wake cut off by a restart runs again after its lease expired, under the turn id of its first run', async () => {
  const run = await core();
  try {
    dueIntention(run, T - MINUTE);
    let started: () => void = () => {};
    const asked = new Promise<void>((resolve) => (started = resolve));
    // The first process dies inside the model call: its turn never answers.
    run.turns.answer = () => {
      started();
      return new Promise<unknown>(() => {});
    };
    void run.life.tick();
    await asked;
    await run.restart();
    run.clock.t = T + 10 * MINUTE;
    run.turns.answer = skipped;
    await run.life.tick();
    const ids = run.turns.calls.map((call) => call.journalTurn.turnId);
    assert.equal(ids.length, 2, 'the cut-off wake runs once more');
    assert.equal(ids[1], ids[0], 'the same turn id, so the same effect keys');
  } finally {
    await run.close();
  }
});

test('a wake that fell due while the core was down sleeps and never runs, and one due before the downtime runs', async () => {
  const run = await core();
  try {
    const before = dueIntention(run, T - MINUTE);
    const during = dueIntention(run, T + 30 * MINUTE);
    // The attention is held at the last tick before the downtime: the earlier wake waits in the queue.
    run.turns.busy = true;
    await run.life.tick();
    run.turns.busy = false;
    await run.restart();
    run.clock.t = T + 2 * HOUR;
    await run.life.tick();
    run.clock.t += MINUTE;
    await run.life.tick();
    assert.deepEqual(
      run.turns.calls.map((call) => call.inner.wake.items.flatMap((item) => item.intentionIds)),
      [[before.id]]
    );
    const slept = wakeOf(readHandleOf(run.memory), during.wakeId);
    assert.equal(slept?.state, 'slept');
    assert.equal(slept?.handledAt, T + 2 * HOUR);
    assert.equal(run.life.status(GUILD).slept, 1, 'the status counts the slept wake since the start');
  } finally {
    await run.close();
  }
});

test('a wake that fell due during a pause sleeps at the resume and never runs', async () => {
  const run = await core();
  try {
    const { wakeId } = dueIntention(run, T + 20 * MINUTE);
    await run.life.tick();
    run.flags.paused = true;
    run.flags.pausedAt = new Date(T + MINUTE).toISOString();
    run.clock.t = T + 10 * MINUTE;
    await run.life.tick();
    run.clock.t = T + 40 * MINUTE;
    delete run.flags.paused;
    delete run.flags.pausedAt;
    await run.life.tick();
    run.clock.t += MINUTE;
    await run.life.tick();
    assert.equal(run.turns.calls.length, 0);
    assert.equal(wakeOf(readHandleOf(run.memory), wakeId)?.state, 'slept');
    assert.equal(run.life.status(GUILD).slept, 1);
  } finally {
    await run.close();
  }
});

test('her calls on an intention whose wake slept answer slept, and the record keeps when it slept', async () => {
  const run = await core();
  try {
    const { id } = dueIntention(run, T + 20 * MINUTE);
    await run.life.tick();
    run.flags.paused = true;
    run.flags.pausedAt = new Date(T + MINUTE).toISOString();
    run.clock.t = T + 10 * MINUTE;
    await run.life.tick();
    run.clock.t = T + 40 * MINUTE;
    delete run.flags.paused;
    delete run.flags.pausedAt;
    await run.life.tick();
    const record = run.service.store(GUILD)?.get(id);
    assert.equal(record?.status, 'cancelled', 'a cancel, never a deletion');
    assert.equal(record?.sleptAt, T + 40 * MINUTE);
    assert.equal(run.service.update(GUILD, id, { state: 'done' }).code, 'slept');
    assert.equal(run.service.cancel(GUILD, id).code, 'slept');
  } finally {
    await run.close();
  }
});

test('a recurring intention whose occurrence fell due during the downtime loses that occurrence, and the next one runs', async () => {
  const run = await core();
  try {
    const first = T + 30 * MINUTE;
    const made = run.service.set(GUILD, {
      purpose: 'say good morning',
      dueAt: first,
      every: { period: 'day', at: null },
      channelId: 'c1',
      scope: 'group',
    });
    if (!made.ok) throw new Error(`intention not set: ${made.code}`);
    const { id } = made.intention;
    await run.life.tick();
    await run.restart();
    run.clock.t = T + 2 * HOUR;
    await run.life.tick();
    assert.equal(run.turns.calls.length, 0, 'the occurrence of the downtime never runs');
    assert.equal(wakeOf(readHandleOf(run.memory), `inner.wake:intention_due:${id}:${first}`)?.state, 'slept');
    const record = run.service.store(GUILD)?.get(id);
    assert.equal(record?.status, 'pending', 'the intention goes on');
    assert.equal(record?.dueAt, first + DAY);
    assert.equal(record?.history.at(-1)?.code, 'slept');
    run.clock.t = T + DAY;
    await run.life.tick();
    run.clock.t = first + DAY + MINUTE;
    await run.life.tick();
    assert.deepEqual(
      run.turns.calls.map((call) => call.inner.wake.items.flatMap((item) => item.intentionIds)),
      [[id]],
      'the next occurrence runs as usual'
    );
  } finally {
    await run.close();
  }
});
