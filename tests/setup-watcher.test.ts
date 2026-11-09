// src/setup/watcher.ts: the watcher step of `neptunia setup`. It asks the backend the watcher runs through and its model,
// and both go into keys.json. The watcher runs only on `/doctor watcher run`, so the step asks no switch and no schedule.
// Changed: the switch and the hour left the step with the timer (owner, 2026-11-09). The terminal is a fake; the private
// folder is a temp dir and the tracked layer is this checkout's. Each test names the bug it catches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { readRouting } from '../src/subharness/routing.ts';
import { watcherStep } from '../src/setup/watcher.ts';
import type { WatcherStepDeps } from '../src/setup/watcher.ts';
import { keysPath, readKeysFile, writeKeysFile } from './fixtures/keys-file.ts';
import { fakeVendor } from './fixtures/fake-vendor.ts';
import { tempDir } from './fixtures/tmp.ts';

const ROOT = path.join(import.meta.dirname, '..');

type Backend = 'codex' | 'claude' | 'opencode';
type Rig = {
  options: { rootDir: string; privateDir: string };
  deps: WatcherStepDeps;
  answers: Array<string>;
  asked: Array<{ question: string; offered: string | null }>;
};

const configFile = (privateDir: string): string => path.join(privateDir, 'config', 'config.json');

function rig(
  watcher: Record<string, unknown> | null = null,
  backends: Array<Backend> = ['codex'],
  extra: { uses?: Record<string, Backend>; models?: Record<string, string> } = {}
): Rig {
  const privateDir = path.join(tempDir('nep-setup-watcher-'), 'private');
  fs.mkdirSync(path.join(privateDir, 'config'), { recursive: true });
  fs.writeFileSync(
    configFile(privateDir),
    JSON.stringify({ bot: { name: 'kept' }, ...(watcher === null ? {} : { watcher }) })
  );
  writeKeysFile(privateDir, { subharness: { backends, key: null, modes: {}, ...extra } });
  // Changed: a source is what is installed and logged in, so each backend the rig calls connected is both.
  for (const backend of backends) if (backend !== 'opencode') fakeVendor(privateDir, backend, { loggedIn: true });
  const r: Rig = {
    options: { rootDir: ROOT, privateDir },
    answers: [],
    asked: [],
    deps: {
      ask: (question, offered) => {
        r.asked.push({ question, offered });
        return Promise.resolve(r.answers.shift() ?? '');
      },
    },
  };
  return r;
}

test('the step asks the backend and the model, and stores both in keys.json', async () => {
  // Catches: the backend chosen at setup is never stored, so the watcher runs through whatever backend is first, or the
  // step still asks for a switch and an hour nothing reads.
  const r = rig(null, ['codex', 'claude']);
  r.answers = ['claude', 'model-a'];
  const outcome = await watcherStep(r.options, r.deps);
  const keys = readKeysFile(r.options.privateDir).subharness;
  assert.equal(outcome.state, 'done');
  assert.equal(r.asked.length, 2);
  assert.equal(keys.uses?.watcher, 'claude');
  assert.equal(keys.models?.watcher, 'model-a');
});

test('the backend question offers the first connected backend when the watcher has none', async () => {
  // Catches: the offered backend is a fixed codex, so Enter stores a backend this deployment never connected.
  const r = rig(null, ['claude', 'codex']);
  r.answers = ['', ''];
  await watcherStep(r.options, r.deps);
  assert.equal(r.asked[0]?.offered, 'claude');
  assert.equal(readRouting(r.options.privateDir).subharness.uses.watcher, 'claude');
});

test('an empty model with none offered stores no model, so the backend runs on its default', async () => {
  // Catches: an empty answer is stored as the model "", and every watcher run passes an empty --model.
  const r = rig();
  r.answers = ['codex', ''];
  await watcherStep(r.options, r.deps);
  assert.equal(readRouting(r.options.privateDir).subharness.uses.watcher, 'codex');
  assert.equal(Object.hasOwn(readKeysFile(r.options.privateDir).subharness.models ?? {}, 'watcher'), false);
});

test('a backend that is not connected is refused and stored nowhere', async () => {
  // Catches: the watcher is pointed at claude while only codex is connected, and every run is refused subharness-off.
  const r = rig(null, ['codex']);
  const before = readKeysFile(r.options.privateDir).subharness.uses?.watcher;
  r.answers = ['claude', ''];
  const outcome = await watcherStep(r.options, r.deps);
  assert.equal(outcome.state, 'refused');
  assert.equal(readKeysFile(r.options.privateDir).subharness.uses?.watcher, before);
});

test('no connected backend is refused', async () => {
  // Catches: setup reports the watcher ready with nothing to run it, and the first /doctor watcher run fails.
  const r = rig(null, []);
  r.answers = ['codex', ''];
  assert.equal((await watcherStep(r.options, r.deps)).state, 'refused');
});

test('a rerun that keeps every value is already done and rewrites neither file', async () => {
  // Catches: each setup rewrites keys.json and the local config, so the step never reports already.
  const r = rig(null, ['codex'], { uses: { watcher: 'codex' }, models: { watcher: 'm' } });
  const before = [
    fs.readFileSync(configFile(r.options.privateDir), 'utf8'),
    fs.readFileSync(keysPath(r.options.privateDir), 'utf8'),
  ];
  r.answers = ['', ''];
  const outcome = await watcherStep(r.options, r.deps);
  assert.equal(outcome.state, 'already');
  assert.deepEqual(
    [
      fs.readFileSync(configFile(r.options.privateDir), 'utf8'),
      fs.readFileSync(keysPath(r.options.privateDir), 'utf8'),
    ],
    before
  );
});
