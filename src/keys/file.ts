// The key store as the subharness, the simulation and `neptunia setup` see it: `<privateDir>/keys.json` (mode 600),
// read and written whole and synchronously, so the paid scripts can read it from plain code. These two functions are
// the only place this part of the engine touches the file. The key store of the keys command (src/keys/) owns the
// file's other sections; `writeKeys` keeps every section it was given, so a write here never drops them.

import fs from 'node:fs';
import path from 'node:path';
import { BACKEND_NAMES } from '../agent-runner/profiles.ts';
import type { BackendName } from '../agent-runner/profiles.ts';
import { isEffortLevel } from '../llm/roles.ts';
import type { EffortLevel } from '../llm/roles.ts';

/** A key of the core list; only the name is read here. */
export type CoreKeyRow = { name: string; value: string; grant?: number; resetDay?: number };

/** keys.json. */
export type KeyStore = {
  core: Array<CoreKeyRow>;
  extra: Record<string, string>;
  roles: Record<string, string>;
  subharness: {
    /** the connected backends, in the order they were connected, no name twice */
    backends: Array<BackendName>;
    /** the extra key opencode runs on; null while opencode is not connected */
    key: string | null;
    modes: Record<string, string>;
    /** the model each agent runs on, by agent; an agent with none runs on the backend's own default */
    models: Record<string, string>;
    /** the reasoning effort each agent runs at, by agent; an agent with none runs at its model's default */
    efforts: Record<string, EffortLevel>;
    /** the backend each agent runs through, by agent; an agent with none runs through backends[0] */
    uses: Record<string, BackendName>;
    /** the memory writer's path through a subharness (src/subharness/memory-path.ts); null is the direct path */
    memory: MemoryPathRecord | null;
  };
  simulation: { key: string | null };
};

/** The backends that can carry the memory writer: one run with no tools and the system prompt replaced. */
export const MEMORY_BACKENDS = ['codex', 'claude'] as const;
export type MemoryBackend = (typeof MEMORY_BACKENDS)[number];

/** keys.json `subharness.memory`: the backend, model and effort the memory writer runs on. */
export type MemoryPathRecord = { backend: MemoryBackend; model: string; effort: EffortLevel | null };

/** The file's name inside the private directory. */
export const KEYS_FILE = 'keys.json';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const textMap = (value: unknown): Record<string, string> =>
  Object.fromEntries(
    Object.entries(isRecord(value) ? value : {}).filter(([, one]) => typeof one === 'string')
  ) as Record<string, string>;

const backendOf = (value: unknown): BackendName | undefined => BACKEND_NAMES.find((name) => name === value);

/**
 * The connected backends: the stored list when there is one, unknown names and repeats dropped and the order kept,
 * else the single `backend` of a store written before the list, as a list of that one.
 */
function backendsOf(sub: Record<string, unknown>): Array<BackendName> {
  const listed = Array.isArray(sub.backends) ? (sub.backends as Array<unknown>) : [sub.backend];
  const names: Array<BackendName> = [];
  for (const value of listed) {
    const name = backendOf(value);
    if (name !== undefined && !names.includes(name)) names.push(name);
  }
  return names;
}

/** The backend of each agent, entries whose value is no backend dropped. */
function usesOf(value: unknown): Record<string, BackendName> {
  const uses: Record<string, BackendName> = {};
  for (const [agent, one] of Object.entries(isRecord(value) ? value : {})) {
    const name = backendOf(one);
    if (name !== undefined) uses[agent] = name;
  }
  return uses;
}

/** The effort of each agent, entries whose value is no effort level dropped. */
function effortsOf(value: unknown): Record<string, EffortLevel> {
  const efforts: Record<string, EffortLevel> = {};
  for (const [agent, one] of Object.entries(isRecord(value) ? value : {})) if (isEffortLevel(one)) efforts[agent] = one;
  return efforts;
}

/**
 * The memory writer's record, or null for one whose backend cannot carry the writer, whose model is no non-empty
 * string or whose effort is neither null nor an effort level. It is kept apart from `uses`: an agent with no entry falls
 * back to the first connected backend, and the writer never runs through a backend nobody chose for it.
 */
function memoryOf(value: unknown): MemoryPathRecord | null {
  if (!isRecord(value)) return null;
  const backend = MEMORY_BACKENDS.find((name) => name === value.backend);
  const { model } = value;
  const effort = value.effort ?? null;
  if (backend === undefined || typeof model !== 'string' || model.trim() === '') return null;
  if (effort !== null && !isEffortLevel(effort)) return null;
  return { backend, model, effort };
}

/** The store a fresh install has. */
export function emptyKeys(): KeyStore {
  return {
    core: [],
    extra: {},
    roles: {},
    subharness: { backends: [], key: null, modes: {}, models: {}, efforts: {}, uses: {}, memory: null },
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
      backends: backendsOf(sub),
      key: typeof sub.key === 'string' ? sub.key : null,
      modes: textMap(sub.modes),
      models: textMap(sub.models),
      efforts: effortsOf(sub.efforts),
      uses: usesOf(sub.uses),
      memory: memoryOf(sub.memory),
    },
    simulation: { key: typeof sim.key === 'string' ? sim.key : null },
  };
}

/** Writes the store whole at mode 600, through a temporary file renamed over the old one. */
export function writeKeys(privateDir: string, store: KeyStore): void {
  fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
  const file = path.join(privateDir, KEYS_FILE);
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(store, null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
}

/** Whether `name` is a key of the `extra` section (a core key name is not). */
export const hasExtraKey = (store: KeyStore, name: string): boolean => Object.hasOwn(store.extra, name);
