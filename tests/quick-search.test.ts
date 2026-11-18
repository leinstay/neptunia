// Quick search as an optional module with a chosen engine: `brave`, `exa` or `openrouter`, no built-in engine or model.
// An unset engine, or a chosen engine without what it needs, leaves quick search off with a reason the tool result
// carries; a chosen engine that fails says why and nothing else answers in its place. `createLookup` runs over fake clients and a fake model client, and
// `runWebSearch` is the tool she calls. No network, no real settings of a deployment.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import { createLookup, webSearchPlugins } from '../src/web/lookup.ts';
import type { LookupDeps } from '../src/web/lookup.ts';
import { runWebSearch } from '../src/tools/tools.ts';
import { searchCommand } from '../src/interface/commands/search.ts';
import { labels } from './fixtures/labels.ts';
import { tempDir } from './fixtures/tmp.ts';
import { chainsOf } from './fixtures/chains.ts';
import { objectMediaCache } from '../src/memory/store-media.ts';
const QUERY = 'the opening hours';
const FOUND = {
  ok: true,
  results: [{ title: 'Hours', url: 'https://library.example.org/hours', snippet: 'Open until eight.' }],
};

type Answer = { ok: boolean; reason?: string; status?: number; results?: typeof FOUND.results };
type SearchCall = { engine: string; apiKey: unknown };
type Failed = { failed: { code: string; reason?: string; engine?: string; status?: number } };

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
    hot: { config, prompts: { 'search-summary': 'Condense the results for {{query}}.' } },
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

test('an unset engine is off with its reason, and no engine or model request runs', async () => {
  // Bug: quick search silently goes to Brave, the old built-in engine, before anyone chose one.
  const { lookup, searches, requests } = rig();
  assert.equal(lookup.hasSearch(), false);
  assert.equal(lookup.searchEngine(), null);
  assert.deepEqual(await lookup.searchResults('g1', QUERY), {
    failed: { code: 'not-configured', reason: 'no-engine' },
  });
  assert.deepEqual(searches, []);
  assert.deepEqual(requests, []);
});

test('an engine outside the three is off as an unset one is', async () => {
  // Bug: a typo in the setting quietly selects Brave.
  const { lookup, searches } = rig({ search: { engine: 'bing' }, keys: { brave: 'brave-key' } });
  assert.equal(lookup.searchEngine(), null);
  assert.deepEqual(await lookup.searchResults('g1', QUERY), {
    failed: { code: 'not-configured', reason: 'no-engine' },
  });
  assert.deepEqual(searches, []);
});

test('the openrouter engine with no chain of its own runs on the analyzer', async () => {
  // Changed: quick search has no chain of its own, so `openrouter` with no route set is on, on the analyzer's model.
  // Bug: quick search stays off waiting for a chain the routing no longer has.
  const { lookup, requests } = rig({ search: { engine: 'openrouter' } });
  assert.equal(lookup.hasSearch(), true);
  await lookup.searchResults('g1', QUERY);
  assert.equal(requests[0]?.role, 'analyzer');
  assert.equal(requests[0]?.model, 'openai/gpt-6.1-sol');
});

test('exa with no chain named search condenses on the analyzer chain', async () => {
  // Bug: the summary still waits for the retired `search` chain, so Exa finds results and the persona reads none.
  const { lookup, requests } = rig({
    search: { engine: 'exa', model: 'x/analyzer' },
    keys: { exa: 'exa-key' },
    complete: () => Promise.resolve({ text: 'Open until eight.', usage: {}, estimated: 1 }),
  });
  const found = await lookup.search('g1', QUERY);
  assert.equal(found?.text, 'Open until eight.');
  assert.equal(requests.length, 1);
  assert.equal(requests[0]?.role, 'analyzer');
  assert.equal(requests[0]?.model, 'x/analyzer');
  assert.equal(requests[0]?.purpose, 'search-summary');
});

