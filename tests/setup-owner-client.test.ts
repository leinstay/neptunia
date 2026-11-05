// Setup's client provisioning gives the owner a board client: `owner`, an agent with the board role `owner`, so `neptunia
// tasks` works from a shell with no client named. Provisioning runs in process over a fake service manager; the process
// tests are what `neptunia tasks` itself selects, and they connect to no core.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { runSetup } from '../src/setup/run.ts';
import type { SetupOptions } from '../src/setup/run.ts';
import { folders } from './fixtures/core-units.ts';
import { runChild } from './fixtures/recording-core.ts';
import { tempDir } from './fixtures/tmp.ts';

const ROOT = path.join(import.meta.dirname, '..');

function setupOptions(): SetupOptions {
  const base = tempDir('nep-owner-client-');
  return {
    system: false,
    user: 'alice',
    group: 'alice',
    home: path.join(base, 'home'),
    rootDir: ROOT,
    privateDir: path.join(base, 'data'),
    dataDir: path.join(base, 'data'),
    node: '/usr/bin/node',
    xdgConfigHome: path.join(base, 'xdg'),
  };
}

const runSetupFully = (options: SetupOptions) =>
  runSetup(options, {
    run: (_command, args) =>
      Promise.resolve(
        args.includes('is-active') ? { code: 3, stdout: '', stderr: '' } : { code: 0, stdout: '', stderr: '' }
      ),
    openChat: () => Promise.resolve(),
  });

type Entry = { kind: string; tokenFile: string; boardRoles?: Array<string> };

const clientsOf = (privateDir: string): Record<string, Entry> =>
  JSON.parse(fs.readFileSync(path.join(privateDir, 'clients.json'), 'utf8')) as Record<string, Entry>;

test('setup provisions the owner client, an agent with the owner role and a private token', async () => {
  // Catches: the owner has no way onto the board from a shell until he finds scripts/client-token.ts.
  const options = setupOptions();
  await runSetupFully(options);
  const owner = clientsOf(options.privateDir).owner;
  assert.equal(owner?.kind, 'agent');
  assert.deepEqual(owner?.boardRoles, ['owner']);
  const file = path.join(options.privateDir, 'clients', 'owner.token');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.notEqual(fs.readFileSync(file, 'utf8').trim(), '');
});

test('a second setup keeps the owner token and the entry, and the other clients stay', async () => {
  // Catches: repeating setup rotates the token under a running shell, or provisioning one client drops another.
  const options = setupOptions();
  await runSetupFully(options);
  const token = fs.readFileSync(path.join(options.privateDir, 'clients', 'owner.token'), 'utf8');
  const clients = clientsOf(options.privateDir);
  assert.equal(clients.cli?.kind, 'cli');
  await runSetupFully(options);
  assert.equal(fs.readFileSync(path.join(options.privateDir, 'clients', 'owner.token'), 'utf8'), token);
  assert.deepEqual(clientsOf(options.privateDir), clients);
});

/** The environment of a `neptunia tasks` run with no client and no token named. */
const NO_CLIENT: NodeJS.ProcessEnv = { NEPTUNIA_TASK_CLIENT: '', NEPTUNIA_TASK_TOKEN: '' };

test('neptunia tasks with no client named reads the token of the owner client', async () => {
  // Catches: every shell has to export NEPTUNIA_TASK_CLIENT=owner before the first board command.
  const dirs = folders();
  fs.mkdirSync(path.join(dirs.privateDir, 'clients'), { recursive: true });
  fs.writeFileSync(path.join(dirs.privateDir, 'clients', 'owner.token'), '');
  const run = await runChild(dirs, ['tasks', 'list'], { env: NO_CLIENT });
  assert.equal(run.code, 1);
  assert.ok(run.stderr.includes('owner.token'), run.stderr);
});

test('neptunia tasks with the owner token goes on to the core', async () => {
  // Catches: the token is found and the command still answers that no client is set.
  const dirs = folders();
  fs.mkdirSync(path.join(dirs.privateDir, 'clients'), { recursive: true });
  fs.writeFileSync(path.join(dirs.privateDir, 'clients', 'owner.token'), 'token\n');
  const run = await runChild(dirs, ['tasks', 'list'], { env: NO_CLIENT });
  assert.equal(run.code, 1);
  assert.ok(run.stderr.includes('no core listens'), run.stderr);
});

test('an unavailable task command names the missing client and how to make it', async () => {
  // Catches: "set NEPTUNIA_TASK_TOKEN or NEPTUNIA_TASK_CLIENT" as the owner's only clue, with neither one his to know.
  const dirs = folders();
  const run = await runChild(dirs, ['tasks', 'list'], { env: NO_CLIENT });
  assert.equal(run.code, 1);
  assert.ok(run.stderr.startsWith('unavailable') || run.stderr.includes('unavailable:'), run.stderr);
  assert.ok(run.stderr.includes('owner'), run.stderr);
  assert.ok(run.stderr.includes('neptunia setup'), run.stderr);
  assert.equal(run.stdout, '');
});
