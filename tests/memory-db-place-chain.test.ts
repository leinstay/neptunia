// src/memory/db/place-tree.ts: the chain of places from one place up to the top of its stored tree, the path the
// `<spatial_awareness>` block names (src/turn/request/spatial.ts). Synthetic places only.
//
// The signature these tests hold the code to:
//   export function placeChainInDb(db: Db, placeId: string): Array<{ id: string; kind: string | null; name: string | null }>;
// The place itself comes first, then each parent in turn.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { placeChainInDb } from '../src/memory/db/place-tree.ts';
import { dbOf } from '../src/memory/db/types.ts';
import { addGroupPlace } from './fixtures/memory-db/opaque-people.ts';

test('the chain runs from a thread up to its server, each place with its kind and name', () => {
  // Bug: the chain is read root first, or stops at the channel, and she never learns the category or the server.
  const handle = openMemoryDb(':memory:');
  try {
    const db = dbOf(handle);
    db.exec('PRAGMA foreign_keys = OFF');
    for (const id of ['srv', 'cat', 'chan', 'thr']) addGroupPlace(db, id, 'one', 'one/global');
    const set = db.prepare('UPDATE places SET kind = ?, name = ?, parent_id = ? WHERE id = ?');
    set.run('server', 'Example Server', null, 'srv');
    set.run('category', 'Lounge', 'srv', 'cat');
    set.run('channel', 'general', 'cat', 'chan');
    set.run('thread', 'weekend plans', 'chan', 'thr');
    assert.deepEqual(placeChainInDb(db, 'thr'), [
      { id: 'thr', kind: 'thread', name: 'weekend plans' },
      { id: 'chan', kind: 'channel', name: 'general' },
      { id: 'cat', kind: 'category', name: 'Lounge' },
      { id: 'srv', kind: 'server', name: 'Example Server' },
    ]);
    assert.deepEqual(placeChainInDb(db, 'srv'), [{ id: 'srv', kind: 'server', name: 'Example Server' }]);
  } finally {
    handle.close();
  }
});

test('the chain ends at a missing parent, stops before a cycle repeats, and is empty for a stranger', () => {
  // Bug: a broken tree throws in the middle of a turn, or a cycle hangs it.
  const handle = openMemoryDb(':memory:');
  try {
    const db = dbOf(handle);
    db.exec('PRAGMA foreign_keys = OFF');
    for (const id of ['orphan', 'a', 'b']) addGroupPlace(db, id, 'one', 'one/global');
    const parent = db.prepare('UPDATE places SET parent_id = ? WHERE id = ?');
    parent.run('gone', 'orphan');
    parent.run('b', 'a');
    parent.run('a', 'b');
    assert.deepEqual(
      placeChainInDb(db, 'orphan').map((link) => link.id),
      ['orphan']
    );
    assert.deepEqual(
      placeChainInDb(db, 'a').map((link) => link.id),
      ['a', 'b']
    );
    assert.deepEqual(placeChainInDb(db, 'nobody'), []);
  } finally {
    handle.close();
  }
});
