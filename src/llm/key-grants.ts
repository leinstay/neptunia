// What is left of each key's grant. The owner sets `llm.keys.<VARIABLE_NAME>` to `{ grant, resetDay }`: the USD the key is
// given and the day of the month (UTC) it is given again. The balance is the grant minus the cost of every request that
// went out on the key since the last reset moment, summed from the engine's own usage records (src/tools/impl/usage.ts,
// by key name), never read from the provider, whose limits follow their own calendar. A key without an entry has no
// balance (null). A `resetDay` past the end of a short month resets on that month's last day. Pure.

import { DAY_MS, utcDay } from '../time.ts';

/** One key's grant as `llm.keys` holds it. */
export type KeyGrant = { grant: number; resetDay: number };

/** One key of a role's list with its balance: `grant` is null for a key `llm.keys` does not name. */
export type KeyBalance = { name: string; left: number | null; grant: number | null; resetDay: number | null };

/** The moment (ms, 00:00 UTC) of the most recent reset on or before `now` for a reset on day `resetDay` of the month. */
export function lastResetMs(now: number, resetDay: number): number {
  const at = new Date(now);
  const year = at.getUTCFullYear();
  const month = at.getUTCMonth();
  const clamped = (y: number, m: number): number => {
    const last = new Date(Date.UTC(y, m + 1, 0)).getUTCDate();
    return Date.UTC(y, m, Math.min(Math.max(1, Math.floor(resetDay)), last));
  };
  const thisMonth = clamped(year, month);
  return thisMonth <= now ? thisMonth : clamped(year, month - 1);
}

/** A grant entry read from the config value, else null. */
function grantOf(entry: unknown): KeyGrant | null {
  if (entry === null || typeof entry !== 'object') return null;
  const grant: unknown = Reflect.get(entry, 'grant');
  const resetDay: unknown = Reflect.get(entry, 'resetDay');
  if (typeof grant !== 'number' || !Number.isFinite(grant) || grant < 0) return null;
  if (typeof resetDay !== 'number' || !Number.isInteger(resetDay) || resetDay < 1 || resetDay > 31) return null;
  return { grant, resetDay };
}

/**
 * The balance of each of `names` now. `keys` is the `llm.keys` map of the live config, `spentSince(name, day)` the cost in
 * dollars of the requests on `name` from the UTC day `day` (`YYYY-MM-DD`) through today. A balance may be negative when the
 * records say the grant is spent.
 */
export function keyBalances({
  keys,
  names,
  now,
  spentSince,
}: {
  keys: unknown;
  names: ReadonlyArray<string>;
  now: number;
  spentSince: (name: string, day: string) => number;
}): Array<KeyBalance> {
  const map = keys !== null && typeof keys === 'object' ? keys : {};
  return names.map((name) => {
    const entry = grantOf(Object.hasOwn(map, name) ? Reflect.get(map, name) : null);
    if (!entry) return { name, left: null, grant: null, resetDay: null };
    const day = utcDay(Math.floor(lastResetMs(now, entry.resetDay) / DAY_MS) * DAY_MS);
    return { name, left: entry.grant - spentSince(name, day), grant: entry.grant, resetDay: entry.resetDay };
  });
}

type NamesOf = {
  keyNames?: (role: string) => Array<string>;
  keyGrants?: () => unknown;
  keyVariables?: () => Record<string, string>;
};
type SpendOf = { keyCost?: (name: string, day: string) => number };

/**
 * The balances of the core's keys now. `llm` is the chat client (`keyNames`), `usage` the usage accumulator (`keyCost`),
 * `config` the live config (`llm.keys`); a source without its reader gives no key, or a spend of 0.
 */
export function coreKeyBalances({
  llm,
  usage,
  config,
  now,
}: {
  llm: unknown;
  usage: unknown;
  config: unknown;
  now: number;
}): Array<KeyBalance> {
  const names = (llm as NamesOf | null)?.keyNames?.('core') ?? [];
  // With a key store the grants are the core rows'; without one they are `llm.keys`.
  const keys = (llm as NamesOf | null)?.keyGrants?.() ?? (config as { llm?: { keys?: unknown } } | null)?.llm?.keys;
  const cost = (name: string, day: string): number => (usage as SpendOf | null)?.keyCost?.(name, day) ?? 0;
  // Spend recorded before the import is under the variable the key came from.
  const variables = (llm as NamesOf | null)?.keyVariables?.() ?? {};
  const spentSince = (name: string, day: string): number =>
    cost(name, day) + (Object.hasOwn(variables, name) ? cost(variables[name] ?? '', day) : 0);
  return keyBalances({ keys, names, now, spentSince });
}
