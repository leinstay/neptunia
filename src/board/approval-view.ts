// What waits for the owner on the board, read and answered through the board's own operations: a triaged task is a plan gate,
// a task waiting for validation a merge gate with its handoff. An answer is `task.approve` under the caller's name, so the
// board's rights, its revision check and its review row decide, whatever a panel showed. Nothing here claims a task, starts
// an executor or adds a merge policy of its own. src/board/commands.ts runs both inside the memory writer.

import type { Board, Handoff } from './board.ts';
import { BoardError } from './machine.ts';

export type ApprovalGate = {
  taskId: string;
  scope: 'plan' | 'merge';
  revision: number;
  title: string;
  handoff: Handoff | null;
};

/** One answer to a gate, naming the revision it was shown. */
export type ApprovalAnswer = {
  taskId: string;
  scope: ApprovalGate['scope'];
  revision: number;
  decision: 'approve' | 'reject';
  note?: string;
};

export type ApprovalResult =
  { status: 'ok'; taskStatus: string } | { status: 'refused'; code: string; message: string };

const SCOPE_OF: Readonly<Record<string, ApprovalGate['scope']>> = { triaged: 'plan', needs_validation: 'merge' };

/** The gates `principal` can see, oldest first as the board lists them. Reading writes nothing. */
export function pendingApprovals(board: Board, principal: string): Array<ApprovalGate> {
  return board.call(principal, 'task.list', { lane: 'dev' }).flatMap((task) => {
    const scope = Object.hasOwn(SCOPE_OF, task.status) ? SCOPE_OF[task.status] : undefined;
    if (scope === undefined) return [];
    const handoff = scope === 'merge' ? board.call(principal, 'task.show', { id: task.id }).handoff : null;
    return [{ taskId: task.id, scope, revision: task.revision, title: task.title, handoff }];
  });
}

/** Hands one answer to the board. A refusal of the board comes back as data, so a task gone meanwhile ends no panel. */
export function answerApproval(board: Board, principal: string, answer: ApprovalAnswer): ApprovalResult {
  const { taskId, scope, revision, decision, note } = answer;
  try {
    const { task } = board.call(principal, 'task.approve', {
      id: taskId,
      scope,
      revision,
      decision,
      ...(note === undefined ? {} : { note }),
    });
    return { status: 'ok', taskStatus: task.status };
  } catch (error) {
    if (error instanceof BoardError) return { status: 'refused', code: error.code, message: error.message };
    throw error;
  }
}
