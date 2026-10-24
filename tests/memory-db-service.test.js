// The memory database service (src/memory/db/service.js): the switch, the sync passes, the sliced first import, the
// shutdown, the per-turn record and the status line. Synthetic data directories only; the clock and the loop are injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createMemoryDb, turnReadRows } from '../src/memory/db/service.js';
import { syncOnce } from '../src/memory/db/sync.js';
import { openMemoryDb } from '../src/memory/db/open.js';
import { memoryDbStatusLine } from '../src/ops/status.js';
import { CHANNEL, GUILD, HOT_ITEM, MEMBER, buildDataDir, guildDir, writeJson } from './fixtures/memory-db/datadir.js';

const tmpRoot = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-svc-'));

function logs() {
  const out = [];
  const add = (level) => (message, fields) => out.push({ level, message, ...fields });
  return { out, info: add('info'), warn: add('warn'), error: add('error'), debug: add('debug') };
}

/** A data directory, a switchable config and a service whose loop is stepped by hand when `manual` is set. */
function setup({ features = { memoryDb: true }, memoryDb = {}, manual = false, ...rest } = {}) {
  // These tests drive the passes on the calling thread; tests/memory-db-worker.test.js covers the worker.
  const root = tmpRoot();
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  buildDataDir(data);
  const hot = { config: { features, memoryDb: { syncSeconds: 60, ...memoryDb } } };
  const log = logs();
  const queue = [];
  let time = Date.UTC(2026, 9, 24, 12, 0, 0);
  const service = createMemoryDb({
    hot, dataDir: data, log, worker: false, now: () => time, defer: manual ? (fn) => queue.push(fn) : (fn) => setImmediate(fn), ...rest,
  });
  const dbFile = () => path.join(data, 'memory.db');
  return {
    root, data, hot, log, service, queue, dbFile, g: guildDir(data),
    advance: (ms) => { time += ms; },
    flushQueue: async () => { while (queue.length) { queue.shift()(); await new Promise((resolve) => setImmediate(resolve)); } },
    done: async () => { await service.close().catch(() => {}); fs.rmSync(root, { recursive: true, force: true }); },
  };
}

const counts = (env) => {
  const reader = openMemoryDb(env.dbFile(), { readOnly: true });
  try { return Object.fromEntries(['files', 'sources', 'claims', 'turn_reads'].map((t) => [t, reader.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n])); } finally { reader.close(); }
};

test('the switch: off opens nothing, on opens the database and imports, off again closes it and frees the lock', async () => {
  const env = setup({ features: { memoryDb: false } });
  try {
    await env.service.tick();
    assert.equal(fs.existsSync(env.dbFile()), false);
    assert.equal(env.service.status().open, false);
    env.hot.config.features.memoryDb = true;
    await env.service.tick();
    assert.equal(env.service.status().open, true);
    assert.equal(env.service.status().importDone, true);
    assert.ok(fs.existsSync(`${env.dbFile()}.lock`));
    assert.ok(counts(env).files > 5);
    env.hot.config.features.memoryDb = false;
    await env.service.tick();
    assert.equal(env.service.status().open, false);
    assert.equal(fs.existsSync(`${env.dbFile()}.lock`), false);
  } finally { await env.done(); }
});

test('the first pass is sliced: several syncOnce calls, the loop given back between them, the import marked done', async () => {
  const calls = [];
  const sync = (handle, dataDir, opts) => { calls.push(Object.keys(opts)); return syncOnce(handle, dataDir, opts); };
  let yields = 0;
  const env = setup({ sync, defer: (fn) => { yields += 1; setImmediate(fn); }, clock: () => 0 });
  try {
    await env.service.tick();
    assert.ok(calls.length >= 3, `the import went in ${calls.length} slices`);
    assert.ok(calls.every((keys) => keys.includes('filter')));
    assert.ok(yields >= calls.length, 'the loop is given back after each slice');
    assert.equal(env.service.status().lastPass.first, true);
    assert.ok(env.service.status().lastPass.slices >= 3);
    calls.length = 0;
    env.advance(61_000);
    await env.service.tick();
    assert.equal(calls.length, 1, 'later passes are one syncOnce');
    assert.equal(calls[0].includes('filter'), false);
    assert.equal(env.service.status().lastPass.first, false);
  } finally { await env.done(); }
});

