// The memory part of `/health`, read from the memory database: the people who spoke within the window and about whom
// nothing was written in it, the claims whose versions change too often, the members' lines her memory session has
// not read, and the newest finished backup. A person counts as written about when a claim about them was created or
// seen, a version of such a claim was recorded, or a description of them got a version in the window. The owner's
// console (src/interface/commands/console.ts) calls `memoryHealth` for `/health memory` with `days: 7` over the
// core's read connection. Pure over the database and the backups folder.

import type { DatabaseSync } from 'node:sqlite';
import { backupsIn } from '../memory/db/backup.js';
import { worse } from './server.ts';
import type { HealthStatus } from './server.ts';

export type MemoryHealth = {
  part: 'memory';
  status: HealthStatus;
  text: string;
  silent: ReadonlyArray<{ personId: string; lastSpokeAt: string }>;
  churning: ReadonlyArray<{ claimId: string; versions: number }>;
  backlog: number;
  lastBackup: { name: string } | null;
};

/** More versions of one claim than this within the window is churn (owner's table of 2026-10-27: "too often"). */
const CHURN_VERSIONS = 10;

const DAY_MS = 24 * 60 * 60 * 1000;

/** The rows of `sql`, [] when a table is missing (a database before its migration). */
function rows(db: DatabaseSync, sql: string, ...params: Array<string | number>): Array<Record<string, unknown>> {
  try {
    return db.prepare(sql).all(...params);
  } catch {
    // A table the schema does not hold yet has no rows.
    return [];
  }
}

/** The memory's health at `now` over the last `days` days; `backupsDir` null reads no backup. */
export function memoryHealth(
  db: DatabaseSync,
  options: { now: number; days: number; backupsDir: string | null }
): MemoryHealth {
  const since = new Date(options.now - options.days * DAY_MS).toISOString();
  const silent = rows(
    db,
    `SELECT p.id, p.last_seen_at FROM people p
     WHERE p.kind = 'person' AND p.retired_at IS NULL AND p.last_seen_at >= ?
       AND NOT EXISTS (SELECT 1 FROM claims c WHERE c.subject_kind = 'person' AND c.subject_id = p.id
         AND (c.created_at >= ? OR c.last_seen_at >= ?))
       AND NOT EXISTS (SELECT 1 FROM claim_versions v JOIN claims c ON c.id = v.claim_id
         WHERE c.subject_kind = 'person' AND c.subject_id = p.id AND v.recorded_at >= ?)
       AND NOT EXISTS (SELECT 1 FROM description_versions v JOIN descriptions d ON d.id = v.description_id
         WHERE d.subject_kind = 'person' AND d.subject_id = p.id AND v.written_at >= ?)
     ORDER BY p.last_seen_at DESC`,
    since,
    since,
    since,
    since,
    since
  ).map((row) => ({ personId: String(row.id), lastSpokeAt: String(row.last_seen_at) }));
  const churning = rows(
    db,
    `SELECT claim_id, COUNT(*) AS n FROM claim_versions WHERE recorded_at >= ?
     GROUP BY claim_id HAVING COUNT(*) > ? ORDER BY n DESC, claim_id`,
    since,
    CHURN_VERSIONS
  ).map((row) => ({ claimId: String(row.claim_id), versions: Number(row.n) }));
  const [backlogRow] = rows(
    db,
    `SELECT COUNT(*) AS n FROM sources WHERE kind = 'seen'
     AND rowid > COALESCE((SELECT MAX(cursor_to) FROM session_runs WHERE applied = 1), 0)`
  );
  const backlog = typeof backlogRow?.n === 'number' ? backlogRow.n : 0;
  const newest = options.backupsDir === null ? undefined : backupsIn(options.backupsDir).at(-1);
  const lastBackup = newest === undefined ? null : { name: newest };
  let status: HealthStatus = 'ok';
  if (silent.length > 0 || churning.length > 0) status = worse(status, 'warn');
  const lines = [
    `memory ${status} over the last ${options.days} days`,
    silent.length === 0
      ? 'spoke, nothing written: none'
      : `spoke, nothing written: ${silent.map((row) => `${row.personId} (last spoke ${row.lastSpokeAt})`).join(', ')}`,
    churning.length === 0
      ? 'claims changing too often: none'
      : `claims changing too often: ${churning.map((row) => `${row.claimId} (${row.versions} versions)`).join(', ')}`,
    `lines her memory session has not read: ${backlog}`,
    `last backup: ${lastBackup?.name ?? 'none'}`,
  ];
  return { part: 'memory', status, text: lines.join('\n'), silent, churning, backlog, lastBackup };
}
