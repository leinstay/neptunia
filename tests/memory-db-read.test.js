// The read switch (spec section 7): a store booted over a data directory once reading the JSON files and once
// reading through the database imported from the same directory gives deep-equal values from every public read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createStore } from '../src/memory/store.js';
import { createMemoryDb } from '../src/memory/db/service.js';
import { openMemoryDb } from '../src/memory/db/open.js';
import { exportOne, idsUnderDir } from '../src/memory/db/export.js';
import { syncOnce } from '../src/memory/db/sync.js';
import { CHANNEL, GUILD, MEMBER, buildDataDir, guildDir, writeJson } from './fixtures/memory-db/datadir.js';

const tmpRoot = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-read-'));

async function setup({ read = true } = {}) {
  const root = tmpRoot();
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  buildDataDir(data);
  const hot = { config: { features: { memoryDb: true }, memoryDb: { read, syncSeconds: 60 } } };
  const service = createMemoryDb({ hot, dataDir: data, log: { info() {}, warn() {}, error() {}, debug() {} } });
  await service.tick();
  return { root, data, hot, service, g: guildDir(data), done: async () => { await service.close(); fs.rmSync(root, { recursive: true, force: true }); } };
}

/** Every public read of the store the fixture directory has something for. */
function readAll(store) {
  return {
    user: store.getUser(GUILD, MEMBER),
    users: store.listUserProfiles(GUILD),
    userCount: store.countUsers(GUILD),
    private: store.getPrivate(GUILD, MEMBER),
    privateBuffer: store.getPrivateBuffer(GUILD, MEMBER),
    privateIds: store.listPrivate(GUILD),
    guild: store.getGuild(GUILD),
    channel: store.getChannel(GUILD, CHANNEL),
    channels: store.listChannels(GUILD),
    lore: store.getLore(GUILD),
    media: store.getMediaCache(GUILD),
    gifs: store.getGifs(GUILD),
    recent: store.getRecent(GUILD),
    participation: store.getParticipation(GUILD),
    diary: store.getDiary(GUILD),
    buffer: store.getBuffer(GUILD),
    voice: store.getVoiceQueue(GUILD),
    versions: store.listVersions(GUILD, 'users', MEMBER),
  };
}

test('a store reading through the database returns deep-equal values from every public read', async () => {
  const env = await setup();
  try {
    const fromFiles = readAll(createStore({ dataDir: env.data }));
    const status = () => env.service.status().reads;
    assert.equal(status().db, 0);
    const fromDb = readAll(createStore({ dataDir: env.data, memoryRead: env.service.reader }));
    assert.ok(status().db >= 8, `the database served ${status().db} files`);
    assert.deepEqual(fromDb, fromFiles);
    // The fixture really holds something in each read, so equality is not two empty answers.
    assert.ok(fromFiles.user && fromFiles.user.id === MEMBER);
    assert.ok(fromFiles.users.length === 1 && fromFiles.privateIds.length === 1 && fromFiles.channels.length === 1);
    assert.equal(fromFiles.recent.lines.length, 1);
  } finally { await env.done(); }
});

test('the read switch off, or the database not synced yet: the store reads the disk and nothing is counted as served', async () => {
  const env = await setup({ read: false });
  try {
    readAll(createStore({ dataDir: env.data, memoryRead: env.service.reader }));
    assert.deepEqual(env.service.status().reads, { db: 0, missing: 0, stale: 0, unmapped: 0, empty: 0, errors: 0 });
    env.hot.config.memoryDb.read = true;
    env.hot.config.features.memoryDb = false;
    assert.equal(env.service.reader.value(path.join(env.g, 'guild.json')), null);
    assert.equal(env.service.reader.ids(path.join(env.g, 'users')), null);
  } finally { await env.done(); }
});

test('a file the database does not hold, or holds behind the disk, is read from the disk and counted', async () => {
  const env = await setup();
  try {
    const late = '100000000000000055';
    writeJson(path.join(env.g, 'users', `${late}.json`), { id: late, names: ['Late'] });
    const edited = JSON.parse(fs.readFileSync(path.join(env.g, 'users', `${MEMBER}.json`), 'utf8'));
    edited.names = ['Edited'];
    writeJson(path.join(env.g, 'users', `${MEMBER}.json`), edited);
    const store = createStore({ dataDir: env.data, memoryRead: env.service.reader });
    assert.deepEqual(store.getUser(GUILD, late).names, ['Late']);
    assert.deepEqual(store.getUser(GUILD, MEMBER).names, ['Edited']);
    const reads = env.service.status().reads;
    assert.equal(reads.missing, 1, 'the new file');
    assert.equal(reads.stale, 1, 'the edited file');
    // state.json is instance state: not a memory file, always the disk.
    assert.ok(reads.unmapped >= 1);
  } finally { await env.done(); }
});

test('ids under a directory come from the database; a directory it holds nothing for falls back to the disk', async () => {
  const env = await setup();
  try {
    const store = createStore({ dataDir: env.data, memoryRead: env.service.reader });
    assert.deepEqual(store.listPrivate(GUILD), [MEMBER]);
    // A guild the database never saw is listed from the disk.
    const other = '300000000000000009';
    writeJson(path.join(env.data, 'guilds', other, 'users', '100000000000000066.json'), { id: '100000000000000066', names: ['Elsewhere'] });
    assert.equal(store.countUsers(other), 1);
  } finally { await env.done(); }
});

test('exportOne: the value of one JSON file from the rows, with the reason when it has none', async () => {
  const env = await setup();
  try {
    const handle = openMemoryDb(path.join(env.root, 'one.db'));
    syncOnce(handle, env.data);
    const rel = `guilds/${GUILD}/users/${MEMBER}.json`;
    const found = exportOne(handle, rel, { dataDir: env.data });
    assert.equal(found.found, true);
    assert.deepEqual(found.value, JSON.parse(fs.readFileSync(path.join(env.data, rel), 'utf8')));
    assert.deepEqual(exportOne(handle, 'state.json'), { found: false, reason: 'unmapped' });
    assert.deepEqual(exportOne(handle, `guilds/${GUILD}/record/2026-10/2026-10-20.jsonl`), { found: false, reason: 'unmapped' });
    assert.deepEqual(exportOne(handle, `guilds/${GUILD}/users/nobody.json`), { found: false, reason: 'missing' });
    fs.appendFileSync(path.join(env.data, rel), ' ');
    assert.deepEqual(exportOne(handle, rel, { dataDir: env.data }), { found: false, reason: 'stale' });
    assert.equal(exportOne(handle, rel).found, true, 'without a data directory the staleness is not checked');
    assert.deepEqual(idsUnderDir(handle, `guilds/${GUILD}/users`), [MEMBER]);
    assert.equal(idsUnderDir(handle, `guilds/${GUILD}/nothing`), null);
    handle.close();
  } finally { await env.done(); }
});
