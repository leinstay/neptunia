// The journal's reads from the database (stage W1): the day reads and everything built on them (findTurn,
// turnOperations, pending, triggerLinks, callMarks, timeline) answer from the database, and fail with a code when the
// database cannot answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJournal } from '../src/memory/journal.js';
import { GUILD, GUILD_2, MEMBER, readerEnv } from './fixtures/memory-db/readers.js';

const NOW = Date.parse('2026-10-21T23:00:00.000Z');
const DAYS = ['2026-10-19', '2026-10-20', '2026-10-21'];

const journalOf = (env, memoryDb = env.memoryDb) => createJournal({ dataDir: env.data, log: env.log, now: () => NOW, memoryDb });

test('journal db reader: read answers every day, kind, limit and layer, the turn and memory joins included', async () => {
  const env = await readerEnv();
  try {
    const journal = journalOf(env);
    const queries = [{ n: 1000 }, { n: 2 }, { kind: 'action', n: 1000 }, { kind: 'turn' }, { privateUserId: MEMBER, n: 1000 }];
    const none = [[], [], [], [], []];
    const day20 = (suffix, privateIds) => [
      [`j-start${suffix}`, `j-turn${suffix}`, `j-system${suffix}`, `j-memory${suffix}`], [`j-system${suffix}`, `j-memory${suffix}`], [], [`j-turn${suffix}`], privateIds,
    ];
    const expected = {
      [GUILD]: {
        '2026-10-19': none,
        '2026-10-20': day20('', ['jp-a1', 'jp-a2']),
        '2026-10-21': [
          ['j2-start', 'j2-a1', 'j2-a2', 'j2-a3', 'j2-turn', 'j2-system', 'j2-hidden'], ['j2-system', 'j2-hidden'], ['j2-a1', 'j2-a2', 'j2-a3', 'j2-hidden'], ['j2-turn'], [],
        ],
      },
      [GUILD_2]: { '2026-10-19': none, '2026-10-20': day20('.g2', []), '2026-10-21': none },
    };
    for (const guildId of [GUILD, GUILD_2]) {
      for (const day of DAYS) {
        for (const [index, query] of queries.entries()) {
          const ids = (await journal.read(guildId, { day, ...query })).map((record) => record.id);
          assert.deepEqual(ids, expected[guildId][day][index], `${guildId} ${day} ${JSON.stringify(query)}`);
        }
      }
    }
    const day = await journal.read(GUILD, { day: '2026-10-20', n: 1000 });
    assert.equal(day.find((record) => record.kind === 'turn')?.think, 'Καλημέρα. A café thought.');
    assert.equal(day.find((record) => record.kind === 'memory')?.attitude?.length, 1);
    assert.deepEqual(env.warns, []);
  } finally { env.done(); }
});

test('journal db reader: findTurn, turnOperations, pending, triggerLinks, callMarks and timeline', async () => {
  const env = await readerEnv();
  try {
    const journal = journalOf(env);
    const found = await journal.findTurn(GUILD, { messageId: '400000000000000014', at: Date.parse('2026-10-21T08:07:00.000Z') });
    assert.deepEqual({ turn: found?.turn?.id, start: found?.start?.id, posted: found?.posted, calls: found?.calls }, { turn: 'j2-turn', start: 'j2-start', posted: ['400000000000000014'], calls: [] });
    const first = await journal.findTurn(GUILD, { messageId: '400000000000000009', at: Date.parse('2026-10-20T10:00:00.000Z') });
    assert.deepEqual([first?.turn?.id, first?.turn?.turnId, first?.start?.id, first?.posted], ['j-turn', 'turn-1', 'j-start', ['400000000000000009']]);
    assert.equal(await journal.findTurn(GUILD, { messageId: '400000000000000098', at: Date.parse('2026-10-20T10:00:00.000Z') }), null);
    assert.deepEqual((await journal.turnOperations(GUILD, { turnId: 'turn-2', days: DAYS })).map((op) => [op.opId, op.name, op.phase, op.text]), [
      ['op-2', 'post', 'succeeded', 'Ναι'], ['op-3', 'react', 'open', null], ['op-4', 'post', 'open', null],
    ]);
    assert.deepEqual((await journal.turnOperations(GUILD, { turnId: 'turn-p', days: DAYS, privateUserId: MEMBER })).map((op) => [op.phase, op.skill]), [['failed', 'msg']]);
    assert.deepEqual((await journal.pending(GUILD, { days: DAYS })).map((op) => op.opId), ['op-3', 'op-4']);
    assert.deepEqual(await journal.pending(GUILD, { days: DAYS, before: Date.parse('2026-10-21T08:07:00.000Z') }), []);
    assert.deepEqual(await journal.triggerLinks(GUILD, { days: DAYS }), []);
    assert.deepEqual(await journal.callMarks(GUILD, { days: DAYS }), { calls: [], postedFrom: [] });
    const kinds = (timeline) => timeline.map((entry) => entry.event ? `${entry.kind}:${entry.event}` : entry.kind);
    assert.deepEqual(kinds(await journal.timeline(GUILD, { from: Date.parse('2026-10-19T00:00:00.000Z') })), [
      'turn.start', 'turn', 'system:start', 'memory', 'turn.start', 'action', 'action', 'action', 'turn', 'action', 'system:stop',
    ]);
    assert.deepEqual(kinds(await journal.timeline(GUILD_2, { from: Date.parse('2026-10-20T00:00:00.000Z') })), ['turn.start', 'turn', 'system:start', 'memory']);
  } finally { env.done(); }
});

test('journal db reader: stats is the latest recordedAt of today and yesterday from the database', async () => {
  const env = await readerEnv();
  try {
    const journal = journalOf(env);
    assert.deepEqual(await journal.stats(GUILD), { lastWriteMs: Date.parse('2026-10-21T20:00:00.000Z') });
    assert.deepEqual(await journal.stats(GUILD, { now: Date.parse('2026-10-25T10:00:00.000Z') }), { lastWriteMs: null });
  } finally { env.done(); }
});

test('journal db reader: a closed database is an error with a code, logged', async () => {
  const env = await readerEnv();
  try {
    const closed = journalOf(env, env.closedDb);
    await assert.rejects(() => closed.read(GUILD, { day: '2026-10-20' }), (error) => error.code === 'DB_CLOSED');
    await assert.rejects(() => closed.findTurn(GUILD, { messageId: '400000000000000014', at: NOW }), (error) => error.code === 'DB_CLOSED');
    await assert.rejects(() => closed.timeline(GUILD, { from: NOW }), (error) => error.code === 'DB_CLOSED');
    await assert.rejects(() => closed.stats(GUILD), (error) => error.code === 'DB_CLOSED');
    assert.equal(env.warns.length, 4);
    assert.ok(env.warns.every((warn) => warn.message === 'memory db: read failed' && warn.reader === 'journal' && warn.code === 'DB_CLOSED'));
  } finally { env.done(); }
});
