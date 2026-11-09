// The engine proxy as the core runs it (src/core.ts calls `startEngineProxy` once, before anything connects). One monitor
// (src/net/proxy.ts) holds the route of the core process's connections, yt-dlp's and every agent run's, and hands the
// URL in force to Node for the whole process (src/net/global-proxy.ts). The core starts on the direct route, and the
// first check probes at once and puts the proxy in force only when it answers; a timer checks again every few seconds,
// and the monitor probes once per `proxy.health.everySeconds`. A request of the process that cannot reach the proxy,
// read from Node's `http.client.request.error` and undici's `undici:client:connectError` diagnostics channels, probes
// at once and goes direct when the probe fails; the failed request itself is not retried.
// A fallback or a recovery reaches the persona as a `proxySwitched` fact once `tellTo` has her facts, like any
// failure, and the log either way. The interfaces never take the proxy: they run as their own processes.

import diagnostics from 'node:diagnostics_channel';
import { serviceCredential } from '../keys/file.ts';
import { createGlobalProxy } from './global-proxy.ts';
import type { SetGlobalProxy } from './global-proxy.ts';
import { createProxyMonitor, isProxyConnectionFailure, probeProxy } from './proxy.ts';
import type { ProxyMonitor, ProxyProbe, ProxySwitch } from './proxy.ts';

/** The two levels of the engine's log this module writes. */
type Log = Record<'info' | 'warn', (message: string, fields: Record<string, unknown>) => void>;

/** How often the core looks at the switch (ms); the probe has its own interval. */
const CHECK_EVERY_MS = 5_000;

/** The diagnostics channels on which Node's http client and undici publish a request that failed to connect. */
const FAILURE_CHANNELS = ['http.client.request.error', 'undici:client:connectError'];

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
  url = () => serviceCredential(dataDir, 'proxy'),
  probe = probeProxy,
  setGlobal,
}: {
  dataDir: string;
  config: () => unknown;
  now: () => number;
  log: Log;
  /** The stored proxy URL, the `proxy` service of keys.json by default. */
  url?: () => string | null;
  probe?: ProxyProbe;
  /** Node's global proxy setter, `http.setGlobalProxyFromEnv` by default. */
  setGlobal?: SetGlobalProxy;
}): EngineProxy {
  let facts: Facts | null = null;
  function tell(change: ProxySwitch): void {
    log.warn('proxy: switch', { change });
    try {
      if (facts?.enabled?.() === true) facts.add({ kind: 'proxySwitched', code: change, why: change, at: now() });
    } catch (err) {
      log.warn('proxy: switch not told', { change, code: (err as NodeJS.ErrnoException).code ?? null });
    }
  }
  const globalProxy = createGlobalProxy(setGlobal);
  const monitor = createProxyMonitor({
    url,
    config,
    probe,
    now,
    apply: (inForce) => {
      globalProxy.apply(inForce);
      log.info('proxy: route', { route: inForce === null ? 'direct' : 'proxy' });
    },
    onSwitch: tell,
  });
  const onFailure = (message: unknown): void => {
    const error = typeof message === 'object' && message !== null ? (message as { error?: unknown }).error : null;
    if (isProxyConnectionFailure(error)) void monitor.suspect();
  };
  for (const name of FAILURE_CHANNELS) diagnostics.subscribe(name, onFailure);
  void monitor.check();
  const timer = setInterval(() => void monitor.check(), CHECK_EVERY_MS);
  timer.unref();
  return {
    current: () => monitor.current(),
    route: () => monitor.route(),
    probe,
    tellTo(given) {
      facts = given ?? null;
    },
    stop() {
      clearInterval(timer);
      for (const name of FAILURE_CHANNELS) diagnostics.unsubscribe(name, onFailure);
    },
  };
}
