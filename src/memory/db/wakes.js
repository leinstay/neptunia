// The writer of her wake runs (schema v11, spec 2026-10-24-memory-schema-v7, section 6 and section 11 on wakes): one
// `wake_runs` row per inner wake run, one `wake_actions` row per action it took, so the next wake can say what she
// looked at last time and a restarted run creates nothing twice.
//
//   startRun(handle, run)          a run in `running` (a new id), or the stored run again: a run that was queued,
//                                  interrupted or failed goes back to `running` (its first start time kept); a finished
//                                  run is left as it is. Returns `{ id, created, status }`.
//   recordAction(handle, action)   the action `n` of a run, keyed `wake:<run>:<n>`: a second record of the same key
//                                  returns the first row (`created: false`) and writes nothing.
//   finishRun(handle, finish)      `succeeded` or `failed` with the outcome code, once: a run that is not running or
//                                  queued is not changed. Returns whether it changed.
//   interruptStale(handle, opts)   at start-up: every `running` run that started more than `limitMs` before `now` (the
//                                  inner turn's time budget) becomes `interrupted`. Returns how many.
//   applyWakeWrite(handle, update) the one message form the service's writer takes (`{ kind: 'wake', op, ... }`).
//
// The run's `inputs` are what its view showed, ids with their versions (an intention with its `updatedAt`, a fact by
// id); `policy_version` is the envelope's (src/skills/access.js#WAKE_POLICY_VERSION). The context a run was issued
// (`context`, an execution context row of scope.ts#contextRow) is recorded in `execution_contexts` in the same
// transaction. Every time is an ISO string; `now` may be given in milliseconds. Imports nothing heavy (the sync
// worker loads it). Codes only, never a text.

import { WAKE_RUN_STATUSES } from './schema.js';
import { ensureInterface } from './rows.js';

const coded = (code) => Object.assign(new Error(code), { code });
const iso = (value) =>
  Number.isFinite(value) ? new Date(value).toISOString() : typeof value === 'string' && value ? value : null;
const json = (value) => (value === undefined || value === null ? null : JSON.stringify(value));
const present = (value) => typeof value === 'string' && value !== '';

/** The idempotency key of action `n` of run `runId`. */
export const actionKey = (runId, n) => `wake:${runId}:${n}`;

/** Records an issued context's row inside the caller's transaction (left alone when already there); its id, or null. */
function contextOf(db, row) {
  if (!row || !present(row.id) || !present(row.issued_at)) return null;
  if (row.iface) ensureInterface(db, row.iface);
  db.prepare(
    `INSERT OR IGNORE INTO execution_contexts (id, mode, iface, destination_place_id, partner_person_id, policy_version, issued_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)`
  ).run(
    row.id,
    row.mode,
    row.iface ?? null,
    row.destination_place_id ?? null,
    row.partner_person_id ?? null,
    row.policy_version ?? 1,
    row.issued_at
  );
  return row.id;
}

const runOf = (db, id) => db.prepare('SELECT * FROM wake_runs WHERE id = ?').get(id) ?? null;

/**
 * Starts a run, or starts a stored one again (see the head of this file).
 * @param {{ db: object, transaction: Function }} handle
 * @param {{ id: string, kind: string, trigger?: string|null, scheduledAt?: number|string|null, startedAt?: number|string,
 *   contextId?: string|null, context?: object|null, inputs?: object|null, policyVersion?: number|null, extra?: object|null }} run
 * @returns {{ id: string, created: boolean, status: string }}
 */
export function startRun(handle, run) {
  if (!present(run?.id) || !present(run?.kind)) throw coded('BAD_WAKE_RUN');
  return handle.transaction(() => {
    const { db } = handle;
    const contextId = contextOf(db, run.context) ?? (present(run.contextId) ? run.contextId : null);
    const stored = runOf(db, run.id);
    if (stored) {
      if (!['queued', 'interrupted', 'failed'].includes(stored.status))
        return { id: run.id, created: false, status: stored.status };
      db.prepare(
        "UPDATE wake_runs SET status = 'running', finished_at = NULL, outcome = NULL, started_at = COALESCE(started_at, ?) WHERE id = ?"
      ).run(iso(run.startedAt) ?? new Date().toISOString(), run.id);
      return { id: run.id, created: false, status: 'running' };
    }
    db.prepare(
      `INSERT INTO wake_runs (id, kind, trigger, scheduled_at, started_at, finished_at, status, context_id, inputs, policy_version, outcome, extra)
      VALUES (?, ?, ?, ?, ?, NULL, 'running', ?, ?, ?, NULL, ?)`
    ).run(
      run.id,
      run.kind,
      run.trigger ?? null,
      iso(run.scheduledAt),
      iso(run.startedAt) ?? new Date().toISOString(),
      contextId,
      json(run.inputs),
      Number.isInteger(run.policyVersion) ? run.policyVersion : null,
      json(run.extra)
    );
    return { id: run.id, created: true, status: 'running' };
  });
}

