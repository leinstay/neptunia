// A link's stored text form (master plan V.8). When she reads a page with `web.read`, the extracted text becomes what the
// link holds, in place of the preview's opening, so she can speak of the page later: any link to that address reads it from
// then on, with no fetch and past the page cache's hours. `createLookup` over a fake page fetcher and an in-memory media
// cache; no network. Synthetic text only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatTranscript } from '../src/format.ts';
import { runWebRead } from '../src/tools/tools.ts';
import { createLookup } from '../src/web/lookup.ts';
import type { LookupDeps } from '../src/web/lookup.ts';
import { labels } from './fixtures/labels.ts';
import { objectMediaCache } from '../src/memory/store-media.ts';
import { createPageFetcher } from '../src/web/fetch-page.ts';

const PLACE = 'g1';
const URL_A = 'https://example.org/a';
const NOW = Date.UTC(2026, 10, 5, 12);
const HOUR = 3_600_000;
const WHOLE = 'mot '.repeat(600).trim();
const LINK = { id: 'link-1', kind: 'link', url: URL_A };

type Page = { ok: boolean; text?: string; title?: string; finalUrl?: string; reason?: string };

function rig(pages: Record<string, Page> = { [URL_A]: { ok: true, text: WHOLE, title: 'Une page', finalUrl: URL_A } }) {
  const clock = { now: NOW };
  const fetched: Array<string> = [];
  const cache: Record<string, unknown> = {};
  const lookup = createLookup({
    hot: { config: { web: { links: { fetchTimeoutMs: 1000, readCacheHours: 2 } } }, prompts: {} },
    store: { ...objectMediaCache(cache) },
    llm: { complete: () => Promise.reject(new Error('reading a page sends no model request')) },
    pageFetcher: {
      fetchText: (url: string) => {
        fetched.push(url);
        return Promise.resolve(pages[url] ?? { ok: false, reason: 'network' });
      },
    },
    now: () => clock.now,
    // The fakes hold the few members these reads use.
  } as unknown as LookupDeps);
  return { lookup, clock, fetched, pages };
}

// Bug: the read is thrown away with the turn and the link goes on showing its first 700 characters.
test('after web.read the link holds the extracted text', async () => {
  const { lookup } = rig();
  await lookup.readPage(PLACE, URL_A);
  assert.equal(lookup.cachedReads(PLACE, [LINK]).get(LINK.id), WHOLE);
});

// Bug: a preview taken before the read wins, and the fuller text never replaces it.
test('the extracted text replaces a preview the link already holds', async () => {
  const { lookup } = rig();
  const { reads } = await lookup.readLinks(PLACE, [LINK]);
  assert.ok(String(reads.get(LINK.id)).length < WHOLE.length, 'the preview is the opening');
  await lookup.readPage(PLACE, URL_A);
  assert.equal(lookup.cachedReads(PLACE, [LINK]).get(LINK.id), WHOLE);
});

// Bug: the next message with the link fetches the page again for a shorter text than she already read.
test('a link she has read is served with no fetch', async () => {
  const { lookup, fetched } = rig();
  await lookup.readPage(PLACE, URL_A);
  const { reads, newCount } = await lookup.readLinks(PLACE, [LINK]);
  assert.equal(reads.get(LINK.id), WHOLE);
  assert.equal(newCount, 0);
  assert.equal(fetched.length, 1);
});

// Bug: the text form lives under the link's id, so the same address posted again later reads as unknown.
test('another link to the same address holds the text too', async () => {
  const { lookup } = rig();
  await lookup.readPage(PLACE, URL_A);
  const later = { id: 'link-2', kind: 'link', url: URL_A };
  assert.equal(lookup.cachedReads(PLACE, [later]).get(later.id), WHOLE);
});

// Bug: the text form expires with the page cache, so she can speak of a page only for its first hours.
test('the text form outlives the hours a page read is cached', async () => {
  const { lookup, clock } = rig();
  await lookup.readPage(PLACE, URL_A);
  clock.now += 3 * HOUR;
  assert.equal(lookup.cachedReads(PLACE, [LINK]).get(LINK.id), WHOLE);
});

// Bug: reading the page again after its text changed leaves the old form standing.
test('a later read of a changed page replaces the text form', async () => {
  const { lookup, clock, pages } = rig();
  await lookup.readPage(PLACE, URL_A);
  clock.now += 3 * HOUR;
  pages[URL_A] = { ok: true, text: 'nouvelle page', title: 'Une page', finalUrl: URL_A };
  await lookup.readPage(PLACE, URL_A);
  assert.equal(lookup.cachedReads(PLACE, [LINK]).get(LINK.id), 'nouvelle page');
});

// Bug: a failed read wipes the preview she had.
test('a failed read leaves what the link held', async () => {
  const { lookup, pages } = rig();
  await lookup.readLinks(PLACE, [LINK]);
  const before = lookup.cachedReads(PLACE, [LINK]).get(LINK.id);
  pages[URL_A] = { ok: false, reason: 'http' };
  const page = await lookup.readPage(PLACE, `${URL_A}?again`);
  assert.equal(page.ok, false);
  assert.equal(lookup.cachedReads(PLACE, [LINK]).get(LINK.id), before);
});

