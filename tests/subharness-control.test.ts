// src/subharness/control.ts: the owner's settings of the subharness roles over keys.json. The result has the shape of
// Hermes' ApprovalModeResult (hermes_cli/approval_mode.py): ok, a code, whether anything changed, and a message. The
// sources are disposable fake CLIs, no request goes out and keys.json lives in a temp dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  DEFAULT_MODES,
  SUBHARNESS_AGENTS,
  agentPaths,
  replyCheckOptions,
  setAgentMode,
  setAgentModel,
  statusText,
  subharnessView,
} from '../src/subharness/control.ts';
import type { EnableDeps } from '../src/subharness/control.ts';
import { readRouting } from '../src/subharness/routing.ts';
import { subharnessPlace } from '../src/subharness/place.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import { readKeysFile, writeKeysFile } from './fixtures/keys-file.ts';

import { tempDir } from './fixtures/tmp.ts';
import * as control from '../src/subharness/control.ts';
import { fakeVendor } from './fixtures/fake-vendor.ts';

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

test('a store with no subharness section reads as off with the default modes', async () => {
  // Bug: a fresh install reads as enabled, or the view throws on the empty store.
  const dir = tempDir('nep-subharness-');
  writeKeysFile(dir);
  // Changed: off is a store with no source named for any agent, and the view lists every source as it stands.
  assert.deepEqual(readRouting(dir).subharness.uses, {});
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

test('the status text names the backend, the key name and every agent with its mode', async () => {
  // Bug: the status leaves out an agent, so a sudo mode is set and nobody sees it.
  // Changed: the status takes each agent's path, and opencode reads as a source by its seeded key.
  const { dir } = rig();
  await setAgentMode(dir, 'dev', 'sudo');
  const text = statusText(await subharnessView(dir), agentPaths(dir));
  for (const word of ['opencode', ...SUBHARNESS_AGENTS, 'sudo']) assert.ok(text.includes(word), word);
});

// The one-reply check of `setAgentModel` goes out through the provider the owner pinned: OpenRouter's request body carries
// the same `provider` block the run will send, so a pin the provider cannot serve is refused before it is saved.
// The fetch is a fake that records the body; no request goes out.

const MODEL = 'anthropic/claude-sonnet-5';

/** A private dir whose opencode is installed and logged in on the extra key `helpers`. */
function installed(): string {
  const dir = tempDir('nep-provider-check-');
  writeKeysFile(dir, {
    extra: { helpers: 'sk-or-v1-check-fake-0123456789' },
    subharness: { key: 'helpers', modes: {} },
  });
  const { binary } = subharnessPlace(dir, 'opencode');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, '#!/bin/sh\nexit 9\n', { mode: 0o755 });
  return dir;
}

/** Deps whose fetch answers `status` and records every body it was sent. */
function deps(dir: string, status: number, bodies: Array<Record<string, unknown>>): EnableDeps {
  return {
    privateDir: dir,
    baseUrl: 'https://openrouter.test/api/v1',
    runBackend: () => Promise.resolve({ ok: true, text: 'ok', exitCode: 0 }),
    fetch: (_url, init) => {
      bodies.push(JSON.parse(typeof init?.body === 'string' ? init.body : '{}') as Record<string, unknown>);
      return Promise.resolve(new Response('{}', { status }));
    },
  };
}

test('the check of a pinned selection asks OpenRouter for that provider alone with no fallback', async () => {
  // Catches: the check goes out unpinned, so a model that only another provider serves passes and the pinned runs fail.
  const bodies: Array<Record<string, unknown>> = [];
  const result = await setAgentModel(deps(installed(), 200, bodies), 'dev', MODEL, undefined, 'opencode', 'anthropic');
  assert.equal(result.ok, true, result.message);
  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0].provider, { order: ['anthropic'], allow_fallbacks: false });
});

test('the check of an unpinned selection sends no provider block', async () => {
  // Catches: an empty or default block on every check, which changes how unpinned selections are served.
  const bodies: Array<Record<string, unknown>> = [];
  await setAgentModel(deps(installed(), 200, bodies), 'dev', MODEL, undefined, 'opencode');
  assert.equal(Object.hasOwn(bodies[0], 'provider'), false);
});

test('a pin the provider refuses is not saved', async () => {
  // Catches: the pin stored after a check that never used it, then every run of the agent failing at OpenRouter.
  const dir = installed();
  const result = await setAgentModel(deps(dir, 404, []), 'dev', MODEL, undefined, 'opencode', 'deepinfra');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'model-rejected');
  assert.equal(readKeysFile(dir).subharness.models?.dev, undefined);
});

// src/subharness/control.ts#routeOfAgent: the path of an agent the core puts inside a task, as keys.json holds it now.

test('the route of an agent is its backend, model, effort and mode as keys.json holds them', () => {
  // Catches: one of the four fields comes from elsewhere, so the runner runs another path than the status shows.
  const dir = tempDir('nep-route-');
  writeKeysFile(dir, {
    subharness: {
      backends: ['codex', 'claude'],
      key: null,
      modes: { scout: 'full' },
      models: { scout: 'claude-opus-5-5', server: 'gpt-6-sol' },
      efforts: { scout: 'high' },
      uses: { scout: 'claude' },
    },
  });
  assert.deepEqual(control.routeOfAgent(dir, 'scout'), {
    backend: 'claude',
    model: 'claude-opus-5-5',
    effort: 'high',
    mode: 'full',
  });
});

