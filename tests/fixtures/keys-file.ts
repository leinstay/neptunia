// The key store's file and the routing as the subharness and setup tests see them: the secrets in
// `<privateDir>/keys.json` and which part runs on what in `<privateDir>/config/config.json`, written and read here as
// plain JSON in the shapes `src/keys/` and `src/subharness/routing.ts` write, so a test of those modules does not depend on
// their own code. A test hands one `KeysFile` in the shape keys.json once had, and `writeKeysFile` puts each section
// where it lives: the `core` and `extra` keys as named keys under `keys` of keys.json, the agents' maps under
// `models.agents` and the two paths as a chain of one harness route under `models.routes.core` and `.memory`.
// `readKeysFile` reads both files back into that one shape, the named keys as `extra`. Mode 600 like the real files.
// Changed: keys.json holds named keys and the paths are chains (spec 2026-11-09-model-routes, slice 4); the bindings of
// `roles` are gone with `llm.boundKeys`, so a test that bound a role writes that role's chain itself.
import fs from 'node:fs';
import path from 'node:path';

/** A key of the `core` list. */
export type CoreKeyRow = { name: string; value: string; grant?: number; resetDay?: number };

/** A backend name as the routing writes it. */
type Backend = 'codex' | 'claude' | 'opencode';

type PathRecord = { backend: string; model: string; effort: string | null };

/** The secrets and the routing of one deployment, in one object. */
export type KeysFile = {
  core: Array<CoreKeyRow>;
  extra: Record<string, string>;
  subharness: {
    /** the old single backend: every agent that names no backend runs through it */
    backend?: Backend | null;
    /** the old list of backends: every agent that names no backend runs through the first */
    backends?: Array<Backend>;
    key: string | null;
    modes: Record<string, string>;
    models?: Record<string, string>;
    /** the effort each agent runs at */
    efforts?: Record<string, string>;
    /** the backend each agent runs through */
    uses?: Record<string, Backend>;
    /** the OpenRouter provider each opencode agent is pinned to */
    providers?: Record<string, string>;
    /** the memory writer's subharness path; absent or null is the direct path */
    memory?: PathRecord | null;
    /** the core's subscription route; absent or null is the API route */
    core?: PathRecord | null;
  };
};

/** The values of a deployment that has just run `neptunia setup`. */
export const EMPTY_KEYS: KeysFile = {
  core: [],
  extra: {},
  subharness: { backend: null, key: null, modes: {} },
};

export const keysPath = (privateDir: string): string => path.join(privateDir, 'keys.json');
export const routingPath = (privateDir: string): string => path.join(privateDir, 'config', 'config.json');

type Tree = Record<string, unknown>;
const isTree = (value: unknown): value is Tree => typeof value === 'object' && value !== null && !Array.isArray(value);
const treeOf = (value: unknown): Tree => (isTree(value) ? value : {});

/** A copy of `tree` with `value` at `at`, or without the key when `value` is empty. */
function placed(tree: Tree, at: string, value: unknown): Tree {
  const empty = value === undefined || value === null || (isTree(value) && Object.keys(value).length === 0);
  const rest = Object.fromEntries(Object.entries(tree).filter(([name]) => name !== at));
  return empty ? rest : { ...rest, [at]: value };
}

/** The agents' maps an old `backend` or `backends` implies: each agent that names none runs through the first. */
function usesOf(sub: KeysFile['subharness']): Record<string, Backend> {
  const first = sub.backends?.[0] ?? sub.backend ?? null;
  if (first === null) return { ...sub.uses };
  const agents = ['scout', 'server', 'dev', 'watcher', 'thinker'];
  return { ...Object.fromEntries(agents.map((agent) => [agent, first])), ...sub.uses };
}

function writeJson(file: string, value: unknown): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(file, 0o600);
}

/** The chain of one harness route a path record stands for, with an effort past `high` read as `high`. */
function chainOfRecord(record: PathRecord | null | undefined): Array<Tree> | undefined {
  if (record === undefined || record === null) return undefined;
  const effort = record.effort === 'xhigh' || record.effort === 'max' ? 'high' : record.effort;
  return [{ via: 'harness', backend: record.backend, model: record.model, effort }];
}

/** Writes keys.json and the routing of config.json with `changes` laid over the empty store; other settings stay. */
export function writeKeysFile(privateDir: string, changes: Partial<KeysFile> = {}): void {
  const { core, extra, subharness: sub, ...secrets } = { ...EMPTY_KEYS, ...changes };
  const named = { ...Object.fromEntries(core.map((row) => [row.name, row.value])), ...extra };
  writeJson(keysPath(privateDir), { ...secrets, keys: named });
  let config: Tree = {};
  try {
    config = treeOf(JSON.parse(fs.readFileSync(routingPath(privateDir), 'utf8')));
  } catch {
    // no settings yet
  }
  let agents: Tree = {};
  agents = placed(agents, 'via', usesOf(sub));
  agents = placed(agents, 'model', sub.models);
  agents = placed(agents, 'effort', sub.efforts);
  agents = placed(agents, 'provider', sub.providers);
  agents = placed(agents, 'mode', sub.modes);
  agents = placed(agents, 'opencodeKey', sub.key);
  let routes = treeOf(treeOf(config.models).routes);
  for (const slot of ['core', 'memory'] as const)
    if (Object.hasOwn(sub, slot)) routes = placed(routes, slot, chainOfRecord(sub[slot]));
  const models = placed(placed(treeOf(config.models), 'agents', agents), 'routes', routes);
  writeJson(routingPath(privateDir), placed(config, 'models', models));
}

/** keys.json and the routing of config.json as they are on disk now, in one object. */
export function readKeysFile(privateDir: string): KeysFile {
  const { keys, ...secrets } = JSON.parse(fs.readFileSync(keysPath(privateDir), 'utf8')) as Tree;
  let config: Tree = {};
  try {
    config = treeOf(JSON.parse(fs.readFileSync(routingPath(privateDir), 'utf8')));
  } catch {
    // no settings: no routing
  }
  const agents = treeOf(treeOf(config.models).agents);
  const routes = treeOf(treeOf(config.models).routes);
  /** The path record of a chain whose first route is a harness, null for any other chain. */
  const record = (value: unknown): PathRecord | null => {
    const first = treeOf(Array.isArray(value) ? value[0] : undefined);
    if (first.via !== 'harness') return null;
    return { backend: String(first.backend), model: String(first.model), effort: (first.effort as string) ?? null };
  };
  return {
    ...secrets,
    core: [],
    extra: treeOf(keys) as Record<string, string>,
    subharness: {
      key: typeof agents.opencodeKey === 'string' ? agents.opencodeKey : null,
      modes: treeOf(agents.mode) as Record<string, string>,
      models: treeOf(agents.model) as Record<string, string>,
      efforts: treeOf(agents.effort) as Record<string, string>,
      uses: treeOf(agents.via) as Record<string, Backend>,
      providers: treeOf(agents.provider) as Record<string, string>,
      memory: record(routes.memory),
      core: record(routes.core),
    },
  };
}
