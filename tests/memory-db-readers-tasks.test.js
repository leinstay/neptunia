// The errand task stores' reads from the database (stage W1): under authority `db` the list and the spend records
// load from the database, so every read equals the file reads of the same data with the files gone from the disk,
// and a failed load is an error with a code (never a file read) that the next `get` tries again.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createTaskStores } from '../src/errands/store.js';
import { GUILD, GUILD_2, readerEnv } from './fixtures/memory-db/readers.js';

const silent = { info() {}, debug() {}, warn() {}, error() {} };
const NOW = 1792000600000;

function config(root) {
  const out = path.join(root, 'no-out');
  return () => ({ agents: new Proxy({}, { get: () => ({ out }) }) });
}

/** Every read of one guild's store. */
function reads(store) {
  return { open: store.open(), recent: store.recent(100), unseen: store.unseen(), unread: store.unread(), t1: store.get('t1'), none: store.get('nope'), costs: store.costs() };
}

test('tasks db reader: the list and the spend records equal the files, with the files gone from the disk', async () => {
  const env = await readerEnv();
  try {
    const args = { config: config(env.root), now: () => NOW };
    const expected = Object.fromEntries([GUILD, GUILD_2].map((g) => [g, reads(createTaskStores({ dataDir: env.data, log: silent, ...args }).get(g))]));
    assert.equal(expected[GUILD].t1?.state, 'done');
    fs.renameSync(env.data, `${env.data}.gone`);
    const db = createTaskStores({ dataDir: env.data, log: env.log, memoryDb: env.memoryDb, ...args });
    for (const g of [GUILD, GUILD_2]) assert.deepEqual(reads(db.get(g)), expected[g], g);
    assert.deepEqual(env.warns.filter((warn) => warn.message === 'memory db: read failed'), []);
    fs.renameSync(`${env.data}.gone`, env.data);
  } finally { env.done(); }
});

test('tasks db reader: a closed database fails the load with a code, logged; the next get tries again; json never asks', async () => {
  const env = await readerEnv();
  try {
    let open = false;
    const memoryDb = { authority: () => 'db', readHandle: () => (open ? env.handle : null) };
    const stores = createTaskStores({ dataDir: env.data, log: env.log, memoryDb, config: config(env.root), now: () => NOW });
    assert.throws(() => stores.get(GUILD), (error) => error.code === 'DB_CLOSED');
    assert.deepEqual(env.warns.map((warn) => [warn.message, warn.reader, warn.code]), [['memory db: read failed', 'tasks', 'DB_CLOSED']]);
    open = true;
    assert.equal(stores.get(GUILD).get('t1')?.id, 't1');
    const json = createTaskStores({ dataDir: env.data, log: silent, memoryDb: env.jsonDb, config: config(env.root), now: () => NOW });
    assert.deepEqual(reads(json.get(GUILD)), reads(createTaskStores({ dataDir: env.data, log: silent, config: config(env.root), now: () => NOW }).get(GUILD)));
    assert.equal(env.handleAsked(), 0);
  } finally { env.done(); }
});
