// Tests for the core part of `/health` (src/health/core.ts#coreHealth) over a fixture memory database written row by
// row: the errands stuck on an expired lease (the board's own reclaim condition) and the sends that failed or still
// wait. The clock is the fixed NOW; no core runs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';
import { openMemoryDb } from '../src/memory/db/open.js';
import { coreHealth } from '../src/health/core.ts';
import { tempDir } from './fixtures/tmp.js';

const NOW = Date.parse('2026-10-31T12:00:00Z');
const HOUR = 60 * 60 * 1000;
const iso = (ms: number): string => new Date(ms).toISOString();

function fixture(): { db: DatabaseSync; close: () => void } {
  const dir = tempDir('health-core-');
  const handle = openMemoryDb(join(dir, 'memory.db'), { context: { dataDir: dir } });
  return { db: handle.db as DatabaseSync, close: () => handle.close() };
}

/** A board task of `lane` in `status`, its lease held by a runner until `leaseUntil` (null: no lease). */
function task(db: DatabaseSync, id: string, lane: string, status: string, leaseUntil: number | null): void {
  db.prepare(
    `INSERT INTO board_tasks (id, lane, title, requester, role, status, lease_owner, lease_expires_at, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    id,
    lane,
    'find the release notes',
    'persona:self',
    lane === 'errand' ? 'scout' : 'dev',
    status,
    leaseUntil === null ? null : 'runner-1',
    leaseUntil === null ? null : iso(leaseUntil),
    iso(NOW - 5 * HOUR),
    iso(NOW - 4 * HOUR)
  );
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

test('counts an errand whose lease expired while it runs as stuck and names it', () => {
  const { db, close } = fixture();
  try {
    task(db, 'e-stuck', 'errand', 'in_progress', NOW - HOUR);
    task(db, 'e-live', 'errand', 'in_progress', NOW + HOUR);
    task(db, 'e-done', 'errand', 'done', null);
    const health = coreHealth(db, { now: NOW, turnDurationsMs: [] });
    assert.deepEqual(
      health.stuckErrands.map((row) => row.id),
      ['e-stuck']
    );
    assert.notEqual(health.status, 'ok');
    assert.ok(health.text.includes('e-stuck'), 'the text names the stuck errand');
  } finally {
    close();
  }
});

test('a development task on an expired lease is not a stuck errand', () => {
  const { db, close } = fixture();
  try {
    task(db, 'd-stale', 'dev', 'in_progress', NOW - HOUR);
    assert.deepEqual(coreHealth(db, { now: NOW, turnDurationsMs: [] }).stuckErrands, []);
  } finally {
    close();
  }
});

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

test('an empty database is healthy, with no stuck errand, no failed send and no latency', () => {
  const { db, close } = fixture();
  try {
    const health = coreHealth(db, { now: NOW, turnDurationsMs: [] });
    assert.equal(health.status, 'ok');
    assert.deepEqual([health.stuckErrands.length, health.failedSends], [0, 0]);
    assert.deepEqual(health.turnLatencyMs, { p50: null, p95: null });
  } finally {
    close();
  }
});
