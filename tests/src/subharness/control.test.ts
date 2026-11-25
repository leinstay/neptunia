// src/subharness/control.ts: the owner's settings of the subharness roles over keys.json. The result has the shape of
// Hermes' ApprovalModeResult (hermes_cli/approval_mode.py): ok, a code, whether anything changed, and a message. The
// sources are disposable fake CLIs, no request goes out and keys.json lives in a temp dir.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as control from '../../../src/subharness/control.ts';
import {
  agentPaths,
  setUnitMode,
  setAgentModel,
  statusText,
  subharnessView,
  routeOfAgent,
} from '../../../src/subharness/control.ts';
import type { EnableDeps } from '../../../src/subharness/control.ts';
import { readRouting } from '../../../src/subharness/routing.ts';
import { subharnessPlace } from '../../../src/subharness/place.ts';
import { withCapturedLogs } from '../../fixtures/capture-logs.ts';
import { readKeysFile, writeKeysFile } from '../../fixtures/keys-file.ts';
import { fakeVendor } from '../../fixtures/fake-vendor.ts';
import { tempDir } from '../../fixtures/tmp.ts';
import type { EffortLevel } from '../../../src/llm/roles.ts';

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
  // Off is a store with no source named for any agent, and the view lists every source as it stands.
  assert.deepEqual(readRouting(dir).subharness.uses, {});
  const view = await subharnessView(dir);
  assert.equal(view.key, null);
  // The modes belong to the units, `server` reading and `scout` and `code` writing by default.
  assert.deepEqual(view.modes, { server: 'read', scout: 'write', code: 'write' });
  assert.equal(
    view.sources.some((one) => one.available),
    false
  );
});

test('no result, log line or status text holds a key value', async () => {
  // Bug: the check logs the request headers, or the status prints the key it shows the name of.
  // The key is seeded, and the selection through opencode is what spends it.
  const { deps } = rig();
  const failing: EnableDeps = { ...deps, fetch: () => Promise.reject(new Error(`connect failed for ${SECRET}`)) };
  const { result, logs } = await withCapturedLogs(async () => {
    const results = [
      await setAgentModel(deps, 'server', 'vendor/model', undefined, 'opencode'),
      await setAgentModel(failing, 'server', 'vendor/other', undefined, 'opencode'),
    ];
    const status = statusText(await subharnessView(deps.privateDir), agentPaths(deps.privateDir));
    return { results, status };
  });
  const seen = JSON.stringify([result, logs]);
  assert.equal(seen.includes(SECRET), false);
  assert.equal(seen.includes(CORE_SECRET), false);
  assert.ok(result.status.includes('opencode'), 'the status names the key');
  const [passed, refused] = result.results;
  assert.equal(passed?.ok, true);
  assert.equal(refused?.ok, false);
});

test('mode sets one unit and leaves the other at what it was', async () => {
  // Bug: writing the whole modes map from defaults overwrites the other unit's choice.
  const dir = tempDir('nep-subharness-');
  writeKeysFile(dir);
  await setUnitMode(dir, 'scout', 'read');
  const result = await setUnitMode(dir, 'server', 'sudo');
  assert.equal(result.ok, true);
  assert.equal(result.changed, true);
  // A mode belongs to a unit, so the view holds the three units.
  assert.deepEqual((await subharnessView(dir)).modes, { server: 'sudo', scout: 'read', code: 'write' });
});

test('mode with no value reports the current mode and writes nothing', async () => {
  // Bug: an inspection (Hermes /approvals without an argument) changes the setting it was asked to show.
  const dir = tempDir('nep-subharness-');
  writeKeysFile(dir);
  const result = await setUnitMode(dir, 'scout');
  assert.equal(result.ok, true);
  assert.equal(result.changed, false);
  assert.equal(result.mode, 'write');
  assert.deepEqual(readKeysFile(dir).subharness.modes, {});
});

