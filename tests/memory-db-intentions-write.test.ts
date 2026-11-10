// The write kind `intentions` (src/memory/db/intentions-write.ts): her list of intentions and the records moved out of it
// to the archive, written as `intentions` rows directly instead of through the units `intentions.json` and
// `intentions-archive.jsonl` and their mapper. The first tests write one input both ways and compare the stored rows column
// by column, and the graph nodes the rows project. The ownership columns `owner_key` and `owner_file` are the one
// difference the plan makes, and the unit path's `operational` remainder row is not written. The last tests hold the
// schema step that moves the rows production holds, and the intention store's round trip over a reopen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createIntentionStore } from '../src/intentions/store.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { intentionsArchiveLines, intentionsValue } from '../src/memory/db/readers/intentions.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db, MemoryHandle, Row } from '../src/memory/db/types.ts';
import { openTestMemory } from './fixtures/memory-db/service.ts';
import { tempDir } from './fixtures/tmp.ts';

const NOW = Date.parse('2026-11-09T10:00:00.000Z');

function intention(id: string, extra: Row = {}): Row {
  return {
    id,
    purpose: 'ask about the trip',
    status: 'pending',
    createdAt: NOW - 3000,
    updatedAt: NOW - 1000,
    dueAt: NOW + 60_000,
    every: null,
    expiresAt: NOW + 86_400_000,
    awaitingErrandId: null,
    waitDeadline: null,
    destination: null,
    completionCondition: null,
    chainId: null,
    attend: null,
    provenance: { kind: 'self', turnId: 't-1', placeId: 'discord:channel:100', scope: 'group' },
    history: [{ at: NOW - 3000, to: 'pending', by: 'persona' }],
    ...extra,
  };
}

function fresh(name: string): { handle: MemoryHandle; db: Db; close: () => void } {
  const handle = openMemoryDb(path.join(tempDir(`intentions-${name}`), 'memory.db'));
  return { handle, db: dbOf(handle), close: () => handle.close() };
}

test('the readers give the list and the archive lines the intentions write stored', () => {
  // Catches: a reader that mixes archived records into the list, or loses the archive's order.
  const direct = fresh('read');
  try {
    applyMemoryWrite(direct.handle, { kind: 'intentions', op: 'value', intentions: [intention('i1')], now: NOW });
    applyMemoryWrite(direct.handle, {
      kind: 'intentions',
      op: 'archive',
      records: [intention('a2', { status: 'done' }), intention('a1', { status: 'done' })],
      now: NOW,
    });
    assert.deepEqual(intentionsValue(direct.db), { found: true, value: { intentions: [intention('i1')] } });
    assert.deepEqual(
      intentionsArchiveLines(direct.db).map((line) => (JSON.parse(line) as Row).id),
      ['a2', 'a1']
    );
  } finally {
    direct.close();
  }
});

test('the intentions write refuses a record without an id', () => {
  // Catches: a record that lands under no key and can never be read or replaced.
  const direct = fresh('refuse');
  try {
    assert.throws(
      () =>
        applyMemoryWrite(direct.handle, {
          kind: 'intentions',
          op: 'value',
          intentions: [{ purpose: 'no id' }],
          now: NOW,
        }),
      { code: 'INTENTIONS_RECORD' }
    );
  } finally {
    direct.close();
  }
});

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
