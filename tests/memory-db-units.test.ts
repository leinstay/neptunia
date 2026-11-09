// The memory units on the database (spec 2026-10-24-memory-authority, section 6 items 1, 2, 3 and 8): the store's
// cached units, the intention and task stores, the archive and the versions write the database (unit-write.js, through
// the outbox of unit-outbox.js), their reads never touch the disk, and a unit write that failed survives a restart
// through `memory-pending/`. A day of writes on a fixture whose memory files are gone and whose directories are
// read-only leaves no memory file and writes every kind of unit. Synthetic data only (Greek or accented Latin for
// non-ASCII); the ids are made up.
import { legacyServerPlaceId } from '../src/memory/migration/paths.ts';
import { accountOf, placeOfRoot, placeOfChat } from '../src/memory/addresses.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemoryDb } from '../src/memory/db/service.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { seedUnits } from './fixtures/memory-db/seed.ts';
import { isOperational } from '../src/memory/migration/paths.ts';
import { createAppendStore } from '../src/memory/append-store.ts';
import { createRecord } from '../src/memory/record.ts';
import { createJournal } from '../src/memory/journal.ts';
import { createArchive } from '../src/memory/archive.ts';
import { createStore } from '../src/memory/store.ts';
import { createIntentionStore } from '../src/intentions/store.ts';
import { createErrandStore } from '../src/errands/store.ts';
import { touchMemory } from '../src/memory/update.ts';
import { CHANNEL, GUILD, MEMBER, buildDataDir, fileFixtureErrand } from './fixtures/memory-db/datadir.ts';
import { createUnitOutbox } from '../src/memory/db/unit-outbox.ts';
import { unitValue } from '../src/memory/db/readers/common.ts';
import { dbOf, type Db } from '../src/memory/db/types.ts';
import {} from '../src/memory/db/ids.ts';
import { listUnits } from '../src/memory/db/storage-units.ts';
import { keyText, type StorageKey } from '../src/memory/db/storage-keys.ts';

type Service = ReturnType<typeof createMemoryDb>;
// The intentions of these tests carry only the fields the store writes, so each is read as the full shape by a cast.
type Intention = Parameters<ReturnType<typeof createIntentionStore>['add']>[0];
// The stores' profiles are untyped records; the tests read these fields.
type Profile = { id: string; affinity: { score: number } };
/** The value of a stored unit the test knows is there. */
const valueOf = (db: Db, owner: string) => (unitValue(db, owner) as { found: true; value: unknown }).value;
const quiet = { info() {}, debug() {}, warn() {}, error() {} };
const NOW = Date.parse('2026-11-03T12:00:00.000Z');
const DAY_MS = 86_400_000;
const DB_FILES = new Set(['memory.db', 'memory.db-wal', 'memory.db-shm', 'memory.db.lock']);

/** The status events and the outbox rows to `persona` of one task (its id given twice). */
const ROWS_OF_TASK = `SELECT (SELECT COUNT(*) FROM board_events WHERE task_id = ? AND type = 'status') AS events,
  (SELECT COUNT(*) FROM board_outbox WHERE task_id = ? AND to_whom = 'persona') AS ends`;

/** The status events of the errand task titled `the pier` on the board. */
const PIER_EVENTS = `SELECT e.seq FROM board_events e JOIN board_tasks t ON t.id = e.task_id
  WHERE t.lane = 'errand' AND t.title = 'the pier' AND e.type = 'status'`;

// The status events of the errand tasks titled `title` on the board, in order.
const errandEvents = (db: Db, title: string): Array<unknown> =>
  db
    .prepare(
      `SELECT e.new AS status FROM board_events e JOIN board_tasks t ON t.id = e.task_id
       WHERE t.lane = 'errand' AND t.title = ? AND e.type = 'status' ORDER BY e.seq`
    )
    .all(title)
    .map((row) => row.status);

const tmpRoot = (prefix = 'memdb-w2b-') => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), prefix));
const settle = async (rounds = 8) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};
const counter = (prefix: string) => {
  let n = 0;
  return () => `${prefix}-${(n += 1)}`;
};

function logs() {
  const out: Array<Record<string, unknown>> = [];
  const add = (level: string) => (message: string, fields?: object) => out.push({ level, message, ...fields });
  return { out, info: add('info'), warn: add('warn'), error: add('error'), debug: add('debug') };
}

