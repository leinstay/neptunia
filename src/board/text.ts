// The plain text of a board answer, as the ledger's `task` command line printed it: one line per task, the whole view
// of `task.show`, one line per event and per outbox row, and the costs table. src/board/commands.ts calls `answerText`
// for a `task.*` command asked without `json`. Pure.

import type { EventRow, Orientation, Row, TaskRecord, TaskView } from './board.ts';

// The result kinds that record what an attempt was given rather than what it made; `full` prints them last.
const RECORD_KINDS: ReadonlyArray<string> = ['prompt', 'spec'];

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** A row's field as text: '' for null and undefined, the JSON of an object. */
function field(value: unknown): string {
  if (value === null || value === undefined) return '';
  if (typeof value === 'string') return value;
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return JSON.stringify(value);
}

function indent(value: unknown, width: number): string {
  const pad = ' '.repeat(width);
  return field(value)
    .split('\n')
    .map((line) => (line ? pad + line : line))
    .join('\n');
}

/** One task on one line: id, status, priority, lane and project, title, and its blocker, lease and deferral. */
export function taskLine(task: TaskRecord): string {
  const where = [task.lane, task.project].filter(Boolean).join('/');
  const flags: Array<string> = [];
  if (task.is_blocked) flags.push('blocked');
  if (task.lease_owner) flags.push(`held by ${task.lease_owner} until ${field(task.lease_expires_at)}`);
  if (task.defer_until) flags.push(`deferred until ${task.defer_until}`);
  const tail = flags.length ? `  (${flags.join('; ')})` : '';
  return `${task.id}  ${task.status.padEnd(16)} p${task.priority}  ${where.padEnd(14)} ${task.title}${tail}`;
}

export function eventLine(event: EventRow): string {
  const between = event.old !== null && event.new !== null ? ' -> ' : '';
  const change = event.old !== null || event.new !== null ? `  ${event.old ?? ''}${between}${event.new ?? ''}` : '';
  return `#${event.seq} ${event.created_at} ${event.task_id ?? '-'} ${event.actor} ${event.type}${change}`;
}

function inboxLine(row: Row): string {
  const payload = isObject(row.payload) ? row.payload : {};
  const detail =
    row.kind === 'answer'
      ? `${field(payload.question)}: ${field(payload.text)}`
      : `${field(payload.title)}${payload.close_reason ? ` (${field(payload.close_reason)})` : ''}`;
  return `#${field(row.seq)} ${field(row.task_id)} ${field(row.kind)} -> ${field(row.to_whom)}  ${detail}`;
}

function questionLine(question: Row, full: boolean): string {
  const head = `${field(question.id)} ${field(question.asked_by)} -> ${field(question.to_whom)}`;
  const answered = Boolean(question.answered_at);
  if (full) {
    const answer = answered
      ? `\n    answer (${field(question.answered_by)}):\n${indent(question.answer, 6)}`
      : '\n    [open]';
    return `${head}:\n${indent(question.text, 4)}${answer}`;
  }
  const answer = answered ? `\n    answer (${field(question.answered_by)}): ${field(question.answer)}` : '  [open]';
  return `${head}: ${field(question.text)}${answer}`;
}

function wholeResult(result: Row): string {
  return `${field(result.id)} ${field(result.kind)} ${field(result.uri)}${result.body ? `\n${indent(result.body, 4)}` : ''}`;
}

function shortResult(result: Row): string {
  const first = result.body ? ` ${field(result.body).split('\n')[0] ?? ''}` : '';
  return `${field(result.id)} ${field(result.kind)} ${field(result.uri)}${first}`;
}

/**
 * The whole view of one task. The default cuts each result body to its first line; `full` prints every body, question
 * and answer whole, each continuation line indented under its row, and the prompts and specs last.
 */
