// Tests for the persona's in-turn tools (src/tools/tools.ts): what a web.search, a web.read and a
// memory.search give back, labelled by source and evidence type, and the statuses of a search
// that cannot run. Fakes only.
import { after, describe, test } from 'node:test';
import assert from 'node:assert/strict';
import {
  findGifs,
  firstLinkIn,
  lookableMedia,
  mediaFind,
  mediaFindText,
  mediaLookText,
  memorySearchText,
  runMediaFind,
  runMediaLook,
  runMemorySearch,
  runWebRead,
  runWebSearch,
  webReadText,
  webSearchText,
} from '../../../src/tools/tools.ts';
import { fill } from '../../../src/format.ts';
import { videoSiteFor, videoUrlCacheKey } from '../../../src/media/video-sites.ts';
import { labels } from '../../fixtures/labels.ts';
import type { Untyped } from '../../../src/tools/types.ts';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDiscordInterface } from '../../../interfaces/discord/index.ts';
import { createFakeAdapter } from '../../../scripts/lib/fake.ts';
import { createAdmin } from '../../../src/admin.ts';
import { createInnerLife } from '../../../src/behavior/inner.ts';
import { personaJournal } from '../../../src/behavior/inner/persona-sources.ts';
import { gifLine, userText } from '../../../src/behavior/prompt.ts';
import { createRecall } from '../../../src/behavior/recall-run.ts';
import { snapshotOf } from '../../../src/behavior/snapshot.ts';
import { createTurnRunner } from '../../../src/behavior/turn.ts';
import { joinLabels } from '../../../src/config/labels.ts';
import { createErrandService } from '../../../src/errands/service.ts';
import { createErrandStores } from '../../../src/errands/store.ts';
import { createErrandTurns } from '../../../src/errands/turns.ts';
import { createEventDoor } from '../../../src/interface/door.ts';
import { createReads } from '../../../src/interface/reads.ts';
import { createFindMeaning } from '../../../src/memory/db/graph-find.ts';
import { channelPlaceId, dmPlaceId } from '../../../src/memory/db/ids.ts';
import { observationOf } from '../../../src/memory/db/observe-event.ts';
import { observe } from '../../../src/memory/db/observe.ts';
import { insertRows } from '../../../src/memory/db/rows.ts';
import { dmScope, groupScope, issueContext, issueContext as issuedContext } from '../../../src/memory/db/scope.ts';
import { findGif, normalizeGifs } from '../../../src/memory/gifs.ts';
import { objectMediaCache } from '../../../src/memory/store-media.ts';
import { skillRegistry } from '../../../src/tools/registry.ts';
import { createLookup, type LookupDeps } from '../../../src/web/lookup.ts';
import { withCapturedLogs } from '../../fixtures/capture-logs.ts';
import { chainsOf } from '../../fixtures/chains.ts';
import { lineEvent } from '../../fixtures/core-over-fake.ts';
import { present, wrongly } from '../../fixtures/loose-types.ts';
import { noMediaNames } from '../../fixtures/media-namer.ts';
import {
  fixture as memoryDbRecallCarrierFixture,
  fixture as memoryDbRecallExclusionsFixture,
  fixture as memorySearchPlaceDayFixture,
  fixture as recallRunBoundariesFixture,
} from '../../fixtures/memory-db-recall.ts';
import { fillEnvAudiences } from '../../fixtures/memory-db/audiences.ts';
import { openTestMemorySync } from '../../fixtures/memory-db/service.ts';
import { personId } from '../../fixtures/memory-db/spelled-ids.ts';
import { ownedBy, OWNER_PERSON } from '../../fixtures/owner-accounts.ts';
import { channel, channel as channelInfo, privateChannel } from '../../fixtures/reads-rig.ts';
import { config } from '../../fixtures/recall-run-kit.ts';
import { tempDir } from '../../fixtures/tmp.ts';
import { call, completionOf, toolAnswer } from '../../fixtures/tool-answers.ts';

// The casts through `Parameters<typeof f>` hand a function a fake that carries only the fields the test reads.

const NOW = Date.UTC(2026, 9, 17, 12);

/** The texts of the in-turn tools in the shipped labels. */
const { tools: TOOL_TEXTS } = labels.tools;

const WEB_ON = { web: { quickSearch: { enabled: true } } };

function fakeLookup({
  found = {
    query: 'q',
    results: [{ title: 'Ο τελικός', url: 'https://www.example.com/a', site: 'example.com', snippet: 'Η Ana κέρδισε.' }],
  },
  capLeft = 5,
  hasSearch = true,
  page = { ok: true, url: 'https://example.com/p', title: 'Σελίδα', text: 'Το κείμενο της σελίδας.', cut: false },
} = {}) {
  const searches: Array<{ placeId: Untyped; query: Untyped }> = [];
  const reads: Array<{ placeId: Untyped; url: Untyped }> = [];
  return {
    searches,
    reads,
    hasSearch: () => hasSearch,
    webCapLeft: () => capLeft,
    searchResults: async (placeId: string, query: unknown) => {
      searches.push({ placeId, query });
      return found ? { ...found, query } : null;
    },
    readPage: async (placeId: string, url: string) => {
      reads.push({ placeId, url });
      return page;
    },
  };
}

test('webSearchText: the query and the evidence type first, what the persona wanted to establish, then each result raw: title, link, site and date, snippet', () => {
  const l = TOOL_TEXTS.web;
  const results = [
    {
      title: 'Ο τελικός',
      url: 'https://www.example.com/a',
      site: 'example.com',
      snippet: 'Η Ana κέρδισε.',
      age: '2026-10-01',
    },
    { title: '', url: 'https://exemple.fr/b', site: 'exemple.fr', snippet: '' },
  ];
  const text = webSearchText({ query: 'τελικός 2026', results }, { goal: 'ποιος κέρδισε', labels });
  assert.equal(
    text,
    [
      fill(l.source, { query: 'τελικός 2026' }),
      fill(l.goal, { goal: 'ποιος κέρδισε' }),
      '1. Ο τελικός',
      'https://www.example.com/a',
      'example.com · 2026-10-01',
      'Η Ana κέρδισε.',
      '2.',
      'https://exemple.fr/b',
      'exemple.fr',
    ].join('\n')
  );
  assert.equal(
    webSearchText({ query: 'x', results: [] }, { labels }),
    [fill(l.source, { query: 'x' }), l.none].join('\n'),
    'nothing found says so'
  );
  assert.equal(
    webSearchText({ query: 'x', results: [{ title: 'bad', url: 'javascript:alert(1)' }] }, { labels }),
    [fill(l.source, { query: 'x' }), l.none].join('\n'),
    'no http(s) link, no result'
  );
});

// A text over its bound is summarized or kept whole, never cut.
// No text the persona reads is cut silently.
test('webSearchText results: duplicates and trackers dropped, titles and links whole, the whole within its cap', () => {
  const long = `https://example.com/${'p'.repeat(400)}`;
  const query = `https://example.net/c?q=${'z'.repeat(400)}`;
  const title = 'Β'.repeat(300);
  const results = [
    { title: 'Α', url: 'https://www.example.com/a/?utm_source=x&id=7#top', snippet: 'α'.repeat(50) },
    { title: 'Α again', url: 'https://example.com/a?id=7', snippet: 'again' },
    { title, url: 'https://example.org/b', snippet: 'β' },
    { title: 'Γ', url: query, snippet: 'γ' },
    { title: 'Δ', url: long, snippet: 'δ' },
  ];
  const lines = webSearchText({ query: 'q', results }, { labels, maxChars: 5000 }).split('\n');
  assert.ok(lines.includes('https://www.example.com/a/?id=7'), 'tracking parameters and the fragment go');
  assert.ok(!lines.some((line) => line === 'again'), 'the same page once');
  assert.ok(lines.includes(`2. ${title}`), 'a long title is whole');
  assert.ok(lines.includes(query), 'a long query string is whole');
  assert.ok(lines.includes(long), 'a long link is whole');
  const capped = webSearchText(
    { query: 'q', results: results.map((r, i) => ({ ...r, url: `https://e${i}.example/`, snippet: 'σ'.repeat(300) })) },
    { labels, maxChars: 500 }
  );
  assert.ok(capped.length <= 500, String(capped.length));
  assert.ok(capped.includes('1. Α') && !capped.includes('5. Δ'), 'the first result shows, the rest stop at the cap');
});

// No text the persona reads is cut silently.
test('webSearchText: a first result whose snippet runs past the room shows its snippet whole, with no ellipsis', () => {
  const snippet = 'ένα μακρύ απόσπασμα για τον κήπο '.repeat(20).trim();
  const out = webSearchText(
    { query: 'κήπος', results: [{ title: 'Κήπος', url: 'https://garden.example/', snippet }] },
    { labels, maxChars: 200 }
  );
  assert.ok(out.split('\n').includes(snippet), out);
});

// A text over its bound is summarized or kept whole, never cut.
test('webReadText: the source, the title, the page text as it is, then read.retold when the page is a retelling', () => {
  // Catches: a retold page shown as if it were the page's own text, or the retelling label on every page.
  const readLabels = {
    tools: {
      tools: { read: { source: 'SOURCE {url} {maxChars}', title: 'TITLE {title}', retold: 'STAND-IN RETOLD' } },
    },
  };
  const page = { url: 'https://example.com/p', title: 'Σελίδα', text: 'Πρώτη γραμμή.\nΔεύτερη.', retold: true };
  assert.equal(
    webReadText(page, { labels: readLabels, maxChars: 4000 }),
    ['SOURCE https://example.com/p 4000', 'TITLE Σελίδα', 'Πρώτη γραμμή.\nΔεύτερη.', 'STAND-IN RETOLD'].join('\n')
  );
  assert.equal(
    webReadText({ ...page, title: '', retold: false }, { labels: readLabels, maxChars: 10 }),
    ['SOURCE https://example.com/p 10', 'Πρώτη γραμμή.\nΔεύτερη.'].join('\n')
  );
});

test('memorySearchText: the source, then each stretch under its day and channel with its lines as they were', () => {
  const l = TOOL_TEXTS.memory;
  const quotes = [
    {
      channelName: 'jardin',
      startTs: Date.UTC(2026, 8, 30, 9),
      lines: '[09:00] Éloïse: ένα κουνέλι\n[09:01] Ana: ωραίο',
    },
    { channelName: 'general', startTs: Date.UTC(2026, 9, 1, 18), lines: '>> [18:44] Βασίλης: το κουνέλι πέθανε' },
  ];
  assert.equal(
    memorySearchText(quotes, { labels, timezone: 'UTC' }),
    [
      l.source,
      fill(l.window, { date: '2026-09-30', channel: 'jardin' }),
      quotes[0].lines,
      fill(l.window, { date: '2026-10-01', channel: 'general' }),
      quotes[1].lines,
    ].join('\n')
  );
  assert.equal(memorySearchText([], { labels }), [l.source, l.none].join('\n'));
});

test('memorySearchText: each stretch is cut on its own, the whole by stretches that fit, and a closing line names the ones left out', () => {
  const l = TOOL_TEXTS.memory;
  const row = (n: number) => `[09:${String(n).padStart(2, '0')}] Ana: ${'α'.repeat(93)}`; // 105 characters with the newline
  const longWindow = Array.from({ length: 19 }, (_, i) => row(i)).join('\n'); // about 2000 characters
  const quotes = Array.from({ length: 10 }, (_, i) => ({
    channelName: `kanali${i}`,
    startTs: Date.UTC(2026, 9, 1 + i, 9),
    lines: longWindow,
  }));
  const out = memorySearchText(quotes, { labels, timezone: 'UTC', windowChars: 1500, maxChars: 10000 });
  const lines = out.split('\n');
  const windows = lines.filter((line) => line.startsWith('2026-10-'));
  assert.equal(windows.length, 6);
  const cutLines = lines.filter((line) => line === fill(l.windowCut, { dropped: '5' }));
  assert.equal(cutLines.length, 6, 'every shown stretch is cut to 14 lines, 5 dropped');
  assert.ok(out.length <= 10000);
  assert.equal(
    lines.at(-1),
    fill(l.windowsLeft, {
      count: '4',
      where: 'kanali6 2026-10-07, kanali7 2026-10-08, kanali8 2026-10-09, kanali9 2026-10-10',
    })
  );
  const whole = memorySearchText(quotes.slice(0, 2), { labels, timezone: 'UTC', windowChars: 1500, maxChars: 9000 });
  assert.ok(!whole.includes(fill(l.windowsLeft, { count: '0', where: '' })));
  assert.equal(whole.split('\n').filter((line) => line.startsWith('2026-10-')).length, 2);
  const short = memorySearchText([{ channelName: 'a', startTs: Date.UTC(2026, 9, 1), lines: 'one\ntwo' }], {
    labels,
    timezone: 'UTC',
  });
  assert.equal(
    short,
    [l.source, fill(l.window, { date: '2026-10-01', channel: 'a' }), 'one\ntwo'].join('\n'),
    'nothing cut, nothing left: no extra line'
  );
});

/** Three results whose snippets are long or short as asked, each on its own page. */
function searchFound(snippets: Array<string>) {
  return {
    query: 'q',
    results: snippets.map((snippet, i) => ({
      title: `T${i}`,
      url: `https://e${i}.example/`,
      site: `e${i}.example`,
      snippet,
    })),
  };
}

/** A summarizer whose answers wait until `release` is called, recording when each call starts. */
function heldSummarize(answerOf: (text: string) => string) {
  const calls: Array<{ text: string; options: { maxChars: number; kind: 'text' } }> = [];
  const waiting: Array<() => void> = [];
  const summarize = (text: string, options: { maxChars: number; kind: 'text' }): Promise<string> => {
    calls.push({ text, options });
    return new Promise((resolve) => waiting.push(() => resolve(answerOf(text))));
  };
  const release = () => {
    for (const go of waiting.splice(0)) go();
  };
  return { calls, summarize, release };
}

