// The board's operations as `task.*` commands of the core's socket. src/board/writer.ts runs each command of an agent
// (src/interface/neptunia-cli.ts hands it over) inside the memory writer, under the caller's name, so the board's own
// rights decide it. The names: a board op that starts with `task.` is the command of the same name, every other op
// takes the prefix (`task.attempt.end`, `task.costs.agents`, `task.outbox.pull`), and the command layer adds two of its
// own:
//   - `task.next { lane = 'dev', role }` claims the first ready task of the lane triaged for `role`, by priority, then
//     age, then filing order. It skips a task that waits for its brief: some client holds `reviewer`, the task's latest
//     attempt ended `needs_answer`, a question of it was answered at or after that end by a principal who holds no
//     `reviewer` role, no reviewer commented or updated the task since that answer, and less than `briefWaitMs` passed
//     since it by the board's clock. A claim another caller won goes on to the next task. Nothing ready is `ok` with no
//     data and writes nothing.
//   - `task.events { from = 0, limit = 1000 }` answers the board's events after `from`.
// Two arguments are the command layer's and never reach the board: `json` (true: the text is the data's JSON) and
// `idempotency` (the key of `Board.call`). A holder call carries the generation of its lease: `task.heartbeat`,
// `task.release`, `task.block`, `task.submit` and `task.attempt.end` always, `task.result` and `task.ask` when the
// caller holds the task's lease. One without it is refused `invalid` before the board is called, so a worker cut off
// from its lease cannot write over the next holder's. Every answer is `{ status, text, data }`: `ok`, or the board's
// error code with its message and no data (`board-unavailable` with no board, `error` for any other failure). The
// plain text is the ledger's command line's (src/board/text.ts). Nothing here logs.

import { BOARD_OPS } from './board.ts';
import type { Board, BoardOp, TaskRecord } from './board.ts';
import { BoardError } from './machine.ts';
import { answerText } from './text.ts';

/** One command's answer: its status, the text a caller prints, and the board's data (null on a refusal). */
export type TaskAnswer = { status: string; text: string; data: unknown };

/** What the command layer reads at each command: the board (null while it is not open) and the brief wait. */
export type TaskCommandDeps = { board: () => Board | null; briefWaitMs: () => number };

type Args = Record<string, unknown>;

const PREFIX = 'task.';
// The holder calls that always carry the lease's generation, and the ones that do when the caller holds the lease.
const ALWAYS_HOLDER: ReadonlyArray<BoardOp> = [
  'task.heartbeat',
  'task.release',
  'task.block',
  'task.submit',
  'attempt.end',
];
const HOLDER_WHEN_LEASED: ReadonlyArray<BoardOp> = ['task.result', 'task.ask'];
const EVENTS_LIMIT = 1000;

const refusal = (status: string, text: string): TaskAnswer => ({ status, text, data: null });

const invalid = (message: string): BoardError => new BoardError('invalid', message);

/** The board op the command `name` reaches, or null for a name that is no board command. */
function opOf(name: string): BoardOp | null {
  if (!name.startsWith(PREFIX)) return null;
  const own = BOARD_OPS.find((op) => op === name);
  if (own !== undefined) return own;
  const rest = name.slice(PREFIX.length);
  return BOARD_OPS.find((op) => op === rest && !op.startsWith(PREFIX)) ?? null;
}

