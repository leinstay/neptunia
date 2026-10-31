// Tests for the clients of the core (src/interface/principals.ts): which principal a token stands for. The private
// layer's `clients.json` maps a client's name to its principal (`kind`, `iface` for an interface, `tokenFile` relative
// to the private directory, `permissions`), and each token is a file of its own. The file is read at the moment of
// use, so a changed token applies to the next lookup. With no `clients.json`, the boot principal the core made for its
// one in-process interface is the only one. Every test writes its own private directory under TMPDIR.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadPrincipals, principalOfToken } from '../src/interface/principals.ts';
import type { Principal } from '../src/interface/principals.ts';
import { tempDir } from './fixtures/tmp.js';

const BOOT: Principal = { name: 'boot', kind: 'interface', iface: 'fake', permissions: [] };
const BOOT_TOKEN = 'b'.repeat(64);

type Entry = { kind: string; iface?: string; tokenFile: string; permissions: Array<string> };

/** A private directory whose `clients.json` holds `entries` and whose token files hold `tokens`, by client name. */
function layer(entries: Record<string, Entry> | null, tokens: Record<string, string> = {}): string {
  const dir = tempDir('nep-clients-');
  if (entries !== null) fs.writeFileSync(path.join(dir, 'clients.json'), JSON.stringify(entries));
  fs.mkdirSync(path.join(dir, 'clients'), { recursive: true, mode: 0o700 });
  for (const [name, token] of Object.entries(tokens))
    fs.writeFileSync(path.join(dir, 'clients', `${name}.token`), token, { mode: 0o600 });
  return dir;
}

const DISCORD: Entry = { kind: 'interface', iface: 'discord', tokenFile: 'clients/discord.token', permissions: [] };
const OWNER: Entry = { kind: 'cli', tokenFile: 'clients/owner.token', permissions: [] };

test('with no clients.json the boot token is the boot principal and any other token is no one', () => {
  const privateDir = layer(null);
  const boot = { token: BOOT_TOKEN, principal: BOOT };
  assert.deepEqual(principalOfToken(BOOT_TOKEN, { privateDir, boot }), BOOT);
  assert.equal(principalOfToken('c'.repeat(64), { privateDir, boot }), null);
});

test('a token from a token file is the principal of its client, a trailing newline ignored', () => {
  const privateDir = layer(
    { discord: DISCORD, owner: OWNER },
    { discord: 'd'.repeat(64), owner: `${'o'.repeat(64)}\n` }
  );
  const owner = principalOfToken('o'.repeat(64), { privateDir, boot: null });
  assert.equal(owner?.name, 'owner');
  assert.equal(owner?.kind, 'cli');
  const discord = principalOfToken('d'.repeat(64), { privateDir, boot: null });
  assert.equal(discord?.name, 'discord');
  assert.equal(discord?.kind, 'interface');
  assert.equal(discord?.iface, 'discord');
});

test('once clients.json exists the boot token is no one', () => {
  const privateDir = layer({ discord: DISCORD }, { discord: 'd'.repeat(64) });
  assert.equal(principalOfToken(BOOT_TOKEN, { privateDir, boot: { token: BOOT_TOKEN, principal: BOOT } }), null);
});

test('a token file changed after a lookup applies to the next one: the old token is no one', () => {
  const privateDir = layer({ discord: DISCORD }, { discord: 'd'.repeat(64) });
  assert.equal(principalOfToken('d'.repeat(64), { privateDir, boot: null })?.name, 'discord');
  fs.writeFileSync(path.join(privateDir, 'clients', 'discord.token'), 'e'.repeat(64), { mode: 0o600 });
  assert.equal(principalOfToken('d'.repeat(64), { privateDir, boot: null }), null);
  assert.equal(principalOfToken('e'.repeat(64), { privateDir, boot: null })?.name, 'discord');
});

test('an empty token is no one, even when a token file is empty', () => {
  const privateDir = layer({ discord: DISCORD }, { discord: '' });
  assert.equal(principalOfToken('', { privateDir, boot: null }), null);
});

test('a clients.json that is not JSON makes every token no one and throws nothing', () => {
  const privateDir = layer(null, { discord: 'd'.repeat(64) });
  fs.writeFileSync(path.join(privateDir, 'clients.json'), '{ not json');
  const boot = { token: BOOT_TOKEN, principal: BOOT };
  assert.equal(principalOfToken('d'.repeat(64), { privateDir, boot }), null);
  assert.equal(principalOfToken(BOOT_TOKEN, { privateDir, boot }), null);
});

test('loadPrincipals lists each client with its kind, iface and token file, and null with no clients.json', () => {
  assert.equal(loadPrincipals(layer(null)), null);
  const listed = loadPrincipals(layer({ discord: DISCORD, owner: OWNER }));
  const byName = new Map((listed ?? []).map((entry) => [entry.name, entry]));
  assert.deepEqual([...byName.keys()].sort(), ['discord', 'owner']);
  assert.equal(byName.get('discord')?.iface, 'discord');
  assert.equal(byName.get('discord')?.tokenFile, 'clients/discord.token');
  assert.equal(byName.get('owner')?.kind, 'cli');
});

// Stage 6c: the board's agents are clients of their own kind.
test('an agent entry of clients.json stands for a principal of kind agent with no iface', () => {
  const AGENT: Entry = { kind: 'agent', tokenFile: 'clients/hand.token', permissions: [] };
  const privateDir = layer({ hand: AGENT }, { hand: 'h'.repeat(64) });
  const hand = principalOfToken('h'.repeat(64), { privateDir, boot: null });
  assert.equal(hand?.name, 'hand');
  assert.equal(hand?.kind, 'agent');
  assert.equal(hand?.iface, null);
});
