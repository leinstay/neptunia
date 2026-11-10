// PR 2, one setup flow and readiness: what setup provisions with no core socket. `runSetup` writes the CLI's identity,
// and `interfacesStep` (src/setup/interfaces.ts) registers the client, writes its private token
// and starts the selected service instance through the scope's manager. Repeating keeps a valid token, and a failure
// claims no running interface. Every manager command goes through a fake; the unit folder is a temp folder.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { localConfigPath } from '../src/config/files.ts';

import type { RunResult } from '../src/setup/install.ts';
import { interfacesStep } from '../src/setup/interfaces.ts';
import { SETUP_STEPS, SetupUsageError, parseSetupArgs, runSetup } from '../src/setup/run.ts';
import type { SetupOptions } from '../src/setup/run.ts';
import { loadPrincipals } from '../src/interface/principals.ts';
import { coreSocketPath } from '../src/interface/socket.ts';
import { tempDir } from './fixtures/tmp.ts';

const ROOT = path.join(import.meta.dirname, '..');
const OK: RunResult = { code: 0, stdout: '', stderr: '' };

function setupOptions(): SetupOptions {
  const base = tempDir('nep-provision-');
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
    run: (_command, args) => Promise.resolve(args.includes('is-active') ? { code: 3, stdout: '', stderr: '' } : OK),
    openChat: () => Promise.resolve(),
  });

test('setup provisions the CLI identity with no core socket', async () => {
  // Catches: the first chat dies on "cannot read the token" because no step ever wrote one.
  const options = setupOptions();
  const report = await runSetupFully(options);
  assert.equal(report.ok, true);
  assert.equal(fs.existsSync(coreSocketPath(options.dataDir)), false);
  const cli = (loadPrincipals(options.privateDir) ?? []).find((one) => one.name === 'cli');
  assert.equal(cli?.kind, 'cli');
  const file = path.join(options.privateDir, 'clients', 'cli.token');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.notEqual(fs.readFileSync(file, 'utf8').trim(), '');
});

test('a second setup keeps the CLI token', async () => {
  // Catches: repeating setup rotates the token under a running chat.
  const options = setupOptions();
  await runSetupFully(options);
  const file = path.join(options.privateDir, 'clients', 'cli.token');
  const token = fs.readFileSync(file, 'utf8');
  await runSetupFully(options);
  assert.equal(fs.readFileSync(file, 'utf8'), token);
});

test('every step word of neptunia setup is refused and names the single flow, while the steps stay internal', () => {
  // Catches: a step subcommand left public; `setup units` and friends bypass the readiness the flow is built on.
  assert.ok(SETUP_STEPS.includes('units'), 'the implementation keeps its steps');
  for (const step of SETUP_STEPS) {
    assert.throws(
      () => parseSetupArgs([step]),
      (error: unknown) => error instanceof SetupUsageError && error.message.includes('neptunia setup'),
      step
    );
  }
});

// src/setup/interfaces.ts

/** An engine folder with one interface package, a data folder, and a manager that answers `answer`. */
function interfaceRig(answer: (args: ReadonlyArray<string>) => RunResult | Promise<RunResult> = () => OK) {
  const base = tempDir('nep-provision-iface-');
  const rootDir = path.join(base, 'engine');
  const dataDir = path.join(base, 'data');
  fs.mkdirSync(path.join(rootDir, 'interfaces', 'chatty'), { recursive: true });
  fs.writeFileSync(
    path.join(rootDir, 'interfaces', 'chatty', 'setup.json'),
    JSON.stringify({ settings: [{ key: 'token', question: 'The token', kind: 'secret', required: true }] })
  );
  const calls: Array<string> = [];
  const run = (command: string, args: ReadonlyArray<string>) => {
    calls.push([command, ...args].join(' '));
    return Promise.resolve(answer(args));
  };
  const scripted = (answers: Array<string>) => () => Promise.resolve(answers.shift() ?? '');
  return { where: { rootDir, dataDir, system: false }, calls, run, scripted, dataDir };
}

const settings = (dataDir: string): Record<string, unknown> =>
  JSON.parse(fs.readFileSync(localConfigPath(dataDir), 'utf8')) as Record<string, unknown>;

const tokenOf = (dataDir: string): string => path.join(dataDir, 'clients', 'chatty.token');

