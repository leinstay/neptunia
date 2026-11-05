// What `neptunia setup` gives the development worker: a unit whose code comes from the install and whose working
// repository is `selfimprovement.checkout`, and the clients `development` and `watcher` with their tokens. Through
// `runSetup` with the units step and a fake service manager; the private folder is a temp dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { runSetup } from '../src/setup/run.ts';
import type { SetupDeps, SetupOptions } from '../src/setup/run.ts';
import { tempDir } from './fixtures/tmp.ts';

const ROOT = path.join(import.meta.dirname, '..');
const UNIT = 'neptunia-development.service';

/** One setup rig with a dev checkout named in the settings; the service manager answers every call with success. */
function rig() {
  const base = tempDir('nep-unit-layout-');
  const dataDir = path.join(base, 'data');
  const checkout = path.join(base, 'dev-checkout');
  const xdg = path.join(base, 'xdg');
  fs.mkdirSync(path.join(dataDir, 'config'), { recursive: true });
  fs.writeFileSync(
    path.join(dataDir, 'config', 'config.json'),
    JSON.stringify({ selfimprovement: { checkout, repository: 'example/engine' } })
  );
  const options: SetupOptions = {
    system: false,
    user: 'alice',
    group: 'alice',
    home: path.join(base, 'home'),
    rootDir: ROOT,
    privateDir: dataDir,
    dataDir,
    node: '/usr/bin/node',
    xdgConfigHome: xdg,
    only: 'units',
  };
  const deps: SetupDeps = {
    run: () => Promise.resolve({ code: 0, stdout: '', stderr: '' }),
    openChat: () => Promise.resolve(),
  };
  const rendered = (): string => fs.readFileSync(path.join(xdg, 'systemd', 'user', UNIT), 'utf8');
  return { options, deps, dataDir, checkout, rendered };
}

const valuesOf = (text: string, key: string): Array<string> =>
  text
    .split('\n')
    .filter((line) => line.startsWith(`${key}=`))
    .map((line) => line.slice(key.length + 1));

/** The write paths of a unit, without the `-` that lets a folder be missing. */
const writePathsOf = (text: string): Array<string> =>
  valuesOf(text, 'ReadWritePaths')
    .flatMap((line) => line.split(/\s+/))
    .map((one) => one.replace(/^-/, ''));

type Client = { kind: string; tokenFile: string; boardRoles?: Array<string>; permissions: Array<string> };
const clientsOf = (dataDir: string): Record<string, Client> =>
  JSON.parse(fs.readFileSync(path.join(dataDir, 'clients.json'), 'utf8')) as Record<string, Client>;
const tokenOf = (dataDir: string, name: string): string =>
  fs.readFileSync(path.join(dataDir, 'clients', `${name}.token`), 'utf8');

// ---------- the unit ----------

test('the worker runs from the install: its code is never the checkout it works on', async () => {
  // Catches: a dev run edits the checkout the worker's own code runs from, and the next restart runs that edit.
  const { options, deps, rendered } = rig();
  await runSetup(options, deps);
  assert.deepEqual(valuesOf(rendered(), 'WorkingDirectory'), [ROOT]);
  assert.match(valuesOf(rendered(), 'ExecStart')[0] ?? '', /^\S+ bin\/neptunia\.ts worker development$/);
});

test("the unit's write paths hold the whole checkout and the persona's skills", async () => {
  // Catches: a worktree write refused by ProtectSystem, or a package that cannot reach <data>/skills.
  const { options, deps, dataDir, checkout, rendered } = rig();
  await runSetup(options, deps);
  const paths = writePathsOf(rendered());
  assert.equal(paths.includes(checkout), true, paths.join(' '));
  assert.equal(paths.includes(path.join(dataDir, 'skills')), true, paths.join(' '));
});

test('the unit cannot write the install, the persona folder whole, or a development folder in it', async () => {
  // Catches: an agent with no sandbox of its own able to rewrite the running code or her memory.
  const { options, deps, dataDir, rendered } = rig();
  await runSetup(options, deps);
  const paths = writePathsOf(rendered());
  for (const banned of [ROOT, path.join(ROOT, '.git'), dataDir, path.join(dataDir, 'development')]) {
    assert.equal(paths.includes(banned), false, `${banned} in ${paths.join(' ')}`);
  }
});

// ---------- the clients ----------