/** Throws BoardError 'invalid' for a holder call without its generation, before the board writes anything. */
function requireGeneration(board: Board, principal: string, name: string, op: BoardOp, args: Record<string, unknown>) {
  if (args.generation !== undefined && args.generation !== null) return;
  if (ALWAYS_HOLDER.includes(op)) throw invalid(`${name} needs the generation of the lease`);
  if (!HOLDER_WHEN_LEASED.includes(op)) return;
  let leaseOwner: string | null = null;
  try {
    leaseOwner = board.getTask(args.id).lease_owner;
  } catch {
    // An unknown task or a board that is down: the board's own call answers it.
    return;
  }
  if (leaseOwner === principal) throw invalid(`${name} by the holder needs the generation of the lease`);
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');

/** Whether `task` waits for its brief: see the head of this file. */
function awaitingBrief(board: Board, task: TaskRecord, briefWaitMs: number): boolean {
  const reviewers = [...board.rolesNow()].filter(([, roles]) => roles.has('reviewer')).map(([name]) => name);
  if (reviewers.length === 0) return false;
  const last = board.db
    .prepare('SELECT outcome, ended_at FROM board_attempts WHERE task_id = ? ORDER BY n DESC LIMIT 1')
    .get(task.id);
  if (last === undefined || last.outcome !== 'needs_answer') return false;
  const answer = board.db
    .prepare(
      `SELECT answered_by, answered_at FROM board_questions WHERE task_id = ? AND answered_at IS NOT NULL
      AND answered_at >= ? ORDER BY answered_at DESC, rowid DESC LIMIT 1`
    )
    .get(task.id, text(last.ended_at));
  if (answer === undefined || reviewers.includes(text(answer.answered_by))) return false;
  const answeredAt = text(answer.answered_at);
  const marks = reviewers.map(() => '?').join(',');
  const acted = board.db
    .prepare(
      `SELECT 1 FROM board_comments WHERE task_id = ? AND created_at >= ? AND author IN (${marks})
      UNION ALL SELECT 1 FROM board_events WHERE task_id = ? AND created_at >= ? AND type = 'task.updated'
      AND actor IN (${marks}) LIMIT 1`
    )
    .get(task.id, answeredAt, ...reviewers, task.id, answeredAt, ...reviewers);
  if (acted !== undefined) return false;
  return board.clock() - Date.parse(answeredAt) < briefWaitMs;
}

/** `task.next`: the claim of the first ready task of the lane and role (see the head of this file), or null. */
function nextTask(board: Board, principal: string, args: Record<string, unknown>, briefWaitMs: number) {
  const role = args.role;
  if (typeof role !== 'string' || role === '') throw invalid('task.next needs a role');
  const lane = args.lane ?? 'dev';
  if (typeof lane !== 'string') throw invalid('lane must be a string');
  const ready = board.call(principal, 'task.list', { lane, ready: true }).filter((task) => task.role === role);
  for (const task of ready) {
    if (awaitingBrief(board, task, briefWaitMs)) continue;
    try {
      return board.call(principal, 'task.claim', { id: task.id });
    } catch (error) {
      // Another caller claimed it or a blocker opened between the list and the claim: the next one.
      if (error instanceof BoardError && (error.code === 'claimed' || error.code === 'blocked')) continue;
      throw error;
    }
  }
  return null;
}

/** `task.events`: the events after `from`, at most `limit`; for a principal with a board role only. */
function eventsOf(board: Board, principal: string, args: Record<string, unknown>) {
  if (!board.rolesNow().has(principal)) throw new BoardError('forbidden', `${principal} holds no board role`);
  const from = args.from ?? 0;
  const limit = args.limit ?? EVENTS_LIMIT;
  if (typeof from !== 'number' || !Number.isInteger(from) || from < 0) throw invalid('from must be a sequence number');
  if (typeof limit !== 'number' || !Number.isInteger(limit) || limit < 1 || limit > EVENTS_LIMIT) {
    throw invalid(`limit must be an integer from 1 to ${EVENTS_LIMIT}`);
  }
  return board.eventsSince(from, limit);
}

/** The data of one command: the command layer's own two, or the board op it reaches. */
function dataOf(deps: TaskCommandDeps, board: Board, call: { principal: string; name: string }, given: Args): unknown {
  const { principal, name } = call;
  const { idempotency, ...args } = given;
  if (idempotency !== undefined && typeof idempotency !== 'string') throw invalid('idempotency must be a string');
  if (name === 'task.next') return nextTask(board, principal, args, deps.briefWaitMs());
  if (name === 'task.events') return eventsOf(board, principal, args);
  const op = opOf(name);
  if (op === null) throw invalid(`unknown command ${name}`);
  requireGeneration(board, principal, name, op, args);
  return board.call(principal, op, args, idempotency ?? null);
}

/**
 * One `task.*` command of `principal`, run at once on the calling thread: the memory writer runs it in one message,
 * so no other write comes between the list and the claim of `task.next`. Never throws.
 */
export function runTaskCommand(
  deps: TaskCommandDeps,
  principal: string,
  name: string,
  given: Readonly<Record<string, unknown>>
): TaskAnswer {
  const board = deps.board();
  if (board === null) return refusal('board-unavailable', 'the task board is not open');
  const { json, ...rest } = given;
  try {
    const data = dataOf(deps, board, { principal, name }, rest);
    return { status: 'ok', text: json === true ? JSON.stringify(data, null, 2) : answerText(name, data, rest), data };
  } catch (error) {
    if (error instanceof BoardError) return refusal(error.code, error.message);
    return refusal('error', error instanceof Error ? error.message : String(error));
  }
}

/** The `task.*` commands over the board `deps.board()` reads at each command. */
export function createTaskCommands(deps: TaskCommandDeps): {
  run(principal: string, name: string, args: Readonly<Record<string, unknown>>): Promise<TaskAnswer>;
} {
  return { run: (principal, name, args) => Promise.resolve(runTaskCommand(deps, principal, name, args)) };
}
