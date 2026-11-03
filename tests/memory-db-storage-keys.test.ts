// Semantic account collections keep equal native IDs in distinct namespaces separate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { applyUnitWrite } from '../src/memory/db/unit-write.ts';
import { unitValue } from '../src/memory/db/readers/common.ts';
import { unitRows } from '../src/memory/db/export.ts';
import { listUnits } from '../src/memory/db/storage-units.ts';
import type { StorageKey } from '../src/memory/db/storage-keys.ts';
import { accountId, guildPlaceId, personId } from '../src/memory/db/ids.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { a, profile } from './fixtures/memory-db/storage-ownership.ts';

test('fresh semantic units read and list independently for equal native account IDs in different namespaces', () => {
  const handle = openMemoryDb(':memory:');
  try {
    const other: StorageKey = {
      ...a,
      subject: { type: 'account', id: accountId('other', 'u1') },
      scopePlaceId: guildPlaceId('other', 'g1'),
    };
    applyUnitWrite(handle, { op: 'value', key: a, value: profile });
    applyUnitWrite(handle, {
      op: 'value',
      key: other,
      iface: 'other',
      value: { ...profile, names: ['Other synthetic'] },
    });
    assert.equal(unitRows(dbOf(handle), a).people[0].id, personId('discord', 'u1'));
    assert.equal(unitRows(dbOf(handle), other).people[0].id, personId('other', 'u1'));
    const one = unitValue(dbOf(handle), a);
    const two = unitValue(dbOf(handle), other);
    assert.ok(one.found && two.found);
    assert.deepEqual(Reflect.get(Object(one.value), 'names'), ['Synthetic']);
    assert.deepEqual(Reflect.get(Object(two.value), 'names'), ['Other synthetic']);
    assert.deepEqual(
      listUnits(dbOf(handle), { kind: 'user' })
        .map((unit) => unit.key)
        .sort((x, y) => x.subject.id.localeCompare(y.subject.id)),
      [a, other]
    );
  } finally {
    handle.close();
  }
});
