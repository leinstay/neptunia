// The engine proxy's route and health. The owner stores one proxy URL as the `proxy` service of keys.json and turns it
// on with `proxy.enabled`; `createProxyMonitor` then holds the route every outbound connection takes: `off` while the
// switch is off or no URL is stored, `proxy` while the proxy answers, `direct` after `proxy.health.failures` failed
// probes in a row, and `proxy` again after `proxy.health.recoveries` good ones. It probes at most once per
// `proxy.health.everySeconds`, hands the URL in force to `apply` whenever it changes (src/net/global-proxy.ts sets it
// for the whole process) and tells `onSwitch` of each fallback and recovery, so the persona learns of it as of any
// failure. The core (src/core.ts) runs one; the interfaces never take the proxy. A worker with no monitor of its own
// (the watcher, the development worker) decides each agent run with `proxyForRun`, one probe before the run.
// `proxyEnvOf` is the environment a child process gets for the URL in force, and `probeProxy` the default probe. A
// URL may carry a login and a password: nothing here logs one.

import https from 'node:https';

/** Where outbound connections go now. */
export type ProxyRoute = 'off' | 'proxy' | 'direct';
/** A switch the persona is told of: the proxy stopped answering, or it answers again. */
export type ProxySwitch = 'proxy-down' | 'proxy-back';
/** One probe of `url` through the proxy, true when an answer came back within `timeoutMs`. */
export type ProxyProbe = (url: string, timeoutMs: number) => Promise<boolean>;

/**
 * The hosts a child and the process always reach directly: the local services, and OpenRouter, whose chat completions
 * came back through the residential proxy as `Malformed_HTTP_Response` (measured on 2026-11-05).
 */
export const NO_PROXY = 'localhost,127.0.0.1,::1,openrouter.ai';

/** What a probe asks for through the proxy: a small HTTPS answer, so the tunnel and the proxy's login both count. */
const PROBE_URL = 'https://www.cloudflare.com/cdn-cgi/trace';

/** The health settings as the monitor reads them, each time it checks. */
export type ProxySettings = {
  enabled: boolean;
  health: { everySeconds: number; failures: number; recoveries: number; timeoutMs: number };
};

/** The defaults of `proxy.*` in config/config.json, used for a value that is missing or not a positive number. */
const DEFAULTS: ProxySettings = {
  enabled: false,
  health: { everySeconds: 60, failures: 3, recoveries: 2, timeoutMs: 8000 },
};

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const positive = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;

/** `proxy.*` of the live settings, with the defaults for what is missing. */
export function proxySettings(config: unknown): ProxySettings {
  const proxy = isRecord(config) && isRecord(config.proxy) ? config.proxy : {};
  const health = isRecord(proxy.health) ? proxy.health : {};
  return {
    enabled: proxy.enabled === true,
    health: {
      everySeconds: positive(health.everySeconds, DEFAULTS.health.everySeconds),
      failures: Math.ceil(positive(health.failures, DEFAULTS.health.failures)),
      recoveries: Math.ceil(positive(health.recoveries, DEFAULTS.health.recoveries)),
      timeoutMs: positive(health.timeoutMs, DEFAULTS.health.timeoutMs),
    },
  };
}

/**
 * The http form of a proxy URL, the one HTTPS_PROXY and Node take: a `socks5h://` URL becomes the `http://` one with the
 * same login, host and port (the proxy serves both on one port), an `http://` or `https://` URL stays as it is, and
 * anything else, or a blank value, is null.
 */
export function httpProxyForm(url: unknown): string | null {
  if (typeof url !== 'string' || !url.trim()) return null;
  let parsed: URL;
  try {
    parsed = new URL(url.trim());
  } catch {
    return null;
  }
  if (parsed.protocol === 'http:' || parsed.protocol === 'https:') return url.trim();
  if (parsed.protocol !== 'socks5h:' || !parsed.hostname || !parsed.port) return null;
  const auth = parsed.username ? `${parsed.username}${parsed.password ? `:${parsed.password}` : ''}@` : '';
  return `http://${auth}${parsed.host}`;
}

/** Whether `url` can be stored as the engine proxy: an http form exists, and the URL names its host and port. */
export function isProxyUrl(url: string): boolean {
  if (httpProxyForm(url) === null) return false;
  try {
    const parsed = new URL(url.trim());
    return parsed.hostname !== '' && parsed.port !== '';
  } catch {
    return false;
  }
}

/**
 * The proxy variables of a child for `url` in force: HTTPS_PROXY and HTTP_PROXY in the http form, under both the upper
 * and the lower case spelling, since curl reads only the lower case `http_proxy`, and NO_PROXY for the local hosts and OpenRouter.
 * Empty for no URL or one with no http form, so a child on the direct path gets no proxy variable at all.
 */
export function proxyEnvOf(url: string | null): Record<string, string> {
  const form = httpProxyForm(url);
  if (form === null) return {};
  return {
    HTTPS_PROXY: form,
    HTTP_PROXY: form,
    https_proxy: form,
    http_proxy: form,
    NO_PROXY,
    no_proxy: NO_PROXY,
  };
}

