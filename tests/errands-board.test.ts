// The errand store (src/errands/store.ts) on the task board (PR 6d): it reads her errands back from the board as the
// `work` archive held them, writes nothing to the archive or to an errand unit, ends an errand in one writer
// transaction (the board move, the outbox row to `persona`, the closing journal line, all or none), keeps an end it
// committed pending until its `errand.done` is marked delivered, and her journal lines of an errand reference its task.
// The memory service is the real one on the calling thread (fixtures/memory-db/service.js), the journal the real one
// over it, the clock fixed. A failure inside the end's transaction is injected with a SQLite trigger on the database
// file. Temporary data directories only.
import { after, test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createErrandStore, createErrandStores } from '../src/errands/store.ts';
import { createErrandService } from '../src/errands/service.ts';
import { createErrandTurns, errandDoneEvent } from '../src/errands/turns.ts';
import { createJournal } from '../src/memory/journal.js';
import { readBoard } from '../src/board/board.ts';
import type { BoardDb } from '../src/board/schema.ts';
import type { ErrandStore } from '../src/errands/types.ts';
import { tableHashes } from '../tools/memory-db.mjs';
import { openTestMemorySync, tempDataDir } from './fixtures/memory-db/service.js';
import { ARCHIVE, GUILD, T0, archiveDataDir, archived } from './fixtures/errand-archive.ts';
import { channel, rig } from './fixtures/reads-rig.ts';

const NOW = T0 + 60 * 60 * 1000;
const SILENT = { info() {}, warn() {}, error() {}, debug() {} };

const CONFIG = {
  features: { journal: true },
  errands: { maxOpen: 3, resultCooldownSeconds: 0, resultRetrySeconds: 0 },
  agents: { scout: { daily: { tasks: 5 } }, server: { daily: { tasks: 5 } } },
  mention: { oneAtATime: true },
};

const ASKED = {
  agent: 'scout',
  goal: 'find the opening hours of the library',
  requester: { userId: 'u1', kind: 'member' },
  origin: { channelId: 'c1', messageId: 'm7' },
  scope: 'group' as const,
};

type MemoryDb = ReturnType<typeof openTestMemorySync>['memoryDb'];
type Rig = { memoryDb: MemoryDb; dataDir: string; store: ErrandStore; journal: ReturnType<typeof createJournal> };

const OPENED: Array<{ close: () => unknown }> = [];
after(async () => {
  for (const memory of OPENED) await memory.close();
});

let counter = 0;
const uuid = (): string => `${(counter += 1).toString(16).padStart(8, '0')}-aaaa-bbbb-cccc-dddddddddddd`;

/** The memory service over `dataDir` (a new one when omitted), the real journal over it, and a store of the guild. */
function setUp(dataDir: string = tempDataDir('nep-errands-board-')): Rig {
  const memory = openTestMemorySync({ dataDir, now: () => NOW, log: SILENT });
  OPENED.push(memory);
  const journal = createJournal({
    dataDir,
    config: () => CONFIG,
    now: () => NOW,
    uuid,
    log: SILENT,
    memoryDb: memory.memoryDb,
  });
  return { memoryDb: memory.memoryDb, dataDir, journal, store: storeOver(memory.memoryDb, journal) };
}

/** A store of the guild over `memoryDb`, as a core started anew builds it. */
function storeOver(memoryDb: MemoryDb, journal: ReturnType<typeof createJournal> | null = null): ErrandStore {
  return createErrandStore({
    guildId: GUILD,
    now: () => NOW,
    config: () => CONFIG,
    journal,
    uuid,
    log: SILENT,
    memoryDb,
  });
}

/** The read connection of the service, as the board's reads take it. */
function readDb(memoryDb: MemoryDb): BoardDb {
  // service.js types its read handle loosely; it is open.js's handle, `{ db }`, or null while the database is closed.
  const handle: { db: object } | null = memoryDb.readHandle() as { db: object } | null;
  if (!handle) throw new Error('the memory database is not open');
  // The read handle's connection is node:sqlite's DatabaseSync, which has every method BoardDb names.
  return handle.db as BoardDb;
}

/** Every write the store and the journal sent, landed. */
async function settle(store: ErrandStore): Promise<void> {
  for (let i = 0; i < 5; i += 1) {
    await store.flush();
    await new Promise((resolve) => setImmediate(resolve));
  }
}

/** A trigger on the database file that aborts the statement it guards, for a failure inside the end's transaction. */
function inject(dataDir: string, sql: string): void {
  const db = new DatabaseSync(path.join(dataDir, 'memory.db'));
  try {
    db.exec(sql);
  } finally {
    db.close();
  }
}

