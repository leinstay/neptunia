// PR 1, sources without an enable step: a subharness's availability is `installed and authenticated`
// (src/subharness/sources.ts), and its account commands change that and nothing else (src/subharness/account.ts). The
// vendor CLIs and npm are disposable fakes (tests/fixtures/fake-vendor.ts); a test reads the argv and the home they saw at
// the spawn boundary. A child process appears only where the claim is about two processes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createInstalledBackend, runChildProcess } from '../src/agent-runner/backend.ts';
import { accountCommand } from '../src/subharness/account.ts';
import type { AccountDeps } from '../src/subharness/account.ts';
import { updateSubharness } from '../src/subharness/install.ts';
import { runMemoryWriter } from '../src/subharness/memory-writer.ts';
import { subharnessPlace } from '../src/subharness/place.ts';
import { availableSources, sourceState } from '../src/subharness/sources.ts';
import { fakeVendor, treeOf } from './fixtures/fake-vendor.ts';
import type { FakeVendor, FakeVendorOptions } from './fixtures/fake-vendor.ts';
import { readKeysFile, writeKeysFile } from './fixtures/keys-file.ts';
import { tempDir } from './fixtures/tmp.ts';

const HOST_ENV = { PATH: '/usr/bin:/bin' };

type Rig = { privateDir: string; vendor: FakeVendor; deps: AccountDeps; asked: Array<string> };

/**
 * A private layer with a fake of `backend`. `answers` are what the owner says, in order; null means nobody can answer,
 * the case of a process with no terminal.
 */
function rig(backend: 'codex' | 'claude', options: FakeVendorOptions = {}, answers: Array<string> | null = []): Rig {
  const privateDir = tempDir('nep-account-');
  writeKeysFile(privateDir, {
    subharness: {
      key: null,
      modes: { dev: 'full' },
      models: { dev: 'sonnet' },
      uses: { dev: 'claude', scout: 'codex' },
      memory: { backend: 'claude', model: 'claude-opus-4-6', effort: null },
    },
  });
  const vendor = fakeVendor(privateDir, backend, options);
  const asked: Array<string> = [];
  const deps: AccountDeps = {
    privateDir,
    hostEnv: HOST_ENV,
    install: vendor.install,
    loginStdio: 'ignore',
    ask:
      answers === null
        ? null
        : (question) => {
            asked.push(question);
            return Promise.resolve(answers.shift() ?? '');
          },
  };
  return { privateDir, vendor, deps, asked };
}

// Availability

test('a source is available when it is installed and its own status command says it is logged in', async () => {
  // Catches: availability read from a stored flag, or from the installing user's home instead of the backend's own.
  const { privateDir, vendor } = rig('claude', { loggedIn: true });
  assert.deepEqual(await sourceState(privateDir, 'claude'), {
    backend: 'claude',
    installed: true,
    authenticated: true,
    available: true,
    code: 'ok',
  });
  assert.deepEqual(vendor.calls(), ['auth status']);
  assert.deepEqual(vendor.homes(), [vendor.home]);
});

test('codex is asked with login status under its own home', async () => {
  // Catches: one status argv for both vendors; `codex auth status` would be a model prompt or an error.
  const { privateDir, vendor } = rig('codex', { loggedIn: true });
  assert.equal((await sourceState(privateDir, 'codex')).available, true);
  assert.deepEqual(vendor.calls(), ['login status']);
  assert.deepEqual(vendor.homes(), [vendor.home]);
});

test('an installed source with no login and a source with no binary are told apart, and neither is available', async () => {
  // Catches: one "unavailable" answer, so the owner is told to log in to a backend that is not there.
  const out = rig('claude');
  const state = await sourceState(out.privateDir, 'claude');
  assert.equal(state.code, 'not-logged-in');
  assert.equal(state.installed, true);
  assert.equal(state.available, false);
  const absent = await sourceState(out.privateDir, 'codex');
  assert.equal(absent.code, 'not-installed');
  assert.equal(absent.authenticated, false);
  assert.equal(absent.available, false);
});

test('opencode is authenticated by an extra key the store still holds, with no process', async () => {
  // Catches: a key name that left the store still counts as a login, and every run then fails with no key.
  const privateDir = tempDir('nep-account-');
  const { binary } = subharnessPlace(privateDir, 'opencode');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, '#!/bin/sh\nexit 9\n', { mode: 0o755 });
  writeKeysFile(privateDir, { extra: { 'oc-1': 'value' }, subharness: { key: 'oc-1', modes: {} } });
  assert.equal((await sourceState(privateDir, 'opencode')).available, true);
  writeKeysFile(privateDir, { extra: {}, subharness: { key: 'oc-1', modes: {} } });
  assert.equal((await sourceState(privateDir, 'opencode')).code, 'not-logged-in');
});

