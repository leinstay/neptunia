// The memory database's writer thread (src/memory/db/writer-worker.ts through src/memory/db/service.ts): its writes
// equal the in-thread ones, the main thread reads through its own read-only connection, a crashed worker is restarted
// at the next tick, and shutdown waits for a write under way (bounded) before it terminates the worker. Synthetic data
// only.
import { legacyServerPlaceId } from '../src/memory/migration/paths.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { pathToFileURL } from 'node:url';
import { createMemoryDb } from '../src/memory/db/service.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { CHANNEL, GUILD, MEMBER, buildDataDir } from './fixtures/memory-db/datadir.ts';
import { unitUpdates } from './fixtures/memory-db/seed.ts';
import { dbOf, type Db } from '../src/memory/db/types.ts';
import {} from '../src/memory/db/ids.ts';
import { listUnits } from '../src/memory/db/storage-units.ts';

const tmpRoot = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-worker-'));
const REAL_WORKER = pathToFileURL(path.resolve('src/memory/db/writer-worker.ts')).href;

function logs() {
  const out: Array<Record<string, unknown>> = [];
  const add = (level: string) => (message: string, fields?: object) => out.push({ level, message, ...fields });
  return { out, info: add('info'), warn: add('warn'), error: add('error'), debug: add('debug') };
}

/**
 * A data directory and a service. `fake` names a behaviour for a stand-in worker that wraps the real one: it reads
 * `<root>/mode` at each write message (`crash-once`, `slow`, `hang`) before the real handlers see the message.
 */
function setup({
  memoryDb = {},
  fake = false,
  ...rest
}: { memoryDb?: Record<string, unknown>; fake?: boolean; options?: Record<string, unknown> } = {}) {
  const root = tmpRoot();
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  buildDataDir(data);
  let workerFile: URL | undefined;
  if (fake) {
    workerFile = pathToFileURL(path.join(root, 'fake-worker.mjs'));
    fs.writeFileSync(
      workerFile,
      `
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
`
    );
  }
  const hot = { config: { memoryDb: { session: { mode: 'off' }, ...memoryDb } } };
  const log = logs();
  let time = Date.UTC(2026, 9, 24, 12, 0, 0);
  const service = createMemoryDb({
    hot,
    dataDir: data,
    log,
    now: () => time,
    ...(fake ? { workerFile } : {}),
    ...rest.options,
  });
  return {
    root,
    data,
    hot,
    log,
    service,
    dbFile: () => path.join(data, 'memory.db'),
    mode: (value: string) => fs.writeFileSync(path.join(root, 'mode'), value),
    advance: (ms: number) => {
      time += ms;
    },
    done: async () => {
      await service.close().catch(() => {});
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

/** A profile unit of a new member. */
const profile = (id: string, name: string) => ({
  op: 'value',
  owner: `guilds/${GUILD}/users/${id}.json`,
  value: { id, names: [name] },
});
const profileRows = (db: Db, id: string) =>
  db.prepare('SELECT COUNT(*) AS n FROM files WHERE path = ?').get(`guilds/${GUILD}/users/${id}.json`)!.n;

const tables = (db: Db) =>
  db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '%_fts%' ORDER BY name"
    )
    .all()
    .map((row) => row.name as string);
const MINTED_UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/g;
const MINTED_HASH = /\b[0-9a-f]{32}\b/g;
const dumpAll = (file: string) => {
  const reader = openMemoryDb(file, { readOnly: true });
  try {
    return Object.fromEntries(
      tables(dbOf(reader)).map((table) => [
        table,
        dbOf(reader)
          .prepare(`SELECT * FROM "${table}"`)
          .all()
          .map((row) => JSON.stringify(row, (_, v) => (typeof v === 'bigint' ? String(v) : v)))
          // The meta-person of an account no row holds is minted with a random uuid on each database, and the graph's
          // ids hash it, so both are named alike before the rows are compared.
          .map((text) => text.replace(MINTED_UUID, 'minted-uuid').replace(MINTED_HASH, 'minted-hash'))
          .sort(),
      ])
    );
  } finally {
    reader.close();
  }
};
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

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
  } finally {
    await threaded.done();
    await inline.done();
  }
});

test('the worker holds the writer lock; the main thread reads through its own read-only connection', async () => {
  const env = setup();
  try {
    await env.service.tick();
    assert.ok(fs.existsSync(`${env.dbFile()}.lock`));
    assert.equal(JSON.parse(fs.readFileSync(`${env.dbFile()}.lock`, 'utf8')).pid, process.pid);
    assert.throws(
      () => openMemoryDb(env.dbFile(), { pid: process.pid + 1 }),
      /locked by pid/,
      'a second writer is refused'
    );
    assert.equal(env.service.status().open, true);
    // A write through the worker is seen by the main thread's reader.
    await env.service.writeUnit(profile('100000000000000077', 'Zed'));
    assert.equal(profileRows(dbOf(env.service.readHandle()!), '100000000000000077'), 1);
    await env.service.close();
    assert.equal(fs.existsSync(`${env.dbFile()}.lock`), false);
  } finally {
    await env.done();
  }
});

