// The write kind `private-layer` (src/memory/db/private-layer.ts): what she learned about a member in their direct chat,
// written as its rows directly instead of through the private mapper of a unit write. The first test writes the same
// layers through the unit write and through the write kind, over copies of one seeded database, and compares every
// table column by column. Then the codes, the store over a reopen and the generated layers.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { accountCollection } from '../src/memory/db/unit-keys.ts';
import { unitValue } from '../src/memory/db/readers/common.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Row } from '../src/memory/db/types.ts';
import { createStore } from '../src/memory/store.ts';
import { generated, plain } from './fixtures/memory-db/roundtrip.ts';
import { openTestMemory, tempDataDir } from './fixtures/memory-db/service.ts';

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

test('the store reads back a private layer after the database is closed and opened again', async () => {
  const dataDir = tempDataDir('nep-private-reopen-');
  const first = await openTestMemory({ dataDir, now: () => NOW, iface: () => 'discord' });
  let written: unknown;
  try {
    const store = createStore({ dataDir, memoryDb: first.memoryDb });
    store.touchUser('discord:555', 'Fifth', NOW);
    // The engine has no episode writer, so a detail is the private write read back here.
    store.applyPrivateOps('discord:555', { details: { add: ['told a secret'] } });
    store.flush();
    await store.flushSettled({});
    written = store.getPrivate('discord:555');
  } finally {
    await first.close();
  }
  const second = await openTestMemory({ dataDir, now: () => NOW, iface: () => 'discord' });
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
