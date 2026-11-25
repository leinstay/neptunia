// The notes of a place under the meta-person: a lesson's teacher is the teacher's meta-person, never an id spelled from
// the interface and the native id, and the notes come back from their rows exactly. Synthetic ids and text only.
import { test, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { personOfAccount } from '../../../../src/memory/db/meta-person.ts';
import { observe, OBSERVATION_VERSION } from '../../../../src/memory/db/observe.ts';
import { openMemoryDb } from '../../../../src/memory/db/open.ts';
import { applyMemoryWrite } from '../../../../src/memory/db/session-write.ts';
import { placeCollection } from '../../../../src/memory/db/unit-keys.ts';
import { unitValue } from '../../../../src/memory/db/readers/common.ts';
import { dbOf } from '../../../../src/memory/db/types.ts';
import type { Db, MemoryHandle, Row } from '../../../../src/memory/db/types.ts';
import { openTestMemory, tempDataDir } from '../../../fixtures/memory-db/service.ts';
import { writeUnitUpdate } from '../../../fixtures/memory-db/unit-writes.ts';
import { createAppendStore } from '../../../../src/memory/append-store.ts';
import { createArchive } from '../../../../src/memory/archive.ts';
import { internalContext, scopeWhere } from '../../../../src/memory/db/scope.ts';
import { createMemoryDb } from '../../../../src/memory/db/service.ts';
import type { MemoryDbService } from '../../../../src/memory/db/service.ts';
import { createJournal } from '../../../../src/memory/journal.ts';
import { createRecord } from '../../../../src/memory/record.ts';
import { createStore } from '../../../../src/memory/store.ts';
import { createVectors } from '../../../../src/memory/vectors.ts';
import '../../../../src/tools/operations/index.ts';
import { wrongly } from '../../../fixtures/loose-types.ts';
import { addAccount, addDmPlace, addGroupPlace } from '../../../fixtures/memory-db/opaque-people.ts';
import { tempDir } from '../../../fixtures/tmp.ts';
import { generated, plain } from '../../../fixtures/memory-db/roundtrip.ts';
import {
  DM as NOTES_DM,
  NOW as NOTES_NOW,
  ROOT,
  copyOf,
  notes,
  seededPlaces,
  writeDirect,
} from '../../../fixtures/memory-db/place-writes.ts';

const AT = '2026-11-08T10:00:00.000Z';
const NOW = Date.parse('2026-11-08T12:00:00.000Z');
const quiet = { info() {}, debug() {}, warn() {}, error() {} };
const OPTS = { now: () => NOW, log: quiet };
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

/** A place's notes written through their write kind (place-notes.ts): the teacher its lesson names and the notes read back. */
function writtenNotes(handle: MemoryHandle, notes: Row): { teacher: unknown; back: unknown } {
  const placeId = 'discord:channel:c1';
  applyMemoryWrite(handle, { kind: 'place-notes', placeId, value: notes, iface: 'discord', now: Date.parse(AT) });
  const db = dbOf(handle);
  const teacher = db.prepare("SELECT from_person FROM claims WHERE kind = 'lesson'").get()?.from_person;
  const read = unitValue(db, placeCollection('place', placeId));
  return { teacher, back: read.found ? read.value : null };
}

function withDb(body: (db: Db, handle: MemoryHandle) => void): void {
  const handle = openMemoryDb(':memory:');
  try {
    body(dbOf(handle), handle);
  } finally {
    handle.close();
  }
}

test("a lesson's teacher is the teacher's meta-person and the place's notes come back exactly", () => {
  // Bug: the teacher of a lesson is spelled `person:discord:<native>` from the mention.
  withDb((db, handle) => {
    seeDm(handle, 'discord', '700');
    const notes: Row = { learned: [{ id: 'l1', text: 'synthetic lesson', from: '<@700>', weight: 1 }] };
    const { teacher, back } = writtenNotes(handle, notes);
    assert.equal(teacher, personOf(db, 'discord:700'));
    assert.deepEqual(back, notes);
  });
});

test('a mention of an account no row holds stores no spelled person and comes back exactly', () => {
  // Bug: the teacher of a lesson is spelled `person:discord:<native>` when no stored account holds the mention.
  withDb((_db, handle) => {
    const notes: Row = { learned: [{ id: 'l2', text: 'synthetic lesson', from: '<@999>', weight: 1 }] };
    const { teacher, back } = writtenNotes(handle, notes);
    assert.equal(teacher, null);
    assert.deepEqual(back, notes);
  });
});

// The claims of the persona about themselves in the notes of a place. A self fact takes the scope of the notes it
// stands in: the groups on a server or channel and the partner's DM on a DM. Synthetic data on a real temporary database.

const GROUP = 'discord:channel:room';
const DM = 'discord:dm:owner';
const FACT_WORDS = 'likes-rain-synthetic';

const observed = (key: string, kind: 'dm' | 'channel', native: string) => ({
  v: OBSERVATION_VERSION,
  iface: 'discord',
  authority: 'discord/global',
  native: { kind: 'message', key: native, revision: 1 },
  place: {
    authority: 'discord/global',
    key,
    kind,
    chat: kind === 'dm' ? 'dm' : 'group',
    // The audit counts an unnamed room, so the room carries its title as a live one does.
    ...(kind === 'dm' ? {} : { title: 'αίθουσα' }),
  },
  author: { kind: 'account', key: 'owner' },
  occurredAt: '2026-11-03T09:00:00.000Z',
  observedAt: '2026-11-03T09:00:01.000Z',
  text: 'a synthetic opening line',
  mentions: [],
  direct: kind === 'dm',
  relations: [],
});

/** A stopped core's database whose #room and whose DM each hold one self fact, written by the place's own writer. */
async function withSelfFacts(): Promise<string> {
  const env = await openTestMemory();
  await env.memoryDb.observe(observed('channel:room', 'channel', 'room-first'), null);
  await env.memoryDb.observe(observed('dm:owner', 'dm', 'dm-first'), null);
  for (const place of [GROUP, DM])
    await writeUnitUpdate(env.memoryDb, {
      op: 'value',
      key: placeCollection('place', place),
      value: { self: [`${FACT_WORDS} ${place}`] },
    });
  const file = path.join(env.dataDir, 'memory.db');
  await env.close();
  // The audit counts an unnamed interface; the name arrives with the interface's hello, absent here.
  const db = new DatabaseSync(file);
  db.exec("UPDATE interfaces SET name = 'Discord' WHERE id = 'discord'");
  db.close();
  return file;
}

type SelfRow = { place: string; scope_kind: string; audience_id: string };

/** The live self facts, each with the place whose notes hold it. */
function selfRows(file: string): Array<SelfRow> {
  const db = new DatabaseSync(file, { readOnly: true });
  try {
    return db
      .prepare(
        `SELECT c.holder_id AS place, c.scope_kind, c.audience_id FROM claims c
         WHERE c.kind = 'self_fact' AND c.writer = 'place' AND c.retired_at IS NULL ORDER BY place`
      )
      .all()
      .map((row) => ({ ...row }) as SelfRow);
  } finally {
    db.close();
  }
}

// ---------- the writer ----------

// Bug: a new self fact is written under aud:none, a row the audit finds.
test('a self fact in the notes of a channel is written for the groups', async () => {
  const rows = selfRows(await withSelfFacts());
  const row = rows.find((one) => one.place === GROUP);
  assert.equal(row?.scope_kind, 'group');
  assert.equal(row?.audience_id, 'aud:group:discord');
});

// Bug: what the persona noted about themselves in a private chat can be shown in any channel.
test('a self fact in the notes of a DM stays in that DM', async () => {
  const rows = selfRows(await withSelfFacts());
  const row = rows.find((one) => one.place === DM);
  assert.equal(row?.scope_kind, 'dm');
  assert.equal(row?.audience_id, `aud:dm:${DM}`);
});

// What a direct message leaves in the journal, the record, the archive and the meaning index reaches its partner alone. A
// journal line of a DM names only its chat (`scope: { channel }`) and carries no private mark, so every reader
// that branched on the mark falls through to the channel rule or to none. Each test seeds one synthetic secret word through
// the writer a turn uses, over the real service and database, then reads as another reader: a group turn, another
// partner's private turn, the persona's own wake. Where the answer could be empty for want of a row, an internal context
// checks first that the row exists, so an empty answer means refused and never means unwritten. The last group asserts
// the converse: the partner's own private turn still reads their own lines.
describe('DM lines out of reach', () => {
  const quiet = { info() {}, debug() {}, warn() {}, error() {} };
  const NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
  const SECRET = 'xylophonewhisper';
  const LIKE = `%${SECRET}%`;

  // A first-generation DM on the home authority: the place and the person are spelled from the native id.
  const PARTNER = 'n1';
  const PARTNER_ACCOUNT = 'discord:n1';
  const PARTNER_PERSON = 'person:discord:n1';
  const DM = 'discord:dm:n1';
  // Another partner on the same interface.
  const OTHER = 'n2';
  const OTHER_PERSON = 'person:discord:n2';
  const OTHER_DM = 'discord:dm:n2';
  const GROUP = 'discord:channel:room-1';
  const SERVER = 'discord:server:g1';
  // A partner with the same native id under another authority of the interface: the place's id spells nothing.
  const STRANGER_ACCOUNT = 'account:other-authority';
  const STRANGER_PERSON = 'person:elsewhere';
  const STRANGER_DM = 'place:dm-other-authority';

  /** Lets the journal's unawaited writes reach the writer, which runs on this thread here. */
  const settled = () => new Promise((resolve) => setImmediate(resolve));

  const opened: Array<MemoryDbService> = [];
  after(async () => {
    for (const service of opened) await service.close();
  });

  function seedWorld(db: Db): void {
    addAccount(db, {
      id: PARTNER_ACCOUNT,
      iface: 'discord',
      authority: 'discord/global',
      native: PARTNER,
      person: PARTNER_PERSON,
    });
    addAccount(db, {
      id: 'discord:n2',
      iface: 'discord',
      authority: 'discord/global',
      native: OTHER,
      person: OTHER_PERSON,
    });
    addAccount(db, {
      id: STRANGER_ACCOUNT,
      iface: 'discord',
      authority: 'discord/other',
      native: PARTNER,
      person: STRANGER_PERSON,
    });
    addDmPlace(db, {
      id: DM,
      iface: 'discord',
      authority: 'discord/global',
      account: PARTNER_ACCOUNT,
      person: PARTNER_PERSON,
    });
    addDmPlace(db, {
      id: OTHER_DM,
      iface: 'discord',
      authority: 'discord/global',
      account: 'discord:n2',
      person: OTHER_PERSON,
    });
    addDmPlace(db, {
      id: STRANGER_DM,
      iface: 'discord',
      authority: 'discord/other',
      account: STRANGER_ACCOUNT,
      person: STRANGER_PERSON,
    });
    addGroupPlace(db, GROUP, 'discord', 'discord/global');
    db.prepare(
      `INSERT INTO places (id, iface, kind, native_id, native_key, authority_id, generation, chat, scope_kind)
     VALUES (?, 'discord', 'server', 'g1', 'server:g1', 'discord/global', 1, 'group', 'group')`
    ).run(SERVER);
  }

  function world() {
    const dataDir = tempDir('nep-dm-privacy-');
    const seed = openMemoryDb(path.join(dataDir, 'memory.db'));
    seedWorld(dbOf(seed));
    seed.close();
    const hot = { config: { memoryDb: { session: { mode: 'off' } }, context: { memory: { openPrivate: false } } } };
    const memoryDb = createMemoryDb({
      hot,
      dataDir,
      log: quiet,
      worker: false,
      iface: () => 'discord',
    });
    memoryDb.tick();
    opened.push(memoryDb);
    const read = (): Db => dbOf(wrongly<Parameters<typeof dbOf>[0]>(memoryDb.readHandle()));
    const journal = createJournal({ dataDir, memoryDb, now: () => NOW, log: quiet });
    const record = createRecord({ dataDir, memoryDb, now: () => NOW, log: quiet });
    const appendStore = createAppendStore({ fsyncMs: 0, log: quiet });
    const archive = createArchive({ appendStore, dataDir, memoryDb, now: () => NOW, log: quiet });
    const vectors = createVectors({ dataDir, memoryDb, now: () => NOW, log: quiet });
    const store = createStore({ dataDir, archive, memoryDb });
    const contexts = {
      group: memoryDb.issueContext({ kind: 'group', iface: 'discord', destination: GROUP }),
      other: memoryDb.issueContext({ kind: 'dm', iface: 'discord', person: OTHER_PERSON, place: OTHER_DM }),
      partner: memoryDb.issueContext({ kind: 'dm', iface: 'discord', person: PARTNER_PERSON, place: DM }),
      stranger: memoryDb.issueContext({ kind: 'dm', iface: 'discord', person: STRANGER_PERSON, place: STRANGER_DM }),
    };
    return { dataDir, hot, memoryDb, read, journal, record, archive, vectors, store, contexts };
  }

  /** The rows of `table` holding the secret that the context may read, by the rule every scoped read uses. */
  function secretRows(db: Db, table: string, ctx: unknown): Array<Record<string, unknown>> {
    const scope = scopeWhere(ctx, 's');
    const columns = db
      .prepare(`SELECT name FROM pragma_table_info('${table}')`)
      .all()
      .map((row) => String(row.name))
      .filter((name) => ['text', 'think', 'extra', 'reason', 'what'].includes(name));
    const holds = columns.map((name) => `s.${name} LIKE ?`).join(' OR ');
    return db
      .prepare(`SELECT s.* FROM ${table} s WHERE (${holds}) AND ${scope.sql}`)
      .all(...columns.map(() => LIKE), ...scope.params);
  }

  test("a lesson taught in a DM is out of a group's reach", async () => {
    // Bug: the place mapper writes every lesson and in-joke `group`, whichever place holds them.
    const w = world();
    // The engine has no writer of lessons: the DM place's notes holding one are written into the database.
    const at = new Date(NOW).toISOString();
    await writeUnitUpdate(w.memoryDb, {
      op: 'value',
      key: placeCollection('place', DM),
      value: {
        patterns: 'short replies',
        learned: [{ id: 1, text: `the ${SECRET} lesson`, weight: 1, firstSeen: at, lastSeen: at }],
        learnedNextId: 2,
      },
    });
    await settled();
    assert.notEqual(secretRows(w.read(), 'claims', internalContext()).length, 0);
    assert.deepEqual(secretRows(w.read(), 'claims', w.contexts.group), []);
  });
});

// The write kind `place-notes` (src/memory/db/place-notes.ts): the notes of a place written as their rows directly
// instead of through the place mapper of a unit write. The first test writes the same notes through the unit write and
// through the write kind, over copies of one seeded database, and compares every table column by column, the owner
// columns of the unit way taken from version step 48. Then the code, the store over a reopen, the rows of a root and a
// direct chat, and the generated notes.

test('the server row stays live and the root keeps its prose fields after its notes are written twice', () => {
  // Bug: the second write of a server's notes retired the server row the first write adopted.
  const handle = copyOf(seededPlaces());
  try {
    writeDirect(handle, { kind: 'place', placeId: ROOT, value: notes() });
    writeDirect(handle, { kind: 'place', placeId: ROOT, value: notes({ injokes: ['the lamp incident'] }) });
    const db = dbOf(handle);
    assert.equal(db.prepare('SELECT retired_at FROM places WHERE id = ?').get(ROOT)?.retired_at, null);
    assert.deepEqual(
      db
        .prepare(
          'SELECT field, scope_kind FROM descriptions WHERE subject_id = ? AND retired_at IS NULL ORDER BY rowid'
        )
        .all(ROOT)
        .map((row) => [row.field, row.scope_kind]),
      [
        ['purpose', 'group'],
        ['patterns', 'group'],
        ['starters', 'group'],
      ]
    );
  } finally {
    handle.close();
  }
});

test('a direct chat keeps its prose fields and its self facts scoped to that chat', () => {
  // Bug: a direct chat's notes were kept where the groups read them.
  const handle = copyOf(seededPlaces());
  try {
    writeDirect(handle, {
      kind: 'place',
      placeId: NOTES_DM,
      value: { purpose: 'Ιδιωτική.', self: ['reads at night'] },
    });
    const db = dbOf(handle);
    const scopes = [
      ...db.prepare('SELECT scope_kind, scope_dm FROM descriptions WHERE subject_id = ?').all(NOTES_DM),
      ...db.prepare("SELECT scope_kind, scope_dm FROM claims WHERE kind = 'self_fact'").all(),
    ].map((row) => [row.scope_kind, row.scope_dm]);
    assert.deepEqual(scopes, [
      ['dm', 'person:partner'],
      ['dm', 'person:partner'],
    ]);
  } finally {
    handle.close();
  }
});

test('the store reads back a place notes after the database is closed and opened again', async () => {
  const dataDir = tempDataDir('nep-place-notes-reopen-');
  const first = await openTestMemory({ dataDir, now: () => NOTES_NOW, iface: () => 'discord' });
  let written: unknown;
  try {
    const store = createStore({ dataDir, memoryDb: first.memoryDb });
    store.setEmojiBackfill('discord:guild:300000000000000005', {
      at: '2026-10-01T00:00:00.000Z',
      channels: 2,
      messages: 9,
    });
    store.flush();
    await store.flushSettled({});
    written = store.getPlace('discord:guild:300000000000000005');
  } finally {
    await first.close();
  }
  const second = await openTestMemory({ dataDir, now: () => NOTES_NOW, iface: () => 'discord' });
  try {
    const store = createStore({ dataDir, memoryDb: second.memoryDb });
    const read = store.getPlace('discord:guild:300000000000000005') as { emojiBackfill?: unknown };
    assert.deepEqual(read.emojiBackfill, { at: '2026-10-01T00:00:00.000Z', channels: 2, messages: 9 });
    assert.deepEqual(read, written);
  } finally {
    await second.close();
  }
});

test('the generated notes with every key path of the live place files come back as they were written', () => {
  for (const [index, given] of generated('guild').entries()) {
    const handle = copyOf(seededPlaces());
    try {
      const value = plain(given) as Row;
      writeDirect(handle, { kind: 'place', placeId: ROOT, value });
      const read = unitValue(dbOf(handle), placeCollection('place', ROOT));
      assert.ok(read.found, `generated place ${index}`);
      assert.deepEqual(read.value, value, `generated place ${index}`);
    } finally {
      handle.close();
    }
  }
});
