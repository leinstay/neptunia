// The file checkpoints of the development tasks, for the owner's `/checkpoints`. A worktree counts only while the board holds
// it for an open task and it lies under the development checkout's worktree folder, so another checkout, the live install and
// a closed task have no capability. The board is the authority here, and this desk starts nothing: taking and restoring copy
// files and run no agent. src/interface/commands/chat-state.ts calls it.

import fs from 'node:fs';
import path from 'node:path';
import { createFileCheckpoints } from './checkpoints.ts';
import type { CheckpointCapability, CheckpointChange, FileCheckpoints, RestoreAnswer } from './checkpoints.ts';

/** The statuses of a closed task on the board (src/board/machine.ts#CLOSED). This module reads rows and no board code. */
const CLOSED: ReadonlySet<unknown> = new Set(['rejected', 'done', 'failed', 'cancelled']);

type Loose = Record<string, unknown>;
const looseOf = (value: unknown): Loose => (value !== null && typeof value === 'object' ? (value as Loose) : {});

/** The open tasks that hold a worktree, from the rows of `task.list`. */
function worktreesOf(rows: unknown): Array<{ taskId: string; worktree: string }> {
  return (Array.isArray(rows) ? (rows as Array<unknown>) : []).flatMap((raw) => {
    const row = looseOf(raw);
    const worktree = looseOf(looseOf(row.metadata).development).worktree;
    return typeof row.id === 'string' && typeof worktree === 'string' && !CLOSED.has(row.status)
      ? [{ taskId: row.id, worktree }]
      : [];
  });
}

/** Whether `worktree` lies strictly under `root`, with every link resolved. */
function isUnder(root: string, worktree: string): boolean {
  try {
    return fs.realpathSync(worktree).startsWith(`${fs.realpathSync(root)}${path.sep}`);
  } catch {
    return false;
  }
}

export type CheckpointPointView = {
  taskId: string;
  id: string;
  revision: number;
  changes: ReadonlyArray<CheckpointChange>;
  diff: string;
};

export type CheckpointDesk = {
  list(): Promise<{ capability: CheckpointCapability; points: Array<CheckpointPointView> }>;
  take(taskId: string): Promise<{ ok: true; id: string } | { ok: false; code: string }>;
  restore(taskId: string, id: string, revision: number): Promise<RestoreAnswer>;
};

export function createCheckpointDesk({
  tasks,
  worktreeRoot,
  storeDir,
  now,
  newId,
}: {
  /** The rows of the board's `task.list`, read at each command. */
  tasks: () => Promise<unknown>;
  /** The development checkout's worktree folder, or null while no checkout is set. */
  worktreeRoot: () => string | null;
  storeDir: string;
  now: () => number;
  newId: () => string;
}): CheckpointDesk {
  /** The checkpoints of `taskId`'s worktree, or null while the board holds none for it. */
  async function openFor(taskId: string): Promise<FileCheckpoints | null> {
    const found = worktreesOf(await tasks()).find((one) => one.taskId === taskId);
    return found === undefined ? null : open(taskId, found.worktree);
  }

  function open(taskId: string, worktree: string): FileCheckpoints {
    return createFileCheckpoints({
      worktree,
      storeDir: path.join(storeDir, path.basename(taskId)),
      authority: {
        allowsWorktree: (asked) => {
          const root = worktreeRoot();
          return root !== null && isUnder(root, asked);
        },
      },
      now,
      newId,
    });
  }

  return {
    async list() {
      const held = worktreesOf(await tasks());
      const opened = held.map((one) => ({ ...one, checkpoints: open(one.taskId, one.worktree) }));
      const allowed = opened.filter((one) => one.checkpoints.capability().restore);
      if (allowed.length === 0)
        return { capability: { restore: false, reason: 'no open development task holds a worktree' }, points: [] };
      const points = allowed.flatMap(({ taskId, checkpoints }) =>
        checkpoints.list().flatMap((point) => {
          const preview = checkpoints.preview(point.id);
          return preview.ok
            ? [{ taskId, id: point.id, revision: point.revision, changes: preview.changes, diff: preview.diff }]
            : [];
        })
      );
      return { capability: { restore: true }, points };
    },
    async take(taskId) {
      const checkpoints = await openFor(taskId);
      if (checkpoints === null) return { ok: false, code: 'no-worktree' };
      const taken = checkpoints.take({ revision: 1 });
      return taken.ok ? { ok: true, id: taken.checkpoint.id } : { ok: false, code: taken.code };
    },
    async restore(taskId, id, revision) {
      const checkpoints = await openFor(taskId);
      if (checkpoints === null) return { status: 'refused', code: 'no-worktree' };
      return checkpoints.restore(id, { confirm: true, revision });
    },
  };
}
