// The agents' spend from the errand records (src/errands/store.js): per agent, over today, the
// last 7 and the last 30 UTC days (today included), its runs, input and output tokens and
// dollars. The dollars are the runner's own estimate (OpenCode's step costs, priced by the live
// `agents.<agent>.cost` the task was sent with, src/errands/client.js), never an OpenRouter key's
// figure. A run counts on the UTC day its task was queued (an open task included), its tokens and
// dollars on the day it ended. The same numbers are the daily caps' (`agents.<agent>.daily.tasks`
// and `.usd`, the `today` window) and the owner card's `costs.errands` field. Pure; the clock is
// passed in.

import { DAY_MS, utcDay } from '../time.js';

/** The windows, in order: the name and how many UTC days it spans, today included. */
export const COST_WINDOWS = Object.freeze([
  ['today', 1],
  ['last7', 7],
  ['last30', 30],
]);

/** How many UTC days of records a holder keeps, today included: enough for the longest window. */
export const KEEP_DAYS = 31;

const amount = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);
const time = (value) => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/**
 * The part of a task record the spend needs: `{ id, agent, createdAt, endedAt, usage }`, the
 * usage as `{ input, output, usd }` (a count that is not a finite number >= 0 is 0) or null when
 * the task has none yet. Null for a record without an id or an agent. Nothing else is kept.
 * @param {object} task  A task as the store keeps it, or one transition line of tasks.jsonl.
 * @returns {{ id: string, agent: string, createdAt: number|null, endedAt: number|null, usage: { input: number, output: number, usd: number }|null }|null}
 */
export function costRecord(task) {
  if (!task || typeof task.id !== 'string' || !task.id || typeof task.agent !== 'string' || !task.agent) return null;
  const usage =
    task.usage && typeof task.usage === 'object'
      ? { input: amount(task.usage.input), output: amount(task.usage.output), usd: amount(task.usage.usd) }
      : null;
  return { id: task.id, agent: task.agent, createdAt: time(task.createdAt), endedAt: time(task.endedAt), usage };
}

/** One window's counters at zero. */
const emptyRow = () => ({ runs: 0, input: 0, output: 0, usd: 0 });

/** An agent's totals with every window at zero. */
export function emptyTotals() {
  return Object.fromEntries(COST_WINDOWS.map(([name]) => [name, emptyRow()]));
}

/**
 * The spend per agent and window. `records` are task records (costRecord's shape, or whole
 * tasks); several of one id fold into the last of them (the transition lines of one task). A
 * record counts one run in each window holding the UTC day of its `createdAt`, and its usage in
 * each window holding the day of its `endedAt`; a time after today counts nowhere.
 * @param {Iterable<object>|null} records
 * @param {{ now: number, agents?: string[]|null }} options  `agents`: listed first, in order,
 *   each present even with no record (the others follow in the order first seen).
 * @returns {Record<string, { today: object, last7: object, last30: object }>}  each window
 *   `{ runs, input, output, usd }`.
 */
export function agentCosts(records, { now, agents = null }) {
  const latest = new Map();
  for (const raw of records ?? []) {
    const record = costRecord(raw);
    if (record) latest.set(record.id, record);
  }
  const totals = {};
  for (const agent of Array.isArray(agents) ? agents : []) totals[agent] = emptyTotals();
  const today = utcDay(now);
  const starts = COST_WINDOWS.map(([name, days]) => [name, utcDay(now - (days - 1) * DAY_MS)]);
  const windowsOf = (at) => {
    if (at === null) return [];
    const day = utcDay(at);
    return day > today ? [] : starts.filter(([, start]) => day >= start).map(([name]) => name);
  };
  for (const record of latest.values()) {
    const row = (totals[record.agent] ??= emptyTotals());
    for (const name of windowsOf(record.createdAt)) row[name].runs += 1;
    if (!record.usage) continue;
    for (const name of windowsOf(record.endedAt)) {
      row[name].input += record.usage.input;
      row[name].output += record.usage.output;
      row[name].usd += record.usage.usd;
    }
  }
  return totals;
}
