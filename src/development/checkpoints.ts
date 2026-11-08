// File checkpoints of one explicit development worktree: a copy of its tracked work kept outside it, a preview of what a
// restore would change, and a restore that needs its confirmation and the revision the preview showed. Every restore first
// takes a checkpoint of the state it replaces, so it can be undone, and a partial failure is reported with that undo. The
// local layer, credentials, live data and git are never captured or restored (EXCLUDED and secret-files.ts), and a symlink that leads out of the
// worktree stops the restore. A worktree the task authority does not allow has no capability. A chat's rewind is
// src/chat/sessions.ts and touches no file. src/development/checkpoint-desk.ts opens one of these per task.

import fs from 'node:fs';
import path from 'node:path';
import { secretClassOfPath } from '../memory/db/secret-files.ts';

export type CheckpointCapability = { restore: true } | { restore: false; reason: string };
export type CheckpointChange = { path: string; change: 'added' | 'modified' | 'removed' };
export type Checkpoint = { id: string; revision: number; at: number };

export type RestoreAnswer =
  | { status: 'restored'; undoId: string; undoRevision: number }
  | { status: 'refused'; code: string }
  | { status: 'failed'; code: string; undoId: string; undoRevision: number };

export type TakeAnswer = { ok: true; checkpoint: Checkpoint } | { ok: false; code: string };

export type FileCheckpoints = {
  capability(): CheckpointCapability;
  take(request: { revision: number }): TakeAnswer;
  list(): Array<Checkpoint>;
  preview(
    id: string
  ): { ok: true; checkpoint: Checkpoint; changes: Array<CheckpointChange>; diff: string } | { ok: false; code: string };
  restore(id: string, request: { confirm: boolean; revision: number }): RestoreAnswer;
};

/** Names that stay out at any depth: the local layer, credentials, live data, git and what git ignores anyway. */
const EXCLUDED: ReadonlySet<string> = new Set([
  '.git',
  '.local.git',
  '.env',
  '.secrets',
  '.agents',
  '.claude',
  '.worktrees',
  'data',
  'node_modules',
  'config.local',
  'config.local.json',
  'prompts.local',
]);
const isExcluded = (name: string): boolean => EXCLUDED.has(name) || name.startsWith('.env.');

/** How much diff one preview carries. A preview is for reading, and the path list stays whole. */
const DIFF_CHARS = 64 * 1024;

/** Every file and symlink under `root`, as paths relative to it. A symlink is never followed. */
function walk(root: string, relative = ''): Array<string> {
  const found: Array<string> = [];
  for (const entry of fs.readdirSync(path.join(root, relative), { withFileTypes: true })) {
    if (isExcluded(entry.name)) continue;
    const child = path.join(relative, entry.name);
    if (secretClassOfPath(child) !== null) continue;
    if (entry.isDirectory()) found.push(...walk(root, child));
    else if (entry.isFile() || entry.isSymbolicLink()) found.push(child);
  }
  return found;
}

const sameFile = (stored: string, current: string): boolean => {
  const stat = fs.lstatSync(current);
  return stat.isFile() && fs.readFileSync(stored).equals(fs.readFileSync(current));
};

/** The changed lines of a file between the checkpoint and now: the common head and tail are left out. */
function changedLines(file: string, before: string, after: string): string {
  const old = before.split('\n');
  const fresh = after.split('\n');
  let head = 0;
  while (head < old.length && head < fresh.length && old[head] === fresh[head]) head += 1;
  let tail = 0;
  while (
    tail < old.length - head &&
    tail < fresh.length - head &&
    old[old.length - 1 - tail] === fresh[fresh.length - 1 - tail]
  )
    tail += 1;
  return [
    `--- ${file}`,
    ...old.slice(head, old.length - tail).map((line) => `- ${line}`),
    ...fresh.slice(head, fresh.length - tail).map((line) => `+ ${line}`),
  ].join('\n');
}

