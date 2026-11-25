// The key ring as its readers see it: the key a role's request goes out on, read off the role's chain of routes. The
// chain client (src/llm/chain-client.ts) switches routes itself, so the ring has no failover of its own: `chainRing`
// names the key of the first usable API route from the route in force, the keys a role's chain names, the roles that
// switched to a later route on a key, and the keys roles other than the core are on now, each with its roles. Names
// only leave this module with a value in `route`, which src/llm/openrouter.ts reads. The core (src/llm/core-routes.ts)
// and the paid scripts (scripts/lib/script-routes.ts) build one over their chain client; the memory session
// (src/memory/db) reads `route`.

import { parseRouteText, ROUTE_ROLES } from '../llm/route-text.ts';
import type { Route } from '../llm/route-text.ts';

export type KeyRoute = { name: string; value: string };

/** A role that switched routes and the key it is on now, with when it moved (ms). */
export type KeyState = { role: string; key: string; switchedAt: number | null };

export type KeyRing = {
  /** The key the next request of `role` goes out on, null when its chain has none keys.json holds. */
  route(role: string): KeyRoute | null;
  /** The keys the chain of `role` names, in order. */
  names(role: string): Array<string>;
  /** The roles that switched to a later route on a key. */
  states(): Array<KeyState>;
  /** The keys some role other than the core is on now, each with its roles. Names only. */
  bound(): Array<{ name: string; roles: Array<string> }>;
};

/**
 * The value of the key `role` goes out on: what the modules that look their own key up (the embedder, the speech
 * synthesis, the pictures) call. '' or null when the ring has none.
 */
export type KeyOf = (role: string) => string | null;

/** What the ring reads of a chain client: each role's chain, the key of its route in force, and the switches. */
export type ChainView = {
  routes(role: string): ReadonlyArray<Route>;
  keyRouteOf(role: string): KeyRoute | null;
  states(): ReadonlyArray<{ role: string; route: string; switchedAt: number }>;
};

/** The key ring over `chain`: every read goes to the chain at the moment of use. */
export function chainRing(chain: ChainView): KeyRing {
  return {
    route: (role) => chain.keyRouteOf(role),
    names: (role) => [...new Set(chain.routes(role).flatMap((route) => (route.via === 'api' ? [route.key] : [])))],
    states() {
      const states: Array<KeyState> = [];
      for (const state of chain.states()) {
        const route = parseRouteText(state.role, state.route);
        if ('via' in route && route.via === 'api')
          states.push({ role: state.role, key: route.key, switchedAt: state.switchedAt });
      }
      return states;
    },
    bound() {
      const core = chain.keyRouteOf('core')?.name ?? null;
      const byKey = new Map<string, Array<string>>();
      for (const role of ROUTE_ROLES) {
        const name = role === 'core' ? null : (chain.keyRouteOf(role)?.name ?? null);
        if (name === null || name === core) continue;
        byKey.set(name, [...(byKey.get(name) ?? []), role]);
      }
      return [...byKey].map(([name, roles]) => ({ name, roles: roles.sort() }));
    },
  };
}
