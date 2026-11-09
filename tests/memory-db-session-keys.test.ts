// The memory session's key (src/memory/db/session.ts#memoryKeyState),
// apart from tests/memory-db-session.test.ts because that file is at its length limit.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CODES, memoryKeyState, refusalOf, sweep } from '../src/memory/db/session.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { CHECK_PURPOSE, DRAFT_PURPOSE, reviewRefusal } from '../src/memory/db/describe.ts';
import { createKeyRing } from '../src/keys/ring.ts';
import type { KeyRing } from '../src/keys/ring.ts';
import { createKeyStore } from '../src/keys/store.ts';
import { createKeyFailover } from '../src/llm/key-failover.ts';
import { tempDir } from './fixtures/tmp.ts';
import { NOW, baseConfig, prompts } from './fixtures/memory-db/session-rig.ts';
// The memory key from the key store (spec 2026-11-02, follow-up 1): the memory session goes out on the key `memory` is
// bound to, else the core list, like every other role; a variable of `.env` never counts.

/** A key ring over a fresh keys.json in a temp folder, with `fill` run on its store first. */
function ringWith(fill: (store: ReturnType<typeof createKeyStore>) => void): KeyRing {
  const store = createKeyStore({ privateDir: tempDir('memory-ring-') });
  fill(store);
  return createKeyRing({ store, failover: createKeyFailover({ now: () => NOW }) });
}

const reviewPrompts = { ...prompts, [DRAFT_PURPOSE]: 'DRAFT', [CHECK_PURPOSE]: 'CHECK' };

test('with a key store and no memory variable in .env, the memory session runs on the core key in use', () => {
  // Catches: the session stays not_configured after the deploy because it still looks for llm.keyByRole.memory in .env.
  const ring = ringWith((store) => store.addCore({ name: 'core-1', value: 'v-core-0001' }));
  const config = baseConfig({}, { llm: {} });
  assert.deepEqual(memoryKeyState(config, {}, ring), { ok: true, name: 'core-1' });
  assert.equal(refusalOf(config, {}, prompts, ring), null);
});

test('with a key store the memory role bound to an extra key is named by that key', () => {
  // Catches: a binding of the memory role is ignored and the state names a core key it does not go out on.
  const ring = ringWith((store) => {
    store.addCore({ name: 'core-1', value: 'v-core-0001' });
    store.addExtra({ name: 'mem-own', value: 'v-mem-0002' });
    store.bind('memory', 'mem-own');
  });
  assert.deepEqual(memoryKeyState(baseConfig(), {}, ring), { ok: true, name: 'mem-own' });
});

test('with an empty key store the session refuses even when .env still holds the memory variable', () => {
  // Catches: the old .env variable keeps the session alive on a deployment whose store has no key at all.
  const ring = ringWith(() => undefined);
  const env = { OPENROUTER_MEMORY_KEY: 'v-env-0003' };
  assert.deepEqual(memoryKeyState(baseConfig(), env, ring), { ok: false, name: null });
  assert.equal(refusalOf(baseConfig(), env, prompts, ring), CODES.NOT_CONFIGURED);
});

test('the description review follows the key store the same way as the sweep', () => {
  // Catches: the sweep runs on the store while the review still refuses not_configured for want of a .env variable.
  const empty = ringWith(() => undefined);
  const full = ringWith((store) => store.addCore({ name: 'core-1', value: 'v-core-0001' }));
  const config = baseConfig({}, { llm: {} });
  assert.equal(reviewRefusal(config, {}, reviewPrompts, full), null);
  assert.equal(reviewRefusal(baseConfig(), { OPENROUTER_MEMORY_KEY: 'v' }, reviewPrompts, empty), CODES.NOT_CONFIGURED);
});

// scripts/memory-session.ts gives the session production's key ring: tests/scripts-lib-script-routes.test.ts.

// The owner's word of 2026-11-06 and 2026-11-08: a role that runs through a harness needs no API key, and no check at
// the moment of use asks for one. The memory writer on `claude` or `codex` sends no key, so neither its sweep nor its
// review may refuse for want of one.
const onHarness = { kind: 'subharness' as const, backend: 'claude' as const, model: 'claude-opus-4-6', effort: null };

test('a memory writer on a harness needs no key: the sweep and the review are not refused with an empty store', () => {
  // Catches: memory sessions stopped for two days with not_configured while the writer ran on the Claude harness.
  const empty = ringWith(() => undefined);
  assert.equal(refusalOf(baseConfig(), {}, prompts, empty, onHarness), null);
  assert.equal(reviewRefusal(baseConfig(), {}, reviewPrompts, empty, onHarness), null);
  assert.equal(memoryKeyState(baseConfig(), {}, empty, onHarness).ok, true);
});

test('a memory writer on the direct path with no key is still refused', () => {
  // Catches: the harness exception swallowing the direct path's real need for a key.
  const empty = ringWith(() => undefined);
  assert.equal(refusalOf(baseConfig(), {}, prompts, empty, { kind: 'direct' }), CODES.NOT_CONFIGURED);
  assert.equal(reviewRefusal(baseConfig(), {}, reviewPrompts, empty, { kind: 'direct' }), CODES.NOT_CONFIGURED);
});

test('a sweep whose writer runs on a harness goes on with an empty key store', async () => {
  // Catches: the sweep reading only the key ring and refusing before the harness client is ever asked.
  const empty = ringWith(() => undefined);
  const result = await sweep({
    db: dbOf(openMemoryDb(':memory:')),
    write: () => Promise.resolve(),
    llm: { complete: () => Promise.reject(new Error('no request expected')) },
    hot: { config: baseConfig(), prompts },
    env: {},
    ring: empty,
    path: () => onHarness,
    now: () => NOW,
  });
  assert.notEqual(result.code, CODES.NOT_CONFIGURED);
});
