// src/setup/interfaces.ts: the interfaces step of `neptunia setup`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { interfacesStep } from '../../../src/setup/interfaces.ts';
import { interfaceCredential, localConfigPath } from '../../../src/config/files.ts';
import { tempDir } from '../../fixtures/tmp.ts';
import type { RunResult } from '../../../src/setup/install.ts';
import { loadPrincipals } from '../../../src/interface/principals.ts';

function rig() {
  const base = tempDir('nep-setup-interfaces-');
  const rootDir = path.join(base, 'engine');
  const dataDir = path.join(base, 'data');
  fs.mkdirSync(path.join(rootDir, 'interfaces', 'chatty'), { recursive: true });
  fs.writeFileSync(
    path.join(rootDir, 'interfaces', 'chatty', 'setup.json'),
    JSON.stringify({ settings: [{ key: 'token', question: 'The token', kind: 'secret', required: true }] })
  );
  // The step starts the instance it sets up, so it needs the scope.
  return { rootDir, dataDir, system: false };
}

/** The service manager, which starts anything it is asked to. */
const run = () => Promise.resolve({ code: 0, stdout: '', stderr: '' });

function scripted(answers: Array<string>) {
  const asked: Array<{ question: string; secret: boolean }> = [];
  const ask = (question: string, _offered: string | null, options?: { secret: boolean }) => {
    asked.push({ question, secret: options?.secret === true });
    return Promise.resolve(answers.shift() ?? '');
  };
  return { ask, asked };
}

test('a yes asks the questions the package declares, the token without echo, and enables the interface', async () => {
  // Bug: the core setup hard-codes one platform's questions, or echoes the token, or leaves the interface off.
  const where = rig();
  const { ask, asked } = scripted(['yes', 'SECRETTOKEN']);
  const outcome = await interfacesStep(where, { ask, run });
  assert.equal(outcome.state, 'done');
  assert.deepEqual(asked[1], { question: 'The token', secret: true });
  assert.equal(interfaceCredential(where.dataDir, 'chatty'), 'SECRETTOKEN');
  const config = fs.readFileSync(localConfigPath(where.dataDir), 'utf8');
  // The config holds only the enabled flag.
  assert.deepEqual(JSON.parse(config), { interfaces: { chatty: { enabled: true } } });
});

test('a no writes nothing, and a yes without the required value leaves the interface off', async () => {
  // Bug: declining leaves an empty folder, or an interface with no token is enabled and fails at every start.
  const where = rig();
  assert.equal((await interfacesStep(where, { ask: scripted(['no']).ask, run })).state, 'already');
  assert.equal(fs.existsSync(path.join(where.dataDir, 'interfaces')), false);
  await interfacesStep(where, { ask: scripted(['yes', '']).ask, run });
  assert.equal(fs.existsSync(localConfigPath(where.dataDir)), false);
});

test('a finished interface names no pairing step', async () => {
  // The owner's accounts are bound with `/memory bind`, and setup names no pairing step. Catches: setup sending the owner
  // to a pairing command at the end of setup.
  const where = rig();
  const outcome = await interfacesStep(where, { ask: scripted(['yes', 'SECRETTOKEN']).ask, run });
  assert.match(outcome.detail, /chatty/);
  assert.doesNotMatch(outcome.detail, /pair/);
});

// The client, the token and the instance of an interface the step sets up, through the scope's manager. Repeating keeps
// a valid token, and a failure claims no running interface.

const OK: RunResult = { code: 0, stdout: '', stderr: '' };

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
