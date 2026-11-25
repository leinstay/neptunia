// The core-safe descriptors a model chooser reads (src/subharness/model-capabilities.ts): the role registry, and each
// source of a role with its state, its evidence and its setup commands. Reading sends no model request and returns no
// key value. An `openrouter:` choice cannot run an agent, so for an agent it routes through opencode or stays hidden.
// Fetch and the vendor CLIs are fakes. The agent checks use `server`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

import { modelRoleRegistry, roleSources } from '../../../src/subharness/model-capabilities.ts';
import type { RoleSources, SourceDescriptor } from '../../../src/subharness/model-capabilities.ts';
import { subharnessPlace } from '../../../src/subharness/place.ts';
import type { EnableDeps } from '../../../src/subharness/control.ts';
import { fakeVendor } from '../../fixtures/fake-vendor.ts';
import { writeKeysFile } from '../../fixtures/keys-file.ts';
import type { KeysFile } from '../../fixtures/keys-file.ts';
import { fakeFetch } from '../../fixtures/keys-rig.ts';
import type { Call, Reply } from '../../fixtures/keys-rig.ts';
import { tempDir } from '../../fixtures/tmp.ts';

const BASE = 'https://openrouter.test/api/v1';

const KEY_VALUES = ['or-value-secret', 'oc-value-secret'];

function listing(call: Call): Reply {
  if (!call.url.endsWith('/models')) return { status: 200, body: {} };
  const text = { input_modalities: ['text'], output_modalities: ['text'] };
  return {
    status: 200,
    body: {
      data: [
        { id: 'vendor/text-1', architecture: text },
        { id: 'vendor/voice-1', architecture: { input_modalities: ['text'], output_modalities: ['audio'] } },
      ],
    },
  };
}

function rig(
  answer: (call: Call) => Reply = listing,
  keys: Partial<KeysFile> = {},
  openRouterKey: string | null = KEY_VALUES[0] ?? null
) {
  const privateDir = tempDir('nep-capabilities-');
  writeKeysFile(privateDir, keys);
  const { fetch, calls } = fakeFetch(answer);
  return { privateDir, calls, deps: { privateDir, fetch, baseUrl: BASE, openRouterKey } };
}

/** Puts an opencode binary in place, on the extra key `oc`. */
function withOpencode(): ReturnType<typeof rig> {
  const made = rig(listing, {
    extra: { oc: KEY_VALUES[1] ?? '' },
    subharness: { key: 'oc', modes: {} },
  });
  const { binary } = subharnessPlace(made.privateDir, 'opencode');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  return made;
}

const source = (read: RoleSources, via: SourceDescriptor['via']): SourceDescriptor => {
  const found = read.sources.find((one) => one.via === via);
  assert.ok(found, `a source with via ${String(via)}`);
  return found;
};

// The registry

test('Main lists the eight roles and Voice persists as the speech role', () => {
  // Catches: Voice writing a role `voice` that nothing reads.
  const main = modelRoleRegistry().filter((one) => one.group === 'main');
  assert.deepEqual(
    main.map((one) => one.role),
    ['core', 'drawing', 'speech', 'memory', 'analyzer', 'vision', 'video', 'embedding']
  );
  assert.equal(main.find((one) => one.role === 'speech')?.label, 'Voice');
  assert.equal(
    main.some((one) => one.role === 'voice'),
    false
  );
});

test('Errand comes from the registry', () => {
  // Catches: an errand agent missing from the registry, or a role listed under a group that does not exist.
  // The Development group holds no agent.
  const rows = modelRoleRegistry();
  const roles = (group: string): Array<string> => rows.filter((one) => one.group === group).map((one) => one.role);
  // The agents are read from disk: `code`, `scout` and `server`.
  assert.deepEqual(roles('errand'), ['code', 'scout', 'server']);
  assert.deepEqual(roles('development'), []);
});

// Openrouter for an agent

