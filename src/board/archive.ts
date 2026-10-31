// Her errands as rows of the board's errand lane, and board v3's move of them out of the `work` archive. An errand is
// one `board_tasks` row with the errand's id, `lane` `errand`, its agent as `role`, its goal as `title`, `persona` as
// requester and subscriber, its state as the board's status (`queued` approved, `running` in_progress, the ends as
// they are) and its error as `close_reason`; its result text is the task's `handoff` result, and every other field of
// the errand, with the guild it belongs to, is kept in `metadata` (`{ guildId, errand }`), so the record comes back
// exactly as the errand store (src/errands/store.ts) keeps it. MOVE_ARCHIVE_SQL is board v3's data step
// (src/board/schema.ts); `compareArchive` is `tools/memory-db.mjs board verify-errands`. After the move `work` and
// `work_events` are an archive the engine neither writes nor reads. Nothing here logs.

import type { Status } from './machine.ts';
import type { BoardDb } from './schema.ts';

/** An errand as the store keeps it (src/errands/types.ts#ErrandRecord), seen from the board as plain data. */
export type ErrandData = Record<string, unknown> & { id: string };

/** The board status of each errand state. */
const STATUS_OF: Readonly<Record<string, Status>> = {
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

/** The `metadata` of an errand's task: its fields but the columns, its result without the text, and its guild. */
export function metadataOf(errand: ErrandData, guildId: string): string {
  const kept: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(errand)) {
    if (COLUMN_KEYS.includes(key)) continue;
    if (key === 'result' && isObject(value)) {
      const result = { ...value };
      delete result.text;
      kept.result = result;
    } else kept[key] = value;
  }
  return JSON.stringify({ guildId, errand: kept });
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
export function insertTask(db: BoardDb, errand: ErrandData, guildId: string, at: string): void {
  db.prepare(
    `INSERT INTO board_tasks (id, lane, title, requester, role, status, close_reason, subscriber, created_at, updated_at,
      metadata) VALUES (?, 'errand', ?, 'persona', ?, 'approved', NULL, 'persona', ?, ?, ?)`
  ).run(errand.id, textOr(errand.goal, ''), textOr(errand.agent, ''), at, at, metadataOf(errand, guildId));
}

/** The handoff of an errand's result, written once per task. */
export function insertHandoff(db: BoardDb, id: string, result: Record<string, unknown>, at: string): void {
  db.prepare(
    `INSERT INTO board_results (id, task_id, attempt_id, kind, body, uri, created_at)
    VALUES (?, ?, NULL, 'handoff', ?, NULL, ?)`
  ).run(`R-${id}`, id, handoffOf(result), at);
}

/** The ISO time (`2026-10-30T10:00:00.000Z`, as `Date#toISOString` writes it) of an epoch-ms SQL expression. */
const isoSql = (ms: string): string =>
  `CASE WHEN ${ms} IS NULL THEN NULL ELSE strftime('%Y-%m-%dT%H:%M:%S', ${ms} / 1000, 'unixepoch') || '.' || ` +
  `printf('%03d', ${ms} % 1000) || 'Z' END`;
/** The board status of an errand state held in an SQL expression, as `statusOfState` maps it. */
const statusSql = (state: string): string =>
  `CASE ${state} WHEN 'queued' THEN 'approved' WHEN 'running' THEN 'in_progress' WHEN 'done' THEN 'done' ` +
  `WHEN 'cancelled' THEN 'cancelled' ELSE 'failed' END`;
const field = (key: string): string => `json_extract(w.record, '$.${key}')`;

const ARCHIVED_ERRANDS = "SELECT id, record FROM work WHERE kind = 'errand' ORDER BY created_ms, rowid";

/**
 * Board v3's data step (src/board/schema.ts), run in the board's migration transaction after the memory schema: every
 * `work` row of kind errand (the retired ones too, the errands a list let go of) becomes an errand task with its id
 * and the fields `metadataOf` keeps, its result text a handoff, and each of its `work_events` lines a status event in
 * line order (one event at its status when it has none). A row whose record does not parse, does not carry its id, or
 * whose unit names no guild stays in the archive only. Nothing is written to `work` or `work_events`.
 */
export const MOVE_ARCHIVE_SQL = `
CREATE TEMP TABLE board_v3_errands AS
  SELECT w.id AS id, w.record AS record, w.rowid AS seq,
    substr(w.owner_file, 8, instr(substr(w.owner_file, 8), '/') - 1) AS guild,
    COALESCE(${isoSql(field('createdAt'))}, '1970-01-01T00:00:00.000Z') AS created,
    COALESCE(${isoSql(`COALESCE(${field('endedAt')}, ${field('startedAt')}, ${field('createdAt')})`)},
      '1970-01-01T00:00:00.000Z') AS updated
  FROM work w
  WHERE w.kind = 'errand' AND json_valid(w.record) AND json_type(w.record) = 'object'
    AND json_extract(w.record, '$.id') = w.id AND w.owner_file GLOB 'guilds/?*/*'
  ORDER BY w.created_ms, w.rowid;
INSERT INTO board_tasks (id, lane, title, requester, role, status, close_reason, subscriber, created_at, updated_at,
    metadata)
  SELECT id, 'errand', COALESCE(json_extract(record, '$.goal'), ''), 'persona',
    COALESCE(json_extract(record, '$.agent'), ''), ${statusSql("json_extract(record, '$.state')")},
    CASE WHEN json_type(record, '$.error') = 'text' THEN json_extract(record, '$.error') END, 'persona', created,
    updated,
    json_object('guildId', guild, 'errand',
      json_remove(record, '$.id', '$.agent', '$.goal', '$.state', '$.error', '$.result.text'))
  FROM board_v3_errands ORDER BY seq;
INSERT INTO board_results (id, task_id, attempt_id, kind, body, uri, created_at)
  SELECT 'R-' || id, id, NULL, 'handoff',
    json_object(
      'result', CASE WHEN json_type(record, '$.result.text') = 'text' THEN json_extract(record, '$.result.text') ELSE '' END,
      'evidence', json((SELECT json_group_array(value) FROM json_each(record, '$.result.sources') WHERE type = 'text')),
      'artifacts', json((SELECT json_group_array(json_extract(value, '$.name')) FROM json_each(record, '$.result.files')
        WHERE json_type(value, '$.name') = 'text')),
      'tests', json('[]'), 'open_issues', json('[]')),
    NULL, updated
  FROM board_v3_errands WHERE json_type(record, '$.result') = 'object' ORDER BY seq;
INSERT INTO board_events (task_id, actor, type, old, new, created_at)
  SELECT task_id, 'core', 'status', LAG(status) OVER (PARTITION BY task_id ORDER BY owner_file, position), status, at
  FROM (
    SELECT e.work_id AS task_id, e.owner_file AS owner_file, e.position AS position,
      ${statusSql("json_extract(e.record, '$.state')")} AS status,
      COALESCE(${isoSql('e.at_ms')}, v.updated) AS at, v.seq AS seq
    FROM work_events e JOIN board_v3_errands v ON v.id = e.work_id
    WHERE json_valid(e.record)
  )
  ORDER BY seq, owner_file, position;
INSERT INTO board_events (task_id, actor, type, old, new, created_at)
  SELECT v.id, 'core', 'status', NULL, ${statusSql("json_extract(v.record, '$.state')")}, v.updated
  FROM board_v3_errands v WHERE NOT EXISTS (SELECT 1 FROM work_events e WHERE e.work_id = v.id AND json_valid(e.record))
  ORDER BY v.seq;
DROP TABLE board_v3_errands;
`;

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

/** One difference `compareArchive` found: the errand and the record's field, or `missing` for an errand with no task. */
export type ArchiveMismatch = { id: string; field: string };

/**
 * Every `work` row of kind errand compared with the errand its board task holds, field by field over the record (the
 * JSON of each field either side has). Read-only.
 */
export function compareArchive(db: BoardDb): { checked: number; mismatches: Array<ArchiveMismatch> } {
  const task = db.prepare(`${TASKS_WITH_HANDOFF} WHERE t.id = ?`);
  const mismatches: Array<ArchiveMismatch> = [];
  let checked = 0;
  for (const row of db.prepare(ARCHIVED_ERRANDS).all()) {
    checked += 1;
    const id = String(row.id);
    const found = task.get(id);
    const moved = found === undefined ? null : errandOf(found);
    if (moved === null) {
      mismatches.push({ id, field: 'missing' });
      continue;
    }
    const archived = parsed(row.record);
    const before = isObject(archived) ? archived : {};
    for (const key of new Set([...Object.keys(before), ...Object.keys(moved)])) {
      if (JSON.stringify(before[key]) !== JSON.stringify(moved[key])) mismatches.push({ id, field: key });
    }
  }
  return { checked, mismatches };
}
