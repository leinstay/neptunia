// The record's reads from the database (stage W1): every read answers from the database for every guild, layer,
// range and channel, and fails with a code when the database cannot answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRecord } from '../src/memory/record.js';
import { GUILD, GUILD_2, MEMBER, CHANNEL_B, all, readerEnv } from './fixtures/memory-db/readers.js';

const line = (entry) => `${entry.kind}:${entry.messageId}:${entry.revision ?? '-'}`;

test('record db reader: iterate answers every guild, layer, range and channel from the database', async () => {
  const env = await readerEnv();
  try {
    const record = createRecord({ dataDir: env.data, log: env.log, memoryDb: env.memoryDb });
    const queries = [
      {},
      { from: '2026-10-21T00:00:00.000Z' },
      { from: '2026-10-20T09:00:00.000Z', to: '2026-10-21T08:05:00.000Z' },
      { channelIds: [CHANNEL_B] },
      { privateUserId: MEMBER },
      { privateUserId: MEMBER, from: '2026-10-21T00:00:00.000Z' },
    ];
    const expected = {
      [GUILD]: [
        [
          'seen:400000000000000001:1',
          'seen:400000000000000001:2',
          'seen:400000000000000002:1',
          'seen:400000000000000011:1',
          'seen:400000000000000012:1',
          'seen:400000000000000013:1',
          'said:400000000000000014:1',
          'deleted:400000000000000012:-',
          'seen:400000000000000011:2',
        ],
        [
          'seen:400000000000000011:1',
          'seen:400000000000000012:1',
          'seen:400000000000000013:1',
          'said:400000000000000014:1',
          'deleted:400000000000000012:-',
          'seen:400000000000000011:2',
        ],
        [
          'seen:400000000000000001:1',
          'seen:400000000000000001:2',
          'seen:400000000000000002:1',
          'seen:400000000000000011:1',
          'seen:400000000000000012:1',
          'seen:400000000000000011:2',
        ],
        ['seen:400000000000000012:1', 'deleted:400000000000000012:-'],
        ['seen:400000000000000005:1'],
        [],
      ],
      [GUILD_2]: [
        ['seen:410000000000000001:1', 'seen:410000000000000001:2', 'seen:410000000000000002:1'],
        [],
        ['seen:410000000000000001:1', 'seen:410000000000000001:2', 'seen:410000000000000002:1'],
        [],
        ['seen:410000000000000005:1'],
        [],
      ],
    };
    for (const guildId of [GUILD, GUILD_2]) {
      for (const [index, query] of queries.entries()) {
        assert.deepEqual(
          (await all(record.iterate(guildId, query))).map(line),
          expected[guildId][index],
          `${guildId} ${JSON.stringify(query)}`
        );
      }
    }
    const said = (await all(record.iterate(GUILD))).find((entry) => entry.kind === 'said');
    assert.equal(said.text, 'Ναι, of course');
    assert.deepEqual(env.warns, []);
  } finally {
    env.done();
  }
});

test('record db reader: newestRevision for edited, single, deleted, private and unknown messages', async () => {
  const env = await readerEnv();
  try {
    const record = createRecord({ dataDir: env.data, log: env.log, memoryDb: env.memoryDb });
    const cases = [
      [GUILD, '400000000000000001', '2026-10-20T09:00:00.000Z', null, 2],
      [GUILD, '400000000000000011', '2026-10-21T08:00:00.000Z', null, 2],
      [GUILD, '400000000000000012', '2026-10-21T08:05:00.000Z', null, 1],
      [GUILD, '400000000000000014', '2026-10-21T08:07:00.000Z', null, 1],
      [GUILD, '400000000000000099', '2026-10-21T08:07:00.000Z', null, null],
      [GUILD, '400000000000000005', '2026-10-20T09:00:00.000Z', MEMBER, 1],
      [GUILD, '400000000000000001', '2026-09-20T09:00:00.000Z', null, null],
    ];
    for (const [guildId, id, at, privateUserId, revision] of cases) {
      assert.equal(await record.newestRevision(guildId, id, at, { privateUserId }), revision, id);
    }
  } finally {
    env.done();
  }
});

test('record db reader: stats counts days, the first day and the distinct messages of the guild record', async () => {
  const env = await readerEnv();
  try {
    const record = createRecord({ dataDir: env.data, log: env.log, memoryDb: env.memoryDb });
    assert.deepEqual(await record.stats(GUILD_2), { messages: 2, days: 1, first: '2026-10-20' });
    assert.deepEqual(await record.stats(GUILD), { messages: 6, days: 2, first: '2026-10-20' });
  } finally {
    env.done();
  }
});

test('record db reader: a closed database or a failed read is an error with a code, logged', async () => {
  const env = await readerEnv();
  try {
    const closed = createRecord({ dataDir: env.data, log: env.log, memoryDb: env.closedDb });
    await assert.rejects(
      () => all(closed.iterate(GUILD)),
      (error) => error.code === 'DB_CLOSED'
    );
    await assert.rejects(
      () => closed.newestRevision(GUILD, '400000000000000001', '2026-10-20T09:00:00.000Z'),
      (error) => error.code === 'DB_CLOSED'
    );
    await assert.rejects(
      () => closed.stats(GUILD),
      (error) => error.code === 'DB_CLOSED'
    );
    const broken = {
      readHandle: () => ({
        db: {
          prepare() {
            throw Object.assign(new Error('disk I/O error'), { code: 'ERR_SQLITE_ERROR' });
          },
        },
      }),
    };
    const failing = createRecord({ dataDir: env.data, log: env.log, memoryDb: broken });
    await assert.rejects(
      () => all(failing.iterate(GUILD)),
      (error) => error.code === 'ERR_SQLITE_ERROR'
    );
    assert.deepEqual(
      env.warns.map((warn) => [warn.message, warn.reader, warn.code]),
      [
        ['memory db: read failed', 'record', 'DB_CLOSED'],
        ['memory db: read failed', 'record', 'DB_CLOSED'],
        ['memory db: read failed', 'record', 'DB_CLOSED'],
        ['memory db: read failed', 'record', 'ERR_SQLITE_ERROR'],
      ]
    );
    assert.ok(
      env.warns.every((warn) => Object.keys(warn).sort().join() === 'code,message,reader'),
      'codes only'
    );
  } finally {
    env.done();
  }
});
