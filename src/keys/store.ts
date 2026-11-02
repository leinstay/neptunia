// The key store: `keys.json` in the private folder, the one file that holds the model keys of a deployment. The core
// list (`core`, the first key is the primary), the extra keys by name and the base roles bound to an extra key live
// here; the sections of later features (`subharness`, `simulation`) pass through every write untouched. Every read goes
// to the file at the moment of use, so a key added from the chat is used by the next request. The file is mode 600,
// written whole to a temp file and renamed over the old one, with the mode set on every write. A listing shows a key's
// name and its last four characters, never a value; an error names a code and never holds a value, a bad name or the
// content of the file. Read by the key ring (src/keys/ring.ts), the check and the commands in this folder.

import fs from 'node:fs';
import path from 'node:path';
import { roleGroup } from '../llm/roles.ts';

export const KEYS_FILE = 'keys.json';

/** Why the store refused: each code is a reason the owner can act on. */
export type KeysErrorCode =
  | 'bad-name'
  | 'bad-value'
  | 'bad-grant'
  | 'duplicate-name'
  | 'unknown-key'
  | 'unknown-role'
  | 'not-bound'
  | 'key-in-use'
  | 'store-not-empty'
  | 'unreadable-file';

const REASONS: Readonly<Record<KeysErrorCode, string>> = {
  'bad-name': 'a key name is lowercase letters, digits and dashes, 1 to 32 characters, starting with a letter or digit',
  'bad-value': 'a key value is not blank and holds no whitespace',
  'bad-grant':
    'a grant is a number of dollars from 0 up, a reset day a whole day of the month from 1 to 31, and both or neither',
  'duplicate-name': 'a key name is used once, across the core and the extra keys',
  'unknown-key': 'no such key of that kind',
  'unknown-role': 'only a base model role can be bound to a key',
  'not-bound': 'that role is not bound to a key',
  'key-in-use': 'a role is still bound to that key; unbind it first',
  'store-not-empty': 'keys.json already holds a key',
  'unreadable-file': 'keys.json is not in the shape the store reads',
};

export class KeysError extends Error {
  code: KeysErrorCode;

  constructor(code: KeysErrorCode) {
    super(`keys: ${code}: ${REASONS[code]}`);
    this.name = 'KeysError';
    this.code = code;
  }
}

export type CoreKeyRow = { name: string; last4: string; grant: number | null; resetDay: number | null };

export type KeyListing = {
  /** In file order: the first is the primary. */
  core: Array<CoreKeyRow>;
  /** Each extra key with the roles bound to it, sorted. */
  extra: Array<{ name: string; last4: string; roles: Array<string> }>;
};

export type KeyStore = {
  /** Names, last four characters, grants and bindings; never a value. */
  list(): KeyListing;
  coreNames(): Array<string>;
  /** The extra key a role is bound to. */
  boundTo(role: string): string | null;
  /** The value of a core or extra key. Only the key ring and the check call it. */
  valueOf(name: string): string | null;
  /** `from` is the `.env` variable the key came from (the import), so spend recorded under it counts for the key. */
  addCore(input: { name: string; value: string; grant?: number; resetDay?: number; from?: string }): void;
  removeCore(name: string): { left: number };
  /** Sets (an object) or clears (null) the grant and reset day of a core key; the value is untouched. */
  setGrant(name: string, grant: { grant: number; resetDay: number } | null): void;
  addExtra(input: { name: string; value: string; from?: string }): void;
  removeExtra(name: string): void;
  /** Binds a base role to an extra key. */
  bind(role: string, name: string): void;
  unbind(role: string): void;
  /** The `.env` variable each imported key came from, by key name. */
  variables(): Record<string, string>;
};

type CoreRow = { name: string; value: string; grant: number | null; resetDay: number | null };
type Content = {
  core: Array<CoreRow>;
  extra: Record<string, string>;
  roles: Record<string, string>;
  variables: Record<string, string>;
};

const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isGrant = (value: unknown): value is number => typeof value === 'number' && Number.isFinite(value) && value >= 0;
const isResetDay = (value: unknown): value is number =>
  typeof value === 'number' && Number.isInteger(value) && value >= 1 && value <= 31;

/** The core rows of the file, or null when a row is not `{ name, value, grant?, resetDay? }`. */
function coreRowsOf(value: unknown): Array<CoreRow> | null {
  if (value === undefined) return [];
  if (!Array.isArray(value)) return null;
  const rows: Array<CoreRow> = [];
  for (const entry of value as Array<unknown>) {
    if (!isRecord(entry) || typeof entry.name !== 'string' || typeof entry.value !== 'string') return null;
    const grant = entry.grant ?? null;
    const resetDay = entry.resetDay ?? null;
    if ((grant !== null && !isGrant(grant)) || (resetDay !== null && !isResetDay(resetDay))) return null;
    rows.push({ name: entry.name, value: entry.value, grant, resetDay });
  }
  return rows;
}

