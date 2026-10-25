// The archive's reads from the database (stage W1): iterate and find answer from the database for every guild, layer,
// range, kind and scope, and fail with a code when the database cannot answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createArchive } from '../src/memory/archive.js';
import { GUILD, GUILD_2, MEMBER, all, readerEnv } from './fixtures/memory-db/readers.js';
import { HOT_ITEM } from './fixtures/memory-db/datadir.js';

test('archive db reader: iterate answers every guild, layer, range, kind and scope from the database', async () => {
  const env = await readerEnv();
  try {
    const archive = createArchive({ dataDir: env.data, log: env.log, memoryDb: env.memoryDb });
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
    const pair = (suffix) => [`ar-1${suffix}`, `ar-2${suffix}`];
    const expected = {
      [GUILD]: [pair(''), pair(''), [], pair(''), [], pair(''), ['arp-1'], []],
      [GUILD_2]: [pair('.g2'), pair('.g2'), [], pair('.g2'), [], pair('.g2'), [], []],
    };
    for (const guildId of [GUILD, GUILD_2]) {
      for (const [index, query] of queries.entries()) {
        assert.deepEqual((await all(archive.iterate(guildId, query))).map((entry) => entry.id), expected[guildId][index], `${guildId} ${JSON.stringify(query)}`);
      }
    }
    assert.deepEqual(env.warns, []);
  } finally { env.done(); }
});

test('archive db reader: find gathers an item from the guild and the private archives, oldest first', async () => {
  const env = await readerEnv();
  try {
    const archive = createArchive({ dataDir: env.data, log: env.log, memoryDb: env.memoryDb });
    assert.deepEqual((await archive.find(GUILD, 'gone-item')).map((entry) => entry.id), ['arp-1', 'ar-2']);
    assert.deepEqual((await archive.find(GUILD, HOT_ITEM)).map((entry) => entry.id), ['ar-1']);
    assert.deepEqual(await archive.find(GUILD, 'no-such-item'), []);
  } finally { env.done(); }
});

test('archive db reader: a closed database is an error with a code, logged', async () => {
  const env = await readerEnv();
  try {
    const closed = createArchive({ dataDir: env.data, log: env.log, memoryDb: env.closedDb });
    await assert.rejects(() => all(closed.iterate(GUILD)), (error) => error.code === 'DB_CLOSED');
    await assert.rejects(() => closed.find(GUILD, 'gone-item'), (error) => error.code === 'DB_CLOSED');
    assert.deepEqual(env.warns.map((warn) => [warn.message, warn.reader, warn.code]), [
      ['memory db: read failed', 'archive', 'DB_CLOSED'],
      ['memory db: read failed', 'archive', 'DB_CLOSED'],
    ]);
  } finally { env.done(); }
});
