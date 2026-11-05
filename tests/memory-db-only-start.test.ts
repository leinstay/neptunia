// The engine's memory starts from the memory database alone: a data directory that holds only `memory.db` and the
// operational files (src/memory/migration/paths.ts), every memory file gone, wired the way src/index.ts wires its memory
// (the database service on its writer, the store, the record, the archive with its pending queue, the journal, the
// meaning index and its queue, the intention and task stores). Everything the fixture held is read back from the
// database, a day of writes goes into it, and after the shutdown no memory file was written and a fresh start reads the
// new writes back. Synthetic data only; the ids are made up.
import { accountOf, placeOfCommunity, placeOfConversation } from '../src/memory/addresses.ts';
import { legacyServerPlaceId } from '../src/memory/migration/paths.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemoryDb } from '../src/memory/db/service.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { isMemoryPath, isOperational } from '../src/memory/migration/paths.ts';
import { createAppendStore } from '../src/memory/append-store.ts';
import { createStore } from '../src/memory/store.ts';
import { createRecord, toRecordLine } from '../src/memory/record.ts';
import { createArchive } from '../src/memory/archive.ts';
import { createJournal } from '../src/memory/journal.ts';
import { createVectors } from '../src/memory/vectors.ts';
import { createEmbedder } from '../src/memory/embedder.ts';
import { createIntentionStores } from '../src/intentions/store.ts';
import { createErrandStores } from '../src/errands/store.ts';
import { CHANNEL, GUILD, MEMBER, buildDataDir } from './fixtures/memory-db/datadir.ts';
import { seedUnits } from './fixtures/memory-db/seed.ts';
import { BOARD_MIGRATIONS } from '../src/board/schema.ts';
import type { Untyped } from '../src/tools/types.ts';
import { wrongly, present } from './fixtures/loose-types.ts';

const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const quiet = { info() {}, debug() {}, warn() {}, error() {} };
const DB_FILES = new Set(['memory.db', 'memory.db-wal', 'memory.db-shm', 'memory.db.lock']);

/** Every file under `dir`, relative with forward slashes. */
function filesOf(dir: string, rel = '', out = []) {
  for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) filesOf(dir, child, out);
    else out.push(wrongly(child));
  }
  return out;
}

