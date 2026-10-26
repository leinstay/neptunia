// Tests for src/web/brave.js: the Brave Search request (URL, query encoding,
// count cap, headers), result parsing with snippet cleaning, every
// failure reason, and logs that carry a reason and a status only -- never the
// query, never the key. fetch is a fake; nothing touches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createBraveSearch } from '../src/web/brave.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';

const KEY = 'test-key-abc123';

function jsonResponse(payload, { status = 200 } = {}) {
  const text = typeof payload === 'string' ? payload : JSON.stringify(payload);
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name) => (name.toLowerCase() === 'content-type' ? 'application/json' : null) },
    text: async () => text,
  };
}

function fakeFetch(response) {
  const calls = [];
  const fetchImpl = async (url, options) => {
    calls.push({ url, options });
    if (response instanceof Error) throw response;
    return typeof response === 'function' ? response(url, options) : response;
  };
  return { calls, fetchImpl };
}

const RESULTS = {
  web: {
    results: [
      {
        title: 'The <strong>Aegean</strong> &amp; its islands',
        url: 'https://example.org/aegean',
        description:
          'A guide to the <strong>Aegean</strong> sea &mdash; \u03b8\u03ac\u03bb\u03b1\u03c3\u03c3\u03b1, caf&eacute;s and\n  ferries.',
        age: '2 days ago',
      },
      { title: 'Second', url: 'https://example.com/b', description: 'Plain snippet.' },
      { title: 'No url at all', description: 'dropped' },
      { title: 'Bad scheme', url: 'javascript:alert(1)', description: 'dropped' },
    ],
  },
};

async function run(search, query, options) {
  return withCapturedLogs(() => search.search(query, options));
}

test('search: request shape -- endpoint, encoded query, count, headers', async () => {
  const { calls, fetchImpl } = fakeFetch(jsonResponse(RESULTS));
  const brave = createBraveSearch({ fetchImpl });
  await run(brave, 'caf\u00e9 & \u03b1\u03b2\u03b3?', { apiKey: KEY, timeoutMs: 5000 });
  assert.equal(calls.length, 1);
  const url = new URL(calls[0].url);
  assert.equal(`${url.origin}${url.pathname}`, 'https://api.search.brave.com/res/v1/web/search');
  assert.equal(url.searchParams.get('q'), 'caf\u00e9 & \u03b1\u03b2\u03b3?');
  assert.equal(url.searchParams.get('count'), '5');
  assert.ok(
    calls[0].url.startsWith(
      `https://api.search.brave.com/res/v1/web/search?q=${encodeURIComponent('caf\u00e9 & \u03b1\u03b2\u03b3?')}&count=5`
    )
  );
  assert.equal(calls[0].options.method, 'GET');
  assert.deepEqual(calls[0].options.headers, {
    Accept: 'application/json',
    'Accept-Encoding': 'gzip',
    'X-Subscription-Token': KEY,
  });
  assert.ok(calls[0].options.signal);
});

test('search: count is capped at 10, floored at 1, and defaults to 5', async () => {
  const counts = [];
  for (const count of [25, 0, 3.7, 'x', undefined]) {
    const { calls, fetchImpl } = fakeFetch(jsonResponse(RESULTS));
    await run(createBraveSearch({ fetchImpl }), 'q', { apiKey: KEY, count, timeoutMs: 5000 });
    counts.push(new URL(calls[0].url).searchParams.get('count'));
  }
  assert.deepEqual(counts, ['10', '1', '3', '5', '5']);
});

test('search: parses web.results, cleans titles and snippets, keeps age, drops entries without an http(s) url', async () => {
  const { fetchImpl } = fakeFetch(jsonResponse(RESULTS));
  const { result, logs } = await run(createBraveSearch({ fetchImpl }), 'aegean', { apiKey: KEY, timeoutMs: 5000 });
  assert.deepEqual(result, {
    ok: true,
    results: [
      {
        title: 'The Aegean & its islands',
        url: 'https://example.org/aegean',
        snippet: 'A guide to the Aegean sea \u2014 \u03b8\u03ac\u03bb\u03b1\u03c3\u03c3\u03b1, caf\u00e9s and ferries.',
        age: '2 days ago',
      },
      { title: 'Second', url: 'https://example.com/b', snippet: 'Plain snippet.' },
    ],
  });
  assert.equal(logs.length, 0);
});

