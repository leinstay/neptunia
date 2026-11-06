// The key store as the subharness, the simulation and `neptunia setup` see it: `<privateDir>/keys.json` (mode 600),
// read and written whole and synchronously, so the paid scripts can read it from plain code. These two functions are
// the only place this part of the engine touches the file. The key store of the keys command (src/keys/) owns the
// file's other sections; `writeKeys` keeps every section it was given, so a write here never drops them.

import fs from 'node:fs';
import path from 'node:path';
import { BACKEND_NAMES } from '../agent-runner/profiles.ts';
import type { BackendName } from '../agent-runner/profiles.ts';
import { isListedEffort } from '../llm/roles.ts';
import type { EffortLevel } from '../llm/roles.ts';

/** A key of the core list; only the name is read here. */
export type CoreKeyRow = { name: string; value: string; grant?: number; resetDay?: number };

/** keys.json. */
export type KeyStore = {
  core: Array<CoreKeyRow>;
  extra: Record<string, string>;
  roles: Record<string, string>;
  subharness: {
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
    /** her core's subscription route (src/subharness/subscription-path.ts), in the memory record's shape; null is the API */
    core: MemoryPathRecord | null;
    /** the simulation's subscription route, in the same shape; null is the API */
    simulation: MemoryPathRecord | null;
  };
  simulation: { key: string | null };
};

/** The agents that take a subharness route: the two errand agents, the development agents, the watcher and the thinker. */
export const SUBHARNESS_AGENTS = ['scout', 'server', 'dev', 'watcher', 'thinker'] as const;
export type SubharnessAgent = (typeof SUBHARNESS_AGENTS)[number];

/** The backends that can carry the memory writer: one run with no tools and the system prompt replaced. */
export const MEMORY_BACKENDS = ['codex', 'claude'] as const;
export type MemoryBackend = (typeof MEMORY_BACKENDS)[number];

/** keys.json `subharness.memory`, `subharness.core` and `subharness.simulation`: the backend, model and effort a path runs on. */
export type MemoryPathRecord = { backend: MemoryBackend; model: string; effort: EffortLevel | null };

/** The file's name inside the private directory. */
export const KEYS_FILE = 'keys.json';

/** Optional service credentials stay in the persona's key file and reach only their consumer. */
export function serviceCredential(dataDir: string, name: 'youtube' | 'brave' | 'exa' | 'proxy'): string | null {
  try {
    const value: unknown = JSON.parse(fs.readFileSync(path.join(dataDir, KEYS_FILE), 'utf8'));
    if (!isRecord(value) || !isRecord(value.services)) return null;
    const key = value.services[name];
    return typeof key === 'string' && key.trim() !== '' ? key.trim() : null;
  } catch {
    return null;
  }
}

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const textMap = (value: unknown): Record<string, string> =>
  Object.fromEntries(
    Object.entries(isRecord(value) ? value : {}).filter(([, one]) => typeof one === 'string')
  ) as Record<string, string>;

const backendOf = (value: unknown): BackendName | undefined => BACKEND_NAMES.find((name) => name === value);

/**
 * The backend of each agent, entries whose value is no backend dropped. A store written before the role assignments
 * holds a list `backends`, or the single `backend` before that: an agent that names no backend takes the list's first
 * name, the one it ran through. The next write leaves the list out, so this reading happens only until then.
 */
function usesOf(sub: Record<string, unknown>): Record<string, BackendName> {
  const uses: Record<string, BackendName> = {};
  for (const [agent, one] of Object.entries(isRecord(sub.uses) ? sub.uses : {})) {
    const name = backendOf(one);
    if (name !== undefined) uses[agent] = name;
  }
  const listed: Array<unknown> = Array.isArray(sub.backends) ? sub.backends : [sub.backend];
  const first = listed.map(backendOf).find((name) => name !== undefined);
  if (first === undefined) return uses;
  for (const agent of SUBHARNESS_AGENTS) uses[agent] ??= first;
  return uses;
}

/** The effort of each agent, entries whose value is no effort level dropped. */
function effortsOf(value: unknown): Record<string, EffortLevel> {
  const efforts: Record<string, EffortLevel> = {};
  for (const [agent, one] of Object.entries(isRecord(value) ? value : {}))
    if (isListedEffort(one)) efforts[agent] = one;
  return efforts;
}

/**
 * A path record (the memory writer's, the core's or the simulation's), or null for one whose backend cannot carry it,
 * whose model is no non-empty string or whose effort is neither null nor an effort level. It is kept apart from `uses`,
 * so a path never runs through a backend nobody chose for it.
 */
function memoryOf(value: unknown): MemoryPathRecord | null {
  if (!isRecord(value)) return null;
  const backend = MEMORY_BACKENDS.find((name) => name === value.backend);
  const { model } = value;
  const effort = value.effort ?? null;
  if (backend === undefined || typeof model !== 'string' || model.trim() === '') return null;
  if (effort !== null && !isListedEffort(effort)) return null;
  return { backend, model, effort };
}

/** The store a fresh install has. */
export function emptyKeys(): KeyStore {
  return {
    core: [],
    extra: {},
    roles: {},
    subharness: {
      key: null,
      modes: {},
      models: {},
      efforts: {},
      uses: {},
      providers: {},
      memory: null,
      core: null,
      simulation: null,
    },
    simulation: { key: null },
  };
}

/** The file as the store: a missing section reads as its empty value. Throws a plain error for a file that is no JSON object. */
export function readKeys(privateDir: string): KeyStore {
  const file = path.join(privateDir, KEYS_FILE);
  let raw: string;
  try {
    raw = fs.readFileSync(file, 'utf8');
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') return emptyKeys();
    throw new Error(`${KEYS_FILE} cannot be read`);
  }
  let parsed: unknown;
  try {
    parsed = raw.trim() === '' ? {} : JSON.parse(raw);
  } catch {
    throw new Error(`${KEYS_FILE} is not valid JSON`);
  }
  if (!isRecord(parsed)) throw new Error(`${KEYS_FILE} is not a JSON object`);
  const sub = isRecord(parsed.subharness) ? parsed.subharness : {};
  const sim = isRecord(parsed.simulation) ? parsed.simulation : {};
  return {
    ...parsed,
    core: Array.isArray(parsed.core) ? (parsed.core as Array<CoreKeyRow>) : [],
    extra: textMap(parsed.extra),
    roles: textMap(parsed.roles),
    subharness: {
      key: typeof sub.key === 'string' ? sub.key : null,
      modes: textMap(sub.modes),
      models: textMap(sub.models),
      efforts: effortsOf(sub.efforts),
      uses: usesOf(sub),
      providers: textMap(sub.providers),
      memory: memoryOf(sub.memory),
      core: memoryOf(sub.core),
      simulation: memoryOf(sub.simulation),
    },
    simulation: { key: typeof sim.key === 'string' ? sim.key : null },
  };
}

/** Writes the store whole at mode 600, through a temporary file renamed over the old one. */
export function writeKeys(privateDir: string, store: KeyStore): void {
  fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
  const file = path.join(privateDir, KEYS_FILE);
  const temporary = `${file}.${process.pid}.tmp`;
  // An empty `providers` is left out, so a file nobody pinned keeps the shape it had.
  const { providers, ...others } = store.subharness;
  const shaped = Object.keys(providers).length === 0 ? { ...store, subharness: others } : store;
  fs.writeFileSync(temporary, `${JSON.stringify(shaped, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
}

/** Whether `name` is a key of the `extra` section (a core key name is not). */
export const hasExtraKey = (store: KeyStore, name: string): boolean => Object.hasOwn(store.extra, name);
