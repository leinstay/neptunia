// Stage W2a of the memory writer switch (spec 2026-10-24-memory-authority, section 6 items 1, 2, 3 and 6): the
// authority fixed for the process and its start checks, the offline tools that refuse under `db`, and the append-like
// writers on the database. A scripted day (lines the handler observed and the analyzer's batch took, a turn with a said
// line, a journal, participation, a diary post, an edit, a deletion, a feeling, embeddings) runs once under `json` (the
// files, then a sync) and once under `db` on a fixture whose memory files are read-only: under `db` nothing writes a
// memory file, every table the sync would have filled is filled, and every unit the day touched exports as the files
// the `json` run wrote. Synthetic data only (Greek or accented Latin for non-ASCII); the ids are made up.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createMemoryDb } from '../src/memory/db/service.js';
import { openMemoryDb } from '../src/memory/db/open.js';
import { syncOnce } from '../src/memory/db/sync.js';
import { filesOfUnit } from '../src/memory/db/export.js';
import { classify } from '../src/memory/db/map/index.js';
import { observationOf } from '../src/memory/db/observe-event.js';
import { authorityRefusal, toolRefusal } from '../src/memory/db/authority.js';
import { channelPlaceId } from '../src/memory/db/ids.js';
import { graphPending } from '../src/memory/db/graph.js';
import { createAppendStore } from '../src/memory/append-store.js';
import { appendRevision, createRecord, feltLine, toRecordLine } from '../src/memory/record.js';
import { createJournal } from '../src/memory/journal.js';
import { createVectors } from '../src/memory/vectors.js';
import { createStore } from '../src/memory/store.js';
import { recordOwnLine } from '../src/memory/participation.js';
import { main as memoryDbTool } from '../tools/memory-db.mjs';
import { main as backfillMain } from '../tools/backfill.mjs';
import { main as warmupMain } from '../tools/warmup.mjs';
import { main as embedIndexMain } from '../tools/embed-index.mjs';
import { main as importTurnsMain } from '../tools/import-turns.mjs';
import { CHANNEL, GUILD, MEMBER, buildDataDir, guildDir } from './fixtures/memory-db/datadir.js';

const quiet = { info() {}, debug() {}, warn() {}, error() {} };
const NOW = Date.parse('2026-11-03T12:00:00.000Z');
const SELF = '100000000000000009';
const DM = '200000000000000099';
const DAY = '2026-11-03';
const UNITS = [
  `guilds/${GUILD}/record/2026-11/${DAY}.jsonl`,
  `guilds/${GUILD}/private/${MEMBER}/record/2026-11/${DAY}.jsonl`,
  `guilds/${GUILD}/journal/${DAY}.jsonl`,
  `guilds/${GUILD}/participation.json`,
  `guilds/${GUILD}/diary.json`,
  `guilds/${GUILD}/vectors/2026-11`,
];
const DB_FILES = new Set(['memory.db', 'memory.db-wal', 'memory.db-shm', 'memory.db.lock']);
/** What the operational allowlist lets a `db` day write (spec 6.8): the participation file and the process state. */
const ALLOWED = new Set([`guilds/${GUILD}/participation.json`, 'state.json']);

const tmpRoot = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-w2a-'));
const settle = async (rounds = 6) => { for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve)); };

function logs() {
  const out = [];
  const add = (level) => (message, fields) => out.push({ level, message, ...fields });
  return { out, info: add('info'), warn: add('warn'), error: add('error'), debug: add('debug') };
}

/** A full db-authority config (every start check met), or json. */
const configOf = (authority, extra = {}) => ({
  features: { memoryDb: true, record: true, journal: true },
  memoryDb: { authority, read: true, observeLive: true, syncSeconds: 60 },
  recall: { backend: 'db' },
  diary: { channelId: CHANNEL },
  ...extra,
});

/** A message event as the interface adapter normalises it (src/protocol/events.js), enough for observationOf. */
function eventOf({ id, author = MEMBER, content, at, dm = false, edit = false, self = false }) {
  return {
    iface: 'discord', at, ...(edit ? { edit: true } : {}),
    message: { id, author: { id: author, name: 'Ada', bot: false, self }, content, at, attachments: [], links: [], stickers: [] },
    conversation: dm ? { id: DM, chatType: 'dm', partnerId: MEMBER } : { id: CHANNEL, chatType: 'channel', name: 'γενικά' },
    addressing: { mentionedUserIds: [] },
  };
}

