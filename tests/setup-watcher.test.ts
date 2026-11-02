// src/setup/watcher.ts: the watcher step of `neptunia setup` (spec 2026-11-02, "The watcher is a fourth ticking
// mechanic"). It asks on or off, the hour of the daily run, the backend it runs through and its model; the switch and
// the hour go into the local config, the backend and the model into keys.json. The terminal is a fake; the private
// folder is a temp dir and the tracked layer is this checkout's. Each test names the bug it catches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { watcherStep } from '../src/setup/watcher.ts';
import type { WatcherStepDeps } from '../src/setup/watcher.ts';
import { keysPath, readKeysFile, writeKeysFile } from './fixtures/keys-file.ts';
import { tempDir } from './fixtures/tmp.ts';

const ROOT = path.join(import.meta.dirname, '..');

type Backend = 'codex' | 'claude' | 'opencode';
type Rig = {
  options: { rootDir: string; privateDir: string };
  deps: WatcherStepDeps;
  answers: Array<string>;
  asked: Array<{ question: string; offered: string | null }>;
};

const configFile = (privateDir: string): string => path.join(privateDir, 'config.local', 'config.json');
const watcherOf = (privateDir: string): Record<string, unknown> =>
  (JSON.parse(fs.readFileSync(configFile(privateDir), 'utf8')) as { watcher?: Record<string, unknown> }).watcher ?? {};

function rig(
  watcher: Record<string, unknown> | null = null,
  backends: Array<Backend> = ['codex'],
  extra: { uses?: Record<string, Backend>; models?: Record<string, string> } = {}
): Rig {
  const privateDir = path.join(tempDir('nep-setup-watcher-'), 'private');
  fs.mkdirSync(path.join(privateDir, 'config.local'), { recursive: true });
  fs.writeFileSync(
    configFile(privateDir),
    JSON.stringify({ bot: { name: 'kept' }, ...(watcher === null ? {} : { watcher }) })
  );
  writeKeysFile(privateDir, { subharness: { backends, key: null, modes: {}, ...extra } });
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

test('on stores the switch and the hour in the settings and the backend and model in keys.json', async () => {
  // Catches: the backend chosen at setup is never stored, so the watcher runs through whatever backend is first.
  const r = rig(null, ['codex', 'claude']);
  r.answers = ['on', '01:30', 'claude', 'model-a'];
  const outcome = await watcherStep(r.options, r.deps);
  const keys = readKeysFile(r.options.privateDir).subharness;
  assert.equal(outcome.state, 'done');
  assert.deepEqual([watcherOf(r.options.privateDir).enabled, watcherOf(r.options.privateDir).at], [true, '01:30']);
  assert.equal(keys.uses?.watcher, 'claude');
  assert.equal(keys.models?.watcher, 'model-a');
});

test('off stores false and asks nothing more', async () => {
  // Catches: an off watcher still asks for an hour and a backend, or off is not written and the timer keeps running.
  const r = rig({ enabled: true, at: '00:00' });
  r.answers = ['off'];
  await watcherStep(r.options, r.deps);
  assert.equal(watcherOf(r.options.privateDir).enabled, false);
  assert.equal(r.asked.length, 1);
});

test('the backend question offers the first connected backend when the watcher has none', async () => {
  // Catches: the offered backend is a fixed codex, so Enter stores a backend this deployment never connected.
  const r = rig(null, ['claude', 'codex']);
  r.answers = ['on', '00:00', '', ''];
  await watcherStep(r.options, r.deps);
  assert.equal(r.asked[2]?.offered, 'claude');
  assert.equal(readKeysFile(r.options.privateDir).subharness.uses?.watcher, 'claude');
});

test('an empty model with none offered stores no model, so the backend runs on its default', async () => {
  // Catches: an empty answer is stored as the model "", and every watcher run passes an empty --model.
  const r = rig();
  r.answers = ['on', '00:00', 'codex', ''];
  await watcherStep(r.options, r.deps);
  assert.equal(readKeysFile(r.options.privateDir).subharness.uses?.watcher, 'codex');
  assert.equal(Object.hasOwn(readKeysFile(r.options.privateDir).subharness.models ?? {}, 'watcher'), false);
});

test('an hour that is no HH:MM is asked again and the valid answer is stored', async () => {
  // Catches: "24:00" reaches the timer's OnCalendar and systemd refuses the unit.
  const r = rig();
  r.answers = ['on', '24:00', '06:45', 'codex', ''];
  await watcherStep(r.options, r.deps);
  assert.equal(watcherOf(r.options.privateDir).at, '06:45');
});

test('on with no connected backend is refused and stored off', async () => {
  // Catches: the watcher is switched on with nothing to run it, and its timer fails every night.
  const r = rig(null, []);
  r.answers = ['on', '00:00', 'codex', ''];
  const outcome = await watcherStep(r.options, r.deps);
  assert.equal(outcome.state, 'refused');
  assert.equal(watcherOf(r.options.privateDir).enabled, false);
});

test('a backend that is not connected is refused and stored nowhere', async () => {
  // Catches: the watcher is pointed at claude while only codex is connected, and every run is refused subharness-off.
  const r = rig(null, ['codex']);
  r.answers = ['on', '00:00', 'claude', ''];
  const outcome = await watcherStep(r.options, r.deps);
  assert.equal(outcome.state, 'refused');
  assert.equal(watcherOf(r.options.privateDir).enabled, false);
  assert.equal(readKeysFile(r.options.privateDir).subharness.uses?.watcher, undefined);
});

test('a rerun that keeps every value is already done and rewrites neither file', async () => {
  // Catches: each setup rewrites keys.json and the local config, so the step never reports already.
  const r = rig({ enabled: true, at: '02:00' }, ['codex'], { uses: { watcher: 'codex' }, models: { watcher: 'm' } });
  const before = [
    fs.readFileSync(configFile(r.options.privateDir), 'utf8'),
    fs.readFileSync(keysPath(r.options.privateDir), 'utf8'),
  ];
  r.answers = ['', '', '', ''];
  const outcome = await watcherStep(r.options, r.deps);
  assert.equal(outcome.state, 'already');
  assert.equal(r.asked[1]?.offered, '02:00');
  assert.deepEqual(
    [
      fs.readFileSync(configFile(r.options.privateDir), 'utf8'),
      fs.readFileSync(keysPath(r.options.privateDir), 'utf8'),
    ],
    before
  );
});
