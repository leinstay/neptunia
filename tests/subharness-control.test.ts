// src/subharness/control.ts: the owner's settings of the subharness roles over keys.json. The result has the shape of
// Hermes' ApprovalModeResult (hermes_cli/approval_mode.py): ok, a code, whether anything changed, and a message. The
// sources are disposable fake CLIs, no request goes out and keys.json lives in a temp dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  AGENT_MODES,
  DEFAULT_MODES,
  SUBHARNESS_AGENTS,
  agentPaths,
  setAgentMode,
  setAgentModel,
  statusText,
  subharnessView,
} from '../src/subharness/control.ts';
import type { EnableDeps } from '../src/subharness/control.ts';
import { readKeys } from '../src/keys/file.ts';
import { subharnessPlace } from '../src/subharness/place.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import { readKeysFile, writeKeysFile } from './fixtures/keys-file.ts';
import { fakeVendor } from './fixtures/fake-vendor.ts';
import { tempDir } from './fixtures/tmp.ts';

const SECRET = 'sk-or-v1-oc-secret-0123456789';
const CORE_SECRET = 'sk-or-v1-core-secret-9876543210';

/** A private dir with keys.json holding an `opencode` extra key that opencode runs on, and a core key; fetch is a fake. */
function rig(): { deps: EnableDeps; dir: string } {
  const dir = tempDir('nep-subharness-');
  writeKeysFile(dir, {
    core: [{ name: 'core-1', value: CORE_SECRET }],
    extra: { opencode: SECRET, sim: 'sk-or-v1-sim-secret' },
    subharness: { key: 'opencode', modes: {} },
  });
  const { binary } = subharnessPlace(dir, 'opencode');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, '#!/bin/sh\nexit 9\n', { mode: 0o755 });
  const deps: EnableDeps = {
    privateDir: dir,
    baseUrl: 'https://openrouter.test/api/v1',
    runBackend: () => Promise.resolve({ ok: true, text: 'ok', exitCode: 0 }),
    fetch: () => Promise.resolve(new Response('{}', { status: 200 })),
  };
  return { deps, dir };
}

test('the tracked defaults are read for server and watcher, write for scout, dev and thinker, and there are four modes', () => {
  // Bug: a read-only agent defaulting to write, or an agent defaulting to an unsandboxed mode before the owner chose.
  // The thinker joined the agents as a role with its own backend, model and effort, so the expectation names it.
  assert.deepEqual(DEFAULT_MODES, { scout: 'write', server: 'read', dev: 'write', watcher: 'read', thinker: 'write' });
  assert.deepEqual([...AGENT_MODES], ['read', 'write', 'full', 'sudo']);
  assert.deepEqual([...SUBHARNESS_AGENTS].sort(), ['dev', 'scout', 'server', 'thinker', 'watcher']);
});

test('a store with no subharness section reads as off with the default modes', async () => {
  // Bug: a fresh install reads as enabled, or the view throws on the empty store.
  const dir = tempDir('nep-subharness-');
  writeKeysFile(dir);
  // Changed: off is a store with no source named for any agent, and the view lists every source as it stands.
  assert.deepEqual(readKeys(dir).subharness.uses, {});
  const view = await subharnessView(dir);
  assert.equal(view.key, null);
  assert.deepEqual(view.modes, DEFAULT_MODES);
  assert.equal(
    view.sources.some((one) => one.available),
    false
  );
});

