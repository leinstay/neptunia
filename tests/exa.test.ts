// Tests for src/web/exa.ts: the MCP tools/call request (endpoint, body,
// headers, count clamp, the key as a bearer header only when given), both
// answer transports (an event stream and plain JSON), both documented forms of
// the tool's text (JSON and formatted lines), the shape recorded from the live
// probe (the rate-limit flag), every failure reason, and logs that carry a
// reason and a status only. fetch is a fake; nothing touches the network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createExaSearch, parseExaText } from '../src/web/exa.ts';
import { withCapturedLogs } from './fixtures/capture-logs.ts';
import type { Untyped } from '../src/tools/types.ts';
import { wrongly } from './fixtures/loose-types.ts';

const KEY = 'exa-test-key-xyz';
const ENDPOINT = 'https://mcp.exa.ai/mcp';

function rawResponse(text: string, { status = 200, type = 'text/event-stream' } = {}) {
  return {
    status,
    ok: status >= 200 && status < 300,
    headers: { get: (name: string) => (name.toLowerCase() === 'content-type' ? type : null) },
    text: async () => text,
  };
}

/** The tool answer `{ result: { _meta, content: [{ type, text }] } }` as one SSE `data:` line (the probed transport). */
function sseAnswer(
  text: string,
  { meta = { 'ai.exa/rateLimited': false }, isError }: { meta?: Record<string, boolean>; isError?: boolean } = {}
) {
  const result: Record<string, unknown> = { _meta: meta, content: [{ type: 'text', text }] };
  if (isError !== undefined) result.isError = isError;
  return rawResponse(`event: message\ndata: ${JSON.stringify({ result, jsonrpc: '2.0', id: 1 })}\n\n`);
}

function fakeFetch(response: Untyped) {
  const calls: Array<Untyped> = [];
  const fetchImpl = async (url: Untyped, options: Untyped) => {
    calls.push({ url, options });
    if (response instanceof Error) throw response;
    return typeof response === 'function' ? response(url, options) : response;
  };
  return { calls, fetchImpl };
}

const JSON_TEXT = JSON.stringify({
  requestId: 'r1',
  results: [
    {
      id: 'a',
      title: 'OpenRouter  API\nReference',
      url: 'https://example.org/api',
      publishedDate: '2026-09-01T00:00:00.000Z',
      author: 'x',
      text: 'One API\n  for many   models.',
    },
    { title: 'Second', url: 'https://example.com/b', highlights: ['first part.', 'second part.'] },
    { title: 'No date', url: 'https://example.net/c', summary: 'A summary.' },
    { title: 'No url', text: 'dropped' },
    { title: 'Bad scheme', url: 'javascript:alert(1)', text: 'dropped' },
  ],
});

const LINES_TEXT = [
  'Title: OpenRouter API Reference',
  'URL: https://example.org/api',
  'Published Date: 2026-09-01T00:00:00.000Z',
  'Author: someone',
  'Text: One API for many models.',
  'It routes requests.',
  '',
  '---',
  '',
  'Title: Second',
  'URL: https://example.com/b',
  'Highlights:',
  'first part.',
  'second part.',
  '',
  'Title: Without a url',
  'Text: dropped',
  '',
  'Title: Bad scheme',
  'URL: ftp://example.com/file',
].join('\n');

async function run(exa: Record<string, Untyped>, query: Untyped, options: Record<string, Untyped>) {
  return withCapturedLogs(() => exa.search(query, options));
}

test('search: request shape -- endpoint, JSON-RPC tools/call body, headers, no key header when keyless', async () => {
  const { calls, fetchImpl } = fakeFetch(sseAnswer(JSON_TEXT));
  const exa = createExaSearch({ fetchImpl });
  await run(exa, '  caf\u00e9 & co  ', { timeoutMs: 5000 });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, ENDPOINT);
  assert.equal(calls[0].options.method, 'POST');
  assert.deepEqual(calls[0].options.headers, {
    'Content-Type': 'application/json',
    Accept: 'application/json, text/event-stream',
  });
  const body = JSON.parse(calls[0].options.body);
  assert.equal(body.jsonrpc, '2.0');
  assert.equal(body.method, 'tools/call');
  assert.equal(typeof body.id, 'number');
  assert.deepEqual(body.params, { name: 'web_search_exa', arguments: { query: 'caf\u00e9 & co', numResults: 5 } });
  assert.ok(calls[0].options.signal);
  for (const apiKey of [null, '', '   ', undefined, 42]) {
    const keyless = fakeFetch(sseAnswer(JSON_TEXT));
    await run(createExaSearch({ fetchImpl: keyless.fetchImpl }), 'q', { apiKey, timeoutMs: 5000 });
    assert.equal(keyless.calls[0].options.headers.Authorization, undefined);
  }
});

