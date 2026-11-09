// The core's chains of routes in one place (src/core.ts builds it once): the chain client every model request walks
// (src/llm/chain-client.ts), and the reads the rest of the core takes from it. `ring` is the key ring as the probes,
// the status, the memory session and the key commands read a role's key: the key of the role's chain (`chainRing`).
// `pathOf` is the route a role takes now as a path (its harness, else the API), `modelOf` its model there, `harnessOf`
// the backend of a role on a harness. The clients a request goes to are built after this, once the archive and the
// usage exist, and handed over with `serve`; a request before that is refused.

import { chainRing } from '../keys/ring.ts';
import type { KeyRing } from '../keys/ring.ts';
import type { KeyStore } from '../keys/store.ts';
import type { MemoryPath } from '../subharness/memory-path.ts';
import { routeName } from '../subharness/route-names.ts';
import { createChainClient, createRouteChainOf } from './chain-client.ts';
import type { ChainClient } from './chain-client.ts';
import type { CompleteResult } from './openrouter.ts';
import { roleModel } from './roles.ts';
import { harnessEffort, isRouteRole } from './route-text.ts';
import type { RouteRole } from './route-text.ts';

type Completing = { complete(messages: unknown, options?: unknown): Promise<CompleteResult> };

export type CoreRoutes = {
  client: ChainClient;
  ring: KeyRing;
  pathOf: (role: RouteRole) => MemoryPath;
  modelOf: (role: RouteRole) => string | null;
  harnessOf: (role: string) => string | null;
  /** The memory writer's path as `/keys check memory` names it: the backend under its route name. */
  memoryCheckPath: () => { kind: 'direct' } | { kind: 'subharness'; backend: string; model: string };
  /** Hands over the clients a request of `core`, of `memory` and of every other role goes to. */
  serve(clients: { core: Completing; memory: Completing; direct: Completing }): void;
};

export function createCoreRoutes(deps: { store: KeyStore; getConfig: () => unknown; now: () => number }): CoreRoutes {
  let clients: { core: Completing; memory: Completing; direct: Completing } | null = null;
  const client = createChainClient({
    getConfig: deps.getConfig,
    keys: { valueOf: (name) => deps.store.valueOf(name) },
    chain: createRouteChainOf(deps.getConfig, deps.now),
    executor: (role) => {
      if (clients === null) throw new Error('core: a model request came before the model clients were built');
      return role === 'core' ? clients.core : role === 'memory' ? clients.memory : clients.direct;
    },
  });
  const pathOf = (role: RouteRole): MemoryPath => {
    const route = client.inForce(role);
    return route?.via === 'harness'
      ? { kind: 'subharness', ...route, effort: harnessEffort(route.effort) }
      : { kind: 'direct' };
  };
  return {
    client,
    ring: chainRing(client),
    pathOf,
    modelOf: (role) => client.inForce(role)?.model ?? roleModel(deps.getConfig(), role) ?? null,
    harnessOf(role) {
      const path = isRouteRole(role) ? pathOf(role) : null;
      return path?.kind === 'subharness' ? path.backend : null;
    },
    memoryCheckPath() {
      const path = pathOf('memory');
      return path.kind === 'subharness'
        ? { kind: 'subharness', backend: routeName(path.backend), model: path.model }
        : path;
    },
    serve(given) {
      clients = given;
    },
  };
}
