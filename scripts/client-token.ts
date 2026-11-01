#!/usr/bin/env node
// The clients of the core and their tokens, in the private layer (`NEPTUNIA_PRIVATE_DIR`, else the checkout). Each
// client is an entry of `clients.json` (src/interface/principals.ts) and a token file `clients/<name>.token` of mode
// 0600, in a folder of mode 0700. The core reads both at every envelope, so a change applies to the next one and a
// rotated or revoked token closes that client's live link.
//
//   node scripts/client-token.ts add <name> --kind interface|cli|plugin|agent [--iface <iface>] [--permission <p> ...]
//        [--roles <role>,<role>]
//        Writes a new token and the client's entry. An interface needs `--iface`, the namespace its events carry.
//        `--roles` takes the client's task board roles (src/board/machine.ts `BOARD_ROLES`) as a comma list and writes
//        them as the entry's `boardRoles`, for any kind; an agent (a development agent of the board) needs them to be
//        let in by the board. A role outside the list writes nothing.
//   node scripts/client-token.ts rotate <name>
//        Writes a new token over the client's old one.
//   node scripts/client-token.ts revoke <name>
//        Removes the client's entry and its token file.
//
// The tool never prints a token: it says which file holds it. The unit user of the client is the one that must read
// the file (`chown` it after `add` and `rotate`).

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { BOARD_ROLES } from '../src/board/machine.ts';
import { CLIENTS_FILE, PRINCIPAL_KINDS } from '../src/interface/principals.ts';
import { CliError, parseFlags, privateDirOf, runCli } from './lib/cli.ts';

const USAGE = [
  'usage: node scripts/client-token.ts add <name> --kind interface|cli|plugin|agent [--iface <iface>]',
  '         [--permission <p> ...] [--roles <role>,<role>]',
  '       node scripts/client-token.ts rotate <name>',
  '       node scripts/client-token.ts revoke <name>',
].join('\n');

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** One entry of `clients.json` as the tool writes it. */
type Entry = {
  kind: string;
  iface?: string;
  tokenFile: string;
  permissions: Array<string>;
  boardRoles?: Array<string>;
};

/** The flags the tool takes. */
type Flags = {
  _: Array<string>;
  '--kind'?: string;
  '--iface'?: string;
  '--roles'?: string;
  '--permission'?: Array<string>;
};

/** Writes `text` to `file` through a temporary file of mode 0600 renamed into place. */
function writePrivate(file: string, text: string) {
  const temporary = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(temporary, text, { mode: 0o600 });
  fs.chmodSync(temporary, 0o600);
  fs.renameSync(temporary, file);
}

/** The entries of `clients.json`, an empty map when there is none. */
function readClients(privateDir: string): Record<string, Entry> {
  const file = path.join(privateDir, CLIENTS_FILE);
  if (!fs.existsSync(file)) return {};
  try {
    const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
    if (parsed !== null && typeof parsed === 'object' && !Array.isArray(parsed)) return parsed as Record<string, Entry>;
  } catch {
    // Reported below, the same way as a file that is not an object.
  }
  throw new CliError(`client-token: ${CLIENTS_FILE} is not a JSON object; fix it by hand first`);
}

const writeClients = (privateDir: string, clients: Record<string, Entry>) =>
  writePrivate(path.join(privateDir, CLIENTS_FILE), `${JSON.stringify(clients, null, 2)}\n`);

/** Writes a fresh token to the client's file; 32 random bytes as hex. */
function writeToken(privateDir: string, tokenFile: string) {
  const folder = path.join(privateDir, path.dirname(tokenFile));
  fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
  fs.chmodSync(folder, 0o700);
  writePrivate(path.join(privateDir, tokenFile), `${randomBytes(32).toString('hex')}\n`);
}

/** The board roles of `--roles`, null when the flag is absent. Throws a CliError naming a role outside BOARD_ROLES. */
function rolesOf(given?: string): Array<string> | null {
  if (given === undefined) return null;
  const roles = given
    .split(',')
    .map((role) => role.trim())
    .filter((role) => role !== '');
  const unknown = roles.filter((role) => !(BOARD_ROLES as ReadonlyArray<string>).includes(role));
  if (unknown.length > 0)
    throw new CliError(
      `client-token: unknown board role ${unknown.join(', ')}; the roles are ${BOARD_ROLES.join(', ')}`
    );
  return [...new Set(roles)];
}

function add(privateDir: string, name: string, flags: Flags) {
  const kind = flags['--kind'] ?? '';
  if (!(PRINCIPAL_KINDS as ReadonlyArray<string>).includes(kind))
    throw new CliError(`client-token: --kind is one of ${PRINCIPAL_KINDS.join(', ')}`);
  const iface = flags['--iface'] ?? null;
  if (kind === 'interface' && !iface)
    throw new CliError('client-token: an interface needs --iface, the namespace of its events');
  const roles = rolesOf(flags['--roles']);
  const clients = readClients(privateDir);
  if (clients[name] !== undefined) throw new CliError(`client-token: ${name} exists; rotate or revoke it`);
  const tokenFile = `clients/${name}.token`;
  writeToken(privateDir, tokenFile);
  const entry = {
    kind,
    ...(iface ? { iface } : {}),
    tokenFile,
    permissions: flags['--permission'] ?? [],
    ...(roles === null ? {} : { boardRoles: roles }),
  };
  writeClients(privateDir, { ...clients, [name]: entry });
  return `added ${name} (${kind}${iface ? `, iface ${iface}` : ''}): its token is in ${tokenFile}\n`;
}

function rotate(privateDir: string, name: string) {
  const entry = readClients(privateDir)[name];
  if (entry === undefined) throw new CliError(`client-token: no client ${name}`);
  writeToken(privateDir, entry.tokenFile);
  return `rotated ${name}: its new token is in ${entry.tokenFile}\n`;
}

function revoke(privateDir: string, name: string) {
  const clients = readClients(privateDir);
  const entry = clients[name];
  if (entry === undefined) throw new CliError(`client-token: no client ${name}`);
  const rest = Object.fromEntries(Object.entries(clients).filter(([key]) => key !== name));
  writeClients(privateDir, rest);
  fs.rmSync(path.join(privateDir, entry.tokenFile), { force: true });
  return `revoked ${name}: its entry and ${entry.tokenFile} are gone\n`;
}

function run(argv: Array<string>): string {
  const flags = parseFlags(argv, {
    values: ['--kind', '--iface', '--roles'],
    lists: ['--permission'],
    usage: USAGE,
  }) as Flags;
  const [command, name, ...extra] = flags._;
  if (typeof name !== 'string' || !NAME.test(name) || extra.length > 0) throw new CliError(USAGE);
  const privateDir = privateDirOf(ROOT);
  if (!fs.existsSync(privateDir))
    throw new CliError(`client-token: the private directory ${privateDir} does not exist`);
  switch (command) {
    case 'add':
      return add(privateDir, name, flags);
    case 'rotate':
      return rotate(privateDir, name);
    case 'revoke':
      return revoke(privateDir, name);
    default:
      throw new CliError(USAGE);
  }
}

export function main(argv: Array<string>): Promise<string> {
  return Promise.resolve().then(() => run(argv));
}

runCli(import.meta.url, main);
