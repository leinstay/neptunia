// The task board's writes as writes of the memory writer. The core never holds a board of its own: each agent's
// command, each board call of her tools and each beat of the reaper is one write of kind `board` of the memory
// database's writer (src/memory/db/service.js#memoryWrite), and `applyBoardWrite` runs it there on the writer's
// connection, at once and whole, so nothing else writes between a `task.next` list and its claim.
// The message carries everything the board reads: the caller, the core's clock at the call (`at`), the live
// `board.*` settings (src/board/board.ts#boardSettings), the brief wait and the private directory whose
// `clients.json` grants the roles. Her principal `persona` is a builtin with the board role `persona` alone.
// `createBoardPort` is the core's side: the commands, the calls (a refusal comes back as the BoardError it was) and the
// reap over one `write` function. Nothing here logs.

import { openBoard } from './board.ts';
import type { Board, BoardBuiltins, BoardOp, BoardResults, BoardSettings } from './board.ts';
import { runTaskCommand } from './commands.ts';
import type { TaskAnswer } from './commands.ts';
import { BoardError, ERROR_CODES } from './machine.ts';
import type { BoardErrorCode } from './machine.ts';
import type { BoardDb } from './schema.ts';

/** The principals the core itself calls the board as: her tools run as `persona`, which may file and read only. */
export const CORE_BUILTINS: BoardBuiltins = Object.freeze({ persona: Object.freeze(['persona'] as const) });

/** What every board write carries from the core. */
type Context = { at: number; settings: BoardSettings; privateDir: string };

/** One board write, as the memory writer receives it. */
export type BoardWrite =
  | (Context & { kind: 'command'; principal: string; name: string; args: Record<string, unknown>; briefWaitMs: number })
  | (Context & {
      kind: 'call';
      principal: string;
      op: BoardOp;
      args: Record<string, unknown>;
      idempotency: string | null;
    })
  | (Context & { kind: 'reap' });

/** The answer of a `call`: its result, or the board's refusal as plain data (it crosses a thread). */
export type CallAnswer = { ok: true; result: unknown } | { ok: false; code: BoardErrorCode; message: string };

function boardOf(db: BoardDb, write: Context): Board {
  return openBoard({
    db,
    privateDir: write.privateDir,
    now: () => write.at,
    settings: () => write.settings,
    builtins: CORE_BUILTINS,
  });
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const WRITE_KINDS: ReadonlyArray<unknown> = ['command', 'call', 'reap'];

/**
 * Runs one `board` write of the memory writer (src/memory/db/session-write.js#applyMemoryWrite) on its handle's
 * connection: a command's answer, a call's answer, or the reaped ids. `update` is `{ kind: 'board', write }`. Throws
 * an Error coded `BAD_UPDATE` for a handle with no connection or a write of no known kind.
 */
export function applyBoardWrite(handle: unknown, update: unknown): TaskAnswer | CallAnswer | Array<string> {
  const db = isRecord(handle) && isRecord(handle.db) ? handle.db : null;
  const given = isRecord(update) && isRecord(update.write) ? update.write : null;
  if (db === null || given === null || !WRITE_KINDS.includes(given.kind)) {
    throw Object.assign(new Error('a board write needs the writer handle and a command, call or reap'), {
      code: 'BAD_UPDATE',
    });
  }
  // The handle is open.js's: node:sqlite's connection, which has every method BoardDb names. The write is the
  // BoardWrite createBoardPort built in the same process family, its kind checked above.
  const write = given as unknown as BoardWrite;
  const board = boardOf(db as unknown as BoardDb, write);
  switch (write.kind) {
    case 'command':
      return runTaskCommand(
        { board: () => board, briefWaitMs: () => write.briefWaitMs },
        write.principal,
        write.name,
        write.args
      );
    case 'call':
      try {
        return { ok: true, result: board.call(write.principal, write.op, write.args, write.idempotency) };
      } catch (error) {
        if (error instanceof BoardError) return { ok: false, code: error.code, message: error.message };
        throw error;
      }
    case 'reap':
      return board.reap();
  }
}

/** The code of a refused memory write (`DB_CLOSED`, `WORKER_EXIT`), or null for an error without one. */
const codeOf = (error: unknown): string | null =>
  isRecord(error) && typeof error.code === 'string' && error.code !== '' ? error.code : null;

const isCode = (value: unknown): value is BoardErrorCode =>
  typeof value === 'string' && (ERROR_CODES as ReadonlyArray<string>).includes(value);

/** The board as the core uses it: every method one write through `write`, the context filled by `context()`. */
export type BoardPort = {
  command(principal: string, name: string, args: Record<string, unknown>): Promise<TaskAnswer>;
  call<TOp extends BoardOp>(
    principal: string,
    op: TOp,
    args?: Readonly<Record<string, unknown>>,
    idempotency?: string | null
  ): Promise<BoardResults[TOp]>;
  reap(): Promise<Array<string>>;
};

/**
 * The core's board over `write` (a `board` write of the memory writer's `memoryWrite`), each write given the context `context()` reads at
 * that moment and the brief wait `briefWaitMs()`. A command whose write the memory writer refuses (the memory database
 * is not open) answers `board-unavailable`; a call rejects with the BoardError of its refusal, or the write's own
 * error; a reap while the database is not open reaps nothing.
 */
export function createBoardPort(deps: {
  write: (write: BoardWrite) => Promise<unknown>;
  context: () => Context;
  briefWaitMs: () => number;
}): BoardPort {
  return {
    async command(principal, name, args) {
      let answer: unknown;
      try {
        answer = await deps.write({
          ...deps.context(),
          kind: 'command',
          principal,
          name,
          args,
          briefWaitMs: deps.briefWaitMs(),
        });
      } catch (error) {
        // A write the memory writer refused (its code: the database is not open, its worker stopped) leaves the board
        // unreachable; any other throw is a failure of the command itself, such as a broken `board.*` setting.
        const code = codeOf(error);
        if (code !== null)
          return { status: 'board-unavailable', text: `the task board is not open (${code})`, data: null };
        return { status: 'error', text: error instanceof Error ? error.message : String(error), data: null };
      }
      // applyBoardWrite answers a command with its TaskAnswer.
      return answer as TaskAnswer;
    },
    async call(principal, op, args = {}, idempotency = null) {
      const answer = await deps.write({
        ...deps.context(),
        kind: 'call',
        principal,
        op,
        args: { ...args },
        idempotency,
      });
      if (!isRecord(answer)) throw new BoardError('board-unavailable', 'the board gave no answer');
      if (answer.ok !== true) {
        throw new BoardError(isCode(answer.code) ? answer.code : 'board-unavailable', String(answer.message));
      }
      // A call's result is the answer of its op (BoardResults[op]), as Board.call returned it in the writer.
      return answer.result as BoardResults[typeof op];
    },
    async reap() {
      let ids: unknown;
      try {
        ids = await deps.write({ ...deps.context(), kind: 'reap' });
      } catch (error) {
        // While the memory database is not open there is no lease to reap.
        if (codeOf(error) === 'DB_CLOSED') return [];
        throw error;
      }
      return Array.isArray(ids) ? ids.map(String) : [];
    },
  };
}
