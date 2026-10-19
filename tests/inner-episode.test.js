// Tests for the persona's inner-turn episodes in her memory (src/memory/inner-episode.js and
// src/memory/update.js#observeInner; docs/inner-life.md, "What she found goes to her memory"):
// what her reads found and her thinks become lines of hers in the memory buffer, worded only by
// labels, marked `inner` (shadow or not), a private chat's in that member's private buffer only;
// the analyzer batch reads them like her other lines, and the record (the chat) never gets them.
// Over a real store in a temp dir and a fake LLM; no network, no data/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createStore } from '../src/memory/store.js';
import { createMemoryUpdater } from '../src/memory/update.js';
import { createCalibrator } from '../src/llm/tokens.js';
import { innerEpisodeLines, innerMemorySettings, linksOf, tailChars } from '../src/memory/inner-episode.js';
import { fill } from '../src/format.js';
import { labels } from './fixtures/labels.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';
import { tempDir } from './fixtures/tmp.js';

const AT = Date.parse('2026-10-19T03:47:00Z');
const SETTINGS = { enabled: true, thinkChars: 200, resultChars: 300, maxFindings: 3, maxSources: 4, skills: ['web.search', 'web.read', 'memory.search'] };

function episode(overrides = {}) {
  return {
    turnId: 't-1',
    at: AT,
    shadow: true,
    channelId: 'c1',
    channelName: 'general',
    privateUserId: null,
    selfId: 'self-id',
    selfName: 'Bot',
    thinks: ['Ας δω τι λέει ο κόσμος για το παιχνίδι.'],
    findings: [
      { skill: 'web.search', args: { query: 'παιχνίδι κόσμος όνομα' }, text: 'Results:\n1. Ο κόσμος λέγεται Φάσμα https://example.org/world. More at https://example.org/wiki' },
      { skill: 'lore.list', args: {}, text: 'three entries' },
    ],
    actions: [
      { skill: 'diary.post', status: 'refused' },
      { skill: 'message.create', status: 'proposed' },
    ],
    ...overrides,
  };
}

test('innerMemorySettings: a test sets its values; a bad one takes the default; only false turns it off', () => {
  const set = innerMemorySettings({ innerLife: { memory: { enabled: false, thinkChars: 50, resultChars: -1, maxFindings: 2, maxSources: 'x', skills: ['web.read', 7] } } });
  assert.equal(set.enabled, false);
  assert.equal(set.thinkChars, 50);
  assert.equal(set.maxFindings, 2);
  assert.deepEqual(set.skills, ['web.read']);
  assert.ok(set.resultChars > 0 && set.maxSources > 0, 'bad values take a positive default');
  assert.equal(innerMemorySettings({ innerLife: { memory: { enabled: 'no' } } }).enabled, true);
});

test('linksOf and tailChars: distinct links in order without trailing punctuation; the end of a long think kept', () => {
  assert.deepEqual(linksOf(['see https://a.example/x. and https://b.example/y, then https://a.example/x', null, 'https://c.example/z'], 2), ['https://a.example/x', 'https://b.example/y']);
  assert.equal(tailChars('σύντομο', 100), 'σύντομο');
  const long = `${'αρχή '.repeat(40)}τέλος της σκέψης`;
  const tail = tailChars(long, 30);
  assert.ok(tail.startsWith('…'), tail);
  assert.ok(tail.endsWith('τέλος της σκέψης'));
  assert.ok(Array.from(tail).length <= 30);
});

test('innerEpisodeLines: her thinks and calls first, then one line per kept finding with its links; all hers, marked inner and shadow', () => {
  const lines = innerEpisodeLines(episode(), { labels, settings: SETTINGS, maxChars: 2000 });
  assert.equal(lines.length, 2, 'the head line and the web.search finding; lore.list is not a kept skill');
  for (const line of lines) {
    assert.equal(line.self, true);
    assert.equal(line.authorId, 'self-id');
    assert.equal(line.channelId, 'c1');
    assert.equal(line.inner.kind, 'inner');
    assert.equal(line.inner.shadow, true);
    assert.equal(line.inner.turnId, 't-1');
  }
  assert.deepEqual(lines.map((line) => line.ts), [AT, AT + 1]);
  assert.equal(new Set(lines.map((line) => line.id)).size, 2);
  const head = lines[0].content;
  assert.ok(head.includes(fill(labels.memory.inner.think, { text: 'Ας δω τι λέει ο κόσμος για το παιχνίδι.' })), head);
  assert.ok(head.includes(fill(labels.memory.inner.notDone, { skills: 'diary.post, message.create' })), 'proposed and refused calls are not done');
  assert.ok(!head.split('\n').some((line) => line.startsWith(labels.memory.inner.done.split('{')[0])), 'nothing was done');
  const found = lines[1].content;
  assert.ok(found.startsWith(fill(labels.memory.inner.found, { skill: 'web.search', asked: fill(labels.memory.inner.asked, { text: 'παιχνίδι κόσμος όνομα' }), text: '' }).trim()), found);
  assert.ok(found.includes('Ο κόσμος λέγεται Φάσμα'));
  assert.deepEqual(lines[1].inner.sources, ['https://example.org/world', 'https://example.org/wiki']);
  assert.ok(found.includes(fill(labels.memory.inner.sources, { links: 'https://example.org/world https://example.org/wiki' })));
});

