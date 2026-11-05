// What each backend's own account says about its use: `readBackendUsage` reads one source, `readAllUsage` all of them with
// one failure held apart, and `usageLines` draws them for `/usage` (src/interface/commands/console.ts). An observation is
// qualified by its source and account, and each metric by its scope. A native value stays as it came, a field the source
// did not report stays unknown, and no price is ever computed for a subscription's tokens. No read starts a model run. The
// sources are never summed, because OpenRouter's spend already holds what OpenCode spent on the same key; `apiAccounting`
// counts per-request records once for a caller that has them. Adapters: src/subharness/usage/.

import { execFile, spawn } from 'node:child_process';
import type { Readable, Writable } from 'node:stream';
import { readClaudeUsage } from './usage/claude.ts';
import { readCodexUsage } from './usage/codex.ts';
import { readOpenCodeUsage } from './usage/opencode.ts';
import { readOpenRouterUsage } from './usage/openrouter.ts';

export const USAGE_SOURCES = ['claude', 'codex', 'opencode', 'openrouter'] as const;
export type UsageSource = (typeof USAGE_SOURCES)[number];

export type UsageMetric = {
  name: string;
  /** whose number it is: the whole account, or this one session */
  scope: 'account' | 'session';
  unit: 'percent' | 'epoch-seconds' | 'minutes' | 'seconds' | 'days' | 'tokens' | 'usd' | 'count';
  /** the source's own value; null when it did not report one */
  value: number | null;
  state: 'observed' | 'unknown' | 'stale';
};

export type Observation = {
  source: UsageSource;
  account: { label: string | null };
  observedAt: number;
  availability: 'available' | 'unavailable' | 'unsupported';
  metrics: ReadonlyArray<UsageMetric>;
  errors: ReadonlyArray<{ code: string }>;
  /** how to read the number by hand where no automatic read exists */
  handoff: string | null;
};

/** A subscription's quota and an API key's spend are different things, so an observation says which it is. */
export type BackendUsage = (Observation & { variant: 'subscription' }) | (Observation & { variant: 'api' });

/** The part of a child process an adapter speaks to. */
export type UsageChild = {
  stdin: Writable;
  stdout: Readable;
  once(event: 'exit' | 'error', listener: (...args: Array<unknown>) => void): unknown;
  kill(): boolean;
};

export type UsageSpawn = (
  binary: string,
  args: ReadonlyArray<string>,
  options: { env: Readonly<Record<string, string>> }
) => UsageChild;

export type UsageExec = (
  binary: string,
  args: ReadonlyArray<string>,
  options: { env: Readonly<Record<string, string>> }
) => Promise<{ code: number; stdout: string; stderr: string }>;

export type UsageDeps = {
  privateDir: string;
  now(): number;
  fetch: typeof fetch;
  baseUrl: string;
  /** the key whose account the direct read names; null while there is none */
  openRouterKey: { name: string; value: string } | null;
  spawn: UsageSpawn;
  exec: UsageExec;
};

/** How long a vendor's own read may take (ms). A local read answers in about a second; measured 2026-11-05 on 0.164.0. */
const READ_MS = 15_000;

/** The child of an adapter, on the machine: its stderr is dropped, because it can hold what a log must not. */
export const spawnUsageChild: UsageSpawn = (binary, args, { env }) => {
  const child = spawn(binary, [...args], { env, stdio: ['pipe', 'pipe', 'ignore'] });
  return {
    stdin: child.stdin,
    stdout: child.stdout,
    once: (event, listener) => (event === 'exit' ? child.once('exit', listener) : child.once('error', listener)),
    kill: () => child.kill(),
  };
};

/** One command of an adapter, on the machine, to its end. */
export const execUsage: UsageExec = (binary, args, { env }) =>
  new Promise((resolve) => {
    const child = execFile(binary, [...args], { env, timeout: READ_MS, encoding: 'utf8' }, (error, stdout, stderr) => {
      const code = error === null ? 0 : typeof error.code === 'number' ? error.code : 1;
      resolve({ code, stdout, stderr });
    });
    child.stdin?.end();
  });

function readOne(source: UsageSource, deps: UsageDeps): Promise<BackendUsage> {
  switch (source) {
    case 'claude':
      return readClaudeUsage(deps);
    case 'codex':
      return readCodexUsage(deps);
    case 'opencode':
      return readOpenCodeUsage(deps);
    case 'openrouter':
      return readOpenRouterUsage({ ...deps, key: deps.openRouterKey });
  }
}

/** One source now. Never rejects, and an adapter's own error text stays out of the answer, since it can hold a value. */
export async function readBackendUsage(request: { source: UsageSource }, deps: UsageDeps): Promise<BackendUsage> {
  try {
    return await readOne(request.source, deps);
  } catch {
    const variant = request.source === 'claude' || request.source === 'codex' ? 'subscription' : 'api';
    return {
      variant,
      source: request.source,
      account: { label: null },
      observedAt: deps.now(),
      availability: 'unavailable',
      metrics: [],
      errors: [{ code: 'read-failed' }],
      handoff: null,
    };
  }
}

