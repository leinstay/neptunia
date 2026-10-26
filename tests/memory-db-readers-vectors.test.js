// The meaning index's reads from the database (stage W1): search, has and stats answer from the database for every
// layer, month, range and filter, leave an evicted vector out, and fail with a code when the database cannot answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createVectors } from '../src/memory/vectors.js';
import { openMemoryDb } from '../src/memory/db/open.js';
import { GUILD, GUILD_2, MEMBER, readerEnv } from './fixtures/memory-db/readers.js';

const QUERIES = [
  [0.3, 0.1, 0.2, 0.5],
  [-0.4, 0.3, 0.2, 0.1],
  [1, 0, 0, 0],
  [0, 0, -1, 0.2],
];
const OPTIONS = [
  { k: 10 },
  { k: 1 },
  { k: 10, months: ['2026-09'] },
  { k: 10, from: '2026-09-11T00:00:00.000Z', to: '2026-09-30T00:00:00.000Z' },
  { k: 10, filter: (meta) => meta.id !== '400000000000000022' },
  { k: 10, privateUserId: MEMBER },
];
const R = (n) => `4000000000000000${n}`;
/** The hits of the first guild, `[id, score]` best first, per query and option (the scores to four places). */
const EXPECTED = [
  [
    [
      [R(21), 0.9061],
      [R(23), 0.5251],
      [R(22), 0],
    ],
    [[R(21), 0.9061]],
    [
      [R(21), 0.9061],
      [R(23), 0.5251],
      [R(22), 0],
    ],
    [
      [R(23), 0.5251],
      [R(22), 0],
    ],
    [
      [R(21), 0.9061],
      [R(23), 0.5251],
    ],
    [['400000000000000005', 0.9134]],
  ],
  [
    [
      [R(22), 0.9984],
      [R(21), 0.3969],
      [R(23), -0.6929],
    ],
    [[R(22), 0.9984]],
    [
      [R(22), 0.9984],
      [R(21), 0.3969],
      [R(23), -0.6929],
    ],
    [
      [R(22), 0.9984],
      [R(23), -0.6929],
    ],
    [
      [R(21), 0.3969],
      [R(23), -0.6929],
    ],
    [['400000000000000005', -0.2616]],
  ],
  [
    [
      [R(23), 0.9234],
      [R(21), 0.184],
      [R(22), -0.7303],
    ],
    [[R(23), 0.9234]],
    [
      [R(23), 0.9234],
      [R(21), 0.184],
      [R(22), -0.7303],
    ],
    [
      [R(23), 0.9234],
      [R(22), -0.7303],
    ],
    [
      [R(23), 0.9234],
      [R(21), 0.184],
    ],
    [['400000000000000005', 0.4776]],
  ],
  [
    [
      [R(23), 0.3394],
      [R(22), -0.3192],
      [R(21), -0.3925],
    ],
    [[R(23), 0.3394]],
    [
      [R(23), 0.3394],
      [R(22), -0.3192],
      [R(21), -0.3925],
    ],
    [
      [R(23), 0.3394],
      [R(22), -0.3192],
    ],
    [
      [R(23), 0.3394],
      [R(21), -0.3925],
    ],
    [['400000000000000005', 0.0752]],
  ],
];

function sameHits(actual, expected, label) {
  assert.deepEqual(
    actual.map((hit) => hit.meta.id),
    expected.map(([id]) => id),
    label
  );
  actual.forEach((hit, i) => assert.ok(Math.abs(hit.score - expected[i][1]) <= 1e-4, `${label} score ${i}`));
}

test('vectors db reader: search answers every layer, month, range and filter from the database', async () => {
  const env = await readerEnv();
  try {
    const vectors = createVectors({ dataDir: env.data, log: env.log, memoryDb: env.memoryDb });
    for (const [q, query] of QUERIES.entries()) {
      for (const [o, option] of OPTIONS.entries()) {
        sameHits(await vectors.search(GUILD, query, option), EXPECTED[q][o], `query ${q} option ${o}`);
        // The second guild's only month is the fixture's hand-made one, whose files fail their checksum.
        assert.deepEqual(await vectors.search(GUILD_2, query, option), [], `guild 2 query ${q} option ${o}`);
      }
    }
    // A month whose rows fail their checksum (the fixture's hand-made month) is skipped, and logged.
    assert.ok(env.warns.length > 0 && env.warns.every((warn) => warn.message === 'vectors: checksum mismatch'));
  } finally {
    env.done();
  }
});