test('the available sources ignore the old list in both directions', async () => {
  // Catches: the old list still gates a login it omits, or still lends availability to a name with no login.
  const { privateDir } = rig('claude', { loggedIn: true });
  writeKeysFile(privateDir, { subharness: { backends: ['codex'], key: null, modes: {} } });
  assert.deepEqual(await availableSources(privateDir), ['claude']);
});

// login

test('login runs the login the installed help names, under her home, and changes nothing in keys.json', async () => {
  // Catches: a login that moves a role, opens a model wizard, or logs in the installing user's own account.
  const { privateDir, vendor, deps, asked } = rig('claude');
  const before = fs.readFileSync(path.join(privateDir, 'keys.json'), 'utf8');
  const answer = await accountCommand(deps, 'claude', 'login');
  assert.equal(answer.status, 'ok');
  assert.ok(vendor.calls().includes('auth login'));
  assert.equal(vendor.loggedIn(), true);
  assert.deepEqual(asked, []);
  assert.equal(fs.readFileSync(path.join(privateDir, 'keys.json'), 'utf8'), before);
});

test('codex logs in with its device flow', async () => {
  // Catches: a browser login on a server with no browser.
  const { vendor, deps } = rig('codex');
  assert.equal((await accountCommand(deps, 'codex', 'login')).status, 'ok');
  assert.ok(vendor.calls().includes('login --device-auth'));
});

test('a backend that is absent is offered, installed on a yes, and the same login continues', async () => {
  // Catches: the install ends the command and the owner has to know a second one.
  const { vendor, deps, asked } = rig('claude', { installed: false }, ['yes']);
  const answer = await accountCommand(deps, 'claude', 'login');
  assert.equal(answer.status, 'ok');
  assert.equal(asked.length, 1);
  assert.equal(vendor.installs.length, 1);
  assert.equal(vendor.loggedIn(), true);
});

test('declining the install changes nothing', async () => {
  // Catches: a folder or a home left behind reads as a half-installed backend on the next look.
  const { privateDir, vendor, deps } = rig('claude', { installed: false }, ['no']);
  const before = treeOf(privateDir);
  const answer = await accountCommand(deps, 'claude', 'login');
  assert.equal(answer.code, 'install-declined');
  assert.equal(answer.status, 'failed');
  assert.deepEqual(vendor.installs, []);
  assert.deepEqual(treeOf(privateDir), before);
});

test('with no terminal a missing install is an explicit requirement, with no install and no wait', async () => {
  // Catches: a script hangs on a question nobody can answer, or a backend is installed behind its back.
  const { privateDir, vendor, deps } = rig('codex', { installed: false }, null);
  const before = treeOf(privateDir);
  const answer = await accountCommand(deps, 'codex', 'login');
  assert.equal(answer.code, 'install-required');
  assert.ok(answer.text.includes('neptunia subharness codex login'), answer.text);
  assert.deepEqual(vendor.installs, []);
  assert.deepEqual(treeOf(privateDir), before);
});

test('with no terminal an installed backend is not logged in behind the owner', async () => {
  // Catches: an interactive vendor login started on pipes waits forever.
  const { vendor, deps } = rig('codex', {}, null);
  const answer = await accountCommand(deps, 'codex', 'login');
  assert.equal(answer.code, 'terminal-required');
  assert.deepEqual(vendor.calls(), []);
});

test('a failed install stops the login and says so', async () => {
  // Catches: the flow goes on to start a binary that is not there, or reports the login.
  const { vendor, deps } = rig('claude', { installed: false, installExit: 1 }, ['yes']);
  const answer = await accountCommand(deps, 'claude', 'login');
  assert.equal(answer.code, 'install-failed');
  assert.equal(answer.status, 'failed');
  assert.deepEqual(vendor.calls(), []);
});

for (const [login, code] of [
  ['fail', 'login-failed'],
  ['cancel', 'login-cancelled'],
  ['no-effect', 'login-failed'],
] as const) {
  test(`a vendor login that ends as ${login} answers ${code}, never success`, async () => {
    // Catches: an exit 0 with no credentials, or an interrupted login, reported as logged in.
    const { vendor, deps } = rig('claude', { login });
    const answer = await accountCommand(deps, 'claude', 'login');
    assert.equal(answer.status, 'failed');
    assert.equal(answer.code, code);
    assert.equal(vendor.loggedIn(), false);
  });
}

