// Round trips of src/memory/db/map/channel.js, guild.js and lore.js: the server map, the guild file and the lorebook <-> rows.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as channel from '../src/memory/db/map/channel.js';
import * as guild from '../src/memory/db/map/guild.js';
import * as lore from '../src/memory/db/map/lore.js';
import { assertRoundTrip, generated, plain, roundTrip } from './fixtures/memory-db/roundtrip.js';
import { openMemoryDb } from '../src/memory/db/open.js';
import { insertRows } from '../src/memory/db/rows.js';
import { reproject } from '../src/memory/db/graph.js';
import { tableHashes } from '../tools/memory-db.mjs';

const GUILD = '300000000000000001';
const CTX = { guildId: GUILD };
const CHANNEL_ID = '200000000000000001';

const channelFile = () => ({
  id: CHANNEL_ID,
  name: 'général',
  category: 'Chat',
  topic: null,
  purpose: 'Everyday talk.',
  topics: 'games, food',
  tone: 'relaxed',
  days: { '2026-10-01': 12, '2026-10-02': 3 },
  messageCount: 15,
  firstMessageAt: 1759300000000,
  lastMessageAt: null,
  topWriters: [{ id: '100000000000000001', count: 9 }],
  updatedAt: '2026-10-02T00:00:00.000Z',
  writers: { '100000000000000001': { count: 9, last: 1759400000000 } },
  notesCheckedAt: null,
  notesFlaggedAt: '2026-10-01T00:00:00.000Z',
  notesAttemptAt: null,
});

test('a channel entry becomes a place, three descriptions and an operational row', () => {
  const rows = assertRoundTrip(channel, `channels/${CHANNEL_ID}.json`, channelFile(), CTX);
  const [place] = rows.places;
  assert.deepEqual(
    [place.id, place.kind, place.native_id, place.parent_id, place.scope_kind, place.name, place.category, place.topic],
    [`discord:channel:${CHANNEL_ID}`, 'channel', CHANNEL_ID, `discord:guild:${GUILD}`, 'group', 'général', 'Chat', null]
  );
  assert.deepEqual(
    rows.descriptions.map((d) => d.field),
    ['purpose', 'topics', 'tone']
  );
  for (const description of rows.descriptions) {
    assert.equal(description.subject_kind, 'place');
    assert.equal(description.subject_id, place.id);
    assert.equal(description.scope_kind, 'group');
  }
  assert.equal(rows.description_versions.find((v) => v.description_id.endsWith(':tone')).text, 'relaxed');
  const operational = JSON.parse(rows.operational[0].value);
  assert.equal(operational.messageCount, 15);
  assert.deepEqual(operational.days, { '2026-10-01': 12, '2026-10-02': 3 });
  assert.ok(!('purpose' in operational));
});

test('a channel with a topic text, with missing fields, or with a non-text purpose', () => {
  const withTopic = { ...channelFile(), topic: 'weekly thread' };
  assert.equal(roundTrip(channel, `channels/${CHANNEL_ID}.json`, withTopic, CTX).rows.places[0].topic, 'weekly thread');
  for (const value of [
    withTopic,
    { id: CHANNEL_ID },
    { id: CHANNEL_ID, purpose: '', topics: '', tone: '' },
    { id: CHANNEL_ID, purpose: 4, tone: null },
    { name: 'x' },
  ]) {
    assert.deepEqual(roundTrip(channel, `channels/${CHANNEL_ID}.json`, value, CTX).back, value, JSON.stringify(value));
  }
});

test('a channel with no guild id in the context has no parent', () => {
  assert.equal(roundTrip(channel, `channels/${CHANNEL_ID}.json`, channelFile()).rows.places[0].parent_id, null);
});

test('the generated fixtures with every key path of the live channel files round trip', () => {
  for (const [index, value] of generated('channel').entries()) {
    assertRoundTrip(channel, `channels/${index}.json`, plain(value), CTX, `generated channel ${index}`);
  }
});

const guildFile = () => ({
  patterns: 'Speaks in short bursts.',
  starters: 'Hey, what are we on about?',
  injokes: ['the lamp incident', 'Πέμπτη'],
  self: ['likes rain', 'is a night owl'],
  updatedAt: '2026-10-01T00:00:00.000Z',
  learnedNextId: 3,
  learned: [
    {
      id: 1,
      text: 'the bridge is closed',
      weight: 2,
      firstSeen: '2026-09-01',
      lastSeen: '2026-09-02',
      from: '<@100000000000000001>',
      itemId: 'ln-1',
    },
    {
      id: 2,
      text: 'dinner is at eight',
      weight: 1,
      firstSeen: '2026-09-03',
      lastSeen: '2026-09-03',
      from: 'the owner',
      itemId: 'ln-2',
    },
    { id: 3, text: 'no source named', weight: 1, firstSeen: 'a', lastSeen: 'b' },
  ],
  emojiUsage: { '500000000000000001': { name: 'smile', count: 3, last: 1759400000000 } },
  emojiBackfill: { at: '2026-09-01T00:00:00.000Z', channels: 4, messages: 100 },
  notesUpdatedAt: '2026-10-01T00:00:00.000Z',
  notesCheckedAt: '2026-10-02T00:00:00.000Z',
  notesAttemptAt: null,
  pingsOff: ['100000000000000002'],
  accessMigrated: 1,
});

