// The one list of files that hold a credential. Every tool that copies a folder asks this module before it copies a
// file. A file is secret by its path: the persona's key file, the interface logins, the backend logins, the client
// tokens and env files. The function is pure: it reads no file.

/** The classes a secret file falls into. */
export type SecretClass = 'keys' | 'credentials' | 'clients' | 'env';

/** The class of a path relative to a data folder (either separator), or null for an ordinary file. */
export function secretClassOfPath(relative: string): SecretClass | null {
  const parts = relative.split(/[\\/]/).filter((part) => part !== '');
  const name = parts.at(-1) ?? '';
  if (parts.length > 1 && parts[0] === 'clients') return 'clients';
  if (name === 'clients.json') return 'clients';
  if (name === 'keys.json') return 'keys';
  if (name === 'credentials.json' || name === '.credentials.json' || name === 'auth.json') return 'credentials';
  if (name === '.env' || name.endsWith('.env')) return 'env';
  return null;
}
