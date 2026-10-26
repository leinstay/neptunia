// Tests for src/memory/record.js: the record of every observed message, the persona's own lines
// and her feelings, written to the memory database of a temporary directory (never the
// deployment's data/).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { RECORD_LINKS_MAX, appendRevision, createRecord, recordLinks, toRecordLine } from '../src/memory/record.js';
import { newestRevisions } from '../src/memory/chunks.js';
import { normalizeMessage } from '../src/interface/discord.js';
import { slimMessage } from '../src/memory/update.js';
import { openTestMemory, unitFile } from './fixtures/memory-db/service.js';

const quiet = { info() {}, warn() {}, error() {} };
const T1 = Date.UTC(2026, 9, 11, 11, 55, 51, 568);
const T2 = Date.UTC(2026, 9, 12, 8, 0, 0);
const NOW = Date.UTC(2026, 9, 13, 9, 0, 0);

function counter(prefix) {
  let n = 0;
  return () => `${prefix}${(n += 1)}`;
}

function slim(overrides = {}) {
  return {
    id: 'm1',
    channelId: 'c1',
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

async function scene() {
  const mem = await openTestMemory();
  const dataDir = mem.dataDir;
  const record = createRecord({ dataDir, log: quiet, now: () => NOW, memoryDb: mem.memoryDb });
  const done = async () => {
    await mem.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  };
  return { dataDir, record, memoryDb: mem.memoryDb, done };
}

/** The lines the database holds for the record unit `rel` (a day of a month). */
function unitLines(memoryDb, rel) {
  const text = unitFile(memoryDb, rel);
  return text
    ? text
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
    : [];
}

async function collect(iterable) {
  const out = [];
  for await (const item of iterable) out.push(item);
  return out;
}

const OCTOBER = { from: '2026-10-01T00:00:00.000Z', to: '2026-10-31T23:59:59.999Z' };

test('record: toRecordLine keeps only the whitelisted fields and lists participants', () => {
  const line = toRecordLine(
    slim({
      replyToId: 'm0',
      replyToAuthorId: 'u3',
      mentionedUserIds: ['u2'],
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
    guildId: null,
    scope: { channel: 'c1' },
    by: 'u1',
    replyTo: 'm0',
    text: 'Καλημέρα',
    media: ['image', 'gif', 'sticker'],
    mentions: ['u2'],
    direct: true,
    participants: ['u1', 'u2', 'u3'],
    sourceMessageIds: ['m1'],
    origin: 'live',
  });
  assert.equal(JSON.stringify(line).includes('https://'), false, 'no URL survives');

  const said = toRecordLine(
    slim({ authorId: 'self1', mentionedUserIds: ['u2'], replyToId: 'm0', replyToAuthorId: 'u3' }),
    {
      kind: 'said',
      turnId: 't-1',
      opId: 'op-1',
      now: () => NOW,
      uuid: () => 'u-2',
    }
  );
  assert.equal(said.kind, 'said');
  assert.equal('by' in said, false, 'her own line names no author');
  assert.deepEqual(said.participants, ['u2', 'u3']);
  assert.equal(said.turnId, 't-1');
  assert.equal(said.opId, 'op-1');

  const deleted = toRecordLine(
    { id: 'm1', channelId: 'c1', authorId: 'u1', ts: T2 },
    { kind: 'deleted', now: () => NOW, uuid: () => 'u-3' }
  );
  assert.deepEqual(
    Object.keys(deleted).sort(),
    [
      'guildId',
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
    channelId: 'c1',
    channel: { name: 'général' },
    author: { id: 'u1', bot: false, username: 'zoe' },
    cleanContent: 'κοίτα https://video.example/watch?v=1',
    content: 'κοίτα https://video.example/watch?v=1',
    createdTimestamp: T1,
    embeds,
  };
  const line = toRecordLine(slimMessage(normalizeMessage(message, 'self1')), { now: () => NOW, uuid: () => 'u-1' });
  assert.equal(line.links.length, RECORD_LINKS_MAX, 'at most three links');
  assert.deepEqual(
    line.links.map((l) => l.title),
    ['Course de montagne épique', 'Deuxième', 'Troisième'],
    'a GIF and an embed with nothing to say are skipped'
  );
  const [first] = line.links;
  assert.equal(first.url, 'https://video.example/watch?v=1');
  assert.equal(first.site, 'VideoSite');
  assert.ok([...first.description].length <= 200, 'the description is clamped');
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

test('record: append writes to the day of occurredAt under the month directory and refuses a duplicate messageId+revision', async () => {
  const { dataDir, record, memoryDb, done } = await scene();
  const first = await record.append('g1', [
    toRecordLine(slim({ id: 'm1', ts: T1 })),
    toRecordLine(slim({ id: 'm2', ts: T2 })),
  ]);
  assert.deepEqual(first, { written: 2, duplicates: 0 });
  const again = await record.append('g1', [toRecordLine(slim({ id: 'm1', ts: T1 }))]);
  assert.deepEqual(again, { written: 0, duplicates: 1 });

  const file1 = path.join(dataDir, 'guilds', 'g1', 'record', '2026-10', '2026-10-11.jsonl');
  const file2 = path.join(dataDir, 'guilds', 'g1', 'record', '2026-10', '2026-10-12.jsonl');
  assert.equal(record.dayFile('g1', new Date(T1).toISOString()), file1);
  const day1 = unitLines(memoryDb, 'guilds/g1/record/2026-10/2026-10-11.jsonl');
  assert.equal(day1.length, 1);
  assert.equal(day1[0].messageId, 'm1');
  assert.equal(day1[0].guildId, 'g1', 'the guild is stamped on append');
  assert.deepEqual(
    unitLines(memoryDb, 'guilds/g1/record/2026-10/2026-10-12.jsonl').map((l) => l.messageId),
    ['m2']
  );
  assert.equal(fs.existsSync(file1), false, 'no record file');

  // A fresh instance reads the database and still refuses the duplicate.
  const reopened = createRecord({ dataDir, log: quiet, now: () => NOW, memoryDb });
  assert.deepEqual(await reopened.append('g1', [toRecordLine(slim({ id: 'm2', ts: T2 }))]), {
    written: 0,
    duplicates: 1,
  });
  await done();
});

test('record: an edit is a new line with revision 2', async () => {
  const { dataDir, record, memoryDb, done } = await scene();
  await record.append('g1', [toRecordLine(slim({ content: 'first' }))]);
  const edit = await record.append('g1', [toRecordLine(slim({ content: 'second' }), { revision: 2 })]);
  assert.deepEqual(edit, { written: 1, duplicates: 0 });
  const lines = await collect(record.iterate('g1', OCTOBER));
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
  await record.append('g1', [
    toRecordLine(slim({ id: 'm1', ts: T1, channelId: 'c1' })),
    toRecordLine(slim({ id: 'm2', ts: T2, channelId: 'c2' })),
    toRecordLine(slim({ id: 'm3', ts: T2 + 1000, channelId: 'c1' })),
  ]);
  const lines = await collect(
    record.iterate('g1', { from: new Date(T2).toISOString(), to: new Date(NOW).toISOString(), channelIds: ['c1'] })
  );
  assert.deepEqual(
    lines.map((l) => l.messageId),
    ['m3']
  );
  await done();
});

test('record: a private line never lands in the guild directory', async () => {
  const { dataDir, record, memoryDb, done } = await scene();
  const result = await record.append('g1', [toRecordLine(slim({ id: 'd1', channelId: 'dm1' }))], {
    privateUserId: 'u1',
  });
  assert.deepEqual(result, { written: 1, duplicates: 0 });
  const privateFile = path.join(dataDir, 'guilds', 'g1', 'private', 'u1', 'record', '2026-10', '2026-10-11.jsonl');
  assert.equal(record.dayFile('g1', new Date(T1).toISOString(), 'u1'), privateFile);
  const [line] = unitLines(memoryDb, 'guilds/g1/private/u1/record/2026-10/2026-10-11.jsonl');
  assert.equal(line.messageId, 'd1');
  assert.deepEqual(line.scope, { user: 'u1', private: true, channel: 'dm1' });
  assert.equal(unitFile(memoryDb, 'guilds/g1/record/2026-10/2026-10-11.jsonl'), null, 'nothing in the guild record');
  assert.deepEqual(
    (await collect(record.iterate('g1', { ...OCTOBER, privateUserId: 'u1' }))).map((l) => l.messageId),
    ['d1']
  );
  assert.deepEqual(await collect(record.iterate('g1', OCTOBER)), []);
  await done();
});

test('record: an edit refused as a duplicate revision lands after the newest one the index holds', async () => {
  const { dataDir, record, memoryDb, done } = await scene();
  const logs = [];
  const log = { info: (msg, fields) => logs.push({ msg, fields }), warn() {}, error() {} };
  await record.append('g1', [toRecordLine(slim({ content: 'first' }))]);
  // Revision 2 is written already; the bot restarts and an edit comes in.
  await record.append('g1', [
    {
      ...toRecordLine(slim({ content: 'first' }), { revision: 2 }),
      links: [{ url: 'https://example.org', title: 'Τίτλος', description: '', site: 'example.org' }],
    },
  ]);
  const reopened = createRecord({ dataDir, log: quiet, now: () => NOW, memoryDb });
  assert.equal(await reopened.newestRevision('g1', 'm1', new Date(T1).toISOString()), 2);
  assert.equal(await reopened.newestRevision('g1', 'm9', new Date(T1).toISOString()), null);
  const edited = slim({ content: 'edited' });
  const out = await appendRevision(
    reopened,
    'g1',
    (revision) => toRecordLine(edited, { revision, now: () => NOW }),
    2,
    { log }
  );
  assert.deepEqual(out, { revision: 3, written: 1, duplicates: 0, bumps: 1 });
  assert.deepEqual(
    logs,
    [{ msg: 'record: edit revision bumped', fields: { guildId: 'g1', bumps: 1, written: 1 } }],
    'counts only'
  );
  const lines = await collect(reopened.iterate('g1', OCTOBER));
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
