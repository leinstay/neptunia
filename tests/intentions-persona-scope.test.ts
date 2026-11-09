// Her intentions belong to one persona, each with its own optional destination: an intention born in a DM keeps that DM
// through a restart, and no list depends on a home root.
// Contract, plan 2026-11-04-cli-and-memory task 5: `createIntentionStore({ memoryDb, log })` takes no `rootId` and its
// collection is `personaKey('intentions')`; `createIntentionService` takes no `getRootId` and `service.list(options?)`,
// `service.due()` and `service.reconcile()` take no root.
// Appendix entries: src/intentions/{service,store,types}.ts, src/memory/db/readers/intentions.ts, src/tools/operations/intention.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIntention } from '../src/intentions/model.ts';
import { createIntentionService } from '../src/intentions/service.ts';
import { createIntentionStore, createIntentionStores } from '../src/intentions/store.ts';
import type { Intention } from '../src/intentions/types.ts';
import { intentionsValue } from '../src/memory/db/readers/intentions.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { hotWith } from './fixtures/inner-rig.ts';
import { present, wrongly } from './fixtures/loose-types.ts';
import { openTestMemory } from './fixtures/memory-db/service.ts';

const NOW = Date.parse('2026-11-05T12:00:00.000Z');
const silent = { info() {}, warn() {}, error() {} };

function made(id: string): Intention {
  const created = createIntention({
    id,
    purpose: 'answer about the synthetic plan',
    provenance: { kind: 'self', placeId: 'native-dm', scope: 'dm' },
    destination: 'native-dm',
    dueAt: NOW - 1000,
    expiresAt: NOW + 86400000,
    now: NOW,
  });
  assert.equal(created.ok, true, JSON.stringify(created));
  return wrongly<{ intention: Intention }>(created).intention;
}

test('the intentions are one persona collection, and an intention born in a DM keeps its destination across a restart', async () => {
  // Bug: the list sits under the root the core resolved first, and a DM's intention acquires that server.
  const mem = await openTestMemory();
  try {
    const store = createIntentionStore({ memoryDb: mem.memoryDb, log: silent });
    store.add(made('i1'));
    await store.flush();
    const db = dbOf(wrongly<Parameters<typeof dbOf>[0]>(mem.memoryDb.readHandle()));
    // The list is the persona's rows, under no root (src/memory/db/intentions-write.ts).
    const stored = intentionsValue(db);
    assert.deepEqual(
      stored.found ? (stored.value as { intentions: Array<{ id: string }> }).intentions.map((one) => one.id) : [],
      ['i1']
    );
    const reopened = createIntentionStore({ memoryDb: mem.memoryDb, log: silent });
    assert.equal(reopened.get('i1')?.destination, 'native-dm');
  } finally {
    await mem.close();
  }
});

test('the service lists and answers what is due with no root named', () => {
  // Bug: `storeOf` answers null without a root, so a core with only DMs forgets every promise.
  const stores = createIntentionStores({ now: () => NOW, log: silent });
  const service = createIntentionService({ stores, hot: hotWith(), now: () => NOW, log: silent });
  present(stores.get()).add(made('i2'));
  assert.deepEqual(
    service.list({ all: true }).map((one) => one.id),
    ['i2']
  );
  assert.deepEqual(
    service.due().map((one) => one.intention.id),
    ['i2']
  );
});