test('search: never returns more results than count', async () => {
  const many = {
    web: {
      results: Array.from({ length: 12 }, (_, i) => ({
        title: `t${i}`,
        url: `https://e.example/${i}`,
        description: 'd',
      })),
    },
  };
  const { fetchImpl } = fakeFetch(jsonResponse(many));
  const { result } = await run(createBraveSearch({ fetchImpl }), 'q', { apiKey: KEY, count: 3, timeoutMs: 5000 });
  assert.deepEqual(
    result.results.map((r) => r.title),
    ['t0', 't1', 't2']
  );
});

test('search: an empty or missing key fails with no-key and sends nothing', async () => {
  const { calls, fetchImpl } = fakeFetch(jsonResponse(RESULTS));
  const brave = createBraveSearch({ fetchImpl });
  for (const apiKey of ['', '   ', undefined, null, 42]) {
    const { result } = await run(brave, 'q', { apiKey, timeoutMs: 5000 });
    assert.deepEqual(result, { ok: false, reason: 'no-key' });
  }
  assert.deepEqual((await run(brave, 'q')).result, { ok: false, reason: 'no-key' });
  assert.equal(calls.length, 0);
});

test('search: a non-2xx status fails with http and the status', async () => {
  const { fetchImpl } = fakeFetch(jsonResponse({ error: 'nope' }, { status: 429 }));
  const { result } = await run(createBraveSearch({ fetchImpl }), 'q', { apiKey: KEY, timeoutMs: 5000 });
  assert.deepEqual(result, { ok: false, reason: 'http', status: 429 });
});

test('search: a body that is not JSON fails with http', async () => {
  const { fetchImpl } = fakeFetch(jsonResponse('<html>oops</html>'));
  const { result } = await run(createBraveSearch({ fetchImpl }), 'q', { apiKey: KEY, timeoutMs: 5000 });
  assert.deepEqual(result, { ok: false, reason: 'http', status: 200 });
});

test('search: a request hanging past timeoutMs fails with timeout', async () => {
  const fetchImpl = (url, { signal }) =>
    new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
  const { result } = await run(createBraveSearch({ fetchImpl }), 'q', { apiKey: KEY, timeoutMs: 20 });
  assert.deepEqual(result, { ok: false, reason: 'timeout' });
});

test('search: a thrown fetch or a missing response fails with network', async () => {
  const thrown = fakeFetch(new TypeError('fetch failed'));
  assert.deepEqual(
    (await run(createBraveSearch({ fetchImpl: thrown.fetchImpl }), 'q', { apiKey: KEY, timeoutMs: 5000 })).result,
    { ok: false, reason: 'network' }
  );
  const empty = fakeFetch(null);
  assert.deepEqual(
    (await run(createBraveSearch({ fetchImpl: empty.fetchImpl }), 'q', { apiKey: KEY, timeoutMs: 5000 })).result,
    { ok: false, reason: 'network' }
  );
});

test('search: no usable results fails with empty, without a warn line (a normal outcome); a blank query too, without a request but warned', async () => {
  for (const payload of [{}, { web: {} }, { web: { results: [] } }, { web: { results: [{ title: 'x' }] } }]) {
    const { fetchImpl } = fakeFetch(jsonResponse(payload));
    const { result, logs } = await run(createBraveSearch({ fetchImpl }), 'q', { apiKey: KEY, timeoutMs: 5000 });
    assert.deepEqual(result, { ok: false, reason: 'empty' }, JSON.stringify(payload));
    assert.equal(logs.length, 0, JSON.stringify(payload));
  }
  const { calls, fetchImpl } = fakeFetch(jsonResponse(RESULTS));
  const { result, logs } = await run(createBraveSearch({ fetchImpl }), '   ', { apiKey: KEY, timeoutMs: 5000 });
  assert.deepEqual(result, { ok: false, reason: 'empty' });
  assert.equal(calls.length, 0);
  assert.deepEqual(
    logs.map((l) => [l.level, l.msg, l.reason]),
    [['warn', 'brave: search failed', 'empty']]
  );
});

test('search: failure logs carry reason and status only, never the query or the key', async () => {
  const { fetchImpl } = fakeFetch(jsonResponse({ error: 'bad' }, { status: 401 }));
  const { logs } = await run(createBraveSearch({ fetchImpl }), 'secret-query-words', { apiKey: KEY, timeoutMs: 5000 });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, 'warn');
  assert.equal(logs[0].msg, 'brave: search failed');
  assert.equal(logs[0].reason, 'http');
  assert.equal(logs[0].status, 401);
  const serialized = JSON.stringify(logs);
  assert.ok(!serialized.includes('secret-query-words'));
  assert.ok(!serialized.includes(KEY));
  assert.ok(!serialized.includes('api.search.brave.com/res/v1/web/search?'));
});
