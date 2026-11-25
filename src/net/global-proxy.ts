// The one place a process hands its proxy to Node. `http.setGlobalProxyFromEnv(env)` routes `fetch`, `http`, `https`,
// the npm `undici` client and the global `WebSocket` of the whole process through the proxy, and returns the function
// that restores the state before it. A later call with `{}` or with empty strings leaves the proxy in force, and Node
// refuses a `socks5h://` URL, so the applier sets the http form (src/net/proxy.ts#httpProxyForm) and goes direct
// through the restore function alone. The proxy monitor of the core (src/core.ts) and of the interface runner
// (bin/neptunia.ts) call `apply` with the URL in force each time it changes.

import http from 'node:http';
import { NO_PROXY, httpProxyForm } from './proxy.ts';

/** Node's setter: takes the proxy variables and returns the restore function. */
export type SetGlobalProxy = (env: Record<string, string>) => () => void;

export type GlobalProxy = {
  /** Puts `url` in force for the whole process, or goes direct for null or a URL with no http form; true when proxied. */
  apply(url: string | null): boolean;
  /** The URL in force, null on the direct path. */
  current(): string | null;
};

/** The applier over `setGlobal`, Node's own by default. A process makes one and keeps it. */
export function createGlobalProxy(setGlobal: SetGlobalProxy = http.setGlobalProxyFromEnv): GlobalProxy {
  let inForce: string | null = null;
  let restore: (() => void) | null = null;

  function direct(): void {
    restore?.();
    restore = null;
    inForce = null;
  }

  return {
    apply(url) {
      const form = httpProxyForm(url);
      if (url === null || form === null) {
        direct();
        return false;
      }
      if (url === inForce) return true;
      direct();
      restore = setGlobal({ HTTP_PROXY: form, HTTPS_PROXY: form, NO_PROXY });
      inForce = url;
      return true;
    },
    current: () => inForce,
  };
}