/** The config of the modules: the record, the journal and the archive on, the diary channel known. */
const configOf = (memoryDb = {}) => ({
  features: { record: true, journal: true, archive: true },
  memoryDb: { session: { mode: 'off' }, ...memoryDb },
  selfreflection: { placeId: CHANNEL },
});

/**
 * The data directory with the fixture already in its database. `archived`: the fixture's errand is filed on the board
 * too; the unit writer itself skips the errand units.
 */
function prepared({ archived = false } = {}) {
  const root = tmpRoot();
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  buildDataDir(data);
  const handle = openMemoryDb(path.join(data, 'memory.db'));
  try {
    seedUnits(handle, data, { now: () => NOW - DAY_MS });
    if (archived) fileFixtureErrand(dbOf(handle));
  } finally {
    handle.close();
  }
  return { root, data };
}

/** The memory files of a data directory (every file but the database's own and the operational allowlist, src/memory/migration/paths.ts), relative. */
function memoryFiles(data: string, rel = '', out: Array<string> = []): Array<string> {
  for (const entry of fs.readdirSync(path.join(data, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) memoryFiles(data, child, out);
    else if (!DB_FILES.has(child) && !isOperational(child)) out.push(child);
  }
  return out;
}

/** The memory files taken away (so no read can find one) and every directory left read-only (so no write can land). */
function retireFiles(data: string) {
  for (const rel of memoryFiles(data)) fs.rmSync(path.join(data, rel));
  setDirs(data, 0o555);
}

/** Every directory under the guilds folder made read-only (0o555) or writable again (0o755). */
function setDirs(data: string, mode: number) {
  const walk = (dir: string) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      if (!entry.isDirectory()) continue;
      const abs = path.join(dir, entry.name);
      if (mode !== 0o555) fs.chmodSync(abs, mode);
      walk(abs);
      if (mode === 0o555) fs.chmodSync(abs, mode);
    }
  };
  walk(path.join(data, 'guilds'));
}

/** The modules of one run, over one data directory (`memoryDb`: a service of the test's own, else a new one). */
async function modules(
  data: string,
  {
    log = quiet,
    memoryDb = null,
  }: { log?: typeof quiet | ReturnType<typeof logs>; memoryDb?: Partial<Service> | null } = {}
) {
  const hot = { config: configOf() };
  // A test's own `memoryDb` is a fake with the members the stores call, so it stands in for the service by a cast.
  const service =
    (memoryDb as Service | null) ??
    createMemoryDb({ hot, dataDir: data, log, worker: false, now: () => NOW, defer: (fn) => setImmediate(fn) });
  // Root state loads eagerly from the database. Readiness precedes construction of its readers.
  if (!memoryDb) await service.open();
  const archiveStore = createAppendStore({ log: quiet, now: () => NOW });
  const record = createRecord({ dataDir: data, log: quiet, now: () => NOW, memoryDb: service });
  const journal = createJournal({ dataDir: data, now: () => NOW, uuid: counter('j'), log: quiet, memoryDb: service });
  const archive = createArchive({
    appendStore: archiveStore,
    dataDir: data,
    log,
    now: () => NOW,
    // @ts-expect-error the archive takes no uuid; the test passes one and the archive ignores it
    uuid: counter('a'),
    memoryDb: service,
  });
  const store = createStore({
    dataDir: data,
    newId: counter('id'),
    record,
    recordOn: () => true,
    archive,
    archiveOn: () => true,
    memoryDb: service,
  });
  const lazy: { intentions?: ReturnType<typeof createIntentionStore>; tasks?: ReturnType<typeof createErrandStore> } =
    {};
  const intentions = () =>
    (lazy.intentions ??= createIntentionStore({
      // @ts-expect-error the store takes no dataDir; the test passes one and the store ignores it
      dataDir: data,
      placeId: GUILD,
      now: () => NOW,
      log,
      memoryDb: service,
    }));
  const tasks = () =>
    (lazy.tasks ??= createErrandStore({
      // @ts-expect-error the store takes no dataDir; the test passes one and the store ignores it
      dataDir: data,
      placeId: GUILD,
      now: () => NOW,
      uuid: counter('task'),
      config: () => hot.config,
      journal,
      log,
      memoryDb: service,
    }));
  return {
    hot,
    service,
    record,
    journal,
    archive,
    store,
    intentions,
    tasks,
    close: async () => {
      await archiveStore.close();
      if (!memoryDb) await service.close();
    },
  };
}

