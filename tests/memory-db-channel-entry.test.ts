// The write kind `channel-entry` (src/memory/db/channel-entry.ts): a channel's entry of the server map written as its
// rows directly instead of through the channel mapper of a unit write. The first test writes the same entries through
// the unit write and through the write kind, over copies of one seeded database, and compares every table column by
// column, the owner columns of the unit way taken from version step 48. Then the code, the parent and kind the
// interface reported, the store over a reopen and the generated entries.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unitValue } from '../src/memory/db/readers/common.ts';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { placeCollection } from '../src/memory/db/unit-keys.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Row } from '../src/memory/db/types.ts';
import { createStore } from '../src/memory/store.ts';
import { generated, plain } from './fixtures/memory-db/roundtrip.ts';
import { openTestMemory, tempDataDir } from './fixtures/memory-db/service.ts';
import { CHANNEL, NOW, THREAD, copyOf, entry, seededPlaces, writeDirect } from './fixtures/memory-db/place-writes.ts';

test('a channel entry write that names no place is refused with a code', () => {
  const handle = copyOf(seededPlaces());
  try {
    assert.throws(() => applyMemoryWrite(handle, { kind: 'channel-entry', placeId: '', value: {}, now: NOW }), {
      code: 'CHANNEL_ENTRY_PLACE',
    });
  } finally {
    handle.close();
  }
});

test('a channel entry keeps the parent and the kind the interface reported, and a new channel has no parent', () => {
  // A category is no place, the owner's word of 2026-11-06: the parent is what the interface reports.
  const handle = copyOf(seededPlaces());
  try {
    writeDirect(handle, { kind: 'channel', placeId: THREAD, value: entry({ id: '200000000000000002' }) });
    writeDirect(handle, { kind: 'channel', placeId: 'discord:channel:200000000000000009', value: entry() });
    const row = (id: string) => dbOf(handle).prepare('SELECT kind, parent_id FROM places WHERE id = ?').get(id);
    assert.deepEqual({ ...row(THREAD) }, { kind: 'thread', parent_id: CHANNEL });
    assert.deepEqual({ ...row('discord:channel:200000000000000009') }, { kind: 'channel', parent_id: null });
  } finally {
    handle.close();
  }
});

test('the store reads back a channel entry after the database is closed and opened again', async () => {
  const dataDir = tempDataDir('nep-channel-entry-reopen-');
  const first = await openTestMemory({ dataDir, now: () => NOW, iface: () => 'discord' });
  let written: unknown;
  try {
    const store = createStore({ dataDir, memoryDb: first.memoryDb });
    store.touchChannel(CHANNEL, { name: 'général' }, NOW, '100000000000000001');
    store.updateChannel(CHANNEL, { purpose: 'Everyday talk.' });
    store.flush();
    await store.flushSettled({});
    written = store.getChannel(CHANNEL);
  } finally {
    await first.close();
  }
  const second = await openTestMemory({ dataDir, now: () => NOW, iface: () => 'discord' });
  try {
    const store = createStore({ dataDir, memoryDb: second.memoryDb });
    const read = store.getChannel(CHANNEL) as { purpose?: unknown } | null;
    assert.equal(read?.purpose, 'Everyday talk.');
    assert.deepEqual(read, written);
  } finally {
    await second.close();
  }
});

test('the generated entries with every key path of the live channel files come back as they were written', () => {
  for (const [index, given] of generated('channel').entries()) {
    const handle = copyOf(seededPlaces());
    try {
      const value = plain(given) as Row;
      writeDirect(handle, { kind: 'channel', placeId: CHANNEL, value });
      const read = unitValue(dbOf(handle), placeCollection('channel', CHANNEL));
      assert.ok(read.found, `generated channel ${index}`);
      assert.deepEqual(read.value, value, `generated channel ${index}`);
    } finally {
      handle.close();
    }
  }
});