test('a clean interface setup registers the client, writes a private token, and starts its instance', async () => {
  // Catches: an interface enabled in settings that no core will ever accept, or that no unit runs.
  const { where, calls, run, scripted, dataDir } = interfaceRig();
  const outcome = await interfacesStep(where, { ask: scripted(['yes', 'PLATFORMTOKEN']), run });
  assert.equal(outcome.state, 'done', outcome.detail);
  assert.deepEqual(outcome.running, ['chatty']);
  const client = (loadPrincipals(dataDir) ?? []).find((one) => one.name === 'chatty');
  assert.equal(client?.kind, 'interface');
  assert.equal(client?.iface, 'chatty');
  assert.equal(fs.statSync(tokenOf(dataDir)).mode & 0o777, 0o600);
  assert.deepEqual(settings(dataDir).interfaces, { chatty: { enabled: true } });
  assert.ok(calls.includes('systemctl --user enable --now neptunia-interface@chatty.service'), calls.join('; '));
});

test('a system-scope interface setup goes through the same scope as the units', async () => {
  // Catches: setup installs system units and then starts the instance on the user manager, which has no such unit.
  const { where, calls, run, scripted } = interfaceRig();
  await interfacesStep({ ...where, system: true }, { ask: scripted(['yes', 'PLATFORMTOKEN']), run });
  assert.ok(calls.includes('sudo systemctl enable --now neptunia-interface@chatty.service'), calls.join('; '));
});

test('repeating the setup keeps the valid token and leaves the client as it is', async () => {
  // Catches: a rerun rotates the token, and a running interface loses its link until someone restarts it.
  const { where, run, scripted, dataDir } = interfaceRig();
  await interfacesStep(where, { ask: scripted(['yes', 'PLATFORMTOKEN']), run });
  const token = fs.readFileSync(tokenOf(dataDir), 'utf8');
  const clients = fs.readFileSync(path.join(dataDir, 'clients.json'), 'utf8');
  await interfacesStep(where, { ask: scripted(['yes', '']), run });
  assert.equal(fs.readFileSync(tokenOf(dataDir), 'utf8'), token);
  assert.equal(fs.readFileSync(path.join(dataDir, 'clients.json'), 'utf8'), clients);
});

test('an empty token file is no valid token, and a repeat replaces it', async () => {
  // Catches: "the file exists" taken as valid, so the interface authenticates with nothing for ever.
  const { where, run, scripted, dataDir } = interfaceRig();
  await interfacesStep(where, { ask: scripted(['yes', 'PLATFORMTOKEN']), run });
  fs.writeFileSync(tokenOf(dataDir), '');
  await interfacesStep(where, { ask: scripted(['yes', '']), run });
  assert.notEqual(fs.readFileSync(tokenOf(dataDir), 'utf8').trim(), '');
});

test('a manager that refuses leaves the interface unclaimed and says why', async () => {
  // Catches: setup prints a running interface over a unit that never started.
  const { where, run, scripted } = interfaceRig(() => ({
    code: 1,
    stdout: '',
    stderr: 'Failed to connect to bus: No medium found',
  }));
  const outcome = await interfacesStep(where, { ask: scripted(['yes', 'PLATFORMTOKEN']), run });
  assert.equal(outcome.state, 'failed');
  assert.deepEqual(outcome.running, []);
  assert.ok(outcome.detail.includes('Failed to connect to bus'), outcome.detail);
});

test('a manager that cannot be started at all is the same failure, not a crash', async () => {
  // Catches: a missing systemctl throws through setup and loses the step's report.
  const { where, scripted } = interfaceRig();
  const run = () => Promise.reject(Object.assign(new Error('spawn systemctl ENOENT'), { code: 'ENOENT' }));
  const outcome = await interfacesStep(where, { ask: scripted(['yes', 'PLATFORMTOKEN']), run });
  assert.equal(outcome.state, 'failed');
  assert.deepEqual(outcome.running, []);
});

test('a setup with a required value missing starts nothing and registers nothing', async () => {
  // Catches: a client and a unit for an interface with no way to log in to its platform.
  const { where, calls, run, scripted, dataDir } = interfaceRig();
  const outcome = await interfacesStep(where, { ask: scripted(['yes', '']), run });
  assert.deepEqual(outcome.running, []);
  assert.deepEqual(calls, []);
  assert.equal(fs.existsSync(path.join(dataDir, 'clients.json')), false);
});

test('a no starts nothing', async () => {
  // Catches: a declined interface still gets a unit.
  const { where, calls, run, scripted } = interfaceRig();
  const outcome = await interfacesStep(where, { ask: scripted(['no']), run });
  assert.deepEqual(outcome.running, []);
  assert.deepEqual(calls, []);
});
