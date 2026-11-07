// The inner life over the wake queue in the memory database (spec 2026-10-27-stage-4-cut, PR B, and the owner's answer
// of 2026-10-27 on sleep). The drain claims a wake in the database before the turn asks the model, and completes it
// after: no transaction is open while the model is asked. A wake cut off by a restart runs again under the turn id of
// its first run, so its effect keys stay the same. A wake that falls due while the core is down or paused sleeps: it
// becomes `slept` and never runs, the status counts it, and the one-off intention it was for is cancelled with a
// `sleptAt` mark, so her calls on it answer `slept`. A recurring intention loses only the occurrence that slept: its
// history records `slept`, and the next occurrence comes due and runs. A real memory database on the calling thread, a real intention
// service and event door, a fake turn runner standing in for the model call; the clock injected as `now`.
import { legacyServerPlaceId } from '../src/memory/migration/paths.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createInnerLife, emptyState } from '../src/behavior/inner.ts';
import type { InnerJournal, InnerTurnParams } from '../src/behavior/inner/types.ts';
import { createEventDoor } from '../src/interface/door.ts';
import { createIntentionService } from '../src/intentions/service.ts';
import { createIntentionStores } from '../src/intentions/store.ts';
import { personaKey } from '../src/memory/db/storage-keys.ts';
import { communityKey } from './fixtures/memory-db/legacy-keys.ts';
import {} from '../src/memory/db/ids.ts';
import { unitValue } from '../src/memory/db/readers/common.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { applyUnitWrite } from '../src/memory/db/unit-write.ts';
import { leaseOf, wakeOf } from '../src/memory/db/wake-queue.ts';
import { openTestMemory } from './fixtures/memory-db/service.ts';
import { tempDir } from './fixtures/tmp.ts';
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
      features: { wakes: true, intentions: true, journal: false },
      mention: { oneAtATime: true },
      wakes: {
        mode: 'shadow',
        tickSeconds: 60,
        queueMax: 20,
        chatMessages: 30,
        review: { enabled: false, historyDays: 14 },
        caps: { perChain: 3 },
      },
      heartbeat: { enabled: false, dueJitterMinutes: 0 },
      // Proposed for spec 2026-11-02 "`selfimprovement` daily, after the watcher": the daily selfimprovement wake is off here too,
      // or it runs at 03:00 of each day this rig crosses and is counted among the turns.
      selfimprovement: { enabled: false },
    },
  };
}

/**
 * One core over a data directory: a memory database opened there, an inner life with its door, and what the core
 * keeps across a restart (the clock, the intentions, the store's pause flags). `restart()` closes the database and
 * opens a new one and a new inner life over the same directory, as a new process would.
 */
