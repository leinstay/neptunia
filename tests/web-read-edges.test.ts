// `web.read` from the tool down to the wire: `runWebRead` over the real `createLookup` and the real `createPageFetcher`,
// whose request function and DNS lookup are fakes. The final URL she reads is where the page ended up, on an empty page
// too, and it never carries credentials someone wrote into a link. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createPageFetcher } from '../src/web/fetch-page.ts';
import { createLookup } from '../src/web/lookup.ts';
import { runWebRead } from '../src/tools/tools.ts';
import { labels } from './fixtures/labels.ts';
import { objectMediaCache } from '../src/memory/store-media.ts';

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
    store: { ...objectMediaCache(cache) },
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
