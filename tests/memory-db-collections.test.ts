// src/memory/db/storage-keys.ts: the neutral constructors of a storage collection. A collection belongs to an account, a
// person or a place, and its key holds that id as given: no interface read from the air, no community, no parsing.
// Contract, plan 2026-11-04-cli-and-memory task 5:
//   accountCollection(kind, accountId, options?): StorageKey     subject { type: 'account', id }
//   personCollection(kind, personId, options?): StorageKey       subject { type: 'person', id }
//   placeCollection(kind, placeId, options?): StorageKey         subject { type: 'place', id }
//   journalKey(placeId, day): StorageKey
//   errandKey(itemId): StorageKey                                a persona collection
//   vectorAddresses().baseDir(placeId)
// `options` is { partition?, selector? }. An empty id throws code `BAD_COLLECTION_ID`.
// Appendix entries: src/memory/db/storage-keys.ts, src/memory/db/storage-units.ts, src/memory/db/unit-write.ts,
// src/memory/db/upsert.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { unitValue } from '../src/memory/db/readers/common.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import * as keys from '../src/memory/db/storage-keys.ts';
import {
  accountCollection,
  errandKey,
  journalKey,
  keyText,
  personCollection,
  placeCollection,
  storageId,
  vectorAddresses,
} from '../src/memory/db/storage-keys.ts';
import { ensureUnit, listUnits, unitById } from '../src/memory/db/storage-units.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { applyUnitWrite } from '../src/memory/db/unit-write.ts';
import { seedOpaqueWorld } from './fixtures/memory-db/opaque-people.ts';

test('each constructor names its subject with the id as given and no community scope', () => {
  // Bug: a constructor reads the ambient interface or wraps the id in `<iface>:guild:`.
  assert.deepEqual(accountCollection('private', 'account:a11'), {
    kind: 'private',
    subject: { type: 'account', id: 'account:a11' },
  });
  assert.deepEqual(personCollection('private', 'person:0b7a4c1e'), {
    kind: 'private',
    subject: { type: 'person', id: 'person:0b7a4c1e' },
  });
  assert.deepEqual(placeCollection('lore', 'place:room-1'), {
    kind: 'lore',
    subject: { type: 'place', id: 'place:room-1' },
  });
});

test('a partition and a selector identify a collection inside its subject', () => {
  // Bug: two months of one place's vectors or two errands share one collection.
  const may = placeCollection('vectors', 'place:room-1', { partition: '2026-05' });
  const june = placeCollection('vectors', 'place:room-1', { partition: '2026-06' });
  assert.equal(may.partition, '2026-05');
  assert.notEqual(storageId(may), storageId(june));
  const selected = placeCollection('versions', 'place:room-1', { selector: { versionKind: 'lore', itemId: 'x' } });
  assert.deepEqual(selected.selector, { versionKind: 'lore', itemId: 'x' });
});

test('the same id gives the same storage id, and different kinds of subject never collide', () => {
  // Bug: an account and a place with one id share a row in the catalog.
  assert.equal(storageId(placeCollection('lore', 'x:1')), storageId(placeCollection('lore', 'x:1')));
  const ids = new Set([
    storageId(accountCollection('private', 'x:1')),
    storageId(personCollection('private', 'x:1')),
    storageId(placeCollection('private', 'x:1')),
  ]);
  assert.equal(ids.size, 3);
});

test('an empty id is refused with a code', () => {
  // Bug: `''` makes one shared collection for everyone whose id failed to resolve (`one:guild:` today).
  for (const build of [accountCollection, personCollection, placeCollection]) {
    assert.throws(
      () => build('lore', ''),
      (error: { code?: string }) => error.code === 'BAD_COLLECTION_ID'
    );
  }
  assert.throws(
    () => journalKey('', '2026-11-01'),
    (error: { code?: string }) => error.code === 'BAD_COLLECTION_ID'
  );
});

test('the journal of a day belongs to its place, an errand to the persona, vectors to a place', () => {
  // Bug: the three keyed helpers keep asking a service for its namespace and a community for its scope.
  assert.deepEqual(journalKey('place:dm-a11', '2026-11-01'), {
    kind: 'journal',
    subject: { type: 'place', id: 'place:dm-a11' },
    partition: '2026-11-01',
  });
  assert.equal(errandKey('task-1').subject.type, 'persona');
  assert.deepEqual(errandKey('task-1').selector, { collection: 'value', itemId: 'task-1' });
  const vectors = vectorAddresses();
  const key = vectors.vectorKey(vectors.baseDir('place:dm-a11'));
  assert.deepEqual(key.subject, { type: 'place', id: 'place:dm-a11' });
  assert.equal(key.scopePlaceId, undefined);
});

test('no constructor that takes a community remains', () => {
  // Bug: a caller keeps building the community partition next to the neutral one, and two collections drift apart.
  assert.equal('communityKey' in keys, false);
});

test('the catalog registers, finds and lists a person collection like any other', () => {
  // Bug: the catalog's subject types stop at `authority`, so a person collection never lists.
  const handle = openMemoryDb(':memory:');
  try {
    const db = dbOf(handle);
    const key = personCollection('state', 'person:0b7a4c1e');
    const id = ensureUnit(db, key);
    assert.deepEqual(unitById(db, id)?.key, key);
    assert.deepEqual(
      listUnits(db, { subject: { type: 'person', id: 'person:0b7a4c1e' } }).map((unit) => unit.id),
      [id]
    );
    assert.equal((JSON.parse(keyText(key)) as { subject: { type: string } }).subject.type, 'person');
  } finally {
    handle.close();
  }
});

test('a place collection and an account collection write and read back through the writer', () => {
  // Bug: `applyUnitWrite` maps a unit by its community scope, so a key without one is refused as unmapped.
  const handle = openMemoryDb(':memory:');
  try {
    const db = dbOf(handle);
    seedOpaqueWorld(db);
    const lore = placeCollection('lore', 'place:room-1');
    applyUnitWrite(handle, {
      op: 'value',
      key: lore,
      iface: 'discord',
      value: { entries: [{ id: 'l1', text: 'a synthetic fact', keys: [] }] },
    });
    const read = unitValue(db, lore);
    assert.equal(read.found, true);
    const owner = accountCollection('user', 'account:a21');
    applyUnitWrite(handle, { op: 'value', key: owner, iface: 'telegram', value: { names: ['Synthetic'] } });
    const person = unitValue(db, owner);
    assert.deepEqual(person.found ? Reflect.get(Object(person.value), 'names') : null, ['Synthetic']);
  } finally {
    handle.close();
  }
});
