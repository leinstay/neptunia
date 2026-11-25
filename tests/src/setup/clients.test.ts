// Tests for src/setup/clients.ts: `addClient` writes a client's token file (`clients/<name>.token` under the private
// directory, mode 0600) and its entry in `clients.json`, and `provisionClients`, the clients step of `neptunia setup`,
// writes a token where the owner's command line has none and keeps one it has. The token is resolved through
// src/interface/principals.ts, as the core resolves it.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { principalOfToken } from '../../../src/interface/principals.ts';
import { CLI_CLIENT, addClient, provisionClients } from '../../../src/setup/clients.ts';
import { tempDir } from '../../fixtures/tmp.ts';

const tokenFile = (privateDir: string, name: string): string => path.join(privateDir, 'clients', `${name}.token`);
const tokenOf = (privateDir: string, name: string): string =>
  fs.readFileSync(tokenFile(privateDir, name), 'utf8').trim();
const whoIs = (privateDir: string, token: string) => principalOfToken(token, { privateDir, boot: null });

test('addClient writes a 0600 token file whose token is the new principal', () => {
  const privateDir = tempDir('nep-token-');
  assert.equal(
    addClient(privateDir, 'discord', { kind: 'interface', iface: 'discord', permissions: [] }),
    'clients/discord.token'
  );
  const token = tokenOf(privateDir, 'discord');
  assert.equal(fs.statSync(tokenFile(privateDir, 'discord')).mode & 0o777, 0o600);
  assert.equal(whoIs(privateDir, token)?.name, 'discord');
  assert.equal(whoIs(privateDir, token)?.iface, 'discord');
  assert.ok(token.length >= 32, 'the token is long enough to guess at');
});

test('setup writes a new token over an empty token file of the command line and keeps a valid one', () => {
  // Bug: an emptied cli.token counts as there, so setup reports the client done while the chat refuses to start.
  const privateDir = tempDir('nep-token-');
  provisionClients(privateDir, [CLI_CLIENT]);
  const valid = tokenOf(privateDir, 'cli');
  assert.deepEqual(provisionClients(privateDir, [CLI_CLIENT]), { made: [], there: ['cli'] });
  assert.equal(tokenOf(privateDir, 'cli'), valid);
  fs.writeFileSync(tokenFile(privateDir, 'cli'), '\n');
  assert.deepEqual(provisionClients(privateDir, [CLI_CLIENT]), { made: ['cli'], there: [] });
  assert.equal(whoIs(privateDir, tokenOf(privateDir, 'cli'))?.name, 'cli');
});
