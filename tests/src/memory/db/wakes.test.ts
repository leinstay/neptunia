// Wake runs with their states and idempotent actions, and the writer path that takes every wake op. Synthetic data
// only; the ids are made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../../../../src/memory/db/open.ts';
import {
  actionKey,
  applyWakeWrite,
  finishRun,
  interruptStale,
  recordAction,
  startRun,
} from '../../../../src/memory/db/wakes.ts';
import { applyMemoryWrite } from '../../../../src/memory/db/session-write.ts';
import { WAKE_POLICY_VERSION } from '../../../../src/tools/access.ts';
import { useIface } from '../../../fixtures/turn-world.ts';
import { dbOf, type Db, type Row } from '../../../../src/memory/db/types.ts';

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

const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const MINUTE = 60_000;
const count = (db: Db, sql: string, ...params: Array<unknown>) => db.prepare(sql).get(...params)!.n;

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
    const firstAction = run.actions[0];
    assert.equal(firstAction.target, JSON.stringify({ channel: 'c1' }));
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
