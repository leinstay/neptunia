// Schema v11, stage 6 (spec 2026-10-24-memory-schema-v7, sections 6 and 11): wake runs with their states and
// idempotent actions, the inner life recording its runs through the service's writer (behind memoryDb.wakeRuns), stale
// runs interrupted at start-up. The skills registry of the SKILL.md skills is tested in tests/memory-db-skills.test.ts.
// Synthetic data only; the ids are made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openMemoryDb, schemaVersion, MIGRATIONS } from '../src/memory/db/open.ts';
import { V11_TABLES } from '../src/memory/db/schema.ts';
import {
  actionKey,
  applyWakeWrite,
  finishRun,
  interruptStale,
  recordAction,
  startRun,
  wakeRunOf,
} from '../src/memory/db/wakes.ts';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { applyUnitWrite } from '../src/memory/db/unit-write.ts';
import { createMemoryDb } from '../src/memory/db/service.ts';
import { createInnerLife, type InnerLifeOptions } from '../src/behavior/inner.ts';
import { createEventDoor } from '../src/interface/door.ts';
import { WAKE_POLICY_VERSION } from '../src/tools/access.ts';
import { buildDataDir } from './fixtures/memory-db/datadir.ts';
import { tempDir } from './fixtures/tmp.ts';
import { useIface, world } from './fixtures/turn-world.ts';
import { dbOf, type Db } from '../src/memory/db/types.ts';

// The chat she wakes in is held by a fake interface named `fake`.
useIface('fake');

const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const MINUTE = 60_000;
const SILENT = { info() {}, warn() {}, error() {}, debug() {} };
const count = (db: Db, sql: string, ...params: Array<unknown>) => db.prepare(sql).get(...params)!.n;