/**
 * The scripted day: counters, a private touch, a decay tick, lore and learning ops, a channel touch, an intention added
 * and updated, a task added and finished.
 */
async function day(m: Awaited<ReturnType<typeof modules>>) {
  const at = (minutes: number) => NOW - 3_600_000 + minutes * 60_000;
  const message = (id: string, minutes: number) => ({
    id,
    authorId: MEMBER,
    authorName: 'Ada',
    ts: at(minutes),
    placeId: CHANNEL,
    channelName: 'γενικά',
    channelCategory: null,
    channelTopic: null,
    self: false,
    bot: false,
    content: 'Καλημέρα, café?',
    mentionedAccountIds: [],
  });
  for (const [id, minutes] of [
    ['600000000000000001', 0],
    ['600000000000000002', 1],
  ] as Array<[string, number]>)
    touchMemory(m.store, GUILD, message(id, minutes), {});
  m.store.touchPrivateSeen(accountOf(m.store, MEMBER), at(5));
  m.store.decayAffinities(NOW + 3 * DAY_MS, { decayPerDay: 0.04, decayPower: 1 });
  m.store.setLore(
    placeOfRoot(m.store, GUILD),
    [{ title: 'Η πλατεία', keys: ['πλατεία'], text: 'The square by the sea.' }],
    {
      source: 'owner',
      now: NOW,
    }
  );
  m.store.applyLearnedOps(
    placeOfRoot(m.store, GUILD),
    { add: ['the café opens at nine'] },
    {
      maxLearned: 20,
      maxLearnedStored: 60,
      learnedChars: 160,
      learnedHalfLifeDays: 720,
      confirmGapHours: 12,
      seenAt: NOW,
    }
  );
  m.store.touchChannel(placeOfChat(m.store, { id: CHANNEL }), { name: 'γενικά', topic: 'café' }, at(6), MEMBER, {});
  const intentions = m.intentions();
  const added = intentions.add({
    id: 'i2',
    purpose: 'ask about the café',
    status: 'pending',
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: NOW + DAY_MS,
    dueAt: null,
    provenance: { kind: 'self', turnId: 't-2', placeId: CHANNEL, scope: 'group' },
    history: [],
  } as unknown as Intention);
  if (!added.ok) throw new Error(`intention add: ${added.code}`);
  const moved = intentions.update('i2', (record) => ({
    ok: true,
    intention: { ...record, purpose: 'ask about the café terrace', updatedAt: NOW + 1 },
    changed: true,
  }));
  if (!moved.ok) throw new Error(`intention update: ${moved.code}`);
  const tasks = m.tasks();
  const task = tasks.add({
    agent: 'scout',
    goal: 'find the café hours',
    requester: { accountId: MEMBER, kind: 'member' },
    origin: { placeId: CHANNEL, messageId: '600000000000000001' },
    scope: 'group',
  });
  if (!task.ok) throw new Error(`task add: ${task.code}`);
  tasks.start(task.errand.id);
  tasks.finish(task.errand.id, {
    status: 'done',
    result: { text: 'nine to five', sources: [], files: [] },
    usage: { input: 1, output: 1, usd: 0, steps: 1, seconds: 1 },
  });
  await m.store.settleArchive();
  await m.store.flushSettled({});
  await m.intentions().flush();
  await m.tasks().flush();
  await settle();
}

