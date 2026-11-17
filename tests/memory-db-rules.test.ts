// The table of the owner's rules (src/memory/db/rules.ts): `writeRules` inserts and deletes rows in one write and
// `liveRules` reads them in the order they were added. Synthetic rules over a test memory database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { liveRules, writeRules } from '../src/memory/db/rules.ts';
import { openTestMemory } from './fixtures/memory-db/service.ts';

const T0 = Date.parse('2026-11-17T10:00:00Z');

test('reads the rules in the order they were added, whatever their ids sort to', async () => {
  // Bug: the list comes back in id order, and the owner's numbering shifts under a rule he added first.
  const opened = await openTestMemory({ now: () => T0 });
  try {
    const db = opened.memoryDb.database();
    assert.ok(db);
    writeRules(db, { added: [{ id: 'z', text: 'first' }], removed: [] }, T0);
    writeRules(db, { added: [{ id: 'a', text: 'second' }], removed: [] }, T0 + 1000);
    assert.deepEqual(liveRules(db), [
      { id: 'z', text: 'first' },
      { id: 'a', text: 'second' },
    ]);
  } finally {
    await opened.close();
  }
});

test('a removed rule is deleted, and a write resent after a failure adds no second row', async () => {
  // Bug: the store resends a write the writer did not confirm, and the rule stands twice in the block.
  const opened = await openTestMemory({ now: () => T0 });
  try {
    const db = opened.memoryDb.database();
    assert.ok(db);
    const write = {
      added: [
        { id: 'one', text: 'kept' },
        { id: 'two', text: 'gone' },
      ],
      removed: [],
    };
    writeRules(db, write, T0);
    writeRules(db, write, T0 + 1000);
    const counted = writeRules(db, { added: [], removed: ['two', 'never-there'] }, T0 + 2000);
    assert.equal(counted.removed, 1);
    assert.deepEqual(liveRules(db), [{ id: 'one', text: 'kept' }]);
    assert.equal(db.prepare('SELECT COUNT(*) AS n FROM rules').get()?.n, 1);
  } finally {
    await opened.close();
  }
});