/** Every source now, in USAGE_SOURCES order. */
export function readAllUsage(deps: UsageDeps): Promise<Array<BackendUsage>> {
  return Promise.all(USAGE_SOURCES.map((source) => readBackendUsage({ source }, deps)));
}

/**
 * What to show after a read. A read that worked stands alone. A failed read of the same known account keeps the last
 * numbers, marked stale under their own time, and any other account or a logout drops them.
 */
export function reconcileUsage(previous: BackendUsage | null, fresh: BackendUsage): BackendUsage {
  const label = fresh.account.label;
  const isSameAccount = label !== null && previous?.account.label === label;
  if (fresh.availability !== 'unavailable' || previous === null || !isSameAccount) return fresh;
  return {
    ...previous,
    availability: 'unavailable',
    errors: fresh.errors,
    metrics: previous.metrics.map((one) => (one.state === 'observed' ? { ...one, state: 'stale' as const } : one)),
  };
}

/** The reader the console holds: every source now, each read against what the last one saw. */
export function backendUsageReader(deps: () => UsageDeps): () => Promise<Array<BackendUsage>> {
  const last = new Map<UsageSource, BackendUsage>();
  return async () => {
    const fresh = await readAllUsage(deps());
    return fresh.map((one) => {
      const shown = reconcileUsage(last.get(one.source) ?? null, one);
      last.set(one.source, shown);
      return shown;
    });
  };
}

type ApiRecord = {
  requestId: string;
  runId: string | null;
  source: 'opencode' | 'openrouter';
  usd: number | null;
  tokens: number;
};
type ApiTotal = { requests: number; usd: number; tokens: number; unknownUsd: number };

/**
 * API records counted once per request id. A request both sides recorded counts under OpenCode, which knows the run it
 * belonged to, and a request with no reported price counts as unknown and adds nothing to the dollars.
 */
export function apiAccounting(records: ReadonlyArray<ApiRecord>): Record<'opencode' | 'openrouter', ApiTotal> {
  const once = new Map<string, ApiRecord>();
  for (const record of records) {
    const seen = once.get(record.requestId);
    if (seen === undefined || (seen.source === 'openrouter' && record.source === 'opencode'))
      once.set(record.requestId, record);
  }
  const totals = {
    opencode: { requests: 0, usd: 0, tokens: 0, unknownUsd: 0 },
    openrouter: { requests: 0, usd: 0, tokens: 0, unknownUsd: 0 },
  };
  for (const { source, usd, tokens } of once.values()) {
    const total = totals[source];
    total.requests += 1;
    total.tokens += tokens;
    if (usd === null) total.unknownUsd += 1;
    else total.usd += usd;
  }
  return totals;
}

/** A time to the minute, as the observation lines and the reset times print it. */
const minuteOf = (ms: number): string => `${new Date(ms).toISOString().slice(0, 16)}Z`;

function valueText({ unit, value }: UsageMetric & { value: number }): string {
  switch (unit) {
    case 'percent':
      return `${value}%`;
    case 'usd':
      return `$${value}`;
    case 'epoch-seconds':
      return minuteOf(value * 1000);
    case 'minutes':
      return `${value} min`;
    case 'seconds':
      return `${value} s`;
    case 'days':
      return `${value} days`;
    case 'tokens':
    case 'count':
      return String(value);
  }
}

function metricLine(metric: UsageMetric): string {
  const scope = metric.scope === 'session' ? ' (this session)' : '';
  if (metric.value === null) return `  ${metric.name}: unknown${scope}`;
  const stale = metric.state === 'stale' ? ' (stale)' : '';
  return `  ${metric.name}: ${valueText({ ...metric, value: metric.value })}${scope}${stale}`;
}

/** The daily rows a block prints at most, the newest ones; the others are counted. */
const DAILY_ROWS = 7;

function metricLines(metrics: ReadonlyArray<UsageMetric>): Array<string> {
  const daily = metrics.filter((one) => one.name.startsWith('daily.'));
  const older = daily.length - DAILY_ROWS;
  const dropped = new Set(older > 0 ? [...daily].sort((a, b) => a.name.localeCompare(b.name)).slice(0, older) : []);
  return [
    ...metrics.filter((one) => !dropped.has(one)).map(metricLine),
    ...(older > 0 ? [`  ${older} older days not shown`] : []),
  ];
}

function headLine(usage: BackendUsage, now: number): string {
  const minutes = Math.floor((now - usage.observedAt) / 60_000);
  const ago = minutes > 0 ? `, ${minutes} min ago` : '';
  const kind = usage.variant === 'api' ? 'API account' : 'subscription';
  return `${usage.source} ${kind} · ${usage.account.label ?? 'account unknown'} · observed ${minuteOf(usage.observedAt)}${ago}`;
}

/** The blocks of `/usage`, one per observation, each naming its source, its account and its time. */
export function usageLines(usages: ReadonlyArray<BackendUsage>, now: number): Array<string> {
  return usages.flatMap((usage) => [
    headLine(usage, now),
    ...(usage.availability === 'unsupported' ? ['  no automatic read for this source'] : []),
    ...metricLines(usage.metrics),
    ...usage.errors.map((one) => `  not read: ${one.code}`),
    ...(usage.handoff === null ? [] : [`  by hand: ${usage.handoff}`]),
  ]);
}
