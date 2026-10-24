// The meaning index's reads from the database (stage W1): under authority `db` search, has and stats equal the file
// reads of the same data (scores within 1e-6), touch no file, leave an evicted vector out, and fail with a code (never
// a file read) when the database cannot answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVectors } from '../src/memory/vectors.js';
import { openMemoryDb } from '../src/memory/db/open.js';
import { GUILD, GUILD_2, HIDDEN, MEMBER, noFs, readerEnv } from './fixtures/memory-db/readers.js';

const silent = { info() {}, debug() {}, warn() {}, error() {} };
const QUERIES = [[0.3, 0.1, 0.2, 0.5], [-0.4, 0.3, 0.2, 0.1], [1, 0, 0, 0], [0, 0, -1, 0.2]];

function sameHits(actual, expected) {
  assert.equal(actual.length, expected.length);
  actual.forEach((hit, i) => {
    assert.deepEqual(hit.meta, expected[i].meta);
    assert.ok(Math.abs(hit.score - expected[i].score) <= 1e-6, `score ${i}`);
  });
}

test('vectors db reader: search equals the files for every layer, month, range and filter, with no file read', async () => {
  const env = await readerEnv();
  try {
    const files = createVectors({ dataDir: env.data, log: silent });
    const db = createVectors({ dataDir: env.data, log: env.log, fs: noFs, memoryDb: env.memoryDb });
    const options = [
      { k: 10 },
      { k: 1 },
      { k: 10, months: ['2026-09'] },
      { k: 10, from: '2026-09-11T00:00:00.000Z', to: '2026-09-30T00:00:00.000Z' },
      { k: 10, filter: (meta) => meta.id !== '400000000000000022' },
      { k: 10, privateUserId: MEMBER },
    ];
    let hits = 0;
    for (const guildId of [GUILD, GUILD_2]) {
      for (const query of QUERIES) {
        for (const option of options) {
          const expected = await files.search(guildId, query, option);
          sameHits(await db.search(guildId, query, option), expected);
          hits += expected.length;
        }
      }
    }
    assert.ok(hits > 20, 'the fixture has rows to rank');
    // The member under a forget marker is left out on both sides.
    assert.ok(!(await db.search(GUILD, QUERIES[2], { k: 10 })).some((hit) => hit.meta.by === HIDDEN));
    // A month whose files fail their checksum (the fixture's hand-made month) is skipped on both sides, and logged.
    assert.ok(env.warns.length > 0 && env.warns.every((warn) => warn.message === 'vectors: checksum mismatch'));
  } finally { env.done(); }
});

test('vectors db reader: has and stats equal the files for every layer and month', async () => {
  const env = await readerEnv();
  try {
    const files = createVectors({ dataDir: env.data, log: silent });
    const db = createVectors({ dataDir: env.data, log: silent, fs: noFs, memoryDb: env.memoryDb });
    for (const guildId of [GUILD, GUILD_2]) {
      for (const privateUserId of [null, MEMBER]) {
        assert.deepEqual(await db.stats(guildId, { privateUserId }), await files.stats(guildId, { privateUserId }));
        for (const month of ['2026-09', '2026-10', '2026-11']) {
          assert.deepEqual([...await db.has(guildId, month, { privateUserId })].sort(), [...await files.has(guildId, month, { privateUserId })].sort(), `${guildId} ${privateUserId} ${month}`);
        }
      }
    }
    assert.deepEqual([...await db.has(GUILD, '2026-09')].sort(), ['record:400000000000000021:1', 'record:400000000000000022:1', 'record:400000000000000023:1']);
  } finally { env.done(); }
});

test('vectors db reader: an evicted vector is left out of the month, which is still read whole', async () => {
  const env = await readerEnv();
  try {
    const writer = openMemoryDb(env.dbFile);
    try {
      const changed = writer.db.prepare("UPDATE vectors SET bytes = NULL, evicted_at = '2026-10-22T00:00:00.000Z' WHERE chunk_key = 'record:400000000000000022:1'").run().changes;
      assert.equal(changed, 1);
    } finally { writer.close(); }
    const files = createVectors({ dataDir: env.data, log: silent });
    const db = createVectors({ dataDir: env.data, log: env.log, fs: noFs, memoryDb: env.memoryDb });
    for (const query of QUERIES) {
      const expected = (await files.search(GUILD, query, { k: 10, months: ['2026-09'] })).filter((hit) => hit.meta.id !== '400000000000000022');
      sameHits(await db.search(GUILD, query, { k: 10, months: ['2026-09'] }), expected);
    }
    assert.deepEqual([...await db.has(GUILD, '2026-09')].sort(), ['record:400000000000000021:1', 'record:400000000000000023:1']);
    assert.equal((await db.stats(GUILD)).rows, (await files.stats(GUILD)).rows - 1);
    assert.deepEqual(env.warns.filter((warn) => warn.message !== 'vectors: checksum mismatch'), []);
  } finally { env.done(); }
});

test('vectors db reader: a closed database is an error with a code, logged, never a file read; json never asks the service', async () => {
  const env = await readerEnv();
  try {
    const closed = createVectors({ dataDir: env.data, log: env.log, fs: noFs, memoryDb: env.closedDb });
    await assert.rejects(() => closed.search(GUILD, QUERIES[0], { k: 5 }), (error) => error.code === 'DB_CLOSED');
    await assert.rejects(() => closed.has(GUILD, '2026-09'), (error) => error.code === 'DB_CLOSED');
    await assert.rejects(() => closed.stats(GUILD), (error) => error.code === 'DB_CLOSED');
    assert.deepEqual(env.warns.map((warn) => [warn.message, warn.reader, warn.code]), Array(3).fill(['memory db: read failed', 'vectors', 'DB_CLOSED']));
    const files = createVectors({ dataDir: env.data, log: silent });
    const json = createVectors({ dataDir: env.data, log: silent, memoryDb: env.jsonDb });
    sameHits(await json.search(GUILD, QUERIES[0], { k: 5 }), await files.search(GUILD, QUERIES[0], { k: 5 }));
    assert.equal(env.handleAsked(), 0);
  } finally { env.done(); }
});
