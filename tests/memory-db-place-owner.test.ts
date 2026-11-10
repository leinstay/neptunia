// The owner columns of the rows of a place's notes and a channel's entry (src/memory/db/place-owner.ts): every row the
// write kinds `place-notes` and `channel-entry` write names its writer and the place that holds it, and a row two
// roots' notes share is listed for the second root by the same columns, so the readers, the retirement of what the
// notes no longer hold and the hand-over of a shared row need no unit. The tests hand over a shared self fact and list
// a sharing root once.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unitValue } from '../src/memory/db/readers/common.ts';
import { placeCollection } from '../src/memory/db/unit-keys.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { MemoryHandle } from '../src/memory/db/types.ts';
import {
  CHANNEL,
  DM,
  OTHER_ROOT,
  ROOT,
  copyOf,
  entry,
  notes,
  seededPlaces,
  writeDirect,
} from './fixtures/memory-db/place-writes.ts';

/** The notes of two roots sharing a self fact, a direct chat's notes and a channel's entry. */
function writeAll(handle: MemoryHandle): void {
  writeDirect(handle, { kind: 'place', placeId: ROOT, value: notes() });
  writeDirect(handle, { kind: 'place', placeId: OTHER_ROOT, value: { self: ['likes rain'], injokes: ['the goat'] } });
  writeDirect(handle, { kind: 'place', placeId: DM, value: { purpose: 'Ιδιωτική.', self: ['reads at night'] } });
  writeDirect(handle, { kind: 'channel', placeId: CHANNEL, value: entry() });
}

const selfFacts = (handle: MemoryHandle, placeId: string): unknown =>
  (unitValue(dbOf(handle), placeCollection('place', placeId)) as { value?: { self?: unknown } }).value?.self;

test('a self fact two roots share goes to the other root when the first one drops it', () => {
  const handle = copyOf(seededPlaces());
  try {
    writeAll(handle);
    writeDirect(handle, { kind: 'place', placeId: ROOT, value: notes({ self: ['is a night owl'] }) });
    const db = dbOf(handle);
    const shared = db.prepare("SELECT writer, holder_id, retired_at FROM claims WHERE text = 'likes rain'").get();
    assert.deepEqual({ ...shared }, { writer: 'place', holder_id: OTHER_ROOT, retired_at: null });
    assert.deepEqual(selfFacts(handle, OTHER_ROOT), ['likes rain']);
    assert.deepEqual(selfFacts(handle, ROOT), ['is a night owl']);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM co_owners').get()?.n, 0);
  } finally {
    handle.close();
  }
});

test('a root that writes its notes again stays listed once beside the root that holds a shared self fact', () => {
  // Bug: the list of sharing places is deduplicated by a unit id the writers no longer give, so every write adds a row.
  const handle = copyOf(seededPlaces());
  try {
    writeAll(handle);
    const other = { self: ['likes rain'], injokes: ['the goat'] };
    writeDirect(handle, { kind: 'place', placeId: OTHER_ROOT, value: other });
    writeDirect(handle, { kind: 'place', placeId: OTHER_ROOT, value: other });
    assert.equal(dbOf(handle).prepare('SELECT COUNT(*) AS n FROM co_owners').get()?.n, 1);
  } finally {
    handle.close();
  }
});
