// The journal's reads from the database (stage W1): under authority `db` the day reads and everything built on them
// (findTurn, turnOperations, pending, triggerLinks, callMarks, timeline) equal the file reads of the same data, touch
// no file, and fail with a code (never a file read) when the database cannot answer.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createJournal } from '../src/memory/journal.js';
import { createAppendStore } from '../src/memory/append-store.js';
import { GUILD, GUILD_2, MEMBER, noFs, readerEnv } from './fixtures/memory-db/readers.js';

const silent = { info() {}, debug() {}, warn() {}, error() {} };
const noAppendStore = { iterate() { throw Object.assign(new Error('the files were read'), { code: 'FILE_READ' }); } };
const NOW = Date.parse('2026-10-21T23:00:00.000Z');
const DAYS = ['2026-10-19', '2026-10-20', '2026-10-21'];

function pair(env) {
  const appendStore = createAppendStore({ log: silent });
  const files = createJournal({ appendStore, dataDir: env.data, log: silent, now: () => NOW });
  const db = createJournal({ appendStore: noAppendStore, dataDir: env.data, log: env.log, fs: noFs, now: () => NOW, memoryDb: env.memoryDb });
  return { files, db, appendStore };
}

test('journal db reader: read equals the files for every day, kind, limit and layer, the turn and memory joins included', async () => {
  const env = await readerEnv();
  const { files, db, appendStore } = pair(env);
  try {
    let records = 0;
    for (const guildId of [GUILD, GUILD_2]) {
      for (const day of DAYS) {
        for (const query of [{ n: 1000 }, { n: 2 }, { kind: 'action', n: 1000 }, { kind: 'turn' }, { privateUserId: MEMBER, n: 1000 }]) {
          const expected = await files.read(guildId, { day, ...query });
          assert.deepEqual(await db.read(guildId, { day, ...query }), expected, `${guildId} ${day} ${JSON.stringify(query)}`);
          records += expected.length;
        }
      }
    }
    assert.ok(records > 20, 'the fixture has records to compare');
    const day = await db.read(GUILD, { day: '2026-10-20', n: 1000 });
    assert.equal(day.find((record) => record.kind === 'turn')?.think, 'Καλημέρα. A café thought.');
    assert.equal(day.find((record) => record.kind === 'memory')?.attitude?.length, 1);
    // The record naming a member under a forget marker is hidden on both sides.
    assert.ok(!(await db.read(GUILD, { day: '2026-10-21', n: 1000 })).some((record) => record.id === 'j2-hidden'));
    assert.deepEqual(env.warns, []);
  } finally { await appendStore.close(); env.done(); }
});

test('journal db reader: findTurn, turnOperations, pending, triggerLinks, callMarks and timeline equal the files', async () => {
  const env = await readerEnv();
  const { files, db, appendStore } = pair(env);
  try {
    const calls = [
      (j) => j.findTurn(GUILD, { messageId: '400000000000000014', at: Date.parse('2026-10-21T08:07:00.000Z') }),
      (j) => j.findTurn(GUILD, { messageId: '400000000000000009', at: Date.parse('2026-10-20T10:00:00.000Z') }),
      (j) => j.findTurn(GUILD, { messageId: '400000000000000098', at: Date.parse('2026-10-20T10:00:00.000Z') }),
      (j) => j.turnOperations(GUILD, { turnId: 'turn-2', days: DAYS }),
      (j) => j.turnOperations(GUILD, { turnId: 'turn-p', days: DAYS, privateUserId: MEMBER }),
      (j) => j.pending(GUILD, { days: DAYS }),
      (j) => j.pending(GUILD, { days: DAYS, before: Date.parse('2026-10-21T08:07:00.000Z') }),
      (j) => j.triggerLinks(GUILD, { days: DAYS }),
      (j) => j.callMarks(GUILD, { days: DAYS }),
      (j) => j.timeline(GUILD, { from: Date.parse('2026-10-19T00:00:00.000Z') }),
      (j) => j.timeline(GUILD_2, { from: Date.parse('2026-10-20T00:00:00.000Z') }),
    ];
    for (const [index, call] of calls.entries()) assert.deepEqual(await call(db), await call(files), `call ${index}`);
    assert.equal((await db.findTurn(GUILD, { messageId: '400000000000000014', at: Date.parse('2026-10-21T08:07:00.000Z') }))?.turn?.turnId, 'turn-2');
    assert.deepEqual((await db.turnOperations(GUILD, { turnId: 'turn-p', days: DAYS, privateUserId: MEMBER })).map((op) => op.phase), ['failed']);
    assert.deepEqual((await db.pending(GUILD, { days: DAYS })).map((op) => op.opId), ['op-3']);
  } finally { await appendStore.close(); env.done(); }
});

test('journal db reader: stats is the latest recordedAt of today and yesterday from the database, the mtime from the files', async () => {
  const env = await readerEnv();
  const { files, db, appendStore } = pair(env);
  try {
    assert.deepEqual(await db.stats(GUILD), { lastWriteMs: Date.parse('2026-10-21T20:00:00.000Z') });
    assert.deepEqual(await db.stats(GUILD, { now: Date.parse('2026-10-25T10:00:00.000Z') }), { lastWriteMs: null });
    assert.ok(Number.isFinite((await files.stats(GUILD)).lastWriteMs), 'the files give a modification time');
    assert.deepEqual(await files.stats(GUILD, { now: Date.parse('2026-10-25T10:00:00.000Z') }), { lastWriteMs: null });
  } finally { await appendStore.close(); env.done(); }
});

test('journal db reader: a closed database is an error with a code, logged, never a file read; json never asks the service', async () => {
  const env = await readerEnv();
  const appendStore = createAppendStore({ log: silent });
  try {
    const closed = createJournal({ appendStore: noAppendStore, dataDir: env.data, log: env.log, fs: noFs, now: () => NOW, memoryDb: env.closedDb });
    await assert.rejects(() => closed.read(GUILD, { day: '2026-10-20' }), (error) => error.code === 'DB_CLOSED');
    await assert.rejects(() => closed.findTurn(GUILD, { messageId: '400000000000000014', at: NOW }), (error) => error.code === 'DB_CLOSED');
    await assert.rejects(() => closed.timeline(GUILD, { from: NOW }), (error) => error.code === 'DB_CLOSED');
    await assert.rejects(() => closed.stats(GUILD), (error) => error.code === 'DB_CLOSED');
    assert.equal(env.warns.length, 4);
    assert.ok(env.warns.every((warn) => warn.message === 'memory db: read failed' && warn.reader === 'journal' && warn.code === 'DB_CLOSED'));
    const files = createJournal({ appendStore, dataDir: env.data, log: silent, now: () => NOW });
    const json = createJournal({ appendStore, dataDir: env.data, log: silent, now: () => NOW, memoryDb: env.jsonDb });
    assert.deepEqual(await json.read(GUILD, { day: '2026-10-21', n: 1000 }), await files.read(GUILD, { day: '2026-10-21', n: 1000 }));
    assert.equal(env.handleAsked(), 0);
  } finally { await appendStore.close(); env.done(); }
});
