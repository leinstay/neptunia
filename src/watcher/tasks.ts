// The watcher's tasks: the agent ends its answer with one ```tasks block, a JSON array of { kind, title, evidence, done }
// with an optional `finding`. `splitAnswer` takes the block out of the report and checks it; src/watcher/inspection.ts
// calls it. `fileTasks` files each draft on the board as the principal `watcher` (role `watcher`, which may add a task and
// nothing else) unless the same evidence is already on the board as an open task of the watcher's or was filed today or
// yesterday. `normalized` is how src/watcher/filing.ts, which keeps receipts per draft, compares evidence too.

import type { BoardCaller } from '../tools/impl/board.ts';

export type TaskDraft = { kind: 'fix' | 'chore'; title: string; evidence: string; done: string; finding?: string };
export type Filed = { id: string; kind: 'fix' | 'chore'; title: string };
export type SplitAnswer =
  { ok: true; report: string; tasks: Array<TaskDraft> } | { ok: false; code: 'bad-tasks'; detail: string };

/** The board principal the watcher files as. */
export const WATCHER = 'watcher';

const DAY_MS = 24 * 60 * 60 * 1000;
const CLOSED_FOR_WATCHER: ReadonlyArray<string> = ['done', 'failed', 'cancelled'];

const bad = (detail: string): SplitAnswer => ({ ok: false, code: 'bad-tasks', detail });

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** One draft of the block, or why it is refused (the reason never quotes the draft). */
function draftOf(raw: unknown, index: number): TaskDraft | string {
  if (!isRecord(raw)) return `task ${index + 1} is not an object`;
  const { kind } = raw;
  if (kind !== 'fix' && kind !== 'chore') return `task ${index + 1}: kind is fix or chore`;
  const fields: Array<string> = [];
  for (const name of ['title', 'evidence', 'done']) {
    const value = raw[name];
    if (typeof value !== 'string' || value.trim() === '') return `task ${index + 1}: ${name} is empty`;
    fields.push(value.trim());
  }
  const { finding } = raw;
  if (finding !== undefined && typeof finding !== 'string') return `task ${index + 1}: finding is a string`;
  return {
    kind,
    title: fields[0] ?? '',
    evidence: fields[1] ?? '',
    done: fields[2] ?? '',
    ...(finding === undefined || finding.trim() === '' ? {} : { finding: finding.trim() }),
  };
}

/**
 * The report and the drafts of an answer. The one optional ```tasks block is cut out of the report; a second block,
 * an unclosed one, text that is not a JSON array and a draft with a kind other than fix or chore, a blank title,
 * evidence or done-criterion or a `finding` that is no string are `bad-tasks`. A blank `finding` counts as none.
 */
export function splitAnswer(text: string): SplitAnswer {
  const lines = text.split('\n');
  const opens = lines.flatMap((line, i) => (/^\s*```tasks\s*$/.test(line) ? [i] : []));
  if (opens.length === 0) return { ok: true, report: text, tasks: [] };
  if (opens.length > 1) return bad('more than one tasks block');
  const start = opens[0] ?? 0;
  const close = lines.findIndex((line, i) => i > start && /^\s*```\s*$/.test(line));
  if (close === -1) return bad('the tasks block is not closed');
  let parsed: unknown;
  try {
    parsed = JSON.parse(lines.slice(start + 1, close).join('\n'));
  } catch {
    return bad('the tasks block is not JSON');
  }
  if (!Array.isArray(parsed)) return bad('the tasks block is not an array');
  const tasks: Array<TaskDraft> = [];
  for (const [index, raw] of parsed.entries()) {
    const draft = draftOf(raw, index);
    if (typeof draft === 'string') return bad(draft);
    tasks.push(draft);
  }
  return { ok: true, report: [...lines.slice(0, start), ...lines.slice(close + 1)].join('\n'), tasks };
}

/** The evidence as compared: trimmed, lower case, runs of spaces as one. */
export const normalized = (evidence: string): string => evidence.trim().toLowerCase().replace(/\s+/g, ' ');

/** A board refusal in the middle of a batch, carrying the tasks the batch had already filed. */
export class FilingError extends Error {
  readonly filed: Array<Filed>;
  constructor(cause: unknown, filed: Array<Filed>) {
    super(cause instanceof Error ? cause.message : 'the board refused', { cause });
    this.name = 'FilingError';
    this.filed = filed;
  }
}

/**
 * Files each draft with `task.add` as `watcher`: the evidence is the description and the metadata, the done-criterion
 * the acceptance. A draft is skipped when a task of the watcher with the same evidence is open (not done, failed or
 * cancelled) or was created on the UTC day of `now` or the day before, and when its evidence already came earlier in
 * the batch. A board refusal rejects with a `FilingError` that holds what was filed before it. Nothing here claims,
 * approves or runs a task.
 */
export async function fileTasks(args: {
  board: BoardCaller;
  drafts: ReadonlyArray<TaskDraft>;
  now: () => number;
}): Promise<{ filed: Array<Filed>; skipped: Array<TaskDraft> }> {
  const filed: Array<Filed> = [];
  const skipped: Array<TaskDraft> = [];
  if (args.drafts.length === 0) return { filed, skipped };
  const since = Math.floor(args.now() / DAY_MS) * DAY_MS - DAY_MS;
  try {
    const known = await args.board.call(WATCHER, 'task.list', { requester: WATCHER });
    const blocked = new Set<string>();
    for (const task of known) {
      const evidence = task.metadata?.evidence;
      if (task.requester !== WATCHER || typeof evidence !== 'string') continue;
      const open = !CLOSED_FOR_WATCHER.includes(task.status);
      if (open || Date.parse(task.created_at) >= since) blocked.add(normalized(evidence));
    }
    for (const draft of args.drafts) {
      const key = normalized(draft.evidence);
      if (blocked.has(key)) {
        skipped.push(draft);
        continue;
      }
      blocked.add(key);
      const added = await args.board.call(WATCHER, 'task.add', {
        lane: 'dev',
        title: draft.title,
        description: draft.evidence,
        acceptance: draft.done,
        metadata: { kind: draft.kind, evidence: draft.evidence },
      });
      filed.push({ id: added.id, kind: draft.kind, title: draft.title });
    }
  } catch (error) {
    throw new FilingError(error, filed);
  }
  return { filed, skipped };
}