test('outbox: a newer value replaces the waiting one, lines keep their order, a failed write goes back in front and is kept at the end', async () => {
  const written: Array<unknown> = [];
  let failing = true;
  const kept: Array<unknown> = [];
  const memoryDb = {
    async writeUnit(update: unknown) {
      if (failing) throw Object.assign(new Error('down'), { code: 'DB_CLOSED' });
      written.push(update);
      return {};
    },
    keepPending(update: unknown) {
      kept.push(update);
    },
  };
  const log = logs();
  const outbox = createUnitOutbox({ memoryDb, log, name: 'test' });
  outbox.value('guilds/g/a.json', { n: 1 });
  outbox.lines('guilds/g/t.jsonl', [{ n: 1 }]);
  assert.equal(await outbox.push(), 0);
  assert.equal(outbox.holds('guilds/g/a.json'), true);
  outbox.value('guilds/g/a.json', { n: 2 });
  outbox.lines('guilds/g/t.jsonl', [{ n: 2 }]);
  failing = false;
  assert.equal(await outbox.flush(), 0);
  assert.deepEqual(written, [
    { op: 'value', owner: 'guilds/g/a.json', value: { n: 2 } },
    { op: 'lines', owner: 'guilds/g/t.jsonl', lines: [{ n: 1 }, { n: 2 }] },
  ]);
  assert.equal(outbox.size(), 0);
  failing = true;
  outbox.value('guilds/g/a.json', { n: 3 });
  assert.equal(await outbox.flush(), 1);
  assert.equal(outbox.keep(), 1);
  assert.deepEqual(kept, [{ op: 'value', owner: 'guilds/g/a.json', value: { n: 3 } }]);
  assert.equal(outbox.size(), 0);
  assert.ok(
    log.out.some(
      (entry) =>
        entry.level === 'warn' && entry.message === 'memory db: unit write failed' && entry.code === 'DB_CLOSED'
    )
  );
  assert.ok(
    log.out.some(
      (entry) => entry.level === 'error' && entry.message === 'memory db: units kept pending' && entry.units === 1
    )
  );
});

test('a day of writes with the memory files gone writes every kind of unit to the database and no memory file', async () => {
  const db = prepared();
  retireFiles(db.data);
  const dbLog = logs();
  const dm = await modules(db.data, { log: dbLog });
  try {
    await dm.service.tick();
    assert.equal(dm.service.status().open, true);
    await day(dm);
    // The projection and the stems, by the writers' own job.
    for (let i = 0; i < 10; i += 1) {
      await dm.service.tick();
      await settle();
    }
    await dm.close();

    setDirs(db.data, 0o755);
    assert.deepEqual(memoryFiles(db.data), []);
    const failures = dbLog.out.filter(
      (entry) =>
        (entry.level === 'warn' || entry.level === 'error') &&
        /failed|refused|pending|lost/.test(entry.message as string)
    );
    assert.deepEqual(failures, []);

    const right = openMemoryDb(path.join(db.data, 'memory.db'), { readOnly: true });
    try {
      const count = (sql: string, ...params: Array<unknown>) =>
        dbOf(right)
          .prepare(sql)
          .get(...params)!.n as number;
      // PR 6d, errands on the board: the day's errand is a board task with its three moves, and the `work` archive
      // takes no write (it asserted the errands.jsonl lines in `work_events` before).
      assert.deepEqual(errandEvents(dbOf(right), 'find the café hours'), ['approved', 'in_progress', 'done']);
      assert.equal(count('SELECT COUNT(*) AS n FROM work') + count('SELECT COUNT(*) AS n FROM work_events'), 0);
      // Runtime ownership follows the catalog's semantic collection, including scope and active/archive selection.
      const units = listUnits(dbOf(right), {
        kind: 'intentions',
        subject: { type: 'persona', id: 'persona:local' },
        selector: { collection: 'active' },
      });
      assert.equal(units.length, 1);
      assert.equal(
        count(
          "SELECT COUNT(*) AS n FROM intentions WHERE owner_key = ? AND id LIKE '%i2%' AND retired_at IS NULL",
          units[0].id
        ),
        1
      );
      assert.ok(
        JSON.stringify(valueOf(dbOf(right), `guilds/${GUILD}/lore.json`)).includes('The square by the sea.'),
        'the lore'
      );
      assert.ok(
        JSON.stringify(valueOf(dbOf(right), `guilds/${GUILD}/guild.json`)).includes('the café opens at nine'),
        'the learned facts'
      );
    } finally {
      right.close();
    }
  } finally {
    setDirs(db.data, 0o755);
    fs.rmSync(db.root, { recursive: true, force: true });
  }
});

