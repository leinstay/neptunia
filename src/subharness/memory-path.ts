// The path of her memory writer: the direct path, her memory session's request on the `memory` role's key, or one
// run of `claude` or `codex` through the subharness. The path is the record `subharness.memory` of keys.json
// (src/keys/file.ts), read again at every call, so a change from the chat acts on the next sweep. `model set memory
// --via <backend> <model> [--effort <level>]` writes the record after one reply on that model and effort, and `model
// set memory <model>` removes it after the direct model passed its check (src/keys/commands.ts, `directPath`).
// opencode cannot carry the writer, because `opencode run` takes no system prompt of its own.

import { BACKEND_NAMES } from '../agent-runner/profiles.ts';
import { EFFORT_LEVELS, isEffortLevel, isListedEffort } from '../llm/roles.ts';
import type { EffortLevel } from '../llm/roles.ts';
import { MEMORY_BACKENDS, readKeys, writeKeys } from '../keys/file.ts';
import type { MemoryBackend, MemoryPathRecord } from '../keys/file.ts';
import { MEMORY_CLAIM, checkedSelection, dropClaim, listsEffort } from './selection.ts';
import type { EnableDeps, SubharnessResult } from './control.ts';

export { MEMORY_BACKENDS };
export type { MemoryBackend, MemoryPathRecord };

export type MemoryPath = { kind: 'direct' } | ({ kind: 'subharness' } & MemoryPathRecord);
export type SubharnessMemoryPath = Extract<MemoryPath, { kind: 'subharness' }>;

const done = (message: string, changed = true): SubharnessResult => ({ ok: true, code: 'ok', changed, message });
const refused = (code: string, message: string): SubharnessResult => ({ ok: false, code, changed: false, message });

/** The path in keys.json now, read at every call: the stored record, else direct. */
export function memoryPath(privateDir: string): MemoryPath {
  const record = readKeys(privateDir).subharness.memory;
  return record === null ? { kind: 'direct' } : { kind: 'subharness', ...record };
}

/**
 * `model set memory --via <backend> <model> [--effort <level>]`: one reply on that model and effort through the
 * backend, then the record, written whole, if nothing moved while the reply ran. Without an effort the record holds
 * none, whatever was stored before. A refusal writes nothing.
 */
export async function setMemoryPath(
  deps: EnableDeps,
  backend: string,
  model: string,
  effort?: string
): Promise<SubharnessResult> {
  const known = BACKEND_NAMES.find((name) => name === backend);
  if (known === undefined)
    return refused('unknown-backend', `${backend} is no backend; use ${MEMORY_BACKENDS.join(' or ')}`);
  const name = MEMORY_BACKENDS.find((one) => one === known);
  if (name === undefined)
    return refused(
      'backend-unsupported',
      `${known} cannot carry the memory writer, it takes no system prompt; use ${MEMORY_BACKENDS.join(' or ')}`
    );
  let level: EffortLevel | undefined;
  if (effort !== undefined) {
    if (!isListedEffort(effort) || !(isEffortLevel(effort) || (await listsEffort(deps, name, effort))))
      return refused('unknown-effort', `${effort} is no effort of ${name}; use ${EFFORT_LEVELS.join(', ')}`);
    level = effort;
  }
  if (model.trim() === '') return refused('model-rejected', 'name the model; nothing was changed');
  return checkedSelection(
    deps,
    { claim: MEMORY_CLAIM, backend: name, keyValue: '', model, ...(level === undefined ? {} : { effort: level }) },
    () => JSON.stringify(readKeys(deps.privateDir).subharness.memory),
    () => {
      const fresh = readKeys(deps.privateDir);
      const record: MemoryPathRecord = { backend: name, model, effort: level ?? null };
      writeKeys(deps.privateDir, { ...fresh, subharness: { ...fresh.subharness, memory: record } });
      return done(
        `her memory writer runs through ${memoryPathText({ kind: 'subharness', ...record })} from its next sweep`
      );
    }
  );
}

/**
 * Back to the direct path: removes the record, and a check of the subharness path that is still running can no longer
 * save. `changed: false` when there was none.
 */
export function clearMemoryPath(privateDir: string): SubharnessResult {
  dropClaim(privateDir, MEMORY_CLAIM);
  const store = readKeys(privateDir);
  if (store.subharness.memory === null) return done('her memory writer is on the direct path already', false);
  writeKeys(privateDir, { ...store, subharness: { ...store.subharness, memory: null } });
  return done('her memory writer is back on the direct path');
}

/** The path in words: `direct`, or `via <backend> <model>` with ` effort <level>` when there is one. */
export function memoryPathText(path: MemoryPath): string {
  if (path.kind === 'direct') return 'direct';
  return `via ${path.backend} ${path.model}${path.effort === null ? '' : ` effort ${path.effort}`}`;
}
