// The clients of the core and their tokens on disk (src/interface/principals.ts reads them): one entry of `clients.json`
// and one token file `clients/<name>.token` of mode 0600, in a folder of mode 0700. scripts/client-token.ts adds, rotates
// and revokes a client by hand. The `units` step of `neptunia setup` (src/setup/run.ts) calls `provisionClients` for the
// clients its units connect as. Nothing here prints or returns a token.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { CLIENTS_FILE } from '../interface/principals.ts';

/** One entry of `clients.json` as it is written. */
export type ClientRecord = {
  kind: string;
  iface?: string;
  tokenFile: string;
  permissions: Array<string>;
  boardRoles?: Array<string>;
};

/** A client file that cannot be used as it is, or a client that exists already: the message says which. */
export class ClientsError extends Error {}

/** Writes `text` to `file` through a temporary file of mode 0600 renamed into place. */
function writePrivate(file: string, text: string): void {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, text, { mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
}

/** The entries of `clients.json`, an empty map when there is none. */
export function readClients(privateDir: string): Record<string, ClientRecord> {
  const file = path.join(privateDir, CLIENTS_FILE);
  if (!fs.existsSync(file)) return {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    // The file's entries are the tool's own; principals.ts checks each one again where it is used.
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed))
      return parsed as Record<string, ClientRecord>;
  } catch {
    // Reported below, the same way as a file that is not an object.
  }
  throw new ClientsError(`${CLIENTS_FILE} is not a JSON object; fix it by hand first`);
}

export function writeClients(privateDir: string, clients: Readonly<Record<string, ClientRecord>>): void {
  writePrivate(path.join(privateDir, CLIENTS_FILE), `${JSON.stringify(clients, null, 2)}\n`);
}

/** Writes a fresh token to the client's file; 32 random bytes as hex. */
export function writeToken(privateDir: string, tokenFile: string): void {
  const folder = path.join(privateDir, path.dirname(tokenFile));
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  fs.chmodSync(folder, 0o700);
  writePrivate(path.join(privateDir, tokenFile), `${randomBytes(32).toString('hex')}\n`);
}

const tokenFileOf = (name: string): string => `clients/${name}.token`;

/** A new client: its token and its entry. Refuses a name that exists. Answers the file that holds the token. */
export function addClient(
  privateDir: string,
  name: string,
  client: {
    kind: string;
    iface: string | null;
    permissions: ReadonlyArray<string>;
    boardRoles: ReadonlyArray<string> | null;
  }
): string {
  const clients = readClients(privateDir);
  if (clients[name] !== undefined) throw new ClientsError(`${name} exists; rotate or revoke it`);
  const tokenFile = tokenFileOf(name);
  writeToken(privateDir, tokenFile);
  const entry: ClientRecord = {
    kind: client.kind,
    ...(client.iface ? { iface: client.iface } : {}),
    tokenFile,
    permissions: [...client.permissions],
    ...(client.boardRoles === null ? {} : { boardRoles: [...client.boardRoles] }),
  };
  writeClients(privateDir, { ...clients, [name]: entry });
  return tokenFile;
}

/**
 * The agent clients `wanted` in place, every other client kept. A client with its entry and its token is left as it is,
 * because a new token would close the link of a running unit. A missing token is written, and a missing entry added.
 * Answers the names it wrote a token for and the names that were there. A broken file throws before anything is written.
 */
export function provisionClients(
  privateDir: string,
  wanted: ReadonlyArray<{ name: string; boardRoles: ReadonlyArray<string> }>
): { made: Array<string>; there: Array<string> } {
  const clients = readClients(privateDir);
  const made: Array<string> = [];
  const there: Array<string> = [];
  for (const { name, boardRoles } of wanted) {
    const entry = clients[name];
    if (entry === undefined) {
      addClient(privateDir, name, { kind: 'agent', iface: null, permissions: [], boardRoles });
      made.push(name);
    } else if (fs.existsSync(path.join(privateDir, entry.tokenFile))) {
      there.push(name);
    } else {
      writeToken(privateDir, entry.tokenFile);
      made.push(name);
    }
  }
  return { made, there };
}
