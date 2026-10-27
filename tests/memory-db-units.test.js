// The memory units on the database (spec 2026-10-24-memory-authority, section 6 items 1, 2, 3 and 8): the store's
// cached units, the intention and task stores, the archive and the versions write the database (unit-write.js, through
// the outbox of unit-outbox.js), their reads never touch the disk, and a unit write that failed survives a restart
// through `memory-pending/`. A day of writes on a fixture whose memory files are gone and whose directories are
// read-only leaves no memory file and writes every kind of unit. Synthetic data only (Greek or accented Latin for
// non-ASCII); the ids are made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemoryDb } from '../src/memory/db/service.js';
import { openMemoryDb } from '../src/memory/db/open.js';
import { seedUnits } from './fixtures/memory-db/seed.js';
import { isOperational } from '../src/memory/db/paths.js';
import { createAppendStore } from '../src/memory/append-store.js';
import { createRecord } from '../src/memory/record.js';
import { createJournal } from '../src/memory/journal.js';
import { createArchive } from '../src/memory/archive.js';
import { createStore } from '../src/memory/store.js';
import { createIntentionStore } from '../src/intentions/store.js';
import { createTaskStore } from '../src/errands/store.js';
import { touchMemory } from '../src/memory/update.js';
import { CHANNEL, GUILD, MEMBER, buildDataDir } from './fixtures/memory-db/datadir.js';
import { createUnitOutbox } from '../src/memory/db/unit-outbox.js';
import { unitValue } from '../src/memory/db/readers/common.js';

const quiet = { info() {}, debug() {}, warn() {}, error() {} };
const NOW = Date.parse('2026-11-03T12:00:00.000Z');
const DAY_MS = 86_400_000;
const DB_FILES = new Set(['memory.db', 'memory.db-wal', 'memory.db-shm', 'memory.db.lock']);

const tmpRoot = (prefix = 'memdb-w2b-') => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), prefix));
const settle = async (rounds = 8) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};
const counter = (prefix) => {
  let n = 0;
  return () => `${prefix}-${(n += 1)}`;
};

function logs() {
  const out = [];
  const add = (level) => (message, fields) => out.push({ level, message, ...fields });
  return { out, info: add('info'), warn: add('warn'), error: add('error'), debug: add('debug') };
}

/** The config of the modules: the record, the journal and the archive on, the diary channel known. */
const configOf = (memoryDb = {}) => ({
  features: { record: true, journal: true, archive: true },
  memoryDb: { session: { mode: 'off' }, ...memoryDb },
  diary: { channelId: CHANNEL },
});

/** The data directory with the fixture already in its database. */
function prepared() {
  const root = tmpRoot();
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  buildDataDir(data);
  const handle = openMemoryDb(path.join(data, 'memory.db'));
  try {
    seedUnits(handle, data, { now: () => NOW - DAY_MS });
  } finally {
    handle.close();
  }
  return { root, data };
}

