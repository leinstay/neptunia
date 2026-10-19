// Tests for src/web/web-search.js, the web agent's search command: the command
// line (query words, --count), the request it sends (OpenRouter's chat
// completions with the web plugin on Exa, the agent's key, the model the
// runner passes), the results read from the answer's url_citation annotations
// and printed as numbered plain lines, and every failure as one
// `web-search: <code>` line on stderr with its exit code, the key never
// printed. A fake fetch; no network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildSearchRequest, DEFAULT_COUNT, formatResults, parseSearchArgs, runWebSearch, searchResults, WEB_SEARCH_MODEL_ENV, webSearchModel } from '../src/web/web-search.js';
import { ROLE_DEFAULTS } from '../src/llm/roles.js';

/** An answer of the chat-completions API carrying `annotations` on its first choice. */
function answer(annotations, text = 'Some text the command never prints.') {
  return { choices: [{ message: { role: 'assistant', content: text, annotations } }], usage: {} };
}

/** A url_citation annotation. */
function cite(url, title, content) {
  return { type: 'url_citation', url_citation: { url, title, content, start_index: 0, end_index: 1 } };
}

/** A fetch fake answering `reply` (an object -> 200 JSON, a number -> that status, an Error -> thrown); records calls. */
function fakeFetch(reply) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, body: JSON.parse(init.body) });
    if (reply instanceof Error) throw reply;
    if (typeof reply === 'number') return { ok: false, status: reply, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => reply };
  };
  return { fetchImpl, calls };
}

test('parseSearchArgs: the words make the query, cleaned; --count, --count= and -n set the count; 8 by default', () => {
  assert.deepEqual(parseSearchArgs(['café', 'olé', 'meme']), { query: 'café olé meme', count: DEFAULT_COUNT });
  assert.equal(DEFAULT_COUNT, 8);
  assert.deepEqual(parseSearchArgs(['--count', '3', 'ελληνικά', 'νέα']), { query: 'ελληνικά νέα', count: 3 });
  assert.deepEqual(parseSearchArgs(['a', '--count=5']), { query: 'a', count: 5 });
  assert.deepEqual(parseSearchArgs(['-n', '2', 'b']), { query: 'b', count: 2 });
  assert.deepEqual(parseSearchArgs(['line\none', '<tag>']), { query: 'line one tag', count: 8 }, 'one line, no angle brackets');
  assert.deepEqual(parseSearchArgs(['--', '-not-an-option']), { query: '-not-an-option', count: 8 });
});

test('parseSearchArgs: no query, a bad count or an unknown option is an error code', () => {
  assert.deepEqual(parseSearchArgs([]), { error: 'no-query' });
  assert.deepEqual(parseSearchArgs(['  ']), { error: 'no-query' });
  assert.deepEqual(parseSearchArgs(['--count', '3']), { error: 'no-query' });
  assert.deepEqual(parseSearchArgs(['q', '--count', 'x']), { error: 'bad-count' });
  assert.deepEqual(parseSearchArgs(['q', '--count', '0']), { error: 'bad-count' });
  assert.deepEqual(parseSearchArgs(['q', '--count']), { error: 'bad-count' });
  assert.deepEqual(parseSearchArgs(['q', '-n', '2.5']), { error: 'bad-count' });
  assert.deepEqual(parseSearchArgs(['q', '--exec', 'x']), { error: 'bad-option' });
});

test('buildSearchRequest: the query as the only message, the Exa web plugin with max_results clamped to 1..10, a short answer', () => {
  const body = buildSearchRequest({ query: 'q', count: 8, model: 'openai/small' });
  assert.equal(body.model, 'openai/small');
  assert.deepEqual(body.messages, [{ role: 'user', content: 'q' }]);
  assert.deepEqual(body.plugins, [{ id: 'web', engine: 'exa', max_results: 8 }]);
  assert.ok(Number.isInteger(body.max_tokens) && body.max_tokens > 0 && body.max_tokens <= 1000);
  assert.equal(buildSearchRequest({ query: 'q', count: 50, model: 'm' }).plugins[0].max_results, 10);
  assert.equal(buildSearchRequest({ query: 'q', count: undefined, model: 'm' }).plugins[0].max_results, 8);
});

test('webSearchModel: the persona\'s own web.search model (analyzer for web-search), a byPurpose entry included', () => {
  assert.equal(webSearchModel({}), ROLE_DEFAULTS.analyzer);
  assert.equal(webSearchModel({ models: { helpers: { analyzer: 'x/cheap' } } }), 'x/cheap');
  assert.equal(webSearchModel({ models: { helpers: { analyzer: 'x/cheap' }, byPurpose: { 'web-search': 'x/other' } } }), 'x/other');
});

