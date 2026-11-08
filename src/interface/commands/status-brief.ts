// The facts the owner's chat reads for its header (cli/state.ts `statusLine`), from what the core already holds: the pause,
// the memory session's mode and last probe, the interfaces, and for the core, memory and the analyzer the model and the
// route each runs on. A role on a harness names that harness and the model the harness runs. A role on the API names
// `direct-api`, its configured model and whether a key carries it. Either reads as unbound while `runFailed` says what
// it runs on does not work: a lost login of its harness (src/subharness/login-state.ts) or a role the tracker of
// src/llm/role-health.ts holds down, until the next run answers. The analyzer runs on the API alone
// (src/subharness/control.ts `DIRECT_ONLY_ROLES`). Nothing here makes a request: every fact is a read.

import { roleModel } from '../../llm/roles.ts';
import { sessionSettings } from '../../memory/db/session.ts';
import type { RouteBackend } from '../../subharness/route-names.ts';
import { routeName } from '../../subharness/route-names.ts';
import { memoryPath } from '../../subharness/memory-path.ts';
import { subscriptionPath } from '../../subharness/subscription-path.ts';

/** The path of a role as config.json holds it: the API, or one harness with the model it runs. */
export type RolePath = { kind: 'direct' } | { kind: 'subharness'; backend: RouteBackend; model: string };

/** The roles the header has a line for. */
export type BriefRole = 'core' | 'memory' | 'analyzer';

export type RoleFacts = { model: string | null; route: string; bound: boolean };

export type StatusBrief = {
  core: { state: 'running' | 'paused'; reason: string | null } & RoleFacts;
  memory: { session: string; probe: 'ok' | 'failed' | 'unknown'; checkedAt: number | null } & RoleFacts;
  analyzer: RoleFacts;
  interfaces: ReadonlyArray<{ name: string; enabled: boolean; connected: boolean }>;
};

export type StatusBriefDeps = {
  config: () => unknown;
  paused: () => boolean;
  pauseReason: () => string | null;
  /** The config.json path of the core or the memory writer, read at the call. */
  path: (role: 'core' | 'memory') => RolePath;
  /** Whether the key ring holds a key for `role`'s requests on the API. */
  hasKey: (role: string) => boolean;
  probe: () => { ok: boolean; at: number } | null;
  /** Whether what `role` runs on through `backend` (`api` for the API) failed its last real run. */
  runFailed: (role: BriefRole, backend: RouteBackend) => boolean;
  interfaces: () => ReadonlyArray<{ name: string; enabled: boolean; connected: boolean }>;
};

/** The path of the core or the memory writer in config.json now. */
export function rolePath(privateDir: string, role: 'core' | 'memory'): RolePath {
  const held = role === 'core' ? subscriptionPath(privateDir, 'core') : memoryPath(privateDir);
  return held.kind === 'subharness' ? held : { kind: 'direct' };
}

function roleFacts(deps: StatusBriefDeps, role: BriefRole, path: RolePath): RoleFacts {
  if (path.kind === 'subharness')
    return { model: path.model, route: routeName(path.backend), bound: !deps.runFailed(role, path.backend) };
  return {
    model: roleModel(deps.config(), role) ?? null,
    route: routeName('api'),
    bound: deps.hasKey(role) && !deps.runFailed(role, 'api'),
  };
}

export function statusBrief(deps: StatusBriefDeps): StatusBrief {
  const paused = deps.paused();
  const probe = deps.probe();
  return {
    core: {
      state: paused ? 'paused' : 'running',
      reason: paused ? deps.pauseReason() : null,
      ...roleFacts(deps, 'core', deps.path('core')),
    },
    memory: {
      session: sessionSettings(deps.config()).mode,
      probe: probe === null ? 'unknown' : probe.ok ? 'ok' : 'failed',
      checkedAt: probe?.at ?? null,
      ...roleFacts(deps, 'memory', deps.path('memory')),
    },
    analyzer: roleFacts(deps, 'analyzer', { kind: 'direct' }),
    interfaces: deps.interfaces(),
  };
}
