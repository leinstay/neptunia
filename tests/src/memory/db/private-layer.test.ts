// The write kind `private-layer` (src/memory/db/private-layer.ts): what the persona learned about a member in their
// direct chat, written as its rows directly instead of through the private mapper of a unit write. The first test
// writes the same layers through the unit write and through the write kind, over copies of one seeded database, and
// compares every table column by column. Then the codes and the generated layers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountCollection } from '../../../../src/memory/db/unit-keys.ts';
import type { UnitKey } from '../../../../src/memory/db/unit-keys.ts';
import { unitValue } from '../../../../src/memory/db/readers/common.ts';
import { dbOf } from '../../../../src/memory/db/types.ts';
import type { Row, Db, MemoryHandle } from '../../../../src/memory/db/types.ts';
import { generated, plain } from '../../../fixtures/memory-db/roundtrip.ts';
import { openTestMemory, tempDataDir } from '../../../fixtures/memory-db/service.ts';
import { createStore } from '../../../../src/memory/store.ts';
import { openMemoryDb } from '../../../../src/memory/db/open.ts';
import { applyUnitUpdate } from '../../../fixtures/memory-db/unit-writes.ts';
import { ANNA, addAffinity, seedOpaqueWorld } from '../../../fixtures/memory-db/opaque-people.ts';

const NOW = Date.parse('2026-11-09T10:00:00.000Z');

test('a private layer write that names no account is refused with a code', async () => {
  const memory = await openTestMemory({ now: () => NOW, iface: () => 'discord' });
  try {
    await assert.rejects(memory.memoryDb.writePrivateLayer({ accountId: '', value: {} }), {
      code: 'PRIVATE_LAYER_ACCOUNT',
    });
  } finally {
    await memory.close();
  }
});

test('the generated layers with every key path of the live private files come back as they were written', async () => {
  for (const [index, given] of generated('private').entries()) {
    const memory = await openTestMemory({ now: () => NOW, iface: () => 'discord' });
    try {
      const value = plain(given) as Row;
      await memory.memoryDb.writePrivateLayer({ accountId: 'discord:900', value });
      const read = unitValue(dbOf(memory.memoryDb.readHandle()!), accountCollection('private', 'discord:900'));
      assert.ok(read.found, `generated private ${index}`);
      assert.deepEqual(plain(read.value), value, `generated private ${index}`);
    } finally {
      await memory.close();
    }
  }
});

// The write kind `private-layer` (src/memory/db/private-layer.ts): what the persona learned about a member in their direct chat,
// written as its rows directly instead of through the private mapper of a unit write. The first test writes the same
// layers through the unit write and through the write kind, over copies of one seeded database, and compares every
// table column by column. Then the codes, the store over a reopen and the generated layers.

const LAYER_NOW = Date.parse('2026-11-09T10:00:00.000Z');

test('the store reads back a private layer after the database is closed and opened again', async () => {
  const dataDir = tempDataDir('nep-private-reopen-');
  const first = await openTestMemory({ dataDir, now: () => LAYER_NOW, iface: () => 'discord' });
  let written: unknown;
  try {
    const store = createStore({ dataDir, memoryDb: first.memoryDb });
    store.touchUser('discord:555', 'Fifth', LAYER_NOW);
    store.flush();
    await store.flushSettled({});
    // The store has no writer of the private layer: the memory session writes it.
    await first.memoryDb.writePrivateLayer({
      accountId: 'discord:555',
      value: { details: [{ id: 1, text: 'told a secret', weight: 1, firstSeen: null, lastSeen: null }], detailsSeq: 2 },
    });
    written = store.getPrivate('discord:555');
  } finally {
    await first.close();
  }
  const second = await openTestMemory({ dataDir, now: () => LAYER_NOW, iface: () => 'discord' });
  try {
    const store = createStore({ dataDir, memoryDb: second.memoryDb });
    const read = store.getPrivate('discord:555') as { details?: Array<{ text?: unknown }> } | null;
    const [detail] = read?.details ?? [];
    assert.equal(detail?.text, 'told a secret');
    assert.deepEqual(read, written);
  } finally {
    await second.close();
  }
});

// A private unit of an account whose person is opaque, through the writer and the session overlay
// (src/memory/db/session-rows.ts, private-layer.ts): the rows carry the actual DM place as their audience, and the session's
// own rows stay on top after another writer flushes the unit. Plan 2026-11-04-cli-and-memory task 4.

const KEY: UnitKey = { kind: 'private', subject: { type: 'account', id: 'account:a21' } };
const PRIVATE = {
  accountId: 'n1',
  relationship: 'told only here',
  details: [{ id: 'd1', text: 'a private detail', at: '2026-11-01' }],
  interests: [],
  episodes: [],
  affinity: { score: 3, reason: null },
};

function withUnit(body: (db: Db, handle: MemoryHandle) => void): void {
  const handle = openMemoryDb(':memory:');
  try {
    seedOpaqueWorld(dbOf(handle));
    applyUnitUpdate(handle, { op: 'value', key: KEY, iface: 'telegram', value: PRIVATE });
    body(dbOf(handle), handle);
  } finally {
    handle.close();
  }
}

test('a private unit writes its rows under the actual DM place of the account, not under a derived one', () => {
  // Bug: `dmScope(person, iface)` over an opaque person gives no place, and every row turns `aud:internal`.
  withUnit((db) => {
    const audiences = db
      .prepare('SELECT DISTINCT audience_id FROM descriptions WHERE subject_id = ? AND id != ?')
      .all(ANNA, 'description:a12');
    assert.deepEqual(
      audiences.map((row) => row.audience_id),
      ['aud:dm:place:dm-a21']
    );
  });
});

test("the persona's newest attitude move in that DM survives a flush of the unit from another writer", () => {
  // Bug: a unit flush rewrites the rows and hides the session's affinity move until the next session.
  withUnit((db, handle) => {
    addAffinity(db, 'affinity:session', ANNA, 'place:dm-a21');
    applyUnitUpdate(handle, {
      op: 'value',
      key: KEY,
      iface: 'telegram',
      value: { ...PRIVATE, relationship: 'told only here, later' },
    });
    const row = db.prepare("SELECT retired_at FROM affinity_events WHERE id = 'affinity:session'").get();
    assert.equal(row?.retired_at ?? null, null);
  });
});
