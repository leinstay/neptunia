// The errand store's side of the board (src/errands/store.ts): its reads and its one write. `saveErrand` runs inside
// the memory writer's transaction (src/memory/db/errand-write.ts, write kind `errand`) as the actor `core`: the task
// filed when the errand is new, then brought to the errand as it stands, each change of status written with its
// `status` event and a move to an end with its outbox row to `persona`, and the closing journal line written by the
// caller in the same transaction. `errandsOf` and `pendingEnds` read the errands and their undelivered ends. The rows and the record map through src/board/archive.ts. Nothing here logs.

import {
  CLOSED,
  TASKS_WITH_HANDOFF,
  errandOf,
  insertHandoff,
  insertTask,
  metadataOf,
  stateOfStatus,
  statusOfState,
} from './archive.ts';
import type { ErrandData, Status } from './archive.ts';
import type { BoardDb } from './schema.ts';

/** The actor the errand store writes the board's events as. */
const ERRAND_ACTOR = 'core';
/** The one reader of a task's outbox rows: the persona's result turns (src/errands/turns.ts). */
const SUBSCRIBER = 'persona';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const filled = (value: unknown): value is string => typeof value === 'string' && value !== '';
const isClosed = (status: string): boolean => (CLOSED as ReadonlyArray<string>).includes(status);

// The memory database's handles hand over node:sqlite's connection, which has every method BoardDb names.
const boardDbOf = (db: unknown): BoardDb => db as BoardDb;

/** A `board_tasks` row as it is stored. */
export type ErrandTaskRow = {
  id: string;
  title: string;
  role: string;
  status: string;
  close_reason: string | null;
  created_at: string;
  updated_at: string;
  metadata: string | null;
};
const textOf = (value: unknown): string =>
  typeof value === 'string' ? value : typeof value === 'number' ? String(value) : '';
const textOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

function taskRowOf(row: Record<string, unknown>): ErrandTaskRow {
  return {
    id: textOf(row.id),
    title: textOf(row.title),
    role: textOf(row.role),
    status: textOf(row.status),
    close_reason: textOrNull(row.close_reason),
    created_at: textOf(row.created_at),
    updated_at: textOf(row.updated_at),
    metadata: textOrNull(row.metadata),
  };
}

const TASK_COLUMNS = 'id, title, role, status, close_reason, created_at, updated_at, metadata';

function readTask(db: BoardDb, id: string): ErrandTaskRow | null {
  const row = db.prepare(`SELECT ${TASK_COLUMNS} FROM board_tasks WHERE id = ?`).get(id);
  return row === undefined ? null : taskRowOf(row);
}

/** Every errand the board holds, in the order they were filed (`db` a read connection). */
export function errandsOf(db: unknown): Array<ErrandData> {
  return boardDbOf(db)
    .prepare(`${TASKS_WITH_HANDOFF} ORDER BY t.rowid`)
    .all()
    .map(errandOf)
    .filter((errand) => errand !== null);
}

/** One end the board committed whose `errand.done` has not been marked delivered. */
export type PendingEnd = { errandId: string; state: string };

/** The ends with an undelivered outbox row to `persona`, oldest first (`db` a read connection). */
export function pendingEnds(db: unknown): Array<PendingEnd> {
  const kinds = CLOSED.map(() => '?').join(',');
  return boardDbOf(db)
    .prepare(
      `SELECT o.task_id AS id, o.kind AS kind, MIN(o.seq) AS first FROM board_outbox o
      JOIN board_tasks t ON t.id = o.task_id
      WHERE o.to_whom = ? AND o.delivered_at IS NULL AND o.kind IN (${kinds})
      GROUP BY o.task_id ORDER BY first`
    )
    .all(SUBSCRIBER, ...CLOSED)
    .map((row) => ({ errandId: String(row.id), state: stateOfStatus(row.kind) }));
}

/** One write of the errand store: the errand as it stands (null: only the delivery mark), and whether its end was delivered. */
export type ErrandSave = {
  id: string;

  at: number;
  errand: ErrandData | null;
  delivered: boolean;
};

function writeEvent(db: BoardDb, id: string, old: string | null, status: Status, at: string): void {
  db.prepare('INSERT INTO board_events (task_id, actor, type, old, new, created_at) VALUES (?, ?, ?, ?, ?, ?)').run(
    id,
    ERRAND_ACTOR,
    'status',
    old,
    status,
    at
  );
}

/** The columns of a task an errand save writes besides its status. */
type TaskFields = { title: string; metadata: string; close_reason?: string | null };

/**
 * Moves `task` to `to` with `fields`: the row, its `status` event and, for an end, the outbox row to `persona` that
 * carries the task's id, title, status and close reason. Answers the task as it stands after the move.
 */
