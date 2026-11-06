// A place's notes unit (kind `place`, src/memory/db/map/place.ts) writes the place row only while no row holds it, and a
// write of the unit retires the rows it owns that its mapping leaves out (retireAbsent in src/memory/db/upsert.ts). The
// first write of a server's notes therefore owns the server row, and every later write must keep it active: a retired
// server leaves its channels pointing at a parent no reader shows, and <spatial_awareness> names it "(unnamed)".
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { placeCollection } from '../src/memory/db/storage-keys.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { applyUnitWrite } from '../src/memory/db/unit-write.ts';

const SERVER = 'place:server-1';

test('keeps the server place active when its notes unit is written a second time', () => {
  // Bug: the second write of a server's notes retires the server row the first write created.
  const handle = openMemoryDb(':memory:');
  try {
    const key = placeCollection('place', SERVER);
    applyUnitWrite(handle, { op: 'value', key, iface: 'discord', value: { injokes: ['first'] } });
    applyUnitWrite(handle, { op: 'value', key, iface: 'discord', value: { injokes: ['first', 'second'] } });
    const row = dbOf(handle).prepare('SELECT retired_at FROM places WHERE id = ?').get(SERVER);
    assert.ok(row, 'the first write creates the server place');
    assert.equal(row.retired_at, null);
  } finally {
    handle.close();
  }
});
