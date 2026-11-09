// The key store as the subharness and `neptunia setup` see it: `<privateDir>/keys.json` (mode 600),
// read and written whole and synchronously, so the paid scripts can read it from plain code. The file holds secrets
// alone: the core keys, the extra keys and the service credentials.
// Which part runs on which key or backend is routing, and lives in config.json (src/subharness/routing.ts); a write here
// drops the sections `roles`, `subharness` and `simulation` an older file still carries. The key store of the keys
// command (src/keys/store.ts) owns the file's other sections; `writeKeys` keeps every other section it was given.

import fs from 'node:fs';
import path from 'node:path';

/** A key of the core list; only the name is read here. */
export type CoreKeyRow = { name: string; value: string; grant?: number; resetDay?: number };

/** keys.json: the secrets, and any other section the keys command keeps there. */
export type KeyStore = {
  core: Array<CoreKeyRow>;
  extra: Record<string, string>;
  [section: string]: unknown;
};

/** The sections an older keys.json held that are routing, not secrets: no write keeps them. */
export const ROUTING_SECTIONS: ReadonlyArray<string> = ['roles', 'subharness', 'simulation'];

/** The sections no module reads any more: no write keeps them either. */
const UNREAD_SECTIONS: ReadonlyArray<string> = ['variables'];

/** `file` without the routing sections and the unread ones. */
export function secretsOnly(file: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(file).filter(
      ([section]) => !ROUTING_SECTIONS.includes(section) && !UNREAD_SECTIONS.includes(section)
    )
  );
}

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

/** The store a fresh install has. */
export function emptyKeys(): KeyStore {
  return { core: [], extra: {} };
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
  return {
    ...secretsOnly(parsed),
    core: Array.isArray(parsed.core) ? (parsed.core as Array<CoreKeyRow>) : [],
    extra: textMap(parsed.extra),
  };
}

/** Writes the store whole at mode 600, through a temporary file renamed over the old one. */
export function writeKeys(privateDir: string, store: KeyStore): void {
  fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
  const file = path.join(privateDir, KEYS_FILE);
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(secretsOnly(store), null, 2)}\n`, { mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
}

/** Whether `name` is a key of the `extra` section (a core key name is not). */
export const hasExtraKey = (store: KeyStore, name: string): boolean => Object.hasOwn(store.extra, name);
