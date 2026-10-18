// Tests for the persona's in-turn tools (src/skills/tools.js): what a web.search, a web.read and a
// memory.search give back, labelled by source and evidence type, and the statuses of a search
// that cannot run. Fakes only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IN_TURN_TOOLS, firstLinkIn, memorySearchText, runMemorySearch, runWebRead, runWebSearch, webReadText, webSearchText } from '../src/skills/tools.js';
import { fill } from '../src/format.js';
import { labels } from './fixtures/labels.js';

const NOW = Date.UTC(2026, 9, 17, 12);
const WEB_ON = { features: { webLookup: true }, web: { search: { enabled: true } } };

function fakeLookup({ found = { query: 'q', results: [{ title: 'Ο τελικός', url: 'https://www.example.com/a', site: 'example.com', snippet: 'Η Ana κέρδισε.' }] }, capLeft = 5, hasSearch = true, page = { ok: true, url: 'https://example.com/p', title: 'Σελίδα', text: 'Το κείμενο της σελίδας.', cut: false } } = {}) {
  const searches = [];
  const reads = [];
  return {
    searches,
    reads,
    hasSearch: () => hasSearch,
    webCapLeft: () => capLeft,
    searchResults: async (guildId, query) => {
      searches.push({ guildId, query });
      return found ? { ...found, query } : null;
    },
    readPage: async (guildId, url) => {
      reads.push({ guildId, url });
      return page;
    },
  };
}

test('in-turn tools: the three skills that come back in the same turn', () => {
  assert.deepEqual([...IN_TURN_TOOLS], ['web.search', 'web.read', 'memory.search']);
});

test('webSearchText: her query and the evidence type first, what she wanted to establish, then each result raw: title, link, site and date, snippet', () => {
  const l = labels.skills.tools.web;
  const results = [
    { title: 'Ο τελικός', url: 'https://www.example.com/a', site: 'example.com', snippet: 'Η Ana κέρδισε.', age: '2026-10-01' },
    { title: '', url: 'https://exemple.fr/b', site: 'exemple.fr', snippet: '' },
  ];
  const text = webSearchText({ query: 'τελικός 2026', results }, { goal: 'ποιος κέρδισε', labels });
  assert.equal(text, [
    fill(l.source, { query: 'τελικός 2026' }),
    fill(l.goal, { goal: 'ποιος κέρδισε' }),
    '1. Ο τελικός',
    'https://www.example.com/a',
    'example.com · 2026-10-01',
    'Η Ana κέρδισε.',
    '2.',
    'https://exemple.fr/b',
    'exemple.fr',
  ].join('\n'));
  assert.equal(webSearchText({ query: 'x', results: [] }, { labels }), [fill(l.source, { query: 'x' }), l.none].join('\n'), 'nothing found says so');
  assert.equal(webSearchText({ query: 'x', results: [{ title: 'bad', url: 'javascript:alert(1)' }] }, { labels }), [fill(l.source, { query: 'x' }), l.none].join('\n'), 'no http(s) link, no result');
});

test('webSearchText results: duplicates and trackers dropped, titles, links and snippets cut, the whole within its cap', () => {
  const long = `https://example.com/${'p'.repeat(400)}`;
  const results = [
    { title: 'Α', url: 'https://www.example.com/a/?utm_source=x&id=7#top', snippet: 'α'.repeat(50) },
    { title: 'Α again', url: 'https://example.com/a?id=7', snippet: 'again' },
    { title: 'Β'.repeat(300), url: 'https://example.org/b', snippet: 'β' },
    { title: 'Γ', url: `https://example.net/c?q=${'z'.repeat(400)}`, snippet: 'γ' },
    { title: 'Δ', url: long, snippet: 'δ' },
  ];
  const lines = webSearchText({ query: 'q', results }, { labels, snippetChars: 20, maxChars: 5000 }).split('\n');
  assert.ok(lines.includes('https://www.example.com/a/?id=7'), 'tracking parameters and the fragment go');
  assert.ok(!lines.some((line) => line === 'again'), 'the same page once');
  const snippet = lines[lines.indexOf('https://www.example.com/a/?id=7') + 1];
  assert.ok(snippet.length <= 20 && snippet.endsWith('…'), snippet);
  assert.ok(lines.some((line) => line.startsWith('2. ') && line.length < 130), 'a long title is cut');
  assert.ok(lines.includes('https://example.net/c'), 'an over-long query string is dropped, the page stays');
  assert.ok(lines.some((line) => line.startsWith('https://example.com/') && line.endsWith('…') && line.length <= 300), 'a still too long link is cut visibly');
  const capped = webSearchText({ query: 'q', results: results.map((r, i) => ({ ...r, url: `https://e${i}.example/`, snippet: 'σ'.repeat(300) })) }, { labels, snippetChars: 300, maxChars: 500 });
  assert.ok(capped.length <= 500, String(capped.length));
  assert.ok(capped.includes('1. Α') && !capped.includes('5. Δ'), 'the first result shows, the rest stop at the cap');
});

