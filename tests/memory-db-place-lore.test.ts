// The write kind `place-lore` (src/memory/db/place-lore.ts) and the owner columns version step 49 gives the rows of a
// lorebook, a participation and recent lines (place-owner.ts#ownPlaceListRows). The first test writes the same
// lorebooks, participation and recent lines through the unit write and through the write kinds over copies of one
// seeded database and compares every table column by column. Then the stamps against step 49, the reads without the
// units, the codes and the generated lorebooks.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownPlaceListRows } from '../src/memory/db/place-owner.ts';
import { unitValue } from '../src/memory/db/readers/common.ts';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { placeCollection } from '../src/memory/db/storage-keys.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Row } from '../src/memory/db/types.ts';
import { generated, plain } from './fixtures/memory-db/roundtrip.ts';
import {
  CHANNEL,
  LIST_STEPS,
  NOW,
  OTHER_ROOT,
  ROOT,
  copyOf,
  seededPlaces,
  tablesOf,
  writeBothWays,
  writeDirect,
  writeListSteps,
} from './fixtures/memory-db/place-writes.ts';

test('lorebooks, a participation and recent lines store the same rows both ways', () => {
  const { unit, direct } = writeBothWays(LIST_STEPS);
  assert.equal(direct[0], unit[0]);
  assert.deepEqual(direct[1], unit[1]);
});

test('the writers stamp every row and link with the owner columns version step 49 derives from its unit', () => {
  const handle = copyOf(seededPlaces());
  try {
    writeListSteps(handle);
    const db = dbOf(handle);
    const stamped = tablesOf(db);
    assert.deepEqual(
      db
        .prepare('SELECT DISTINCT writer FROM episode_sources WHERE retired_at IS NULL')
        .all()
        .map((row) => row.writer),
      ['participation']
    );
    for (const table of ['claims', 'episodes', 'episode_sources', 'operational', 'co_owners'])
      db.exec(
        `UPDATE "${table}" SET writer = NULL, holder_id = NULL WHERE writer IN ('lore', 'participation', 'recent')`
      );
    ownPlaceListRows(db);
    assert.equal(tablesOf(db), stamped);
  } finally {
    handle.close();
  }
});

test('the lorebooks, the participation and the recent lines read the same once no unit owns their rows', () => {
  const handle = copyOf(seededPlaces());
  try {
    writeListSteps(handle);
    const db = dbOf(handle);
    const read = () => ({
      root: unitValue(db, placeCollection('lore', ROOT)),
      other: unitValue(db, placeCollection('lore', OTHER_ROOT)),
      participation: unitValue(db, placeCollection('participation', ROOT)),
      recent: unitValue(db, placeCollection('recent', CHANNEL)),
    });
    const before = read();
    assert.deepEqual(
      ((before.other as { value?: Array<Row> }).value ?? []).map((entry) => entry.id),
      ['harbour-1']
    );
    for (const table of ['claims', 'episodes', 'episode_sources', 'operational', 'co_owners'])
      db.exec(`UPDATE "${table}" SET owner_key = NULL WHERE writer IN ('lore', 'participation', 'recent')`);
    assert.deepEqual(read(), before);
  } finally {
    handle.close();
  }
});

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
