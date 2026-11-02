// src/setup/subharness.ts: the subharness step of `neptunia setup` (spec 2026-11-02, PR 5, "Several subharnesses"). It
// asks which backends to install, installs each into her place through the install of src/subharness/install.ts,
// shows the login of codex and claude, connects each after one check and stores the list in keys.json. npm, the
// terminal, the backends' reply and the key check are fakes that record what they were given; the private folder is
// a temp dir. Each test names the bug it catches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import type { BackendResult } from '../src/agent-runner/backend.ts';
import { subharnessStep } from '../src/setup/subharness.ts';
import type { SubharnessStepDeps } from '../src/setup/subharness.ts';
import type { InstallRunResult } from '../src/subharness/install.ts';
import { loginCommand, subharnessPlace } from '../src/subharness/place.ts';
import { readKeysFile, writeKeysFile } from './fixtures/keys-file.ts';
import { tempDir } from './fixtures/tmp.ts';

const SECRET = 'sk-or-v1-opencode-secret-0123456789';
const REPLY: BackendResult = { ok: true, text: 'ok', exitCode: 0 };
const SILENT: BackendResult = { ok: false, text: '', exitCode: 1 };

type Rig = {
  privateDir: string;
  deps: SubharnessStepDeps;
  /** what the owner types, in order; an exhausted list answers '' */
  answers: Array<string>;
  asked: Array<{ question: string; offered: string | null }>;
  /** every outside call in order: `install <backend>`, `ask <n>`, `check <backend>`, `fetch` */
  events: Array<string>;
  installs: Array<ReadonlyArray<string>>;
  /** the answer of npm, by backend */
  npm: Record<string, InstallRunResult>;
  /** the answer of the reply check, by backend */
  replies: Record<string, BackendResult>;
  fetched: Array<string>;
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
    replies: {},
    fetched: [],
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
        if (result.code === 0 && (backend === 'codex' || backend === 'claude'))
          placeBinary(subharnessPlace(privateDir, backend).binary);
        return Promise.resolve(result);
      },
      hostEnv: { PATH: '/usr/bin:/bin', HOME: '/home/alice' },
      runBackend: (name) => {
        r.events.push(`check ${name}`);
        return Promise.resolve(r.replies[name] ?? REPLY);
      },
      fetch: (url: string | URL | Request, init?: RequestInit) => {
        r.events.push('fetch');
        r.fetched.push(new Headers(init?.headers).get('authorization') ?? '');
        return Promise.resolve(new Response('{}', { status: 200 }));
      },
      baseUrl: 'https://openrouter.test/api/v1',
    },
  };
  return r;
}

test('a fresh setup installs and connects every backend the owner names, in the order named', async () => {
  // Catches: only the first name of the answer is installed, or the list is stored sorted, so the default backend of
  // every agent (the first) is not the one the owner put first.
  const r = rig();
  r.answers = ['claude, codex'];
  const outcome = await subharnessStep({ privateDir: r.privateDir }, r.deps);
  assert.equal(outcome.state, 'done');
  assert.deepEqual(readKeysFile(r.privateDir).subharness.backends, ['claude', 'codex']);
  assert.deepEqual(outcome.connected, ['claude', 'codex']);
});

test("each backend is installed into her place with npm's own prefix", async () => {
  // Catches: the step installs globally or into the installing user's home, so her agents run on his CLI and login.
  const r = rig();
  r.answers = ['codex'];
  await subharnessStep({ privateDir: r.privateDir }, r.deps);
  assert.equal(r.installs.length, 1);
  assert.ok(r.installs[0]?.includes(subharnessPlace(r.privateDir, 'codex').dir));
});

test('the login line of her binary is shown before the reply check of that backend', async () => {
  // Catches: the check runs before the owner could log in, fails with no reply, and a fresh install never connects.
  const r = rig();
  r.answers = ['codex'];
  await subharnessStep({ privateDir: r.privateDir }, r.deps);
  const login = loginCommand(r.privateDir, 'codex')?.text ?? 'no login line';
  const at = r.asked.findIndex((one) => one.question.includes(login));
  assert.notEqual(at, -1, 'a question shows the login line');
  assert.ok(r.events.indexOf(`ask ${at + 1}`) < r.events.indexOf('check codex'));
});

test('a rerun with every chosen backend installed and connected is already done and installs or checks nothing', async () => {
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

test('choosing none installs nothing and leaves the connected backends as they were', async () => {
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
  // Catches: the backend is stored although npm failed, and every agent run on it is refused not-installed.
  const r = rig();
  r.answers = ['codex'];
  r.npm.codex = { code: 1, stdout: '', stderr: 'npm ERR! network' };
  const outcome = await subharnessStep({ privateDir: r.privateDir }, r.deps);
  assert.equal(outcome.state, 'failed');
  assert.deepEqual(readKeysFile(r.privateDir).subharness.backends ?? [], []);
});

test('a backend whose check fails is left out and the one connected before it stays', async () => {
  // Catches: one failed login rolls back the whole step, so a working codex is disconnected because claude was not logged in.
  const r = rig();
  r.answers = ['codex claude'];
  r.replies.claude = SILENT;
  const outcome = await subharnessStep({ privateDir: r.privateDir }, r.deps);
  assert.equal(outcome.state, 'failed');
  assert.deepEqual(readKeysFile(r.privateDir).subharness.backends, ['codex']);
});

test('opencode is copied in, connected to the extra key the owner names, and no line holds the key value', async () => {
  // Catches: opencode is stored with no key and every run is refused, or the step prints the key it checked.
  const r = rig();
  const source = path.join(tempDir('nep-setup-opencode-'), 'opencode');
  placeBinary(source);
  r.answers = ['opencode', source, 'oc-key'];
  const outcome = await subharnessStep({ privateDir: r.privateDir }, r.deps);
  const stored = readKeysFile(r.privateDir).subharness;
  assert.deepEqual([outcome.state, stored.backends, stored.key], ['done', ['opencode'], 'oc-key']);
  assert.deepEqual(r.fetched, [`Bearer ${SECRET}`]);
  assert.equal(JSON.stringify([outcome, r.asked]).includes(SECRET), false);
});