/** A map of names to strings, or null when a value is not a string. */
function stringMapOf(value: unknown): Record<string, string> | null {
  if (value === undefined) return {};
  if (!isRecord(value)) return null;
  const map: Record<string, string> = {};
  for (const [key, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') return null;
    map[key] = entry;
  }
  return map;
}

export function createKeyStore({ privateDir }: { privateDir: string }): KeyStore {
  const file = path.join(privateDir, KEYS_FILE);

  /** The whole file as an object, `{}` for a missing file; the content never reaches an error. */
  function readRaw(): Record<string, unknown> {
    let text: string;
    try {
      text = fs.readFileSync(file, 'utf8');
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === 'ENOENT') return {};
      throw new KeysError('unreadable-file');
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      // The parser's message quotes the text around the error, key included, so it is dropped.
      throw new KeysError('unreadable-file');
    }
    if (!isRecord(parsed)) throw new KeysError('unreadable-file');
    return parsed;
  }

  function read(): Content {
    const raw = readRaw();
    const core = coreRowsOf(raw.core);
    const extra = stringMapOf(raw.extra);
    const roles = stringMapOf(raw.roles);
    if (core === null || extra === null || roles === null) throw new KeysError('unreadable-file');
    const variables = stringMapOf(raw.variables);
    if (variables === null) throw new KeysError('unreadable-file');
    return { core, extra, roles, variables };
  }

  /** Writes the three sections the store owns and keeps every other section of the file as it was. */
  function write(content: Content): void {
    const kept = readRaw();
    const text = `${JSON.stringify({ ...kept, core: content.core, extra: content.extra, roles: content.roles, variables: content.variables }, null, 2)}\n`;
    fs.mkdirSync(privateDir, { recursive: true, mode: 0o700 });
    const temp = `${file}.${process.pid}.tmp`;
    try {
      fs.writeFileSync(temp, text, { mode: 0o600 });
      // The mode is set on every write: the rename gives the file the temp file's mode, never the old file's.
      fs.chmodSync(temp, 0o600);
      fs.renameSync(temp, file);
    } catch (err) {
      fs.rmSync(temp, { force: true });
      throw err;
    }
  }

  const last4 = (value: string): string => value.slice(-4);
  const has = (content: Content, name: string): boolean =>
    content.core.some((row) => row.name === name) || Object.hasOwn(content.extra, name);

  function checkNew(content: Content, name: string, value: string): void {
    if (!NAME.test(name)) throw new KeysError('bad-name');
    if (value === '' || /\s/.test(value)) throw new KeysError('bad-value');
    if (has(content, name)) throw new KeysError('duplicate-name');
  }

  return {
    list() {
      const { core, extra, roles } = read();
      return {
        core: core.map((row) => ({
          name: row.name,
          last4: last4(row.value),
          grant: row.grant,
          resetDay: row.resetDay,
        })),
        extra: Object.entries(extra).map(([name, value]) => ({
          name,
          last4: last4(value),
          roles: Object.entries(roles)
            .filter(([, bound]) => bound === name)
            .map(([role]) => role)
            .sort(),
        })),
      };
    },
    coreNames: () => read().core.map((row) => row.name),
    boundTo(role) {
      const { roles } = read();
      return Object.hasOwn(roles, role) ? (roles[role] ?? null) : null;
    },
    valueOf(name) {
      const { core, extra } = read();
      const row = core.find((one) => one.name === name);
      if (row !== undefined) return row.value;
      return Object.hasOwn(extra, name) ? (extra[name] ?? null) : null;
    },
    addCore({ name, value, grant, resetDay, from }) {
      const content = read();
      checkNew(content, name, value);
      if ((grant === undefined) !== (resetDay === undefined)) throw new KeysError('bad-grant');
      if (grant !== undefined && (!isGrant(grant) || !isResetDay(resetDay))) throw new KeysError('bad-grant');
      content.core.push({ name, value, grant: grant ?? null, resetDay: resetDay ?? null });
      if (from !== undefined) content.variables[name] = from;
      write(content);
    },
    removeCore(name) {
      const content = read();
      if (!content.core.some((row) => row.name === name)) throw new KeysError('unknown-key');
      content.core = content.core.filter((row) => row.name !== name);
      delete content.variables[name];
      write(content);
      return { left: content.core.length };
    },
    setGrant(name, grant) {
      const content = read();
      const row = content.core.find((one) => one.name === name);
      if (row === undefined) throw new KeysError('unknown-key');
      if (grant !== null && (!isGrant(grant.grant) || !isResetDay(grant.resetDay))) throw new KeysError('bad-grant');
      row.grant = grant?.grant ?? null;
      row.resetDay = grant?.resetDay ?? null;
      write(content);
    },
    addExtra({ name, value, from }) {
      const content = read();
      checkNew(content, name, value);
      content.extra[name] = value;
      if (from !== undefined) content.variables[name] = from;
      write(content);
    },
    removeExtra(name) {
      const content = read();
      if (!Object.hasOwn(content.extra, name)) throw new KeysError('unknown-key');
      if (Object.values(content.roles).includes(name)) throw new KeysError('key-in-use');
      delete content.extra[name];
      delete content.variables[name];
      write(content);
    },
    bind(role, name) {
      const content = read();
      if (roleGroup(role) !== 'base') throw new KeysError('unknown-role');
      if (!Object.hasOwn(content.extra, name)) throw new KeysError('unknown-key');
      content.roles[role] = name;
      write(content);
    },
    variables: () => ({ ...read().variables }),
    unbind(role) {
      const content = read();
      if (!Object.hasOwn(content.roles, role)) throw new KeysError('not-bound');
      delete content.roles[role];
      write(content);
    },
  };
}

/** Whether `name` is a valid key name, checked before a value is asked for it. */
export const isKeyName = (name: string): boolean => NAME.test(name);

/** Whether the private folder holds a `keys.json`: the moment the core takes its keys from the ring instead of `.env`. */
export const keysFileExists = (privateDir: string): boolean => fs.existsSync(path.join(privateDir, KEYS_FILE));
