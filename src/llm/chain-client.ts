// The model client in front of every role's client: each request walks its role's chain of routes
// (src/llm/route-chain.ts). An API route goes to the role's client with the route's key (`routeKey`, which
// src/llm/openrouter.ts sends in place of a key of its own) and, past the role's first model, the route's model; a
// harness route goes to the role's client with the route itself (`chainRoute`, which the subscription client and the
// memory writer run). A route that is unavailable hands the same request to the next route, a route whose key keys.json
// lacks is skipped with no request, and a request counts once against the day's request cap however many routes it
// walks. A chain of one route fails with that route's own error; a longer chain whose every route failed fails with
// `routes-exhausted`. A role with no usable route goes to its client unchanged, which refuses it as a role with no key.
// The core builds one (src/core.ts), and so does a paid script (scripts/lib/script-routes.ts). Names leave this module
// only in log lines and errors; a key value goes only into the request's `routeKey`.

import type { CompleteResult } from './openrouter.ts';
import { createRouteChain, routesOf, unavailableCode } from './route-chain.ts';
import type { RouteChain } from './route-chain.ts';
import { isRouteRole } from './route-text.ts';
import type { Route, RouteRole } from './route-text.ts';
import { MINUTE_MS } from '../time.ts';

type Rec = Record<string, unknown>;
type Completing = { complete(messages: unknown, options?: unknown): Promise<CompleteResult> };

export type ChainClientDeps = {
  /** The live config, read at each request. */
  getConfig(): unknown;
  /** keys.json now: the core key names in their order, and the value of a key by name. */
  keys: { coreNames(): Array<string>; valueOf(name: string): string | null };
  chain: RouteChain;
  /** The client a request of `role` goes to: the subscription client for `core`, the memory writer for `memory`. */
  executor(role: string): Completing;
  /** The chain of `role` in place of config.json's, for a paid script whose flag replaces it; null keeps config.json's. */
  routes?(role: RouteRole): Array<Route> | null;
};

export type ChainClient = {
  /** One request of the role its options name, walked along that role's chain. */
  complete: (messages: unknown, options?: unknown) => Promise<CompleteResult>;
  /** The chain of `role` now. */
  routes(role: RouteRole): Array<Route>;
  /** The route `role` would take now, null with none usable. */
  inForce(role: RouteRole): Route | null;
  /** The value of the key of the first usable API route of `role` from the one in force, null with none. */
  keyOf(role: string): string | null;
};

const isRec = (value: unknown): value is Rec => typeof value === 'object' && value !== null && !Array.isArray(value);

/** The error of a chain whose every route was unavailable within one request. */
function routesExhausted(role: string, codes: ReadonlyArray<string>): Error {
  return Object.assign(new Error(`llm: every route of the ${role} role is unavailable (${codes.join(', ')})`), {
    code: 'routes-exhausted',
    name: 'RoutesExhaustedError',
  });
}

/** The `models.byPurpose` pin of `purpose`, read the way src/llm/roles.ts#roleModel reads it. */
function purposePin(config: unknown, purpose: unknown): string | undefined {
  const models = isRec(config) && isRec(config.models) ? config.models : {};
  const pins = isRec(models.byPurpose) ? models.byPurpose : {};
  const pin = typeof purpose === 'string' && Object.hasOwn(pins, purpose) ? pins[purpose] : undefined;
  return typeof pin === 'string' && pin !== '' ? pin : undefined;
}

export function createChainClient(deps: ChainClientDeps): ChainClient {
  const routes = (role: RouteRole): Array<Route> =>
    deps.routes?.(role) ?? routesOf(deps.getConfig(), role, deps.keys.coreNames());
  const isUsable = (route: Route): boolean => route.via === 'harness' || deps.keys.valueOf(route.key) !== null;

  /** The indexes of `chain` in the order a request walks them: from the route in force to the end, then from the first. */
  function walk(role: RouteRole, chain: ReadonlyArray<Route>): Array<number> {
    const start = deps.chain.inForce(role, chain);
    return chain.map((_, step) => (start + step) % chain.length);
  }

  /** The options one route sends: the route, and on the API its key, its model past the role's first and its effort. */
  function optionsFor(chain: ReadonlyArray<Route>, route: Route, asked: Rec, counted: boolean): Rec {
    const sent: Rec = { ...asked, chainRoute: route, ...(counted ? { countAgainstDailyCap: false } : {}) };
    if (route.via === 'harness') return sent;
    sent.routeKey = { name: route.key, value: deps.keys.valueOf(route.key) ?? '' };
    // The caller chose the model of the role's first route for its purpose; a route with another model sends its own.
    if (asked.model === undefined || route.model !== chain[0]?.model)
      sent.model = purposePin(deps.getConfig(), asked.purpose) ?? route.model;
    if (route.effort !== null && !isRec(asked.reasoning)) sent.reasoning = { effort: route.effort };
    return sent;
  }

  async function complete(messages: unknown, options?: unknown): Promise<CompleteResult> {
    const asked = isRec(options) ? options : {};
    const role = typeof asked.role === 'string' ? asked.role : 'core';
    const client = deps.executor(role);
    if (!isRouteRole(role)) return client.complete(messages, options);
    const chain = routes(role);
    if (!chain.some(isUsable)) return client.complete(messages, options);
    const codes: Array<string> = [];
    let counted = false;
    let lastError: unknown = null;
    for (const index of walk(role, chain)) {
      const route = chain[index];
      if (route === undefined) continue;
      if (!isUsable(route)) {
        deps.chain.failed(role, chain, index, 'key-unknown');
        codes.push('key-unknown');
        continue;
      }
      try {
        return await client.complete(messages, optionsFor(chain, route, asked, counted));
      } catch (error) {
        const code = unavailableCode(route, error);
        if (code === null) throw error;
        counted = true;
        lastError = error;
        codes.push(code);
        deps.chain.failed(role, chain, index, code);
      }
    }
    // What the one route's client threw, passed on as it came: the callers read its code and status.
    if (chain.length === 1 && lastError !== null) throw lastError as Error;
    throw routesExhausted(role, codes);
  }

  return {
    complete,
    routes,
    inForce(role) {
      const chain = routes(role);
      const index = walk(role, chain).find((one) => chain[one] !== undefined && isUsable(chain[one]));
      return index === undefined ? null : (chain[index] ?? null);
    },
    keyOf(role) {
      if (!isRouteRole(role)) return null;
      const chain = routes(role);
      for (const index of walk(role, chain)) {
        const route = chain[index];
        if (route?.via === 'api') {
          const value = deps.keys.valueOf(route.key);
          if (value !== null) return value;
        }
      }
      return null;
    },
  };
}

/** The chain state the core and the scripts build: the retry window read from `llm.routeRetryMinutes` at each use. */
export function createRouteChainOf(getConfig: () => unknown, now: () => number): RouteChain {
  const minutes = (): number => {
    const config = getConfig();
    const llm = isRec(config) && isRec(config.llm) ? config.llm : {};
    const value = llm.routeRetryMinutes;
    return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 30;
  };
  return createRouteChain({ now, retryMs: () => minutes() * MINUTE_MS });
}
