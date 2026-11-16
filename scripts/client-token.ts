#!/usr/bin/env node
// The clients of the core and their tokens, in the data folder (`NEPTUNIA_DATA_DIR`, else `data/` of the checkout). Each
// client is an entry of `clients.json` (src/interface/principals.ts) and a token file `clients/<name>.token` of mode
// 0600, in a folder of mode 0700. The core reads both at every envelope, so a change applies to the next one and a
// rotated or revoked token closes that client's live link.
//
//   node scripts/client-token.ts add <name> --kind interface|cli [--iface <iface>] [--permission <p> ...]
//        Writes a new token and the client's entry. An interface needs `--iface`, the namespace its events carry.
//   node scripts/client-token.ts rotate <name>
//        Writes a new token over the client's old one.
//   node scripts/client-token.ts revoke <name>
//        Removes the client's entry and its token file.
//
// The tool never prints a token: it says which file holds it. The unit user of the client is the one that must read
// the file (`chown` it after `add` and `rotate`).

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { PRINCIPAL_KINDS } from '../src/interface/principals.ts';
import { ClientsError, addClient, readClients, writeClients, writeToken } from '../src/setup/clients.ts';
import { CliError, parseFlags, privateDirOf, runCli } from './lib/cli.ts';

const USAGE = [
  'usage: node scripts/client-token.ts add <name> --kind interface|cli [--iface <iface>] [--permission <p> ...]',
  '       node scripts/client-token.ts rotate <name>',
  '       node scripts/client-token.ts revoke <name>',
].join('\n');

const NAME = /^[a-z0-9][a-z0-9-]{0,62}$/;
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

/** The flags the tool takes. */
type Flags = {
  _: Array<string>;
  '--kind'?: string;
  '--iface'?: string;
  '--permission'?: Array<string>;
};

function add(privateDir: string, name: string, flags: Flags) {
  const kind = flags['--kind'] ?? '';
  if (!(PRINCIPAL_KINDS as ReadonlyArray<string>).includes(kind))
    throw new CliError(`client-token: --kind is one of ${PRINCIPAL_KINDS.join(', ')}`);
  const iface = flags['--iface'] ?? null;
  if (kind === 'interface' && !iface)
    throw new CliError('client-token: an interface needs --iface, the namespace of its events');
  const tokenFile = addClient(privateDir, name, {
    kind,
    iface,
    permissions: flags['--permission'] ?? [],
  });
  return (
    `added ${name} (${kind}${iface ? `, iface ${iface}` : ''}): its token is in ${tokenFile}\n` +
    'the server unit still sees it until `neptunia setup` renders it again\n'
  );
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
    values: ['--kind', '--iface'],
    lists: ['--permission'],
    usage: USAGE,
  }) as Flags;
  const [command, name, ...extra] = flags._;
  if (typeof name !== 'string' || !NAME.test(name) || extra.length > 0) throw new CliError(USAGE);
  const privateDir = privateDirOf(ROOT);
  if (!fs.existsSync(privateDir))
    throw new CliError(`client-token: the private directory ${privateDir} does not exist`);
  try {
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
  } catch (error) {
    if (error instanceof ClientsError) throw new CliError(`client-token: ${error.message}`);
    throw error;
  }
}

export function main(argv: Array<string>): Promise<string> {
  return Promise.resolve().then(() => run(argv));
}

runCli(import.meta.url, main);
