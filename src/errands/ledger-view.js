// The owner's read views of the ledger (src/errands/ledger.js#readLedger), every word from
// prompts/labels.json: the `/nep status` card's ledger lines (`labels.status.ledger`: the last
// LEDGER_STATUS_COUNT tasks of both lanes from `task.list`, or `off` when the ledger is not
// configured or does not answer) and `/nep task show <id>` (`labels.tasks.ledger`: one ledger task
// whole from `task.show`, as `task show --full` prints it: the description, the acceptance, every
// attempt with its cost, every result with its whole body -- the `prompt` and `spec` kinds
// included --, the questions with their answers, and the events). The ledger's answers are data:
// its field names are read in their snake_case and camelCase forms, a field it does not send
// shows `-` or is left out. A missing label leaves its line out. Pure.

import { fill } from '../format.js';
import { isPlainObject } from '../config.js';
import { clampWithEllipsis, oneLine } from '../memory/clamp.js';
import { utcMinute } from '../time.js';

/** How many ledger tasks the status card lists. */
export const LEDGER_STATUS_COUNT = 5;
/** A ledger task's title on the status card: cut to this many characters. */
export const LEDGER_TITLE_CHARS = 60;

/** `fill` of a label that is a non-empty string; null otherwise (the line is left out). */
function line(template, values = {}) {
  return typeof template === 'string' && template ? fill(template, values) : null;
}

/** The first of `keys` `object` holds (not null or undefined), else undefined. */
function pick(object, ...keys) {
  if (!isPlainObject(object)) return undefined;
  for (const key of keys) if (object[key] !== undefined && object[key] !== null) return object[key];
  return undefined;
}

/** A value as one shown word: a string or a finite number as itself, else `-`. */
function shown(value) {
  if (typeof value === 'string' && value.trim()) return oneLine(value);
  if (typeof value === 'number' && Number.isFinite(value)) return String(value);
  return '-';
}

/** A ledger time (ISO text, epoch ms or epoch seconds) as `YYYY-MM-DD HH:MM UTC`, else `-`. */
function when(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return utcMinute(value < 1e12 ? value * 1000 : value);
  if (typeof value === 'string' && value) return utcMinute(value);
  return '-';
}

/** A time as epoch ms for ordering, else null. */
function epochOf(value) {
  if (typeof value === 'number' && Number.isFinite(value)) return value < 1e12 ? value * 1000 : value;
  const ms = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(ms) ? ms : null;
}

/** Dollars with three decimals, else `-`. */
function dollars(value) {
  const amount = typeof value === 'string' ? Number(value) : value;
  return typeof amount === 'number' && Number.isFinite(amount) ? amount.toFixed(3) : '-';
}

/** The tasks of a `task.list` answer: the array itself, or its `tasks` / `items`. */
export function ledgerTasksOf(result) {
  if (Array.isArray(result)) return result.filter(isPlainObject);
  const list = pick(result, 'tasks', 'items');
  return Array.isArray(list) ? list.filter(isPlainObject) : [];
}

/**
 * The newest `count` of `tasks`, newest first: by their creation time when every task has one
 * (the ledger's order kept among equal times), else the ledger's order.
 */
export function latestLedgerTasks(tasks, count = LEDGER_STATUS_COUNT) {
  const list = Array.isArray(tasks) ? tasks.filter(isPlainObject) : [];
  const times = list.map((task) => epochOf(pick(task, 'created_at', 'createdAt')));
  if (times.every((ms) => ms !== null)) {
    return list.map((task, i) => ({ task, at: times[i], i })).sort((a, b) => b.at - a.at || a.i - b.i).slice(0, count).map(({ task }) => task);
  }
  return list.slice(0, count);
}

/**
 * The status card's ledger lines (`labels.status.ledger`): `off` alone when the read failed
 * (no socket, no answer, a refusal), `empty` alone without a task, else `header` and one `line`
 * per task of the newest LEDGER_STATUS_COUNT (`{id}`, `{lane}`, `{status}`, `{title}` cut to
 * LEDGER_TITLE_CHARS).
 * @param {{ ok: boolean, result?: unknown }} outcome  readLedger's answer to `task.list`.
 * @param {object} labels  `hot.prompts.labels`.
 * @returns {string[]}
 */
export function ledgerStatusLines(outcome, labels) {
  const L = labels?.status?.ledger;
  if (!isPlainObject(L)) return [];
  if (!outcome?.ok) return [line(L.off)].filter(Boolean);
  const tasks = latestLedgerTasks(ledgerTasksOf(outcome.result));
  if (tasks.length === 0) return [line(L.empty)].filter(Boolean);
  const lines = tasks.map((task) => line(L.line, {
    id: shown(pick(task, 'id')),
    lane: shown(pick(task, 'lane')),
    status: shown(pick(task, 'status', 'state')),
    title: clampWithEllipsis(oneLine(pick(task, 'title') ?? ''), LEDGER_TITLE_CHARS) || '-',
  }));
  return [line(L.header), ...lines].filter(Boolean);
}

/** A list of the `task.show` answer: at its top, else on its task. */
function listOf(result, task, ...keys) {
  const list = pick(result, ...keys) ?? pick(task, ...keys);
  return Array.isArray(list) ? list.filter(isPlainObject) : [];
}