/** A web.search over `found` with `summarize`, its text once it settles. */
async function searchText(found: ReturnType<typeof searchFound>, summarize: unknown): Promise<string> {
  const result = await runWebSearch({
    lookup: fakeLookup({ found }),
    config: WEB_ON,
    labels,
    placeId: 'g1',
    args: { query: 'q' },
    summarize,
  } as unknown as Parameters<typeof runWebSearch>[0]);
  return result.data?.text ?? '';
}

const passThrough = (text: string, options: { maxChars: number; kind: 'text' }): Promise<string> =>
  Promise.resolve(Array.from(text).length > options.maxChars ? `SUMMARY of ${text.length}` : text);

// A text over its bound is summarized or kept whole, never cut.
test('runWebSearch: the snippets over 400 characters go to summarize side by side, each answered by its summary', async () => {
  // Catches: snippets cut at 400 with an ellipsis, or summarized one after another so a search waits three times.
  const long = (n: number) => `${'λέξη '.repeat(100)}${n}`;
  const held = heldSummarize((text) => `SUMMARY ${text.slice(-1)}`);
  const pending = searchText(searchFound([long(1), long(2), long(3)]), held.summarize);
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(held.calls.length, 3, 'all three started before the first was answered');
  held.release();
  const text = await pending;
  assert.deepEqual(
    held.calls.map(({ options }) => options),
    [1, 2, 3].map(() => ({ maxChars: 400, kind: 'text' }))
  );
  assert.ok(
    held.calls.every(({ text: given }, i) => given === long(i + 1)),
    'each whole snippet goes to the summarizer'
  );
  for (const n of [1, 2, 3]) assert.ok(text.includes(`SUMMARY ${n}`), text);
  assert.ok(!text.includes('λέξη λέξη'), 'no long snippet itself');
});

// A text over its bound is summarized or kept whole, never cut.
test('runWebSearch: a snippet within 400 characters is shown as it is', async () => {
  // Catches: a short snippet rewritten.
  const snippet = 'λέξη '.repeat(70).trim();
  assert.ok((await searchText(searchFound([snippet]), passThrough)).includes(snippet));
});

// A text over its bound is summarized or kept whole, never cut.
test('runWebSearch: a summary still over 400 characters, and a long snippet with no summarizer, are shown whole', async () => {
  // Catches: a summary or a snippet cut at the bound.
  const longer = `${'σύνοψη '.repeat(80)}τέλος`;
  const snippet = `${'λέξη '.repeat(100)}τέλος`;
  const over = (): Promise<string> => Promise.resolve(longer);
  assert.ok((await searchText(searchFound([snippet]), over)).includes(longer));
  assert.ok((await searchText(searchFound([snippet]), undefined)).includes(snippet));
});

test("runWebSearch: the persona's query goes to the raw search as written, the results are cut at the snippet length; the statuses of a search that cannot run", async () => {
  const lookup = fakeLookup();
  const ok = await runWebSearch({
    lookup,
    config: WEB_ON,
    labels,
    placeId: 'g1',
    args: { query: '  τελικός 2026 ', goal: 'ποιος' },
  } as unknown as Parameters<typeof runWebSearch>[0]);
  assert.equal(ok.status, 'ok');
  assert.deepEqual(lookup.searches, [{ placeId: 'g1', query: 'τελικός 2026' }]);
  const { data: okData } = ok;
  assert.ok(okData?.text.startsWith(fill(TOOL_TEXTS.web.source, { query: 'τελικός 2026' })), okData?.text ?? '');
  assert.ok(okData?.text.includes('https://www.example.com/a'), okData?.text ?? '');
  const status = async (overrides: Untyped) => {
    const result = await runWebSearch({
      lookup: fakeLookup(overrides.lookup),
      config: overrides.config ?? WEB_ON,
      labels,
      placeId: 'g1',
      args: overrides.args ?? { query: 'x' },
    } as unknown as Parameters<typeof runWebSearch>[0]);
    return [result.status, result.code];
  };
  assert.deepEqual(await status({ args: {} }), ['invalid', 'invalid-args']);
  assert.deepEqual(await status({ lookup: { found: { failed: { code: 'not-configured', reason: 'no-engine' } } } }), [
    'not_configured',
    'not-configured',
  ]);
  assert.deepEqual(await status({ lookup: { found: null } }), ['failed', 'error']);
  assert.deepEqual(
    (await runWebSearch({ lookup: null, config: WEB_ON, labels, placeId: 'g1', args: { query: 'x' } })).status,
    'not_configured'
  );
});

test('runWebRead: a link, or the link of a message, goes to the page reader; the text comes back under its source; the statuses', async () => {
  const lookup = fakeLookup();
  const ok = await runWebRead({
    lookup,
    config: WEB_ON,
    labels,
    placeId: 'g1',
    args: { url: ' https://example.com/p ' },
  } as unknown as Parameters<typeof runWebRead>[0]);
  assert.equal(ok.status, 'ok');
  assert.deepEqual(lookup.reads, [{ placeId: 'g1', url: 'https://example.com/p' }]);
  assert.equal(
    ok.data?.text,
    [
      // The page reader reads 4000 characters.
      fill(TOOL_TEXTS.read.source, { url: 'https://example.com/p', maxChars: '4000' }),
      fill(TOOL_TEXTS.read.title, { title: 'Σελίδα' }),
      'Το κείμενο της σελίδας.',
    ].join('\n')
  );
  const byMessage = fakeLookup();
  const asked: Array<string> = [];
  const viaMessage = await runWebRead({
    lookup: byMessage,
    config: WEB_ON,
    labels,
    placeId: 'g1',
    args: { message: 'm7' },
    linkOf: async (id: string) => (asked.push(id), 'https://exemple.fr/x'),
  } as unknown as Parameters<typeof runWebRead>[0]);
  assert.equal(viaMessage.status, 'ok');
  assert.deepEqual([asked, byMessage.reads.map((read) => read.url)], [['m7'], ['https://exemple.fr/x']]);
  const status = async ({
    lookup: over,
    config = WEB_ON,
    args = { url: 'https://example.com/p' },
    linkOf = () => null,
  }: Record<string, Untyped> = {}) => {
    const result = await runWebRead({
      lookup: over === null ? null : fakeLookup(over),
      config,
      labels,
      placeId: 'g1',
      args,
      linkOf,
    } as unknown as Parameters<typeof runWebRead>[0]);
    return [result.status, result.code];
  };
  assert.deepEqual(await status({ args: {} }), ['invalid', 'invalid-args']);
  assert.deepEqual(await status({ args: { message: 'm1' } }), ['invalid', 'no-link'], 'a message without a link');
  assert.deepEqual(await status({ lookup: null }), ['not_configured', 'not-configured']);
  assert.deepEqual(await status({ lookup: { page: { ok: false, reason: 'private' } } }), ['failed', 'private']);
  assert.deepEqual(await status({ lookup: { page: { ok: false, reason: 'scheme' } } }), ['invalid', 'scheme']);
  const empty = await runWebRead({
    lookup: fakeLookup({ page: { ok: false, reason: 'empty' } } as unknown as Parameters<typeof fakeLookup>[0]),
    config: WEB_ON,
    labels,
    placeId: 'g1',
    args: { url: 'https://example.com/e' },
  } as unknown as Parameters<typeof runWebRead>[0]);
  assert.equal(empty.status, 'ok');
  const { data: emptyData } = empty;
  assert.ok(emptyData?.text.endsWith(TOOL_TEXTS.read.none), emptyData?.text ?? '');
});

test("runMemorySearch: the persona's arguments become the server part (no helper), recall runs over the turn history; the statuses", async () => {
  const runs: Array<Untyped> = [];
  const recall = {
    available: () => true,
    run: async (args: unknown) => {
      runs.push(args);
      return {
        text: null,
        stretch: null,
        people: [],
        quotes: [{ channelName: 'jardin', startTs: Date.UTC(2026, 8, 30, 9), lines: '[09:00] Éloïse: ένα κουνέλι' }],
      };
    },
  };
  const root = { id: 'g1' };
  // The chat is the interface's info now: a chat of a root says which.
  const channel = { id: 'c1', rootId: 'g1', root };
  const history = [{ id: 'h1' }];
  const decorate = (lines: unknown) => lines;
  const store = { listUserProfiles: () => [{ id: 'u3', names: ['Éloïse'], aliases: [] }] };
  const config = { bot: { timezone: 'UTC' }, features: { recall: true }, recall: { maxForms: 4 } };
  const result = await runMemorySearch({
    recall,
    store,
    config,
    labels,
    // @ts-expect-error: the scene passes a root key the options type does not name
    root,
    placeId: 'g1',
    channel,
    selfId: 'self',
    selfName: 'Zoë',
    history,
    decorate,
    args: { question: 'τι είπε η Éloïse για το κουνέλι;', terms: 'λαγός', placeId: 'c2' },
    now: NOW,
  });
  assert.equal(result.status, 'ok');
  const { data: resultData } = result;
  assert.ok(resultData?.text.includes('[09:00] Éloïse: ένα κουνέλι'), resultData?.text ?? '');
  assert.equal(runs.length, 1);
  const [run] = runs;
  assert.deepEqual(run.server, { forms: ['λαγός', 'κουνέλι'], who: ['éloïse'], from: null, to: null, placeId: 'c2' });
  assert.deepEqual(
    [run.history, run.decorate, run.candidate.content],
    [history, decorate, 'τι είπε η Éloïse για το κουνέλι;']
  );
  const status = async (overrides: Record<string, unknown>) => {
    const out = await runMemorySearch({
      recall,
      store,
      config,
      labels,
      // @ts-expect-error: the scene passes a root key the options type does not name
      root,
      placeId: 'g1',
      channel,
      args: { question: 'τι;' },
      now: NOW,
      ...overrides,
    });
    return [out.status, out.code];
  };
  assert.deepEqual(await status({}), ['invalid', 'no-query'], 'nothing left to search');
  assert.deepEqual(await status({ recall: null }), ['not_configured', 'not-configured']);
  assert.deepEqual(await status({ recall: { ...recall, available: () => false } }), [
    'not_configured',
    'not-configured',
  ]);
  assert.deepEqual(await status({ root: null, channel: { id: 'dm1', root: null } }), ['not_configured', 'unsupported']);
});

test('firstLinkIn: the first http(s) link written in a text, up to a space or an angle bracket; null without one', () => {
  assert.equal(firstLinkIn('δες <https://exemple.fr/άρθρο?a=1> και http://b.example'), 'https://exemple.fr/άρθρο?a=1');
  assert.equal(firstLinkIn('ftp://x.example and www.example.com'), null);
  assert.equal(firstLinkIn(undefined), null);
});

// media.look: the persona's own second look at a picture or a video, through the describer's second-look path.

const LOOK_ON = {
  features: { vision: true, mediaDescriptions: true, videoDescriptions: true, coreTools: true },
  media: { video: { sites: ['youtube.com'] } },
};

/** A normalized message with a picture, a GIF embed, a video attachment and a video-site link. */
function mediaMessage() {
  return {
    id: 'm7',
    content: 'δες',
    attachments: [
      { id: 'pa', kind: 'image', url: 'https://cdn.example.com/a.png', name: 'a.png' },
      {
        id: 'va',
        kind: 'video',
        url: 'https://cdn.example.com/clip.mp4',
        name: 'clip.mp4',
        durationSec: 12,
        size: 1000,
      },
    ],
    links: [
      {
        id: 'm7#e0',
        kind: 'gif',
        url: 'https://tenor.com/x',
        site: 'Tenor',
        title: '',
        thumbnailUrl: 'https://media.tenor.com/x.png',
        animationUrl: 'https://media.tenor.com/x.mp4',
      },
      { id: 'm7#e1', kind: 'video', url: 'https://youtube.com/watch?v=abc', site: 'YouTube', title: 'Μια ταινία' },
    ],
    stickers: [],
  };
}

function fakeDescriber({ answer = 'ένα κόκκινο ποδήλατο', caps = null }: Record<string, Untyped> = {}) {
  const calls: Array<{ method: Untyped; placeId: Untyped; itemId: Untyped; question: Untyped }> = [];
  const second = (method: string) => async (placeId: string, item: Untyped, question: unknown) => {
    calls.push({ method, placeId, itemId: item.itemId, question });
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
  assert.deepEqual(
    media.map(({ kind, item }) => `${kind}:${item.itemId}`),
    ['image:pa', 'video:va', 'gif:m7#e0', 'video:m7#e1']
  );
  assert.deepEqual(
    lookableMedia(mediaMessage()).map(({ kind }) => kind),
    ['image', 'video', 'gif'],
    'no video site: the link is no video'
  );
  assert.deepEqual(lookableMedia({ id: 'm1', content: 'τίποτα', attachments: [], links: [], stickers: [] }), []);
  assert.deepEqual(lookableMedia(null), []);
});

test('mediaLookText: the image or the video model named as the source with what was asked, then its answer as it gave it', () => {
  const l = TOOL_TEXTS.look;
  assert.equal(
    mediaLookText({ kind: 'image', name: 'a.png', question: 'τι χρώμα;', text: 'κόκκινο' }, { labels }),
    [fill(l.image, { name: 'a.png', question: 'τι χρώμα;' }), 'κόκκινο'].join('\n')
  );
  assert.equal(
    mediaLookText({ kind: 'video', name: 'clip.mp4', question: 'ποιος μιλά;', text: 'η Zoë' }, { labels }),
    [fill(l.video, { name: 'clip.mp4', question: 'ποιος μιλά;' }), 'η Zoë'].join('\n')
  );
  assert.equal(
    mediaLookText({ kind: 'gif', name: 'Tenor', question: 'τι κάνει;', text: 'χορεύει' }, { labels }),
    [fill(l.video, { name: 'Tenor', question: 'τι κάνει;' }), 'χορεύει'].join('\n'),
    'a GIF is watched as a clip'
  );
  assert.equal(
    mediaLookText({ kind: 'image', name: 'a.png', question: 'q', text: 'απάντηση' }, { labels: {} }),
    'απάντηση',
    'a missing label adds nothing'
  );
});