function move(db: BoardDb, task: ErrandTaskRow, to: Status, at: string, fields: Partial<TaskFields>): ErrandTaskRow {
  const moved: ErrandTaskRow = { ...task, ...fields, status: to, updated_at: at };
  db.prepare(
    'UPDATE board_tasks SET title = ?, metadata = ?, close_reason = ?, status = ?, updated_at = ? WHERE id = ?'
  ).run(moved.title, moved.metadata, moved.close_reason, to, at, task.id);
  writeEvent(db, task.id, task.status, to, at);
  if (isClosed(to)) {
    const payload = { task: moved.id, title: moved.title, status: to, close_reason: moved.close_reason };
    db.prepare('INSERT INTO board_outbox (task_id, to_whom, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)').run(
      task.id,
      SUBSCRIBER,
      to,
      JSON.stringify(payload),
      at
    );
  }
  return moved;
}

/**
 * Brings the board to `save` inside the caller's transaction: the task filed at `approved` when it is new, its fields
 * and status moved to the errand's (through `in_progress` when it started), `onEnd` called right after a move to an
 * end (the caller writes the closing journal line there), the result's handoff written once, and with `delivered` the
 * outbox rows of its end marked delivered. The store's own rules decide the state. A closed task never opens again,
 * and a save that changes nothing writes nothing. A failing statement throws, and the caller rolls back.
 */
function saveErrand(db: BoardDb, save: ErrandSave, onEnd: () => void): void {
  const at = new Date(save.at).toISOString();
  const errand = save.errand;
  if (errand !== null) {
    if (readTask(db, errand.id) === null) {
      insertTask(db, errand, at);
      writeEvent(db, errand.id, null, 'approved', at);
    }
    const filed = readTask(db, errand.id);
    if (filed === null) throw new Error(`errand task ${errand.id} is missing right after it was filed`);
    let task = filed;
    const fields: TaskFields = {
      metadata: metadataOf(errand),
      title: typeof errand.goal === 'string' ? errand.goal : task.title,
    };
    const target = statusOfState(errand.state);
    // Writes waiting together are one write of the latest: an errand that started on the way to its end still passes
    // through in_progress, so the task's history holds every state it was in.
    if (task.status === 'approved' && isClosed(target) && typeof errand.startedAt === 'number') {
      task = move(db, task, 'in_progress', at, {});
    }
    if (task.status !== target && !isClosed(task.status)) {
      const ending = isClosed(target);
      const moved: TaskFields = { ...fields };
      if (ending) moved.close_reason = typeof errand.error === 'string' ? errand.error : null;
      task = move(db, task, target, at, moved);
      if (ending) onEnd();
    } else if (task.metadata !== fields.metadata || task.title !== fields.title) {
      db.prepare('UPDATE board_tasks SET metadata = ?, title = ?, updated_at = ? WHERE id = ?').run(
        fields.metadata,
        fields.title,
        at,
        task.id
      );
    }
    const held = db.prepare("SELECT 1 AS ok FROM board_results WHERE task_id = ? AND kind = 'handoff'").get(task.id);
    const result = errand.result;
    if (held === undefined && result !== null && typeof result === 'object' && !Array.isArray(result)) {
      // A stored result is the JSON of an object (src/errands/types.ts#ErrandResult).
      insertHandoff(db, task.id, result as Record<string, unknown>, at);
    }
  }
  if (save.delivered) {
    db.prepare(
      'UPDATE board_outbox SET delivered_at = ? WHERE task_id = ? AND to_whom = ? AND delivered_at IS NULL'
    ).run(at, save.id, SUBSCRIBER);
  }
}

/** The closing journal line of an errand save: the place whose journal takes it and the line. */
export type ErrandClosing = { placeId: string | null; line: Record<string, unknown> };

/**
 * One write of the errand store on the writer's connection, inside its transaction: `value` is an ErrandSave with its
 * `closing` (`{ placeId, line }` or null), and `writeClosing` writes that line when the save moves the errand to an end.
 * Throws an Error coded `ERRAND_WRITE_ID` for a value with no errand id.
 */
export function applyErrandSave(
  db: unknown,
  value: Record<string, unknown>,
  at: number,
  writeClosing: (closing: ErrandClosing) => void
): { ended: boolean } {
  if (!filled(value.id)) {
    throw Object.assign(new Error('an errand write needs the errand id'), { code: 'ERRAND_WRITE_ID' });
  }
  const closing = isRecord(value.closing) ? value.closing : null;
  const errand = isRecord(value.errand) && filled(value.errand.id) ? { ...value.errand, id: value.errand.id } : null;
  const save: ErrandSave = {
    id: value.id,
    at: typeof value.at === 'number' && Number.isFinite(value.at) ? value.at : at,
    errand,
    delivered: value.delivered === true,
  };
  let ended = false;
  saveErrand(boardDbOf(db), save, () => {
    ended = true;
    if (closing !== null && isRecord(closing.line)) {
      const placeId = filled(closing.placeId) ? closing.placeId : null;
      writeClosing({ placeId, line: closing.line });
    }
  });
  return { ended };
}