test('a chain under models.routes.search is not read', async () => {
  // Bug: a deployment's old `search` chain still picks the model of the summary.
  const { lookup, requests } = rig({
    search: { engine: 'exa', model: 'x/analyzer', routes: chainsOf({ search: 'x/old-search' }) },
    keys: { exa: 'exa-key' },
  });
  await lookup.search('g1', QUERY);
  assert.equal(requests[0]?.model, 'x/analyzer');
});

test('the purpose pins of models.byPurpose decide the model of each search request', async () => {
  // Bug: the summary or the openrouter search takes the analyzer's model past the pin the owner set for that one job.
  const exa = rig({
    search: { engine: 'exa', model: 'x/analyzer', byPurpose: { 'search-summary': 'x/pinned' } },
    keys: { exa: 'exa-key' },
  });
  await exa.lookup.search('g1', QUERY);
  const [summary] = exa.requests;
  assert.equal(summary?.model, 'x/pinned');
  const routed = rig({
    search: { engine: 'openrouter', model: 'x/analyzer', byPurpose: { 'quick-search': 'x/raw' } },
  });
  await routed.lookup.searchResults('g1', QUERY);
  const [raw] = routed.requests;
  assert.equal(raw?.model, 'x/raw');
  assert.equal(raw?.role, 'analyzer');
});

test('the tool says quick search is off and why, under the name quick-search', async () => {
  // Bug: she reads a bare not-configured for the web and cannot tell the owner what is missing.
  const result = await rig().tool();
  assert.equal(result.status, 'not_configured');
  assert.equal(result.code, 'not-configured');
  assert.deepEqual(result.values, { feature: 'quick-search', reason: 'no-engine' });
});

test('the status command reads off while no engine is set', () => {
  // Bug: `/search status` says on while every search is refused.
  const dataDir = tempDir('nep-quick-search-status-');
  assert.match(searchCommand(dataDir, 'search.status', {}).text, /quick search is off/);
});

test('the openrouter request carries the plugin engine auto under the purpose quick-search', async () => {
  // Bug: the plugin stays pinned on Exa, whose billing and limits the owner did not choose.
  const annotations = [
    {
      type: 'url_citation',
      url_citation: { url: 'https://library.example.org/hours', title: 'Hours', content: 'Eight.' },
    },
  ];
  const { lookup, requests } = rig({
    search: { engine: 'openrouter', model: 'x/quick' },
    complete: () => Promise.resolve({ text: 'unread', usage: {}, estimated: 1, annotations }),
  });
  assert.equal(lookup.hasSearch(), true);
  // OpenRouter refuses `auto`, measured 2026-11-05
  assert.deepEqual(webSearchPlugins(5), [{ id: 'web', max_results: 5 }]);
  const found = await lookup.searchResults('g1', QUERY);
  // OpenRouter refuses `auto`, measured 2026-11-05
  assert.deepEqual(requests[0]?.plugins, [{ id: 'web', max_results: 5 }]);
  assert.equal(requests[0]?.purpose, 'quick-search');
  // Changed: the openrouter engine sends its search on the analyzer's chain.
  assert.equal(requests[0]?.role, 'analyzer');
  assert.deepEqual(found, {
    query: QUERY,
    results: [
      { title: 'Hours', url: 'https://library.example.org/hours', site: 'library.example.org', snippet: 'Eight.' },
    ],
  });
});

for (const engine of ['brave', 'exa'] as const) {
  test(`${engine} without its key is unavailable, and a listed fallback does not answer for it`, async () => {
    // Bug: Exa's keyless endpoint or a fallback answers for an engine the owner chose and never gave a key.
    const other = engine === 'brave' ? 'exa' : 'brave';
    const { lookup, searches, requests } = rig({
      search: { engine, model: 'x/quick', fallback: [other, 'openrouter'] },
      keys: { [other]: 'other-key' },
    });
    assert.equal(lookup.hasSearch(), false);
    assert.deepEqual(await lookup.searchResults('g1', QUERY), {
      failed: { code: 'not-configured', reason: 'no-key', engine },
    });
    assert.deepEqual(searches, []);
    assert.deepEqual(requests, []);
  });
}