/**
 * The row of the fixture's channel, keyed as an observation keys it, over a plain connection beside the service's: a
 * channel read names the place its row holds.
 */
function channelRow(file: string): void {
  const connection = new DatabaseSync(file, { timeout: 5000 });
  try {
    connection
      .prepare(
        `INSERT OR IGNORE INTO places (id, iface, kind, native_id, native_key, authority_id, generation, chat, scope_kind)
         VALUES (?, 'discord', 'channel', ?, ?, 'discord/global', 1, 'group', 'group')`
      )
      .run(`discord:channel:${CHANNEL}`, CHANNEL, `channel:${CHANNEL}`);
  } finally {
    connection.close();
  }
}

test('turn reads are written by the worker and counted at debug', async () => {
  const env = setup();
  try {
    await env.service.tick();
    channelRow(env.dbFile());
    env.service.recordTurnReads({
      turnId: 'turn-9',
      step: 's0',
      reads: [
        { kind: 'channel', id: CHANNEL, block: 'server', ord: 3 },
        { kind: 'claim', id: 'no-such-claim', block: 'people', ord: 1 },
      ],
    });
    await env.service.close();
    const reader = openMemoryDb(env.dbFile(), { readOnly: true });
    try {
      const rows = dbOf(reader)
        .prepare('SELECT turn_id, step, row_kind, block, ord FROM turn_reads')
        .all()
        .map((row) => ({ ...row }));
      assert.deepEqual(
        rows
          .filter((row) => row.turn_id === 'turn-9')
          .map((row) => row.row_kind)
          .sort(),
        ['claims', 'places']
      );
      assert.deepEqual(
        rows
          .filter((row) => row.turn_id === 'turn-9')
          .map((row) => [row.row_kind, row.block, row.ord])
          .sort(),
        [
          ['claims', 'people', 1],
          ['places', 'server', 3],
        ],
        'resolved on the main thread, written by the worker'
      );
    } finally {
      reader.close();
    }
  } finally {
    await env.done();
  }
});

test('a crashed worker is logged with a code, its write fails, and the next tick starts a new one that takes the lock over', async () => {
  const env = setup({ fake: true });
  try {
    await env.service.tick();
    env.mode('crash-once');
    await assert.rejects(
      () => env.service.writeUnit(profile('100000000000000078', 'Yan')),
      (error: NodeJS.ErrnoException) => error.code === 'WORKER_EXIT'
    );
    const exited = env.log.out.find((e) => e.message === 'memory db: worker exited');
    assert.deepEqual([exited?.code, exited?.exit], ['WORKER_EXIT', 3]);
    // The lock the dead worker held is still there, with this process's pid; the new worker takes it over.
    env.advance(1000);
    await env.service.tick();
    assert.equal(env.log.out.filter((e) => e.message === 'memory db: opened').length, 2, 'a second worker was opened');
    await env.service.writeUnit(profile('100000000000000078', 'Yan'));
    assert.equal(profileRows(dbOf(env.service.readHandle()!), '100000000000000078'), 1, 'and its write ran');
  } finally {
    await env.done();
  }
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
    try {
      assert.equal(profileRows(dbOf(reader), '100000000000000079'), 1, 'its result is in the database');
    } finally {
      reader.close();
    }
  } finally {
    await env.done();
  }
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
    assert.equal(((await write) as { code?: string } | undefined)?.code, 'WORKER_EXIT');
    assert.equal(fs.existsSync(`${env.dbFile()}.lock`), false, 'the lock of a terminated worker is released');
    assert.equal(env.service.status().open, false);
    // Nothing is left running: the database opens again for a writer.
    const again = openMemoryDb(env.dbFile());
    again.close();
  } finally {
    await env.done();
  }
});

test('a memory session write goes through the worker', async () => {
  const run = {
    id: 'run:w',
    sweepId: 'sweep:w',
    scopeKey: 'group:discord',
    scope: { scope_kind: 'group', scope_iface: 'discord', scope_dm: null },
    batchKey: 'apply|w',
    startedAt: '2026-10-24T12:00:00.000Z',
    finishedAt: '2026-10-24T12:00:00.000Z',
    outcome: 'ok',
    counts: {},
    errors: [],
  };
  const update = {
    kind: 'session',
    mode: 'apply',
    run,
    plan: { claims: [], episodes: [], affinity: [], descriptions: [] },
    now: 1,
  };
  const db = setup();
  try {
    await db.service.tick();
    await db.service.memoryWrite(update);
    await db.service.close();
    const reader = openMemoryDb(db.dbFile(), { readOnly: true });
    try {
      assert.equal(dbOf(reader).prepare('SELECT COUNT(*) AS n FROM session_runs WHERE applied = 1').get()!.n, 1);
    } finally {
      reader.close();
    }
  } finally {
    await db.done();
  }
});

