// The one list of files that hold a credential. A backup leaves them out, a restore never writes them, and every tool
// that copies a data folder asks this module before it copies a file. A file is secret by its path (the persona's key
// file, the interface logins, the backend logins, the client tokens, env files, the folder of earlier backups) or by its
// content (an OpenRouter, Anthropic or Google key pasted into any text). The functions are pure: they read no file.

/** The classes a secret file falls into; a backup's manifest counts what it left out per class. */
export const SECRET_CLASSES = ['keys', 'credentials', 'clients', 'env', 'backups', 'key-pattern'] as const;
export type SecretClass = (typeof SECRET_CLASSES)[number];

const KEY_PATTERNS: ReadonlyArray<RegExp> = [
  /sk-or-v1-[A-Za-z0-9]{20,}/,
  /sk-ant-[A-Za-z0-9_-]{20,}/,
  /AIza[A-Za-z0-9_-]{30,}/,
];

/** The class of a path relative to a data folder (either separator), or null for an ordinary file. */
export function secretClassOfPath(relative: string): SecretClass | null {
  const parts = relative.split(/[\\/]/).filter((part) => part !== '');
  const name = parts.at(-1) ?? '';
  if (parts.length > 1 && parts[0] === 'backups') return 'backups';
  if (parts.length > 1 && parts[0] === 'clients') return 'clients';
  if (name === 'clients.json') return 'clients';
  if (name === 'keys.json') return 'keys';
  if (name === 'credentials.json' || name === '.credentials.json' || name === 'auth.json') return 'credentials';
  if (name === '.env' || name.endsWith('.env')) return 'env';
  return null;
}

/** `key-pattern` when the content holds a key of a known provider, otherwise null. */
export function secretClassOfContent(content: Buffer | string): SecretClass | null {
  const text = typeof content === 'string' ? content : content.toString('latin1');
  return KEY_PATTERNS.some((pattern) => pattern.test(text)) ? 'key-pattern' : null;
}

/** The class by path first, then by content when the caller has it. */
export function secretClassOf(relative: string, content?: Buffer | string): SecretClass | null {
  return secretClassOfPath(relative) ?? (content === undefined ? null : secretClassOfContent(content));
}
