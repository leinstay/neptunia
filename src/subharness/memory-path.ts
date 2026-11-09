// The path of a role that may run as a CLI chat step, her memory writer and her core: the direct path on a key, or one
// run of `claude` or `codex` through the subharness. The path is read off the role's chain of routes in
// `models.routes.<role>` of config.json (src/llm/route-chain.ts): its first route when that is a harness route, else
// the direct path. The core reads the route in force from its chain client instead (src/llm/core-routes.ts#pathOf);
// this read serves the modules that are handed no path, at every call, so a `/model set` from the chat acts on the next
// run. The memory session (src/memory/db) reads the types and `memoryPathText`.

import path from 'node:path';
import { CONFIG_DIR, CONFIG_FILE } from '../config/files.ts';
import type { EffortLevel } from '../llm/roles.ts';
import { harnessEffort, isRefusal, readRoute } from '../llm/route-text.ts';
import { readLocalConfig } from '../tools/operations/shared.ts';
import type { MemoryBackend } from './routing.ts';
import { routeName } from './route-names.ts';

/** A path through a subharness: the backend, model and effort a run takes. */
export type MemoryPathRecord = { backend: MemoryBackend; model: string; effort: EffortLevel | null };

export type MemoryPath = { kind: 'direct' } | ({ kind: 'subharness' } & MemoryPathRecord);
export type SubharnessMemoryPath = Extract<MemoryPath, { kind: 'subharness' }>;

type Tree = Record<string, unknown>;
const treeOf = (value: unknown): Tree =>
  typeof value === 'object' && value !== null && !Array.isArray(value) ? (value as Tree) : {};

/** The path of `role` in config.json now: the harness of the first route of its chain, else direct. */
export function harnessPathOf(privateDir: string, role: 'core' | 'memory'): MemoryPath {
  const local = readLocalConfig(path.join(privateDir, CONFIG_DIR, CONFIG_FILE));
  const chain = treeOf(treeOf(treeOf(local).models).routes)[role];
  const first: unknown = Array.isArray(chain) ? chain[0] : undefined;
  if (first === undefined) return { kind: 'direct' };
  const route = readRoute(role, first);
  if (isRefusal(route) || route.via !== 'harness') return { kind: 'direct' };
  return { kind: 'subharness', backend: route.backend, model: route.model, effort: harnessEffort(route.effort) };
}

/** The memory writer's path in config.json now. */
export const memoryPath = (privateDir: string): MemoryPath => harnessPathOf(privateDir, 'memory');

/** The path in words: `direct-api`, or `via <harness> <model>` with ` effort <level>` when there is one. */
export function memoryPathText(path: MemoryPath): string {
  if (path.kind === 'direct') return routeName('api');
  return `via ${routeName(path.backend)} ${path.model}${path.effort === null ? '' : ` effort ${path.effort}`}`;
}
