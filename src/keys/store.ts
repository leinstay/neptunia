// The key store: `keys.json` in the private folder, the one file that holds the model keys of a deployment. Each key is
// named, under `keys` (`{ <name>: <value> }`, in the order they were added), and the service credentials and the
// `management` key pass through every write untouched. Which role runs on which key is its chain of routes in
// `models.routes` of config.json (src/llm/route-chain.ts), never a section of this file. Every read goes to the file at
// the moment of use, so a key added from the chat is used by the next request. The file is mode 600, written whole to a
// temp file and renamed over the old one, with the mode set on every write. A listing shows a key's name and its last
// four characters, never a value; an error names a code and never holds a value, a bad name or the content of the
// file. A file in the layout before named keys (a `core` list or an `extra` section) is refused with `old-layout`.
// Read by the chain client (src/llm/chain-client.ts), the check and the commands in this folder.

import fs from 'node:fs';
import path from 'node:path';
import { isOldLayout, OLD_LAYOUT_REASON, secretsOnly } from './file.ts';

export const KEYS_FILE = 'keys.json';

/** Why the store refused: each code is a reason the owner can act on. */
export type KeysErrorCode =
  'bad-name' | 'bad-value' | 'duplicate-name' | 'unknown-key' | 'unreadable-file' | 'old-layout';

const REASONS: Readonly<Record<KeysErrorCode, string>> = {
  'bad-name': 'a key name is lowercase letters, digits and dashes, 1 to 32 characters, starting with a letter or digit',
  'bad-value': 'a key value is not blank and holds no whitespace',
  'duplicate-name': 'a key name is used once',
  'unknown-key': 'keys.json holds no key of that name',
  'unreadable-file': 'keys.json is not in the shape the store reads',
  'old-layout': OLD_LAYOUT_REASON,
};

export class KeysError extends Error {
  code: KeysErrorCode;

  constructor(code: KeysErrorCode) {
    super(`keys: ${code}: ${REASONS[code]}`);
    this.name = 'KeysError';
    this.code = code;
  }
}

/** A key as a listing shows it: its name and the last four characters of its value. */
export type KeyRow = { name: string; last4: string };

export type KeyStore = {
  /** Every key in file order, by name and last four characters; never a value. */
  list(): Array<KeyRow>;
  /** The key names in file order. */
  names(): Array<string>;
  /** The value of a named key, null for a name keys.json lacks. Only the chain client and the checks call it. */
  valueOf(name: string): string | null;
  add(input: { name: string; value: string }): void;
  remove(name: string): void;
};

const NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

/** The named keys of the file, or null when a value is not a string. */
function namedKeysOf(value: unknown): Record<string, string> | null {
  if (value === undefined) return {};
  if (!isRecord(value)) return null;
  const keys: Record<string, string> = {};
  for (const [name, entry] of Object.entries(value)) {
    if (typeof entry !== 'string') return null;
    keys[name] = entry;
  }
  return keys;
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
    if (isOldLayout(parsed)) throw new KeysError('old-layout');
    return parsed;
  }

  function read(): Record<string, string> {
    const keys = namedKeysOf(readRaw().keys);
    if (keys === null) throw new KeysError('unreadable-file');
    return keys;
  }

  /** Writes the named keys and keeps every other secret section of the file as it was. */
  function write(keys: Record<string, string>): void {
    const kept = secretsOnly(readRaw());
    const text = `${JSON.stringify({ ...kept, keys }, null, 2)}\n`;
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

  return {
    list: () => Object.entries(read()).map(([name, value]) => ({ name, last4: value.slice(-4) })),
    names: () => Object.keys(read()),
    valueOf(name) {
      const keys = read();
      return Object.hasOwn(keys, name) ? (keys[name] ?? null) : null;
    },
    add({ name, value }) {
      const keys = read();
      if (!NAME.test(name)) throw new KeysError('bad-name');
      if (value === '' || /\s/.test(value)) throw new KeysError('bad-value');
      if (Object.hasOwn(keys, name)) throw new KeysError('duplicate-name');
      write({ ...keys, [name]: value });
    },
    remove(name) {
      const keys = read();
      if (!Object.hasOwn(keys, name)) throw new KeysError('unknown-key');
      write(Object.fromEntries(Object.entries(keys).filter(([one]) => one !== name)));
    },
  };
}

/** Whether `name` is a valid key name, checked before a value is asked for it. */
export const isKeyName = (name: string): boolean => NAME.test(name);

/** Whether the private folder holds a `keys.json`. */
export const keysFileExists = (privateDir: string): boolean => fs.existsSync(path.join(privateDir, KEYS_FILE));
