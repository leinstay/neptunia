// The boot token of an in-process deployment (src/interface/principals.ts): random per boot and held by the core, so it
// stands for its in-process principal whatever `clients.json` holds, and `neptunia setup units` writing that file stops
// no running interface. The clients come from the real `runSetup` with a fake service manager; the folders are temp dirs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { principalOfToken } from '../src/interface/principals.ts';
import type { BootPrincipal } from '../src/interface/principals.ts';
import { runSetup } from '../src/setup/run.ts';
import { tempDir } from './fixtures/tmp.ts';

const ROOT = path.join(import.meta.dirname, '..');
const BOOT: BootPrincipal = {
  token: 'boot-token-of-this-process',
  principal: { name: 'discord', kind: 'interface', iface: null, permissions: [] },
};

/** A persona folder after `neptunia setup units`, which leaves the client `watcher` in `clients.json`. */
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

test('the boot token still stands for its principal after setup wrote clients.json', async () => {
  // Catches: `neptunia setup units` cuts off a running in-process interface at its next envelope.
  const privateDir = await afterSetupUnits();
  assert.deepEqual(principalOfToken(BOOT.token, { privateDir, boot: BOOT }), BOOT.principal);
});

test('a wrong token is no one, with or without clients.json', async () => {
  // Catches: honouring the boot token opens the door to any token once clients.json exists.
  const privateDir = await afterSetupUnits();
  assert.equal(principalOfToken('not-a-token', { privateDir, boot: BOOT }), null);
  assert.equal(principalOfToken('not-a-token', { privateDir: tempDir('nep-boot-empty-'), boot: BOOT }), null);
});

test("a client's token stands for that client and never for the boot principal", async () => {
  // Catches: a client on the socket gets the in-process interface's name and rights.
  const privateDir = await afterSetupUnits();
  const token = fs.readFileSync(path.join(privateDir, 'clients', 'watcher.token'), 'utf8').trim();
  const who = principalOfToken(token, { privateDir, boot: BOOT });
  assert.equal(who?.name, 'watcher');
  assert.equal(who?.kind, 'agent');
});

test('a boot principal with no token is no one, and an empty token never matches it', async () => {
  // Catches: an empty boot token, as a core with no in-process interface could hold, lets a blank token through.
  const privateDir = await afterSetupUnits();
  const empty: BootPrincipal = { token: '', principal: BOOT.principal };
  assert.equal(principalOfToken('', { privateDir, boot: empty }), null);
  assert.equal(principalOfToken('anything', { privateDir, boot: empty }), null);
});

test('a broken clients.json still leaves the boot token its principal, and every other token no one', async () => {
  // Catches: a bad hand edit of the file takes down the in-process interface, or lets a client's token through unread.
  const privateDir = await afterSetupUnits();
  const token = fs.readFileSync(path.join(privateDir, 'clients', 'watcher.token'), 'utf8').trim();
  fs.writeFileSync(path.join(privateDir, 'clients.json'), '{ broken');
  assert.deepEqual(principalOfToken(BOOT.token, { privateDir, boot: BOOT }), BOOT.principal);
  assert.equal(principalOfToken(token, { privateDir, boot: BOOT }), null);
});
