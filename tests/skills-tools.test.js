// Tests for the persona's in-turn tools (src/skills/tools.js): what a web.search and a
// memory.search give back, labelled by source and evidence type, and the statuses of a search
// that cannot run. Fakes only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IN_TURN_TOOLS, memorySearchText, runMemorySearch, runWebSearch, webSearchText } from '../src/skills/tools.js';
import { fill } from '../src/format.js';
import { labels } from './fixtures/labels.js';

const NOW = Date.UTC(2026, 9, 17, 12);
const WEB_ON = { features: { webLookup: true }, web: { search: { enabled: true } } };

function fakeLookup({ found = { query: 'q', text: 'ευρήματα', sources: [{ url: 'https://www.example.com/a' }, { site: 'example.com' }, { site: 'exemple.fr' }] }, capLeft = 5, hasSearch = true } = {}) {
  const searches = [];
  return {
    searches,
    hasSearch: () => hasSearch,
    webCapLeft: () => capLeft,
    search: async (guildId, query) => {
      searches.push({ guildId, query });
      return found ? { ...found, query } : null;
    },
  };
}

test('in-turn tools: the two skills that come back in the same turn', () => {
  assert.deepEqual([...IN_TURN_TOOLS], ['web.search', 'memory.search']);
});

test('webSearchText: her query and the evidence type first, what she wanted to establish, the snippets, the numbered sources with their links', () => {
  const l = labels.skills.tools.web;
  const sources = [{ title: 'Ο τελικός', url: 'https://www.example.com/a' }, { site: 'example.com' }, { title: '', url: 'https://exemple.fr/b' }];
  const text = webSearchText({ query: 'τελικός 2026', text: 'Η Ana κέρδισε.', sources }, { goal: 'ποιος κέρδισε', labels });
  assert.equal(text, [
    fill(l.source, { query: 'τελικός 2026' }),
    fill(l.goal, { goal: 'ποιος κέρδισε' }),
    'Η Ana κέρδισε.',
    l.sources,
    '1. Ο τελικός: https://www.example.com/a',
    '2. https://exemple.fr/b',
  ].join('\n'));
  assert.equal(webSearchText({ query: 'x', text: '' }, { labels }), [fill(l.source, { query: 'x' }), l.none].join('\n'), 'nothing found says so');
  assert.equal(webSearchText({ query: 'x', text: 'κάτι', sources: [{ site: 'example.com' }] }, { labels }), [fill(l.source, { query: 'x' }), 'κάτι'].join('\n'), 'no link, no list');
});

test('webSearchText sources: duplicates and trackers dropped, titles and long links cut, at most six', () => {
  const l = labels.skills.tools.web;
  const long = `https://example.com/${'p'.repeat(400)}`;
  const sources = [
    { title: 'Α', url: 'https://www.example.com/a/?utm_source=x&id=7#top' },
    { title: 'Α again', url: 'https://example.com/a?id=7' },
    { title: 'Β'.repeat(300), url: 'https://example.org/b' },
    { title: 'Γ', url: `https://example.net/c?q=${'z'.repeat(400)}` },
    { title: 'Δ', url: long },
    { title: 'bad', url: 'javascript:alert(1)' },
    { title: 'Ε', url: 'https://e.example/1' },
    { title: 'Ζ', url: 'https://e.example/2' },
    { title: 'Η', url: 'https://e.example/3' },
  ];
  const lines = webSearchText({ query: 'q', text: 'κάτι', sources }, { labels }).split('\n');
  const list = lines.slice(lines.indexOf(l.sources) + 1);
  assert.equal(list.length, 6);
  assert.equal(list[0], '1. Α: https://www.example.com/a/?id=7', 'tracking parameters and the fragment go, the first title stays');
  assert.ok(list[1].startsWith('2. ') && list[1].endsWith(': https://example.org/b') && list[1].length < 200, list[1]);
  assert.equal(list[2], '3. Γ: https://example.net/c', 'an over-long query string is dropped, the page stays');
  assert.ok(list[3].startsWith('4. Δ: https://example.com/') && list[3].endsWith('…') && list[3].length < 320, 'a still too long link is cut visibly');
  assert.deepEqual(list.slice(4), ['5. Ε: https://e.example/1', '6. Ζ: https://e.example/2']);
});

