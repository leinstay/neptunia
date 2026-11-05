// src/memory/db/place-tree.ts: the walk up `parent_id`, through depth, a missing parent and a cycle.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { rootPlaceInDb } from '../src/memory/db/place-tree.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { addGroupPlace } from './fixtures/memory-db/opaque-people.ts';

test('the walk ends at the top, at the last stored place, and answers none for a cycle or a stranger', () => {
  // Bug: a broken chain throws in the middle of a turn, or a cycle hangs it.
  const handle = openMemoryDb(':memory:');
  try {
    const db = dbOf(handle);
    db.exec('PRAGMA foreign_keys = OFF');
    for (const id of ['top', 'mid', 'leaf', 'orphan', 'a', 'b']) addGroupPlace(db, id, 'one', 'one/global');
    const parent = db.prepare('UPDATE places SET parent_id = ? WHERE id = ?');
    parent.run('top', 'mid');
    parent.run('mid', 'leaf');
    parent.run('gone', 'orphan');
    parent.run('b', 'a');
    parent.run('a', 'b');
    assert.equal(rootPlaceInDb(db, 'leaf'), 'top');
    assert.equal(rootPlaceInDb(db, 'top'), 'top');
    assert.equal(rootPlaceInDb(db, 'orphan'), 'orphan');
    assert.equal(rootPlaceInDb(db, 'a'), null);
    assert.equal(rootPlaceInDb(db, 'nobody'), null);
  } finally {
    handle.close();
  }
});
