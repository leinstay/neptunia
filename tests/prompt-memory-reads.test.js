// The memory-read collector of src/behavior/prompt.js#buildRequest (`memoryReads`): what a request carried from
// memory, in the memory's own identity. Synthetic prompts, config and labels only (tests/fixtures/labels.js).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildRequest, userText as contentText } from '../src/behavior/prompt.js';
import { labels } from './fixtures/labels.js';

const NOW = Date.UTC(2026, 9, 10, 12, 0, 0);
const MIN = 60_000;
const HOUR = 60 * MIN;
const HERE = 'c1';

function config(features = {}) {
  return {
    bot: { timezone: 'Europe/Athens' },
    context: {
      gapMarkerMinutes: 20,
      maxMessageChars: 800,
      ageAfterMinutes: 60,
      caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000, server: 2500, lore: 1500, recent: 1200 },
      vision: { tokensPerImage: 400 },
      tempo: { liveMessages10min: 4, deadSilenceMinutes: 45 },
      askedAboutEpisodes: 3,
    },
    features: { relationships: true, episodes: true, lore: true, recent: true, participation: true, ...features },
    llm: { maxRequestTokens: 50000, safetyMargin: 0.9 },
    lore: { scanMessages: 30, maxMatches: 8 },
    memory: { recentHours: 72 },
    participation: { hours: 72, shown: 4, perChannel: 2, episodeChars: 1800 },
  };
}

const prompts = { 'system-prompt': 'S', 'character-card': 'C', rules: 'R', format: 'F', reply: 'Reply', interject: 'I', initiate: 'N', labels };
const line = (id, ts, extra = {}) => ({ id, ts, authorId: `a-${id}`, authorName: `User${id}`, self: false, content: `message ${id}`, attachments: [], stickers: [], replyToId: null, ...extra });

const profile = {
  id: 'u1',
  names: ['Ζωή'],
  interests: [{ topic: 'tango', note: '', weight: 3, itemId: 'in-1' }, { topic: 'no id', note: '', weight: 1 }],
  details: [{ id: 1, text: 'lives in Lyon', weight: 2, itemId: 'de-1' }],
  aliases: [{ name: 'Zo', weight: 1, itemId: 'al-1' }],
  episodes: [{ date: '2026-10-01', what: 'a long talk', quote: '', feeling: '', weight: 2, itemId: 'ep-1' }],
};

function request(overrides = {}) {
  const trigger = line('m1', NOW - MIN, { content: 'remember the flood?', authorId: 'u1' });
  return buildRequest({
    config: config(), prompts, calibrator: { ratio: 1, apply: (n) => n }, mode: 'reply', now: NOW, selfName: 'Nept',
    history: [trigger], neighbors: [], trigger, triggerKind: 'mention', guildMemory: {}, interlocutor: null, otherProfiles: [],
    channels: [{ id: HERE, name: 'general', purpose: 'chat' }, { id: 'c2', name: 'other' }], currentChannelId: HERE, ...overrides,
  });
}

const has = (reads, kind, id) => reads.some((read) => read.kind === kind && read.id === id);

test('memoryReads: the interlocutor profile items carry their itemIds, an item without one is left out', () => {
  const result = request({ interlocutor: profile });
  for (const [kind, id] of [['claim', 'in-1'], ['claim', 'de-1'], ['claim', 'al-1'], ['episode', 'ep-1']]) assert.ok(has(result.memoryReads, kind, id), `${kind} ${id}`);
  assert.equal(result.memoryReads.filter((read) => read.kind === 'claim').length, 3);
});

test('memoryReads: the channel notes, the guild notes and the lore entries the request kept', () => {
  const result = request({
    guildMemory: { patterns: 'short messages', starters: 'a greeting', injokes: ['a joke'] },
    loreEntries: [{ id: 'l1', title: 'The Great Flood', keys: ['flood'], text: 'It flooded once.', always: false, source: 'analyzer', weight: 3 }],
  });
  assert.ok(has(result.memoryReads, 'channel', HERE));
  assert.ok(has(result.memoryReads, 'guild_note', 'patterns'));
  assert.ok(has(result.memoryReads, 'guild_note', 'starters'));
  assert.ok(has(result.memoryReads, 'lore', 'l1'));
  assert.ok(!result.memoryReads.some((read) => read.kind === 'guild_note' && read.id === 'injokes'), 'a list without stable item ids is not recorded');
});