test('vectors db reader: has and stats for every layer and month', async () => {
  const env = await readerEnv();
  try {
    const vectors = createVectors({ dataDir: env.data, log: env.log, memoryDb: env.memoryDb });
    const keys = (...ids) => ids.map((id) => `record:${id}:1`);
    const expected = [
      [
        GUILD,
        null,
        { months: 2, rows: 5, bytes: 1420 },
        { '2026-09': keys(R(21), R(22), R(23)), '2026-10': keys(R('01'), R('02')), '2026-11': [] },
      ],
      [
        GUILD,
        MEMBER,
        { months: 1, rows: 1, bytes: 296 },
        { '2026-09': [], '2026-10': keys('400000000000000005'), '2026-11': [] },
      ],
      [
        GUILD_2,
        null,
        { months: 1, rows: 2, bytes: 532 },
        { '2026-09': [], '2026-10': keys('410000000000000001', '410000000000000002'), '2026-11': [] },
      ],
      [GUILD_2, MEMBER, { months: 0, rows: 0, bytes: 0 }, { '2026-09': [], '2026-10': [], '2026-11': [] }],
    ];
    for (const [guildId, privateUserId, stats, months] of expected) {
      assert.deepEqual(await vectors.stats(guildId, { privateUserId }), stats, `${guildId} ${privateUserId}`);
      for (const [month, held] of Object.entries(months)) {
        assert.deepEqual(
          [...(await vectors.has(guildId, month, { privateUserId }))].sort(),
          held,
          `${guildId} ${privateUserId} ${month}`
        );
      }
    }
  } finally {
    env.done();
  }
});

test('vectors db reader: an evicted vector is left out of the month, which is still read whole', async () => {
  const env = await readerEnv();
  try {
    const writer = openMemoryDb(env.dbFile);
    try {
      const changed = writer.db
        .prepare(
          "UPDATE vectors SET bytes = NULL, evicted_at = '2026-10-22T00:00:00.000Z' WHERE chunk_key = 'record:400000000000000022:1'"
        )
        .run().changes;
      assert.equal(changed, 1);
    } finally {
      writer.close();
    }
    const vectors = createVectors({ dataDir: env.data, log: env.log, memoryDb: env.memoryDb });
    for (const [q, query] of QUERIES.entries()) {
      sameHits(
        await vectors.search(GUILD, query, { k: 10, months: ['2026-09'] }),
        EXPECTED[q][2].filter(([id]) => id !== R(22)),
        `query ${q}`
      );
    }
    assert.deepEqual([...(await vectors.has(GUILD, '2026-09'))].sort(), [
      'record:400000000000000021:1',
      'record:400000000000000023:1',
    ]);
    assert.equal((await vectors.stats(GUILD)).rows, 4);
    assert.deepEqual(
      env.warns.filter((warn) => warn.message !== 'vectors: checksum mismatch'),
      []
    );
  } finally {
    env.done();
  }
});

test('vectors db reader: a closed database is an error with a code, logged', async () => {
  const env = await readerEnv();
  try {
    const closed = createVectors({ dataDir: env.data, log: env.log, memoryDb: env.closedDb });
    await assert.rejects(
      () => closed.search(GUILD, QUERIES[0], { k: 5 }),
      (error) => error.code === 'DB_CLOSED'
    );
    await assert.rejects(
      () => closed.has(GUILD, '2026-09'),
      (error) => error.code === 'DB_CLOSED'
    );
    await assert.rejects(
      () => closed.stats(GUILD),
      (error) => error.code === 'DB_CLOSED'
    );
    assert.deepEqual(
      env.warns.map((warn) => [warn.message, warn.reader, warn.code]),
      Array(3).fill(['memory db: read failed', 'vectors', 'DB_CLOSED'])
    );
  } finally {
    env.done();
  }
});
