// The record's reads from the database (stage W1): under authority `db` every read equals the file read of the same
// data, touches no file, and fails with a code (never a file read) when the database cannot answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecord } from '../src/memory/record.js';
import { createAppendStore } from '../src/memory/append-store.js';
import { GUILD, GUILD_2, MEMBER, CHANNEL_B, all, noFs, readerEnv } from './fixtures/memory-db/readers.js';

const silent = { info() {}, debug() {}, warn() {}, error() {} };
const noAppendStore = { iterate() { throw Object.assign(new Error('the files were read'), { code: 'FILE_READ' }); }, append() { throw new Error('no write'); } };

function pair(env) {
  const appendStore = createAppendStore({ log: silent });
  const files = createRecord({ appendStore, dataDir: env.data, log: silent });
  const db = createRecord({ appendStore: noAppendStore, dataDir: env.data, log: env.log, fs: noFs, memoryDb: env.memoryDb });
  return { files, db, appendStore };
}

test('record db reader: iterate equals the files for every guild, layer, range and channel, with no file read', async () => {
  const env = await readerEnv();
  const { files, db, appendStore } = pair(env);
  try {
    const queries = [
      {},
      { from: '2026-10-21T00:00:00.000Z' },
      { from: '2026-10-20T09:00:00.000Z', to: '2026-10-21T08:05:00.000Z' },
      { channelIds: [CHANNEL_B] },
      { privateUserId: MEMBER },
      { privateUserId: MEMBER, from: '2026-10-21T00:00:00.000Z' },
    ];
    let lines = 0;
    for (const guildId of [GUILD, GUILD_2]) {
      for (const query of queries) {
        const expected = await all(files.iterate(guildId, query));
        assert.deepEqual(await all(db.iterate(guildId, query)), expected, JSON.stringify(query));
        lines += expected.length;
      }
    }
    assert.ok(lines > 10, 'the fixture has lines to compare');
    const kinds = new Set((await all(db.iterate(GUILD))).map((line) => line.kind));
    assert.deepEqual([...kinds].sort(), ['deleted', 'said', 'seen']);
    assert.deepEqual(env.warns, []);
  } finally { await appendStore.close(); env.done(); }
});

test('record db reader: a member under a forget marker is hidden from the database read as from the files', async () => {
  const env = await readerEnv();
  const { files, db, appendStore } = pair(env);
  try {
    const fromDb = await all(db.iterate(GUILD, { from: '2026-10-21T00:00:00.000Z' }));
    assert.ok(!fromDb.some((line) => line.messageId === '400000000000000013'));
    assert.deepEqual(fromDb, await all(files.iterate(GUILD, { from: '2026-10-21T00:00:00.000Z' })));
  } finally { await appendStore.close(); env.done(); }
});

test('record db reader: newestRevision equals the id index for edited, single, deleted, private and unknown messages', async () => {
  const env = await readerEnv();
  const { files, db, appendStore } = pair(env);
  try {
    const cases = [
      [GUILD, '400000000000000001', '2026-10-20T09:00:00.000Z', null],
      [GUILD, '400000000000000011', '2026-10-21T08:00:00.000Z', null],
      [GUILD, '400000000000000012', '2026-10-21T08:05:00.000Z', null],
      [GUILD, '400000000000000014', '2026-10-21T08:07:00.000Z', null],
      [GUILD, '400000000000000099', '2026-10-21T08:07:00.000Z', null],
      [GUILD, '400000000000000005', '2026-10-20T09:00:00.000Z', MEMBER],
      [GUILD, '400000000000000001', '2026-09-20T09:00:00.000Z', null],
    ];
    const seen = [];
    for (const [guildId, id, at, privateUserId] of cases) {
      const expected = await files.newestRevision(guildId, id, at, { privateUserId });
      assert.equal(await db.newestRevision(guildId, id, at, { privateUserId }), expected, id);
      seen.push(expected);
    }
    assert.deepEqual(seen, [2, 2, 1, 1, null, 1, null]);
  } finally { await appendStore.close(); env.done(); }
});

test('record db reader: stats counts days, the first day and the distinct messages of the guild record', async () => {
  const env = await readerEnv();
  const { files, db, appendStore } = pair(env);
  try {
    // The second guild has nobody under a forget marker: the database holds every line its id index names.
    await files.newestRevision(GUILD_2, '410000000000000001', '2026-10-20T09:00:00.000Z');
    assert.deepEqual(await db.stats(GUILD_2), await files.stats(GUILD_2));
    assert.deepEqual(await db.stats(GUILD_2), { messages: 2, days: 1, first: '2026-10-20' });
    // A member under a marker was never imported: the database counts what it holds.
    assert.deepEqual(await db.stats(GUILD), { messages: 5, days: 2, first: '2026-10-20' });
  } finally { await appendStore.close(); env.done(); }
});

test('record db reader: a closed database or a failed read is an error with a code, logged, and never a file read', async () => {
  const env = await readerEnv();
  try {
    const closed = createRecord({ appendStore: noAppendStore, dataDir: env.data, log: env.log, fs: noFs, memoryDb: env.closedDb });
    await assert.rejects(() => all(closed.iterate(GUILD)), (error) => error.code === 'DB_CLOSED');
    await assert.rejects(() => closed.newestRevision(GUILD, '400000000000000001', '2026-10-20T09:00:00.000Z'), (error) => error.code === 'DB_CLOSED');
    await assert.rejects(() => closed.stats(GUILD), (error) => error.code === 'DB_CLOSED');
    const broken = { authority: () => 'db', readHandle: () => ({ db: { prepare() { throw Object.assign(new Error('disk I/O error'), { code: 'ERR_SQLITE_ERROR' }); } } }) };
    const failing = createRecord({ appendStore: noAppendStore, dataDir: env.data, log: env.log, fs: noFs, memoryDb: broken });
    await assert.rejects(() => all(failing.iterate(GUILD)), (error) => error.code === 'ERR_SQLITE_ERROR');
    assert.deepEqual(env.warns.map((warn) => [warn.message, warn.reader, warn.code]), [
      ['memory db: read failed', 'record', 'DB_CLOSED'],
      ['memory db: read failed', 'record', 'DB_CLOSED'],
      ['memory db: read failed', 'record', 'DB_CLOSED'],
      ['memory db: read failed', 'record', 'ERR_SQLITE_ERROR'],
    ]);
    assert.ok(env.warns.every((warn) => Object.keys(warn).sort().join() === 'code,message,reader'), 'codes only');
  } finally { env.done(); }
});

test('record db reader: under authority json the service is never asked and the files are read', async () => {
  const env = await readerEnv();
  const appendStore = createAppendStore({ log: silent });
  try {
    const files = createRecord({ appendStore, dataDir: env.data, log: silent });
    const json = createRecord({ appendStore, dataDir: env.data, log: silent, memoryDb: env.jsonDb });
    assert.deepEqual(await all(json.iterate(GUILD)), await all(files.iterate(GUILD)));
    assert.equal(await json.newestRevision(GUILD, '400000000000000011', '2026-10-21T08:00:00.000Z'), 2);
    await json.stats(GUILD);
    assert.equal(env.handleAsked(), 0);
    // An explicit authority wins over the service's.
    const forced = createRecord({ appendStore: noAppendStore, dataDir: env.data, log: silent, fs: noFs, memoryDb: env.jsonDb, authorityOf: () => 'db' });
    assert.deepEqual(await all(forced.iterate(GUILD)), await all(files.iterate(GUILD)));
  } finally { await appendStore.close(); env.done(); }
});