/** The fixture written into its database, then every file but the database's own and the operational ones removed. */
function databaseOnly() {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-only-'));
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  buildDataDir(data);
  // Seeded at board v2, as a database from before PR 6d: the fixture's errand lands in the `work` archive and the
  // engine's first open moves it onto the board (board v3), where the errand store reads it.
  const handle = openMemoryDb(path.join(data, 'memory.db'), { boardMigrations: BOARD_MIGRATIONS.slice(0, 2) });
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

/** The memory modules over `data`, as src/index.ts builds them (the clock fixed, no network, no model). */
async function engine(data: string, log = quiet) {
  const config = {
    features: { record: true, journal: true, archive: true, intentions: true },
    memoryDb: { session: { mode: 'off' } },
    errands: { maxOpen: 3 },
    agents: { scout: { daily: { tasks: 5 } } },
  };
  const hot = { config, prompts: {} };
  const memoryDb = createMemoryDb({ hot, dataDir: data, log, now: () => NOW, worker: false });
  // Eager state readers require the database before store construction.
  await memoryDb.open();
  const archiveAppendStore = createAppendStore({ fsyncMs: 0, log });
  const record = createRecord({ dataDir: data, log, now: () => NOW, memoryDb });
  const vectors = createVectors({ dataDir: data, log, now: () => NOW, memoryDb });
  const archive = createArchive({ appendStore: archiveAppendStore, dataDir: data, log, now: () => NOW, memoryDb });
  const journal = createJournal({
    dataDir: data,
    config: () => ({}),
    lockStores: [archiveAppendStore],
    now: () => NOW,
    memoryDb,
    log,
  });
  const store = createStore({ dataDir: data, record, recordOn: () => true, archive, archiveOn: () => true, memoryDb });
  const embedQueue = createEmbedder({ hot, vectors, embed: async () => [], record, log, now: () => NOW, memoryDb });
  const taskStores = createErrandStores({ config: () => config, journal, log, now: () => NOW, memoryDb });
  const intentionStores = createIntentionStores({ log, now: () => NOW, memoryDb });
  return {
    memoryDb,
    store,
    record,
    archive,
    journal,
    vectors,
    embedQueue,
    taskStores,
    intentionStores,
    /** The shutdown of src/index.ts: the stores' writes, the queue, then the database. */
    async close() {
      store.flush();
      await store.flushSettled({ final: true });
      await present(taskStores.get()).flush({ final: true });
      await present(intentionStores.get()).flush({ final: true });
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
    assert.ok(
      before.every((rel) => DB_FILES.has(rel) || isOperational(rel)),
      `only the database and operational files: ${before}`
    );
    assert.ok(before.includes(wrongly('memory.db')));

    const warnings: Array<Untyped> = [];
    const log: Untyped = {
      ...quiet,
      warn: (message: string, fields: Record<string, Untyped>) => warnings.push({ message, ...fields }),
      error: (message: string, fields: Record<string, Untyped>) => warnings.push({ message, ...fields }),
    };
    const first = await engine(data, log);
    await first.memoryDb.tick();
    assert.equal(first.memoryDb.status().open, true);

    // What the fixture held comes back from the database.
    assert.equal(wrongly<{ id: string } | null>(first.store.getUser(accountOf(first.store, MEMBER)))?.id, MEMBER);
    assert.ok(first.store.getPlace(placeOfCommunity(first.store, GUILD)), 'the guild memory');
    assert.equal(first.store.getChannel(placeOfConversation(first.store, { id: CHANNEL }))?.id, CHANNEL);
    assert.deepEqual(first.store.listPrivate(), [`discord:${MEMBER}`]);
    const lines = [];
    for await (const line of first.record.iterate(legacyServerPlaceId('discord', GUILD), {
      from: '2026-10-20T00:00:00.000Z',
      to: '2026-10-20T23:59:59.999Z',
    }))
      lines.push(line);
    assert.ok(lines.length > 0, 'the record day');
    assert.ok(
      (await first.journal.read(legacyServerPlaceId('discord', GUILD), { day: '2026-10-20', n: 100 })).length > 0,
      'the journal day'
    );
    // PR 6d, errands on the board: the fixture's errand is read from the board task board v3 made of it (it was read
    // from the errands unit before).
    assert.deepEqual(
      present(first.taskStores.get())
        .recent(10)
        .map((task) => task.id),
      ['t1']
    );
    assert.ok(Array.isArray(present(first.intentionStores.get()).list()));
    assert.ok((await first.vectors.stats(GUILD)).rows >= 0);

    // A day of writes.
    first.store.touchUser(accountOf(first.store, '100000000000000077'), 'Zoé', NOW);
    first.store.setLore(
      placeOfCommunity(first.store, GUILD),
      [{ title: 'Η πλατεία', keys: ['πλατεία'], text: 'The square by the sea.' }],
      {
        source: 'owner',
        now: NOW,
      }
    );
    const said = toRecordLine({
      id: '700000000000000001',
      placeId: CHANNEL,
      authorId: MEMBER,
      authorName: 'Ana',
      content: 'Καλημέρα, café?',
      ts: NOW,
      attachments: [],
      links: [],
      stickers: [],
      emojis: [],
    });
    assert.deepEqual(await first.record.append(legacyServerPlaceId('discord', GUILD), [said]), {
      written: 1,
      duplicates: 0,
    });
    await first.journal.system({ event: 'pause', by: 'owner' });
    const task = present(first.taskStores.get()).add({
      agent: 'scout',
      goal: 'find the café hours',
      requester: { accountId: MEMBER, kind: 'member' },
      origin: { placeId: CHANNEL, messageId: null },
      scope: 'group',
    });
    assert.equal(task.ok, true);
    await first.close();

    // No memory file was written; the database and the operational files are all there is.
    const after = filesOf(data);
    assert.deepEqual(
      after.filter((rel) => isMemoryPath(rel)),
      [],
      'no memory file'
    );
    assert.ok(
      after.every((rel: string) => DB_FILES.has(rel) || isOperational(rel) || rel.startsWith('memory-pending/')),
      `${after}`
    );
    assert.deepEqual(
      after.filter((rel: string) => rel.startsWith('memory-pending/')),
      [],
      'nothing waits for a next start'
    );
    assert.deepEqual(
      warnings.filter((entry) => /failed|refused|pending|lost/.test(entry.message)),
      []
    );

    // A fresh start reads the new writes back from the database.
    const second = await engine(data);
    await second.memoryDb.tick();
    try {
      assert.equal(
        wrongly<{ names?: Array<string> } | null>(second.store.getUser(accountOf(second.store, '100000000000000077')))
          ?.names?.[0],
        'Zoé'
      );
      assert.ok(
        second.store
          .getLore(placeOfCommunity(second.store, GUILD))
          .some((entry: Record<string, Untyped>) => entry.title === 'Η πλατεία')
      );
      assert.equal(
        await second.record.newestRevision(
          legacyServerPlaceId('discord', GUILD),
          '700000000000000001',
          new Date(NOW).toISOString()
        ),
        1
      );
      assert.ok(
        (await second.journal.read(null, { day: '2026-10-24', n: 100 })).some(
          (entry: Record<string, Untyped>) => entry.kind === 'system' && entry.event === 'pause'
        )
      );
      assert.ok(present(second.taskStores.get()).get(task.errand.id), 'the task');
    } finally {
      await second.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
