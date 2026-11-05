// Operations `task.propose`, `task.status`, `task.cancel`, `task.comment`, `task.answer` and `task.unblock`: her side of the task
// board (src/board/). `task.propose` files a `dev` task in `proposed` with her evidence as its description,
// `persona:self` as its requester and subscriber, so the owner or a reviewer decides whether it is done, and refuses a
// title she already has open (`duplicate-task`, naming that task); `task.status` reads back every task filed for her
// with its questions and its reviews. The others act on a task of hers: cancel it, comment on it, answer the open
// question addressed to her, lift its block. A question addressed to her is hers to answer whoever filed its task. All run against the board the core gives the operations' environment (`env.board`,
// src/board/writer.ts#createBoardPort) as the builtin principal `persona`, whose only board role is `persona`: she
// files, reads and answers, and never approves, reviews or merges. Every member may use the first two while
// `features.memberCommands` is on (rights.member); none is granted to her in the tracked config. A board refusal is
// `invalid` for bad arguments, `denied` for `forbidden` and `failed` otherwise. Answers are operator lines (ids, states,
// titles).

import { defineOp, perEnv, invalid } from './registry.ts';
import { clampWithEllipsis, oneLine } from '../../memory/clamp.ts';
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

/** One task filed for her, as `task.status` answers it. */
export type BoardStatusEntry = { task: TaskRecord; questions: Array<Row>; reviews: Array<Row> };