for (const role of ['scout', 'server']) {
  test(`no source offers ${role} a direct OpenRouter path, which an agent cannot run`, async () => {
    // Catches: `openrouter:x` chosen for an agent and saved as a backend that does not exist.
    const { deps, privateDir } = rig();
    fakeVendor(privateDir, 'claude', { loggedIn: true });
    const read = await roleSources(deps, role);
    assert.equal(
      read.sources.some((one) => one.providerType === 'api'),
      false
    );
    for (const one of read.sources) assert.ok(['claude', 'codex', 'opencode'].includes(String(one.via)), one.id);
  });
}

test("an agent's OpenRouter model routes through opencode when opencode can run, once", async () => {
  // Catches: one model listed twice under two sources that both end in opencode.
  const { deps } = withOpencode();
  const read = await roleSources(deps, 'server');
  const opencode = source(read, 'opencode');
  assert.equal(opencode.code, 'ok');
  assert.deepEqual(
    opencode.models.filter((one) => one.id === 'vendor/text-1').map((one) => one.evidence),
    ['observed']
  );
});

test("an agent's OpenRouter model is hidden while opencode cannot run", async () => {
  // Catches: a listed model with no way to run it, the source missing only on save.
  const { deps, privateDir } = rig();
  fakeVendor(privateDir, 'claude', { loggedIn: true });
  const read = await roleSources(deps, 'server');
  for (const one of read.sources)
    assert.equal(
      one.models.some((model) => model.id === 'vendor/text-1'),
      false,
      one.id
    );
  assert.equal(source(read, 'opencode').code, 'not-installed');
});

// The three kinds of evidence

test('a fixed list is a suggestion, a provider listing is observed', async () => {
  // Catches: a fixed alias list passed off as what this account is entitled to.
  const { deps, privateDir } = rig();
  fakeVendor(privateDir, 'claude', { loggedIn: true });
  const claude = source(await roleSources(deps, 'server'), 'claude');
  assert.equal(claude.listing, 'suggestion');
  assert.ok(claude.models.length > 0);
  assert.ok(claude.models.every((one) => one.evidence === 'suggestion'));
  const api = source(await roleSources(deps, 'analyzer'), null);
  assert.equal(api.listing, 'observed');
  assert.ok(api.models.every((one) => one.evidence === 'observed'));
});

