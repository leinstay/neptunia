// Round trips of participation.js, recent.js and diary.js through the real schema.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as participation from '../src/memory/db/map/participation.js';
import * as recent from '../src/memory/db/map/recent.js';
import * as diary from '../src/memory/db/map/diary.js';
import { assertRoundTrip, roundTrip } from './fixtures/memory-db/roundtrip.js';

const message = (id, extra = {}) => ({
  id,
  ts: 1792000000000,
  authorId: '100000000000000001',
  name: 'Ada',
  self: false,
  text: 'Καλημέρα',
  replyTo: null,
  caption: null,
  ...extra,
});

const participationFile = () => ({
  nextId: 5,
  episodes: [
    {
      id: 'p-1',
      channelId: '200000000000000001',
      startAt: 1792000000000,
      lastAt: 1792000060000,
      lastOwnAt: 1792000050000,
      messages: [
        message('400000000000000001'),
        message('400000000000000002', { self: true, replyTo: '400000000000000001', caption: 'a cat' }),
      ],
      continues: null,
      itemId: 'ep-1',
    },
    {
      id: 'p-2',
      channelId: '200000000000000002',
      startAt: 1,
      lastAt: 2,
      lastOwnAt: 2,
      messages: [],
      continues: 'p-1',
      itemId: 'ep-2',
    },
  ],
});

test('participation: episodes of kind participation with the messages kept whole and their ids as sources', () => {
  const rows = assertRoundTrip(participation, 'participation.json', participationFile());
  assert.equal(rows.episodes.length, 2);
  const [first] = rows.episodes;
  assert.equal(first.id, 'ep-1');
  assert.equal(first.kind, 'participation');
  assert.equal(first.place_id, 'discord:channel:200000000000000001');
  assert.equal(first.start_ms, 1792000000000);
  assert.equal(first.last_ms, 1792000060000);
  assert.equal(first.scope_kind, 'group');
  assert.ok(JSON.parse(first.extra).messages[1].caption === 'a cat');
  assert.deepEqual(
    rows.episode_sources.map((row) => [row.episode_id, row.source_id, row.position]),
    [
      ['ep-1', 'src:discord:400000000000000001', 0],
      ['ep-1', 'src:discord:400000000000000002', 1],
    ]
  );
});

test('participation: an episode without itemId or with a repeated one still comes back as it was', () => {
  const file = participationFile();
  delete file.episodes[0].itemId;
  file.episodes[1].itemId = 'dup';
  file.episodes.push({ ...file.episodes[1] });
  assertRoundTrip(participation, 'participation.json', file);
  assertRoundTrip(participation, 'participation.json', { nextId: 1, episodes: [] });
  assertRoundTrip(participation, 'participation.json', { episodes: 'broken', other: [1] });
});

const recentFile = () => ({
  nextId: 3,
  lines: [
    {
      id: 1,
      at: 1792000000000,
      addedAt: '2026-10-20T10:00:00.000Z',
      channelId: '200000000000000001',
      text: 'café',
      who: ['100000000000000001'],
      weight: 0.5,
      itemId: 'rc-1',
    },
    { id: 2, at: 2, addedAt: 'x', channelId: '200000000000000001', text: '', who: [], weight: 1, itemId: 'rc-2' },
  ],
});

test('recent: lines become claims of kind recent_line under the channel', () => {
  const rows = assertRoundTrip(recent, 'recent.json', recentFile());
  const [claim] = rows.claims;
  assert.equal(claim.id, 'rc-1');
  assert.equal(claim.kind, 'recent_line');
  assert.equal(claim.subject_kind, 'place');
  assert.equal(claim.subject_id, 'discord:channel:200000000000000001');
  assert.equal(claim.text, 'café');
  assert.equal(claim.weight, 0.5);
  assert.equal(claim.created_at, '2026-10-20T10:00:00.000Z');
  assert.deepEqual(JSON.parse(claim.extra), { id: 1, at: 1792000000000, who: ['100000000000000001'] });
});

test('recent: lines without an itemId, empty files and odd shapes survive', () => {
  const file = recentFile();
  delete file.lines[0].itemId;
  assertRoundTrip(recent, 'recent.json', file);
  assertRoundTrip(recent, 'recent.json', { nextId: 1, lines: [] });
  assertRoundTrip(recent, 'recent.json', { lines: [1, 'x'] });
  assertRoundTrip(recent, 'recent.json', { lines: [{ channelId: 5, text: 7 }] });
});

const diaryFile = () => ({
  updatedAt: 1792000000000,
  posts: [
    {
      at: 1792000000000,
      kind: 'day',
      gist: 'a quiet day',
      picture: 'a lamp in the rain',
      messageIds: ['500000000000000001', '500000000000000002'],
      search: null,
      itemId: 'd-1',
      pictures: 1,
    },
    { at: 2, kind: 'night', gist: 'late', picture: null, messageIds: [], search: 'moths', itemId: 'd-2' },
  ],
});

test('diary: posts become diary rows and the message ids a mirror row', () => {
  const rows = assertRoundTrip(diary, 'diary.json', diaryFile());
  const [post] = rows.diary;
  assert.equal(post.id, 'd-1');
  assert.equal(post.at_ms, 1792000000000);
  assert.equal(post.gist, 'a quiet day');
  assert.equal(post.picture_prompt, 'a lamp in the rain');
  assert.equal(post.scope_kind, 'group');
  assert.deepEqual(JSON.parse(post.extra), { pictures: 1, $null: ['search'] });
  assert.deepEqual(JSON.parse(rows.diary_mirrors[0].native_ids), ['500000000000000001', '500000000000000002']);
  assert.equal(rows.diary_mirrors[0].iface, 'discord');
});

test('diary: absent, empty and odd message ids stay as they were', () => {
  const file = diaryFile();
  delete file.posts[1].messageIds;
  const { rows, back } = roundTrip(diary, 'diary.json', file);
  assert.equal(rows.diary_mirrors.length, 1);
  assert.ok(!Object.hasOwn(back.posts[1], 'messageIds'));
  assert.deepEqual(back, file);
  file.posts[0].messageIds = [1, 'x'];
  assertRoundTrip(diary, 'diary.json', file);
  assertRoundTrip(diary, 'diary.json', { posts: [] });
  assertRoundTrip(diary, 'diary.json', { posts: [{ gist: 5 }, { itemId: 'same' }, { itemId: 'same' }] });
});