test("runMediaLook: the persona's question goes to the second look of the item they name, the answer comes back labelled; the first item by default", async () => {
  const describer = fakeDescriber();
  const asked: Array<Untyped> = [];
  const mediaOf = (id: string) => (asked.push(id), id === 'm7' ? mediaMessage() : null);
  const first = await runMediaLook({
    describer,
    config: LOOK_ON,
    labels,
    placeId: 'g1',
    args: { message: 'm7', question: ' τι κρατά; ' },
    mediaOf,
  } as unknown as Parameters<typeof runMediaLook>[0]);
  assert.equal(first.status, 'ok');
  assert.deepEqual(describer.calls, [{ method: 'relookImage', placeId: 'g1', itemId: 'pa', question: 'τι κρατά;' }]);
  assert.equal(
    first.data?.text,
    mediaLookText({ kind: 'image', name: 'a.png', question: 'τι κρατά;', text: 'ένα κόκκινο ποδήλατο' }, { labels })
  );
  for (const [item, method, itemId] of [
    [2, 'rewatchVideo', 'va'],
    ['3', 'rewatchGif', 'm7#e0'],
    [4, 'rewatchVideo', 'm7#e1'],
  ]) {
    const one = fakeDescriber();
    const result = await runMediaLook({
      describer: one,
      config: LOOK_ON,
      labels,
      placeId: 'g1',
      args: { message: 'm7', question: 'τι;', item },
      mediaOf,
    } as unknown as Parameters<typeof runMediaLook>[0]);
    assert.equal(result.status, 'ok', `item ${item}`);
    assert.deepEqual(
      one.calls.map((call) => [call.method, call.itemId]),
      [[method, itemId]]
    );
  }
  assert.deepEqual([...new Set(asked)], ['m7']);
});

test('runMediaLook: the statuses -- arguments, message, media, the turn cap and a describer that gives nothing', async () => {
  const run = async ({
    args = { message: 'm7', question: 'τι;' },
    config = LOOK_ON,
    describer = fakeDescriber(),
    message = mediaMessage(),
    takeTurnSlot = undefined,
  }: Record<string, Untyped> = {}) => {
    const result = await runMediaLook({
      describer,
      config,
      labels,
      placeId: 'g1',
      args,
      mediaOf: () => message,
      ...(takeTurnSlot ? { takeTurnSlot } : {}),
    });
    return [result.status, result.code];
  };
  assert.deepEqual(await run({ args: { question: 'τι;' } }), ['invalid', 'invalid-args']);
  assert.deepEqual(await run({ args: { message: 'm7' } }), ['invalid', 'invalid-args']);
  assert.deepEqual(await run({ message: null }), ['invalid', 'unknown-message']);
  assert.deepEqual(await run({ message: { id: 'm7', content: 'κείμενο', attachments: [], links: [], stickers: [] } }), [
    'invalid',
    'no-media',
  ]);
  assert.deepEqual(await run({ args: { message: 'm7', question: 'τι;', item: 9 } }), ['invalid', 'invalid-args']);
  assert.deepEqual(await run({ describer: null }), ['not_configured', 'not-configured']);
  // The turn's own cap: the slot is taken only once every other check passed.
  let slots = 1;
  const takeTurnSlot = () => (slots > 0 ? ((slots -= 1), true) : false);
  assert.deepEqual(await run({ args: { question: 'τι;' }, takeTurnSlot }), ['invalid', 'invalid-args']);
  assert.equal(slots, 1, 'a refused look takes no slot of the turn');
  assert.deepEqual(await run({ takeTurnSlot }), ['ok', undefined]);
  assert.deepEqual(await run({ takeTurnSlot }), ['failed', 'turn-cap']);
  assert.deepEqual(
    await run({ describer: fakeDescriber({ answer: null }) }),
    ['failed', 'error'],
    'the describer gave nothing back'
  );
  const throwing = {
    relookImage: async () => {
      throw new Error('boom');
    },
  };
  assert.deepEqual(await run({ describer: throwing }), ['failed', 'error']);
});

test('runMediaLook url: a video link of a listed site goes to the video second look as a link item, with the question', async () => {
  const describer = fakeDescriber({ answer: 'ένα τραγούδι' });
  const config = { ...LOOK_ON, media: { video: { sites: ['youtube.com', 'tiktok.com'] } } };
  const url = 'https://www.youtube.com/watch?v=abc123&t=5';
  const result = await runMediaLook({
    describer,
    config,
    labels,
    placeId: 'g1',
    args: { url, question: ' τι ακούγεται; ' },
    mediaOf: () => {
      throw new Error('no message is read');
    },
  } as unknown as Parameters<typeof runMediaLook>[0]);
  assert.equal(result.status, 'ok');
  assert.deepEqual(describer.calls, [
    { method: 'rewatchVideo', placeId: 'g1', itemId: videoUrlCacheKey(url), question: 'τι ακούγεται;' },
  ]);
  assert.equal(
    result.data?.text,
    mediaLookText({ kind: 'video', name: url, question: 'τι ακούγεται;', text: 'ένα τραγούδι' }, { labels })
  );
  let seen = null;
  const spy = {
    rewatchVideo: async (placeId: string, item: unknown, question: unknown) => {
      seen = item;
      return { question, text: 'x' };
    },
  };
  const { sites: videoSites } = config.media.video;
  await runMediaLook({
    describer: spy,
    config,
    labels,
    placeId: 'g1',
    args: { url, question: 'q' },
    mediaOf: null,
  } as unknown as Parameters<typeof runMediaLook>[0]);
  assert.deepEqual(seen, {
    source: 'link',
    messageId: null,
    itemId: videoUrlCacheKey(url),
    kind: 'link',
    url,
    site: videoSiteFor(url, videoSites),
    name: url,
    durationSec: null,
  });
});

test('runMediaLook url: a link off the site list is refused as not-video-site and the result names the sites; nothing is fetched', async () => {
  const describer = fakeDescriber();
  const config = { ...LOOK_ON, media: { video: { sites: ['youtube.com', 'tiktok.com'] } } };
  const result = await runMediaLook({
    describer,
    config,
    labels,
    placeId: 'g1',
    args: { url: 'https://example.com/clip.mp4', question: 'τι;' },
    mediaOf: null,
  } as unknown as Parameters<typeof runMediaLook>[0]);
  assert.deepEqual([result.status, result.code], ['invalid', 'not-video-site']);
  assert.equal(result.data?.text, fill(TOOL_TEXTS.look.notVideoSite, { sites: 'youtube.com, tiktok.com' }));
  assert.deepEqual(describer.calls, []);
});

test('runMediaLook url: exactly one of message and url; an unparseable or non-http url is invalid-args', async () => {
  const run = (args: unknown) =>
    runMediaLook({
      describer: fakeDescriber(),
      config: LOOK_ON,
      labels,
      placeId: 'g1',
      args,
      mediaOf: () => mediaMessage(),
    } as unknown as Parameters<typeof runMediaLook>[0]).then((r) => [r.status, r.code, r.reason]);
  assert.deepEqual(await run({ message: 'm7', url: 'https://youtube.com/watch?v=abc', question: 'τι;' }), [
    'invalid',
    'invalid-args',
    'args.url|message:one',
  ]);
  assert.deepEqual(await run({ question: 'τι;' }), ['invalid', 'invalid-args', 'args.url|message:one']);
  assert.deepEqual(await run({ url: 'not a url', question: 'τι;' }), ['invalid', 'invalid-args', 'args.url:bad']);
  assert.deepEqual(await run({ url: 'ftp://youtube.com/watch?v=abc', question: 'τι;' }), [
    'invalid',
    'invalid-args',
    'args.url:bad',
  ]);
  assert.deepEqual(await run({ url: 'https://youtube.com/watch?v=abc' }), [
    'invalid',
    'invalid-args',
    'args.question:required',
  ]);
});

test('runMediaLook url: a video link has the turn cap the message looks have, the turn count shared', async () => {
  const given = { url: 'https://youtube.com/watch?v=abc', question: 'τι;' };
  const run = ({
    describer = fakeDescriber(),
    config = LOOK_ON,
    takeTurnSlot,
    args = given,
  }: Record<string, Untyped> = {}) =>
    runMediaLook({
      describer,
      config,
      labels,
      placeId: 'g1',
      args,
      mediaOf: () => mediaMessage(),
      ...(takeTurnSlot ? { takeTurnSlot } : {}),
    }).then((r) => [r.status, r.code]);
  assert.deepEqual(await run({ describer: null }), ['not_configured', 'not-configured']);
  // One per-turn count for both kinds of look.
  let slots = 1;
  const takeTurnSlot = () => (slots > 0 ? ((slots -= 1), true) : false);
  assert.deepEqual(await run({ args: { message: 'm7', question: 'τι;' }, takeTurnSlot }), ['ok', undefined]);
  assert.deepEqual(await run({ takeTurnSlot }), ['failed', 'turn-cap']);
  slots = 1;
  assert.deepEqual(await run({ takeTurnSlot }), ['ok', undefined]);
  assert.deepEqual(await run({ args: { message: 'm7', question: 'τι;' }, takeTurnSlot }), ['failed', 'turn-cap']);
  assert.deepEqual(await run({ describer: fakeDescriber({ answer: null }) }), ['failed', 'error']);
});

// A second look the provider cut twice tells the persona why instead of handing them half an answer.
test('runMediaLook: a second look that came back failed "filter" is the error failure with the reason "filter"', async () => {
  const describer = {
    relookImage: (placeId: string, item: Untyped, question: string) => Promise.resolve({ question, failed: 'filter' }),
  };
  const result = await runMediaLook({
    describer,
    config: LOOK_ON,
    labels,
    placeId: 'g1',
    args: { message: 'm7', question: 'τι γράφει;' },
    mediaOf: (id: string) => (id === 'm7' ? mediaMessage() : null),
  } as unknown as Parameters<typeof runMediaLook>[0]);
  assert.deepEqual([result.status, result.code, result.reason], ['failed', 'error', 'filter']);
});

test('runMediaLook: a placeholder of a deleted message is refused as unknown-message with the reason message-deleted', async () => {
  const result = await runMediaLook({
    describer: {},
    config: LOOK_ON,
    labels,
    placeId: 'g1',
    args: { message: 'm7', question: 'τι;' },
    mediaOf: () => ({ id: 'm7', deleted: true, attachments: [] }),
  });
  assert.deepEqual([result.status, result.code, result.reason], ['invalid', 'unknown-message', 'message-deleted']);
});

// A tool that did not do what it was asked says so, and none of these outcomes reads as an empty success.

test("runWebSearch: the lookup's coded failures reach the persona as what they are; an empty search that ran stays ok with the none label", async () => {
  const via = async (failed: unknown) =>
    runWebSearch({
      lookup: fakeLookup({ found: { failed } } as unknown as Parameters<typeof fakeLookup>[0]),
      config: WEB_ON,
      labels,
      placeId: 'g1',
      args: { query: 'q' },
    } as unknown as Parameters<typeof runWebSearch>[0]);
  assert.deepEqual(await via({ code: 'provider', status: 503 }), {
    status: 'failed',
    code: 'provider',
    values: { feature: 'quick-search', reason: '', status: '503' },
  });
  assert.deepEqual(await via({ code: 'provider' }), {
    status: 'failed',
    code: 'provider',
    values: { feature: 'quick-search', reason: '', status: '' },
  });
  assert.deepEqual(await via({ code: 'cap' }), { status: 'failed', code: 'cap', values: { what: 'search' } });
  assert.deepEqual(await via({ code: 'empty-query' }), { status: 'invalid', code: 'empty-query' });
  assert.deepEqual(await via({ code: 'not-configured' }), {
    status: 'not_configured',
    code: 'not-configured',
    values: { feature: 'quick-search', reason: '' },
  });
  const none = await runWebSearch({
    lookup: fakeLookup({ found: { results: [] } } as unknown as Parameters<typeof fakeLookup>[0]),
    config: WEB_ON,
    labels,
    placeId: 'g1',
    args: { query: 'q' },
  } as unknown as Parameters<typeof runWebSearch>[0]);
  assert.equal(none.status, 'ok');
  const { data: noneData } = none;
  assert.ok(noneData?.text.endsWith(TOOL_TEXTS.web.none), noneData?.text ?? '');
});

test('webSearchText: results left out for room are counted in a closing line', () => {
  const results = Array.from({ length: 5 }, (_, i) => ({
    title: `Τίτλος ${i}`,
    url: `https://example.com/${i}`,
    site: 'example.com',
    snippet: 'κείμενο',
  }));
  const out = webSearchText({ query: 'q', results }, { labels, maxChars: 190 });
  const shown = out.split('\n').filter((line) => /^\d+\. /.test(line)).length;
  assert.ok(shown >= 1 && shown < 5, out);
  assert.equal(out.split('\n').at(-1), fill(TOOL_TEXTS.web.more, { count: String(5 - shown) }));
  assert.ok(
    !webSearchText({ query: 'q', results: results.slice(0, 1) }, { labels }).includes(
      fill(TOOL_TEXTS.web.more, { count: '0' })
    )
  );
});

/** A recall runner that answers `answer` (what its run resolves) to every search. */
function recallAnswering(answer: unknown) {
  return { available: () => true, run: async () => answer };
}

async function memoryWith(answer: unknown, args = { question: 'τι είπε η Zoë;', terms: 'λαγός' }) {
  const root = { id: 'g1' };
  return runMemorySearch({
    recall: recallAnswering(answer),
    store: { listUserProfiles: () => [] },
    config: { bot: { timezone: 'UTC' }, features: { recall: true }, recall: { maxForms: 4 } },
    labels,
    root,
    placeId: 'g1',
    channel: { id: 'c1', rootId: 'g1', root },
    args,
    now: NOW,
  } as unknown as Parameters<typeof runMemorySearch>[0]);
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
  const { data: someData } = some;
  assert.ok(someData?.text.includes(STRETCH.lines), 'the stretches that came back are kept');
});

