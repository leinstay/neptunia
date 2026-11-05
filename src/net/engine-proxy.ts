// The engine proxy as the core runs it (src/core.ts calls `startEngineProxy` once, before anything connects). A stored
// `videoProxy` moves under `proxy` once (src/keys/services.ts#migrateProxyService), then one monitor
// (src/net/proxy.ts) holds the route of the core process's connections, yt-dlp's and every agent run's, and hands the
// URL in force to Node for the whole process (src/net/global-proxy.ts). The first check puts a proxy that is on in
// force at once; a timer checks again every few seconds, and the monitor probes once per `proxy.health.everySeconds`.
// A fallback or a recovery reaches the persona as a `proxySwitched` fact once `tellTo` has her facts, like any
// failure, and the log either way. The interfaces never take the proxy: they run as their own processes.

import { serviceCredential } from '../keys/file.ts';
import { migrateProxyService } from '../keys/services.ts';
import { createGlobalProxy } from './global-proxy.ts';
import { createProxyMonitor, probeProxy } from './proxy.ts';
import type { ProxyMonitor, ProxyProbe, ProxySwitch } from './proxy.ts';

/** The two levels of the engine's log this module writes. */
type Log = Record<'info' | 'warn', (message: string, fields: Record<string, unknown>) => void>;

/** How often the core looks at the switch (ms); the probe has its own interval. */
const CHECK_EVERY_MS = 5_000;

/** The part of the inner life's facts a switch is told through. */
type Facts = {
  enabled?: () => boolean;
  add: (fact: { kind: string; at: number } & Record<string, unknown>) => unknown;
};

export type EngineProxy = Pick<ProxyMonitor, 'current' | 'route'> & {
  probe: ProxyProbe;
  /** From now on a switch is told to her as a `proxySwitched` fact. */
  tellTo(facts: Facts | null | undefined): void;
  stop(): void;
};

export function startEngineProxy({
  dataDir,
  config,
  now,
  log,
}: {
  dataDir: string;
  config: () => unknown;
  now: () => number;
  log: Log;
}): EngineProxy {
  try {
    const moved = migrateProxyService(dataDir);
    if (moved !== 'none') log.info('proxy: the stored video proxy is the engine proxy now', { migration: moved });
  } catch (err) {
    log.warn('proxy: the video proxy could not be moved', { code: (err as NodeJS.ErrnoException).code ?? null });
  }
  let facts: Facts | null = null;
  function tell(change: ProxySwitch): void {
    log.warn('proxy: switch', { change });
    try {
      if (facts?.enabled?.() === true) facts.add({ kind: 'proxySwitched', code: change, why: change, at: now() });
    } catch (err) {
      log.warn('proxy: switch not told', { change, code: (err as NodeJS.ErrnoException).code ?? null });
    }
  }
  const globalProxy = createGlobalProxy();
  const monitor = createProxyMonitor({
    url: () => serviceCredential(dataDir, 'proxy'),
    config,
    probe: probeProxy,
    now,
    apply: (inForce) => {
      globalProxy.apply(inForce);
      log.info('proxy: route', { route: inForce === null ? 'direct' : 'proxy' });
    },
    onSwitch: tell,
  });
  void monitor.check();
  const timer = setInterval(() => void monitor.check(), CHECK_EVERY_MS);
  timer.unref();
  return {
    current: () => monitor.current(),
    route: () => monitor.route(),
    probe: probeProxy,
    tellTo(given) {
      facts = given ?? null;
    },
    stop: () => clearInterval(timer),
  };
}
