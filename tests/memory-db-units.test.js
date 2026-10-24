// Stage W2b of the memory writer switch (spec 2026-10-24-memory-authority, section 6 items 1, 2, 3 and 8): under
// authority `db` the store's cached units, the intention and task stores, the archive and the versions write the
// database (unit-write.js, through the outbox of unit-outbox.js), their reads never fall back to the disk, and a unit
// write that failed survives a restart through `memory-pending/`. The writer parity: a scripted day under `db` on a
// fixture whose memory files are gone and whose directories are read-only, against the same day under `json` followed
// by a sync, compared table by table as canonical rows (the sources' rowid and the full-text indexes, which follow the
// order rows were inserted in, the files' signatures, the meta keys and the derived month indexes left out). Synthetic
// data only (Greek or accented Latin for non-ASCII); the ids are made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemoryDb } from '../src/memory/db/service.js';
import { openMemoryDb } from '../src/memory/db/open.js';
import { syncOnce } from '../src/memory/db/sync.js';
import { operationalJsonPath } from '../src/memory/store.js';
import { createAppendStore } from '../src/memory/append-store.js';
import { createRecord } from '../src/memory/record.js';
import { createJournal } from '../src/memory/journal.js';
import { createArchive } from '../src/memory/archive.js';
import { createStore } from '../src/memory/store.js';
import { createIntentionStore } from '../src/intentions/store.js';
import { createTaskStore } from '../src/errands/store.js';
import { applyMemoryUpdate, applyPrivateUpdate, touchMemory } from '../src/memory/update.js';
import { CHANNEL, GUILD, MEMBER, buildDataDir } from './fixtures/memory-db/datadir.js';
import { createUnitOutbox } from '../src/memory/db/unit-outbox.js';
import { authorityRefusal } from '../src/memory/db/authority.js';
import { unitValue } from '../src/memory/db/readers/common.js';
import { main as memoryDbTool } from '../tools/memory-db.mjs';

const quiet = { info() {}, debug() {}, warn() {}, error() {} };
const NOW = Date.parse('2026-11-03T12:00:00.000Z');
const DAY_MS = 86_400_000;
const DB_FILES = new Set(['memory.db', 'memory.db-wal', 'memory.db-shm', 'memory.db.lock']);

const tmpRoot = (prefix = 'memdb-w2b-') => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), prefix));
const settle = async (rounds = 8) => { for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve)); };
const counter = (prefix) => { let n = 0; return () => `${prefix}-${(n += 1)}`; };

function logs() {
  const out = [];
  const add = (level) => (message, fields) => out.push({ level, message, ...fields });
  return { out, info: add('info'), warn: add('warn'), error: add('error'), debug: add('debug') };
}

/** A full db-authority config (every start check met), or json. */
const configOf = (authority, memoryDb = {}) => ({
  features: { memoryDb: true, record: true, journal: true, archive: true },
  memoryDb: { authority, read: true, observeLive: true, syncSeconds: 60, ...memoryDb },
  recall: { backend: 'db' },
  diary: { channelId: CHANNEL },
});