test('each backend offers the levels of its survey, and opencode none past high', async () => {
  // Catches: xhigh offered on opencode, whose models nobody surveyed, or claude and codex held to the global three.
  // The levels are the survey in src/subharness/models.ts, so no backend offers none for want of a help text.
  const { deps, privateDir } = withOpencode();
  fakeVendor(privateDir, 'claude', { loggedIn: true });
  fakeVendor(privateDir, 'codex', { loggedIn: true });
  const read = await roleSources(deps, 'server');
  const levels = Object.fromEntries(read.sources.map((one) => [String(one.via), one.effort] as const));
  assert.deepEqual(levels, {
    claude: ['low', 'medium', 'high', 'xhigh', 'max'],
    codex: ['low', 'medium', 'high', 'xhigh', 'max'],
    opencode: ['low', 'medium', 'high'],
  });
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

test('a logged-in claude offers every level of the survey', async () => {
  // Catches: xhigh and max unreachable from the chooser, or the global three offered in place of what claude takes.
  const { deps } = effortRig();
  const read = await roleSources({ ...deps, baseUrl: 'https://openrouter.test', openRouterKey: null }, 'server');
  const claude = read.sources.find((one) => one.via === 'claude');
  assert.deepEqual(claude?.effort, ['low', 'medium', 'high', 'xhigh', 'max']);
});

test('the core role says provider effort is unsupported', async () => {
  // Catches: an effort step for the core, which has its own thinking contract and rejects provider effort.
  const { deps } = rig();
  assert.deepEqual(source(await roleSources(deps, 'core'), null).effort, []);
});

// What keeps a source out

test('a missing install and a missing login are separate codes, each with the login command', async () => {
  // Catches: one "unavailable" for both, with no way to know whether to install or to log in.
  const { deps, privateDir } = rig();
  fakeVendor(privateDir, 'claude');
  const read = await roleSources(deps, 'server');
  const claude = source(read, 'claude');
  const codex = source(read, 'codex');
  assert.equal(claude.code, 'not-logged-in');
  assert.equal(codex.code, 'not-installed');
  assert.deepEqual(claude.setup, [{ command: '/subharness claude login', masked: false }]);
  assert.deepEqual(codex.setup, [{ command: '/subharness codex login', masked: false }]);
});

test('a provider that refuses the listing is its own code, never an empty list', async () => {
  // Catches: a rejected key reading as "this provider has no models".
  const { deps } = rig(() => ({ status: 401, body: {} }));
  const api = source(await roleSources(deps, 'speech'), null);
  assert.equal(api.code, 'provider-rejected');
  assert.equal(api.listing, 'failed');
});

test('a missing API key names the role-specific masked key commands', async () => {
  // Catches: a setup hint that loses the role, or that binds another role's key.
  const { deps } = rig(listing, {}, null);
  const api = source(await roleSources(deps, 'drawing'), null);
  assert.equal(api.code, 'no-key');
  assert.deepEqual(api.setup, [
    // One named key and the role's route.
    { command: '/keys add <name>', masked: true },
    { command: '/model set drawing <name>/<model>', masked: false },
  ]);
});

for (const role of ['speech', 'drawing', 'embedding', 'analyzer', 'vision', 'video', 'core']) {
  test(`${role} shows every CLI as unsupported by the role, without asking the CLI anything`, async () => {
    // Catches: a text-only CLI selectable as a voice or a painter, or a vendor process started for a disabled row.
    const { deps, privateDir } = rig();
    const vendor = fakeVendor(privateDir, 'claude', { loggedIn: true });
    const read = await roleSources(deps, role);
    for (const via of ['claude', 'codex', 'opencode'] as const) {
      assert.equal(source(read, via).code, 'role-unsupported');
      assert.deepEqual(source(read, via).models, []);
    }
    assert.deepEqual(vendor.calls(), []);
  });
}

test('memory offers the API, codex and claude, and refuses opencode by the role', async () => {
  // Catches: opencode offered to the writer, which needs a system prompt it cannot replace.
  const { deps, privateDir } = withOpencode();
  fakeVendor(privateDir, 'claude', { loggedIn: true });
  const read = await roleSources(deps, 'memory');
  assert.equal(source(read, 'opencode').code, 'role-unsupported');
  assert.equal(source(read, 'claude').code, 'ok');
  assert.equal(source(read, null).code, 'ok');
});

test('two sources exposing one name stay two sources', async () => {
  // Catches: rows keyed by model name, the source of `sonnet` decided by listing order.
  const { deps, privateDir } = rig();
  fakeVendor(privateDir, 'claude', { loggedIn: true });
  fakeVendor(privateDir, 'codex', { loggedIn: true });
  const read = await roleSources(deps, 'server');
  assert.equal(new Set(read.sources.map((one) => one.id)).size, read.sources.length);
});

// What a read does not do

test('reading sends no model request and starts no model run', async () => {
  // Catches: a chooser that spends tokens by being opened.
  const { deps, privateDir, calls } = withOpencode();
  const vendor = fakeVendor(privateDir, 'claude', { loggedIn: true });
  await roleSources(deps, 'server');
  assert.ok(calls.every((call) => call.url.endsWith('/models')));
  assert.deepEqual(vendor.calls(), ['auth status']);
});

test('no descriptor carries a key value', async () => {
  // Catches: a credential reaching chooser state, then a screen or a log.
  const { deps } = withOpencode();
  for (const role of ['server', 'memory', 'speech']) {
    const text = JSON.stringify(await roleSources(deps, role));
    for (const secret of KEY_VALUES) assert.equal(text.includes(secret), false, role);
  }
});

test("a role's stored selection is read back as its current one", async () => {
  // Catches: a chooser that cannot say keep, so omitting effort silently clears the writer's.
  const made = rig(listing, {
    subharness: { key: null, modes: {}, memory: { backend: 'claude', model: 'opus', effort: 'high' } },
  });
  const read = await roleSources(made.deps, 'memory');
  assert.deepEqual(read.current, { via: 'claude', model: 'opus', effort: 'high' });
});
