// The routes are named by what runs them (brief 2026-11-06 "the routes are named by what runs them"): `direct-api` for
// the OpenRouter API, `claude-harness`, `codex-harness` and `opencode-harness` for the three CLIs. The owner reads and
// types these four names; keys.json keeps `backend: "claude"` and the rest. The mapping lives in
// src/subharness/route-names.ts and is applied at the edge: the status rows, the answers of `/model set` and the
// `--via` value. keys.json lives in a temp dir; the backend runner, its `--help` and fetch are fakes.
import fs from 'node:fs';
import path from 'node:path';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ROUTE_NAMES, backendOfRouteName, routeName } from '../src/subharness/route-names.ts';
import { clearSubscriptionPath, subscriptionPath, subscriptionPathText } from '../src/subharness/subscription-path.ts';
import type { EnableDeps } from '../src/subharness/control.ts';
import { subharnessCommand } from '../src/interface/commands/subharness.ts';
import { createConsole } from '../src/interface/commands/console.ts';
import type { Answer, ConsoleDeps } from '../src/interface/commands/console.ts';
import { createKeysCommands } from '../src/keys/commands.ts';
import { createKeyRing } from '../src/keys/ring.ts';
import { createKeyStore } from '../src/keys/store.ts';
import { createKeyFailover } from '../src/llm/key-failover.ts';
import { BASE_URL, SECRET, fakeFetch, fakePause, healthy } from './fixtures/keys-rig.ts';
import { readKeysFile, writeKeysFile } from './fixtures/keys-file.ts';
import type { KeysFile } from './fixtures/keys-file.ts';
import { fakeVendor } from './fixtures/fake-vendor.ts';
import { tempDir } from './fixtures/tmp.ts';
import { subharnessPlace } from '../src/subharness/place.ts';

type Route = 'api' | 'claude' | 'codex' | 'opencode';
const ROUTES: ReadonlyArray<Route> = ['api', 'claude', 'codex', 'opencode'];
const FOUR_NAMES = ['direct-api', 'claude-harness', 'codex-harness', 'opencode-harness'];
const HELP_WITH_EFFORT = 'Usage: claude [options]\n  --model <model>\n  --effort <level>  reasoning effort\n';
const OWNER = { id: 'owner' };

type Ran = { name: string; model: string | undefined };

/** keys.json with `subharness` laid over; claude and codex are installed and logged in, the runner answers every model. */
function rig(subharness: Partial<KeysFile['subharness']> = {}) {
  const dir = tempDir('nep-route-names-');
  writeKeysFile(dir, { subharness: { key: null, modes: {}, models: {}, uses: {}, ...subharness } });
  for (const backend of ['claude', 'codex'] as const) fakeVendor(dir, backend, { loggedIn: true });
  const ran: Array<Ran> = [];
  const deps: EnableDeps = {
    privateDir: dir,
    runBackend: (name, _brief, model) => {
      ran.push({ name, model });
      return Promise.resolve({ ok: true, text: 'ok', exitCode: 0 });
    },
    fetch: () => Promise.resolve(new Response('{}', { status: 200 })),
    helpOf: () => Promise.resolve(HELP_WITH_EFFORT),
  };
  return { dir, deps, ran };
}

/** The words of the status line that starts with two spaces and `name`. */
const wordsOf = (text: string, name: string): Array<string> =>
  (text.split('\n').find((line) => line.startsWith(`  ${name} `)) ?? '').trim().split(/\s+/);

/** A console over `deps`; `keys` answers the key commands, or `keys answered` when absent. */
function consoleOver(dir: string, deps: EnableDeps, keys?: NonNullable<ConsoleDeps['keys']>) {
  const consoleDeps: ConsoleDeps = {
    runOp: () => Promise.resolve({ status: 'ok', code: '', summary: '', data: null }),
    ownerReads: { lessons: () => '', aliases: () => '' },
    places: () => ['g1'],
    selfId: () => 'self-1',
    hot: { config: { bot: { owners: [] } } },
    privateDir: dir,
    dataDir: dir,
    memoryDb: null,
    usage: null,
    metrics: null,
    chatLines: () => [],
    now: () => 0,
    keys: keys ?? { enabled: () => true, run: () => Promise.resolve({ text: 'keys answered', status: 'ok' }) },
    subharness: {
      runBackend: (...args) => deps.runBackend(...args),
      fetch: (...args) => deps.fetch(...args),
      helpOf: (...args: Parameters<NonNullable<EnableDeps['helpOf']>>) => deps.helpOf!(...args),
    },
  };
  return createConsole(consoleDeps);
}

