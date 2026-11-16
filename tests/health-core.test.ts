// Tests for the core part of `/health` (src/health/core.ts#coreHealth) over a fixture memory database written row by
// row: the sends that failed or still wait and the errand ends not yet delivered. The clock is the fixed NOW; no core
// runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { coreHealth } from '../src/health/core.ts';
import { tempDir } from './fixtures/tmp.ts';

const NOW = Date.parse('2026-10-31T12:00:00Z');
const HOUR = 60 * 60 * 1000;

function fixture(): { db: DatabaseSync; close: () => void } {
  const dir = tempDir('health-core-');
  const handle = openMemoryDb(join(dir, 'memory.db'));
  return { db: handle.db as DatabaseSync, close: () => handle.close() };
}

/** A delivery of one wake in `state`. */
function delivery(db: DatabaseSync, key: string, state: string): void {
  db.prepare(
    "INSERT OR IGNORE INTO wakes (id, kind, queued_at, payload, state) VALUES ('w1', 'heartbeat', ?, '{}', 'handled')"
  ).run(NOW - HOUR);
  db.prepare(
    "INSERT INTO deliveries (key, wake_id, target, payload, state, queued_at) VALUES (?, 'w1', 'c1', '{}', ?, ?)"
  ).run(key, state, NOW - HOUR);
}

test('counts the failed sends and the queued ones apart from those sent', () => {
  const { db, close } = fixture();
  try {
    delivery(db, 'k1', 'failed');
    delivery(db, 'k2', 'failed');
    delivery(db, 'k3', 'queued');
    delivery(db, 'k4', 'sent');
    const health = coreHealth(db, { now: NOW, turnDurationsMs: [] });
    assert.equal(health.failedSends, 2);
    assert.equal(health.queues.deliveries, 1);
  } finally {
    close();
  }
});

test('counts the outbox rows of errand ends not yet delivered and leaves out the delivered ones', () => {
  // Bug: a count over every outbox row, so /doctor core reports ends that her result turns already took.
  const { db, close } = fixture();
  try {
    const insert = db.prepare(
      "INSERT INTO board_outbox (task_id, to_whom, kind, payload, created_at, delivered_at) VALUES (?, 'persona', 'done', '{}', 'x', ?)"
    );
    insert.run('e-1', null);
    insert.run('e-2', null);
    insert.run('e-3', 'y');
    assert.equal(coreHealth(db, { now: NOW, turnDurationsMs: [] }).queues.outbox, 2);
  } finally {
    close();
  }
});

// Changed: the stuck-errand check goes, since no errand holds a lease, so the empty case no longer reports one.
test('an empty database is healthy, with no failed send, no waiting outbox row and no latency', () => {
  const { db, close } = fixture();
  try {
    const health = coreHealth(db, { now: NOW, turnDurationsMs: [] });
    assert.equal(health.status, 'ok');
    assert.deepEqual([health.failedSends, health.queues.outbox], [0, 0]);
    assert.deepEqual(health.turnLatencyMs, { p50: null, p95: null });
  } finally {
    close();
  }
});
