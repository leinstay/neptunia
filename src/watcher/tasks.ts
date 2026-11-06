// The watcher's tasks: the agent ends its answer with one ```tasks block, a JSON array of { kind, title, evidence, done }
// with an optional `finding`. `splitAnswer` takes the block out of the report and checks it; src/watcher/inspection.ts
// calls it, and src/watcher/filing.ts files the drafts. `normalized` and `herOpenTask` are how filing compares evidence.

import type { TaskRecord } from '../board/board.ts';
import { SELF } from '../board/fields.ts';
import { CLOSED } from '../board/machine.ts';

export type TaskDraft = {
  kind: 'fix' | 'chore';
  title: string;
  evidence: string;
  done: string;
  finding?: string;
};
export type SplitAnswer =
  { ok: true; report: string; tasks: Array<TaskDraft> } | { ok: false; code: 'bad-tasks'; detail: string };

/** The board principal the watcher files as. */
export const WATCHER = 'watcher';
/** The requester of her own tasks. */
export const HER = SELF;

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

const evidenceOf = (row: TaskRecord): string => {
  const kept = row.metadata?.evidence;
  return normalized(typeof kept === 'string' ? kept : (row.description ?? ''));
};

/** Her open task on this evidence: the issue already runs under her name, so a draft on it files nothing. */
export function herOpenTask(rows: ReadonlyArray<TaskRecord>, evidence: string): TaskRecord | undefined {
  const wanted = normalized(evidence);
  return rows.find((row) => row.requester === HER && !CLOSED.includes(row.status) && evidenceOf(row) === wanted);
}
