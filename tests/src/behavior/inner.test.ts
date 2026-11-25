// The inner life (src/behavior/inner.ts): its ticks, its wakes and the turns it starts with no interface, over the fake
// interface, temporary data folders and a scripted turn runner.
import { describe, test, after, before } from 'node:test';
import assert from 'node:assert/strict';
import { innerRig } from '../../fixtures/boundary.ts';
import { createInnerLife, wakeOfDue } from '../../../src/behavior/inner.ts';
import type { InnerLifeOptions } from '../../../src/behavior/inner.ts';
import { createEventDoor } from '../../../src/interface/door.ts';
import { createIntentionService } from '../../../src/intentions/service.ts';
import { createIntentionStores } from '../../../src/intentions/store.ts';
import { tempDir } from '../../fixtures/tmp.ts';
import { useIface, world } from '../../fixtures/turn-world.ts';
import fs from 'node:fs';
import path from 'node:path';
import type { InnerJournal, InnerTurnParams } from '../../../src/behavior/inner/types.ts';
import { openTestMemory } from '../../fixtures/memory-db/service.ts';
import { openMemoryDb } from '../../../src/memory/db/open.ts';
import { dbOf } from '../../../src/memory/db/types.ts';
import type { Db, Row } from '../../../src/memory/db/types.ts';
import { MINUTE_MS } from '../../../src/time.ts';
import {
  ROOT as INNER_ROOT,
  NOW,
  clock,
  fakeTurns,
  hotWith,
  intention,
  setup as innerSetup,
  wakeMemory,
} from '../../fixtures/inner-rig.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import { wrongly, present } from '../../fixtures/loose-types.ts';
import { applyMemoryWrite } from '../../../src/memory/db/session-write.ts';
import { applyUnitUpdate } from '../../fixtures/memory-db/unit-writes.ts';
import { WAKE_POLICY_VERSION } from '../../../src/tools/access.ts';

/** The rigs and services a test opened; closed when the file is done. */
const OPEN: Array<{ close(): unknown }> = [];

after(async () => {
  for (const item of OPEN) await item.close();
});

async function rig(options?: Parameters<typeof innerRig>[0]) {
  const opened = await innerRig(options);
  OPEN.push(opened.memory);
  return opened;
}

describe('inner turns with no interface', () => {
  test('a heartbeat turn runs to the end on the fake interface and its run is in memory', async () => {
    const core = await rig();
    await core.beat();
    await core.settle();
    const calls = core.llm.calls;
    assert.equal(calls.length, 1, 'one model request, one turn');
    const runs = core.wakeRuns();
    assert.deepEqual(
      runs.map((run) => `${run.kind}:${run.status}:${run.outcome}`),
      ['heartbeat:succeeded:skip']
    );
  });

  // Stage 3, item "The inner life and the diary": with no interface to describe a chat, the heartbeat runs its
  // turn with no chat, in the served root, the way the diary wake does.
  test('a heartbeat turn runs to the end with no interface connected and its run is in memory', async () => {
    const core = await rig({ interface: false });
    await core.beat();
    await core.settle();
    const calls = core.llm.calls;
    assert.equal(calls.length, 1);
    assert.deepEqual(
      core.wakeRuns().map((run) => `${run.kind}:${run.status}`),
      ['heartbeat:succeeded']
    );
  });
});

useIface('fake');

const ROOT = 'g1';

const MINUTE = 60_000;

const START = Date.parse('2026-10-26T12:00:00Z');

const ERRAND = 't0000000a';

const SILENT = { info() {}, warn() {}, error() {} };

type TurnParams = {
  chat?: { chatId: string } | null;
  inner: { wake: { kind: string; items: Array<Record<string, unknown>> }; currentChannel?: string | null };
};