/** The phases of the journal lines whose `day` row references errand `id`, in the order they were written. */
function workPhases(memoryDb: MemoryDb, id: string): Array<string> {
  return readDb(memoryDb)
    .prepare("SELECT json_extract(extra, '$.phase') AS phase FROM day WHERE work_id = ? ORDER BY rowid")
    .all(id)
    .map((row) => String(row.phase));
}

const closingLines = (memoryDb: MemoryDb, id: string): number =>
  workPhases(memoryDb, id).filter((phase) => phase === 'succeeded' || phase === 'failed').length;

const outboxRows = (memoryDb: MemoryDb, id: string): Array<Record<string, unknown>> =>
  readDb(memoryDb).prepare('SELECT * FROM board_outbox WHERE task_id = ? ORDER BY seq').all(id);

const statusOf = (memoryDb: MemoryDb, id: string): string =>
  readBoard(readDb(memoryDb), () => NOW).show(id).task.status;

/** An errand of the scout queued and started, its writes landed. */
async function running(rig: Rig): Promise<string> {
  const added = rig.store.add(ASKED);
  assert.equal(added.ok, true);
  const id = added.errand?.id ?? '';
  rig.store.start(id);
  await settle(rig.store);
  return id;
}

const DONE = { status: 'done', result: { text: 'Open until eight.', sources: [], files: [] }, usage: { usd: 0.02 } };

test('a store over the moved archive reads every errand back as the archive held it', () => {
  const { dataDir } = archiveDataDir();
  const { store, memoryDb } = setUp(dataDir);
  assert.equal(readBoard(readDb(memoryDb), () => NOW).list().length, ARCHIVE.length, 'the open moved them');
  for (const errand of ARCHIVE) assert.deepEqual(store.get(errand.id), archived(errand.id), errand.id);
});

test("the store's writes after the move leave work, work_events and the errand units as they were", async () => {
  const { dataDir } = archiveDataDir();
  const rig = setUp(dataDir);
  const archive = (): unknown => [
    tableHashes(readDb(rig.memoryDb), ['work', 'work_events']),
    readDb(rig.memoryDb).prepare("SELECT * FROM files WHERE path LIKE 'guilds/g1/errands%' ORDER BY path").all(),
  ];
  const before = archive();
  const id = await running(rig);
  rig.store.finish(id, DONE);
  rig.store.markRead(id);
  rig.store.resolve('t0000e002');
  await settle(rig.store);
  assert.equal(statusOf(rig.memoryDb, id), 'done', 'the errand went to the board');
  assert.deepEqual(archive(), before);
});

test('an errand end commits the board move, the outbox row to persona and the closing journal line', async () => {
  const rig = setUp();
  const id = await running(rig);
  rig.store.finish(id, DONE);
  await settle(rig.store);
  assert.equal(statusOf(rig.memoryDb, id), 'done');
  assert.deepEqual(
    outboxRows(rig.memoryDb, id).map((row) => [row.to_whom, row.kind]),
    [['persona', 'done']]
  );
  assert.equal(closingLines(rig.memoryDb, id), 1);
});

test('a failing closing journal line leaves the errand in progress on the board with no outbox row', async () => {
  const rig = setUp();
  const id = await running(rig);
  inject(
    rig.dataDir,
    `CREATE TRIGGER fail_closing BEFORE INSERT ON day WHEN json_extract(NEW.extra, '$.phase') = 'succeeded'
     BEGIN SELECT RAISE(ABORT, 'injected'); END;`
  );
  rig.store.finish(id, DONE);
  await settle(rig.store);
  assert.equal(statusOf(rig.memoryDb, id), 'in_progress');
  assert.deepEqual(outboxRows(rig.memoryDb, id), []);
  assert.equal(closingLines(rig.memoryDb, id), 0);
});

test('a failing outbox row leaves the errand in progress on the board with no closing journal line', async () => {
  const rig = setUp();
  const id = await running(rig);
  inject(
    rig.dataDir,
    "CREATE TRIGGER fail_outbox BEFORE INSERT ON board_outbox BEGIN SELECT RAISE(ABORT, 'injected'); END;"
  );
  rig.store.finish(id, DONE);
  await settle(rig.store);
  assert.equal(statusOf(rig.memoryDb, id), 'in_progress');
  assert.deepEqual(outboxRows(rig.memoryDb, id), []);
  assert.equal(closingLines(rig.memoryDb, id), 0);
});