test('the sliced import equals a whole pass: the same rows', async () => {
  const sliced = setup();
  const whole = setup();
  try {
    await sliced.service.tick();
    const handle = openMemoryDb(path.join(whole.root, 'whole.db'));
    syncOnce(handle, whole.data);
    const a = openMemoryDb(sliced.dbFile(), { readOnly: true });
    try {
      for (const table of ['files', 'sources', 'claims', 'episodes', 'vectors', 'operational', 'day', 'diary', 'descriptions']) {
        const rowsOf = (db) => db.prepare(`SELECT COUNT(*) AS n FROM ${table}`).get().n;
        assert.equal(rowsOf(a.db), rowsOf(handle.db), table);
      }
    } finally { a.close(); handle.close(); }
  } finally { await sliced.done(); await whole.done(); }
});

test('a slice grows while the last one was quick and drops to one unit when it was slow', async () => {
  const sizes = [];
  let time = 0;
  const sync = (handle, dataDir, opts) => {
    const result = syncOnce(handle, dataDir, opts);
    sizes.push(result.seen);
    time += sizes.length <= 2 ? 0 : 1_000_000;
    return result;
  };
  const env = setup({ sync, clock: () => time });
  try {
    await env.service.tick();
    assert.ok(sizes[1] > sizes[0], `quick slices grow: ${sizes.slice(0, 3)}`);
    assert.ok(sizes[2] > sizes[1]);
    assert.equal(sizes[3], 1, 'a slow slice leaves room for one unit only');
  } finally { await env.done(); }
});

test('a pass never runs concurrently with itself', async () => {
  let active = 0;
  let peak = 0;
  const sync = (handle, dataDir, opts) => {
    active += 1; peak = Math.max(peak, active);
    try { return syncOnce(handle, dataDir, opts); } finally { active -= 1; }
  };
  const env = setup({ sync });
  try {
    await Promise.all([env.service.tick(), env.service.tick(), env.service.tick()]);
    env.service.requestSync();
    env.service.requestSync();
    await new Promise((resolve) => setTimeout(resolve, 100));
    assert.equal(peak, 1);
  } finally { await env.done(); }
});

test('requestSync runs a pass off the caller, soon; a pass is also due after syncSeconds', async () => {
  const env = setup({ manual: true });
  try {
    const first = env.service.tick();
    while (env.queue.length) { env.queue.shift()(); await new Promise((resolve) => setImmediate(resolve)); }
    await first;
    const before = counts(env);
    writeJson(path.join(env.g, 'users', '100000000000000077.json'), { id: '100000000000000077', names: ['Zed'] });
    env.service.requestSync();
    assert.equal(counts(env).files, before.files, 'nothing ran on the caller');
    assert.equal(env.queue.length, 1, 'one deferred tick');
    await env.flushQueue();
    await new Promise((resolve) => setTimeout(resolve, 50));
    assert.equal(counts(env).files, before.files + 1);
    // Within syncSeconds and not dirty: no pass.
    const passes = env.log.out.filter((e) => e.message === 'memory db: pass').length;
    await env.service.tick();
    assert.equal(env.log.out.filter((e) => e.message === 'memory db: pass').length, passes);
    env.advance(61_000);
    await env.service.tick();
    assert.equal(env.log.out.filter((e) => e.message === 'memory db: pass').length, passes + 1);
  } finally { await env.done(); }
});

test('a pass logs counts at debug and nothing at info; a failing pass warns with a code only and is retried', async () => {
  let fail = true;
  const sync = (handle, dataDir, opts) => {
    if (fail) throw Object.assign(new Error('secret path /x/y'), { code: 'EIO' });
    return syncOnce(handle, dataDir, opts);
  };
  const env = setup({ sync });
  try {
    await env.service.tick();
    const warn = env.log.out.find((e) => e.message === 'memory db: pass failed');
    assert.deepEqual(Object.keys(warn).sort(), ['code', 'level', 'message', 'reason']);
    assert.equal(warn.code, 'EIO');
    assert.equal(env.service.status().lastSyncAt, null);
    fail = false;
    await env.service.tick();
    assert.ok(env.service.status().lastSyncAt !== null, 'the next tick retried');
    const debug = env.log.out.find((e) => e.level === 'debug' && e.message === 'memory db: pass');
    assert.ok(debug && Number.isInteger(debug.seen) && Number.isInteger(debug.upserted));
    assert.equal(env.log.out.filter((e) => e.level === 'info' && /pass/.test(e.message)).length, 0);
  } finally { await env.done(); }
});

