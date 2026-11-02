// Tests for the parts of item 0.5 that surface the key state: the core's `keys-exhausted` reaching the role tracker
// (src/llm/role-health.ts#reportingCoreKeys) and the grant lines of the status card (src/tools/impl/usage.ts#keyGrantLines).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRoleHealth, reportingCoreKeys } from '../src/llm/role-health.ts';
import { keyGrantLines } from '../src/tools/impl/key-lines.ts';

const CONFIG = { models: { base: { core: 'x/core', vision: 'x/eyes' } } };
const exhausted = () => Object.assign(new Error('out'), { code: 'keys-exhausted' });

function rig(complete: (messages?: unknown, options?: unknown) => Promise<unknown>) {
  const health = createRoleHealth({ now: () => Date.parse('2026-11-02T09:00:00Z'), hasKey: () => true });
  return { health, llm: reportingCoreKeys({ complete }, health) };
}

test('reportingCoreKeys: a core request that fails with keys-exhausted puts the core down, the next answer clears it', async () => {
  let fail = true;
  const { health, llm } = rig(() => (fail ? Promise.reject(exhausted()) : Promise.resolve({ text: 'hi' })));
  await assert.rejects(llm.complete([], { role: 'core' }), { code: 'keys-exhausted' });
  assert.equal(health.down(CONFIG, 'core')?.reason, 'keys-exhausted');
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

test('keyGrantLines: a key with a grant shows what is left and its reset day, a key without one is named unconfigured', () => {
  const labels = {
    status: {
      costs: {
        keyGrant: '{key}: {left} of {grant} USD left, resets on day {day}',
        keyUnconfigured: '{key}: no grant set in llm.keys',
      },
    },
  };
  const rows = [
    { name: 'OPENROUTER_CORE_KEY', left: 161.5, grant: 200, resetDay: 15 },
    { name: 'OPENROUTER_CORE_BACKUP_KEY', left: null, grant: null, resetDay: null },
  ];
  assert.deepEqual(keyGrantLines({ rows, labels }), [
    'OPENROUTER_CORE_KEY: 161.50 of 200.00 USD left, resets on day 15',
    'OPENROUTER_CORE_BACKUP_KEY: no grant set in llm.keys',
  ]);
  assert.deepEqual(keyGrantLines({ rows, labels: {} }), []);
});
