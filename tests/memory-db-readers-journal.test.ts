// The journal's reads from the database (stage W1): the day reads and everything built on them (findTurn,
// turnOperations, pending, triggerLinks, callMarks, timeline) answer from the database, and fail with a code when the
// database cannot answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJournal } from '../src/memory/journal.ts';
import {
  GUILD,
  placeOfGuild,
  readAt,
  GUILD_2,
  MEMBER,
  readerEnv,
  type ReaderEnv,
} from './fixtures/memory-db/readers.ts';

const NOW = Date.parse('2026-10-21T23:00:00.000Z');
const DAYS = ['2026-10-19', '2026-10-20', '2026-10-21'];

// The journal's records are untyped; the tests read these fields.
type Rec = { id: string; turnId: string; kind: string; think: string; attitude: Array<unknown> };
const rec = (value: object | null | undefined) => value as Partial<Rec> | null | undefined;

const journalOf = (env: ReaderEnv, memoryDb: ReaderEnv['memoryDb'] | ReaderEnv['closedDb'] = env.memoryDb) =>
  createJournal({ dataDir: env.data, log: env.log, now: () => NOW, memoryDb });

test('journal db reader: read answers every day, kind, limit and layer, the turn and memory joins included', async () => {
  const env = await readerEnv();
  try {
    const journal = journalOf(env);
    const queries = [
      { n: 1000 },
      { n: 2 },
      { kind: 'action', n: 1000 },
      { kind: 'turn' },
      { privateUserId: MEMBER, n: 1000 },
    ];
    const none = [[], [], [], [], []];
    const day20 = (suffix: string, privateIds: Array<string>) => [
      [`j-start${suffix}`, `j-turn${suffix}`, `j-system${suffix}`, `j-memory${suffix}`],
      [`j-system${suffix}`, `j-memory${suffix}`],
      [],
      [`j-turn${suffix}`],
      privateIds,
    ];
    const expected: Record<string, Record<string, Array<Array<string>>>> = {
      [GUILD]: {
        '2026-10-19': none,
        '2026-10-20': day20('', ['jp-a1', 'jp-a2']),
        '2026-10-21': [
          ['j2-start', 'j2-a1', 'j2-a2', 'j2-a3', 'j2-turn', 'j2-system', 'j2-hidden'],
          ['j2-system', 'j2-hidden'],
          ['j2-a1', 'j2-a2', 'j2-a3', 'j2-hidden'],
          ['j2-turn'],
          [],
        ],
      },
      [GUILD_2]: { '2026-10-19': none, '2026-10-20': day20('.g2', []), '2026-10-21': none },
    };
    for (const placeId of [GUILD, GUILD_2]) {
      for (const day of DAYS) {
        for (const [index, query] of queries.entries()) {
          // A DM place has no guild: the private queries run once, under the first guild.
          if (placeId === GUILD_2 && 'privateUserId' in query) continue;
          const { placeId: holder, rest } = readAt(placeId, query);
          const ids = (await journal.read(holder, { day, ...rest })).map((record) => rec(record)?.id);
          assert.deepEqual(ids, expected[placeId][day][index], `${placeId} ${day} ${JSON.stringify(query)}`);
        }
      }
    }
    const day = await journal.read(placeOfGuild(GUILD), { day: '2026-10-20', n: 1000 });
    assert.equal(rec(day.find((record) => rec(record)?.kind === 'turn'))?.think, 'Καλημέρα. A café thought.');
    assert.equal(rec(day.find((record) => rec(record)?.kind === 'memory'))?.attitude?.length, 1);
    assert.deepEqual(env.warns, []);
  } finally {
    env.done();
  }
});