test('the guild file becomes a place, descriptions, claims of three kinds and an operational row', () => {
  const rows = assertRoundTrip(guild, 'guild.json', guildFile(), CTX);
  assert.deepEqual(
    [rows.places[0].id, rows.places[0].kind, rows.places[0].native_id],
    [`discord:guild:${GUILD}`, 'guild', GUILD]
  );
  assert.deepEqual(
    rows.descriptions.map((d) => d.field),
    ['patterns', 'starters']
  );
  const kinds = rows.claims.map((c) => c.kind);
  assert.deepEqual(kinds, ['injoke', 'injoke', 'self_fact', 'self_fact', 'lesson', 'lesson', 'lesson']);
  const selfFacts = rows.claims.filter((c) => c.kind === 'self_fact');
  for (const fact of selfFacts)
    assert.deepEqual([fact.subject_kind, fact.subject_id, fact.scope_kind], ['self', 'person:self', 'none']);
  for (const joke of rows.claims.filter((c) => c.kind === 'injoke'))
    assert.deepEqual([joke.subject_kind, joke.scope_kind], ['place', 'group']);
  const lessons = rows.claims.filter((c) => c.kind === 'lesson');
  assert.deepEqual(
    lessons.map((l) => l.id.slice(0, 5)),
    ['ln-1', 'ln-2', 'lesso']
  );
  assert.deepEqual(
    lessons.map((l) => l.how),
    ['taught', 'taught', 'taught']
  );
  assert.equal(lessons[0].from_person, 'person:discord:100000000000000001');
  assert.equal(lessons[1].from_person, null, 'a teacher that is not a mention token stays in extra');
  assert.equal(JSON.parse(lessons[1].extra).from, 'the owner');
  const operational = JSON.parse(rows.operational[0].value);
  assert.equal(operational.learnedNextId, 3);
  assert.deepEqual(operational.pingsOff, ['100000000000000002']);
  assert.ok(!('learned' in operational));
});

test('guild lists: absent stay absent, empty stay empty, odd ones stay whole', () => {
  for (const value of [
    {},
    { injokes: [], self: [], learned: [] },
    { injokes: [1, 2], self: 'x', learned: [{ id: 1 }, 'y'] },
    { patterns: '', starters: 4 },
    {
      learned: [
        { id: 1, text: 't', from: '<@123>' },
        { id: 1, text: 't', from: '<@123>' },
      ],
    },
  ]) {
    assert.deepEqual(roundTrip(guild, 'guild.json', value, CTX).back, value, JSON.stringify(value));
  }
});

test('a repeated in-joke keeps both entries', () => {
  const value = { injokes: ['same', 'same', 'same'] };
  const { rows, back } = roundTrip(guild, 'guild.json', value, CTX);
  assert.equal(new Set(rows.claims.map((c) => c.id)).size, 3);
  assert.deepEqual(back, value);
});

test('the generated fixtures with every key path of the live guild file round trip', () => {
  for (const [index, value] of generated('guild').entries()) {
    assertRoundTrip(guild, 'guild.json', plain(value), CTX, `generated guild ${index}`);
  }
});

const loreFile = () => [
  {
    id: 'harbour-9f8e7d6c5b4a',
    title: 'The harbour',
    keys: ['harbour', 'port', 'λιμάνι'],
    text: 'Where the boats sleep.',
    always: false,
    source: 'owner',
    weight: 2,
    createdAt: '2026-09-01T00:00:00.000Z',
    updatedAt: '2026-10-01T00:00:00.000Z',
  },
  {
    id: '715474998364',
    title: '715474998364',
    keys: [],
    text: 'A number as a name.',
    always: true,
    source: 'analyzer',
    weight: 1,
    createdAt: 'a',
    updatedAt: 'b',
  },
];

test('lore entries become lore claims about the guild, the source is the author', () => {
  const rows = assertRoundTrip(lore, 'lore.json', loreFile(), CTX);
  assert.equal(rows.claims.length, 2);
  const [first, second] = rows.claims;
  assert.deepEqual(
    [
      first.id,
      first.kind,
      first.subject_kind,
      first.subject_id,
      first.text,
      first.weight,
      first.author,
      first.first_seen_at,
      first.last_seen_at,
      first.scope_kind,
      first.position,
    ],
    [
      'lore:harbour-9f8e7d6c5b4a',
      'lore',
      'place',
      `discord:guild:${GUILD}`,
      'Where the boats sleep.',
      2,
      'owner',
      '2026-09-01T00:00:00.000Z',
      '2026-10-01T00:00:00.000Z',
      'group',
      0,
    ]
  );
  assert.equal(second.author, 'analyzer');
  const extra = JSON.parse(first.extra);
  assert.deepEqual(Object.keys(extra).sort(), ['always', 'keys', 'title']);
});

