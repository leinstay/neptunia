// Tests for src/memory/db/record-lines.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ChannelType } from 'discord.js';
import { toEvent } from '../../../fixtures/sdk-shaped.ts';
import { lineOf as normalizedOf } from '../../../../src/behavior/line-of.ts';
import { validateEvent } from '../../../../src/protocol/index.ts';
import { observationOf } from '../../../../src/memory/db/observe-event.ts';
import { checkEnvelope, observe } from '../../../../src/memory/db/observe.ts';
import { openMemoryDb } from '../../../../src/memory/db/open.ts';
import { seedUnits } from '../../../fixtures/memory-db/seed.ts';
import { slimMessage, toRecordLine } from '../../../../src/memory/index.ts';
import {
  CHANNEL,
  GUILD,
  MEMBER,
  buildDataDir,
  guildDir,
  writeJson,
  writeLines,
} from '../../../fixtures/memory-db/datadir.ts';
import type { Untyped } from '../../../../src/tools/types.ts';
import { wrongly, sqlOf } from '../../../fixtures/loose-types.ts';
import type { UntypedDb } from '../../../fixtures/loose-types.ts';
import {
  createRecord,
  toRecordLine as linesToRecordLine,
  toRecordLine as firstToRecordLine,
  toRecordLine as singleToRecordLine,
} from '../../../../src/memory/record.ts';
import { recordLines } from '../../../../src/memory/db/record-lines.ts';
import { applyMemoryWrite } from '../../../../src/memory/db/session-write.ts';
import { placeOrPersona } from '../../../../src/memory/db/unit-keys.ts';
import { dbOf } from '../../../../src/memory/db/types.ts';
import type { Db, Row } from '../../../../src/memory/db/types.ts';
import { addAccount, addChannelPlace } from '../../../fixtures/memory-db/opaque-people.ts';
import { openTestMemory, tempDataDir } from '../../../fixtures/memory-db/service.ts';
import { topPlaceSpelled } from '../../../../src/memory/db/ids.ts';

// Stage 8a (spec 2026-10-24-memory-schema-v7): the Discord interface on the observation path. A discord.js-shaped
// message goes through the adapter (toEvent), the core's mapping (observe-event.js#observationOf) and the envelope
// check, and is written by observe.js; on a database the record's unit writes made from the same lines, observe finds
// the rows they wrote and mints none, and in the live order (observe first, the record later) the record's writes take
// over the rows observe wrote. Synthetic text only (Greek or accented Latin for non-ASCII); the ids are made up.

const quiet = { info() {}, debug() {}, warn() {}, error() {} };
const NOW = Date.parse('2026-10-24T12:00:00.000Z');
const T0 = Date.parse('2026-10-24T09:00:00.000Z');
const SELF = '100000000000000009';
const MEMBER2 = '100000000000000002';
const BOT = '100000000000000008';
const DM_CHANNEL = '200000000000000099';
const opts = { now: () => NOW, log: quiet };
const count = (db: UntypedDb, sql: string, ...params: Array<unknown>) => db.prepare(sql).get(...params).n;

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

const dmChannel = () => channelOf({ id: DM_CHANNEL, name: wrongly(null), type: ChannelType.DM, recipientId: MEMBER });