/** The names `proxyEnvOf` sets, which a child on the direct path must not inherit from anywhere. */
export const PROXY_ENV_NAMES = Object.freeze([
  'HTTPS_PROXY',
  'HTTP_PROXY',
  'https_proxy',
  'http_proxy',
  'ALL_PROXY',
  'all_proxy',
  'NO_PROXY',
  'no_proxy',
]);

/**
 * The default probe: one HTTPS request through an agent of its own that tunnels through `url`, so the process's global
 * setting plays no part and a proxy that refuses the login fails. Any HTTP status counts as an answer.
 */
export function probeProxy(url: string, timeoutMs: number): Promise<boolean> {
  const form = httpProxyForm(url);
  if (form === null) return Promise.resolve(false);
  const agent = new https.Agent({ proxyEnv: { HTTPS_PROXY: form } });
  return new Promise<boolean>((resolve) => {
    const request = https.get(PROBE_URL, { agent, timeout: timeoutMs }, (response) => {
      response.resume();
      resolve(true);
    });
    request.on('timeout', () => request.destroy(new Error('timeout')));
    request.on('error', () => resolve(false));
  }).finally(() => agent.destroy());
}

/**
 * The proxy one agent run of a worker without a monitor takes: the stored URL while the proxy is on and answers one
 * probe now, else null, the direct path.
 */
export async function proxyForRun({
  url,
  config,
  probe = probeProxy,
}: {
  url: string | null;
  config: unknown;
  probe?: ProxyProbe;
}): Promise<string | null> {
  const settings = proxySettings(config);
  if (!settings.enabled || url === null) return null;
  try {
    return (await probe(url, settings.health.timeoutMs)) ? url : null;
  } catch {
    return null;
  }
}

/** What `createProxyMonitor` reads and calls. */
export type ProxyMonitorDeps = {
  /** The stored URL, read at each check; null while none is stored. */
  url: () => string | null;
  /** The live settings; `proxy.*` is read at each check. */
  config: () => unknown;
  probe: ProxyProbe;
  now: () => number;
  /** Takes the URL in force, null for the direct path, each time it changes. */
  apply?: (inForce: string | null) => void;
  /** Told of each switch to the direct path and back; never of `proxy off`. */
  onSwitch?: (change: ProxySwitch) => void;
};

export type ProxyMonitor = {
  /** Brings the route up to date with the settings and, once an interval has passed, probes. Never rejects. */
  check(): Promise<void>;
  route(): ProxyRoute;
  /** The URL connections take now, null on the direct path or with the proxy off. */
  current(): string | null;
};

/**
 * The monitor of one process. A check with a new URL, or with the proxy just turned on, puts that URL in force at once
 * (`apply` runs before the probe) and starts the counts over; turning the proxy off goes direct at the next check
 * without a notice. A probe that throws counts as a failure.
 */
export function createProxyMonitor({
  url,
  config,
  probe,
  now,
  apply = () => {},
  onSwitch = () => {},
}: ProxyMonitorDeps): ProxyMonitor {
  let route: ProxyRoute = 'off';
  let watched: string | null = null;
  let inForce: string | null = null;
  let failures = 0;
  let recoveries = 0;
  let probedAt: number | null = null;
  let probing = false;

  function put(next: string | null): void {
    if (next === inForce) return;
    inForce = next;
    apply(next);
  }

  async function probed(target: string, timeoutMs: number): Promise<boolean> {
    try {
      return await probe(target, timeoutMs);
    } catch {
      return false;
    }
  }

  async function check(): Promise<void> {
    const settings = proxySettings(config());
    const stored = url();
    const at = now();
    if (!settings.enabled || stored === null) {
      route = 'off';
      watched = null;
      put(null);
      return;
    }
    if (stored !== watched) {
      watched = stored;
      route = 'proxy';
      failures = 0;
      recoveries = 0;
      probedAt = null;
      put(stored);
    }
    if (probing || (probedAt !== null && at - probedAt < settings.health.everySeconds * 1000)) return;
    probing = true;
    probedAt = at;
    const answered = await probed(stored, settings.health.timeoutMs);
    probing = false;
    // The URL changed or the proxy was turned off while the probe ran: this answer is about nothing in force.
    if (watched !== stored) return;
    if (route === 'proxy') {
      failures = answered ? 0 : failures + 1;
      if (failures < settings.health.failures) return;
      route = 'direct';
      recoveries = 0;
      put(null);
      onSwitch('proxy-down');
      return;
    }
    recoveries = answered ? recoveries + 1 : 0;
    if (recoveries < settings.health.recoveries) return;
    route = 'proxy';
    failures = 0;
    put(stored);
    onSwitch('proxy-back');
  }

  return {
    check,
    route: () => route,
    current() {
      if (route !== 'proxy' || !proxySettings(config()).enabled || url() === null) return null;
      return inForce;
    },
  };
}
