// The key store's file as the subharness, simulation and setup tests see it: `<privateDir>/keys.json`, written and
// read here as plain JSON in the shape of the spec (.agents/docs/specs/2026-11-02-keys-and-subharness.md), so a test
// of those modules does not depend on the store's own code. Mode 600 like the real file.
import fs from 'node:fs';
import path from 'node:path';

/** A key of the `core` list. */
export type CoreKeyRow = { name: string; value: string; grant?: number; resetDay?: number };

/** A backend name as keys.json writes it. */
type Backend = 'codex' | 'claude' | 'opencode';

/** keys.json. */
export type KeysFile = {
  core: Array<CoreKeyRow>;
  extra: Record<string, string>;
  roles: Record<string, string>;
  subharness: {
    /** the old single backend, read as a one-element list */
    backend?: Backend | null;
    /** the connected backends */
    backends?: Array<Backend>;
    key: string | null;
    modes: Record<string, string>;
    models?: Record<string, string>;
    /** the effort each agent runs at */
    efforts?: Record<string, string>;
    /** the backend each agent runs through */
    uses?: Record<string, Backend>;
    /** the memory writer's subharness path; absent or null is the direct path */
    memory?: { backend: string; model: string; effort: string | null } | null;
  };
  simulation: { key: string | null };
};

/** The values of a deployment that has just run `neptunia setup`. */
export const EMPTY_KEYS: KeysFile = {
  core: [],
  extra: {},
  roles: {},
  subharness: { backend: null, key: null, modes: {} },
  simulation: { key: null },
};

export const keysPath = (privateDir: string): string => path.join(privateDir, 'keys.json');

/** Writes keys.json with `changes` laid over the empty store. */
export function writeKeysFile(privateDir: string, changes: Partial<KeysFile> = {}): void {
  fs.mkdirSync(privateDir, { recursive: true });
  fs.writeFileSync(keysPath(privateDir), JSON.stringify({ ...EMPTY_KEYS, ...changes }, null, 2), { mode: 0o600 });
  fs.chmodSync(keysPath(privateDir), 0o600);
}

/** keys.json as it is on disk now. */
export function readKeysFile(privateDir: string): KeysFile {
  return JSON.parse(fs.readFileSync(keysPath(privateDir), 'utf8')) as KeysFile;
}
