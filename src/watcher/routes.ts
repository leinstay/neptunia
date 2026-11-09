// The degraded routes of the core, read from its journal for the first page of `services watcher evidence`
// (src/service/watcher.ts), with no model call. The core logs one JSON object per line (src/log.ts), and four of its
// lines say when a route stopped or started working: `proxy: switch` and `proxy: route` of the engine proxy
// (src/net/engine-proxy.ts), `youtube-check: status` of the startup YouTube check (src/memory/youtube-check.ts),
// `subscription: run failed` and `subscription: step` of a harness backend (src/subharness/subscription-client.ts).
// A route is down from the first failure after its last success, across restarts, and `routeFacts` lists it when it
// has been down longer than `watcher.degradedAfterMinutes`. `llm: route switched` (src/llm/route-chain.ts) logs no
// recovery, so a chain's switches are counted in the observation window instead. Only names, times and counts leave.

import { CORE_UNIT, unitScope } from '../service/manager.ts';
import type { Environment, RunManager } from '../service/manager.ts';
import { objOf } from '../tools/types.ts';
import { watcherSettings } from './settings.ts';

/** How far back the journal is read for the start of an outage. */
const LOOKBACK_DAYS = 14;

/** The messages read; journalctl's `--grep` keeps every other line of the core out of the read. */
const MESSAGES = [
  'proxy: switch',
  'proxy: route',
  'youtube-check: status',
  'subscription: run failed',
  'subscription: step',
  'llm: route switched',
];

/** The codes of `subscription: run failed` that mean the harness lost its login (src/subharness/login-state.ts). */
const LOGIN_CODES = new Set(['subscription-login', 'not-logged-in']);

/** A route that has been down longer than the threshold: since when, and for how many minutes. */
export type DegradedRoute = {
  route: 'proxy' | 'youtube' | 'harness-login';
  name: string;
  since: string;
  minutes: number;
};

/** The switches of one role from one route to another in the observation window, and the last one's time. */
export type RouteSwitches = { role: string; from: string; to: string; count: number; last: string };

export type RouteFacts = {
  thresholdMinutes: number;
  down: Array<DegradedRoute>;
  switches: Array<RouteSwitches>;
  /** Why the journal could not be read, null when it was. */
  unavailable: string | null;
};

type Entry = { at: number; msg: string; fields: Record<string, unknown> };

function entriesOf(journal: string): Array<Entry> {
  const entries: Array<Entry> = [];
  for (const text of journal.split('\n')) {
    if (!text.startsWith('{')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      continue;
    }
    const fields = objOf(parsed);
    const at = typeof fields.time === 'string' ? Date.parse(fields.time) : NaN;
    if (typeof fields.msg !== 'string' || Number.isNaN(at)) continue;
    entries.push({ at, msg: fields.msg, fields });
  }
  return entries.sort((a, b) => a.at - b.at);
}

/** What one entry says of a route: its key, and whether the route failed or worked; null for anything else. */
function verdictOf(entry: Entry): { route: DegradedRoute['route']; name: string; failed: boolean } | null {
  const { msg, fields } = entry;
  if (msg === 'proxy: switch' && (fields.change === 'proxy-down' || fields.change === 'proxy-back'))
    return { route: 'proxy', name: 'proxy', failed: fields.change === 'proxy-down' };
  if (msg === 'proxy: route' && fields.route === 'proxy') return { route: 'proxy', name: 'proxy', failed: false };
  if (msg === 'youtube-check: status' && typeof fields.status === 'string')
    return { route: 'youtube', name: 'youtube', failed: fields.status === 'page' || fields.status === 'blocked' };
  if (typeof fields.backend !== 'string') return null;
  if (msg === 'subscription: step') return { route: 'harness-login', name: fields.backend, failed: false };
  if (msg === 'subscription: run failed' && typeof fields.code === 'string' && LOGIN_CODES.has(fields.code))
    return { route: 'harness-login', name: fields.backend, failed: true };
  return null;
}

/** The degraded routes and the chain switches of `journal`, the core's log lines. */
export function routeFacts(
  journal: string,
  options: { now: number; window: { from: number; to: number }; thresholdMinutes: number; proxyOn: boolean }
): RouteFacts {
  const downSince = new Map<string, { route: DegradedRoute['route']; name: string; at: number }>();
  const switches = new Map<string, RouteSwitches & { at: number }>();
  for (const entry of entriesOf(journal)) {
    if (entry.msg === 'llm: route switched') {
      if (entry.at < options.window.from || entry.at > options.window.to) continue;
      const [role, from, to] = [entry.fields.role, entry.fields.from, entry.fields.to].map(String);
      const key = JSON.stringify([role, from, to]);
      const seen = switches.get(key);
      switches.set(key, {
        role,
        from,
        to,
        count: (seen?.count ?? 0) + 1,
        last: new Date(entry.at).toISOString(),
        at: entry.at,
      });
      continue;
    }
    const verdict = verdictOf(entry);
    if (verdict === null) continue;
    const key = `${verdict.route}:${verdict.name}`;
    if (!verdict.failed) downSince.delete(key);
    else if (!downSince.has(key)) downSince.set(key, { route: verdict.route, name: verdict.name, at: entry.at });
  }
  const down: Array<DegradedRoute> = [];
  for (const { route, name, at } of downSince.values()) {
    const minutes = Math.floor((options.now - at) / 60_000);
    if (route === 'proxy' && !options.proxyOn) continue;
    if (minutes <= options.thresholdMinutes) continue;
    down.push({ route, name, since: new Date(at).toISOString(), minutes });
  }
  return {
    thresholdMinutes: options.thresholdMinutes,
    down,
    switches: [...switches.values()].map(({ role, from, to, count, last }) => ({ role, from, to, count, last })),
    unavailable: null,
  };
}

/** Reads the core's journal of the last `LOOKBACK_DAYS` through `run` and answers its degraded routes. Never rejects. */
export async function readRouteFacts(input: {
  run: RunManager;
  env: Environment;
  now: number;
  window: { from: number; to: number };
  config: unknown;
}): Promise<RouteFacts> {
  const thresholdMinutes = watcherSettings(input.config).degradedAfterMinutes;
  const proxyOn = objOf(objOf(input.config).proxy).enabled === true;
  const since = Math.floor(input.now / 1000) - LOOKBACK_DAYS * 86_400;
  const scope = unitScope(input.env) === 'user' ? ['--user'] : [];
  const args = [...scope, '-u', CORE_UNIT, '--no-pager', '-o', 'cat', '--since', `@${since}`];
  args.push('-g', `"msg":"(${MESSAGES.join('|')})"`);
  const empty = (unavailable: string | null): RouteFacts => ({ thresholdMinutes, down: [], switches: [], unavailable });
  try {
    const done = await input.run('journalctl', args);
    if (done.code !== 0) {
      if (/No entries/.test(`${done.stdout}${done.stderr ?? ''}`)) return empty(null);
      return empty(/permission/i.test(done.stderr ?? '') ? 'journal-permission' : `journalctl-exit-${done.code}`);
    }
    return routeFacts(done.stdout, { now: input.now, window: input.window, thresholdMinutes, proxyOn });
  } catch (error) {
    return empty(`journalctl-${(error as NodeJS.ErrnoException).code ?? 'error'}`);
  }
}
