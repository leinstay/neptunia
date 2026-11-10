// The owner columns of the rows of a place's notes and a channel's entry (src/memory/db/place-owner.ts): every row the
// write kinds `place-notes` and `channel-entry` write names its writer and the place that holds it, and a row two
// roots' notes share is listed for the second root by the same columns, so the readers, the retirement of what the
// notes no longer hold and the hand-over of a shared row need no unit. The tests read the notes with the units'
// ownership taken away, hand over a shared self fact, and check that the writers register no unit.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unitValue } from '../src/memory/db/readers/common.ts';
import { placeCollection } from '../src/memory/db/unit-keys.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db, MemoryHandle } from '../src/memory/db/types.ts';
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

const OWNED = ['places', 'claims', 'descriptions', 'description_versions', 'operational', 'co_owners'];

/** The notes of two roots sharing a self fact, a direct chat's notes and a channel's entry. */
function writeAll(handle: MemoryHandle): void {
  writeDirect(handle, { kind: 'place', placeId: ROOT, value: notes() });
  writeDirect(handle, { kind: 'place', placeId: OTHER_ROOT, value: { self: ['likes rain'], injokes: ['the goat'] } });
  writeDirect(handle, { kind: 'place', placeId: DM, value: { purpose: 'Ιδιωτική.', self: ['reads at night'] } });
  writeDirect(handle, { kind: 'channel', placeId: CHANNEL, value: entry() });
}

const selfFacts = (handle: MemoryHandle, placeId: string): unknown =>
  (unitValue(dbOf(handle), placeCollection('place', placeId)) as { value?: { self?: unknown } }).value?.self;

test('the notes and the channel entry read the same once no unit owns their rows', () => {
  const handle = copyOf(seededPlaces());
  try {
    writeAll(handle);
    const db = dbOf(handle);
    const read = () => ({
      root: unitValue(db, placeCollection('place', ROOT)),
      other: unitValue(db, placeCollection('place', OTHER_ROOT)),
      dm: unitValue(db, placeCollection('place', DM)),
      channel: unitValue(db, placeCollection('channel', CHANNEL)),
    });
    const before = read();
    assert.deepEqual(selfFacts(handle, OTHER_ROOT), ['likes rain']);
    for (const table of OWNED) db.exec(`UPDATE "${table}" SET owner_key = NULL WHERE writer IN ('place', 'channel')`);
    assert.deepEqual(read(), before);
  } finally {
    handle.close();
  }
});

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

/** The storage units and the rows naming a unit or a file the writes left: none once the rows own themselves. */
function legacyOwners(db: Db): Array<string> {
  const found: Array<string> = [];
  if (Number(db.prepare('SELECT COUNT(*) AS n FROM storage_units').get()?.n) > 0) found.push('storage_units');
  for (const { name } of db.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()) {
    if (name === 'graph_edges') continue; // its owner_key is the graph's own key, not a unit
    const columns = db
      .prepare(`PRAGMA table_info("${String(name)}")`)
      .all()
      .map((column) => String(column.name));
    for (const column of ['owner_key', 'owner_file', 'origin_file'].filter((col) => columns.includes(col)))
      if (db.prepare(`SELECT 1 FROM "${String(name)}" WHERE "${column}" IS NOT NULL LIMIT 1`).get())
        found.push(`${String(name)}.${column}`);
  }
  return found;
}

test('the writers of the notes and the channel entry register no storage unit and name no unit in a row', () => {
  const handle = copyOf(seededPlaces());
  try {
    writeAll(handle);
    assert.deepEqual(legacyOwners(dbOf(handle)), []);
  } finally {
    handle.close();
  }
});
