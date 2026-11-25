// Tests for src/intentions/store.ts: a closed record beyond KEEP_CLOSED moves to the archive, and the intentions are one
// collection of the persona.
import assert from 'node:assert/strict';

import { test, after } from 'node:test';
import { createIntentionStores, createIntentionStore } from '../../../src/intentions/store.ts';

import { useIface } from '../../fixtures/turn-world.ts';
import { tempDir } from '../../fixtures/tmp.ts';
import { openTestMemorySync, unitFile, openTestMemory } from '../../fixtures/memory-db/service.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import { wrongly, present } from '../../fixtures/loose-types.ts';

import type { Intention } from '../../../src/intentions/types.ts';
import { ownedBy } from '../../fixtures/owner-accounts.ts';
import { createIntention } from '../../../src/intentions/model.ts';
import { intentionsValue } from '../../../src/memory/db/readers/intentions.ts';
import { dbOf } from '../../../src/memory/db/types.ts';
import fs from 'node:fs';
import type { Row } from '../../../src/memory/db/types.ts';
import { readerEnv } from '../../fixtures/memory-db/readers.ts';

/** The memory database of each data directory used here, opened once; closed when the file is done. */
const MEMORY = new Map<string, ReturnType<typeof openTestMemorySync>>();
after(async () => {
  for (const { close } of MEMORY.values()) await close();
});
function memoryOf(dataDir: string) {
  if (!MEMORY.has(dataDir)) MEMORY.set(dataDir, openTestMemorySync({ dataDir }));
  return present(MEMORY.get(dataDir)).memoryDb;
}
// The chat an errand answers in is held by the fake interface of the test's world.
useIface('fake');
const OWNER = '42';
const T0 = Date.parse('2026-10-18T10:00:00Z');

test('store: a closed record beyond KEEP_CLOSED moves to the archive, never lost', async () => {
  const { KEEP_CLOSED } = await import('../../../src/intentions/store.ts');
  const { createIntention } = await import('../../../src/intentions/model.ts');
  const MEMBER = '987654321';
  const dataDir = tempDir('intent-archive');
  const stores = createIntentionStores({ memoryDb: memoryOf(dataDir), now: () => T0 });
  const store = stores.get();
  const make = (i: number, participants: Untyped) => {
    const made = createIntention({
      purpose: `want ${i}`,
      provenance: { kind: 'self', turnId: 't', ...(participants ? { participants } : {}) },
      now: T0 + i,
      id: `i${i}`,
      dropped: true,
      reason: `why ${i}`,
    });
    assert.equal(made.ok, true, wrongly(made.code));
    return made.intention;
  };
  for (let i = 0; i < KEEP_CLOSED + 3; i += 1)
    assert.equal(present(store).add(make(i, i === 0 ? [MEMBER] : undefined)).ok, true);
  assert.equal(present(store).list().length, KEEP_CLOSED, 'the list keeps the latest ones');
  await present(store).flush();
  assert.deepEqual(
    present(store)
      .archived()
      .map((r) => r.id),
    ['i0', 'i1', 'i2'],
    'the older three moved, not deleted'
  );
  const lines = present(unitFile(memoryOf(dataDir), 'guilds/g1/intentions-archive.jsonl'))
    .trim()
    .split('\n');
  assert.equal(lines.length, 3);
  assert.deepEqual(
    present(createIntentionStores({ memoryDb: memoryOf(dataDir), now: () => T0 }).get())
      .archived()
      .map((r) => r.id),
    ['i0', 'i1', 'i2'],
    'read back from the database'
  );
});

// The owner account of these configs: `bot.ownerPerson` and the accounts bound to it, in the fixture of owner accounts.
ownedBy([OWNER]);

