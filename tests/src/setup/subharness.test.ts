// src/setup/subharness.ts: the subharness step of `neptunia setup`. It asks which backends to install, installs each
// into the persona's place through the install of src/subharness/install.ts, shows the login of codex and claude, and asks the
// backend's own status afterwards. npm and the terminal are fakes that record what they were given, the vendor CLIs are
// disposable fakes that a login step logs in, and the private folder is a temp dir. Each test names the bug it catches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { subharnessStep } from '../../../src/setup/subharness.ts';
import type { SubharnessStepDeps } from '../../../src/setup/subharness.ts';
import type { InstallRunResult } from '../../../src/subharness/install.ts';
import { subharnessPlace } from '../../../src/subharness/place.ts';
import { fakeVendor } from '../../fixtures/fake-vendor.ts';
import type { FakeVendor } from '../../fixtures/fake-vendor.ts';
import { readKeysFile, writeKeysFile } from '../../fixtures/keys-file.ts';
import { tempDir } from '../../fixtures/tmp.ts';

const SECRET = 'sk-or-v1-opencode-secret-0123456789';

type Rig = {
  privateDir: string;
  deps: SubharnessStepDeps;
  /** what the owner types, in order; an exhausted list answers '' */
  answers: Array<string>;
  asked: Array<{ question: string; offered: string | null }>;
  /** every outside call in order: `install <backend>`, `ask <n>` */
  events: Array<string>;
  installs: Array<ReadonlyArray<string>>;
  /** the answer of npm, by backend */
  npm: Record<string, InstallRunResult>;
  /** the vendor CLIs, whose login the step runs itself */
  vendors: Record<'codex' | 'claude', FakeVendor>;
};

/** Puts an executable file at `file`, as npm or the copy would. */
function placeBinary(file: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '#!/bin/sh\n', { mode: 0o755 });
}

function rig(): Rig {
  const privateDir = path.join(tempDir('nep-setup-subharness-'), 'private');
  writeKeysFile(privateDir, { extra: { 'oc-key': SECRET } });
  const r: Rig = {
    privateDir,
    answers: [],
    asked: [],
    events: [],
    installs: [],
    npm: {},
    vendors: {
      codex: fakeVendor(privateDir, 'codex', { installed: false }),
      claude: fakeVendor(privateDir, 'claude', { installed: false }),
    },
    deps: {
      ask: (question, offered) => {
        r.asked.push({ question, offered });
        r.events.push(`ask ${r.asked.length}`);
        return Promise.resolve(r.answers.shift() ?? '');
      },
      install: (command, args) => {
        const prefix = args[args.indexOf('--prefix') + 1] ?? '';
        const backend = path.basename(prefix);
        r.installs.push([command, ...args]);
        r.events.push(`install ${backend}`);
        const result = r.npm[backend] ?? { code: 0, stdout: '', stderr: '' };
        if (result.code === 0 && (backend === 'codex' || backend === 'claude')) {
          const vendor = r.vendors[backend];
          return vendor.install(command, args, { env: {} });
        }
        return Promise.resolve(result);
      },
      hostEnv: { PATH: '/usr/bin:/bin', HOME: '/home/alice' },
      loginStdio: 'ignore',
    },
  };
  return r;
}

test('a fresh setup installs and logs in every backend the owner names, in the order named', async () => {
  // Catches: only the first name of the answer is installed.
  // No list is stored; availability is what the step ends with.
  const r = rig();
  r.answers = ['claude, codex'];
  const outcome = await subharnessStep({ privateDir: r.privateDir }, r.deps);
  assert.equal(outcome.state, 'done');
  assert.deepEqual(
    r.events.filter((one) => one.startsWith('install')),
    ['install claude', 'install codex']
  );
  assert.equal(Object.hasOwn(readKeysFile(r.privateDir).subharness, 'backends'), false);
  assert.deepEqual([...outcome.available].sort(), ['claude', 'codex']);
});