test('a failing board move leaves no outbox row and no closing journal line', async () => {
  const rig = setUp();
  const id = await running(rig);
  inject(
    rig.dataDir,
    `CREATE TRIGGER fail_move BEFORE UPDATE OF status ON board_tasks WHEN NEW.status = 'done'
     BEGIN SELECT RAISE(ABORT, 'injected'); END;`
  );
  rig.store.finish(id, DONE);
  await settle(rig.store);
  assert.equal(statusOf(rig.memoryDb, id), 'in_progress');
  assert.deepEqual(outboxRows(rig.memoryDb, id), []);
  assert.equal(closingLines(rig.memoryDb, id), 0);
});

test('an end committed before a restart is pending once at the next start, under its errand-done event id', async () => {
  const rig = setUp();
  const id = await running(rig);
  rig.store.finish(id, DONE);
  await settle(rig.store);
  const restarted = storeOver(rig.memoryDb);
  assert.deepEqual(restarted.pendingEnds(), [{ eventId: `errand-done:${id}`, errandId: id, state: 'done' }]);
});

test('an end marked delivered is pending no more, after a restart too', async () => {
  const rig = setUp();
  const id = await running(rig);
  rig.store.finish(id, DONE);
  await settle(rig.store);
  assert.equal(rig.store.markDelivered(id), true);
  await settle(rig.store);
  const restarted = storeOver(rig.memoryDb);
  assert.deepEqual(restarted.pendingEnds(), []);
  assert.equal(restarted.markDelivered(id), false);
});

test('her journal lines of an errand reference its task, whose title is what she asked the scout for', async () => {
  const rig = setUp();
  const id = await running(rig);
  rig.store.finish(id, DONE);
  await settle(rig.store);
  assert.deepEqual(workPhases(rig.memoryDb, id), ['proposed', 'started', 'succeeded']);
  const proposed = readDb(rig.memoryDb)
    .prepare("SELECT json_extract(extra, '$.input.agent') AS agent FROM day WHERE work_id = ? ORDER BY rowid LIMIT 1")
    .get(id);
  assert.equal(proposed?.agent, 'scout');
  assert.equal(readBoard(readDb(rig.memoryDb), () => NOW).show(id).task.title, ASKED.goal);
});

test('an errand.done delivered twice opens one result turn and leaves one closing journal line', async () => {
  const memory = setUp();
  const stores = createErrandStores({
    config: () => CONFIG,
    journal: memory.journal,
    now: () => NOW,
    log: SILENT,
    memoryDb: memory.memoryDb,
  });
  const hot = { config: CONFIG, prompts: {} };
  const service = createErrandService({
    client: {},
    stores,
    hot,
    getGuildId: () => GUILD,
    log: SILENT,
    now: () => NOW,
  });
  const store = service.store(GUILD);
  assert.ok(store);
  const added = store.add(ASKED);
  const id = added.errand?.id ?? '';
  store.start(id);
  store.finish(id, DONE);
  await settle(store);
  const { fake, reads } = rig();
  fake.seedConversation(channel('c1'));
  let turns = 0;
  const errandTurns = createErrandTurns({
    hot,
    reads,
    iface: () => 'fake',
    turns: {
      runTurn: () => {
        turns += 1;
        return Promise.resolve({ outcome: 'spoke' });
      },
    },
    errands: service,
    getGuildId: () => GUILD,
    now: () => NOW,
    // A retry is never due here: the timer is a stand-in that never runs the retry.
    setTimer: () => setTimeout(() => {}, 0),
    log: SILENT,
  });
  const delivery = (): ReturnType<typeof errandDoneEvent> => {
    const errand = store.get(id);
    assert.ok(errand);
    return errandDoneEvent(errand, GUILD, () => NOW);
  };
  await errandTurns.onEvent(delivery());
  await errandTurns.onEvent(delivery());
  await settle(store);
  assert.equal(turns, 1);
  assert.equal(closingLines(memory.memoryDb, id), 1);
});

test('an errand her turn queued survives a stale errands.json unit flushed after it and reads back at the next turn', async () => {
  const rig = setUp();
  const added = rig.store.add({ ...ASKED, origin: { ...ASKED.origin, turnId: 'turn-9' }, idempotencyKey: 'turn-9:0' });
  const id = added.errand?.id ?? '';
  await settle(rig.store);
  // A write of the unit the store wrote before PR 6d, as an outbox or a memory-pending file of an older run sends it.
  await rig.memoryDb
    .writeUnit({ op: 'value', owner: `guilds/${GUILD}/errands.json`, value: { errands: [] } })
    .catch(() => null);
  const next = storeOver(rig.memoryDb);
  assert.deepEqual(
    next.open().map((errand) => errand.id),
    [id]
  );
});
