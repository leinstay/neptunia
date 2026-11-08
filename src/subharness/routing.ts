// Which part of Neptunia runs on what: the extra key a role is bound to, the source, model, effort, mode and provider of
// each agent, the extra key opencode runs on, the paths of her core, her memory writer and the simulation through a
// subharness, and the key the simulation spends. All of it lives in the private settings file `config/config.json`
// (src/config/files.ts), never in keys.json, which holds the secrets alone (src/keys/file.ts). Each read
// goes to the file at the moment of use, so a choice from the chat acts on the next request; each write goes through the
// locked writer of src/service/local-settings.ts and leaves every other setting as it was.
//
// The settings and the record each maps to:
//   llm.boundKeys            roles                  the extra key each base role and `search` goes out on
//   llm.simulationKey        simulation.key         the extra key the paid scripts spend
//   models.agents.via        subharness.uses        the backend each agent runs through
//   models.agents.model      subharness.models      the model each agent runs on
//   models.agents.effort     subharness.efforts     the reasoning effort each agent runs at
//   models.agents.provider   subharness.providers   the OpenRouter provider each opencode agent is pinned to
//   models.agents.mode       subharness.modes       what each agent may do (src/subharness/control.ts#AGENT_MODES)
//   models.agents.opencodeKey subharness.key        the extra key opencode runs on
//   models.harness.core      subharness.core        her core's subscription route; null is the API
//   models.harness.memory    subharness.memory      the memory writer's path; null is the direct path
//   models.harness.simulation subharness.simulation the simulation's subscription route; null is the API
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

/** `models.harness.memory`, `.core` and `.simulation`: the backend, model and effort a path runs on. */
export type MemoryPathRecord = { backend: MemoryBackend; model: string; effort: EffortLevel | null };

/** The agents' routes and the three paths through a subharness. */
export type SubharnessRouting = {
  /** the extra key opencode runs on; null while opencode has no login */
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
  /** the memory writer's path through a subharness (src/subharness/memory-path.ts); null is the direct path */
  memory: MemoryPathRecord | null;
  /** her core's subscription route (src/subharness/subscription-path.ts); null is the API */
  core: MemoryPathRecord | null;
  /** the simulation's subscription route; null is the API */
  simulation: MemoryPathRecord | null;
};

/** Which part runs on what, as the private settings file holds it. */
export type Routing = {
  /** the extra key each role is bound to, by role */
  roles: Record<string, string>;
  subharness: SubharnessRouting;
  simulation: { key: string | null };
};

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

/**
 * A path record, or null for one whose backend cannot carry it, whose model is no non-empty string or whose effort is
 * neither null nor an effort level. It is kept apart from the agents' backends, so a path never runs through a backend
 * nobody chose for it.
 */
function recordOf(value: unknown): MemoryPathRecord | null {
  if (!isTree(value)) return null;
  const backend = MEMORY_BACKENDS.find((name) => name === value.backend);
  const { model } = value;
  const effort = value.effort ?? null;
  if (backend === undefined || typeof model !== 'string' || model.trim() === '') return null;
  if (effort !== null && !isListedEffort(effort)) return null;
  return { backend, model, effort };
}

/** The routing of a settings tree. */
function routingOf(config: Tree): Routing {
  const llm = treeOf(config.llm);
  const models = treeOf(config.models);
  const agents = treeOf(models.agents);
  const harness = treeOf(models.harness);
  return {
    roles: textMap(llm.boundKeys),
    subharness: {
      key: textOrNull(agents.opencodeKey),
      modes: textMap(agents.mode),
      models: textMap(agents.model),
      efforts: effortsOf(agents.effort),
      uses: usesOf(agents.via),
      providers: textMap(agents.provider),
      memory: recordOf(harness.memory),
      core: recordOf(harness.core),
      simulation: recordOf(harness.simulation),
    },
    simulation: { key: textOrNull(llm.simulationKey) },
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
  let harness = treeOf(treeOf(config.models).harness);
  harness = placed(harness, 'core', sub.core);
  harness = placed(harness, 'memory', sub.memory);
  harness = placed(harness, 'simulation', sub.simulation);
  const models = placed(placed(treeOf(config.models), 'agents', agents), 'harness', harness);
  let llm = treeOf(config.llm);
  llm = placed(llm, 'boundKeys', routing.roles);
  llm = placed(llm, 'simulationKey', routing.simulation.key);
  return placed(placed(config, 'models', models), 'llm', llm);
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
 * The extra key opencode runs on (`models.agents.opencodeKey`) with its value from keys.json, or null while it names
 * none or a key that left the store.
 */
export function opencodeKey(privateDir: string): { name: string; value: string } | null {
  const name = readRouting(privateDir).subharness.key;
  if (name === null) return null;
  const { extra } = readKeys(privateDir);
  return Object.hasOwn(extra, name) ? { name, value: extra[name] ?? '' } : null;
}

/** Applies `change` to the routing under the settings file's lock; a change that alters nothing writes nothing. */
export function updateRouting(privateDir: string, change: (routing: Routing) => Routing): void {
  updateLocalSettings(privateDir, (local) => withRouting(local, change(routingOf(local))));
}
