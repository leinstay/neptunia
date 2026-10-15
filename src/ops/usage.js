// The costs field of the owner's `/nep status` card: what the OpenRouter key allows and has spent,
// the account's credits, and today's requests per model role from the bot's own accounting. The
// accumulator is fed by the `llm: usage` log lines (src/log.js#onLog, subscribed in src/index.js
// via `usageTap`), the one place every chat completion and embedding request reports its tokens
// and cost, and by the `images: generated` lines (a picture: the `drawing` role, a cost and no
// tokens); it keeps the current and the previous UTC day only, in memory, and `data/usage.json`
// keeps them across a restart (written at most once a minute, and once more on shutdown;
// write-temp + rename). Only numbers and role codes are kept. The costs are OpenRouter's reported
// ones: a BYOK request is billed by the provider and shows here at OpenRouter's list price (the
// upstream cost when the answer carries it). The renderer is pure and takes every word from
// `labels.status.costs`.

import * as nodeFs from 'node:fs';
import path from 'node:path';
import { MINUTE_MS, DAY_MS, utcDay, utcMinute } from '../time.js';
import { fill } from '../discord/format.js';
import { isPlainObject } from '../config.js';
import { log as defaultLog } from '../log.js';
import { IMAGE_ROLE } from '../llm/images.js';

/** The file under `data/` the per-day accumulator persists in. */
export const USAGE_FILE = 'usage.json';

/** The least time between two writes of the file (a forced write on shutdown aside). */
export const SAVE_EVERY_MS = MINUTE_MS;

/** The file's schema version. */
const VERSION = 1;

/** The role a generated picture counts under (src/llm/images.js#IMAGE_ROLE). */
const DRAWING_ROLE = IMAGE_ROLE;

/** The role code of a usage line that names none. */
const NO_ROLE = 'other';

const COUNTERS = Object.freeze(['requests', 'promptTokens', 'cachedTokens', 'completionTokens', 'cost']);

const isAmount = (value) => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const amountOr0 = (value) => (isAmount(value) ? value : 0);

/** A role's counters with every field a finite number >= 0 (0 for anything else). */
function cleanRow(row) {
  return Object.fromEntries(COUNTERS.map((key) => [key, amountOr0(row?.[key])]));
}

/**
 * Create the accumulator, loading `data/usage.json` when it is there (a missing or broken file
 * starts empty; days other than today and yesterday are dropped).
 *
 * @param {object} options
 * @param {string} options.dataDir  The `data/` directory.
 * @param {() => number} [options.now=Date.now]
 * @param {object} [options.fs]  A `node:fs`-shaped API (`readFileSync`, `promises.mkdir|writeFile|rename`).
 * @param {{ warn: Function }} [options.log]
 * @returns {{
 *   record(entry: { role?: string|null, promptTokens?: number, cachedTokens?: number, completionTokens?: number, cost?: number }): void,
 *   byRole(): Array<{ role: string, requests: number, promptTokens: number, cachedTokens: number, completionTokens: number, cost: number }>,
 *   save(opts?: { force?: boolean }): Promise<boolean>,
 * }}
 *   `record` adds one request to today's row of its role (`other` without one; a count that is
 *   not a finite number >= 0 adds 0). `byRole` lists today's roles by cost, then requests (both
 *   descending), then role name. `save` writes the file when a request came since the last write
 *   and, unless `force`, a minute has passed since it; resolves whether it wrote. A failed write
 *   is logged (`usage: save failed`, its code) and tried again on the next call.
 */
