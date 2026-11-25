// The memory database's writer thread (src/memory/db/writer-worker.ts through src/memory/db/service.ts): its writes
// equal the in-thread ones, the main thread reads through its own read-only connection, a crashed worker is restarted
// at the next tick, and shutdown waits for a write under way (bounded) before it terminates the worker. Synthetic data
// only.
import { legacyServerPlaceId } from '../../../fixtures/memory-db/legacy-paths.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { createMemoryDb } from '../../../../src/memory/db/service.ts';
import { openMemoryDb } from '../../../../src/memory/db/open.ts';
import { CHANNEL, GUILD, MEMBER, buildDataDir } from '../../../fixtures/memory-db/datadir.ts';
import { unitUpdates } from '../../../fixtures/memory-db/seed.ts';
import { writeUnitUpdate } from '../../../fixtures/memory-db/unit-writes.ts';
import { dbOf, type Db } from '../../../../src/memory/db/types.ts';

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
    iface: () => 'discord',
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

test('the unit writes through the worker make the same database as on the calling thread', async () => {
  const threaded = setup();
  const inline = setup({ options: { worker: false } });
  try {
    await threaded.service.tick();
    await inline.service.tick();
    for (const update of unitUpdates(threaded.data)) {
      // One moment for both, so the rows they stamp compare equal.
      await writeUnitUpdate(threaded.service, { ...update, now: Date.UTC(2026, 9, 24, 12, 0, 0) });
      await writeUnitUpdate(inline.service, { ...update, now: Date.UTC(2026, 9, 24, 12, 0, 0) });
    }
    await threaded.service.close();
    await inline.service.close();
    const a = dumpAll(threaded.dbFile());
    const b = dumpAll(inline.dbFile());
    for (const table of Object.keys(b)) assert.deepEqual(a[table], b[table], table);
    assert.ok(a.claims.length + a.sources.length + a.operational.length > 5 && a.vectors.length === 2);
  } finally {
    await threaded.done();
    await inline.done();
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
  const file = `guilds/${GUILD}/record/2026-11/2026-11-03.jsonl`;
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
    assert.deepEqual(await writeUnitUpdate(env.service, { op: 'lines', file, lines: [line] }), {
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
    await writeUnitUpdate(env.service, {
      op: 'vectors',
      file: month,
      delta: { manifest, meta, i8: Buffer.from([1, 2, 3, 4]) },
    });
    const db = dbOf(env.service.readHandle()!);
    // Observation and record adoption share semantic ownership even when no legacy provenance path exists.
    const place = legacyServerPlaceId('discord', GUILD);
    assert.deepEqual(
      db
        .prepare(
          "SELECT kind, position FROM sources WHERE writer = 'record' AND holder_id = ? AND period = ? ORDER BY position"
        )
        .all(place, '2026-11-03')
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