/** A board refusal as an operation's result: the status by its kind, the board's code where the catalogue has it. */
function refused(error: BoardError) {
  if (error.code === 'invalid') throw invalid(error.message);
  if (error.code === 'duplicate')
    return {
      status: 'denied',
      code: CODE.DUPLICATE_TASK,
      summary: `task board: already open as ${error.message}`,
      data: { text: error.message },
    };
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

/** The fields a proposal of a kind carries, besides the title and the evidence. */
const KIND_FIELDS: ReadonlyArray<string> = ['kind', 'examples', 'counterexamples', 'benefit', 'evaluation'];
/** The kinds of a proposal that ask for a skill or for a change of her code. */
const PROPOSAL_KINDS: ReadonlyArray<string> = ['skill', 'fix'];

/** A list of non-empty strings, or null when `value` is not one. */
function stringList(value: unknown): Array<string> | null {
  if (!Array.isArray(value)) return null;
  const items = value.map((item) => textOf(item).trim());
  return items.every((item) => item !== '') ? items : null;
}

/**
 * The task metadata of a proposal with a `kind`: the kind, at least one example, the counterexamples (none by
 * default), the expected benefit and an evaluation case. Null when she gave none of the fields; a refusal when she
 * gave some and the set is not whole or the kind is not one of the two.
 */
function proposalMetadata(args: Obj): Obj | null {
  const given = KIND_FIELDS.filter((name) => args[name] !== undefined && args[name] !== null);
  if (given.length === 0) return null;
  const kind = textOf(args.kind).trim();
  if (!PROPOSAL_KINDS.includes(kind)) throw invalid(`kind: ${PROPOSAL_KINDS.join(' or ')}`);
  const examples = stringList(args.examples);
  if (examples === null || examples.length === 0) throw invalid('examples: at least one turn or case');
  const counterexamples = args.counterexamples === undefined ? [] : stringList(args.counterexamples);
  if (counterexamples === null) throw invalid('counterexamples: a list of cases, or none');
  const benefit = textOf(args.benefit).trim();
  if (!benefit) throw invalid('benefit: what gets better');
  const evaluation = textOf(args.evaluation).trim();
  if (!evaluation) throw invalid('evaluation: how to tell the change works');
  return { kind, examples, counterexamples, benefit, evaluation };
}

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

  /** `task.propose { title, evidence, acceptance?, kind?, ... }`: a proposed dev task filed for her. */
  function cmdPropose(args: Obj, context: OpContext) {
    const title = textOf(args.title).trim();
    const evidence = textOf(args.evidence).trim();
    if (!title) throw invalid('a title is required');
    if (!evidence) throw invalid('the evidence is required');
    const acceptance = textOf(args.acceptance).trim();
    const metadata = proposalMetadata(args);
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
          ...(metadata === null ? {} : { metadata }),
          requester: SELF,
          subscriber: SELF,
          unique_open_title: true,
        },
        key
      );
      return { status: 'ok', code: CODE.OK, summary: `task ${task.id}: ${task.status}`, data: { task } };
    });
  }

  /** `task.status`: every task filed for her, in the board's order, with its questions and reviews. */
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

  /** The view of `id` when the task is hers; any other is refused, whatever the shared board role would allow. */
  async function herTask(board: BoardCaller, id: string) {
    const view = await board.call(PERSONA, 'task.show', { id });
    if (view.task.requester !== SELF) throw new BoardError('forbidden', `${id} is not filed for her`);
    return view;
  }

  /** The named argument as text, refused when it is empty. */
  function required(args: Obj, name: string): string {
    const value = textOf(args[name]).trim();
    if (!value) throw invalid(`${name} is required`);
    return value;
  }

  /** `task.cancel { id, reason }`: her task cancelled with her reason, at its current revision. */
  function cmdCancel(args: Obj) {
    const id = required(args, 'id');
    const reason = required(args, 'reason');
    return guarded(async (board) => {
      const { task } = await herTask(board, id);
      const status = 'cancelled';
      const moved = await board.call(PERSONA, 'task.transition', {
        id,
        status,
        revision: task.revision,
        close_reason: reason,
      });
      return { status: 'ok', code: CODE.OK, summary: `task ${moved.id}: ${moved.status}`, data: { task: moved } };
    });
  }

  /** `task.comment { id, text }`: her comment on her task; the status stays. */
  function cmdComment(args: Obj) {
    const id = required(args, 'id');
    const text = required(args, 'text');
    return guarded(async (board) => {
      await herTask(board, id);
      const { task } = await board.call(PERSONA, 'task.comment', { id, text });
      return { status: 'ok', code: CODE.OK, summary: `task ${task.id}: comment added`, data: { task } };
    });
  }

  /** The open question on task `id` addressed to her. */
  async function openQuestionOn(board: BoardCaller, id: string): Promise<string> {
    const { questions } = await board.call(PERSONA, 'task.show', { id });
    const open = questions.find((question) => !question.answered_at && question.to_whom === SELF);
    if (open === undefined) throw new BoardError('not-found', `${id} has no question for her`);
    return String(open.id);
  }

  /**
   * `task.answer { id, text }` or `task.answer { question_id, text }`: her answer to the open question addressed to
   * her on task `id`, or to that question, so its holder goes on. The board refuses a question addressed to anyone else.
   */
  function cmdAnswer(args: Obj) {
    const questionId = textOf(args.question_id).trim();
    const id = questionId ? '' : required(args, 'id');
    const text = required(args, 'text');
    return guarded(async (board) => {
      const question_id = questionId || (await openQuestionOn(board, id));
      const { task } = await board.call(PERSONA, 'task.answer', { question_id, text });
      return { status: 'ok', code: CODE.OK, summary: `task ${task.id}: ${task.status}`, data: { task } };
    });
  }

  /** `task.unblock { id, note }`: her task back to approved, with what she decided as a comment for whoever goes on. */
  function cmdUnblock(args: Obj) {
    const id = required(args, 'id');
    const note = required(args, 'note');
    return guarded(async (board) => {
      await herTask(board, id);
      const moved = await board.call(PERSONA, 'task.unblock', { id, note });
      return { status: 'ok', code: CODE.OK, summary: `task ${moved.id}: ${moved.status}`, data: { task: moved } };
    });
  }

  return { cmdPropose, cmdStatus, cmdCancel, cmdComment, cmdAnswer, cmdUnblock };
});

defineOp({
  name: 'task.propose',
  rights: { kind: 'write', member: true },
  run: (args, ctx) => handlers(ctx.env).cmdPropose(args, ctx),
});
defineOp({
  name: 'task.status',
  rights: { kind: 'read', member: true },
  run: (_args, ctx) => handlers(ctx.env).cmdStatus(),
});
defineOp({
  name: 'task.cancel',
  rights: { kind: 'write' },
  run: (args, ctx) => handlers(ctx.env).cmdCancel(args),
});
defineOp({
  name: 'task.comment',
  rights: { kind: 'write' },
  run: (args, ctx) => handlers(ctx.env).cmdComment(args),
});
defineOp({
  name: 'task.answer',
  rights: { kind: 'write' },
  run: (args, ctx) => handlers(ctx.env).cmdAnswer(args),
});
defineOp({
  name: 'task.unblock',
  rights: { kind: 'write' },
  run: (args, ctx) => handlers(ctx.env).cmdUnblock(args),
});