// Errands on the board: the fixture's errand reaches the store from its board task.
test('reads: the store, the intentions and the tasks load the database values with the memory files gone', async () => {
  const db = prepared({ archived: true });
  retireFiles(db.data);
  const dm = await modules(db.data);
  try {
    await dm.service.tick();
    assert.equal((dm.store.getUser(accountOf(dm.store, MEMBER)) as Profile | null)?.id, MEMBER);
    assert.ok(dm.store.getPlace(placeOfRoot(dm.store, GUILD)), 'the guild');
    assert.equal(dm.store.getChannel(placeOfChat(dm.store, { id: CHANNEL }))?.id, CHANNEL);
    assert.ok(dm.store.getLore(placeOfRoot(dm.store, GUILD)).length > 0, 'the lore');
    assert.deepEqual(dm.store.listPrivate(), [`discord:${MEMBER}`]);
    assert.equal(
      dm.store.getUser(accountOf(dm.store, '100000000000000077')),
      null,
      'a member the database does not hold is absent'
    );
    assert.ok(Array.isArray(dm.intentions().list()));
    assert.deepEqual(
      dm
        .tasks()
        .recent()
        .map((task: { id: string }) => task.id),
      ['t1']
    );
    assert.ok(!dm.store.validate().includes(`guilds/${GUILD}/voice.json`), 'a memory unit is never checked as a file');
    // A closed database is an error to the reader, never a file read.
    // Eager root-state construction refuses the same closed database before any reader is returned.
    await assert.rejects(
      () => modules(db.data, { memoryDb: { readHandle: () => null, database: () => null } }),
      (error: NodeJS.ErrnoException) => error.code === 'DB_CLOSED'
    );
  } finally {
    await dm.close();
    setDirs(db.data, 0o755);
    fs.rmSync(db.root, { recursive: true, force: true });
  }
});

