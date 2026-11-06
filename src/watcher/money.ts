// What the watcher knows of the money before it starts: the spend of the last 24 hours from `model_requests.usage` by key
// slot, role and model, each balance and limit OpenRouter reports for the deployment's keys, the engine's own rails, and
// how long each limit lasts against that spend until it resets. `moneyFacts` reads a key's balance with the injected
// `fetch` and keeps the numbers only: a key is named by its slot, and its value goes to the key endpoint alone. A read that
// fails is named under `unavailable` with its code and nothing is guessed. bin/neptunia-watcher.ts gathers the keys from
// keys.json (`moneyKeysOf`) and today's request count (`requestsTodayOf`), and the brief carries the result as `<money>`.

import type { KeyStore } from '../keys/file.ts';
import { llmCountToday } from '../llm/openrouter.ts';
import type { Db } from '../memory/db/types.ts';
import { DAY_MS } from '../time.ts';

/** One key the deployment holds: its slot, the service it is for and its value, which never leaves this module. */
export type MoneyKey = { slot: string; service: string; value: string };

/** What was spent in one group of requests: dollars from credits and from BYOK apart. */
export type SpendRow = { requests: number; tokens: number; credits: number; byok: number };
/** What a subscription backend ran: requests and tokens, which cost no dollars per request. */
export type SubscriptionRow = { requests: number; tokens: number };

/** How a limit fares against the 24-hour spend: past its reset with a margin (null with no spend), or out at an hour. */
export type Runway = { state: 'enough'; margin: number | null } | { state: 'short'; runsOutAt: string };

/** One OpenRouter key as `GET /api/v1/key` reported it, by slot, with when it resets and its runway. */
export type KeyBalance = {
  slot: string;
  limit: number | null;
  limit_remaining: number | null;
  limit_reset: string | null;
  usage: number | null;
  usage_daily: number | null;
  usage_weekly: number | null;
  usage_monthly: number | null;
  is_free_tier: boolean | null;
  resetAt: string | null;
  /** The credits spent through this slot in the last 24 hours; a key of the core pool counts the whole pool. */
  spent24h: number;
  runway: Runway | null;
};

/** A read that gave nothing, by slot and service, with its code. */
export type MoneyGap = { slot: string; service: string; code: string };

export type MoneyFacts = {
  window: { from: string; to: string };
  spend: {
    byKey: Record<string, SpendRow>;
    byRole: Record<string, SpendRow>;
    byModel: Record<string, SpendRow>;
    subscription: Record<string, SubscriptionRow>;
  };
  keys: Array<KeyBalance>;
  rails: {
    requestsPerDay: {
      cap: number | null;
      today: number;
      remaining: number | null;
      resetAt: string;
      spent24h: number;
      runway: Runway | null;
    };
    maxRequestTokens: number | null;
    /** The subscription runs a spent window refused in the last 24 hours, by backend, with the last refusal. */
    subscriptionRefusals: Record<string, { count: number; lastAt: string }>;
  };
  unavailable: Array<MoneyGap>;
};

type Fetch = (url: string, init: { headers: Record<string, string>; signal?: AbortSignal }) => Promise<Response>;

/** OpenRouter's read of the key a request carries. */
export const KEY_ENDPOINT = 'https://openrouter.ai/api/v1/key';
/** The backends that run on a subscription: counted by requests and tokens, never in dollars. */
const SUBSCRIPTION_BACKENDS: ReadonlyArray<string> = ['claude', 'codex'];
/** The slot of the core pool, which every role without a key of its own spends on. */
const CORE_SLOT = 'core';
const KEY_READ_TIMEOUT_MS = 10_000;
/** The error code a subscription run gets when its window is spent (src/subharness/subscription-client.ts). */
const EXHAUSTED = 'subscription-exhausted';

type Row = Record<string, unknown>;

const iso = (at: number): string => new Date(at).toISOString();
const numberOr = (value: unknown, fallback: number | null): number | null =>
  typeof value === 'number' && Number.isFinite(value) ? value : fallback;
/** Dollars to a millionth, so a sum of small costs reads as the provider billed it. */
const dollars = (value: number): number => Math.round(value * 1e6) / 1e6;
const isRecord = (value: unknown): value is Row => typeof value === 'object' && value !== null && !Array.isArray(value);

function parsed(text: unknown): Row {
  if (typeof text !== 'string') return {};
  try {
    const value: unknown = JSON.parse(text);
    return isRecord(value) ? value : {};
  } catch {
    return {};
  }
}

/** The tokens of one answer's usage. */
const tokensOf = (usage: Row): number =>
  (numberOr(usage.prompt_tokens, 0) ?? 0) + (numberOr(usage.completion_tokens, 0) ?? 0);

/** The dollars of one answer: the upstream cost for a BYOK answer, else what OpenRouter charged. */
function costOf(usage: Row): { credits: number; byok: number } {
  if (usage.is_byok === true) {
    const details = isRecord(usage.cost_details) ? usage.cost_details : {};
    return { credits: 0, byok: numberOr(details.upstream_inference_cost, 0) ?? 0 };
  }
  return { credits: numberOr(usage.cost, 0) ?? 0, byok: 0 };
}

