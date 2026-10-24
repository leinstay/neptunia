// The intention stores' reads from the database (stage W1): under authority `db` list, get and archived equal the
// file reads of the same data with the files gone from the disk, and a failed load is an error with a code (never a
// file read) that the next `get` tries again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createIntentionStores } from '../src/intentions/store.js';
import { GUILD, GUILD_2, readerEnv } from './fixtures/memory-db/readers.js';

const silent = { info() {}, debug() {}, warn() {}, error() {} };

/** Every read of one guild's store. */
function reads(store) {
  return { list: store.list(), i2: store.get('i2'), i3: store.get('i3'), none: store.get('nope'), archived: store.archived() };
}

test('intentions db reader: list, get and archived equal the files, with the files gone from the disk', async () => {
  const env = await readerEnv();
  try {
    const expected = Object.fromEntries([GUILD, GUILD_2].map((g) => [g, reads(createIntentionStores({ dataDir: env.data, log: silent }).get(g))]));
    assert.deepEqual(expected[GUILD].list.map((record) => record.id), ['i2', 'i3']);
    assert.deepEqual(expected[GUILD].archived.map((record) => record.id), ['i0']);
    fs.renameSync(env.data, `${env.data}.gone`);
    const db = createIntentionStores({ dataDir: env.data, log: env.log, memoryDb: env.memoryDb });
    for (const g of [GUILD, GUILD_2]) assert.deepEqual(reads(db.get(g)), expected[g], g);
    assert.deepEqual(env.warns.filter((warn) => warn.message === 'memory db: read failed'), []);
    fs.renameSync(`${env.data}.gone`, env.data);
  } finally { env.done(); }
});

test('intentions db reader: a closed database fails the load with a code, logged; the next get tries again', async () => {
  const env = await readerEnv();
  try {
    let open = false;
    const memoryDb = { authority: () => 'db', readHandle: () => (open ? env.handle : null) };
    const stores = createIntentionStores({ dataDir: env.data, log: env.log, memoryDb });
    assert.throws(() => stores.get(GUILD), (error) => error.code === 'DB_CLOSED');
    assert.deepEqual(env.warns.map((warn) => [warn.message, warn.reader, warn.code]), [['memory db: read failed', 'intentions', 'DB_CLOSED']]);
    open = true;
    assert.deepEqual(stores.get(GUILD).list().map((record) => record.id), ['i2', 'i3']);
    const json = createIntentionStores({ dataDir: env.data, log: silent, memoryDb: env.jsonDb });
    assert.deepEqual(reads(json.get(GUILD)), reads(createIntentionStores({ dataDir: env.data, log: silent }).get(GUILD)));
    assert.equal(env.handleAsked(), 0);
  } finally { env.done(); }
});