function setup() {
  const clock = { t: START };
  world().channel({ id: 'c1', name: 'chan-c1', placeId: ROOT, permissions: { send: true } });
  const hot = {
    config: {
      bot: { timezone: 'UTC' },
      features: { wakes: true, intentions: true, journal: true },
      mention: { oneAtATime: true },
      wakes: {
        mode: 'shadow',
        tickSeconds: 60,
        queueMax: 20,
        chatMessages: 30,
        review: { enabled: false, historyDays: 14 },
        caps: { perChain: 3 },
      },
      heartbeat: { enabled: false },
    },
  };
  // The errand is running for the whole test: the store of the errand service has it open.
  const errands = { store: () => ({ get: (id: string) => (id === ERRAND ? { id, state: 'running' } : null) }) };
  const service = createIntentionService({
    stores: createIntentionStores({ dataDir: tempDir('nep-deadline-'), now: () => clock.t, log: SILENT }),
    hot,
    errands,
    now: () => clock.t,
    log: SILENT,
  });
  const calls: Array<TurnParams> = [];
  const turns = {
    calls,
    isAnyBusy: () => false,
    runTurn: (params: TurnParams) => {
      calls.push(params);
      return Promise.resolve({ outcome: 'skip', reason: 'nothing-to-do', inner: { actions: [], turnId: 't-1' } });
    },
  };
  const journal: Array<Record<string, unknown>> = [];
  let inner: ReturnType<typeof createInnerLife> | null = null;
  const door = createEventDoor({
    handlers: { 'inner.wake': (event: object) => inner?.onWake(event) },
    log: SILENT,
  });
  inner = createInnerLife({
    hot,
    dataDir: tempDir('nep-deadline-inner-'),
    turns,
    intentions: service,
    journal: { inner: (fields: Record<string, unknown>) => Promise.resolve(journal.push(fields)) },
    reads: world().reads,
    iface: () => 'fake',
    chatName: (id: string) => `chan-${id}`,
    submit: (event: object) => door.submit(event),
    store: { state: { data: {} } },
    meter: { run: async (fn: () => unknown) => ({ result: await fn(), usd: 0, requests: 1, voice: 0 }) },
    rng: () => 0.5,
    now: () => clock.t,
    log: SILENT,
  });
  return { clock, service, inner, calls, journal };
}

/** An intention waiting on the running errand with no due time, its deadline ten minutes ahead. */
function waitingIntention(service: ReturnType<typeof setup>['service']): string {
  const made = service.set({
    purpose: 'tell what the errand found',
    dueAt: null,
    placeId: 'c1',
    errandId: ERRAND,
    deadline: START + 10 * MINUTE,
  }) as { ok: boolean; intention: { id: string } };
  assert.equal(made.ok, true);
  return made.intention.id;
}

test('a wait past its deadline wakes the persona once as errand_deadline, never as intention_due, and the same tick again is a duplicate', async () => {
  const run = setup();
  const id = waitingIntention(run.service);
  run.clock.t = START + 11 * MINUTE;
  const first = await run.inner.tick();
  assert.equal(first.submitted, 1);
  assert.deepEqual(
    run.calls.map(({ inner: { wake } }) => wake.items.map((item) => item.kind)),
    [['errand_deadline']]
  );
  const second = await run.inner.tick();
  assert.equal(second.submitted, 0);
  assert.equal(run.calls.length, 1, 'one deadline, one wake');
  const turn = run.journal.find((entry) => entry.event === 'turn');
  assert.deepEqual(turn?.coalesced, [`inner.wake:errand_deadline:${id}:${ERRAND}`]);
});

test('the wake item names the errand as errandId and the intention channel is the current one, for the errand', async () => {
  const run = setup();
  waitingIntention(run.service);
  run.clock.t = START + 11 * MINUTE;
  await run.inner.tick();
  const call = run.calls[0];
  const wake = call?.inner.wake;
  const item = wake?.items[0];
  assert.equal(item?.errandId, ERRAND);
  assert.equal(Object.hasOwn(wake?.items[0] ?? {}, 'taskId'), false);
  // Slice 5: the wake's `here` line left with `<wake>`; the intention's channel is the turn's chat and current
  // channel.
  const [turn] = run.calls;
  assert.equal(turn?.inner.currentChannel, 'c1');
  assert.equal(turn?.chat?.chatId, 'c1');
});

useIface('fake');

const T = Date.parse('2026-10-31T12:00:00Z');

const LEASE_MS = MINUTE;

const INNER_WAKES_SILENT = { info() {}, warn() {}, error() {}, debug() {} };

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
    },
  };
}

/**
 * One core over a data directory: a memory database opened there, an inner life with its door, and what the core
 * keeps across a restart (the clock, the intentions, the store's pause flags). `restart()` closes the database and
 * opens a new one and a new inner life over the same directory, as a new process would.
 */
