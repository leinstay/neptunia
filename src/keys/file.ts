// The key store as the subharness, the simulation and `neptunia setup` see it: `<privateDir>/keys.json` (mode 600),
// read and written whole and synchronously, so the paid scripts can read it from plain code. These two functions are
// the only place this part of the engine touches the file. The key store of the keys command (src/keys/) owns the
// file's other sections; `writeKeys` keeps every section it was given, so a write here never drops them.

import fs from 'node:fs';
import path from 'node:path';
import type { BackendName } from '../agent-runner/profiles.ts';

/** A key of the core list; only the name is read here. */
export type CoreKeyRow = { name: string; value: string; grant?: number; resetDay?: number };

/** keys.json. */
export type KeyStore = {
  core: Array<CoreKeyRow>;
  extra: Record<string, string>;
  roles: Record<string, string>;
  subharness: {
    backend: BackendName | null;
    key: string | null;
    modes: Record<string, string>;
    /** the model each agent runs on, by agent; an agent with none runs on the backend's own default */
    models: Record<string, string>;
  };
  simulation: { key: string | null };
};

/** The file's name inside the private directory. */
export const KEYS_FILE = 'keys.json';

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

const textMap = (value: unknown): Record<string, string> =>
  Object.fromEntries(
    Object.entries(isRecord(value) ? value : {}).filter(([, one]) => typeof one === 'string')
  ) as Record<string, string>;

/** The store a fresh install has. */
export function emptyKeys(): KeyStore {
  return {
    core: [],
    extra: {},
    roles: {},
    subharness: { backend: null, key: null, modes: {}, models: {} },
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
  const backend =
    sub.backend === 'codex' || sub.backend === 'claude' || sub.backend === 'opencode' ? sub.backend : null;
  return {
    ...parsed,
    core: Array.isArray(parsed.core) ? (parsed.core as Array<CoreKeyRow>) : [],
    extra: textMap(parsed.extra),
    roles: textMap(parsed.roles),
    subharness: {
      backend,
      key: typeof sub.key === 'string' ? sub.key : null,
      modes: textMap(sub.modes),
      models: textMap(sub.models),
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