// the mapping

test('routeName and backendOfRouteName are inverse for the four routes', () => {
  // Catches: a name that renders but cannot be typed back, so the owner copies `via claude-harness` and is refused.
  assert.deepEqual(
    ROUTES.map((backend) => routeName(backend)),
    FOUR_NAMES
  );
  for (const backend of ROUTES) assert.equal(backendOfRouteName(routeName(backend)), backend);
  assert.deepEqual(ROUTE_NAMES, {
    api: 'direct-api',
    claude: 'claude-harness',
    codex: 'codex-harness',
    opencode: 'opencode-harness',
  });
});

test('backendOfRouteName reads an old backend word, an empty word and a stranger as null', () => {
  // Catches: the old words still accepted, so two names for one route live on and the docs cannot say which is right.
  for (const word of ['claude', 'codex', 'opencode', 'api', '', 'claude-harnes', 'harness', 'gemini-harness'])
    assert.equal(backendOfRouteName(word), null, word);
});

test('the route in words names the harness, and direct-api for the API', () => {
  // Catches: the setup line and the script line printing the stored word the owner is told not to type.
  const text = subscriptionPathText({ kind: 'subharness', backend: 'claude', model: 'claude-opus-4-6', effort: 'low' });
  assert.equal(text, 'via claude-harness claude-opus-4-6 effort low');
  assert.equal(subscriptionPathText({ kind: 'api' }), 'direct-api');
});

// what the owner reads

test('subharness status renders via claude-harness for a stored claude route and direct-api for none', async () => {
  // Catches: the core row still saying `via claude`, or `api` where the core has no record.
  const { deps } = rig({ core: { backend: 'claude', model: 'claude-opus-4-6', effort: null } });
  const status = await subharnessCommand(deps, 'subharness.status', {});
  const core = wordsOf(status.text, 'core');
  assert.deepEqual(core.slice(0, 4), ['core', 'via', 'claude-harness', 'claude-opus-4-6']);
  const none = await subharnessCommand(rig().deps, 'subharness.status', {});
  const api = wordsOf(none.text, 'core');
  assert.ok(api.includes('direct-api'), none.text);
  assert.equal(api.includes('api'), false, none.text);
});

test('subharness status renders the memory writer on codex-harness', async () => {
  // Catches: the memory row left on the stored word while the core row moved.
  const { deps } = rig({ memory: { backend: 'codex', model: 'gpt-6.1-sol', effort: null } });
  const status = await subharnessCommand(deps, 'subharness.status', {});
  const memory = wordsOf(status.text, 'memory');
  assert.deepEqual(memory.slice(0, 4), ['memory', 'via', 'codex-harness', 'gpt-6.1-sol']);
});

for (const backend of ['claude', 'codex', 'opencode'] as const) {
  test(`an agent row on ${backend} renders ${backend}-harness in its backend column`, async () => {
    // Catches: the agent rows keeping the stored word, so one status shows two naming schemes side by side.
    const { deps } = rig({ uses: { scout: backend }, models: { scout: 'invented-model' } });
    const status = await subharnessCommand(deps, 'subharness.status', {});
    const scout = wordsOf(status.text, 'scout');
    assert.ok(scout.includes(`${backend}-harness`), status.text);
    assert.equal(scout.includes(backend), false, status.text);
  });
}

test('the stored record keeps its backend word after the status renders the route', async () => {
  // Catches: the rename written back to keys.json, which every reader and the logs still read as `claude`.
  const core = { backend: 'claude', model: 'claude-opus-4-6', effort: null };
  const { dir, deps } = rig({ core });
  await subharnessCommand(deps, 'subharness.status', {});
  assert.deepEqual(readKeysFile(dir).subharness.core, core);
  assert.equal(subscriptionPath(dir, 'core').kind, 'subharness');
});

// what the owner types

test('model set core --via claude-harness stores backend claude and answers in the new name', async () => {
  // Catches: the new name passed on to the backend lookup as is, which refuses it as unknown.
  const { dir, deps, ran } = rig();
  const answer = await consoleOver(dir, deps).run(
    'model.set',
    { role: 'core', via: 'claude-harness', model: 'claude-opus-4-6' },
    OWNER
  );
  assert.equal(answer.status, 'ok', answer.text);
  assert.deepEqual(readKeysFile(dir).subharness.core, {
    backend: 'claude',
    model: 'claude-opus-4-6',
    effort: null,
  });
  assert.deepEqual(ran, [{ name: 'claude', model: 'claude-opus-4-6' }]);
  assert.ok(answer.text.includes('claude-harness'), answer.text);
});

