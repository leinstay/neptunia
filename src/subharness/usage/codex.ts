// Codex's native usage over its app-server, the documented JSON lines of `codex app-server`: `initialize`, the
// `initialized` notification, then the three account reads. No method here can start a turn. The child runs under the
// persona's backend home and is ended when the reads are in or the deadline passes. Whether the account is logged in is what
// `account/read` itself answers, so no status command runs beside it. src/subharness/usage.ts reads through this.

import { isInstalled, subharnessPlace, vendorEnv } from '../place.ts';
import type { BackendUsage, Observation, UsageMetric, UsageSpawn } from '../usage.ts';

export type CodexUsageDeps = { privateDir: string; now(): number; spawn: UsageSpawn; timeoutMs?: number };

/** How long the whole read may take (ms); a local app-server answered in about a second, measured 2026-11-05 on 0.164.0. */
const DEADLINE_MS = 15_000;

const INITIALIZE_ID = 1;
const READS = { account: 'account/read', limits: 'account/rateLimits/read', usage: 'account/usage/read' } as const;
type ReadName = keyof typeof READS;
const READ_IDS: Readonly<Record<ReadName, number>> = { account: 2, limits: 3, usage: 4 };
const READ_NAMES = Object.keys(READS) as Array<ReadName>;

type Reply = { result: unknown } | { error: unknown };
type Replies = { byRead: Partial<Record<ReadName, Reply>>; timedOut: boolean };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** Speaks to one child until every read is answered, it ends, or the deadline passes, and always ends it. */
function askAppServer(deps: CodexUsageDeps): Promise<Replies> {
  const { binary } = subharnessPlace(deps.privateDir, 'codex');
  return new Promise((resolve, reject) => {
    const child = deps.spawn(binary, ['app-server'], { env: vendorEnv(deps.privateDir, 'codex') });
    const byRead: Replies['byRead'] = {};
    let isDone = false;
    const finish = (timedOut: boolean): void => {
      if (isDone) return;
      isDone = true;
      clearTimeout(timer);
      child.kill();
      resolve({ byRead, timedOut });
    };
    const timer = setTimeout(() => finish(true), deps.timeoutMs ?? DEADLINE_MS);
    const send = (message: unknown): void => void child.stdin.write(`${JSON.stringify(message)}\n`);

    const onLine = (line: string): void => {
      let message: unknown;
      try {
        message = JSON.parse(line);
      } catch {
        // A line that is no JSON is the CLI's own noise; a read it should have answered then reaches the deadline.
        return;
      }
      if (!isRecord(message)) return;
      if (message.id === INITIALIZE_ID) {
        if ('error' in message) {
          finish(false);
          return;
        }
        send({ method: 'initialized' });
        for (const name of READ_NAMES) send({ id: READ_IDS[name], method: READS[name], params: {} });
        return;
      }
      const name = READ_NAMES.find((one) => READ_IDS[one] === message.id);
      if (name === undefined) return;
      byRead[name] = 'result' in message ? { result: message.result } : { error: message.error };
      if (READ_NAMES.every((one) => byRead[one] !== undefined)) finish(false);
    };

    let buffer = '';
    child.stdout.on('data', (chunk: Buffer | string) => {
      buffer += String(chunk);
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) if (line.trim() !== '') onLine(line);
    });
    child.stdin.on('error', () => finish(false));
    child.once('exit', () => finish(false));
    child.once('error', () => {
      clearTimeout(timer);
      isDone = true;
      reject(new Error('codex app-server did not start'));
    });
    send({ id: INITIALIZE_ID, method: 'initialize', params: { clientInfo: { name: 'neptunia', version: '0' } } });
  });
}

/** One native number: a number as it came, anything else unknown. */
function metric(name: string, unit: UsageMetric['unit'], value: unknown): UsageMetric {
  return typeof value === 'number'
    ? { name, scope: 'account', unit, value, state: 'observed' }
    : { name, scope: 'account', unit, value: null, state: 'unknown' };
}

