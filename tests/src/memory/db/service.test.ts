// The memory database service (src/memory/db/service.ts): the open and the writer lock, the shutdown, the per-turn
// record, the session writes, the observations and the jobs it runs, its read connection and its reader and writer
// threads. Synthetic data directories only; the clock and the loop are injected.

import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { createMemoryDb, turnReadRows } from '../../../../src/memory/db/service.ts';
import { seedUnits } from '../../../fixtures/memory-db/seed.ts';
import { openMemoryDb } from '../../../../src/memory/db/open.ts';
import {
  CHANNEL,
  GUILD,
  HOT_ITEM,
  MEMBER,
  buildDataDir,
  guildDir,
  writeJson,
} from '../../../fixtures/memory-db/datadir.ts';
import { dbOf } from '../../../../src/memory/db/types.ts';
import { memoryRing } from '../../../fixtures/memory-db/session-rig.ts';
import { chainsOf } from '../../../fixtures/chains.ts';
import { writeUnitUpdate } from '../../../fixtures/memory-db/unit-writes.ts';
import { openTestMemory, tempDataDir } from '../../../fixtures/memory-db/service.ts';
import { observationOf } from '../../../../src/memory/db/observe-event.ts';
import { START, rowsOf } from '../../../fixtures/boundary.ts';
import { insertRows } from '../../../../src/memory/db/rows.ts';
import { channelPlaceId, dmPlaceId, messageSourceId } from '../../../../src/memory/db/ids.ts';
import { createDiaryMedia, applyDiaryUpdate } from '../../../../src/memory/db/diary-media.ts';
import { createFakeAdapter } from '../../../../scripts/lib/fake.ts';
import type { Untyped } from '../../../../src/tools/types.ts';
import { sqlOf, present, wrongly } from '../../../fixtures/loose-types.ts';
import { toEvent } from '../../../fixtures/sdk-shaped.ts';
import { validateEvent } from '../../../../src/protocol/index.ts';
import { readerEnv } from '../../../fixtures/memory-db/readers.ts';
import { pathToFileURL } from 'node:url';
import { dbSettings, search } from '../../../../src/memory/db/recall.ts';
import { personId } from '../../../fixtures/memory-db/spelled-ids.ts';
import {
  dmScope,
  internalContext,
  groupContext,
  dmContext,
  allowedAudience,
  dmAudienceId,
} from '../../../../src/memory/db/scope.ts';
import { fixture } from '../../../fixtures/memory-db-recall.ts';
import { fillEnvAudiences } from '../../../fixtures/memory-db/audiences.ts';
import { labels } from '../../../fixtures/labels.ts';
import { config } from '../../../fixtures/recall-run-kit.ts';
import { startRun } from '../../../../src/memory/db/wakes.ts';
import type { Db, MemoryHandle } from '../../../../src/memory/db/types.ts';
import { personOfAccount } from '../../../../src/memory/db/meta-person.ts';
import { observe, OBSERVATION_VERSION } from '../../../../src/memory/db/observe.ts';
import { applyMemoryWrite } from '../../../../src/memory/db/session-write.ts';
import { tempDir } from '../../../fixtures/tmp.ts';
import type { MemoryDbService } from '../../../../src/memory/db/service.ts';
import { createStore } from '../../../../src/memory/store.ts';
import { createOpsEnv } from '../../../../src/tools/operations/env.ts';
import { ANNA, seedOpaqueWorld } from '../../../fixtures/memory-db/opaque-people.ts';
import { lastFocusDay } from '../../../../src/memory/db/focus.ts';
import { accountOf, placeOfRoot, placeOfChat } from '../../../../src/memory/addresses.ts';
import {
  legacyServerPlaceId,
  isMemoryPath,
  isOperational,
  legacyStorageKey,
} from '../../../fixtures/memory-db/legacy-paths.ts';
import { unitSubjects, unitValue } from '../../../../src/memory/db/readers/common.ts';
import { createAppendStore } from '../../../../src/memory/append-store.ts';
import { createRecord, toRecordLine } from '../../../../src/memory/record.ts';
import { createArchive } from '../../../../src/memory/archive.ts';
import { createJournal } from '../../../../src/memory/journal.ts';
import { createVectors } from '../../../../src/memory/vectors.ts';
import { createEmbedder } from '../../../../src/memory/embedder.ts';
import { createIntentionStores, createIntentionStore } from '../../../../src/intentions/store.ts';
import { createErrandStores, createErrandStore } from '../../../../src/errands/store.ts';
import { fileFixtureErrand, seen, writeLines } from '../../../fixtures/memory-db/datadir.ts';
import { type Row, dbOf as sqlOfHandle } from '../../../../src/memory/db/types.ts';
import {
  addChannelPlace,
  BORIS,
  BORIS_ACCOUNT,
  BORIS_PLACE,
  addAccount,
  addClaim,
  addDmPlace,
  addEpisode,
} from '../../../fixtures/memory-db/opaque-people.ts';
import { memoryDbStatusLine } from '../../../../src/tools/operations/status.ts';
import { cursorKey } from '../../../../src/memory/db/session.ts';
import * as memoryIds from '../../../../src/memory/db/ids.ts';
import { NOW as SESSION_NOW } from '../../../fixtures/memory-db/session-rig.ts';
import { createHash } from 'node:crypto';
import { touchMemory } from '../../../../src/memory/update.ts';
import { keyText, type UnitKey } from '../../../../src/memory/db/unit-keys.ts';
import type { Context } from '../../../../src/memory/db/scope.ts';
import type { MemoryPage } from '../../../../src/memory/db/semantic-types.ts';
import type { RetrievalInput } from '../../../../src/memory/retrieval-input.ts';
import { openTestMemorySync } from '../../../fixtures/memory-db/service.ts';
import { join } from 'node:path';

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
  // These tests run the service on the calling thread; tests/src/memory/db/writer-worker.test.ts covers the worker.
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
    iface: () => 'discord',
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
      ['accounts', 'sources', 'claims', 'turn_reads'].map((t) => [
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
    assert.ok(env.service.status().rows! > 5);
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
    const logged = env.log.out;
    assert.equal(logged.filter((e) => e.message === 'memory db: open failed').length, 1);
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
    const write = writeUnitUpdate(env.service, {
      op: 'value',
      file: `guilds/${GUILD}/users/100000000000000088.json`,
      value: { id: '100000000000000088', names: ['Late'] },
    });
    await env.service.close();
    await write;
    assert.equal(fs.existsSync(`${env.dbFile()}.lock`), false);
    assert.equal(counts(env).accounts, before.accounts + 1);
    assert.equal(env.service.status().open, false);
    await assert.rejects(
      () => writeUnitUpdate(env.service, { op: 'value', file: `guilds/${GUILD}/lore.json`, value: [] }),
      (error: NodeJS.ErrnoException) => error.code === 'DB_CLOSED'
    );
  } finally {
    await env.done();
  }
});

