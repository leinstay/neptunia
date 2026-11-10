// The seam of the database readers (stage W1): the service's read connection is what the readers read through; the
// store's directory ids and `/nep resume`'s check, and the embedder's catch-up, come from the database with no file
// read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createMemoryDb } from '../src/memory/db/service.ts';
import { createStore, operationalJsonPath } from '../src/memory/store.ts';
import { createRecord } from '../src/memory/record.ts';
import { createVectors } from '../src/memory/vectors.ts';
import { createEmbedder } from '../src/memory/embedder.ts';
import { GUILD, placeOfGuild, GUILD_2, MEMBER, readerEnv } from './fixtures/memory-db/readers.ts';
import { buildDataDir } from './fixtures/memory-db/datadir.ts';

const silent = { info() {}, debug() {}, warn() {}, error() {} };

test('service: the read connection opens with the first tick and closes with the service', async () => {
  const env = await readerEnv();
  try {
    const dataDir = path.join(env.root, 'service');
    fs.mkdirSync(dataDir);
    buildDataDir(dataDir);
    const service = createMemoryDb({
      iface: () => 'discord',
      hot: { config: {} },
      dataDir,
      log: silent,
      worker: false,
      now: () => Date.UTC(2026, 9, 24),
    });
    assert.equal(service.readHandle(), null, 'nothing open before the first tick');
    await service.tick();
    assert.ok(service.readHandle()?.db, 'the read connection once open');
    await service.close();
    assert.equal(service.readHandle(), null, 'closed: no read connection');
  } finally {
    env.done();
  }
});

test('store: the directory ids come from the database only; a closed database is an error with a code', async () => {
  const env = await readerEnv();
  try {
    const originalReaddir = fs.readdirSync;
    let readdirs = 0;
    // The overloads of readdirSync cannot take a forwarded rest, so the wrapper forwards through a loose signature.
    const forward = originalReaddir as (...rest: Array<unknown>) => unknown;
    fs.readdirSync = ((...args: Array<unknown>) => {
      readdirs += 1;
      return forward(...args);
    }) as typeof fs.readdirSync;
    try {
      const store = createStore({ dataDir: env.data, memoryDb: env.memoryDb });
      // The account of the private layer, stored under its spelled id; the same in every guild it writes from.
      assert.deepEqual(
        { privates: store.listPrivate().sort(), users: store.countUsers() },
        { privates: [`discord:${MEMBER}`], users: 1 }
      );
      assert.equal(readdirs, 0, 'no directory listed');
    } finally {
      fs.readdirSync = originalReaddir;
    }
    // Root state loads eagerly, so the same closed-database error occurs at construction.
    assert.throws(
      () => createStore({ dataDir: env.data, memoryDb: env.closedDb }),
      (error: NodeJS.ErrnoException) => error.code === 'DB_CLOSED'
    );
  } finally {
    env.done();
  }
});

test('store: /nep resume checks only the operational JSON files', async () => {
  const env = await readerEnv();
  try {
    const g = path.join(env.data, 'places', GUILD);
    fs.mkdirSync(path.join(g, 'users'), { recursive: true });
    fs.writeFileSync(path.join(g, 'users', '100000000000000077.json'), '{ broken');
    fs.writeFileSync(path.join(g, 'unknown.json'), '{ broken');
    fs.mkdirSync(path.join(g, 'journal', 'requests', '2026-10-21'), { recursive: true });
    fs.writeFileSync(path.join(g, 'journal', 'requests', '2026-10-21', 'turn-9-s1.json'), '{ broken');
    const broken = createStore({ dataDir: env.data, memoryDb: env.memoryDb }).validate().sort();
    // Retired inner state is database-authoritative. The malformed operational request still fails validation.
    assert.deepEqual(broken, [`places/${GUILD}/journal/requests/2026-10-21/turn-9-s1.json`]);
    for (const [rel, kept] of [
      ['state.json', false],
      ['usage.json', false],
      ['vault/x/places/1/users/2.json', true],
      ['snapshots/a/b.json', true],
      [`places/${GUILD}/gifs.json`, false],
      [`places/${GUILD}/media.json`, false],
      [`places/${GUILD}/participation.json`, false],
      [`places/${GUILD}/backfill/state.json`, true],
      [`places/${GUILD}/record/backfill.json`, true],
      [`places/${GUILD}/private/${MEMBER}/missed.json`, true],
      [`places/${GUILD}/guild.json`, false],
      [`places/${GUILD}/intentions.json`, false],
      [`places/${GUILD}/private/${MEMBER}.json`, false],
      [`places/${GUILD}/record/2026-10/ids.json`, false],
      [`places/${GUILD}/forgotten.json`, false],
    ] as Array<[string, boolean]>)
      assert.equal(operationalJsonPath(rel), kept, rel);
  } finally {
    env.done();
  }
});

test('embedder: the catch-up survey comes from the database', async () => {
  const env = await readerEnv();
  try {
    const now = () => Date.parse('2026-10-21T23:00:00.000Z');
    const hot = { config: { features: { meaningSearch: true, embedIndex: true }, embed: { catchUpHours: 72 } } };
    const embed = async () => {
      throw new Error('no model call in a test');
    };
    const embedder = createEmbedder({
      hot,
      embed,
      now,
      log: env.log,
      memoryDb: env.memoryDb,
      record: createRecord({ dataDir: env.data, log: env.log, memoryDb: env.memoryDb }),
      vectors: createVectors({ dataDir: env.data, log: env.log, memoryDb: env.memoryDb }),
    });
    const found = await embedder.coverage(placeOfGuild(GUILD), { hours: 72 });
    assert.ok(found.messages > 0 && found.indexed > 0, 'messages counted and some indexed');
    const second = await embedder.coverage(placeOfGuild(GUILD_2), { hours: 72 });
    assert.ok(second.messages > 0, 'the second guild counted');
    assert.deepEqual(
      env.warns.filter((warn) => warn.message === 'memory db: read failed'),
      []
    );
  } finally {
    env.done();
  }
});