test('search: a key is sent as a bearer header; a custom endpoint is used', async () => {
  const { calls, fetchImpl } = fakeFetch(sseAnswer(JSON_TEXT));
  await run(createExaSearch({ fetchImpl, endpoint: 'https://exa.example/mcp' }), 'q', {
    apiKey: ` ${KEY} `,
    timeoutMs: 5000,
  });
  assert.equal(calls[0].url, 'https://exa.example/mcp');
  assert.equal(calls[0].options.headers.Authorization, `Bearer ${KEY}`);
});

test('search: numResults is clamped to 1..10 and defaults to 5', async () => {
  const counts = [];
  for (const count of [25, 0, 3.7, 'x', undefined]) {
    const { calls, fetchImpl } = fakeFetch(sseAnswer(JSON_TEXT));
    await run(createExaSearch({ fetchImpl }), 'q', { count, timeoutMs: 5000 });
    counts.push(JSON.parse(calls[0].options.body).params.arguments.numResults);
  }
  assert.deepEqual(counts, [10, 1, 3, 5, 5]);
});

test('search: a good answer (event stream, JSON text) -> items with age from publishedDate, entries without an http(s) url dropped', async () => {
  const { fetchImpl } = fakeFetch(sseAnswer(JSON_TEXT));
  const { result, logs } = await run(createExaSearch({ fetchImpl }), 'openrouter api', { timeoutMs: 5000 });
  assert.deepEqual(result, {
    ok: true,
    results: [
      {
        title: 'OpenRouter API Reference',
        url: 'https://example.org/api',
        snippet: 'One API for many models.',
        age: '2026-09-01T00:00:00.000Z',
      },
      { title: 'Second', url: 'https://example.com/b', snippet: 'first part. second part.' },
      { title: 'No date', url: 'https://example.net/c', snippet: 'A summary.' },
    ],
  });
  assert.equal(logs.length, 0);
});

test('search: a plain JSON body is read like the stream; a bare results array too', async () => {
  const message = {
    jsonrpc: '2.0',
    id: 1,
    result: {
      content: [{ type: 'text', text: JSON.stringify([{ title: 'T', url: 'https://e.example/1', text: 's' }]) }],
    },
  };
  const { fetchImpl } = fakeFetch(rawResponse(JSON.stringify(message), { type: 'application/json' }));
  const { result } = await run(createExaSearch({ fetchImpl }), 'q', { timeoutMs: 5000 });
  assert.deepEqual(result, { ok: true, results: [{ title: 'T', url: 'https://e.example/1', snippet: 's' }] });
});

test('parseExaText: the formatted text form -- Title/URL/Published Date/Text lines, continuation lines, separators', () => {
  assert.deepEqual(parseExaText(LINES_TEXT, 10), [
    {
      title: 'OpenRouter API Reference',
      url: 'https://example.org/api',
      snippet: 'One API for many models. It routes requests.',
      age: '2026-09-01T00:00:00.000Z',
    },
    { title: 'Second', url: 'https://example.com/b', snippet: 'first part. second part.' },
  ]);
  assert.deepEqual(parseExaText('', 5), []);
  assert.deepEqual(parseExaText(null, 5), []);
});

test('parseExaText: the live label set -- Title/URL/Published/Author/Highlights then page text; N/A or empty Published leaves age out', () => {
  const text = [
    'Title: Harbour Timetable',
    'URL: https://example.org/timetable',
    'Published: 2026-10-01T00:00:00.000Z',
    'Author: N/A',
    'Highlights:',
    'Ferries leave every hour.',
    'Last one at midnight.',
    '',
    'Title: Café Notes',
    'URL: https://example.com/cafe',
    'Published: N/A',
    'Author: someone',
    'Highlights:',
    'Open late.',
    '',
    'Title: Lower Case',
    'URL: https://example.net/lower',
    'Published: n/a',
    'Highlights:',
    'Quiet.',
    '',
    'Title: Empty Date',
    'URL: https://example.net/empty',
    'Published:',
    'Highlights:',
    'Nothing.',
  ].join('\n');
  assert.deepEqual(parseExaText(text, 10), [
    {
      title: 'Harbour Timetable',
      url: 'https://example.org/timetable',
      snippet: 'Ferries leave every hour. Last one at midnight.',
      age: '2026-10-01T00:00:00.000Z',
    },
    { title: 'Café Notes', url: 'https://example.com/cafe', snippet: 'Open late.' },
    { title: 'Lower Case', url: 'https://example.net/lower', snippet: 'Quiet.' },
    { title: 'Empty Date', url: 'https://example.net/empty', snippet: 'Nothing.' },
  ]);
  const json = JSON.stringify({
    results: [{ title: 'J', url: 'https://e.example/j', publishedDate: 'N/A', text: 's' }],
  });
  assert.deepEqual(parseExaText(json, 5), [{ title: 'J', url: 'https://e.example/j', snippet: 's' }]);
});