const slimOf = ({ id, author = MEMBER, content, at }) => ({ id, channelId: CHANNEL, authorId: author, ts: at, content, mentionedUserIds: [] });
const counter = (prefix) => { let n = 0; return () => `${prefix}-${(n += 1)}`; };

/** Every file under `dir` but the database's own: rel -> sha1. */
function tree(dir, rel = '', out = new Map()) {
  for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) tree(dir, child, out);
    else if (!DB_FILES.has(child)) out.set(child, createHash('sha1').update(fs.readFileSync(path.join(dir, child))).digest('hex'));
  }
  return out;
}

/** Makes the guild's memory read-only: every file but the allowlist, every directory below the guild's. */
function freeze(data, mode) {
  const g = guildDir(data);
  const walkDir = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const abs = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        if (mode === 'thaw') fs.chmodSync(abs, 0o755);
        walkDir(abs);
        if (mode === 'freeze') fs.chmodSync(abs, 0o555);
      } else if (!ALLOWED.has(path.relative(data, abs).split(path.sep).join('/'))) {
        fs.chmodSync(abs, mode === 'freeze' ? 0o444 : 0o644);
      }
    }
  };
  walkDir(g);
}

/** The data directory with the fixture already in a database (the life under `json` before the day). */
function prepared() {
  const root = tmpRoot();
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  buildDataDir(data);
  const handle = openMemoryDb(path.join(data, 'memory.db'));
  try {
    syncOnce(handle, data, { now: () => NOW - 86_400_000 });
    handle.db.prepare("INSERT INTO meta (key, value) VALUES ('service_import_done', '1') ON CONFLICT(key) DO UPDATE SET value = excluded.value").run();
  } finally { handle.close(); }
  return { root, data };
}

/** The modules of one run, over one data directory, under one authority. */
function modules(data, authority, { log = quiet } = {}) {
  const hot = { config: configOf(authority) };
  const service = createMemoryDb({ hot, dataDir: data, log, worker: false, now: () => NOW, defer: (fn) => setImmediate(fn) });
  const recordStore = createAppendStore({ log: quiet, now: () => NOW });
  const journalStore = createAppendStore({ log: quiet, now: () => NOW });
  const record = createRecord({ appendStore: recordStore, dataDir: data, log: quiet, now: () => NOW, memoryDb: service });
  const journal = createJournal({ appendStore: journalStore, dataDir: data, now: () => NOW, uuid: counter('j'), log: quiet, memoryDb: service });
  const vectors = createVectors({ dataDir: data, log: quiet, now: () => NOW, memoryDb: service });
  const store = createStore({ dataDir: data, newId: counter('id'), record, recordOn: () => true, memoryRead: service.reader, memoryDb: service });
  return {
    hot, service, record, journal, vectors, store,
    close: async () => { await Promise.all([recordStore.close(), journalStore.close()]); await service.close(); },
  };
}

