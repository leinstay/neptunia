// The seam of the database readers (stage W1): the service's authority is fixed for the process and its read
// connection is what the readers read through; the store's directory ids and `/nep resume`'s check, and the
// embedder's catch-up, follow the authority with no file read under `db`.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createMemoryDb } from '../src/memory/db/service.js';
import { createStore, operationalJsonPath } from '../src/memory/store.js';
import { createRecord } from '../src/memory/record.js';
import { createVectors } from '../src/memory/vectors.js';
import { createEmbedder } from '../src/memory/embedder.js';
import { createAppendStore } from '../src/memory/append-store.js';
import { GUILD, GUILD_2, MEMBER, noFs, readerEnv } from './fixtures/memory-db/readers.js';
import { buildDataDir } from './fixtures/memory-db/datadir.js';

const silent = { info() {}, debug() {}, warn() {}, error() {} };

function collect() {
  const out = [];
  const add = (level) => (message, fields) => out.push({ level, message, ...fields });
  return { out, info: add('info'), warn: add('warn'), error: add('error'), debug: add('debug') };
}

test('service: the readers\' authority is the one at creation; a change is logged once and needs a restart', async () => {
  const env = await readerEnv();
  try {
    const dataDir = path.join(env.root, 'service');
    fs.mkdirSync(dataDir);
    buildDataDir(dataDir);
    const hot = { config: { features: { memoryDb: true }, memoryDb: { authority: 'db' } } };
    const log = collect();
    const service = createMemoryDb({ hot, dataDir, log, worker: false, now: () => Date.UTC(2026, 9, 24) });
    assert.equal(service.authority(), 'db');
    assert.equal(service.readHandle(), null, 'nothing open before the first tick');
    await service.tick();
    assert.ok(service.readHandle()?.db, 'the read connection once open');
    hot.config.memoryDb.authority = 'json';
    assert.equal(service.authority(), 'db');
    await service.tick();
    assert.equal(service.authority(), 'db');
    const changes = log.out.filter((entry) => entry.message === 'memory db: authority change needs a restart');
    assert.deepEqual(changes.map(({ level, running, asked }) => [level, running, asked]), [['warn', 'db', 'json']]);
    hot.config.features.memoryDb = false;
    await service.tick();
    assert.equal(service.readHandle(), null, 'switched off: no read connection');
    await service.close();
    const plain = createMemoryDb({ hot: { config: { features: { memoryDb: true } } }, dataDir, log: silent, worker: false });
    assert.equal(plain.authority(), 'json');
    await plain.close();
  } finally { env.done(); }
});

test('store: under db the directory ids come from the database only; a closed database is an error with a code', async () => {
  const env = await readerEnv();
  try {
    const files = createStore({ dataDir: env.data });
    const expected = Object.fromEntries([GUILD, GUILD_2].map((g) => [g, { privates: files.listPrivate(g).sort(), users: files.countUsers(g) }]));
    assert.ok(expected[GUILD].privates.includes(MEMBER));
    const originalReaddir = fs.readdirSync;
    let readdirs = 0;
    fs.readdirSync = (...args) => { readdirs += 1; return originalReaddir(...args); };
    try {
      const db = createStore({ dataDir: env.data, memoryDb: env.memoryDb });
      for (const g of [GUILD, GUILD_2]) assert.deepEqual({ privates: db.listPrivate(g).sort(), users: db.countUsers(g) }, expected[g], g);
      assert.equal(readdirs, 0, 'no directory listed');
      const empty = createStore({ dataDir: env.data, memoryDb: env.memoryDb });
      assert.deepEqual(empty.listPrivate('300000000000000099'), []);
    } finally { fs.readdirSync = originalReaddir; }
    const closed = createStore({ dataDir: env.data, memoryDb: env.closedDb });
    assert.throws(() => closed.listPrivate(GUILD), (error) => error.code === 'DB_CLOSED');
    const json = createStore({ dataDir: env.data, memoryDb: env.jsonDb });
    assert.deepEqual(json.listPrivate(GUILD).sort(), expected[GUILD].privates);
    assert.equal(env.handleAsked(), 0);
  } finally { env.done(); }
});