export function createUsage({ dataDir, now = Date.now, fs = nodeFs, log = defaultLog }) {
  const file = path.join(dataDir, USAGE_FILE);
  let days = {}; // day -> role -> counters
  let dirty = false;
  let lastSaveAt = -Infinity;
  let chain = Promise.resolve();

  /** Only today and yesterday (UTC) stay. */
  function prune() {
    const nowMs = now();
    const keep = new Set([utcDay(nowMs), utcDay(nowMs - DAY_MS)]);
    for (const day of Object.keys(days)) if (!keep.has(day)) delete days[day];
  }

  function load() {
    let parsed;
    try {
      parsed = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (error) {
      if (error?.code !== 'ENOENT') log.warn('usage: load failed', { code: error?.code ?? null });
      return;
    }
    if (!isPlainObject(parsed?.days)) return;
    for (const [day, roles] of Object.entries(parsed.days)) {
      if (!isPlainObject(roles)) continue;
      days[day] = Object.fromEntries(Object.entries(roles).filter(([, row]) => isPlainObject(row)).map(([role, row]) => [role, cleanRow(row)]));
    }
    prune();
  }

  function record({ role, promptTokens, cachedTokens, completionTokens, cost } = {}) {
    const day = utcDay(now());
    const key = typeof role === 'string' && role ? role : NO_ROLE;
    days[day] ??= {};
    const row = (days[day][key] ??= cleanRow(null));
    row.requests += 1;
    row.promptTokens += amountOr0(promptTokens);
    row.cachedTokens += amountOr0(cachedTokens);
    row.completionTokens += amountOr0(completionTokens);
    row.cost += amountOr0(cost);
    prune();
    dirty = true;
  }

  function byRole() {
    const today = days[utcDay(now())] ?? {};
    return Object.entries(today)
      .map(([role, row]) => ({ role, ...row }))
      .sort((a, b) => b.cost - a.cost || b.requests - a.requests || (a.role < b.role ? -1 : a.role > b.role ? 1 : 0));
  }

  async function write() {
    prune();
    const text = JSON.stringify({ v: VERSION, days });
    const tmp = `${file}.tmp`;
    await fs.promises.mkdir(dataDir, { recursive: true });
    await fs.promises.writeFile(tmp, text);
    await fs.promises.rename(tmp, file);
  }

  function save({ force = false } = {}) {
    const run = chain.then(async () => {
      if (!dirty || (!force && now() - lastSaveAt < SAVE_EVERY_MS)) return false;
      dirty = false;
      try {
        await write();
        lastSaveAt = now();
        return true;
      } catch (error) {
        dirty = true;
        log.warn('usage: save failed', { code: error?.code ?? null });
        return false;
      }
    });
    chain = run.catch(() => {});
    return run;
  }

  load();
  return { record, byRole, save };
}

/**
 * A log listener (src/log.js#onLog) feeding `usage` from every `llm: usage` line: its role, prompt,
 * cached and completion tokens, and its cost (`upstreamCost` when the line has one, else `cost`);
 * and from every `images: generated` line (src/llm/images.js, which logs no `llm: usage`): one
 * request of the `drawing` role with its `cost` and no tokens.
 * Never throws on an odd entry.
 * @param {{ record: Function }} usage
 * @returns {(entry: object) => void}
 */
export function usageTap(usage) {
  return (entry) => {
    if (!entry || typeof entry !== 'object') return;
    if (entry.msg === 'images: generated') {
      usage.record({ role: DRAWING_ROLE, cost: entry.cost });
      return;
    }
    if (entry.msg !== 'llm: usage') return;
    usage.record({
      role: entry.role,
      promptTokens: entry.promptTokens,
      cachedTokens: entry.cachedTokens,
      completionTokens: entry.completionTokens,
      cost: isAmount(entry.upstreamCost) ? entry.upstreamCost : entry.cost,
    });
  };
}

/**
 * One read-only account GET of the llm client (`keyInfo` or `credits`, src/llm/openrouter.js),
 * reduced to `{ ok: true, data }` (the answer's `data` object) or `{ ok: false, reason, status? }`
 * with `reason` one of `no-client` (no such method), `http` (a non-2xx answer, with its status),
 * `bad-answer` (no `data` object), `timeout`, `network`. Never rejects.
 * @param {(() => Promise<{ ok: boolean, status: number, json: object|null }>)|null|undefined} call
 * @returns {Promise<{ ok: true, data: object } | { ok: false, reason: string, status?: number }>}
 */
export async function readAccount(call) {
  if (typeof call !== 'function') return { ok: false, reason: 'no-client' };
  let answer;
  try {
    answer = await call();
  } catch (err) {
    return { ok: false, reason: err?.name === 'TimeoutError' || err?.name === 'AbortError' ? 'timeout' : 'network' };
  }
  if (!answer?.ok) return { ok: false, reason: 'http', status: answer?.status ?? null };
  if (!isPlainObject(answer.json?.data)) return { ok: false, reason: 'bad-answer' };
  return { ok: true, data: answer.json.data };
}

/** A token count for the card: `812`, `9.3k`, `974k`, `1.23M`. */
export function compactTokens(n) {
  const value = amountOr0(n);
  if (value < 1000) return String(Math.round(value));
  if (value < 10_000) return `${(value / 1000).toFixed(1)}k`;
  if (Math.round(value / 1000) < 1000) return `${Math.round(value / 1000)}k`;
  return `${(value / 1_000_000).toFixed(2)}M`;
}

/** Dollars with two decimals. */
const usd = (value) => amountOr0(value).toFixed(2);

/** `fill` of a label that is a non-empty string; null otherwise (the line is left out). */
function line(template, values) {
  return typeof template === 'string' && template ? fill(template, values) : null;
}

/** Why an account read failed, through `labels.reasons`. */
function reasonText(outcome, L) {
  const reasons = isPlainObject(L.reasons) ? L.reasons : {};
  const key = { timeout: 'timeout', network: 'network', http: 'http', 'no-client': 'noClient', 'bad-answer': 'badAnswer' }[outcome.reason] ?? 'badAnswer';
  return line(reasons[key], { status: outcome.status ?? '-' }) ?? outcome.reason;
}

/** The budget that describes the key's limit: the `key_limit` one, else the effective budget, else the first. */
function keyBudget(data) {
  const budgets = Array.isArray(data.budgets) ? data.budgets.filter(isPlainObject) : [];
  return budgets.find((budget) => budget.scope === 'key_limit') ?? (isPlainObject(data.effective_budget) ? data.effective_budget : null) ?? budgets[0] ?? null;
}

const INTERVAL_USAGE = Object.freeze({ daily: 'usage_daily', weekly: 'usage_weekly', monthly: 'usage_monthly' });

/** The key line (src: GET /key's `data`): spend over limit with its notes, or no limit with the total used. */
function keyLine(data, L, lead) {
  const budget = keyBudget(data);
  const limit = isAmount(budget?.limit_usd) ? budget.limit_usd : data.limit;
  if (!isAmount(limit)) {
    return isAmount(data.usage) ? line(L.keyNone, { lead, used: usd(data.usage) }) : line(L.keyNonePlain, { lead });
  }
  const hasReset = budget && Object.hasOwn(budget, 'reset_interval') ? true : Object.hasOwn(data, 'limit_reset');
  const interval = budget && Object.hasOwn(budget, 'reset_interval') ? budget.reset_interval : data.limit_reset;
  const remaining = isAmount(budget?.remaining_usd) ? budget.remaining_usd : data.limit_remaining;
  let spent = null;
  if (isAmount(budget?.spend_usd)) spent = budget.spend_usd;
  else if (isAmount(remaining)) spent = Math.max(0, limit - remaining);
  else if (interval === null && isAmount(data.usage)) spent = data.usage;
  else if (typeof interval === 'string' && isAmount(data[INTERVAL_USAGE[interval]])) spent = data[INTERVAL_USAGE[interval]];

  const notes = [];
  if (hasReset) {
    if (typeof interval === 'string' && interval) {
      const word = (isPlainObject(L.intervals) && typeof L.intervals[interval] === 'string' && L.intervals[interval]) || interval;
      const at = budget?.resets_at ? utcMinute(budget.resets_at) : null;
      notes.push(at && at !== '-' ? line(L.resetsAt, { interval: word, at }) : line(L.resets, { interval: word }));
    } else {
      notes.push(line(L.neverResets, {}));
    }
  }
  const byok = typeof budget?.include_byok === 'boolean' ? budget.include_byok : data.include_byok_in_limit;
  if (byok === true) notes.push(line(L.byokCounted, {}));
  if (byok === false) notes.push(line(L.byokNotCounted, {}));
  const kept = notes.filter(Boolean);
  const values = { lead, spent: spent === null ? '-' : usd(spent), limit: usd(limit) };
  return kept.length > 0 ? line(L.keyLimit, { ...values, notes: kept.join(L.noteSeparator ?? '') }) : line(L.keyLimitPlain, values);
}

/** The usage line: today, this week and this month from GET /key, each only when present. */
function usageLine(data, L) {
  const parts = [
    ['usage_daily', L.usageToday],
    ['usage_weekly', L.usageWeek],
    ['usage_monthly', L.usageMonth],
  ]
    .filter(([field]) => isAmount(data[field]))
    .map(([field, template]) => line(template, { usd: usd(data[field]) }))
    .filter(Boolean);
  return parts.length > 0 ? line(L.usage, { parts: parts.join(L.partSeparator ?? '') }) : null;
}

/** The credits line from GET /credits's `data`. */
function creditsLine(outcome, L) {
  if (!outcome?.ok) return line(L.creditsUnavailable, { reason: reasonText(outcome ?? { reason: 'bad-answer' }, L) });
  const { total_credits: bought, total_usage: used } = outcome.data;
  if (!isAmount(bought) || !isAmount(used)) return line(L.creditsUnavailable, { reason: reasonText({ reason: 'bad-answer' }, L) });
  return line(L.credits, { left: usd(bought - used), bought: usd(bought), used: usd(used) });
}

/** One role row (or the total) through `template`; a row with no token at all (a drawing) shows its
 * token counts as `-`. */
function rowLine(template, row) {
  const tokens = row.promptTokens + row.cachedTokens + row.completionTokens > 0;
  const count = (n) => (tokens ? compactTokens(n) : '-');
  return line(template, {
    role: row.role,
    requests: row.requests,
    in: count(row.promptTokens),
    cached: count(row.cachedTokens),
    out: count(row.completionTokens),
    cost: usd(row.cost),
  });
}

/**
 * The costs field's lines, every word from `labels.status.costs` (a missing label leaves its line
 * out; no `status.costs` at all gives []): the key line (`keyLimit` with its `notes` -- the reset
 * and whether BYOK counts -- or `keyLimitPlain`; `keyNone` / `keyNonePlain` without a limit;
 * `keyUnavailable` on a failed read; each takes the lead word `{lead}` from `keyLead`), then the
 * same line for the simulator key (lead `simKeyLead`; `simKeyNotSet` when `sim` is null), the
 * `usage` line when the key reports any, the `credits`
 * line (`creditsUnavailable` on a failed read), then today's roles: `byRoleHeader`, one `role`
 * line per row in the given order and the `total`, or `byRoleEmpty`. The key's label is never read.
 * Pure.
 * @param {{ key: object, sim?: object|null, credits: object, rows: object[], labels: object }} params
 *   `key`, `sim` (null: not set) and `credits` as `readAccount` resolves; `rows` as `createUsage().byRole()` returns.
 * @returns {string[]}
 */
export function costsLines({ key, sim = null, credits, rows, labels }) {
  const L = labels?.status?.costs;
  if (!isPlainObject(L)) return [];
  const lines = [];
  const lead = typeof L.keyLead === 'string' ? L.keyLead : '';
  const simLead = typeof L.simKeyLead === 'string' ? L.simKeyLead : '';
  const unavailable = (outcome, word) => line(L.keyUnavailable, { lead: word, reason: reasonText(outcome ?? { reason: 'bad-answer' }, L) });
  lines.push(key?.ok ? keyLine(key.data, L, lead) : unavailable(key, lead));
  lines.push(sim ? (sim.ok ? keyLine(sim.data, L, simLead) : unavailable(sim, simLead)) : line(L.simKeyNotSet, {}));
  if (key?.ok) lines.push(usageLine(key.data, L));
  lines.push(creditsLine(credits, L));
  const list = Array.isArray(rows) ? rows : [];
  if (list.length === 0) {
    lines.push(line(L.byRoleEmpty, {}));
  } else {
    lines.push(line(L.byRoleHeader, {}), ...list.map((row) => rowLine(L.role, row)));
    const total = { role: '', ...cleanRow(null) };
    for (const row of list) for (const field of COUNTERS) total[field] += amountOr0(row[field]);
    lines.push(rowLine(L.total, total));
  }
  return lines.filter(Boolean);
}
