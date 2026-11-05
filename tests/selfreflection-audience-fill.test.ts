// The owner's fill of the audience on old diary entries (`/memory selfreflection audience fill [--dry-run]`, writer kind
// `selfreflection-audience-fill`): an entry written before the persona could choose an audience carries none, and by the
// owner's word of 2026-11-05 it gets the explicit unrestricted one. An entry with a chosen audience, a retired entry, a
// private entry and one whose metadata cannot be read stay as they are, a run counts what it wrote, a second run writes
// nothing, and `--dry-run` counts without writing. Real temporary databases built by the public migration path,
// synthetic entries only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { parseRequest } from '../bin/neptunia-request.ts';
import { createConsole } from '../src/interface/commands/console.ts';
import type { ConsoleDeps } from '../src/interface/commands/console.ts';
import { commandLineWords, parseCommandLine } from '../src/interface/commands/table.ts';
import { audienceRefusal } from '../src/memory/db/selfreflection-audience.ts';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { applyMemoryWrite } from '../src/memory/db/session-write.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db, MemoryHandle, Row } from '../src/memory/db/types.ts';
import { databaseDigest } from './fixtures/memory-db/browser-world.ts';
import { openTestMemory, tempDataDir } from './fixtures/memory-db/service.ts';
import { tempDir } from './fixtures/tmp.ts';

const NOW = Date.parse('2026-11-05T12:00:00Z');
const UNRESTRICTED = { kind: 'unrestricted' };
const CHOSEN = { kind: 'interface', iface: 'discord' };
const UNTOUCHED = ['e:chosen', 'e:retired', 'e:private', 'e:unreadable'];

type Filled = { ok: true; written: number; dryRun: boolean };

/**
 * Seven synthetic entries: three group entries with no audience (one with other metadata, one with a saved boundary),
 * one with a chosen interface audience, one retired, one private, one whose metadata cannot be read.
 */
function seedEntries(db: Db): void {
  const put = db.prepare(
    `INSERT INTO selfreflection (id, at_ms, kind, text, status, scope_kind, scope_iface, extra, retired_at)
     VALUES (?, ?, 'entry', 'a synthetic evening', 'done', ?, 'discord', ?, ?)`
  );
  put.run('e:plain', 1, 'group', null, null);
  put.run('e:other-keys', 2, 'group', JSON.stringify({ mood: 'calm' }), null);
  put.run('e:boundary', 3, 'group', JSON.stringify({ publicationBoundary: { allow: ['discord'] } }), null);
  put.run('e:chosen', 4, 'group', JSON.stringify({ publicationAudience: CHOSEN }), null);
  put.run('e:retired', 5, 'group', null, '2026-10-01T00:00:00.000Z');
  put.run('e:private', 6, 'dm', null, null);
  put.run('e:unreadable', 7, 'group', '{not json', null);
}

function withEntries(body: (handle: MemoryHandle, db: Db) => void): void {
  const handle = openMemoryDb(join(tempDir('nep-audience-fill-'), 'memory.db'));
  try {
    seedEntries(dbOf(handle));
    body(handle, dbOf(handle));
  } finally {
    handle.close();
  }
}

const fill = (handle: MemoryHandle, update: Row = {}): Filled =>
  applyMemoryWrite(handle, { kind: 'selfreflection-audience-fill', by: 'owner', now: NOW, ...update }) as Filled;

const rowOf = (db: Db, id: string): Row | undefined => db.prepare('SELECT * FROM selfreflection WHERE id = ?').get(id);

/** The metadata of one entry as stored: parsed JSON, the raw text when it is not JSON, or null. */
function extraOf(db: Db, id: string): unknown {
  const raw = rowOf(db, id)?.extra;
  if (typeof raw !== 'string') return raw ?? null;
  try {
    return JSON.parse(raw);
  } catch {
    return raw;
  }
}