/**
 * Records action `n` of a run once (see the head of this file).
 * @param {{ db: object, transaction: Function }} handle
 * @param {{ runId: string, n: number, kind: string, target?: string|object|null, status: string, at?: number|string }} action
 * @returns {{ key: string, created: boolean, row: object }}
 */
export function recordAction(handle, action) {
  if (
    !present(action?.runId) ||
    !Number.isInteger(action?.n) ||
    action.n < 1 ||
    !present(action?.kind) ||
    !present(action?.status)
  )
    throw coded('BAD_WAKE_ACTION');
  return handle.transaction(() => {
    const { db } = handle;
    if (!runOf(db, action.runId)) throw coded('UNKNOWN_WAKE_RUN');
    const key = actionKey(action.runId, action.n);
    const target =
      typeof action.target === 'string' || action.target === null || action.target === undefined
        ? (action.target ?? null)
        : JSON.stringify(action.target);
    const done = db
      .prepare(
        `INSERT OR IGNORE INTO wake_actions (run_id, n, idempotency_key, kind, target, status, at) VALUES (?, ?, ?, ?, ?, ?, ?)`
      )
      .run(action.runId, action.n, key, action.kind, target, action.status, iso(action.at) ?? new Date().toISOString());
    return {
      key,
      created: done.changes > 0,
      row: { ...db.prepare('SELECT * FROM wake_actions WHERE idempotency_key = ?').get(key) },
    };
  });
}

/**
 * Ends a running (or queued) run once with `succeeded` or `failed` and its outcome code.
 * @param {{ db: object, transaction: Function }} handle
 * @param {{ id: string, status: 'succeeded'|'failed', outcome?: string|null, finishedAt?: number|string, extra?: object|null }} finish
 * @returns {boolean}
 */
export function finishRun(handle, finish) {
  if (!present(finish?.id) || !['succeeded', 'failed'].includes(finish?.status)) throw coded('BAD_WAKE_FINISH');
  return handle.transaction(() => {
    const done = handle.db
      .prepare(
        `UPDATE wake_runs SET status = ?, outcome = ?, finished_at = ?, extra = COALESCE(?, extra)
      WHERE id = ? AND status IN ('running', 'queued')`
      )
      .run(
        finish.status,
        finish.outcome ?? null,
        iso(finish.finishedAt) ?? new Date().toISOString(),
        json(finish.extra),
        finish.id
      );
    return done.changes > 0;
  });
}

/**
 * Marks every run still `running` that started more than `limitMs` before `now` as `interrupted` (start-up).
 * @param {{ db: object, transaction: Function }} handle
 * @param {{ now: number, limitMs: number }} opts
 * @returns {number}
 */
export function interruptStale(handle, { now, limitMs }) {
  if (!Number.isFinite(now) || !Number.isFinite(limitMs) || limitMs < 0) throw coded('BAD_WAKE_INTERRUPT');
  return handle.transaction(
    () =>
      handle.db
        .prepare(
          `UPDATE wake_runs SET status = 'interrupted', finished_at = ?
    WHERE status = 'running' AND started_at IS NOT NULL AND started_at < ?`
        )
        .run(iso(now), iso(now - limitMs)).changes
  );
}

/** The stored run and its actions (in order), or null. */
export function wakeRunOf(db, id) {
  const run = runOf(db, id);
  if (!run) return null;
  return {
    ...run,
    actions: db
      .prepare('SELECT * FROM wake_actions WHERE run_id = ? ORDER BY n')
      .all(id)
      .map((row) => ({ ...row })),
  };
}

/**
 * One wake write on the writer connection (service.js#memoryWrite): `{ kind: 'wake', op: 'start' | 'action' |
 * 'finish' | 'interrupt', ... }` with the fields of the matching function above (`run`, `action`, `finish`, or
 * `now` and `limitMs`).
 */
export function applyWakeWrite(handle, update) {
  switch (update?.op) {
    case 'start':
      return startRun(handle, update.run);
    case 'action':
      return recordAction(handle, update.action);
    case 'actions':
      return {
        recorded: (Array.isArray(update.actions) ? update.actions : [])
          .map((action) => recordAction(handle, action).created)
          .filter(Boolean).length,
      };
    case 'finish':
      return { changed: finishRun(handle, update.finish) };
    case 'interrupt':
      return { interrupted: interruptStale(handle, update) };
    default:
      throw coded('BAD_UPDATE');
  }
}

export { WAKE_RUN_STATUSES };