test('an unknown unit or mode is refused and the file is not touched', async () => {
  // Bug: "root" or "thinker" is written into keys.json and read later as a mode no code maps to a flag.
  const dir = tempDir('nep-subharness-');
  writeKeysFile(dir);
  assert.equal((await setUnitMode(dir, 'scout', 'root')).code, 'unknown-mode');
  // A mode is set per unit, so a name that is no unit is refused as such.
  assert.equal((await setUnitMode(dir, 'web', 'read')).code, 'unknown-unit');
  assert.deepEqual(readKeysFile(dir).subharness.modes, {});
});

test('a stored mode that is no mode reads as the default, never as an unsandboxed one', async () => {
  // Bug: a hand-edited or damaged value such as "root" is passed on and an agent runs with more than the owner gave it.
  const dir = tempDir('nep-subharness-');
  // Modes are stored per unit, so the damaged value is the server unit's, default `read`.
  writeKeysFile(dir, { subharness: { backend: 'codex', key: null, modes: { server: 'root', scout: 'sudo' } } });
  const view = await subharnessView(dir);
  assert.equal(view.modes.server, 'read');
  assert.equal(view.modes.scout, 'sudo');
});

test('the status text names the backend, the key name and every agent with its mode', async () => {
  // Bug: the status leaves out an agent, so a sudo mode is set and nobody sees it.
  // The status takes each agent's path, and opencode reads as a source by its seeded key.
  const { dir } = rig();
  await setUnitMode(dir, 'server', 'sudo');
  const text = statusText(await subharnessView(dir), agentPaths(dir));
  // Each unit carries its agent's name.
  for (const word of ['opencode', 'scout', 'code', 'server', 'sudo']) assert.ok(text.includes(word), word);
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
  const result = await setAgentModel(
    deps(installed(), 200, bodies),
    'server',
    MODEL,
    undefined,
    'opencode',
    'anthropic'
  );
  assert.equal(result.ok, true, result.message);
  assert.equal(bodies.length, 1);
  assert.deepEqual(bodies[0].provider, { order: ['anthropic'], allow_fallbacks: false });
});

test('the check of an unpinned selection sends no provider block', async () => {
  // Catches: an empty or default block on every check, which changes how unpinned selections are served.
  const bodies: Array<Record<string, unknown>> = [];
  await setAgentModel(deps(installed(), 200, bodies), 'server', MODEL, undefined, 'opencode');
  assert.equal(Object.hasOwn(bodies[0], 'provider'), false);
});

test('a pin the provider refuses is not saved', async () => {
  // Catches: the pin stored after a check that never used it, then every run of the agent failing at OpenRouter.
  const dir = installed();
  const result = await setAgentModel(deps(dir, 404, []), 'server', MODEL, undefined, 'opencode', 'deepinfra');
  assert.equal(result.ok, false);
  assert.equal(result.code, 'model-rejected');
  assert.equal(readKeysFile(dir).subharness.models?.server, undefined);
});

// src/subharness/control.ts#routeOfAgent: the path of an agent the core puts inside a task, as keys.json holds it now.