// The owner on 2026-11-17: a text over its bound is summarized or kept whole, never cut.
test('parseExaText: at most count items; a long snippet is kept whole', () => {
  const many = JSON.stringify({
    results: Array.from({ length: 12 }, (_, i) => ({
      title: `t${i}`,
      url: `https://e.example/${i}`,
      text: 'word '.repeat(400),
    })),
  });
  const items = parseExaText(many, 3);
  assert.deepEqual(
    items.map((r) => r.title),
    ['t0', 't1', 't2']
  );
  assert.equal(items[0].snippet, 'word '.repeat(400).trim());
});

/** One Exa answer of three results whose snippets are given. */
function threeSnippets(snippets: Array<string>) {
  return sseAnswer(
    JSON.stringify({ results: snippets.map((text, i) => ({ title: `t${i}`, url: `https://e.example/${i}`, text })) })
  );
}

/** A summarizer whose answers wait until `release` is called, recording each call as it starts. */
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

const snippetsOf = (result: Record<string, Untyped>): Array<string> =>
  (result.results as Array<{ snippet: string }>).map(({ snippet }) => snippet);

// The owner on 2026-11-17: a text over its bound is summarized or kept whole, never cut.
test('search: snippets over 600 characters go to summarize side by side, each replaced by its summary', async () => {
  // Catches: a snippet cut at 600, or the snippets of one search summarized one after another.
  const long = (n: number) => `${'word '.repeat(150)}${n}`;
  const held = heldSummarize((text) => `summary ${text.slice(-1)}`);
  const { fetchImpl } = fakeFetch(threeSnippets([long(1), long(2), long(3)]));
  const pending = createExaSearch({ fetchImpl, summarize: held.summarize }).search('q', { timeoutMs: 5000 });
  for (let tick = 0; tick < 5 && held.calls.length === 0; tick += 1) await new Promise((r) => setImmediate(r));
  assert.equal(held.calls.length, 3, 'all three started before the first was answered');
  held.release();
  const result = await pending;
  assert.deepEqual(snippetsOf(result), ['summary 1', 'summary 2', 'summary 3']);
  assert.deepEqual(
    held.calls.map(({ text, options }) => [text, options]),
    [1, 2, 3].map((n) => [long(n), { maxChars: 600, kind: 'text' }])
  );
});

// The owner on 2026-11-17: a text over its bound is summarized or kept whole, never cut.
test('search: a snippet within 600 characters is kept as it is, and a summary still over 600 is kept whole', async () => {
  // Catches: a short snippet rewritten, or a summary cut at the bound.
  const short = 'word '.repeat(100).trim();
  const longer = 'summary '.repeat(100).trim();
  const summarize = (text: string, options: { maxChars: number; kind: 'text' }): Promise<string> =>
    Promise.resolve(Array.from(text).length > options.maxChars ? longer : text);
  const { fetchImpl } = fakeFetch(threeSnippets([short, 'word '.repeat(200).trim()]));
  const result = await createExaSearch({ fetchImpl, summarize }).search('q', { timeoutMs: 5000 });
  assert.deepEqual(snippetsOf(result), [short, longer]);
});

test('search: a 429 fails with rate-limited and the status', async () => {
  const { fetchImpl } = fakeFetch(rawResponse('{}', { status: 429, type: 'application/json' }));
  const { result, logs } = await run(createExaSearch({ fetchImpl }), 'q', { timeoutMs: 5000 });
  assert.deepEqual(result, { ok: false, reason: 'rate-limited', status: 429 });
  assert.deepEqual(
    logs.map((l) => [l.level, l.msg, l.reason, l.status]),
    [['warn', 'web: exa failed', 'rate-limited', 429]]
  );
});