async function core(dataDir = tempDir('nep-inner-wakes-'), journal: InnerJournal | null = null) {
  world().channel({ id: 'c1', name: 'chan-c1', placeId: GUILD, permissions: { send: true } });
  const clock = { t: T };
  const hot = hotOf();
  const flags: PauseFlags = {};
  const store = { state: { data: flags } };
  const service = createIntentionService({
    stores: createIntentionStores({ now: () => clock.t, log: SILENT }),
    hot,
    now: () => clock.t,
    log: SILENT,
  });
  const turns = { busy: false, calls: [] as Array<InnerTurnParams>, answer: skipped as Answer };
  const open = async () => {
    const memory = await openTestMemory({
      dataDir,
      iface: () => 'fake',
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
      meter: { run: async (fn: () => unknown) => ({ result: await fn(), usd: 0, requests: 1, voice: 0 }) },
      memoryDb: memory.memoryDb,
      journal,
      rng: () => 0.5,
      now: () => clock.t,
      log: SILENT,
    });
    return { memory, life };
  };
  let current = await open();
  return {
    dataDir,
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
  const made = run.service.set({ purpose: 'ask how the trip went', dueAt, placeId: 'c1', scope: 'group' });
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

test('a wake cut off by a restart is interrupted without another model call', async () => {
  const run = await core();
  try {
    const { wakeId } = dueIntention(run, T - MINUTE);
    const unfinished = structuredClone(run.service.list({ all: true }));
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
    // Restart retains evidence but never authorizes replay of an unfinished action.
    assert.equal(ids.length, 1, 'the cut-off wake never asks the model again');
    const kept = wakeOf(readHandleOf(run.memory), wakeId);
    assert.equal(kept?.state, 'handled');
    assert.equal(kept?.outcome, 'interrupted');
    assert.equal(kept?.turnId, ids[0], 'the original turn identity remains evidence');
    assert.deepEqual(run.service.list({ all: true }), unfinished, 'restart retains unfinished work exactly');
  } finally {
    await run.close();
  }
});

test('the turn mark of a running wake records the interface of its conversation', async () => {
  // Catches: a restart cannot tell on which interface a DM turn ran, so it looks in the wrong DM place.
  const run = await core();
  try {
    const { wakeId } = dueIntention(run, T - MINUTE);
    let marked: unknown = null;
    run.turns.answer = () => {
      marked = wakeOf(readHandleOf(run.memory), wakeId)?.turn?.iface;
      return skipped();
    };
    await run.life.tick();
    assert.equal(marked, 'fake');
  } finally {
    await run.close();
  }
});

test('the recovery of a cut-off turn asks the journal for the operations under the interface of that turn', async () => {
  // Catches: the interface is recorded in the mark and never handed to the journal lookup of the restart.
  const asked: Array<unknown> = [];
  const journal: InnerJournal = {
    turnOperations: (query) => {
      asked.push(query);
      return [];
    },
  };
  const dir = tempDir('nep-inner-wakes-');
  const run = await core(dir, journal);
  try {
    dueIntention(run, T - MINUTE);
    let started: () => void = () => {};
    const inTurn = new Promise<void>((resolve) => (started = resolve));
    run.turns.answer = () => {
      started();
      return new Promise<unknown>(() => {});
    };
    void run.life.tick();
    await inTurn;
    await run.restart();
    run.clock.t = T + 10 * MINUTE;
    await run.life.tick();
    assert.equal(asked.length, 1);
    assert.equal(Reflect.get(asked[0] as object, 'iface'), 'fake');
  } finally {
    await run.close();
  }
});

test('restart abandons an already queued wake while a wake due during downtime sleeps', async () => {
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
    // Queued actions need a fresh model decision after restart, just like interrupted running actions.
    assert.deepEqual(run.turns.calls, []);
    const abandoned = wakeOf(readHandleOf(run.memory), before.wakeId);
    assert.equal(abandoned?.state, 'handled');
    assert.equal(abandoned?.outcome, 'interrupted');
    const slept = wakeOf(readHandleOf(run.memory), during.wakeId);
    assert.equal(slept?.state, 'slept');
    assert.equal(slept?.handledAt, T + 2 * HOUR);
    assert.equal(run.life.status().slept, 1, 'the status counts the slept wake since the start');
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
    assert.equal(run.life.status().slept, 1);
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
    const record = run.service.store()?.get(id);
    assert.equal(record?.status, 'cancelled', 'a cancel, never a deletion');
    assert.equal(record?.sleptAt, T + 40 * MINUTE);
    assert.equal(run.service.update(id, { state: 'done' }).code, 'slept');
    assert.equal(run.service.cancel(id).code, 'slept');
  } finally {
    await run.close();
  }
});

test('a recurring intention whose occurrence fell due during the downtime loses that occurrence, and the next one runs', async () => {
  const run = await core();
  try {
    const first = T + 30 * MINUTE;
    const made = run.service.set({
      purpose: 'say good morning',
      dueAt: first,
      every: { period: 'day', at: null },
      placeId: 'c1',
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
    const record = run.service.store()?.get(id);
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

test('inner stop state saved through the writer survives reopening without inner.json', async () => {
  const run = await core();
  const file = path.join(run.dataDir, 'guilds', GUILD, 'inner.json');
  try {
    run.life.stop({ by: 'owner' });
    await run.life.release();
    assert.equal(fs.existsSync(file), false);
    await run.restart();
    assert.equal(run.life.status().stopped, true);
    assert.equal(fs.existsSync(file), false);
  } finally {
    await run.close();
  }
});

// Separate community caches must not overwrite the persona's clocks or another conversation's evidence.
// Slice 5: the daily review is deleted, so the legacy states keep their `review` fields as stored data and the merged
// life holds no review or review views; the rest of the consolidation is unchanged.
test('legacy inner states consolidate into one persistent life with scoped facts', async () => {
  const dataDir = tempDir('nep-global-inner-');
  const firstKey = communityKey('inner', GUILD, { iface: 'fake' });
  const secondKey = communityKey('inner', 'g2', { iface: 'fake' });
  const first = {
    ...emptyState(),
    stopped: true,
    stoppedAt: T - MINUTE,
    stoppedBy: 'owner',
    heartbeat: { lastAt: T - 3 * MINUTE, nextAt: T + 5 * MINUTE },
    selfimprovement: { lastAt: T - MINUTE, raisedAt: T - 4 * MINUTE },
    review: { day: '2026-10-31', at: T + MINUTE, done: true, channels: ['c1'], lines: 2 },
    facts: [{ id: 'f1', kind: 'turnFailed', placeId: 'c1', privateChat: false, at: T - MINUTE, told: false as const }],
    turns: [{ at: T - MINUTE, chainId: 'one', usd: 1, outcome: 'skip', kinds: ['review'] }],
    spend: [{ at: T - MINUTE, usd: 1 }],
    turnIds: ['turn-one'],
  };
  const second = {
    ...emptyState(),
    heartbeat: { lastAt: T - 2 * MINUTE, nextAt: T + 3 * MINUTE },
    selfimprovement: { lastAt: T - 2 * MINUTE, raisedAt: T - 3 * MINUTE },
    review: { day: '2026-10-31', at: T + 2 * MINUTE, done: false, channels: ['c2'], lines: 3 },
    facts: [{ id: 'f2', kind: 'turnFailed', placeId: 'c2', privateChat: false, at: T, told: false as const }],
    turns: [{ at: T, chainId: 'two', usd: 2, outcome: 'skip', kinds: ['review'] }],
    spend: [{ at: T, usd: 2 }],
    turnIds: ['turn-two'],
  };
  // Legacy units precede the first service open. An existing persona state always wins subsequent opens.
  const legacy = openMemoryDb(path.join(dataDir, 'memory.db'));
  try {
    applyUnitWrite(legacy, { op: 'value', key: firstKey, value: first });
    applyUnitWrite(legacy, { op: 'value', key: secondKey, value: second });
  } finally {
    legacy.close();
  }
  const run = await core(dataDir);
  try {
    const state = run.life.state();
    assert.equal(run.life.state().stopped, true, 'the stop applies across community contexts');
    assert.deepEqual(run.life.state().heartbeat, { lastAt: T - 2 * MINUTE, nextAt: T + 5 * MINUTE });
    assert.deepEqual(state.heartbeat, { lastAt: T - 2 * MINUTE, nextAt: T + 5 * MINUTE });
    assert.deepEqual(state.selfimprovement, { lastAt: T - MINUTE, raisedAt: T - 3 * MINUTE });
    assert.equal(state.stopped, true);
    assert.equal(state.stoppedBy, 'owner');
    assert.deepEqual(state.turnIds.toSorted(), ['turn-one', 'turn-two']);
    assert.deepEqual(
      state.turns.map((turn): [string, unknown] => [turn.chainId, Reflect.get(turn, 'scopePlaceId')]).toSorted(),
      [
        ['one', legacyServerPlaceId('fake', GUILD)],
        ['two', legacyServerPlaceId('fake', 'g2')],
      ]
    );
    assert.deepEqual(
      state.spend.map(({ at, usd }) => ({ at, usd })),
      [...first.spend, ...second.spend]
    );
    assert.deepEqual(
      run.life.facts.pending({ placeId: 'c1' }).map((fact) => fact.id),
      ['f1']
    );
    assert.deepEqual(
      run.life.facts.pending({ placeId: 'c2' }).map((fact) => fact.id),
      ['f2']
    );
    run.life.facts.add({ kind: 'turnFailed', placeId: 'c2', text: 'retained after reopen' });
    await run.life.release();
    const handle = run.memory.memoryDb.readHandle();
    assert.ok(handle);
    const db = dbOf(handle);
    assert.deepEqual(unitValue(db, firstKey), { found: true, value: first });
    assert.deepEqual(unitValue(db, secondKey), { found: true, value: second });
    const persisted = unitValue(db, personaKey('inner'));
    assert.equal(persisted.found, true);
    await run.memory.memoryDb.writeUnit({ op: 'value', key: firstKey, value: { ...first, stopped: false } });
    await run.restart();
    assert.equal(run.life.state().stopped, true, 'historical source units never overwrite existing persona state');
    const reopened = run.memory.memoryDb.readHandle();
    assert.ok(reopened);
    assert.deepEqual(unitValue(dbOf(reopened), personaKey('inner')), persisted);
    assert.deepEqual(
      run.life.facts.pending({ placeId: 'c2' }).map((fact) => fact.text ?? fact.id),
      ['f2', 'retained after reopen']
    );
  } finally {
    await run.close();
  }
});