function windowMetrics(prefix: string, window: unknown): Array<UsageMetric> {
  const read = isRecord(window) ? window : {};
  return [
    metric(`${prefix}.usedPercent`, 'percent', read.usedPercent),
    metric(`${prefix}.resetsAt`, 'epoch-seconds', read.resetsAt),
    metric(`${prefix}.windowDurationMins`, 'minutes', read.windowDurationMins),
  ];
}

function limitMetrics(result: unknown): Array<UsageMetric> {
  const limits = isRecord(result) && isRecord(result.rateLimits) ? result.rateLimits : {};
  return [...windowMetrics('primary', limits.primary), ...windowMetrics('secondary', limits.secondary)];
}

function activityMetrics(result: unknown): Array<UsageMetric> {
  const read = isRecord(result) ? result : {};
  const summary = isRecord(read.summary) ? read.summary : {};
  const days = Array.isArray(read.dailyUsageBuckets) ? (read.dailyUsageBuckets as Array<unknown>) : [];
  return [
    metric('lifetimeTokens', 'tokens', summary.lifetimeTokens),
    metric('peakDailyTokens', 'tokens', summary.peakDailyTokens),
    metric('longestRunningTurnSec', 'seconds', summary.longestRunningTurnSec),
    metric('currentStreakDays', 'days', summary.currentStreakDays),
    metric('longestStreakDays', 'days', summary.longestStreakDays),
    ...days.flatMap((day) =>
      isRecord(day) && typeof day.startDate === 'string'
        ? [metric(`daily.${day.startDate}.tokens`, 'tokens', day.tokens)]
        : []
    ),
  ];
}

/** The account's name: the email and plan of a subscription, or that it runs on an API key. */
function accountLabel(account: Record<string, unknown>): string {
  if (typeof account.email !== 'string') return 'API key';
  return typeof account.planType === 'string' ? `${account.email} (${account.planType})` : account.email;
}

/** Codex's account now. A read that fails keeps the others, under its own error code. */
export async function readCodexUsage(deps: CodexUsageDeps): Promise<BackendUsage> {
  const answer = (over: Partial<Observation>): BackendUsage => ({
    variant: 'subscription',
    source: 'codex',
    account: { label: null },
    observedAt: deps.now(),
    availability: 'unavailable',
    metrics: [],
    errors: [],
    handoff: null,
    ...over,
  });
  if (!isInstalled(deps.privateDir, 'codex')) return answer({ errors: [{ code: 'not-installed' }] });
  let replies: Replies;
  try {
    replies = await askAppServer(deps);
  } catch {
    return answer({ errors: [{ code: 'read-failed' }] });
  }
  const { byRead, timedOut } = replies;
  const missing = timedOut ? 'timeout' : 'read-failed';
  const account = byRead.account;
  if (account === undefined) return answer({ errors: [{ code: missing }] });
  if (!('result' in account)) return answer({ errors: [{ code: 'account-read-failed' }] });
  const found = isRecord(account.result) ? account.result.account : null;
  if (!isRecord(found)) return answer({ errors: [{ code: 'not-logged-in' }] });
  const problem = (reply: Reply | undefined, failed: string): Array<{ code: string }> =>
    reply === undefined ? [{ code: missing }] : 'error' in reply ? [{ code: failed }] : [];
  const resultOf = (reply: Reply | undefined): Array<unknown> =>
    reply !== undefined && 'result' in reply ? [reply.result] : [];
  return answer({
    account: { label: accountLabel(found) },
    availability: 'available',
    metrics: [...resultOf(byRead.limits).flatMap(limitMetrics), ...resultOf(byRead.usage).flatMap(activityMetrics)],
    errors: [...problem(byRead.limits, 'limits-read-failed'), ...problem(byRead.usage, 'usage-read-failed')],
  });
}