test('a failed unit write survives a restart through memory-pending/ and is applied once', async () => {
  const { root, data } = prepared();
  retireFiles(data);
  const log = logs();
  const hot = { config: configOf() };
  const service = createMemoryDb({
    hot,
    dataDir: data,
    log,
    worker: false,
    now: () => NOW,
    defer: (fn) => setImmediate(fn),
  });
  const pendingDir = path.join(data, 'memory-pending');
  // PR 6d, errands on the board: the errand's write is op `errand` onto the board, so the refused write, its pending
  // file and its single replay are counted on the board's status events (they were errands.jsonl lines before).
  const moves = (handle: Parameters<typeof dbOf>[0]) => dbOf(handle).prepare(PIER_EVENTS).all().length;
  try {
    fs.chmodSync(data, 0o755);
    await service.tick();
    // The writer refuses every unit write of this process (a database that cannot take them).
    const down = {
      ...service,
      writeUnit: async (update: { op: string }) => {
        if (update.op === 'value' || update.op === 'lines' || update.op === 'errand')
          throw Object.assign(new Error('down'), { code: 'SQLITE_FULL' });
        return service.writeUnit(update);
      },
    };
    const m = await modules(data, { log, memoryDb: down });
    const before = moves(service.readHandle()!);
    m.store.setLore(placeOfRoot(m.store, GUILD), [{ title: 'Η αποβάθρα', keys: ['αποβάθρα'], text: 'The old pier.' }], {
      source: 'owner',
      now: NOW,
    });
    m.store.appendSelfreflectionPost(
      // @ts-expect-error a post without a picture is null, the shape the diary writes before one is drawn
      { at: NOW, kind: 'day', gist: 'une journée de pluie', picture: null, messageIds: [], search: null },
      { max: 150, now: NOW }
    );
    const task = m.tasks().add({
      agent: 'scout',
      goal: 'the pier',
      requester: { accountId: MEMBER, kind: 'member' },
      origin: { placeId: CHANNEL, messageId: null },
      scope: 'group',
    });
    assert.equal(task.ok, true);
    const settled = await m.store.flushSettled({ final: true });
    assert.equal(settled.pending, 2, 'the lore and the diary');
    assert.deepEqual(await m.tasks().flush({ final: true }), { waiting: 1, pending: 1 });
    await m.close();
    await service.close();
    assert.equal(fs.readdirSync(pendingDir).filter((name) => name.endsWith('.json')).length, 3);
    // Pending runtime writes retain semantic keys rather than legacy filenames.
    const place = legacyServerPlaceId('discord', GUILD);
    const loreKey: StorageKey = { kind: 'lore', subject: { type: 'place', id: place } };
    const lore = JSON.parse(
      fs.readFileSync(
        path.join(pendingDir, `${createHash('sha1').update(keyText(loreKey)).digest('hex')}.json`),
        'utf8'
      )
    );
    assert.deepEqual([lore.key, lore.op, typeof lore.at], [loreKey, 'value', 'string']);
    assert.ok(log.out.some((entry) => entry.level === 'error' && entry.message === 'memory db: units kept pending'));
    assert.deepEqual(memoryFiles(data), [], 'still no memory file');

    // The next start replays them before anything reads, and deletes each file once its write resolved.
    for (let start = 0; start < 2; start += 1) {
      const next = createMemoryDb({
        hot,
        dataDir: data,
        log,
        worker: false,
        now: () => NOW,
        defer: (fn) => setImmediate(fn),
      });
      try {
        await next.tick();
        assert.equal(next.status().open, true);
        assert.deepEqual(fs.readdirSync(pendingDir), []);
        const handle = next.readHandle()!;
        const value = valueOf(dbOf(handle), `guilds/${GUILD}/lore.json`);
        assert.ok(JSON.stringify(value).includes('The old pier.'));
        assert.ok(JSON.stringify(valueOf(dbOf(handle), `guilds/${GUILD}/diary.json`)).includes('une journée de pluie'));
        assert.equal(moves(handle), before + 1, 'the errand filed once');
      } finally {
        await next.close();
      }
    }
    assert.equal(log.out.filter((entry) => entry.message === 'memory db: pending replayed').length, 1);
  } finally {
    setDirs(data, 0o755);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// Stage AM of the master plan: a refused pending write no longer keeps the database closed. It moves to the
// quarantine with its code and the open goes on (tests/memory-pending-quarantine.test.ts holds the rest).
test('a pending write the writer refuses moves to the quarantine and the database opens', async () => {
  const { root, data } = prepared();
  const log = logs();
  const hot = { config: configOf() };
  const pendingDir = path.join(data, 'memory-pending');
  const name = `${'0'.repeat(40)}.json`;
  fs.mkdirSync(pendingDir);
  fs.writeFileSync(
    path.join(pendingDir, name),
    JSON.stringify({ owner: `guilds/${GUILD}/nothing.json`, op: 'value', value: {}, at: '2026-11-03T12:00:00.000Z' })
  );
  const service = createMemoryDb({
    hot,
    dataDir: data,
    log,
    worker: false,
    now: () => NOW,
    defer: (fn) => setImmediate(fn),
  });
  try {
    await service.tick();
    assert.equal(service.status().open, true);
    assert.deepEqual(fs.readdirSync(pendingDir), []);
    assert.ok(fs.existsSync(path.join(data, 'memory-pending-quarantine', name)));
    assert.ok(
      log.out.some(
        (entry) =>
          entry.level === 'error' &&
          entry.message === 'memory db: pending quarantined' &&
          entry.count === 1 &&
          entry.code === 'UNIT_UNMAPPED'
      )
    );
    assert.equal(
      log.out.some((entry) => entry.message === 'memory db: open failed'),
      false
    );
  } finally {
    await service.close();
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('a task transition or an intention whose write committed and whose answer was lost is retried as a no-op', async () => {
  const { root, data } = prepared();
  retireFiles(data);
  const hot = { config: configOf() };
  const service = createMemoryDb({
    hot,
    dataDir: data,
    log: quiet,
    worker: false,
    now: () => NOW,
    defer: (fn) => setImmediate(fn),
  });
  try {
    fs.chmodSync(data, 0o755);
    await service.tick();
    // The writer commits every unit write, then the first `lost` answers of the kind asked for are lost (a dead worker).
    let lost = 0;
    let lostOp: ((update: { op: string }) => boolean) | null = null;
    const flaky = {
      ...service,
      writeUnit: async (update: { op: string }) => {
        const done = await service.writeUnit(update);
        if (lost > 0 && (lostOp === null || lostOp(update))) {
          lost -= 1;
          throw Object.assign(new Error('the answer was lost'), { code: 'WORKER_EXIT' });
        }
        return done;
      },
    };
    const m = await modules(data, { memoryDb: flaky });
    const db = () => dbOf(service.readHandle()!);
    // PR 6d, errands on the board: the transitions are the task's status events and its end the outbox row to
    // `persona`, written by op `errand` (they were `work_events` lines of op `lines` before).
    const rows = (id: unknown) => db().prepare(ROWS_OF_TASK).get(String(id), String(id));
    const transitions = (id: unknown) => rows(id)?.events;
    const ends = (id: unknown) => rows(id)?.ends;
    const run = async (lose: number) => {
      lost = lose;
      lostOp = (update: { op: string }) => update.op === 'errand';
      const tasks = m.tasks();
      const added = tasks.add({
        agent: 'scout',
        goal: 'the pier',
        requester: { accountId: MEMBER, kind: 'member' },
        origin: { placeId: CHANNEL, messageId: null },
        scope: 'group',
      });
      await settle();
      tasks.start(added.errand!.id);
      await settle();
      tasks.finish(added.errand!.id, {
        status: 'done',
        result: { text: 'found', sources: [], files: [] },
        usage: { input: 0, output: 0, usd: 0, steps: 1, seconds: 1 },
      });
      // Retried until nothing waits (each retry sends the same lines again).
      for (let round = 0; round < 6 && (await tasks.flush()).waiting > 0; round += 1) await settle();
      return added.errand!.id;
    };
    const control = await run(0);
    const faulted = await run(3);
    assert.equal(lost, 0, 'every lost answer was hit');
    assert.equal(transitions(control), 3, 'added, started, done');
    assert.equal(transitions(faulted), 3, 'the retried transitions are not written twice');
    assert.equal(ends(control), 1);
    assert.equal(ends(faulted), 1, 'the retried end is not announced twice');
    assert.equal(m.tasks().get(faulted)!.state, 'done');
    // The same check for an intention: its value and its archive line retried after a lost answer stay one row each.
    lost = 2;
    lostOp = null;
    const intentions = m.intentions();
    const record = {
      id: 'intent-retry',
      purpose: 'ask about the pier',
      status: 'pending',
      createdAt: NOW,
      updatedAt: NOW,
      expiresAt: NOW + DAY_MS,
      dueAt: null,
      provenance: { kind: 'self', turnId: 't-1', placeId: null, scope: 'group' },
      history: [],
    };
    assert.equal(intentions.add(record as unknown as Intention).ok, true);
    await settle();
    for (let round = 0; round < 6 && (await intentions.flush()).waiting > 0; round += 1) await settle();
    assert.equal(lost, 0);
    assert.equal(
      db().prepare("SELECT COUNT(*) AS n FROM intentions WHERE id = 'intent-retry' AND retired_at IS NULL").get()!.n,
      1
    );
    assert.equal(intentions.list().filter((entry: { id: string }) => entry.id === 'intent-retry').length, 1);
    await m.close();
  } finally {
    await service.close();
    setDirs(data, 0o755);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("her session's attitude move reaches the store's cached profile: a later flush never writes the older score over it", async () => {
  const { root, data } = prepared();
  retireFiles(data);
  const hot = { config: configOf() };
  const service = createMemoryDb({
    hot,
    dataDir: data,
    log: quiet,
    worker: false,
    now: () => NOW,
    defer: (fn) => setImmediate(fn),
  });
  try {
    fs.chmodSync(data, 0o755);
    await service.tick();
    await service.tick();
    const m = await modules(data, { memoryDb: service });
    const db = () => dbOf(service.readHandle()!);
    const person = `person:discord:${MEMBER}`;
    const stored = () => db().prepare('SELECT affinity FROM people WHERE id = ?').get(person)!.affinity;
    const source = db()
      .prepare("SELECT id FROM sources WHERE kind = 'seen' AND retired_at IS NULL ORDER BY rowid LIMIT 1")
      .get()!.id;
    let runs = 0;
    const move = (delta: number) => {
      runs += 1;
      const id = `run-move-${runs}`;
      return service.memoryWrite({
        kind: 'session',
        mode: 'apply',
        now: NOW,
        run: {
          id,
          sweepId: `sweep-${id}`,
          scopeKey: 'group:discord',
          scope: { scope_kind: 'group', scope_iface: 'discord', scope_dm: null },
          batchKey: `apply|${id}`,
          startedAt: new Date(NOW).toISOString(),
          finishedAt: new Date(NOW).toISOString(),
          outcome: 'ok',
          counts: {},
          errors: [],
        },
        plan: {
          claims: [],
          episodes: [],
          affinity: [{ personId: person, delta, reason: 'una charla amable', sources: [source] }],
          descriptions: [],
          people: [],
        },
      });
    };
    // A clean cached profile: the store reads the moved score.
    const start = (m.store.getUser(accountOf(m.store, MEMBER)) as Profile).affinity.score;
    await move(2);
    assert.equal(stored(), Math.round((start + 2) * 100) / 100);
    assert.equal(
      (m.store.getUser(accountOf(m.store, MEMBER)) as Profile).affinity.score,
      stored(),
      'the cached profile took the move'
    );
    // A profile changed in the cache at the same time (a decay tick stamps it): both count after the flush.
    const decayed = m.store.decayAffinities(NOW, { decayPerDay: 0.5, decayPower: 1 });
    assert.ok(decayed.profiles > 0);
    const cached = (m.store.getUser(accountOf(m.store, MEMBER)) as Profile).affinity;
    await move(3);
    m.store.flush();
    await m.store.flushSettled({});
    const expected = Math.round(Math.max(-100, Math.min(100, cached.score + 3)) * 100) / 100;
    assert.equal(stored(), expected, 'the move survives the flush of the decayed profile');
    assert.equal((m.store.getUser(accountOf(m.store, MEMBER)) as Profile).affinity.score, expected);
    assert.equal(
      db()
        .prepare("SELECT COUNT(*) AS n FROM affinity_events WHERE person_id = ? AND reason = 'una charla amable'")
        .get(person)!.n,
      2
    );
    await m.close();
  } finally {
    await service.close();
    setDirs(data, 0o755);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('root state and participation, GIF and media caches persist through the writer without legacy JSON', async () => {
  const fixture = prepared();
  const files = ['state.json', ...['participation', 'gifs', 'media'].map((name) => `guilds/${GUILD}/${name}.json`)].map(
    (file) => path.join(fixture.data, file)
  );
  for (const file of files) fs.rmSync(file, { force: true });
  let run = await modules(fixture.data);
  try {
    await run.service.tick();
    run.store.state.data.paused = true;
    run.store.state.markDirty();
    run.store.setParticipation(
      placeOfRoot(run.store, GUILD),
      {
        nextId: 10,
        episodes: [
          {
            itemId: 'pt-roundtrip',
            id: 'p-roundtrip',
            placeId: CHANNEL,
            startAt: NOW,
            lastAt: NOW,
            lastOwnAt: NOW,
            continues: null,
            messages: [{ id: 'native-roundtrip', ts: NOW, self: true, text: 'café' }],
          },
        ],
      },
      { now: NOW }
    );
    run.store.getMediaCache(placeOfRoot(run.store, GUILD)).photo = { text: 'a café terrace', ts: NOW };
    run.store.markMediaCacheDirty(placeOfRoot(run.store, GUILD));
    assert.equal(
      run.store.recordGifs(placeOfRoot(run.store, GUILD), [
        {
          id: 'native-gif',
          placeId: CHANNEL,
          ts: NOW,
          self: false,
          bot: false,
          links: [{ id: 'gif-key', kind: 'gif', site: 'Tenor', url: 'https://tenor.com/view/cat-dance-123' }],
          attachments: [],
        },
      ]),
      1
    );
    const participation = run.store.getParticipation(placeOfRoot(run.store, GUILD));
    const gifs = structuredClone(run.store.getGifs());
    await run.store.flushSettled({ final: true });
    assert.deepEqual(
      files.filter((file) => fs.existsSync(file)),
      []
    );
    run.store.state.data.paused = false;
    run.store.reloadState();
    assert.equal(run.store.state.data.paused, true);
    run.store.state.data.afterReload = 'persisted after reload';
    run.store.state.markDirty();
    await run.store.flushSettled({ final: true });
    await run.close();
    run = await modules(fixture.data);
    await run.service.tick();
    assert.equal(run.store.state.data.paused, true);
    assert.equal(run.store.state.data.afterReload, 'persisted after reload');
    assert.deepEqual(run.store.getParticipation(placeOfRoot(run.store, GUILD)), participation);
    assert.deepEqual(run.store.getGifs(), gifs);
    assert.deepEqual(run.store.getMediaCache(placeOfRoot(run.store, GUILD)).photo, {
      text: 'a café terrace',
      ts: NOW,
    });
    assert.deepEqual(
      files.filter((file) => fs.existsSync(file)),
      []
    );
  } finally {
    await run.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});
