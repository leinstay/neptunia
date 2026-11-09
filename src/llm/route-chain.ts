// A model role's chain of routes (src/llm/route-text.ts) and the choice of the route in force, kept per role in process
// memory. `routesOf` reads `models.routes.<role>` of config.json, the one place a role's routes live: a role with no
// entry there has no route. A request takes the route in force; a route that is unavailable (`unavailableCode`) moves
// the role to the next route that has not failed within the last minute, wrapping to the first, and `llm: route
// switched` logs the role, both routes as text and the code. After a switch the role stays there for the retry window
// (`llm.routeRetryMinutes`) and then tries its first route again. Names only, never a key value. Pure apart from the
// injected clock and the log line.

import { log } from '../log.ts';
import { MINUTE_MS } from '../time.ts';
import { SUBSCRIPTION_CODES, isBudgetError } from './openrouter.ts';
import { ROUTE_ROLES, isRefusal, readRoute, routeText } from './route-text.ts';
import type { Route, RouteRole } from './route-text.ts';

type Tree = Record<string, unknown>;
const isTree = (value: unknown): value is Tree => typeof value === 'object' && value !== null && !Array.isArray(value);
const treeOf = (value: unknown): Tree => (isTree(value) ? value : {});

/** The chain of `role`: `models.routes.<role>`, records the settings check refuses left out; none without an entry. */
export function routesOf(config: unknown, role: RouteRole): Array<Route> {
  const own = treeOf(treeOf(treeOf(config).models).routes)[role];
  if (!Array.isArray(own)) return [];
  return own.map((value) => readRoute(role, value)).filter((route): route is Route => !isRefusal(route));
}

/** The key each role's chain names first, by role: the key a role spends on while its first route is in force. */
export function chainKeyNames(config: unknown): Record<string, string> {
  const names: Record<string, string> = {};
  for (const role of ROUTE_ROLES) {
    const first = routesOf(config, role).find((route) => route.via === 'api');
    if (first?.via === 'api') names[role] = first.key;
  }
  return names;
}

/** The codes of a harness run that say the harness cannot run now: a missing install, a logout, a run that broke. */
const HARNESS_DOWN = new Set<string>([
  ...SUBSCRIPTION_CODES,
  'not-logged-in',
  'backend-error',
  'backend-missing',
  'spawn',
  'timeout',
]);

/**
 * The code of a failure that makes `route` unavailable, so the same request goes to the next route; null for a failure
 * that would fail on any route. On an API route: HTTP 401 and 402, and a 429 whose body names credits or balance. On a
 * harness route: every code of SUBSCRIPTION_CODES and the memory writer's codes of a run that did not come through.
 */
export function unavailableCode(route: Route, error: unknown): string | null {
  const fields = treeOf(error);
  if (route.via === 'api') {
    const status = fields.statusCode;
    if (status === 401 || status === 402 || (status === 429 && isBudgetError(status, fields.body)))
      return `http-${status}`;
    return null;
  }
  const code = fields.code;
  if (typeof code !== 'string') return null;
  return HARNESS_DOWN.has(code) || /^exit-/.test(code) ? code : null;
}

/** A role that switched: the route in force as text and when it moved there (ms). */
export type RouteState = { role: string; route: string; switchedAt: number };

export type RouteChain = {
  /** The index of the route in force among `routes`: the first until a switch, and again once the window has passed. */
  inForce(role: string, routes: ReadonlyArray<Route>): number;
  /**
   * The route at `index` was unavailable with `code`. When it is the route in force the role moves to the next route
   * that has not failed within the last minute, wrapping to the first; with none the role stays where it is.
   */
  failed(role: string, routes: ReadonlyArray<Route>, index: number, code: string): void;
  /** The roles that switched and have not gone back to their first route. */
  states(): Array<RouteState>;
};

/** How long a failure of a route counts against it when the chain wraps: past it the route may have recovered. */
const FAILED_WINDOW_MS = MINUTE_MS;

export function createRouteChain({ now, retryMs }: { now: () => number; retryMs: () => number }): RouteChain {
  const states = new Map<string, { route: string; switchedAt: number }>();
  const failedAt = new Map<string, number>();
  const failureKey = (role: string, route: Route): string => `${role}\n${routeText(route)}`;

  function inForce(role: string, routes: ReadonlyArray<Route>): number {
    const state = states.get(role);
    if (state === undefined) return 0;
    const index = routes.findIndex((route) => routeText(route) === state.route);
    if (index <= 0 || now() - state.switchedAt >= retryMs()) {
      states.delete(role);
      return 0;
    }
    return index;
  }

  return {
    inForce,
    failed(role, routes, index, code) {
      const route = routes[index];
      if (route === undefined) return;
      const at = now();
      failedAt.set(failureKey(role, route), at);
      if (inForce(role, routes) !== index) return;
      for (let step = 1; step < routes.length; step += 1) {
        const next = routes[(index + step) % routes.length];
        if (next === undefined) continue;
        if (at - (failedAt.get(failureKey(role, next)) ?? -Infinity) < FAILED_WINDOW_MS) continue;
        states.set(role, { route: routeText(next), switchedAt: at });
        log.warn('llm: route switched', { role, from: routeText(route), to: routeText(next), code });
        return;
      }
    },
    states: () => [...states].map(([role, state]) => ({ role, ...state })),
  };
}
