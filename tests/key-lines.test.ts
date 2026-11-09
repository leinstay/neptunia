// Tests for the core health: the core's `routes-exhausted` reaching the role tracker
// (src/llm/role-health.ts#reportingCoreKeys).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoleHealth, reportingCoreKeys } from '../src/llm/role-health.ts';

const CONFIG = { models: { base: { core: 'x/core', vision: 'x/eyes' } } };
// The chain client's code replaces keys-exhausted (spec 2026-11-09-model-routes).
const exhausted = () => Object.assign(new Error('out'), { code: 'routes-exhausted' });

function rig(complete: (messages?: unknown, options?: unknown) => Promise<unknown>) {
  const health = createRoleHealth({ now: () => Date.parse('2026-11-02T09:00:00Z'), hasKey: () => true });
  return { health, llm: reportingCoreKeys({ complete }, health) };
}

test('reportingCoreKeys: a core request that fails with routes-exhausted puts the core down, the next answer clears it', async () => {
  let fail = true;
  const { health, llm } = rig(() => (fail ? Promise.reject(exhausted()) : Promise.resolve({ text: 'hi' })));
  await assert.rejects(llm.complete([], { role: 'core' }), { code: 'routes-exhausted' });
  assert.equal(health.down(CONFIG, 'core')?.reason, 'routes-exhausted');
  fail = false;
  await llm.complete([], { role: 'core' });
  assert.equal(health.down(CONFIG, 'core'), null);
});

test('reportingCoreKeys: other failures and other roles tell the tracker nothing', async () => {
  const { health, llm } = rig(() => Promise.reject(Object.assign(new Error('x'), { statusCode: 402 })));
  await assert.rejects(llm.complete([], { role: 'core' }));
  // Bug caught: every core 402 or empty answer marking the core down through a wrapper meant for one error.
  assert.equal(health.down(CONFIG, 'core'), null);
  const other = rig(() => Promise.reject(exhausted()));
  await assert.rejects(other.llm.complete([], { role: 'vision' }));
  assert.equal(other.health.down(CONFIG, 'vision'), null);
});
