// The archive's reads from the database (stage W1): under authority `db` iterate and find equal the file reads of
// the same data, touch no file, and fail with a code (never a file read) when the database cannot answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createArchive } from '../src/memory/archive.js';
import { createAppendStore } from '../src/memory/append-store.js';
import { GUILD, GUILD_2, MEMBER, all, noFs, readerEnv } from './fixtures/memory-db/readers.js';
import { HOT_ITEM } from './fixtures/memory-db/datadir.js';

const silent = { info() {}, debug() {}, warn() {}, error() {} };
const noAppendStore = { iterate() { throw Object.assign(new Error('the files were read'), { code: 'FILE_READ' }); } };

test('archive db reader: iterate equals the files for every guild, layer, range, kind and scope, with no file read', async () => {
  const env = await readerEnv();
  const appendStore = createAppendStore({ log: silent });
  try {
    const files = createArchive({ appendStore, dataDir: env.data, log: silent });
    const db = createArchive({ appendStore: noAppendStore, dataDir: env.data, log: env.log, fs: noFs, memoryDb: env.memoryDb });
    const queries = [
      {},
      { from: '2026-10-02T00:00:00.000Z' },
      { to: '2026-10-01T12:00:00.000Z' },
      { kinds: ['detail'] },
      { kinds: ['episode'] },
      { scope: { user: MEMBER } },
      { privateUserId: MEMBER },
      { privateUserId: MEMBER, from: '2026-11-01T00:00:00.000Z' },
    ];
    let entries = 0;
    for (const guildId of [GUILD, GUILD_2]) {
      for (const query of queries) {
        const expected = await all(files.iterate(guildId, query));
        assert.deepEqual(await all(db.iterate(guildId, query)), expected, JSON.stringify(query));
        entries += expected.length;
      }
    }
    assert.ok(entries > 5, 'the fixture has entries to compare');
    assert.deepEqual(env.warns, []);
  } finally { await appendStore.close(); env.done(); }
});

test('archive db reader: find gathers an item from the guild and the private archives, oldest first, as the files do', async () => {
  const env = await readerEnv();
  const appendStore = createAppendStore({ log: silent });
  try {
    const files = createArchive({ appendStore, dataDir: env.data, log: silent });
    const db = createArchive({ appendStore: noAppendStore, dataDir: env.data, log: env.log, fs: noFs, memoryDb: env.memoryDb });
    for (const itemId of ['gone-item', HOT_ITEM, 'no-such-item']) {
      assert.deepEqual(await db.find(GUILD, itemId), await files.find(GUILD, itemId), itemId);
    }
    const gone = await db.find(GUILD, 'gone-item');
    assert.deepEqual(gone.map((entry) => entry.id), ['arp-1', 'ar-2']);
  } finally { await appendStore.close(); env.done(); }
});

test('archive db reader: a closed database is an error with a code, logged, never a file read; json never asks the service', async () => {
  const env = await readerEnv();
  const appendStore = createAppendStore({ log: silent });
  try {
    const closed = createArchive({ appendStore: noAppendStore, dataDir: env.data, log: env.log, fs: noFs, memoryDb: env.closedDb });
    await assert.rejects(() => all(closed.iterate(GUILD)), (error) => error.code === 'DB_CLOSED');
    await assert.rejects(() => closed.find(GUILD, 'gone-item'), (error) => error.code === 'DB_CLOSED');
    assert.deepEqual(env.warns.map((warn) => [warn.message, warn.reader, warn.code]), [
      ['memory db: read failed', 'archive', 'DB_CLOSED'],
      ['memory db: read failed', 'archive', 'DB_CLOSED'],
    ]);
    const files = createArchive({ appendStore, dataDir: env.data, log: silent });
    const json = createArchive({ appendStore, dataDir: env.data, log: silent, memoryDb: env.jsonDb });
    assert.deepEqual(await json.find(GUILD, 'gone-item'), await files.find(GUILD, 'gone-item'));
    assert.equal(env.handleAsked(), 0);
  } finally { await appendStore.close(); env.done(); }
});