test('a locked database is not an error of the bot: one warning with a code, retried at the next tick', async () => {
  const env = setup();
  const holder = openMemoryDb(env.dbFile());
  try {
    await env.service.tick();
    await env.service.tick();
    assert.equal(env.service.status().open, false);
    assert.equal(env.log.out.filter((e) => e.message === 'memory db: open failed').length, 1);
    holder.close();
    await env.service.tick();
    assert.equal(env.service.status().open, true);
  } finally { try { holder.close(); } catch { /* closed */ } await env.done(); }
});

test('close: a last pass picks up what the last flush wrote, then the lock is released', async () => {
  const env = setup();
  try {
    await env.service.tick();
    const before = counts(env);
    writeJson(path.join(env.g, 'users', '100000000000000088.json'), { id: '100000000000000088', names: ['Late'] });
    await env.service.close();
    assert.equal(fs.existsSync(`${env.dbFile()}.lock`), false);
    assert.equal(counts(env).files, before.files + 1);
    assert.equal(env.service.status().open, false);
  } finally { await env.done(); }
});

test('close during the first import stops the slices and leaves the import to the next start', async () => {
  const env = setup({ manual: true });
  try {
    const first = env.service.tick();
    for (let i = 0; i < 1 && env.queue.length; i += 1) { env.queue.shift()(); await new Promise((resolve) => setImmediate(resolve)); }
    const closing = env.service.close();
    while (env.queue.length) { env.queue.shift()(); await new Promise((resolve) => setImmediate(resolve)); }
    await Promise.all([first, closing]);
    assert.equal(fs.existsSync(`${env.dbFile()}.lock`), false);
    const reader = openMemoryDb(env.dbFile(), { readOnly: true });
    try { assert.equal(reader.db.prepare("SELECT value FROM meta WHERE key = 'service_import_done'").get(), undefined); } finally { reader.close(); }
    // The next start takes the import up again, to the same rows.
    const again = createMemoryDb({ hot: env.hot, dataDir: env.data, log: env.log, now: () => 1 });
    await again.tick();
    assert.equal(again.status().importDone, true);
    await again.close();
  } finally { await env.done(); }
});