/** A stored text whole, as one entry of lines (line ends normalized, trailing space dropped); [] for none. */
function body(text) {
  return typeof text === 'string' && text.trim() ? [text.replace(/\r\n?/g, '\n').replace(/\s+$/u, '')] : [];
}

/** A JSON value as compact text (`-` for nothing). */
function compact(value) {
  if (value === undefined || value === null) return '-';
  if (typeof value === 'string') return value;
  try {
    return JSON.stringify(value);
  } catch {
    return '-';
  }
}

/**
 * One ledger task whole (`labels.tasks.ledger`), from the answer of `task.show`: `header`
 * (`{id}`, `{lane}`, `{status}`, `{title}` whole), `meta` (project, requester, role, created,
 * updated), `closed` with the close reason when there is one; then the sections, each its title
 * label and its items, `none` for an empty one: `description` and `acceptance` (their text as
 * stored), `attempts` (one `attempt` each: id, role, model, outcome, steps, cost, start, end),
 * `results` (one `result` each -- kind, time, attempt -- then its whole body and its `resultUri`),
 * `questions` (one `question` each, then its `answer` or `unanswered`), `events` (one `event`
 * each: sequence, time, actor, type, and `{change}` as `eventChange` of the old and new values).
 * '' when the labels hold no `tasks.ledger`.
 * @param {unknown} result  The ledger's answer: `{ task, attempts, results, questions, events }`,
 *   or the task with those lists on it.
 * @param {object} labels  `hot.prompts.labels`.
 * @returns {string}
 */
export function ledgerTaskText(result, labels) {
  const L = labels?.tasks?.ledger;
  if (!isPlainObject(L)) return '';
  const task = isPlainObject(result?.task) ? result.task : isPlainObject(result) ? result : {};
  const none = typeof L.none === 'string' ? L.none : '';
  const out = [];
  out.push(line(L.header, { id: shown(pick(task, 'id')), lane: shown(pick(task, 'lane')), status: shown(pick(task, 'status', 'state')), title: shown(pick(task, 'title')) }));
  out.push(line(L.meta, {
    project: shown(pick(task, 'project')),
    requester: shown(pick(task, 'requester')),
    role: shown(pick(task, 'role')),
    created: when(pick(task, 'created_at', 'createdAt')),
    updated: when(pick(task, 'updated_at', 'updatedAt')),
  }));
  const reason = pick(task, 'close_reason', 'closeReason');
  if (typeof reason === 'string' && reason) out.push(line(L.closed, { reason }));

  const section = (title, items) => {
    out.push('', line(title));
    out.push(...(items.length > 0 ? items : [none]));
  };
  section(L.description, body(pick(task, 'description')));
  section(L.acceptance, body(pick(task, 'acceptance_criteria', 'acceptanceCriteria', 'acceptance')));

  section(L.attempts, listOf(result, task, 'attempts').map((attempt) => line(L.attempt, {
    id: shown(pick(attempt, 'id')),
    role: shown(pick(attempt, 'role')),
    model: shown(pick(attempt, 'model')),
    outcome: shown(pick(attempt, 'outcome', 'status')),
    steps: shown(pick(attempt, 'steps')),
    cost: dollars(pick(attempt, 'cost_usd', 'cost_billed_usd', 'cost_est_usd', 'costUsd')),
    started: when(pick(attempt, 'started_at', 'startedAt')),
    ended: when(pick(attempt, 'ended_at', 'endedAt')),
  })));

  const results = [];
  for (const item of listOf(result, task, 'results')) {
    results.push(line(L.result, { kind: shown(pick(item, 'kind')), at: when(pick(item, 'created_at', 'createdAt')), attempt: shown(pick(item, 'attempt_id', 'attemptId')) }));
    results.push(...body(pick(item, 'body', 'text')));
    const uri = pick(item, 'uri');
    if (typeof uri === 'string' && uri) results.push(line(L.resultUri, { uri }));
    const metadata = pick(item, 'metadata');
    if (isPlainObject(metadata) && Object.keys(metadata).length > 0) results.push(line(L.resultMetadata, { metadata: compact(metadata) }));
  }
  section(L.results, results);

  const questions = [];
  for (const item of listOf(result, task, 'questions')) {
    questions.push(line(L.question, { id: shown(pick(item, 'id')), by: shown(pick(item, 'asked_by', 'askedBy')), text: String(pick(item, 'text') ?? '-') }));
    const answer = pick(item, 'answer');
    questions.push(typeof answer === 'string' && answer
      ? line(L.answer, { by: shown(pick(item, 'answered_by', 'answeredBy')), at: when(pick(item, 'answered_at', 'answeredAt')), text: answer })
      : line(L.unanswered));
  }
  section(L.questions, questions);

  section(L.events, listOf(result, task, 'events').map((event) => line(L.event, {
    seq: shown(pick(event, 'seq', 'id')),
    at: when(pick(event, 'created_at', 'createdAt', 'at')),
    actor: shown(pick(event, 'actor')),
    type: shown(pick(event, 'type')),
    change: pick(event, 'old') === undefined && pick(event, 'new') === undefined ? '' : line(L.eventChange, { old: compact(pick(event, 'old')), new: compact(pick(event, 'new')) }) ?? '',
  })?.trimEnd() ?? null));

  return out.filter((entry) => entry !== null).join('\n').trim();
}
