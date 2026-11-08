// The probes of the three parts she cannot work without: her core, the analyzer and the memory writer. Each part is
// probed on the route it runs on now, its key (one minimal request, `checkRole`) or its harness (the vendor's status, then
// one one-word reply), by `routeProbe` of src/subharness/memory-probe.ts. Each has a watch of its own with the memory
// probe's timing: at core start, every `memory.probeMinutes` (default 30), and for the memory writer at once after a
// refused run. A failed probe while she runs pauses her with the part's reason, `core-down`, `analyzer-down` or
// `memory-down`, through the reasoned pause (src/keys/commands.ts#PauseControl), and the part's next passing probe lifts
// only that pause. When it lifts while another part's last probe failed, she sleeps again with that part's reason. A
// part that does not run passes with no request: an analyzer whose model is switched off, a memory session that is not
// `apply`. With no `fetch`, as in a core whose model client was injected, a part on the API passes with no request. The owner's word of 2026-11-08: the memory probe stays and the same probe applies to the core and the analyzer.

import type { PauseControl } from '../keys/commands.ts';
import { MEMORY_DOWN, createMemoryWatch, routeProbe } from './memory-probe.ts';
import type { MemoryProbeDeps, MemoryWatch, ProbePath, ProbeResult } from './memory-probe.ts';
import { memoryPath } from './memory-path.ts';
import { subscriptionPath } from './subscription-path.ts';

export const CORE_DOWN = 'core-down';
export const ANALYZER_DOWN = 'analyzer-down';

/** The parts the watches probe, in the order a round probes them. */
export const WATCHED_ROLES = ['core', 'analyzer', 'memory'] as const;
export type WatchedRole = (typeof WATCHED_ROLES)[number];

const REASONS: Readonly<Record<WatchedRole, string>> = {
  core: CORE_DOWN,
  analyzer: ANALYZER_DOWN,
  memory: MEMORY_DOWN,
};

export type RouteWatchDeps = {
  privateDir: string;
  /** null: the parts on the API are not probed, since nothing reaches the provider. */
  fetch: typeof fetch | null;
  baseUrl(): string;
  /** The key `role`'s requests go out on now; null when there is none. */
  route(role: WatchedRole): { name: string; value: string } | null;
  /** The model `role` runs on the API now; null while it is switched off. */
  model(role: WatchedRole): string | null;
  runBackend: MemoryProbeDeps['runBackend'];
  pause: PauseControl;
  now(): number;
  /** The live config, read at every probe and tick. */
  config(): unknown;
};

export type RouteWatches = {
  /** The probes at core start, one part after another. */
  start(): Promise<void>;
  /** The core's timer: each part whose interval has passed is probed. */
  tick(): Promise<void>;
  /** After a refused run of `role`: that part is probed at once. */
  refused(role: WatchedRole): Promise<ProbeResult>;
  /** The last probe of `role`, null before its first. */
  last(role: WatchedRole): ProbeResult | null;
};

/** A probe's result in one word: `unknown` before the first, then `ok` or `down`. */
export const probeWord = (result: ProbeResult | null): 'unknown' | 'ok' | 'down' =>
  result === null ? 'unknown' : result.ok ? 'ok' : 'down';

const rec = (value: unknown): Record<string, unknown> =>
  value !== null && typeof value === 'object' ? (value as Record<string, unknown>) : {};

/** Whether the memory writer runs: its session mode is `apply`. */
const writerRuns = (config: unknown): boolean => rec(rec(rec(config).memoryDb).session).mode === 'apply';

function pathOf(privateDir: string, role: WatchedRole): ProbePath {
  if (role === 'core') return subscriptionPath(privateDir, 'core');
  return role === 'memory' ? memoryPath(privateDir) : { kind: 'direct' };
}

export function createRouteWatches(deps: RouteWatchDeps): RouteWatches {
  const watches = new Map<WatchedRole, MemoryWatch>();
  const probe = (role: WatchedRole, now: number): Promise<ProbeResult> => {
    const model = deps.model(role);
    const path = pathOf(deps.privateDir, role);
    const fetch = deps.fetch;
    const off = role === 'memory' ? !writerRuns(deps.config()) : role === 'analyzer' && model === null;
    if (off || (fetch === null && path.kind !== 'subharness')) return Promise.resolve({ ok: true, at: now });
    return routeProbe(
      {
        privateDir: deps.privateDir,
        role,
        path: () => path,
        route: () => deps.route(role),
        fetch: fetch ?? globalThis.fetch,
        baseUrl: deps.baseUrl(),
        model: () => model ?? '',
        runBackend: deps.runBackend,
      },
      now
    );
  };
  /** The reason of another part whose last probe failed, for the sleep after one lifted. */
  const others = (role: WatchedRole): string | null => {
    const failing = WATCHED_ROLES.find((other) => other !== role && watches.get(other)?.last()?.ok === false);
    return failing === undefined ? null : REASONS[failing];
  };
  for (const role of WATCHED_ROLES)
    watches.set(
      role,
      createMemoryWatch({
        probe: (now) => probe(role, now),
        reason: REASONS[role],
        others: () => others(role),
        pause: deps.pause,
        now: () => deps.now(),
        config: () => deps.config(),
      })
    );
  const watch = (role: WatchedRole): MemoryWatch => {
    const found = watches.get(role);
    if (found === undefined) throw new Error(`no watch of ${role}`);
    return found;
  };
  return {
    async start() {
      for (const role of WATCHED_ROLES) await watch(role).start();
    },
    async tick() {
      for (const role of WATCHED_ROLES) await watch(role).tick();
    },
    refused: (role) => watch(role).refused(),
    last: (role) => watch(role).last(),
  };
}
