// The core part of `/health`, read from the memory database: the errands stuck on an expired lease, the sends that
// failed or still wait, the depths of the ingest, outbox and delivery queues, the wakes claimed more than once, and
// the latency of her replies. A stuck errand is the board's own reclaim condition (src/board/board.ts, `reap`): a
// task of lane `errand`, `approved` or `in_progress`, whose lease expired. The owner's console
// (src/interface/commands/console.ts) calls `coreHealth` for `/health core` over the core's read connection; the
// turn durations come from the `reply` metric (src/tools/impl/metrics.ts). Pure over the database and its options.

import type { DatabaseSync } from 'node:sqlite';
import { worse } from './server.ts';
import type { HealthStatus } from './server.ts';

export type CoreHealth = {
  part: 'core';
  status: HealthStatus;
  text: string;
  stuckErrands: ReadonlyArray<{ id: string; status: string; leaseExpiresAt: string }>;
  failedSends: number;
  queues: { deliveries: number; outbox: number; ingest: number };
  retries: number;
  turnLatencyMs: { p50: number | null; p95: number | null };
};

/** One count of `sql`, 0 when the table is missing (a database before its migration). */
function count(db: DatabaseSync, sql: string, ...params: Array<string | number>): number {
  try {
    const row = db.prepare(sql).get(...params) as { n?: unknown } | undefined;
    return typeof row?.n === 'number' ? row.n : 0;
  } catch {
    // A table the schema does not hold yet has nothing queued in it.
    return 0;
  }
}

/** The `share` quantile of `values` (nearest rank), null for none. */
function quantile(values: ReadonlyArray<number>, share: number): number | null {
  const sorted = values.filter((value) => Number.isFinite(value)).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(share * sorted.length) - 1));
  return sorted[index] ?? null;
}

/** The core's health from the memory database at `now`, with the reply durations of the last day. */
export function coreHealth(
  db: DatabaseSync,
  options: { now: number; turnDurationsMs: ReadonlyArray<number> }
): CoreHealth {
  const nowIso = new Date(options.now).toISOString();
  let stuckErrands: Array<{ id: string; status: string; leaseExpiresAt: string }> = [];
  try {
    stuckErrands = (
      db
        .prepare(
          `SELECT id, status, lease_expires_at FROM board_tasks WHERE lane = 'errand' AND lease_owner IS NOT NULL
           AND lease_expires_at < ? AND status IN ('approved', 'in_progress') ORDER BY lease_expires_at`
        )
        .all(nowIso) as Array<{ id: unknown; status: unknown; lease_expires_at: unknown }>
    ).map((row) => ({ id: String(row.id), status: String(row.status), leaseExpiresAt: String(row.lease_expires_at) }));
  } catch {
    // No board tables: no errand can be stuck.
    stuckErrands = [];
  }
  const failedSends = count(db, "SELECT COUNT(*) AS n FROM deliveries WHERE state = 'failed'");
  const queues = {
    deliveries: count(db, "SELECT COUNT(*) AS n FROM deliveries WHERE state = 'queued'"),
    outbox: count(db, 'SELECT COUNT(*) AS n FROM board_outbox WHERE delivered_at IS NULL'),
    ingest: count(
      db,
      `SELECT COUNT(*) AS n FROM ingest i LEFT JOIN ingest_cursor c ON c.principal = i.principal
       WHERE i.seq IS NOT NULL AND i.seq > COALESCE(c.acked_seq, 0)`
    ),
  };
  const retries = count(db, 'SELECT COUNT(*) AS n FROM wakes WHERE attempt > 1');
  const turnLatencyMs = {
    p50: quantile(options.turnDurationsMs, 0.5),
    p95: quantile(options.turnDurationsMs, 0.95),
  };
  let status: HealthStatus = 'ok';
  if (stuckErrands.length > 0 || failedSends > 0) status = worse(status, 'warn');
  const ms = (value: number | null): string => (value === null ? '-' : `${Math.round(value)} ms`);
  const lines = [
    `core ${status}`,
    stuckErrands.length === 0
      ? 'stuck errands: none'
      : `stuck errands: ${stuckErrands.map((row) => `${row.id} (${row.status}, lease expired ${row.leaseExpiresAt})`).join(', ')}`,
    `failed sends: ${failedSends}`,
    `queues: ${queues.deliveries} deliveries, ${queues.outbox} board outbox, ${queues.ingest} ingest`,
    `wakes claimed more than once: ${retries}`,
    `reply latency over the last day: p50 ${ms(turnLatencyMs.p50)}, p95 ${ms(turnLatencyMs.p95)}`,
  ];
  return { part: 'core', status, text: lines.join('\n'), stuckErrands, failedSends, queues, retries, turnLatencyMs };
}