test('searchResults: the url_citation annotations, http(s) only, each url once, snippet one line and clamped', () => {
  const long = `${'word '.repeat(100)}end`;
  const results = searchResults(answer([
    cite('https://a.example/one', 'First\nTitle', 'Line one.\n\nLine two.'),
    cite('https://a.example/one', 'Again', 'dup'),
    cite('javascript:alert(1)', 'Bad', 'x'),
    { type: 'file', file: {} },
    cite('http://b.example/two', 'Second', long),
    cite('https://c.example/three', undefined, undefined),
  ]));
  assert.deepEqual(results.map((r) => r.url), ['https://a.example/one', 'http://b.example/two', 'https://c.example/three']);
  assert.equal(results[0].title, 'First Title');
  assert.equal(results[0].snippet, 'Line one. Line two.');
  assert.ok(results[1].snippet.length <= 240 && results[1].snippet.length > 100, String(results[1].snippet.length));
  assert.ok(!results[1].snippet.includes('\n'));
  assert.deepEqual(results[2], { title: '', url: 'https://c.example/three', snippet: '' });
  assert.deepEqual(searchResults(answer(undefined)), []);
  assert.deepEqual(searchResults({}), []);
});

test('formatResults: numbered blocks of title, URL and snippet, a blank line between; nothing for none', () => {
  const out = formatResults([
    { title: 'First', url: 'https://a.example/one', snippet: 'One.' },
    { title: '', url: 'https://c.example/three', snippet: '' },
  ]);
  assert.equal(out, '1. First\nhttps://a.example/one\nOne.\n\n2. \nhttps://c.example/three\n');
  assert.equal(formatResults([]), '');
});

test('runWebSearch: one POST to OpenRouter chat completions with the agent key, the passed model and the plugin; the results printed', async () => {
  const { fetchImpl, calls } = fakeFetch(answer([cite('https://a.example/one', 'First', 'One.')], 'secret-free text'));
  const env = { OPENROUTER_API_KEY: 'sk-or-agent-key', [WEB_SEARCH_MODEL_ENV]: 'openai/small' };
  const out = await runWebSearch({ argv: ['olé', 'meme', '--count', '4'], env, fetchImpl });
  assert.deepEqual(out, { code: 0, stdout: '1. First\nhttps://a.example/one\nOne.\n', stderr: '' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://openrouter.ai/api/v1/chat/completions');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(calls[0].init.headers.Authorization, 'Bearer sk-or-agent-key');
  assert.deepEqual(calls[0].body, { model: 'openai/small', messages: [{ role: 'user', content: 'olé meme' }], max_tokens: calls[0].body.max_tokens, plugins: [{ id: 'web', engine: 'exa', max_results: 4 }] });
  assert.ok(calls[0].init.signal, 'a timeout signal');
  assert.ok(!out.stdout.includes('secret-free text'), 'the answer text is never printed');
});

test('runWebSearch: without a passed model, the lookup\'s default model', async () => {
  const { fetchImpl, calls } = fakeFetch(answer([cite('https://a.example/one', 'First', 'One.')]));
  await runWebSearch({ argv: ['q'], env: { OPENROUTER_API_KEY: 'k' }, fetchImpl });
  assert.equal(calls[0].body.model, ROLE_DEFAULTS.analyzer);
});

test('runWebSearch: every failure is one web-search: <code> line on stderr, the key never printed, no request on a usage error', async () => {
  const env = { OPENROUTER_API_KEY: 'sk-or-agent-key' };
  const cases = [
    [{ argv: [], env }, 2, 'no-query'],
    [{ argv: ['q', '--count', 'x'], env }, 2, 'bad-count'],
    [{ argv: ['q', '--exec'], env }, 2, 'bad-option'],
    [{ argv: ['q'], env: {} }, 2, 'no-key'],
  ];
  for (const [options, code, reason] of cases) {
    const { fetchImpl, calls } = fakeFetch(answer([]));
    const out = await runWebSearch({ ...options, fetchImpl });
    assert.deepEqual(out, { code, stdout: '', stderr: `web-search: ${reason}\n` }, reason);
    assert.equal(calls.length, 0, reason);
  }
  const timeout = Object.assign(new Error('t'), { name: 'TimeoutError' });
  const network = new TypeError('fetch failed');
  const failures = [
    [429, 'http-429'],
    [401, 'http-401'],
    [timeout, 'timeout'],
    [network, 'network'],
    [{ error: { message: 'sk-or-agent-key echoed' } }, 'bad-answer'],
    [answer([]), 'no-results'],
    [answer(undefined), 'no-results'],
  ];
  for (const [reply, reason] of failures) {
    const { fetchImpl } = fakeFetch(reply);
    const out = await runWebSearch({ argv: ['q'], env, fetchImpl });
    assert.deepEqual(out, { code: 1, stdout: '', stderr: `web-search: ${reason}\n` }, reason);
    assert.ok(!JSON.stringify(out).includes('sk-or-agent-key'), reason);
  }
  const notJson = await runWebSearch({ argv: ['q'], env, fetchImpl: async () => ({ ok: true, status: 200, json: async () => { throw new SyntaxError('x'); } }) });
  assert.deepEqual(notJson, { code: 1, stdout: '', stderr: 'web-search: bad-answer\n' });
});