/** The scripted day (the same calls in the same order under both authorities). */
async function day(m) {
  const at = (minutes) => NOW - 3_600_000 + minutes * 60_000;
  const a = { id: '600000000000000001', content: 'Καλημέρα, café?', at: at(0) };
  const b = { id: '600000000000000002', content: 'ναι', at: at(1) };
  const dm = { id: '600000000000000005', content: 'a private word', at: at(2) };
  // The handler observes; the analyzer's batch then takes the seen lines (under db: the observation is the record).
  for (const line of [a, b]) await m.service.observe(observationOf(eventOf(line)), { guildId: GUILD });
  await m.service.observe(observationOf(eventOf({ ...dm, dm: true })), { guildId: GUILD, privateUserId: MEMBER });
  await m.record.append(GUILD, [a, b].map((line, i) => toRecordLine(slimOf(line), { now: () => NOW, uuid: () => `rs-${i}` })));
  await m.record.append(GUILD, [toRecordLine({ ...slimOf(dm), channelId: DM }, { now: () => NOW, uuid: () => 'rs-dm' })], { privateUserId: MEMBER });
  // A turn: its journal lines, her said line, the participation it opens, a diary post.
  const started = m.journal.start(GUILD, { channelId: CHANNEL, mode: 'reply', turnId: 'turn-w2a' });
  const said = { id: '600000000000000003', content: 'Γεια σου!', at: at(3) };
  await m.record.append(GUILD, [toRecordLine({ ...slimOf(said), authorId: SELF, replyToId: a.id, replyToAuthorId: MEMBER }, { kind: 'said', now: () => NOW, uuid: () => 'rs-said', turnId: started.turnId, opId: 'op-w2a' })]);
  await m.journal.turn(GUILD, { channelId: CHANNEL, turnId: started.turnId, attemptId: 1, outcome: 'spoke', think: 'Η σκέψη της.', posted: [{ messageId: said.id, replyTo: a.id, opId: 'op-w2a' }] });
  await m.journal.system(GUILD, { event: 'reload', note: 'config' });
  const state = recordOwnLine(m.store.getParticipation(GUILD), {
    channelId: CHANNEL,
    own: { id: said.id, ts: said.at, authorId: SELF, name: 'Her', self: true, text: said.content, replyTo: a.id },
    before: [{ id: a.id, ts: a.at, authorId: MEMBER, name: 'Ada', self: false, text: a.content, replyTo: null }],
  }, {}, NOW);
  m.store.setParticipation(GUILD, state, { now: NOW });
  m.store.appendDiaryPost(GUILD, { at: NOW, kind: 'day', gist: 'une journée calme', picture: null, messageIds: [said.id], search: null }, { max: 150, now: NOW });
  // An edit (the database counts its revision under db), a deletion, a feeling.
  const edited = observationOf(eventOf({ ...b, content: 'ναι, café', edit: true }));
  const observed = await m.service.observe(edited, { guildId: GUILD });
  const revision = m.service.authority() === 'db' ? observed.revision : 2;
  await appendRevision(m.record, GUILD, (next) => toRecordLine(slimOf({ ...b, content: 'ναι, café' }), { revision: next, now: () => NOW, uuid: () => 'rs-edit' }), revision, { log: quiet });
  await m.record.append(GUILD, [toRecordLine({ id: b.id, channelId: CHANNEL, authorId: MEMBER, ts: b.at }, { kind: 'deleted', now: () => NOW, uuid: () => 'rs-del' })]);
  await m.record.append(GUILD, [feltLine({ userId: MEMBER, itemId: 'ep-w2a', text: 'χαρά', date: DAY, sourceMessageIds: [a.id] }, { now: () => NOW, uuid: counter('felt') })]);
  // Two embeddings: the month is created, then extended.
  const meta = (line, revision = 1) => ({ kind: 'record', id: line.id, revision, occurredAt: new Date(line.at).toISOString(), channelId: CHANNEL, by: MEMBER, participants: [MEMBER], sourceIds: [line.id] });
  await m.vectors.append(GUILD, [{ meta: meta(a), vector: [0.5, -0.25, 0.125, 1] }], { model: 'test/embedder' });
  await m.vectors.append(GUILD, [{ meta: meta(b), vector: [-1, 0.5, 0.25, 0] }, { meta: meta(said), vector: [0.1, 0.2, 0.3, 0.4] }], { model: 'test/embedder' });
  m.store.flush();
  await settle();
  return { a, b, dm, said };
}

/** The files of a unit as the run wrote them (`json`) or as the database exports them (`db`), parsed. */
function unitValue(source, unit) {
  const vectors = unit.includes('/vectors/');
  const info = classify(vectors ? `${unit}/manifest.json` : unit);
  const parse = (rel, data) => (rel.endsWith('.i8') ? data.toString('base64') : rel.endsWith('.jsonl') ? data.toString('utf8').split('\n').filter(Boolean).map((line) => JSON.parse(line)) : JSON.parse(data.toString('utf8')));
  if (source.dir) {
    const abs = path.join(source.dir, unit);
    if (!vectors) return parse(unit, fs.readFileSync(abs));
    return Object.fromEntries(fs.readdirSync(abs).sort().map((name) => [name, parse(name, fs.readFileSync(path.join(abs, name)))]));
  }
  const out = filesOfUnit(source.db, info.unit, info, unit);
  if (!vectors) return parse(unit, out[0].data);
  return Object.fromEntries(out.map((file) => [path.basename(file.rel), parse(file.rel, file.data)]).sort(([x], [y]) => (x < y ? -1 : 1)));
}

