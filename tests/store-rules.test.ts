// The owner's rules in the store (`rules`, written through the memory writer's `rules` kind): a rule added shows at
// once in the order of adding, a removed rule leaves the list and its row leaves the table, and a new store on the same
// database reads the rules back after a flush. Synthetic rules over a test memory database.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/memory/store.ts';
import { openTestMemory, tempDataDir } from './fixtures/memory-db/service.ts';

const T0 = Date.parse('2026-11-17T10:00:00Z');

test('lists the rules in the order they were added, before the writer holds them', async () => {
  const opened = await openTestMemory({ now: () => T0 });
  try {
    const store = createStore({ dataDir: opened.dataDir, memoryDb: opened.memoryDb });
    store.addRule('first');
    store.addRule('second');
    assert.deepEqual(
      store.liveRules().map((rule) => rule.text),
      ['first', 'second']
    );
  } finally {
    await opened.close();
  }
});

// The owner on 2026-11-17: removing a rule deletes it.
test('a removed rule leaves the list and its row leaves the table', async () => {
  const opened = await openTestMemory({ now: () => T0 });
  try {
    const store = createStore({ dataDir: opened.dataDir, memoryDb: opened.memoryDb });
    const first = store.addRule('first');
    store.addRule('second');
    await store.flushSettled({});
    store.removeRule(first.id);
    assert.deepEqual(
      store.liveRules().map((rule) => rule.text),
      ['second']
    );
    await store.flushSettled({});
    const db = opened.memoryDb.database();
    assert.ok(db, 'the memory is open');
    const rows = db.prepare('SELECT text FROM rules ORDER BY rowid').all();
    assert.deepEqual(
      rows.map((row) => row.text),
      ['second']
    );
  } finally {
    await opened.close();
  }
});

test('a rule written through one store is read back by a new store on the same database', async () => {
  const dataDir = tempDataDir('nep-rules-');
  const first = await openTestMemory({ dataDir, now: () => T0 });
  try {
    const store = createStore({ dataDir, memoryDb: first.memoryDb });
    store.addRule('kept');
    const gone = store.addRule('gone');
    store.removeRule(gone.id);
    await store.flushSettled({});
  } finally {
    await first.close();
  }
  const second = await openTestMemory({ dataDir, now: () => T0 });
  try {
    const store = createStore({ dataDir, memoryDb: second.memoryDb });
    assert.deepEqual(
      store.liveRules().map((rule) => rule.text),
      ['kept']
    );
  } finally {
    await second.close();
  }
});
