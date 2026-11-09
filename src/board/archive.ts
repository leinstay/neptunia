// Her errands as rows of the board's errand lane. An errand is
// one `board_tasks` row with the errand's id, `lane` `errand`, its agent as `role`, its goal as `title`, `persona` as
// requester and subscriber, its state as the board's status (`queued` approved, `running` in_progress, the ends as
// they are) and its error as `close_reason`; its result text is the task's `handoff` result, and every other field of
// the errand, with the place it belongs to, is kept in `metadata` (`{ placeId, errand }`), so the record comes back
// exactly as the errand store (src/errands/store.ts) keeps it. `work` and `work_events` are an archive the engine
// neither writes nor reads. Nothing here logs.

import type { Status } from './machine.ts';
import type { BoardDb } from './schema.ts';

/** An errand as the store keeps it (src/errands/types.ts#ErrandRecord), seen from the board as plain data. */
export type ErrandData = Record<string, unknown> & { id: string };

/** The board status of each errand state. */
export const STATUS_OF: Readonly<Record<string, Status>> = {
  queued: 'approved',
  running: 'in_progress',
  done: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
};
/** The errand state of each status an errand task stands in. */
const STATE_OF: Readonly<Partial<Record<string, string>>> = {
  approved: 'queued',
  in_progress: 'running',
  done: 'done',
  failed: 'failed',
  cancelled: 'cancelled',
};

/**
 * The fields of an errand in the order the store writes them; a field outside the list follows them. `ledgerId` is the
 * id an errand of the ledger mirror's time carries in its metadata: no code writes it, and it keeps its place so such
 * an errand reads back with its fields in the order it was stored.
 */
const ERRAND_KEYS: ReadonlyArray<string> = [
  'id',
  'agent',
  'goal',
  'requester',
  'origin',
  'idempotencyKey',
  'scope',
  'state',
  'createdAt',
  'startedAt',
  'endedAt',
  'usage',
  'result',
  'error',
  'seen',
  'readAt',
  'resolvedAt',
  'opId',
  'ledgerId',
  'filesExpired',
  'resultTurnFailed',
];
/** The fields the board's columns hold, so `metadata.errand` leaves them out. */
const COLUMN_KEYS: ReadonlyArray<string> = ['id', 'agent', 'goal', 'state', 'error'];

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const textOr = (value: unknown, fallback: string): string => (typeof value === 'string' ? value : fallback);

/** The board status of an errand state; `failed` for a state the store does not know. */
export const statusOfState = (state: unknown): Status => STATUS_OF[String(state)] ?? 'failed';

/** The errand state of a board status, or the status itself for one no errand stands in. */
export const stateOfStatus = (status: unknown): string => STATE_OF[String(status)] ?? String(status);

/** The `metadata` of an errand's task: its fields but the columns, its result without the text, and its place. */
export function metadataOf(errand: ErrandData): string {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(errand)) {
    if (COLUMN_KEYS.includes(key)) continue;
    if (key === 'result' && isObject(value)) {
      const result = { ...value };
      delete result.text;
      kept.result = result;
    } else kept[key] = value;
  }
  return JSON.stringify({ errand: kept });
}

/** The handoff body of an errand's result: its text, its sources as the evidence, its files' names as artifacts. */
function handoffOf(result: Record<string, unknown>): string {
  const files = Array.isArray(result.files) ? result.files : [];
  return JSON.stringify({
    result: textOr(result.text, ''),
    evidence: Array.isArray(result.sources) ? result.sources.filter((url) => typeof url === 'string') : [],
    artifacts: files.map((file) => (isObject(file) ? file.name : null)).filter((name) => typeof name === 'string'),
    tests: [],
    open_issues: [],
  });
}

const parsed = (text: unknown): unknown => {
  try {
    return typeof text === 'string' ? JSON.parse(text) : null;
  } catch {
    return null;
  }
};

/** The errand a task row of the errand lane holds (`handoff` the body of its latest handoff); null for none. */
export function errandOf(row: Record<string, unknown>): ErrandData | null {
  const meta = parsed(row.metadata);
  const kept = isObject(meta) && isObject(meta.errand) ? meta.errand : null;
  const state = STATE_OF[String(row.status)];
  if (kept === null || state === undefined || typeof row.id !== 'string') return null;
  const handoff = parsed(row.handoff);
  const text = isObject(handoff) ? textOr(handoff.result, '') : '';
  const fields: Record<string, unknown> = {
    ...kept,
    id: row.id,
    agent: row.role,
    goal: row.title,
    state,
    error: typeof row.close_reason === 'string' ? row.close_reason : null,
    result: isObject(kept.result) ? { text, ...kept.result } : (kept.result ?? null),
  };
  const errand: ErrandData = { id: row.id };
  for (const key of ERRAND_KEYS) if (Object.hasOwn(fields, key)) errand[key] = fields[key];
  for (const [key, value] of Object.entries(fields)) if (!Object.hasOwn(errand, key)) errand[key] = value;
  return errand;
}

/** A select of task rows with the body of each one's latest handoff as `handoff`. */
export const TASKS_WITH_HANDOFF = `SELECT t.*, (SELECT body FROM board_results r WHERE r.task_id = t.id
  AND r.kind = 'handoff' ORDER BY r.created_at DESC, r.rowid DESC LIMIT 1) AS handoff FROM board_tasks t`;

/** A new errand task at `approved`, as the archive's `queued` line and the store's `add` file it. */
export function insertTask(db: BoardDb, errand: ErrandData, at: string): void {
  db.prepare(
    `INSERT INTO board_tasks (id, lane, title, requester, role, status, close_reason, subscriber, created_at, updated_at,
      metadata) VALUES (?, 'errand', ?, 'persona', ?, 'approved', NULL, 'persona', ?, ?, ?)`
  ).run(errand.id, textOr(errand.goal, ''), textOr(errand.agent, ''), at, at, metadataOf(errand));
}

/** The handoff of an errand's result, written once per task. */
export function insertHandoff(db: BoardDb, id: string, result: Record<string, unknown>, at: string): void {
  db.prepare(
    `INSERT INTO board_results (id, task_id, attempt_id, kind, body, uri, created_at)
    VALUES (?, ?, NULL, 'handoff', ?, NULL, ?)`
  ).run(`R-${id}`, id, handoffOf(result), at);
}

/**
 * The errand a journal action line of an errand names (`name` `errand`, the id in its `input`, `target` or `result`
 * as `errandId`), the task its `day` row references; null for any other line.
 */
export function errandIdOfLine(line: unknown): string | null {
  if (!isObject(line) || line.kind !== 'action' || line.name !== 'errand') return null;
  for (const part of [line.input, line.target, line.result]) {
    if (isObject(part) && typeof part.errandId === 'string' && part.errandId !== '') return part.errandId;
  }
  return null;
}