test('memoryReads: recent lines and moments, participation episodes, prefetched sources', () => {
  const stored = (id, ts, self) => ({ id, ts, authorId: self ? 'self' : 'u9', name: self ? 'Nept' : 'Ana', self, text: `line ${id}`, replyTo: null, caption: null });
  const result = request({
    channels: [{ id: HERE, name: 'general' }, { id: 'c2', name: 'journal' }],
    recentLines: [{ id: 1, at: NOW - HOUR, addedAt: new Date(NOW).toISOString(), channelId: HERE, text: 'a note', who: [], weight: 2, itemId: 'rc-1' }],
    participation: {
      state: { nextId: 5, episodes: [{ id: 'p1', itemId: 'pe-1', channelId: 'c2', continues: null, messages: [stored('a1', NOW - 2 * HOUR - MIN, false), stored('a2', NOW - 2 * HOUR, true)] }] },
      pickedIds: [], audience: () => true, channelName: () => null,
    },
    prefetch: {
      status: 'ok', basis: [],
      excerpts: [
        { source: 'memory', kind: 'detail', id: 'de-9', date: '2026-10-01', who: 'Ana', lines: 'lives in Lyon' },
        { source: 'history', id: 'm7', channelId: 'c2', channelName: 'journal', startTs: NOW - HOUR, hitIds: ['m7', 'm8'], lines: 'someone said something' },
      ],
    },
  });
  assert.ok(has(result.memoryReads, 'recent_line', 'rc-1'));
  assert.ok(has(result.memoryReads, 'participation', 'pe-1'));
  assert.ok(has(result.memoryReads, 'item', 'de-9'));
  assert.ok(has(result.memoryReads, 'source', 'm7') && has(result.memoryReads, 'source', 'm8'));
});

test('memoryReads: a profile the budget dropped is not recorded, and nothing is recorded twice', () => {
  const crowded = request({ interlocutor: profile, config: { ...config(), context: { ...config().context, caps: { ...config().context.caps, interlocutor: 1 } } } });
  assert.deepEqual(crowded.memoryReads.filter((read) => read.kind === 'claim' || read.kind === 'episode'), []);
  const result = request({ interlocutor: profile, otherProfiles: [profile] });
  const keys = result.memoryReads.map((read) => `${read.kind}:${read.id}`);
  assert.equal(new Set(keys).size, keys.length);
});

test('memoryReads: collecting changes no rendered text', () => {
  const plain = contentText(request({ interlocutor: profile }).messages[1].content);
  const again = contentText(request({ interlocutor: { ...profile, interests: profile.interests.map((item) => ({ ...item, itemId: undefined })) } }).messages[1].content);
  assert.equal(plain, again);
});

test('memoryReads: each read names the block it sat in and its place in the request, following the order of the blocks in the content', () => {
  const stored = (id, ts, self) => ({ id, ts, authorId: self ? 'self' : 'u9', name: self ? 'Nept' : 'Ana', self, text: `line ${id}`, replyTo: null, caption: null });
  const result = request({
    interlocutor: profile,
    guildMemory: { patterns: 'short messages' },
    loreEntries: [{ id: 'l1', title: 'The Great Flood', keys: ['flood'], text: 'It flooded once.', always: false, source: 'analyzer', weight: 3 }],
    channels: [{ id: HERE, name: 'general' }, { id: 'c2', name: 'journal' }],
    recentLines: [{ id: 1, at: NOW - HOUR, addedAt: new Date(NOW).toISOString(), channelId: HERE, text: 'a note', who: [], weight: 2, itemId: 'rc-1' }],
    participation: {
      state: { nextId: 5, episodes: [{ id: 'p1', itemId: 'pe-1', channelId: 'c2', continues: null, messages: [stored('a1', NOW - 2 * HOUR - MIN, false), stored('a2', NOW - 2 * HOUR, true)] }] },
      pickedIds: [], audience: () => true, channelName: () => null,
    },
    prefetch: {
      status: 'ok', basis: [],
      excerpts: [{ source: 'memory', kind: 'detail', id: 'de-9', date: '2026-10-01', who: 'Ana', lines: 'lives in Lyon' }],
    },
  });
  const reads = result.memoryReads;
  assert.deepEqual(reads.map((read) => read.ord), reads.map((_, index) => index), 'a place in the request for each read, from 0');
  const blockOf = (kind, id) => reads.find((read) => read.kind === kind && read.id === id)?.block;
  assert.equal(blockOf('claim', 'in-1'), 'people');
  assert.equal(blockOf('episode', 'ep-1'), 'people');
  assert.equal(blockOf('guild_note', 'patterns'), 'about_chat');
  assert.equal(blockOf('lore', 'l1'), 'lore');
  assert.equal(blockOf('recent_line', 'rc-1'), 'recent');
  assert.equal(blockOf('participation', 'pe-1'), 'participation');
  assert.equal(blockOf('item', 'de-9'), 'retrieved');
  const text = contentText(result.messages[1].content);
  const at = reads.map((read) => text.indexOf(`<${read.block}>`));
  assert.ok(at.every((position) => position >= 0), `every block is in the content: ${reads.map((read) => read.block)}`);
  assert.deepEqual(at, [...at].sort((a, b) => a - b), 'the reads follow the order of their blocks in the content');
});