test('an agent has no route while nothing is connected', () => {
  // Catches: an empty switch yields a route with a null backend, which the runner refuses as bad-route instead of subharness-off.
  const dir = tempDir('nep-route-');
  writeKeysFile(dir, { subharness: { backends: [], key: null, modes: {} } });
  assert.equal(control.routeOfAgent(dir, 'scout'), null);
});

// src/subharness/control.ts: the thinker is an agent of the subharness like the others: it takes a backend, a model and
// an effort, the status lists it, and it runs in `write` by default. keys.json lives in a temp dir; the backend runner
// and its `--help` are fakes.

function thinkerRig() {
  const dir = tempDir('nep-thinker-');
  // Changed: the thinker's source is seeded in the store, and a selection reads the real source.
  writeKeysFile(dir, { subharness: { key: null, modes: {}, models: {}, uses: { thinker: 'claude' } } });
  fakeVendor(dir, 'codex', { loggedIn: true });
  fakeVendor(dir, 'claude', { loggedIn: true });
  const ran: Array<{ name: string; model: string | undefined; effort: string | undefined }> = [];
  const deps: EnableDeps = {
    privateDir: dir,
    runBackend: (name, _brief, model, effort) => {
      ran.push({ name, model, effort });
      return Promise.resolve({ ok: true, text: 'ok', exitCode: 0 });
    },
    fetch: () => Promise.resolve(new Response('{}', { status: 200 })),
    helpOf: () => Promise.resolve('Usage: claude [options]\n  --model <model>\n  --effort <level>\n'),
  };
  return { dir, deps, ran };
}

test('a selection through a source takes the thinker', async () => {
  // Catches: "/model set thinker <model> --via codex" is refused unknown-agent, so the thinker has no path of its own.
  // Changed: `subharness use` left the family, and --via is what names a source.
  const { dir, deps } = thinkerRig();
  const result = await setAgentModel(deps, 'thinker', 'gpt-6-sol', undefined, 'codex');
  assert.equal(result.ok, true);
  assert.equal(readKeysFile(dir).subharness.uses?.thinker, 'codex');
});

test('model set takes the thinker with an effort, after one reply through its backend', async () => {
  // Catches: the model of the thinker cannot be set, or it is checked on the first connected backend and not on claude.
  const { dir, deps, ran } = thinkerRig();
  const result = await setAgentModel(deps, 'thinker', 'claude-opus-5-5', 'medium');
  assert.equal(result.ok, true);
  assert.deepEqual(ran, [{ name: 'claude', model: 'claude-opus-5-5', effort: 'medium' }]);
  const stored = readKeysFile(dir).subharness;
  assert.equal(stored.models?.thinker, 'claude-opus-5-5');
  assert.equal(stored.efforts?.thinker, 'medium');
});

test('the paths list the thinker with its backend, model and effort', async () => {
  // Catches: the thinker runs on a path no caller of agentPaths can see.
  const { dir, deps } = thinkerRig();
  await setAgentModel(deps, 'thinker', 'claude-opus-5-5', 'medium');
  assert.deepEqual(
    agentPaths(dir).find((one) => String(one.agent) === 'thinker'),
    { agent: 'thinker', backend: 'claude', model: 'claude-opus-5-5', effort: 'medium' }
  );
});

test('the status lists the thinker in write with its backend, model and effort', async () => {
  // Catches: the owner reads the status and cannot see which CLI and model the thinker runs on.
  const { dir, deps } = thinkerRig();
  await setAgentModel(deps, 'thinker', 'claude-opus-5-5', 'medium');
  const text = statusText(await subharnessView(dir), agentPaths(dir));
  const row = text.split('\n').find((line) => line.startsWith('  thinker ')) ?? '';
  for (const word of ['write', 'claude', 'claude-opus-5-5', 'medium'])
    assert.ok(row.includes(word), `${word} on "${row}"`);
});

test('a reply check through claude runs with native thinking off while llm.subscription.thinking is false', () => {
  // Catches: the memory probe and the other one-reply checks running claude with its native thinking on.
  const options = replyCheckOptions({
    backend: 'claude',
    model: 'claude-opus-4-6',
    effort: 'medium',
    config: { llm: { subscription: { thinking: false } } },
    cwd: '/tmp',
  });
  assert.equal(options.env?.MAX_THINKING_TOKENS, '0');
  assert.equal(options.effort, 'medium');
});

test('a reply check through claude keeps native thinking while llm.subscription.thinking is true', () => {
  // Catches: the check forcing the switch off whatever the owner set.
  const options = replyCheckOptions({
    backend: 'claude',
    config: { llm: { subscription: { thinking: true } } },
    cwd: '/tmp',
  });
  assert.equal(options.env?.MAX_THINKING_TOKENS, undefined);
});