/** The data directory with the fixture already in a database (the life under `json` before the day). */
function prepared() {
  const root = tmpRoot();
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  buildDataDir(data);
  const handle = openMemoryDb(path.join(data, 'memory.db'));
  try {
    syncOnce(handle, data, { now: () => NOW - DAY_MS });
    handle.db.prepare("INSERT INTO meta (key, value) VALUES ('service_import_done', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  } finally { handle.close(); }
  return { root, data };
}

/** The memory files of a data directory (every file but the database's own and the operational allowlist), relative. */
function memoryFiles(data, rel = '', out = []) {
  for (const entry of fs.readdirSync(path.join(data, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) memoryFiles(data, child, out);
    else if (!DB_FILES.has(child) && !operationalJsonPath(child) && !/recall-trace\.jsonl$/.test(child) && !/archive\/pending[^/]*\.jsonl$/.test(child)) out.push(child);
  }
  return out;
}

/** Under `db`: the memory files taken away (so no read can find one) and every directory left read-only (so no write can land). */
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

/** The modules of one run, over one data directory, under one authority. */
function modules(data, authority, { log = quiet, memoryDb = null } = {}) {
  const hot = { config: configOf(authority, authority === 'json' ? { observeLive: false } : {}) };
  const service = memoryDb ?? createMemoryDb({ hot, dataDir: data, log, worker: false, now: () => NOW, defer: (fn) => setImmediate(fn) });
  const recordStore = createAppendStore({ log: quiet, now: () => NOW });
  const journalStore = createAppendStore({ log: quiet, now: () => NOW });
  const archiveStore = createAppendStore({ log: quiet, now: () => NOW });
  const record = createRecord({ appendStore: recordStore, dataDir: data, log: quiet, now: () => NOW, memoryDb: service });
  const journal = createJournal({ appendStore: journalStore, dataDir: data, now: () => NOW, uuid: counter('j'), log: quiet, memoryDb: service });
  const archive = createArchive({ appendStore: archiveStore, dataDir: data, log, now: () => NOW, uuid: counter('a'), memoryDb: service });
  const store = createStore({ dataDir: data, newId: counter('id'), record, recordOn: () => true, archive, archiveOn: () => true, memoryRead: service.reader, memoryDb: service });
  const lazy = {};
  const intentions = () => (lazy.intentions ??= createIntentionStore({ dataDir: data, guildId: GUILD, now: () => NOW, log, memoryDb: service }));
  const tasks = () => (lazy.tasks ??= createTaskStore({ dataDir: data, guildId: GUILD, now: () => NOW, uuid: counter('task'), config: () => hot.config, journal, log, memoryDb: service }));
  return {
    hot, service, record, journal, archive, store, intentions, tasks,
    close: async () => {
      await Promise.all([recordStore.close(), journalStore.close(), archiveStore.close()]);
      if (!memoryDb) await service.close();
    },
  };
}

const MEMORY_CFG = { fieldChars: 400, maxDetails: 15, maxInjokes: 15, maxSelfFacts: 20, maxInterests: 12, interestTopicChars: 40, interestNoteChars: 120 };
const RELATIONSHIPS = { enabled: true, maxDeltaPerUpdate: 15, historySize: 10, damping: true, dampingPower: 1, now: NOW };

/** One analyzer batch with a fixed plan (no model call): a relationship text (a version, kept 1: the older ones are archived), affinity, an episode. */
function batch(m, relationship, extra = {}) {
  const plan = {
    users: { [MEMBER]: { relationship, affinity: { delta: 3, reason: 'φιλική κουβέντα' }, episodes: [{ what: `a talk: ${relationship}`, feeling: 'χαρά', date: '2026-11-03' }] } },
    guild: { patterns: `Short replies, ${relationship}` },
    channels: { [CHANNEL]: { purpose: `chatter about ${relationship}` } },
    ...extra,
  };
  return applyMemoryUpdate(m.store, GUILD, plan, MEMORY_CFG, new Set([MEMBER]), {
    knownChannelIds: new Set([CHANNEL]), relationships: RELATIONSHIPS, episodes: { enabled: true, now: NOW },
    lore: { enabled: true, now: NOW }, versions: { enabled: true, kept: 1 },
  });
}

/**
 * The scripted day (the same calls in the same order under both authorities): analyzer batches, a private batch,
 * counters, a decay tick, lore and learning ops, a channel touch, the buffer and the voice queue, an intention added
 * and updated, a task added and finished, an archive eviction (the versions kept 1) and a version.
 */
async function day(m) {
  const at = (minutes) => NOW - 3_600_000 + minutes * 60_000;
  const message = (id, minutes) => ({ id, authorId: MEMBER, authorName: 'Ada', ts: at(minutes), channelId: CHANNEL, channelName: 'γενικά', channelCategory: null, channelTopic: null, self: false, bot: false, content: 'Καλημέρα, café?', mentionedUserIds: [] });
  for (const [id, minutes] of [['600000000000000001', 0], ['600000000000000002', 1]]) {
    touchMemory(m.store, GUILD, message(id, minutes), {});
    m.store.pushBuffer(GUILD, message(id, minutes), 100);
  }
  batch(m, 'Une amitié calme.', { lore: [{ title: 'Le café', keys: ['café'], text: 'The corner café, its terrace.' }] });
  await m.store.settleArchive(GUILD);
  batch(m, 'Une amitié plus proche.');
  await m.store.settleArchive(GUILD);
  batch(m, 'Une amitié de longue date.');
  await m.store.settleArchive(GUILD);
  applyPrivateUpdate(m.store, GUILD, MEMBER, { users: { [MEMBER]: { affinity: { delta: 2, reason: 'a kind word' }, episodes: [{ what: 'a private talk', feeling: 'ήρεμη', date: '2026-11-03' }] } } }, MEMORY_CFG, { relationships: RELATIONSHIPS, episodes: { enabled: true, now: NOW } });
  m.store.touchPrivateSeen(GUILD, MEMBER, at(5));
  m.store.decayAffinities(GUILD, NOW + 3 * DAY_MS, { decayPerDay: 0.04, decayPower: 1 });
  m.store.setLore(GUILD, [{ title: 'Η πλατεία', keys: ['πλατεία'], text: 'The square by the sea.' }], { source: 'owner', now: NOW });
  m.store.applyLearnedOps(GUILD, { add: ['the café opens at nine'] }, { maxLearned: 20, maxLearnedStored: 60, learnedChars: 160, learnedHalfLifeDays: 720, confirmGapHours: 12, seenAt: NOW });
  m.store.touchChannel(GUILD, CHANNEL, { name: 'γενικά', category: null, topic: 'café' }, at(6), MEMBER, {});
  m.store.updateVoiceQueue(GUILD, () => []);
  m.store.shiftBuffer(GUILD, [message('600000000000000001', 0)]);
  const intentions = m.intentions();
  const added = intentions.add({
    id: 'i2', purpose: 'ask about the café', status: 'pending', createdAt: NOW, updatedAt: NOW, expiresAt: NOW + DAY_MS, dueAt: null,
    provenance: { kind: 'self', turnId: 't-2', channelId: CHANNEL, scope: 'group' }, history: [],
  });
  if (!added.ok) throw new Error(`intention add: ${added.code}`);
  const moved = intentions.update('i2', (record) => ({ ok: true, intention: { ...record, purpose: 'ask about the café terrace', updatedAt: NOW + 1 }, changed: true }));
  if (!moved.ok) throw new Error(`intention update: ${moved.code}`);
  const tasks = m.tasks();
  const task = tasks.add({ agent: 'scout', goal: 'find the café hours', requester: { userId: MEMBER, kind: 'member' }, origin: { channelId: CHANNEL, messageId: '600000000000000001' }, scope: 'group' });
  if (!task.ok) throw new Error(`task add: ${task.code}`);
  tasks.start(task.task.id);
  tasks.finish(task.task.id, { status: 'done', result: { text: 'nine to five', sources: [], files: [] }, usage: { input: 1, output: 1, usd: 0, steps: 1, seconds: 1 } });
  await m.store.settleArchive(GUILD);
  await m.store.flushSettled({});
  await m.intentions().flush();
  await m.tasks().flush();
  await settle();
}

/** Tables the comparison leaves out: the files' signatures, the meta keys, the full-text indexes (derived from sources). */
const LEFT_OUT = new Set(['files', 'meta']);
const DERIVED_KINDS = new Set(['archive_ids', 'record_ids']);
function canonical(db) {
  const tables = db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all();
  const virtual = tables.filter((t) => /^CREATE VIRTUAL TABLE/i.test(t.sql ?? '')).map((t) => t.name);
  const sourceId = new Map(db.prepare('SELECT rowid, id FROM sources').all().map((row) => [row.rowid, row.id]));
  const out = new Map();
  for (const { name } of tables) {
    if (LEFT_OUT.has(name) || virtual.some((v) => name === v || name.startsWith(`${v}_`))) continue;
    const rows = db.prepare(`SELECT * FROM "${name}"`).all().map((row) => {
      const copy = { ...row };
      if (name === 'sources') delete copy.rowid;
      if ('source_rowid' in copy) copy.source_rowid = copy.source_rowid === null ? null : (sourceId.get(copy.source_rowid) ?? `?${copy.source_rowid}`);
      return JSON.stringify(Object.entries(copy).map(([k, v]) => [k, v instanceof Uint8Array ? Buffer.from(v).toString('hex') : typeof v === 'bigint' ? String(v) : v]));
    }).filter((text) => !(name === 'operational' && DERIVED_KINDS.has(JSON.parse(text).find(([k]) => k === 'kind')?.[1])));
    rows.sort();
    out.set(name, { rows, hash: createHash('sha256').update(rows.join('\n')).digest('hex') });
  }
  return out;
}

/** The first differing rows of every table whose canonical rows differ ([] when none). */
function differences(left, right) {
  const out = [];
  for (const name of new Set([...left.keys(), ...right.keys()])) {
    const a = left.get(name);
    const b = right.get(name);
    if (a?.hash === b?.hash) continue;
    const onlyA = (a?.rows ?? []).filter((row) => !(b?.rows ?? []).includes(row));
    const onlyB = (b?.rows ?? []).filter((row) => !(a?.rows ?? []).includes(row));
    out.push(`${name}: json ${a?.rows.length ?? 0} rows, db ${b?.rows.length ?? 0}\n  json only: ${onlyA.slice(0, 2).join('\n    ')}\n  db only: ${onlyB.slice(0, 2).join('\n    ')}`);
  }
  return out;
}

const io = () => { const lines = []; return { lines, out: (line) => lines.push(line), err: (line) => lines.push(line) }; };

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
    keepPending(update) { kept.push(update); },
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
    { op: 'lines', mode: 'db', owner: 'guilds/g/t.jsonl', lines: [{ n: 1 }, { n: 2 }] },
  ]);
  assert.equal(outbox.size(), 0);
  failing = true;
  outbox.value('guilds/g/a.json', { n: 3 });
  assert.equal(await outbox.flush(), 1);
  assert.equal(outbox.keep(), 1);
  assert.deepEqual(kept, [{ op: 'value', owner: 'guilds/g/a.json', value: { n: 3 } }]);
  assert.equal(outbox.size(), 0);
  assert.ok(log.out.some((entry) => entry.level === 'warn' && entry.message === 'memory db: unit write failed' && entry.code === 'DB_CLOSED'));
  assert.ok(log.out.some((entry) => entry.level === 'error' && entry.message === 'memory db: units kept pending' && entry.units === 1));
});

