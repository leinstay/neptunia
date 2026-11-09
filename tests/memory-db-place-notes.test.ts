// The write kind `place-notes` (src/memory/db/place-notes.ts): the notes of a place written as their rows directly
// instead of through the place mapper of a unit write. The first test writes the same notes through the unit write and
// through the write kind, over copies of one seeded database, and compares every table column by column, the owner
// columns of the unit way taken from version step 48. Then the code, the store over a reopen, the rows of a root and a
// direct chat, and the generated notes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unitValue } from '../src/memory/db/readers/common.ts';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { placeCollection } from '../src/memory/db/storage-keys.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Row } from '../src/memory/db/types.ts';
import { createStore } from '../src/memory/store.ts';
import { generated, plain } from './fixtures/memory-db/roundtrip.ts';
import { openTestMemory, tempDataDir } from './fixtures/memory-db/service.ts';
import {
  DM,
  NOW,
  OTHER_ROOT,
  ROOT,
  copyOf,
  notes,
  seededPlaces,
  writeBothWays,
  writeDirect,
} from './fixtures/memory-db/place-writes.ts';

test('notes of two roots sharing a self fact, a direct chat and a place with no row store the same rows both ways', () => {
  const { unit, direct } = writeBothWays([
    { kind: 'place', placeId: ROOT, value: notes() },
    { kind: 'place', placeId: OTHER_ROOT, value: { self: ['likes rain'], injokes: [] } },
    { kind: 'review' },
    { kind: 'place', placeId: ROOT, value: notes({ self: ['is a night owl'], injokes: ['Πέμπτη'] }) },
    {
      kind: 'place',
      placeId: DM,
      value: { purpose: 'Ιδιωτική κουβέντα.', tone: 'τρυφερός', self: ['reads at night'] },
    },
    { kind: 'place', placeId: 'discord:guild:300000000000000009', value: { patterns: 'Quiet.', odd: [1, { two: 2 }] } },
    { kind: 'place', placeId: OTHER_ROOT, value: {} },
  ]);
  assert.equal(direct[0], unit[0]);
  assert.deepEqual(direct[1], unit[1]);
});

test('a place notes write that names no place is refused with a code', () => {
  const handle = copyOf(seededPlaces());
  try {
    assert.throws(() => applyMemoryWrite(handle, { kind: 'place-notes', placeId: '', value: {}, now: NOW }), {
      code: 'PLACE_NOTES_PLACE',
    });
  } finally {
    handle.close();
  }
});

test('the server row stays live and the root keeps its prose fields after its notes are written twice', () => {
  // Bug: the second write of a server's notes retired the server row the first write adopted.
  const handle = copyOf(seededPlaces());
  try {
    writeDirect(handle, { kind: 'place', placeId: ROOT, value: notes() });
    writeDirect(handle, { kind: 'place', placeId: ROOT, value: notes({ injokes: ['the lamp incident'] }) });
    const db = dbOf(handle);
    assert.equal(db.prepare('SELECT retired_at FROM places WHERE id = ?').get(ROOT)?.retired_at, null);
    assert.deepEqual(
      db
        .prepare(
          'SELECT field, scope_kind FROM descriptions WHERE subject_id = ? AND retired_at IS NULL ORDER BY rowid'
        )
        .all(ROOT)
        .map((row) => [row.field, row.scope_kind]),
      [
        ['purpose', 'group'],
        ['patterns', 'group'],
        ['starters', 'group'],
      ]
    );
  } finally {
    handle.close();
  }
});

test('a direct chat keeps its prose fields and its self facts scoped to that chat', () => {
  // Bug: a direct chat's notes were kept where the groups read them.
  const handle = copyOf(seededPlaces());
  try {
    writeDirect(handle, { kind: 'place', placeId: DM, value: { purpose: 'Ιδιωτική.', self: ['reads at night'] } });
    const db = dbOf(handle);
    const scopes = [
      ...db.prepare('SELECT scope_kind, scope_dm FROM descriptions WHERE subject_id = ?').all(DM),
      ...db.prepare("SELECT scope_kind, scope_dm FROM claims WHERE kind = 'self_fact'").all(),
    ].map((row) => [row.scope_kind, row.scope_dm]);
    assert.deepEqual(scopes, [
      ['dm', 'person:partner'],
      ['dm', 'person:partner'],
    ]);
  } finally {
    handle.close();
  }
});

test('the store reads back a place notes after the database is closed and opened again', async () => {
  const dataDir = tempDataDir('nep-place-notes-reopen-');
  const first = await openTestMemory({ dataDir, now: () => NOW, iface: () => 'discord' });
  let written: unknown;
  try {
    const store = createStore({ dataDir, memoryDb: first.memoryDb });
    store.updatePlace('discord:guild:300000000000000005', { patterns: 'Laughs a lot.', injokes: ['the goat'] });
    store.flush();
    await store.flushSettled({});
    written = store.getPlace('discord:guild:300000000000000005');
  } finally {
    await first.close();
  }
  const second = await openTestMemory({ dataDir, now: () => NOW, iface: () => 'discord' });
  try {
    const store = createStore({ dataDir, memoryDb: second.memoryDb });
    const read = store.getPlace('discord:guild:300000000000000005') as { patterns?: unknown };
    assert.equal(read.patterns, 'Laughs a lot.');
    assert.deepEqual(read, written);
  } finally {
    await second.close();
  }
});

test('the generated notes with every key path of the live place files come back as they were written', () => {
  for (const [index, given] of generated('guild').entries()) {
    const handle = copyOf(seededPlaces());
    try {
      const value = plain(given) as Row;
      writeDirect(handle, { kind: 'place', placeId: ROOT, value });
      const read = unitValue(dbOf(handle), placeCollection('place', ROOT));
      assert.ok(read.found, `generated place ${index}`);
      assert.deepEqual(read.value, value, `generated place ${index}`);
    } finally {
      handle.close();
    }
  }
});
