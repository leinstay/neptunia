// A private unit of an account whose person is opaque, through the writer and the session overlay
// (src/memory/db/session-rows.ts, private-layer.ts): the rows carry the actual DM place as their audience, and the session's
// own rows stay on top after another writer flushes the unit. Plan 2026-11-04-cli-and-memory task 4.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unitRows } from '../src/memory/db/export.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import type { StorageKey } from '../src/memory/db/storage-keys.ts';
import { applyUnitWrite } from '../src/memory/db/unit-write.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db, MemoryHandle } from '../src/memory/db/types.ts';
import { ANNA, addClaim, addAffinity, seedOpaqueWorld } from './fixtures/memory-db/opaque-people.ts';

const KEY: StorageKey = { kind: 'private', subject: { type: 'account', id: 'account:a21' } };
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
    applyUnitWrite(handle, { op: 'value', key: KEY, iface: 'telegram', value: PRIVATE });
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

test('the unit of an opaque person shows the session rows of that DM and no other DM', () => {
  // Bug: `personScopeOf` parses the interface out of the person id, so an opaque person gets no overlay at all.
  withUnit((db) => {
    addClaim(db, 'claim:session-here', ANNA, 'aud:dm:place:dm-a21');
    addClaim(db, 'claim:session-elsewhere', ANNA, 'aud:dm:place:dm-a11');
    const ids = (unitRows(db, KEY).claims ?? []).map((row) => row.id);
    assert.ok(ids.includes('claim:session-here'));
    assert.equal(ids.includes('claim:session-elsewhere'), false);
  });
});

test('her newest attitude move in that DM survives a flush of the unit from another writer', () => {
  // Bug: a unit flush rewrites the rows and hides the session's affinity move until the next session.
  withUnit((db, handle) => {
    addAffinity(db, 'affinity:session', ANNA, 'place:dm-a21');
    applyUnitWrite(handle, {
      op: 'value',
      key: KEY,
      iface: 'telegram',
      value: { ...PRIVATE, relationship: 'told only here, later' },
    });
    const row = db.prepare("SELECT retired_at FROM affinity_events WHERE id = 'affinity:session'").get();
    assert.equal(row?.retired_at ?? null, null);
    assert.ok((unitRows(db, KEY).affinity_events ?? []).some((one) => one.id === 'affinity:session'));
  });
});
