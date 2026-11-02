// The path of her memory writer: the direct path, her memory session's request on the `memory` role's key, or one
// run of `claude` or `codex` through the subharness. The path is the record `subharness.memory` of keys.json
// (src/keys/file.ts), read again at every call, so a change from the chat acts on the next sweep. `model set memory
// --via <backend> <model> [--effort <level>]` writes the record after one reply on that model and effort, and `model
// set memory <model>` removes it after the direct model passed its check (src/keys/commands.ts, `directPath`).
// opencode cannot carry the writer, because `opencode run` takes no system prompt of its own.

import { BACKEND_NAMES } from '../agent-runner/profiles.ts';
import { EFFORT_LEVELS, isEffortLevel } from '../llm/roles.ts';
import type { EffortLevel } from '../llm/roles.ts';
import { MEMORY_BACKENDS, readKeys, writeKeys } from '../keys/file.ts';
import type { MemoryBackend, MemoryPathRecord } from '../keys/file.ts';
import { checkModel } from './models.ts';
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

/** Whether this claude takes `--effort`: its `--help` lists it. A help that cannot be read says no. */
async function claudeTakesEffort(deps: EnableDeps): Promise<boolean> {
  if (deps.helpOf === undefined) return false;
  try {
    return (await deps.helpOf('claude')).includes('--effort');
  } catch {
    return false;
  }
}

/**
 * `model set memory --via <backend> <model> [--effort <level>]`: one reply on that model and effort through the
 * backend, then the record, written whole. Without an effort the record holds none, whatever was stored before. A
 * refusal writes nothing and runs nothing.
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
  if (!readKeys(deps.privateDir).subharness.backends.includes(name))
    return refused('backend-not-connected', `${name} is not connected: subharness enable ${name}; nothing was changed`);
  let level: EffortLevel | undefined;
  if (effort !== undefined) {
    if (!isEffortLevel(effort))
      return refused('unknown-effort', `${effort} is no effort; use ${EFFORT_LEVELS.join(', ')}`);
    level = effort;
  }
  if (level !== undefined && name === 'claude' && !(await claudeTakesEffort(deps)))
    return refused('effort-unsupported', 'this claude takes no --effort; nothing was changed');
  if (model.trim() === '') return refused('model-rejected', 'name the model; nothing was changed');
  const failed = await checkModel(deps, name, '', model, level);
  if (failed !== null) return { ...failed, message: `${failed.message}; nothing was changed` };
  const fresh = readKeys(deps.privateDir);
  const record: MemoryPathRecord = { backend: name, model, effort: level ?? null };
  writeKeys(deps.privateDir, { ...fresh, subharness: { ...fresh.subharness, memory: record } });
  return done(
    `her memory writer runs through ${memoryPathText({ kind: 'subharness', ...record })} from its next sweep`
  );
}

/** Back to the direct path: removes the record. `changed: false` when there was none. */
export function clearMemoryPath(privateDir: string): SubharnessResult {
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
