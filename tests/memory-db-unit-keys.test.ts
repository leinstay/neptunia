// Semantic account collections keep equal native IDs in distinct namespaces separate.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { applyUnitUpdate } from './fixtures/memory-db/unit-writes.ts';
import { unitSubjects, unitValue } from '../src/memory/db/readers/common.ts';
import type { UnitKey } from '../src/memory/db/unit-keys.ts';
import { accountId } from '../src/memory/db/ids.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { a, profile } from './fixtures/memory-db/storage-ownership.ts';

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
