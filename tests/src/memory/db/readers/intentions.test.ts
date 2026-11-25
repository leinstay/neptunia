// Tests for src/memory/db/readers/intentions.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createIntentionStores } from '../../../../../src/intentions/store.ts';
import { readerEnv } from '../../../../fixtures/memory-db/readers.ts';

// The intention stores' reads from the database (stage W1): list, get and archived load from the database, and a
// failed load is an error with a code that the next `get` tries again.

const ids = (records: Array<{ id: string }>) => records.map((record) => record.id);

test('intentions db reader: list, get and archived come from the database', async () => {
  const env = await readerEnv();
  try {
    const stores = createIntentionStores({ log: env.log, memoryDb: env.memoryDb });
    const store = stores.get()!;
    assert.deepEqual(ids(store.list()), ['i2', 'i3']);
    assert.deepEqual(ids(store.archived()), ['i0']);
    assert.equal(store.get('i2')?.purpose, 'ask how the café went');
    assert.equal(store.get('i3')?.provenance?.scope, 'dm');
    assert.equal(store.get('nope'), null);
    // The second guild's empty store this line read is gone: intentions are the persona's, one store for every place.
    assert.deepEqual(
      env.warns.filter((warn) => warn.message === 'memory db: read failed'),
      []
    );
  } finally {
    env.done();
  }
});