test("each backend is installed into the persona's place with npm's own prefix", async () => {
  // Catches: the step installs globally or into the installing user's home, so the persona's agents run on that user's CLI and login.
  const r = rig();
  r.answers = ['codex'];
  await subharnessStep({ privateDir: r.privateDir }, r.deps);
  assert.equal(r.installs.length, 1);
  const install = r.installs[0];
  assert.ok(install?.includes(subharnessPlace(r.privateDir, 'codex').dir));
});

test("the step runs the login of the persona's binary after the install of that backend", async () => {
  // Catches: the login runs before the binary is there, or the owner is left to find the command.
  // The step runs the login itself, so the fake vendor records it.
  const r = rig();
  r.answers = ['codex'];
  const outcome = await subharnessStep({ privateDir: r.privateDir }, r.deps);
  assert.equal(outcome.state, 'done', outcome.detail);
  assert.equal(r.events[1], 'install codex');
  const codex = r.vendors.codex;
  assert.ok(codex.calls().includes('login --device-auth'), codex.calls().join('; '));
  assert.deepEqual(codex.homes().at(-1), codex.home);
});

test('a rerun with every chosen backend installed and logged in is already done and installs nothing', async () => {
  // Catches: each setup rerun spends an npm install and a reply on backends that work, or asks the owner to log in again.
  const r = rig();
  r.answers = ['codex claude'];
  await subharnessStep({ privateDir: r.privateDir }, r.deps);
  r.events.length = 0;
  r.answers = [''];
  const outcome = await subharnessStep({ privateDir: r.privateDir }, r.deps);
  assert.equal(outcome.state, 'already');
  assert.equal(r.asked.at(-1)?.offered, 'codex claude');
  assert.deepEqual(
    r.events.filter((one) => !one.startsWith('ask')),
    []
  );
});

test('choosing none installs nothing and leaves the stored choices as they were', async () => {
  // Catches: an empty choice is stored as an empty list and disconnects the backends a deployment already runs on.
  const r = rig();
  writeKeysFile(r.privateDir, {
    extra: { 'oc-key': SECRET },
    subharness: { backends: ['codex'], key: null, modes: {} },
  });
  // The stored choices are the entries of every agent's `models.agents.via`.
  const before = readKeysFile(r.privateDir).subharness.uses;
  r.answers = ['none'];
  const outcome = await subharnessStep({ privateDir: r.privateDir }, r.deps);
  assert.equal(outcome.state, 'skipped');
  assert.deepEqual(r.installs, []);
  assert.deepEqual(readKeysFile(r.privateDir).subharness.uses, before);
});

test('a failed install fails the step and connects nothing for that backend', async () => {
  // Catches: the backend reads as available although npm failed, and every agent run on it is refused not-installed.
  const r = rig();
  r.answers = ['codex'];
  r.npm.codex = { code: 1, stdout: '', stderr: 'npm ERR! network' };
  const outcome = await subharnessStep({ privateDir: r.privateDir }, r.deps);
  assert.equal(outcome.state, 'failed');
  assert.deepEqual(outcome.available, []);
});

test('a backend whose login did not happen is left out and the one set up before it stays', async () => {
  // Catches: one failed login rolls back the whole step, so a working codex is lost because claude was not logged in.
  // The step runs the login itself, so it is the vendor's login that fails.
  const r = rig();
  r.answers = ['codex claude'];
  const claude = r.vendors.claude;
  claude.setLogin('fail');
  const outcome = await subharnessStep({ privateDir: r.privateDir }, r.deps);
  assert.equal(outcome.state, 'failed');
  assert.deepEqual(outcome.available, ['codex']);
});