/** The lines of the fixture day, as the gateway delivers them, with what the record writes for each. */
function day() {
  const first = message({ id: '400000000000000101', content: 'Καλημέρα σε όλους', at: T0 });
  const reply = message({
    id: '400000000000000102',
    author: MEMBER2,
    content: 'γεια @Ada',
    at: T0 + 30_000,
    replyTo: first.id,
    mentions: [MEMBER],
  });
  const edited = message({ id: first.id, content: 'Καλημέρα σε όλους!', at: T0, editedAt: T0 + 60_000 });
  const personaLine = message({
    id: '400000000000000103',
    author: SELF,
    content: 'καλημέρα κι από μένα',
    at: T0 + 90_000,
  });
  const dmLine = message({
    id: '400000000000000104',
    channel: dmChannel(),
    guild: false,
    content: 'ένα μυστικό',
    at: T0 + 120_000,
  });
  const dmPersonaLine = message({
    id: '400000000000000105',
    channel: dmChannel(),
    author: SELF,
    guild: false,
    content: 'το κρατάω',
    at: T0 + 150_000,
  });
  const events = [
    { event: eventOf(first), direct: false },
    { event: eventOf(reply), direct: false },
    { event: eventOf(edited, { edit: true, previous: first, now: () => T0 + 61_000 }), direct: false },
    { event: eventOf(personaLine), direct: false },
    { event: eventOf(dmLine), direct: true },
    { event: eventOf(dmPersonaLine), direct: false },
  ];
  const stamp = (line: Record<string, Untyped>) => ({ ...line, placeId: GUILD });
  const seen = (
    event: Untyped,
    {
      direct = false,
      revision = 1,
      replyToAuthorId = null,
    }: { direct?: boolean; revision?: number; replyToAuthorId?: Untyped } = {}
  ) =>
    stamp(
      toRecordLine(
        { ...slimMessage(normalizedOf(event), direct), ...(replyToAuthorId ? { replyToAuthorId } : {}) },
        { revision, now: () => event.at + 1000 }
      )
    );
  const said = (event: Record<string, Untyped>) =>
    stamp(
      toRecordLine(
        {
          id: event.message.id,
          placeId: event.chat.id,
          content: event.message.content,
          ts: event.message.at,
          replyToId: null,
          mentionedAccountIds: [],
        },
        { kind: 'said', now: () => event.message.at + 500, turnId: 'turn-8a' }
      )
    );
  const record = [
    seen(events[0].event),
    seen(events[1].event, { replyToAuthorId: MEMBER }),
    seen(events[2].event, { revision: 2 }),
    said(events[3].event),
  ];
  const privateRecord = [seen(events[4].event, { direct: true }), said(events[5].event)];
  return { events, record, privateRecord };
}

/** A data directory (the shared fixture, a second member) and its database with its units written. */
function imported({ withRecord }: Record<string, Untyped>) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'memdb-8a-'));
  const data = path.join(root, 'data');
  fs.mkdirSync(data);
  buildDataDir(data);
  writeJson(path.join(guildDir(data), 'users', `${MEMBER2}.json`), { id: MEMBER2, names: ['Zoé'] });
  const fixture = day();
  const writeRecord = () => {
    writeLines(path.join(guildDir(data), 'record', '2026-10', '2026-10-24.jsonl'), fixture.record);
    writeLines(
      path.join(guildDir(data), 'private', MEMBER, 'record', '2026-10', '2026-10-24.jsonl'),
      fixture.privateRecord
    );
  };
  if (withRecord) writeRecord();
  const file = path.join(root, 'memory.db');
  const handle = openMemoryDb(file);
  assert.equal(seedUnits(handle, data, wrongly({ log: quiet, now: () => NOW })).errors, 0);
  return {
    root,
    data,
    file,
    handle,
    fixture,
    writeRecord,
    done: () => {
      try {
        handle.close();
      } catch {
        /* closed */
      }
      fs.rmSync(root, { recursive: true, force: true });
    },
  };
}

const observeAll = (handle: ReturnType<typeof openMemoryDb>, events: Array<Record<string, Untyped>>) =>
  events.map(({ event, direct }) => {
    const envelope = observationOf(event, { selfId: SELF, direct });
    assert.equal(checkEnvelope(envelope), null);
    const done = observe(handle, envelope, opts);
    assert.equal(done.ok, true, JSON.stringify(done));
    return done;
  });

// ---------- the envelope round trip ----------

// ---------- the same rows as the record's ----------

test("the live order: observe first, the record later; the record's writes take the observed rows over and nothing is doubled", () => {
  const env = imported({ withRecord: false });
  try {
    const db = sqlOf(env.handle);
    const done = observeAll(env.handle, env.fixture.events);
    assert.ok(done.every((one) => one.replayed === false));
    // The edit was counted by the database: the message's second revision, as the record will write it.
    assert.equal(done[2].sourceId, 'src:discord:400000000000000101:2:seen');
    env.writeRecord();
    assert.equal(seedUnits(env.handle, env.data, wrongly({ log: quiet, now: () => NOW + 60_000 })).errors, 0);
    const { fixture } = env;
    const natives = fixture.events.map(({ event }) => event.message.id);
    const mine = db
      .prepare(
        `SELECT id, writer, origin FROM sources WHERE native_id IN (${natives.map(() => '?').join(', ')}) ORDER BY id`
      )
      .all(...natives)
      .map((row) => ({ ...row }));
    assert.equal(mine.length, fixture.record.length + fixture.privateRecord.length, 'one row per record line');
    assert.ok(
      mine.every((row) => row.writer === 'record' && row.origin === 'live'),
      JSON.stringify(mine)
    );
    assert.equal(
      count(db, 'SELECT COUNT(*) AS n FROM places WHERE id = ? AND writer IS NOT NULL', `discord:channel:${CHANNEL}`),
      1
    );
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
  } finally {
    env.done();
  }
});

