// Operations `board.propose` and `board.status`: her side of the task board (src/board/). `board.propose` files a
// `dev` task in `proposed` with her evidence as its description, `persona:self` as its requester and subscriber, so
// the owner or a reviewer decides whether it is done; `board.status` reads back every task filed for her with its
// questions and its reviews. Both run against the board the core gives the operations' environment (`env.board`,
// src/board/writer.ts#createBoardPort) as the builtin principal `persona`, whose only board role is `persona`: she
// files and reads, and never approves, reviews or merges. Every member may use them while `features.memberCommands`
// is on (rights.member); neither is granted to her in the tracked config. A board refusal is `invalid` for bad
// arguments, `denied` for `forbidden` and `failed` otherwise. Answers are operator lines (ids, states, titles).

import { defineOp, perEnv, invalid } from './registry.ts';
import { clampWithEllipsis, oneLine } from '../../memory/clamp.js';
import { CODE } from '../codes.ts';
import { textOf } from '../types.ts';
import type { Obj, OpContext } from '../types.ts';
import { BoardError } from '../../board/machine.ts';
import type { BoardOp, BoardResults, Row, TaskRecord } from '../../board/board.ts';

/** The board as her operations call it: the core's port (a promise per call) or a board in the same thread. */
export type BoardCaller = {
  call<TOp extends BoardOp>(
    principal: string,
    op: TOp,
    args?: Readonly<Record<string, unknown>>,
    idempotency?: string | null
  ): BoardResults[TOp] | Promise<BoardResults[TOp]>;
};

/** The principal her calls run as, and the name she files under. */
const PERSONA = 'persona';
const SELF = 'persona:self';
/** The title of a task in an answer line (characters). */
const TITLE_LINE_CHARS = 80;

/** One task filed for her, as `board.status` answers it. */
export type BoardStatusEntry = { task: TaskRecord; questions: Array<Row>; reviews: Array<Row> };

/** A board refusal as an operation's result: the status by its kind, the board's code where the catalogue has it. */
function refused(error: BoardError) {
  if (error.code === 'invalid') throw invalid(error.message);
  const code = error.code === 'not-found' ? CODE.NOT_FOUND : error.code === 'forbidden' ? CODE.FORBIDDEN : null;
  return {
    status: error.code === 'forbidden' ? 'denied' : 'failed',
    code: code ?? (error.code === 'board-unavailable' ? CODE.BOARD_UNAVAILABLE : CODE.ERROR),
    summary: `task board: ${error.message}`,
    data: null,
  };
}

const unavailable = () => ({
  status: 'failed',
  code: CODE.BOARD_UNAVAILABLE,
  summary: 'task board: not open',
  data: null,
});

const handlers = perEnv((env) => {
  /** The board of the environment, null when the core has none. */
  const boardOf = (): BoardCaller | null => env.board;

  async function guarded<T>(run: (board: BoardCaller) => Promise<T>) {
    const board = boardOf();
    if (board === null) return unavailable();
    try {
      return await run(board);
    } catch (error) {
      if (error instanceof BoardError) return refused(error);
      throw error;
    }
  }

  /** `board.propose { title, evidence, acceptance? }`: a proposed dev task filed for her. */
  function cmdPropose(args: Obj, context: OpContext) {
    const title = textOf(args.title).trim();
    const evidence = textOf(args.evidence).trim();
    if (!title) throw invalid('a title is required');
    if (!evidence) throw invalid('the evidence is required');
    const acceptance = textOf(args.acceptance).trim();
    const key = typeof context?.idempotencyKey === 'string' ? context.idempotencyKey : null;
    return guarded(async (board) => {
      const task = await board.call(
        PERSONA,
        'task.add',
        {
          lane: 'dev',
          title,
          description: evidence,
          ...(acceptance ? { acceptance } : {}),
          requester: SELF,
          subscriber: SELF,
        },
        key
      );
      return { status: 'ok', code: CODE.OK, summary: `task ${task.id}: ${task.status}`, data: { task } };
    });
  }

  /** `board.status`: every task filed for her, in the board's order, with its questions and reviews. */
  function cmdStatus() {
    return guarded(async (board) => {
      const tasks = await board.call(PERSONA, 'task.list', { requester: SELF });
      const entries: Array<BoardStatusEntry> = [];
      for (const task of tasks) {
        const view = await board.call(PERSONA, 'task.show', { id: task.id });
        entries.push({ task: view.task, questions: view.questions, reviews: view.approvals });
      }
      const lines = entries.map(({ task, questions }) => {
        const open = questions.filter((question) => !question.answered_at).length;
        return `${task.id} ${task.status} ${clampWithEllipsis(oneLine(task.title), TITLE_LINE_CHARS)}${open > 0 ? ` (${open} open questions)` : ''}`;
      });
      return {
        status: 'ok',
        code: CODE.OK,
        summary: lines.length > 0 ? lines.join('\n') : 'no tasks filed',
        data: { tasks: entries },
      };
    });
  }

  return { cmdPropose, cmdStatus };
});

defineOp({
  name: 'board.propose',
  rights: { kind: 'write', member: true },
  run: (args, ctx) => handlers(ctx.env).cmdPropose(args, ctx),
});
defineOp({
  name: 'board.status',
  rights: { kind: 'read', member: true },
  run: (_args, ctx) => handlers(ctx.env).cmdStatus(),
});
