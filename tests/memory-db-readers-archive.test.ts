// The archive's reads from the database (stage W1): iterate and find answer from the database for every guild, layer,
// range, kind and scope, and fail with a code when the database cannot answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createArchive } from '../src/memory/archive.ts';
import { GUILD, placeOfGuild, readAt, GUILD_2, MEMBER, all, readerEnv } from './fixtures/memory-db/readers.ts';
import { HOT_ITEM } from './fixtures/memory-db/datadir.ts';

// The entries of the archive are untyped records; the tests read their ids.
const idOf = (entry: object) => (entry as { id: string }).id;

test('archive db reader: iterate answers every guild, layer, range, kind and scope from the database', async () => {
  const env = await readerEnv();
  try {
    // The reads under test answer from the database, so no append store is given.
    // @ts-expect-error appendStore is required of an archive that writes
    const archive = createArchive({ dataDir: env.data, log: env.log, memoryDb: env.memoryDb });
    const queries = [
      {},
      { from: '2026-10-02T00:00:00.000Z' },
      { to: '2026-10-01T12:00:00.000Z' },
      { kinds: ['detail'] },
      { kinds: ['episode'] },
      { scope: { user: MEMBER } },
      { privateAccountId: MEMBER },
      { privateAccountId: MEMBER, from: '2026-11-01T00:00:00.000Z' },
    ];
    const pair = (suffix: string) => [`ar-1${suffix}`, `ar-2${suffix}`];
    const expected: Record<string, Array<Array<string>>> = {
      [GUILD]: [pair(''), pair(''), [], pair(''), [], pair(''), ['arp-1'], []],
      [GUILD_2]: [pair('.g2'), pair('.g2'), [], pair('.g2'), [], pair('.g2'), [], []],
    };
    for (const placeId of [GUILD, GUILD_2]) {
      for (const [index, query] of queries.entries()) {
        // A DM place has no guild: the private queries run once, under the first guild.
        if (placeId === GUILD_2 && 'privateAccountId' in query) continue;
        const { placeId: holder, rest } = readAt(placeId, query);
        assert.deepEqual(
          (await all(archive.iterate(holder, rest))).map(idOf),
          expected[placeId][index],
          `${placeId} ${JSON.stringify(query)}`
        );
      }
    }
    assert.deepEqual(env.warns, []);
  } finally {
    env.done();
  }
});

test('archive db reader: find gathers an item from the guild and the private archives, oldest first', async () => {
  const env = await readerEnv();
  try {
    // The reads under test answer from the database, so no append store is given.
    // @ts-expect-error appendStore is required of an archive that writes
    const archive = createArchive({ dataDir: env.data, log: env.log, memoryDb: env.memoryDb });
    // Every holder's archive: the DM place's, then each server's copy of the fixture.
    assert.deepEqual((await archive.find('gone-item')).map(idOf), ['arp-1', 'ar-2', 'ar-2.g2']);
    assert.deepEqual((await archive.find(HOT_ITEM)).map(idOf), ['ar-1']);
    assert.deepEqual(await archive.find('no-such-item'), []);
  } finally {
    env.done();
  }
});

test('archive db reader: a closed database is an error with a code, logged', async () => {
  const env = await readerEnv();
  try {
    // @ts-expect-error no append store, as above
    const closed = createArchive({ dataDir: env.data, log: env.log, memoryDb: env.closedDb });
    await assert.rejects(
      () => all(closed.iterate(placeOfGuild(GUILD))),
      (error: NodeJS.ErrnoException) => error.code === 'DB_CLOSED'
    );
    await assert.rejects(
      () => closed.find('gone-item'),
      (error: NodeJS.ErrnoException) => error.code === 'DB_CLOSED'
    );
    assert.deepEqual(
      env.warns.map((warn) => [warn.message, warn.reader, warn.code]),
      [
        ['memory db: read failed', 'archive', 'DB_CLOSED'],
        ['memory db: read failed', 'archive', 'DB_CLOSED'],
      ]
    );
  } finally {
    env.done();
  }
});
