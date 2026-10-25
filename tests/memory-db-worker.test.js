// The memory database's writer thread (src/memory/db/writer-worker.js through src/memory/db/service.js): its writes
// equal the in-thread ones, the main thread reads through its own read-only connection, a crashed worker is restarted
// at the next tick, and shutdown waits for a write under way (bounded) before it terminates the worker. Synthetic data
// only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createMemoryDb } from '../src/memory/db/service.js';
import { openMemoryDb } from '../src/memory/db/open.js';
import { CHANNEL, GUILD, MEMBER, buildDataDir } from './fixtures/memory-db/datadir.js';
import { unitUpdates } from './fixtures/memory-db/seed.js';

const tmpRoot = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-worker-'));
const REAL_WORKER = pathToFileURL(path.resolve('src/memory/db/writer-worker.js')).href;

function logs() {
  const out = [];
  const add = (level) => (message, fields) => out.push({ level, message, ...fields });
  return { out, info: add('info'), warn: add('warn'), error: add('error'), debug: add('debug') };
}

/**
 * A data directory and a service. `fake` names a behaviour for a stand-in worker that wraps the real one: it reads
 * `<root>/mode` at each write message (`crash-once`, `slow`, `hang`) before the real handlers see the message.
 */
function setup({ memoryDb = {}, fake = false, ...rest } = {}) {
  const root = tmpRoot();
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  buildDataDir(data);
  let workerFile;
  if (fake) {
    workerFile = pathToFileURL(path.join(root, 'fake-worker.mjs'));
    fs.writeFileSync(workerFile, `
import { parentPort } from 'node:worker_threads';
import fs from 'node:fs';
const root = ${JSON.stringify(root)};
parentPort.on('message', (message) => {
  if (message.type !== 'memoryWrite') return;
  let mode = '';
  try { mode = fs.readFileSync(root + '/mode', 'utf8'); } catch { /* none */ }
  if (mode === 'crash-once' && !fs.existsSync(root + '/crashed')) { fs.writeFileSync(root + '/crashed', '1'); process.exit(3); }
  if (mode === 'slow') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
  if (mode === 'hang') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
});
await import(${JSON.stringify(REAL_WORKER)});
`);
  }
  const hot = { config: { memoryDb: { session: { mode: 'off' }, ...memoryDb } } };
  const log = logs();
  let time = Date.UTC(2026, 9, 24, 12, 0, 0);
  const service = createMemoryDb({ hot, dataDir: data, log, now: () => time, ...(fake ? { workerFile } : {}), ...rest.options });
  return {
    root, data, hot, log, service, dbFile: () => path.join(data, 'memory.db'),
    mode: (value) => fs.writeFileSync(path.join(root, 'mode'), value),
    advance: (ms) => { time += ms; },
    done: async () => { await service.close().catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

/** A profile unit of a new member. */
const profile = (id, name) => ({ op: 'value', owner: `guilds/${GUILD}/users/${id}.json`, value: { id, names: [name] } });
const profileRows = (db, id) => db.prepare('SELECT COUNT(*) AS n FROM files WHERE path = ?').get(`guilds/${GUILD}/users/${id}.json`).n;

const tables = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%' ORDER BY name").all().map((row) => row.name);
const dumpAll = (file) => {
  const reader = openMemoryDb(file, { readOnly: true });
  try {
    return Object.fromEntries(tables(reader.db).map((table) => [table, reader.db.prepare(`SELECT * FROM "${table}"`).all().map((row) => JSON.stringify(row, (_, v) => (typeof v === 'bigint' ? String(v) : v))).sort()]));
  } finally { reader.close(); }
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('the unit writes through the worker make the same database as on the calling thread', async () => {
  const threaded = setup();
  const inline = setup({ options: { worker: false } });
  try {
    await threaded.service.tick();
    await inline.service.tick();
    for (const update of unitUpdates(threaded.data)) {
      await threaded.service.writeUnit(update);
      await inline.service.writeUnit(update);
    }
    await threaded.service.close();
    await inline.service.close();
    const a = dumpAll(threaded.dbFile());
    const b = dumpAll(inline.dbFile());
    for (const table of Object.keys(b)) assert.deepEqual(a[table], b[table], table);
    assert.ok(a.files.length > 5 && a.vectors.length === 2);
  } finally { await threaded.done(); await inline.done(); }
});

test('the worker holds the writer lock; the main thread reads through its own read-only connection', async () => {
  const env = setup();
  try {
    await env.service.tick();
    assert.ok(fs.existsSync(`${env.dbFile()}.lock`));
    assert.equal(JSON.parse(fs.readFileSync(`${env.dbFile()}.lock`, 'utf8')).pid, process.pid);
    assert.throws(() => openMemoryDb(env.dbFile(), { pid: process.pid + 1 }), /locked by pid/, 'a second writer is refused');
    assert.equal(env.service.status().open, true);
    // A write through the worker is seen by the main thread's reader.
    await env.service.writeUnit(profile('100000000000000077', 'Zed'));
    assert.equal(profileRows(env.service.readHandle().db, '100000000000000077'), 1);
    await env.service.close();
    assert.equal(fs.existsSync(`${env.dbFile()}.lock`), false);
  } finally { await env.done(); }
});

test('turn reads are written by the worker and counted at debug', async () => {
  const env = setup();
  try {
    await env.service.tick();
    env.service.recordTurnReads({ turnId: 'turn-9', step: 's0', reads: [{ kind: 'channel', id: CHANNEL, block: 'server', ord: 3 }, { kind: 'claim', id: 'no-such-claim', block: 'people', ord: 1 }] });
    await env.service.close();
    const reader = openMemoryDb(env.dbFile(), { readOnly: true });
    try {
      const rows = reader.db.prepare('SELECT turn_id, step, row_kind, block, ord FROM turn_reads').all().map((row) => ({ ...row }));
      assert.deepEqual(rows.filter((row) => row.turn_id === 'turn-9').map((row) => row.row_kind).sort(), ['claims', 'places']);
      assert.deepEqual(rows.filter((row) => row.turn_id === 'turn-9').map((row) => [row.row_kind, row.block, row.ord]).sort(), [['claims', 'people', 1], ['places', 'server', 3]], 'resolved on the main thread, written by the worker');
    } finally { reader.close(); }
  } finally { await env.done(); }
});

test('a crashed worker is logged with a code, its write fails, and the next tick starts a new one that takes the lock over', async () => {
  const env = setup({ fake: true });
  try {
    await env.service.tick();
    env.mode('crash-once');
    await assert.rejects(() => env.service.writeUnit(profile('100000000000000078', 'Yan')), (error) => error.code === 'WORKER_EXIT');
    const exited = env.log.out.find((e) => e.message === 'memory db: worker exited');
    assert.deepEqual([exited?.code, exited?.exit], ['WORKER_EXIT', 3]);
    // The lock the dead worker held is still there, with this process's pid; the new worker takes it over.
    env.advance(1000);
    await env.service.tick();
    assert.equal(env.log.out.filter((e) => e.message === 'memory db: opened').length, 2, 'a second worker was opened');
    await env.service.writeUnit(profile('100000000000000078', 'Yan'));
    assert.equal(profileRows(env.service.readHandle().db, '100000000000000078'), 1, 'and its write ran');
  } finally { await env.done(); }
});

test('shutdown waits for a write under way, then closes the database and frees the lock', async () => {
  const env = setup({ fake: true, memoryDb: { closeTimeoutMs: 5000 } });
  try {
    await env.service.tick();
    env.mode('slow');
    const write = env.service.writeUnit(profile('100000000000000079', 'Wim'));
    await wait(50);
    const started = Date.now();
    await env.service.close();
    await write;
    assert.ok(Date.now() - started >= 150, 'it waited for the slow write');
    assert.equal(fs.existsSync(`${env.dbFile()}.lock`), false);
    const reader = openMemoryDb(env.dbFile(), { readOnly: true });
    try { assert.equal(profileRows(reader.db, '100000000000000079'), 1, 'its result is in the database'); } finally { reader.close(); }
  } finally { await env.done(); }
});

test('shutdown gives a stuck write closeTimeoutMs, then terminates the worker and frees the lock', async () => {
  const env = setup({ fake: true, memoryDb: { closeTimeoutMs: 300 } });
  try {
    await env.service.tick();
    env.mode('hang');
    const write = env.service.writeUnit(profile('100000000000000080', 'Uma')).catch((error) => error);
    await wait(50);
    const started = Date.now();
    await env.service.close();
    const took = Date.now() - started;
    assert.ok(took >= 250 && took < 5000, `bounded by the timeout: ${took} ms`);
    assert.equal((await write)?.code, 'WORKER_EXIT');
    assert.equal(fs.existsSync(`${env.dbFile()}.lock`), false, 'the lock of a terminated worker is released');
    assert.equal(env.service.status().open, false);
    // Nothing is left running: the database opens again for a writer.
    const again = openMemoryDb(env.dbFile());
    again.close();
  } finally { await env.done(); }
});

test('a memory session write goes through the worker', async () => {
  const run = { id: 'run:w', sweepId: 'sweep:w', scopeKey: 'group:discord', scope: { scope_kind: 'group', scope_iface: 'discord', scope_dm: null }, batchKey: 'apply|w', startedAt: '2026-10-24T12:00:00.000Z', finishedAt: '2026-10-24T12:00:00.000Z', outcome: 'ok', counts: {}, errors: [] };
  const update = { kind: 'session', mode: 'apply', run, plan: { claims: [], episodes: [], affinity: [], descriptions: [] }, now: 1 };
  const db = setup();
  try {
    await db.service.tick();
    await db.service.memoryWrite(update);
    await db.service.close();
    const reader = openMemoryDb(db.dbFile(), { readOnly: true });
    try { assert.equal(reader.db.prepare("SELECT COUNT(*) AS n FROM session_runs WHERE applied = 1").get().n, 1); } finally { reader.close(); }
  } finally { await db.done(); }
});

test('worker: the unit writers and the observation write through the worker (buffers cross the thread)', async () => {
  const env = setup();
  const owner = `guilds/${GUILD}/record/2026-11/2026-11-03.jsonl`;
  const month = `guilds/${GUILD}/vectors/2026-11`;
  try {
    await env.service.tick();
    const envelope = {
      v: 1, iface: 'discord', authority: 'discord/global', native: { kind: 'message', key: '600000000000000001', subtype: 'seen', revision: 1 },
      place: { authority: 'discord/global', key: `channel:${CHANNEL}`, kind: 'channel', conversation: 'group' },
      author: { kind: 'account', key: MEMBER, account_kind: 'user' }, occurredAt: '2026-11-03T10:00:00.000Z', observedAt: '2026-11-03T10:00:00.000Z',
      text: 'Καλημέρα', mentions: [], direct: false, relations: [],
    };
    const observed = await env.service.observe(envelope, { guildId: GUILD });
    assert.deepEqual([observed.ok, observed.revision], [true, 1]);
    const line = { v: 1, id: 'r-w', kind: 'said', messageId: '600000000000000002', revision: 1, occurredAt: '2026-11-03T10:01:00.000Z', recordedAt: '2026-11-03T10:01:00.000Z', guildId: GUILD, scope: { channel: CHANNEL }, replyTo: null, text: 'Γεια', media: [], mentions: [], turnId: 't-w', opId: 'op-w', participants: [], sourceMessageIds: ['600000000000000002'], origin: 'live' };
    assert.deepEqual(await env.service.writeUnit({ op: 'lines', owner, lines: [line] }), { written: 1, duplicates: 0, adopted: 0 });
    const meta = '{"row":0,"kind":"record","id":"600000000000000002","revision":1,"occurredAt":"2026-11-03T10:01:00.000Z","channelId":null,"by":null,"participants":[],"sourceIds":[],"scale":0.01,"norm":1}\n';
    const manifest = { v: 1, gen: 1, rows: 1, bytes: 4, metaBytes: Buffer.byteLength(meta), model: 'test/embedder', dims: 4, checksum: 'fnv1a32:00000000:00000000' };
    await env.service.writeUnit({ op: 'vectors', owner: month, delta: { manifest, meta, i8: Buffer.from([1, 2, 3, 4]) } });
    const db = env.service.readHandle().db;
    assert.deepEqual(db.prepare('SELECT kind, position FROM sources WHERE owner_file = ? ORDER BY position').all(owner).map((row) => [row.kind, row.position]), [['seen', 0], ['said', 1]]);
    assert.deepEqual([...db.prepare('SELECT bytes FROM vectors WHERE owner_file = ?').get(month).bytes], [1, 2, 3, 4]);
  } finally { await env.done(); }
});

test('a shutdown right after a turn writes its reads before the database closes, even when the deferred write has not run', async () => {
  const env = setup({ options: { defer: () => {} } });
  try {
    await env.service.tick();
    env.service.recordTurnReads({ turnId: 'turn-10', step: 's0', reads: [{ kind: 'channel', id: CHANNEL, block: 'server', ord: 0 }] });
    await env.service.close();
    const reader = openMemoryDb(env.dbFile(), { readOnly: true });
    try {
      assert.deepEqual(reader.db.prepare("SELECT row_kind FROM turn_reads WHERE turn_id = 'turn-10'").all().map((row) => row.row_kind), ['places']);
    } finally { reader.close(); }
  } finally { await env.done(); }
});
