// Tests for src/memory/record.ts: the record of every observed message, the persona's own lines
// and their feelings, written to the memory database of a temporary directory (never the
// deployment's data/). Later sections adopt observed sources, read through the reader fixture, reopen the database
// and address the place of the record's rows.
import { legacyServerPlaceId } from '../../fixtures/memory-db/legacy-paths.ts';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {
  RECORD_LINKS_MAX,
  appendRevision,
  asRecordLines,
  createRecord,
  recordLinks,
  toRecordLine as toStoredLine,
} from '../../../src/memory/record.ts';
import type { RecordLine } from '../../../src/memory/record.ts';
import { newestRevisions } from '../../../src/memory/chunks.ts';
import { normalizeMessage } from '../../../interfaces/discord/index.ts';
import { slimMessage } from '../../../src/memory/update.ts';
import { openMemoryDb } from '../../../src/memory/db/open.ts';
import { dbOf } from '../../../src/memory/db/types.ts';
import { addAccount, addDmPlace } from '../../fixtures/memory-db/opaque-people.ts';
import { openTestMemory, tempDataDir, unitFile } from '../../fixtures/memory-db/service.ts';
import { observationOf } from '../../../src/memory/db/observe-event.ts';
import { withIface } from '../../../src/memory/db/current-iface.ts';
import type { Db, Row } from '../../../src/memory/db/types.ts';
import type { MemoryDb } from '../../../src/memory/types.ts';
import { wrongly } from '../../fixtures/loose-types.ts';
import {
  GUILD,
  placeOfGuild,
  readAt,
  GUILD_2,
  MEMBER,
  CHANNEL_B,
  all,
  readerEnv,
} from '../../fixtures/memory-db/readers.ts';
import { after } from 'node:test';
import { createAppendStore } from '../../../src/memory/append-store.ts';
import { createArchive } from '../../../src/memory/archive.ts';
import { search } from '../../../src/memory/db/recall.ts';
import { internalContext } from '../../../src/memory/db/scope.ts';
import { createMemoryDb, type MemoryDbService } from '../../../src/memory/db/service.ts';
import { createJournal } from '../../../src/memory/journal.ts';
import { createStore } from '../../../src/memory/store.ts';
import { createVectors } from '../../../src/memory/vectors.ts';
import { addGroupPlace } from '../../fixtures/memory-db/opaque-people.ts';
import { tempDir } from '../../fixtures/tmp.ts';
import { topPlaceSpelled } from '../../../src/memory/db/ids.ts';

const quiet = { info() {}, warn() {}, error() {} };
const T1 = Date.UTC(2026, 9, 11, 11, 55, 51, 568);
const T2 = Date.UTC(2026, 9, 12, 8, 0, 0);
const G1 = legacyServerPlaceId('discord', 'g1');
const DM_U1 = 'discord:dm:u1';
const NOW = Date.UTC(2026, 9, 13, 9, 0, 0);

// The line as the record stores it: `toRecordLine` types it as a plain object.
const toRecordLine = (...args: Parameters<typeof toStoredLine>) => toStoredLine(...args) as RecordLine;

function counter(prefix: string) {
  let n = 0;
  return () => `${prefix}${(n += 1)}`;
}

function slim(overrides: Record<string, unknown> = {}) {
  return {
    id: 'm1',
    placeId: 'c1',
    channelName: 'général',
    authorId: 'u1',
    authorName: 'Zoé',
    self: false,
    bot: false,
    content: 'Καλημέρα',
    ts: T1,
    replyToId: null,
    attachments: [],
    links: [],
    stickers: [],
    emojis: [],
    direct: false,
    ...overrides,
  };
}

/** A data directory whose database holds u1's account and direct chat, as the observation of u1's first line stores them. */
function withStoredDm(): string {
  const dataDir = tempDataDir();
  const handle = openMemoryDb(path.join(dataDir, 'memory.db'));
  try {
    const db = dbOf(handle);
    addAccount(db, {
      id: 'discord:u1',
      iface: 'discord',
      authority: 'discord/global',
      native: 'u1',
      person: 'person:u1',
    });
    addDmPlace(db, {
      id: DM_U1,
      iface: 'discord',
      authority: 'discord/global',
      account: 'discord:u1',
      person: 'person:u1',
    });
  } finally {
    handle.close();
  }
  return dataDir;
}