test('innerEpisodeLines: a live call that ran is done; nothing without a kept finding, switched off, or without the found label', () => {
  const live = innerEpisodeLines(episode({ shadow: false, thinks: [], actions: [{ skill: 'message.create', status: 'executed' }] }), { labels, settings: SETTINGS });
  assert.equal(live[0].inner.shadow, false);
  assert.equal(live[0].content, fill(labels.memory.inner.done, { skills: 'message.create' }));
  const bare = innerEpisodeLines(episode({ thinks: [], actions: [] }), { labels, settings: SETTINGS });
  assert.equal(bare.length, 1, 'no head line when there is nothing to say in it');
  assert.deepEqual(innerEpisodeLines(episode({ findings: [{ skill: 'lore.list', args: {}, text: 'x' }] }), { labels, settings: SETTINGS }), []);
  assert.deepEqual(innerEpisodeLines(episode(), { labels, settings: { ...SETTINGS, enabled: false } }), []);
  assert.deepEqual(innerEpisodeLines(episode(), { labels: { ...labels, memory: { ...labels.memory, inner: { ...labels.memory.inner, found: '' } } }, settings: SETTINGS }), []);
  const cut = innerEpisodeLines(episode({ findings: [{ skill: 'web.read', args: { url: 'https://example.org/p' }, text: 'λέξη '.repeat(500) }] }), { labels, settings: SETTINGS, maxChars: 120 });
  assert.ok(Array.from(cut[1].content).length <= 120, 'a line keeps the analyzer\'s per-line limit');
  assert.deepEqual(cut[1].inner.sources, ['https://example.org/p'], 'the page read is its source');
});

function hotFor(overrides = {}) {
  return {
    config: {
      bot: { timezone: 'UTC' },
      context: { gapMarkerMinutes: 20, maxMessageChars: 2000 },
      models: { core: 'x/y', helpers: { extractor: 'x/y' } },
      llm: { temperature: 1, maxOutputTokens: 700, maxRequestTokens: 50000, safetyMargin: 0.9, timeoutMs: 1000, retries: 0, maxRequestsPerDay: 100 },
      memory: { batchMessages: 2, minBatchMessages: 1, maxBatchAgeMinutes: 180, maxOutputTokens: 4000, fieldChars: 400, maxDetails: 15, maxInjokes: 15, maxSelfFacts: 20 },
      features: { record: true },
      innerLife: { memory: { ...SETTINGS } },
      ...overrides,
    },
    prompts: { memory: 'sys', labels },
  };
}

test('observeInner: a server episode goes to the server buffer, a private one to that member\'s buffer only; nothing while paused', () => {
  const dir = tempDir('nep-inner-ep-');
  const store = createStore({ dataDir: dir });
  const hot = hotFor();
  const updater = createMemoryUpdater({ hot, store, llm: { complete: async () => ({ text: '{}' }) }, calibrator: createCalibrator(), getSelfName: () => 'Bot', now: () => AT });
  return withCapturedLogs(async () => {
    assert.equal(updater.observeInner('g1', episode()), 2);
    assert.deepEqual(store.getBuffer('g1').map((line) => line.inner?.kind), ['inner', 'inner']);
    assert.equal(updater.observeInner('g1', episode({ turnId: 't-2', channelId: 'dm1', privateUserId: 'u7' })), 2);
    assert.equal(store.getBuffer('g1').length, 2, 'a private finding never reaches the server buffer');
    assert.deepEqual(store.getPrivateBuffer('g1', 'u7').map((line) => line.channelId), ['dm1', 'dm1']);
    hot.config.innerLife.memory.enabled = false;
    assert.equal(updater.observeInner('g1', episode({ turnId: 't-3' })), 0);
    hot.config.innerLife.memory.enabled = true;
    store.state.data.paused = true;
    assert.equal(updater.observeInner('g1', episode({ turnId: 't-4' })), 0);
    assert.equal(store.getBuffer('g1').length, 2);
  }).then(({ logs }) => {
    const buffered = logs.filter((entry) => entry.msg === 'memory: inner episode buffered');
    assert.equal(buffered.length, 2);
    assert.deepEqual([buffered[0].lines, buffered[0].sources, buffered[0].shadow], [2, 2, true]);
    assert.equal(buffered[1].private, true);
    assert.ok(!JSON.stringify(buffered).includes('Φάσμα'), 'counts only, never the text');
  });
});

test('memory batch: the analyzer reads her episode as her own lines; the record (the chat) never gets them', async () => {
  const dir = tempDir('nep-inner-ep-');
  const store = createStore({ dataDir: dir });
  const hot = hotFor({ memory: { ...hotFor().config.memory, batchMessages: 3 } });
  const requests = [];
  const llm = { complete: async (messages) => (requests.push(messages), { text: '{}' }) };
  const appended = [];
  const record = { append: async (guildId, lines) => (appended.push(...lines), { written: lines.length, duplicates: 0 }) };
  const updater = createMemoryUpdater({ hot, store, llm, calibrator: createCalibrator(), getSelfName: () => 'Bot', now: () => AT + 60_000, record });
  store.pushBuffer('g1', { id: 'm1', channelId: 'c1', channelName: 'general', authorId: 'u1', authorName: 'Zoë', self: false, bot: false, content: 'καλημέρα', ts: AT - 1000, replyToId: null, attachments: [], stickers: [] }, 100);
  updater.observeInner('g1', episode());
  await withCapturedLogs(() => updater.run('g1'));
  assert.equal(requests.length, 1);
  const user = JSON.stringify(requests[0][1].content);
  assert.ok(user.includes('Ο κόσμος λέγεται Φάσμα'), 'the finding is in the batch transcript');
  assert.ok(user.includes(fill(labels.self, { name: 'Bot' })), 'as a line of hers');
  assert.deepEqual(appended.map((line) => line.messageId), ['m1'], 'only the chat line is recorded');
  assert.deepEqual(store.getBuffer('g1'), [], 'the batch consumed her episode');
});