test('v11: the tables exist, the schema is at its last version, constraints hold', () => {
  const handle = openMemoryDb(':memory:');
  try {
    assert.equal(schemaVersion(dbOf(handle)), MIGRATIONS.length);
    assert.ok(MIGRATIONS.length >= 11);
    for (const table of V11_TABLES)
      assert.ok(
        dbOf(handle).prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(table),
        table
      );
    const columns = (table: string) =>
      dbOf(handle)
        .prepare(`PRAGMA table_info(${table})`)
        .all()
        .map((column) => column.name as string);
    assert.ok(columns('sources').includes('tier'));
    assert.ok(columns('vectors').includes('evicted_at'));
    assert.ok(columns('media').includes('availability'));
    startRun(handle, { id: 'run-1', kind: 'heartbeat', startedAt: NOW });
    // The key must spell the run and the number; an unknown status is refused.
    assert.throws(
      () =>
        dbOf(handle)
          .prepare(
            "INSERT INTO wake_actions (run_id, n, idempotency_key, kind, status, at) VALUES ('run-1', 1, 'wake:other:1', 'x', 'executed', 'now')"
          )
          .run(),
      /CHECK/
    );
    assert.throws(
      () =>
        dbOf(handle)
          .prepare("INSERT INTO wake_runs (id, kind, status) VALUES ('run-2', 'heartbeat', 'sleeping')")
          .run(),
      /CHECK/
    );
    assert.throws(
      () =>
        dbOf(handle)
          .prepare(
            "INSERT INTO wake_actions (run_id, n, idempotency_key, kind, status, at) VALUES ('nope', 1, 'wake:nope:1', 'x', 'executed', 'now')"
          )
          .run(),
      /FOREIGN KEY/
    );
    assert.deepEqual(dbOf(handle).prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    handle.close();
  }
});

test('wakes: a restarted run creates no duplicate action; a finished run is not started or finished again', () => {
  const handle = openMemoryDb(':memory:');
  try {
    const inputs = {
      wakes: ['inner.wake:heartbeat:1'],
      intentions: [{ id: 'i1', updatedAt: NOW - MINUTE }],
      facts: ['f1'],
    };
    assert.deepEqual(
      startRun(handle, {
        id: 'run-1',
        kind: 'heartbeat',
        trigger: 'inner.wake:heartbeat:1',
        startedAt: NOW,
        inputs,
        policyVersion: WAKE_POLICY_VERSION,
      }),
      { id: 'run-1', created: true, status: 'running' }
    );
    const first = recordAction(handle, {
      runId: 'run-1',
      n: 1,
      kind: 'intention.set',
      target: { channel: 'c1' },
      status: 'executed',
      at: NOW + 1000,
    });
    assert.equal(first.created, true);
    assert.equal(first.key, actionKey('run-1', 1));
    recordAction(handle, { runId: 'run-1', n: 2, kind: 'message.create', status: 'proposed', at: NOW + 2000 });
    // The process dies: at start-up the run is interrupted; the restart takes the same run id and replays its actions.
    assert.equal(interruptStale(handle, { now: NOW + 10 * MINUTE, limitMs: 3 * MINUTE }), 1);
    assert.equal(wakeRunOf(dbOf(handle), 'run-1')!.status, 'interrupted');
    assert.deepEqual(startRun(handle, { id: 'run-1', kind: 'heartbeat', startedAt: NOW + 11 * MINUTE }), {
      id: 'run-1',
      created: false,
      status: 'running',
    });
    const again = recordAction(handle, {
      runId: 'run-1',
      n: 1,
      kind: 'intention.set',
      target: { channel: 'c1' },
      status: 'executed',
      at: NOW + 12 * MINUTE,
    });
    assert.equal(again.created, false);
    assert.deepEqual(again.row, first.row, 'the second record of the same key returns the first row');
    recordAction(handle, { runId: 'run-1', n: 3, kind: 'intention.update', status: 'executed', at: NOW + 13 * MINUTE });
    assert.equal(count(dbOf(handle), 'SELECT COUNT(*) AS n FROM wake_actions WHERE run_id = ?', 'run-1'), 3);
    assert.equal(
      finishRun(handle, { id: 'run-1', status: 'succeeded', outcome: 'spoke', finishedAt: NOW + 14 * MINUTE }),
      true
    );
    assert.equal(finishRun(handle, { id: 'run-1', status: 'failed', outcome: 'error' }), false, 'ended once');
    assert.deepEqual(startRun(handle, { id: 'run-1', kind: 'heartbeat' }), {
      id: 'run-1',
      created: false,
      status: 'succeeded',
    });
    const run = wakeRunOf(dbOf(handle), 'run-1')!;
    assert.equal(run.status, 'succeeded');
    assert.equal(run.outcome, 'spoke');
    assert.equal(run.started_at, new Date(NOW).toISOString(), 'the first start is kept');
    assert.deepEqual(JSON.parse(run.inputs as string), inputs);
    assert.equal(run.policy_version, WAKE_POLICY_VERSION);
    assert.deepEqual(
      run.actions.map((action) => action.idempotency_key),
      ['wake:run-1:1', 'wake:run-1:2', 'wake:run-1:3']
    );
    assert.equal(run.actions[0].target, JSON.stringify({ channel: 'c1' }));
    assert.throws(() => recordAction(handle, { runId: 'nope', n: 1, kind: 'x', status: 'executed' }), {
      code: 'UNKNOWN_WAKE_RUN',
    });
  } finally {
    handle.close();
  }
});

test('wakes: only running rows older than the turn limit become interrupted; the writer path takes every op', () => {
  const handle = openMemoryDb(':memory:');
  try {
    startRun(handle, { id: 'old', kind: 'review', startedAt: NOW - 10 * MINUTE });
    startRun(handle, { id: 'young', kind: 'review', startedAt: NOW - MINUTE });
    startRun(handle, { id: 'done', kind: 'review', startedAt: NOW - 20 * MINUTE });
    finishRun(handle, { id: 'done', status: 'failed', outcome: 'error', finishedAt: NOW - 19 * MINUTE });
    assert.deepEqual(applyMemoryWrite(handle, { kind: 'wake', op: 'interrupt', now: NOW, limitMs: 3 * MINUTE }), {
      interrupted: 1,
    });
    const status = Object.fromEntries(
      dbOf(handle)
        .prepare('SELECT id, status FROM wake_runs')
        .all()
        .map((row) => [row.id, row.status])
    );
    assert.deepEqual(status, { old: 'interrupted', young: 'running', done: 'failed' });
    // A context issued for a run is recorded with it.
    applyWakeWrite(handle, {
      kind: 'wake',
      op: 'start',
      run: {
        id: 'ctx',
        kind: 'heartbeat',
        startedAt: NOW,
        context: { id: 'ctx:1', mode: 'internal', iface: null, issued_at: new Date(NOW).toISOString() },
      },
    });
    assert.equal(wakeRunOf(dbOf(handle), 'ctx')!.context_id, 'ctx:1');
    assert.equal(count(dbOf(handle), 'SELECT COUNT(*) AS n FROM execution_contexts WHERE id = ?', 'ctx:1'), 1);
    assert.deepEqual(
      applyMemoryWrite(handle, {
        kind: 'wake',
        op: 'actions',
        actions: [
          { runId: 'ctx', n: 1, kind: 'memory.search', status: 'executed', at: NOW },
          { runId: 'ctx', n: 1, kind: 'memory.search', status: 'executed', at: NOW },
        ],
      }),
      { recorded: 1 }
    );
    assert.throws(() => applyMemoryWrite(handle, { kind: 'wake', op: 'nope' }), { code: 'BAD_UPDATE' });
    assert.deepEqual(dbOf(handle).prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    handle.close();
  }
});

// ---------- the inner life records its runs ----------

type TurnParams = { journalTurn: { turnId: string } };

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
    writeUnit: (update: Parameters<typeof applyUnitWrite>[1]) => Promise.resolve(applyUnitWrite(handle, update)),
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
      dueAt: NOW - MINUTE,
      chainId: null,
      destination: null,
      provenance: { kind: 'self', placeId: 'c1', scope: 'group' },
      createdAt: NOW - 86_400_000,
      updatedAt: NOW - 3600_000,
      expiresAt: NOW + 7 * 86_400_000,
    },
  ];
  const intentions = {
    due: () => records.filter((r) => r.status === 'pending').map((r) => ({ intention: r, reason: 'due', at: r.dueAt })),
    reconcile: () => ({ arrived: 0, missing: 0, deadline: 0, expired: 0 }),
    list: () => records,
    store: () => ({ get: (id: string) => records.find((r) => r.id === id) ?? null, list: () => records }),
    // The records carry only the fields the wake reads, so the fake stands in for the intention service by a cast.
  } as unknown as NonNullable<InnerLifeOptions['intentions']>;
  const calls: Array<TurnParams> = [];
  const turns = {
    isAnyBusy: () => false,
    runTurn: async (params: TurnParams) => {
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
  const door = createEventDoor({ handlers: { 'inner.wake': (event) => inner.onWake(event) }, log: SILENT });
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
    now: () => NOW,
    uuid: () => `u${(n += 1)}`,
    memoryDb,
    log: SILENT,
  });
  return { handle, writes, inner, calls };
}

