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
import type { RouteChain, RouteState } from './route-chain.ts';
import { harnessEffort, isRouteEffort, isRouteRole } from './route-text.ts';
import type { Route, RouteRole } from './route-text.ts';
import { MINUTE_MS } from '../time.ts';

type Rec = Record<string, unknown>;
type Completing = { complete(messages: unknown, options?: unknown): Promise<CompleteResult> };

export type ChainClientDeps = {
  /** The live config, read at each request. */
  getConfig(): unknown;
  /** keys.json now: the value of a named key. */
  keys: { valueOf(name: string): string | null };
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
  /** The name and value of that key, null with none. */
  keyRouteOf(role: string): { name: string; value: string } | null;
  /**
   * A client that sends on `keyOf` (the embedder, the speech synthesis, the pictures) failed with `error`: when it makes
   * that route unavailable the role moves to its next route for its next request.
   */
  report(role: string, error: unknown): void;
  /** The route in force of `role` was found down with `code` (a probe): the role moves on; true when another is in force. */
  moveOn(role: RouteRole, code: string): boolean;
  /** The roles that switched and have not gone back to their first route. */
  states(): Array<RouteState>;
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
  const routes = (role: RouteRole): Array<Route> => deps.routes?.(role) ?? routesOf(deps.getConfig(), role);
  const isUsable = (route: Route): boolean => route.via === 'harness' || deps.keys.valueOf(route.key) !== null;

  /** The first API route of `role` whose key keys.json holds, from the route in force, with that key. */
  function keyRoute(role: string) {
    if (!isRouteRole(role)) return null;
    const chain = routes(role);
    for (const index of walk(role, chain)) {
      const route = chain[index];
      const value = route?.via === 'api' ? deps.keys.valueOf(route.key) : null;
      if (route?.via === 'api' && value !== null) return { name: route.key, value, route, chain, index };
    }
    return null;
  }

  /** The indexes of `chain` in the order a request walks them: from the route in force to the end, then from the first. */
  function walk(role: RouteRole, chain: ReadonlyArray<Route>): Array<number> {
    const start = deps.chain.inForce(role, chain);
    return chain.map((_, step) => (start + step) % chain.length);
  }

  /** `route` with the default effort of its role (`llm.routeEffort.<role>`) when it names none. */
  function withDefaultEffort(role: string, route: Route): Route {
    if (route.effort !== null) return route;
    const config = deps.getConfig();
    const llm = isRec(config) && isRec(config.llm) ? config.llm : {};
    const efforts = isRec(llm.routeEffort) ? llm.routeEffort : {};
    const effort = Object.hasOwn(efforts, role) ? efforts[role] : undefined;
    return isRouteEffort(effort) ? { ...route, effort } : route;
  }

  /**
   * The options one route sends, its effort translated for it: through a harness the CLI's level (`harnessEffort`,
   * `disabled` at the lowest one) and `isThinking` when the effort is a level, which the memory writer reads, on the API the provider's `reasoning`, none for `disabled`. On the API also its key,
   * and its model past the role's first.
   */
  function optionsFor(chain: ReadonlyArray<Route>, given: Route, asked: Rec, counted: boolean): Rec {
    const route = withDefaultEffort(typeof asked.role === 'string' ? asked.role : 'core', given);
    const counting = counted ? { countAgainstDailyCap: false } : {};
    if (route.via === 'harness') {
      // `disabled` reaches the CLI as its lowest level, so the run is told apart whether the effort asked for thinking.
      const isThinking = route.effort !== null && route.effort !== 'disabled';
      const chainRoute = { ...route, effort: harnessEffort(route.effort), ...(isThinking ? { isThinking } : {}) };
      return { ...asked, chainRoute, ...counting };
    }
    const sent: Rec = { ...asked, chainRoute: route, ...counting };
    sent.routeKey = { name: route.key, value: deps.keys.valueOf(route.key) ?? '' };
    // The caller chose the model of the role's first route for its purpose; a route with another model sends its own.
    if (asked.model === undefined || given.model !== chain[0]?.model)
      sent.model = purposePin(deps.getConfig(), asked.purpose) ?? route.model;
    if (route.effort !== null && route.effort !== 'disabled' && !isRec(asked.reasoning))
      sent.reasoning = { effort: route.effort };
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
    keyOf: (role) => keyRoute(role)?.value ?? null,
    keyRouteOf: (role) => {
      const found = keyRoute(role);
      return found === null ? null : { name: found.name, value: found.value };
    },
    report(role, error) {
      const found = keyRoute(role);
      if (found === null || !isRouteRole(role)) return;
      const code = unavailableCode(found.route, error);
      if (code !== null) deps.chain.failed(role, found.chain, found.index, code);
    },
    moveOn(role, code) {
      const chain = routes(role);
      const index = deps.chain.inForce(role, chain);
      if (chain[index] === undefined) return false;
      deps.chain.failed(role, chain, index, code);
      return deps.chain.inForce(role, chain) !== index;
    },
    states: () => deps.chain.states(),
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

/**
 * `client` with each call that returns a promise told to `report` under `role` when it rejects, the rejection passed on
 * unchanged: the clients that send on a role's key themselves (the embedder, the speech synthesis, the pictures) move
 * the role along its chain this way (`ChainClient.report`).
 */
export function reportingFailures<TClient extends object>(
  client: TClient,
  role: string,
  report: (role: string, error: unknown) => void
): TClient {
  // A copy of the client's own properties, read by name below; its functions are replaced one by one.
  const wrapped = Object.assign({}, client) as Record<string, unknown>;
  for (const [name, value] of Object.entries(client)) {
    if (typeof value !== 'function') continue;
    const call = value as (...args: Array<unknown>) => unknown;
    wrapped[name] = (...args: Array<unknown>): unknown => {
      const result = call.apply(client, args);
      if (!(result instanceof Promise)) return result;
      return result.catch((error: unknown) => {
        report(role, error);
        throw error;
      });
    };
  }
  // Each own function of `client` is replaced by a wrapper of the same signature; the rest is copied as it was.
  return wrapped as TClient;
}