test('search: the probed shape -- a 200 whose result carries the rate-limit flag -> rate-limited', async () => {
  const { fetchImpl } = fakeFetch(
    sseAnswer("You've hit the free rate limit.", { meta: { 'ai.exa/rateLimited': true } })
  );
  const { result, logs } = await run(createExaSearch({ fetchImpl }), 'q', { timeoutMs: 5000 });
  assert.deepEqual(result, { ok: false, reason: 'rate-limited' });
  assert.equal(logs.length, 1);
});

test('search: a non-2xx, an unreadable body, a JSON-RPC error or a tool error fails with http', async () => {
  const cases = [
    [rawResponse('nope', { status: 500 }), { ok: false, reason: 'http', status: 500 }],
    [rawResponse('<html>oops</html>'), { ok: false, reason: 'http', status: 200 }],
    [
      rawResponse(JSON.stringify({ jsonrpc: '2.0', id: 1, error: { code: -32600, message: 'bad' } }), {
        type: 'application/json',
      }),
      { ok: false, reason: 'http', status: 200 },
    ],
    [sseAnswer('tool failed', { isError: true }), { ok: false, reason: 'http', status: 200 }],
  ];
  for (const [response, expected] of cases) {
    const { fetchImpl } = fakeFetch(response);
    assert.deepEqual((await run(createExaSearch({ fetchImpl }), 'q', { timeoutMs: 5000 })).result, expected);
  }
});

test('search: a request hanging past timeoutMs fails with timeout', async () => {
  const fetchImpl = (url: Record<string, Untyped>, { signal }: Record<string, Untyped>) =>
    new Promise((resolve, reject) => {
      signal.addEventListener('abort', () => reject(new DOMException('aborted', 'AbortError')));
    });
  const { result } = await run(createExaSearch({ fetchImpl: wrongly(fetchImpl) }), 'q', { timeoutMs: 20 });
  assert.deepEqual(result, { ok: false, reason: 'timeout' });
});

test('search: a thrown fetch or a missing response fails with network', async () => {
  const thrown = fakeFetch(new TypeError('fetch failed'));
  assert.deepEqual((await run(createExaSearch({ fetchImpl: thrown.fetchImpl }), 'q', { timeoutMs: 5000 })).result, {
    ok: false,
    reason: 'network',
  });
  const missing = fakeFetch(null);
  assert.deepEqual((await run(createExaSearch({ fetchImpl: missing.fetchImpl }), 'q', { timeoutMs: 5000 })).result, {
    ok: false,
    reason: 'network',
  });
});

test('search: an empty answer fails with empty without a warn line; a blank query too, without a request but warned', async () => {
  for (const text of [
    '',
    'No results found.',
    JSON.stringify({ results: [] }),
    JSON.stringify({ results: [{ title: 'x' }] }),
  ]) {
    const { fetchImpl } = fakeFetch(sseAnswer(text));
    const { result, logs } = await run(createExaSearch({ fetchImpl }), 'q', { timeoutMs: 5000 });
    assert.deepEqual(result, { ok: false, reason: 'empty' }, text);
    assert.equal(logs.length, 0, text);
  }
  const noContent = fakeFetch(rawResponse(`data: ${JSON.stringify({ jsonrpc: '2.0', id: 1, result: {} })}\n`));
  assert.deepEqual((await run(createExaSearch({ fetchImpl: noContent.fetchImpl }), 'q', { timeoutMs: 5000 })).result, {
    ok: false,
    reason: 'empty',
  });
  const { calls, fetchImpl } = fakeFetch(sseAnswer(JSON_TEXT));
  const { result, logs } = await run(createExaSearch({ fetchImpl }), '   ', { timeoutMs: 5000 });
  assert.deepEqual(result, { ok: false, reason: 'empty' });
  assert.equal(calls.length, 0);
  assert.deepEqual(
    logs.map((l) => [l.level, l.msg, l.reason]),
    [['warn', 'web: exa failed', 'empty']]
  );
});

test('search: failure logs carry reason and status only, never the query, the key or the endpoint', async () => {
  const { fetchImpl } = fakeFetch(rawResponse('bad', { status: 401 }));
  const { logs } = await run(createExaSearch({ fetchImpl }), 'secret-query-words', { apiKey: KEY, timeoutMs: 5000 });
  assert.equal(logs.length, 1);
  assert.equal(logs[0].level, 'warn');
  assert.equal(logs[0].msg, 'web: exa failed');
  assert.equal(logs[0].reason, 'http');
  assert.equal(logs[0].status, 401);
  const serialized = JSON.stringify(logs);
  assert.ok(!serialized.includes('secret-query-words'));
  assert.ok(!serialized.includes(KEY));
  assert.ok(!serialized.includes('mcp.exa.ai'));
});