test('runMemorySearch: an empty search that really ran stays ok with the none label; words only and cut searches are named', async () => {
  const l = TOOL_TEXTS.memory;
  const none = await memoryWith({ ...NO_STRETCH, outcome: { kind: 'searched', degraded: false, failed: 0, total: 3 } });
  assert.equal(none.status, 'ok');
  assert.equal(none.data?.text, [l.source, l.none].join('\n'));
  const plain = await memoryWith({ ...NO_STRETCH });
  assert.equal(plain.data?.text, none.data?.text, 'a run without an outcome is a plain search');
  const words = await memoryWith({
    ...NO_STRETCH,
    quotes: [STRETCH],
    outcome: { kind: 'searched', degraded: true, failed: 0, total: 3 },
  });
  assert.equal(words.status, 'ok');
  const { data: wordsData } = words;
  assert.equal(wordsData?.text.split('\n')[0], l.degraded);
  assert.ok(wordsData?.text.includes(STRETCH.lines));
  const cut = await memoryWith({
    ...NO_STRETCH,
    quotes: [STRETCH],
    outcome: { kind: 'searched', degraded: false, failed: 2, total: 5 },
  });
  assert.equal(cut.status, 'ok');
  const { data: cutData } = cut;
  assert.equal(cutData?.text.split('\n').at(-1), fill(l.partial, { failed: '2', total: '5' }));
  assert.ok(!cutData?.text.includes(l.degraded));
});

test('memorySearchText: with a registry each quoted line carries a #N handle numbered on, the lines that stayed are registered, a cut line is not', () => {
  const l = TOOL_TEXTS.memory;
  const entry = (id: string, text: string) => ({ id, text, authorId: `u${id}`, self: id === 'm2', message: { id } });
  const quotes = [
    {
      placeId: 'c1',
      channelName: 'jardin',
      startTs: Date.UTC(2026, 8, 30, 9),
      lines: 'x',
      entries: [entry('m1', '[09:00] Éloïse: ένα κουνέλι'), entry('m2', '[09:01] Ana: ωραίο')],
    },
    {
      placeId: 'c2',
      channelName: 'general',
      startTs: Date.UTC(2026, 9, 1, 18),
      lines: 'y',
      entries: [entry('m3', '>> [18:44] Βασίλης: το κουνέλι πέθανε')],
    },
  ];
  const taken: Array<Untyped> = [];
  const refs = { next: () => 85, take: (shown: Untyped) => taken.push(...shown) };
  assert.equal(
    memorySearchText(quotes, { labels, timezone: 'UTC', refs }),
    [
      l.source,
      l.handles,
      fill(l.window, { date: '2026-09-30', channel: 'jardin' }),
      '#85 [09:00] Éloïse: ένα κουνέλι',
      '#86 [09:01] Ana: ωραίο',
      fill(l.window, { date: '2026-10-01', channel: 'general' }),
      '#87 >> [18:44] Βασίλης: το κουνέλι πέθανε',
    ].join('\n')
  );
  assert.deepEqual(
    taken.map((ref) => [ref.n, ref.id, ref.placeId, ref.authorId, ref.self]),
    [
      [85, 'm1', 'c1', 'um1', false],
      [86, 'm2', 'c1', 'um2', true],
      [87, 'm3', 'c2', 'um3', false],
    ]
  );
  // A stretch cut at windowChars registers only the lines that stayed.
  const cut: Array<{ [x: string]: unknown }> = [];
  memorySearchText(quotes.slice(0, 1), {
    labels,
    timezone: 'UTC',
    windowChars: 30,
    refs: { next: () => 10, take: (shown) => cut.push(...shown) },
  });
  assert.deepEqual(
    cut.map((ref) => ref.n),
    [10]
  );
  // Without a registry the text is as before.
  assert.ok(!memorySearchText(quotes, { labels, timezone: 'UTC' }).includes('#85'));
});

test('runMemorySearch lists each episode the search found under its date, after the stored facts', async () => {
  // Bug: the episodes a search found by meaning never reach the persona, or reach them without when they happened.
  const root = { id: 'g1' };
  const shipped = labels.tools;
  const memory = {
    facts: 'Facts:',
    fact: '- {text}',
    episode: '- moment of {date}: {text}',
  };
  const result = await runMemorySearch({
    recall: recallAnswering({
      ...NO_STRETCH,
      quotes: [STRETCH],
      assertions: [{ text: 'likes tea', state: 'current', polarity: 'positive' }],
      episodes: [{ id: 'ep:1', date: '2026-10-30', text: 'danced at the party' }],
      outcome: { kind: 'searched' },
    }),
    store: { listUserProfiles: () => [] },
    config: { bot: { timezone: 'UTC' }, features: { recall: true }, recall: { maxForms: 4 } },
    labels: { ...labels, tools: { ...shipped, tools: { ...shipped.tools, memory } } },
    root,
    placeId: 'g1',
    channel: { id: 'c1', rootId: 'g1', root },
    args: { question: 'what happened at the party', terms: 'party' },
    now: NOW,
  } as unknown as Parameters<typeof runMemorySearch>[0]);
  const text = result.data?.text ?? '';
  const lines = text.split('\n');
  const fact = lines.indexOf('- likes tea');
  assert.ok(fact >= 0, 'the fact is listed');
  assert.equal(lines[fact + 1], '- moment of 2026-10-30: danced at the party');
});

test('memory.search names the person of each found episode that has one', async () => {
  // Bug: the moments of two people stand one after another with no name, and one reads as the other's.
  const shipped = labels.tools;
  const memory = { episode: '- {date}: {text}', episodeWith: '- {date} {who}: {text}' };
  const root = { id: 'g1' };
  const result = await runMemorySearch({
    recall: recallAnswering({
      ...NO_STRETCH,
      quotes: [STRETCH],
      episodes: [
        { id: 'ep:1', date: '2026-10-30', text: 'ΧΟΡΟΣ', who: '@ua' },
        { id: 'ep:2', date: '2026-10-31', text: 'ΤΡΑΓΟΥΔΙ', who: '@ub' },
        { id: 'ep:3', date: '2026-11-01', text: 'ΓΙΟΡΤΗ', who: null },
      ],
      outcome: { kind: 'searched' },
    }),
    store: { listUserProfiles: () => [] },
    config: { bot: { timezone: 'UTC' }, features: { recall: true }, recall: { maxForms: 4 } },
    labels: { ...labels, tools: { ...shipped, tools: { ...shipped.tools, memory } } },
    root,
    placeId: 'g1',
    channel: { id: 'c1', rootId: 'g1', root },
    args: { question: 'what happened at the party', terms: 'party' },
    now: NOW,
  } as unknown as Parameters<typeof runMemorySearch>[0]);
  const lines = (result.data?.text ?? '').split('\n');
  const lineOf = (word: string): string => lines.find((one) => one.includes(word)) ?? '';
  assert.ok(lineOf('ΧΟΡΟΣ').includes('@ua') && !lineOf('ΧΟΡΟΣ').includes('@ub'), lines.join('\n'));
  assert.ok(lineOf('ΤΡΑΓΟΥΔΙ').includes('@ub') && !lineOf('ΤΡΑΓΟΥΔΙ').includes('@ua'), lines.join('\n'));
  assert.doesNotMatch(lineOf('ΓΙΟΡΤΗ'), /@/);
});

/** The memory database of each data directory used here (a restart opens the same one); closed when the file is done. */
const MEMORY = new Map<string, ReturnType<typeof openTestMemorySync>>();

after(async () => {
  for (const { close } of MEMORY.values()) await close();
});

function memoryOf(dataDir: string) {
  if (!MEMORY.has(dataDir)) MEMORY.set(dataDir, openTestMemorySync({ dataDir }));
  return present(MEMORY.get(dataDir)).memoryDb;
}

const DISCORD = createDiscordInterface().capabilities;

const NOW0 = Date.parse('2026-10-19T12:00:00Z');

const GUILD = 'g1';

const SELF = 'self-id';

const SILENT = { info() {}, warn() {}, error() {} };

const INNER_TASK = 'Nobody wrote to you; read the wake block.';

const clock = { t: NOW0 };

/** A model call that never returns: the process dies there. */
const HANG = Symbol('hang');

// ---- the chat: what survives a "death" (the chats, the model, the log of what was asked) ----

/**
 * The chat world: a fake port holding every message (seeded and sent), the channels reading their
 * history from it, a scripted model, and the records the invariant checks. It is built once per
 * scenario and outlives every boot.
 */
const names: Record<string, string> = { u1: 'Alice', u2: 'Zoë', [SELF]: 'Bot' };

type Chat = ReturnType<typeof makeChat>;

/** The scripted model of a chat: every request it got, and the answer it plays. */
type ChatLlm = {
  calls: Array<Array<Record<string, Untyped>>>;
  complete: (messages: Array<Record<string, Untyped>>) => Promise<unknown>;
};

function makeChat() {
  let stamp = 0;
  const port = createFakeAdapter({ iface: 'fake', selfId: SELF, now: () => clock.t - 5000 + (stamp += 1) });
  const injected: Array<Untyped> = []; // the sends a fault turned into a failure: { n, chat, text }
  const failures = new Map<number, Record<string, Untyped>>(); // send attempt number -> the result it gets
  const dyingAfter = new Set(); // send attempt numbers after which the process dies: the message is in the chat, the answer never comes
  let attempts = 0;
  const send = port.send.bind(port);
  port.send = wrongly<typeof port.send>(
    async (target: Parameters<typeof send>[0], content: Parameters<typeof send>[1]) => {
      attempts += 1;
      if (dyingAfter.has(attempts)) {
        await send(target, content);
        chat.hung = true;
        return new Promise(() => {});
      }
      const result = failures.get(attempts);
      if (!result) return send(target, content);
      port.calls.push({ op: 'send', args: [target, content] });
      injected.push({ n: attempts, chat: target.chatId, text: content?.text ?? '' });
      return result;
    }
  );

  // The chats of the chat: #c1, #c2 and #c3 of the root and the direct chat d1 (c9 is unknown to the interface).
  const infoOf = (id: string, { send = true }: { send?: boolean } = {}) => ({
    id,
    kind: id === 'd1' ? 'dm' : 'channel',
    rootId: id === 'd1' ? null : GUILD,
    name: id === 'd1' ? null : `chan-${id}`,
    topic: null,
    category: null,
    chatType: id === 'd1' ? 'dm' : 'channel',
    ...(id === 'd1' ? { partnerId: 'u1' } : {}),
    iface: 'fake',
    permissions: { read: true, send, attach: true, react: true },
    owner: null,
    lastMessageAt: null,
    voice: false,
    public: true,
    audience:
      id === 'd1'
        ? null
        : {
            everyone: true,
            groups: [],
            groupAllow: [],
            groupDeny: [],
            memberAllow: [],
            memberDeny: [],
            memberGroups: {},
          },
  });
  for (const id of ['c1', 'c2', 'c3', 'd1']) port.seedChat(wrongly(infoOf(id)));

  const results: Array<Untyped> = []; // every turn that ended: { placeId, mode, result, failedSends }
  const requests: Array<{ audience: string | null; text: string }> = []; // every request a model call got: { audience, text }
  const completed: Array<Untyped> = []; // every model call that answered: { at, audience }
  const script: Array<Untyped> = []; // the next answers: a text, an Error, a function of the messages, or HANG
  const fallback: unknown = '<skip/>';
  const audience = null;
  const gifs = null;
  const llm = wrongly<ChatLlm>(null);
  const chat = {
    port,
    injected,
    results,
    requests,
    completed,
    script,
    fallback,
    hung: false,
    audience,
    gifs,
    /** The nth send attempt (1-based, counted over the whole scenario) fails with `result`. */
    failSend(n: number, result = { status: 'failed', error: { code: 'rate-limited', retryable: false } }) {
      failures.set(n, result);
    },
    /** The process dies right after the nth send attempt reached the chat. */
    dieAfterSend(n: number) {
      dyingAfter.add(n);
    },
    get sendAttempts() {
      return attempts;
    },
    /** Where the persona may write: the chats in `unwritable` may not be written in, the others may. */
    permit(unwritable: Array<string> = []) {
      for (const id of ['c1', 'c2', 'c3', 'd1'])
        port.seedChat(wrongly(infoOf(id, { send: !unwritable.includes(wrongly(id)) })));
    },
    /** A line by `authorId` in `chatId` (the persona's own when it is `SELF`); its raw form. */
    /**
     */
    say(chatId: string, authorId: Untyped, text: string) {
      stamp += 1;
      const at = clock.t - 5000 + stamp;
      const id = `s${stamp}`;
      if (authorId === SELF) {
        port.seed(chatId, { authorId, text, messageId: id });
      } else {
        // A member's line is a whole event, the way an interface reports it, with the name the member goes by.
        port.seedEvent({
          kind: 'message.received',
          iface: 'fake',
          at,
          id: `fake:message:${id}`,
          chat: {
            id: chatId,
            kind: chatId === 'd1' ? 'dm' : 'channel',
            rootId: chatId === 'd1' ? null : GUILD,
            name: chatId === 'd1' ? null : `chan-${chatId}`,
          },
          message: {
            id,
            author: { id: authorId, name: names[authorId] ?? authorId, self: false, bot: false },
            content: text,
            sourceText: text,
            system: false,
            at,
            replyToId: null,
            replyPingAccountId: null,
            forwardedFrom: null,
            attachments: [],
            links: [],
            forwarded: [],
            stickers: [],
            emojis: [],
            reactions: [],
          },
          addressing: { mentioned: false, replyToSelf: false, mentionedAccountIds: [], mentionedChatIds: [] },
        });
      }
      return { id, placeId: chatId, cleanContent: text, createdTimestamp: at };
    },
    ownMessages(chatId: string, n = 20) {
      return port
        .messagesIn(chatId)
        .filter((message) => message.authorId === SELF)
        .slice(-n)
        .map((message) => ({
          id: message.ref.messageId,
          content: message.text,
          replyToId: message.replyTo?.messageId ?? null,
          createdAt: message.at,
        }));
    },
    textsFromSelf(chatId: string) {
      return port
        .messagesIn(chatId)
        .filter((message) => message.authorId === SELF)
        .map((message) => message.text);
    },
    llm,
  };
  chat.llm = {
    calls: [],
    complete: async (messages: Array<Record<string, Untyped>>) => {
      const chatCalls = chat.llm.calls;
      chatCalls.push(messages);
      chat.requests.push(wrongly({ audience: chat.audience, text: userText(messages[1].content) }));
      let step: unknown = chat.script.length > 0 ? chat.script.shift() : chat.fallback;
      if (typeof step === 'function') step = await wrongly<(messages: Untyped) => Promise<unknown>>(step)(messages);
      if (step === HANG) {
        chat.hung = true;
        return new Promise(() => {});
      }
      if (step instanceof Error) throw step;
      chat.completed.push(wrongly({ at: clock.t, audience: chat.audience }));
      return completionOf(step);
    },
  };
  return chat;
}