export function showText(view: TaskView, { full = false }: { full?: boolean } = {}): string {
  const task = view.task;
  const lines = [taskLine(task)];
  const add = (name: string, value: unknown): void => {
    if (value !== null && value !== undefined && value !== '') lines.push(`  ${name}: ${field(value)}`);
  };
  add('revision', task.revision);
  add('requester', task.requester);
  add('subscriber', task.subscriber);
  add('risk', task.risk);
  add('role', task.role);
  add('estimate', task.estimate_minutes !== null ? `${task.estimate_minutes} min` : null);
  add('budget', task.budget_usd !== null ? `$${task.budget_usd}` : null);
  add('step cap', task.step_cap);
  add('close reason', task.close_reason);
  add('ready', view.ready ? 'yes' : null);
  add('metadata', task.metadata ? JSON.stringify(task.metadata) : null);
  if (task.description) lines.push('', 'Description:', task.description);
  if (task.acceptance) lines.push('', 'Acceptance:', task.acceptance);
  const section = <T>(title: string, rows: ReadonlyArray<T>, line: (row: T) => string): void => {
    if (rows.length) lines.push('', `${title}:`, ...rows.map((row) => `  ${line(row)}`));
  };
  section('Depends on', view.dependencies, (row) => `${field(row.depends_on_id)} (${field(row.type)})`);
  section('Dependents', view.dependents, (row) => `${field(row.task_id)} (${field(row.type)})`);
  section('Attempts', view.attempts, (row) => {
    const cost = row.cost_est_usd !== null && row.cost_est_usd !== undefined ? ` $${field(row.cost_est_usd)}` : '';
    return `${field(row.id)} #${field(row.n)} ${field(row.principal)} ${field(row.model)} ${field(row.outcome) || 'running'}${cost}`;
  });
  section('Questions', view.questions, (row) => questionLine(row, full));
  section('Approvals', view.approvals, (row) => {
    const note = row.note ? `: ${field(row.note)}` : '';
    return `${field(row.id)} ${field(row.scope)} ${field(row.decision)} by ${field(row.principal)}${note}`;
  });
  const record = full ? view.results.filter((row) => RECORD_KINDS.includes(field(row.kind))) : [];
  section(
    'Results',
    view.results.filter((row) => !record.includes(row)),
    full ? wholeResult : shortResult
  );
  section('Comments', view.comments, (row) => `${row.id} ${row.author}: ${row.text}`);
  section('Events', view.events, eventLine);
  section('Prompts and specs', record, (row) => `${field(row.attempt_id) || '-'} ${wholeResult(row)}`);
  return lines.join('\n');
}

type Window = { runs: number; input: number; output: number; usd: number };

const isWindow = (value: unknown): value is Window =>
  isObject(value) && typeof value.runs === 'number' && typeof value.usd === 'number';

/** One line per agent and window, then the thinker's last wave. */
export function costsText(costs: Readonly<Record<string, unknown>>): string {
  const lines = [
    `${'agent'.padEnd(10)}${'window'.padEnd(8)}${'runs'.padStart(6)}${'input'.padStart(12)}${'output'.padStart(12)}${'usd'.padStart(12)}`,
  ];
  for (const [agent, windows] of Object.entries(costs)) {
    for (const name of ['today', 'last7', 'last30']) {
      const window = isObject(windows) ? windows[name] : null;
      if (!isWindow(window)) continue;
      lines.push(
        `${agent.padEnd(10)}${name.padEnd(8)}${String(window.runs).padStart(6)}${String(window.input).padStart(12)}` +
          `${String(window.output).padStart(12)}${window.usd.toFixed(4).padStart(12)}`
      );
    }
  }
  const thinker = costs.thinker;
  const wave = isObject(thinker) && isObject(thinker.last_wave) ? thinker.last_wave : null;
  lines.push(
    wave
      ? `thinker last wave ${field(wave.wave)}: ${field(wave.turns)} turns, $${Number(wave.usd).toFixed(4)}, ` +
          `context mean ${field(wave.context_mean) || '-'}, peak ${field(wave.context_peak) || '-'}`
      : 'thinker last wave: none'
  );
  return lines.join('\n');
}

