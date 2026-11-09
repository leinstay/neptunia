// The memory database service (src/memory/db/service.ts): the open and the writer lock, the shutdown, the per-turn
// record, the session writes and the status line. Synthetic data directories only; the clock and the loop are injected.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createMemoryDb, turnReadRows } from '../src/memory/db/service.ts';
import { seedUnits } from './fixtures/memory-db/seed.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { memoryDbStatusLine } from '../src/tools/operations/status.ts';
import { CHANNEL, GUILD, HOT_ITEM, MEMBER, buildDataDir, guildDir } from './fixtures/memory-db/datadir.ts';
import { dbOf } from '../src/memory/db/types.ts';

const tmpRoot = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-svc-'));

type LogFn = (message: string, fields?: object) => unknown;

function logs(): { out: Array<Record<string, unknown>>; info: LogFn; warn: LogFn; error: LogFn; debug?: LogFn } {
  const out: Array<Record<string, unknown>> = [];
  const add = (level: string) => (message: string, fields?: object) => out.push({ level, message, ...fields });
  return { out, info: add('info'), warn: add('warn'), error: add('error'), debug: add('debug') };
}

/** A data directory whose units are in its database, a config and a service whose loop is stepped by hand when `manual` is set. */
function setup({
  memoryDb = {},
  manual = false,
  ...rest
}: { memoryDb?: Record<string, unknown>; manual?: boolean; [option: string]: unknown } = {}) {
  // These tests run the service on the calling thread; tests/memory-db-worker.test.ts covers the worker.
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
  const queue: Array<() => void> = [];
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
    advance: (ms: number) => {
      time += ms;
    },
    flushQueue: async () => {
      while (queue.length) {
        queue.shift()!();
        await new Promise((resolve) => setImmediate(resolve));
      }
    },
    done: async () => {
      await service.close().catch(() => {});
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

const counts = (env: { dbFile: () => string }): Record<string, number> => {
  const reader = openMemoryDb(env.dbFile(), { readOnly: true });
  try {
    return Object.fromEntries(
      ['files', 'sources', 'claims', 'turn_reads'].map((t) => [
        t,
        dbOf(reader).prepare(`SELECT COUNT(*) AS n FROM ${t}`).get()!.n as number,
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
    assert.ok(env.service.status().files! > 5);
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
      (error: NodeJS.ErrnoException) => error.code === 'DB_CLOSED'
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
      placeId: GUILD,
      reads: [
        { kind: 'claim', id: HOT_ITEM },
        { kind: 'claim', id: HOT_ITEM },
        { kind: 'episode', id: 'ep-1' },
        { kind: 'channel', id: CHANNEL },
        { kind: 'place_note', id: 'patterns' },
        { kind: 'lore', id: 'l1' },
        { kind: 'source', id: '400000000000000002' },
        { kind: 'source', id: 'no-such-message' },
      ],
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    const reader = openMemoryDb(env.dbFile(), { readOnly: true });
    try {
      const rows = dbOf(reader)
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
      assert.ok(
        rows.some((r) => r.row_kind === 'sources' && /^src:discord:400000000000000002:/.test(r.row_id as string))
      );
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
      env.queue.shift()!();
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
      const rows = dbOf(reader)
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
      assert.ok(Number.isInteger(rows[1].revision) && (rows[1].revision as number) >= 1);
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
      { ...dbOf(db.service.readHandle()!).prepare('SELECT mode, applied FROM session_runs').get() },
      { mode: 'apply', applied: 1 }
    );
    await assert.rejects(
      () => db.service.memoryWrite({ kind: 'session', mode: 'other', run: { ...run, id: 'run:2' }, plan, now: 1 }),
      (error: NodeJS.ErrnoException) => error.code === 'BAD_MODE'
    );
  } finally {
    await db.done();
  }
});

// PR 7d: `memoryDb.turnReads` is code, so the case without the setting went with it.
test('turn reads: nothing without a turn id or reads', async () => {
  const env = setup();
  try {
    await env.service.tick();
    env.service.recordTurnReads({ turnId: '', reads: [{ kind: 'claim', id: 'x' }] });
    env.service.recordTurnReads({ turnId: 't', reads: [] });
    await new Promise((resolve) => setTimeout(resolve, 30));
    assert.equal(counts(env).turn_reads, 0);
  } finally {
    await env.done();
  }
});

test("turnReadRows: a channel read names the room's stored row, never a place spelled from the channel id", () => {
  // Bug: the read was recorded under `<iface>:channel:<id>`, a place no row holds when the room's id is opaque.
  const handle = openMemoryDb(':memory:');
  try {
    dbOf(handle)
      .exec(`INSERT INTO places (id, iface, kind, native_id, native_key, authority_id, generation, chat, scope_kind)
      VALUES ('place:opaque-room', 'discord', 'channel', 'c9', 'channel:c9', 'discord/global', 1, 'group', 'group')`);
    assert.deepEqual(
      turnReadRows(dbOf(handle), [{ kind: 'channel', id: 'c9' }], { iface: 'discord' }).map((row) => [
        row.row_kind,
        row.row_id,
      ]),
      [['places', 'place:opaque-room']]
    );
  } finally {
    handle.close();
  }
});

test('turnReadRows: a guild note needs the guild; unknown kinds are ignored', () => {
  const handle = openMemoryDb(':memory:');
  try {
    assert.deepEqual(
      turnReadRows(dbOf(handle), [
        { kind: 'place_note', id: 'patterns' },
        { kind: 'mystery', id: 'x' },
        { kind: 'claim' },
      ]),
      []
    );
    assert.deepEqual(
      turnReadRows(dbOf(handle), [{ kind: 'place_note', id: 'starters', block: 'about_chat', ord: 2 }], {
        placeId: '5',
      }),
      [
        {
          row_kind: 'descriptions',
          row_id: 'desc:5:starters',
          block: 'about_chat',
          ord: 2,
          version_id: null,
          revision: null,
        },
      ]
    );
    // the exact version of a description or a claim, the revision of a source, resolved now
    dbOf(handle)
      .prepare(
        "INSERT INTO descriptions (id, subject_kind, subject_id, field, current_version) VALUES ('desc:5:starters', 'place', 'discord:guild:5', 'starters', 'dv-1')"
      )
      .run();
    dbOf(handle)
      .prepare(
        "INSERT INTO claim_versions (id, claim_id, text, recorded_at) VALUES ('cv-1', 'c1', 'a', '2026-10-01'), ('cv-2', 'c1', 'b', '2026-10-02')"
      )
      .run();
    dbOf(handle)
      .prepare(
        "INSERT INTO sources (id, kind, iface, native_id, revision, authority_id) VALUES ('src:discord:m1:3:seen', 'seen', 'discord', 'm1', 3, 'discord/global')"
      )
      .run();
    // the same native id on another interface is another message: never the one a Discord turn read
    dbOf(handle)
      .prepare(
        "INSERT INTO sources (id, kind, iface, native_id, revision, authority_id) VALUES ('src:telegram:m1:9:seen', 'seen', 'telegram', 'm1', 9, 'telegram/global')"
      )
      .run();
    const rows = turnReadRows(
      dbOf(handle),
      [
        { kind: 'place_note', id: 'starters' },
        { kind: 'claim', id: 'c1' },
        { kind: 'source', id: 'm1' },
      ],
      { placeId: '5' }
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
    assert.ok(status.rows! > 0 && status.files! > 0);
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
    assert.match(ctx.id as string, /^ctx:/);
    // PR 7d: every issued context reads through `audience_id`, open database or not.
    assert.deepEqual([ctx.kind, ctx.iface, ctx.mode, ctx.audienceColumn], ['group', 'discord', 'outward', true]);
  } finally {
    await closed.done();
  }
  const env = setup({ manual: true });
  try {
    const first = env.service.tick();
    await env.flushQueue();
    await first;
    // The caller names the DM place it found in `places`: the partner's person id no longer spells it.
    const ctx = env.service.issueContext({
      kind: 'dm',
      person: `person:discord:${MEMBER}`,
      place: `discord:dm:${MEMBER}`,
    });
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
      const row = { ...dbOf(reader).prepare('SELECT * FROM execution_contexts WHERE id = ?').get(ctx.id) };
      assert.deepEqual(
        [row.mode, row.iface, row.destination_place_id, row.partner_person_id],
        ['outward', 'discord', `discord:dm:${MEMBER}`, `person:discord:${MEMBER}`]
      );
      const read = {
        ...dbOf(reader).prepare("SELECT context_id, reader_kind FROM turn_reads WHERE turn_id = 'turn-C'").get(),
      };
      assert.deepEqual(read, { context_id: ctx.id, reader_kind: 'turn' });
    } finally {
      reader.close();
    }
  } finally {
    await env.done();
  }
});

/** An embedding client that records the purpose of every request and answers one small vector per text. */
function recordingEmbed(purposes: Array<unknown>) {
  return (texts: ReadonlyArray<string>, options: Record<string, unknown>): Promise<unknown> => {
    purposes.push(options.purpose);
    return Promise.resolve(texts.map(() => [0.5, -0.25, 0.75]));
  };
}

/** Lets the loop run until `done()` holds or a bounded number of turns passed. */
async function settle(done: () => boolean): Promise<void> {
  for (let turn = 0; turn < 500 && !done(); turn += 1) await new Promise((resolve) => setImmediate(resolve));
}

const objectVectorCount = (file: string): number => {
  const reader = openMemoryDb(file, { readOnly: true });
  try {
    return Number(
      dbOf(reader)
        .prepare(
          `SELECT COUNT(*) AS n FROM vectors
            WHERE substr(chunk_key, 1, 6) IN ('claim:', 'names:') OR substr(chunk_key, 1, 5) = 'desc:'
               OR substr(chunk_key, 1, 8) = 'episode:'`
        )
        .get()?.n
    );
  } finally {
    reader.close();
  }
};

test('a tick embeds the pending memory objects while memoryDb.retrieval.embedObjects is true', async () => {
  // Bug: the job is never started, so claims and descriptions stay without vectors and searches stay lexical.
  const purposes: Array<unknown> = [];
  const env = setup({
    memoryDb: { retrieval: { embedObjects: true, embedBatch: 50 } },
    embed: recordingEmbed(purposes),
  });
  try {
    await env.service.tick();
    await settle(() => purposes.includes('memory-object') && objectVectorCount(env.dbFile()) > 0);
    assert.ok(purposes.includes('memory-object'), 'one request of purpose memory-object');
    assert.ok(objectVectorCount(env.dbFile()) > 0, 'the vectors are written');
  } finally {
    await env.done();
  }
});

test('a tick sends no memory-object request while memoryDb.retrieval.embedObjects is false', async () => {
  // Bug: the switch is ignored, so turning it off still spends requests against the daily cap.
  const purposes: Array<unknown> = [];
  const env = setup({
    memoryDb: { retrieval: { embedObjects: false, embedBatch: 50 } },
    embed: recordingEmbed(purposes),
  });
  try {
    await env.service.tick();
    await settle(() => false);
    assert.ok(!purposes.includes('memory-object'));
    assert.equal(objectVectorCount(env.dbFile()), 0);
  } finally {
    await env.done();
  }
});

// A memory session run that fails is told once with the scope it covered (service.ts#sessionFailed). The kind, the
// interface and the DM place come from the run itself, so nothing is worked out of the text of the scope's key.
const KAI_DM = 'discord:dm:u-kai';

/** One DM place with one line in it, written into the service's database before its first open. */
function seedKaiDm(file: string): void {
  const handle = openMemoryDb(file);
  try {
    const db = dbOf(handle);
    db.prepare(
      `INSERT INTO places (id, iface, kind, native_key, generation, chat, scope_kind, partner_account)
       VALUES (?, 'discord', 'dm', ?, 1, 'dm', 'dm', 'discord:u-kai')`
    ).run(KAI_DM, KAI_DM);
    db.prepare("INSERT INTO audiences (id, kind, iface, place_id) VALUES (?, 'dm', 'discord', ?)").run(
      `aud:dm:${KAI_DM}`,
      KAI_DM
    );
    const at = '2026-10-24T10:00:00.000Z';
    db.prepare(
      `INSERT INTO sources (id, kind, iface, native_id, revision, place_id, author_kind, occurred_at, recorded_at, text,
        scope_kind, scope_iface, scope_dm, audience_id)
       VALUES ('src:kai', 'seen', 'discord', 'm-kai', 1, ?, 'account', ?, ?, 'a line', 'dm', 'discord', NULL, ?)`
    ).run(KAI_DM, at, at, `aud:dm:${KAI_DM}`);
  } finally {
    handle.close();
  }
}

test('a failed run of a DM is told with its kind, interface and place, and no partner spelled from its key', async () => {
  // Bug: the failure split the scope key and named `person:discord:u-kai`, a person no row holds, as the partner.
  const failures: Array<Record<string, unknown>> = [];
  const env = setup({
    sessionLlm: () => ({ complete: () => Promise.reject(Object.assign(new Error('down'), { code: 'HTTP_503' })) }),
    sessionEnv: () => ({ OPENROUTER_MEMORY_KEY: 'k' }),
    onSessionFailure: (failure: Record<string, unknown>) => failures.push(failure),
  });
  try {
    seedKaiDm(env.dbFile());
    const session = { mode: 'apply', minMessages: 1, minLines: 0, settleMinutes: 0 };
    const live = env.hot.config;
    Object.assign(env.hot, {
      config: {
        bot: { timezone: 'UTC' },
        models: { base: { memory: 'x/memory' } },
        llm: { keyByRole: { memory: 'OPENROUTER_MEMORY_KEY' } },
        memoryDb: { ...live.memoryDb, session },
      },
      prompts: { 'memory-session': 'SESSION', 'system-prompt': 'S', 'character-card': 'C', rules: '- R', format: 'F' },
    });
    await env.service.tick();
    const dms = () => failures.filter((one) => one.scopeKind === 'dm');
    for (let i = 0; i < 200 && dms().length === 0; i += 1) await new Promise((resolve) => setTimeout(resolve, 5));
    assert.equal(dms().length, 1);
    const [failure] = dms();
    assert.deepEqual([failure.scopeKind, failure.iface, failure.place], ['dm', 'discord', KAI_DM]);
    assert.equal(failure.partner, undefined);
  } finally {
    await env.done();
  }
});
