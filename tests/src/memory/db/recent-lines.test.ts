// Tests for src/memory/db/recent-lines.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unitValue } from '../../../../src/memory/db/readers/common.ts';
import { placeCollection } from '../../../../src/memory/db/unit-keys.ts';
import { dbOf } from '../../../../src/memory/db/types.ts';
import type { Row } from '../../../../src/memory/db/types.ts';
import { plain } from '../../../fixtures/memory-db/roundtrip.ts';
import { addChannelPlace } from '../../../fixtures/memory-db/opaque-people.ts';
import { CHANNEL, copyOf, line, recent, seededPlaces } from '../../../fixtures/memory-db/place-writes.ts';
import { seedRecentLines } from '../../../fixtures/memory-db/recent-rows.ts';

// The read of the recent lines earlier versions stored (src/memory/db/recent-lines.ts): the lines the persona said lately in a
// place, as claims of kind recent_line beside one operational row, seeded in that format (fixtures/memory-db/recent-rows.ts).
// Lines with a missing or repeated item id, an empty list and odd shapes come back as they were stored.

test('stored recent lines with a missing or repeated item id, an empty list and an odd shape read back as stored', () => {
  const values: ReadonlyArray<Row> = [
    recent([line(1, { itemId: undefined }), line(1, { itemId: undefined })]),
    { lines: [{ placeId: 5, text: 7 }] },
    { nextId: 1, lines: [] },
    { nextId: 3, lines: [line(1), line(2)] },
  ];
  for (const value of values) {
    const handle = copyOf(seededPlaces());
    try {
      seedRecentLines(dbOf(handle), CHANNEL, value);
      const read = unitValue(dbOf(handle), placeCollection('recent', CHANNEL));
      assert.deepEqual(read.found ? read.value : null, plain(value), JSON.stringify(value));
    } finally {
      handle.close();
    }
  }
});

test('a stored recent line names the place of its chat when the place id spells nothing, and reads back the chat', () => {
  const handle = copyOf(seededPlaces());
  try {
    const db = dbOf(handle);
    addChannelPlace(db, { id: 'place:9b21', iface: 'discord', authority: 'discord/global', native: 'room-n' });
    const value = recent([line(1, { placeId: 'room-n' })]);
    seedRecentLines(dbOf(handle), CHANNEL, value);
    const stored = db
      .prepare("SELECT subject_id AS place FROM claims WHERE writer = 'recent' AND retired_at IS NULL")
      .all();
    assert.deepEqual(
      stored.map((row) => row.place),
      ['place:9b21']
    );
    const read = unitValue(db, placeCollection('recent', CHANNEL));
    assert.deepEqual(read.found ? read.value : null, plain(value));
  } finally {
    handle.close();
  }
});