test('opencode is copied in, logged in on the extra key the owner names, and no line holds the key value', async () => {
  // Catches: opencode is stored with no key and every run is refused, or the step prints the key it found.
  // No list is stored and no request checks the key; the store must hold it.
  const r = rig();
  const source = path.join(tempDir('nep-setup-opencode-'), 'opencode');
  placeBinary(source);
  r.answers = ['opencode', source, 'oc-key'];
  const outcome = await subharnessStep({ privateDir: r.privateDir }, r.deps);
  const stored = readKeysFile(r.privateDir).subharness;
  assert.deepEqual([outcome.state, outcome.available, stored.key], ['done', ['opencode'], 'oc-key']);
  assert.equal(JSON.stringify([outcome, r.asked]).includes(SECRET), false);
});

// The step over fake installers and fake vendor CLIs: one backend, all of them, and a reopen that keeps the accounts
// and model choices.

// The backends

/** The step's deps: the owner's `answers` in order, and the fake install. */
function stepDeps(answers: Array<string>, install: SubharnessStepDeps['install']): SubharnessStepDeps {
  return {
    ask: () => Promise.resolve(answers.shift() ?? ''),
    install,
    hostEnv: { PATH: '/usr/bin:/bin' },
    loginStdio: 'ignore',
  };
}

/** A private layer with fakes of codex and claude absent, and an install that puts in place the one npm was asked for. */
function fakes() {
  const privateDir = tempDir('nep-flow-backends-');
  writeKeysFile(privateDir, {
    subharness: { key: null, modes: { dev: 'full' }, models: { dev: 'sonnet' }, uses: { dev: 'claude' } },
  });
  const codex = fakeVendor(privateDir, 'codex', { installed: false });
  const claude = fakeVendor(privateDir, 'claude', { installed: false });
  const install: SubharnessStepDeps['install'] = (command, args, options) => {
    const vendor = args.some((one) => one.startsWith('@openai/codex')) ? codex : claude;
    return vendor.install(command, args, options);
  };
  return { privateDir, codex, claude, install };
}

test('one backend is installed through the installer and logged in, with no list stored and no role moved', async () => {
  // Catches: setup still writing the enabled list, or assigning the new backend to the agents.
  const { privateDir, codex, claude, install } = fakes();
  const deps = stepDeps(['codex'], install);
  const outcome = await subharnessStep({ privateDir }, deps);
  assert.equal(outcome.state, 'done', outcome.detail);
  assert.equal(codex.installs.length, 1);
  assert.equal(codex.loggedIn(), true);
  assert.deepEqual(claude.installs, []);
  const stored = readKeysFile(privateDir).subharness;
  assert.equal(Object.hasOwn(stored, 'backends'), false);
  assert.deepEqual(stored.uses, { dev: 'claude' });
});

test('all is an answer of its own and needs the opencode source only when opencode is absent', async () => {
  // Catches: "all" refused as an unknown backend name.
  const { privateDir, codex, claude, install } = fakes();
  const source = path.join(tempDir('nep-flow-opencode-'), 'opencode');
  fs.writeFileSync(source, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  const deps = stepDeps(['all', source, ''], install);
  await subharnessStep({ privateDir }, deps);
  assert.equal(codex.loggedIn(), true);
  assert.equal(claude.loggedIn(), true);
  assert.equal(fs.existsSync(path.join(privateDir, 'subharness', 'opencode', 'bin', 'opencode')), true);
});

test('reopening adds an omitted backend and keeps the accounts and model choices of the first', async () => {
  // Catches: the second pass logs the first account out, reinstalls it, or resets the agents' models.
  const { privateDir, codex, claude, install } = fakes();
  await subharnessStep({ privateDir }, stepDeps(['codex'], install));
  const logins = codex.calls().filter((one) => one.startsWith('login --')).length;
  const outcome = await subharnessStep({ privateDir }, stepDeps(['claude'], install));
  assert.equal(outcome.state, 'done', outcome.detail);
  assert.equal(codex.loggedIn(), true);
  assert.equal(codex.installs.length, 1);
  assert.equal(codex.calls().filter((one) => one.startsWith('login --')).length, logins);
  assert.equal(claude.loggedIn(), true);
  assert.deepEqual(readKeysFile(privateDir).subharness.models, { dev: 'sonnet' });
});
