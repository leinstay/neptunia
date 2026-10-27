// The agents' spend from the errand records (src/errands/store.ts): per agent, over today, the
// last 7 and the last 30 UTC days (today included), its runs, input and output tokens and
// dollars. The dollars are the runner's own estimate (OpenCode's step costs, priced by the live
// `agents.<agent>.cost` the errand was sent with, src/errands/client.ts), never an OpenRouter key's
// figure. A run counts on the UTC day its errand was queued (an open errand included), its tokens and
// dollars on the day it ended. The same numbers are the daily caps' (`agents.<agent>.daily.errands`
// and `.usd`, the `today` window) and the owner card's `costs.errands` field. Pure; the clock is
// passed in.

import { DAY_MS, utcDay } from '../time.js';
import { objOf } from '../tools/types.ts';
import type { AgentCosts, CostRecord, CostRow, CostWindows } from './types.ts';

type WindowName = keyof CostWindows;

/** The windows, in order: the name and how many UTC days it spans, today included. */
export const COST_WINDOWS: ReadonlyArray<readonly [WindowName, number]> = Object.freeze([
  ['today', 1],
  ['last7', 7],
  ['last30', 30],
] as const);

/** How many UTC days of records a holder keeps, today included: enough for the longest window. */
export const KEEP_DAYS = 31;

const amount = (value: unknown): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
const time = (value: unknown): number | null => (typeof value === 'number' && Number.isFinite(value) ? value : null);

/**
 * The part of an errand record the spend needs: `{ id, agent, createdAt, endedAt, usage }`, the
 * usage as `{ input, output, usd }` (a count that is not a finite number >= 0 is 0) or null when
 * the errand has none yet. Null for a record without an id or an agent. Nothing else is kept.
 * The `errand` is an errand as the store keeps it, or one transition line of errands.jsonl.
 */
export function costRecord(errand: unknown): CostRecord | null {
  const record = objOf(errand);
  if (typeof record.id !== 'string' || !record.id || typeof record.agent !== 'string' || !record.agent) return null;
  const used = record.usage;
  const usage =
    typeof used === 'object' && used !== null
      ? { input: amount(objOf(used).input), output: amount(objOf(used).output), usd: amount(objOf(used).usd) }
      : null;
  return {
    id: record.id,
    agent: record.agent,
    createdAt: time(record.createdAt),
    endedAt: time(record.endedAt),
    usage,
  };
}

/** One window's counters at zero. */
const emptyRow = (): CostRow => ({ runs: 0, input: 0, output: 0, usd: 0 });

/** An agent's totals with every window at zero. */
export function emptyTotals(): CostWindows {
  return { today: emptyRow(), last7: emptyRow(), last30: emptyRow() };
}

/**
 * The spend per agent and window. `records` are errand records (costRecord's shape, or whole
 * errands); several of one id fold into the last of them (the transition lines of one errand). A
 * record counts one run in each window holding the UTC day of its `createdAt`, and its usage in
 * each window holding the day of its `endedAt`; a time after today counts nowhere.
 * `agents` lists agents first, in order, each present even with no record (the others follow in the
 * order first seen).
 */
export function agentCosts(
  records: Iterable<unknown> | null,
  { now, agents = null }: { now: number; agents?: Array<string> | null }
): AgentCosts {
  const latest = new Map<string, CostRecord>();
  for (const raw of records ?? []) {
    const record = costRecord(raw);
    if (record) latest.set(record.id, record);
  }
  const totals: AgentCosts = {};
  for (const agent of Array.isArray(agents) ? agents : []) totals[agent] = emptyTotals();
  const today = utcDay(now);
  const starts = COST_WINDOWS.map(([name, days]) => [name, utcDay(now - (days - 1) * DAY_MS)] as const);
  const windowsOf = (at: number | null): Array<WindowName> => {
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
