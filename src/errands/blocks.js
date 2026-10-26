// The persona's view of her errands in a request, as text: the `<tasks>` block (her open errands
// and the finished ones she has not seen, one line each) and the `<task_result>` block of the
// turn an errand's end opens (src/errands/turns.js). Pure: every word comes from
// `labels.tasks` (prompts/labels.json); a block whose labels are missing is left out (''). Ids,
// agent names, states' codes, URLs, file handles, content types and sizes are data, not wording.

import { fill } from '../format.js';
import { clampWithEllipsis, oneLine } from '../memory/clamp.js';
import { MINUTE_MS } from '../time.js';
import { fileHandle, isOpenState } from './store.js';

/** The goal's length on a `<tasks>` line (characters). */
export const TASK_GOAL_CHARS = 120;
/** `agents.unreadShown` when it is missing (config.json carries the same). */
export const DEFAULT_UNREAD_SHOWN = 5;
/** `agents.resultMaxChars` when it is missing (config.json carries the same). */
export const DEFAULT_RESULT_MAX_CHARS = 3000;

/** The state of `task` in words (`labels.tasks.states`), else its code. */
function stateWord(state, labels) {
  const words = labels?.tasks?.states;
  return typeof words?.[state] === 'string' && words[state] ? words[state] : String(state ?? '');
}

/**
 * The state of `task` in words: `labels.tasks.states.expired` for a finished task whose files the
 * runner has deleted (`filesExpired`) when that label is there, else its state's word.
 */
function taskStateWord(task, labels) {
  const expired = labels?.tasks?.states?.expired;
  if (task?.filesExpired === true && typeof expired === 'string' && expired) return expired;
  return stateWord(task?.state, labels);
}

/**
 * The `<tasks>` block's body: `labels.tasks.header`, then one `labels.tasks.line` per task
 * (`{id}`, `{agent}`, `{goal}` on one line cut to TASK_GOAL_CHARS, `{state}` through
 * `labels.tasks.states`, `states.expired` for a task whose files have expired, `{error}` the
 * code of a task that did not end `done` ('' otherwise), `{age}` whole minutes since it was
 * asked). The open ones come first; a finished one is an unread result and its line ends with
 * `labels.tasks.unread` (and `labels.tasks.resultTurnFailed` when its result turn never
 * completed). At most `unreadShown` finished ones are listed, oldest first; `labels.tasks.unreadMore`
 * (`{count}`) counts the rest. '' with no task or without the header or line label.
 * @param {object[]} tasks
 * @param {object} labels
 * @param {{ now: number, goalChars?: number, unreadShown?: number }} options
 * @returns {string}
 */
export function tasksBlockText(
  tasks,
  labels,
  { now, goalChars = TASK_GOAL_CHARS, unreadShown = DEFAULT_UNREAD_SHOWN }
) {
  const l = labels?.tasks;
  const list = Array.isArray(tasks) ? tasks.filter((task) => task && typeof task.id === 'string') : [];
  if (list.length === 0 || typeof l?.header !== 'string' || typeof l?.line !== 'string') return '';
  const open = list.filter((task) => isOpenState(task.state));
  const finished = list.filter((task) => !isOpenState(task.state));
  const cap = Number.isInteger(unreadShown) && unreadShown >= 0 ? unreadShown : DEFAULT_UNREAD_SHOWN;
  const shown = [...open, ...finished.slice(0, cap)];
  const lineOf = (task) => {
    const line = fill(l.line, {
      id: task.id,
      agent: task.agent,
      goal: clampWithEllipsis(oneLine(task.goal), goalChars),
      state: taskStateWord(task, labels),
      error: task.state !== 'done' && task.error ? task.error : '',
      age: Math.max(0, Math.floor((now - (Number(task.createdAt) || now)) / MINUTE_MS)),
    });
    if (isOpenState(task.state)) return line;
    const notes = [
      typeof l.unread === 'string' ? l.unread : '',
      task.resultTurnFailed === true && typeof l.resultTurnFailed === 'string' ? l.resultTurnFailed : '',
    ].filter(Boolean);
    return notes.length > 0 ? `${line} ${notes.join(' ')}` : line;
  };
  const lines = shown.map(lineOf);
  const more = finished.length - (shown.length - open.length);
  if (more > 0 && typeof l.unreadMore === 'string') lines.push(fill(l.unreadMore, { count: more }));
  return [l.header, ...lines].join('\n');
}