/** The memory files of a data directory (every file but the database's own and the operational allowlist, src/memory/db/paths.js), relative. */
function memoryFiles(data, rel = '', out = []) {
  for (const entry of fs.readdirSync(path.join(data, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) memoryFiles(data, child, out);
    else if (!DB_FILES.has(child) && !isOperational(child)) out.push(child);
  }
  return out;
}

/** The memory files taken away (so no read can find one) and every directory left read-only (so no write can land). */
function retireFiles(data) {
  for (const rel of memoryFiles(data)) fs.rmSync(path.join(data, rel));
  setDirs(data, 0o555);
}

/** Every directory under the guilds folder made read-only (0o555) or writable again (0o755). */
function setDirs(data, mode) {
  const walk = (dir) => {
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
function modules(data, { log = quiet, memoryDb = null } = {}) {
  const hot = { config: configOf() };
  const service =
    memoryDb ??
    createMemoryDb({ hot, dataDir: data, log, worker: false, now: () => NOW, defer: (fn) => setImmediate(fn) });
  const archiveStore = createAppendStore({ log: quiet, now: () => NOW });
  const record = createRecord({ dataDir: data, log: quiet, now: () => NOW, memoryDb: service });
  const journal = createJournal({ dataDir: data, now: () => NOW, uuid: counter('j'), log: quiet, memoryDb: service });
  const archive = createArchive({
    appendStore: archiveStore,
    dataDir: data,
    log,
    now: () => NOW,
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
  const lazy = {};
  const intentions = () =>
    (lazy.intentions ??= createIntentionStore({
      dataDir: data,
      guildId: GUILD,
      now: () => NOW,
      log,
      memoryDb: service,
    }));
  const tasks = () =>
    (lazy.tasks ??= createTaskStore({
      dataDir: data,
      guildId: GUILD,
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
async function day(m) {
  const at = (minutes) => NOW - 3_600_000 + minutes * 60_000;
  const message = (id, minutes) => ({
    id,
    authorId: MEMBER,
    authorName: 'Ada',
    ts: at(minutes),
    channelId: CHANNEL,
    channelName: 'γενικά',
    channelCategory: null,
    channelTopic: null,
    self: false,
    bot: false,
    content: 'Καλημέρα, café?',
    mentionedUserIds: [],
  });
  for (const [id, minutes] of [
    ['600000000000000001', 0],
    ['600000000000000002', 1],
  ])
    touchMemory(m.store, GUILD, message(id, minutes), {});
  m.store.touchPrivateSeen(GUILD, MEMBER, at(5));
  m.store.decayAffinities(GUILD, NOW + 3 * DAY_MS, { decayPerDay: 0.04, decayPower: 1 });
  m.store.setLore(GUILD, [{ title: 'Η πλατεία', keys: ['πλατεία'], text: 'The square by the sea.' }], {
    source: 'owner',
    now: NOW,
  });
  m.store.applyLearnedOps(
    GUILD,
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
  m.store.touchChannel(GUILD, CHANNEL, { name: 'γενικά', category: null, topic: 'café' }, at(6), MEMBER, {});
  const intentions = m.intentions();
  const added = intentions.add({
    id: 'i2',
    purpose: 'ask about the café',
    status: 'pending',
    createdAt: NOW,
    updatedAt: NOW,
    expiresAt: NOW + DAY_MS,
    dueAt: null,
    provenance: { kind: 'self', turnId: 't-2', channelId: CHANNEL, scope: 'group' },
    history: [],
  });
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
    requester: { userId: MEMBER, kind: 'member' },
    origin: { channelId: CHANNEL, messageId: '600000000000000001' },
    scope: 'group',
  });
  if (!task.ok) throw new Error(`task add: ${task.code}`);
  tasks.start(task.task.id);
  tasks.finish(task.task.id, {
    status: 'done',
    result: { text: 'nine to five', sources: [], files: [] },
    usage: { input: 1, output: 1, usd: 0, steps: 1, seconds: 1 },
  });
  await m.store.settleArchive(GUILD);
  await m.store.flushSettled({});
  await m.intentions().flush();
  await m.tasks().flush();
  await settle();
}

test('outbox: a newer value replaces the waiting one, lines keep their order, a failed write goes back in front and is kept at the end', async () => {
  const written = [];
  let failing = true;
  const kept = [];
  const memoryDb = {
    async writeUnit(update) {
      if (failing) throw Object.assign(new Error('down'), { code: 'DB_CLOSED' });
      written.push(update);
      return {};
    },
    keepPending(update) {
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
  const dm = modules(db.data, { log: dbLog });
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
        (entry.level === 'warn' || entry.level === 'error') && /failed|refused|pending|lost/.test(entry.message)
    );
    assert.deepEqual(failures, []);

    const right = openMemoryDb(path.join(db.data, 'memory.db'), { readOnly: true });
    try {
      const count = (sql, ...params) => right.db.prepare(sql).get(...params).n;
      assert.equal(
        count(
          'SELECT COUNT(*) AS n FROM work_events WHERE owner_file = ? AND retired_at IS NULL',
          `guilds/${GUILD}/errands.jsonl`
        ),
        4
      );
      assert.equal(
        count(
          "SELECT COUNT(*) AS n FROM intentions WHERE owner_file = ? AND id LIKE '%i2%' AND retired_at IS NULL",
          `guilds/${GUILD}/intentions.json`
        ),
        1
      );
      assert.ok(
        JSON.stringify(unitValue(right.db, `guilds/${GUILD}/lore.json`).value).includes('The square by the sea.'),
        'the lore'
      );
      assert.ok(
        JSON.stringify(unitValue(right.db, `guilds/${GUILD}/guild.json`).value).includes('the café opens at nine'),
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

test('reads: the store, the intentions and the tasks load the database values with the memory files gone', async () => {
  const db = prepared();
  retireFiles(db.data);
  const dm = modules(db.data);
  try {
    await dm.service.tick();
    assert.equal(dm.store.getUser(GUILD, MEMBER)?.id, MEMBER);
    assert.ok(dm.store.getGuild(GUILD), 'the guild');
    assert.equal(dm.store.getChannel(GUILD, CHANNEL)?.id, CHANNEL);
    assert.ok(dm.store.getLore(GUILD).length > 0, 'the lore');
    assert.deepEqual(dm.store.listPrivate(GUILD), [MEMBER]);
    assert.equal(dm.store.getUser(GUILD, '100000000000000077'), null, 'a member the database does not hold is absent');
    assert.ok(Array.isArray(dm.intentions().list()));
    assert.deepEqual(
      dm
        .tasks()
        .recent()
        .map((task) => task.id),
      ['t1']
    );
    assert.ok(!dm.store.validate().includes(`guilds/${GUILD}/voice.json`), 'a memory unit is never checked as a file');
    // A closed database is an error to the reader, never a file read.
    const closed = modules(db.data, { memoryDb: { readHandle: () => null, database: () => null } });
    assert.throws(
      () => closed.store.getGuild(GUILD),
      (error) => error.code === 'DB_CLOSED'
    );
    await closed.close();
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
  const lineCount = (handle) =>
    handle.db
      .prepare('SELECT COUNT(*) AS n FROM work_events WHERE owner_file = ? AND retired_at IS NULL')
      .get(`guilds/${GUILD}/errands.jsonl`).n;
  try {
    fs.chmodSync(data, 0o755);
    await service.tick();
    // The writer refuses every unit write of this process (a database that cannot take them).
    const down = {
      ...service,
      writeUnit: async (update) => {
        if (update.op === 'value' || update.op === 'lines')
          throw Object.assign(new Error('down'), { code: 'SQLITE_FULL' });
        return service.writeUnit(update);
      },
    };
    const m = modules(data, { log, memoryDb: down });
    const before = lineCount(service.readHandle());
    m.store.setLore(GUILD, [{ title: 'Η αποβάθρα', keys: ['αποβάθρα'], text: 'The old pier.' }], {
      source: 'owner',
      now: NOW,
    });
    m.store.appendDiaryPost(
      GUILD,
      { at: NOW, kind: 'day', gist: 'une journée de pluie', picture: null, messageIds: [], search: null },
      { max: 150, now: NOW }
    );
    const task = m.tasks().add({
      agent: 'scout',
      goal: 'the pier',
      requester: { userId: MEMBER, kind: 'member' },
      origin: { channelId: CHANNEL, messageId: null },
      scope: 'group',
    });
    assert.equal(task.ok, true);
    const settled = await m.store.flushSettled({ final: true });
    assert.equal(settled.pending, 2, 'the lore and the diary');
    assert.deepEqual(await m.tasks().flush({ final: true }), { waiting: 2, pending: 2 });
    await m.close();
    await service.close();
    assert.equal(fs.readdirSync(pendingDir).filter((name) => name.endsWith('.json')).length, 4);
    const lore = JSON.parse(
      fs.readFileSync(
        path.join(pendingDir, `${createHash('sha1').update(`guilds/${GUILD}/lore.json`).digest('hex')}.json`),
        'utf8'
      )
    );
    assert.deepEqual([lore.owner, lore.op, typeof lore.at], [`guilds/${GUILD}/lore.json`, 'value', 'string']);
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
        const handle = next.readHandle();
        const value = unitValue(handle.db, `guilds/${GUILD}/lore.json`).value;
        assert.ok(JSON.stringify(value).includes('The old pier.'));
        assert.ok(
          JSON.stringify(unitValue(handle.db, `guilds/${GUILD}/diary.json`).value).includes('une journée de pluie')
        );
        assert.equal(lineCount(handle), before + 1, 'the transition line applied once');
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

test('a pending write the writer refuses keeps its file and the database closed', async () => {
  const { root, data } = prepared();
  const log = logs();
  const hot = { config: configOf() };
  const pendingDir = path.join(data, 'memory-pending');
  fs.mkdirSync(pendingDir);
  fs.writeFileSync(
    path.join(pendingDir, `${'0'.repeat(40)}.json`),
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
    assert.equal(service.status().open, false);
    assert.equal(service.readHandle(), null);
    assert.equal(fs.readdirSync(pendingDir).length, 1);
    assert.ok(
      log.out.some(
        (entry) =>
          entry.level === 'error' &&
          entry.message === 'memory db: pending replay failed' &&
          entry.count === 1 &&
          entry.code === 'UNIT_UNMAPPED'
      )
    );
    assert.ok(log.out.some((entry) => entry.message === 'memory db: open failed' && entry.code === 'PENDING_REPLAY'));
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
    let lostOp = null;
    const flaky = {
      ...service,
      writeUnit: async (update) => {
        const done = await service.writeUnit(update);
        if (lost > 0 && (lostOp === null || lostOp(update))) {
          lost -= 1;
          throw Object.assign(new Error('the answer was lost'), { code: 'WORKER_EXIT' });
        }
        return done;
      },
    };
    const m = modules(data, { memoryDb: flaky });
    const db = () => service.readHandle().db;
    const transitions = (id) =>
      db().prepare('SELECT COUNT(*) AS n FROM work_events WHERE work_id = ? AND retired_at IS NULL').get(id).n;
    const run = async (lose) => {
      lost = lose;
      lostOp = (update) => update.op === 'lines';
      const tasks = m.tasks();
      const added = tasks.add({
        agent: 'scout',
        goal: 'the pier',
        requester: { userId: MEMBER, kind: 'member' },
        origin: { channelId: CHANNEL, messageId: null },
        scope: 'group',
      });
      await settle();
      tasks.start(added.task.id);
      await settle();
      tasks.finish(added.task.id, {
        status: 'done',
        result: { text: 'found', sources: [], files: [] },
        usage: { input: 0, output: 0, usd: 0, steps: 1, seconds: 1 },
      });
      // Retried until nothing waits (each retry sends the same lines again).
      for (let round = 0; round < 6 && (await tasks.flush()).waiting > 0; round += 1) await settle();
      return added.task.id;
    };
    const control = await run(0);
    const faulted = await run(3);
    assert.equal(lost, 0, 'every lost answer was hit');
    assert.equal(transitions(control), 3, 'added, started, done');
    assert.equal(transitions(faulted), 3, 'the retried transitions are not written twice');
    assert.equal(m.tasks().get(faulted).state, 'done');
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
      provenance: { kind: 'self', turnId: 't-1', channelId: null, scope: 'group' },
      history: [],
    };
    assert.equal(intentions.add(record).ok, true);
    await settle();
    for (let round = 0; round < 6 && (await intentions.flush()).waiting > 0; round += 1) await settle();
    assert.equal(lost, 0);
    assert.equal(
      db().prepare("SELECT COUNT(*) AS n FROM intentions WHERE id = 'intent-retry' AND retired_at IS NULL").get().n,
      1
    );
    assert.equal(intentions.list().filter((entry) => entry.id === 'intent-retry').length, 1);
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
    const m = modules(data, { memoryDb: service });
    const db = () => service.readHandle().db;
    const person = `person:discord:${MEMBER}`;
    const stored = () => db().prepare('SELECT affinity FROM people WHERE id = ?').get(person).affinity;
    const source = db()
      .prepare("SELECT id FROM sources WHERE kind = 'seen' AND retired_at IS NULL ORDER BY rowid LIMIT 1")
      .get().id;
    let runs = 0;
    const move = (delta) => {
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
    const start = m.store.getUser(GUILD, MEMBER).affinity.score;
    await move(2);
    assert.equal(stored(), Math.round((start + 2) * 100) / 100);
    assert.equal(m.store.getUser(GUILD, MEMBER).affinity.score, stored(), 'the cached profile took the move');
    // A profile changed in the cache at the same time (a decay tick stamps it): both count after the flush.
    const decayed = m.store.decayAffinities(GUILD, NOW, { decayPerDay: 0.5, decayPower: 1 });
    assert.ok(decayed.profiles > 0);
    const cached = m.store.getUser(GUILD, MEMBER).affinity;
    await move(3);
    m.store.flush();
    await m.store.flushSettled({});
    const expected = Math.round(Math.max(-100, Math.min(100, cached.score + 3)) * 100) / 100;
    assert.equal(stored(), expected, 'the move survives the flush of the decayed profile');
    assert.equal(m.store.getUser(GUILD, MEMBER).affinity.score, expected);
    assert.equal(
      db()
        .prepare("SELECT COUNT(*) AS n FROM affinity_events WHERE person_id = ? AND reason = 'una charla amable'")
        .get(person).n,
      2
    );
    await m.close();
  } finally {
    await service.close();
    setDirs(data, 0o755);
    fs.rmSync(root, { recursive: true, force: true });
  }
});