// Bug: one page's text lands on every link of the place.
test('a link to another address is not touched', async () => {
  const { lookup } = rig();
  await lookup.readPage(PLACE, URL_A);
  const other = { id: 'link-3', kind: 'link', url: 'https://example.org/b' };
  assert.equal(lookup.cachedReads(PLACE, [other]).has(other.id), false);
});

// Bug: a read she started from a message, the usual way, takes another path and stores nothing.
test('web.read of a message stores the text form of the link it found', async () => {
  const { lookup } = rig();
  const result = await runWebRead({
    lookup: lookup as unknown as Parameters<typeof runWebRead>[0]['lookup'],
    labels,
    placeId: PLACE,
    args: { message: '#3' },
    linkOf: () => URL_A,
  });
  assert.equal(result.status, 'ok');
  assert.equal(lookup.cachedReads(PLACE, [LINK]).get(LINK.id), WHOLE);
});

// Bug: a read page of 4000 characters rides on every later render of its line and crowds the chat out of the budget.
test('a line of chat shows a read link cut at what a preview shows', () => {
  const [line] = formatTranscript(
    [{ id: 'm1', ts: NOW, authorId: 'u1', authorName: 'Zoë', content: URL_A, links: [LINK] }],
    { labels, timezone: 'UTC', selfName: 'Bot', now: NOW, reads: new Map([[LINK.id, WHOLE]]) }
  );
  const shown = line.text.match(/mot/g)?.length ?? 0;
  assert.ok(shown > 100 && shown <= 700 / 4, `${shown} words of the page`);
});

// `web.read` from the tool down to the wire: `runWebRead` over the real `createLookup` and the real `createPageFetcher`,
// whose request function and DNS lookup are fakes. The final URL she reads is where the page ended up, on an empty page
// too, and it never carries credentials someone wrote into a link. No network.

const PUBLIC = '93.184.216.34';

type Route = { status: number; headers: Record<string, string>; body?: string };

function reader(routes: Record<string, Route>) {
  const requested: Array<string> = [];
  const pageFetcher = createPageFetcher({
    lookup: () => Promise.resolve([{ address: PUBLIC, family: 4 }]),
    requestImpl: (url) => {
      requested.push(url);
      const route = routes[url];
      if (route === undefined) return Promise.reject(new TypeError('no route'));
      const chunks = route.body === undefined ? [] : [new TextEncoder().encode(route.body)];
      return Promise.resolve({
        status: route.status,
        headers: route.headers,
        body: {
          *[Symbol.asyncIterator]() {
            yield* chunks;
          },
        } as never,
      });
    },
  });
  const cache: Record<string, unknown> = {};
  const lookup = createLookup({
    hot: { config: { web: { links: { fetchTimeoutMs: 1000, readCacheHours: 24 } } }, prompts: {} },
    store: objectMediaCache(cache),
    llm: { complete: () => Promise.reject(new Error('web.read sends no model request')) },
    pageFetcher,
    now: () => 1000,
    // The fakes hold the few members web.read uses.
  });
  return {
    requested,
    cache,
    read: (url: string) =>
      runWebRead({
        lookup: lookup as unknown as Parameters<typeof runWebRead>[0]['lookup'],
        labels,
        placeId: 'g1',
        args: { url },
      }),
  };
}

test('an empty page behind a redirect names the address it ended at', async () => {
  // Bug: she is told the short link had no text and goes on citing an address that is not where the page lives.
  const { read } = reader({
    'https://short.example.org/a': { status: 302, headers: { location: 'https://final.example.org/end' } },
    'https://final.example.org/end': {
      status: 200,
      headers: { 'content-type': 'text/html' },
      body: '<html><body></body></html>',
    },
  });
  const result = await read('https://short.example.org/a');
  assert.equal(result.status, 'ok');
  const text = String((result.data as { text?: unknown } | undefined)?.text);
  assert.ok(text.includes('https://final.example.org/end'), text);
  assert.ok(!text.includes('short.example.org'), text);
});

test('credentials written into a link reach neither the text she reads nor the cache', async () => {
  // Bug: a password in a pasted or redirected link lands in her context, then in her memory as the page's source.
  const { read, cache } = reader({
    'https://reader:hunter2@host.example.org/doc': {
      status: 200,
      headers: { 'content-type': 'text/plain' },
      body: 'The plain document.',
    },
    'https://host.example.org/doc': {
      status: 200,
      headers: { 'content-type': 'text/plain' },
      body: 'The plain document.',
    },
  });
  const result = await read('https://reader:hunter2@host.example.org/doc');
  assert.equal(result.status, 'ok');
  assert.ok(!JSON.stringify(result).includes('hunter2'));
  assert.ok(!JSON.stringify(cache).includes('hunter2'));
});
