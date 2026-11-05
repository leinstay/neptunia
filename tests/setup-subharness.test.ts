// src/setup/subharness.ts: the subharness step of `neptunia setup`. It asks which backends to install, installs each
// into her place through the install of src/subharness/install.ts, shows the login of codex and claude, and asks the
// backend's own status afterwards. npm and the terminal are fakes that record what they were given, the vendor CLIs are
// disposable fakes that a login step logs in, and the private folder is a temp dir. Each test names the bug it catches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { subharnessStep } from '../src/setup/subharness.ts';
import type { SubharnessStepDeps } from '../src/setup/subharness.ts';
import type { InstallRunResult } from '../src/subharness/install.ts';
import { loginCommand, subharnessPlace } from '../src/subharness/place.ts';
import { fakeVendor } from './fixtures/fake-vendor.ts';
import type { FakeVendor } from './fixtures/fake-vendor.ts';
import { readKeysFile, writeKeysFile } from './fixtures/keys-file.ts';
import { tempDir } from './fixtures/tmp.ts';

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
  /** the vendor CLIs, each logged in by its login step unless the backend is in `noLogin` */
  vendors: Record<'codex' | 'claude', FakeVendor>;
  noLogin: Array<string>;
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
    noLogin: [],
    deps: {
      ask: (question, offered) => {
        r.asked.push({ question, offered });
        r.events.push(`ask ${r.asked.length}`);
        // The owner logs in at the terminal while this question waits.
        for (const name of ['codex', 'claude'] as const) {
          const vendor = r.vendors[name];
          if (question.includes(vendor.binary) && !r.noLogin.includes(name)) {
            fs.mkdirSync(vendor.home, { recursive: true });
            fs.writeFileSync(path.join(vendor.home, 'credentials'), '');
          }
        }
        return Promise.resolve(r.answers.shift() ?? '');
      },
      install: (command, args) => {
        const prefix = args[args.indexOf('--prefix') + 1] ?? '';
        const backend = path.basename(prefix);
        r.installs.push([command, ...args]);
        r.events.push(`install ${backend}`);
        const result = r.npm[backend] ?? { code: 0, stdout: '', stderr: '' };
        if (result.code === 0 && (backend === 'codex' || backend === 'claude'))
          return r.vendors[backend].install(command, args, { env: {} });
        return Promise.resolve(result);
      },
      hostEnv: { PATH: '/usr/bin:/bin', HOME: '/home/alice' },
    },
  };
  return r;
}

test('a fresh setup installs and logs in every backend the owner names, in the order named', async () => {
  // Catches: only the first name of the answer is installed.
  // Changed: no list is stored; availability is what the step ends with.
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

test("each backend is installed into her place with npm's own prefix", async () => {
  // Catches: the step installs globally or into the installing user's home, so her agents run on his CLI and login.
  const r = rig();
  r.answers = ['codex'];
  await subharnessStep({ privateDir: r.privateDir }, r.deps);
  assert.equal(r.installs.length, 1);
  assert.ok(r.installs[0]?.includes(subharnessPlace(r.privateDir, 'codex').dir));
});

test('the login line of her binary is shown after the install of that backend', async () => {
  // Catches: the owner is told to log in with a binary that is not there yet, or with the installing user's own.
  // Changed: the backend's own status decides afterwards, so no reply check follows.
  const r = rig();
  r.answers = ['codex'];
  await subharnessStep({ privateDir: r.privateDir }, r.deps);
  const login = loginCommand(r.privateDir, 'codex')?.text ?? 'no login line';
  const at = r.asked.findIndex((one) => one.question.includes(login));
  assert.notEqual(at, -1, 'a question shows the login line');
  assert.ok(r.events.indexOf('install codex') < r.events.indexOf(`ask ${at + 1}`));
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
  r.answers = ['none'];
  const outcome = await subharnessStep({ privateDir: r.privateDir }, r.deps);
  assert.equal(outcome.state, 'skipped');
  assert.deepEqual(r.installs, []);
  assert.deepEqual(readKeysFile(r.privateDir).subharness.backends, ['codex']);
});

test('a failed install fails the step and connects nothing for that backend', async () => {
  // Catches: the backend reads as available although npm failed, and every agent run on it is refused not-installed.
  // Changed: availability replaced the stored list.
  const r = rig();
  r.answers = ['codex'];
  r.npm.codex = { code: 1, stdout: '', stderr: 'npm ERR! network' };
  const outcome = await subharnessStep({ privateDir: r.privateDir }, r.deps);
  assert.equal(outcome.state, 'failed');
  assert.deepEqual(outcome.available, []);
});

test('a backend whose login did not happen is left out and the one set up before it stays', async () => {
  // Catches: one failed login rolls back the whole step, so a working codex is lost because claude was not logged in.
  // Changed: the backend's own status decides, in place of a reply check.
  const r = rig();
  r.answers = ['codex claude'];
  r.noLogin = ['claude'];
  const outcome = await subharnessStep({ privateDir: r.privateDir }, r.deps);
  assert.equal(outcome.state, 'failed');
  assert.deepEqual(outcome.available, ['codex']);
});

test('opencode is copied in, logged in on the extra key the owner names, and no line holds the key value', async () => {
  // Catches: opencode is stored with no key and every run is refused, or the step prints the key it found.
  // Changed: no list is stored and no request checks the key; the store must hold it.
  const r = rig();
  const source = path.join(tempDir('nep-setup-opencode-'), 'opencode');
  placeBinary(source);
  r.answers = ['opencode', source, 'oc-key'];
  const outcome = await subharnessStep({ privateDir: r.privateDir }, r.deps);
  const stored = readKeysFile(r.privateDir).subharness;
  assert.deepEqual([outcome.state, outcome.available, stored.key], ['done', ['opencode'], 'oc-key']);
  assert.equal(JSON.stringify([outcome, r.asked]).includes(SECRET), false);
});
