// The one checked commit of a role's source, model and effort. The source must be able to run before any request is
// spent; then one reply from that model decides, and the reply is saved only if the source can still run and nobody moved
// the selection while it ran. A newer selection of the role takes the claim from an older one that is still waiting, and
// the store's own value catches a change from another process, so a slow reply never overwrites what the owner chose
// after it. Codes: `not-installed`, `not-logged-in`, `model-rejected`, `selection-changed`, `source-changed`.

import type { BackendName } from '../agent-runner/profiles.ts';
import type { EffortLevel } from '../llm/roles.ts';
import { isListedEffort } from '../llm/roles.ts';
import type { EnableDeps, SubharnessResult } from './control.ts';
import { checkModel } from './models.ts';
import { sourceProblem, sourceState } from './sources.ts';

/** The selection each role is checking now, by private layer and role; a running check holds it while it is its own. */
const claims = new Map<string, symbol>();

const claimKey = (privateDir: string, role: string): string => `${privateDir}\0${role}`;

const refused = (code: string, message: string): SubharnessResult => ({ ok: false, code, changed: false, message });

export type Selection = {
  /** the agent's name, or `route-<backend>` for a route check */
  claim: string;
  backend: BackendName;
  /** the key the check of opencode goes out on; empty for the others */
  keyValue: string;
  model: string;
  effort?: string;
  /** the OpenRouter provider the check of opencode is pinned to */
  provider?: string;
};

/**
 * Checks `selection` and runs `commit`, which writes it. `stored` reads the role's selection as text: a different text
 * after the reply means it moved. `commit` runs in the same tick as the last look at the claim and the store.
 */
export async function checkedSelection(
  deps: EnableDeps,
  selection: Selection,
  stored: () => string,
  commit: () => SubharnessResult
): Promise<SubharnessResult> {
  const { claim, backend, keyValue, model, effort, provider } = selection;
  const before = await sourceState(deps.privateDir, backend);
  if (!before.available) return refused(before.code, `${sourceProblem(before)}; nothing was changed`);
  const level: EffortLevel | undefined = effort !== undefined && isListedEffort(effort) ? effort : undefined;
  const key = claimKey(deps.privateDir, claim);
  const mine = Symbol(claim);
  claims.set(key, mine);
  const seen = stored();
  try {
    const failed = await checkModel(deps, backend, keyValue, model, level, provider);
    if (failed !== null) return { ...failed, message: `${failed.message}; nothing was changed` };
    const after = await sourceState(deps.privateDir, backend);
    if (claims.get(key) !== mine || stored() !== seen)
      return refused('selection-changed', `the selection changed while ${model} was checked; nothing was changed`);
    if (!after.available)
      return refused('source-changed', `${sourceProblem(after)}, it changed during the check; nothing was changed`);
    return commit();
  } finally {
    if (claims.get(key) === mine) claims.delete(key);
  }
}

/**
 * One reply through `route`'s harness, as a check of a route of a chain (src/keys/commands.ts `/model set` and
 * `/model add`): the source checked first, then the reply; nothing is written, the caller writes the chain on `ok`.
 */
export async function checkedRoute(
  deps: EnableDeps,
  route: { backend: BackendName; model: string; effort: string | null }
): Promise<{ ok: boolean; code: string }> {
  const result = await checkedSelection(
    deps,
    {
      claim: `route-${route.backend}`,
      backend: route.backend,
      keyValue: '',
      model: route.model,
      ...(route.effort === null ? {} : { effort: route.effort }),
    },
    () => '',
    () => ({ ok: true, code: 'ok', changed: false, message: '' })
  );
  return { ok: result.ok, code: result.code };
}
