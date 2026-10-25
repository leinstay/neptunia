// Tests for the lines an inner turn's episode makes (src/memory/inner-episode.js; docs/inner-life.md, "What she
// found goes to her memory"): what her reads found and her thinks become lines of hers, worded only by labels,
// marked `inner` (shadow or not). Pure functions; no network, no data/.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { feedbackText, innerEpisodeLines, innerMemorySettings, linksOf, tailChars } from '../src/memory/inner-episode.js';
import { feedbackFactText } from '../src/behavior/wake.js';
import { fill } from '../src/format.js';
import { labels } from './fixtures/labels.js';

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
      { skill: 'draw.create', status: 'refused' },
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
  assert.ok(head.includes(fill(labels.memory.inner.notDone, { skills: 'draw.create, message.create' })), 'proposed and refused calls are not done');
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

test('innerEpisodeLines: the feedback facts of the turn join the first line in her voice; with no finding they are the one line; nothing without their label', () => {
  const feedback = [
    { kind: 'callFailed', skill: 'message.create', status: 'refused', code: 'destination-required' },
    { kind: 'doneWithoutDelivery', intentionId: 'i1', purpose: 'send a cat meme' },
  ];
  const expected = fill(labels.memory.innerFeedback, { facts: feedback.map((fact) => feedbackFactText(fact, labels.wake)).join('; ') });
  assert.equal(feedbackText({ feedback }, labels), feedback.map((fact) => feedbackFactText(fact, labels.wake)).join('; '));
  assert.equal(feedbackText({ feedback: [] }, labels), '');
  const lines = innerEpisodeLines(episode({ feedback }), { labels, settings: SETTINGS, maxChars: 2000 });
  assert.equal(lines.length, 2, 'the head line and the finding');
  const head = lines[0].content.split('\n');
  assert.equal(head.at(-1), expected, 'the facts close the head line, after her thinks and calls');
  assert.ok(head[0].startsWith(labels.memory.inner.think.split('{')[0]));
  assert.ok(lines[0].self && lines[0].inner.kind === 'inner');
  // A turn that found nothing and lost its output: the facts alone are the episode, one line of hers.
  const alone = innerEpisodeLines(episode({ thinks: [], findings: [], actions: [{ skill: 'intent.update', status: 'executed' }], feedback }), { labels, settings: SETTINGS });
  assert.equal(alone.length, 1);
  assert.equal(alone[0].content, `${fill(labels.memory.inner.done, { skills: 'intent.update' })}\n${expected}`);
  assert.equal(alone[0].id, 'inner:t-1:0');
  // Without the memory label the facts are not written; without a finding that leaves nothing.
  const without = { ...labels, memory: { ...labels.memory, innerFeedback: undefined } };
  assert.deepEqual(innerEpisodeLines(episode({ findings: [], feedback }), { labels: without, settings: SETTINGS }), []);
  assert.equal(innerEpisodeLines(episode({ feedback }), { labels: without, settings: SETTINGS })[0].content.includes('cat meme'), false);
  // An unknown fact kind is skipped; facts of known kinds without their wake label too.
  assert.equal(feedbackText({ feedback: [{ kind: 'other' }] }, labels), '');
  assert.deepEqual(innerEpisodeLines(episode({ findings: [], feedback }), { labels: { ...labels, wake: { ...labels.wake, feedback: {} } }, settings: SETTINGS }), []);
});