test('no result, log line or status text holds a key value', async () => {
  // Bug: the check logs the request headers, or the status prints the key it shows the name of.
  // Changed: the key is seeded, and the selection through opencode is what spends it now that enable is gone.
  const { deps } = rig();
  const failing: EnableDeps = { ...deps, fetch: () => Promise.reject(new Error(`connect failed for ${SECRET}`)) };
  const { result, logs } = await withCapturedLogs(async () => {
    const results = [
      await setAgentModel(deps, 'dev', 'vendor/model', undefined, 'opencode'),
      await setAgentModel(failing, 'dev', 'vendor/other', undefined, 'opencode'),
    ];
    const status = statusText(await subharnessView(deps.privateDir), agentPaths(deps.privateDir));
    return { results, status };
  });
  const seen = JSON.stringify([result, logs]);
  assert.equal(seen.includes(SECRET), false);
  assert.equal(seen.includes(CORE_SECRET), false);
  assert.ok(result.status.includes('opencode'), 'the status names the key');
  assert.equal(result.results[0]?.ok, true);
  assert.equal(result.results[1]?.ok, false);
});

test('mode sets one agent and leaves the others at what they were', async () => {
  // Bug: writing the whole modes map from defaults overwrites the other agents' choices.
  const dir = tempDir('nep-subharness-');
  writeKeysFile(dir);
  await setAgentMode(dir, 'scout', 'read');
  const result = await setAgentMode(dir, 'dev', 'sudo');
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  assert.deepEqual((await subharnessView(dir)).modes, {
    scout: 'read',
    server: 'read',
    dev: 'sudo',
    watcher: 'read',
    thinker: 'write',
  });
});

test('mode with no value reports the current mode and writes nothing', async () => {
  // Bug: an inspection (Hermes /approvals without an argument) changes the setting it was asked to show.
  const dir = tempDir('nep-subharness-');
  writeKeysFile(dir);
  const result = await setAgentMode(dir, 'dev');
  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
  assert.equal(result.mode, 'write');
  assert.deepEqual(readKeysFile(dir).subharness.modes, {});
});

test('an unknown agent or mode is refused and the file is not touched', async () => {
  // Bug: "root" or "thinker" is written into keys.json and read later as a mode no code maps to a flag.
  const dir = tempDir('nep-subharness-');
  writeKeysFile(dir);
  assert.equal((await setAgentMode(dir, 'dev', 'root')).code, 'unknown-mode');
  assert.equal((await setAgentMode(dir, 'editor', 'read')).code, 'unknown-agent');
  assert.deepEqual(readKeysFile(dir).subharness.modes, {});
});

test('a stored mode that is no mode reads as the default, never as an unsandboxed one', async () => {
  // Bug: a hand-edited or damaged value such as "root" is passed on and an agent runs with more than the owner gave it.
  const dir = tempDir('nep-subharness-');
  writeKeysFile(dir, { subharness: { backend: 'codex', key: null, modes: { dev: 'root', scout: 'sudo' } } });
  const view = await subharnessView(dir);
  assert.equal(view.modes.dev, 'write');
  assert.equal(view.modes.scout, 'sudo');
});

test('the status says who holds the sandbox: the backend for codex, the systemd unit alone for opencode', async () => {
  // Bug: the owner believes read and write are enforced under OpenCode, which has no sandbox of its own.
  // Changed: the view lists the sources as they stand, so codex is a logged-in fake and opencode has its key.
  const { dir } = rig();
  fakeVendor(dir, 'codex', { loggedIn: true });
  const lines = statusText(await subharnessView(dir), agentPaths(dir)).split('\n');
  const lineOf = (name: string): string => lines.find((line) => line.trim().startsWith(name)) ?? '';
  assert.match(lineOf('codex'), /sandbox and by the unit/);
  assert.match(lineOf('opencode'), /systemd unit alone/);
});

test('the status text names the backend, the key name and every agent with its mode', async () => {
  // Bug: the status leaves out an agent, so a sudo mode is set and nobody sees it.
  // Changed: the status takes each agent's path, and opencode reads as a source by its seeded key.
  const { dir } = rig();
  await setAgentMode(dir, 'dev', 'sudo');
  const text = statusText(await subharnessView(dir), agentPaths(dir));
  for (const word of ['opencode', ...SUBHARNESS_AGENTS, 'sudo']) assert.ok(text.includes(word), word);
});