test('opencode logs in by naming an extra key, which is checked for in the store and leaves the roles alone', async () => {
  // Catches: `--key` written unchecked, so opencode reads as available on a key that does not exist.
  const privateDir = tempDir('nep-account-');
  const { binary } = subharnessPlace(privateDir, 'opencode');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, '#!/bin/sh\nexit 9\n', { mode: 0o755 });
  writeKeysFile(privateDir, {
    extra: { 'oc-1': 'value' },
    subharness: { key: null, modes: {}, uses: { dev: 'claude' } },
  });
  const deps: AccountDeps = {
    privateDir,
    hostEnv: HOST_ENV,
    install: () => Promise.reject(new Error('no install')),
    ask: null,
  };
  assert.equal((await accountCommand(deps, 'opencode', 'login', { key: 'missing' })).code, 'key-unknown');
  assert.equal((await accountCommand(deps, 'opencode', 'login', { key: 'oc-1' })).status, 'ok');
  const stored = readKeysFile(privateDir).subharness;
  assert.equal(stored.key, 'oc-1');
  assert.deepEqual(stored.uses, { dev: 'claude' });
});

// status and logout

for (const action of ['status', 'logout'] as const) {
  test(`${action} never installs a backend that is absent`, async () => {
    // Catches: a read or a removal that downloads a CLI.
    const { privateDir, vendor, deps, asked } = rig('codex', { installed: false }, ['yes']);
    const before = treeOf(privateDir);
    const answer = await accountCommand(deps, 'codex', action);
    assert.equal(answer.code, 'not-installed');
    assert.deepEqual(vendor.installs, []);
    assert.deepEqual(asked, []);
    assert.deepEqual(treeOf(privateDir), before);
  });
}

test('status answers the login state with no model run', async () => {
  // Catches: a status implemented as a one-word reply, which spends a request on every read.
  const { vendor, deps } = rig('claude', { loggedIn: true });
  assert.equal((await accountCommand(deps, 'claude', 'status')).status, 'ok');
  assert.deepEqual(vendor.calls(), ['auth status']);
  const out = rig('claude');
  assert.equal((await accountCommand(out.deps, 'claude', 'status')).code, 'not-logged-in');
});

test('logout removes the login under her home and moves no role', async () => {
  // Catches: a logout that clears the assignment, so a later login silently changes where a role runs.
  const { privateDir, vendor, deps } = rig('claude', { loggedIn: true });
  const before = fs.readFileSync(path.join(privateDir, 'keys.json'), 'utf8');
  assert.equal((await accountCommand(deps, 'claude', 'logout')).status, 'ok');
  assert.ok(vendor.calls().includes('auth logout'));
  assert.equal(vendor.loggedIn(), false);
  assert.equal(fs.readFileSync(path.join(privateDir, 'keys.json'), 'utf8'), before);
  assert.equal((await sourceState(privateDir, 'claude')).code, 'not-logged-in');
});

test('an unknown backend is refused with nothing run', async () => {
  // Catches: the word reaching a path join under the private layer.
  const { deps } = rig('claude');
  assert.equal((await accountCommand(deps, '../claude', 'status')).code, 'unknown-backend');
});

// Busy

test('logout during an agent run answers busy and leaves the credentials, and goes through after it', async () => {
  // Catches: the credentials pulled from under a running child, which then fails in a way nobody can read.
  const { privateDir, vendor, deps } = rig('codex', { loggedIn: true });
  vendor.hold('run');
  const running = createInstalledBackend('codex', privateDir).run('the brief', {
    cwd: privateDir,
    timeoutMs: 5000,
    sandbox: 'read-only',
    env: HOST_ENV,
  });
  try {
    await vendor.started('run');
    const answer = await accountCommand(deps, 'codex', 'logout');
    assert.equal(answer.code, 'busy');
    assert.equal(vendor.loggedIn(), true);
  } finally {
    vendor.release('run');
  }
  await running;
  assert.equal((await accountCommand(deps, 'codex', 'logout')).status, 'ok');
  assert.equal(vendor.loggedIn(), false);
});

test('logout during a memory writer run answers busy', async () => {
  // Catches: the writer starts through its own child runner, which an activity mark on the agent path misses.
  const { privateDir, vendor, deps } = rig('claude', { loggedIn: true });
  vendor.hold('run');
  const writing = runMemoryWriter(
    { kind: 'subharness', backend: 'claude', model: 'claude-opus-4-6', effort: null },
    { system: 'S', user: 'U', timeoutMs: 5000 },
    { privateDir, runChild: runChildProcess, workDir: tempDir('nep-memory-work-') }
  ).catch(() => null);
  try {
    await vendor.started('run');
    assert.equal((await accountCommand(deps, 'claude', 'logout')).code, 'busy');
  } finally {
    vendor.release('run');
  }
  await writing;
});