test('the route of an agent is its backend, model, effort and mode as keys.json holds them', () => {
  // Catches: one of the four fields comes from elsewhere, so the runner runs another path than the status shows.
  const dir = tempDir('nep-route-');
  writeKeysFile(dir, {
    subharness: {
      backends: ['codex', 'claude'],
      key: null,
      // A mode is stored per unit, and the scout runs in the unit of its name.
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

/** A private layer with claude logged in, and a backend runner that records the effort of each reply check. */
function effortRig() {
  const privateDir = tempDir('nep-effort-facts-');
  writeKeysFile(privateDir, { subharness: { key: null, modes: {}, uses: {} } });
  fakeVendor(privateDir, 'claude', { loggedIn: true });
  const runs: Array<unknown> = [];
  const deps: EnableDeps = {
    privateDir,
    runBackend: (_name, _brief, _model, effort) => {
      runs.push(effort);
      return Promise.resolve({ ok: true, text: 'ok', exitCode: 0 });
    },
    fetch: () => Promise.resolve(new Response('{}', { status: 200 })),
  };
  return { deps, privateDir, runs };
}

test('the setter stores a level claude takes for an agent', async () => {
  // Catches: the chooser offering max and the setter refusing it after the confirmation.
  const { deps, privateDir, runs } = effortRig();
  const agent = await setAgentModel(deps, 'server', 'opus', 'max', 'claude');
  assert.equal(agent.ok, true, agent.message);
  assert.deepEqual(runs, ['max']);
  assert.equal(readKeysFile(privateDir).subharness.efforts?.server, 'max');
});

test('the setter refuses xhigh on opencode and runs nothing', async () => {
  // Catches: a level no opencode model was surveyed for saved, so the agent's next real run fails on its variant.
  const { deps, privateDir, runs } = effortRig();
  const answer = await setAgentModel(deps, 'server', 'openrouter/vendor/text-1', 'xhigh', 'opencode');
  assert.equal(answer.code, 'unknown-effort');
  assert.deepEqual(runs, []);
  assert.equal(readKeysFile(privateDir).subharness.efforts?.server, undefined);
});

test('the word default clears an agent effort after its reply check', async () => {
  // Catches: the chooser's "model default" leaving the old level in force, because omission keeps it.
  const { deps, privateDir } = effortRig();
  await setAgentModel(deps, 'server', 'opus', 'high', 'claude');
  const answer = await setAgentModel(deps, 'server', 'opus', 'default');
  assert.equal(answer.ok, true, answer.message);
  assert.equal(readKeysFile(privateDir).subharness.efforts?.server, undefined);
});

// The model id of an agent on opencode: opencode names a model by its provider, and the one provider it has is
// OpenRouter (it gets OPENROUTER_API_KEY and nothing else), so `opencode run -m google/x` exits 1 where
// `-m openrouter/google/x` answers. A typed `/model set <agent> <id> --via opencode` stores the id with `openrouter/`, and
// a bare id already in keys.json or in a task's route runs with it. The binaries are fakes, no request goes out.

const OPENCODE_KEY = 'sk-or-v1-helpers-fake-0123456789';

/** A private dir whose opencode is installed and logged in on the extra key `helpers`, with the scout's stored path. */
function opencodeInstalled(models: Record<string, string> = {}): string {
  const dir = tempDir('nep-oc-model-');
  writeKeysFile(dir, {
    extra: { helpers: OPENCODE_KEY },
    subharness: { key: 'helpers', modes: {}, models, uses: { scout: 'opencode' } },
  });
  const { binary } = subharnessPlace(dir, 'opencode');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, '#!/bin/sh\nexit 9\n', { mode: 0o755 });
  return dir;
}

const selectionDeps = (dir: string): EnableDeps => ({
  privateDir: dir,
  baseUrl: 'https://openrouter.test/api/v1',
  runBackend: () => Promise.resolve({ ok: true, text: 'ok', exitCode: 0 }),
  fetch: () => Promise.resolve(new Response('{}', { status: 200 })),
});

test('a typed opencode model with no provider prefix is stored with openrouter/', async () => {
  // Bug: `/model set scout google/gemini-4-argon --via opencode` stores the bare id, and every scout run exits 1.
  const dir = opencodeInstalled();
  const result = await setAgentModel(selectionDeps(dir), 'scout', 'google/gemini-4-argon', undefined, 'opencode');
  assert.equal(result.ok, true, result.message);
  assert.equal(readRouting(dir).subharness.models.scout, 'openrouter/google/gemini-4-argon');
});

test('a typed opencode model that already names openrouter is stored as typed', async () => {
  // Bug: the prefix is added twice, `openrouter/openrouter/...`, which opencode cannot resolve either.
  const dir = opencodeInstalled();
  const result = await setAgentModel(
    selectionDeps(dir),
    'scout',
    'openrouter/google/gemini-4-argon',
    undefined,
    'opencode'
  );
  assert.equal(result.ok, true, result.message);
  assert.equal(readRouting(dir).subharness.models.scout, 'openrouter/google/gemini-4-argon');
});

/** Deps whose backend answers only for the models in `good`; every model asked is recorded. */
function modelRig(good: ReadonlyArray<string>) {
  const dir = tempDir('nep-models-');
  writeKeysFile(dir, { extra: { opencode: SECRET } });
  const asked: Array<string | undefined> = [];
  const deps: EnableDeps = {
    privateDir: dir,
    runBackend: (_name, _brief, model) => {
      asked.push(model);
      const ok = model === undefined || good.includes(model);
      return Promise.resolve({ ok, text: ok ? 'ok' : '', exitCode: ok ? 0 : 1 });
    },
    fetch: () => Promise.resolve(new Response('{}', { status: 200 })),
  };
  return { dir, deps, asked };
}

test('subharness model checks the model and stores it for one agent, and status shows it', async () => {
  // Bug: "model" writes without a reply, or the status leaves the model out.
  const { dir, deps } = modelRig(['opus']);
  // The selection reads the real source, and the status reads each agent's path.
  writeKeysFile(dir, { extra: {}, subharness: { backend: 'claude', key: null, modes: {}, models: {} } });
  fakeVendor(dir, 'claude', { loggedIn: true });
  assert.equal((await setAgentModel(deps, 'server', 'nope')).ok, false);
  assert.equal((await setAgentModel(deps, 'server', 'opus')).ok, true);
  assert.equal(readKeysFile(dir).subharness.models?.server, 'opus');
  assert.ok(statusText(await subharnessView(dir), agentPaths(dir)).includes('opus'));
});

// A path per role on the subharness side (spec 2026-11-02 PR 5, "A path per role"): `model set <agent> <model> [--effort
// <level>]` names its model and effort after one reply on the source the store names for it, the status lists each agent's path, and the six direct roles have no subharness path. keys.json lives
// in a temp dir; the backend runner and fetch are fakes, so no process starts and no request goes out.
// Changed: the agent `dev` is gone with the development agents (maintainer, 2026-11-16),
// so the agent checks use `server`.

type Ran = { name: string; model: string | undefined; effort: EffortLevel | undefined };

/** keys.json with codex and claude connected; the runner answers for every model but `bad-model`. */
function subharnessPathsRig(options: { backends?: Array<'codex' | 'claude' | 'opencode'> } = {}) {
  const dir = tempDir('nep-paths-');
  writeKeysFile(dir, {
    subharness: { backends: options.backends ?? ['codex', 'claude'], key: null, modes: {}, models: {}, uses: {} },
  });
  // Changed: a selection reads the real source, so each backend a rig calls connected is installed and logged in.
  for (const backend of options.backends ?? (['codex', 'claude'] as const))
    if (backend !== 'opencode') fakeVendor(dir, backend, { loggedIn: true });
  const ran: Array<Ran> = [];
  const deps: EnableDeps = {
    privateDir: dir,
    runBackend: (name, _brief, model, effort) => {
      ran.push({ name, model, effort });
      const ok = model !== 'bad-model';
      return Promise.resolve({ ok, text: ok ? 'ok' : '', exitCode: ok ? 0 : 1 });
    },
    fetch: () => Promise.resolve(new Response('{}', { status: 200 })),
  };
  return { dir, deps, ran };
}

/** Names the source of one agent in the store, as a selection leaves it. */
function seedUses(dir: string, agent: string, backend: 'codex' | 'claude'): void {
  const stored = readKeysFile(dir);
  writeKeysFile(dir, {
    ...stored,
    subharness: { ...stored.subharness, uses: { ...stored.subharness.uses, [agent]: backend } },
  });
}

// model set for an agent

test('model set with an effort checks one reply on that model and effort, then stores both', async () => {
  // Catches: the effort is stored without the reply check, or the check runs without the effort it will run at.
  const { dir, deps, ran } = subharnessPathsRig();
  seedUses(dir, 'server', 'codex');
  const result = await setAgentModel(deps, 'server', 'gpt-6.1-sol', 'high');
  assert.equal(result.ok, true);
  assert.deepEqual(ran, [{ name: 'codex', model: 'gpt-6.1-sol', effort: 'high' }]);
  const stored = readKeysFile(dir).subharness;
  assert.equal(stored.models?.server, 'gpt-6.1-sol');
  assert.equal(stored.efforts?.server, 'high');
});

test('model set checks through the backend the agent uses, not the first connected one', async () => {
  // Catches: the check runs on codex while the agent runs on claude, so a claude-only model is refused.
  const { dir, deps, ran } = subharnessPathsRig();
  seedUses(dir, 'scout', 'claude');
  await setAgentModel(deps, 'scout', 'claude-opus-5-5');
  assert.equal(ran[0]?.name, 'claude');
});

test('a model whose reply check fails keeps the model and the effort stored before', async () => {
  // Catches: the effort written before the check, left beside the old model when the new one is refused.
  const { dir, deps } = subharnessPathsRig();
  await setAgentModel(deps, 'server', 'gpt-6.1-sol', 'high');
  const result = await setAgentModel(deps, 'server', 'bad-model', 'low');
  assert.equal(result.ok, false);
  const stored = readKeysFile(dir).subharness;
  assert.equal(stored.models?.server, 'gpt-6.1-sol');
  assert.equal(stored.efforts?.server, 'high');
});

test('an effort that is no level is refused before anything runs', async () => {
  // Catches: a word that is no level passed to the CLI, which refuses it at the agent's next real run.
  // Changed: codex takes `max` by the survey in src/subharness/models.ts, so the word is one no backend takes.
  const { dir, deps, ran } = subharnessPathsRig();
  const result = await setAgentModel(deps, 'server', 'gpt-6.1-sol', 'turbo');
  assert.equal(result.code, 'unknown-effort');
  assert.deepEqual(ran, []);
  assert.deepEqual(readKeysFile(dir).subharness.models, {});
});

test('claude takes an effort and runs the check at it', async () => {
  // Catches: every effort on claude refused, or the level dropped from the check.
  const { dir, deps, ran } = subharnessPathsRig();
  seedUses(dir, 'server', 'claude');
  const result = await setAgentModel(deps, 'server', 'claude-opus-5-5', 'medium');
  assert.equal(result.ok, true);
  assert.deepEqual(ran, [{ name: 'claude', model: 'claude-opus-5-5', effort: 'medium' }]);
  assert.equal(readKeysFile(dir).subharness.efforts?.server, 'medium');
});

test('a model set without an effort keeps the effort stored before', async () => {
  // Catches: changing the model wipes the effort the owner set, and the agent drops to the CLI's default.
  const { dir, deps } = subharnessPathsRig();
  await setAgentModel(deps, 'server', 'gpt-6.1-sol', 'high');
  await setAgentModel(deps, 'server', 'gpt-6-sol');
  const stored = readKeysFile(dir).subharness;
  assert.equal(stored.models?.server, 'gpt-6-sol');
  assert.equal(stored.efforts?.server, 'high');
});

// The OpenRouter provider of an opencode route: `/model set <agent> <model> --via opencode --provider <slug>` stores it
// in keys.json (`subharness.providers`, by agent), `/subharness status` shows it, `routeOfAgent` puts it into the task's
// route, and `runAgent` hands it to the backend. The binaries are fakes, no request goes out.
// Changed: the agent `dev` is gone with the development agents (maintainer, 2026-11-16),
// so the agent checks use `server`.

const KEY = 'sk-or-v1-provider-fake-0123456789';
const SUBHARNESS_PROVIDER_MODEL = 'anthropic/claude-sonnet-5';

/** The providers keys.json holds, by agent; the section is absent while nobody pinned one. */
const providersOf = (dir: string): unknown => (readKeysFile(dir).subharness as Record<string, unknown>).providers;

/** A private dir whose opencode is installed and logged in on the extra key `helpers`. */
function subharnessProviderInstalled(): string {
  const dir = tempDir('nep-provider-');
  writeKeysFile(dir, { extra: { helpers: KEY }, subharness: { key: 'helpers', modes: {} } });
  const { binary } = subharnessPlace(dir, 'opencode');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, '#!/bin/sh\nexit 9\n', { mode: 0o755 });
  return dir;
}

const subharnessProviderSelectionDeps = (dir: string): EnableDeps => ({
  privateDir: dir,
  baseUrl: 'https://openrouter.test/api/v1',
  runBackend: () => Promise.resolve({ ok: true, text: 'ok', exitCode: 0 }),
  fetch: () => Promise.resolve(new Response('{}', { status: 200 })),
});

// setAgentModel

test('setAgentModel stores the provider of an opencode route beside its model', async () => {
  // Catches: `--provider` accepted and dropped, so the route is written without the pin the owner asked for.
  const dir = subharnessProviderInstalled();
  const result = await setAgentModel(
    subharnessProviderSelectionDeps(dir),
    'server',
    SUBHARNESS_PROVIDER_MODEL,
    undefined,
    'opencode',
    'anthropic'
  );
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(providersOf(dir), { server: 'anthropic' });
  assert.equal(readKeysFile(dir).subharness.models?.server, `openrouter/${SUBHARNESS_PROVIDER_MODEL}`);
});

test('the answer of a pinned selection says which provider the agent is pinned to', async () => {
  // Catches: the owner sets a pin and the reply reads like an unpinned selection, so the owner cannot tell it took.
  const dir = subharnessProviderInstalled();
  const result = await setAgentModel(
    subharnessProviderSelectionDeps(dir),
    'server',
    SUBHARNESS_PROVIDER_MODEL,
    undefined,
    'opencode',
    'google-vertex'
  );
  assert.ok(result.message.includes('google-vertex'), result.message);
});

test('a model set with no provider drops the provider stored for that agent', async () => {
  // Catches: a provider chosen for one model staying on the next model, which that provider may not serve at all.
  const dir = subharnessProviderInstalled();
  await setAgentModel(
    subharnessProviderSelectionDeps(dir),
    'server',
    SUBHARNESS_PROVIDER_MODEL,
    undefined,
    'opencode',
    'anthropic'
  );
  assert.deepEqual(providersOf(dir), { server: 'anthropic' }, 'the pin was stored first');
  const result = await setAgentModel(
    subharnessProviderSelectionDeps(dir),
    'server',
    'deepseek/deepseek-v4',
    undefined,
    'opencode'
  );
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(providersOf(dir) ?? {}, {});
});

test('a provider of one agent is not stored for another', async () => {
  // Catches: the providers held in one slot, so dev's pin also pins scout.
  const dir = subharnessProviderInstalled();
  await setAgentModel(
    subharnessProviderSelectionDeps(dir),
    'server',
    SUBHARNESS_PROVIDER_MODEL,
    undefined,
    'opencode',
    'anthropic'
  );
  await setAgentModel(
    subharnessProviderSelectionDeps(dir),
    'scout',
    'deepseek/deepseek-v4',
    undefined,
    'opencode',
    'deepinfra'
  );
  assert.deepEqual(providersOf(dir), { server: 'anthropic', scout: 'deepinfra' });
});

test('moving an agent to claude drops its provider', async () => {
  // Catches: a stale pin kept under a backend that cannot honour it, which the next route then refuses as bad-route.
  const dir = subharnessProviderInstalled();
  fakeVendor(dir, 'claude', { loggedIn: true });
  await setAgentModel(
    subharnessProviderSelectionDeps(dir),
    'server',
    SUBHARNESS_PROVIDER_MODEL,
    undefined,
    'opencode',
    'anthropic'
  );
  assert.deepEqual(providersOf(dir), { server: 'anthropic' }, 'the pin was stored first');
  const result = await setAgentModel(subharnessProviderSelectionDeps(dir), 'server', 'sonnet', undefined, 'claude');
  assert.equal(result.ok, true, result.message);
  assert.deepEqual(providersOf(dir) ?? {}, {});
});

for (const backend of ['claude', 'codex'] as const) {
  test(`a provider with --via ${backend} is refused as provider-unsupported and writes nothing`, async () => {
    // Catches: a pin stored for a backend that has no such control, so it is ignored without a word.
    const dir = subharnessProviderInstalled();
    fakeVendor(dir, backend, { loggedIn: true });
    const before = JSON.stringify(readKeysFile(dir));
    const result = await setAgentModel(
      subharnessProviderSelectionDeps(dir),
      'server',
      'sonnet',
      undefined,
      backend,
      'anthropic'
    );
    assert.equal(result.ok, false);
    assert.equal(result.code, 'provider-unsupported');
    assert.equal(JSON.stringify(readKeysFile(dir)), before);
  });
}

test('a provider on an agent whose stored source is claude is refused when --via is left out', async () => {
  // Catches: the check looking at `--via` alone, so a pin slips onto an agent that already runs through claude.
  const dir = subharnessProviderInstalled();
  fakeVendor(dir, 'claude', { loggedIn: true });
  await setAgentModel(subharnessProviderSelectionDeps(dir), 'server', 'sonnet', undefined, 'claude');
  const result = await setAgentModel(
    subharnessProviderSelectionDeps(dir),
    'server',
    'opus',
    undefined,
    undefined,
    'anthropic'
  );
  assert.equal(result.code, 'provider-unsupported');
});

for (const provider of ['two words', '--flag', 'Upper']) {
  test(`setAgentModel refuses the provider ${JSON.stringify(provider)} as bad-provider and writes nothing`, async () => {
    // Catches: a free-form string stored and later written into the child's config.
    const dir = subharnessProviderInstalled();
    const before = JSON.stringify(readKeysFile(dir));
    const result = await setAgentModel(
      subharnessProviderSelectionDeps(dir),
      'server',
      SUBHARNESS_PROVIDER_MODEL,
      undefined,
      'opencode',
      provider
    );
    assert.equal(result.code, 'bad-provider');
    assert.equal(JSON.stringify(readKeysFile(dir)), before);
  });
}

// the route

test('the route of an agent carries the provider stored for it', async () => {
  // Catches: the pin kept in keys.json and never put into the task, so every errand runs unpinned.
  const dir = subharnessProviderInstalled();
  await setAgentModel(
    subharnessProviderSelectionDeps(dir),
    'server',
    SUBHARNESS_PROVIDER_MODEL,
    undefined,
    'opencode',
    'anthropic'
  );
  assert.deepEqual(routeOfAgent(dir, 'server'), {
    backend: 'opencode',
    model: `openrouter/${SUBHARNESS_PROVIDER_MODEL}`,
    effort: null,
    // Changed: the agent is the server, whose default mode is `read`, the agent `dev` being gone (2026-11-16).
    mode: 'read',
    provider: 'anthropic',
  });
});

test('the route of an agent with no provider has no provider key', () => {
  // Catches: a null or undefined provider on every route, which the strict route parser then refuses as bad-route.
  const dir = subharnessProviderInstalled();
  const stored = readKeysFile(dir);
  writeKeysFile(dir, {
    ...stored,
    subharness: {
      ...stored.subharness,
      uses: { server: 'opencode' },
      models: { server: `openrouter/${SUBHARNESS_PROVIDER_MODEL}` },
    },
  });
  assert.deepEqual(Object.keys(routeOfAgent(dir, 'server') ?? {}).sort(), ['backend', 'effort', 'mode', 'model']);
});