test('authority is fixed for the process: a live change is logged once and changes nothing, a new service takes it', async () => {
  const { root, data } = prepared();
  const log = logs();
  const hot = { config: configOf('json') };
  const service = createMemoryDb({ hot, dataDir: data, log, worker: false, now: () => NOW, defer: (fn) => setImmediate(fn) });
  try {
    await service.tick();
    hot.config.memoryDb.authority = 'db';
    await service.tick();
    await service.tick();
    assert.equal(service.authority(), 'json');
    assert.deepEqual([service.status().authority, service.status().syncOff], ['json', false]);
    assert.equal(log.out.filter((entry) => entry.message === 'memory db: authority change needs a restart').length, 1);
    const run = { id: 'run:w2a', sweepId: 'sweep:w2a', scopeKey: 'group:discord', scope: { scope_kind: 'group', scope_iface: 'discord', scope_dm: null }, batchKey: 'apply|w2a', startedAt: '2026-11-03T12:00:00.000Z', finishedAt: '2026-11-03T12:00:00.000Z', outcome: 'ok', counts: {}, errors: [] };
    await assert.rejects(() => service.memoryWrite({ kind: 'session', mode: 'apply', run, plan: { claims: [], episodes: [], affinity: [], descriptions: [] }, now: 1 }), (error) => error.code === 'APPLY_JSON_WRITER');
    await assert.rejects(() => service.writeUnit({ op: 'lines', mode: 'db', owner: UNITS[0], lines: [] }), (error) => error.code === 'UNIT_JSON_WRITER');
  } finally { await service.close(); }
  // A new process with the new value.
  const next = createMemoryDb({ hot, dataDir: data, log, worker: false, now: () => NOW, defer: (fn) => setImmediate(fn) });
  try {
    await next.tick();
    assert.deepEqual([next.authority(), next.status().authority, next.status().syncOff, next.status().open], ['db', 'db', true, true]);
  } finally { await next.close(); fs.rmSync(root, { recursive: true, force: true }); }
});

test('start checks: under db the memory does not open without read, recall on the database and the live observation', async () => {
  const refusals = [
    [{ memoryDb: { authority: 'db', read: false, observeLive: true }, recall: { backend: 'db' } }, 'READ_OFF'],
    [{ memoryDb: { authority: 'db', read: true, observeLive: true }, recall: { backend: 'discord' } }, 'RECALL_NOT_DB'],
    [{ memoryDb: { authority: 'db', read: true, observeLive: false }, recall: { backend: 'db' } }, 'OBSERVE_OFF'],
  ];
  for (const [config, code] of refusals) {
    assert.equal(authorityRefusal(config), code);
    const { root, data } = prepared();
    const log = logs();
    const hot = { config: { ...configOf('db'), ...config, features: { memoryDb: true } } };
    const service = createMemoryDb({ hot, dataDir: data, log, worker: false, now: () => NOW, defer: (fn) => setImmediate(fn) });
    try {
      await service.tick();
      await service.tick();
      assert.deepEqual([service.status().open, service.status().refused], [false, code], code);
      assert.equal(log.out.filter((entry) => entry.message === 'memory db: start refused' && entry.code === code).length, 1, 'logged once');
      await assert.rejects(() => service.writeUnit({ op: 'lines', mode: 'db', owner: UNITS[0], lines: [] }), (error) => error.code === 'DB_CLOSED');
    } finally { await service.close(); fs.rmSync(root, { recursive: true, force: true }); }
  }
  assert.equal(authorityRefusal(configOf('db')), null);
  assert.equal(authorityRefusal({ memoryDb: { authority: 'json' } }), null, 'json refuses nothing here (session apply is refused by its writer)');
});