/**
 * The `<task_result>` block's body for a finished `task`: `labels.tasks.result.header` (`{id}`,
 * `{agent}`, `{goal}` on one line, `{state}` in words), then the result's text under
 * `result.text` cut to `maxChars` (`result.empty` when there is none), `result.error` (`{error}`:
 * the code) when it did not end `done`, the sources as a numbered list under `result.sources`,
 * and each file as `result.file` (`{handle}`: `file:<task id>/<name>`, `{contentType}`,
 * `{bytes}`) under `result.files` unless the files have expired (`filesExpired`: the state's word
 * is then `states.expired`, when present), then one `result.withheld` line (`{paths}`: the paths
 * the runner withheld in a filtered scope, joined by `, `) when there are any, then one
 * `result.held` line (`{names}`: the names of the files the runner held back and did not deliver,
 * `result.filesDropped`, joined by `, `; no handle for them) when there are any. A part without its
 * label is left out; '' without the header.
 * @param {object} task
 * @param {object} labels
 * @param {{ maxChars?: number }} [options]
 * @returns {string}
 */
export function taskResultText(task, labels, { maxChars = DEFAULT_RESULT_MAX_CHARS } = {}) {
  const r = labels?.tasks?.result;
  if (!task || typeof r?.header !== 'string') return '';
  const parts = [
    fill(r.header, { id: task.id, agent: task.agent, goal: oneLine(task.goal), state: taskStateWord(task, labels) }),
  ];
  const text = typeof task.result?.text === 'string' ? task.result.text.trim() : '';
  if (text && typeof r.text === 'string') parts.push(r.text, clampWithEllipsis(text, maxChars));
  else if (!text && typeof r.empty === 'string') parts.push(r.empty);
  if (task.state !== 'done' && task.error && typeof r.error === 'string')
    parts.push(fill(r.error, { error: task.error }));
  const sources = Array.isArray(task.result?.sources)
    ? task.result.sources.filter((url) => typeof url === 'string' && url)
    : [];
  if (sources.length > 0 && typeof r.sources === 'string')
    parts.push(r.sources, ...sources.map((url, i) => `${i + 1}. ${url}`));
  // Expired files name nothing any more: no handle for them.
  const files =
    task.filesExpired !== true && Array.isArray(task.result?.files)
      ? task.result.files.filter((file) => file && typeof file.name === 'string' && file.name)
      : [];
  if (files.length > 0 && typeof r.files === 'string' && typeof r.file === 'string') {
    parts.push(
      r.files,
      ...files.map((file) =>
        fill(r.file, {
          handle: fileHandle(task.id, file.name),
          contentType: file.contentType || '-',
          bytes: Number(file.bytes) || 0,
        })
      )
    );
  }
  const withheld = Array.isArray(task.result?.withheld)
    ? task.result.withheld.filter((entry) => typeof entry === 'string' && entry)
    : [];
  if (withheld.length > 0 && typeof r.withheld === 'string')
    parts.push(fill(r.withheld, { paths: withheld.join(', ') }));
  const held = Array.isArray(task.result?.filesDropped)
    ? task.result.filesDropped
        .map((entry) => (typeof entry === 'string' ? entry : entry?.name))
        .filter((name) => typeof name === 'string' && name)
    : [];
  if (held.length > 0 && typeof r.held === 'string') parts.push(fill(r.held, { names: held.join(', ') }));
  return parts.join('\n');
}
