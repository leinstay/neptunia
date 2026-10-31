// The clients of the core and the principal each token stands for. The private layer's `clients.json` maps a client's
// name to its principal: `kind` (`interface`, `cli`, `plugin` or `agent`), `iface` for an interface, `tokenFile` (a
// path under the private directory, `clients/<name>.token`, mode 0600), `permissions`, and for a client of the task
// board its `boardRoles` (src/board/board.ts reads those). tools/client-token.mjs writes both. An agent's principal has
// no `iface`: it says hello under `agent` (src/interface/link.ts). The link resolves the token of every envelope
// through `principalOfToken`, which reads the files at each call, so a rotated or revoked token stops at the next
// envelope. With no `clients.json` the core's boot principal, made at start for its one in-process interface, is the
// only one. A `clients.json` that cannot be read makes every token no one. Logs nothing and never throws.

import { createHash, timingSafeEqual } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

/** The client kinds: an interface package, the owner's command line, a plugin, a development agent of the board. */
export const PRINCIPAL_KINDS = ['interface', 'cli', 'plugin', 'agent'] as const;
export type PrincipalKind = (typeof PRINCIPAL_KINDS)[number];

/**
 * Who a connection is. `iface` is the namespace an interface principal's events must carry; the boot principal's is
 * null, which binds it to the `iface` its `hello` names.
 */
export type Principal = {
  name: string;
  kind: PrincipalKind;
  iface: string | null;
  permissions: ReadonlyArray<string>;
};

/** One entry of `clients.json`: the principal and the file its token is in. */
export type ClientEntry = Principal & { tokenFile: string };

/** The principal the core makes at start when no `clients.json` exists, with its token. */
export type BootPrincipal = { token: string; principal: Principal };

/** The file of the clients under the private directory. */
export const CLIENTS_FILE = 'clients.json';

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const isKind = (value: unknown): value is PrincipalKind =>
  typeof value === 'string' && (PRINCIPAL_KINDS as ReadonlyArray<string>).includes(value);

/** The entry named `name`, or null when it is malformed: no kind, no token file, or an interface without an iface. */
function entryOf(name: string, value: unknown): ClientEntry | null {
  if (!isObject(value) || !isKind(value.kind)) return null;
  if (typeof value.tokenFile !== 'string' || value.tokenFile === '') return null;
  const named = typeof value.iface === 'string' && value.iface !== '' ? value.iface : null;
  const iface = value.kind === 'agent' ? null : named;
  if (value.kind === 'interface' && iface === null) return null;
  const permissions = Array.isArray(value.permissions)
    ? value.permissions.filter((item): item is string => typeof item === 'string')
    : [];
  return { name, kind: value.kind, iface, permissions, tokenFile: value.tokenFile };
}

/** The entries of `clients.json`: null when there is no file, `broken` when it cannot be read as an object. */
function readClients(privateDir: string): Array<ClientEntry> | null | 'broken' {
  let text: string;
  try {
    text = fs.readFileSync(path.join(privateDir, CLIENTS_FILE), 'utf8');
  } catch (err) {
    return (err as NodeJS.ErrnoException).code === 'ENOENT' ? null : 'broken';
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return 'broken';
  }
  if (!isObject(parsed)) return 'broken';
  return Object.entries(parsed).flatMap(([name, value]) => {
    const entry = entryOf(name, value);
    return entry === null ? [] : [entry];
  });
}

/** The principals of `clients.json` with their token files, or null when the file does not exist. */
export function loadPrincipals(privateDir: string): Array<ClientEntry> | null {
  const clients = readClients(privateDir);
  if (clients === 'broken') return [];
  return clients;
}

/** The token held in `entry`'s file, a trailing newline dropped; null when the file is missing or outside the folder. */
function tokenOfEntry(privateDir: string, entry: ClientEntry): string | null {
  const root = path.resolve(privateDir);
  const file = path.resolve(root, entry.tokenFile);
  if (!file.startsWith(`${root}${path.sep}`)) return null;
  try {
    return fs.readFileSync(file, 'utf8').replace(/\r?\n$/, '');
  } catch {
    return null;
  }
}

const digest = (text: string): Buffer => createHash('sha256').update(text).digest();

// Compared through their digests, so the time taken says nothing about how much of a token matched.
const sameToken = (given: string, known: string): boolean => timingSafeEqual(digest(given), digest(known));

const principalOf = (entry: ClientEntry): Principal => ({
  name: entry.name,
  kind: entry.kind,
  iface: entry.iface,
  permissions: entry.permissions,
});

/**
 * The principal `token` stands for, or null for no one: an empty token, a token no client holds, or any token while
 * `clients.json` cannot be read. `boot` counts only while `clients.json` does not exist.
 */
export function principalOfToken(
  token: string,
  options: { privateDir: string; boot: BootPrincipal | null }
): Principal | null {
  if (token === '') return null;
  const clients = readClients(options.privateDir);
  if (clients === 'broken') return null;
  if (clients === null) {
    const { boot } = options;
    return boot !== null && boot.token !== '' && sameToken(token, boot.token) ? boot.principal : null;
  }
  for (const entry of clients) {
    const known = tokenOfEntry(options.privateDir, entry);
    if (known !== null && known !== '' && sameToken(token, known)) return principalOf(entry);
  }
  return null;
}