test('a fill gives every group entry without an audience the explicit unrestricted one, and reports the count', () => {
  // Bug: the 78 entries written before the persona chose audiences keep none, so a reader cannot tell "unrestricted"
  // from "nobody decided", and the count of what was written is unknown.
  withEntries((handle, db) => {
    const answer = fill(handle);
    assert.equal(answer.written, 3);
    assert.equal(answer.dryRun, false);
    for (const id of ['e:plain', 'e:other-keys', 'e:boundary'])
      assert.deepEqual((extraOf(db, id) as Row).publicationAudience, UNRESTRICTED, id);
  });
});

test('a fill keeps the other metadata and the saved boundary of an entry it writes', () => {
  // Bug: the fill replaces the whole `extra`, dropping a publication boundary and widening what the entry may reach.
  withEntries((handle, db) => {
    fill(handle);
    assert.equal((extraOf(db, 'e:other-keys') as Row).mood, 'calm');
    assert.deepEqual((extraOf(db, 'e:boundary') as Row).publicationBoundary, { allow: ['discord'] });
  });
});

test('a fill leaves a chosen audience, a retired entry, a private entry and unreadable metadata as they were', () => {
  // Bug: the fill overwrites her choice with unrestricted, widens a private or unreadable entry, or revives a retired one.
  withEntries((handle, db) => {
    const before = UNTOUCHED.map((id) => rowOf(db, id));
    fill(handle);
    assert.deepEqual(
      UNTOUCHED.map((id) => rowOf(db, id)),
      before
    );
  });
});

test('an entry the fill wrote reaches a place of its interface, and a private entry still reaches none', () => {
  // Bug: the unrestricted audience is read as permission, so an entry outside the group scope reaches every mirror.
  withEntries((handle, db) => {
    db.prepare(
      "INSERT INTO places (id, iface, kind, scope_kind) VALUES ('discord:channel:c1', 'discord', 'channel', 'group')"
    ).run();
    fill(handle);
    assert.equal(audienceRefusal(db, rowOf(db, 'e:plain'), 'discord:channel:c1'), null);
    assert.equal(audienceRefusal(db, rowOf(db, 'e:private'), 'discord:channel:c1'), 'audience-excluded');
  });
});

test('a second fill writes nothing', () => {
  // Bug: every run rewrites the entries and reports the same count, so the owner cannot tell that the work is done.
  withEntries((handle, db) => {
    fill(handle);
    const afterFirst = databaseDigest(db);
    assert.equal(fill(handle).written, 0);
    assert.deepEqual(databaseDigest(db), afterFirst);
  });
});

test('a dry run counts the entries it would write and changes nothing', () => {
  // Bug: the dry run writes, or counts a different set than the real run.
  withEntries((handle, db) => {
    const before = databaseDigest(db);
    const dry = fill(handle, { dryRun: true });
    assert.deepEqual([dry.written, dry.dryRun], [3, true]);
    assert.deepEqual(databaseDigest(db), before);
    assert.equal(fill(handle).written, dry.written);
  });
});

test('a fill by anyone but the owner is refused and writes nothing', () => {
  // Bug: her memory session fills the audience, so a lapse in the session decides what every mirror may show.
  withEntries((handle, db) => {
    const before = databaseDigest(db);
    assert.throws(() => fill(handle, { by: 'her' }), { code: 'OWNER_ONLY' });
    assert.throws(() => fill(handle, { by: 'her', dryRun: true }), { code: 'OWNER_ONLY' });
    assert.deepEqual(databaseDigest(db), before);
  });
});

test('a fill over a database with no entries writes nothing', () => {
  const handle = openMemoryDb(join(tempDir('nep-audience-fill-empty-'), 'memory.db'));
  try {
    assert.deepEqual(fill(handle), { ok: true, written: 0, dryRun: false });
  } finally {
    handle.close();
  }
});