const settle = async () => {
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
    await settle();
    assert.equal(run.calls.length, 1);
    const runs = dbOf(run.handle).prepare('SELECT * FROM wake_runs').all();
    assert.equal(runs.length, 1);
    const stored = wakeRunOf(dbOf(run.handle), runs[0].id)!;
    assert.equal(stored.id, run.calls[0].journalTurn.turnId, 'the run is the in-flight turn');
    assert.equal(stored.kind, 'intention_due');
    assert.equal(stored.status, 'succeeded');
    assert.equal(stored.outcome, 'spoke');
    assert.equal(stored.policy_version, WAKE_POLICY_VERSION);
    const inputs = JSON.parse(stored.inputs as string);
    assert.deepEqual(inputs.intentions, [{ id: 'i1', updatedAt: NOW - 3600_000 }], 'ids with their versions');
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

// PR 7d: `memoryDb.wakeRuns` is code (owner, 2026-10-31), so the half of this test that wrote nothing with the switch
// off is gone; the next test holds the run written with no setting.
test('inner life: with no setting a turn is a wake run with its actions', async () => {
  const run = innerHarness({ wakeRuns: undefined, actions: [{ skill: 'memory.search', status: 'executed' }] });
  try {
    await run.inner.tick();
    await settle();
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
    await settle();
    const row = dbOf(failed.handle).prepare('SELECT status, outcome FROM wake_runs').get();
    assert.deepEqual({ ...row }, { status: 'failed', outcome: 'error' });
  } finally {
    failed.handle.close();
  }
});

// PR 7d: `memoryDb.wakeRuns` is code (owner, 2026-10-31). This test held that nothing was written and no stale run
// was interrupted with the switch off; with no setting the service now writes and interrupts at the first open.
test('service: recordWake writes with no setting; an open interrupts the stale runs a dead process left', async () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-wakes-'));
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  buildDataDir(data);
  try {
    // A run a dead process left running.
    const before = openMemoryDb(path.join(data, 'memory.db'));
    startRun(before, { id: 'left', kind: 'heartbeat', startedAt: NOW - 30 * MINUTE });
    before.close();
    const hot = { config: { wakes: { loop: { timeBudgetMs: 3 * MINUTE } } } };
    const service = createMemoryDb({ hot, dataDir: data, log: SILENT, worker: false, now: () => NOW });
    await service.tick();
    await settle();
    await service.recordWake({ kind: 'wake', op: 'start', run: { id: 'r1', kind: 'heartbeat', startedAt: NOW } });
    await service.close();
    const reader = openMemoryDb(path.join(data, 'memory.db'), { readOnly: true });
    const status = Object.fromEntries(
      dbOf(reader)
        .prepare('SELECT id, status FROM wake_runs')
        .all()
        .map((row) => [row.id, row.status])
    );
    reader.close();
    assert.deepEqual(status, { left: 'interrupted', r1: 'running' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