test('setup provisions the clients development and watcher with their roles and private tokens', async () => {
  // Catches: the worker and the watcher are installed with no way to reach the board.
  const { options, deps, dataDir } = rig();
  const report = await runSetup(options, deps);
  const clients = clientsOf(dataDir);
  assert.deepEqual(
    [clients.development?.kind, clients.development?.boardRoles, clients.development?.tokenFile],
    ['agent', ['reviewer', 'worker'], 'clients/development.token']
  );
  assert.deepEqual(
    [clients.watcher?.kind, clients.watcher?.boardRoles, clients.watcher?.tokenFile],
    ['agent', ['watcher'], 'clients/watcher.token']
  );
  assert.equal(fs.statSync(path.join(dataDir, 'clients')).mode & 0o777, 0o700);
  for (const name of ['development', 'watcher']) {
    assert.match(tokenOf(dataDir, name), /^[0-9a-f]{64}\n$/);
    assert.equal(fs.statSync(path.join(dataDir, 'clients', `${name}.token`)).mode & 0o777, 0o600);
  }
  const detail = report.steps.find((step) => step.step === 'units')?.detail ?? '';
  assert.match(detail, /development/);
  assert.match(detail, /watcher/);
  assert.equal(detail.includes(tokenOf(dataDir, 'development').trim()), false, 'a report never holds a token');
});

test('a second setup changes no token and no entry, and says the clients are there', async () => {
  // Catches: a rerun of setup rotates the token under a running worker, which closes its link.
  const { options, deps, dataDir } = rig();
  await runSetup(options, deps);
  const [development, watcher] = [tokenOf(dataDir, 'development'), tokenOf(dataDir, 'watcher')];
  const entries = clientsOf(dataDir);
  const again = await runSetup(options, deps);
  assert.equal(tokenOf(dataDir, 'development'), development);
  assert.equal(tokenOf(dataDir, 'watcher'), watcher);
  assert.deepEqual(clientsOf(dataDir), entries);
  assert.equal(again.steps.find((step) => step.step === 'units')?.state, 'already');
});

test('setup keeps the clients it did not make', async () => {
  // Catches: the provisioning writes clients.json whole and locks out the owner's other clients.
  const { options, deps, dataDir } = rig();
  const mine = { kind: 'cli', tokenFile: 'clients/lead.token', permissions: [], boardRoles: ['owner'] };
  fs.writeFileSync(path.join(dataDir, 'clients.json'), JSON.stringify({ lead: mine }));
  await runSetup(options, deps);
  assert.deepEqual(clientsOf(dataDir).lead, mine);
});

test('an entry whose token file went missing gets a token again, and setup says so', async () => {
  // Catches: the entry reads as provisioned, and the worker dies at each start on a file nobody made.
  const { options, deps, dataDir } = rig();
  await runSetup(options, deps);
  fs.rmSync(path.join(dataDir, 'clients', 'development.token'));
  const report = await runSetup(options, deps);
  assert.match(tokenOf(dataDir, 'development'), /^[0-9a-f]{64}\n$/);
  const step = report.steps.find((one) => one.step === 'units');
  assert.equal(step?.state, 'done');
  assert.match(step?.detail ?? '', /development/);
});

const BROKEN: ReadonlyArray<[string, (dataDir: string) => void]> = [
  ['a clients.json that is no JSON', (dataDir) => fs.writeFileSync(path.join(dataDir, 'clients.json'), '{ broken')],
  ['a clients path that is a file', (dataDir) => fs.writeFileSync(path.join(dataDir, 'clients'), 'not a folder')],
];
for (const [label, breakIt] of BROKEN) {
  test(`setup reports ${label} as a failed step and writes no token`, async () => {
    // Catches: a throw out of the provisioning, or a setup that says done with no client behind it.
    const { options, deps, dataDir } = rig();
    breakIt(dataDir);
    const report = await runSetup(options, deps);
    assert.equal(report.ok, false);
    const step = report.steps.find((one) => one.step === 'units');
    assert.equal(step?.state, 'failed');
    assert.match(step?.detail ?? '', /clients/);
    assert.equal(fs.existsSync(path.join(dataDir, 'clients', 'development.token')), false);
  });
}

test('the worker with no token says which file is missing and to run setup, and exits 1', () => {
  // Catches: a unit in a restart loop with nothing in its journal that tells the owner what to do.
  const dir = tempDir('nep-unit-layout-worker-');
  const done = spawnSync(process.execPath, [path.join(ROOT, 'bin', 'neptunia.ts'), 'worker', 'development'], {
    cwd: ROOT,
    encoding: 'utf8',
    timeout: 8000,
    env: { PATH: process.env.PATH, TMPDIR: dir, NEPTUNIA_PRIVATE_DIR: dir, NEPTUNIA_DATA_DIR: dir },
  });
  assert.equal(done.status, 1, done.stdout + done.stderr);
  assert.match(done.stderr, /clients\/development\.token/);
  assert.match(done.stderr, /neptunia setup/);
});