/** What the caller holds, what it blocked, what waits for its review and what it is asked, a section each. */
function orientText(orientation: Orientation): string {
  const lines: Array<string> = [];
  const section = <T>(title: string, rows: ReadonlyArray<T>, line: (row: T) => string): void => {
    lines.push(`${title}:`, ...(rows.length ? rows.map((row) => `  ${line(row)}`) : ['  (none)']));
  };
  section('Held', orientation.held, taskLine);
  section('Blocked', orientation.blocked, taskLine);
  section('Reviews', orientation.reviews, taskLine);
  section('Questions', orientation.questions, (row) => `${field(row.id)} ${field(row.task_id)}: ${field(row.text)}`);
  return lines.join('\n');
}

const taskOf = (data: unknown): TaskRecord | null =>
  isObject(data) && isObject(data.task) && typeof data.task.id === 'string'
    ? // The `task` of a board answer is the TaskRecord the board wrote.
      (data.task as TaskRecord)
    : null;

/** `row.id` above the line of the answer's task, for the answers that file a row (ask, result, submit). */
function rowAndTask(data: unknown, key: string): string {
  const row = isObject(data) && isObject(data[key]) ? data[key] : {};
  const task = taskOf(data);
  return [field(row.id), task ? taskLine(task) : ''].filter(Boolean).join('\n');
}

/**
 * The plain text of the answer `data` of the command `name`, as the ledger's command line printed it: the new id for
 * `task.add`, a task line for a command that answers a task, the whole view for `task.show` (`full` as its arg).
 */
export function answerText(name: string, data: unknown, args: Readonly<Record<string, unknown>>): string {
  // Each case reads the answer of its own op (BoardResults in board.ts), or the command layer's own for next and events.
  switch (name) {
    case 'task.add':
      return field((data as TaskRecord).id);
    case 'task.list': {
      const tasks = data as Array<TaskRecord>;
      return tasks.length ? tasks.map(taskLine).join('\n') : '(no tasks)';
    }
    case 'task.show':
      return showText(data as TaskView, { full: args.full === true });
    case 'task.next':
      return data === null ? '(no task ready)' : taskLine(data as TaskRecord);
    case 'task.approve': {
      const approval = isObject(data) && isObject(data.approval) ? data.approval : {};
      const task = taskOf(data);
      return `${field(approval.id)} ${field(approval.scope)} ${field(approval.decision)}\n${task ? taskLine(task) : ''}`;
    }
    case 'task.review': {
      const review = isObject(data) && isObject(data.review) ? data.review : {};
      const task = taskOf(data);
      return `${field(review.id)} ${field(review.decision)}\n${task ? taskLine(task) : ''}`;
    }
    case 'task.ask':
      return rowAndTask(data, 'question');
    case 'task.result':
    case 'task.submit':
      return rowAndTask(data, 'result');
    case 'task.comment':
      return field(isObject(data) && isObject(data.comment) ? data.comment.id : '');
    case 'task.answer':
    case 'task.escalate': {
      const task = taskOf(data);
      return task ? taskLine(task) : '';
    }
    case 'task.events': {
      const events = data as Array<EventRow>;
      return events.length ? events.map(eventLine).join('\n') : '(no events)';
    }
    case 'task.outbox.pull': {
      const rows = data as Array<Row>;
      return rows.length ? rows.map(inboxLine).join('\n') : '(inbox empty)';
    }
    case 'task.costs.agents':
      return costsText(data as Readonly<Record<string, unknown>>);
    case 'task.orient':
      return orientText(data as Orientation);
    case 'task.attempt.start':
    case 'task.attempt.end':
    case 'task.run.start':
    case 'task.run.end':
      return field(isObject(data) ? data.id : '');
    default:
      return isObject(data) && typeof data.id === 'string' ? taskLine(data as TaskRecord) : JSON.stringify(data);
  }
}
