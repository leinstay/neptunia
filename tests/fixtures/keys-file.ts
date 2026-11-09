// The key store's file and the routing as the subharness and setup tests see them: the secrets in
// `<privateDir>/keys.json` and which part runs on what in `<privateDir>/config/config.json`, written and read here as
// plain JSON in the shapes `src/keys/` and `src/subharness/routing.ts` write, so a test of those modules does not depend on
// their own code. A test hands one `KeysFile` in the shape keys.json once had, and `writeKeysFile` puts each section
// where it lives: `core` and `extra` in keys.json, `roles` under `llm.boundKeys`, the agents' maps under
// `models.agents` and the two paths under `models.harness`.
// `readKeysFile` reads both files back into that one shape. Mode 600 like the real files.
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
  roles: Record<string, string>;
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
  roles: {},
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

/** Writes keys.json and the routing of config.json with `changes` laid over the empty store; other settings stay. */
export function writeKeysFile(privateDir: string, changes: Partial<KeysFile> = {}): void {
  const { roles, subharness: sub, ...secrets } = { ...EMPTY_KEYS, ...changes };
  writeJson(keysPath(privateDir), secrets);
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
  let harness: Tree = {};
  for (const slot of ['core', 'memory'] as const) harness = placed(harness, slot, sub[slot]);
  const models = placed(placed(treeOf(config.models), 'agents', agents), 'harness', harness);
  const llm = placed(treeOf(config.llm), 'boundKeys', roles);
  writeJson(routingPath(privateDir), placed(placed(config, 'models', models), 'llm', llm));
}

/** keys.json and the routing of config.json as they are on disk now, in one object. */
export function readKeysFile(privateDir: string): KeysFile {
  const secrets = JSON.parse(fs.readFileSync(keysPath(privateDir), 'utf8')) as Tree;
  let config: Tree = {};
  try {
    config = treeOf(JSON.parse(fs.readFileSync(routingPath(privateDir), 'utf8')));
  } catch {
    // no settings: no routing
  }
  const agents = treeOf(treeOf(config.models).agents);
  const harness = treeOf(treeOf(config.models).harness);
  const llm = treeOf(config.llm);
  const record = (value: unknown): PathRecord | null => (isTree(value) ? (value as PathRecord) : null);
  return {
    ...secrets,
    core: Array.isArray(secrets.core) ? (secrets.core as Array<CoreKeyRow>) : [],
    extra: treeOf(secrets.extra) as Record<string, string>,
    roles: treeOf(llm.boundKeys) as Record<string, string>,
    subharness: {
      key: typeof agents.opencodeKey === 'string' ? agents.opencodeKey : null,
      modes: treeOf(agents.mode) as Record<string, string>,
      models: treeOf(agents.model) as Record<string, string>,
      efforts: treeOf(agents.effort) as Record<string, string>,
      uses: treeOf(agents.via) as Record<string, Backend>,
      providers: treeOf(agents.provider) as Record<string, string>,
      memory: record(harness.memory),
      core: record(harness.core),
    },
  };
}
