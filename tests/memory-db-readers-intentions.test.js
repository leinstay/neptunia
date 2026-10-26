// The intention stores' reads from the database (stage W1): list, get and archived load from the database, and a
// failed load is an error with a code that the next `get` tries again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIntentionStores } from '../src/intentions/store.js';
import { GUILD, GUILD_2, readerEnv } from './fixtures/memory-db/readers.js';

const ids = (records) => records.map((record) => record.id);

test('intentions db reader: list, get and archived come from the database', async () => {
  const env = await readerEnv();
  try {
    const stores = createIntentionStores({ log: env.log, memoryDb: env.memoryDb });
    const store = stores.get(GUILD);
    assert.deepEqual(ids(store.list()), ['i2', 'i3']);
    assert.deepEqual(ids(store.archived()), ['i0']);
    assert.equal(store.get('i2')?.purpose, 'ask how the café went');
    assert.equal(store.get('i3')?.provenance?.scope, 'dm');
    assert.equal(store.get('nope'), null);
    assert.deepEqual([ids(stores.get(GUILD_2).list()), ids(stores.get(GUILD_2).archived())], [[], []]);
    assert.deepEqual(
      env.warns.filter((warn) => warn.message === 'memory db: read failed'),
      []
    );
  } finally {
    env.done();
  }
});

test('intentions db reader: a closed database fails the load with a code, logged; the next get tries again', async () => {
  const env = await readerEnv();
  try {
    let open = false;
    const memoryDb = { readHandle: () => (open ? env.handle : null), database: () => (open ? env.handle.db : null) };
    const stores = createIntentionStores({ log: env.log, memoryDb });
    assert.throws(
      () => stores.get(GUILD),
      (error) => error.code === 'DB_CLOSED'
    );
    assert.deepEqual(
      env.warns.map((warn) => [warn.message, warn.reader, warn.code]),
      [['memory db: read failed', 'intentions', 'DB_CLOSED']]
    );
    open = true;
    assert.deepEqual(ids(stores.get(GUILD).list()), ['i2', 'i3']);
  } finally {
    env.done();
  }
});
