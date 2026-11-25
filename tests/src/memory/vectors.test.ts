// Tests for src/memory/vectors.ts: the int8 vector index for meaning search, in the memory database of a
// temporary directory (never the deployment's data/), with a fixed clock and seeded vectors.
// Later sections read through the reader fixture and reopen the database.
import { after, test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { createVectors, dequantize, quantize } from '../../../src/memory/vectors.ts';
import { lineVectorShape } from '../../../src/memory/db/line-vectors.ts';
import { dbOf } from '../../../src/memory/db/types.ts';
import type { Db } from '../../../src/memory/db/types.ts';
import { openTestMemory } from '../../fixtures/memory-db/service.ts';
import type { TestMemory } from '../../fixtures/memory-db/service.ts';
import fs from 'node:fs';
import { openMemoryDb } from '../../../src/memory/db/open.ts';
import { GUILD, placeOfGuild, readAt, GUILD_2, MEMBER, readerEnv } from '../../fixtures/memory-db/readers.ts';
import path from 'node:path';
import { createAppendStore } from '../../../src/memory/append-store.ts';
import { createArchive } from '../../../src/memory/archive.ts';
import { createMemoryDb } from '../../../src/memory/db/service.ts';
import type { MemoryDbService } from '../../../src/memory/db/service.ts';
import { createJournal } from '../../../src/memory/journal.ts';
import { createRecord, toRecordLine } from '../../../src/memory/record.ts';
import { createStore } from '../../../src/memory/store.ts';
import '../../../src/tools/operations/index.ts';
import { wrongly } from '../../fixtures/loose-types.ts';
import { addAccount, addDmPlace, addGroupPlace } from '../../fixtures/memory-db/opaque-people.ts';
import { tempDir } from '../../fixtures/tmp.ts';
import { createEmbedder } from '../../../src/memory/embedder.ts';
import { OBSERVATION_VERSION } from '../../../src/memory/db/observe.ts';
import { chainsOf } from '../../fixtures/chains.ts';

const quiet = { info() {}, warn() {}, error() {} };
const OCT = Date.UTC(2026, 9, 13, 9, 0, 0);

/** A seeded generator (mulberry32). */
function seeded(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function randomVector(rng: () => number, dims: number) {
  const v = new Float32Array(dims);
  for (let i = 0; i < dims; i += 1) v[i] = rng() * 2 - 1;
  return v;
}

/** `base` nudged by noise of size `amount`. */
function near(base: Float32Array, rng: () => number, amount: number) {
  const v = new Float32Array(base.length);
  for (let i = 0; i < base.length; i += 1) v[i] = base[i] + (rng() * 2 - 1) * amount;
  return v;
}

function cosine(a: ArrayLike<number>, b: ArrayLike<number>) {
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i += 1) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  return dot / Math.sqrt(na * nb);
}

function meta(id: string, overrides: Record<string, unknown> = {}) {
  return {
    kind: 'record',
    id,
    revision: 1,
    occurredAt: '2026-10-12T10:00:00.000Z',
    placeId: 'c1',
    by: 'u1',
    participants: ['u1'],
    sourceIds: [id],
    ...overrides,
  };
}

/** The test databases opened here; closed when the file is done. */
const OPENED: Array<Awaited<ReturnType<typeof openTestMemory>>> = [];
after(async () => {
  for (const mem of OPENED) await mem.close();
});

async function scene(options: Partial<Parameters<typeof createVectors>[0]> = {}) {
  const mem = await openTestMemory();
  OPENED.push(mem);
  const { dataDir, memoryDb } = mem;
  const vectors = createVectors({ dataDir, log: quiet, now: () => OCT, memoryDb, ...options });
  return { dataDir, memoryDb, vectors };
}

type MemoryDb = Awaited<ReturnType<typeof scene>>['memoryDb'];

/** The rows of a month of a place's index the database holds (src/memory/db/line-vectors.ts). */
function monthRows(memoryDb: MemoryDb, month: string, placeId = 'g1'): number {
  const handle = memoryDb.readHandle();
  if (!handle) throw new Error('the memory database is not open');
  return lineVectorShape(handle.db as Db, placeId, month)?.rows ?? 0;
}

const ids = (hits: ReadonlyArray<{ meta: object }>) => hits.map((hit) => (hit.meta as { id: string }).id);

test('vectors: quantise and dequantise round trip within half a step of the row scale', () => {
  const rng = seeded(1);
  const v = randomVector(rng, 64);
  v[5] = 3.5;
  const { bytes, scale, norm } = quantize(v);
  assert.equal(bytes.length, 64);
  assert.ok(Math.abs(scale - 3.5 / 127) < 1e-6);
  assert.ok(Math.abs(norm - Math.sqrt(v.reduce((s, x) => s + x * x, 0))) < 1e-4);
  const back = dequantize(bytes, scale);
  for (let i = 0; i < v.length; i += 1) assert.ok(Math.abs(back[i] - v[i]) <= scale / 2 + 1e-6);
  assert.ok(cosine(back, v) > 0.999);
  const zero = quantize(new Float32Array(8));
  assert.equal(zero.scale, 0);
  assert.equal(zero.norm, 0);
});

test('vectors: append then search returns the nearest rows with a plausible cosine', async () => {
  const { memoryDb, vectors } = await scene();
  const rng = seeded(2);
  const target = randomVector(rng, 128);
  const rows = [
    { meta: meta('m-near'), vector: near(target, rng, 0.1) },
    { meta: meta('m-mid'), vector: near(target, rng, 0.6) },
  ];
  for (let i = 0; i < 30; i += 1) rows.push({ meta: meta(`m-${i}`), vector: randomVector(rng, 128) });
  await vectors.append('g1', rows, { model: 'test-model' });
  const hits = await vectors.search('g1', target, { k: 2 });
  assert.deepEqual(ids(hits), ['m-near', 'm-mid']);
  assert.ok(Math.abs(hits[0].score - cosine(rows[0].vector, target)) < 0.01);
  assert.ok(hits[0].score > hits[1].score);
  assert.ok(hits[1].score > 0.5);
  const filtered = await vectors.search('g1', target, { k: 1, filter: (m: { id?: string }) => m.id !== 'm-near' });
  assert.deepEqual(ids(filtered), ['m-mid']);
  assert.equal((await vectors.stats('g1')).rows, 32);
});

test('vectors: rows go to the month of their occurredAt; months and from/to narrow the search', async () => {
  const { memoryDb, vectors } = await scene();
  const rng = seeded(3);
  const q = randomVector(rng, 32);
  await vectors.append('g1', [
    { meta: meta('sep', { occurredAt: '2026-09-30T23:59:00.000Z' }), vector: near(q, rng, 0.05) },
    { meta: meta('oct', { occurredAt: '2026-10-01T00:01:00.000Z' }), vector: near(q, rng, 0.05) },
  ]);
  assert.equal(monthRows(memoryDb, '2026-09'), 1);
  assert.equal(monthRows(memoryDb, '2026-10'), 1);
  assert.deepEqual(ids(await vectors.search('g1', q, { k: 5, months: ['2026-10'] })), ['oct']);
  assert.deepEqual(ids(await vectors.search('g1', q, { k: 5, to: '2026-09-30T23:59:59.000Z' })), ['sep']);
  assert.deepEqual(ids(await vectors.search('g1', q, { k: 5, from: '2026-10-01T00:00:00.000Z' })), ['oct']);
  assert.equal((await vectors.search('g1', q, { k: 5 })).length, 2);
  const stats = await vectors.stats('g1');
  assert.equal(stats.months, 2);
  assert.equal(stats.rows, 2);
  assert.ok(stats.bytes > 64);
});

test('vectors: a private layer is kept apart from the root index and from other private layers', async () => {
  const { memoryDb, vectors } = await scene();
  const rng = seeded(9);
  const q = randomVector(rng, 16);
  await vectors.append('g1', [{ meta: meta('root'), vector: near(q, rng, 0.1) }]);
  // A private chat is its own place, so its index is that place's.
  await vectors.append('dm-u3', [{ meta: meta('dm-a'), vector: near(q, rng, 0.1) }]);
  await vectors.append('dm-u4', [{ meta: meta('dm-b'), vector: near(q, rng, 0.1) }]);
  assert.equal(monthRows(memoryDb, '2026-10', 'dm-u3'), 1);
  assert.deepEqual(ids(await vectors.search('g1', q, { k: 10 })), ['root']);
  assert.deepEqual(ids(await vectors.search('dm-u3', q, { k: 10 })), ['dm-a']);
  assert.deepEqual(ids(await vectors.search('dm-u4', q, { k: 10 })), ['dm-b']);
  assert.equal((await vectors.stats('dm-u4')).rows, 1);
});

test('vectors: has lists the kind, id and revision of every row of a month, kept current across appends and layers', async () => {
  const { memoryDb, vectors } = await scene();
  const rng = seeded(11);
  assert.deepEqual([...(await vectors.has('g1', '2026-10'))], [], 'no month yet');
  await vectors.append('g1', [
    { meta: meta('a'), vector: randomVector(rng, 8) },
    { meta: meta('b', { revision: 2 }), vector: randomVector(rng, 8) },
    { meta: meta('ep1', { kind: 'archive', revision: 'rv-1' }), vector: randomVector(rng, 8) },
  ]);
  assert.deepEqual([...(await vectors.has('g1', '2026-10'))].sort(), ['archive:ep1:rv-1', 'record:a:1', 'record:b:2']);
  await vectors.append('g1', [{ meta: meta('c'), vector: randomVector(rng, 8) }]);
  assert.ok((await vectors.has('g1', '2026-10')).has('record:c:1'), 'an append shows at once');
  assert.equal((await vectors.has('g1', '2026-09')).size, 0, 'another month');
  await vectors.append('dm-u9', [{ meta: meta('p'), vector: randomVector(rng, 8) }]);
  assert.deepEqual([...(await vectors.has('dm-u9', '2026-10'))], ['record:p:1']);
  assert.equal(
    (await vectors.has('g1', '2026-10')).has('record:p:1'),
    false,
    'a private row stays out of the root month'
  );
  await assert.rejects(vectors.has('g1', 'october'), TypeError);
});

test('vectors: has sees a month another instance wrote', async () => {
  const { dataDir, memoryDb, vectors } = await scene();
  const other = createVectors({ dataDir, log: quiet, now: () => OCT, memoryDb });
  const rng = seeded(12);
  await vectors.append('g1', [{ meta: meta('a'), vector: randomVector(rng, 8) }]);
  assert.equal((await vectors.has('g1', '2026-10')).size, 1);
  await other.append('g1', [{ meta: meta('b'), vector: randomVector(rng, 8) }]);
  assert.ok((await vectors.has('g1', '2026-10')).has('record:b:1'));
});

// ---- the meaning index's reads from the database ------------------------------------------------------------------

// Search, has and stats answer from the database for every layer, month, range and filter, leave an evicted vector
// out, and fail with a code when the database cannot answer.

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
  { k: 10, filter: (meta: object) => (meta as { id: string }).id !== '400000000000000022' },
  { k: 10, privateAccountId: MEMBER },
];
const R = (n: string | number) => `4000000000000000${n}`;
/** The hits of the first guild, `[id, score]` best first, per query and option (the scores to four places). */
const EXPECTED: Array<Array<Array<[string, number]>>> = [
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

function sameHits(actual: Array<{ meta: object; score: number }>, expected: Array<[string, number]>, label: string) {
  assert.deepEqual(
    actual.map((hit) => (hit.meta as { id: string }).id),
    expected.map(([id]) => id),
    label
  );
  actual.forEach((hit, i) => assert.ok(Math.abs(hit.score - expected[i][1]) <= 1e-4, `${label} score ${i}`));
}

test('vectors db reader: search answers every layer, month, range and filter from the database', async () => {
  const env = await readerEnv();
  try {
    // The fixture's hand-made months of both guilds (datadir.ts#vectorMonth) failed the checksum of their manifests, so
    // search skipped them. The line vectors hold no manifest (src/memory/db/line-vectors.ts): their rows go, so the
    // expected hits stay those of the months the engine wrote.
    const writer = openMemoryDb(env.dbFile);
    try {
      dbOf(writer)
        .prepare('DELETE FROM vectors WHERE item_id IN (?, ?, ?, ?) AND place_id IS NOT NULL')
        .run(R('01'), R('02'), '410000000000000001', '410000000000000002');
    } finally {
      writer.close();
    }
    const vectors = createVectors({ dataDir: env.data, log: env.log, memoryDb: env.memoryDb });
    for (const [q, query] of QUERIES.entries()) {
      for (const [o, option] of OPTIONS.entries()) {
        const { placeId, rest } = readAt(GUILD, option as { privateAccountId?: string });
        sameHits(await vectors.search(placeId, query, rest), EXPECTED[q][o], `query ${q} option ${o}`);
        // A DM place has no guild: the private option ran above.
        if ('privateAccountId' in option) continue;
        assert.deepEqual(
          await vectors.search(placeOfGuild(GUILD_2), query, option),
          [],
          `guild 2 query ${q} option ${o}`
        );
      }
    }
    assert.deepEqual(env.warns, []);
  } finally {
    env.done();
  }
});

test('vectors db reader: has and stats for every layer and month', async () => {
  const env = await readerEnv();
  try {
    const vectors = createVectors({ dataDir: env.data, log: env.log, memoryDb: env.memoryDb });
    const keys = (...ids: Array<string>) => ids.map((id) => `record:${id}:1`);
    const expected: Array<[string, string | null, object, Record<string, Array<string>>]> = [
      [
        GUILD,
        null,
        { months: 2, rows: 5, bytes: 1410 },
        { '2026-09': keys(R(21), R(22), R(23)), '2026-10': keys(R('01'), R('02')), '2026-11': [] },
      ],
      [
        GUILD,
        MEMBER,
        { months: 1, rows: 1, bytes: 294 },
        { '2026-09': [], '2026-10': keys('400000000000000005'), '2026-11': [] },
      ],
      [
        GUILD_2,
        null,
        { months: 1, rows: 2, bytes: 528 },
        { '2026-09': [], '2026-10': keys('410000000000000001', '410000000000000002'), '2026-11': [] },
      ],
    ];
    for (const [placeId, privateAccountId, stats, months] of expected) {
      const holder = readAt(placeId, { privateAccountId }).placeId;
      assert.deepEqual(await vectors.stats(holder), stats, `${placeId} ${privateAccountId}`);
      for (const [month, held] of Object.entries(months)) {
        assert.deepEqual(
          [...(await vectors.has(holder, month))].sort(),
          held,
          `${placeId} ${privateAccountId} ${month}`
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
      const changed = dbOf(writer)
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
      const monthHits = EXPECTED[q][2];
      sameHits(
        await vectors.search(placeOfGuild(GUILD), query, { k: 10, months: ['2026-09'] }),
        monthHits.filter(([id]) => id !== R(22)),
        `query ${q}`
      );
    }
    assert.deepEqual([...(await vectors.has(placeOfGuild(GUILD), '2026-09'))].sort(), [
      'record:400000000000000021:1',
      'record:400000000000000023:1',
    ]);
    assert.equal((await vectors.stats(placeOfGuild(GUILD))).rows, 4);
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
      () => closed.search(placeOfGuild(GUILD), QUERIES[0], { k: 5 }),
      (error: NodeJS.ErrnoException) => error.code === 'DB_CLOSED'
    );
    await assert.rejects(
      () => closed.has(placeOfGuild(GUILD), '2026-09'),
      (error: NodeJS.ErrnoException) => error.code === 'DB_CLOSED'
    );
    await assert.rejects(
      () => closed.stats(placeOfGuild(GUILD)),
      (error: NodeJS.ErrnoException) => error.code === 'DB_CLOSED'
    );
    assert.deepEqual(
      env.warns.map((warn) => [warn.message, warn.reader, warn.code]),
      Array(3).fill(['memory db: read failed', 'vectors', 'DB_CLOSED'])
    );
  } finally {
    env.done();
  }
});

// ---- the meaning index over a reopened database -------------------------------------------------------------------

const LINES_MODEL = 'test/embedder';
const LINES_GROUP = 'discord:guild:1';
const LINES_NOW = Date.parse('2026-11-09T10:00:00.000Z');
const LINES_NOV = '2026-11-03T10:00:00.000Z';

test('the vector index finds what it appended after the database reopens', async () => {
  // Catches: rows the index writes that no new index can find once the first one and its cache are gone.
  let env = await openTestMemory();
  try {
    const first = createVectors({ dataDir: env.dataDir, memoryDb: env.memoryDb, now: () => LINES_NOW });
    await first.append(
      LINES_GROUP,
      [
        { meta: { kind: 'record', id: 'm1', revision: 1, occurredAt: LINES_NOV }, vector: [1, 0, 0, 0] },
        { meta: { kind: 'record', id: 'm2', revision: 1, occurredAt: LINES_NOV }, vector: [0, 1, 0, 0] },
      ],
      { model: LINES_MODEL }
    );
    await env.close();
    env = await openTestMemory({ dataDir: env.dataDir });
    const second = createVectors({ dataDir: env.dataDir, memoryDb: env.memoryDb, now: () => LINES_NOW });
    const found = await second.search(LINES_GROUP, [1, 0.1, 0, 0], { k: 2 });
    assert.deepEqual(
      found.map((hit) => (hit.meta as { id: string }).id),
      ['m1', 'm2']
    );
    assert.deepEqual([...(await second.has(LINES_GROUP, '2026-11'))].sort(), ['record:m1:1', 'record:m2:1']);
    assert.deepEqual(await second.stats(LINES_GROUP), {
      months: 1,
      rows: 2,
      bytes: (await second.stats(LINES_GROUP)).bytes,
    });
  } finally {
    await env.close();
    fs.rmSync(env.dataDir, { recursive: true, force: true });
  }
});

// What a direct message leaves in the journal, the record, the archive and the meaning index reaches its partner alone. A
// journal line of a DM names only its chat (`scope: { channel }`) and carries no private mark, so every reader
// that branched on the mark falls through to the channel rule or to none. Each test seeds one synthetic secret word through
// the writer a turn uses, over the real service and database, then reads as another reader: a group turn, another
// partner's private turn, the persona's own wake. Where the answer could be empty for want of a row, an internal context
// checks first that the row exists, so an empty answer means refused and never means unwritten. The last group asserts
// the converse: the partner's own private turn still reads their own lines.

const dmJournalPrivacyQuiet = { info() {}, debug() {}, warn() {}, error() {} };
const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const SECRET = 'xylophonewhisper';

// A first-generation DM on the home authority: the place and the person are spelled from the native id.
const PARTNER = 'n1';
const PARTNER_ACCOUNT = 'discord:n1';
const PARTNER_PERSON = 'person:discord:n1';
const DM = 'discord:dm:n1';
const DM_CHAT = 'dm-chat-n1';
// Another partner on the same interface.
const OTHER = 'n2';
const OTHER_PERSON = 'person:discord:n2';
const OTHER_DM = 'discord:dm:n2';
const GROUP = 'discord:channel:room-1';
const SERVER = 'discord:server:g1';
// A partner with the same native id under another authority of the interface: the place's id spells nothing.
const STRANGER_ACCOUNT = 'account:other-authority';
const STRANGER_PERSON = 'person:elsewhere';
const STRANGER_DM = 'place:dm-other-authority';

/** Lets the journal's unawaited writes reach the writer, which runs on this thread here. */
const settled = () => new Promise((resolve) => setImmediate(resolve));

const opened: Array<MemoryDbService> = [];

function seedWorld(db: Db): void {
  addAccount(db, {
    id: PARTNER_ACCOUNT,
    iface: 'discord',
    authority: 'discord/global',
    native: PARTNER,
    person: PARTNER_PERSON,
  });
  addAccount(db, {
    id: 'discord:n2',
    iface: 'discord',
    authority: 'discord/global',
    native: OTHER,
    person: OTHER_PERSON,
  });
  addAccount(db, {
    id: STRANGER_ACCOUNT,
    iface: 'discord',
    authority: 'discord/other',
    native: PARTNER,
    person: STRANGER_PERSON,
  });
  addDmPlace(db, {
    id: DM,
    iface: 'discord',
    authority: 'discord/global',
    account: PARTNER_ACCOUNT,
    person: PARTNER_PERSON,
  });
  addDmPlace(db, {
    id: OTHER_DM,
    iface: 'discord',
    authority: 'discord/global',
    account: 'discord:n2',
    person: OTHER_PERSON,
  });
  addDmPlace(db, {
    id: STRANGER_DM,
    iface: 'discord',
    authority: 'discord/other',
    account: STRANGER_ACCOUNT,
    person: STRANGER_PERSON,
  });
  addGroupPlace(db, GROUP, 'discord', 'discord/global');
  db.prepare(
    `INSERT INTO places (id, iface, kind, native_id, native_key, authority_id, generation, chat, scope_kind)
     VALUES (?, 'discord', 'server', 'g1', 'server:g1', 'discord/global', 1, 'group', 'group')`
  ).run(SERVER);
}

function world() {
  const dataDir = tempDir('nep-dm-privacy-');
  const seed = openMemoryDb(path.join(dataDir, 'memory.db'));
  seedWorld(dbOf(seed));
  seed.close();
  const hot = { config: { memoryDb: { session: { mode: 'off' } }, context: { memory: { openPrivate: false } } } };
  const memoryDb = createMemoryDb({
    hot,
    dataDir,
    log: dmJournalPrivacyQuiet,
    worker: false,
    iface: () => 'discord',
  });
  memoryDb.tick();
  opened.push(memoryDb);
  const read = (): Db => dbOf(wrongly<Parameters<typeof dbOf>[0]>(memoryDb.readHandle()));
  const journal = createJournal({ dataDir, memoryDb, now: () => NOW, log: dmJournalPrivacyQuiet });
  const record = createRecord({ dataDir, memoryDb, now: () => NOW, log: dmJournalPrivacyQuiet });
  const appendStore = createAppendStore({ fsyncMs: 0, log: dmJournalPrivacyQuiet });
  const archive = createArchive({ appendStore, dataDir, memoryDb, now: () => NOW, log: dmJournalPrivacyQuiet });
  const vectors = createVectors({ dataDir, memoryDb, now: () => NOW, log: dmJournalPrivacyQuiet });
  const store = createStore({ dataDir, archive, memoryDb });
  const contexts = {
    group: memoryDb.issueContext({ kind: 'group', iface: 'discord', destination: GROUP }),
    other: memoryDb.issueContext({ kind: 'dm', iface: 'discord', person: OTHER_PERSON, place: OTHER_DM }),
    partner: memoryDb.issueContext({ kind: 'dm', iface: 'discord', person: PARTNER_PERSON, place: DM }),
    stranger: memoryDb.issueContext({ kind: 'dm', iface: 'discord', person: STRANGER_PERSON, place: STRANGER_DM }),
  };
  return { dataDir, hot, memoryDb, read, journal, record, archive, vectors, store, contexts };
}

/** A record line of a chat: what a person said there. */
const lineSaid = (id: string, chat = DM_CHAT, by = PARTNER) =>
  toRecordLine(
    { id, placeId: chat, authorId: by, authorName: 'Partner', content: `the ${SECRET} plan`, ts: NOW - 60_000 },
    { now: () => NOW }
  );
describe('privacy of a dm journal', () => {
  after(async () => {
    for (const service of opened) await service.close();
  });

  test("a DM's vector is out of a group's index and carries no group audience", async () => {
    // Bug: a vector row keeps the scope its month was written under, so a DM's chunk answers a group's question.
    const w = world();
    await w.record.append(DM, [lineSaid('m-dm')]);
    const unit = Float32Array.from([1, 0, 0, 0]);
    await w.vectors.append(
      DM,
      [
        {
          vector: unit,
          meta: {
            kind: 'record',
            id: 'm-dm',
            revision: 1,
            occurredAt: new Date(NOW - 60_000).toISOString(),
            placeId: DM_CHAT,
            by: PARTNER,
            participants: [PARTNER],
            sourceIds: ['m-dm'],
          },
        },
      ],
      { model: 'test-model' }
    );
    await settled();
    assert.deepEqual(await w.vectors.search(GROUP, unit, { k: 5 }), []);
    const own = await w.vectors.search(DM, unit, { k: 5 });
    assert.deepEqual(
      own.map((row) => wrongly<{ id: string }>(row.meta).id),
      ['m-dm']
    );
    const rows = w.read().prepare('SELECT audience_id FROM vectors WHERE retired_at IS NULL').all();
    assert.deepEqual(
      rows.map((row) => row.audience_id),
      [`aud:dm:${DM}`]
    );
  });
});

// What a restart of the core finds in the meaning index. The catch-up asks the index which records it holds and embeds
// the rest, so a month the index cannot answer for is embedded again at every restart, and that spends money. Synthetic
// data only; the embedding call is a fake.

const MONTH = '2026-11';
const AT = Date.parse('2026-11-03T10:00:00.000Z');
const MEMORY_DB_VECTOR_RESTART_NOW = AT + 3_600_000;
const CLI_DM = 'cli:dm:owner';
const DISCORD_DM = 'discord:dm:owner';

type Warned = { message: string; fields?: Record<string, unknown> };

function logged() {
  const warnings: Array<Warned> = [];
  return {
    warnings,
    log: {
      info() {},
      debug() {},
      error() {},
      warn: (message: string, fields?: Record<string, unknown>) => warnings.push({ message, fields }),
    },
  };
}

/** An observed DM on `iface` with the native partner `owner`. */
const observedDm = (iface: string) => ({
  v: OBSERVATION_VERSION,
  iface,
  authority: `${iface}/global`,
  native: { kind: 'message', key: `${iface}-first`, revision: 1 },
  place: { authority: `${iface}/global`, key: 'dm:owner', kind: 'dm', chat: 'dm' },
  author: { kind: 'account', key: 'owner' },
  occurredAt: '2026-11-03T09:00:00.000Z',
  observedAt: '2026-11-03T09:00:01.000Z',
  text: 'a synthetic opening line',
  mentions: [],
  direct: true,
  relations: [],
});

/** A row the embedder would append for the record `id`. */
const vectorRow = (id: string, minute: number) => ({
  meta: {
    kind: 'record',
    id,
    revision: 1,
    occurredAt: new Date(AT + minute * 60_000).toISOString(),
    placeId: null,
    by: 'owner',
    participants: ['owner'],
    sourceIds: [id],
  },
  vector: Float32Array.from([0.5, 0.5, minute + 1, 0.25]),
});

const CONFIG = { embed: { dimensions: 4 }, models: { routes: chainsOf({ embedding: 'test/embedder' }) }, llm: {} };

/** One life of the core over `env`: its own index and embedding queue. What `embed` was asked goes in `sent`. */
function coreLife(env: TestMemory, log: ReturnType<typeof logged>['log']) {
  const { dataDir, memoryDb } = env;
  const record = createRecord({ dataDir, log, memoryDb });
  const vectors = createVectors({ dataDir, log, memoryDb });
  const sent: Array<string> = [];
  const embedder = createEmbedder({
    hot: { config: CONFIG },
    vectors,
    record,
    log,
    memoryDb,
    now: () => MEMORY_DB_VECTOR_RESTART_NOW,
    embed: (texts: Array<string>) => {
      sent.push(...texts);
      return Promise.resolve(texts.map(() => Float32Array.from([0.5, 0.25, 0.25, 0.5])));
    },
  });
  return { record, vectors, embedder, sent };
}

const readDb = (env: TestMemory) => dbOf(env.memoryDb.readHandle()!);

/** The live rows of the month of a place's index, in the order they were written (src/memory/db/line-vectors.ts). */
const stored = (env: TestMemory, placeId: string) => ({
  rows: readDb(env)
    .prepare(
      'SELECT item_id, audience_id FROM vectors WHERE place_id = ? AND substr(occurred_at, 1, 7) = ? AND retired_at IS NULL ORDER BY rowid'
    )
    .all(placeId, MONTH)
    .map((row) => ({ ...row })),
});

test('a record another DM unit already holds under the same key lands in its own month', async () => {
  // Bug: a chunk key names only the partner's native id, so two DM places of one native id spell the same key. The second
  // writer's row went to `co_owners` and never landed, and the month read short for good.
  const { log, warnings } = logged();
  const env = await openTestMemory({ log });
  try {
    await env.memoryDb.observe(observedDm('cli'), null);
    await env.memoryDb.observe(observedDm('discord'), null);
    const { vectors } = coreLife(env, log);
    await vectors.append(DISCORD_DM, [vectorRow('shared', 0)], { model: 'test/embedder' });

    await vectors.append(CLI_DM, [vectorRow('own', 1), vectorRow('shared', 0)], { model: 'test/embedder' });
    await vectors.append(CLI_DM, [vectorRow('later', 2)], { model: 'test/embedder' });

    const { rows } = stored(env, CLI_DM);
    assert.equal(rows.length, 3);
    assert.deepEqual(
      rows.map((row) => [row.item_id, row.audience_id]),
      [
        ['own', 'aud:dm:cli:dm:owner'],
        ['shared', 'aud:dm:cli:dm:owner'],
        ['later', 'aud:dm:cli:dm:owner'],
      ]
    );
    assert.deepEqual(
      stored(env, DISCORD_DM).rows.map((row) => [row.item_id, row.audience_id]),
      [['shared', 'aud:dm:discord:dm:owner']]
    );
    assert.deepEqual([...(await vectors.has(CLI_DM, MONTH))].sort(), [
      'record:later:1',
      'record:own:1',
      'record:shared:1',
    ]);
    const found = await vectors.search(CLI_DM, [1, 1, 1, 1], { k: 10 });
    assert.equal(found.length, 3);
    assert.deepEqual(
      warnings.filter((one) => /unreadable|checksum/.test(one.message)),
      []
    );
  } finally {
    await env.close();
  }
});