function add(rows: Record<string, SpendRow>, name: string, tokens: number, cost: { credits: number; byok: number }) {
  const row = (rows[name] ??= { requests: 0, tokens: 0, credits: 0, byok: 0 });
  row.requests += 1;
  row.tokens += tokens;
  row.credits = dollars(row.credits + cost.credits);
  row.byok = dollars(row.byok + cost.byok);
}

/** The next reset of a limit after `now` in UTC, or null for one that never resets. */
function resetAfter(reset: unknown, now: number): number | null {
  const at = new Date(now);
  const midnight = Date.UTC(at.getUTCFullYear(), at.getUTCMonth(), at.getUTCDate());
  if (reset === 'daily') return midnight + DAY_MS;
  // OpenRouter's week starts on Monday.
  if (reset === 'weekly') return midnight + ((8 - at.getUTCDay()) % 7 || 7) * DAY_MS;
  if (reset === 'monthly') return Date.UTC(at.getUTCFullYear(), at.getUTCMonth() + 1, 1);
  return null;
}

/**
 * How `remaining` lasts at the rate of `spent24h` a day: `enough` when it lasts to `resetAt`, with how many times over,
 * else `short` with the moment it runs out. A limit that never resets is short whenever anything is spent on it.
 */
export function runwayOf(remaining: number, spent24h: number, resetAt: number | null, now: number): Runway {
  if (!(spent24h > 0)) return { state: 'enough', margin: null };
  const outAt = now + (Math.max(0, remaining) * DAY_MS) / spent24h;
  if (resetAt !== null && outAt >= resetAt) {
    const expected = (spent24h * (resetAt - now)) / DAY_MS;
    return { state: 'enough', margin: Math.round((remaining / expected) * 100) / 100 };
  }
  return { state: 'short', runsOutAt: iso(Math.round(outAt)) };
}

/** The finished requests of the window, as the spend reads them. */
function windowRows(db: Db, from: number, to: number): Array<Row> {
  return db
    .prepare(
      'SELECT role, model, backend, status, usage, error_code, finished_at FROM model_requests WHERE finished_at > ? AND finished_at <= ?'
    )
    .all(iso(from), iso(to));
}

function spendOf(rows: ReadonlyArray<Row>, roleSlots: Readonly<Record<string, string>>) {
  const byKey: Record<string, SpendRow> = {};
  const byRole: Record<string, SpendRow> = {};
  const byModel: Record<string, SpendRow> = {};
  const subscription: Record<string, SubscriptionRow> = {};
  const subscriptionRefusals: Record<string, { count: number; lastAt: string }> = {};
  let apiRequests = 0;
  for (const row of rows) {
    const usage = parsed(row.usage);
    const tokens = tokensOf(usage);
    const backend = typeof row.backend === 'string' ? row.backend : '';
    if (SUBSCRIPTION_BACKENDS.includes(backend)) {
      const one = (subscription[backend] ??= { requests: 0, tokens: 0 });
      one.requests += 1;
      one.tokens += tokens;
      if (row.error_code === EXHAUSTED) {
        const refused = (subscriptionRefusals[backend] ??= { count: 0, lastAt: String(row.finished_at) });
        refused.count += 1;
        if (String(row.finished_at) > refused.lastAt) refused.lastAt = String(row.finished_at);
      }
      continue;
    }
    apiRequests += 1;
    const role = typeof row.role === 'string' ? row.role : 'unknown';
    const cost = costOf(usage);
    add(byKey, roleSlots[role] ?? CORE_SLOT, tokens, cost);
    add(byRole, role, tokens, cost);
    add(byModel, typeof row.model === 'string' ? row.model : 'unknown', tokens, cost);
  }
  return { spend: { byKey, byRole, byModel, subscription }, subscriptionRefusals, apiRequests };
}

/** The spend slot of a key: a key of the core pool spends from the pool, since a request names no key of it. */
const spendSlot = (slot: string): string => (slot.startsWith(`${CORE_SLOT}:`) ? CORE_SLOT : slot);

