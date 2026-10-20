// Tests for the persona's in-turn tools (src/skills/tools.js): what a web.search, a web.read and a
// memory.search give back, labelled by source and evidence type, and the statuses of a search
// that cannot run. Fakes only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { IN_TURN_TOOLS, firstLinkIn, lookableMedia, mediaLookText, memorySearchText, runMediaLook, runMemorySearch, runWebRead, runWebSearch, webReadText, webSearchText } from '../src/skills/tools.js';
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

test('in-turn tools: the skills that come back in the same turn', () => {
  assert.deepEqual([...IN_TURN_TOOLS], ['web.search', 'web.read', 'media.look', 'memory.search', 'conversation.read', 'media.find']);
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

test('memorySearchText: each stretch is cut on its own, the whole by stretches that fit, and a closing line names the ones left out', () => {
  const l = labels.skills.tools.memory;
  const row = (n) => `[09:${String(n).padStart(2, '0')}] Ana: ${'α'.repeat(93)}`; // 105 characters with the newline
  const longWindow = Array.from({ length: 19 }, (_, i) => row(i)).join('\n'); // about 2000 characters
  const quotes = Array.from({ length: 10 }, (_, i) => ({ channelName: `kanali${i}`, startTs: Date.UTC(2026, 9, 1 + i, 9), lines: longWindow }));
  const out = memorySearchText(quotes, { labels, timezone: 'UTC', windowChars: 1500, maxChars: 10000 });
  const lines = out.split('\n');
  const windows = lines.filter((line) => line.startsWith('2026-10-'));
  assert.equal(windows.length, 6);
  const cutLines = lines.filter((line) => line === fill(l.windowCut, { dropped: '5' }));
  assert.equal(cutLines.length, 6, 'every shown stretch is cut to 14 lines, 5 dropped');
  assert.ok(out.length <= 10000);
  assert.equal(lines.at(-1), fill(l.windowsLeft, { count: '4', where: 'kanali6 2026-10-07, kanali7 2026-10-08, kanali8 2026-10-09, kanali9 2026-10-10' }));
  const whole = memorySearchText(quotes.slice(0, 2), { labels, timezone: 'UTC', windowChars: 1500, maxChars: 9000 });
  assert.ok(!whole.includes(fill(l.windowsLeft, { count: '0', where: '' })));
  assert.equal(whole.split('\n').filter((line) => line.startsWith('2026-10-')).length, 2);
  const short = memorySearchText([{ channelName: 'a', startTs: Date.UTC(2026, 9, 1), lines: 'one\ntwo' }], { labels, timezone: 'UTC' });
  assert.equal(short, [l.source, fill(l.window, { date: '2026-10-01', channel: 'a' }), 'one\ntwo'].join('\n'), 'nothing cut, nothing left: no extra line');
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

// media.look: her own second look at a picture or a video, through the describer's second-look path.

const LOOK_ON = { features: { vision: true, mediaDescriptions: true, videoDescriptions: true, coreTools: true }, media: { video: { sites: ['youtube.com'] } } };

/** A normalized message with a picture, a GIF embed, a video attachment and a video-site link. */
function mediaMessage() {
  return {
    id: 'm7',
    content: 'δες',
    attachments: [
      { id: 'pa', kind: 'image', url: 'https://cdn.example.com/a.png', name: 'a.png' },
      { id: 'va', kind: 'video', url: 'https://cdn.example.com/clip.mp4', name: 'clip.mp4', durationSec: 12, size: 1000 },
    ],
    links: [
      { id: 'm7#e0', kind: 'gif', url: 'https://tenor.com/x', site: 'Tenor', title: '', thumbnailUrl: 'https://media.tenor.com/x.png', animationUrl: 'https://media.tenor.com/x.mp4' },
      { id: 'm7#e1', kind: 'video', url: 'https://youtube.com/watch?v=abc', site: 'YouTube', title: 'Μια ταινία' },
    ],
    stickers: [],
  };
}

function fakeDescriber({ answer = 'ένα κόκκινο ποδήλατο', caps = null } = {}) {
  const calls = [];
  const second = (method) => async (guildId, item, question) => {
    calls.push({ method, guildId, itemId: item.itemId, question });
    return answer ? { question, text: answer } : null;
  };
  return {
    calls,
    relookImage: second('relookImage'),
    rewatchVideo: second('rewatchVideo'),
    rewatchGif: second('rewatchGif'),
    ...(caps ? { videoCapsLeft: () => caps } : {}),
  };
}

test('lookableMedia: the pictures, GIFs and videos of one message in their order; a video once, as a video', () => {
  const media = lookableMedia(mediaMessage(), { videoSites: ['youtube.com'] });
  assert.deepEqual(media.map(({ kind, item }) => `${kind}:${item.itemId}`), ['image:pa', 'video:va', 'gif:m7#e0', 'video:m7#e1']);
  assert.deepEqual(lookableMedia(mediaMessage()).map(({ kind }) => kind), ['image', 'video', 'gif'], 'no video site: the link is no video');
  assert.deepEqual(lookableMedia({ id: 'm1', content: 'τίποτα', attachments: [], links: [], stickers: [] }), []);
  assert.deepEqual(lookableMedia(null), []);
});

test('mediaLookText: the image or the video model named as the source with what was asked, then its answer as it gave it', () => {
  const l = labels.skills.tools.look;
  assert.equal(mediaLookText({ kind: 'image', name: 'a.png', question: 'τι χρώμα;', text: 'κόκκινο' }, { labels }), [fill(l.image, { name: 'a.png', question: 'τι χρώμα;' }), 'κόκκινο'].join('\n'));
  assert.equal(mediaLookText({ kind: 'video', name: 'clip.mp4', question: 'ποιος μιλά;', text: 'η Zoë' }, { labels }), [fill(l.video, { name: 'clip.mp4', question: 'ποιος μιλά;' }), 'η Zoë'].join('\n'));
  assert.equal(mediaLookText({ kind: 'gif', name: 'Tenor', question: 'τι κάνει;', text: 'χορεύει' }, { labels }), [fill(l.video, { name: 'Tenor', question: 'τι κάνει;' }), 'χορεύει'].join('\n'), 'a GIF is watched as a clip');
  assert.equal(mediaLookText({ kind: 'image', name: 'a.png', question: 'q', text: 'απάντηση' }, { labels: {} }), 'απάντηση', 'a missing label adds nothing');
});

test('runMediaLook: her question goes to the second look of the item she names, the answer comes back labelled; the first item by default', async () => {
  const describer = fakeDescriber();
  const asked = [];
  const mediaOf = (id) => (asked.push(id), id === 'm7' ? mediaMessage() : null);
  const first = await runMediaLook({ describer, config: LOOK_ON, labels, guildId: 'g1', args: { message: 'm7', question: ' τι κρατά; ' }, mediaOf });
  assert.equal(first.status, 'ok');
  assert.deepEqual(describer.calls, [{ method: 'relookImage', guildId: 'g1', itemId: 'pa', question: 'τι κρατά;' }]);
  assert.equal(first.data.text, mediaLookText({ kind: 'image', name: 'a.png', question: 'τι κρατά;', text: 'ένα κόκκινο ποδήλατο' }, { labels }));
  for (const [item, method, itemId] of [[2, 'rewatchVideo', 'va'], ['3', 'rewatchGif', 'm7#e0'], [4, 'rewatchVideo', 'm7#e1']]) {
    const one = fakeDescriber();
    const result = await runMediaLook({ describer: one, config: LOOK_ON, labels, guildId: 'g1', args: { message: 'm7', question: 'τι;', item }, mediaOf });
    assert.equal(result.status, 'ok', `item ${item}`);
    assert.deepEqual(one.calls.map((call) => [call.method, call.itemId]), [[method, itemId]]);
  }
  assert.deepEqual([...new Set(asked)], ['m7']);
});

test('runMediaLook: the statuses -- arguments, message, media, switches, the turn cap and the daily second-look limits', async () => {
  const run = async ({ args = { message: 'm7', question: 'τι;' }, config = LOOK_ON, describer = fakeDescriber(), message = mediaMessage(), takeTurnSlot = undefined } = {}) => {
    const result = await runMediaLook({ describer, config, labels, guildId: 'g1', args, mediaOf: () => message, ...(takeTurnSlot ? { takeTurnSlot } : {}) });
    return [result.status, result.code];
  };
  assert.deepEqual(await run({ args: { question: 'τι;' } }), ['invalid', 'invalid-args']);
  assert.deepEqual(await run({ args: { message: 'm7' } }), ['invalid', 'invalid-args']);
  assert.deepEqual(await run({ message: null }), ['invalid', 'unknown-message']);
  assert.deepEqual(await run({ message: { id: 'm7', content: 'κείμενο', attachments: [], links: [], stickers: [] } }), ['invalid', 'no-media']);
  assert.deepEqual(await run({ args: { message: 'm7', question: 'τι;', item: 9 } }), ['invalid', 'invalid-args']);
  assert.deepEqual(await run({ describer: null }), ['not_configured', 'not-configured']);
  assert.deepEqual(await run({ config: { ...LOOK_ON, features: { ...LOOK_ON.features, imageRelook: false } } }), ['not_configured', 'not-configured']);
  assert.deepEqual(await run({ args: { message: 'm7', question: 'τι;', item: 2 }, config: { ...LOOK_ON, features: { ...LOOK_ON.features, videoRewatch: false } } }), ['not_configured', 'not-configured']);
  assert.deepEqual(await run({ args: { message: 'm7', question: 'τι;', item: 2 }, config: { ...LOOK_ON, features: { ...LOOK_ON.features, mediaDescriptions: false } } }), ['not_configured', 'not-configured'], 'a video without video vision');
  // The daily limits the second look already has: one second-look counter, a video slot for a video, a GIF watch slot for a GIF.
  assert.deepEqual(await run({ describer: fakeDescriber({ caps: { video: 5, rewatch: 0, gif: 5 } }) }), ['failed', 'daily-cap']);
  assert.deepEqual(await run({ args: { message: 'm7', question: 'τι;', item: 2 }, describer: fakeDescriber({ caps: { video: 0, rewatch: 5, gif: 5 } }) }), ['failed', 'daily-cap']);
  assert.deepEqual(await run({ describer: fakeDescriber({ caps: { video: 0, rewatch: 5, gif: 0 } }) }), ['ok', undefined], 'a picture takes no video or GIF slot');
  assert.deepEqual(await run({ args: { message: 'm7', question: 'τι;', item: 3 }, describer: fakeDescriber({ caps: { video: 5, rewatch: 5, gif: 0 } }) }), ['failed', 'daily-cap']);
  // The turn's own cap: the slot is taken only once every other check passed.
  let slots = 1;
  const takeTurnSlot = () => (slots > 0 ? ((slots -= 1), true) : false);
  assert.deepEqual(await run({ describer: fakeDescriber({ caps: { video: 5, rewatch: 0, gif: 5 } }), takeTurnSlot }), ['failed', 'daily-cap']);
  assert.equal(slots, 1, 'a refused look takes no slot of the turn');
  assert.deepEqual(await run({ takeTurnSlot }), ['ok', undefined]);
  assert.deepEqual(await run({ takeTurnSlot }), ['failed', 'turn-cap']);
  assert.deepEqual(await run({ describer: fakeDescriber({ answer: null }) }), ['failed', 'error'], 'the describer gave nothing back');
  const throwing = { relookImage: async () => { throw new Error('boom'); } };
  assert.deepEqual(await run({ describer: throwing }), ['failed', 'error']);
});

test('runMediaLook: a placeholder of a deleted message is refused as unknown-message with the reason message-deleted', async () => {
  const result = await runMediaLook({ describer: {}, config: LOOK_ON, labels, guildId: 'g1', args: { message: 'm7', question: 'τι;' }, mediaOf: () => ({ id: 'm7', deleted: true, attachments: [] }) });
  assert.deepEqual([result.status, result.code, result.reason], ['invalid', 'unknown-message', 'message-deleted']);
});

// A tool that did not do what it was asked says so: the outcomes that used to read as an empty success.

test('runWebSearch: the lookup\'s coded failures reach her as what they are; an empty search that ran stays ok with the none label', async () => {
  const via = async (failed) => runWebSearch({ lookup: fakeLookup({ found: { failed } }), config: WEB_ON, labels, guildId: 'g1', args: { query: 'q' } });
  assert.deepEqual(await via({ code: 'provider', status: 503 }), { status: 'failed', code: 'provider', values: { status: '503' } });
  assert.deepEqual(await via({ code: 'provider' }), { status: 'failed', code: 'provider', values: { status: '' } });
  assert.deepEqual(await via({ code: 'cap' }), { status: 'failed', code: 'cap', values: { what: 'search' } });
  assert.deepEqual(await via({ code: 'empty-query' }), { status: 'invalid', code: 'empty-query' });
  assert.deepEqual(await via({ code: 'not-configured' }), { status: 'not_configured', code: 'not-configured', values: { feature: 'web' } });
  const none = await runWebSearch({ lookup: fakeLookup({ found: { results: [] } }), config: WEB_ON, labels, guildId: 'g1', args: { query: 'q' } });
  assert.equal(none.status, 'ok');
  assert.ok(none.data.text.endsWith(labels.skills.tools.web.none), none.data.text);
});

test('webSearchText: results left out for room are counted in a closing line', () => {
  const results = Array.from({ length: 5 }, (_, i) => ({ title: `Τίτλος ${i}`, url: `https://example.com/${i}`, site: 'example.com', snippet: 'κείμενο' }));
  const out = webSearchText({ query: 'q', results }, { labels, maxChars: 190 });
  const shown = out.split('\n').filter((line) => /^\d+\. /.test(line)).length;
  assert.ok(shown >= 1 && shown < 5, out);
  assert.equal(out.split('\n').at(-1), fill(labels.skills.tools.web.more, { count: String(5 - shown) }));
  assert.ok(!webSearchText({ query: 'q', results: results.slice(0, 1) }, { labels }).includes(fill(labels.skills.tools.web.more, { count: '0' })));
});

test('skillResultBlock: a reason with its own values is filled with them', async () => {
  const { skillResultBlock } = await import('../src/behavior/prompt.js');
  const block = skillResultBlock({ skill: 'web.search', status: 'failed', code: 'provider', values: { status: '503' } }, labels);
  assert.ok(block.includes(fill(labels.skills.result.reasons.provider, { status: '503' })), block);
  assert.ok(!block.includes('{status}'), block);
});

/** A recall runner that answers `answer` (what its run resolves) to every search. */
function recallAnswering(answer) {
  return { available: () => true, run: async () => answer };
}

async function memoryWith(answer, args = { question: 'τι είπε η Zoë;', terms: 'λαγός' }) {
  const guild = { id: 'g1' };
  return runMemorySearch({
    recall: recallAnswering(answer),
    store: { listUserProfiles: () => [] },
    config: { bot: { timezone: 'UTC' }, features: { recall: true }, recall: { maxForms: 4 } },
    labels,
    guild,
    guildId: 'g1',
    channel: { id: 'c1', guild },
    args,
    now: NOW,
  });
}

const STRETCH = { channelName: 'jardin', startTs: Date.UTC(2026, 8, 30, 9), lines: '[09:00] Éloïse: ένα κουνέλι' };
const NO_STRETCH = { text: null, stretch: null, people: [], quotes: [] };

test('runMemorySearch: a run that did not search says why instead of "no matching messages"', async () => {
  const cap = await memoryWith({ ...NO_STRETCH, outcome: { kind: 'daily-cap' } });
  assert.deepEqual([cap.status, cap.code, cap.data], ['denied', 'daily-cap', undefined]);
  const hidden = await memoryWith({ ...NO_STRETCH, outcome: { kind: 'not-visible' } });
  assert.deepEqual([hidden.status, hidden.code], ['denied', 'channel-not-visible']);
  const thrown = await memoryWith({ ...NO_STRETCH, outcome: { kind: 'error' } });
  assert.deepEqual([thrown.status, thrown.code], ['failed', 'error']);
  const late = await memoryWith({ ...NO_STRETCH, outcome: { kind: 'timeout' } });
  assert.deepEqual([late.status, late.code], ['failed', 'timeout']);
  const some = await memoryWith({ ...NO_STRETCH, quotes: [STRETCH], outcome: { kind: 'timeout' } });
  assert.deepEqual([some.status, some.code], ['partial', 'timeout']);
  assert.ok(some.data.text.includes(STRETCH.lines), 'the stretches that came back are kept');
});

test('runMemorySearch: an empty search that really ran stays ok with the none label; words only and cut searches are named', async () => {
  const l = labels.skills.tools.memory;
  const none = await memoryWith({ ...NO_STRETCH, outcome: { kind: 'searched', degraded: false, failed: 0, total: 3 } });
  assert.equal(none.status, 'ok');
  assert.equal(none.data.text, [l.source, l.none].join('\n'));
  const plain = await memoryWith({ ...NO_STRETCH });
  assert.equal(plain.data.text, none.data.text, 'a run without an outcome is a plain search');
  const words = await memoryWith({ ...NO_STRETCH, quotes: [STRETCH], outcome: { kind: 'searched', degraded: true, failed: 0, total: 3 } });
  assert.equal(words.status, 'ok');
  assert.equal(words.data.text.split('\n')[0], l.degraded);
  assert.ok(words.data.text.includes(STRETCH.lines));
  const cut = await memoryWith({ ...NO_STRETCH, quotes: [STRETCH], outcome: { kind: 'searched', degraded: false, failed: 2, total: 5 } });
  assert.equal(cut.status, 'ok');
  assert.equal(cut.data.text.split('\n').at(-1), fill(l.partial, { failed: '2', total: '5' }));
  assert.ok(!cut.data.text.includes(l.degraded));
});

test('runMediaLook: a second look that is switched off names the switch', async () => {
  const given = { message: 'm7', question: 'τι;', item: '1' };
  const run = (features, item = '1') => runMediaLook({ describer: fakeDescriber(), config: { ...LOOK_ON, features: { ...LOOK_ON.features, ...features } }, labels, guildId: 'g1', args: { ...given, item }, mediaOf: () => mediaMessage() });
  const picture = await run({ imageRelook: false });
  assert.deepEqual([picture.status, picture.code], ['not_configured', 'not-configured']);
  assert.equal(picture.data.text, fill(labels.skills.tools.look.off, { feature: 'features.imageRelook' }));
  const clip = await run({ videoRewatch: false }, '2');
  assert.equal(clip.data.text, fill(labels.skills.tools.look.off, { feature: 'features.videoRewatch' }));
  const noVision = await run({ videoDescriptions: false, mediaDescriptions: false }, '2');
  assert.equal(noVision.status, 'not_configured');
  assert.ok(noVision.data.text.length > 0, 'the video vision switch is named too');
});

test('memorySearchText: with a registry each quoted line carries a #N handle numbered on, the lines that stayed are registered, a cut line is not', () => {
  const l = labels.skills.tools.memory;
  const entry = (id, text) => ({ id, text, authorId: `u${id}`, self: id === 'm2', message: { id } });
  const quotes = [
    { channelId: 'c1', channelName: 'jardin', startTs: Date.UTC(2026, 8, 30, 9), lines: 'x', entries: [entry('m1', '[09:00] Éloïse: ένα κουνέλι'), entry('m2', '[09:01] Ana: ωραίο')] },
    { channelId: 'c2', channelName: 'general', startTs: Date.UTC(2026, 9, 1, 18), lines: 'y', entries: [entry('m3', '>> [18:44] Βασίλης: το κουνέλι πέθανε')] },
  ];
  const taken = [];
  const refs = { next: () => 85, take: (shown) => taken.push(...shown) };
  assert.equal(memorySearchText(quotes, { labels, timezone: 'UTC', refs }), [
    l.source,
    l.handles,
    fill(l.window, { date: '2026-09-30', channel: 'jardin' }),
    '#85 [09:00] Éloïse: ένα κουνέλι',
    '#86 [09:01] Ana: ωραίο',
    fill(l.window, { date: '2026-10-01', channel: 'general' }),
    '#87 >> [18:44] Βασίλης: το κουνέλι πέθανε',
  ].join('\n'));
  assert.deepEqual(taken.map((ref) => [ref.n, ref.id, ref.channelId, ref.authorId, ref.self]), [[85, 'm1', 'c1', 'um1', false], [86, 'm2', 'c1', 'um2', true], [87, 'm3', 'c2', 'um3', false]]);
  // A stretch cut at windowChars registers only the lines that stayed.
  const cut = [];
  memorySearchText(quotes.slice(0, 1), { labels, timezone: 'UTC', windowChars: 30, refs: { next: () => 10, take: (shown) => cut.push(...shown) } });
  assert.deepEqual(cut.map((ref) => ref.n), [10]);
  // Without a registry the text is as before.
  assert.ok(!memorySearchText(quotes, { labels, timezone: 'UTC' }).includes('#85'));
});