async function core(dataDir = tempDir('nep-inner-wakes-'), journal: InnerJournal | null = null) {
  world().channel({ id: 'c1', name: 'chan-c1', placeId: ROOT, permissions: { send: true } });
  const clock = { t: T };
  const hot = hotOf();
  const flags: PauseFlags = {};
  const store = { state: { data: flags } };
  const service = createIntentionService({
    stores: createIntentionStores({ now: () => clock.t, log: INNER_WAKES_SILENT }),
    hot,
    now: () => clock.t,
    log: INNER_WAKES_SILENT,
  });
  const turns = { busy: false, calls: [] as Array<InnerTurnParams>, answer: skipped as Answer };
  // One stream of ids across restarts, as each process draws its own.
  let ids = 0;
  const open = async () => {
    const memory = await openTestMemory({
      dataDir,
      iface: () => 'fake',
      config: { context: { turnLeaseMs: LEASE_MS } },
      now: () => clock.t,
    });
    let life: ReturnType<typeof createInnerLife> | null = null;
    const door = createEventDoor({
      handlers: { 'inner.wake': (event: object) => life?.onWake(event) },
      log: INNER_WAKES_SILENT,
    });
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
      chatName: (id: string) => `chan-${id}`,
      submit: (event: object) => door.submit(event),
      store,
      meter: { run: async (fn: () => unknown) => ({ result: await fn(), usd: 0, requests: 1, voice: 0 }) },
      memoryDb: memory.memoryDb,
      journal,
      rng: () => 0.5,
      uuid: () => `u${(ids += 1)}`,
      now: () => clock.t,
      log: INNER_WAKES_SILENT,
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

test('inner stop state saved through the writer survives reopening without inner.json', async () => {
  const run = await core();
  const file = path.join(run.dataDir, 'guilds', ROOT, 'inner.json');
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

useIface('fake');

const settle = () => new Promise((resolve) => setImmediate(resolve));

test.beforeEach(() => void (clock.t = NOW));

test('inner: a due intention is one wake through the door and one inner turn; the next tick does not wake the persona again', async () => {
  const run = innerSetup({ records: [intention('i1')] });
  const first = await run.inner.tick();
  assert.equal(first.submitted, 1);
  const calls = run.turns.calls;
  assert.equal(calls.length, 1);
  const params = calls[0];
  assert.equal(params.mode, 'inner');
  assert.equal(wrongly<Record<string, unknown>>(params).trigger, undefined, 'no fabricated message');
  assert.equal(present(params.chat).chatId, 'c1');
  assert.equal(params.inner.shadow, true);
  const wake = params.inner.wake;
  assert.equal(wake.kind, 'intention_due');
  assert.deepEqual(
    wake.items.map((item) => item.kind),
    ['intention_due']
  );
  assert.deepEqual(
    wake.intentions.map((r) => r.id),
    ['i1']
  );
  // Stage AD: the wake carries no budgets any more.
  assert.equal(wrongly<Record<string, unknown>>(params.inner.wake).budgets, undefined);
  const second = await run.inner.tick();
  assert.equal(second.submitted, 0);
  const calls2 = run.turns.calls;
  assert.equal(calls2.length, 1, 'the same due time wakes the persona once');
  // A new due time is a new wake.
  const records = run.intentions.records;
  records[0].dueAt = NOW;
  clock.t = NOW + MINUTE_MS;
  await run.inner.tick();
  const calls3 = run.turns.calls;
  assert.equal(calls3.length, 2);
});

test('inner: a state file that cannot be read is moved aside, journalled and told as a stateLost fact, never a silent empty start', async () => {
  const dataDir = tempDir('nep-inner-lost-');
  const dir = path.join(dataDir, 'persona');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'inner.json'), '{"queue": [');
  const run = innerSetup({ dataDir });
  const state = run.inner.state();
  assert.deepEqual(state.queue, [], 'the queue starts empty');
  const aside = fs.readdirSync(dir).filter((name) => name.startsWith('inner.json.bad-'));
  assert.equal(aside.length, 1, 'the old file is kept');
  assert.equal(fs.readFileSync(path.join(dir, aside[0]), 'utf8'), '{"queue": [');
  assert.deepEqual(
    JSON.parse(fs.readFileSync(path.join(dir, 'inner.json'), 'utf8')).facts.map((fact: Record<string, Untyped>) => [
      fact.kind,
      fact.code,
      fact.told,
    ]),
    [['stateLost', 'parse', false]]
  );
  await settle();
  assert.deepEqual(
    run.journal.filter((fields) => fields.event === 'stateLost').map((fields) => [fields.code, fields.kept]),
    [['parse', true]]
  );
  // Told once at the persona's next turn, in a server channel or in a wake, and not in a private chat.
  const facts = run.inner.facts;
  assert.deepEqual(
    facts.pending({ placeId: 'c1', dmChat: false }).map((fact) => fact.kind),
    ['stateLost']
  );
  assert.deepEqual(facts.pending({ placeId: 'd1', dmChat: true }), []);
  // A missing file is a first start, not a loss.
  const fresh = innerSetup({ dataDir: tempDir('nep-inner-fresh-') });
  assert.deepEqual(fresh.inner.state().facts ?? [], []);
});

test('inner: the turn in flight is on disk while the turn runs and gone once it ended; a turn held (busy) leaves no mark', async () => {
  const dataDir = tempDir('nep-inner-flight-');
  // The in-flight mark is the running wake in the memory database (stage 4 cut, the lead's decision 1).
  const db = wakeMemory(dataDir, () => clock.t);
  let during: Record<string, Untyped> = wrongly(null);
  const turns = fakeTurns({
    answer: (params: Record<string, Untyped>) => {
      during = { running: db.wakes('running'), journalTurn: params.journalTurn };
      return { outcome: 'skip', reason: 'nothing-to-do', inner: { actions: [], turnId: 't-1' } };
    },
  });
  const run = innerSetup({ records: [intention('i1')], turns, dataDir, memoryDb: db.memoryDb });
  await run.inner.tick();
  const firstRunning = present(during).running[0];
  assert.deepEqual(
    [
      present(during).running.length,
      present(during).running[0].kind,
      firstRunning.payload.placeId,
      present(during).running[0].turnId === present(during).journalTurn.turnId,
      present(during).journalTurn.attemptId,
    ],
    [1, 'intention_due', 'c1', true, 1]
  );
  assert.equal(present(db.wake(present(during).running[0].id)).state, 'handled', 'gone once it ended');
  const held = innerSetup({
    records: [intention('i2')],
    turns: fakeTurns({ answer: () => ({ outcome: 'busy' }) }),
    dataDir: tempDir('nep-inner-flight-'),
  });
  await held.inner.tick();
  assert.equal(held.inner.state().inflight, null);
  assert.equal(held.inner.state().queue.length, 1, 'the wake waits');
});

test('inner: an unfinished mark with the journal off is interrupted without replay', async () => {
  const dataDir = tempDir('nep-inner-flight-');
  const records = [intention('i1')];
  const wake = wakeOfDue({ intention: records[0], reason: 'due', at: present(records[0].dueAt) });
  // The turn a restart cut off: its wake is running under a lease that expired when it started, so the recovery of
  // the next start resolves it.
  const seeding = openMemoryDb(path.join(dataDir, 'memory.db'));
  dbOf(seeding)
    .prepare(
      `INSERT INTO wakes (id, kind, community, due_at, queued_at, payload, state, lease_holder, lease_token,
        lease_expires_at, turn_id, attempt, claimed_at, turn)
       VALUES (?, ?, ?, ?, ?, ?, 'running', 'restart', 0, ?, 't-gone', 1, ?, ?)`
    )
    .run(
      wake.id,
      wake.kind,
      INNER_ROOT,
      wake.dueAt ?? null,
      wake.queuedAt ?? NOW,
      JSON.stringify(wake),
      NOW - MINUTE_MS,
      NOW - MINUTE_MS,
      JSON.stringify({ kind: 'intention_due', placeId: 'c1', dmChat: false, privateAccountId: null })
    );
  seeding.close();
  const db = wakeMemory(dataDir, () => clock.t);
  const run = innerSetup({ records, dataDir, hot: hotWith(), memoryDb: db.memoryDb });
  await run.inner.tick();
  // An unavailable journal cannot authorize replay of the unfinished action.
  const calls = run.turns.calls;
  assert.equal(calls.length, 0);
  assert.equal(run.inner.state().handled[wake.id]?.outcome, 'interrupted');
  assert.equal(run.inner.state().inflight, null);
  assert.deepEqual(
    run.inner.state().facts.filter((fact) => fact.kind === 'interrupted'),
    []
  );
});

/** The stored run and its actions (in order), or null. */
function wakeRunOf(
  db: Db,
  id: unknown
): (Row & { actions: Array<Row & { n: number; kind: string; status: string }> }) | null {
  const run = db.prepare('SELECT * FROM wake_runs WHERE id = ?').get(id);
  if (!run) return null;
  return {
    ...run,
    actions: db
      .prepare('SELECT * FROM wake_actions WHERE run_id = ? ORDER BY n')
      .all(id)
      .map((row) => ({ ...row }) as Row & { n: number; kind: string; status: string }),
  };
}

// The chat the persona wakes in is held by a fake interface named `fake`.
useIface('fake');

const MEMORY_DB_WAKES_NOW = Date.parse('2026-10-24T12:00:00.000Z');

const MEMORY_DB_WAKES_SILENT = { info() {}, warn() {}, error() {}, debug() {} };

const count = (db: Db, sql: string, ...params: Array<unknown>) => db.prepare(sql).get(...params)!.n;

// ---------- the inner life records its runs ----------

type memoryDbWakesTurnParams = { journalTurn: { turnId: string } };

function innerHarness({
  wakeRuns,
  actions = [],
  outcome = 'spoke',
}: {
  wakeRuns?: boolean;
  actions?: Array<Record<string, unknown>>;
  outcome?: string;
}) {
  const handle = openMemoryDb(':memory:');
  const writes: Array<{ op?: string }> = [];
  const memoryDb = {
    readHandle: () => handle,
    writeUnit: (update: Parameters<typeof applyUnitUpdate>[1]) => Promise.resolve(applyUnitUpdate(handle, update)),
    writeOperational: (write: Record<string, unknown>) =>
      Promise.resolve(applyMemoryWrite(handle, { ...write, kind: 'operational' })),
    recordWake: async (update: { op?: string }) => {
      writes.push(update);
      return applyMemoryWrite(handle, update);
    },
  };
  const records = [
    {
      id: 'i1',
      status: 'pending',
      purpose: 'say hello',
      dueAt: MEMORY_DB_WAKES_NOW - MINUTE,
      chainId: null,
      destination: null,
      provenance: { kind: 'self', placeId: 'c1', scope: 'group' },
      createdAt: MEMORY_DB_WAKES_NOW - 86_400_000,
      updatedAt: MEMORY_DB_WAKES_NOW - 3600_000,
      expiresAt: MEMORY_DB_WAKES_NOW + 7 * 86_400_000,
    },
  ];
  const intentions = {
    due: () => records.filter((r) => r.status === 'pending').map((r) => ({ intention: r, reason: 'due', at: r.dueAt })),
    reconcile: () => ({ arrived: 0, missing: 0, deadline: 0, expired: 0 }),
    list: () => records,
    store: () => ({ get: (id: string) => records.find((r) => r.id === id) ?? null, list: () => records }),
    // The records carry only the fields the wake reads, so the fake stands in for the intention service by a cast.
  } as unknown as NonNullable<InnerLifeOptions['intentions']>;
  const calls: Array<memoryDbWakesTurnParams> = [];
  const turns = {
    isAnyBusy: () => false,
    runTurn: async (params: memoryDbWakesTurnParams) => {
      calls.push(params);
      return { outcome, inner: { actions, turnId: 'turn-x' } };
    },
  };
  world().channel({ id: 'c1', name: 'general', placeId: 'g1' });
  const hot = {
    config: {
      bot: { timezone: 'UTC' },
      features: { wakes: true, intentions: true, journal: false },
      mention: { oneAtATime: true },
      memoryDb: { wakeRuns },
      wakes: {
        mode: 'shadow',
        tickSeconds: 60,
        queueMax: 20,
        chatMessages: 30,
        review: { enabled: false, historyDays: 14 },
        caps: { perChain: 3 },
      },
      heartbeat: { enabled: false },
    },
  };
  let inner: ReturnType<typeof createInnerLife>;
  const door = createEventDoor({
    handlers: { 'inner.wake': (event) => inner.onWake(event) },
    log: MEMORY_DB_WAKES_SILENT,
  });
  let n = 0;
  inner = createInnerLife({
    hot,
    dataDir: tempDir('nep-wakes-'),
    turns,
    intentions,
    reads: world().reads,
    iface: () => 'fake',
    submit: (event) => door.submit(event),
    store: { state: { data: {} } },
    meter: { run: async (fn) => ({ result: await fn(), usd: 0, requests: 1, voice: 0 }) },
    now: () => MEMORY_DB_WAKES_NOW,
    uuid: () => `u${(n += 1)}`,
    memoryDb,
    log: MEMORY_DB_WAKES_SILENT,
  });
  return { handle, writes, inner, calls };
}

const memoryDbWakesSettle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

test('inner life: with memoryDb.wakeRuns on, a turn is one wake run with its inputs, its actions once each, and its end', async () => {
  const actions = [
    { skill: 'memory.search', status: 'executed', result: 'ok', target: {} },
    { skill: 'message.create', status: 'proposed', result: 'ok', target: { channel: 'c1' } },
  ];
  const run = innerHarness({ wakeRuns: true, actions });
  try {
    await run.inner.tick();
    await memoryDbWakesSettle();
    assert.equal(run.calls.length, 1);
    const runs = dbOf(run.handle).prepare('SELECT * FROM wake_runs').all();
    assert.equal(runs.length, 1);
    const stored = wakeRunOf(dbOf(run.handle), runs[0].id)!;
    const call = run.calls[0];
    assert.equal(stored.id, call.journalTurn.turnId, 'the run is the in-flight turn');
    assert.equal(stored.kind, 'intention_due');
    assert.equal(stored.status, 'succeeded');
    assert.equal(stored.outcome, 'spoke');
    assert.equal(stored.policy_version, WAKE_POLICY_VERSION);
    const inputs = JSON.parse(stored.inputs as string);
    assert.deepEqual(
      inputs.intentions,
      [{ id: 'i1', updatedAt: MEMORY_DB_WAKES_NOW - 3600_000 }],
      'ids with their versions'
    );
    assert.equal(inputs.wakes.length, 1);
    assert.deepEqual(
      stored.actions.map((action) => `${action.n}:${action.kind}:${action.status}`),
      ['1:memory.search:executed', '2:message.create:proposed']
    );
    // A replay of the same writes (a restarted writer) adds nothing.
    for (const update of run.writes.filter((write) => write.op === 'actions')) applyMemoryWrite(run.handle, update);
    assert.equal(count(dbOf(run.handle), 'SELECT COUNT(*) AS n FROM wake_actions'), 2);
  } finally {
    run.handle.close();
  }
});

// `memoryDb.wakeRuns` is code with no switch, so a turn with no setting is a wake run.
test('inner life: with no setting a turn is a wake run with its actions', async () => {
  const run = innerHarness({ wakeRuns: undefined, actions: [{ skill: 'memory.search', status: 'executed' }] });
  try {
    await run.inner.tick();
    await memoryDbWakesSettle();
    assert.equal(run.calls.length, 1);
    assert.equal(count(dbOf(run.handle), 'SELECT COUNT(*) AS n FROM wake_runs'), 1);
    assert.equal(count(dbOf(run.handle), "SELECT COUNT(*) AS n FROM wake_runs WHERE status = 'succeeded'"), 1);
    assert.equal(count(dbOf(run.handle), 'SELECT COUNT(*) AS n FROM wake_actions'), 1);
  } finally {
    run.handle.close();
  }
});

test('inner life: a failed turn ends its run failed', async () => {
  const failed = innerHarness({ wakeRuns: true, outcome: 'error' });
  try {
    await failed.inner.tick();
    await memoryDbWakesSettle();
    const row = dbOf(failed.handle).prepare('SELECT status, outcome FROM wake_runs').get();
    assert.deepEqual({ ...row }, { status: 'failed', outcome: 'error' });
  } finally {
    failed.handle.close();
  }
});

describe('on the default interface of the turn world', () => {
  before(() => {
    useIface('discord');
  });
  after(() => {
    useIface('fake');
  });

  // The limits are not the lines: with the lines gone, a chain at its cap is still held until the next local day.
  test('a chain past wakes.caps.perChain is still held after the budget lines left the wake', async () => {
    const run = innerSetup({
      records: [intention('i1', { chainId: 'k' }), intention('i2', { chainId: 'k', placeId: 'c2' })],
      hot: hotWith({ wakes: { caps: { perChain: 1 } } }),
    });
    await run.inner.tick();
    // The lead: the turn calls get a name, so the read stays three segments deep (R.2).
    const turnCalls = run.turns.calls;
    assert.equal(turnCalls.length, 1, 'the first wake of the chain runs');
    assert.deepEqual((await run.inner.tick()).drained, { refused: 'per-chain' });
    assert.equal(run.inner.state().queue.find((wake) => wake.kind !== 'feedback')?.capped, 'per-chain');
  });
});
