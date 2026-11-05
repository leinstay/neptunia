// PR 1, sources without an enable step: the source-qualified model choices (src/subharness/model-sources.ts). Each role
// is offered models from OpenRouter and from the installed, authenticated backends, one choice per source even when two
// sources expose one name, with what keeps a source out said separately. Fetch and vendor CLIs are fakes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { modelChoices } from '../src/subharness/model-sources.ts';
import type { ChoicesDeps } from '../src/subharness/model-sources.ts';
import { subharnessPlace } from '../src/subharness/place.ts';
import { fakeVendor } from './fixtures/fake-vendor.ts';
import { fakeFetch } from './fixtures/keys-rig.ts';
import type { Call, Reply } from './fixtures/keys-rig.ts';
import { writeKeysFile } from './fixtures/keys-file.ts';
import { tempDir } from './fixtures/tmp.ts';

const BASE = 'https://openrouter.test/api/v1';

/** OpenRouter's `/models` holding a text model named like Claude's alias, and a speech and a drawing model. */
function listing(call: Call): Reply {
  if (!call.url.endsWith('/models')) return { status: 200, body: {} };
  const text = { input_modalities: ['text'], output_modalities: ['text'] };
  return {
    status: 200,
    body: {
      data: [
        { id: 'opus', architecture: text },
        { id: 'vendor/text-1', architecture: text },
        { id: 'vendor/voice-1', architecture: { input_modalities: ['text'], output_modalities: ['audio'] } },
        { id: 'vendor/paint-1', architecture: { input_modalities: ['text'], output_modalities: ['image'] } },
      ],
    },
  };
}

function rig(answer: (call: Call) => Reply = listing): { deps: ChoicesDeps; privateDir: string; calls: Array<Call> } {
  const privateDir = tempDir('nep-model-sources-');
  writeKeysFile(privateDir);
  const { fetch, calls } = fakeFetch(answer);
  return { privateDir, calls, deps: { privateDir, fetch, baseUrl: BASE, openRouterKey: 'or-value' } };
}

test('one model name from two sources stays two choices, each naming its source', async () => {
  // Catches: choices keyed by model name, so picking `opus` silently lands on whichever source was listed last.
  const { deps, privateDir } = rig();
  fakeVendor(privateDir, 'claude', { loggedIn: true });
  const { choices } = await modelChoices(deps, 'dev');
  const opus = choices.filter((one) => one.model === 'opus');
  assert.deepEqual(opus.map((one) => one.source).sort(), ['claude', 'openrouter']);
  assert.equal(new Set(opus.map((one) => one.id)).size, 2);
});

test('a backend that is absent and a backend with no login each say so, and offer no model', async () => {
  // Catches: one "unavailable", or a list of fixed names shown for a backend that cannot run them.
  const { deps, privateDir } = rig();
  fakeVendor(privateDir, 'claude');
  const { choices, notices } = await modelChoices(deps, 'dev');
  assert.deepEqual(
    notices
      .filter((one) => one.source !== 'opencode')
      .map((one) => [one.source, one.code])
      .sort(),
    [
      ['claude', 'not-logged-in'],
      ['codex', 'not-installed'],
    ]
  );
  assert.deepEqual([...new Set(choices.map((one) => one.source))], ['openrouter']);
});

test('a provider that rejects the listing is its own notice, not an empty list', async () => {
  // Catches: a revoked key reads as "no models", and the owner goes looking in the wrong place.
  const { deps } = rig(() => ({ status: 401, body: {} }));
  const { notices } = await modelChoices(deps, 'memory');
  assert.deepEqual(notices.find((one) => one.source === 'openrouter')?.code, 'provider-rejected');
});

test('the fixed names of a CLI are labelled suggestions, and a listed OpenRouter model is not', async () => {
  // Catches: a hand-kept list passed off as what the account can run.
  const { deps, privateDir } = rig();
  fakeVendor(privateDir, 'codex', { loggedIn: true });
  const { choices } = await modelChoices(deps, 'scout');
  assert.ok(choices.some((one) => one.source === 'codex'));
  for (const one of choices) assert.equal(one.suggestion, one.source === 'codex', one.id);
});

for (const role of ['speech', 'drawing']) {
  test(`${role} is offered no text-only CLI, whatever is logged in`, async () => {
    // Catches: a CLI advertised as a voice or a painter, which fails only when she tries to use it.
    const { deps, privateDir } = rig();
    fakeVendor(privateDir, 'claude', { loggedIn: true });
    fakeVendor(privateDir, 'codex', { loggedIn: true });
    const { choices, notices } = await modelChoices(deps, role);
    assert.deepEqual([...new Set(choices.map((one) => one.source))], ['openrouter']);
    assert.deepEqual(notices, []);
    assert.deepEqual(
      choices.map((one) => one.model),
      [role === 'speech' ? 'vendor/voice-1' : 'vendor/paint-1']
    );
  });
}

test('memory is never offered opencode, which takes no system prompt of its own', async () => {
  // Catches: a choice the writer's own selection then refuses.
  const { deps, privateDir } = rig();
  fakeVendor(privateDir, 'claude', { loggedIn: true });
  writeKeysFile(privateDir, { extra: { 'oc-1': 'oc-value' }, subharness: { key: 'oc-1', modes: {} } });
  const { choices, notices } = await modelChoices(deps, 'memory');
  assert.equal(
    choices.some((one) => one.source === 'opencode'),
    false
  );
  assert.equal(
    notices.some((one) => one.source === 'opencode'),
    false
  );
});

test('opencode lists through its own key and every other source offers no key', async () => {
  // Catches: the core key spent on a listing the owner bound to another account.
  const { deps, privateDir, calls } = rig();
  const { binary } = subharnessPlace(privateDir, 'opencode');
  fs.mkdirSync(path.dirname(binary), { recursive: true });
  fs.writeFileSync(binary, '#!/bin/sh\nexit 9\n', { mode: 0o755 });
  writeKeysFile(privateDir, { extra: { 'oc-1': 'oc-value' }, subharness: { key: 'oc-1', modes: {} } });
  const { choices } = await modelChoices(deps, 'dev');
  assert.ok(choices.some((one) => one.source === 'opencode' && one.model === 'vendor/text-1'));
  assert.deepEqual([...new Set(calls.map((one) => one.auth))].sort(), ['oc-value', 'or-value']);
});

test('reading the choices sends no model request', async () => {
  // Catches: a picker that verifies every entry on open, one paid request per row.
  const { deps, privateDir, calls } = rig();
  fakeVendor(privateDir, 'claude', { loggedIn: true });
  const vendor = fakeVendor(privateDir, 'codex', { loggedIn: true });
  await modelChoices(deps, 'dev');
  assert.equal(
    calls.some((one) => one.url.endsWith('/chat/completions')),
    false
  );
  assert.deepEqual(vendor.calls(), ['login status']);
});