test('memorySearchText: the source, then each stretch under its day and channel with its lines as they were', () => {
  const l = labels.skills.tools.memory;
  const quotes = [
    { channelName: 'jardin', startTs: Date.UTC(2026, 8, 30, 9), lines: '[09:00] Éloïse: ένα κουνέλι\n[09:01] Ana: ωραίο' },
    { channelName: 'general', startTs: Date.UTC(2026, 9, 1, 18), lines: '>> [18:44] Βασίλης: το κουνέλι πέθανε' },
  ];
  assert.equal(memorySearchText(quotes, { labels, timezone: 'UTC' }), [
    l.source,
    fill(l.window, { date: '2026-09-30', channel: 'jardin' }),
    quotes[0].lines,
    fill(l.window, { date: '2026-10-01', channel: 'general' }),
    quotes[1].lines,
  ].join('\n'));
  assert.equal(memorySearchText([], { labels }), [l.source, l.none].join('\n'));
});

test('runWebSearch: her query goes to the client as written; the statuses of a search that cannot run', async () => {
  const lookup = fakeLookup();
  const ok = await runWebSearch({ lookup, config: WEB_ON, labels, guildId: 'g1', args: { query: '  τελικός 2026 ', goal: 'ποιος' } });
  assert.equal(ok.status, 'ok');
  assert.deepEqual(lookup.searches, [{ guildId: 'g1', query: 'τελικός 2026' }]);
  assert.ok(ok.data.text.startsWith(fill(labels.skills.tools.web.source, { query: 'τελικός 2026' })), ok.data.text);
  const status = async (overrides) => {
    const result = await runWebSearch({ lookup: fakeLookup(overrides.lookup), config: overrides.config ?? WEB_ON, labels, guildId: 'g1', args: overrides.args ?? { query: 'x' } });
    return [result.status, result.code];
  };
  assert.deepEqual(await status({ args: {} }), ['invalid', 'invalid-args']);
  assert.deepEqual(await status({ config: { features: { webLookup: false } } }), ['not_configured', 'not-configured']);
  assert.deepEqual(await status({ lookup: { hasSearch: false } }), ['not_configured', 'not-configured']);
  assert.deepEqual(await status({ lookup: { capLeft: 0 } }), ['failed', 'daily-cap']);
  assert.deepEqual(await status({ lookup: { found: null } }), ['failed', 'error']);
  assert.deepEqual((await runWebSearch({ lookup: null, config: WEB_ON, labels, guildId: 'g1', args: { query: 'x' } })).status, 'not_configured');
});

test('runMemorySearch: her arguments become the server part (no helper), recall runs with quotes over the turn history; the statuses', async () => {
  const runs = [];
  const recall = {
    available: () => true,
    run: async (args) => {
      runs.push(args);
      return { text: null, stretch: null, people: [], quotes: [{ channelName: 'jardin', startTs: Date.UTC(2026, 8, 30, 9), lines: '[09:00] Éloïse: ένα κουνέλι' }] };
    },
  };
  const guild = { id: 'g1' };
  const channel = { id: 'c1', guild };
  const history = [{ id: 'h1' }];
  const decorate = (lines) => lines;
  const store = { listUserProfiles: () => [{ id: 'u3', names: ['Éloïse'], aliases: [] }] };
  const config = { bot: { timezone: 'UTC' }, features: { recall: true }, recall: { maxForms: 4 } };
  const result = await runMemorySearch({ recall, store, config, labels, guild, guildId: 'g1', channel, selfId: 'self', selfName: 'Zoë', history, decorate, args: { question: 'τι είπε η Éloïse για το κουνέλι;', terms: 'λαγός', channelId: 'c2' }, now: NOW });
  assert.equal(result.status, 'ok');
  assert.ok(result.data.text.includes('[09:00] Éloïse: ένα κουνέλι'), result.data.text);
  assert.equal(runs.length, 1);
  const [run] = runs;
  assert.equal(run.quotes, true);
  assert.deepEqual(run.server, { forms: ['λαγός', 'κουνέλι'], who: ['éloïse'], from: null, to: null, channelId: 'c2' });
  assert.deepEqual([run.history, run.decorate, run.candidate.content], [history, decorate, 'τι είπε η Éloïse για το κουνέλι;']);
  const status = async (overrides) => {
    const out = await runMemorySearch({ recall, store, config, labels, guild, guildId: 'g1', channel, args: { question: 'τι;' }, now: NOW, ...overrides });
    return [out.status, out.code];
  };
  assert.deepEqual(await status({}), ['invalid', 'no-query'], 'nothing left to search');
  assert.deepEqual(await status({ recall: null }), ['not_configured', 'not-configured']);
  assert.deepEqual(await status({ recall: { ...recall, available: () => false } }), ['not_configured', 'not-configured']);
  assert.deepEqual(await status({ guild: null, channel: { id: 'dm1', guild: null } }), ['not_configured', 'unsupported']);
});
