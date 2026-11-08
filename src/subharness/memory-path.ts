// The path of her memory writer: the direct path, her memory session's request on the `memory` role's key, or one
// run of `claude` or `codex` through the subharness. The path is the record `models.harness.memory` of config.json
// (src/subharness/routing.ts), read again at every call, so a change from the chat acts on the next sweep. `model set memory
// --via <route> <model> [--effort <level>]` writes the record after one reply on that model and effort, and `model
// set memory <model>` removes it after the direct model passed its check (src/keys/commands.ts, `directPath`).
// opencode cannot carry the writer, because `opencode run` takes no system prompt of its own.

import { BACKEND_NAMES } from '../agent-runner/profiles.ts';
import { EFFORT_LEVELS, isEffortLevel, isListedEffort } from '../llm/roles.ts';
import type { EffortLevel } from '../llm/roles.ts';
import { MEMORY_BACKENDS, readRouting, updateRouting } from './routing.ts';
import type { MemoryBackend, MemoryPathRecord } from './routing.ts';
import { routeName, routeNamesText } from './route-names.ts';
import { MEMORY_CLAIM, checkedSelection, dropClaim, listsEffort } from './selection.ts';
import type { EnableDeps, SubharnessResult } from './control.ts';

export { MEMORY_BACKENDS };
export type { MemoryBackend, MemoryPathRecord };

export type MemoryPath = { kind: 'direct' } | ({ kind: 'subharness' } & MemoryPathRecord);
export type SubharnessMemoryPath = Extract<MemoryPath, { kind: 'subharness' }>;

const done = (message: string, changed = true): SubharnessResult => ({ ok: true, code: 'ok', changed, message });
const refused = (code: string, message: string): SubharnessResult => ({ ok: false, code, changed: false, message });

/** The path in config.json now, read at every call: the stored record, else direct. */
export function memoryPath(privateDir: string): MemoryPath {
  const record = readRouting(privateDir).subharness.memory;
  return record === null ? { kind: 'direct' } : { kind: 'subharness', ...record };
}

/** The path as `keys check memory` answers it: the backend of a subharness path under its route name. */
export function memoryCheckPath(
  privateDir: string
): { kind: 'direct' } | { kind: 'subharness'; backend: string; model: string } {
  const path = memoryPath(privateDir);
  return path.kind === 'direct' ? path : { kind: 'subharness', backend: routeName(path.backend), model: path.model };
}

/** The config.json records of a path through a subharness: the memory writer's, the core's and the simulation's. */
export type PathSlot = 'memory' | 'core' | 'simulation';

/**
 * One checked write of the record `slot`: one reply on that model and effort through the backend, then the record,
 * written whole, if nothing moved while the reply ran. Without an effort the record holds none, whatever was stored
 * before. A refusal writes nothing. `carrier` names what the backend would carry, for the refusal of opencode, and
 * `said` the line of a saved record.
 */
export async function setPathRecord(
  deps: EnableDeps,
  slot: PathSlot,
  choice: { backend: string; model: string; effort: string | undefined },
  words: { carrier: string; said: (record: MemoryPathRecord) => string }
): Promise<SubharnessResult> {
  const { backend, model, effort } = choice;
  const known = BACKEND_NAMES.find((name) => name === backend);
  if (known === undefined)
    return refused('unknown-backend', `${backend} is no backend; use ${routeNamesText(MEMORY_BACKENDS)}`);
  const name = MEMORY_BACKENDS.find((one) => one === known);
  if (name === undefined)
    return refused(
      'backend-unsupported',
      `${routeName(known)} cannot carry ${words.carrier}, it takes no system prompt; use ${routeNamesText(MEMORY_BACKENDS)}`
    );
  let level: EffortLevel | undefined;
  if (effort !== undefined) {
    if (!isListedEffort(effort) || !(isEffortLevel(effort) || (await listsEffort(deps, name, effort))))
      return refused('unknown-effort', `${effort} is no effort of ${routeName(name)}; use ${EFFORT_LEVELS.join(', ')}`);
    level = effort;
  }
  if (model.trim() === '') return refused('model-rejected', 'name the model; nothing was changed');
  return checkedSelection(
    deps,
    { claim: slot, backend: name, keyValue: '', model, ...(level === undefined ? {} : { effort: level }) },
    () => JSON.stringify(readRouting(deps.privateDir).subharness[slot]),
    () => {
      const record: MemoryPathRecord = { backend: name, model, effort: level ?? null };
      updateRouting(deps.privateDir, (fresh) => ({ ...fresh, subharness: { ...fresh.subharness, [slot]: record } }));
      return done(words.said(record));
    }
  );
}

/** `model set memory --via <route> <model> [--effort <level>]`: the memory writer's record, after one reply. */
export function setMemoryPath(
  deps: EnableDeps,
  backend: string,
  model: string,
  effort?: string
): Promise<SubharnessResult> {
  return setPathRecord(
    deps,
    MEMORY_CLAIM,
    { backend, model, effort },
    {
      carrier: 'the memory writer',
      said: (record) =>
        `her memory writer runs through ${memoryPathText({ kind: 'subharness', ...record })} from its next sweep`,
    }
  );
}

/**
 * Back to the direct path: removes the record, and a check of the subharness path that is still running can no longer
 * save. `changed: false` when there was none.
 */
export function clearMemoryPath(privateDir: string): SubharnessResult {
  dropClaim(privateDir, MEMORY_CLAIM);
  if (readRouting(privateDir).subharness.memory === null)
    return done('her memory writer is on direct-api already', false);
  updateRouting(privateDir, (store) => ({ ...store, subharness: { ...store.subharness, memory: null } }));
  return done('her memory writer is back on direct-api');
}

/** The path in words: `direct-api`, or `via <harness> <model>` with ` effort <level>` when there is one. */
export function memoryPathText(path: MemoryPath): string {
  if (path.kind === 'direct') return routeName('api');
  return `via ${routeName(path.backend)} ${path.model}${path.effort === null ? '' : ` effort ${path.effort}`}`;
}
