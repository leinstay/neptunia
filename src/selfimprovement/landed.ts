// What a merged fix shows in her wake: the pull request's title and its paths, once. The facts are the undelivered rows
// of her outbox (`persona:self`, kind `done`) whose task carries `metadata.landed`, which src/selfimprovement/service.ts writes
// when the pull request merges. Both wakes that show them (the selfimprovement wake and the heartbeat) read with
// `landedFor` and acknowledge with `ackLanded` once the wake committed, so whichever comes first tells her and the
// other does not. Read as `persona`; the diff and the evidence text never leave the board.

import type { BoardCaller } from '../tools/impl/board.ts';
import { isObj, listOf } from '../tools/types.ts';

export type Landed = {
  /** the outbox row */
  seq: number;
  taskId: string;
  /** the pull request's title */
  title: string;
  /** paths only, no diff */
  files: Array<string>;
  pr: number | null;
  decidedBy: 'owner' | 'auto';
};

/** The addressee of the outbox rows that are hers. */
const SELF = 'persona:self';

/** The `metadata.landed` of a task as a Landed (without its row), or null when it is not one. */
function landedOf(value: unknown): Omit<Landed, 'seq' | 'taskId'> | null {
  if (!isObj(value) || typeof value.title !== 'string') return null;
  const { decidedBy, pr } = value;
  if (decidedBy !== 'owner' && decidedBy !== 'auto') return null;
  const files = listOf(value.files).filter((one): one is string => typeof one === 'string');
  return { title: value.title, files, pr: typeof pr === 'number' ? pr : null, decidedBy };
}

/**
 * The undelivered outbox rows addressed to `persona:self` of kind `done` whose task carries `metadata.landed`, as the
 * facts of a wake, oldest first, with the numbers of their rows.
 */
export async function landedFor(board: BoardCaller): Promise<{ landed: Array<Landed>; seqs: Array<number> }> {
  const rows = await board.call('persona', 'outbox.pull', { to_whom: SELF });
  const landed: Array<Landed> = [];
  for (const row of rows) {
    if (row.kind !== 'done' || typeof row.task_id !== 'string') continue;
    const view = await board.call('persona', 'task.show', { id: row.task_id });
    const found = landedOf(view.task.metadata?.landed);
    if (found !== null) landed.push({ seq: Number(row.seq), taskId: row.task_id, ...found });
  }
  return { landed, seqs: landed.map((one) => one.seq) };
}

/** Marks those rows delivered, as `persona`: exactly those, not the rows below them. */
export async function ackLanded(board: BoardCaller, seqs: ReadonlyArray<number>): Promise<void> {
  if (seqs.length === 0) return;
  await board.call('persona', 'outbox.pull', { ack_seqs: [...seqs], limit: 0, to_whom: SELF });
}