test('webReadText: the source with the page link and the cut, the title, the page text as it is, the cut said when it was cut', () => {
  const l = labels.skills.tools.read;
  const page = { url: 'https://example.com/p', title: 'Σελίδα', text: 'Πρώτη γραμμή.\nΔεύτερη.', cut: true };
  assert.equal(webReadText(page, { labels, maxChars: 4000 }), [
    fill(l.source, { url: 'https://example.com/p', maxChars: '4000' }),
    fill(l.title, { title: 'Σελίδα' }),
    'Πρώτη γραμμή.\nΔεύτερη.',
    fill(l.cut, { maxChars: '4000' }),
  ].join('\n'));
  assert.equal(webReadText({ ...page, title: '', cut: false }, { labels, maxChars: 10 }), [fill(l.source, { url: 'https://example.com/p', maxChars: '10' }), 'Πρώτη γραμμή.\nΔεύτερη.'].join('\n'));
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

test('runWebSearch: her query goes to the raw search as written, the results are cut by the config; the statuses of a search that cannot run', async () => {
  const lookup = fakeLookup();
  const ok = await runWebSearch({ lookup, config: { ...WEB_ON, web: { search: { enabled: true, snippetChars: 5 } } }, labels, guildId: 'g1', args: { query: '  τελικός 2026 ', goal: 'ποιος' } });
  assert.equal(ok.status, 'ok');
  assert.deepEqual(lookup.searches, [{ guildId: 'g1', query: 'τελικός 2026' }]);
  assert.ok(ok.data.text.startsWith(fill(labels.skills.tools.web.source, { query: 'τελικός 2026' })), ok.data.text);
  assert.ok(ok.data.text.includes('https://www.example.com/a') && ok.data.text.endsWith('Η…'), ok.data.text);
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

test('runWebRead: a link, or the link of a message, goes to the page reader; the text comes back under its source; the statuses', async () => {
  const lookup = fakeLookup();
  const ok = await runWebRead({ lookup, config: { ...WEB_ON, web: { links: { readChars: 1234 } } }, labels, guildId: 'g1', args: { url: ' https://example.com/p ' } });
  assert.equal(ok.status, 'ok');
  assert.deepEqual(lookup.reads, [{ guildId: 'g1', url: 'https://example.com/p' }]);
  assert.equal(ok.data.text, [fill(labels.skills.tools.read.source, { url: 'https://example.com/p', maxChars: '1234' }), fill(labels.skills.tools.read.title, { title: 'Σελίδα' }), 'Το κείμενο της σελίδας.'].join('\n'));
  const byMessage = fakeLookup();
  const asked = [];
  const viaMessage = await runWebRead({ lookup: byMessage, config: WEB_ON, labels, guildId: 'g1', args: { message: 'm7' }, linkOf: async (id) => (asked.push(id), 'https://exemple.fr/x') });
  assert.equal(viaMessage.status, 'ok');
  assert.deepEqual([asked, byMessage.reads.map((read) => read.url)], [['m7'], ['https://exemple.fr/x']]);
  const status = async ({ lookup: over, config = WEB_ON, args = { url: 'https://example.com/p' }, linkOf = () => null } = {}) => {
    const result = await runWebRead({ lookup: over === null ? null : fakeLookup(over), config, labels, guildId: 'g1', args, linkOf });
    return [result.status, result.code];
  };
  assert.deepEqual(await status({ args: {} }), ['invalid', 'invalid-args']);
  assert.deepEqual(await status({ args: { message: 'm1' } }), ['invalid', 'no-link'], 'a message without a link');
  assert.deepEqual(await status({ config: { features: { webLookup: false } } }), ['not_configured', 'not-configured']);
  assert.deepEqual(await status({ lookup: null }), ['not_configured', 'not-configured']);
  assert.deepEqual(await status({ lookup: { capLeft: 0 } }), ['failed', 'daily-cap']);
  assert.deepEqual(await status({ lookup: { page: { ok: false, reason: 'private' } } }), ['failed', 'private']);
  assert.deepEqual(await status({ lookup: { page: { ok: false, reason: 'scheme' } } }), ['invalid', 'scheme']);
  const empty = await runWebRead({ lookup: fakeLookup({ page: { ok: false, reason: 'empty' } }), config: WEB_ON, labels, guildId: 'g1', args: { url: 'https://example.com/e' } });
  assert.equal(empty.status, 'ok');
  assert.ok(empty.data.text.endsWith(labels.skills.tools.read.none), empty.data.text);
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

test('firstLinkIn: the first http(s) link written in a text, up to a space or an angle bracket; null without one', () => {
  assert.equal(firstLinkIn('δες <https://exemple.fr/άρθρο?a=1> και http://b.example'), 'https://exemple.fr/άρθρο?a=1');
  assert.equal(firstLinkIn('ftp://x.example and www.example.com'), null);
  assert.equal(firstLinkIn(undefined), null);
});
