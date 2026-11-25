// Tests for src/memory/db/readers/common.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unitValue, unitSubjects } from '../../../../../src/memory/db/readers/common.ts';
import { openMemoryDb } from '../../../../../src/memory/db/open.ts';
import type { UnitKey } from '../../../../../src/memory/db/unit-keys.ts';
import { applyUnitUpdate } from '../../../../fixtures/memory-db/unit-writes.ts';
import { dbOf } from '../../../../../src/memory/db/types.ts';
import type { Db, MemoryHandle } from '../../../../../src/memory/db/types.ts';
import { ANNA, addClaim, seedOpaqueWorld } from '../../../../fixtures/memory-db/opaque-people.ts';
import { accountId } from '../../../../../src/memory/db/ids.ts';
import { a, profile } from '../../../../fixtures/memory-db/storage-ownership.ts';

// A private unit of an account whose person is opaque, through the writer and the session overlay
// (src/memory/db/session-rows.ts, private-layer.ts): the rows carry the actual DM place as their audience, and the session's
// own rows stay on top after another writer flushes the unit. Plan 2026-11-04-cli-and-memory task 4.

const KEY: UnitKey = { kind: 'private', subject: { type: 'account', id: 'account:a21' } };
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
    applyUnitUpdate(handle, { op: 'value', key: KEY, iface: 'telegram', value: PRIVATE });
    body(dbOf(handle), handle);
  } finally {
    handle.close();
  }
}

test('the unit of an opaque person shows the session rows of that DM and no other DM', () => {
  // Bug: `personScopeOf` parses the interface out of the person id, so an opaque person gets no overlay at all.
  withUnit((db) => {
    addClaim(db, 'claim:session-here', ANNA, 'aud:dm:place:dm-a21');
    addClaim(db, 'claim:session-elsewhere', ANNA, 'aud:dm:place:dm-a11');
    const layer = JSON.stringify((unitValue(db, KEY) as { value?: unknown }).value);
    assert.ok(layer.includes('the words of claim:session-here'));
    assert.equal(layer.includes('the words of claim:session-elsewhere'), false);
  });
});

// Semantic account collections keep equal native IDs in distinct namespaces separate.

test('fresh semantic units read and list independently for equal native account IDs in different namespaces', () => {
  const handle = openMemoryDb(':memory:');
  try {
    const other: UnitKey = {
      ...a,
      subject: { type: 'account', id: accountId('other', 'u1') },
    };
    applyUnitUpdate(handle, { op: 'value', key: a, value: profile });
    applyUnitUpdate(handle, {
      op: 'value',
      key: other,
      iface: 'other',
      value: { ...profile, names: ['Other synthetic'] },
    });
    // Each account no row held gets a meta-person of its own; the two never share one.
    const personOf = (account: string) =>
      dbOf(handle).prepare('SELECT person_id FROM accounts WHERE id = ?').get(account)?.person_id;
    assert.notEqual(personOf(a.subject.id), personOf(other.subject.id));
    const one = unitValue(dbOf(handle), a);
    const two = unitValue(dbOf(handle), other);
    assert.ok(one.found && two.found);
    assert.deepEqual(Reflect.get(Object(one.value), 'names'), ['Synthetic']);
    assert.deepEqual(Reflect.get(Object(two.value), 'names'), ['Other synthetic']);
    assert.deepEqual(
      unitSubjects(dbOf(handle), 'user'),
      [a.subject.id, other.subject.id].sort((x, y) => x.localeCompare(y))
    );
  } finally {
    handle.close();
  }
});