/** A child process that imports the engine from the checkout and evaluates `body`, with `deps` and `vendor` in scope. */
function otherProcess(body: string, values: Record<string, unknown>) {
  const url = (file: string): string => pathToFileURL(path.join(import.meta.dirname, '..', file)).href;
  const source = `
    import { createInstalledBackend } from ${JSON.stringify(url('src/agent-runner/backend.ts'))};
    import { accountCommand } from ${JSON.stringify(url('src/subharness/account.ts'))};
    const values = ${JSON.stringify(values)};
    const deps = { ...values, install: () => Promise.reject(new Error('no install')), ask: () => Promise.resolve('no'), loginStdio: 'ignore' };
    ${body}
  `;
  const child = spawn(process.execPath, ['--input-type=module', '-e', source], { stdio: 'ignore', detached: false });
  const ended = new Promise<number | null>((resolve) => child.once('exit', (code) => resolve(code)));
  return { child, ended };
}

test('a run of another process makes logout answer busy, as the core running while the owner types in a shell', async () => {
  // Catches: the busy mark held in this process's memory, which the command line can never see.
  const { privateDir, vendor, deps } = rig('codex', { loggedIn: true });
  vendor.hold('run');
  const other = otherProcess(
    `await createInstalledBackend('codex', values.privateDir).run('brief', { cwd: values.privateDir, timeoutMs: 5000, sandbox: 'read-only', env: values.hostEnv });`,
    { privateDir, hostEnv: HOST_ENV }
  );
  try {
    await vendor.started('run');
    assert.equal((await accountCommand(deps, 'codex', 'logout')).code, 'busy');
  } finally {
    vendor.release('run');
  }
  assert.equal(await other.ended, 0);
});

test('a mark left by a process that died does not hold logout forever', async () => {
  // Catches: a core killed in the middle of a run leaves the backend busy until someone deletes a file by hand.
  const { privateDir, vendor, deps } = rig('codex', { loggedIn: true });
  vendor.hold('run');
  const other = otherProcess(
    `await createInstalledBackend('codex', values.privateDir).run('brief', { cwd: values.privateDir, timeoutMs: 5000, sandbox: 'read-only', env: values.hostEnv });`,
    { privateDir, hostEnv: HOST_ENV }
  );
  try {
    await vendor.started('run');
    other.child.kill('SIGKILL');
    await other.ended;
  } finally {
    vendor.release('run');
  }
  // The orphaned vendor child sees the release and ends; only the mark of its dead parent is left.
  await new Promise((resolve) => setTimeout(resolve, 100));
  assert.equal((await accountCommand(deps, 'codex', 'logout')).status, 'ok');
});

// Serialization

test('credential changes of one backend run one at a time', async () => {
  // Catches: a logout racing a login leaves a home that is half of each.
  const { vendor, deps } = rig('claude');
  vendor.hold('login');
  const login = accountCommand(deps, 'claude', 'login');
  await vendor.started('login');
  const logout = accountCommand(deps, 'claude', 'logout');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(vendor.calls().includes('auth logout'), false, 'the logout waits for the login');
  vendor.release('login');
  await Promise.all([login, logout]);
  const calls = vendor.calls();
  assert.ok(calls.indexOf('auth login') < calls.indexOf('auth logout'));
  assert.equal(vendor.loggedIn(), false);
});

test('an update of a backend waits for a login of that backend', async () => {
  // Catches: npm moving the binary away while the vendor's login is writing the home.
  const { privateDir, vendor, deps } = rig('claude');
  vendor.hold('login');
  const login = accountCommand(deps, 'claude', 'login');
  await vendor.started('login');
  const update = updateSubharness(
    { privateDir, backend: 'claude', hostEnv: HOST_ENV, version: '9.9.9' },
    vendor.install
  );
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(vendor.installs, [], 'the update waits for the login');
  vendor.release('login');
  await Promise.all([login, update]);
  assert.equal(vendor.installs.length, 1);
});

test('a login of one backend does not hold another backend', async () => {
  // Catches: one global lock, so a login left waiting for a browser stops every other account command.
  const { privateDir, vendor, deps } = rig('claude');
  const codex = fakeVendor(privateDir, 'codex', { loggedIn: true });
  vendor.hold('login');
  const login = accountCommand(deps, 'claude', 'login');
  await vendor.started('login');
  const logout = await accountCommand({ ...deps, install: codex.install }, 'codex', 'logout');
  assert.equal(logout.status, 'ok');
  vendor.release('login');
  await login;
});

test('a login in another process holds a logout in this one', async () => {
  // Catches: a queue kept in this process, when the command line and the core are two processes on one home.
  const { privateDir, vendor, deps } = rig('claude');
  vendor.hold('login');
  const other = otherProcess(`await accountCommand(deps, 'claude', 'login');`, { privateDir, hostEnv: HOST_ENV });
  await vendor.started('login');
  const logout = accountCommand(deps, 'claude', 'logout');
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.equal(vendor.calls().includes('auth logout'), false);
  vendor.release('login');
  await logout;
  assert.equal(await other.ended, 0);
  assert.equal(vendor.loggedIn(), false);
});