/** A fake intention service over `records` (mutable, outlives a boot): the due ones are pending with a passed dueAt. */
function fakeIntentions(records: Untyped) {
  return {
    records,
    due: () =>
      records
        .filter(
          (r: Record<string, Untyped>) => r.status === 'pending' && Number.isFinite(r.dueAt) && r.dueAt <= clock.t
        )
        .map((r: Record<string, Untyped>) => ({ intention: r, reason: 'due', at: r.dueAt })),
    reconcile: () => ({ arrived: 0, missing: 0, deadline: 0, expired: 0 }),
    list: () => records.filter((r: Record<string, Untyped>) => ['pending', 'waiting', 'proposed'].includes(r.status)),
    store: () => ({
      get: (id: string) => records.find((r: Record<string, Untyped>) => r.id === id) ?? null,
      list: () => records,
    }),
  };
}

const personaGrants = (names: Array<string>) =>
  Object.fromEntries(names.map((name) => [name, { everyone: false, roles: [], users: [SELF] }]));

function hotWith({
  features = {},
  wakes = {},
  timezone = 'UTC',
  grants = [],
  config = {},
}: {
  features?: Record<string, Untyped>;
  wakes?: Record<string, Untyped>;
  timezone?: string;
  grants?: Array<Untyped>;
  config?: Record<string, Untyped>;
} = {}) {
  return {
    config: {
      bot: { timezone, dryRunChannelId: '', ownerPerson: OWNER_PERSON, access: personaGrants(grants) },
      context: {
        channelMessages: 100,
        neighborMessages: 5,
        neighborMaxAgeMinutes: 60,
        neighborMaxChannels: 8,
        maxMessageChars: 800,
        gapMarkerMinutes: 20,
        otherProfiles: 6,
        failedTurnsKept: 3,
        caps: { interlocutor: 2500, aboutChat: 2500, people: 4000, neighbors: 3000 },
        vision: {
          maxImages: 2,
          tokensPerImage: 400,
          imageSize: 512,
          recentImages: 0,
          recentImageMinutes: 0,
          maxBytes: 1_500_000,
          fetchTimeoutMs: 10_000,
        },
        pull: { scanMessages: 20, maxChannels: 1, sameAudience: true },
      },
      llm: { maxRequestTokens: 50000, safetyMargin: 0.9 },
      typing: { reactionDelayMs: [0, 0], msPerChar: [1, 1], minMs: 0, maxMs: 100, betweenMessagesMs: [0, 0] },
      features: {
        memory: true,
        reactions: true,
        multiMessage: true,
        typingSimulation: false,
        vision: false,
        callMarkers: true,
        coreTools: true,
        wakes: true,
        intentions: true,
        ...features,
      },
      models: { routes: chainsOf({ analyzer: 'x/text' }) },
      media: { maxPerTurn: 6, filePreviewChars: 500 },
      gifs: { maxPerDay: 40 },
      mention: { oneAtATime: true },
      tools: {
        safeMode: false,
        resultMaxChars: 2000,
        callTimeoutMs: 120000,
        loop: { maxSteps: 3, timeBudgetMs: 20000, maxCallsPerStep: 4 },
      },
      wakes: {
        mode: 'live',
        tickSeconds: 60,
        queueMax: 20,
        chatMessages: 30,
        caps: { perChain: 3 },
        ...wakes,
      },
      heartbeat: { enabled: false },
      errands: { maxOpen: 3, resultMaxChars: 1000, resultCooldownSeconds: 60, resultRetrySeconds: 30 },
      agents: { scout: { enabled: true, daily: { tasks: 10 } } },
      ...config,
    },
    prompts: {
      main: 'You are a regular member of this chat, not an assistant.',
      persona: 'You are friendly and terse.',
      format: 'Use <msg> and <react> tags.',
      'turn/reply': 'Someone called you: {{author}}.',
      interject: 'Jump into the chat.',
      initiate: 'Start a topic.',
      'turn/inner': INNER_TASK,
      labels,
    },
    reloadConfig: () => true,
  };
}

function fakeStore(gifs = null) {
  const store = {
    getPlace: () => ({}),
    getUser: () => null,
    getPrivate: () => null,
    listChannels: () => [],
    listUserProfiles: () => [],
    countUsers: () => 0,
    getLore: () => [],
    liveRules: () => [],
    ...objectMediaCache({}),
    state: { data: {}, markDirty() {} },
  };
  if (gifs)
    Object.assign(store, {
      findGif: (handle: string) => gifs[handle] ?? null,
      recordOwnGif: () => {},
    });
  return store;
}

/**
 * One boot: a turn runner, an inner life, an errand service with its result turns, all over the
 * chat and `dataDir` -- what src/index.ts builds at start, less Discord. A second boot over the same
 * `dataDir` is a restart. `records` are the intentions (they outlive a boot, like their file would).
 * `die`: the errand service's end hook does nothing (the process died before the result turn).
 */
function boot(
  chat: Chat,
  {
    dataDir,
    records = [],
    hot = hotWith(),
    unwritable = [],
    recall = null,
    failOps = [],
    journal = null,
    record = null,
    gifs = null,
    runErrand = null,
    die = false,
    store = fakeStore(gifs),
    ready = undefined,
    innerMemory = null,
  }: {
    dataDir: string;
    records?: Array<Untyped>;
    hot?: ReturnType<typeof hotWith>;
    unwritable?: Array<string>;
    recall?: Untyped;
    failOps?: Array<string>;
    journal?: Untyped;
    record?: Untyped;
    gifs?: Untyped;
    runErrand?: Untyped;
    die?: boolean;
    store?: ReturnType<typeof fakeStore>;
    ready?: Untyped;
    innerMemory?: Untyped;
  }
) {
  const intentions = fakeIntentions(records);
  const timers: Array<Untyped> = [];
  const accepted = new Set();
  const client = { user: { id: SELF, username: 'Bot' } };
  const port = chat.port;
  chat.permit(unwritable);
  const reads = createReads(port, SILENT);
  const admin = createAdmin({
    discord: DISCORD,
    hot,
    store,
    client,
    isServedRoot: (id: unknown) => id === GUILD,
    port,
    reads,
  });
  const runOp =
    failOps.length === 0
      ? admin.runSkillOp
      : async (op: string, args: Record<string, Untyped>, context: Record<string, Untyped>) =>
          failOps.includes(op)
            ? { status: 'failed', code: 'error', summary: 'it did not work', data: null }
            : admin.runSkillOp(op, args, context);

  // The errand service over the real task store; its runner is a fake that ends at once.
  const stores = createErrandStores({ memoryDb: memoryOf(dataDir), config: () => hot.config, log: SILENT });
  let taskTurns = wrongly<ReturnType<typeof createErrandTurns>>(null);
  const errands = createErrandService({
    client: {
      configured: () => true,
      run: async (task) =>
        runErrand ? runErrand(task) : { status: 'done', result: { text: 'found it' }, usage: { usd: 0.01 } },
      cancel: () => true,
    },
    stores,
    hot,
    log: SILENT,
    onFinished: (task) => (die ? null : taskTurns.onFinished(task)),
  });

  const turns = createTurnRunner({
    hot,
    store,
    llm: chat.llm,
    calibrator: { ratio: 1, apply: (value) => value, observe: () => {} },
    now: () => clock.t,
    port,
    reads,
    selfId: () => SELF,
    getSelfName: () => 'Bot',
    memberOf: (placeId: string, accountId: string) =>
      accountId in names ? { name: names[accountId], bot: false } : null,
    membersOf: () => Object.entries(names).map(([id, name]) => ({ id, name, bot: false })),
    chatName: (id: string) => (id === 'd1' ? null : `chan-${id}`),
    skills: skillRegistry(),
    journal,
    runOp,
    runOwnOp: admin.runOwnSkillOp,
    runInitiativeOp: admin.runInitiativeSkillOp,
    errands,
    ...(recall ? { recall } : {}),
  });
  // Every turn that ends is recorded with the sends a fault failed during it.
  const recorded = {
    isAnyBusy: () => turns.isAnyBusy?.() ?? false,
    isBusy: (id: string) => turns.isBusy?.(id) ?? false,
    runTurn: async (params: Record<string, Untyped>) => {
      chat.audience = params.chat?.chatId ?? null;
      const before = chat.sendAttempts;
      const result = await turns.runTurn(params);
      chat.results.push({
        placeId: params.chat?.chatId ?? null,
        mode: params.mode,
        result,
        failedSends: chat.injected.filter((f) => f.n > before && f.n <= chat.sendAttempts),
      });
      return result;
    },
  };
  taskTurns = createErrandTurns({
    hot,
    reads,
    iface: () => 'fake',
    turns: recorded,
    errands,
    now: () => clock.t,
    setTimer: wrongly((fn: string, ms: Array<Record<string, Untyped>>) => timers.push({ fn, ms })),
    log: SILENT,
  });

  let inner: ReturnType<typeof createInnerLife>;
  const door = createEventDoor({ handlers: { 'inner.wake': (event) => inner.onWake(event) }, log: SILENT });
  inner = createInnerLife({
    hot,
    dataDir,
    turns: recorded,
    intentions,
    record,
    journal: journal ? personaJournal(wrongly(journal), () => [GUILD]) : null,
    reads,
    iface: () => 'fake',
    ...(ready ? { ready } : {}),
    submit: (event) => {
      accepted.add(event.id);
      return door.submit(event);
    },
    store: { state: { data: {} } },
    meter: { run: async (fn) => ({ result: await fn(), usd: 0, requests: 1, voice: 1 }) },
    ...(innerMemory ? { memoryDb: innerMemory } : {}),
    rng: () => 0.5,
    now: () => clock.t,
    log: SILENT,
  });
  turns.setFactsSource(inner.facts);

  const quiet = async (fn: () => unknown) => (await withCapturedLogs(fn)).result;
  const world = {
    chat,
    hot,
    dataDir,
    store,
    client,
    port,
    reads,
    turns,
    inner,
    errands,
    taskTurns,
    intentions,
    records,
    accepted,
    timers,
    journal,
    /** A wake handed to the door, as the scheduler would; remembered as accepted work. */
    accept: (wake: Record<string, Untyped>) => {
      accepted.add(wake.id);
      return door.submit({ kind: 'inner.wake', at: clock.t, id: wake.id, rootId: GUILD, wake });
    },
    tick: () => quiet(() => inner.tick()),
    /** Alice's line in `chatId`, answered by an addressed turn (the model's next answers are `chat.script`). */
    ask: (chatId: string, text: Untyped, { dm = false }: { dm?: boolean } = {}) =>
      quiet(async () => {
        const raw = chat.say(chatId, 'u1', text);
        const trigger = {
          id: raw.id,
          placeId: raw.placeId,
          authorId: 'u1',
          authorName: 'Alice',
          self: false,
          bot: false,
          content: raw.cleanContent,
          ts: raw.createdTimestamp,
          replyToId: null,
          attachments: [],
          stickers: [],
        };
        return recorded.runTurn({
          chat: { iface: 'fake', chatId },
          ...(dm ? { placeId: GUILD } : {}),
          mode: 'reply',
          trigger,
          triggerKind: 'mention',
        });
      }),
    quiet,
    state: () => inner.state(),
    factKinds: () =>
      inner.state().facts.map((fact: Record<string, Untyped>) => `${fact.kind}${fact.told ? ':told' : ''}`),
  };
  return world;
}

// ---- the invariant ----

/**
 * What no scenario may end with (spec section 1), checked from the fakes' records:
 * 1. no accepted work lost: every wake the door accepted is queued or has a handled outcome, and no
 *    errand is left open by a process that is gone;
 * 2. no false success: a turn that had a send fail never reads `spoke` with something delivered
 *    unless it says `partial` (or one of its calls is recorded as not ok);
 * 3. no blind duplicate: the persona never said the same text twice in one chat;
 * 4. no premature told: a fact marked told is backed by a model answer that completed after it was born;
 * 5. audience-correct: nothing marked private (`privateMarks`) is in a request made in another chat,
 *    and a private fact belongs to one of `dmChats`.
 */
/** What a test adds to the invariants: wakes it accepted, the private chats, and the marks that must stay private. */
type Invariants = { accepted?: Array<Untyped>; dmChats?: Untyped; privateMarks?: Array<Untyped> };