test('start checks: under db her memory session may be apply or off, never shadow', async () => {
  const base = configOf('db');
  assert.equal(authorityRefusal(base), null, 'no session settings: off');
  assert.equal(authorityRefusal({ ...base, memoryDb: { ...base.memoryDb, session: { mode: 'apply' } } }), null);
  assert.equal(authorityRefusal({ ...base, memoryDb: { ...base.memoryDb, session: { mode: 'off' } } }), null);
  assert.equal(authorityRefusal({ ...base, memoryDb: { ...base.memoryDb, session: { mode: 'shadow' } } }), 'SESSION_SHADOW');
  assert.equal(authorityRefusal({ memoryDb: { authority: 'json', session: { mode: 'shadow' } } }), null, 'json: shadow is the default way to try it');
  const { root, data } = prepared();
  const log = logs();
  const hot = { config: { ...base, memoryDb: { ...base.memoryDb, session: { mode: 'shadow' } } } };
  const service = createMemoryDb({ hot, dataDir: data, log, worker: false, now: () => NOW, defer: (fn) => setImmediate(fn) });
  try {
    await service.tick();
    assert.deepEqual([service.status().open, service.status().refused], [false, 'SESSION_SHADOW']);
    assert.equal(log.out.filter((entry) => entry.message === 'memory db: start refused' && entry.code === 'SESSION_SHADOW').length, 1);
  } finally { await service.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('writer parity: the scripted day under db, with the memory files gone, makes the rows the json day and a sync make', async (t) => {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const json = prepared();
  const db = prepared();
  retireFiles(db.data);
  const dbLog = logs();
  const jm = modules(json.data, 'json');
  const dm = modules(db.data, 'db', { log: dbLog });
  try {
    await jm.service.tick();
    await dm.service.tick();
    assert.equal(dm.service.status().open, true);
    await day(jm);
    await day(dm);
    // The projection and the stems a sync pass would finish, by the writers' own job.
    for (let i = 0; i < 10; i += 1) { await dm.service.tick(); await settle(); }
    await jm.close();
    await dm.close();
    const handle = openMemoryDb(path.join(json.data, 'memory.db'));
    try { syncOnce(handle, json.data, { now: () => NOW }); } finally { handle.close(); }

    // Under db no memory file came back and no write failed.
    setDirs(db.data, 0o755);
    assert.deepEqual(memoryFiles(db.data), []);
    const failures = dbLog.out.filter((entry) => (entry.level === 'warn' || entry.level === 'error') && /failed|refused|pending|lost/.test(entry.message));
    assert.deepEqual(failures, []);

    const left = openMemoryDb(path.join(json.data, 'memory.db'), { readOnly: true });
    const right = openMemoryDb(path.join(db.data, 'memory.db'), { readOnly: true });
    try {
      const a = canonical(left.db);
      const b = canonical(right.db);
      assert.ok(a.size > 40, 'every table compared');
      assert.deepEqual(differences(a, b), []);
      // The day reached every kind of unit: the archive month of the evicted versions, the task line, the intention.
      const count = (sql, ...params) => right.db.prepare(sql).get(...params).n;
      assert.equal(count('SELECT COUNT(*) AS n FROM claim_versions WHERE owner_file = ? AND retired_at IS NULL', `guilds/${GUILD}/archive/2026-11.jsonl`), 6);
      assert.equal(count('SELECT COUNT(*) AS n FROM work_events WHERE owner_file = ? AND retired_at IS NULL', `guilds/${GUILD}/tasks.jsonl`), 4);
      assert.equal(count("SELECT COUNT(*) AS n FROM intentions WHERE owner_file = ? AND id LIKE '%i2%' AND retired_at IS NULL", `guilds/${GUILD}/intentions.json`), 1);
      assert.equal(count('SELECT COUNT(*) AS n FROM description_versions WHERE owner_file = ? AND retired_at IS NULL', `guilds/${GUILD}/versions/users/${MEMBER}.json`), 2);
    } finally { left.close(); right.close(); }

    // Under json the files and the database still agree after the resync.
    const file = path.join(json.data, 'memory.db');
    for (const argv of [['verify', '--data', json.data, '--db', file], ['parity', '--data', json.data, '--db', file]]) {
      const out = io();
      assert.equal(memoryDbTool(argv, out), 0, `${argv[0]}\n${out.lines.join('\n')}`);
    }
    const readers = io();
    assert.equal(await memoryDbTool(['reader-parity', '--data', json.data, '--db', file], readers), 0, readers.lines.join('\n'));
  } finally {
    setDirs(db.data, 0o755);
    fs.rmSync(json.root, { recursive: true, force: true });
    fs.rmSync(db.root, { recursive: true, force: true });
  }
});

test('reads under db: the store, the intentions and the tasks load the database values with the memory files gone', async () => {
  const files = prepared();
  const db = prepared();
  retireFiles(db.data);
  const jm = modules(files.data, 'json');
  const dm = modules(db.data, 'db');
  try {
    await jm.service.tick();
    await dm.service.tick();
    assert.deepEqual(dm.store.getUser(GUILD, MEMBER), jm.store.getUser(GUILD, MEMBER));
    assert.deepEqual(dm.store.getGuild(GUILD), jm.store.getGuild(GUILD));
    assert.deepEqual(dm.store.getChannel(GUILD, CHANNEL), jm.store.getChannel(GUILD, CHANNEL));
    assert.deepEqual(dm.store.getLore(GUILD), jm.store.getLore(GUILD));
    assert.deepEqual(dm.store.listPrivate(GUILD), jm.store.listPrivate(GUILD));
    assert.equal(dm.store.getUser(GUILD, '100000000000000077'), null, 'a member the database does not hold is absent');
    assert.deepEqual(dm.intentions().list(), jm.intentions().list());
    assert.deepEqual(dm.tasks().recent(), jm.tasks().recent());
    assert.ok(!dm.store.validate().includes(`guilds/${GUILD}/voice.json`), 'the voice queue is a database unit under db');
    // A closed database is an error to the reader, never a file read.
    const closed = modules(db.data, 'db', { memoryDb: { authority: () => 'db', readHandle: () => null, reader: { value() { throw Object.assign(new Error('closed'), { code: 'DB_CLOSED' }); } } } });
    assert.throws(() => closed.store.getGuild(GUILD), (error) => error.code === 'DB_CLOSED');
    await closed.close();
  } finally {
    await jm.close();
    await dm.close();
    setDirs(db.data, 0o755);
    fs.rmSync(files.root, { recursive: true, force: true });
    fs.rmSync(db.root, { recursive: true, force: true });
  }
});

test('a failed unit write survives a restart through memory-pending/ and is applied once', async () => {
  const { root, data } = prepared();
  retireFiles(data);
  const log = logs();
  const hot = { config: configOf('db') };
  const service = createMemoryDb({ hot, dataDir: data, log, worker: false, now: () => NOW, defer: (fn) => setImmediate(fn) });
  const pendingDir = path.join(data, 'memory-pending');
  const lineCount = (handle) => handle.db.prepare('SELECT COUNT(*) AS n FROM work_events WHERE owner_file = ? AND retired_at IS NULL').get(`guilds/${GUILD}/tasks.jsonl`).n;
  try {
    fs.chmodSync(data, 0o755);
    await service.tick();
    // The writer refuses every unit write of this process (a database that cannot take them).
    const down = { ...service, writeUnit: async (update) => { if (update.op === 'value' || update.op === 'lines') throw Object.assign(new Error('down'), { code: 'SQLITE_FULL' }); return service.writeUnit(update); } };
    const m = modules(data, 'db', { log, memoryDb: down });
    const before = lineCount(service.readHandle());
    m.store.setLore(GUILD, [{ title: 'Η αποβάθρα', keys: ['αποβάθρα'], text: 'The old pier.' }], { source: 'owner', now: NOW });
    m.store.appendDiaryPost(GUILD, { at: NOW, kind: 'day', gist: 'une journée de pluie', picture: null, messageIds: [], search: null }, { max: 150, now: NOW });
    const task = m.tasks().add({ agent: 'scout', goal: 'the pier', requester: { userId: MEMBER, kind: 'member' }, origin: { channelId: CHANNEL, messageId: null }, scope: 'group' });
    assert.equal(task.ok, true);
    const settled = await m.store.flushSettled({ final: true });
    assert.equal(settled.pending, 2, 'the lore and the diary');
    assert.deepEqual(await m.tasks().flush({ final: true }), { waiting: 2, pending: 2 });
    await m.close();
    await service.close();
    assert.equal(fs.readdirSync(pendingDir).filter((name) => name.endsWith('.json')).length, 4);
    const lore = JSON.parse(fs.readFileSync(path.join(pendingDir, `${createHash('sha1').update(`guilds/${GUILD}/lore.json`).digest('hex')}.json`), 'utf8'));
    assert.deepEqual([lore.owner, lore.op, typeof lore.at], [`guilds/${GUILD}/lore.json`, 'value', 'string']);
    assert.ok(log.out.some((entry) => entry.level === 'error' && entry.message === 'memory db: units kept pending'));
    assert.deepEqual(memoryFiles(data), [], 'still no memory file');

    // The next start replays them before anything reads, and deletes each file once its write resolved.
    for (let start = 0; start < 2; start += 1) {
      const next = createMemoryDb({ hot, dataDir: data, log, worker: false, now: () => NOW, defer: (fn) => setImmediate(fn) });
      try {
        await next.tick();
        assert.equal(next.status().open, true);
        assert.deepEqual(fs.readdirSync(pendingDir), []);
        const handle = next.readHandle();
        const value = unitValue(handle.db, `guilds/${GUILD}/lore.json`).value;
        assert.ok(JSON.stringify(value).includes('The old pier.'));
        assert.ok(JSON.stringify(unitValue(handle.db, `guilds/${GUILD}/diary.json`).value).includes('une journée de pluie'));
        assert.equal(lineCount(handle), before + 1, 'the transition line applied once');
      } finally { await next.close(); }
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
  const hot = { config: configOf('db') };
  const pendingDir = path.join(data, 'memory-pending');
  fs.mkdirSync(pendingDir);
  fs.writeFileSync(path.join(pendingDir, `${'0'.repeat(40)}.json`), JSON.stringify({ owner: `guilds/${GUILD}/nothing.json`, op: 'value', value: {}, at: '2026-11-03T12:00:00.000Z' }));
  const service = createMemoryDb({ hot, dataDir: data, log, worker: false, now: () => NOW, defer: (fn) => setImmediate(fn) });
  try {
    await service.tick();
    assert.equal(service.status().open, false);
    assert.equal(service.readHandle(), null);
    assert.equal(fs.readdirSync(pendingDir).length, 1);
    assert.ok(log.out.some((entry) => entry.level === 'error' && entry.message === 'memory db: pending replay failed' && entry.count === 1 && entry.code === 'UNIT_UNMAPPED'));
    assert.ok(log.out.some((entry) => entry.message === 'memory db: open failed' && entry.code === 'PENDING_REPLAY'));
  } finally { await service.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