test('worker: the unit writers and the observation write through the worker (buffers cross the thread)', async () => {
  const env = setup();
  const owner = `guilds/${GUILD}/record/2026-11/2026-11-03.jsonl`;
  const month = `guilds/${GUILD}/vectors/2026-11`;
  try {
    await env.service.tick();
    const envelope = {
      v: 1,
      iface: 'discord',
      authority: 'discord/global',
      native: { kind: 'message', key: '600000000000000001', subtype: 'seen', revision: 1 },
      place: { authority: 'discord/global', key: `channel:${CHANNEL}`, kind: 'channel', chat: 'group' },
      author: { kind: 'account', key: MEMBER, account_kind: 'user' },
      occurredAt: '2026-11-03T10:00:00.000Z',
      observedAt: '2026-11-03T10:00:00.000Z',
      text: 'Καλημέρα',
      mentions: [],
      direct: false,
      relations: [],
    };
    const observed = await env.service.observe(envelope, { placeId: legacyServerPlaceId('discord', GUILD) });
    // observe answers the stored-row shape; the test reads these two fields.
    const { ok, revision } = observed as { ok: boolean; revision: number };
    assert.deepEqual([ok, revision], [true, 1]);
    const line = {
      v: 1,
      id: 'r-w',
      kind: 'said',
      messageId: '600000000000000002',
      revision: 1,
      occurredAt: '2026-11-03T10:01:00.000Z',
      recordedAt: '2026-11-03T10:01:00.000Z',
      placeId: GUILD,
      scope: { channel: CHANNEL },
      replyTo: null,
      text: 'Γεια',
      media: [],
      mentions: [],
      turnId: 't-w',
      opId: 'op-w',
      participants: [],
      sourceMessageIds: ['600000000000000002'],
      origin: 'live',
    };
    assert.deepEqual(await env.service.writeUnit({ op: 'lines', owner, lines: [line] }), {
      written: 1,
      duplicates: 0,
      adopted: 0,
    });
    const meta =
      '{"row":0,"kind":"record","id":"600000000000000002","revision":1,"occurredAt":"2026-11-03T10:01:00.000Z","placeId":null,"by":null,"participants":[],"sourceIds":[],"scale":0.01,"norm":1}\n';
    const manifest = {
      v: 1,
      gen: 1,
      rows: 1,
      bytes: 4,
      metaBytes: Buffer.byteLength(meta),
      model: 'test/embedder',
      dims: 4,
      checksum: 'fnv1a32:00000000:00000000',
    };
    await env.service.writeUnit({
      op: 'vectors',
      owner: month,
      delta: { manifest, meta, i8: Buffer.from([1, 2, 3, 4]) },
    });
    const db = dbOf(env.service.readHandle()!);
    // Observation and record adoption share semantic ownership even when no legacy provenance path exists.
    const place = legacyServerPlaceId('discord', GUILD);
    const units = listUnits(db, {
      kind: 'record',
      subject: { type: 'place', id: place },
      partition: '2026-11-03',
    });
    assert.equal(units.length, 1);
    assert.deepEqual(
      db
        .prepare('SELECT kind, position FROM sources WHERE owner_key = ? ORDER BY position')
        .all(units[0].id)
        .map((row) => [row.kind, row.position]),
      [
        ['seen', 0],
        ['said', 1],
      ]
    );
    // A month of vectors is rows of its place (src/memory/db/line-vectors.ts), its bytes crossed the thread whole.
    assert.deepEqual(
      [...(db.prepare('SELECT bytes FROM vectors WHERE place_id = ?').get(place)!.bytes as Uint8Array)],
      [1, 2, 3, 4]
    );
  } finally {
    await env.done();
  }
});

test('a shutdown right after a turn writes its reads before the database closes, even when the deferred write has not run', async () => {
  const env = setup({ options: { defer: () => {} } });
  try {
    await env.service.tick();
    channelRow(env.dbFile());
    env.service.recordTurnReads({
      turnId: 'turn-10',
      step: 's0',
      reads: [{ kind: 'channel', id: CHANNEL, block: 'server', ord: 0 }],
    });
    await env.service.close();
    const reader = openMemoryDb(env.dbFile(), { readOnly: true });
    try {
      assert.deepEqual(
        dbOf(reader)
          .prepare("SELECT row_kind FROM turn_reads WHERE turn_id = 'turn-10'")
          .all()
          .map((row) => row.row_kind),
        ['places']
      );
    } finally {
      reader.close();
    }
  } finally {
    await env.done();
  }
});
