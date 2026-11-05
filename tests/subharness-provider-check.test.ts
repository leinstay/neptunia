// The one-reply check of `setAgentModel` goes out through the provider the owner pinned: OpenRouter's request body carries
// the same `provider` block the run will send, so a pin the provider cannot serve is refused before it is saved.
// The fetch is a fake that records the body; no request goes out.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { setAgentModel } from '../src/subharness/control.ts';
import type { EnableDeps } from '../src/subharness/control.ts';
import { subharnessPlace } from '../src/subharness/place.ts';
import { readKeysFile, writeKeysFile } from './fixtures/keys-file.ts';
import { tempDir } from './fixtures/tmp.ts';

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