test('the memory service fills through its one writer', async () => {
  // Bug: the command reaches a method the service never wired, so the owner's fill fails on a running core.
  const dataDir = tempDataDir('nep-audience-fill-service-');
  const writer = openMemoryDb(join(dataDir, 'memory.db'));
  seedEntries(dbOf(writer));
  writer.close();
  const memory = await openTestMemory({ dataDir });
  try {
    const db = memory.memoryDb.readHandle()?.db as Db;
    const answer = (await memory.memoryDb.selfreflectionAudienceFill({ by: 'owner', now: NOW })) as Filled;
    assert.equal(answer.written, 3);
    assert.deepEqual((extraOf(db, 'e:plain') as Row).publicationAudience, UNRESTRICTED);
  } finally {
    await memory.close();
  }
});

// ---------- the owner's command ----------

test('/memory selfreflection audience fill parses the same from the chat and from argv', () => {
  const line = '/memory selfreflection audience fill --dry-run';
  const fromChat = parseCommandLine(line);
  assert.ok(fromChat.ok, fromChat.ok ? '' : fromChat.reason);
  assert.equal(fromChat.name, 'memory.selfreflection.audience.fill');
  assert.deepEqual(parseRequest(commandLineWords(line)).parsed, fromChat);
});

/** The owner's console over an empty read-only file, with a writer that records what it is asked. */
function consoleRig(): {
  say(line: string): Promise<{ status: string; code?: string; text: string }>;
  writes: Array<Row>;
} {
  const dir = tempDir('nep-audience-fill-console-');
  mkdirSync(join(dir, 'config'), { recursive: true });
  const file = join(dir, 'memory.db');
  openMemoryDb(file).close();
  const reader = openMemoryDb(file, { readOnly: true });
  const writes: Array<Row> = [];
  const deps: ConsoleDeps = {
    runOp: () => Promise.resolve({ status: 'failed', code: 'NOT_A_FILL', summary: '', data: null }),
    ownerReads: { lessons: () => '', aliases: () => '' },
    places: () => [],
    selfId: () => null,
    hot: {
      config: {
        memoryDb: {
          file: 'memory.db',
          inspection: { pageRows: 50, snapshotIdleSeconds: 60, snapshotMaxSeconds: 300, maxSnapshots: 8 },
        },
      },
    },
    privateDir: dir,
    dataDir: dir,
    memoryDb: {
      database: () => dbOf(reader),
      selfreflectionAudienceFill: (update: Row) => {
        writes.push(update);
        return Promise.resolve({ ok: true, written: 3, dryRun: update.dryRun === true });
      },
    },
    usage: null,
    metrics: { samples: () => [] },
    conversationLines: () => [],
    now: () => NOW,
  };
  const desk = createConsole(deps);
  return {
    writes,
    say: async (line) => {
      const parsed = parseCommandLine(line);
      assert.ok(parsed.ok, parsed.ok ? '' : `${line}: ${parsed.reason}`);
      return desk.run(parsed.name, parsed.args, { id: 'owner' });
    },
  };
}

test('/memory selfreflection audience fill goes through the one writer as the owner and answers the count', async () => {
  // Bug: the console writes over its own connection, a second writer on her memory, or records the fill as nobody's.
  const rig = consoleRig();
  const answer = await rig.say('/memory selfreflection audience fill');
  assert.equal(answer.status, 'ok', answer.text);
  assert.equal((JSON.parse(answer.text) as Row).written, 3);
  assert.deepEqual(
    rig.writes.map(({ by, dryRun }) => ({ by, dryRun: dryRun === true })),
    [{ by: 'owner', dryRun: false }]
  );
});

test('/memory selfreflection audience fill --dry-run asks the writer for a dry run', async () => {
  // Bug: the flag is parsed and dropped, so the owner's rehearsal writes the audience.
  const rig = consoleRig();
  const answer = await rig.say('/memory selfreflection audience fill --dry-run');
  assert.equal(answer.status, 'ok', answer.text);
  assert.deepEqual(
    rig.writes.map(({ by, dryRun }) => ({ by, dryRun })),
    [{ by: 'owner', dryRun: true }]
  );
});