test('the offline tools that write memory files refuse under db; memory-db export, backup and restore do not ask', async () => {
  const { root, data } = prepared();
  const hot = { config: { memoryDb: { authority: 'db' }, bot: { guildId: GUILD } }, prompts: {}, close() {} };
  const refused = (error) => /memoryDb\.authority is db/.test(error.message);
  try {
    assert.equal(toolRefusal({ memoryDb: { authority: 'json' } }, 'x'), null);
    await assert.rejects(() => backfillMain(['fetch', '--since', '2026-10-01', '--data', data], { hot, cwd: root }), refused);
    await assert.rejects(() => warmupMain(['run', '--data', data, '--guild', GUILD], { hot, cwd: root }), refused);
    await assert.rejects(() => embedIndexMain(['build', '--max-usd', '1', '--data', data], { hot, cwd: root }), refused);
    await assert.rejects(() => importTurnsMain(['--csv', path.join(root, 'none.csv'), '--write', '--data', data], { hot, cwd: root }), refused);
    const lines = [];
    const code = memoryDbTool(['export', '--db', path.join(data, 'memory.db'), '--to', path.join(root, 'out')], { out: (line) => lines.push(line), err: (line) => lines.push(line) });
    assert.equal(code, 0, lines.join('\n'));
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a scripted day under db writes no memory file, fills every table the sync would, and exports as the json run wrote it', async () => {
  const json = prepared();
  const db = prepared();
  const before = tree(db.data);
  freeze(db.data, 'freeze');
  const dbLog = logs();
  const jm = modules(json.data, 'json');
  const dm = modules(db.data, 'db', { log: dbLog });
  try {
    await jm.service.tick();
    await dm.service.tick();
    assert.equal(dm.service.status().open, true);
    const ids = await day(jm);
    await day(dm);
    await jm.close();
    await settle();

    // Nothing but the allowlist changed on the db run's disk, and no write failed.
    const after = tree(db.data);
    for (const rel of new Set([...before.keys(), ...after.keys()])) {
      if (ALLOWED.has(rel)) continue;
      assert.equal(after.get(rel), before.get(rel), `${rel} was written under db`);
    }
    assert.ok(!dbLog.out.some((entry) => entry.level === 'warn' && /failed|refused/.test(entry.message)), JSON.stringify(dbLog.out.filter((entry) => entry.level === 'warn')));

    const d = dm.service.database() ?? dm.service.readHandle().db;
    const count = (sql, ...params) => d.prepare(sql).get(...params).n;
    // The record: every kind, in its day unit, at contiguous positions, the batch's lines adopting the observations.
    const record = d.prepare('SELECT id, kind, origin, position, revision FROM sources WHERE owner_file = ? AND retired_at IS NULL ORDER BY position').all(UNITS[0]);
    assert.deepEqual(record.map((row) => row.kind), ['seen', 'seen', 'said', 'seen', 'deleted', 'felt']);
    assert.deepEqual(record.map((row) => row.position), [0, 1, 2, 3, 4, 5]);
    assert.ok(record.every((row) => row.origin === 'live'), 'every observation was taken over by its record line');
    assert.equal(record[3].revision, 2, 'the edit has the revision the database counted');
    assert.equal(count('SELECT COUNT(*) AS n FROM sources WHERE owner_file = ?', UNITS[1]), 1, 'the private line is in the private record');
    assert.equal(count("SELECT COUNT(*) AS n FROM sources WHERE owner_file IS NULL AND kind IN ('seen', 'said', 'deleted', 'felt')"), 0, 'no line without its unit');
    // The journal, participation (references resolved), the vectors (linked), the diary and its publication.
    assert.equal(count('SELECT COUNT(*) AS n FROM day WHERE owner_file = ?', UNITS[2]), 3);
    assert.equal(count("SELECT COUNT(*) AS n FROM sources WHERE kind = 'answer' AND owner_file = ?", UNITS[2]), 1);
    const sources = d.prepare('SELECT es.source_id AS id, s.id AS found FROM episode_sources es JOIN episodes e ON e.id = es.episode_id LEFT JOIN sources s ON s.id = es.source_id WHERE e.owner_file = ? AND e.retired_at IS NULL AND es.retired_at IS NULL').all(UNITS[3]);
    assert.ok(sources.length >= 2 && sources.every((row) => row.found !== null), 'every episode line resolves to a stored line');
    const vectorRows = d.prepare('SELECT source_rowid FROM vectors WHERE owner_file = ? AND retired_at IS NULL').all(UNITS[5]);
    assert.equal(vectorRows.length, 3);
    assert.ok(vectorRows.every((row) => Number.isInteger(row.source_rowid)), 'every vector names its line');
    const publication = d.prepare("SELECT p.status, p.idempotency_key, p.destination_place_id, p.receipts FROM publications p JOIN diary_mirrors m ON m.id = p.id JOIN diary y ON y.id = m.diary_id WHERE y.owner_file = ? AND y.gist = 'une journée calme'").get(UNITS[4]);
    assert.equal(publication.status, 'sent');
    assert.match(publication.idempotency_key, /^diary:/);
    assert.equal(publication.destination_place_id, channelPlaceId(CHANNEL));
    assert.deepEqual(JSON.parse(publication.receipts).map((receipt) => receipt.key), [ids.said.id]);
    for (const unit of UNITS) assert.equal(count('SELECT COUNT(*) AS n FROM files WHERE path = ? AND gone_at IS NULL', unit), 1, `${unit} is listed`);

    // Writer parity: every unit the day touched exports as the json run wrote it.
    for (const unit of UNITS) assert.deepEqual(unitValue({ db: d }, unit), unitValue({ dir: json.data }, unit), unit);

    // The W1 readers see the observed lines (owner and position) and the database's month index.
    const lines = [];
    for await (const line of dm.record.iterate(GUILD, { from: `${DAY}T00:00:00.000Z`, to: `${DAY}T23:59:59.999Z` })) lines.push(line.kind);
    assert.deepEqual(lines, ['seen', 'seen', 'said', 'seen', 'deleted', 'felt']);
    const lone = { id: '600000000000000007', content: 'σιωπή', at: NOW - 60_000 };
    assert.equal((await dm.service.observe(observationOf(eventOf(lone)), { guildId: GUILD })).ok, true);
    const seenNow = [];
    for await (const line of dm.record.iterate(GUILD, { from: `${DAY}T00:00:00.000Z` })) seenNow.push(line.messageId);
    assert.equal(seenNow.at(-1), lone.id, 'an observed line is in the record before any batch');
    assert.equal(await dm.record.newestRevision(GUILD, ids.b.id, `${DAY}T00:00:00.000Z`), 2);
  } finally {
    await dm.close();
    freeze(db.data, 'thaw');
    fs.rmSync(json.root, { recursive: true, force: true });
    fs.rmSync(db.root, { recursive: true, force: true });
  }
});

test('under json the record shadows said, deleted and felt lines; after a sync observe-check and verify are clean', async () => {
  const { root, data } = prepared();
  const m = modules(data, 'json');
  const io = () => { const lines = []; return { lines, out: (line) => lines.push(line), err: (line) => lines.push(line) }; };
  try {
    await m.service.tick();
    await day(m);
    const d = m.service.database();
    const shadows = d.prepare("SELECT kind FROM sources WHERE origin = 'observation' AND owner_file IS NULL ORDER BY kind").all().map((row) => row.kind);
    assert.ok(['deleted', 'felt', 'said'].every((kind) => shadows.includes(kind)), shadows.join(','));
    await m.close();
    const file = path.join(data, 'memory.db');
    const handle = openMemoryDb(file);
    try { syncOnce(handle, data, { now: () => NOW }); } finally { handle.close(); }
    const check = io();
    assert.equal(memoryDbTool(['observe-check', '--db', file, '--since', '2026-11-01T00:00:00.000Z'], check), 0, check.lines.join('\n'));
    const verify = io();
    assert.equal(memoryDbTool(['verify', '--data', data, '--db', file], verify), 0, verify.lines.join('\n'));
    // A deleted line the file holds and the database never saw: the check names it.
    fs.appendFileSync(path.join(data, UNITS[0]), `${JSON.stringify(toRecordLine({ id: '600000000000000008', channelId: CHANNEL, authorId: MEMBER, ts: NOW - 1000 }, { kind: 'deleted', now: () => NOW, uuid: () => 'rs-late' }))}\n`);
    const again = openMemoryDb(file);
    try { syncOnce(again, data, { now: () => NOW }); } finally { again.close(); }
    const late = io();
    assert.equal(memoryDbTool(['observe-check', '--db', file, '--since', '2026-11-01T00:00:00.000Z'], late), 1);
    assert.match(late.lines.join('\n'), /in the record, not observed: 1/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('under db the writers finish the graph projection a migration left pending, one slice a tick', async () => {
  const { root, data } = prepared();
  const file = path.join(data, 'memory.db');
  const handle = openMemoryDb(file);
  try { handle.db.prepare("INSERT INTO meta (key, value) VALUES ('graph_pending', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify({ unit: 0, after: null })); } finally { handle.close(); }
  const service = createMemoryDb({ hot: { config: configOf('db') }, dataDir: data, log: quiet, worker: false, now: () => NOW, defer: (fn) => setImmediate(fn) });
  try {
    for (let i = 0; i < 60 && (i === 0 || graphPending(service.readHandle())); i += 1) {
      await service.tick();
      await settle();
    }
    assert.equal(graphPending(service.readHandle()), false);
    assert.equal(service.status().syncOff, true);
  } finally { await service.close(); fs.rmSync(root, { recursive: true, force: true }); }
});
