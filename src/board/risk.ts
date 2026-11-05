// A task's risk on the board (src/board/board.ts calls these inside its transaction). `task.risk` records who set the
// level and why. Only the owner lowers a task, and nobody lowers one below its highest dev task; a level set before
// triage and never recorded is the filer's wish and moves freely. A raise climbs to every open parent, so the task that
// opens the pull request never reads lower than a step under it. `task.risk.held` tells the persona once why her green
// task waits for the owner.

import type { Board, TaskRow } from './board.ts';
import { SELF, invalid, str } from './fields.ts';
import type { Args, SqlValue } from './fields.ts';
import { BoardError, CLOSED } from './machine.ts';
import type { BoardDb } from './schema.ts';

type Risk = TaskRow['risk'];

const RANK: Readonly<Record<Risk, number>> = { low: 0, normal: 1, high: 2 };
/** A reason of `task.risk.held` is a code, so a model's free text can never reach her through it. */
const HOLD_CODE = /^[a-z][a-z-]{0,39}$/;

const isRisk = (value: unknown): value is Risk => value === 'low' || value === 'normal' || value === 'high';

/** Whether a `task.risk` event names this task: an assessment stays on the record however many events follow it. */
export function hasRiskRecord(db: BoardDb, id: string): boolean {
  return (
    db.prepare("SELECT 1 FROM board_events WHERE task_id = ? AND type = 'task.risk' LIMIT 1").get(id) !== undefined
  );
}

function highestChild(board: Board, id: string): number {
  const rows = board.db
    .prepare(
      `SELECT c.risk AS risk FROM board_dependencies d JOIN board_tasks c ON c.id = d.task_id
      WHERE d.depends_on_id = ? AND d.type = 'parent-child'`
    )
    .all(id);
  return Math.max(0, ...rows.map((row) => (isRisk(row.risk) ? RANK[row.risk] : 0)));
}

/** Refuses with 'risk-lowered' a level in `fields` that lowers the task for this principal; any other level passes. */
export function refuseLowering(
  board: Board,
  principal: string,
  task: TaskRow,
  fields: Readonly<Record<string, SqlValue>>
): void {
  const to = fields.risk;
  if (!isRisk(to) || RANK[to] >= RANK[task.risk]) return;
  const refuse = (why: string): BoardError =>
    new BoardError('risk-lowered', `${task.id} stays at ${task.risk}: ${why}`);
  if (RANK[to] < highestChild(board, task.id)) throw refuse('a dev task under it is higher');
  if (board.grantsOf(principal).has('owner')) return;
  if (task.status === 'proposed' && !hasRiskRecord(board.db, task.id)) return;
  throw refuse('only the owner lowers a task');
}

/** Raises every open parent of `child` that reads lower than it, and theirs, each with its own record. */
export function climbRisk(board: Board, principal: string, child: TaskRow): void {
  const parents = board.db
    .prepare("SELECT depends_on_id FROM board_dependencies WHERE task_id = ? AND type = 'parent-child'")
    .all(child.id);
  for (const row of parents) {
    const parent = board.getTask(row.depends_on_id);
    if (CLOSED.includes(parent.status) || RANK[parent.risk] >= RANK[child.risk]) continue;
    const raised = board.write(parent, { risk: child.risk });
    board.event(parent.id, principal, 'task.risk', parent.risk, { risk: child.risk, reason: `dev task ${child.id}` });
    climbRisk(board, principal, raised);
  }
}

/** `task.risk`: the level with its reason on the record. The level the task already has is an assessment too. */
export function assessRisk(board: Board, principal: string, args: Args): TaskRow {
  const task = board.getTask(args.id);
  board.requireEditor(principal, task);
  if (CLOSED.includes(task.status)) throw new BoardError('invalid-transition', `${task.id} is ${task.status}`);
  const { risk } = args;
  if (!isRisk(risk)) throw invalid('risk must be low, normal or high');
  const reason = str(args.reason, 'reason', { required: true, max: 2000 });
  refuseLowering(board, principal, task, { risk });
  const updated = risk === task.risk ? task : board.write(task, { risk });
  board.event(task.id, principal, 'task.risk', task.risk, { risk, reason });
  climbRisk(board, principal, updated);
  return updated;
}

/**
 * `task.risk.held`: one outbox row to the persona with a reason that is a code, for the owner or a reviewer. A delivered
 * row still counts, and a repeat writes nothing, no event either, so a look that repeats it wakes nobody.
 */
export function tellHeld(board: Board, principal: string, args: Args): TaskRow {
  const task = board.getTask(args.id);
  const grants = board.grantsOf(principal);
  if (!grants.has('owner') && !grants.has('reviewer')) {
    throw new BoardError('forbidden', `${principal} may not speak for the merge gate`);
  }
  const reason = str(args.reason, 'reason', { required: true, max: 40 }) ?? '';
  if (!HOLD_CODE.test(reason)) throw invalid('reason must be a category code');
  const told = board.db.prepare("SELECT 1 FROM board_outbox WHERE task_id = ? AND kind = 'risk' LIMIT 1").get(task.id);
  if (told === undefined) {
    board.notify(task.id, SELF, 'risk', { task: task.id, title: task.title, status: task.status, reason });
  }
  return task;
}
