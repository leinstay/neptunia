// Which agent runs on what: the source, model, effort, mode and provider of each agent and the named key opencode runs
// on. The model roles run on their chains of routes in `models.routes` (src/llm/route-chain.ts), which this module does
// not touch. All of it lives in the private settings file `config/config.json`
// (src/config/files.ts), never in keys.json, which holds the secrets alone (src/keys/file.ts). Each read
// goes to the file at the moment of use, so a choice from the chat acts on the next request; each write goes through the
// locked writer of src/service/local-settings.ts and leaves every other setting as it was.
//
// The settings and the record each maps to:
//   models.agents.via        subharness.uses        the backend each agent runs through
//   models.agents.model      subharness.models      the model each agent runs on
//   models.agents.effort     subharness.efforts     the reasoning effort each agent runs at
//   models.agents.provider   subharness.providers   the OpenRouter provider each opencode agent is pinned to
//   models.agents.mode       subharness.modes       what each agent may do (src/subharness/control.ts#AGENT_MODES)
//   models.agents.opencodeKey subharness.key        the named key of keys.json opencode runs on
// An empty map or a null record leaves the file, so a deployment that chose nothing keeps a file with no routing in it.

import path from 'node:path';
import { BACKEND_NAMES } from '../agent-runner/profiles.ts';
import type { BackendName } from '../agent-runner/profiles.ts';
import { isListedEffort } from '../llm/roles.ts';
import type { EffortLevel } from '../llm/roles.ts';
import { updateLocalSettings } from '../service/local-settings.ts';
import { readLocalConfig } from '../tools/operations/shared.ts';
import { CONFIG_DIR, CONFIG_FILE } from '../config/files.ts';
import { readKeys } from '../keys/file.ts';

/** The agents that take a subharness route: the two errand agents, the development agents, the watcher and the thinker. */
export const SUBHARNESS_AGENTS = ['scout', 'server', 'dev', 'watcher', 'thinker'] as const;
export type SubharnessAgent = (typeof SUBHARNESS_AGENTS)[number];

/** The backends that can carry the memory writer: one run with no tools and the system prompt replaced. */
export const MEMORY_BACKENDS = ['codex', 'claude'] as const;
export type MemoryBackend = (typeof MEMORY_BACKENDS)[number];

/** The agents' routes. */
export type SubharnessRouting = {
  /** the named key opencode runs on; null while opencode has no login */
  key: string | null;
  modes: Record<string, string>;
  /** the model each agent runs on, by agent; an agent with none runs on the backend's own default */
  models: Record<string, string>;
  /** the reasoning effort each agent runs at, by agent; an agent with none runs at its model's default */
  efforts: Record<string, EffortLevel>;
  /** the source each agent runs through, by agent; an agent with none has no route */
  uses: Record<string, BackendName>;
  /** the OpenRouter provider each opencode agent is pinned to, by agent; an agent with none runs at any provider */
  providers: Record<string, string>;
};

/** Which agent runs on what, as the private settings file holds it. */
export type Routing = { subharness: SubharnessRouting };

type Tree = Record<string, unknown>;

const isTree = (value: unknown): value is Tree => typeof value === 'object' && value !== null && !Array.isArray(value);
const treeOf = (value: unknown): Tree => (isTree(value) ? value : {});

const textMap = (value: unknown): Record<string, string> =>
  Object.fromEntries(Object.entries(treeOf(value)).filter(([, one]) => typeof one === 'string')) as Record<
    string,
    string
  >;

const textOrNull = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/** The backend of each agent, entries whose value is no backend dropped. */
function usesOf(value: unknown): Record<string, BackendName> {
  const uses: Record<string, BackendName> = {};
  for (const [agent, one] of Object.entries(treeOf(value))) {
    const name = BACKEND_NAMES.find((backend) => backend === one);
    if (name !== undefined) uses[agent] = name;
  }
  return uses;
}

/** The effort of each agent, entries whose value is no effort level dropped. */
function effortsOf(value: unknown): Record<string, EffortLevel> {
  const efforts: Record<string, EffortLevel> = {};
  for (const [agent, one] of Object.entries(treeOf(value))) if (isListedEffort(one)) efforts[agent] = one;
  return efforts;
}

/** The routing of a settings tree. */
function routingOf(config: Tree): Routing {
  const agents = treeOf(treeOf(config.models).agents);
  return {
    subharness: {
      key: textOrNull(agents.opencodeKey),
      modes: textMap(agents.mode),
      models: textMap(agents.model),
      efforts: effortsOf(agents.effort),
      uses: usesOf(agents.via),
      providers: textMap(agents.provider),
    },
  };
}

/** `tree` with `value` at `key`, or without `key` when `value` is null or an empty map. */
function placed(tree: Tree, key: string, value: unknown): Tree {
  const rest = Object.fromEntries(Object.entries(tree).filter(([name]) => name !== key));
  const empty = value === null || (isTree(value) && Object.keys(value).length === 0);
  return empty ? rest : { ...rest, [key]: value };
}

/** The settings tree `config` with its routing replaced by `routing`. */
function withRouting(config: Tree, routing: Routing): Tree {
  const sub = routing.subharness;
  let agents = treeOf(treeOf(config.models).agents);
  agents = placed(agents, 'via', sub.uses);
  agents = placed(agents, 'model', sub.models);
  agents = placed(agents, 'effort', sub.efforts);
  agents = placed(agents, 'provider', sub.providers);
  agents = placed(agents, 'mode', sub.modes);
  agents = placed(agents, 'opencodeKey', sub.key);
  return placed(config, 'models', placed(treeOf(config.models), 'agents', agents));
}

/** The routing nobody has chosen yet. */
export function emptyRouting(): Routing {
  return routingOf({});
}

/**
 * The routing in the private settings file now; a missing file reads as nothing chosen. Throws on JSON that does not
 * parse. The read takes the file where the settings loader does and, unlike a write, leaves the check of an old
 * layout to the loader, so an agent run reads its route in any private folder.
 */
export function readRouting(privateDir: string): Routing {
  return routingOf(treeOf(readLocalConfig(path.join(privateDir, CONFIG_DIR, CONFIG_FILE))));
}

/**
 * The named key opencode runs on (`models.agents.opencodeKey`) with its value from keys.json, or null while it names
 * none or a key that left the store.
 */
export function opencodeKey(privateDir: string): { name: string; value: string } | null {
  const name = readRouting(privateDir).subharness.key;
  if (name === null) return null;
  const { keys } = readKeys(privateDir);
  return Object.hasOwn(keys, name) ? { name, value: keys[name] ?? '' } : null;
}

/** Applies `change` to the routing under the settings file's lock; a change that alters nothing writes nothing. */
export function updateRouting(privateDir: string, change: (routing: Routing) => Routing): void {
  updateLocalSettings(privateDir, (local) => withRouting(local, change(routingOf(local))));
}
