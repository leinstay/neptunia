// The errand store's side of the board (src/errands/store.ts): its reads and its one write. `saveErrand` runs inside
// the memory writer's transaction (src/memory/db/errand-write.ts, write kind `errand`) as the principal `core`: the task filed
// when the errand is new, then brought to the errand as it stands, an end moved through the board's own `move` (which
// writes the outbox row to the subscriber, `persona`) with the closing journal line written by the caller in the same
// transaction. `errandsOf` and `pendingEnds` read a place's errands and its undelivered ends. The rows and the record
// map through src/board/archive.ts. Nothing here logs.

import {
  TASKS_WITH_HANDOFF,
  errandOf,
  insertHandoff,
  insertTask,
  metadataOf,
  stateOfStatus,
  statusOfState,
} from './archive.ts';
import type { ErrandData } from './archive.ts';
import { Board } from './board.ts';
import { CLOSED } from './machine.ts';
import type { BoardDb } from './schema.ts';

/** The principal the errand store writes the board as (src/board/writer.ts#CORE_BUILTINS). */
const ERRAND_PRINCIPAL = 'core';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const filled = (value: unknown): value is string => typeof value === 'string' && value !== '';

// The memory database's handles hand over node:sqlite's connection, which has every method BoardDb names.
const boardDbOf = (db: unknown): BoardDb => db as BoardDb;

/** Every errand the board holds, in the order they were filed (`db` a read connection). */
export function errandsOf(db: unknown): Array<ErrandData> {
  return boardDbOf(db)
    .prepare(`${TASKS_WITH_HANDOFF} WHERE t.lane = 'errand' ORDER BY t.rowid`)
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
      WHERE o.to_whom = 'persona' AND o.delivered_at IS NULL AND o.kind IN (${kinds}) AND t.lane = 'errand'
      GROUP BY o.task_id ORDER BY first`
    )
    .all(...CLOSED)
    .map((row) => ({ errandId: String(row.id), state: stateOfStatus(row.kind) }));
}

/** One write of the errand store: the errand as it stands (null: only the delivery mark), and whether its end was delivered. */
export type ErrandSave = {
  id: string;

  at: number;
  errand: ErrandData | null;
  delivered: boolean;
};

// The errand store's moves need no lease, triage or project setting: the board's defaults stand.
const SETTINGS = Object.freeze({
  leaseTtlMinutes: 30,
  autoTriage: Object.freeze({ role: 'dev', budget: 4, steps: 80, estimate: 30 }),
  projects: Object.freeze({}),
});

/**
 * Brings the board to `save` inside the caller's transaction: the task filed at `approved` when it is new, its fields
 * and status moved to the errand's as `core` (through `in_progress` when it started), `onEnd` called right after a move to an end (the caller writes the
 * closing journal line there), the result's handoff written once, and with `delivered` the outbox rows of its end
 * marked delivered. The store's own rules decide the state, so the moves go past the role machine. A closed task never
 * opens again, and a save that changes nothing writes nothing. A failing statement throws, and the caller rolls back.
 */
function saveErrand(db: BoardDb, save: ErrandSave, onEnd: () => void): void {
  const at = new Date(save.at).toISOString();
  const board = new Board({ db, privateDir: '', now: () => save.at, settings: () => SETTINGS });
  const errand = save.errand;
  if (errand !== null) {
    if (db.prepare('SELECT 1 AS ok FROM board_tasks WHERE id = ?').get(errand.id) === undefined) {
      insertTask(db, errand, at);
      board.event(errand.id, ERRAND_PRINCIPAL, 'status', null, 'approved');
    }
    let task = board.getTask(errand.id);
    const fields = {
      metadata: metadataOf(errand),
      title: typeof errand.goal === 'string' ? errand.goal : task.title,
    };
    const target = statusOfState(errand.state);
    // Writes waiting together are one write of the latest: an errand that started on the way to its end still passes
    // through in_progress, so the task's history holds every state it was in.
    if (task.status === 'approved' && CLOSED.includes(target) && typeof errand.startedAt === 'number') {
      task = board.move(task, 'in_progress', ERRAND_PRINCIPAL);
    }
    if (task.status !== target && !CLOSED.includes(task.status)) {
      const ending = CLOSED.includes(target);
      const moved: Record<string, string | null> = { ...fields };
      if (ending) moved.close_reason = typeof errand.error === 'string' ? errand.error : null;
      task = board.move(task, target, ERRAND_PRINCIPAL, moved);
      if (ending) onEnd();
    } else if (task.metadata !== fields.metadata || task.title !== fields.title) {
      task = board.write(task, fields);
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
      "UPDATE board_outbox SET delivered_at = ? WHERE task_id = ? AND to_whom = 'persona' AND delivered_at IS NULL"
    ).run(at, save.id);
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
