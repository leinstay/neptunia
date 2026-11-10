// Tests for the clients of the core (src/interface/principals.ts): which principal a token stands for. The private
// layer's `clients.json` maps a client's name to its principal (`kind`, `iface` for an interface, `tokenFile` relative
// to the private directory, `permissions`), and each token is a file of its own. The file is read at the moment of
// use, so a changed token applies to the next lookup. The boot principal the core made for its one in-process interface
// holds whatever `clients.json` says (tests/interface-boot-principal.test.ts). Every test writes its own private directory under TMPDIR.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { loadPrincipals, principalOfToken } from '../src/interface/principals.ts';
import type { Principal, BootPrincipal } from '../src/interface/principals.ts';
import { tempDir } from './fixtures/tmp.ts';
import { runSetup } from '../src/setup/run.ts';

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

test('once clients.json exists the boot token still stands for the boot principal', () => {
  // Changed: `neptunia setup units` writes clients.json under a running in-process interface, which must keep working.
  // The token is random per boot and held by the core, so the file has nothing to say about it.
  const privateDir = layer({ discord: DISCORD }, { discord: 'd'.repeat(64) });
  assert.deepEqual(principalOfToken(BOOT_TOKEN, { privateDir, boot: { token: BOOT_TOKEN, principal: BOOT } }), BOOT);
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

test("a clients.json that is not JSON makes every client's token no one and throws nothing", () => {
  const privateDir = layer(null, { discord: 'd'.repeat(64) });
  fs.writeFileSync(path.join(privateDir, 'clients.json'), '{ not json');
  const boot = { token: BOOT_TOKEN, principal: BOOT };
  assert.equal(principalOfToken('d'.repeat(64), { privateDir, boot }), null);
  // Changed: the boot token depends on no file, so a broken one keeps the in-process interface up.
  assert.deepEqual(principalOfToken(BOOT_TOKEN, { privateDir, boot }), BOOT);
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

// The boot token of an in-process deployment (src/interface/principals.ts): random per boot and held by the core, so it
// stands for its in-process principal whatever `clients.json` holds, and `neptunia setup units` writing that file stops
// no running interface. The clients come from the real `runSetup` with a fake service manager; the folders are temp dirs.

const ROOT = path.join(import.meta.dirname, '..');
const BOOT_BOOT_PRINCIPAL: BootPrincipal = {
  token: 'boot-token-of-this-process',
  principal: { name: 'discord', kind: 'interface', iface: null, permissions: [] },
};

/** A persona folder after `neptunia setup units`, which leaves the client `owner` in `clients.json`. */
// Changed: setup makes no client `watcher` any more (owner, 2026-11-09), so the client under test is `owner`.
async function afterSetupUnits(): Promise<string> {
  const base = tempDir('nep-boot-principal-');
  const dataDir = path.join(base, 'data');
  fs.mkdirSync(path.join(dataDir, 'config'), { recursive: true });
  const report = await runSetup(
    {
      system: false,
      user: 'alice',
      group: 'alice',
      home: path.join(base, 'home'),
      rootDir: ROOT,
      privateDir: dataDir,
      dataDir,
      node: '/usr/bin/node',
      xdgConfigHome: path.join(base, 'xdg'),
      only: 'units',
    },
    { run: () => Promise.resolve({ code: 0, stdout: '', stderr: '' }), openChat: () => Promise.resolve() }
  );
  assert.equal(report.ok, true);
  assert.equal(fs.existsSync(path.join(dataDir, 'clients.json')), true);
  return dataDir;
}

test('a wrong token is no one, with or without clients.json', async () => {
  // Catches: honouring the boot token opens the door to any token once clients.json exists.
  const privateDir = await afterSetupUnits();
  assert.equal(principalOfToken('not-a-token', { privateDir, boot: BOOT_BOOT_PRINCIPAL }), null);
  assert.equal(
    principalOfToken('not-a-token', { privateDir: tempDir('nep-boot-empty-'), boot: BOOT_BOOT_PRINCIPAL }),
    null
  );
});

test("a client's token stands for that client and never for the boot principal", async () => {
  // Catches: a client on the socket gets the in-process interface's name and rights.
  const privateDir = await afterSetupUnits();
  const token = fs.readFileSync(path.join(privateDir, 'clients', 'owner.token'), 'utf8').trim();
  const who = principalOfToken(token, { privateDir, boot: BOOT_BOOT_PRINCIPAL });
  assert.equal(who?.name, 'owner');
  assert.equal(who?.kind, 'agent');
});

test('a boot principal with no token is no one, and an empty token never matches it', async () => {
  // Catches: an empty boot token, as a core with no in-process interface could hold, lets a blank token through.
  const privateDir = await afterSetupUnits();
  const empty: BootPrincipal = { token: '', principal: BOOT_BOOT_PRINCIPAL.principal };
  assert.equal(principalOfToken('', { privateDir, boot: empty }), null);
  assert.equal(principalOfToken('anything', { privateDir, boot: empty }), null);
});
