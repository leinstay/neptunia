// The engine's memory starts from the memory database alone: a data directory that holds only `memory.db` and the
// operational files (src/memory/db/paths.js), every memory file gone, wired the way src/index.js wires its memory
// (the database service on its writer, the store, the record, the archive with its pending queue, the journal, the
// meaning index and its queue, the intention and task stores). Everything the fixture held is read back from the
// database, a day of writes goes into it, and after the shutdown no memory file was written and a fresh start reads the
// new writes back. Synthetic data only; the ids are made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemoryDb } from '../src/memory/db/service.js';
import { openMemoryDb } from '../src/memory/db/open.js';
import { isMemoryPath, isOperational } from '../src/memory/db/paths.js';
import { createAppendStore } from '../src/memory/append-store.js';
import { createStore } from '../src/memory/store.js';
import { createRecord, toRecordLine } from '../src/memory/record.js';
import { createArchive } from '../src/memory/archive.js';
import { createJournal } from '../src/memory/journal.js';
import { createVectors } from '../src/memory/vectors.js';
import { createEmbedder } from '../src/memory/embedder.js';
import { createIntentionStores } from '../src/intentions/store.js';
import { createTaskStores } from '../src/errands/store.js';
import { CHANNEL, GUILD, MEMBER, buildDataDir } from './fixtures/memory-db/datadir.js';
import { seedUnits } from './fixtures/memory-db/seed.js';

const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const quiet = { info() {}, debug() {}, warn() {}, error() {} };
const DB_FILES = new Set(['memory.db', 'memory.db-wal', 'memory.db-shm', 'memory.db.lock']);

/** Every file under `dir`, relative with forward slashes. */
function filesOf(dir, rel = '', out = []) {
  for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) filesOf(dir, child, out);
    else out.push(child);
  }
  return out;
}

/** The fixture written into its database, then every file but the database's own and the operational ones removed. */
function databaseOnly() {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-only-'));
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  buildDataDir(data);
  const handle = openMemoryDb(path.join(data, 'memory.db'));
  try {
    assert.equal(seedUnits(handle, data, { now: NOW - 86_400_000 }).errors, 0);
  } finally {
    handle.close();
  }
  for (const rel of filesOf(data)) {
    if (!DB_FILES.has(rel) && !isOperational(rel)) fs.rmSync(path.join(data, rel));
  }
  return { root, data };
}

/** The memory modules over `data`, as src/index.js builds them (the clock fixed, no network, no model). */
function engine(data, log = quiet) {
  const config = { features: { record: true, journal: true, archive: true, intentions: true }, memoryDb: { session: { mode: 'off' } }, agents: { maxOpen: 3, scout: { daily: { tasks: 5 } } } };
  const hot = { config, prompts: {} };
  const memoryDb = createMemoryDb({ hot, dataDir: data, log, now: () => NOW, worker: false });
  const archiveAppendStore = createAppendStore({ fsyncMs: 0, log });
  const record = createRecord({ dataDir: data, log, now: () => NOW, memoryDb });
  const vectors = createVectors({ dataDir: data, log, now: () => NOW, memoryDb });
  const archive = createArchive({ appendStore: archiveAppendStore, dataDir: data, log, now: () => NOW, memoryDb });
  const journal = createJournal({ dataDir: data, config: () => ({}), lockStores: [archiveAppendStore], now: () => NOW, memoryDb, log });
  const store = createStore({ dataDir: data, record, recordOn: () => true, archive, archiveOn: () => true, memoryDb });
  const embedQueue = createEmbedder({ hot, vectors, embed: async () => [], record, log, now: () => NOW, memoryDb });
  const taskStores = createTaskStores({ config: () => config, journal, log, now: () => NOW, memoryDb });
  const intentionStores = createIntentionStores({ log, now: () => NOW, memoryDb });
  return {
    memoryDb, store, record, archive, journal, vectors, embedQueue, taskStores, intentionStores,
    /** The shutdown of src/index.js: the stores' writes, the queue, then the database. */
    async close() {
      store.flush();
      await store.flushSettled({ final: true });
      await taskStores.get(GUILD).flush({ final: true });
      await intentionStores.get(GUILD).flush({ final: true });
      await embedQueue.close?.({ timeoutMs: 100 });
      await archiveAppendStore.close();
      await memoryDb.close();
    },
  };
}

