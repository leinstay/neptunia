// The subscription route of her core and of the simulation: the API, or one run of `claude` or `codex` per turn
// (src/subharness/subscription-client.ts). Each route is a record of config.json beside the memory writer's,
// `models.harness.core` and `models.harness.simulation` (src/subharness/routing.ts), read again at every request, so a change from the chat acts on the
// next turn. `model set core|simulation <model> --via <route> [--effort <level>]` writes the record after one reply on
// that model and effort; `model set core <model>` clears the core's after the API model passed its check
// (src/keys/commands.ts, `directPath`), and `model set simulation direct-api` clears the simulation's. opencode cannot carry a
// route, because `opencode run` takes no system prompt of its own.

import type { EffortLevel } from '../llm/roles.ts';
import { readRouting, updateRouting } from './routing.ts';
import type { MemoryBackend } from './routing.ts';
import type { EnableDeps, SubharnessResult } from './control.ts';
import { memoryPath, setPathRecord } from './memory-path.ts';
import { routeName } from './route-names.ts';
import { dropClaim } from './selection.ts';

/** The routes a subscription can carry. */
export const SUBSCRIPTION_ROLES = ['core', 'simulation'] as const;
export type SubscriptionRole = (typeof SUBSCRIPTION_ROLES)[number];

export type SubscriptionPath =
  { kind: 'api' } | { kind: 'subharness'; backend: MemoryBackend; model: string; effort: EffortLevel | null };

/** What a route carries, in the owner's words, with its verbs. */
const CARRIES: Readonly<Record<SubscriptionRole, { what: string; runs: string; is: string }>> = {
  core: { what: 'her turns', runs: 'run', is: 'are' },
  simulation: { what: 'the simulation', runs: 'runs', is: 'is' },
};

const done = (message: string, changed = true): SubharnessResult => ({ ok: true, code: 'ok', changed, message });

/** The route of `role` in config.json now: the stored record, else the API. */
export function subscriptionPath(privateDir: string, role: SubscriptionRole): SubscriptionPath {
  const record = readRouting(privateDir).subharness[role];
  return record === null ? { kind: 'api' } : { kind: 'subharness', ...record };
}

/** The backend `role` runs through (`core`, `memory`, `simulation`), null on the API or for another role: a role on a harness needs no key. */
export function harnessBackend(privateDir: string, role: string): string | null {
  try {
    const path =
      role === 'memory'
        ? memoryPath(privateDir)
        : role === 'core' || role === 'simulation'
          ? subscriptionPath(privateDir, role)
          : null;
    return path !== null && path.kind === 'subharness' ? path.backend : null;
  } catch {
    return null;
  }
}

/** `model set core|simulation <model> --via <route> [--effort <level>]`: the route, after one reply on it. */
export function setSubscriptionPath(
  deps: EnableDeps,
  role: SubscriptionRole,
  backend: string,
  model: string,
  effort?: string
): Promise<SubharnessResult> {
  return setPathRecord(
    deps,
    role,
    { backend, model, effort },
    {
      carrier: CARRIES[role].what,
      said: (record) =>
        `${CARRIES[role].what} ${CARRIES[role].runs} ${subscriptionPathText({ kind: 'subharness', ...record })} from the next turn`,
    }
  );
}

/** Back to the API: removes the record, and a check of a route that is still running can no longer save. */
export function clearSubscriptionPath(privateDir: string, role: SubscriptionRole): SubharnessResult {
  dropClaim(privateDir, role);
  const { what, runs, is } = CARRIES[role];
  if (readRouting(privateDir).subharness[role] === null)
    return done(`${what} ${runs} on ${routeName('api')} already`, false);
  updateRouting(privateDir, (store) => ({ ...store, subharness: { ...store.subharness, [role]: null } }));
  return done(`${what} ${is} back on ${routeName('api')}`);
}

/** The route in words: `direct-api`, or `via <harness> <model>` with ` effort <level>` when there is one. */
export function subscriptionPathText(path: SubscriptionPath): string {
  if (path.kind === 'api') return routeName('api');
  return `via ${routeName(path.backend)} ${path.model}${path.effort === null ? '' : ` effort ${path.effort}`}`;
}