async function scene({ dataDir: given }: { dataDir?: string } = {}) {
  const mem = await openTestMemory(given ? { dataDir: given } : {});
  const dataDir = mem.dataDir;
  const record = createRecord({ dataDir, log: quiet, now: () => NOW, memoryDb: mem.memoryDb });
  const done = async () => {
    await mem.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
  return { dataDir, record, memoryDb: mem.memoryDb, done };
}

/** The lines the database holds for the record unit `rel` (a day of a month). */
function unitLines(memoryDb: Parameters<typeof unitFile>[0], rel: string) {
  const text = unitFile(memoryDb, rel);
  return text
    ? text
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
}

async function collect(iterable: AsyncIterable<object>) {
  const out: Array<RecordLine> = [];
  for await (const item of asRecordLines(iterable)) out.push(item);
  return out;
}

const OCTOBER = { from: '2026-10-01T00:00:00.000Z', to: '2026-10-31T23:59:59.999Z' };

test('record: toRecordLine keeps only the whitelisted fields and lists participants', () => {
  const line = toRecordLine(
    slim({
      replyToId: 'm0',
      replyToAuthorId: 'u3',
      mentionedAccountIds: ['u2'],
      attachments: [{ kind: 'image', name: 'a.png', id: 'm1#a0', durationSec: null, url: 'https://x/a.png' }],
      links: [{ kind: 'gif', name: 'Tenor', id: 'm1#e0', durationSec: null }],
      stickers: [{ id: 's1', name: 'wave', format: 1 }],
      direct: true,
      avatarUrl: 'https://x/avatar.png',
      presence: 'online',
    }),
    { now: () => NOW, uuid: () => 'u-1' }
  );
  assert.deepEqual(line, {
    v: 1,
    id: 'u-1',
    kind: 'seen',
    messageId: 'm1',
    revision: 1,
    occurredAt: new Date(T1).toISOString(),
    recordedAt: new Date(NOW).toISOString(),
    scope: { channel: 'c1' },
    by: 'u1',
    replyTo: 'm0',
    text: 'Καλημέρα',
    // A record line carries its emoji and stickers as media items with their ids and stable names.
    media: [
      'image',
      'gif',
      {
        kind: 'sticker',
        availability: 'unreadable',
        nativeRef: 's1',
        description: null,
        origin: null,
        extra: { name: 'wave' },
      },
    ],
    mentions: ['u2'],
    direct: true,
    participants: ['u1', 'u2', 'u3'],
    sourceMessageIds: ['m1'],
    origin: 'live',
  });
  assert.equal(JSON.stringify(line).includes('https://'), false, 'no URL survives');

  const said = toRecordLine(
    slim({ authorId: 'self1', mentionedAccountIds: ['u2'], replyToId: 'm0', replyToAuthorId: 'u3' }),
    {
      kind: 'said',
      turnId: 't-1',
      opId: 'op-1',
      now: () => NOW,
      uuid: () => 'u-2',
    }
  );
  assert.equal(said.kind, 'said');
  assert.equal('by' in said, false, "the persona's own line names no author");
  assert.deepEqual(said.participants, ['u2', 'u3']);
  assert.equal(said.turnId, 't-1');
  assert.equal(said.opId, 'op-1');

  const deleted = toRecordLine(
    { id: 'm1', placeId: 'c1', authorId: 'u1', ts: T2 },
    { kind: 'deleted', now: () => NOW, uuid: () => 'u-3' }
  );
  assert.deepEqual(
    Object.keys(deleted).sort(),
    [
      'id',
      'kind',
      'messageId',
      'occurredAt',
      'origin',
      'participants',
      'recordedAt',
      'scope',
      'sourceMessageIds',
      'v',
    ].sort()
  );
  assert.deepEqual(deleted.participants, ['u1']);
});

test('record: a message with link embeds keeps a compact links field (url, title, description, site)', () => {
  const embeds = [
    {
      url: 'https://video.example/watch?v=1',
      title: 'Course de montagne épique',
      description: 'Δύο παίκτες τρέχουν. '.repeat(30),
      provider: { name: 'VideoSite' },
    },
    { url: 'https://media.example/cat.gif', title: 'Gato', provider: { name: 'Tenor' } },
    { url: 'https://news.example/a', title: '', description: '' },
    { url: 'https://news.example/b', title: 'Deuxième', description: 'texte' },
    { url: 'https://news.example/c', title: 'Troisième' },
    { url: 'https://news.example/d', title: 'Quatrième' },
  ];
  const message = {
    id: 'm1',
    placeId: 'c1',
    channel: { name: 'général' },
    author: { id: 'u1', bot: false, username: 'zoe' },
    cleanContent: 'κοίτα https://video.example/watch?v=1',
    content: 'κοίτα https://video.example/watch?v=1',
    createdTimestamp: T1,
    embeds,
  };
  const line = toRecordLine(slimMessage(normalizeMessage(message, 'self1') as Parameters<typeof slimMessage>[0]), {
    now: () => NOW,
    uuid: () => 'u-1',
  });
  assert.equal(line.links?.length, RECORD_LINKS_MAX, 'at most three links');
  assert.deepEqual(
    line.links?.map((l: { title: string }) => l.title),
    ['Course de montagne épique', 'Deuxième', 'Troisième'],
    'a GIF and an embed with nothing to say are skipped'
  );
  const [first] = line.links ?? [];
  assert.equal(first.url, 'https://video.example/watch?v=1');
  assert.equal(first.site, 'VideoSite');
  assert.ok(first.description.startsWith('Δύο παίκτες'));
  assert.deepEqual(Object.keys(first).sort(), ['description', 'id', 'site', 'title', 'url']);
  assert.equal(line.text, 'κοίτα https://video.example/watch?v=1', 'the text stays as posted');

  const plain = toRecordLine(slim(), { now: () => NOW, uuid: () => 'u-2' });
  assert.equal('links' in plain, false, 'a message without link embeds has no links field');
  assert.deepEqual(
    recordLinks([{ kind: 'link', title: 42, text: null, url: 'https://x.example' }]),
    [],
    'nothing readable, nothing kept'
  );
});

// A link preview's title and description are kept whole, with no length limit.
test('recordLinks: a long title and description are kept whole', () => {
  const title = 'Course de montagne épique '.repeat(20).trim();
  const description = 'Δύο παίκτες τρέχουν. '.repeat(30).trim();
  assert.deepEqual(
    recordLinks([{ kind: 'link', url: 'https://video.example/watch?v=1', title, description, site: 'VideoSite' }]).map(
      (link) => [link.title, link.description]
    ),
    [[title, description]]
  );
});

// No text the persona reads is cut silently.
test('recordLinks: a link whose URL runs past 500 characters keeps its URL whole', () => {
  const url = `https://archive.example/${'σελίδα/'.repeat(90)}`;
  assert.deepEqual(
    recordLinks([{ kind: 'link', url, title: 'Αρχείο' }]).map((link) => link.url),
    [url]
  );
});

// No text the persona reads is cut silently.
test('recordLinks: a link whose site name runs past 100 characters keeps it whole', () => {
  const site = 'Ένας πολύ μακρύς ιστότοπος '.repeat(6).trim();
  assert.deepEqual(
    recordLinks([{ kind: 'link', url: 'https://site.example/', title: 'Αρχείο', site }]).map((link) => link.site),
    [site]
  );
});

test('record: append writes to the day of occurredAt under the month directory and refuses a duplicate messageId+revision', async () => {
  const { dataDir, record, memoryDb, done } = await scene();
  const first = await record.append(G1, [
    toRecordLine(slim({ id: 'm1', ts: T1 })),
    toRecordLine(slim({ id: 'm2', ts: T2 })),
  ]);
  assert.deepEqual(first, { written: 2, duplicates: 0 });
  const again = await record.append(G1, [toRecordLine(slim({ id: 'm1', ts: T1 }))]);
  assert.deepEqual(again, { written: 0, duplicates: 1 });

  const file1 = path.join(dataDir, 'places', encodeURIComponent(G1), 'record', '2026-10', '2026-10-11.jsonl');
  const file2 = path.join(dataDir, 'places', encodeURIComponent(G1), 'record', '2026-10', '2026-10-12.jsonl');
  assert.equal(record.dayFile(G1, new Date(T1).toISOString()), file1);
  const day1 = unitLines(memoryDb, 'guilds/g1/record/2026-10/2026-10-11.jsonl');
  assert.equal(day1.length, 1);
  assert.equal(day1[0].messageId, 'm1');
  // The line spells no root: the unit's key names the place.
  assert.deepEqual(
    unitLines(memoryDb, 'guilds/g1/record/2026-10/2026-10-12.jsonl').map((l) => l.messageId),
    ['m2']
  );
  assert.equal(fs.existsSync(file1), false, 'no record file');

  // A fresh instance reads the database and still refuses the duplicate.
  const reopened = createRecord({ dataDir, log: quiet, now: () => NOW, memoryDb });
  assert.deepEqual(await reopened.append(G1, [toRecordLine(slim({ id: 'm2', ts: T2 }))]), {
    written: 0,
    duplicates: 1,
  });
  await done();
});

test('record: an edit is a new line with revision 2', async () => {
  const { dataDir, record, memoryDb, done } = await scene();
  await record.append(G1, [toRecordLine(slim({ content: 'first' }))]);
  const edit = await record.append(G1, [toRecordLine(slim({ content: 'second' }), { revision: 2 })]);
  assert.deepEqual(edit, { written: 1, duplicates: 0 });
  const lines = await collect(record.iterate(G1, OCTOBER));
  assert.deepEqual(
    lines.map((l) => [l.messageId, l.revision, l.text]),
    [
      ['m1', 1, 'first'],
      ['m1', 2, 'second'],
    ]
  );
  assert.equal(unitLines(memoryDb, 'guilds/g1/record/2026-10/2026-10-11.jsonl').length, 2);
  await done();
});

test('record: iterate filters by time and channel', async () => {
  const { record, memoryDb, done } = await scene();
  await record.append(G1, [
    toRecordLine(slim({ id: 'm1', ts: T1, placeId: 'c1' })),
    toRecordLine(slim({ id: 'm2', ts: T2, placeId: 'c2' })),
    toRecordLine(slim({ id: 'm3', ts: T2 + 1000, placeId: 'c1' })),
  ]);
  const lines = await collect(
    record.iterate(G1, { from: new Date(T2).toISOString(), to: new Date(NOW).toISOString(), placeIds: ['c1'] })
  );
  assert.deepEqual(
    lines.map((l) => l.messageId),
    ['m3']
  );
  await done();
});

test('record: a private line never lands in the guild directory', async () => {
  // The direct chat is stored: a line of a place no row holds is not stamped private (src/memory/record.ts).
  const { dataDir, record, memoryDb, done } = await scene({ dataDir: withStoredDm() });
  const result = await record.append(DM_U1, [toRecordLine(slim({ id: 'd1', placeId: 'dm1' }))]);
  assert.deepEqual(result, { written: 1, duplicates: 0 });
  const privateFile = path.join(dataDir, 'places', encodeURIComponent(DM_U1), 'record', '2026-10', '2026-10-11.jsonl');
  assert.equal(record.dayFile(DM_U1, new Date(T1).toISOString()), privateFile);
  const [line] = unitLines(memoryDb, 'guilds/g1/private/u1/record/2026-10/2026-10-11.jsonl');
  assert.equal(line.messageId, 'd1');
  assert.deepEqual(line.scope, { user: 'u1', private: true, channel: 'dm1' });
  assert.equal(unitFile(memoryDb, 'guilds/g1/record/2026-10/2026-10-11.jsonl'), null, 'nothing in the guild record');
  assert.deepEqual(
    (await collect(record.iterate(DM_U1, OCTOBER))).map((l) => l.messageId),
    ['d1']
  );
  assert.deepEqual(await collect(record.iterate(G1, OCTOBER)), []);
  await done();
});

test('record: an edit refused as a duplicate revision lands after the newest one the index holds', async () => {
  const { dataDir, record, memoryDb, done } = await scene();
  const logs: Array<{ msg: string; fields: unknown }> = [];
  const log = { info: (msg: string, fields: unknown) => logs.push({ msg, fields }), warn() {}, error() {} };
  await record.append(G1, [toRecordLine(slim({ content: 'first' }))]);
  // Revision 2 is written already; the bot restarts and an edit comes in.
  await record.append(G1, [
    {
      ...toRecordLine(slim({ content: 'first' }), { revision: 2 }),
      links: [{ url: 'https://example.org', title: 'Τίτλος', description: '', site: 'example.org' }],
    },
  ]);
  const reopened = createRecord({ dataDir, log: quiet, now: () => NOW, memoryDb });
  assert.equal(await reopened.newestRevision(G1, 'm1', new Date(T1).toISOString()), 2);
  assert.equal(await reopened.newestRevision(G1, 'm9', new Date(T1).toISOString()), null);
  const edited = slim({ content: 'edited' });
  const out = await appendRevision(reopened, G1, (revision) => toRecordLine(edited, { revision, now: () => NOW }), 2, {
    log,
  });
  assert.deepEqual(out, { revision: 3, written: 1, duplicates: 0, bumps: 1 });
  assert.deepEqual(
    logs,
    [{ msg: 'record: edit revision bumped', fields: { placeId: G1, bumps: 1, written: 1 } }],
    'counts only'
  );
  const lines = await collect(reopened.iterate(G1, OCTOBER));
  assert.deepEqual(
    lines.map((l) => l.revision),
    [1, 2, 3]
  );
  const [newest] = newestRevisions(lines);
  assert.deepEqual([newest.revision, newest.text], [3, 'edited']);

  // A free revision is written at once, with no log.
  logs.length = 0;
  assert.deepEqual(
    await appendRevision(reopened, 'g1', (revision) => toRecordLine(slim({ content: 'again' }), { revision }), 4, {
      log,
    }),
    { revision: 4, written: 1, duplicates: 0, bumps: 0 }
  );
  assert.equal(logs.length, 0);
  // A record without newestRevision still moves on, one revision at a time, at most EDIT_REVISION_RETRIES.
  let calls = 0;
  const stubborn = { append: async () => ((calls += 1), { written: 0, duplicates: 1 }) };
  const refused = await appendRevision(stubborn, 'g1', (revision) => ({ revision }), 2, { log });
  assert.deepEqual([refused.written, refused.bumps, calls], [0, 5, 6]);
  await done();
});

// ---- observed sources: the message families of qualified record writes -------------------------------------------

// Qualified record writes adopt exact observed sources and preserve protocol IDs on export.

const FAMILY_NOW = Date.parse('2026-10-24T12:00:00Z');
const FAMILY_AT = new Date(FAMILY_NOW - 60000).toISOString();
const familyLocator = (room: string) => ({ iface: 'synthetic', chatId: room, messageId: 'same-message' });
const familyLine = (id: string, room: string, text: string, revision: number) => ({
  v: 1,
  id,
  kind: 'seen',
  messageId: 'same-message',
  revision,
  occurredAt: FAMILY_AT,
  recordedAt: new Date(FAMILY_NOW).toISOString(),
  placeId: 'root',
  scope: { channel: room },
  by: 'member',
  text,
  origin: 'live',
});

function observedId(result: object | null): string {
  if (!result || !('sourceId' in result) || typeof result.sourceId !== 'string') throw new Error('observation refused');
  return result.sourceId;
}

function envelope(room: string, text: string, edited = false) {
  const result = observationOf({
    iface: 'synthetic',
    at: FAMILY_NOW,
    edit: edited,
    chat: { id: room, kind: 'channel', chatType: 'channel' },
    message: { id: 'same-message', at: FAMILY_NOW - 60000, content: text, author: { id: 'member' } },
  });
  if (!result) throw new Error('synthetic message rejected');
  return result;
}

test('recording an observed edit enriches that exact revision without adding a source or incrementing again', async () => {
  const memory = await openTestMemory({ now: () => FAMILY_NOW, iface: () => 'synthetic' });
  try {
    const record = createRecord({ ...memory, now: () => FAMILY_NOW });
    observedId(await memory.memoryDb.observeMessage(envelope('room-a', 'Original'), { placeId: 'root' }));
    const editedId = observedId(
      await memory.memoryDb.observeMessage(envelope('room-a', 'Edited', true), { placeId: 'root' })
    );
    const db = memory.memoryDb.database();
    if (!db) throw new Error('database unavailable');
    const before = db.prepare('SELECT id, revision, text FROM sources ORDER BY revision').all();
    const data = familyLine('edit-record', 'room-a', 'Edited', 2);
    const opts = { messages: [{ lineId: data.id, locator: familyLocator('room-a'), observedSourceId: editedId }] };
    await record.append('root', [data], opts);
    await record.append('root', [data], opts);
    assert.deepEqual(db.prepare('SELECT id, revision, text FROM sources ORDER BY revision').all(), before);
    assert.equal(
      await record.newestRevision('root', 'same-message', FAMILY_AT, { locator: familyLocator('room-a') }),
      2
    );
    const exported: Array<object> = [];
    for await (const item of record.iterate('root')) exported.push(item);
    assert.ok(
      exported.some(
        (item) => 'messageId' in item && item.messageId === 'same-message' && 'revision' in item && item.revision === 2
      )
    );
  } finally {
    await memory.close();
  }
});

test('qualified records with one native ID retain separate revisions and actual chat IDs', async () => {
  const memory = await openTestMemory({ now: () => FAMILY_NOW, iface: () => 'synthetic' });
  try {
    const record = createRecord({ ...memory, now: () => FAMILY_NOW });
    for (const [room, revision] of [
      ['room-a', 3],
      ['room-b', 1],
    ] as const) {
      const data = familyLine(`record-${room}`, room, `Text ${room}`, revision);
      await record.append('root', [data], { messages: [{ lineId: data.id, locator: familyLocator(room) }] });
    }
    assert.equal(
      await record.newestRevision('root', 'same-message', FAMILY_AT, { locator: familyLocator('room-a') }),
      3
    );
    assert.equal(
      await record.newestRevision('root', 'same-message', FAMILY_AT, { locator: familyLocator('room-b') }),
      1
    );
    const exported: Array<object> = [];
    for await (const item of record.iterate('root')) exported.push(item);
    assert.equal(exported.length, 2);
    assert.ok(exported.every((item) => 'messageId' in item && item.messageId === 'same-message'));
  } finally {
    await memory.close();
  }
});

test('a supplied source belonging to another chat cannot receive record metadata', async () => {
  const memory = await openTestMemory({ now: () => FAMILY_NOW, iface: () => 'synthetic' });
  try {
    const record = createRecord({ ...memory, now: () => FAMILY_NOW });
    const foreignId = observedId(await memory.memoryDb.observeMessage(envelope('room-b', 'Foreign original')));
    const db = memory.memoryDb.database();
    if (!db) throw new Error('database unavailable');
    const before = db.prepare('SELECT * FROM sources ORDER BY id').all();
    const data = familyLine('forged-reference', 'room-a', 'Must not attach', 1);
    await assert.rejects(
      record.append('root', [data], {
        messages: [{ lineId: data.id, locator: familyLocator('room-a'), observedSourceId: foreignId }],
      })
    );
    assert.deepEqual(db.prepare('SELECT * FROM sources ORDER BY id').all(), before);
  } finally {
    await memory.close();
  }
});

test('exporting a normalized record restores native message and reply IDs rather than family keys', async () => {
  const memory = await openTestMemory({ now: () => FAMILY_NOW, iface: () => 'synthetic' });
  try {
    const record = createRecord({ ...memory, now: () => FAMILY_NOW });
    const child = envelope('room-a', 'Child');
    const childId = observedId(
      await memory.memoryDb.observeMessage(
        {
          ...child,
          messageReply: { iface: 'synthetic', chatId: 'room-a', messageId: 'native-parent' },
        },
        { placeId: 'root' }
      )
    );
    const data = { ...familyLine('child-record', 'room-a', 'Child', 1), replyTo: 'native-parent' };
    await record.append('root', [data], {
      messages: [{ lineId: data.id, locator: familyLocator('room-a'), observedSourceId: childId }],
    });
    const exported: Array<object> = [];
    for await (const item of record.iterate('root')) exported.push(item);
    assert.deepEqual(
      exported.map((item) => ['messageId' in item ? item.messageId : null, 'replyTo' in item ? item.replyTo : null]),
      [['same-message', 'native-parent']]
    );
    const db = memory.memoryDb.database();
    if (!db) throw new Error('database unavailable');
    assert.deepEqual(
      db
        .prepare("SELECT id FROM sources WHERE kind = 'seen'")
        .all()
        .map((row) => row.id),
      [childId]
    );
  } finally {
    await memory.close();
  }
});

test('recording an observed deletion adopts its tombstone without inventing a revision', async () => {
  const memory = await openTestMemory({ now: () => FAMILY_NOW, iface: () => 'synthetic' });
  try {
    const record = createRecord({ ...memory, now: () => FAMILY_NOW });
    const deletedId = observedId(
      await memory.memoryDb.deleteMessage(
        {
          v: 1,
          iface: 'synthetic',
          authority: 'synthetic/global',
          messageLocator: { v: 1, origin: 'protocol-message', ...familyLocator('room-a') },
          messageChat: { id: 'room-a', chatType: 'channel' },
          occurredAt: FAMILY_AT,
          observedAt: new Date(FAMILY_NOW).toISOString(),
        },
        { placeId: 'root' }
      )
    );
    const data = {
      v: 1,
      id: 'deleted-record',
      kind: 'deleted',
      messageId: 'same-message',
      occurredAt: FAMILY_AT,
      recordedAt: new Date(FAMILY_NOW).toISOString(),
      placeId: 'root',
      scope: { channel: 'room-a' },
      origin: 'live',
    };
    const options = { messages: [{ lineId: data.id, locator: familyLocator('room-a'), observedSourceId: deletedId }] };
    await record.append('root', [data], options);
    await record.append('root', [data], options);
    const db = memory.memoryDb.database();
    if (!db) throw new Error('database unavailable');
    assert.deepEqual(
      db
        .prepare("SELECT id, revision FROM sources WHERE kind = 'deleted'")
        .all()
        .map((row) => ({ ...row })),
      [{ id: deletedId, revision: null }]
    );
    const exported: Array<object> = [];
    for await (const item of record.iterate('root')) exported.push(item);
    assert.deepEqual(
      exported.map((item) => ('messageId' in item ? item.messageId : null)),
      ['same-message']
    );
  } finally {
    await memory.close();
  }
});

// ---- the record's reads from the database ---------------------------------------------------------------------------

// Every read answers from the database for every guild, layer, range and channel, and fails with a code when the
// database cannot answer.

// The entries of the record are untyped; the tests read these fields.
type ReaderEntry = { kind: string; messageId: string; revision?: number; text?: string };
const readerLine = (entry: object) => {
  const { kind, messageId, revision } = entry as ReaderEntry;
  return `${kind}:${messageId}:${revision ?? '-'}`;
};

test('record db reader: iterate answers every guild, layer, range and channel from the database', async () => {
  const env = await readerEnv();
  try {
    const record = createRecord({ dataDir: env.data, log: env.log, memoryDb: env.memoryDb });
    const queries = [
      {},
      { from: '2026-10-21T00:00:00.000Z' },
      { from: '2026-10-20T09:00:00.000Z', to: '2026-10-21T08:05:00.000Z' },
      { placeIds: [CHANNEL_B] },
      { privateAccountId: MEMBER },
      { privateAccountId: MEMBER, from: '2026-10-21T00:00:00.000Z' },
    ];
    const expected: Record<string, Array<Array<string>>> = {
      [GUILD]: [
        [
          'seen:400000000000000001:1',
          'seen:400000000000000001:2',
          'seen:400000000000000002:1',
          'seen:400000000000000011:1',
          'seen:400000000000000012:1',
          'seen:400000000000000013:1',
          'said:400000000000000014:1',
          'deleted:400000000000000012:-',
          'seen:400000000000000011:2',
        ],
        [
          'seen:400000000000000011:1',
          'seen:400000000000000012:1',
          'seen:400000000000000013:1',
          'said:400000000000000014:1',
          'deleted:400000000000000012:-',
          'seen:400000000000000011:2',
        ],
        [
          'seen:400000000000000001:1',
          'seen:400000000000000001:2',
          'seen:400000000000000002:1',
          'seen:400000000000000011:1',
          'seen:400000000000000012:1',
          'seen:400000000000000011:2',
        ],
        ['seen:400000000000000012:1', 'deleted:400000000000000012:-'],
        // Both guilds' private lines of the member: their DM place is one.
        ['seen:400000000000000005:1', 'seen:410000000000000005:1'],
        [],
      ],
      [GUILD_2]: [
        ['seen:410000000000000001:1', 'seen:410000000000000001:2', 'seen:410000000000000002:1'],
        [],
        ['seen:410000000000000001:1', 'seen:410000000000000001:2', 'seen:410000000000000002:1'],
        [],
        ['seen:410000000000000005:1'],
        [],
      ],
    };
    for (const placeId of [GUILD, GUILD_2]) {
      for (const [index, query] of queries.entries()) {
        // A DM place has no guild: the private queries run once, under the first guild.
        if (placeId === GUILD_2 && 'privateAccountId' in query) continue;
        const { placeId: holder, rest } = readAt(placeId, query);
        assert.deepEqual(
          (await all(record.iterate(holder, rest))).map(readerLine),
          expected[placeId][index],
          `${placeId} ${JSON.stringify(query)}`
        );
      }
    }
    const said = ((await all(record.iterate(placeOfGuild(GUILD)))) as Array<ReaderEntry>).find(
      (entry) => entry.kind === 'said'
    );
    assert.equal(said!.text, 'Ναι, of course');
    assert.deepEqual(env.warns, []);
  } finally {
    env.done();
  }
});

test('record db reader: newestRevision for edited, single, deleted, private and unknown messages', async () => {
  const env = await readerEnv();
  try {
    const record = createRecord({ dataDir: env.data, log: env.log, memoryDb: env.memoryDb });
    const cases: Array<[string, string, string, string | null, number | null]> = [
      [GUILD, '400000000000000001', '2026-10-20T09:00:00.000Z', null, 2],
      [GUILD, '400000000000000011', '2026-10-21T08:00:00.000Z', null, 2],
      [GUILD, '400000000000000012', '2026-10-21T08:05:00.000Z', null, 1],
      [GUILD, '400000000000000014', '2026-10-21T08:07:00.000Z', null, 1],
      [GUILD, '400000000000000099', '2026-10-21T08:07:00.000Z', null, null],
      [GUILD, '400000000000000005', '2026-10-20T09:00:00.000Z', MEMBER, 1],
      [GUILD, '400000000000000001', '2026-09-20T09:00:00.000Z', null, null],
    ];
    for (const [placeId, id, at, privateAccountId, revision] of cases) {
      const { placeId: holder } = readAt(placeId, { privateAccountId });
      assert.equal(await record.newestRevision(holder, id, at), revision, id);
    }
  } finally {
    env.done();
  }
});

test('record db reader: stats counts days, the first day and the distinct messages of the guild record', async () => {
  const env = await readerEnv();
  try {
    const record = createRecord({ dataDir: env.data, log: env.log, memoryDb: env.memoryDb });
    assert.deepEqual(await record.stats(placeOfGuild(GUILD_2)), { messages: 2, days: 1, first: '2026-10-20' });
    assert.deepEqual(await record.stats(placeOfGuild(GUILD)), { messages: 6, days: 2, first: '2026-10-20' });
  } finally {
    env.done();
  }
});

test('record db reader: a closed database or a failed read is an error with a code, logged', async () => {
  const env = await readerEnv();
  try {
    const closed = createRecord({ dataDir: env.data, log: env.log, memoryDb: env.closedDb });
    await assert.rejects(
      () => all(closed.iterate(placeOfGuild(GUILD))),
      (error: NodeJS.ErrnoException) => error.code === 'DB_CLOSED'
    );
    await assert.rejects(
      () => closed.newestRevision(placeOfGuild(GUILD), '400000000000000001', '2026-10-20T09:00:00.000Z'),
      (error: NodeJS.ErrnoException) => error.code === 'DB_CLOSED'
    );
    await assert.rejects(
      () => closed.stats(placeOfGuild(GUILD)),
      (error: NodeJS.ErrnoException) => error.code === 'DB_CLOSED'
    );
    // A handle whose database throws on the first query: only `db.prepare` is reached, so it stands in for a MemoryDb.
    const broken = {
      readHandle: () => ({
        db: {
          prepare() {
            throw Object.assign(new Error('disk I/O error'), { code: 'ERR_SQLITE_ERROR' });
          },
        },
      }),
    } as unknown as MemoryDb;
    const failing = createRecord({ dataDir: env.data, log: env.log, memoryDb: broken });
    await assert.rejects(
      () => all(failing.iterate(placeOfGuild(GUILD))),
      (error: NodeJS.ErrnoException) => error.code === 'ERR_SQLITE_ERROR'
    );
    assert.deepEqual(
      env.warns.map((warn) => [warn.message, warn.reader, warn.code]),
      [
        ['memory db: read failed', 'record', 'DB_CLOSED'],
        ['memory db: read failed', 'record', 'DB_CLOSED'],
        ['memory db: read failed', 'record', 'DB_CLOSED'],
        ['memory db: read failed', 'record', 'ERR_SQLITE_ERROR'],
      ]
    );
    assert.ok(
      env.warns.every((warn) => Object.keys(warn).sort().join() === 'code,message,reader'),
      'codes only'
    );
  } finally {
    env.done();
  }
});

// ---- the record over a reopened database --------------------------------------------------------------------------

const LINES_NOW = Date.parse('2026-11-09T10:00:00.000Z');
const LINES_ROOT = 'synthetic:root:1';
const LINES_DAY1 = '2026-11-08T09:00:00.000Z';
const LINES_DAY2 = '2026-11-09T08:00:00.000Z';

const linesSeen = (id: string, messageId: string, occurredAt: string, extra: Row = {}): Row => ({
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

const linesSaid = (id: string, messageId: string, occurredAt: string, extra: Row = {}): Row => ({
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

test('the record reads back what it wrote after the database is closed and opened again', async () => {
  const dataDir = tempDataDir();
  const lines = [
    linesSeen('a1', 'm20', LINES_DAY1),
    linesSaid('a2', 'm21', LINES_DAY2),
    linesSeen('a3', 'm22', LINES_DAY2, { revision: 2 }),
  ];
  const first = await openTestMemory({ dataDir, now: () => LINES_NOW, iface: () => 'synthetic' });
  const written: Array<object> = [];
  try {
    const record = createRecord({ ...first, now: () => LINES_NOW });
    await record.append(LINES_ROOT, lines);
    for await (const line of record.iterate(LINES_ROOT)) written.push(line);
  } finally {
    await first.close();
  }
  const second = await openTestMemory({ dataDir, now: () => LINES_NOW, iface: () => 'synthetic' });
  try {
    const record = createRecord({ ...second, now: () => LINES_NOW });
    const read: Array<object> = [];
    for await (const line of record.iterate(LINES_ROOT)) read.push(line);
    assert.equal(read.length, 3);
    assert.deepEqual(read, written);
    assert.deepEqual(await record.stats(LINES_ROOT), { messages: 3, days: 2, first: '2026-11-08' });
    assert.equal(await record.newestRevision(LINES_ROOT, 'm22', LINES_DAY2), 2);
  } finally {
    await second.close();
  }
});

// ---- the place of the record's rows -------------------------------------------------------------------------------

// The record addresses a canonical place: a DM's lines belong to its DM place. Retries run from the key chosen at the
// write, so they need no ambient interface.

const PLACES_NOW = Date.UTC(2026, 10, 3, 9, 0, 0);
const PLACES_DM = 'place:dm-a21';
const PLACES_OTHER = 'place:room-1';

/** The holders of a writer's live rows in `table`: the places, or the persona, whose lines they are. */
const holdersOf = (db: Db, table: string, writer: string): Array<unknown> =>
  db
    .prepare(`SELECT DISTINCT holder_id FROM "${table}" WHERE writer = ? AND retired_at IS NULL ORDER BY holder_id`)
    .all(writer)
    .map((row) => row.holder_id);

const placesSlim = (id: string) => ({
  id,
  placeId: 'native-chat',
  placeName: 'a chat',
  authorId: 'u1',
  authorName: 'Zoé',
  self: false,
  bot: false,
  content: 'Καλημέρα',
  ts: PLACES_NOW,
  replyToId: null,
  attachments: [],
  links: [],
  stickers: [],
  emojis: [],
  direct: false,
});

async function placesScene() {
  const mem = await openTestMemory({ iface: () => 'somewhere-else' });
  const read = (): Db => dbOf(wrongly<Parameters<typeof dbOf>[0]>(mem.memoryDb.readHandle()));
  return { mem, read };
}

test('the record of a place is written and read by its id, whatever interface is ambient', async () => {
  // Bug: the write made inside an event and the read made on a wake address two collections of one place.
  const { mem, read } = await placesScene();
  try {
    const record = createRecord({ dataDir: mem.dataDir, log: quiet, now: () => PLACES_NOW, memoryDb: mem.memoryDb });
    const appended = await withIface('telegram', () => record.append(PLACES_DM, [toRecordLine(placesSlim('m1'))]));
    assert.equal(appended.written, 1);
    const seen: Array<unknown> = [];
    for await (const line of record.iterate(PLACES_DM)) seen.push(Reflect.get(Object(line), 'messageId'));
    assert.equal(seen.length, 1);
    for await (const line of record.iterate(PLACES_OTHER))
      assert.fail(`read a line of another place: ${JSON.stringify(line)}`);
    assert.deepEqual(holdersOf(read(), 'sources', 'record'), [PLACES_DM]);
  } finally {
    await mem.close();
  }
});

// What a direct message leaves in the journal, the record, the archive and the meaning index reaches its partner alone. A
// journal line of a DM names only its chat (`scope: { channel }`) and carries no private mark, so every reader
// that branched on the mark falls through to the channel rule or to none. Each test seeds one synthetic secret word through
// the writer a turn uses, over the real service and database, then reads as another reader: a group turn, another
// partner's private turn, the persona's own wake. Where the answer could be empty for want of a row, an internal context
// checks first that the row exists, so an empty answer means refused and never means unwritten. The last group asserts
// the converse: the partner's own private turn still reads their own lines.

const dmJournalPrivacyQuiet = { info() {}, debug() {}, warn() {}, error() {} };
const DM_JOURNAL_PRIVACY_NOW = Date.UTC(2026, 10, 5, 12, 0, 0);
const SECRET = 'xylophonewhisper';
const LIKE = `%${SECRET}%`;

// A first-generation DM on the home authority: the place and the person are spelled from the native id.
const PARTNER = 'n1';
const PARTNER_ACCOUNT = 'discord:n1';
const PARTNER_PERSON = 'person:discord:n1';
const DM = 'discord:dm:n1';
const DM_CHAT = 'dm-chat-n1';
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
    log: dmJournalPrivacyQuiet,
    worker: false,
    iface: () => 'discord',
  });
  memoryDb.tick();
  opened.push(memoryDb);
  const read = (): Db => dbOf(wrongly<Parameters<typeof dbOf>[0]>(memoryDb.readHandle()));
  const journal = createJournal({ dataDir, memoryDb, now: () => DM_JOURNAL_PRIVACY_NOW, log: dmJournalPrivacyQuiet });
  const record = createRecord({ dataDir, memoryDb, now: () => DM_JOURNAL_PRIVACY_NOW, log: dmJournalPrivacyQuiet });
  const appendStore = createAppendStore({ fsyncMs: 0, log: dmJournalPrivacyQuiet });
  const archive = createArchive({
    appendStore,
    dataDir,
    memoryDb,
    now: () => DM_JOURNAL_PRIVACY_NOW,
    log: dmJournalPrivacyQuiet,
  });
  const vectors = createVectors({ dataDir, memoryDb, now: () => DM_JOURNAL_PRIVACY_NOW, log: dmJournalPrivacyQuiet });
  const store = createStore({ dataDir, archive, memoryDb });
  const contexts = {
    group: memoryDb.issueContext({ kind: 'group', iface: 'discord', destination: GROUP }),
    other: memoryDb.issueContext({ kind: 'dm', iface: 'discord', person: OTHER_PERSON, place: OTHER_DM }),
    partner: memoryDb.issueContext({ kind: 'dm', iface: 'discord', person: PARTNER_PERSON, place: DM }),
    stranger: memoryDb.issueContext({ kind: 'dm', iface: 'discord', person: STRANGER_PERSON, place: STRANGER_DM }),
  };
  return { dataDir, hot, memoryDb, read, journal, record, archive, vectors, store, contexts };
}
type World = ReturnType<typeof world>;

/** A record line of a chat: what a person said there. */
const lineSaid = (id: string, chat = DM_CHAT, by = PARTNER) =>
  toStoredLine(
    {
      id,
      placeId: chat,
      authorId: by,
      authorName: 'Partner',
      content: `the ${SECRET} plan`,
      ts: DM_JOURNAL_PRIVACY_NOW - 60_000,
    },
    { now: () => DM_JOURNAL_PRIVACY_NOW }
  );

/** Everything `search` hands a reader, as text. */
const searched = (w: World, ctx: unknown) =>
  JSON.stringify(
    search(w.read(), { ctx, plan: { forms: [SECRET], who: [], from: null, to: null }, now: DM_JOURNAL_PRIVACY_NOW })
  );

test('with context.memory.openPrivate on, a DM line keeps the DM audience and a group line the group audience', async () => {
  // Bug: the open mark leaks into a write, so a line said alone is stored where a group reads it as its own.
  const w = world();
  const { hot } = w;
  hot.config.context.memory.openPrivate = true;
  await w.record.append(DM, [lineSaid('m-dm')]);
  await w.record.append(GROUP, [lineSaid('m-group', GROUP)]);
  await settled();
  const audiences = w
    .read()
    .prepare('SELECT DISTINCT audience_id FROM sources WHERE text LIKE ? ORDER BY audience_id')
    .all(LIKE)
    .map((row) => row.audience_id);
  assert.deepEqual(audiences, [`aud:dm:${DM}`, 'aud:group:discord']);
});

test('a partner under another authority finds nothing of the DM of the same native id', async () => {
  // Bug: the record mapper writes the audience of `discord:dm:<native>`, the home authority partner's own audience.
  const w = world();
  await w.record.append(STRANGER_DM, [lineSaid('m-dm')]);
  await settled();
  assert.equal(searched(w, internalContext()).includes(SECRET), true);
  assert.equal(searched(w, w.contexts.partner).includes(SECRET), false);
});

test('a DM record line keeps the mark the meaning index and recall branch on', async () => {
  // Bug: `chunks.ts#layerOf` and `allowLine` read `scope.private`; a line written without it joins the place's layer.
  const w = world();
  await w.record.append(DM, [lineSaid('m-dm')]);
  await settled();
  const seen: Array<{ scope?: { private?: boolean; user?: string } }> = [];
  for await (const line of w.record.iterate(DM)) seen.push(wrongly(line));
  assert.deepEqual(
    seen.map((line) => [line.scope?.private, line.scope?.user]),
    [[true, PARTNER]]
  );
});

// One sent line, one `sources` row. The interface echoes the persona's own message to the core, the observation stores it under the
// key of its message family, and the record line of the same send (src/turn/journal-notes.ts#recordSaid and its siblings,
// all `record.append(placeId, [line], {})`) arrives with no descriptor, so it must find that family by itself.
// Synthetic data only.

const SAID_ROWS_SINGLE_NOW = Date.parse('2026-10-24T12:00:00.000Z');
const SENT = SAID_ROWS_SINGLE_NOW - 60_000;
const IFACE = 'synthetic';
const ROOT = 'root';
// The place that holds the record of the chat's tree, as the pipeline names it (src/memory/addresses.ts#sharedPlaceOf).
const TOP = topPlaceSpelled(IFACE, ROOT);
const ROOM = 'room-a';
const SELF_ID = 'her-account';
const WORDS = 'κουνέλι στον κήπο';

type Memory = Awaited<ReturnType<typeof openTestMemory>>;

/** The `message.received` event of a line: the persona's when `author` is their id, as the interface delivers their own echo. */
function lineEvent({
  id = 'sent-1',
  author = SELF_ID,
  at = SENT,
  text = WORDS,
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
    chat: { id: ROOM, kind: 'channel', chatType: 'channel', rootId: ROOT },
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

async function observeLine(memory: Memory, options: Parameters<typeof lineEvent>[0] = {}): Promise<string> {
  const envelope = observationOf(lineEvent(options), { selfId: SELF_ID });
  if (!envelope) throw new Error('the synthetic event was refused');
  const done = await memory.memoryDb.observeMessage(envelope, { placeId: TOP });
  if (!done || !('sourceId' in done) || typeof done.sourceId !== 'string')
    throw new Error('the observation was refused');
  return done.sourceId;
}

/** The record line of the persona's send, as recordSaid builds it, appended with no descriptor as every said writer does. */
async function recordSent(memory: Memory, { mentionedAccountIds = [] }: { mentionedAccountIds?: Array<string> } = {}) {
  const line = toStoredLine(
    { id: 'sent-1', placeId: ROOM, content: WORDS, ts: SENT, replyToId: null, mentionedAccountIds },
    { kind: 'said', now: () => SAID_ROWS_SINGLE_NOW, turnId: 't-1', opId: 'op-1' }
  );
  await createRecord({ ...memory, now: () => SAID_ROWS_SINGLE_NOW }).append(TOP, [line], {});
}

function database(memory: Memory): Db {
  const db = memory.memoryDb.database();
  if (!db) throw new Error('database unavailable');
  return db;
}

async function withEchoedLine(run: (memory: Memory, db: Db) => Promise<void> | void): Promise<void> {
  const memory = await openTestMemory({ now: () => SAID_ROWS_SINGLE_NOW, iface: () => IFACE });
  try {
    await observeLine(memory);
    await recordSent(memory);
    await run(memory, database(memory));
  } finally {
    await memory.close();
  }
}

test('the record lists the persona’s echoed line once under its protocol id', async () => {
  // Bug: every reader of the record (a chat read, the inner places, the heartbeat view) shows it twice.
  await withEchoedLine(async (memory) => {
    const lines: Array<{ kind?: unknown; messageId?: unknown }> = [];
    for await (const item of createRecord({ ...memory, now: () => SAID_ROWS_SINGLE_NOW }).iterate(TOP))
      lines.push(item);
    assert.deepEqual(
      lines.filter((line) => line.kind === 'said').map((line) => line.messageId),
      ['sent-1']
    );
  });
});
