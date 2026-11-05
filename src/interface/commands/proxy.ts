// `/proxy`: the owner's commands over the engine proxy (src/net/proxy.ts). `set` asks the URL in the chat's masked
// question and stores it as the `proxy` service of keys.json. The interfaces never take the proxy. `on` and `off` write
// `proxy.enabled` to the persona's settings file, which the proxy monitors read at their next check. `status` says
// whether the proxy is on and the route connections take now, `test` probes the stored URL once, and `useragent` writes
// `proxy.userAgent` and the `.curlrc` of every installed harness home. No answer carries the URL, its login, its
// password or its address. Called by src/interface/commands/console.ts.

import { localConfigPath } from '../../config/files.ts';
import type { Dialog } from '../../keys/commands.ts';
import { serviceCredential } from '../../keys/file.ts';
import { writeService } from '../../keys/services.ts';
import { isProxyUrl, proxySettings } from '../../net/proxy.ts';
import type { ProxyRoute } from '../../net/proxy.ts';
import { writeHarnessCurlrc } from '../../subharness/place.ts';
import { readLocalConfig, setPath, writeLocalConfig } from '../../tools/impl/shared.ts';

/** What the proxy commands read and call besides the persona's folder. */
export type ProxyCommandDeps = {
  /** where keys.json, the settings file and the harness homes are */
  dataDir: string;
  /** one probe through the URL, as the monitor probes (src/net/proxy.ts#probeProxy) */
  probe: (url: string, timeoutMs: number) => Promise<boolean>;
  /** the route of the core's monitor now */
  route: () => ProxyRoute;
  /** the live settings, for the probe's timeout; the defaults without it */
  config?: () => unknown;
};

export type ProxyAnswer = { text: string; status: 'ok' | 'invalid' | 'not_configured' | 'failed' };

const NOT_STORED: ProxyAnswer = { text: 'no proxy is stored; /proxy set stores one', status: 'not_configured' };

function writeSetting(dataDir: string, key: string, value: unknown): void {
  const file = localConfigPath(dataDir);
  writeLocalConfig(file, setPath(readLocalConfig(file), ['proxy', key], value));
}

const settingsOf = (dataDir: string): Record<string, unknown> => {
  const proxy = readLocalConfig(localConfigPath(dataDir)).proxy;
  return typeof proxy === 'object' && proxy !== null ? (proxy as Record<string, unknown>) : {};
};

/** How `route` reads in a status line. */
function routeWords(route: ProxyRoute): string {
  switch (route) {
    case 'proxy':
      return 'connections go through the proxy';
    case 'direct':
      return 'connections go direct, because the proxy stopped answering; it is taken back once it answers again';
    case 'off':
      return 'connections go direct until the next check';
  }
}

async function set(deps: ProxyCommandDeps, dialog: Dialog | null): Promise<ProxyAnswer> {
  if (dialog === null) return { text: 'the proxy URL is asked in the chat; run /proxy set there', status: 'invalid' };
  const value = (await dialog.ask('Proxy URL (scheme://login:password@host:port):', { secret: true })).trim();
  if (!isProxyUrl(value))
    return {
      text: 'a proxy URL is http://, https:// or socks5h:// with a host and a port; nothing is written',
      status: 'invalid',
    };
  writeService(deps.dataDir, 'proxy', value);
  const next =
    settingsOf(deps.dataDir).enabled === true ? 'it is taken at the next check' : '/proxy on puts it in force';
  return { text: `the proxy is stored; ${next}`, status: 'ok' };
}

function status(deps: ProxyCommandDeps): ProxyAnswer {
  if (serviceCredential(deps.dataDir, 'proxy') === null) return { ...NOT_STORED, status: 'ok' };
  const settings = settingsOf(deps.dataDir);
  const enabled = settings.enabled === true;
  const agent = typeof settings.userAgent === 'string' && settings.userAgent !== '' ? 'set' : 'not set';
  return {
    text: [
      `proxy: ${enabled ? 'on' : 'off'}`,
      enabled ? routeWords(deps.route()) : 'connections go direct',
      `curl user agent: ${agent}`,
    ].join('; '),
    status: 'ok',
  };
}

/** Runs one `/proxy` command. */
export async function proxyCommand(
  deps: ProxyCommandDeps,
  name: string,
  args: Readonly<Record<string, unknown>>,
  dialog: Dialog | null
): Promise<ProxyAnswer> {
  const stored = (): string | null => serviceCredential(deps.dataDir, 'proxy');
  switch (name) {
    case 'proxy.set':
      return set(deps, dialog);
    case 'proxy.on':
      if (stored() === null) return NOT_STORED;
      writeSetting(deps.dataDir, 'enabled', true);
      return { text: 'the proxy is on; every connection takes it from the next check', status: 'ok' };
    case 'proxy.off':
      writeSetting(deps.dataDir, 'enabled', false);
      return { text: 'the proxy is off; every connection goes direct from the next check', status: 'ok' };
    case 'proxy.status':
      return status(deps);
    case 'proxy.test': {
      const url = stored();
      if (url === null) return NOT_STORED;
      const answered = await deps.probe(url, proxySettings(deps.config?.()).health.timeoutMs);
      return answered
        ? { text: 'the proxy answered', status: 'ok' }
        : { text: 'the proxy did not answer: it is down, or it refused the login', status: 'failed' };
    }
    case 'proxy.useragent': {
      const agent = typeof args.value === 'string' ? args.value.trim() : '';
      writeSetting(deps.dataDir, 'userAgent', agent);
      const homes = writeHarnessCurlrc(deps.dataDir, agent === '' ? null : agent);
      const where = homes.length > 0 ? `the .curlrc of ${homes.join(', ')}` : 'no harness home yet';
      return {
        text: agent === '' ? `the user agent is cleared from ${where}` : `the user agent is written to ${where}`,
        status: 'ok',
      };
    }
    default:
      return { text: `no command ${name}`, status: 'invalid' };
  }
}