test("writeGeneration: a store's own direct write moves it for every reader but that store", async () => {
  // Bug: a store's own write counted for itself, so every write it sent made its next read of any unit go to the
  // database again, and the last read it keeps answered nothing.
  const env = setup();
  try {
    await env.service.tick();
    const sender = {};
    const reader = {};
    const before = [env.service.writeGeneration(sender), env.service.writeGeneration(reader)];
    await env.service.writeAccountProfile(
      { accountId: `discord:${MEMBER}`, value: { id: MEMBER, names: ['Ζωή'] } },
      sender
    );
    assert.deepEqual(
      [env.service.writeGeneration(sender), env.service.writeGeneration(reader)],
      [before[0], before[1] + 1]
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
    // the persona's session writes a newer version before the deferred insert runs
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
      // The turn's interface: a message id is read under its authority.
      { placeId: '5', iface: 'discord' }
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

test('a logger without debug (the engine logger has none): ticks and turn reads warn about nothing', async () => {
  const env = setup();
  delete env.log.debug;
  try {
    await env.service.tick();
    env.service.recordTurnReads({ turnId: 'turn-D', reads: [{ kind: 'channel', id: CHANNEL }] });
    env.advance(61_000);
    await env.service.tick();
    await new Promise((resolve) => setTimeout(resolve, 30));
    const logged = env.log.out;
    assert.deepEqual(
      logged.filter((line) => line.level === 'warn'),
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
    // Every issued context reads through `audience_id`, open database or not.
    assert.deepEqual([ctx.kind, ctx.iface, ctx.mode, ctx.audienceColumn], ['group', 'discord', 'outward', true]);
  } finally {
    await closed.done();
  }
  const env = setup({ manual: true });
  try {
    const first = env.service.tick();
    await env.flushQueue();
    await first;
    // The caller names the DM place it found in `places`: the partner's person id does not spell it.
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
    // The memory key comes from the key ring, which stands where an `.env` variable and `llm.keyByRole` stood.
    sessionKeys: () => memoryRing(),
    onSessionFailure: (failure: Record<string, unknown>) => failures.push(failure),
  });
  try {
    seedKaiDm(env.dbFile());
    const session = { mode: 'apply', minMessages: 1, minLines: 0, settleMinutes: 0 };
    const live = env.hot.config;
    Object.assign(env.hot, {
      config: {
        bot: { timezone: 'UTC' },
        models: { routes: chainsOf({ memory: 'x/memory' }) },
        memoryDb: { ...live.memoryDb, session },
      },
      prompts: { 'memory/session': 'SESSION', main: 'S', persona: 'C', rules: '- R', format: 'F' },
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

// The owner's command line, as its interface names it (src/protocol/identity.ts#nativeAuthorityOf: `cli/local`).
const CONSOLE_CHAT = 'cli:dm:owner';
const CONSOLE_AT = Date.UTC(2026, 10, 10, 21, 40, 0);
const CONSOLE_WORDS = 'το φανάρι στο λιμάνι';

/** A line of the command line as its interface hands it, from the persona (`self`) or from the owner. */
function consoleEvent(id: string, at: number, self: boolean) {
  return {
    iface: 'cli',
    at,
    chat: { id: CONSOLE_CHAT, kind: 'dm', chatType: 'dm', partnerId: 'owner', rootId: null },
    message: { id, at, content: CONSOLE_WORDS, author: { id: self ? 'self' : 'owner', self } },
  };
}

function consoleEnvelope(id: string, at: number, self: boolean) {
  const envelope = observationOf(consoleEvent(id, at, self), { selfId: 'self' });
  if (!envelope) throw new Error('the synthetic event was refused');
  return envelope;
}

test('a failed observation warns with the kind of the observation and the SQLite message, never the line', async () => {
  // Bug: the warning carries `ERR_SQLITE_ERROR` alone, the code of every SQLite failure, so thousands of warnings
  // cannot say which statement failed. SQLite's message for a constraint names the table and the column and holds no
  // stored value, so it is safe in a log; the line's text must stay out of it.
  const log = logs();
  const memory = await openTestMemory({ iface: () => 'cli', now: () => CONSOLE_AT + 60_000, log });
  try {
    // A synthetic constraint that the second line of the chat breaks, standing for any statement the writer fails.
    memory.memoryDb.database()?.exec('CREATE UNIQUE INDEX synthetic_one_line ON sources (iface)');
    await memory.memoryDb.observeMessage(consoleEnvelope('line-1', CONSOLE_AT, false), { placeId: CONSOLE_CHAT });
    const failed = await memory.memoryDb.observeMessage(consoleEnvelope('line-2', CONSOLE_AT + 1000, false), {
      placeId: CONSOLE_CHAT,
    });
    assert.equal(failed, null, 'the scene fails the second observation');
    const warned = log.out.find((entry) => entry.message === 'memory db: observe failed');
    assert.equal(warned?.code, 'ERR_SQLITE_ERROR');
    assert.equal(warned?.kind, 'observeMessage');
    assert.equal(warned?.detail, 'UNIQUE constraint failed: sources.iface');
    assert.equal(JSON.stringify(warned).includes(CONSOLE_WORDS), false, 'no chat content in the log');
  } finally {
    await memory.close();
  }
});

test('memoryWrite: a written session tells its listeners the accounts the pass came across', async () => {
  // Bug: nothing after a pass reaches the code that opens a direct chat ahead, so no chat is ever opened.
  const db = setup();
  try {
    await db.service.tick();
    const told: Array<unknown> = [];
    db.service.onSessionAccounts((accounts) => told.push(...accounts));
    const met = [{ iface: 'discord', native: 'u-ada' }];
    await db.service.memoryWrite({ kind: 'session', mode: 'shadow', run: null, plan: null, met, now: 1 });
    assert.deepEqual(told, met);
  } finally {
    await db.done();
  }
});

test('memoryWrite: a session listener that throws leaves the write done', async () => {
  // Bug: a failed opening of a direct chat ahead fails the memory pass that came across the person.
  const db = setup();
  try {
    await db.service.tick();
    db.service.onSessionAccounts(() => {
      throw new Error('the interface is gone');
    });
    const met = [{ iface: 'discord', native: 'u-ada' }];
    await assert.doesNotReject(() =>
      db.service.memoryWrite({ kind: 'session', mode: 'shadow', run: null, plan: null, met, now: 1 })
    );
  } finally {
    await db.done();
  }
});

// The one writer of the memory service: callers that write at once all land, in order.

const SILENT = { info() {}, warn() {}, error() {}, debug() {} };

/** The rigs and services a test opened; closed when the file is done. */
const OPEN: Array<{ close(): unknown }> = [];
after(async () => {
  for (const item of OPEN) await item.close();
});

/** The memory service over its own data directory, the writer on its thread as in production. */
async function writerService() {
  const dataDir = tempDataDir('boundary-writer-');
  const hot = { config: { memoryDb: { session: { mode: 'off' } } }, prompts: {} };
  const memoryDb = createMemoryDb({ iface: () => 'discord', hot, dataDir, log: SILENT, now: () => START });
  OPEN.push({ close: () => memoryDb.close() });
  await memoryDb.tick();
  return { memoryDb, dataDir };
}
const WRITER_UNIT = 'guilds/g1/journal/2026-10-26.jsonl';
const writerLine = (id: string) => ({
  id,
  kind: 'turn.start',
  occurredAt: '2026-10-26T12:00:00.000Z',
  turnId: id,
});

test('two callers writing at once both land, in the order they asked', async () => {
  const { memoryDb } = await writerService();
  const first = writeUnitUpdate(memoryDb, {
    op: 'lines',
    file: WRITER_UNIT,
    lines: [writerLine('a1'), writerLine('a2')],
  });
  const second = writeUnitUpdate(memoryDb, { op: 'lines', file: WRITER_UNIT, lines: [writerLine('b1')] });
  await Promise.all([first, second]);
  const rows = rowsOf(
    memoryDb,
    "SELECT id FROM day WHERE writer = 'journal' AND period = '2026-10-26' ORDER BY position"
  );
  assert.deepEqual(
    rows.map((row) => row.id),
    ['a1', 'a2', 'b1']
  );
});

// The diary media job (src/memory/db/diary-media.ts): the text and the pictures of the persona's diary posts come from the
// interface into the database and `data/media/diary/`. A fake port, a fake image fetcher, synthetic data only.

const DIARY_CHANNEL = '700000000000000001';
const dataUrl = (buffer: Untyped, contentType = 'image/png') =>
  `data:${contentType};base64,${buffer.toString('base64')}`;

function diarySetup({ posts, config = {} }: { posts?: Untyped; config?: Record<string, Untyped> } = {}) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-diary-'));
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  buildDataDir(data);
  const g = guildDir(data);
  const writePosts = (list: Record<string, Untyped>) =>
    writeJson(path.join(g, 'diary.json'), { updatedAt: 1, posts: list });
  writePosts(posts);
  const dbFile = path.join(data, 'memory.db');
  const handle = openMemoryDb(dbFile);
  seedUnits(handle, data);
  // The posts' place is the diary's mirror (a `mirrors` row); the job asks the interface for the posts in that place.
  const placeId = channelPlaceId('discord', DIARY_CHANNEL);
  insertRows(
    handle.db,
    {
      places: [
        {
          id: placeId,
          iface: 'discord',
          kind: 'channel',
          native_id: DIARY_CHANNEL,
          parent_id: null,
          scope_kind: 'group',
          name: 'journal',
        },
      ],
    },
    { at: '2026-10-27T00:00:00.000Z' }
  );
  // open.js answers its node:sqlite connection untyped; the fixture needs prepare and run.
  const writer: Record<string, Untyped> = handle.db;
  writer
    .prepare(
      "INSERT INTO mirrors (id, row_kind, place_id, enabled, created_at, created_by, extra) VALUES ('mirror-1', 'diary', ?, 1, '2026-10-27T00:00:00.000Z', 'owner', NULL)"
    )
    .run(placeId);
  const port = createFakeAdapter({ iface: 'discord', selfId: 'self' });
  const downloads: Array<Untyped> = [];
  const files = new Map();
  const audioFiles = new Map();
  const audioFetches: Array<Untyped> = [];
  const fetcher = {
    async fetchAsDataUrl(url: Record<string, Untyped>, options: Record<string, Untyped>) {
      downloads.push({ url, ...options });
      return files.get(url) ?? null;
    },
  };
  const hot = {
    config: {
      context: { vision: { fetchTimeoutMs: 5000 } },
      ...config,
    },
  };
  const sleeps: Array<Untyped> = [];
  const logs: Array<Untyped> = [];
  const log = {
    info: (m: Untyped, f: Record<string, Untyped>) => logs.push({ m, ...f }),
    warn: (m: Untyped, f: Record<string, Untyped>) => logs.push({ m, ...f }),
    error() {},
    debug() {},
  };
  const job = () =>
    createDiaryMedia({
      db: () => handle.db,
      apply: (update) => applyDiaryUpdate(handle, update),
      port: () => port,
      imageFetcher: () => fetcher,
      fetchImpl: wrongly(async (url: Record<string, Untyped>) => {
        audioFetches.push(url);
        const served = audioFiles.get(url);
        if (!served) return { ok: false, status: 404 };
        return {
          ok: true,
          headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? served.type : null) },
          arrayBuffer: async () => served.bytes,
        };
      }),
      config: () => hot.config,
      dataDir: data,
      log,
      sleep: async (ms) => {
        sleeps.push(ms);
      },
    });
  /** A message of the persona's in the diary channel, with picture attachments (url -> bytes served by the fake fetcher). */
  const say = (text: Untyped, pictures: Array<Untyped> = [], size?: Untyped) => {
    const ref = port.seed(DIARY_CHANNEL, { authorId: 'self', text });
    present(port.messages.get(`${DIARY_CHANNEL}/${ref.messageId}`)).attachments = pictures.map((picture) => {
      const url = `https://cdn.example/${picture.name}?sig=1`;
      if (picture.bytes)
        files.set(url, { dataUrl: dataUrl(picture.bytes), bytes: picture.bytes.byteLength, contentType: 'image/png' });
      return {
        url,
        name: picture.name,
        contentType: picture.type ?? 'image/png',
        size: size ?? picture.bytes?.byteLength,
      };
    });
    return ref.messageId;
  };
  /** A message of the persona's carrying one audio attachment (served by the fake fetch). */
  const sayVoice = (
    text: Untyped,
    {
      bytes,
      type = 'audio/ogg',
      name = 'voice-message.ogg',
      durationSec,
      size,
    }: { bytes?: Untyped; type?: string; name?: string; durationSec?: Untyped; size?: Untyped } = {}
  ) => {
    const ref = port.seed(DIARY_CHANNEL, { authorId: 'self', text });
    const url = `https://cdn.example/${name}?sig=1`;
    audioFiles.set(url, { bytes, type });
    present(port.messages.get(`${DIARY_CHANNEL}/${ref.messageId}`)).attachments = [
      {
        url,
        name,
        contentType: type,
        size: size ?? bytes.byteLength,
        ...(durationSec === undefined ? {} : { durationSec }),
      },
    ];
    return ref.messageId;
  };
  return {
    sayVoice,
    audioFetches,
    root,
    data,
    g,
    handle,
    port,
    job,
    say,
    writePosts,
    downloads,
    sleeps,
    logs,
    hot,
    dbFile,
    row: (id: Untyped) => sqlOf(handle).prepare('SELECT * FROM diary WHERE id = ?').get(id),
    media: () =>
      sqlOf(handle)
        .prepare(
          `SELECT m.* FROM media m JOIN media_links l ON l.media_id = m.id WHERE l.owner_kind = 'diary'
           ORDER BY l.owner_id, l.position`
        )
        .all(),
    writeUnits: () => seedUnits(handle, data),
    /** Turns the diary's mirror on or off. */
    mirrored: (enabled: Untyped) =>
      writer.prepare("UPDATE mirrors SET enabled = ? WHERE id = 'mirror-1'").run(enabled ? 1 : 0),
    done: () => {
      handle.close();
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

const post = (itemId: Untyped, messageIds: Record<string, Untyped>, extra = {}) => ({
  at: 1792000000000,
  kind: 'picture',
  gist: `gist ${itemId}`,
  picture: null,
  messageIds,
  search: null,
  itemId,
  ...extra,
});

// The job always runs.
test('the service runs the job once the database is open', async () => {
  const { createMemoryDb } = await import('../../../../src/memory/db/service.ts');
  const env = diarySetup(wrongly({ posts: [post('d-1', ['x'])] }));
  try {
    const a = env.say('served');
    env.writePosts([post('d-1', [a])]);
    env.writeUnits();
    env.handle.close();
    const hot = { config: { ...env.hot.config } };
    const service = createMemoryDb({
      iface: () => 'discord',
      hot,
      dataDir: env.data,
      worker: false,
      log: { info() {}, warn() {}, error() {}, debug() {} },
      diaryMediaDeps: () => ({ port: env.port, imageFetcher: { fetchAsDataUrl: async () => null } }),
      diarySleep: async () => {},
    });
    await service.tick();
    await new Promise((resolve) => setTimeout(resolve, 50));
    await service.close();
    const reader = openMemoryDb(env.dbFile, { readOnly: true });
    try {
      assert.equal(sqlOf(reader).prepare('SELECT text FROM diary WHERE id = ?').get('d-1').text, 'served');
    } finally {
      reader.close();
    }
  } finally {
    fs.rmSync(env.root, { recursive: true, force: true });
  }
});

// Observations through the service: a discord.js-shaped message goes through the adapter (toEvent) and the core's
// mapping into the service's writer. Synthetic text only (Greek or accented Latin for non-ASCII); the ids are made up.

const quiet = { info() {}, debug() {}, warn() {}, error() {} };
const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const T0 = Date.parse('2026-10-24T09:00:00.000Z');
const SELF = '100000000000000009';
const MEMBER2 = '100000000000000002';
const BOT = '100000000000000008';

const NAMES: Record<string, string> = { [MEMBER]: 'Ada', [MEMBER2]: 'Zoé', [SELF]: 'Her', [BOT]: 'Robot' };

function channelOf({
  id = CHANNEL,
  name = 'γενικά',
  thread = false,
  type,
  recipientId,
  parentId,
}: { id?: string; name?: string; thread?: boolean; type?: number; recipientId?: string; parentId?: string } = {}) {
  return {
    id,
    name,
    isThread: () => thread,
    messages: { cache: new Map() },
    ...(type === undefined ? {} : { type }),
    ...(recipientId ? { recipientId } : {}),
    ...(parentId ? { parentId } : {}),
  };
}

/** A discord.js message, shaped just enough for the adapter. */
function message({
  id,
  channel = channelOf(),
  author = MEMBER,
  content,
  at,
  replyTo = null,
  mentions = [],
  guild = true,
  editedAt = null,
}: {
  id: string;
  channel?: ReturnType<typeof channelOf>;
  author?: string;
  content: string;
  at: number;
  replyTo?: string | null;
  mentions?: Array<string>;
  guild?: boolean;
  editedAt?: number | null;
}) {
  return {
    id,
    placeId: channel.id,
    channel,
    guild: guild ? { id: GUILD } : null,
    chatId: guild ? GUILD : null,
    author: { id: author, bot: author === BOT, globalName: NAMES[author], username: NAMES[author] },
    member: { displayName: NAMES[author] },
    content,
    cleanContent: content,
    createdTimestamp: at,
    editedTimestamp: editedAt,
    reference: replyTo ? { messageId: replyTo } : null,
    mentions: { users: new Map(mentions.map((user) => [user, { id: user }])) },
    attachments: new Map(),
    stickers: new Map(),
    embeds: [],
    messageSnapshots: new Map(),
    flags: { has: () => false },
  };
}

const eventOf = (raw: Record<string, Untyped>, options = {}) => {
  const event = toEvent(raw, SELF, options);
  assert.deepEqual(validateEvent(event), { ok: true });
  return event;
};

// ---------- through the service ----------

test("service: observe goes through the writer; an edit's revision survives a new service", async () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-8a-svc-'));
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  buildDataDir(data);
  const hot = { config: {} };
  const start = () =>
    createMemoryDb({ iface: () => 'discord', hot, dataDir: data, log: quiet, worker: false, now: () => NOW });
  const envelopeOf = (raw: Record<string, Untyped>, options?: Record<string, Untyped>) =>
    observationOf(eventOf(raw, options), { selfId: SELF });
  const first = message({ id: 'm-svc', content: 'πρώτη', at: T0 });
  try {
    const one = start();
    await one.tick();
    assert.equal(wrongly<Untyped>(present(await one.observe(envelopeOf(first)))).sourceId, 'src:discord:m-svc:1:seen');
    const edit: Untyped = await one.observe(
      envelopeOf(message({ id: 'm-svc', content: 'δεύτερη', at: T0, editedAt: T0 + 1000 }), {
        edit: true,
        now: () => T0 + 1000,
      })
    );
    assert.equal(present(edit).sourceId, 'src:discord:m-svc:2:seen');
    await one.close();

    const two = start();
    await two.tick();
    const later: Untyped = await two.observe(
      envelopeOf(message({ id: 'm-svc', content: 'τρίτη', at: T0, editedAt: T0 + 2000 }), {
        edit: true,
        now: () => T0 + 2000,
      })
    );
    assert.equal(present(later).sourceId, 'src:discord:m-svc:3:seen', 'the count lives in the database');
    assert.equal(await present(two.observe({ v: 1 })).then((done: Record<string, Untyped>) => done.code), 'BAD_IFACE');
    await two.close();
    assert.equal(two.observe(envelopeOf(first)), null, 'closed: nothing is written');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('service: an observation that comes before the database opens is written once it opens; one just before a shutdown lands before it closes', async () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-8a-queue-'));
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  buildDataDir(data);
  const hot = { config: {} };
  const service = createMemoryDb({
    iface: () => 'discord',
    hot,
    dataDir: data,
    log: quiet,
    worker: false,
    now: () => NOW,
  });
  const envelopeOf = (raw: Record<string, Untyped>) => observationOf(eventOf(raw), { selfId: SELF });
  try {
    // the start's catch-up runs before the database opens
    assert.equal(
      service.observe(envelopeOf(message({ id: 'm-early', content: 'early', at: T0 }))),
      null,
      'queued, not written yet'
    );
    await service.tick();
    // a line that arrives while the bot is stopping
    service.observe(envelopeOf(message({ id: 'm-late', content: 'late', at: T0 + 1000 })));
    await service.close();
    const reader = openMemoryDb(path.join(data, 'memory.db'), { readOnly: true });
    try {
      assert.deepEqual(
        sqlOf(reader)
          .prepare("SELECT native_id FROM sources WHERE native_id IN ('m-early', 'm-late') ORDER BY native_id")
          .all()
          .map((row) => row.native_id),
        ['m-early', 'm-late']
      );
    } finally {
      reader.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The seam of the database readers: the service's read connection is what the readers read through.

const silent = { info() {}, debug() {}, warn() {}, error() {} };

test('service: the read connection opens with the first tick and closes with the service', async () => {
  const env = await readerEnv();
  try {
    const dataDir = path.join(env.root, 'service');
    fs.mkdirSync(dataDir);
    buildDataDir(dataDir);
    const service = createMemoryDb({
      iface: () => 'discord',
      hot: { config: {} },
      dataDir,
      log: silent,
      worker: false,
      now: () => Date.UTC(2026, 9, 24),
    });
    assert.equal(service.readHandle(), null, 'nothing open before the first tick');
    await service.tick();
    assert.ok(service.readHandle()?.db, 'the read connection once open');
    await service.close();
    assert.equal(service.readHandle(), null, 'closed: no read connection');
  } finally {
    env.done();
  }
});

// `search` off the main thread: the service's `searchRecord` runs it in the reader worker on a read-only connection,
// with the results and the audience of the synchronous call. Synthetic data only.
const MINUTE = 60_000;
const MAIN = channelPlaceId('discord', 'main');
const OTHER = channelPlaceId('discord', 'other');
const ALICE = 'u-alice';
const BOB = 'u-bob';
const ALICE_PERSON = personId('discord', ALICE);
const BOB_PERSON = personId('discord', BOB);
const VECTOR = [1, 0, 0, 0];
const REAL_READER = pathToFileURL(path.resolve('src/memory/db/reader-worker.ts')).href;
const SLOW_MS = 1000;
const STALE_MS = 60_000;

const readerTmpRoot = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-off-main-'));

/** A file database with group lines in two channels, one DM line each for two people, an account and vectors. */
function writeFixtureDb(file: string): void {
  const env = fixture();
  try {
    insertRows(env.db, {
      places: [
        { id: MAIN, iface: 'discord', kind: 'channel', native_id: 'main', scope_kind: 'group', name: 'main' },
        { id: OTHER, iface: 'discord', kind: 'channel', native_id: 'other', scope_kind: 'group', name: 'other' },
        {
          id: dmPlaceId('discord', ALICE),
          iface: 'discord',
          kind: 'dm',
          native_id: null,
          scope_kind: 'dm',
          partner_person: ALICE_PERSON,
        },
        {
          id: dmPlaceId('discord', BOB),
          iface: 'discord',
          kind: 'dm',
          native_id: null,
          scope_kind: 'dm',
          partner_person: BOB_PERSON,
        },
      ],
    });
    env.account(ALICE, ['Alice']);
    env.account(BOB, ['Bob']);
    env.say({ native: 'main-1', at: NOW - 5 * MINUTE, text: 'the rabbit left the garden' });
    env.say({ native: 'main-2', at: NOW - 4 * MINUTE, text: 'a rabbit came back at dusk', author: BOB });
    env.say({ native: 'main-3', at: NOW - 3 * MINUTE, text: 'nothing about animals in this line' });
    env.say({ native: 'other-1', at: NOW - 2 * MINUTE, text: 'the rabbit in the other channel', place: OTHER });
    env.say({
      native: 'dm-alice',
      at: NOW - MINUTE,
      text: 'the secret rabbit of alice',
      place: dmPlaceId('discord', ALICE),
      scope: dmScope(ALICE_PERSON, 'discord'),
    });
    env.say({
      native: 'dm-bob',
      at: NOW - MINUTE,
      text: 'the secret rabbit of bob',
      author: BOB,
      place: dmPlaceId('discord', BOB),
      scope: dmScope(BOB_PERSON, 'discord'),
    });
    env.vector('main-3', VECTOR);
    env.vector('main-1', [0.9, 0.1, 0, 0]);
    env.vector('dm-alice', VECTOR, { scope: dmScope(ALICE_PERSON, 'discord') });
    env.stem();
    fillEnvAudiences(env);
    env.db.prepare('VACUUM INTO ?').run(file);
  } finally {
    env.done();
  }
}

/** A stand-in reader that reads `<root>/mode` at each message but `open` and `close`, then lets the real reader answer. */
function standInReader(root: string): URL {
  const file = pathToFileURL(path.join(root, 'stand-in-reader.mjs'));
  fs.writeFileSync(
    file,
    `
import { parentPort } from 'node:worker_threads';
import fs from 'node:fs';
const root = ${JSON.stringify(root)};
const block = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const once = (name) => {
  if (fs.existsSync(root + '/' + name)) return false;
  fs.writeFileSync(root + '/' + name, '1');
  return true;
};
parentPort.on('message', (message) => {
  if (message.type === 'open' || message.type === 'close') return;
  let mode = '';
  try { mode = fs.readFileSync(root + '/mode', 'utf8'); } catch { /* none */ }
  if (mode === 'slow') block(${SLOW_MS});
  if (mode === 'hang') block(${STALE_MS});
  if (mode === 'hang-once' && once('hung')) block(${STALE_MS});
  if (mode === 'crash-once' && once('crashed')) process.exit(3);
});
await import(${JSON.stringify(REAL_READER)});
`
  );
  return file;
}

/** The fixture database, a service over it and a config both read. `standIn` puts the blocking worker before the reader. */
async function readerSetup({
  standIn = false,
  memoryDb = {},
  recall = {},
  options = {},
}: {
  standIn?: boolean;
  memoryDb?: Record<string, unknown>;
  recall?: Record<string, unknown>;
  options?: Record<string, unknown>;
} = {}) {
  const root = readerTmpRoot();
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  const file = path.join(data, 'memory.db');
  writeFixtureDb(file);
  const hot = {
    config: config({
      features: { recall: true, meaningSearch: false },
      // A short close bound: a stand-in may still hold the reader when the test closes the service.
      memoryDb: { session: { mode: 'off' }, closeTimeoutMs: 500, ...memoryDb },
      recall: {
        prefetch: {
          deadlineMs: 100,
          maxTokens: 1500,
          contextTokens: 500,
          minFormsMatched: 1,
          singleTermScore: 0,
          maxTermShare: 1,
          trivial: [],
        },
        ...recall,
      },
    }),
    prompts: { labels },
  };
  const service = createMemoryDb({
    iface: () => 'discord',
    hot,
    dataDir: data,
    now: () => NOW,
    ...(standIn ? { readerFile: standInReader(root) } : {}),
    ...options,
  });
  await service.open();
  return {
    root,
    file,
    hot,
    service,
    mode: (value: string) => fs.writeFileSync(path.join(root, 'mode'), value),
    done: async () => {
      await service.close().catch(() => {});
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

const rabbit = (extra: Record<string, unknown> = {}) => ({
  ctx: groupContext('discord'),
  plan: { forms: ['rabbit'], who: [], from: null, to: null },
  limit: 8,
  now: NOW,
  settings: dbSettings({}),
  ...extra,
});
const messageIds = (found: { hits: Array<{ messageId: unknown }> }) => found.hits.map((hit) => hit.messageId);

// ---------- the same results ----------

const SAME_RESULT_CASES: Array<[string, Record<string, unknown>]> = [
  ['a group reader', {}],
  ['a DM reader of the person', { ctx: dmContext(ALICE_PERSON, 'discord', dmPlaceId('discord', ALICE)) }],
  ['a DM reader of another person', { ctx: dmContext(BOB_PERSON, 'discord', dmPlaceId('discord', BOB)) }],
  ['an internal reader', { ctx: internalContext() }],
  ['the place rule of the caller', { allowPlace: (place: string) => place !== OTHER }],
  [
    'the names of the caller',
    {
      nameOf: (id: string) => (id === ALICE ? 'Alicia' : null),
      channelNameOf: (id: string) => (id === 'main' ? 'general' : null),
      selfName: 'Persona',
    },
  ],
  ['a query vector as a typed array', { vector: Float32Array.from(VECTOR), model: 'test/embedder' }],
  ['a query vector as a plain array', { vector: VECTOR, model: 'test/embedder' }],
  ['a query vector of another model', { vector: VECTOR, model: 'other/embedder' }],
  ['a person in the plan', { plan: { forms: [], who: ['Alice'], from: null, to: null } }],
  ['a closed range', { plan: { forms: ['rabbit'], who: [], from: NOW - 5 * MINUTE, to: NOW - 3 * MINUTE } }],
  ['one channel', { plan: { forms: ['rabbit'], who: [], from: null, to: null, placeId: 'other' } }],
  ['excluded ids as a set', { exclude: new Set([messageSourceId('discord', 'main-1', 1, 'seen')]) }],
  [
    'exclusions by source',
    { exclusions: [{ kind: 'source', sourceId: messageSourceId('discord', 'main-1', 1, 'seen') }] },
  ],
  ['a limit of one', { limit: 1 }],
  ['forms nothing holds', { plan: { forms: ['zzzqqq'], who: [], from: null, to: null } }],
];

for (const [name, extra] of SAME_RESULT_CASES) {
  test(`the reader answers ${name} exactly as the synchronous search does`, async () => {
    const env = await readerSetup();
    try {
      const args = rabbit(extra);
      const expected = search(env.service.database(), args);
      assert.deepEqual(await env.service.searchRecord(args), expected);
    } finally {
      await env.done();
    }
  });
}

test('the audience holds in the reader: a DM line reaches its person and no other reader', async () => {
  const env = await readerSetup();
  try {
    const find = (ctx: unknown) => env.service.searchRecord(rabbit({ ctx }));
    assert.ok(
      messageIds(await find(dmContext(ALICE_PERSON, 'discord', dmPlaceId('discord', ALICE)))).includes('dm-alice')
    );
    const bob = messageIds(await find(dmContext(BOB_PERSON, 'discord', dmPlaceId('discord', BOB))));
    assert.ok(bob.includes('dm-bob'));
    assert.ok(!bob.includes('dm-alice'));
    const group = messageIds(await find(groupContext('discord')));
    assert.ok(group.includes('main-1'));
    assert.ok(!group.includes('dm-alice') && !group.includes('dm-bob'));
  } finally {
    await env.done();
  }
});

test('a query vector in the reader finds a line by meaning alone, and only in its audience', async () => {
  const env = await readerSetup();
  try {
    const meaning = (ctx: unknown) =>
      env.service.searchRecord(
        rabbit({
          ctx,
          plan: { forms: [], who: [], from: null, to: null },
          vector: Float32Array.from(VECTOR),
          model: 'test/embedder',
        })
      );
    const group = await meaning(groupContext('discord'));
    assert.ok(messageIds(group).includes('main-3'));
    assert.ok(!messageIds(group).includes('dm-alice'));
    assert.ok(group.stats.meaning > 0);
    assert.ok(
      messageIds(await meaning(dmContext(ALICE_PERSON, 'discord', dmPlaceId('discord', ALICE)))).includes('dm-alice')
    );
  } finally {
    await env.done();
  }
});

test('the place rule holds in the reader: a refused channel returns no line', async () => {
  const env = await readerSetup();
  try {
    const found = await env.service.searchRecord(rabbit({ allowPlace: (place: string) => place !== OTHER }));
    assert.ok(messageIds(found).includes('main-1'));
    assert.ok(!messageIds(found).includes('other-1'));
  } finally {
    await env.done();
  }
});

test('the names of the caller reach the messages of the answer', async () => {
  const env = await readerSetup();
  try {
    const found = await env.service.searchRecord(
      rabbit({
        nameOf: (id: string) => (id === ALICE ? 'Alicia' : null),
        channelNameOf: (id: string) => (id === 'main' ? 'general' : null),
      })
    );
    const window = found.windows.find((one) => one.placeId === 'main');
    assert.equal(window?.channelName, 'general');
    assert.ok(window?.messages.some((message) => message.authorName === 'Alicia'));
  } finally {
    await env.done();
  }
});

test('a search without a valid context is refused in the reader', async () => {
  const env = await readerSetup();
  try {
    await assert.rejects(env.service.searchRecord(rabbit({ ctx: { kind: 'group' } })));
    await assert.rejects(env.service.searchRecord(rabbit({ ctx: undefined })));
  } finally {
    await env.done();
  }
});

test('a line the writer committed after the reader opened is found by the next search', async () => {
  const env = await readerSetup();
  try {
    await env.service.tick();
    await env.service.searchRecord(rabbit());
    const observed = await env.service.observe(
      {
        v: 1,
        iface: 'discord',
        authority: 'discord/global',
        native: { kind: 'message', key: '600000000000000001', subtype: 'seen', revision: 1 },
        place: { authority: 'discord/global', key: 'channel:main', kind: 'channel', chat: 'group' },
        author: { kind: 'account', key: 'u-carol', account_kind: 'user' },
        occurredAt: new Date(NOW - 30_000).toISOString(),
        observedAt: new Date(NOW - 30_000).toISOString(),
        text: 'a fresh pangolin line',
        mentions: [],
        direct: false,
        relations: [],
      },
      { placeId: 'g1' }
    );
    assert.equal((observed as { ok: boolean }).ok, true);
    const plan = { forms: ['pangolin'], who: [], from: null, to: null };
    assert.ok(messageIds(await env.service.searchRecord(rabbit({ plan }))).includes('600000000000000001'));
  } finally {
    await env.done();
  }
});

test('a service without a worker answers the same search on its own connection', async () => {
  const env = await readerSetup({ options: { worker: false } });
  try {
    const args = rabbit();
    const found = await env.service.searchRecord(args);
    assert.ok(found.hits.length > 0);
    assert.deepEqual(found, search(env.service.database(), args));
  } finally {
    await env.done();
  }
});

// Wake runs through the service's writer, and stale runs interrupted at start-up. Synthetic data only; the ids are
// made up.

const wakesSettle = async () => {
  for (let i = 0; i < 5; i += 1) await new Promise((resolve) => setImmediate(resolve));
};

test('service: recordWake writes with no setting; an open interrupts the stale runs a dead process left', async () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-wakes-'));
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  buildDataDir(data);
  try {
    // A run a dead process left running.
    const before = openMemoryDb(path.join(data, 'memory.db'));
    startRun(before, { id: 'left', kind: 'heartbeat', startedAt: NOW - 30 * MINUTE });
    before.close();
    const hot = { config: { wakes: { loop: { timeBudgetMs: 3 * MINUTE } } } };
    const service = createMemoryDb({
      iface: () => 'discord',
      hot,
      dataDir: data,
      log: SILENT,
      worker: false,
      now: () => NOW,
    });
    await service.tick();
    await wakesSettle();
    await service.recordWake({ kind: 'wake', op: 'start', run: { id: 'r1', kind: 'heartbeat', startedAt: NOW } });
    await service.close();
    const reader = openMemoryDb(path.join(data, 'memory.db'), { readOnly: true });
    const status = Object.fromEntries(
      dbOf(reader)
        .prepare('SELECT id, status FROM wake_runs')
        .all()
        .map((row) => [row.id, row.status])
    );
    reader.close();
    assert.deepEqual(status, { left: 'interrupted', r1: 'running' });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// The writer thread of the service: turn reads are written by the worker, and a shutdown right after a turn writes
// them before the database closes. Synthetic data only.
const workerTmpRoot = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-worker-'));
const REAL_WORKER = pathToFileURL(path.resolve('src/memory/db/writer-worker.ts')).href;

function workerLogs() {
  const out: Array<Record<string, unknown>> = [];
  const add = (level: string) => (message: string, fields?: object) => out.push({ level, message, ...fields });
  return { out, info: add('info'), warn: add('warn'), error: add('error'), debug: add('debug') };
}

/**
 * A data directory and a service. `fake` names a behaviour for a stand-in worker that wraps the real one: it reads
 * `<root>/mode` at each write message (`crash-once`, `slow`, `hang`) before the real handlers see the message.
 */
function workerSetup({
  memoryDb = {},
  fake = false,
  ...rest
}: { memoryDb?: Record<string, unknown>; fake?: boolean; options?: Record<string, unknown> } = {}) {
  const root = workerTmpRoot();
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
  const log = workerLogs();
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
  const env = workerSetup();
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

test('a shutdown right after a turn writes its reads before the database closes, even when the deferred write has not run', async () => {
  const env = workerSetup({ options: { defer: () => {} } });
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

// A name the owner gives a person, written through the service's own method. Synthetic ids and names over a test
// memory service.

const KINDS_NOW = Date.parse('2026-11-10T10:00:00.000Z');

const ownerAliases = (db: Db, person: string): Array<unknown> =>
  db
    .prepare(
      "SELECT text FROM claims WHERE subject_id = ? AND kind = 'alias' AND author = 'owner' AND retired_at IS NULL"
    )
    .all(person)
    .map((row) => row.text);

test('the service writes an owner name through its own method and offers no unit write', async () => {
  const opened = await openTestMemory({ now: () => KINDS_NOW });
  try {
    const service = opened.memoryDb as unknown as Record<string, unknown>;
    assert.equal(service.writeUnit, undefined);
    await (service.writeOwnerName as (write: object) => Promise<unknown>)({ personId: 'person:self', name: 'Zefira' });
    const db = dbOf(opened.memoryDb.readHandle() as never);
    assert.deepEqual(ownerAliases(db, 'person:self'), ['Zefira']);
  } finally {
    await opened.close();
  }
});

// The private layer under the meta-person: a direct chat reads the private layer of its person across every account of
// that person, the owner's command line included, and no one else's. Synthetic ids and text only.

const AT = '2026-11-08T10:00:00.000Z';
const SCOPE_NOW = Date.parse('2026-11-08T12:00:00.000Z');
const OPTS = { now: () => SCOPE_NOW, log: quiet };
const AUTHORITY: Record<string, string> = { discord: 'discord/global', telegram: 'telegram/global', cli: 'cli/local' };

/** Observes one direct chat line from `native` on `iface` and answers the place it was stored under. */
function seeDm(handle: MemoryHandle, iface: string, native: string, key = `${native}:1`): string {
  const authority = AUTHORITY[iface] ?? `${iface}/global`;
  const result = observe(
    handle,
    {
      v: OBSERVATION_VERSION,
      iface,
      authority,
      native: { kind: 'message', key, revision: 1 },
      place: { authority, key: `dm:${native}`, kind: 'dm', chat: 'dm', partner: { key: native } },
      author: { kind: 'account', key: native },
      occurredAt: AT,
      observedAt: AT,
      text: `synthetic line ${key}`,
    },
    OPTS
  );
  assert.equal(result.ok, true, JSON.stringify(result));
  return String(result.placeId);
}

const personOf = (db: Db, account: string): string => String(personOfAccount(db, account));

/** A service over a database seeded by `seed`, closed after `body`. */
async function withService(
  seed: (handle: MemoryHandle) => void,
  body: (service: ReturnType<typeof createMemoryDb>, db: Db) => void
): Promise<void> {
  const dataDir = tempDir('nep-meta-scope-');
  const seeded = openMemoryDb(path.join(dataDir, 'memory.db'));
  seed(seeded);
  seeded.close();
  const service = createMemoryDb({
    iface: () => 'discord',
    dataDir,
    hot: { config: {} },
    log: { info() {}, warn() {}, error() {} },
    embed: () => Promise.resolve([]),
  });
  await service.open();
  try {
    body(service, service.database() as Db);
  } finally {
    await service.close();
  }
}

const dmContextOf = (
  service: ReturnType<typeof createMemoryDb>,
  db: Db,
  iface: string,
  account: string,
  place: string
) => service.issueContext({ kind: 'dm', iface, person: personOf(db, account), place });

const placeOfAccount = (db: Db, account: string): string =>
  String(db.prepare('SELECT id FROM places WHERE partner_account = ?').get(account)?.id);

test("from the owner's command line chat, their direct chat on another interface is readable", async () => {
  // Bug: the owner's command line chat and their chat on the platform are two audiences, so the persona cannot read one
  // from the other.
  await withService(
    (handle) => {
      seeDm(handle, 'discord', '900');
      seeDm(handle, 'cli', 'owner');
      applyMemoryWrite(handle, {
        kind: 'person-link',
        op: 'bind',
        accountId: 'cli:owner',
        target: { accountId: 'discord:900' },
        now: SCOPE_NOW,
      });
    },
    (service, db) => {
      const ctx = dmContextOf(service, db, 'cli', 'cli:owner', placeOfAccount(db, 'cli:owner'));
      assert.equal(allowedAudience({ audience_id: dmAudienceId(placeOfAccount(db, 'discord:900')) }, ctx), true);
    }
  );
});

test("another person's direct chat stays closed to a person's direct chat", async () => {
  // Bug: widening the private layer to every account opens the direct chat of someone who is not the same person.
  await withService(
    (handle) => {
      seeDm(handle, 'discord', '900');
      seeDm(handle, 'cli', 'owner');
      seeDm(handle, 'discord', '901');
      applyMemoryWrite(handle, {
        kind: 'person-link',
        op: 'bind',
        accountId: 'cli:owner',
        target: { accountId: 'discord:900' },
        now: SCOPE_NOW,
      });
    },
    (service, db) => {
      const ctx = dmContextOf(service, db, 'cli', 'cli:owner', placeOfAccount(db, 'cli:owner'));
      assert.equal(allowedAudience({ audience_id: dmAudienceId(placeOfAccount(db, 'discord:901')) }, ctx), false);
    }
  );
});

test('a member with two accounts reads their private layer from either account', async () => {
  // Bug: only the owner's accounts share a private layer, so a member bound to two accounts stays two audiences.
  await withService(
    (handle) => {
      seeDm(handle, 'discord', '700');
      seeDm(handle, 'telegram', '800');
      applyMemoryWrite(handle, {
        kind: 'person-link',
        op: 'bind',
        accountId: 'telegram:800',
        target: { accountId: 'discord:700' },
        now: SCOPE_NOW,
      });
    },
    (service, db) => {
      const discordDm = placeOfAccount(db, 'discord:700');
      const telegramDm = placeOfAccount(db, 'telegram:800');
      const fromDiscord = dmContextOf(service, db, 'discord', 'discord:700', discordDm);
      const fromTelegram = dmContextOf(service, db, 'telegram', 'telegram:800', telegramDm);
      assert.equal(allowedAudience({ audience_id: dmAudienceId(telegramDm) }, fromDiscord), true);
      assert.equal(allowedAudience({ audience_id: dmAudienceId(discordDm) }, fromTelegram), true);
    }
  );
});

// The private view of the service by person or by place, `privateByPerson` and `privateByPlace`, read through its read
// connection on a core with no root.

const opened: Array<MemoryDbService> = [];
after(async () => {
  for (const service of opened) await service.close();
});

function rig(): { env: ReturnType<typeof createOpsEnv>; memoryDb: MemoryDbService } {
  const dataDir = tempDir('nep-ops-private-');
  const seed = openMemoryDb(path.join(dataDir, 'memory.db'));
  seedOpaqueWorld(dbOf(seed));
  seed.close();
  const memoryDb = createMemoryDb({
    iface: () => 'discord',
    hot: { config: { memoryDb: { session: { mode: 'off' } } } },
    dataDir,
    log: { info() {}, debug() {}, warn() {}, error() {} },
    worker: false,
  });
  memoryDb.tick();
  opened.push(memoryDb);
  const rootDir = tempDir('nep-ops-private-root-');
  fs.mkdirSync(path.join(rootDir, 'prompts'));
  const hot = {
    config: { bot: { owners: [], access: {} }, llm: { model: 'x/y', maxRequestsPerDay: 10 } },
    prompts: { labels: {} },
    promptSources: {},
    promptsDir: path.join(rootDir, 'prompts'),
    localPromptsDir: path.join(rootDir, 'prompts.local'),
    rootDir,
    reloadConfig: () => true,
    reloadPrompts: () => true,
  };
  const env = createOpsEnv({
    hot,
    store: createStore({ dataDir, memoryDb }),
    memoryDb,
    dataDir,
  });
  return { env, memoryDb };
}

test('the service answers the same views through its read connection', () => {
  // Bug: the operation opens the database itself, past the one writer and its read seam.
  const { memoryDb } = rig();
  const view = memoryDb.privateByPerson(ANNA, internalContext());
  assert.equal(view.found && view.person.id, ANNA);
  assert.equal(memoryDb.privateByPlace('place:nowhere', internalContext()).found, false);
});

// The focus job of the memory service (src/memory/db/service.ts over src/memory/db/focus.ts): it runs at the first
// tick, once a UTC day, on the main thread and on the worker, and the reader of the sets carries the share.

const focusQuiet = { info() {}, debug() {}, warn() {}, error() {} };
const DAY = 86_400_000;
const HOUR = 3_600_000;

// ---------- the daily job ----------

function serviceEnv({ worker = false }: { worker?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-focus-'));
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  buildDataDir(data);
  // The focus job and its measures are code (an exploring share of 0.15).
  const hot = { config: {} };
  let time = Date.UTC(2026, 9, 24, 12, 0, 0);
  const service = createMemoryDb({
    iface: () => 'discord',
    hot,
    dataDir: data,
    log: focusQuiet,
    now: () => time,
    ...(worker ? {} : { worker: false }),
  });
  return {
    hot,
    service,
    file: path.join(data, 'memory.db'),
    advance: (ms: number) => {
      time += ms;
    },
    done: async () => {
      await service.close().catch(() => {});
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}
const focusDayOf = (file: string) => {
  const reader = openMemoryDb(file, { readOnly: true });
  try {
    return {
      day: lastFocusDay(wrongly(sqlOf(reader))),
      events: sqlOf(reader).prepare('SELECT COUNT(*) AS n FROM focus_events').get().n,
    };
  } finally {
    reader.close();
  }
};
const focusSettle = () => new Promise((resolve) => setTimeout(resolve, 50));

test('service: the focus job runs at the first tick with no setting', async () => {
  const env = serviceEnv();
  try {
    await env.service.tick();
    await focusSettle();
    assert.equal(focusDayOf(env.file).day, '2026-10-24');
  } finally {
    await env.done();
  }
});

// The focus job is code with no switch: the next test holds the job running with no setting.
test('service: the focus job runs once a UTC day; the reader carries the share; on the worker too', async () => {
  const env = serviceEnv();
  try {
    await env.service.tick();
    await focusSettle();
    assert.equal(focusDayOf(env.file).day, '2026-10-24');
    const events = focusDayOf(env.file).events;
    env.advance(HOUR);
    await env.service.tick();
    await focusSettle();
    assert.equal(focusDayOf(env.file).events, events, 'once a day');
    env.advance(DAY);
    await env.service.tick();
    await focusSettle();
    assert.equal(focusDayOf(env.file).day, '2026-10-25');
    const view: Untyped = env.service.focusPeople();
    assert.deepEqual(Object.keys(view).sort(), ['close', 'exploring', 'exploringShare']);
    assert.equal(present(view).exploringShare, 0.15);
  } finally {
    await env.done();
  }
  const threaded = serviceEnv({ worker: true });
  try {
    await threaded.service.tick();
    await threaded.service.close();
    assert.equal(focusDayOf(threaded.file).day, '2026-10-24', 'through the worker');
    assert.equal(threaded.service.focusPeople(), null, 'closed: no sets');
  } finally {
    await threaded.done();
  }
});

// The engine's memory starts from the memory database alone: a data directory that holds only `memory.db` and the
// operational files (fixtures/memory-db/legacy-paths.ts), every memory file gone, wired the way src/index.ts wires its memory
// (the database service on its writer, the store, the record, the archive with its pending queue, the journal, the
// meaning index and its queue, the intention and task stores). Everything the fixture held is read back from the
// database, a day of writes goes into it, and after the shutdown no memory file was written and a fresh start reads the
// new writes back. Synthetic data only; the ids are made up.

const ONLY_START_NOW = Date.parse('2026-10-24T12:00:00.000Z');
const onlyStartQuiet = { info() {}, debug() {}, warn() {}, error() {} };
const DB_FILES = new Set(['memory.db', 'memory.db-wal', 'memory.db-shm', 'memory.db.lock']);

/** Every file under `dir`, relative with forward slashes. */
function filesOf(dir: string, rel = '', out = []) {
  for (const entry of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) filesOf(dir, child, out);
    else out.push(wrongly(child));
  }
  return out;
}

/** The fixture written into its database, then every file but the database's own and the operational ones removed. */
function databaseOnly() {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-only-'));
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  buildDataDir(data);
  // The fixture's errand goes onto the board, where the errand store reads it.
  const handle = openMemoryDb(path.join(data, 'memory.db'));
  try {
    assert.equal(seedUnits(handle, data, { now: ONLY_START_NOW - 86_400_000 }).errors, 0);
    fileFixtureErrand(dbOf(handle));
  } finally {
    handle.close();
  }
  for (const rel of filesOf(data)) {
    if (!DB_FILES.has(rel) && !isOperational(rel)) fs.rmSync(path.join(data, rel));
  }
  return { root, data };
}

/** The memory modules over `data`, as src/index.ts builds them (the clock fixed, no network, no model). */
async function engine(data: string, log = onlyStartQuiet) {
  const config = {
    features: { record: true, journal: true, archive: true, intentions: true },
    memoryDb: { session: { mode: 'off' } },
    errands: { maxOpen: 3 },
    agents: { scout: { daily: { tasks: 5 } } },
  };
  const hot = { config, prompts: {} };
  const memoryDb = createMemoryDb({
    iface: () => 'discord',
    hot,
    dataDir: data,
    log,
    now: () => ONLY_START_NOW,
    worker: false,
  });
  // Eager state readers require the database before store construction.
  await memoryDb.open();
  const archiveAppendStore = createAppendStore({ fsyncMs: 0, log });
  const record = createRecord({ dataDir: data, log, now: () => ONLY_START_NOW, memoryDb });
  const vectors = createVectors({ dataDir: data, log, now: () => ONLY_START_NOW, memoryDb });
  const archive = createArchive({
    appendStore: archiveAppendStore,
    dataDir: data,
    log,
    now: () => ONLY_START_NOW,
    memoryDb,
  });
  const journal = createJournal({
    dataDir: data,
    config: () => ({}),
    lockStores: [archiveAppendStore],
    now: () => ONLY_START_NOW,
    memoryDb,
    log,
  });
  const store = createStore({ dataDir: data, archive, archiveOn: () => true, memoryDb });
  const embedQueue = createEmbedder({
    hot,
    vectors,
    embed: async () => [],
    record,
    log,
    now: () => ONLY_START_NOW,
    memoryDb,
  });
  const taskStores = createErrandStores({ config: () => config, journal, log, now: () => ONLY_START_NOW, memoryDb });
  const intentionStores = createIntentionStores({ log, now: () => ONLY_START_NOW, memoryDb });
  return {
    memoryDb,
    store,
    record,
    archive,
    journal,
    vectors,
    embedQueue,
    taskStores,
    intentionStores,
    /** The shutdown of src/index.ts: the stores' writes, the queue, then the database. */
    async close() {
      store.flush();
      await store.flushSettled({ final: true });
      await present(taskStores.get()).flush({ final: true });
      await present(intentionStores.get()).flush({ final: true });
      await embedQueue.close?.({ timeoutMs: 100 });
      await archiveAppendStore.close();
      await memoryDb.close();
    },
  };
}

test('the memory starts from memory.db and the operational files alone, writes only to the database, and a restart reads it back', async () => {
  const { root, data } = databaseOnly();
  try {
    const before = filesOf(data);
    assert.ok(
      before.every((rel) => DB_FILES.has(rel) || isOperational(rel)),
      `only the database and operational files: ${before}`
    );
    assert.ok(before.includes(wrongly('memory.db')));

    const warnings: Array<Untyped> = [];
    const log: Untyped = {
      ...onlyStartQuiet,
      warn: (message: string, fields: Record<string, Untyped>) => warnings.push({ message, ...fields }),
      error: (message: string, fields: Record<string, Untyped>) => warnings.push({ message, ...fields }),
    };
    const first = await engine(data, log);
    await first.memoryDb.tick();
    assert.equal(first.memoryDb.status().open, true);

    // What the fixture held comes back from the database.
    assert.equal(wrongly<{ id: string } | null>(first.store.getUser(accountOf(first.store, MEMBER)))?.id, MEMBER);
    assert.ok(first.store.getPlace(placeOfRoot(first.store, GUILD)), 'the guild memory');
    assert.equal(first.store.getChannel(placeOfChat(first.store, { id: CHANNEL }))?.id, CHANNEL);
    assert.deepEqual(unitSubjects(first.memoryDb.readHandle()?.db, 'private'), [`discord:${MEMBER}`]);
    const lines = [];
    for await (const line of first.record.iterate(legacyServerPlaceId('discord', GUILD), {
      from: '2026-10-20T00:00:00.000Z',
      to: '2026-10-20T23:59:59.999Z',
    }))
      lines.push(line);
    assert.ok(lines.length > 0, 'the record day');
    assert.ok(
      (await first.journal.read(legacyServerPlaceId('discord', GUILD), { day: '2026-10-20', n: 100 })).length > 0,
      'the journal day'
    );
    // Errands on the board: the fixture's errand is read from its board task.
    assert.deepEqual(
      present(first.taskStores.get())
        .recent(10)
        .map((task) => task.id),
      ['t1']
    );
    assert.ok(Array.isArray(present(first.intentionStores.get()).list()));
    assert.ok((await first.vectors.stats(GUILD)).rows >= 0);

    // A day of writes.
    first.store.touchUser(accountOf(first.store, '100000000000000077'), 'Zoé', ONLY_START_NOW);
    first.store.setLore(
      placeOfRoot(first.store, GUILD),
      [{ title: 'Η πλατεία', keys: ['πλατεία'], text: 'The square by the sea.' }],
      {
        source: 'owner',
        by: 'owner',
        now: ONLY_START_NOW,
      }
    );
    const said = toRecordLine({
      id: '700000000000000001',
      placeId: CHANNEL,
      authorId: MEMBER,
      authorName: 'Ana',
      content: 'Καλημέρα, café?',
      ts: ONLY_START_NOW,
      attachments: [],
      links: [],
      stickers: [],
      emojis: [],
    });
    assert.deepEqual(await first.record.append(legacyServerPlaceId('discord', GUILD), [said]), {
      written: 1,
      duplicates: 0,
    });
    await first.journal.system({ event: 'pause', by: 'owner' });
    const task = present(first.taskStores.get()).add({
      agent: 'scout',
      goal: 'find the café hours',
      requester: { accountId: MEMBER, kind: 'member' },
      origin: { placeId: CHANNEL, messageId: null },
      scope: 'group',
    });
    assert.equal(task.ok, true);
    await first.close();

    // No memory file was written; the database and the operational files are all there is.
    const after = filesOf(data);
    assert.deepEqual(
      after.filter((rel) => isMemoryPath(rel)),
      [],
      'no memory file'
    );
    assert.ok(
      after.every((rel: string) => DB_FILES.has(rel) || isOperational(rel)),
      `${after}`
    );
    assert.deepEqual(
      warnings.filter((entry) => /failed|refused|pending|lost/.test(entry.message)),
      []
    );

    // A fresh start reads the new writes back from the database.
    const second = await engine(data);
    await second.memoryDb.tick();
    try {
      assert.equal(
        wrongly<{ names?: Array<string> } | null>(second.store.getUser(accountOf(second.store, '100000000000000077')))
          ?.names?.[0],
        'Zoé'
      );
      assert.ok(
        second.store
          .getLore(placeOfRoot(second.store, GUILD))
          .some((entry: Record<string, Untyped>) => entry.title === 'Η πλατεία')
      );
      assert.equal(
        await second.record.newestRevision(
          legacyServerPlaceId('discord', GUILD),
          '700000000000000001',
          new Date(ONLY_START_NOW).toISOString()
        ),
        1
      );
      assert.ok(
        (await second.journal.read(null, { day: '2026-10-24', n: 100 })).some(
          (entry: Record<string, Untyped>) => entry.kind === 'system' && entry.event === 'pause'
        )
      );
      assert.ok(present(second.taskStores.get()).get(task.errand.id), 'the task');
    } finally {
      await second.close();
    }
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// `search` (src/memory/db/recall.ts) off the main thread: the service's `searchRecord` runs it in the reader worker
// (src/memory/db/reader-worker.ts) on a read-only connection with the results and the audience of the synchronous call,
// the event loop stays free meanwhile, a deadline abandons a slow search, a dead reader is a concrete error the turn
// survives, and shutdown closes the reader before the writer. Slowness comes from a stand-in worker that blocks in front
// of the real reader, so no test depends on how fast this machine scans vectors. Synthetic data only.

const RECALL_OFF_MAIN_NOW = Date.parse('2026-10-24T12:00:00.000Z');
const RECALL_OFF_MAIN_MINUTE = 60_000;
const RECALL_OFF_MAIN_MAIN = channelPlaceId('discord', 'main');
const RECALL_OFF_MAIN_OTHER = channelPlaceId('discord', 'other');
const RECALL_OFF_MAIN_ALICE = 'u-alice';
const RECALL_OFF_MAIN_BOB = 'u-bob';
const RECALL_OFF_MAIN_ALICE_PERSON = personId('discord', RECALL_OFF_MAIN_ALICE);
const RECALL_OFF_MAIN_BOB_PERSON = personId('discord', RECALL_OFF_MAIN_BOB);
const RECALL_OFF_MAIN_VECTOR = [1, 0, 0, 0];
const RECALL_OFF_MAIN_REAL_READER = pathToFileURL(path.resolve('src/memory/db/reader-worker.ts')).href;
const RECALL_OFF_MAIN_SLOW_MS = 1000;
const RECALL_OFF_MAIN_STALE_MS = 60_000;

const recallOffMainTmpRoot = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-off-main-'));

/** A file database with group lines in two channels, one DM line each for two people, an account and vectors. */
function recallOffMainWriteFixtureDb(file: string): void {
  const env = fixture();
  try {
    insertRows(env.db, {
      places: [
        {
          id: RECALL_OFF_MAIN_MAIN,
          iface: 'discord',
          kind: 'channel',
          native_id: 'main',
          scope_kind: 'group',
          name: 'main',
        },
        {
          id: RECALL_OFF_MAIN_OTHER,
          iface: 'discord',
          kind: 'channel',
          native_id: 'other',
          scope_kind: 'group',
          name: 'other',
        },
        {
          id: dmPlaceId('discord', RECALL_OFF_MAIN_ALICE),
          iface: 'discord',
          kind: 'dm',
          native_id: null,
          scope_kind: 'dm',
          partner_person: RECALL_OFF_MAIN_ALICE_PERSON,
        },
        {
          id: dmPlaceId('discord', RECALL_OFF_MAIN_BOB),
          iface: 'discord',
          kind: 'dm',
          native_id: null,
          scope_kind: 'dm',
          partner_person: RECALL_OFF_MAIN_BOB_PERSON,
        },
      ],
    });
    env.account(RECALL_OFF_MAIN_ALICE, ['Alice']);
    env.account(RECALL_OFF_MAIN_BOB, ['Bob']);
    env.say({
      native: 'main-1',
      at: RECALL_OFF_MAIN_NOW - 5 * RECALL_OFF_MAIN_MINUTE,
      text: 'the rabbit left the garden',
    });
    env.say({
      native: 'main-2',
      at: RECALL_OFF_MAIN_NOW - 4 * RECALL_OFF_MAIN_MINUTE,
      text: 'a rabbit came back at dusk',
      author: RECALL_OFF_MAIN_BOB,
    });
    env.say({
      native: 'main-3',
      at: RECALL_OFF_MAIN_NOW - 3 * RECALL_OFF_MAIN_MINUTE,
      text: 'nothing about animals in this line',
    });
    env.say({
      native: 'other-1',
      at: RECALL_OFF_MAIN_NOW - 2 * RECALL_OFF_MAIN_MINUTE,
      text: 'the rabbit in the other channel',
      place: RECALL_OFF_MAIN_OTHER,
    });
    env.say({
      native: 'dm-alice',
      at: RECALL_OFF_MAIN_NOW - RECALL_OFF_MAIN_MINUTE,
      text: 'the secret rabbit of alice',
      place: dmPlaceId('discord', RECALL_OFF_MAIN_ALICE),
      scope: dmScope(RECALL_OFF_MAIN_ALICE_PERSON, 'discord'),
    });
    env.say({
      native: 'dm-bob',
      at: RECALL_OFF_MAIN_NOW - RECALL_OFF_MAIN_MINUTE,
      text: 'the secret rabbit of bob',
      author: RECALL_OFF_MAIN_BOB,
      place: dmPlaceId('discord', RECALL_OFF_MAIN_BOB),
      scope: dmScope(RECALL_OFF_MAIN_BOB_PERSON, 'discord'),
    });
    env.vector('main-3', RECALL_OFF_MAIN_VECTOR);
    env.vector('main-1', [0.9, 0.1, 0, 0]);
    env.vector('dm-alice', RECALL_OFF_MAIN_VECTOR, { scope: dmScope(RECALL_OFF_MAIN_ALICE_PERSON, 'discord') });
    env.stem();
    fillEnvAudiences(env);
    env.db.prepare('VACUUM INTO ?').run(file);
  } finally {
    env.done();
  }
}

/** A stand-in reader that reads `<root>/mode` at each message but `open` and `close`, then lets the real reader answer. */
function recallOffMainStandInReader(root: string): URL {
  const file = pathToFileURL(path.join(root, 'stand-in-reader.mjs'));
  fs.writeFileSync(
    file,
    `
import { parentPort } from 'node:worker_threads';
import fs from 'node:fs';
const root = ${JSON.stringify(root)};
const block = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const once = (name) => {
  if (fs.existsSync(root + '/' + name)) return false;
  fs.writeFileSync(root + '/' + name, '1');
  return true;
};
parentPort.on('message', (message) => {
  if (message.type === 'open' || message.type === 'close') return;
  let mode = '';
  try { mode = fs.readFileSync(root + '/mode', 'utf8'); } catch { /* none */ }
  if (mode === 'slow') block(${RECALL_OFF_MAIN_SLOW_MS});
  if (mode === 'hang') block(${RECALL_OFF_MAIN_STALE_MS});
  if (mode === 'hang-once' && once('hung')) block(${RECALL_OFF_MAIN_STALE_MS});
  if (mode === 'crash-once' && once('crashed')) process.exit(3);
});
await import(${JSON.stringify(RECALL_OFF_MAIN_REAL_READER)});
`
  );
  return file;
}

/** The fixture database, a service over it and a config both read. `standIn` puts the blocking worker before the reader. */
async function recallOffMainSetup({
  standIn = false,
  memoryDb = {},
  recall = {},
  options = {},
}: {
  standIn?: boolean;
  memoryDb?: Record<string, unknown>;
  recall?: Record<string, unknown>;
  options?: Record<string, unknown>;
} = {}) {
  const root = recallOffMainTmpRoot();
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  const file = path.join(data, 'memory.db');
  recallOffMainWriteFixtureDb(file);
  const hot = {
    config: config({
      features: { recall: true, meaningSearch: false },
      // A short close bound: a stand-in may still hold the reader when the test closes the service.
      memoryDb: { session: { mode: 'off' }, closeTimeoutMs: 500, ...memoryDb },
      recall: {
        prefetch: {
          deadlineMs: 100,
          maxTokens: 1500,
          contextTokens: 500,
          minFormsMatched: 1,
          singleTermScore: 0,
          maxTermShare: 1,
          trivial: [],
        },
        ...recall,
      },
    }),
    prompts: { labels },
  };
  const service = createMemoryDb({
    iface: () => 'discord',
    hot,
    dataDir: data,
    now: () => RECALL_OFF_MAIN_NOW,
    ...(standIn ? { readerFile: recallOffMainStandInReader(root) } : {}),
    ...options,
  });
  await service.open();
  return {
    root,
    file,
    hot,
    service,
    mode: (value: string) => fs.writeFileSync(path.join(root, 'mode'), value),
    done: async () => {
      await service.close().catch(() => {});
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

const recallOffMainRabbit = (extra: Record<string, unknown> = {}) => ({
  ctx: groupContext('discord'),
  plan: { forms: ['rabbit'], who: [], from: null, to: null },
  limit: 8,
  now: RECALL_OFF_MAIN_NOW,
  settings: dbSettings({}),
  ...extra,
});

/** The code a promise rejects with. A promise that answers fails the test. */
async function codeOfRejection(promise: Promise<unknown>): Promise<unknown> {
  try {
    await promise;
  } catch (error) {
    return (error as { code?: unknown } | null)?.code;
  }
  return assert.fail('the search answered; a rejection with a code was expected');
}

test('a reader that dies leaves the writer writing', async () => {
  const env = await recallOffMainSetup({ standIn: true });
  try {
    env.mode('crash-once');
    await codeOfRejection(env.service.searchRecord(recallOffMainRabbit()));
    await writeUnitUpdate(env.service, {
      op: 'value',
      file: 'guilds/g1/users/u-new.json',
      value: { id: 'u-new', names: ['New'] },
    });
    const row = env.service.database()?.prepare("SELECT COUNT(*) AS n FROM accounts WHERE native_id = 'u-new'").get();
    assert.equal(row?.n, 1);
  } finally {
    await env.done();
  }
});

test('a clean close leaves no WAL behind: the reader is gone before the writer closes', async () => {
  const env = await recallOffMainSetup();
  try {
    assert.ok((await env.service.searchRecord(recallOffMainRabbit())).hits.length > 0);
    await env.service.close();
    assert.equal(fs.existsSync(`${env.file}-wal`), false);
    assert.equal(fs.existsSync(`${env.file}.lock`), false);
  } finally {
    await env.done();
  }
});

// A sample (`sampleTime`, src/memory/db/recall.ts) through the reader thread: the rule of which places it may read is a
// function, so the main thread turns it into a list, and the worker answers from that list what the synchronous search
// answers. Synthetic data on a real file database.

const RECALL_SAMPLED_OFF_MAIN_NOW = Date.parse('2026-11-05T12:00:00.000Z');
const DAY_START = Date.parse('2026-11-01T00:00:00.000Z');
const RECALL_SAMPLED_OFF_MAIN_HOUR = 3600000;
const RECALL_SAMPLED_OFF_MAIN_MAIN = channelPlaceId('discord', 'main');
const RECALL_SAMPLED_OFF_MAIN_OTHER = channelPlaceId('discord', 'other');
const SHUT = channelPlaceId('discord', 'shut');

async function recallSampledOffMainSetup() {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-sampled-'));
  const data = path.join(root, 'data');
  fs.mkdirSync(data, { recursive: true });
  const env = fixture();
  for (let i = 0; i < 12; i += 1) {
    env.say({
      native: `main-${i}`,
      at: DAY_START + i * RECALL_SAMPLED_OFF_MAIN_HOUR,
      text: `line main ${i}`,
      place: RECALL_SAMPLED_OFF_MAIN_MAIN,
    });
    env.say({
      native: `other-${i}`,
      at: DAY_START + i * RECALL_SAMPLED_OFF_MAIN_HOUR + 1,
      text: `line other ${i}`,
      place: RECALL_SAMPLED_OFF_MAIN_OTHER,
    });
    env.say({
      native: `shut-${i}`,
      at: DAY_START + i * RECALL_SAMPLED_OFF_MAIN_HOUR + 2,
      text: `line shut ${i}`,
      place: SHUT,
    });
  }
  env.stem();
  fillEnvAudiences(env);
  env.db.prepare('VACUUM INTO ?').run(path.join(data, 'memory.db'));
  env.done();
  const hot = {
    config: config({
      features: { recall: true, meaningSearch: false },
      memoryDb: { session: { mode: 'off' }, closeTimeoutMs: 500 },
    }),
    prompts: { labels },
  };
  const service = createMemoryDb({
    iface: () => 'discord',
    hot,
    dataDir: data,
    now: () => RECALL_SAMPLED_OFF_MAIN_NOW,
  });
  await service.open();
  return {
    service,
    done: async () => {
      await service.close().catch(() => {});
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

const theDay = (extra: Record<string, unknown> = {}) => ({
  ctx: groupContext('discord'),
  plan: { forms: [], who: [], from: DAY_START, to: DAY_START + 24 * RECALL_SAMPLED_OFF_MAIN_HOUR - 1 },
  limit: 3,
  now: RECALL_SAMPLED_OFF_MAIN_NOW,
  settings: dbSettings({}),
  sampleTime: true,
  ...extra,
});

test('a sample through the reader answers what the synchronous search answers, sampled included', async () => {
  const env = await recallSampledOffMainSetup();
  try {
    const args = theDay({
      allowPlace: (place: string) => place !== RECALL_SAMPLED_OFF_MAIN_OTHER,
      samplePlace: (place: string) => place !== SHUT,
    });
    const expected = search(env.service.database(), args);
    assert.equal(expected.sampled, true);
    const found = await env.service.searchRecord(args);
    assert.deepEqual(found, expected);
    assert.ok(found.hits.length > 0);
    assert.ok(found.hits.every((hit) => hit.placeId === RECALL_SAMPLED_OFF_MAIN_MAIN));
  } finally {
    await env.done();
  }
});

test('a rule that refuses every place answers nothing through the reader, and not sampled', async () => {
  const env = await recallSampledOffMainSetup();
  try {
    const found = await env.service.searchRecord(theDay({ samplePlace: () => false }));
    assert.deepEqual([found.hits.length, found.windows.length, found.sampled], [0, 0, false]);
  } finally {
    await env.done();
  }
});

test('a word search through the reader ignores the sample rule and says it is no sample', async () => {
  const env = await recallSampledOffMainSetup();
  try {
    const found = await env.service.searchRecord(
      theDay({ plan: { forms: ['shut'], who: [], from: null, to: null }, samplePlace: () => false })
    );
    assert.ok(found.hits.length > 0);
    assert.equal(found.sampled, false);
  } finally {
    await env.done();
  }
});

// The write kind `record-lines` (src/memory/db/record-lines.ts): the lines of the record written as `sources` rows of
// their place's day directly instead of through the record mapper of a unit write. The first tests write the same lines
// through the unit write of each day and through the write kind, and compare every table column by column: the rows,
// their day's unit, the message families, the media and the relations.

const RECORD_LINES_NOW = Date.parse('2026-11-09T10:00:00.000Z');
const DAY2 = '2026-11-09T08:00:00.000Z';

const said = (id: string, messageId: string, occurredAt: string, extra: Row = {}): Row => ({
  v: 1,
  id,
  kind: 'said',
  messageId,
  revision: 1,
  occurredAt,
  recordedAt: occurredAt,
  scope: { channel: 'room-a' },
  replyTo: null,
  text: `her words ${id}`,
  media: [],
  mentions: [],
  turnId: 'turn-1',
  opId: 'op-1',
  participants: [],
  sourceMessageIds: [messageId],
  origin: 'live',
  ...extra,
});

test('the service hands its `newId` to the record writes it runs on its own thread', async () => {
  const dataDir = tempDataDir();
  let drawn = 0;
  const memoryDb = createMemoryDb({
    hot: { config: { memoryDb: { session: { mode: 'off' } } }, prompts: {} },
    dataDir,
    now: () => RECORD_LINES_NOW,
    worker: false,
    iface: () => 'synthetic',
    newId: () => `key-${(drawn += 1)}`,
  });
  try {
    await memoryDb.open();
    const db = memoryDb.database() as Db;
    addChannelPlace(db, { id: 'place:4c13', iface: 'synthetic', authority: 'synthetic/global', native: 'room-a' });
    await memoryDb.writeRecordLines({ placeId: 'place:4c13', lines: [said('s10', 'm42', DAY2)] });
    const keys = db.prepare('SELECT native_key FROM message_families WHERE message_id = ?').all('m42');
    assert.deepEqual(
      keys.map((row) => row.native_key),
      ['key-1']
    );
  } finally {
    await memoryDb.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

// The memory database service (src/memory/db/service.ts): the open and the writer lock, the shutdown, the per-turn
// record, the session writes and the status line. Synthetic data directories only; the clock and the loop are injected.

const serviceTmpRoot = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-svc-'));

type ServiceLogFn = (message: string, fields?: object) => unknown;

function serviceLogs(): {
  out: Array<Record<string, unknown>>;
  info: ServiceLogFn;
  warn: ServiceLogFn;
  error: ServiceLogFn;
  debug?: ServiceLogFn;
} {
  const out: Array<Record<string, unknown>> = [];
  const add = (level: string) => (message: string, fields?: object) => out.push({ level, message, ...fields });
  return { out, info: add('info'), warn: add('warn'), error: add('error'), debug: add('debug') };
}

/** A data directory whose units are in its database, a config and a service whose loop is stepped by hand when `manual` is set. */
function serviceSetup({
  memoryDb = {},
  manual = false,
  ...rest
}: { memoryDb?: Record<string, unknown>; manual?: boolean; [option: string]: unknown } = {}) {
  // These tests run the service on the calling thread; tests/src/memory/db/writer-worker.test.ts covers the worker.
  const root = serviceTmpRoot();
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
  const log = serviceLogs();
  const queue: Array<() => void> = [];
  let time = Date.UTC(2026, 9, 24, 12, 0, 0);
  const service = createMemoryDb({
    iface: () => 'discord',
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

test('status: the state of the database for the card, and its line from the labels', async () => {
  const env = serviceSetup();
  try {
    const labels = { status: { memoryDb: { unavailable: 'DOWN', ok: 'rows {rows}' } } };
    assert.equal(env.service.status().open, false);
    assert.equal(memoryDbStatusLine(env.service.status(), labels), 'DOWN');
    await env.service.tick();
    const status = env.service.status();
    assert.equal(status.open, true);
    assert.ok(status.rows! > 0);
    assert.equal(memoryDbStatusLine(status, labels), `rows ${status.rows}`);
    // A label the writer has not filled yet leaves the line out.
    assert.equal(memoryDbStatusLine(status, { status: { memoryDb: { ok: '' } } }), null);
    assert.equal(memoryDbStatusLine(status, {}), null);
  } finally {
    await env.done();
  }
});

// The persona's memory session (src/memory/db/session.ts, session-write.js): the request, the answer's checks, the id mapping, shadow
// and apply writes, the refusals. A fake llm and synthetic Greek and accented Latin text only; nothing leaves the process.

test('writes from the main thread go through the worker: a session write lands in the database the worker owns', async () => {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-session-worker-'));
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  buildDataDir(data);
  const hot = { config: { memoryDb: { session: { mode: 'off' } } } };
  const service = createMemoryDb({
    iface: () => 'discord',
    hot,
    dataDir: data,
    log: { info() {}, warn() {}, error() {}, debug() {} },
    now: () => SESSION_NOW,
  });
  try {
    await service.tick();
    assert.ok(service.database(), 'opened');
    const run = {
      id: 'run:w',
      sweepId: 'sweep:w',
      scopeKey: 'group:discord',
      scope: { scope_kind: 'group', scope_iface: 'discord', scope_dm: null },
      startedAt: new Date(SESSION_NOW).toISOString(),
      finishedAt: new Date(SESSION_NOW).toISOString(),
      cursorFrom: 0,
      cursorTo: 7,
      sourcesN: 3,
      outcome: 'ok',
      counts: { claims: 1 },
      errors: [],
    };
    const plan = {
      claims: [
        {
          op: 'add',
          subjectKind: 'self',
          subjectId: memoryIds.SELF_PERSON,
          kind: 'self_fact',
          text: 'a fact',
          how: 'saw',
          sources: [],
          when: null,
        },
      ],
      episodes: [],
      affinity: [],
      descriptions: [],
    };
    const counts = (await service.memoryWrite({
      kind: 'session',
      mode: 'shadow',
      run,
      plan,
      advance: { key: cursorKey('shadow', 'group:discord'), value: 7 },
      now: SESSION_NOW,
    })) as Applied;
    assert.equal(counts.proposed, 1);
    const db = service.database();
    assert.equal(db!.prepare("SELECT outcome FROM session_runs WHERE id = 'run:w'").get()!.outcome, 'ok');
    assert.equal(db!.prepare("SELECT action FROM decisions WHERE id = 'dec:run:w:1'").get()!.action, 'proposed:add');
    assert.equal(
      db!.prepare('SELECT value FROM meta WHERE key = ?').get(cursorKey('shadow', 'group:discord'))!.value,
      '7'
    );
    await service.close();
    await assert.rejects(
      () => service.memoryWrite({ kind: 'description', row: {} }),
      (error: NodeJS.ErrnoException) => error.code === 'DB_CLOSED'
    );
  } finally {
    await service.close().catch(() => {});
    fs.rmSync(root, { recursive: true, force: true });
  }
});
type Applied = Record<string, number | boolean | undefined>;

// The memory database has two writers of one member's profile: the persona's memory
// session (src/memory/db/session-write.ts) and the unit sync of the store's cached file (src/memory/db/upsert.ts). Each
// test runs a session write, then a unit flush of the same file through the store, then reads the profile back the
// way the persona's turns read it (`store.getUser`, readers/common.ts#unitValue). What the session wrote must survive the flush and be
// in the profile. Two suspects of the same shape close the file: the diary's fetched text and an observation's update
// of an account. Synthetic data only (Greek or accented Latin for non-ASCII); the ids are made up.

type TwoWritersRow = Record<string, unknown>;
type Statement = {
  all(...params: Array<unknown>): Array<TwoWritersRow>;
  get(...params: Array<unknown>): TwoWritersRow | undefined;
};
type TwoWritersDb = { prepare(sql: string): Statement };
type Move = { ts?: unknown; reason?: unknown; appliedDelta?: unknown; delta?: unknown };
type Item = { itemId?: unknown; text?: unknown; topic?: unknown; what?: unknown; lastSeen?: unknown };
type Profile = {
  details?: Array<Item>;
  interests?: Array<Item>;
  episodes?: Array<Item>;
  character?: unknown;
  relationship?: unknown;
  relationshipScore?: unknown;
  relationshipWrittenAt?: unknown;
  affinity?: { score?: unknown; reason?: unknown; history?: Array<Move> };
};
type Scope = { scope_kind: string; scope_iface: string; scope_dm: string | null };

const TWO_WRITERS_NOW = Date.parse('2026-10-31T12:00:00.000Z');
const TWO_WRITERS_AT = new Date(TWO_WRITERS_NOW).toISOString();
const twoWritersQuiet = { info(): void {}, debug(): void {}, warn(): void {}, error(): void {} };
const PERSON = `person:discord:${MEMBER}`;
const USER_REL = `guilds/${GUILD}/users/${MEMBER}.json`;
const PRIVATE_REL = `guilds/${GUILD}/private/${MEMBER}.json`;
const GROUP: Scope = { scope_kind: 'group', scope_iface: 'discord', scope_dm: null };
const DM: Scope = { scope_kind: 'dm', scope_iface: 'discord', scope_dm: PERSON };
const GROUP_LINE = '400000000000000001';
const DM_LINE = '400000000000000005';
const DIARY_POST = 'd-1';

/** The stored profile of the member: two details, an empty interest list, one episode, two texts, one old move. */
const PROFILE = {
  id: MEMBER,
  names: ['Ada'],
  firstSeen: '2026-09-01T00:00:00.000Z',
  lastSeen: '2026-10-29T00:00:00.000Z',
  messageCount: 10,
  details: [
    {
      itemId: 'det-cafe',
      text: 'drinks a café at nine',
      weight: 1,
      firstSeen: '2026-09-01T00:00:00.000Z',
      lastSeen: '2026-09-02T00:00:00.000Z',
    },
    {
      itemId: 'det-sea',
      text: 'swims in the sea',
      weight: 1,
      firstSeen: '2026-09-01T00:00:00.000Z',
      lastSeen: '2026-09-03T00:00:00.000Z',
    },
  ],
  interests: [],
  episodes: [
    {
      itemId: 'ep-file',
      date: '2026-09-05',
      what: 'told the story of a long swim',
      weight: 1,
      addedAt: '2026-09-05T00:00:00.000Z',
    },
  ],
  character: 'Calm, answers slowly.',
  relationship: 'We talk about the sea.',
  relationshipWrittenAt: '2026-10-01T00:00:00.000Z',
  relationshipScore: 10,
  affinity: {
    score: 10,
    reason: 'shared a swim story',
    history: [{ ts: '2026-09-20T00:00:00.000Z', delta: 2, appliedDelta: 2, score: 10, reason: 'shared a swim story' }],
  },
};

/** The memory units of the scene, written as files, seeded into the database and taken off the disk again. */
function seededDataDir(): string {
  const data = path.join(tempDir('memdb-two-writers-'), 'data');
  const guild = path.join(data, 'guilds', GUILD);
  const files = [
    path.join(guild, 'users', `${MEMBER}.json`),
    path.join(guild, 'private', `${MEMBER}.json`),
    path.join(guild, 'channels', `${CHANNEL}.json`),
    path.join(guild, 'diary.json'),
    path.join(guild, 'record', '2026-10', '2026-10-30.jsonl'),
    path.join(guild, 'private', MEMBER, 'record', '2026-10', '2026-10-30.jsonl'),
  ] as const;
  writeJson(files[0], PROFILE);
  writeJson(files[1], { details: [], interests: [], episodes: [] });
  writeJson(files[2], {
    id: CHANNEL,
    name: 'γενικά',
    messageCount: 1,
    firstMessageAt: null,
    lastMessageAt: null,
    days: {},
  });
  writeJson(files[3], {
    updatedAt: TWO_WRITERS_NOW - 86_400_000,
    posts: [
      {
        at: TWO_WRITERS_NOW - 86_400_000,
        kind: 'day',
        gist: 'a quiet day',
        picture: null,
        messageIds: ['500000000000000001'],
        search: null,
        itemId: DIARY_POST,
      },
    ],
  });
  writeLines(files[4], [seen(GROUP_LINE, 1, 'Πάμε για μπάνιο αύριο;')]);
  writeLines(files[5], [
    seen(DM_LINE, 1, 'a private plan for the winter', { scope: { channel: '200000000000000099' }, direct: true }),
  ]);
  const handle = openMemoryDb(path.join(data, 'memory.db'));
  try {
    // No writer makes the member's DM place from the member id, so the DM is stored
    // first, as an observed DM leaves it.
    sqlOfHandle(handle)
      .prepare(
        `INSERT INTO places (id, iface, kind, native_id, chat, scope_kind, partner_account, partner_person)
         VALUES (?, 'discord', 'dm', NULL, 'dm', 'dm', ?, ?)`
      )
      .run(`discord:dm:${MEMBER}`, `discord:${MEMBER}`, PERSON);
    // No writer spells the member's person or cuts a native id out of an id, so
    // the member's account with the person memory holds and the root are stored first, as the observation and the
    // interface's hello leave them.
    sqlOfHandle(handle).exec(`
      INSERT OR IGNORE INTO interfaces (id, name, contract) VALUES ('discord', 'discord', 1);
      INSERT OR IGNORE INTO authorities (id, iface, namespace) VALUES ('discord/global', 'discord', 'global');
      INSERT INTO people (id, first_seen_at) VALUES ('${PERSON}', '2026-09-01T00:00:00.000Z');
      INSERT INTO accounts (id, iface, native_id, native_key, authority_id, generation, kind, person_id, link)
        VALUES ('discord:${MEMBER}', 'discord', '${MEMBER}', '${MEMBER}', 'discord/global', 1, 'user', '${PERSON}', 'verified');
      INSERT INTO places (id, iface, kind, native_id, native_key, authority_id, generation, chat, scope_kind)
        VALUES ('discord:guild:${GUILD}', 'discord', 'server', '${GUILD}', 'server:${GUILD}', 'discord/global', 1, NULL, 'group');`);
    assert.equal(seedUnits(handle, data, { now: () => TWO_WRITERS_NOW - 86_400_000 }).errors, 0);
  } finally {
    handle.close();
  }
  for (const file of files) fs.rmSync(file);
  return data;
}

/** The node:sqlite connection of a handle (open.js and service.js are untyped JS; both hand out `{ db }`). */
const twoWritersDbOf = (handle: unknown): TwoWritersDb => (handle as { db: TwoWritersDb }).db;

/** The real service over `data`, on the calling thread, opened; `iface` is the live interface it stamps unit writes with. */
async function openService(data: string, iface: string | null = 'discord') {
  const hot = { config: { memoryDb: { session: { mode: 'off' } } }, prompts: {} };
  const service = createMemoryDb({
    hot,
    dataDir: data,
    log: twoWritersQuiet,
    worker: false,
    now: () => TWO_WRITERS_NOW,
    defer: (fn: () => void) => setImmediate(fn),
    iface: () => iface,
  });
  await service.tick();
  await service.tick();
  assert.ok(service.readHandle(), 'the database is open');
  return service;
}

type Service = Awaited<ReturnType<typeof openService>>;

/** One scene: the seeded data directory, the service over it and the store whose cached files the sync writes. */
async function scene(iface: string | null = 'discord') {
  const data = seededDataDir();
  const service = await openService(data, iface);
  let ids = 0;
  const store = createStore({ dataDir: data, newId: () => `id-${(ids += 1)}`, memoryDb: service });
  const db = () => twoWritersDbOf(service.readHandle());
  const sourceOf = (native: string): string => {
    const row = db().prepare('SELECT id FROM sources WHERE native_id = ? AND retired_at IS NULL').get(native);
    assert.ok(row && typeof row.id === 'string', `the line ${native} is stored`);
    return row.id;
  };
  return { data, service, store, db, sourceOf, done: () => service.close() };
}

/** Every cached file the store holds goes to the database, and the writes have landed. */
async function flush(store: ReturnType<typeof createStore>): Promise<void> {
  store.flush();
  await store.flushSettled({});
}

/** The member's profile as a store that caches nothing yet reads it: the database's view, as the next start sees it. */
function freshProfile(data: string, service: Service, accountId = MEMBER): Profile {
  // store.js is untyped JS; `getUser` returns the user file's value, whose shape is the profile writer's (account-profile.ts).
  const store = createStore({ dataDir: data, memoryDb: service });
  return store.getUser(accountOf(store, accountId)) as Profile;
}

/** The member's profile as the store the persona's turns use holds it, its cache included. */
function liveProfile(store: ReturnType<typeof createStore>, accountId: string): Profile {
  // store.js is untyped JS; `getUser` returns the user file's value, whose shape is the profile writer's (account-profile.ts).
  return store.getUser(accountOf(store, accountId)) as Profile;
}

/** One unit rebuilt from the database alone, by the key its path names. */
function exported(service: Service, rel: string): Profile {
  const out = unitValue((service.readHandle() as { db: unknown }).db, legacyStorageKey(rel));
  assert.ok(out.found, `the unit ${rel} is in the database`);
  // For a users or private unit the value is a profile.
  return out.value as Profile;
}

let runs = 0;

/** One applied run of the persona's memory session in `scope`; `plan` is laid over an empty plan. */
function sessionApply(service: Service, plan: Record<string, Array<Record<string, unknown>>>, scope = GROUP) {
  runs += 1;
  const id = `run-two-writers-${runs}`;
  // memoryWrite is untyped JS; a session write resolves to its counts (session-write.js#applyMemoryWrite).
  return service.memoryWrite({
    kind: 'session',
    mode: 'apply',
    now: TWO_WRITERS_NOW,
    maxDelta: 5,
    run: {
      id,
      sweepId: `sweep-${id}`,
      scopeKey: scope.scope_kind === 'dm' ? `dm:discord:${PERSON}` : 'group:discord',
      scope,
      batchKey: `apply|${id}`,
      startedAt: TWO_WRITERS_AT,
      finishedAt: TWO_WRITERS_AT,
      outcome: 'ok',
      counts: {},
      errors: [],
    },
    plan: { claims: [], episodes: [], affinity: [], descriptions: [], ...plan },
  }) as Promise<Record<string, number>>;
}

const texts = (items: Array<Item> | undefined, key: 'text' | 'topic' | 'what'): Array<unknown> =>
  (items ?? []).map((item) => item[key]);

test("F1: the persona's session's attitude moves end the profile's history after a flush, so the moves can be shown and counted", async () => {
  const env = await scene();
  try {
    assert.ok(env.store.getUser(accountOf(env.store, MEMBER)), 'the profile is cached');
    env.store.touchUser(accountOf(env.store, MEMBER), 'Ada', TWO_WRITERS_NOW);
    const groupLine = env.sourceOf(GROUP_LINE);
    const first = await sessionApply(env.service, {
      affinity: [{ personId: PERSON, delta: 3, reason: 'helped with the boat', sources: [groupLine] }],
    });
    const second = await sessionApply(env.service, {
      affinity: [{ personId: PERSON, delta: -1, reason: 'was curt about the trip', sources: [groupLine] }],
    });
    assert.deepEqual([first.affinity, second.affinity], [1, 1], 'both moves were applied');
    await flush(env.store);

    for (const [name, profile] of [
      ['a fresh store', freshProfile(env.data, env.service)],
      ['the export', exported(env.service, USER_REL)],
    ] as const) {
      const history = profile.affinity?.history ?? [];
      assert.deepEqual(
        history.slice(-2).map((move) => [move.ts, move.reason]),
        [
          [TWO_WRITERS_AT, 'helped with the boat'],
          [TWO_WRITERS_AT, 'was curt about the trip'],
        ],
        `${name}: the history ends with the persona's two moves`
      );
    }
  } finally {
    await env.done();
  }
});

test('F3: a description review is the profile text after a flush, and the review stays the current version', async () => {
  const env = await scene();
  const descriptionId = `desc:${PERSON}:character`;
  const reviewId = `${descriptionId}:review-1`;
  const reviewed = 'Calm, answers slowly, and laughs at her own jokes.';
  try {
    assert.ok(env.store.getUser(accountOf(env.store, MEMBER)), 'the profile is cached');
    await env.service.memoryWrite({
      kind: 'description',
      mode: 'apply',
      row: { id: reviewId, descriptionId, text: reviewed, writtenAt: TWO_WRITERS_AT },
      subject: { kind: 'person', id: PERSON, field: 'character' },
      scope: GROUP,
      expectCurrent: `${descriptionId}:legacy`,
      now: TWO_WRITERS_NOW,
    });
    env.store.touchUser(accountOf(env.store, MEMBER), 'Ada', TWO_WRITERS_NOW);
    await flush(env.store);

    assert.equal(freshProfile(env.data, env.service).character, reviewed, 'a fresh store reads the review');
    assert.equal(exported(env.service, USER_REL).character, reviewed, 'the export reads the review');
    assert.equal(
      env.db().prepare('SELECT current_version FROM descriptions WHERE id = ?').get(descriptionId)?.current_version,
      reviewId,
      'the flush left the review current'
    );
  } finally {
    await env.done();
  }
});

test("F4: a revise and a confirm of the file's claims keep the new text and the new last-seen time after a flush", async () => {
  const env = await scene();
  const revised = 'drinks a freddo café at ten';
  try {
    assert.ok(env.store.getUser(accountOf(env.store, MEMBER)), 'the profile is cached');
    const groupLine = env.sourceOf(GROUP_LINE);
    const counts = await sessionApply(env.service, {
      claims: [
        {
          op: 'revise',
          id: 'det-cafe',
          text: revised,
          how: 'said',
          sources: [groupLine],
          reason: 'she said it herself',
        },
        { op: 'confirm', id: 'det-sea', sources: [groupLine] },
      ],
    });
    assert.deepEqual([counts.revised, counts.confirmed], [1, 1], 'both claim ops were applied');
    env.store.touchUser(accountOf(env.store, MEMBER), 'Ada', TWO_WRITERS_NOW);
    await flush(env.store);

    for (const [name, profile] of [
      ['a fresh store', freshProfile(env.data, env.service)],
      ['the export', exported(env.service, USER_REL)],
    ] as const) {
      const byId = new Map((profile.details ?? []).map((item) => [item.itemId, item]));
      assert.equal(byId.get('det-cafe')?.text, revised, `${name}: the revised text`);
      assert.equal(byId.get('det-sea')?.lastSeen, TWO_WRITERS_AT, `${name}: the confirmed claim was seen now`);
    }
  } finally {
    await env.done();
  }
});

test('F5: claims and an episode the persona’s session added are in the profile of their scope, and a private one only there', async () => {
  const env = await scene();
  const interest = 'θάλασσα το πρωί';
  const episode = 'μιλήσαμε για το λιμάνι';
  const secret = 'plans a winter trip alone';
  try {
    const groupLine = env.sourceOf(GROUP_LINE);
    const dmLine = env.sourceOf(DM_LINE);
    const group = await sessionApply(env.service, {
      claims: [
        {
          op: 'add',
          subjectKind: 'person',
          subjectId: PERSON,
          kind: 'interest',
          text: interest,
          how: 'said',
          sources: [groupLine],
          when: null,
        },
      ],
      episodes: [{ subjectId: PERSON, what: episode, feeling: '', sources: [groupLine] }],
    });
    const dm = await sessionApply(
      env.service,
      {
        claims: [
          {
            op: 'add',
            subjectKind: 'person',
            subjectId: PERSON,
            kind: 'detail',
            text: secret,
            how: 'said',
            sources: [dmLine],
            when: null,
          },
        ],
      },
      DM
    );
    assert.deepEqual([group.added, group.episodes, dm.added], [1, 1, 1], 'every op was applied');
    env.store.touchUser(accountOf(env.store, MEMBER), 'Ada', TWO_WRITERS_NOW);
    await flush(env.store);

    for (const [name, profile] of [
      ['a fresh store', freshProfile(env.data, env.service)],
      ['the export', exported(env.service, USER_REL)],
    ] as const) {
      assert.ok(texts(profile.interests, 'topic').includes(interest), `${name}: the group interest is shown`);
      assert.ok(texts(profile.episodes, 'what').includes(episode), `${name}: the group episode is shown`);
      assert.ok(
        texts(profile.episodes, 'what').includes('told the story of a long swim'),
        `${name}: the file's episode stays`
      );
      assert.ok(
        !texts(profile.details, 'text').includes(secret),
        `${name}: the private claim stays out of the group profile`
      );
    }
    assert.ok(
      texts(exported(env.service, PRIVATE_REL).details, 'text').includes(secret),
      'the private claim is in the private layer'
    );
  } finally {
    await env.done();
  }
});

test('F6: a move for a person spelled in another interface keeps its score and reason through the flush of a changed profile', async () => {
  const env = await scene('nebula');
  const member = '100000000000000077';
  try {
    env.store.touchUser(accountOf(env.store, member), 'Νόρα', TWO_WRITERS_NOW - 3_600_000);
    await flush(env.store);
    // The profile of an account no row held makes the account under its interface, with a meta-person of its own.
    const account = env
      .db()
      .prepare('SELECT iface, person_id FROM accounts WHERE id = ?')
      .get(accountOf(env.store, member));
    assert.equal(account?.iface, 'nebula', 'the profile is stored under its interface');
    const person = String(account?.person_id);
    assert.ok(env.db().prepare('SELECT 1 AS ok FROM people WHERE id = ?').get(person), 'the person is stored');
    env.store.touchUser(accountOf(env.store, member), 'Νόρα', TWO_WRITERS_NOW);
    const counts = await sessionApply(env.service, {
      affinity: [{ personId: person, delta: 3, reason: 'brought pastries', sources: [env.sourceOf(GROUP_LINE)] }],
    });
    assert.equal(counts.affinity, 1, 'the move was applied');
    await flush(env.store);

    const row = env.db().prepare('SELECT affinity, affinity_reason FROM people WHERE id = ?').get(person);
    assert.deepEqual([row?.affinity, row?.affinity_reason], [3, 'brought pastries'], 'the stored person');
    for (const [name, profile] of [
      ['the live store', liveProfile(env.store, member)],
      ['a fresh store', freshProfile(env.data, env.service, member)],
    ] as const)
      assert.deepEqual(
        [profile.affinity?.score, profile.affinity?.reason],
        [3, 'brought pastries'],
        `${name}: the score and the reason`
      );
  } finally {
    await env.done();
  }
});

test("F6: a move keeps its reason through the flush of a changed profile in the store's own spelling", async () => {
  const env = await scene();
  try {
    assert.ok(env.store.getUser(accountOf(env.store, MEMBER)), 'the profile is cached');
    env.store.touchUser(accountOf(env.store, MEMBER), 'Ada', TWO_WRITERS_NOW);
    const counts = await sessionApply(env.service, {
      affinity: [{ personId: PERSON, delta: 2, reason: 'fixed the net with me', sources: [env.sourceOf(GROUP_LINE)] }],
    });
    assert.equal(counts.affinity, 1, 'the move was applied');
    await flush(env.store);

    const row = env.db().prepare('SELECT affinity, affinity_reason FROM people WHERE id = ?').get(PERSON);
    assert.deepEqual([row?.affinity, row?.affinity_reason], [12, 'fixed the net with me'], 'the stored person');
    for (const [name, profile] of [
      ['the live store', liveProfile(env.store, MEMBER)],
      ['a fresh store', freshProfile(env.data, env.service)],
    ] as const)
      assert.deepEqual(
        [profile.affinity?.score, profile.affinity?.reason],
        [12, 'fixed the net with me'],
        `${name}: the score and the reason`
      );
  } finally {
    await env.done();
  }
});

test("the diary's fetched text survives a flush of the diary file", async () => {
  const data = seededDataDir();
  const handle = openMemoryDb(path.join(data, 'memory.db'));
  try {
    applyDiaryUpdate(handle, { id: DIARY_POST, text: 'Σήμερα ήταν ήσυχα στο λιμάνι.', media: [] });
  } finally {
    handle.close();
  }
  const service = await openService(data);
  try {
    const store = createStore({ dataDir: data, memoryDb: service });
    store.appendDiaryPost(
      {
        at: TWO_WRITERS_NOW,
        kind: 'day',
        gist: 'a windy day',
        picture: null,
        messageIds: [],
        search: '',
        itemId: 'd-2',
      },
      { max: 10, now: TWO_WRITERS_NOW }
    );
    await flush(store);
    const db = twoWritersDbOf(service.readHandle());
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM diary WHERE id = 'd-2'").get()?.n, 1, 'the new post is stored');
    assert.equal(
      db.prepare('SELECT text FROM diary WHERE id = ?').get(DIARY_POST)?.text,
      'Σήμερα ήταν ήσυχα στο λιμάνι.'
    );
  } finally {
    await service.close();
  }
});

test("an observation's account kind and place times survive a flush of the member's and the channel's files", async () => {
  const data = seededDataDir();
  const handle = openMemoryDb(path.join(data, 'memory.db'));
  try {
    // observe is untyped JS; it resolves to `{ ok, ... }` or `{ ok: false, code }`.
    const result = observe(
      handle,
      {
        v: 1,
        iface: 'discord',
        authority: 'discord/global',
        native: { kind: 'message', key: '400000000000000033', revision: 1 },
        place: { authority: 'discord/global', key: `channel:${CHANNEL}`, kind: 'channel', chat: 'group' },
        author: { kind: 'account', key: MEMBER, account_kind: 'bot', display: 'Ada' },
        occurredAt: TWO_WRITERS_AT,
        observedAt: TWO_WRITERS_AT,
        text: 'beep',
      },
      { now: () => TWO_WRITERS_NOW, log: twoWritersQuiet }
    ) as { ok?: unknown };
    assert.equal(result.ok, true, 'the observation is stored');
  } finally {
    handle.close();
  }
  const service = await openService(data);
  try {
    const store = createStore({ dataDir: data, memoryDb: service });
    store.touchUser(accountOf(store, MEMBER), 'Ada', TWO_WRITERS_NOW);
    store.touchChannel(placeOfChat(store, { id: CHANNEL }), { name: 'γενικά' }, TWO_WRITERS_NOW, MEMBER);
    await flush(store);
    const db = twoWritersDbOf(service.readHandle());
    assert.equal(db.prepare('SELECT kind FROM accounts WHERE id = ?').get(`discord:${MEMBER}`)?.kind, 'bot');
    const place = db.prepare('SELECT chat, seen_to_at FROM places WHERE id = ?').get(`discord:channel:${CHANNEL}`);
    assert.deepEqual([place?.chat, place?.seen_to_at], ['group', TWO_WRITERS_AT], 'the observed place');
  } finally {
    await service.close();
  }
});

test("a listener hears the moves of the run just applied, never those of a run whose id begins with that run's id", async () => {
  // Bug: the moves of run `r` were read by the prefix `aff:r:` of their ids, which the moves of run `r:2` share.
  const env = await scene();
  try {
    const line = env.sourceOf(GROUP_LINE);
    const apply = (id: string, delta: number, reason: string) =>
      env.service.memoryWrite({
        kind: 'session',
        mode: 'apply',
        now: TWO_WRITERS_NOW,
        maxDelta: 5,
        run: {
          id,
          sweepId: `sweep-${id}`,
          scopeKey: 'group:discord',
          scope: GROUP,
          batchKey: `apply|${id}`,
          startedAt: TWO_WRITERS_AT,
          finishedAt: TWO_WRITERS_AT,
          outcome: 'ok',
          counts: {},
          errors: [],
        },
        plan: {
          claims: [],
          episodes: [],
          affinity: [{ personId: PERSON, delta, reason, sources: [line] }],
          descriptions: [],
        },
      });
    await apply('run-heard:2', 2, 'carried the oars');
    const heard: Array<Record<string, unknown>> = [];
    const stop = env.service.onAffinityMoves((moves) => heard.push(...moves));
    await apply('run-heard', 1, 'shared the catch');
    stop();
    assert.deepEqual(
      heard.map((move) => move.applied),
      [1]
    );
  } finally {
    await env.done();
  }
});

// The memory units on the database: the store's
// units, the intention and task stores, the archive and the versions write the database through its writer, their
// reads never touch the disk, and a unit write that still fails at the shutdown leaves no file. A day of writes on a fixture whose memory files are gone and whose directories are
// read-only leaves no memory file and writes every kind of unit. Synthetic data only (Greek or accented Latin for
// non-ASCII); the ids are made up.

type UnitsService = ReturnType<typeof createMemoryDb>;
// The intentions of these tests carry only the fields the store writes, so each is read as the full shape by a cast.
type Intention = Parameters<ReturnType<typeof createIntentionStore>['add']>[0];
// The stores' profiles are untyped records; the tests read these fields.
type UnitsProfile = { id: string; affinity: { score: number } };
/** The value of a stored unit the test knows is there. */
const valueOf = (db: Db, file: string) =>
  (unitValue(db, legacyStorageKey(file)) as { found: true; value: unknown }).value;
const unitsQuiet = { info() {}, debug() {}, warn() {}, error() {} };
const UNITS_NOW = Date.parse('2026-11-03T12:00:00.000Z');
const DAY_MS = 86_400_000;
const UNITS_DB_FILES = new Set(['memory.db', 'memory.db-wal', 'memory.db-shm', 'memory.db.lock']);

/** The status events and the outbox rows to `persona` of one task (its id given twice). */
const ROWS_OF_TASK = `SELECT (SELECT COUNT(*) FROM board_events WHERE task_id = ? AND type = 'status') AS events,
  (SELECT COUNT(*) FROM board_outbox WHERE task_id = ? AND to_whom = 'persona') AS ends`;

// The status events of the errand tasks titled `title` on the board, in order.
// The board holds errands only and its tasks have no lane, so the title alone picks the errand.
const errandEvents = (db: Db, title: string): Array<unknown> =>
  db
    .prepare(
      `SELECT e.new AS status FROM board_events e JOIN board_tasks t ON t.id = e.task_id
       WHERE t.title = ? AND e.type = 'status' ORDER BY e.seq`
    )
    .all(title)
    .map((row) => row.status);

const unitsTmpRoot = (prefix = 'memdb-w2b-') => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), prefix));
const unitsSettle = async (rounds = 8) => {
  for (let i = 0; i < rounds; i += 1) await new Promise((resolve) => setImmediate(resolve));
};
const counter = (prefix: string) => {
  let n = 0;
  return () => `${prefix}-${(n += 1)}`;
};

function unitsLogs() {
  const out: Array<Record<string, unknown>> = [];
  const add = (level: string) => (message: string, fields?: object) => out.push({ level, message, ...fields });
  return { out, info: add('info'), warn: add('warn'), error: add('error'), debug: add('debug') };
}

/** The config of the modules: the record, the journal and the archive on, the diary channel known. */
const configOf = (memoryDb = {}) => ({
  features: { record: true, journal: true, archive: true },
  memoryDb: { session: { mode: 'off' }, ...memoryDb },
  diary: { placeId: CHANNEL },
});

/**
 * The data directory with the fixture already in its database. `archived`: the fixture's errand is filed on the board
 * too; the unit writer itself skips the errand units.
 */
/**
 * The rows the interface's hello and the observation of the fixture's lines store before any unit names them: the
 * root, its channel and the member's account with the person memory holds for it. A unit write reads a subject's
 * interface and native id from its row only.
 */
function storedSubjects(db: Db): void {
  const root = legacyServerPlaceId('discord', GUILD);
  db.exec(`INSERT OR IGNORE INTO interfaces (id, name, contract) VALUES ('discord', 'discord', 1);
    INSERT OR IGNORE INTO authorities (id, iface, namespace) VALUES ('discord/global', 'discord', 'global');`);
  const place = db.prepare(
    `INSERT INTO places (id, iface, kind, native_id, native_key, authority_id, generation, parent_id, chat, scope_kind)
     VALUES (?, 'discord', ?, ?, ?, 'discord/global', 1, ?, ?, 'group')`
  );
  place.run(root, 'server', GUILD, `server:${GUILD}`, null, null);
  place.run(`discord:channel:${CHANNEL}`, 'channel', CHANNEL, `channel:${CHANNEL}`, root, 'group');
  db.prepare("INSERT INTO people (id, first_seen_at) VALUES (?, '2026-10-01T00:00:00.000Z')").run(
    `person:discord:${MEMBER}`
  );
  db.prepare(
    `INSERT INTO accounts (id, iface, native_id, native_key, authority_id, generation, kind, person_id, link)
     VALUES (?, 'discord', ?, ?, 'discord/global', 1, 'user', ?, 'verified')`
  ).run(`discord:${MEMBER}`, MEMBER, MEMBER, `person:discord:${MEMBER}`);
}

function prepared({ archived = false } = {}) {
  const root = unitsTmpRoot();
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  buildDataDir(data);
  const handle = openMemoryDb(path.join(data, 'memory.db'));
  try {
    storedSubjects(dbOf(handle));
    seedUnits(handle, data, { now: () => UNITS_NOW - DAY_MS });
    if (archived) fileFixtureErrand(dbOf(handle));
  } finally {
    handle.close();
  }
  return { root, data };
}

/** The memory files of a data directory (every file but the database's own and the operational allowlist, fixtures/memory-db/legacy-paths.ts), relative. */
function memoryFiles(data: string, rel = '', out: Array<string> = []): Array<string> {
  for (const entry of fs.readdirSync(path.join(data, rel), { withFileTypes: true })) {
    const child = rel ? `${rel}/${entry.name}` : entry.name;
    if (entry.isDirectory()) memoryFiles(data, child, out);
    else if (!UNITS_DB_FILES.has(child) && !isOperational(child)) out.push(child);
  }
  return out;
}

/** The memory files taken away (so no read can find one) and every directory left read-only (so no write can land). */
function retireFiles(data: string) {
  for (const rel of memoryFiles(data)) fs.rmSync(path.join(data, rel));
  setDirs(data, 0o555);
}

/** Every directory under the guilds folder made read-only (0o555) or writable again (0o755). */
function setDirs(data: string, mode: number) {
  const walk = (dir: string) => {
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
async function modules(
  data: string,
  {
    log = unitsQuiet,
    memoryDb = null,
  }: { log?: typeof unitsQuiet | ReturnType<typeof unitsLogs>; memoryDb?: Partial<UnitsService> | null } = {}
) {
  const hot = { config: configOf() };
  // A test's own `memoryDb` is a fake with the members the stores call, so it stands in for the service by a cast.
  const service =
    (memoryDb as UnitsService | null) ??
    createMemoryDb({
      iface: () => 'discord',
      hot,
      dataDir: data,
      log,
      worker: false,
      now: () => UNITS_NOW,
      defer: (fn) => setImmediate(fn),
    });
  // Root state loads eagerly from the database. Readiness precedes construction of its readers.
  if (!memoryDb) await service.open();
  const archiveStore = createAppendStore({ log: unitsQuiet, now: () => UNITS_NOW });
  const record = createRecord({ dataDir: data, log: unitsQuiet, now: () => UNITS_NOW, memoryDb: service });
  const journal = createJournal({
    dataDir: data,
    now: () => UNITS_NOW,
    uuid: counter('j'),
    log: unitsQuiet,
    memoryDb: service,
  });
  const archive = createArchive({
    appendStore: archiveStore,
    dataDir: data,
    log,
    now: () => UNITS_NOW,
    // @ts-expect-error the archive takes no uuid; the test passes one and the archive ignores it
    uuid: counter('a'),
    memoryDb: service,
  });
  const store = createStore({
    dataDir: data,
    newId: counter('id'),
    archive,
    archiveOn: () => true,
    memoryDb: service,
  });
  const lazy: { intentions?: ReturnType<typeof createIntentionStore>; tasks?: ReturnType<typeof createErrandStore> } =
    {};
  const intentions = () =>
    (lazy.intentions ??= createIntentionStore({
      // @ts-expect-error the store takes no dataDir; the test passes one and the store ignores it
      dataDir: data,
      placeId: GUILD,
      now: () => UNITS_NOW,
      log,
      memoryDb: service,
    }));
  const tasks = () =>
    (lazy.tasks ??= createErrandStore({
      // @ts-expect-error the store takes no dataDir; the test passes one and the store ignores it
      dataDir: data,
      placeId: GUILD,
      now: () => UNITS_NOW,
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
 * The scripted day: counters, a decay tick, lore, a channel touch, an intention added
 * and updated, a task added and finished.
 */
async function day(m: Awaited<ReturnType<typeof modules>>) {
  const at = (minutes: number) => UNITS_NOW - 3_600_000 + minutes * 60_000;
  const message = (id: string, minutes: number) => ({
    id,
    authorId: MEMBER,
    authorName: 'Ada',
    ts: at(minutes),
    placeId: CHANNEL,
    channelName: 'γενικά',
    channelCategory: null,
    channelTopic: null,
    self: false,
    bot: false,
    content: 'Καλημέρα, café?',
    mentionedAccountIds: [],
  });
  for (const [id, minutes] of [
    ['600000000000000001', 0],
    ['600000000000000002', 1],
  ] as Array<[string, number]>)
    touchMemory(m.store, GUILD, message(id, minutes), {});
  m.store.decayAffinities(UNITS_NOW + 3 * DAY_MS, { decayPerDay: 0.04, decayPower: 1 });
  m.store.setLore(
    placeOfRoot(m.store, GUILD),
    [{ title: 'Η πλατεία', keys: ['πλατεία'], text: 'The square by the sea.' }],
    {
      source: 'owner',
      by: 'owner',
      now: UNITS_NOW,
    }
  );
  m.store.touchChannel(placeOfChat(m.store, { id: CHANNEL }), { name: 'γενικά', topic: 'café' }, at(6), MEMBER, {});
  const intentions = m.intentions();
  const added = intentions.add({
    id: 'i2',
    purpose: 'ask about the café',
    status: 'pending',
    createdAt: UNITS_NOW,
    updatedAt: UNITS_NOW,
    expiresAt: UNITS_NOW + DAY_MS,
    dueAt: null,
    provenance: { kind: 'self', turnId: 't-2', placeId: CHANNEL, scope: 'group' },
    history: [],
  } as unknown as Intention);
  if (!added.ok) throw new Error(`intention add: ${added.code}`);
  const moved = intentions.update('i2', (record) => ({
    ok: true,
    intention: { ...record, purpose: 'ask about the café terrace', updatedAt: UNITS_NOW + 1 },
    changed: true,
  }));
  if (!moved.ok) throw new Error(`intention update: ${moved.code}`);
  const tasks = m.tasks();
  const task = tasks.add({
    agent: 'scout',
    goal: 'find the café hours',
    requester: { accountId: MEMBER, kind: 'member' },
    origin: { placeId: CHANNEL, messageId: '600000000000000001' },
    scope: 'group',
  });
  if (!task.ok) throw new Error(`task add: ${task.code}`);
  tasks.start(task.errand.id);
  tasks.finish(task.errand.id, {
    status: 'done',
    result: { text: 'nine to five', sources: [], files: [] },
    usage: { input: 1, output: 1, usd: 0, steps: 1, seconds: 1 },
  });
  await m.store.flushSettled({});
  await m.intentions().flush();
  await m.tasks().flush();
  await unitsSettle();
}

test('a day of writes with the memory files gone writes every kind of unit to the database and no memory file', async () => {
  const db = prepared();
  retireFiles(db.data);
  const dbLog = unitsLogs();
  const dm = await modules(db.data, { log: dbLog });
  try {
    await dm.service.tick();
    assert.equal(dm.service.status().open, true);
    await day(dm);
    // The projection and the stems, by the writers' own job.
    for (let i = 0; i < 10; i += 1) {
      await dm.service.tick();
      await unitsSettle();
    }
    await dm.close();

    setDirs(db.data, 0o755);
    assert.deepEqual(memoryFiles(db.data), []);
    const failures = dbLog.out.filter(
      (entry) =>
        (entry.level === 'warn' || entry.level === 'error') &&
        /failed|refused|pending|lost/.test(entry.message as string)
    );
    assert.deepEqual(failures, []);

    const right = openMemoryDb(path.join(db.data, 'memory.db'), { readOnly: true });
    try {
      const count = (sql: string, ...params: Array<unknown>) =>
        dbOf(right)
          .prepare(sql)
          .get(...params)!.n as number;
      // The day's errand is a board task with its three moves, and the `work` archive
      // takes no write (it asserted the errands.jsonl lines in `work_events` before).
      assert.deepEqual(errandEvents(dbOf(right), 'find the café hours'), ['approved', 'in_progress', 'done']);
      assert.equal(count('SELECT COUNT(*) AS n FROM work') + count('SELECT COUNT(*) AS n FROM work_events'), 0);
      // The persona's intentions are rows of their own (src/memory/db/intentions-write.ts): the day's intention is in the list.
      assert.equal(
        count("SELECT COUNT(*) AS n FROM intentions WHERE archived = 0 AND id LIKE '%i2%' AND retired_at IS NULL"),
        1
      );
      assert.ok(
        JSON.stringify(valueOf(dbOf(right), `guilds/${GUILD}/lore.json`)).includes('The square by the sea.'),
        'the lore'
      );
      // The day writes no lesson, since the store's writer of lessons left with `/memory lessons add`.
    } finally {
      right.close();
    }
  } finally {
    setDirs(db.data, 0o755);
    fs.rmSync(db.root, { recursive: true, force: true });
  }
});

// Errands on the board: the fixture's errand reaches the store from its board task.
test('reads: the store, the intentions and the tasks load the database values with the memory files gone', async () => {
  const db = prepared({ archived: true });
  retireFiles(db.data);
  const dm = await modules(db.data);
  try {
    await dm.service.tick();
    assert.equal((dm.store.getUser(accountOf(dm.store, MEMBER)) as UnitsProfile | null)?.id, MEMBER);
    assert.ok(dm.store.getPlace(placeOfRoot(dm.store, GUILD)), 'the guild');
    assert.equal(dm.store.getChannel(placeOfChat(dm.store, { id: CHANNEL }))?.id, CHANNEL);
    assert.ok(dm.store.getLore(placeOfRoot(dm.store, GUILD)).length > 0, 'the lore');
    assert.deepEqual(unitSubjects(dm.service.readHandle()?.db, 'private'), [`discord:${MEMBER}`]);
    assert.equal(
      dm.store.getUser(accountOf(dm.store, '100000000000000077')),
      null,
      'a member the database does not hold is absent'
    );
    assert.ok(Array.isArray(dm.intentions().list()));
    assert.deepEqual(
      dm
        .tasks()
        .recent()
        .map((task: { id: string }) => task.id),
      ['t1']
    );
    assert.ok(!dm.store.validate().includes(`guilds/${GUILD}/voice.json`), 'a memory unit is never checked as a file');
    // A closed database is an error to the reader, never a file read.
    // Eager root-state construction refuses the same closed database before any reader is returned.
    await assert.rejects(
      () => modules(db.data, { memoryDb: { readHandle: () => null, database: () => null } }),
      (error: NodeJS.ErrnoException) => error.code === 'DB_CLOSED'
    );
  } finally {
    await dm.close();
    setDirs(db.data, 0o755);
    fs.rmSync(db.root, { recursive: true, force: true });
  }
});

test('a unit write that still fails at the shutdown is logged lost and leaves no file in the data directory', async () => {
  const { root, data } = prepared();
  retireFiles(data);
  const log = unitsLogs();
  const hot = { config: configOf() };
  const service = createMemoryDb({
    iface: () => 'discord',
    hot,
    dataDir: data,
    log,
    worker: false,
    now: () => UNITS_NOW,
    defer: (fn) => setImmediate(fn),
  });
  try {
    fs.chmodSync(data, 0o755);
    await service.tick();
    // The writer refuses every unit write of this process (a database that cannot take them).
    const down = {
      ...service,
      writeUnit: async (update: { op: string }) => {
        if (update.op === 'value' || update.op === 'lines')
          throw Object.assign(new Error('down'), { code: 'SQLITE_FULL' });
        return writeUnitUpdate(service, update);
      },
      // The task store has its own write kind (src/memory/db/errand-write.ts), refused the same way.
      writeErrand: () => Promise.reject(Object.assign(new Error('down'), { code: 'SQLITE_FULL' })),
      // A lorebook and the persona's diary have their own write kinds (src/memory/db/place-lore.ts,
      // diary-entries.ts), refused the same way.
      writePlaceLore: () => Promise.reject(Object.assign(new Error('down'), { code: 'SQLITE_FULL' })),
      writeDiary: () => Promise.reject(Object.assign(new Error('down'), { code: 'SQLITE_FULL' })),
    };
    const m = await modules(data, { log, memoryDb: down });
    m.store.setLore(placeOfRoot(m.store, GUILD), [{ title: 'Η αποβάθρα', keys: ['αποβάθρα'], text: 'The old pier.' }], {
      source: 'owner',
      by: 'owner',
      now: UNITS_NOW,
    });
    m.store.appendDiaryPost(
      // @ts-expect-error a post without a picture is null, the shape the diary writes before one is drawn
      { at: UNITS_NOW, kind: 'day', gist: 'une journée de pluie', picture: null, messageIds: [], search: null },
      { max: 150, now: UNITS_NOW }
    );
    const task = m.tasks().add({
      agent: 'scout',
      goal: 'the pier',
      requester: { accountId: MEMBER, kind: 'member' },
      origin: { placeId: CHANNEL, messageId: null },
      scope: 'group',
    });
    assert.equal(task.ok, true);
    const settled = await m.store.flushSettled({ final: true });
    assert.equal(settled.waiting, 2, 'the lore and the diary');
    assert.deepEqual(await m.tasks().flush({ final: true }), { waiting: 1 });
    await m.close();
    await service.close();
    // Bug: the shutdown writes the persona's memory to a folder beside the database that no open reads.
    assert.equal(fs.existsSync(path.join(data, 'memory-pending')), false);
    assert.deepEqual(memoryFiles(data), [], 'still no memory file');
    // The store logs through the engine's own logger, so only the task store's line reaches this one.
    const lost = log.out.filter((entry) => entry.level === 'error' && entry.message === 'memory db: units lost');
    assert.deepEqual(
      lost.map((entry) => [entry.reader, entry.units]),
      [['tasks', 1]]
    );
  } finally {
    setDirs(data, 0o755);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

// A file an older release left in `memory-pending/` is not replayed: its write is older than the rows written since.
test('an open applies nothing from a file in memory-pending/ and leaves the file as it was', async () => {
  const { root, data } = prepared();
  const log = unitsLogs();
  const hot = { config: configOf() };
  const pendingDir = path.join(data, 'memory-pending');
  const loreKey: UnitKey = { kind: 'lore', subject: { type: 'place', id: legacyServerPlaceId('discord', GUILD) } };
  const name = `${createHash('sha1').update(keyText(loreKey)).digest('hex')}.json`;
  const kept = JSON.stringify({
    key: loreKey,
    op: 'value',
    value: [{ title: 'Η αποβάθρα', keys: ['αποβάθρα'], text: 'The old pier.' }],
    at: '2026-11-03T12:00:00.000Z',
  });
  fs.mkdirSync(pendingDir);
  fs.writeFileSync(path.join(pendingDir, name), kept);
  const service = createMemoryDb({
    iface: () => 'discord',
    hot,
    dataDir: data,
    log,
    worker: false,
    now: () => UNITS_NOW,
    defer: (fn) => setImmediate(fn),
  });
  try {
    await service.tick();
    assert.equal(service.status().open, true);
    // Bug: a write of an older release replayed over what the persona learned since.
    assert.equal(
      JSON.stringify(valueOf(dbOf(service.readHandle()!), `guilds/${GUILD}/lore.json`)).includes('The old pier.'),
      false
    );
    assert.deepEqual(fs.readdirSync(pendingDir), [name]);
    assert.equal(fs.readFileSync(path.join(pendingDir, name), 'utf8'), kept);
    assert.equal(fs.existsSync(path.join(data, 'memory-pending-quarantine')), false);
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
    iface: () => 'discord',
    hot,
    dataDir: data,
    log: unitsQuiet,
    worker: false,
    now: () => UNITS_NOW,
    defer: (fn) => setImmediate(fn),
  });
  try {
    fs.chmodSync(data, 0o755);
    await service.tick();
    // The writer commits every unit write, then the first `lost` answers of the kind asked for are lost (a dead worker).
    let lost = 0;
    let lostOp: ((update: { op: string }) => boolean) | null = null;
    const flaky = {
      ...service,
      writeUnit: async (update: { op: string }) => {
        const done = await writeUnitUpdate(service, update);
        if (lost > 0 && (lostOp === null || lostOp(update))) {
          lost -= 1;
          throw Object.assign(new Error('the answer was lost'), { code: 'WORKER_EXIT' });
        }
        return done;
      },
      // The task store goes through its own write kind (src/memory/db/errand-write.ts), lost the same way.
      writeErrand: async (update: Parameters<typeof service.writeErrand>[0]) => {
        const done = await service.writeErrand(update);
        if (lost > 0 && (lostOp === null || lostOp({ op: 'errand' }))) {
          lost -= 1;
          throw Object.assign(new Error('the answer was lost'), { code: 'WORKER_EXIT' });
        }
        return done;
      },
      // The persona's intentions go through their own write kind (src/memory/db/intentions-write.ts), lost the same way.
      writeIntentions: async (update: Parameters<typeof service.writeIntentions>[0]) => {
        const done = await service.writeIntentions(update);
        if (lost > 0 && (lostOp === null || lostOp(update))) {
          lost -= 1;
          throw Object.assign(new Error('the answer was lost'), { code: 'WORKER_EXIT' });
        }
        return done;
      },
    };
    const m = await modules(data, { memoryDb: flaky });
    const db = () => dbOf(service.readHandle()!);
    // The transitions are the task's status events and its end the outbox row to
    // `persona`, written by the write kind `errand`.
    const rows = (id: unknown) => db().prepare(ROWS_OF_TASK).get(String(id), String(id));
    const transitions = (id: unknown) => rows(id)?.events;
    const ends = (id: unknown) => rows(id)?.ends;
    const run = async (lose: number) => {
      lost = lose;
      lostOp = (update: { op: string }) => update.op === 'errand';
      const tasks = m.tasks();
      const added = tasks.add({
        agent: 'scout',
        goal: 'the pier',
        requester: { accountId: MEMBER, kind: 'member' },
        origin: { placeId: CHANNEL, messageId: null },
        scope: 'group',
      });
      await unitsSettle();
      tasks.start(added.errand!.id);
      await unitsSettle();
      tasks.finish(added.errand!.id, {
        status: 'done',
        result: { text: 'found', sources: [], files: [] },
        usage: { input: 0, output: 0, usd: 0, steps: 1, seconds: 1 },
      });
      // Retried until nothing waits (each retry sends the same lines again).
      for (let round = 0; round < 6 && (await tasks.flush()).waiting > 0; round += 1) await unitsSettle();
      return added.errand!.id;
    };
    const control = await run(0);
    const faulted = await run(3);
    assert.equal(lost, 0, 'every lost answer was hit');
    assert.equal(transitions(control), 3, 'added, started, done');
    assert.equal(transitions(faulted), 3, 'the retried transitions are not written twice');
    assert.equal(ends(control), 1);
    assert.equal(ends(faulted), 1, 'the retried end is not announced twice');
    assert.equal(m.tasks().get(faulted)!.state, 'done');
    // The same check for an intention: its value and its archive line retried after a lost answer stay one row each.
    lost = 2;
    lostOp = null;
    const intentions = m.intentions();
    const record = {
      id: 'intent-retry',
      purpose: 'ask about the pier',
      status: 'pending',
      createdAt: UNITS_NOW,
      updatedAt: UNITS_NOW,
      expiresAt: UNITS_NOW + DAY_MS,
      dueAt: null,
      provenance: { kind: 'self', turnId: 't-1', placeId: null, scope: 'group' },
      history: [],
    };
    assert.equal(intentions.add(record as unknown as Intention).ok, true);
    await unitsSettle();
    for (let round = 0; round < 6 && (await intentions.flush()).waiting > 0; round += 1) await unitsSettle();
    assert.equal(lost, 0);
    assert.equal(
      db().prepare("SELECT COUNT(*) AS n FROM intentions WHERE id = 'intent-retry' AND retired_at IS NULL").get()!.n,
      1
    );
    assert.equal(intentions.list().filter((entry: { id: string }) => entry.id === 'intent-retry').length, 1);
    await m.close();
  } finally {
    await service.close();
    setDirs(data, 0o755);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test("the persona's session's attitude move reaches the store's cached profile: a later flush never writes the older score over it", async () => {
  const { root, data } = prepared();
  retireFiles(data);
  const hot = { config: configOf() };
  const service = createMemoryDb({
    iface: () => 'discord',
    hot,
    dataDir: data,
    log: unitsQuiet,
    worker: false,
    now: () => UNITS_NOW,
    defer: (fn) => setImmediate(fn),
  });
  try {
    fs.chmodSync(data, 0o755);
    await service.tick();
    await service.tick();
    const m = await modules(data, { memoryDb: service });
    const db = () => dbOf(service.readHandle()!);
    const person = `person:discord:${MEMBER}`;
    const stored = () => db().prepare('SELECT affinity FROM people WHERE id = ?').get(person)!.affinity;
    const source = db()
      .prepare("SELECT id FROM sources WHERE kind = 'seen' AND retired_at IS NULL ORDER BY rowid LIMIT 1")
      .get()!.id;
    let runs = 0;
    const move = (delta: number) => {
      runs += 1;
      const id = `run-move-${runs}`;
      return service.memoryWrite({
        kind: 'session',
        mode: 'apply',
        now: UNITS_NOW,
        run: {
          id,
          sweepId: `sweep-${id}`,
          scopeKey: 'group:discord',
          scope: { scope_kind: 'group', scope_iface: 'discord', scope_dm: null },
          batchKey: `apply|${id}`,
          startedAt: new Date(UNITS_NOW).toISOString(),
          finishedAt: new Date(UNITS_NOW).toISOString(),
          outcome: 'ok',
          counts: {},
          errors: [],
        },
        plan: {
          claims: [],
          episodes: [],
          affinity: [{ personId: person, delta, reason: 'una charla amable', sources: [source] }],
          descriptions: [],
        },
      });
    };
    // A clean cached profile: the store reads the moved score.
    const start = (m.store.getUser(accountOf(m.store, MEMBER)) as UnitsProfile).affinity.score;
    await move(2);
    assert.equal(stored(), Math.round((start + 2) * 100) / 100);
    assert.equal(
      (m.store.getUser(accountOf(m.store, MEMBER)) as UnitsProfile).affinity.score,
      stored(),
      'the cached profile took the move'
    );
    // A profile changed in the cache at the same time (a decay tick stamps it): both count after the flush.
    const decayed = m.store.decayAffinities(UNITS_NOW, { decayPerDay: 0.5, decayPower: 1 });
    assert.ok(decayed.profiles > 0);
    const cached = (m.store.getUser(accountOf(m.store, MEMBER)) as UnitsProfile).affinity;
    await move(3);
    m.store.flush();
    await m.store.flushSettled({});
    const expected = Math.round(Math.max(-100, Math.min(100, cached.score + 3)) * 100) / 100;
    assert.equal(stored(), expected, 'the move survives the flush of the decayed profile');
    assert.equal((m.store.getUser(accountOf(m.store, MEMBER)) as UnitsProfile).affinity.score, expected);
    assert.equal(
      db()
        .prepare("SELECT COUNT(*) AS n FROM affinity_events WHERE person_id = ? AND reason = 'una charla amable'")
        .get(person)!.n,
      2
    );
    await m.close();
  } finally {
    await service.close();
    setDirs(data, 0o755);
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('root state and participation, GIF and media caches persist through the writer without legacy JSON', async () => {
  const fixture = prepared();
  const files = ['state.json', ...['participation', 'gifs', 'media'].map((name) => `guilds/${GUILD}/${name}.json`)].map(
    (file) => path.join(fixture.data, file)
  );
  for (const file of files) fs.rmSync(file, { force: true });
  let run = await modules(fixture.data);
  try {
    await run.service.tick();
    const storeState = run.store.state;
    storeState.data.paused = true;
    const runState = run.store.state;
    runState.markDirty();
    run.store.setParticipation(
      placeOfRoot(run.store, GUILD),
      {
        nextId: 10,
        episodes: [
          {
            itemId: 'pt-roundtrip',
            id: 'p-roundtrip',
            placeId: CHANNEL,
            startAt: UNITS_NOW,
            lastAt: UNITS_NOW,
            lastOwnAt: UNITS_NOW,
            continues: null,
            messages: [{ id: 'native-roundtrip', ts: UNITS_NOW, self: true, text: 'café' }],
          },
        ],
      },
      { now: UNITS_NOW }
    );
    run.store.putMediaEntry(placeOfRoot(run.store, GUILD), 'photo', { text: 'a café terrace', ts: UNITS_NOW });
    assert.equal(
      run.store.recordGifs(placeOfRoot(run.store, GUILD), [
        {
          id: 'native-gif',
          placeId: CHANNEL,
          ts: UNITS_NOW,
          self: false,
          bot: false,
          links: [{ id: 'gif-key', kind: 'gif', site: 'Tenor', url: 'https://tenor.com/view/cat-dance-123' }],
          attachments: [],
        },
      ]),
      1
    );
    const participation = run.store.getParticipation(placeOfRoot(run.store, GUILD));
    const gifs = structuredClone(run.store.getGifs());
    await run.store.flushSettled({ final: true });
    assert.deepEqual(
      files.filter((file) => fs.existsSync(file)),
      []
    );
    const state2 = run.store.state;
    state2.data.paused = false;
    run.store.reloadState();
    const state3 = run.store.state;
    assert.equal(state3.data.paused, true);
    state3.data.afterReload = 'persisted after reload';
    const state4 = run.store.state;
    state4.markDirty();
    await run.store.flushSettled({ final: true });
    await run.close();
    run = await modules(fixture.data);
    await run.service.tick();
    const state5 = run.store.state;
    assert.equal(state5.data.paused, true);
    assert.equal(state5.data.afterReload, 'persisted after reload');
    assert.deepEqual(run.store.getParticipation(placeOfRoot(run.store, GUILD)), participation);
    assert.deepEqual(run.store.getGifs(), gifs);
    assert.deepEqual(run.store.mediaEntry(placeOfRoot(run.store, GUILD), 'photo'), {
      text: 'a café terrace',
      ts: UNITS_NOW,
    });
    assert.deepEqual(
      files.filter((file) => fs.existsSync(file)),
      []
    );
  } finally {
    await run.close();
    fs.rmSync(fixture.root, { recursive: true, force: true });
  }
});

// The memory database's writer thread (src/memory/db/writer-worker.ts through src/memory/db/service.ts): its writes
// equal the in-thread ones, the main thread reads through its own read-only connection, a crashed worker is restarted
// at the next tick, and shutdown waits for a write under way (bounded) before it terminates the worker. Synthetic data
// only.

const memoryDbWorkerTmpRoot = () => fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-worker-'));
const WORKER_REAL_WORKER = pathToFileURL(path.resolve('src/memory/db/writer-worker.ts')).href;

function memoryDbWorkerLogs() {
  const out: Array<Record<string, unknown>> = [];
  const add = (level: string) => (message: string, fields?: object) => out.push({ level, message, ...fields });
  return { out, info: add('info'), warn: add('warn'), error: add('error'), debug: add('debug') };
}

/**
 * A data directory and a service. `fake` names a behaviour for a stand-in worker that wraps the real one: it reads
 * `<root>/mode` at each write message (`crash-once`, `slow`, `hang`) before the real handlers see the message.
 */
function memoryDbWorkerSetup({
  memoryDb = {},
  fake = false,
  ...rest
}: { memoryDb?: Record<string, unknown>; fake?: boolean; options?: Record<string, unknown> } = {}) {
  const root = memoryDbWorkerTmpRoot();
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
await import(${JSON.stringify(WORKER_REAL_WORKER)});
`
    );
  }
  const hot = { config: { memoryDb: { session: { mode: 'off' }, ...memoryDb } } };
  const log = memoryDbWorkerLogs();
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

/** A profile unit of a new member. */
const profile = (id: string, name: string) => ({
  op: 'value',
  file: `guilds/${GUILD}/users/${id}.json`,
  value: { id, names: [name] },
});
const profileRows = (db: Db, id: string) =>
  db.prepare('SELECT COUNT(*) AS n FROM accounts WHERE native_id = ?').get(id)!.n;
const wait = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

test('the worker holds the writer lock; the main thread reads through its own read-only connection', async () => {
  const env = memoryDbWorkerSetup();
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
    await writeUnitUpdate(env.service, profile('100000000000000077', 'Zed'));
    assert.equal(profileRows(dbOf(env.service.readHandle()!), '100000000000000077'), 1);
    await env.service.close();
    assert.equal(fs.existsSync(`${env.dbFile()}.lock`), false);
  } finally {
    await env.done();
  }
});

test('a crashed worker is logged with a code, its write fails, and the next tick starts a new one that takes the lock over', async () => {
  const env = memoryDbWorkerSetup({ fake: true });
  try {
    await env.service.tick();
    env.mode('crash-once');
    await assert.rejects(
      () => writeUnitUpdate(env.service, profile('100000000000000078', 'Yan')),
      (error: NodeJS.ErrnoException) => error.code === 'WORKER_EXIT'
    );
    const logOut = env.log.out;
    const exited = logOut.find((e) => e.message === 'memory db: worker exited');
    assert.deepEqual([exited?.code, exited?.exit], ['WORKER_EXIT', 3]);
    // The lock the dead worker held is still there, with this process's pid; the new worker takes it over.
    env.advance(1000);
    await env.service.tick();
    assert.equal(logOut.filter((e) => e.message === 'memory db: opened').length, 2, 'a second worker was opened');
    await writeUnitUpdate(env.service, profile('100000000000000078', 'Yan'));
    assert.equal(profileRows(dbOf(env.service.readHandle()!), '100000000000000078'), 1, 'and its write ran');
  } finally {
    await env.done();
  }
});

test('shutdown waits for a write under way, then closes the database and frees the lock', async () => {
  const env = memoryDbWorkerSetup({ fake: true, memoryDb: { closeTimeoutMs: 5000 } });
  try {
    await env.service.tick();
    env.mode('slow');
    const write = writeUnitUpdate(env.service, profile('100000000000000079', 'Wim'));
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
  const env = memoryDbWorkerSetup({ fake: true, memoryDb: { closeTimeoutMs: 300 } });
  try {
    await env.service.tick();
    env.mode('hang');
    const write = writeUnitUpdate(env.service, profile('100000000000000080', 'Uma')).catch((error) => error);
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

// The consumers of memory reach the one retrieval service in production code, not only through the seams
// tests/src/memory/retrieval-input.test.ts exercises: a session's request, an attention's input, an
// errand and a diary post. Each test goes through the module the consumer calls. Fake model, real
// temporary databases, synthetic content.

const BOUNDS = { seeds: 3, hops: 2, nodes: 10, edges: 30, assertions: 6, evidence: 9, tokens: 900, deadlineMs: 700 };

test('the memory service reads a consumer input under the settings of this moment, and null while they are absent', async () => {
  // Bug: the service caches a budget, or a config with no retrieval settings turns into a thrown turn.
  const memory = openTestMemorySync({ dataDir: path.join(tempDir('nep-service-'), 'data') });
  const service = wrongly<{
    issueContext(spec: object): Context;
    retrievalBoundsFor(purpose: string): { hops: number } | null;
    retrieve(ctx: Context, input: RetrievalInput): Promise<MemoryPage | null>;
  }>(memory.memoryDb);
  const ctx = service.issueContext({ kind: 'internal' });
  const input: RetrievalInput = { purpose: 'task', goal: 'nothing stored', refs: [] };
  assert.equal(service.retrievalBoundsFor('task'), null);
  assert.equal(await service.retrieve(ctx, input), null);
  wrongly<{ config: unknown }>(memory.hot).config = { memoryDb: { retrieval: { ...BOUNDS, hops: 1 } } };
  assert.equal(service.retrievalBoundsFor('task')?.hops, 1);
  assert.deepEqual((await service.retrieve(ctx, input))?.assertions, []);
});

// The owner's merge of one person into another (`kind: 'person-merge'` through the one writer, `/memory users merge` from
// the owner's line): everything stored about the person who goes moves to the person who stays, and nothing moves out of the
// chat it was said in. One `people_merges` row records it, and running it again changes nothing. Real
// temporary databases over the synthetic opaque world.

const PERSON_MERGE_NOW = Date.parse('2026-11-05T12:00:00Z');
const PERSON_MERGE_AT = '2026-11-01T00:00:00.000Z';
const CAROL = 'person:c4r01-synthetic';
const CAROL_PLACE = 'place:dm-c31';

/** The opaque world, with Boris's line and vector in his DM, a group fact about him, and Carol's DM that mentions him. */
function seedWorld(db: Db): void {
  seedOpaqueWorld(db);
  addClaim(db, 'claim:b21-public', BORIS, 'aud:group:discord');
  addEpisode(db, 'episode:b21', BORIS, BORIS_PLACE);
  addAccount(db, { id: 'account:c31', iface: 'telegram', authority: 'telegram/global', native: 'n3', person: CAROL });
  addDmPlace(db, {
    id: CAROL_PLACE,
    iface: 'telegram',
    authority: 'telegram/global',
    account: 'account:c31',
    person: CAROL,
  });
  addClaim(db, 'claim:about-boris-in-carols-dm', BORIS, `aud:dm:${CAROL_PLACE}`);
  db.prepare("UPDATE claims SET from_person = ? WHERE id = 'claim:about-anna-in-his-dm'").run(BORIS);
  db.prepare(
    `INSERT INTO sources (id, kind, iface, place_id, author_account, author_kind, occurred_at, recorded_at, text,
       audience_id, scope_kind, scope_iface, scope_dm)
     VALUES ('source:b21', 'seen', 'telegram', ?, ?, 'account', ?, ?, 'a synthetic line', ?, 'dm', 'telegram', ?)`
  ).run(BORIS_PLACE, BORIS_ACCOUNT, PERSON_MERGE_AT, PERSON_MERGE_AT, `aud:dm:${BORIS_PLACE}`, BORIS);
  db.prepare(
    `INSERT INTO vectors (source_rowid, item_id, chunk_key, model, dims, context, occurred_at, scope_kind, scope_iface,
       scope_dm, audience_id)
     VALUES ((SELECT rowid FROM sources WHERE id = 'source:b21'), 'source:b21', 'chunk:b21', 'test/embedder', 4, '{}', ?,
       'dm', 'telegram', ?, ?)`
  ).run(PERSON_MERGE_AT, BORIS, `aud:dm:${BORIS_PLACE}`);
  db.prepare('UPDATE people SET affinity = 40 WHERE id = ?').run(ANNA);
  db.prepare('UPDATE people SET affinity = 5 WHERE id = ?').run(BORIS);
  for (const person of [ANNA, BORIS])
    db.prepare(
      `INSERT INTO relationship_daily (person_id, day, audience_id, addressed_by_them, addressed_by_her, meaningful)
       VALUES (?, '2026-11-01', 'aud:group:discord', 2, 1, 0)`
    ).run(person);
}

type Merged = { ok: true; id: string; survivor: string; moved: Record<string, number> };

test('the memory service merges through its one writer', async () => {
  // Bug: the command reaches a method the service never wired, so the owner's merge fails on a running core.
  const dataDir = tempDataDir('nep-merge-service-');
  const writer = openMemoryDb(join(dataDir, 'memory.db'));
  seedWorld(dbOf(writer));
  writer.close();
  const memory = await openTestMemory({ dataDir });
  try {
    const db = memory.memoryDb.readHandle()?.db as Db;
    const answer = (await memory.memoryDb.personMerge({
      from: BORIS,
      into: ANNA,
      by: 'owner',
      now: PERSON_MERGE_NOW,
    })) as Merged;
    assert.equal(answer.survivor, ANNA);
    assert.equal(
      db.prepare('SELECT into_person FROM people_merges WHERE from_person = ?').get(BORIS)?.into_person,
      ANNA
    );
  } finally {
    await memory.close();
  }
});