// The write kind `record-lines` (src/memory/db/record-lines.ts): the lines of the record written as `sources` rows of
// their place's day directly instead of through the record mapper of a unit write. The first tests write the same lines
// through the unit write of each day and through the write kind, and compare every table column by column: the rows,
// their day's unit, the message families, the media and the relations.

const LINES_NOW = Date.parse('2026-11-09T10:00:00.000Z');
const ROOT = 'synthetic:root:1';
const DAY2 = '2026-11-09T08:00:00.000Z';

type Memory = Awaited<ReturnType<typeof openTestMemory>>;
type Ref = { lineId: string; locator: { iface: string; chatId: string; messageId: string }; observedSourceId?: string };

const seen = (id: string, messageId: string, occurredAt: string, extra: Row = {}): Row => ({
  v: 1,
  id,
  kind: 'seen',
  messageId,
  revision: 1,
  occurredAt,
  recordedAt: occurredAt,
  scope: { channel: 'room-a' },
  by: 'member',
  replyTo: null,
  text: `text of ${id}`,
  media: [],
  mentions: [],
  direct: false,
  participants: ['member'],
  sourceMessageIds: [messageId],
  origin: 'live',
  ...extra,
});

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

const ref = (line: Row, observedSourceId?: string): Ref => ({
  lineId: String(line.id),
  locator: { iface: 'synthetic', chatId: 'room-a', messageId: String(line.messageId) },
  ...(observedSourceId ? { observedSourceId } : {}),
});

/** The day of a line, as the unit path names its unit. */
const dayOf = (line: Row): string => String(line.occurredAt).slice(0, 10);

async function fresh(): Promise<Memory> {
  return openTestMemory({ now: () => LINES_NOW, iface: () => 'synthetic' });
}

test('a write with a reference that names no line of it is refused with a code', async () => {
  const memory = await fresh();
  try {
    const line = seen('r1', 'm11', DAY2);
    await assert.rejects(
      memory.memoryDb.writeRecordLines({ placeId: ROOT, lines: [line], messages: [{ ...ref(line), lineId: 'other' }] }),
      { code: 'BAD_NATIVE' }
    );
  } finally {
    await memory.close();
  }
});