test('turn reads: one deduplicated insert per step, rows resolved against the database', async () => {
  const env = setup();
  try {
    await env.service.tick();
    env.service.recordTurnReads({
      turnId: 'turn-9', guildId: GUILD,
      reads: [
        { kind: 'claim', id: HOT_ITEM }, { kind: 'claim', id: HOT_ITEM }, { kind: 'episode', id: 'ep-1' },
        { kind: 'channel', id: CHANNEL }, { kind: 'guild_note', id: 'patterns' }, { kind: 'lore', id: 'l1' },
        { kind: 'source', id: '400000000000000002' }, { kind: 'source', id: 'no-such-message' },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const reader = openMemoryDb(env.dbFile(), { readOnly: true });
    try {
      const rows = reader.db.prepare('SELECT step, row_kind, row_id FROM turn_reads WHERE turn_id = ? ORDER BY row_kind, row_id').all('turn-9').map((r) => ({ ...r }));
      assert.deepEqual(rows.map((r) => r.step), rows.map(() => 's0'));
      assert.deepEqual(rows.map((r) => r.row_kind).sort(), ['claims', 'descriptions', 'claims', 'episodes', 'places', 'sources'].sort());
      assert.ok(rows.some((r) => r.row_kind === 'places' && r.row_id === `discord:channel:${CHANNEL}`));
      assert.ok(rows.some((r) => r.row_kind === 'sources' && /^src:discord:400000000000000002:/.test(r.row_id)));
      assert.equal(rows.filter((r) => r.row_id === HOT_ITEM).length, 1);
    } finally { reader.close(); }
  } finally { await env.done(); }
});

test('turn reads are resolved when the request is assembled: block, order and the exact versions, whatever is written before the deferred insert', async () => {
  const env = setup({ manual: true });
  let writer = null;
  try {
    const first = env.service.tick();
    while (env.queue.length) { env.queue.shift()(); await new Promise((resolve) => setImmediate(resolve)); }
    await first;
    writer = new DatabaseSync(env.dbFile());
    writer.exec('PRAGMA busy_timeout = 5000');
    writer.prepare("INSERT INTO claim_versions (id, claim_id, text, recorded_at, event, by, origin) VALUES ('cv-early', ?, 'early', '2099-06-01T00:00:00.000Z', 'add', 'her', 'session')").run(HOT_ITEM);
    env.service.recordTurnReads({
      turnId: 'turn-A', step: 's1',
      reads: [{ kind: 'claim', id: HOT_ITEM, block: 'people', ord: 4 }, { kind: 'source', id: '400000000000000002', block: 'retrieved', ord: 9 }],
    });
    // the sync, or her session, writes a newer version before the deferred insert runs
    writer.prepare("INSERT INTO claim_versions (id, claim_id, text, recorded_at, event, by, origin) VALUES ('cv-late', ?, 'late', '2099-12-31T00:00:00.000Z', 'revise', 'her', 'session')").run(HOT_ITEM);
    writer.close();
    writer = null;
    await env.flushQueue();
    const reader = openMemoryDb(env.dbFile(), { readOnly: true });
    try {
      const rows = reader.db.prepare('SELECT row_kind, row_id, block, ord, version_id, revision FROM turn_reads WHERE turn_id = ? ORDER BY ord').all('turn-A').map((row) => ({ ...row }));
      assert.equal(rows.length, 2);
      assert.deepEqual([rows[0].row_kind, rows[0].row_id, rows[0].block, rows[0].ord, rows[0].version_id, rows[0].revision], ['claims', HOT_ITEM, 'people', 4, 'cv-early', null], 'the version the request was built from, not the newest one');
      assert.deepEqual([rows[1].row_kind, rows[1].block, rows[1].ord, rows[1].version_id], ['sources', 'retrieved', 9, null]);
      assert.ok(Number.isInteger(rows[1].revision) && rows[1].revision >= 1);
    } finally { reader.close(); }
  } finally { writer?.close(); await env.done(); }
});

test('authority db: the sync is off (ticks, flushes and the shutdown pass), the status says so, and a switch back to json syncs again', async () => {
  const env = setup();
  try {
    await env.service.tick();
    const before = counts(env);
    assert.ok(before.files > 0);
    assert.deepEqual([env.service.status().authority, env.service.status().syncOff], ['json', false]);
    env.hot.config.memoryDb.authority = 'db';
    const passes = () => env.log.out.filter((e) => e.message === 'memory db: pass').length;
    const ran = passes();
    writeJson(path.join(env.g, 'users', '100000000000000077.json'), { id: '100000000000000077', names: ['Zed'] });
    env.service.requestSync();
    await new Promise((resolve) => setTimeout(resolve, 50));
    env.advance(300_000);
    await env.service.tick();
    assert.equal(passes(), ran, 'no pass');
    assert.equal(counts(env).files, before.files);
    const status = env.service.status();
    assert.deepEqual([status.authority, status.syncOff, status.lagSeconds, status.open], ['db', true, null, true]);
    // back to json: the database is dirty and catches up
    env.hot.config.memoryDb.authority = 'json';
    await env.service.tick();
    assert.equal(counts(env).files, before.files + 1);
    // db again: the shutdown pass is off too
    env.hot.config.memoryDb.authority = 'db';
    writeJson(path.join(env.g, 'users', '100000000000000078.json'), { id: '100000000000000078', names: ['Yan'] });
    await env.service.close();
    assert.equal(counts(env).files, before.files + 1, 'the last pass did not run');
  } finally { await env.done(); }
});

test('authority db from the first open: nothing is imported, the database counts as in step, no pass is ever run', async () => {
  const env = setup({ memoryDb: { authority: 'db' } });
  try {
    await env.service.tick();
    await env.service.tick();
    const status = env.service.status();
    assert.deepEqual([status.open, status.syncOff, status.lastPass, status.lagSeconds], [true, true, null, null]);
    assert.equal(env.log.out.filter((e) => e.message === 'memory db: pass').length, 0);
    assert.equal(counts(env).files, 0);
  } finally { await env.done(); }
});

test('memoryWrite: the service stamps the authority of the live config; the caller cannot claim it', async () => {
  const env = setup();
  try {
    await env.service.tick();
    const run = { id: 'run:svc', sweepId: 'sweep:svc', scopeKey: 'group:discord', scope: { scope_kind: 'group', scope_iface: 'discord', scope_dm: null }, batchKey: 'apply|svc', startedAt: '2026-10-24T12:00:00.000Z', finishedAt: '2026-10-24T12:00:00.000Z', outcome: 'ok', counts: {}, errors: [] };
    const plan = { claims: [], episodes: [], affinity: [], descriptions: [] };
    await assert.rejects(() => env.service.memoryWrite({ kind: 'session', mode: 'apply', authority: 'db', run, plan, now: 1 }), (error) => error.code === 'APPLY_JSON_WRITER');
    assert.equal(env.service.database().prepare('SELECT COUNT(*) AS n FROM session_runs').get().n, 0);
    env.hot.config.memoryDb.authority = 'db';
    await env.service.memoryWrite({ kind: 'session', mode: 'apply', authority: 'json', run, plan, now: 1 });
    assert.deepEqual({ ...env.service.database().prepare('SELECT mode, applied FROM session_runs').get() }, { mode: 'apply', applied: 1 });
    await assert.rejects(() => env.service.memoryWrite({ kind: 'session', mode: 'other', run: { ...run, id: 'run:2' }, plan, now: 1 }), (error) => error.code === 'BAD_MODE');
  } finally { await env.done(); }
});

test('status line: while the database is the writer the sync-off line replaces the sync line, when its label is filled', () => {
  const status = { on: true, open: true, rows: 7, files: 3, lastSyncAt: Date.UTC(2026, 9, 24, 12), lagSeconds: null, read: true, reads: {}, syncOff: true };
  const labels = { status: { memoryDb: { line: 'rows {rows}', syncOff: 'OFF {rows} {files}', readOn: 'on', readOff: 'off' } } };
  assert.equal(memoryDbStatusLine(status, labels), 'OFF 7 3');
  assert.equal(memoryDbStatusLine(status, { status: { memoryDb: { ...labels.status.memoryDb, syncOff: '' } } }), 'rows 7', 'a label not filled yet leaves the usual line');
  assert.equal(memoryDbStatusLine({ ...status, syncOff: false }, labels), 'rows 7');
});

test('turn reads: nothing without the switch, the setting, a turn id or reads', async () => {
  const env = setup({ memoryDb: { turnReads: false } });
  try {
    await env.service.tick();
    env.service.recordTurnReads({ turnId: 't', reads: [{ kind: 'claim', id: 'x' }] });
    env.hot.config.memoryDb.turnReads = true;
    env.service.recordTurnReads({ turnId: '', reads: [{ kind: 'claim', id: 'x' }] });
    env.service.recordTurnReads({ turnId: 't', reads: [] });
    env.hot.config.features.memoryDb = false;
    env.service.recordTurnReads({ turnId: 't', reads: [{ kind: 'claim', id: 'x' }] });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(counts(env).turn_reads, 0);
  } finally { await env.done(); }
});

test('turnReadRows: a guild note needs the guild; unknown kinds are ignored', () => {
  const handle = openMemoryDb(':memory:');
  try {
    assert.deepEqual(turnReadRows(handle.db, [{ kind: 'guild_note', id: 'patterns' }, { kind: 'mystery', id: 'x' }, { kind: 'claim' }]), []);
    assert.deepEqual(turnReadRows(handle.db, [{ kind: 'guild_note', id: 'starters', block: 'about_chat', ord: 2 }], { guildId: '5' }), [
      { row_kind: 'descriptions', row_id: 'desc:discord:guild:5:starters', block: 'about_chat', ord: 2, version_id: null, revision: null },
    ]);
    // the exact version of a description or a claim, the revision of a source, resolved now
    handle.db.prepare("INSERT INTO descriptions (id, subject_kind, subject_id, field, current_version) VALUES ('desc:discord:guild:5:starters', 'place', 'discord:guild:5', 'starters', 'dv-1')").run();
    handle.db.prepare("INSERT INTO claim_versions (id, claim_id, text, recorded_at) VALUES ('cv-1', 'c1', 'a', '2026-10-01'), ('cv-2', 'c1', 'b', '2026-10-02')").run();
    handle.db.prepare("INSERT INTO sources (id, kind, native_id, revision) VALUES ('src:discord:m1:3:seen', 'seen', 'm1', 3)").run();
    const rows = turnReadRows(handle.db, [{ kind: 'guild_note', id: 'starters' }, { kind: 'claim', id: 'c1' }, { kind: 'source', id: 'm1' }], { guildId: '5' });
    assert.deepEqual(rows.map((row) => [row.row_kind, row.version_id, row.revision, row.ord]), [['descriptions', 'dv-1', null, 1], ['claims', 'cv-2', null, 2], ['sources', null, 3, 3]]);
  } finally { handle.close(); }
});

test('status: the state of the database for the card, and its line from the labels', async () => {
  const env = setup();
  try {
    assert.equal(env.service.status().open, false);
    await env.service.tick();
    const status = env.service.status();
    assert.equal(status.on, true);
    assert.ok(status.rows > 0 && status.files > 0);
    assert.equal(status.read, false);
    assert.equal(status.lagSeconds, 0);
    const labels = { status: { memoryDb: { off: 'OFF', unavailable: 'DOWN', notSynced: 'NEW {files}', line: 'rows {rows} files {files} at {at} lag {lag} read {read} fallbacks {fallbacks}', readOn: 'on', readOff: 'off' } } };
    assert.match(memoryDbStatusLine(status, labels, Date.now()), /^rows \d+ files \d+ at 2026-10-24 12:00 UTC lag 0 read off fallbacks 0$/);
    assert.equal(memoryDbStatusLine({ on: false }, labels), 'OFF');
    assert.equal(memoryDbStatusLine({ on: true, open: false }, labels), 'DOWN');
    assert.equal(memoryDbStatusLine({ on: true, open: true, lastSyncAt: null, files: 3 }, labels), 'NEW 3');
    // A label the writer has not filled yet leaves the line out.
    assert.equal(memoryDbStatusLine(status, { status: { memoryDb: { line: '' } } }), null);
    assert.equal(memoryDbStatusLine(status, {}), null);
  } finally { await env.done(); }
});

test('a logger without debug (the engine logger has none): passes succeed and warn about nothing', async () => {
  const env = setup();
  delete env.log.debug;
  try {
    await env.service.tick();
    env.advance(61_000);
    await env.service.tick();
    assert.deepEqual(env.log.out.filter((line) => line.level === 'warn'), []);
    assert.notEqual(env.service.status().lastPass?.failed, true);
  } finally {
    await env.done();
  }
});

test('issued contexts: recorded while the database is open, a pure object when it is not; turn reads carry the context id', async () => {
  const closed = setup({ features: { memoryDb: false } });
  try {
    const ctx = closed.service.issueContext({ kind: 'group' });
    assert.match(ctx.id, /^ctx:/);
    assert.deepEqual([ctx.kind, ctx.iface, ctx.mode, ctx.audienceColumn], ['group', 'discord', 'outward', undefined]);
  } finally { await closed.done(); }
  const env = setup({ manual: true, memoryDb: { audienceColumn: true } });
  try {
    const first = env.service.tick();
    await env.flushQueue();
    await first;
    const ctx = env.service.issueContext({ kind: 'dm', person: `person:discord:${MEMBER}` });
    assert.deepEqual([ctx.place, ctx.audienceColumn, ctx.issuedAt], [`discord:dm:${MEMBER}`, true, new Date(Date.UTC(2026, 9, 24, 12, 0, 0)).toISOString()]);
    env.service.recordTurnReads({ turnId: 'turn-C', contextId: ctx.id, reads: [{ kind: 'claim', id: HOT_ITEM, block: 'people', ord: 1 }] });
    await env.flushQueue();
    const reader = openMemoryDb(env.dbFile(), { readOnly: true });
    try {
      const row = { ...reader.db.prepare('SELECT * FROM execution_contexts WHERE id = ?').get(ctx.id) };
      assert.deepEqual([row.mode, row.iface, row.destination_place_id, row.partner_person_id], ['outward', 'discord', `discord:dm:${MEMBER}`, `person:discord:${MEMBER}`]);
      const read = { ...reader.db.prepare("SELECT context_id, reader_kind FROM turn_reads WHERE turn_id = 'turn-C'").get() };
      assert.deepEqual(read, { context_id: ctx.id, reader_kind: 'turn' });
    } finally { reader.close(); }
  } finally { await env.done(); }
});