export function createFileCheckpoints({
  worktree,
  storeDir,
  authority,
  now,
  newId,
  io = {},
}: {
  worktree: string;
  storeDir: string;
  authority: { allowsWorktree: (worktree: string) => boolean };
  now: () => number;
  newId: () => string;
  io?: { writeFile?: (file: string, data: Buffer) => void };
}): FileCheckpoints {
  const writeFile = io.writeFile ?? ((file: string, data: Buffer) => fs.writeFileSync(file, data));
  const isAllowed = (): boolean => authority.allowsWorktree(worktree);
  const home = (id: string): string => path.join(storeDir, id);
  const filesOf = (id: string): string => path.join(home(id), 'files');

  function capture(revision: number): Checkpoint {
    const checkpoint = { id: newId(), revision, at: now() };
    const files = filesOf(checkpoint.id);
    fs.mkdirSync(files, { recursive: true, mode: 0o700 });
    for (const file of walk(worktree)) {
      const from = path.join(worktree, file);
      if (!fs.lstatSync(from).isFile()) continue;
      const to = path.join(files, file);
      fs.mkdirSync(path.dirname(to), { recursive: true });
      fs.copyFileSync(from, to);
    }
    fs.writeFileSync(path.join(home(checkpoint.id), 'checkpoint.json'), JSON.stringify(checkpoint));
    return checkpoint;
  }

  function read(id: string): Checkpoint | null {
    // An id comes from a panel: one that is no plain folder name is simply unknown.
    if (id !== path.basename(id)) return null;
    try {
      return JSON.parse(fs.readFileSync(path.join(home(id), 'checkpoint.json'), 'utf8')) as Checkpoint;
    } catch {
      return null;
    }
  }

  /** What a restore of `id` would change, as seen from now. */
  function changesOf(id: string): Array<CheckpointChange> {
    const stored = new Set(walk(filesOf(id)));
    const current = new Set(walk(worktree));
    const changes: Array<CheckpointChange> = [];
    for (const file of stored) {
      if (!current.has(file)) changes.push({ path: file, change: 'removed' });
      else if (!sameFile(path.join(filesOf(id), file), path.join(worktree, file)))
        changes.push({ path: file, change: 'modified' });
    }
    for (const file of current) if (!stored.has(file)) changes.push({ path: file, change: 'added' });
    return changes;
  }

  function diffOf(id: string, changes: ReadonlyArray<CheckpointChange>): string {
    const text = changes
      .map((one) => {
        const stored = path.join(filesOf(id), one.path);
        const current = path.join(worktree, one.path);
        if (one.change === 'added') return `+++ ${one.path} (added since the checkpoint)`;
        if (one.change === 'removed') return `--- ${one.path} (removed since the checkpoint)`;
        return fs.lstatSync(current).isFile()
          ? changedLines(one.path, fs.readFileSync(stored, 'utf8'), fs.readFileSync(current, 'utf8'))
          : `--- ${one.path} (a symlink now)`;
      })
      .join('\n');
    return text.length > DIFF_CHARS ? `${text.slice(0, DIFF_CHARS)}\n(the rest of the diff is cut)` : text;
  }

  /** Whether writing `file` would leave the worktree through a symlink on its way. */
  function escapes(file: string): boolean {
    const root = fs.realpathSync(worktree);
    const parts = file.split(path.sep);
    for (let depth = 1; depth <= parts.length; depth += 1) {
      const step = path.join(worktree, ...parts.slice(0, depth));
      let isLink: boolean;
      try {
        isLink = fs.lstatSync(step).isSymbolicLink();
      } catch {
        return false;
      }
      if (!isLink) continue;
      let target: string;
      try {
        target = fs.realpathSync(step);
      } catch {
        // A dangling link leads nowhere readable, and nothing proves it stays inside.
        return true;
      }
      if (target !== root && !target.startsWith(`${root}${path.sep}`)) return true;
    }
    return false;
  }

  function apply(id: string, changes: ReadonlyArray<CheckpointChange>): void {
    for (const one of changes) {
      const target = path.join(worktree, one.path);
      if (one.change === 'added') {
        fs.rmSync(target, { force: true });
        continue;
      }
      fs.mkdirSync(path.dirname(target), { recursive: true });
      // A link inside the worktree is replaced by the file it stood for, and never written through.
      if (one.change === 'modified' && fs.lstatSync(target).isSymbolicLink()) fs.rmSync(target);
      writeFile(target, fs.readFileSync(path.join(filesOf(id), one.path)));
    }
  }

  return {
    capability: () =>
      isAllowed() ? { restore: true } : { restore: false, reason: 'this worktree is outside the task authority' },
    take({ revision }) {
      if (!isAllowed()) return { ok: false, code: 'unavailable' };
      return { ok: true, checkpoint: capture(revision) };
    },
    list() {
      if (!isAllowed() || !fs.existsSync(storeDir)) return [];
      return fs
        .readdirSync(storeDir)
        .flatMap((id) => read(id) ?? [])
        .sort((one, two) => one.at - two.at || one.revision - two.revision);
    },
    preview(id) {
      if (!isAllowed()) return { ok: false, code: 'unavailable' };
      const checkpoint = read(id);
      if (checkpoint === null) return { ok: false, code: 'unknown-checkpoint' };
      const changes = changesOf(id);
      return { ok: true, checkpoint, changes, diff: diffOf(id, changes) };
    },
    restore(id, { confirm, revision }) {
      if (!isAllowed()) return { status: 'refused', code: 'unavailable' };
      const checkpoint = read(id);
      if (checkpoint === null) return { status: 'refused', code: 'unknown-checkpoint' };
      if (!confirm) return { status: 'refused', code: 'needs-confirmation' };
      if (revision !== checkpoint.revision) return { status: 'refused', code: 'stale-revision' };
      const changes = changesOf(id);
      if (changes.some((one) => one.change !== 'added' && escapes(one.path)))
        return { status: 'refused', code: 'symlink-escape' };
      const undo = capture(checkpoint.revision + 1);
      try {
        apply(id, changes);
      } catch {
        return { status: 'failed', code: 'write-failed', undoId: undo.id, undoRevision: undo.revision };
      }
      return { status: 'restored', undoId: undo.id, undoRevision: undo.revision };
    },
  };
}