test('a line names the stored rows of its author and chat when their ids spell nothing, and reads back as written', () => {
  const dir = tempDataDir();
  const handle = openMemoryDb(path.join(dir, 'memory.db'));
  try {
    const db = dbOf(handle);
    addAccount(db, {
      id: 'account:7f3e',
      iface: 'synthetic',
      authority: 'synthetic/global',
      native: 'member',
      person: 'person:5a1c',
    });
    addChannelPlace(db, { id: 'place:9b20', iface: 'synthetic', authority: 'synthetic/global', native: 'room-a' });
    const line = seen('o1', 'm30', DAY2);
    applyMemoryWrite(handle, {
      kind: 'record-lines',
      placeId: 'place:9b20',
      lines: [line],
      iface: 'synthetic',
      now: LINES_NOW,
    });
    const row = db.prepare('SELECT author_account, place_id, extra FROM sources WHERE native_id = ?').get('m30');
    assert.equal(row?.author_account, 'account:7f3e');
    assert.equal(row?.place_id, 'place:9b20');
    const [stored] = recordLines(db, placeOrPersona('record', 'place:9b20', { partition: dayOf(line) }));
    const read = JSON.parse(String(stored)) as Row;
    assert.equal(read.by, 'member');
    assert.deepEqual(read.scope, { channel: 'room-a' });
  } finally {
    handle.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

/** The emoji and stickers a line links, as `[kind, platform id, name]`, sorted. */
function linkedOf(db: Db, messageId: string): Array<Array<unknown>> {
  const rows = db
    .prepare(
      `SELECT m.kind AS kind, m.native_ref AS ref, json_extract(m.extra, '$.name') AS name
       FROM sources s JOIN media_links l ON l.owner_kind = 'source' AND l.owner_id = s.id
       JOIN media m ON m.id = l.media_id
       WHERE s.native_id = ? AND m.kind IN ('emoji', 'sticker')`
    )
    .all(messageId);
  return rows.map((row) => [row.kind, row.ref, row.name]).sort((a, b) => String(a[0]).localeCompare(String(b[0])));
}

test('a record line of a message with a custom emoji and a sticker links both by platform id and stable name', async () => {
  const memory = await fresh();
  try {
    const line = linesToRecordLine(
      {
        id: 'm40',
        placeId: 'room-a',
        authorId: 'member',
        content: 'look :e4:',
        ts: Date.parse(DAY2),
        emojis: [{ id: '901', name: 'e4' }],
        stickers: [{ id: '801', name: 's2', animated: false, url: null }],
      },
      { now: () => LINES_NOW }
    );
    await createRecord({ ...memory, now: () => LINES_NOW }).append(ROOT, [line]);
    const db = memory.memoryDb.database() as Db;
    assert.deepEqual(linkedOf(db, 'm40'), [
      ['emoji', '901', 'e4'],
      ['sticker', '801', 's2'],
    ]);
  } finally {
    await memory.close();
  }
});

// Diagnosis 2026-11-18, graph orphans: a stored line named an author account no row held, so its `authored_by` edge
// ended at nothing and its author resolved to no one. The live observation writes the account of a line's author; a
// record line carries the author's platform id alone (`by`), so the row holds that id and no name.
test('a line by an author memory does not know writes that author account with the platform id the line carries', () => {
  const dir = tempDataDir();
  const handle = openMemoryDb(path.join(dir, 'memory.db'));
  try {
    const db = dbOf(handle);
    addChannelPlace(db, { id: 'place:4c11', iface: 'synthetic', authority: 'synthetic/global', native: 'room-a' });
    const line = seen('u1', 'm40', DAY2, { by: 'stranger-7', participants: ['stranger-7'] });
    applyMemoryWrite(handle, {
      kind: 'record-lines',
      placeId: 'place:4c11',
      lines: [line],
      iface: 'synthetic',
      now: LINES_NOW,
    });
    const author = db.prepare('SELECT author_account FROM sources WHERE native_id = ?').get('m40')?.author_account;
    const account = db.prepare('SELECT iface, native_id FROM accounts WHERE id = ?').get(author);
    assert.deepEqual(
      { iface: account?.iface, native: account?.native_id },
      { iface: 'synthetic', native: 'stranger-7' }
    );
  } finally {
    handle.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// A replay draws its ids from a counter, so two runs of one write leave the same rows.
test("a line of the persona's reserves its message family under the key the write draws from its `uuid`", () => {
  const dir = tempDataDir();
  const handle = openMemoryDb(path.join(dir, 'memory.db'));
  try {
    const db = dbOf(handle);
    addChannelPlace(db, { id: 'place:4c12', iface: 'synthetic', authority: 'synthetic/global', native: 'room-a' });
    let drawn = 0;
    applyMemoryWrite(handle, {
      kind: 'record-lines',
      placeId: 'place:4c12',
      lines: [said('s9', 'm41', DAY2)],
      iface: 'synthetic',
      now: LINES_NOW,
      uuid: () => `key-${(drawn += 1)}`,
    });
    const keys = db.prepare('SELECT native_key FROM message_families WHERE message_id = ?').all('m41');
    assert.deepEqual(
      keys.map((row) => row.native_key),
      ['key-1']
    );
  } finally {
    handle.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The other order of one send: the record line lands before the interface's echo of the same message. The two must
// still be one `sources` row, and that row must read as the one the echo-first order leaves. Synthetic data only.
const SENT = NOW - 60_000;
const IFACE = 'synthetic';
const FIRST_ROOT = 'root';
// The place that holds the record of the chat's tree, as the pipeline names it (src/memory/addresses.ts#sharedPlaceOf).
const TOP = topPlaceSpelled(IFACE, FIRST_ROOT);
const ROOM = 'room-a';
const SELF_ID = 'her-account';
const FIRST_MEMBER = 'member-account';
const WORDS = 'τα κλειδιά στο συρτάρι';

async function observeLine(
  memory: Memory,
  {
    id = 'sent-1',
    author = SELF_ID,
    at = SENT,
    replyToId,
  }: { id?: string; author?: string; at?: number; replyToId?: string } = {}
): Promise<string> {
  const event = {
    iface: IFACE,
    at,
    chat: { id: ROOM, kind: 'channel', chatType: 'channel', rootId: FIRST_ROOT },
    addressing: { mentionedAccountIds: [] },
    message: {
      id,
      at,
      content: WORDS,
      author: { id: author, self: author === SELF_ID },
      ...(replyToId ? { replyToId } : {}),
    },
  };
  const envelope = observationOf(event, { selfId: SELF_ID });
  if (!envelope) throw new Error('the synthetic event was refused');
  const done = await memory.memoryDb.observeMessage(envelope, { placeId: TOP });
  if (!done || !('sourceId' in done) || typeof done.sourceId !== 'string')
    throw new Error('the observation was refused');
  return done.sourceId;
}

async function recordSent(memory: Memory): Promise<void> {
  const line = firstToRecordLine(
    { id: 'sent-1', placeId: ROOM, content: WORDS, ts: SENT, replyToId: null, mentionedAccountIds: [] },
    { kind: 'said', now: () => NOW, turnId: 't-1', opId: 'op-1' }
  );
  await createRecord({ ...memory, now: () => NOW }).append(TOP, [line], {});
}

function database(memory: Memory): Db {
  const db = memory.memoryDb.database();
  if (!db) throw new Error('database unavailable');
  return db;
}

const saidRows = (db: Db): Array<Row> => db.prepare("SELECT * FROM sources WHERE kind = 'said' ORDER BY rowid").all();

async function withOrder(
  order: 'record-first' | 'echo-first',
  run: (memory: Memory, db: Db) => Promise<void> | void
): Promise<void> {
  const memory = await openTestMemory({ now: () => NOW, iface: () => IFACE });
  try {
    if (order === 'record-first') {
      await recordSent(memory);
      await observeLine(memory);
    } else {
      await observeLine(memory);
      await recordSent(memory);
    }
    await run(memory, database(memory));
  } finally {
    await memory.close();
  }
}

test('a record line landing before its echo leaves one said row carrying the turn', async () => {
  // Bug: the record line takes a key the echo does not know, and the echo writes a second row beside it.
  await withOrder('record-first', (_memory, db) => {
    const rows = saidRows(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.turn_id, 't-1');
    assert.equal(rows[0]?.op_id, 'op-1');
  });
});

test('both orders of one send key the line by its message family', async () => {
  // Bug: a line recorded first holds the protocol id, so vector links and replies take another route to it.
  await withOrder('record-first', (_memory, db) => {
    const family = db.prepare("SELECT native_key FROM message_families WHERE message_id = 'sent-1'").get();
    assert.equal(saidRows(db)[0]?.native_id, family?.native_key);
  });
  await withOrder('echo-first', (_memory, db) => {
    const family = db.prepare("SELECT native_key FROM message_families WHERE message_id = 'sent-1'").get();
    assert.equal(saidRows(db)[0]?.native_id, family?.native_key);
  });
});

test('a line recorded before its echo stands in the place the echo names', async () => {
  // Bug: the record line derives its place by another route, so the line leaves the room's window and audience.
  await withOrder('record-first', async (memory, db) => {
    await observeLine(memory, { id: 'member-1', author: FIRST_MEMBER, at: SENT + 1000 });
    const member = db.prepare("SELECT place_id, audience_id FROM sources WHERE kind = 'seen'").get();
    const personaLine = saidRows(db)[0];
    assert.equal(personaLine?.place_id, member?.place_id);
    assert.equal(personaLine?.audience_id, member?.audience_id);
  });
});

test('a record line retried after a record-first send and its echo adds no row', async () => {
  // Bug: the retry looks for the protocol id, which the row does not hold.
  await withOrder('record-first', async (memory, db) => {
    await recordSent(memory);
    assert.equal(saidRows(db).length, 1);
  });
});

test("the echo of the persona's line in a second room with the same message id stays its own row", async () => {
  // Bug: a lookup by the message id alone joins two chats' lines of an interface with per-room ids.
  await withOrder('echo-first', async (memory, db) => {
    const line = firstToRecordLine(
      { id: 'sent-1', placeId: 'room-b', content: WORDS, ts: SENT, replyToId: null, mentionedAccountIds: [] },
      { kind: 'said', now: () => NOW, turnId: 't-2', opId: 'op-2' }
    );
    await createRecord({ ...memory, now: () => NOW }).append(TOP, [line], {});
    assert.deepEqual(
      saidRows(db)
        .map((row) => row.turn_id)
        .sort(),
      ['t-1', 't-2']
    );
  });
});

test("the revision of the persona's line reads by its protocol id once it holds a family key", async () => {
  // Bug: an edit asks the newest revision by the protocol id, finds none and writes revision 1 over the slot of the persona's line.
  await withOrder('echo-first', async (memory) => {
    const record = createRecord({ ...memory, now: () => NOW });
    assert.equal(await record.newestRevision(TOP, 'sent-1', new Date(SENT).toISOString()), 1);
  });
});

// One sent line, one `sources` row. The interface echoes the persona's own message to the core, the observation stores it under the
// key of its message family, and the record line of the same send (src/turn/journal-notes.ts#recordSaid and its siblings,
// all `record.append(placeId, [line], {})`) arrives with no descriptor, so it must find that family by itself.
// Synthetic data only.
const SINGLE_ROOT = 'root';
// The place that holds the record of the chat's tree, as the pipeline names it (src/memory/addresses.ts#sharedPlaceOf).
const SINGLE_TOP = topPlaceSpelled(IFACE, SINGLE_ROOT);
const SINGLE_WORDS = 'κουνέλι στον κήπο';

/** The `message.received` event of a line: the persona's when `author` is their id, as the interface delivers their own echo. */
function lineEvent({
  id = 'sent-1',
  author = SELF_ID,
  at = SENT,
  text = SINGLE_WORDS,
  replyToId,
  mentionedAccountIds = [],
}: {
  id?: string;
  author?: string;
  at?: number;
  text?: string;
  replyToId?: string;
  mentionedAccountIds?: Array<string>;
} = {}) {
  return {
    iface: IFACE,
    at,
    chat: { id: ROOM, kind: 'channel', chatType: 'channel', rootId: SINGLE_ROOT },
    addressing: { mentionedAccountIds },
    message: {
      id,
      at,
      content: text,
      author: { id: author, self: author === SELF_ID },
      ...(replyToId ? { replyToId } : {}),
    },
  };
}

async function singleObserveLine(memory: Memory, options: Parameters<typeof lineEvent>[0] = {}): Promise<string> {
  const envelope = observationOf(lineEvent(options), { selfId: SELF_ID });
  if (!envelope) throw new Error('the synthetic event was refused');
  const done = await memory.memoryDb.observeMessage(envelope, { placeId: SINGLE_TOP });
  if (!done || !('sourceId' in done) || typeof done.sourceId !== 'string')
    throw new Error('the observation was refused');
  return done.sourceId;
}

/** The record line of the persona's send, as recordSaid builds it, appended with no descriptor as every said writer does. */
async function singleRecordSent(
  memory: Memory,
  { mentionedAccountIds = [] }: { mentionedAccountIds?: Array<string> } = {}
) {
  const line = singleToRecordLine(
    { id: 'sent-1', placeId: ROOM, content: SINGLE_WORDS, ts: SENT, replyToId: null, mentionedAccountIds },
    { kind: 'said', now: () => NOW, turnId: 't-1', opId: 'op-1' }
  );
  await createRecord({ ...memory, now: () => NOW }).append(SINGLE_TOP, [line], {});
}

async function withEchoedLine(run: (memory: Memory, db: Db) => Promise<void> | void): Promise<void> {
  const memory = await openTestMemory({ now: () => NOW, iface: () => IFACE });
  try {
    await singleObserveLine(memory);
    await singleRecordSent(memory);
    await run(memory, database(memory));
  } finally {
    await memory.close();
  }
}

test("the persona's sent line leaves one said row when its echo was observed before the record line", async () => {
  // Bug: the record line takes the protocol id as its key, the echo its family's, and each stands as the persona's line.
  await withEchoedLine((_memory, db) => {
    assert.equal(saidRows(db).length, 1);
  });
});

test("the one row of the persona's echoed line carries the turn and the post operation", async () => {
  // Bug: the row the rest of memory attaches to (replies, episodes) has no turn, so nothing joins it to the persona's attempt.
  await withEchoedLine((_memory, db) => {
    const withTurn = saidRows(db).filter((row) => row.turn_id === 't-1');
    assert.equal(withTurn.length, 1);
    assert.equal(withTurn[0]?.op_id, 'op-1');
    assert.equal(saidRows(db).filter((row) => row.turn_id === null).length, 0);
  });
});

test('a record line retried after the echo adds no row', async () => {
  // Bug: the duplicate check looks for the protocol id, which the adopted row no longer holds as its native id.
  await withEchoedLine(async (memory, db) => {
    await singleRecordSent(memory);
    assert.equal(saidRows(db).length, 1);
  });
});
