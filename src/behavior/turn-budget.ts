// The one budget line of her wake view: how many core turns this UTC week allows against how many she has had. A key's
// credit is a monthly allowance, so a week gets a quarter of what is left on the core's keys. Dividing that by the mean
// cost of a core request over the last seven days gives the turns the week's share can pay for. A request is the unit of a
// turn (nine in ten turns are one request), and the usage store keeps totals per role and day, not the cost of each
// request, so the cost is a mean, not a median. A key whose limit is not reported counts 0. Without a core request in
// those days the possible count is unknown (null). The figures are facts for her to read, never a limit the engine
// enforces. Pure: the clock and the sources are the caller's.

import { DAY_MS } from '../time.ts';

/** What the wake view words: the Sunday the week ends, the core turns of the week so far and the count the credit allows. */
export type TurnsBudget = { until: number; spent: number; possible: number | null };

/** The weeks a key's remaining credit is spread over. */
const WEEKS_PER_ALLOWANCE = 4;

/** Start of the UTC week (Monday 00:00) that holds `now`, and its Sunday 00:00, in ms. */
export function utcWeekOf(now: number): { start: number; sunday: number } {
  const midnight = Math.floor(now / DAY_MS) * DAY_MS;
  // 1970-01-01 was a Thursday: (day number + 3) mod 7 is 0 on a Monday.
  const sinceMonday = (Math.floor(now / DAY_MS) + 3) % 7;
  const start = midnight - sinceMonday * DAY_MS;
  return { start, sunday: start + 6 * DAY_MS };
}

/** The mean cost of a request: `cost` over `requests`; null without a request or a positive cost. */
export function meanCost(cost: number, requests: number): number | null {
  return requests > 0 && Number.isFinite(cost) && cost > 0 ? cost / requests : null;
}

/**
 * The turns line's figures. `balances` are the remaining credits of every key of the core role (null: no limit reported,
 * counted 0), `cost` the mean cost in dollars of a core request of the last seven days (null: none), `spent` the core requests since Monday.
 */
export function turnsBudget({
  now,
  balances,
  cost,
  spent,
}: {
  now: number;
  balances: ReadonlyArray<number | null>;
  cost: number | null;
  spent: number;
}): TurnsBudget {
  const left = balances.reduce<number>(
    (sum, balance) => sum + (typeof balance === 'number' && balance > 0 ? balance : 0),
    0
  );
  const possible = cost === null ? null : Math.floor(left / WEEKS_PER_ALLOWANCE / cost);
  return { until: utcWeekOf(now).sunday, spent, possible };
}

/** The usage accumulator as this module reads it (src/tools/impl/usage.ts#createUsage). */
type UsageSums = {
  sumDays(days: number, filter?: { only?: ReadonlyArray<string> }): { total: { requests: number; cost: number } };
};

/** The days of the cost history. */
const COST_DAYS = 7;

/**
 * The source of the wake's turns line, from the usage store's `core` role: the requests since Monday 00:00 UTC are the turns
 * spent, the cost over the requests of the last seven days is the cost of a turn. The balances of the core keys are read at
 * every call (`keyBalances`).
 */
export function createTurnsBudget({
  usage,
  keyBalances,
  now,
}: {
  usage: UsageSums;
  keyBalances: () => ReadonlyArray<{ left: number | null }>;
  now: () => number;
}): () => Promise<TurnsBudget> {
  return () => {
    const at = now();
    const sinceMonday = Math.round((Math.floor(at / DAY_MS) * DAY_MS - utcWeekOf(at).start) / DAY_MS) + 1;
    const week = usage.sumDays(sinceMonday, { only: ['core'] }).total;
    const recent = usage.sumDays(COST_DAYS, { only: ['core'] }).total;
    return Promise.resolve(
      turnsBudget({
        now: at,
        balances: keyBalances().map((key) => key.left),
        cost: meanCost(recent.cost, recent.requests),
        spent: week.requests,
      })
    );
  };
}