// The intentions belong to one persona, each with its own optional destination: an intention born in a DM keeps that
// DM through a restart, and no list depends on a home root.
// Contract: `createIntentionStore({ memoryDb, log })` takes no `rootId` and its
// collection is `personaKey('intentions')`; `createIntentionService` takes no `getRootId` and `service.list(options?)`,
// `service.due()` and `service.reconcile()` take no root.
// Appendix entries: src/intentions/{service,store,types}.ts, src/memory/db/readers/intentions.ts, src/tools/operations/intention.ts.

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

const WRITE_NOW = Date.parse('2026-11-09T10:00:00.000Z');

function intention(id: string, extra: Row = {}): Row {
  return {
    id,
    purpose: 'ask about the trip',
    status: 'pending',
    createdAt: WRITE_NOW - 3000,
    updatedAt: WRITE_NOW - 1000,
    dueAt: WRITE_NOW + 60_000,
    every: null,
    expiresAt: WRITE_NOW + 86_400_000,
    awaitingErrandId: null,
    waitDeadline: null,
    destination: null,
    completionCondition: null,
    chainId: null,
    attend: null,
    provenance: { kind: 'self', turnId: 't-1', placeId: 'discord:channel:100', scope: 'group' },
    history: [{ at: WRITE_NOW - 3000, to: 'pending', by: 'persona' }],
    ...extra,
  };
}

test('the intention store keeps its list and its archive over a reopen of the database', async () => {
  // Catches: a store whose writes no new store can read once the first one is gone.
  let mem = await openTestMemory();
  try {
    const first = createIntentionStore({ memoryDb: mem.memoryDb });
    assert.equal(first.add(intention('i1') as never).ok, true);
    await first.flush({ final: true });
    await mem.close();
    mem = await openTestMemory({ dataDir: mem.dataDir });
    const second = createIntentionStore({ memoryDb: mem.memoryDb });
    assert.deepEqual(
      second.list().map((record) => record.id),
      ['i1']
    );
  } finally {
    await mem.close();
    fs.rmSync(mem.dataDir, { recursive: true, force: true });
  }
});

test('a list write that failed is sent again by the next flush', async () => {
  // Catches: a store that drops the write the database refused, so the change is gone after a restart.
  let mem = await openTestMemory();
  try {
    const service = mem.memoryDb;
    let down = true;
    const memoryDb = {
      ...service,
      writeIntentions: (write: Parameters<typeof service.writeIntentions>[0]) =>
        down ? Promise.reject(Object.assign(new Error('down'), { code: 'DB_CLOSED' })) : service.writeIntentions(write),
    };
    const store = createIntentionStore({ memoryDb, log: { info() {}, warn() {}, error() {} } });
    assert.equal(store.add(intention('i1') as never).ok, true);
    assert.equal((await store.flush()).waiting, 1);
    down = false;
    assert.equal((await store.flush({ final: true })).waiting, 0);
    await mem.close();
    mem = await openTestMemory({ dataDir: mem.dataDir });
    assert.deepEqual(
      createIntentionStore({ memoryDb: mem.memoryDb })
        .list()
        .map((record) => record.id),
      ['i1']
    );
  } finally {
    await mem.close();
    fs.rmSync(mem.dataDir, { recursive: true, force: true });
  }
});

const ids = (records: Array<{ id: string }>) => records.map((record) => record.id);

test('intentions db reader: a closed database fails the load with a code, logged; the next get tries again', async () => {
  const env = await readerEnv();
  try {
    let open = false;
    const memoryDb = { readHandle: () => (open ? env.handle : null), database: () => (open ? env.handle.db : null) };
    const stores = createIntentionStores({ log: env.log, memoryDb });
    assert.throws(
      () => stores.get(),
      (error: NodeJS.ErrnoException) => error.code === 'DB_CLOSED'
    );
    assert.deepEqual(
      env.warns.map((warn) => [warn.message, warn.reader, warn.code]),
      [['memory db: read failed', 'intentions', 'DB_CLOSED']]
    );
    open = true;
    assert.deepEqual(ids(stores.get()!.list()), ['i2', 'i3']);
  } finally {
    env.done();
  }
});
