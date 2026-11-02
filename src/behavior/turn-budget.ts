// The one budget line of her wake view: how many core turns this UTC week allows against how many she has had. A key's
// credit is a monthly allowance, so a week gets a quarter of what is left on the core's keys; dividing that by the median
// cost of a core turn over the last seven days gives the turns the week's share can pay for. A key whose
// limit is not reported counts 0. Without any cost history the possible count is unknown (null). The figures are facts
// for her to read, never a limit the engine enforces. Pure: the clock and the sources are the caller's.

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

/** The median of the finite, positive costs; null for none. */
export function medianCost(costs: ReadonlyArray<number>): number | null {
  const sorted = costs.filter((cost) => Number.isFinite(cost) && cost > 0).sort((a, b) => a - b);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? (sorted[middle] ?? null) : ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/**
 * The turns line's figures. `balances` are the remaining credits of every key of the core role (null: no limit reported,
 * counted 0), `costs` the cost in dollars of each core turn of the last seven days, `spent` the core turns since Monday.
 */
export function turnsBudget({
  now,
  balances,
  costs,
  spent,
}: {
  now: number;
  balances: ReadonlyArray<number | null>;
  costs: ReadonlyArray<number>;
  spent: number;
}): TurnsBudget {
  const left = balances.reduce<number>(
    (sum, balance) => sum + (typeof balance === 'number' && balance > 0 ? balance : 0),
    0
  );
  const median = medianCost(costs);
  const possible = median === null ? null : Math.floor(left / WEEKS_PER_ALLOWANCE / median);
  return { until: utcWeekOf(now).sunday, spent, possible };
}

/** The journal as this module reads it: one UTC day's records of one kind (src/memory/journal.ts#read). */
type JournalReads = {
  read(guildId: string, query: { day: string; kind: string; n: number }): Promise<ReadonlyArray<unknown>>;
};

/** The days of the cost history. */
const COST_DAYS = 7;
/** How long the journal's figures are reused: the balances are read fresh at every wake, the journal is not. */
const JOURNAL_CACHE_MS = 10 * 60_000;

/** The `occurredAt` of a journal record in ms, else null. */
function occurredAt(record: unknown): number | null {
  const stamp: unknown = record !== null && typeof record === 'object' ? Reflect.get(record, 'occurredAt') : null;
  const at = typeof stamp === 'string' ? Date.parse(stamp) : Number.NaN;
  return Number.isFinite(at) ? at : null;
}

/** The cost in dollars an `inner` turn record carries, else null. */
function costOf(record: unknown): number | null {
  if (record === null || typeof record !== 'object' || Reflect.get(record, 'event') !== 'turn') return null;
  const cost: unknown = Reflect.get(record, 'cost');
  const usd: unknown = cost !== null && typeof cost === 'object' ? Reflect.get(cost, 'usd') : null;
  return typeof usd === 'number' && Number.isFinite(usd) ? usd : null;
}

/**
 * The source of the wake's turns line. Each call reads the remaining credit of the core's keys now (`keyBudgets`) and, from
 * the journal (cached ten minutes), the `turn` records of the current UTC week and the `inner` turn costs of the last
 * seven days. Null without a guild or a journal; a journal read that fails counts as no records.
 */
export function createTurnsBudget({
  journal,
  guildId,
  keyBudgets,
  now,
}: {
  journal: JournalReads | null;
  guildId: () => string | null;
  keyBudgets: () => Promise<ReadonlyArray<{ left: number | null }>>;
  now: () => number;
}): () => Promise<TurnsBudget | null> {
  let cached: { at: number; guild: string; spent: number; costs: Array<number> } | null = null;

  async function history(guild: string, at: number): Promise<{ spent: number; costs: Array<number> }> {
    if (cached && cached.guild === guild && at - cached.at >= 0 && at - cached.at < JOURNAL_CACHE_MS) return cached;
    if (!journal) return { spent: 0, costs: [] };
    const weekStart = utcWeekOf(at).start;
    const today = Math.floor(at / DAY_MS) * DAY_MS;
    const days: Array<number> = [];
    for (let day = Math.min(weekStart, today - (COST_DAYS - 1) * DAY_MS); day <= today; day += DAY_MS) days.push(day);
    const dayKey = (day: number): string => new Date(day).toISOString().slice(0, 10);
    const readDay = (day: number, kind: string): Promise<ReadonlyArray<unknown>> =>
      journal.read(guild, { day: dayKey(day), kind, n: Number.MAX_SAFE_INTEGER }).catch(() => []);
    let spent = 0;
    const costs: Array<number> = [];
    for (const day of days) {
      if (day >= weekStart) {
        for (const record of await readDay(day, 'turn')) {
          const when = occurredAt(record);
          if (when !== null && when >= weekStart) spent += 1;
        }
      }
      if (day >= today - (COST_DAYS - 1) * DAY_MS) {
        for (const record of await readDay(day, 'inner')) {
          const when = occurredAt(record);
          const usd = costOf(record);
          if (usd !== null && when !== null && when > at - COST_DAYS * DAY_MS) costs.push(usd);
        }
      }
    }
    cached = { at, guild, spent, costs };
    return cached;
  }

  return async () => {
    const guild = guildId();
    if (!guild) return null;
    const at = now();
    const [{ spent, costs }, keys] = await Promise.all([history(guild, at), keyBudgets()]);
    return turnsBudget({ now: at, balances: keys.map((key) => key.left), costs, spent });
  };
}