test('model set core --via codex-harness stores backend codex', async () => {
  // Catches: only the claude route taking the new names, while codex still wants the old word.
  const { dir, deps } = rig();
  const answer = await consoleOver(dir, deps).run(
    'model.set',
    { role: 'core', via: 'codex-harness', model: 'gpt-6.1-sol' },
    OWNER
  );
  assert.equal(answer.status, 'ok', answer.text);
  assert.deepEqual(readKeysFile(dir).subharness.core, { backend: 'codex', model: 'gpt-6.1-sol', effort: null });
});

test('model set memory --via claude-harness stores backend claude', async () => {
  // Catches: the memory writer's `--via` left on the old words.
  const { dir, deps } = rig();
  const answer = await consoleOver(dir, deps).run(
    'model.set',
    { role: 'memory', via: 'claude-harness', model: 'claude-opus-4-6' },
    OWNER
  );
  assert.equal(answer.status, 'ok', answer.text);
  assert.deepEqual(readKeysFile(dir).subharness.memory, { backend: 'claude', model: 'claude-opus-4-6', effort: null });
});

test('model set scout --via opencode-harness stores uses opencode for the agent', async () => {
  // Catches: the agent path (setAgentModel) comparing the typed word with the stored names and refusing the new one.
  // The lead: opencode is installed and logged in on an extra key here, as tests/subharness-provider.test.ts does,
  // because the rig installs only claude and codex and the answer was "opencode is not installed".
  const { dir, deps } = rig({ key: 'helpers' });
  const keys = readKeysFile(dir);
  writeKeysFile(dir, { ...keys, extra: { helpers: 'sk-or-invented' } });
  const { binary } = subharnessPlace(dir, 'opencode');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, '#!/bin/sh\nexit 9\n', { mode: 0o755 });
  const answer = await consoleOver(dir, deps).run(
    'model.set',
    { role: 'scout', via: 'opencode-harness', model: 'vendor/invented-model' },
    OWNER
  );
  assert.equal(answer.status, 'ok', answer.text);
  assert.equal(readKeysFile(dir).subharness.uses?.scout, 'opencode');
});

for (const role of ['core', 'memory', 'scout']) {
  for (const old of ['claude', 'codex', 'opencode']) {
    test(`model set ${role} --via ${old} is refused as an unknown backend that names the four names`, async () => {
      // Catches: the old word still accepted, or refused with a code the owner's tools do not know.
      const { dir, deps, ran } = rig();
      const before = JSON.stringify(readKeysFile(dir));
      const answer: Answer = await consoleOver(dir, deps).run(
        'model.set',
        { role, via: old, model: 'invented-model' },
        OWNER
      );
      assert.equal(answer.code, 'unknown-backend', answer.text);
      assert.notEqual(answer.status, 'ok');
      for (const name of FOUR_NAMES) assert.ok(answer.text.includes(name), `${name} in "${answer.text}"`);
      assert.deepEqual(ran, []);
      assert.equal(JSON.stringify(readKeysFile(dir)), before);
    });
  }
}

test('model set core --via direct-api clears the core record, as model set core does', async () => {
  // Catches: `direct-api` refused as an unknown backend, or accepted with no effect so her turns stay on the CLI.
  const { dir, deps, ran } = rig({ core: { backend: 'claude', model: 'claude-opus-4-6', effort: null } });
  const store = createKeyStore({ privateDir: tempDir('nep-route-names-keys-') });
  store.addCore({ name: 'core-1', value: SECRET });
  const ring = createKeyRing({ store, failover: createKeyFailover({ now: () => 0 }) });
  const keys = createKeysCommands({
    store,
    ring,
    fetch: fakeFetch(healthy).fetch,
    baseUrl: () => BASE_URL,
    defaults: {},
    currentModel: (role) => `current/${role}`,
    saveModel: () => Promise.resolve(),
    pause: fakePause(),
    directPath: (role) => {
      if (role === 'core') clearSubscriptionPath(dir, role);
    },
  });
  const desk = consoleOver(dir, deps, {
    enabled: () => true,
    run: (name, args, dialog) => keys.run(name, args, dialog),
  });
  const answer = await desk.run(
    'model.set',
    { role: 'core', via: 'direct-api', model: 'anthropic/claude-opus-4.6' },
    OWNER
  );
  assert.equal(answer.status, 'ok', answer.text);
  assert.deepEqual(subscriptionPath(dir, 'core'), { kind: 'api' });
  assert.deepEqual(ran, []);
});