/** One key's balance, or the code of why it could not be read. The key goes in the header to the key endpoint and nowhere else. */
async function readKey(
  key: MoneyKey,
  fetch: Fetch,
  spent24h: number,
  now: number
): Promise<KeyBalance | { code: string }> {
  let answer: Response;
  try {
    answer = await fetch(KEY_ENDPOINT, {
      headers: { Authorization: `Bearer ${key.value}` },
      signal: AbortSignal.timeout(KEY_READ_TIMEOUT_MS),
    });
  } catch (error) {
    return { code: (error as Error | null)?.name === 'TimeoutError' ? 'timeout' : 'unreachable' };
  }
  if (!answer.ok) return { code: `http_${answer.status}` };
  let body: unknown;
  try {
    body = await answer.json();
  } catch {
    return { code: 'bad-answer' };
  }
  const data = isRecord(body) && isRecord(body.data) ? body.data : null;
  if (data === null) return { code: 'bad-answer' };
  const remaining = numberOr(data.limit_remaining, null);
  const reset = resetAfter(data.limit_reset, now);
  return {
    slot: key.slot,
    limit: numberOr(data.limit, null),
    limit_remaining: remaining,
    limit_reset: typeof data.limit_reset === 'string' ? data.limit_reset : null,
    usage: numberOr(data.usage, null),
    usage_daily: numberOr(data.usage_daily, null),
    usage_weekly: numberOr(data.usage_weekly, null),
    usage_monthly: numberOr(data.usage_monthly, null),
    is_free_tier: typeof data.is_free_tier === 'boolean' ? data.is_free_tier : null,
    resetAt: reset === null ? null : iso(reset),
    spent24h,
    runway: remaining === null ? null : runwayOf(remaining, spent24h, reset, now),
  };
}

/**
 * The money fact over the requests of the 24 hours before `now`: the spend, each key's balance, the rails and their
 * runways. `roleSlots` names the extra key a role spends on (keys.json `roles`); a role with none spends on `core`.
 * `requestsToday` is the engine's count against `llm.maxRequestsPerDay`, whose day ends at midnight UTC.
 */
export async function moneyFacts(input: {
  db: Db;
  keys: ReadonlyArray<MoneyKey>;
  roleSlots: Readonly<Record<string, string>>;
  requestsToday: number;
  fetch: Fetch;
  now: () => number;
  config: unknown;
}): Promise<MoneyFacts> {
  const now = input.now();
  const from = now - DAY_MS;
  const { spend, subscriptionRefusals, apiRequests } = spendOf(windowRows(input.db, from, now), input.roleSlots);
  const keys: Array<KeyBalance> = [];
  const unavailable: Array<MoneyGap> = [];
  for (const key of input.keys) {
    if (key.service !== 'openrouter') {
      unavailable.push({ slot: key.slot, service: key.service, code: 'no-balance-read' });
      continue;
    }
    const spent = spend.byKey[spendSlot(key.slot)]?.credits ?? 0;
    const read = await readKey(key, input.fetch, spent, now);
    if ('code' in read) unavailable.push({ slot: key.slot, service: key.service, code: read.code });
    else keys.push(read);
  }
  const llm = isRecord(input.config) && isRecord(input.config.llm) ? input.config.llm : {};
  const cap = numberOr(llm.maxRequestsPerDay, null);
  const midnight = resetAfter('daily', now) ?? now + DAY_MS;
  const remaining = cap === null ? null : Math.max(0, cap - input.requestsToday);
  return {
    window: { from: iso(from), to: iso(now) },
    spend,
    keys,
    rails: {
      requestsPerDay: {
        cap,
        today: input.requestsToday,
        remaining,
        resetAt: iso(midnight),
        spent24h: apiRequests,
        runway: remaining === null ? null : runwayOf(remaining, apiRequests, midnight, now),
      },
      maxRequestTokens: numberOr(llm.maxRequestTokens, null),
      subscriptionRefusals,
    },
    unavailable,
  };
}

/**
 * The keys of keys.json as named slots: the core pool (`core`, or `core:<name>` for each key of a pool of several), every
 * extra key by its name, the simulation key and the paid services (`services.<name>`). Each OpenRouter key is read for its
 * balance, and a service with no balance read is named as unavailable.
 */
export function moneyKeysOf(store: KeyStore): Array<MoneyKey> {
  const keys: Array<MoneyKey> = [];
  const core = store.core.filter((row) => typeof row.value === 'string' && row.value.trim() !== '');
  for (const row of core) {
    keys.push({
      slot: core.length === 1 ? CORE_SLOT : `${CORE_SLOT}:${row.name}`,
      service: 'openrouter',
      value: row.value,
    });
  }
  for (const [name, value] of Object.entries(store.extra)) {
    if (value.trim() !== '') keys.push({ slot: name, service: 'openrouter', value });
  }
  if (store.simulation.key !== null && store.simulation.key.trim() !== '') {
    keys.push({ slot: 'simulation', service: 'openrouter', value: store.simulation.key });
  }
  const services = (store as { services?: unknown }).services;
  for (const [name, value] of Object.entries(isRecord(services) ? services : {})) {
    if (typeof value === 'string' && value.trim() !== '') keys.push({ slot: name, service: name, value });
  }
  return keys;
}

/** The engine's count against `llm.maxRequestsPerDay` today, from the persona's state in the memory database; 0 with none. */
export function requestsTodayOf(db: Db, now: number): number {
  const row = db
    .prepare("SELECT value FROM operational WHERE kind = 'state' AND retired_at IS NULL ORDER BY rowid DESC LIMIT 1")
    .get();
  return llmCountToday(parsed(row?.value), now);
}
