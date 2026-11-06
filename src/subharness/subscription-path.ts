// The subscription route of her core and of the simulation: the API, or one run of `claude` or `codex` per turn
// (src/subharness/subscription-client.ts). Each route is a record of keys.json beside the memory writer's,
// `subharness.core` and `subharness.simulation`, read again at every request, so a change from the chat acts on the
// next turn. `model set core|simulation <model> --via <backend> [--effort <level>]` writes the record after one reply on
// that model and effort; `model set core <model>` clears the core's after the API model passed its check
// (src/keys/commands.ts, `directPath`), and `model set simulation api` clears the simulation's. opencode cannot carry a
// route, because `opencode run` takes no system prompt of its own.

import type { EffortLevel } from '../llm/roles.ts';
import { readKeys, writeKeys } from '../keys/file.ts';
import type { MemoryBackend } from '../keys/file.ts';
import type { EnableDeps, SubharnessResult } from './control.ts';
import { setPathRecord } from './memory-path.ts';
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

/** The route of `role` in keys.json now: the stored record, else the API. */
export function subscriptionPath(privateDir: string, role: SubscriptionRole): SubscriptionPath {
  const record = readKeys(privateDir).subharness[role];
  return record === null ? { kind: 'api' } : { kind: 'subharness', ...record };
}

/** `model set core|simulation <model> --via <backend> [--effort <level>]`: the route, after one reply on it. */
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
  const store = readKeys(privateDir);
  const { what, runs, is } = CARRIES[role];
  if (store.subharness[role] === null) return done(`${what} ${runs} on the API already`, false);
  writeKeys(privateDir, { ...store, subharness: { ...store.subharness, [role]: null } });
  return done(`${what} ${is} back on the API`);
}

/** The route in words: `api`, or `via <backend> <model>` with ` effort <level>` when there is one. */
export function subscriptionPathText(path: SubscriptionPath): string {
  if (path.kind === 'api') return 'api';
  return `via ${path.backend} ${path.model}${path.effort === null ? '' : ` effort ${path.effort}`}`;
}
