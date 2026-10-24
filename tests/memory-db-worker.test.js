// The memory database's worker thread (src/memory/db/sync-worker.js through src/memory/db/service.js): its passes equal
// the in-thread ones, the main thread reads through its own read-only connection, a crashed worker is restarted at the
// next pass, and shutdown waits for a pass under way (bounded) before it terminates the worker. Synthetic data only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { Worker } from 'node:worker_threads';
import { createMemoryDb } from '../src/memory/db/service.js';
import { openMemoryDb } from '../src/memory/db/open.js';
import { CHANNEL, GUILD, MEMBER, buildDataDir, guildDir, writeJson } from './fixtures/memory-db/datadir.js';

const tmpRoot = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-worker-'));
const REAL_WORKER = pathToFileURL(path.resolve('src/memory/db/sync-worker.js')).href;

function logs() {
  const out = [];
  const add = (level) => (message, fields) => out.push({ level, message, ...fields });
  return { out, info: add('info'), warn: add('warn'), error: add('error'), debug: add('debug') };
}

/**
 * A data directory and a service. `fake` names a behaviour for a stand-in worker that wraps the real one: it reads
 * `<root>/mode` at each pass message (`crash-once`, `slow`, `hang`) before the real handlers see the message.
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
  if (message.type !== 'pass') return;
  let mode = '';
  try { mode = fs.readFileSync(root + '/mode', 'utf8'); } catch { /* none */ }
  if (mode === 'crash-once' && !fs.existsSync(root + '/crashed')) { fs.writeFileSync(root + '/crashed', '1'); process.exit(3); }
  if (mode === 'slow') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 400);
  if (mode === 'hang') Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 60000);
});
await import(${JSON.stringify(REAL_WORKER)});
`);
  }
  const hot = { config: { features: { memoryDb: true, ...rest.features }, memoryDb: { syncSeconds: 60, ...memoryDb } } };
  const log = logs();
  let time = Date.UTC(2026, 9, 24, 12, 0, 0);
  const service = createMemoryDb({ hot, dataDir: data, log, now: () => time, ...(fake ? { workerFile } : {}), ...rest.options });
  return {
    root, data, hot, log, service, g: guildDir(data), dbFile: () => path.join(data, 'memory.db'),
    mode: (value) => fs.writeFileSync(path.join(root, 'mode'), value),
    advance: (ms) => { time += ms; },
    done: async () => { await service.close().catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

const tables = (db) => db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%' ORDER BY name").all().map((row) => row.name);
const dumpAll = (file) => {
  const reader = openMemoryDb(file, { readOnly: true });
  try {
    return Object.fromEntries(tables(reader.db).map((table) => [table, reader.db.prepare(`SELECT * FROM "${table}"`).all().map((row) => JSON.stringify(row, (_, v) => (typeof v === 'bigint' ? String(v) : v))).sort()]));
  } finally { reader.close(); }
};
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

test('a pass in the worker writes the same database as the same pass on the calling thread', async () => {
  const threaded = setup();
  const inline = setup({ options: { worker: false } });
  try {
    fs.cpSync(threaded.data, inline.data, { recursive: true, preserveTimestamps: true });
    await threaded.service.tick();
    await inline.service.tick();
    assert.equal(threaded.service.status().importDone, true);
    assert.equal(threaded.service.status().lastPass.errors, 0);
    await threaded.service.close();
    await inline.service.close();
    const a = dumpAll(threaded.dbFile());
    const b = dumpAll(inline.dbFile());
    for (const table of Object.keys(b)) assert.deepEqual(a[table], b[table], table);
    assert.ok(a.files.length > 5 && a.vectors.length === 2);
  } finally { await threaded.done(); await inline.done(); }
});

test('the worker holds the writer lock; the main thread reads through its own read-only connection', async () => {
  const env = setup({ memoryDb: { read: true } });
  try {
    await env.service.tick();
    assert.ok(fs.existsSync(`${env.dbFile()}.lock`));
    assert.equal(JSON.parse(fs.readFileSync(`${env.dbFile()}.lock`, 'utf8')).pid, process.pid);
    assert.throws(() => openMemoryDb(env.dbFile(), { pid: process.pid + 1 }), /locked by pid/, 'a second writer is refused');
    const status = env.service.status();
    assert.equal(status.readActive, true);
    assert.ok(status.rows > 5 && status.files > 5);
    const found = env.service.reader.value(path.join(env.g, 'recent.json'));
    assert.equal(found?.found, true);
    // A change on disk reaches the database through the worker's next pass, and the reader sees it.
    writeJson(path.join(env.g, 'users', '100000000000000077.json'), { id: '100000000000000077', names: ['Zed'] });
    const before = status.files;
    env.service.requestSync();
    for (let i = 0; i < 100 && env.service.status().files === before; i += 1) await wait(20);
    assert.equal(env.service.status().files, before + 1);
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

test('a crashed worker is logged with a code, its pass fails, and the next tick starts a new one that takes the lock over', async () => {
  const env = setup({ fake: true });
  try {
    await env.service.tick();
    assert.equal(env.service.status().importDone, true);
    env.mode('crash-once');
    env.advance(61_000);
    await env.service.tick();
    const exited = env.log.out.find((e) => e.message === 'memory db: worker exited');
    assert.deepEqual([exited?.code, exited?.exit], ['WORKER_EXIT', 3]);
    const failed = env.log.out.find((e) => e.message === 'memory db: pass failed');
    assert.equal(failed?.code, 'WORKER_EXIT');
    assert.equal(Object.keys(failed).every((key) => ['level', 'message', 'reason', 'code'].includes(key)), true);
    // The lock the dead worker held is still there, with this process's pid; the new worker takes it over.
    writeJson(path.join(env.g, 'users', '100000000000000078.json'), { id: '100000000000000078', names: ['Yan'] });
    const before = env.service.status().files;
    env.advance(1000);
    await env.service.tick();
    assert.equal(env.log.out.filter((e) => e.message === 'memory db: opened').length, 2, 'a second worker was opened');
    assert.equal(env.service.status().files, before + 1, 'and its pass ran');
    assert.equal(env.service.status().lastPass.failed, undefined);
  } finally { await env.done(); }
});

test('shutdown waits for a pass under way, then closes the database and frees the lock', async () => {
  const env = setup({ fake: true, memoryDb: { closeTimeoutMs: 5000 } });
  try {
    await env.service.tick();
    env.mode('slow');
    writeJson(path.join(env.g, 'users', '100000000000000079.json'), { id: '100000000000000079', names: ['Wim'] });
    env.advance(61_000);
    const pass = env.service.tick();
    await wait(50);
    const started = Date.now();
    await env.service.close();
    await pass;
    assert.ok(Date.now() - started >= 150, 'it waited for the slow pass');
    assert.equal(env.log.out.some((e) => e.message === 'memory db: pass failed'), false);
    assert.equal(fs.existsSync(`${env.dbFile()}.lock`), false);
    const reader = openMemoryDb(env.dbFile(), { readOnly: true });
    try { assert.ok(reader.db.prepare("SELECT 1 AS ok FROM files WHERE path LIKE '%100000000000000079%'").get(), 'its result is in the database'); } finally { reader.close(); }
  } finally { await env.done(); }
});

test('shutdown gives a stuck pass closeTimeoutMs, then terminates the worker and frees the lock', async () => {
  const env = setup({ fake: true, memoryDb: { closeTimeoutMs: 300 } });
  try {
    await env.service.tick();
    env.mode('hang');
    env.advance(61_000);
    const pass = env.service.tick();
    await wait(50);
    const started = Date.now();
    await env.service.close();
    const took = Date.now() - started;
    assert.ok(took >= 250 && took < 5000, `bounded by the timeout: ${took} ms`);
    await pass;
    assert.equal(fs.existsSync(`${env.dbFile()}.lock`), false, 'the lock of a terminated worker is released');
    assert.equal(env.service.status().open, false);
    // Nothing is left running: the database opens again for a writer.
    const again = openMemoryDb(env.dbFile());
    again.close();
  } finally { await env.done(); }
});

test('the worker refuses a pass while the database is the authority; a write through it is stamped with the service\'s fixed authority', async () => {
  const root = tmpRoot();
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  const worker = new Worker(new URL(REAL_WORKER), { workerData: { dataDir: data } });
  const ask = (message) => new Promise((resolve) => { worker.once('message', resolve); worker.postMessage(message); });
  try {
    assert.equal((await ask({ id: 1, type: 'open', path: path.join(data, 'memory.db') })).ok, true);
    const refused = await ask({ id: 2, type: 'pass', first: true, now: 0, authority: 'db' });
    assert.deepEqual([refused.ok, refused.code], [false, 'SYNC_OFF']);
    assert.equal((await ask({ id: 3, type: 'close' })).ok, true);
  } finally {
    await worker.terminate();
    fs.rmSync(root, { recursive: true, force: true });
  }
  const run = { id: 'run:w', sweepId: 'sweep:w', scopeKey: 'group:discord', scope: { scope_kind: 'group', scope_iface: 'discord', scope_dm: null }, batchKey: 'apply|w', startedAt: '2026-10-24T12:00:00.000Z', finishedAt: '2026-10-24T12:00:00.000Z', outcome: 'ok', counts: {}, errors: [] };
  const update = { kind: 'session', mode: 'apply', authority: 'db', run, plan: { claims: [], episodes: [], affinity: [], descriptions: [] }, now: 1 };
  const env = setup();
  try {
    await env.service.tick();
    await assert.rejects(() => env.service.memoryWrite(update), (error) => error.code === 'APPLY_JSON_WRITER');
    // The authority is fixed for the process: a live change does not unlock the write.
    env.hot.config.memoryDb.authority = 'db';
    await assert.rejects(() => env.service.memoryWrite(update), (error) => error.code === 'APPLY_JSON_WRITER');
  } finally { await env.done(); }
  // A service started under db (every start check met) writes it through the worker.
  const db = setup({ memoryDb: { authority: 'db', read: true, observeLive: true } });
  db.hot.config.recall = { backend: 'db' };
  try {
    await db.service.tick();
    await db.service.memoryWrite(update);
    await db.service.close();
    const reader = openMemoryDb(db.dbFile(), { readOnly: true });
    try { assert.equal(reader.db.prepare("SELECT COUNT(*) AS n FROM session_runs WHERE applied = 1").get().n, 1); } finally { reader.close(); }
  } finally { await db.done(); }
});

test('worker: under db the unit writers and the observation write through the worker (buffers cross the thread)', async () => {
  const env = setup({ memoryDb: { authority: 'db', read: true, observeLive: true } });
  env.hot.config.recall = { backend: 'db' };
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
    assert.deepEqual(await env.service.writeUnit({ op: 'lines', mode: 'db', owner, lines: [line] }), { written: 1, duplicates: 0, adopted: 0 });
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