function assertNoSilentFailure(run: Record<string, Untyped>, options: Invariants = {}) {
  const { accepted = [], dmChats = ['d1'], privateMarks = [] } = options;
  const { chat } = run;
  const state = run.inner.state(GUILD);
  for (const id of new Set([...accepted, ...run.accepted])) {
    assert.ok(
      state.queue.some((wake: Record<string, Untyped>) => wake.id === id) || state.handled[id],
      `1: the accepted wake ${id} is neither queued nor handled`
    );
  }
  const open = run.errands.store()?.open() ?? [];
  assert.deepEqual(
    open.map((task: Record<string, Untyped>) => task.id),
    [],
    '1: an errand is left open with no process to run it'
  );
  for (const { placeId, mode, result, failedSends } of chat.results) {
    if (failedSends.length === 0) continue;
    const callNotOk = (result?.inner?.actions ?? []).some((action: Record<string, Untyped>) => action.result !== 'ok');
    const readsAsSuccess =
      result?.outcome === 'spoke' && result.delivered === true && result.partial !== true && !callNotOk;
    assert.equal(readsAsSuccess, false, `2: the ${mode} turn in ${placeId} lost a send but reads as a success`);
  }
  assertSaidOnce(chat);
  assertPrivateKept(chat, state, { dmChats, privateMarks });
}

/** Invariant 3: the persona never said the same thing twice in one chat. */
function assertSaidOnce(chat: Chat) {
  const said = new Map();
  const chatMessages = chat.port.messages;
  for (const message of chatMessages.values()) {
    if (message.authorId !== SELF || message.deleted) continue;
    const key = `${message.ref.chatId}\n${message.text}`;
    said.set(key, (said.get(key) ?? 0) + 1);
  }
  for (const [key, count] of said) {
    if (count > 1) assert.fail(`3: the persona said twice in ${key.split('\n')[0]}: ${key.split('\n')[1]}`);
  }
}

/** Invariants 4 and 5: a told fact has a model answer after it, and private facts and marks stay in the private chats. */
function assertPrivateKept(
  chat: Chat,
  state: Record<string, Untyped>,
  { dmChats, privateMarks }: { dmChats: Untyped; privateMarks: Array<Untyped> }
) {
  for (const fact of state.facts) {
    if (fact.told)
      assert.ok(
        chat.completed.some((done: { at: number }) => done.at >= fact.at),
        `4: the fact ${fact.kind} is told but no model answer completed after it was born`
      );
    if (fact.dmChat) assert.ok(dmChats.includes(fact.placeId), `5: a private fact belongs to ${fact.placeId}`);
  }
  for (const request of chat.requests) {
    if (request.audience !== null && dmChats.includes(request.audience)) continue;
    for (const mark of privateMarks)
      assert.ok(!request.text.includes(mark), `5: a request in ${request.audience} carries a private mark`);
  }
}

// The owner of these configs: `bot.ownerPerson` and the accounts bound to it (tests/fixtures/owner-accounts.ts).
ownedBy(['u1']);

describe('injected faults', () => {
  test.beforeEach(() => {
    clock.t = NOW0;
  });

  test('row 9: memory.search that timed out reads as a timeout; one that really found nothing reads as none', async () => {
    // The fixture labels word no timeout; this test words it itself, as the tracked labels do.
    const resultLabels = labels.tools.result;
    const words = {
      ...labels,
      tools: {
        ...labels.tools,
        result: { ...labels.tools.result, reasons: { ...resultLabels.reasons, timeout: '{what} timed out' } },
      },
    };
    const hot = hotWith({ grants: ['memory.search'], features: { recall: true } });
    hot.prompts.labels = words;
    const search = async (outcome: Record<string, Untyped>) => {
      const chat = makeChat();
      const recall = {
        available: () => true,
        run: async () => ({ text: null, stretch: null, people: [], quotes: [], stats: {}, outcome }),
      };
      const run = boot(chat, { dataDir: tempDir('nep-fault-'), hot, recall });
      chat.script = [toolAnswer('', [call('memory.search', { question: 'what did Éloïse say' })]), '<msg>ok</msg>'];
      await run.ask('c1', 'search for it');
      const chatCalls = chat.llm.calls;
      assert.equal(chatCalls.length, 2);
      assertNoSilentFailure(run);
      return present(chat.llm)
        .calls[1].filter((message) => message.role === 'tool')
        .map((message) =>
          typeof message.content === 'string'
            ? message.content
            : message.content.map((part: Record<string, Untyped>) => part.text).join('')
        )
        .join('\n');
    };
    const timedOut = await search({ kind: 'timeout' });
    assert.match(timedOut, /timed out/, 'the cause is the timeout');
    const toolsLabels = labels.tools;
    const toolsLabelsMemory = toolsLabels.tools.memory;
    assert.ok(!timedOut.includes(toolsLabelsMemory.none), 'not "nothing found"');
    const labelsResultLabels = labels.tools.result;
    assert.ok(!timedOut.startsWith(labelsResultLabels.ok), 'not a result that went well');
    const empty = await search({ kind: 'searched', degraded: false, failed: 0, total: 3 });
    const resultLabels2 = labels.tools.result;
    assert.ok(empty.startsWith(resultLabels2.ok), empty);
    const labelsToolsLabels = labels.tools;
    const labelsToolsLabelsMemory = labelsToolsLabels.tools.memory;
    assert.ok(empty.includes(labelsToolsLabelsMemory.none), 'a real empty result reads as none');
  });
});

type GifEntryLine = Parameters<typeof gifLine>[0];

const mediaFindLabels = {
  gifs: { entry: '{id}: {text}', entryNoText: '{id}' },
  tools: { tools: { find: { source: 'Source: media.find "{query}", {count} found.', none: 'Nothing matched.' } } },
};

/** A library of entries g1.. with these descriptions, the first used most. */
function fixture(descriptions: Array<string>) {
  const entries: Record<string, Untyped> = {};
  const cache: Record<string, Untyped> = {};
  descriptions.forEach((text, index) => {
    const key = `k${index + 1}`;
    entries[key] = {
      id: `g${index + 1}`,
      kind: 'link',
      url: `https://tenor.example/${key}`,
      itemId: key,
      messageId: 'm',
      placeId: 'c',
      count: 10 - index,
      last: 1000,
    };
    cache[key] = { text };
  });
  return { gifs: normalizeGifs({ nextId: descriptions.length + 1, entries }), cache };
}

// A GIF is one text, so the library holds texts and no fields.
const LIBRARY = [
  'γάτα που χορεύει, a cat dances on a table',
  'Élodie rit, a woman laughs out loud, haha',
  'κλάμα, crying rain window',
  'a dog runs in the park',
];

function storeOf({ gifs, cache }: Record<string, Untyped>) {
  return {
    getGifs: () => gifs,
    ...objectMediaCache(cache),
    findGif: (handle: string) => findGif(gifs, handle),
  };
}

test('findGifs ranks by words in either language, accents and case ignored, ties by the library order', () => {
  const lib = fixture(LIBRARY);
  assert.deepEqual(
    findGifs(lib.gifs, lib.cache, 'CAT dances').map((e) => e.id),
    ['g1']
  );
  assert.deepEqual(
    findGifs(lib.gifs, lib.cache, 'γατα').map((e) => e.id),
    ['g1'],
    'a Greek word without its accent'
  );
  assert.deepEqual(
    findGifs(lib.gifs, lib.cache, 'elodie').map((e) => e.id),
    ['g2'],
    'accented Latin folded'
  );
  assert.deepEqual(
    findGifs(lib.gifs, lib.cache, 'laughs haha').map((e) => e.id),
    ['g2']
  );
  assert.deepEqual(
    findGifs(lib.gifs, lib.cache, 'dog dances').map((e) => e.id),
    ['g1', 'g4'],
    'equal scores keep the library order'
  );
  // a near form (shared stem) counts less than an exact word
  assert.deepEqual(
    findGifs(lib.gifs, lib.cache, 'cry').map((e) => e.id),
    [],
    'under the stem length nothing partial'
  );
  assert.deepEqual(
    findGifs(lib.gifs, lib.cache, 'crying').map((e) => e.id),
    ['g3']
  );
  assert.deepEqual(
    findGifs(lib.gifs, lib.cache, 'dance').map((e) => e.id),
    ['g1'],
    'a shared stem of a form counts, less than the exact word'
  );
  assert.deepEqual(
    findGifs(lib.gifs, lib.cache, 'dance laughs').map((e) => e.id),
    ['g2', 'g1'],
    'an exact word outranks a stem match'
  );
  assert.deepEqual(
    findGifs(lib.gifs, lib.cache, 'dancing laughs').map((e) => e.id),
    ['g2'],
    'dancing and dances share no stem here'
  );
});

test('findGifs: an entry without a stored description is never returned, nothing matching gives none', () => {
  const lib = fixture(LIBRARY);
  delete lib.cache.k4;
  lib.cache.k3 = { miss: true };
  assert.deepEqual(
    findGifs(lib.gifs, lib.cache, 'dog park crying').map((e) => e.id),
    []
  );
  assert.deepEqual(
    findGifs(lib.gifs, lib.cache, 'zzz').map((e) => e.id),
    []
  );
  assert.deepEqual(
    findGifs(lib.gifs, lib.cache, '   ').map((e) => e.id),
    []
  );
});

test('findGifs: n defaults to 5, is capped at 10 and floored at 1', () => {
  const lib = fixture(Array.from({ length: 14 }, (_, i) => `a cat number ${i}`));
  assert.equal(findGifs(lib.gifs, lib.cache, 'cat').length, 5);
  assert.equal(findGifs(lib.gifs, lib.cache, 'cat', { n: 3 }).length, 3);
  assert.equal(findGifs(lib.gifs, lib.cache, 'cat', { n: 99 }).length, 10);
  assert.equal(findGifs(lib.gifs, lib.cache, 'cat', { n: 0 }).length, 5);
});

// gifLine takes no field lengths.
test('runMediaFind: handles in the result are the library handles message.create gif= and <gif> resolve, written as a library line', () => {
  const lib = fixture(LIBRARY);
  const store = storeOf(lib);
  const result = runMediaFind({
    store,
    config: {},
    labels: mediaFindLabels,
    placeId: 'G',
    args: { query: 'cat laughs' },
  });
  assert.equal(result.status, 'ok');
  const lines = present(result.data).text.split('\n');
  assert.equal(lines[0], 'Source: media.find "cat laughs", 2 found.');
  const handles = lines.slice(1).map((line) => line.split(':')[0]);
  assert.equal(handles.length, 2);
  for (const handle of handles) assert.ok(store.findGif(handle), `${handle} resolves in the library`);
  // B7: the `<gifs>` block left the turn; the line of an entry is gifLine's, which media.find keeps writing.
  const block = Object.values<Untyped>(lib.gifs.entries).map((entry) =>
    gifLine(entry as GifEntryLine, lib.cache, mediaFindLabels, { now: 0, ownMarkHours: 0 })
  );
  for (const line of lines.slice(1)) assert.ok(block.includes(line), 'the same line the entry always had');
});

// A GIF is shown whole in the answer of media.find; the cut at 70 characters goes.
test('runMediaFind: the line of a GIF holds its 300-character text whole', () => {
  const text = `a cat dances on a table ${'and spins around '.repeat(16)}end`;
  assert.equal(text.length, 299);
  const store = storeOf(fixture([text]));
  const result = runMediaFind({ store, config: {}, labels: mediaFindLabels, placeId: 'G', args: { query: 'cat' } });
  const lines = present(result.data).text.split('\n');
  assert.equal(lines[1], `g1: ${text}`);
});

test('runMediaFind: nothing found is an ok with the none label; bad arguments and no library are refused', () => {
  const store = storeOf(fixture(LIBRARY));
  const none = runMediaFind({ store, config: {}, labels: mediaFindLabels, placeId: 'G', args: { query: 'submarine' } });
  assert.deepEqual(
    [none.status, present(none.data).text],
    ['ok', 'Source: media.find "submarine", 0 found.\nNothing matched.']
  );
  const bare = runMediaFind({ store, config: {}, labels: {}, placeId: 'G', args: { query: 'submarine' } });
  assert.deepEqual([bare.status, present(bare.data).text], ['ok', '']);
  assert.equal(
    runMediaFind({ store, config: {}, labels: mediaFindLabels, placeId: 'G', args: {} }).code,
    'invalid-args'
  );
  assert.equal(
    runMediaFind({ store, config: {}, labels: mediaFindLabels, placeId: 'G', args: { query: '!!' } }).status,
    'invalid'
  );
  assert.equal(
    runMediaFind({ store, config: {}, labels: mediaFindLabels, placeId: 'G', args: { query: 'cat', n: 11 } }).reason,
    'args.n:range'
  );
  assert.equal(
    runMediaFind({ store, config: {}, labels: mediaFindLabels, placeId: 'G', args: { query: 'cat', n: 0 } }).reason,
    'args.n:range'
  );
  assert.equal(
    runMediaFind({ store: null, config: {}, labels: mediaFindLabels, placeId: 'G', args: { query: 'cat' } }).status,
    'not_configured'
  );
  assert.equal(
    present(
      runMediaFind({ store, config: {}, labels: mediaFindLabels, placeId: 'G', args: { query: 'cat', n: 1 } }).data
    ).text.split('\n').length,
    2,
    'n=1 gives one GIF'
  );
  assert.equal(
    mediaFindText([], { query: 'x', labels: mediaFindLabels }),
    'Source: media.find "x", 0 found.\nNothing matched.'
  );
});

