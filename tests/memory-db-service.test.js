// The memory database service (src/memory/db/service.js): the open and the writer lock, the shutdown, the per-turn
// record, the session writes and the status line. Synthetic data directories only; the clock and the loop are injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createMemoryDb, turnReadRows } from '../src/memory/db/service.js';
import { seedUnits } from './fixtures/memory-db/seed.js';
import { openMemoryDb } from '../src/memory/db/open.js';
import { memoryDbStatusLine } from '../src/tools/impl/status.ts';
import { CHANNEL, GUILD, HOT_ITEM, MEMBER, buildDataDir, guildDir } from './fixtures/memory-db/datadir.js';

const tmpRoot = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-svc-'));

function logs() {
  const out = [];
  const add = (level) => (message, fields) => out.push({ level, message, ...fields });
  return { out, info: add('info'), warn: add('warn'), error: add('error'), debug: add('debug') };
}

/** A data directory whose units are in its database, a config and a service whose loop is stepped by hand when `manual` is set. */
function setup({ memoryDb = {}, manual = false, ...rest } = {}) {
  // These tests run the service on the calling thread; tests/memory-db-worker.test.js covers the worker.
  const root = tmpRoot();
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  buildDataDir(data);
  const seeded = openMemoryDb(path.join(data, 'memory.db'));
  try {
    seedUnits(seeded, data, { now: Date.UTC(2026, 9, 24, 11, 0, 0) });
  } finally {
    seeded.close();
  }
  const hot = { config: { memoryDb: { session: { mode: 'off' }, ...memoryDb } } };
  const log = logs();
  const queue = [];
  let time = Date.UTC(2026, 9, 24, 12, 0, 0);
  const service = createMemoryDb({
    hot,
    dataDir: data,
    log,
    worker: false,
    now: () => time,
    defer: manual ? (fn) => queue.push(fn) : (fn) => setImmediate(fn),
    ...rest,
  });
  const dbFile = () => path.join(data, 'memory.db');
  return {
    root,
    data,
    hot,
    log,
    service,
    queue,
    dbFile,
    g: guildDir(data),
    advance: (ms) => {
      time += ms;
    },
    flushQueue: async () => {
      while (queue.length) {
        queue.shift()();
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
    done: async () => {
      await service.close().catch(() => {});
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

const counts = (env) => {
  const reader = openMemoryDb(env.dbFile(), { readOnly: true });
  try {
    return Object.fromEntries(
      ['files', 'sources', 'claims', 'turn_reads'].map((t) => [
        t,
        reader.db.prepare(`SELECT COUNT(*) AS n FROM ${t}`).get().n,
      ])
    );
  } finally {
    reader.close();
  }
};

test('the first tick opens the database and takes the writer lock; close frees it', async () => {
  const env = setup();
  try {
    assert.equal(env.service.status().open, false);
    assert.equal(env.service.readHandle(), null);
    await env.service.tick();
    assert.equal(env.service.status().open, true);
    assert.ok(fs.existsSync(`${env.dbFile()}.lock`));
    assert.ok(env.service.status().files > 5);
    await env.service.close();
    assert.equal(env.service.status().open, false);
    assert.equal(fs.existsSync(`${env.dbFile()}.lock`), false);
  } finally {
    await env.done();
  }
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
  } finally {
    try {
      holder.close();
    } catch {
      /* closed */
    }
    await env.done();
  }
});

test('close: a unit write under way lands, then the lock is released', async () => {
  const env = setup();
  try {
    await env.service.tick();
    const before = counts(env);
    const write = env.service.writeUnit({
      op: 'value',
      owner: `guilds/${GUILD}/users/100000000000000088.json`,
      value: { id: '100000000000000088', names: ['Late'] },
    });
    await env.service.close();
    await write;
    assert.equal(fs.existsSync(`${env.dbFile()}.lock`), false);
    assert.equal(counts(env).files, before.files + 1);
    assert.equal(env.service.status().open, false);
    await assert.rejects(
      () => env.service.writeUnit({ op: 'value', owner: `guilds/${GUILD}/lore.json`, value: [] }),
      (error) => error.code === 'DB_CLOSED'
    );
  } finally {
    await env.done();
  }
});

test('turn reads: one deduplicated insert per step, rows resolved against the database', async () => {
  const env = setup();
  try {
    await env.service.tick();
    env.service.recordTurnReads({
      turnId: 'turn-9',
      guildId: GUILD,
      reads: [
        { kind: 'claim', id: HOT_ITEM },
        { kind: 'claim', id: HOT_ITEM },
        { kind: 'episode', id: 'ep-1' },
        { kind: 'channel', id: CHANNEL },
        { kind: 'guild_note', id: 'patterns' },
        { kind: 'lore', id: 'l1' },
        { kind: 'source', id: '400000000000000002' },
        { kind: 'source', id: 'no-such-message' },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const reader = openMemoryDb(env.dbFile(), { readOnly: true });
    try {
      const rows = reader.db
        .prepare('SELECT step, row_kind, row_id FROM turn_reads WHERE turn_id = ? ORDER BY row_kind, row_id')
        .all('turn-9')
        .map((r) => ({ ...r }));
      assert.deepEqual(
        rows.map((r) => r.step),
        rows.map(() => 's0')
      );
      assert.deepEqual(
        rows.map((r) => r.row_kind).sort(),
        ['claims', 'descriptions', 'claims', 'episodes', 'places', 'sources'].sort()
      );
      assert.ok(rows.some((r) => r.row_kind === 'places' && r.row_id === `discord:channel:${CHANNEL}`));
      assert.ok(rows.some((r) => r.row_kind === 'sources' && /^src:discord:400000000000000002:/.test(r.row_id)));
      assert.equal(rows.filter((r) => r.row_id === HOT_ITEM).length, 1);
    } finally {
      reader.close();
    }
  } finally {
    await env.done();
  }
});

test('turn reads are resolved when the request is assembled: block, order and the exact versions, whatever is written before the deferred insert', async () => {
  const env = setup({ manual: true });
  let writer = null;
  try {
    const first = env.service.tick();
    while (env.queue.length) {
      env.queue.shift()();
      await new Promise((resolve) => setImmediate(resolve));
    }
    await first;
    writer = new DatabaseSync(env.dbFile());
    writer.exec('PRAGMA busy_timeout = 5000');
    writer
      .prepare(
        "INSERT INTO claim_versions (id, claim_id, text, recorded_at, event, by, origin) VALUES ('cv-early', ?, 'early', '2099-06-01T00:00:00.000Z', 'add', 'her', 'session')"
      )
      .run(HOT_ITEM);
    env.service.recordTurnReads({
      turnId: 'turn-A',
      step: 's1',
      reads: [
        { kind: 'claim', id: HOT_ITEM, block: 'people', ord: 4 },
        { kind: 'source', id: '400000000000000002', block: 'retrieved', ord: 9 },
      ],
    });
    // her session writes a newer version before the deferred insert runs
    writer
      .prepare(
        "INSERT INTO claim_versions (id, claim_id, text, recorded_at, event, by, origin) VALUES ('cv-late', ?, 'late', '2099-12-31T00:00:00.000Z', 'revise', 'her', 'session')"
      )
      .run(HOT_ITEM);
    writer.close();
    writer = null;
    await env.flushQueue();
    const reader = openMemoryDb(env.dbFile(), { readOnly: true });
    try {
      const rows = reader.db
        .prepare(
          'SELECT row_kind, row_id, block, ord, version_id, revision FROM turn_reads WHERE turn_id = ? ORDER BY ord'
        )
        .all('turn-A')
        .map((row) => ({ ...row }));
      assert.equal(rows.length, 2);
      assert.deepEqual(
        [rows[0].row_kind, rows[0].row_id, rows[0].block, rows[0].ord, rows[0].version_id, rows[0].revision],
        ['claims', HOT_ITEM, 'people', 4, 'cv-early', null],
        'the version the request was built from, not the newest one'
      );
      assert.deepEqual(
        [rows[1].row_kind, rows[1].block, rows[1].ord, rows[1].version_id],
        ['sources', 'retrieved', 9, null]
      );
      assert.ok(Number.isInteger(rows[1].revision) && rows[1].revision >= 1);
    } finally {
      reader.close();
    }
  } finally {
    writer?.close();
    await env.done();
  }
});

test('memoryWrite: a session apply is written; a mode the writer does not know is refused', async () => {
  const run = {
    id: 'run:svc',
    sweepId: 'sweep:svc',
    scopeKey: 'group:discord',
    scope: { scope_kind: 'group', scope_iface: 'discord', scope_dm: null },
    batchKey: 'apply|svc',
    startedAt: '2026-10-24T12:00:00.000Z',
    finishedAt: '2026-10-24T12:00:00.000Z',
    outcome: 'ok',
    counts: {},
    errors: [],
  };
  const plan = { claims: [], episodes: [], affinity: [], descriptions: [] };
  const db = setup();
  try {
    await db.service.tick();
    await db.service.memoryWrite({ kind: 'session', mode: 'apply', run, plan, now: 1 });
    assert.deepEqual(
      { ...db.service.readHandle().db.prepare('SELECT mode, applied FROM session_runs').get() },
      { mode: 'apply', applied: 1 }
    );
    await assert.rejects(
      () => db.service.memoryWrite({ kind: 'session', mode: 'other', run: { ...run, id: 'run:2' }, plan, now: 1 }),
      (error) => error.code === 'BAD_MODE'
    );
  } finally {
    await db.done();
  }
});

test('turn reads: nothing without the setting, a turn id or reads', async () => {
  const env = setup({ memoryDb: { turnReads: false } });
  try {
    await env.service.tick();
    env.service.recordTurnReads({ turnId: 't', reads: [{ kind: 'claim', id: 'x' }] });
    env.hot.config.memoryDb.turnReads = true;
    env.service.recordTurnReads({ turnId: '', reads: [{ kind: 'claim', id: 'x' }] });
    env.service.recordTurnReads({ turnId: 't', reads: [] });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(counts(env).turn_reads, 0);
  } finally {
    await env.done();
  }
});

test('turnReadRows: a guild note needs the guild; unknown kinds are ignored', () => {
  const handle = openMemoryDb(':memory:');
  try {
    assert.deepEqual(
      turnReadRows(handle.db, [
        { kind: 'guild_note', id: 'patterns' },
        { kind: 'mystery', id: 'x' },
        { kind: 'claim' },
      ]),
      []
    );
    assert.deepEqual(
      turnReadRows(handle.db, [{ kind: 'guild_note', id: 'starters', block: 'about_chat', ord: 2 }], { guildId: '5' }),
      [
        {
          row_kind: 'descriptions',
          row_id: 'desc:discord:guild:5:starters',
          block: 'about_chat',
          ord: 2,
          version_id: null,
          revision: null,
        },
      ]
    );
    // the exact version of a description or a claim, the revision of a source, resolved now
    handle.db
      .prepare(
        "INSERT INTO descriptions (id, subject_kind, subject_id, field, current_version) VALUES ('desc:discord:guild:5:starters', 'place', 'discord:guild:5', 'starters', 'dv-1')"
      )
      .run();
    handle.db
      .prepare(
        "INSERT INTO claim_versions (id, claim_id, text, recorded_at) VALUES ('cv-1', 'c1', 'a', '2026-10-01'), ('cv-2', 'c1', 'b', '2026-10-02')"
      )
      .run();
    handle.db
      .prepare(
        "INSERT INTO sources (id, kind, iface, native_id, revision, authority_id) VALUES ('src:discord:m1:3:seen', 'seen', 'discord', 'm1', 3, 'discord/global')"
      )
      .run();
    // the same native id on another interface is another message: never the one a Discord turn read
    handle.db
      .prepare(
        "INSERT INTO sources (id, kind, iface, native_id, revision, authority_id) VALUES ('src:telegram:m1:9:seen', 'seen', 'telegram', 'm1', 9, 'telegram/global')"
      )
      .run();
    const rows = turnReadRows(
      handle.db,
      [
        { kind: 'guild_note', id: 'starters' },
        { kind: 'claim', id: 'c1' },
        { kind: 'source', id: 'm1' },
      ],
      { guildId: '5' }
    );
    assert.deepEqual(
      rows.map((row) => [row.row_kind, row.version_id, row.revision, row.ord]),
      [
        ['descriptions', 'dv-1', null, 1],
        ['claims', 'cv-2', null, 2],
        ['sources', null, 3, 3],
      ]
    );
  } finally {
    handle.close();
  }
});

test('status: the state of the database for the card, and its line from the labels', async () => {
  const env = setup();
  try {
    const labels = { status: { memoryDb: { unavailable: 'DOWN', ok: 'rows {rows} files {files}' } } };
    assert.equal(env.service.status().open, false);
    assert.equal(memoryDbStatusLine(env.service.status(), labels), 'DOWN');
    await env.service.tick();
    const status = env.service.status();
    assert.equal(status.open, true);
    assert.ok(status.rows > 0 && status.files > 0);
    assert.equal(memoryDbStatusLine(status, labels), `rows ${status.rows} files ${status.files}`);
    // A label the writer has not filled yet leaves the line out.
    assert.equal(memoryDbStatusLine(status, { status: { memoryDb: { ok: '' } } }), null);
    assert.equal(memoryDbStatusLine(status, {}), null);
  } finally {
    await env.done();
  }
});

test('a logger without debug (the engine logger has none): ticks and turn reads warn about nothing', async () => {
  const env = setup();
  delete env.log.debug;
  try {
    await env.service.tick();
    env.service.recordTurnReads({ turnId: 'turn-D', reads: [{ kind: 'channel', id: CHANNEL }] });
    env.advance(61_000);
    await env.service.tick();
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.deepEqual(
      env.log.out.filter((line) => line.level === 'warn'),
      []
    );
  } finally {
    await env.done();
  }
});

test('issued contexts: recorded while the database is open, a pure object when it is not; turn reads carry the context id', async () => {
  const closed = setup();
  try {
    const ctx = closed.service.issueContext({ kind: 'group' });
    assert.match(ctx.id, /^ctx:/);
    assert.deepEqual([ctx.kind, ctx.iface, ctx.mode, ctx.audienceColumn], ['group', 'discord', 'outward', undefined]);
  } finally {
    await closed.done();
  }
  const env = setup({ manual: true, memoryDb: { audienceColumn: true } });
  try {
    const first = env.service.tick();
    await env.flushQueue();
    await first;
    const ctx = env.service.issueContext({ kind: 'dm', person: `person:discord:${MEMBER}` });
    assert.deepEqual(
      [ctx.place, ctx.audienceColumn, ctx.issuedAt],
      [`discord:dm:${MEMBER}`, true, new Date(Date.UTC(2026, 9, 24, 12, 0, 0)).toISOString()]
    );
    env.service.recordTurnReads({
      turnId: 'turn-C',
      contextId: ctx.id,
      reads: [{ kind: 'claim', id: HOT_ITEM, block: 'people', ord: 1 }],
    });
    await env.flushQueue();
    const reader = openMemoryDb(env.dbFile(), { readOnly: true });
    try {
      const row = { ...reader.db.prepare('SELECT * FROM execution_contexts WHERE id = ?').get(ctx.id) };
      assert.deepEqual(
        [row.mode, row.iface, row.destination_place_id, row.partner_person_id],
        ['outward', 'discord', `discord:dm:${MEMBER}`, `person:discord:${MEMBER}`]
      );
      const read = {
        ...reader.db.prepare("SELECT context_id, reader_kind FROM turn_reads WHERE turn_id = 'turn-C'").get(),
      };
      assert.deepEqual(read, { context_id: ctx.id, reader_kind: 'turn' });
    } finally {
      reader.close();
    }
  } finally {
    await env.done();
  }
});
