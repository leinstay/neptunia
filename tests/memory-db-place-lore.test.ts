// The write kind `place-lore` (src/memory/db/place-lore.ts) and the owner columns version step 49 gives the rows of a
// lorebook, a participation and recent lines (place-owner.ts#ownPlaceListRows). The tests hold the codes and the
// generated lorebooks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unitValue } from '../src/memory/db/readers/common.ts';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { placeCollection } from '../src/memory/db/unit-keys.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Row } from '../src/memory/db/types.ts';
import { generated, plain } from './fixtures/memory-db/roundtrip.ts';
import { NOW, ROOT, copyOf, seededPlaces, writeDirect } from './fixtures/memory-db/place-writes.ts';

test('a write of each kind that names no place is refused with a code', () => {
  const handle = copyOf(seededPlaces());
  try {
    for (const [kind, code] of [
      ['place-lore', 'PLACE_LORE_PLACE'],
      ['participation-episodes', 'PARTICIPATION_PLACE'],
      ['recent-lines', 'RECENT_LINES_PLACE'],
    ])
      assert.throws(() => applyMemoryWrite(handle, { kind, placeId: '', value: {}, now: NOW }), { code }, kind);
  } finally {
    handle.close();
  }
});

test('the generated lorebooks with every key path of the live files come back as they were written', () => {
  for (const [index, given] of generated('lore').entries()) {
    const handle = copyOf(seededPlaces());
    try {
      const value = plain(given) as Array<Row>;
      writeDirect(handle, { kind: 'lore', placeId: ROOT, value });
      const read = unitValue(dbOf(handle), placeCollection('lore', ROOT));
      assert.deepEqual(read.found ? read.value : [], value, `generated lore ${index}`);
    } finally {
      handle.close();
    }
  }
});