test('media.find finds a GIF by the media vector of its row when its words find no full match', async () => {
  // Bug: media.find reads words only, so a query in another language than the descriptions finds nothing.
  const lib = fixture(LIBRARY);
  const vectors = new Map([
    ['k3', [1, 0, 0]],
    ['k1', [0, 1, 0]],
  ]);
  let asked = 0;
  const store = { ...storeOf(lib), gifMediaVectors: () => vectors };
  const findMeaning = createFindMeaning({
    embed: () => {
      asked += 1;
      return Promise.resolve([1, 0, 0]);
    },
    model: 'test/embedder',
    deadlineMs: 1000,
    memo: new Map(),
  });
  const args = { query: 'λύπη' };
  assert.equal(
    runMediaFind({ store, config: {}, labels: mediaFindLabels, placeId: 'G', args }).data?.text?.includes('0 found'),
    true
  );
  const result = await mediaFind({ store, config: {}, labels: mediaFindLabels, placeId: 'G', args, findMeaning });
  const handles = present(result.data)
    .text.split('\n')
    .slice(1)
    .map((line) => line.split(':')[0]);
  assert.deepEqual(handles, ['g3']);
  const words = await mediaFind({
    store,
    config: {},
    labels: mediaFindLabels,
    placeId: 'G',
    args: { query: 'cat' },
    findMeaning,
  });
  assert.equal(present(words.data).text.split('\n').length, 2, 'the cat is found by its words');
  assert.equal(asked, 1, 'a query whose words find a full match sends no embedding');
});

const DAY = 86400000;

const MEMORY_DB_RECALL_CARRIER_NOW = Date.parse('2026-10-24T12:00:00.000Z');

const BOB = 'u-bob';

function runner(env: ReturnType<typeof memoryDbRecallCarrierFixture>) {
  fillEnvAudiences(env);
  insertRows(
    env.db,
    {
      places: [
        {
          id: channelPlaceId('discord', 'c1'),
          iface: 'discord',
          kind: 'channel',
          native_id: 'c1',
          scope_kind: 'group',
          name: 'general',
        },
        {
          id: dmPlaceId('discord', BOB),
          iface: 'discord',
          kind: 'dm',
          native_id: null,
          scope_kind: 'dm',
          partner_person: personId('discord', BOB),
        },
      ],
    },
    { log: { info() {}, debug() {}, warn() {}, error() {} } }
  );
  const hot = {
    config: { features: { recall: true, meaningSearch: false }, bot: { timezone: 'UTC' } },
    prompts: { labels },
  };
  const recaller = createRecall({
    mediaNameOf: noMediaNames,
    iface: 'discord',
    hot,
    store: { state: { data: {}, markDirty() {} }, listUserProfiles: () => [] },
    llm: { capLeft: () => 100, complete: () => Promise.reject(new Error('quoted SQLite reads need no model')) },
    now: () => MEMORY_DB_RECALL_CARRIER_NOW,
    memoryDb: { database: () => env.db },
  });
  return { recaller, hot, args: { placeId: 'g1', channel: channelInfo('c1', { name: 'general' }) } };
}

test('the memory tool expands a trusted source carrier even when its ordinary anchor text is empty', async () => {
  const env = memoryDbRecallCarrierFixture();
  try {
    env.say({
      native: 'carrier-before',
      at: MEMORY_DB_RECALL_CARRIER_NOW - DAY - 60_000,
      place: channelPlaceId('discord', 'c1'),
      text: 'carrier-neighbor-731',
    });
    const sourceId = env.say({
      native: 'carrier-anchor',
      at: MEMORY_DB_RECALL_CARRIER_NOW - DAY,
      place: channelPlaceId('discord', 'c1'),
      text: 'anchor',
    });
    const s = runner(env);
    const result = await runMemorySearch({
      recall: s.recaller,
      config: s.hot.config,
      labels,
      ...s.args,
      args: { anchor: '', move: 'up', messages: 1 },
      resolvedAnchor: { kind: 'source', sourceId },
      now: MEMORY_DB_RECALL_CARRIER_NOW,
    });
    assert.equal(result.status, 'ok');
    const resultText = result.data?.text;
    assert.ok(resultText?.includes('carrier-neighbor-731'));
  } finally {
    env.done();
  }
});

test('the memory tool never falls back from a hidden trusted source to visible ordinary anchor text', async () => {
  const env = memoryDbRecallCarrierFixture();
  try {
    env.say({
      native: 'visible-before',
      at: MEMORY_DB_RECALL_CARRIER_NOW - DAY - 60_000,
      place: channelPlaceId('discord', 'c1'),
      text: 'visible-fallback-731',
    });
    env.say({
      native: 'visible-anchor',
      at: MEMORY_DB_RECALL_CARRIER_NOW - DAY,
      place: channelPlaceId('discord', 'c1'),
      text: 'visible anchor',
    });
    const hidden = env.say({
      native: 'hidden-anchor',
      at: MEMORY_DB_RECALL_CARRIER_NOW - DAY,
      place: dmPlaceId('discord', BOB),
      scope: dmScope(personId('discord', BOB), 'discord'),
      text: 'hidden-secret-842',
    });
    const s = runner(env);
    const result = await runMemorySearch({
      recall: s.recaller,
      config: s.hot.config,
      labels,
      ...s.args,
      args: { anchor: 'visible-anchor', move: 'up', messages: 1 },
      resolvedAnchor: { kind: 'source', sourceId: hidden },
      now: MEMORY_DB_RECALL_CARRIER_NOW,
    });
    assert.deepEqual([result.status, result.code], ['invalid', 'unknown-message']);
    assert.equal(JSON.stringify(result).includes('hidden-secret-842'), false);
    assert.equal(JSON.stringify(result).includes('visible-fallback-731'), false);
  } finally {
    env.done();
  }
});

const MEMORY_DB_RECALL_EXCLUSIONS_NOW = Date.parse('2026-10-24T12:00:00.000Z');

function objectOf(value: unknown): Record<string, unknown> {
  if (value === null || typeof value !== 'object' || Array.isArray(value))
    throw new Error('tracked settings require an object');
  // The guard establishes an object whose settings are read by string keys.
  return value as Record<string, unknown>;
}

function memoryDbRecallExclusionsRunner(env: ReturnType<typeof memoryDbRecallExclusionsFixture>) {
  fillEnvAudiences(env);
  insertRows(
    env.db,
    {
      places: [
        {
          id: channelPlaceId('discord', 'c1'),
          iface: 'discord',
          kind: 'channel',
          native_id: 'c1',
          scope_kind: 'group',
          name: 'general',
        },
        {
          id: channelPlaceId('discord', 'c4'),
          iface: 'discord',
          kind: 'channel',
          native_id: 'c4',
          scope_kind: 'group',
          name: 'secret',
        },
        {
          id: dmPlaceId('discord', BOB),
          iface: 'discord',
          kind: 'dm',
          native_id: null,
          scope_kind: 'dm',
          partner_person: personId('discord', BOB),
        },
      ],
    },
    { log: { info() {}, debug() {}, warn() {}, error() {} } }
  );
  const parsed: unknown = JSON.parse(fs.readFileSync(new URL('../../../config/config.json', import.meta.url), 'utf8'));
  const config = objectOf(parsed);
  config.bot = { ...objectOf(config.bot ?? {}), timezone: 'UTC' };
  config.features = { ...objectOf(config.features ?? {}), meaningSearch: false, recall: true };
  const models = objectOf(config.models ?? {});
  // Changed: a role's model is its chain's (spec 2026-11-09-model-routes, slice 4).
  config.models = {
    ...models,
    routes: { ...objectOf(models.routes ?? {}), ...chainsOf({ embedding: 'test/embedder' }) },
  };
  const channel = channelInfo('c1', { name: 'general' });
  const secret = { ...privateChannel('c4', []), name: 'secret' };
  const snapshot = snapshotOf('g1', { chats: [channel, secret], groups: [] });
  const toolsLabels = labels.tools;
  const hot = {
    config,
    prompts: {
      labels: {
        ...labels,
        tools: {
          ...labels.tools,
          tools: { ...toolsLabels.tools, memory: { ...toolsLabels.tools.memory, hidden: 'ΚΡΥΦΟ-ΣΗΜΑ' } },
        },
      },
    },
  };
  const recaller = createRecall({
    mediaNameOf: noMediaNames,
    iface: 'discord',
    hot,
    // The DM partner `owner-42` has a stored person, which the store answers; no person is spelled from a member id.
    store: {
      state: { data: {}, markDirty() {} },
      listUserProfiles: () => [],
      personOfAccount: (account: string) => (account === 'owner-42' ? personId('discord', 'owner-42') : null),
    },
    llm: { capLeft: () => 100, complete: () => Promise.reject(new Error('quoted SQLite reads need no model')) },
    now: () => MEMORY_DB_RECALL_EXCLUSIONS_NOW,
    embed: null,
    memoryDb: { database: () => env.db },
  });
  return {
    recaller,
    hot,
    args: {
      placeId: 'g1',
      snapshot,
      channel,
      partnerId: null,
      selfId: 'self',
      selfName: 'Ζωή',
      history: [],
      candidate: { id: 'q', content: 'το σπιτι' },
    },
  };
}

function exclusionSource(
  env: ReturnType<typeof memoryDbRecallExclusionsFixture>,
  {
    iface = 'fake',
    room,
    id = 'shared-visible',
    marker,
    dm = false,
    offset = 60_000,
    authority = `${iface}/${room}`,
  }: { iface?: string; room: string; id?: string; marker: string; dm?: boolean; offset?: number; authority?: string }
) {
  const event = lineEvent({
    id,
    chatId: room,
    authorId: 'owner-42',
    text: `το κουνέλι ${marker}`,
    at: MEMORY_DB_RECALL_EXCLUSIONS_NOW - DAY - offset,
  });
  event.iface = iface;
  event.chat = dm
    ? { id: room, kind: 'dm', rootId: null, partnerId: 'owner-42' }
    : { id: room, kind: 'channel', rootId: 'g1', name: room };
  const envelope = observationOf(event);
  if (!envelope) throw new Error('valid exclusion fixture was refused');
  envelope.authority = authority;
  envelope.place.authority = authority;
  const result = observe(env.handle, envelope, { now: () => MEMORY_DB_RECALL_EXCLUSIONS_NOW });
  assert.equal(result.ok, true);
  if (typeof result.sourceId !== 'string' || typeof result.placeId !== 'string')
    throw new Error('exclusion source identity missing');
  return {
    sourceId: result.sourceId,
    placeId: result.placeId,
    iface,
    native: { iface, chatId: room, messageId: id },
  };
}

test('an internal CLI tool excludes trusted current history while retaining a foreign private collision', async () => {
  const env = memoryDbRecallExclusionsFixture();
  try {
    exclusionSource(env, { iface: 'cli', room: 'cli:dm:owner', marker: 'own-cli-visible-731', dm: true });
    exclusionSource(env, { iface: 'other', room: 'foreign-dm', marker: 'foreign-private-842', dm: true });
    env.stem();
    const s = memoryDbRecallExclusionsRunner(env);
    const args = {
      ...s.args,
      placeId: null,
      snapshot: null,
      channel: channelInfo('cli:dm:owner', { kind: 'dm', rootId: null, partnerId: 'owner-42', audience: null }),
      historyRef: { iface: 'cli', chatId: 'cli:dm:owner' },
      history: [{ id: 'shared-visible', placeId: 'cli:dm:owner', content: 'το κουνέλι own-cli-visible-731' }],
      memoryContext: issuedContext({
        kind: 'internal',
        newId: () => 'ctx:exclude-cli-tool',
        now: () => MEMORY_DB_RECALL_EXCLUSIONS_NOW,
      }),
    };
    const found = await runMemorySearch({
      ...args,
      recall: s.recaller,
      config: s.hot.config,
      labels,
      args: { terms: 'κουνέλι' },
      now: MEMORY_DB_RECALL_EXCLUSIONS_NOW,
    });
    assert.equal(JSON.stringify(found).includes('own-cli-visible-731'), false);
    assert.ok(JSON.stringify(found).includes('foreign-private-842'));
  } finally {
    env.done();
  }
});

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

const shippedJson = (file: string) =>
  JSON.parse(fs.readFileSync(path.join(ROOT, 'config', file), 'utf8')) as Record<string, object>;

const MINUTE = 60000;

const MEMORY_SEARCH_PLACE_DAY_NOW = Date.parse('2026-11-05T12:00:00.000Z');

const DAY_START = Date.parse('2026-11-01T00:00:00.000Z');

const DAY_END = Date.parse('2026-11-01T23:59:59.999Z');

const GENERAL = channelPlaceId('discord', 'c1');

const SECRET = channelPlaceId('discord', 'c4');

const SAMPLED_MARK = 'SAMPLED-MARK';

const NONE_MARK = 'NONE-MARK';

const toolsLabels2 = labels.tools;
const toolLabels = {
  ...labels,
  tools: {
    ...labels.tools,
    tools: {
      ...toolsLabels2.tools,
      memory: { ...toolsLabels2.tools.memory, sampled: SAMPLED_MARK, none: NONE_MARK },
    },
  },
};

type Env = ReturnType<typeof memorySearchPlaceDayFixture>;

/** `count` lines spread evenly over a span, each further from the next than a chat's silence. */
function spread(
  env: Env,
  prefix: string,
  {
    from,
    to,
    count,
    place = GENERAL,
    text = '',
  }: { from: number; to: number; count: number; place?: string; text?: string }
) {
  const step = (to - from) / count;
  for (let i = 0; i < count; i += 1)
    env.say({ native: `${prefix}${i}`, at: Math.round(from + i * step), text: text || `line ${prefix}${i}`, place });
}

/**
 * The runner and the tool over the fixture database: #general (c1), #secret (c4) that the root cannot see, stored as
 * `secret`.
 */