test('the memory starts from memory.db and the operational files alone, writes only to the database, and a restart reads it back', async () => {
  const { root, data } = databaseOnly();
  try {
    const before = filesOf(data);
    assert.ok(before.every((rel) => DB_FILES.has(rel) || isOperational(rel)), `only the database and operational files: ${before}`);
    assert.ok(before.includes('memory.db'));

    const warnings = [];
    const log = { ...quiet, warn: (message, fields) => warnings.push({ message, ...fields }), error: (message, fields) => warnings.push({ message, ...fields }) };
    const first = engine(data, log);
    await first.memoryDb.tick();
    assert.equal(first.memoryDb.status().open, true);

    // What the fixture held comes back from the database.
    assert.equal(first.store.getUser(GUILD, MEMBER)?.id, MEMBER);
    assert.ok(first.store.getGuild(GUILD), 'the guild memory');
    assert.equal(first.store.getChannel(GUILD, CHANNEL)?.id, CHANNEL);
    assert.deepEqual(first.store.listPrivate(GUILD), [MEMBER]);
    const lines = [];
    for await (const line of first.record.iterate(GUILD, { from: '2026-10-20T00:00:00.000Z', to: '2026-10-20T23:59:59.999Z' })) lines.push(line);
    assert.ok(lines.length > 0, 'the record day');
    assert.ok((await first.journal.read(GUILD, { day: '2026-10-20', n: 100 })).length > 0, 'the journal day');
    assert.deepEqual(first.taskStores.get(GUILD).recent(10).map((task) => task.id), ['t1']);
    assert.ok(Array.isArray(first.intentionStores.get(GUILD).list()));
    assert.ok((await first.vectors.stats(GUILD)).rows >= 0);

    // A day of writes.
    first.store.touchUser(GUILD, '100000000000000077', 'Zoé', NOW);
    first.store.setLore(GUILD, [{ title: 'Η πλατεία', keys: ['πλατεία'], text: 'The square by the sea.' }], { source: 'owner', now: NOW });
    const said = toRecordLine({ id: '700000000000000001', channelId: CHANNEL, authorId: MEMBER, authorName: 'Ana', content: 'Καλημέρα, café?', ts: NOW, attachments: [], links: [], stickers: [], emojis: [] });
    assert.deepEqual(await first.record.append(GUILD, [said]), { written: 1, duplicates: 0 });
    await first.journal.system(GUILD, { event: 'pause', by: 'owner' });
    const task = first.taskStores.get(GUILD).add({ agent: 'scout', goal: 'find the café hours', requester: { userId: MEMBER, kind: 'member' }, origin: { channelId: CHANNEL, messageId: null }, scope: 'group' });
    assert.equal(task.ok, true);
    await first.close();

    // No memory file was written; the database and the operational files are all there is.
    const after = filesOf(data);
    assert.deepEqual(after.filter((rel) => isMemoryPath(rel)), [], 'no memory file');
    assert.ok(after.every((rel) => DB_FILES.has(rel) || isOperational(rel) || rel.startsWith('memory-pending/')), `${after}`);
    assert.deepEqual(after.filter((rel) => rel.startsWith('memory-pending/')), [], 'nothing waits for a next start');
    assert.deepEqual(warnings.filter((entry) => /failed|refused|pending|lost/.test(entry.message)), []);

    // A fresh start reads the new writes back from the database.
    const second = engine(data);
    await second.memoryDb.tick();
    try {
      assert.equal(second.store.getUser(GUILD, '100000000000000077')?.names?.[0], 'Zoé');
      assert.ok(second.store.getLore(GUILD).some((entry) => entry.title === 'Η πλατεία'));
      assert.equal(await second.record.newestRevision(GUILD, '700000000000000001', new Date(NOW).toISOString()), 1);
      assert.ok((await second.journal.read(GUILD, { day: '2026-10-24', n: 100 })).some((entry) => entry.kind === 'system' && entry.event === 'pause'));
      assert.ok(second.taskStores.get(GUILD).get(task.task.id), 'the task');
    } finally {
      await second.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