test('store: under db /nep resume checks only the operational JSON files', async () => {
  const env = await readerEnv();
  try {
    const g = path.join(env.data, 'guilds', GUILD);
    fs.writeFileSync(path.join(g, 'users', '100000000000000077.json'), '{ broken');
    fs.writeFileSync(path.join(g, 'inner.json'), '{ broken');
    fs.mkdirSync(path.join(g, 'journal', 'requests', '2026-10-21'), { recursive: true });
    fs.writeFileSync(path.join(g, 'journal', 'requests', '2026-10-21', 'turn-9-s1.json'), '{ broken');
    const json = createStore({ dataDir: env.data, memoryDb: env.jsonDb }).validate().sort();
    assert.deepEqual(json, [
      `guilds/${GUILD}/inner.json`, `guilds/${GUILD}/journal/requests/2026-10-21/turn-9-s1.json`, `guilds/${GUILD}/users/100000000000000077.json`,
    ]);
    const db = createStore({ dataDir: env.data, memoryDb: env.memoryDb }).validate().sort();
    assert.deepEqual(db, [`guilds/${GUILD}/inner.json`, `guilds/${GUILD}/journal/requests/2026-10-21/turn-9-s1.json`]);
    for (const [rel, kept] of [
      ['state.json', true], ['usage.json', true], ['vault/x/guilds/1/users/2.json', true], ['snapshots/a/b.json', true],
      [`guilds/${GUILD}/gifs.json`, true], [`guilds/${GUILD}/media.json`, true], [`guilds/${GUILD}/participation.json`, true],
      [`guilds/${GUILD}/backfill/state.json`, true], [`guilds/${GUILD}/record/backfill.json`, true], [`guilds/${GUILD}/private/${MEMBER}/missed.json`, true],
      [`guilds/${GUILD}/guild.json`, false], [`guilds/${GUILD}/intentions.json`, false], [`guilds/${GUILD}/private/${MEMBER}.json`, false],
      [`guilds/${GUILD}/record/2026-10/ids.json`, false], [`guilds/${GUILD}/forgotten.json`, false],
    ]) assert.equal(operationalJsonPath(rel), kept, rel);
  } finally { env.done(); }
});

test('embedder: under db the catch-up survey equals the files, with no file read', async () => {
  const env = await readerEnv();
  const appendStore = createAppendStore({ log: silent });
  try {
    const now = () => Date.parse('2026-10-21T23:00:00.000Z');
    const hot = { config: { features: { meaningSearch: true, embedIndex: true }, embed: { catchUpHours: 72 } } };
    const embed = async () => { throw new Error('no model call in a test'); };
    const files = createEmbedder({
      hot, embed, now, log: silent, dataDir: env.data,
      record: createRecord({ appendStore, dataDir: env.data, log: silent }), vectors: createVectors({ dataDir: env.data, log: silent }),
    });
    const noAppendStore = { iterate() { throw Object.assign(new Error('the files were read'), { code: 'FILE_READ' }); } };
    const db = createEmbedder({
      hot, embed, now, log: env.log, dataDir: env.data, fs: noFs, memoryDb: env.memoryDb,
      record: createRecord({ appendStore: noAppendStore, dataDir: env.data, log: env.log, fs: noFs, memoryDb: env.memoryDb }),
      vectors: createVectors({ dataDir: env.data, log: env.log, fs: noFs, memoryDb: env.memoryDb }),
    });
    for (const g of [GUILD, GUILD_2]) {
      const expected = await files.coverage(g, { hours: 72 });
      assert.deepEqual(await db.coverage(g, { hours: 72 }), expected, g);
    }
    const found = await db.coverage(GUILD, { hours: 72 });
    assert.ok(found.messages > 0 && found.indexed > 0, 'messages counted and some indexed');
    assert.deepEqual(env.warns.filter((warn) => warn.message === 'memory db: read failed'), []);
  } finally { await appendStore.close(); env.done(); }
});