function toolRig(env: Env, { secret: secretId = SECRET }: { secret?: string } = {}) {
  fillEnvAudiences(env);
  insertRows(
    env.db,
    {
      places: [
        { id: GENERAL, iface: 'discord', kind: 'channel', native_id: 'c1', scope_kind: 'group', name: 'general' },
        { id: secretId, iface: 'discord', kind: 'channel', native_id: 'c4', scope_kind: 'group', name: 'secret' },
      ],
    },
    { log: { info() {}, debug() {}, warn() {}, error() {} } }
  );
  const channel = channelInfo('c1', { name: 'general' });
  const secret = { ...privateChannel('c4', []), name: 'secret' };
  const snapshot = snapshotOf('g1', { chats: [channel, secret], groups: [] });
  const shipped = shippedJson('config.json');
  const config = {
    ...shipped,
    bot: { ...shipped.bot, timezone: 'UTC' },
    features: { ...shipped.features, meaningSearch: false, recall: true },
  };
  const data = {};
  const store = {
    state: {
      get data() {
        return data;
      },
      markDirty() {},
    },
    listUserProfiles: () => [],
  };
  const llmCalls: Array<unknown> = [];
  const reads = {
    history: () => Promise.resolve({ events: [], complete: true }),
  };
  const llm = {
    capLeft: () => 100,
    complete: (...call: Array<unknown>) => {
      llmCalls.push(call);
      return Promise.resolve({ text: '' });
    },
  };
  const recall = createRecall({
    iface: 'discord',
    mediaNameOf: noMediaNames,
    reads,
    hot: { config, prompts: { labels: toolLabels } },
    store,
    llm,
    now: () => MEMORY_SEARCH_PLACE_DAY_NOW,
    memoryDb: { database: () => env.db },
  } as unknown as Parameters<typeof createRecall>[0]);
  const ask = (args: Record<string, unknown>) =>
    runMemorySearch({
      recall,
      store,
      config,
      labels: toolLabels,
      placeId: 'g1',
      snapshot,
      channel,
      selfId: 'self',
      selfName: 'Self',
      history: [],
      now: MEMORY_SEARCH_PLACE_DAY_NOW,
      args,
    });
  return { ask, llmCalls };
}

const textOf = (result: Awaited<ReturnType<typeof runMemorySearch>>) => {
  assert.equal(result.status, 'ok');
  return (result as { data: { text: string } }).data.text;
};

// ---------- the tool ----------

for (const [name, args] of [
  ['with no question', { when: '2026-11-01', placeId: 'c1' }],
  ['with a channel alone', { placeId: 'c1' }],
] as const) {
  test(`the tool answers a day in a channel ${name} with its lines and the sampled line`, async () => {
    const env = memorySearchPlaceDayFixture();
    try {
      spread(env, 'd', { from: DAY_START, to: DAY_END, count: 30 });
      const text = textOf(await toolRig(env).ask(args));
      assert.ok(text.includes(SAMPLED_MARK), text);
      assert.ok(text.includes('line d'), text);
      assert.ok(!text.includes(NONE_MARK), text);
    } finally {
      env.done();
    }
  });
}

// These two cases expected a sample of the day's lines. A call that gives words (a question or terms) and finds none is
// answered with none found: a sample of unrelated lines read as a hit (slice 4 of the lookup loop, behaviour 4).
for (const [name, args] of [
  ['with a question', { question: 'τι εγινε τοτε στο καναλι', when: '2026-11-01', placeId: 'c1' }],
  ['with terms that match nothing', { terms: 'ανυπαρκτο', when: '2026-11-01', placeId: 'c1' }],
] as const) {
  test(`the tool answers a day in a channel ${name} with none found and no sampled line`, async () => {
    const env = memorySearchPlaceDayFixture();
    try {
      spread(env, 'd', { from: DAY_START, to: DAY_END, count: 30 });
      const text = textOf(await toolRig(env).ask(args));
      assert.ok(text.includes(NONE_MARK), text);
      assert.ok(!text.includes(SAMPLED_MARK), text);
    } finally {
      env.done();
    }
  });
}

test('the tool answers an empty search the same as before: no sampled line', async () => {
  const env = memorySearchPlaceDayFixture();
  try {
    spread(env, 'd', { from: DAY_START, to: DAY_END, count: 5 });
    const text = textOf(await toolRig(env).ask({ when: '2026-10-01', placeId: 'c1' }));
    assert.ok(text.includes(NONE_MARK), text);
    assert.ok(!text.includes(SAMPLED_MARK), text);
  } finally {
    env.done();
  }
});

test('the tool answers terms and a day that match nothing with none found and no sample of the day', async () => {
  const env = memorySearchPlaceDayFixture();
  try {
    spread(env, 'd', { from: DAY_START, to: DAY_END, count: 30 });
    const text = textOf(await toolRig(env).ask({ terms: 'ανυπαρκτο', when: '2026-11-01' }));
    assert.ok(text.includes(NONE_MARK), text);
    assert.ok(!text.includes('line d'), 'no line of the day comes back');
    assert.ok(!text.includes(SAMPLED_MARK), text);
  } finally {
    env.done();
  }
});

test('the tool narrows a word to the place of another interface that the call names by its stored id', async () => {
  const env = memorySearchPlaceDayFixture();
  try {
    const away = channelPlaceId('telegram', 't9');
    env.db
      .prepare(
        "INSERT INTO places (id, iface, kind, native_id, chat, scope_kind, name) VALUES (?, 'telegram', 'channel', 't9', 'group', 'group', 'away')"
      )
      .run(away);
    env.say({ native: 'here', at: DAY_START + 60 * MINUTE, text: 'a kite over the home channel', place: GENERAL });
    env.say({
      native: 'there',
      at: DAY_START + 61 * MINUTE,
      text: 'a kite over the other interface',
      iface: 'telegram',
      place: away,
      scope: groupScope('telegram'),
    });
    env.stem();
    const text = textOf(await toolRig(env).ask({ terms: 'kite', placeId: away }));
    assert.ok(text.includes('over the other interface'), text);
    assert.ok(!text.includes('over the home channel'), "the line of the turn's own interface stays out");
  } finally {
    env.done();
  }
});

test('the tool still refuses a call with nothing to search', async () => {
  const env = memorySearchPlaceDayFixture();
  try {
    assert.equal((await toolRig(env).ask({})).status, 'invalid');
  } finally {
    env.done();
  }
});

test('the tool keeps a hidden channel hidden through its place rule', async () => {
  const env = memorySearchPlaceDayFixture();
  try {
    spread(env, 'shut', { from: DAY_START, to: DAY_END, count: 12, place: SECRET, text: 'κρυφο' });
    spread(env, 'open', { from: DAY_START, to: DAY_END, count: 12 });
    const rig = toolRig(env);
    const named = textOf(await rig.ask({ when: '2026-11-01', placeId: 'c4' }));
    assert.ok(!named.includes('κρυφο'), named);
    const wide = textOf(await rig.ask({ when: '2026-11-01' }));
    assert.ok(!wide.includes('κρυφο'), wide);
    assert.ok(wide.includes('line open'), wide);
  } finally {
    env.done();
  }
});

test('the place rule keeps a hidden channel stored under an opaque id hidden, read by the native id of its row', async () => {
  // Bug: the rule cut the channel's native id out of the text of its place id, which an opaque id does not spell.
  const env = memorySearchPlaceDayFixture();
  try {
    const hidden = 'place:opaque-secret';
    spread(env, 'shut', { from: DAY_START, to: DAY_END, count: 12, place: hidden, text: 'κρυφο' });
    spread(env, 'open', { from: DAY_START, to: DAY_END, count: 12 });
    const rig = toolRig(env, { secret: hidden });
    const wide = textOf(await rig.ask({ when: '2026-11-01' }));
    assert.deepEqual([wide.includes('κρυφο'), wide.includes('line open')], [false, true]);
  } finally {
    env.done();
  }
});

test('memorySearchText names a sample after the source line, and only when it holds a stretch', () => {
  const quote = { channelName: 'general', startTs: DAY_START, lines: 'line one' };
  const shown = memorySearchText([quote], { labels: toolLabels, sampled: true });
  const lines = shown.split('\n');
  assert.equal(lines[1], SAMPLED_MARK);
  assert.ok(!memorySearchText([quote], { labels: toolLabels }).includes(SAMPLED_MARK));
  assert.ok(!memorySearchText([], { labels: toolLabels, sampled: true }).includes(SAMPLED_MARK));
});

// Without the label a sampled day reads as a match for words that matched nothing.
test('the shipped labels hold the line that names a sample', () => {
  const quote = { channelName: 'general', startTs: DAY_START, lines: 'line one' };
  // The engine reads labels through joinLabels; the file itself is split by area and model.
  const shipped = joinLabels(shippedJson('labels.json') as never);
  assert.notEqual(
    memorySearchText([quote], { labels: shipped, sampled: true }),
    memorySearchText([quote], { labels: shipped })
  );
});

const QUERY = 'the opening hours';

const FOUND = {
  ok: true,
  results: [{ title: 'Hours', url: 'https://library.example.org/hours', snippet: 'Open until eight.' }],
};

type Answer = { ok: boolean; reason?: string; status?: number; results?: typeof FOUND.results };

type SearchCall = { engine: string; apiKey: unknown };

function rig({
  search = {},
  keys = {},
  brave = FOUND,
  exa = FOUND,
  complete = () => Promise.resolve({ text: 'unread', usage: {}, estimated: 1 }),
}: {
  search?: Record<string, unknown>;
  keys?: { brave?: string | null; exa?: string | null };
  brave?: Answer;
  exa?: Answer;
  complete?: (messages: unknown, options: Record<string, unknown>) => Promise<unknown>;
} = {}) {
  const searches: Array<SearchCall> = [];
  const requests: Array<Record<string, unknown>> = [];
  // Changed: quick search condenses and searches on the analyzer, so a `model` of `search` becomes the analyzer's chain,
  // and `routes` and `byPurpose` add chains and pins of their own.
  const { model, routes = {}, byPurpose = {}, ...quick } = search;
  const config = {
    models: { routes: { ...chainsOf({ analyzer: model }), ...(routes as object) }, byPurpose },
    web: { quickSearch: { enabled: true, cacheHours: 24, timeoutMs: 1000, ...quick } },
    llm: { timeoutMs: 1000 },
  };
  const client = (engine: string, answer: Answer) => ({
    search: (_query: string, options: { apiKey?: unknown }) => {
      searches.push({ engine, apiKey: options.apiKey });
      return Promise.resolve(answer);
    },
  });
  const cache = {};
  const deps = {
    hot: { config, prompts: { 'summarize/search': 'Condense the results for {{query}}.' } },
    store: { ...objectMediaCache(cache) },
    llm: {
      complete: (messages: unknown, options: Record<string, unknown>) => {
        requests.push(options);
        return complete(messages, options);
      },
    },
    pageFetcher: { fetchText: () => Promise.resolve({ ok: false, reason: 'network' }) },
    searches: { brave: client('brave', brave), exa: client('exa', exa) },
    keys,
    now: () => 1000,
    // The fakes hold the few members the lookup reads.
  } as unknown as LookupDeps;
  const lookup = createLookup(deps);
  return {
    lookup,
    config,
    searches,
    requests,
    tool: () =>
      runWebSearch({
        lookup: lookup as unknown as Parameters<typeof runWebSearch>[0]['lookup'],
        config,
        labels,
        placeId: 'g1',
        args: { query: QUERY },
      }),
  };
}

test('the tool says quick search is off and why, under the name quick-search', async () => {
  // Bug: the persona reads a bare not-configured for the web and cannot tell the owner what is missing.
  const result = await rig().tool();
  assert.equal(result.status, 'not_configured');
  assert.equal(result.code, 'not-configured');
  assert.deepEqual(result.values, { feature: 'quick-search', reason: 'no-engine' });
});

const RECALL_RUN_BOUNDARIES_NOW = Date.parse('2026-10-24T12:00:00.000Z');

const PLACE = channelPlaceId('discord', 'main');

const args = {
  placeId: 'g1',
  channel: channel('main'),
  partnerId: null,
  selfId: 'self',
  selfName: 'Persona',
  history: [],
  candidate: { content: 'rabbit' },
};

const hot = {
  config: config({ features: { recall: true, meaningSearch: false } }),
  prompts: { labels },
};

function scene(env: ReturnType<typeof recallRunBoundariesFixture>, store: object = {}) {
  // The recall fixture stores the default place's row itself.
  env.db
    .prepare(
      "INSERT OR IGNORE INTO places (id, iface, kind, native_id, scope_kind) VALUES (?, 'discord', 'channel', 'main', 'group')"
    )
    .run(PLACE);
  env.say({ native: 'boundary-before', at: RECALL_RUN_BOUNDARIES_NOW - 120000, text: 'rabbit boundary evidence' });
  env.say({ native: 'boundary-anchor', at: RECALL_RUN_BOUNDARIES_NOW - 60000, text: 'rabbit anchor evidence' });
  env.stem();
  fillEnvAudiences(env);
  return createRecall({
    mediaNameOf: noMediaNames,
    iface: 'discord',
    hot,
    store,
    now: () => RECALL_RUN_BOUNDARIES_NOW,
    llm: { capLeft: () => 100, complete: () => Promise.reject(new Error('unexpected model call')) },
    memoryDb: { database: () => env.db },
  });
}

for (const hasRoot of [false, true]) {
  test(`memory search retains database evidence ${hasRoot ? 'without an optional profile callback' : 'without reading legacy profiles for a null root'}`, async () => {
    const env = recallRunBoundariesFixture();
    try {
      const recall = scene(env);
      let profiles = 0;
      const store = hasRoot
        ? undefined
        : {
            listUserProfiles: () => {
              profiles += 1;
              return [];
            },
          };
      const memoryContext = issueContext({
        kind: 'internal',
        newId: () => 'ctx:tool-boundary',
        now: () => RECALL_RUN_BOUNDARIES_NOW,
      });
      // The tool uses only these injected dependencies for a database search.
      const result = await runMemorySearch({
        ...args,
        placeId: hasRoot ? 'g1' : null,
        recall,
        store,
        config: hot.config,
        labels,
        now: RECALL_RUN_BOUNDARIES_NOW,
        memoryContext,
        args: { question: 'rabbit' },
      });
      assert.equal(result.status, 'ok');
      const resultText = result.data?.text;
      assert.ok(resultText?.includes('rabbit boundary evidence'));
      assert.equal(profiles, 0);
    } finally {
      env.done();
    }
  });
}