test('exa with its key searches on that key', async () => {
  // Bug: the key is given and the client still goes to the keyless endpoint.
  const { lookup, searches } = rig({ search: { engine: 'exa' }, keys: { exa: 'exa-key' } });
  assert.equal(lookup.hasSearch(), true);
  await lookup.searchResults('g1', QUERY);
  assert.deepEqual(searches, [{ engine: 'exa', apiKey: 'exa-key' }]);
  assert.equal(lookup.searchEngine(), 'exa');
  // Asked apart from the check above: the same engine without the key is the refusal.
  const bare = rig({ search: { engine: 'exa' } });
  assert.equal(bare.lookup.hasSearch(), false);
});

test('a timeout says timeout and no other engine is asked', async () => {
  // Bug: she reads only "provider", and an unlisted engine or the model request stands in without a word.
  const { lookup, searches, requests } = rig({
    search: { engine: 'brave', model: 'x/quick' },
    keys: { brave: 'brave-key', exa: 'exa-key' },
    brave: { ok: false, reason: 'timeout' },
  });
  const answer = (await lookup.searchResults('g1', QUERY)) as Failed;
  assert.equal(answer.failed.code, 'provider');
  assert.equal(answer.failed.reason, 'timeout');
  assert.equal(answer.failed.engine, 'brave');
  assert.deepEqual(
    searches.map((call) => call.engine),
    ['brave']
  );
  assert.deepEqual(requests, []);
});

test('a rate limit says rate-limited with its status, on the tool result too', async () => {
  // Bug: a busy engine and a broken one read the same, so she retries at once or gives up for good.
  const { tool } = rig({
    search: { engine: 'brave' },
    keys: { brave: 'brave-key' },
    brave: { ok: false, reason: 'http', status: 429 },
  });
  const result = await tool();
  assert.equal(result.status, 'failed');
  assert.equal(result.code, 'provider');
  const values = result.values as Record<string, unknown>;
  assert.equal(values.feature, 'quick-search');
  assert.equal(values.reason, 'rate-limited');
  assert.equal(values.engine, 'brave');
  assert.equal(String(values.status), '429');
});

test('refused credentials say credentials, on either kind of engine, and no fallback answers', async () => {
  // Bug: a revoked key reads as a passing outage, and a fallback hides it from the owner.
  const brave = rig({
    search: { engine: 'brave', fallback: ['exa'] },
    keys: { brave: 'bad-key', exa: 'exa-key' },
    brave: { ok: false, reason: 'http', status: 401 },
  });
  assert.deepEqual(await brave.lookup.searchResults('g1', QUERY), {
    failed: { code: 'provider', reason: 'credentials', engine: 'brave', status: 401 },
  });
  assert.deepEqual(
    brave.searches.map((call) => call.engine),
    ['brave']
  );
  const routed = rig({
    search: { engine: 'openrouter', model: 'x/quick', fallback: ['exa'] },
    keys: { exa: 'exa-key' },
    complete: () => Promise.reject(Object.assign(new Error('refused'), { statusCode: 403 })),
  });
  assert.deepEqual(await routed.lookup.searchResults('g1', QUERY), {
    failed: { code: 'provider', reason: 'credentials', engine: 'openrouter', status: 403 },
  });
  assert.deepEqual(routed.searches, []);
});

test('the openrouter engine with no key for its role is off with the reason no-key', async () => {
  // Bug: a missing binding is reported as a provider failure, so the owner looks at the wrong thing.
  const { lookup } = rig({
    search: { engine: 'openrouter', model: 'x/quick' },
    complete: () => Promise.reject(Object.assign(new Error('no key'), { code: 'ROLE_KEY_MISSING' })),
  });
  assert.deepEqual(await lookup.searchResults('g1', QUERY), {
    failed: { code: 'not-configured', reason: 'no-key', engine: 'openrouter' },
  });
});