test('an empty lorebook, odd ids and repeated ids come back as they were', () => {
  for (const value of [
    [],
    [{ title: 'no id' }],
    [{ id: '', title: 'empty id' }],
    [{ id: 5, title: 'number id' }],
    [
      { id: 'a', title: '1' },
      { id: 'a', title: '2' },
    ],
  ]) {
    assert.deepEqual(roundTrip(lore, 'lore.json', value, CTX).back, value, JSON.stringify(value));
  }
});

test('the generated fixtures with every key path of the live lorebook round trip', () => {
  for (const [index, value] of generated('lore').entries()) {
    assertRoundTrip(lore, 'lore.json', plain(value), CTX, `generated lore ${index}`);
  }
});

// Schema v9: the sync writes units in no guaranteed order, and a projection never fails the typed write.
test('graph: a channel written before its guild and a membership before its account keep their edges; a rolled-back write leaves nothing behind', () => {
  const handle = openMemoryDb(':memory:');
  const { db } = handle;
  const quiet = { warn() {} };
  const node = (id) => db.prepare('SELECT kind, row_id, created_at FROM graph_nodes WHERE id = ?').get(id);
  const graph = () =>
    Object.fromEntries(
      tableHashes(db, ['graph_nodes', 'graph_edges', 'node_access']).map((entry) => [entry.table, entry.hash])
    );
  try {
    // A write rolled back on the same connection: the next one does not trust a row that went with it.
    for (let i = 0; i < 2; i += 1) {
      db.exec('BEGIN');
      insertRows(
        db,
        {
          places: [
            {
              id: 'telegram:channel:x',
              iface: 'telegram',
              kind: 'channel',
              native_id: 'x',
              parent_id: 'telegram:guild:y',
              scope_kind: 'group',
            },
          ],
        },
        { log: quiet }
      );
      db.exec('ROLLBACK');
    }
    insertRows(
      db,
      {
        places: [
          {
            id: 'discord:channel:c1',
            iface: 'discord',
            kind: 'channel',
            native_id: 'c1',
            parent_id: 'discord:guild:g1',
            scope_kind: 'group',
          },
        ],
      },
      { log: quiet }
    );
    assert.deepEqual(
      { ...node('place:discord:guild:g1') },
      { kind: 'place', row_id: 'discord:guild:g1', created_at: '1970-01-01T00:00:00.000Z' },
      'the missing guild is a placeholder node'
    );
    assert.equal(
      db.prepare("SELECT COUNT(*) AS n FROM graph_edges WHERE predicate = 'contained_in' AND retired_at IS NULL").get()
        .n,
      1,
      'the edge is kept'
    );
    insertRows(
      db,
      {
        places: [
          {
            id: 'discord:guild:g1',
            iface: 'discord',
            kind: 'guild',
            native_id: 'g1',
            parent_id: null,
            scope_kind: 'group',
            seen_from_at: '2026-10-01T00:00:00.000Z',
          },
        ],
        memberships: [
          {
            id: 'm:1',
            account_id: 'discord:u1',
            place_id: 'discord:guild:g1',
            valid_from_at: '2026-10-02T00:00:00.000Z',
          },
        ],
      },
      { log: quiet }
    );
    assert.equal(
      node('place:discord:guild:g1').created_at,
      '2026-10-01T00:00:00.000Z',
      'the guild row fills its node in'
    );
    assert.equal(
      node('account:discord:u1').created_at,
      '1970-01-01T00:00:00.000Z',
      'the account a membership names before it arrives'
    );
    insertRows(db, { accounts: [{ id: 'discord:u1', iface: 'discord', native_id: 'u1' }] }, { log: quiet });
    assert.equal(
      db
        .prepare("SELECT COUNT(*) AS n FROM graph_nodes WHERE id IN ('place:discord:guild:g1', 'account:discord:u1')")
        .get().n,
      2,
      'one node each, not two'
    );
    assert.equal(
      db
        .prepare(
          "SELECT COUNT(*) AS n FROM graph_edges WHERE predicate IN ('has_membership', 'membership_in') AND retired_at IS NULL"
        )
        .get().n,
      2
    );
    assert.deepEqual(db.prepare('PRAGMA foreign_key_check').all(), []);
    assert.equal(db.prepare("SELECT COUNT(*) AS n FROM meta WHERE key = 'graph_pending'").get().n, 0, 'nothing failed');
    const before = graph();
    reproject(handle);
    assert.deepEqual(graph(), before, 'whatever the order, the writers left what a re-projection makes');
  } finally {
    handle.close();
  }
});