test('journal db reader: findTurn, turnOperations, pending, triggerLinks, callMarks and timeline', async () => {
  const env = await readerEnv();
  try {
    const journal = journalOf(env);
    const found = await journal.findTurn(placeOfGuild(GUILD), {
      messageId: '400000000000000014',
      at: Date.parse('2026-10-21T08:07:00.000Z'),
    });
    assert.deepEqual(
      { turn: rec(found?.turn)?.id, start: rec(found?.start)?.id, posted: found?.posted, calls: found?.calls },
      { turn: 'j2-turn', start: 'j2-start', posted: ['400000000000000014'], calls: [] }
    );
    const first = await journal.findTurn(placeOfGuild(GUILD), {
      messageId: '400000000000000009',
      at: Date.parse('2026-10-20T10:00:00.000Z'),
    });
    assert.deepEqual(
      [rec(first?.turn)?.id, rec(first?.turn)?.turnId, rec(first?.start)?.id, first?.posted],
      ['j-turn', 'turn-1', 'j-start', ['400000000000000009']]
    );
    assert.equal(
      await journal.findTurn(placeOfGuild(GUILD), {
        messageId: '400000000000000098',
        at: Date.parse('2026-10-20T10:00:00.000Z'),
      }),
      null
    );
    assert.deepEqual(
      (await journal.turnOperations(placeOfGuild(GUILD), { turnId: 'turn-2', days: DAYS })).map((op) => [
        op.opId,
        op.name,
        op.phase,
        op.text,
      ]),
      [
        ['op-2', 'post', 'succeeded', 'Ναι'],
        ['op-3', 'react', 'open', null],
        ['op-4', 'post', 'open', null],
      ]
    );
    assert.deepEqual(
      (
        await journal.turnOperations(readAt(GUILD, { privateUserId: MEMBER }).placeId, { turnId: 'turn-p', days: DAYS })
      ).map((op) => [op.phase, op.skill]),
      [['failed', 'msg']]
    );
    assert.deepEqual(
      (await journal.pending(placeOfGuild(GUILD), { days: DAYS })).map((op) => op.opId),
      ['op-3', 'op-4']
    );
    assert.deepEqual(
      await journal.pending(placeOfGuild(GUILD), { days: DAYS, before: Date.parse('2026-10-21T08:07:00.000Z') }),
      []
    );
    assert.deepEqual(await journal.triggerLinks(placeOfGuild(GUILD), { days: DAYS }), []);
    assert.deepEqual(await journal.callMarks(placeOfGuild(GUILD), { days: DAYS }), { calls: [], postedFrom: [] });
    const kinds = (timeline: Array<{ kind: string; event: string | null }>) =>
      timeline.map((entry) => (entry.event ? `${entry.kind}:${entry.event}` : entry.kind));
    assert.deepEqual(
      kinds(await journal.timeline(placeOfGuild(GUILD), { from: Date.parse('2026-10-19T00:00:00.000Z') })),
      [
        'turn.start',
        'turn',
        'system:start',
        'memory',
        'turn.start',
        'action',
        'action',
        'action',
        'turn',
        'action',
        'system:stop',
      ]
    );
    assert.deepEqual(
      kinds(await journal.timeline(placeOfGuild(GUILD_2), { from: Date.parse('2026-10-20T00:00:00.000Z') })),
      ['turn.start', 'turn', 'system:start', 'memory']
    );
  } finally {
    env.done();
  }
});

test('journal db reader: stats is the latest recordedAt of today and yesterday from the database', async () => {
  const env = await readerEnv();
  try {
    const journal = journalOf(env);
    assert.deepEqual(await journal.stats(placeOfGuild(GUILD)), { lastWriteMs: Date.parse('2026-10-21T20:00:00.000Z') });
    assert.deepEqual(await journal.stats(placeOfGuild(GUILD), { now: Date.parse('2026-10-25T10:00:00.000Z') }), {
      lastWriteMs: null,
    });
  } finally {
    env.done();
  }
});

test('journal db reader: a closed database is an error with a code, logged', async () => {
  const env = await readerEnv();
  try {
    const closed = journalOf(env, env.closedDb);
    await assert.rejects(
      () => closed.read(placeOfGuild(GUILD), { day: '2026-10-20' }),
      (error: NodeJS.ErrnoException) => error.code === 'DB_CLOSED'
    );
    await assert.rejects(
      () => closed.findTurn(placeOfGuild(GUILD), { messageId: '400000000000000014', at: NOW }),
      (error: NodeJS.ErrnoException) => error.code === 'DB_CLOSED'
    );
    await assert.rejects(
      () => closed.timeline(placeOfGuild(GUILD), { from: NOW }),
      (error: NodeJS.ErrnoException) => error.code === 'DB_CLOSED'
    );
    await assert.rejects(
      () => closed.stats(placeOfGuild(GUILD)),
      (error: NodeJS.ErrnoException) => error.code === 'DB_CLOSED'
    );
    assert.equal(env.warns.length, 4);
    assert.ok(
      env.warns.every(
        (warn) => warn.message === 'memory db: read failed' && warn.reader === 'journal' && warn.code === 'DB_CLOSED'
      )
    );
  } finally {
    env.done();
  }
});
