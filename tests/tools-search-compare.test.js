// Tests for tools/search-compare.mjs, its pure part tools/lib/search-compare.mjs and the
// `--search` mode of tools/replay-score.mjs: two queries through three engines with fake Brave and
// Exa clients and a fake llm (no network, no real prompts or data): the results file, the summary
// counts and percentiles, the blind sheet against its key, `--dry-run`, a keyless Brave, the cost
// stop, and the scorer over a filled blind sheet.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { main } from '../tools/search-compare.mjs';
import { main as scoreMain } from '../tools/replay-score.mjs';
import { CliError } from '../tools/lib/cli.mjs';
import { parseBlindScores, parseQueries, seededShuffle, tallySearchScores } from '../tools/lib/search-compare.mjs';
import { NotByokError } from '../src/llm/openrouter.js';
import { tempDir } from './fixtures/tmp.js';

const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);
const ROWS = [
  { id: 'q1', query: 'weather in Lisboa today', asked: 'what is the weather in Lisboa today?' },
  { id: 'q2', query: 'café hours Porto' },
];
const ENV = { BRAVE_SEARCH_API_KEY: 'brave-test-key' };

function hotFixture() {
  return {
    config: {
      models: { base: { reasoner: 'test/reasoner' } },
      llm: { helperTimeoutMs: 9000 },
      web: { maxPerDay: 0, search: { engine: 'brave', fallback: ['exa'], results: 5, summaryChars: 900, maxOutputTokens: 400, timeoutMs: 7000, cacheHours: 24 } },
    },
    prompts: { 'search-summary': 'Q: {{query}}\nT: {{today}}\nM: {{maxChars}}' },
  };
}

/** A fake clock and the fakes that move it: each call takes a fixed time per engine and query. */
function fakes({ clock }) {
  const calls = { brave: [], exa: [], llm: [] };
  const brave = {
    async search(query, options) {
      calls.brave.push({ query, options });
      if (query === 'weather in Lisboa today') {
        clock.t += 200;
        return { ok: true, results: [{ title: 'Brave one', url: 'https://weather.example.org/lisboa', snippet: 'sunny' }, { title: 'Brave two', url: 'https://news.example.net/a', snippet: 'warm' }] };
      }
      clock.t += 150;
      return { ok: false, reason: 'empty' };
    },
  };
  const exa = {
    async search(query, options) {
      calls.exa.push({ query, options });
      clock.t += query === 'weather in Lisboa today' ? 300 : 500;
      return { ok: true, results: [{ title: `Exa ${query}`, url: 'https://exa.example.org/x', snippet: 'found' }] };
    },
  };
  const llm = {
    async complete(messages, options) {
      calls.llm.push({ messages, options });
      const query = /^Q: (.*)$/m.exec(messages[0].content)[1];
      if (options.plugins) {
        if (query === 'café hours Porto') {
          clock.t += 800;
          throw new NotByokError('not byok: test/reasoner via test');
        }
        clock.t += 1000;
        return { text: `plugin answer about ${query}`, usage: { cost: 0.01 }, annotations: [{ type: 'url_citation', url_citation: { title: 'Cited', url: 'https://cited.example.org/p' } }] };
      }
      clock.t += 100;
      const firstTitle = /^1\. (.*)$/m.exec(messages[1].content)[1];
      return { text: `summary from ${firstTitle}`, usage: { cost: 0.001 } };
    },
  };
  return { calls, searches: { brave, exa }, llm };
}

function tempQueries(rows = ROWS) {
  const dir = tempDir('nep-search-compare-');
  const file = path.join(dir, 'queries.jsonl');
  fs.writeFileSync(file, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  return { dir, file };
}

/** `fn` with stderr swallowed (the tool's progress lines). */
async function quietly(fn) {
  const write = process.stderr.write;
  process.stderr.write = () => true;
  try {
    return await fn();
  } finally {
    process.stderr.write = write;
  }
}

function run(argv, { dir, env = ENV }) {
  const clock = { t: NOW };
  const f = fakes({ clock });
  const promise = quietly(() => main(argv, { cwd: dir, rootDir: dir, now: () => clock.t, hot: hotFixture(), llmClient: f.llm, searches: f.searches, env }));
  return { promise, ...f };
}

function readJsonl(file) {
  return fs.readFileSync(file, 'utf8').trim().split('\n').map((l) => JSON.parse(l));
}

/** Each section of a blind sheet as `{ id, answers: { letter: text } }`. */
function blindSections(markdown) {
  const out = {};
  let id = null;
  let letter = null;
  for (const line of markdown.split('\n')) {
    const head = /^## query (.+)$/.exec(line);
    if (head) [id, letter] = [head[1], null];
    const l = /^### ([A-Z])$/.exec(line);
    if (l) letter = l[1];
    if (id && letter && line.startsWith('> ')) (out[id] ??= {})[letter] = line.slice(2);
  }
  return out;
}

test('search-compare: two queries x three engines -> results, summary, blind sheet and key that agree', async () => {
  const { dir, file } = tempQueries();
  const { promise, calls } = run([file, '--out', 'out', '--seed', 's1'], { dir });
  const out = await promise;

  const results = readJsonl(path.join(dir, 'out', 'results.jsonl'));
  const strip = ({ text, sources, ...rest }) => rest;
  assert.deepEqual(results.map(strip), [
    { id: 'q1', engine: 'brave', ok: true, reason: null, ms_search: 200, ms_summary: 100, ms_total: 300, results: 2, cost: 0.001 },
    { id: 'q1', engine: 'exa', ok: true, reason: null, ms_search: 300, ms_summary: 100, ms_total: 400, results: 1, cost: 0.001 },
    { id: 'q1', engine: 'openrouter', ok: true, reason: null, ms_search: 1000, ms_summary: null, ms_total: 1000, results: 1, cost: 0.01 },
    { id: 'q2', engine: 'brave', ok: true, reason: 'empty', ms_search: 150, ms_summary: null, ms_total: 150, results: 0, cost: 0 },
    { id: 'q2', engine: 'exa', ok: true, reason: null, ms_search: 500, ms_summary: 100, ms_total: 600, results: 1, cost: 0.001 },
    { id: 'q2', engine: 'openrouter', ok: false, reason: 'not-byok', ms_search: 800, ms_summary: null, ms_total: 800, results: 0, cost: 0 },
  ]);
  assert.equal(results[0].text, 'summary from Brave one');
  assert.deepEqual(results[0].sources.map((s) => s.site), ['weather.example.org', 'news.example.net']);
  assert.deepEqual(results[2].sources, [{ title: 'Cited', url: 'https://cited.example.org/p', site: 'cited.example.org' }]);
  assert.equal(results[3].text, '');

  // Production's requests: the engine forced, no fallback, the reasoner, outside the daily cap.
  assert.equal(calls.brave.length, 2);
  assert.equal(calls.exa.length, 2);
  assert.equal(calls.brave[0].options.apiKey, 'brave-test-key');
  assert.equal(calls.brave[0].options.timeoutMs, 7000);
  assert.equal(calls.exa[0].options.apiKey, null);
  const summaryCall = calls.llm[0].options;
  assert.equal(summaryCall.model, 'test/reasoner');
  assert.equal(summaryCall.role, 'reasoner');
  assert.equal(summaryCall.purpose, 'search-summary');
  assert.equal(summaryCall.origin, 'search-compare');
  assert.equal(summaryCall.countAgainstDailyCap, false);
  const pluginCall = calls.llm.find((c) => c.options.plugins).options;
  assert.deepEqual(pluginCall.plugins, [{ id: 'web', engine: 'exa', max_results: 5 }]);
  assert.equal(pluginCall.helper, false);
  assert.equal(pluginCall.countAgainstDailyCap, false);

  const summary = fs.readFileSync(path.join(dir, 'out', 'summary.md'), 'utf8');
  assert.ok(out.startsWith(summary));
  assert.match(summary, /\| brave \| 2 \| 1 \| 1 \| 0 \| 0 \| 150 \| 200 \| 100 \| 100 \| 150 \| 300 \| 0\.0010 \| 0\.0005 \|/);
  assert.match(summary, /\| exa \| 2 \| 2 \| 0 \| 0 \| 0 \| 300 \| 500 \| 100 \| 100 \| 400 \| 600 \| 0\.0020 \| 0\.0010 \|/);
  assert.match(summary, /\| openrouter \| 2 \| 1 \| 0 \| 1 \| 0 \| 800 \| 1000 \| - \| - \| 800 \| 1000 \| 0\.0100 \| 0\.0050 \|/);
  assert.match(summary, /\| openrouter \| not-byok \| 1 \|/);
  assert.match(summary, /\| exa \| brave \| 1 \| q2 \|/);
  assert.match(summary, /\| exa \| openrouter \| 1 \| q2 \|/);
  assert.match(summary, /cost: 0\.0130 USD/);

  const key = JSON.parse(fs.readFileSync(path.join(dir, 'out', 'blind-key.json'), 'utf8'));
  const blind = fs.readFileSync(path.join(dir, 'out', 'blind.md'), 'utf8');
  assert.deepEqual(Object.keys(key), ['q1', 'q2']);
  assert.deepEqual(Object.keys(key.q1), ['A', 'B', 'C']);
  assert.deepEqual(Object.values(key.q1).sort(), ['brave', 'exa', 'openrouter']);
  assert.deepEqual(key.q2, { A: 'exa' });
  const sections = blindSections(blind);
  for (const [id, letters] of Object.entries(key)) {
    for (const [letter, engine] of Object.entries(letters)) {
      assert.equal(sections[id][letter], results.find((r) => r.id === id && r.engine === engine).text);
    }
  }
  assert.match(blind, /## query q1\n\nQuestion: what is the weather in Lisboa today\?/);
  assert.match(blind, /## query q2\n\nQuestion: café hours Porto/);
  assert.match(blind, /score: A = \?, B = \?, C = \?/);
  assert.match(blind, /score: A = \?\n/);

  // The same seed shuffles the same way; the letters follow seededShuffle.
  const again = run([file, '--out', 'out2', '--seed', 's1'], { dir });
  await again.promise;
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'out2', 'blind-key.json'), 'utf8')), key);
  const order = seededShuffle(['brave', 'exa', 'openrouter'], 's1', 'q1');
  assert.deepEqual(Object.values(key.q1), order);
});

test('search-compare: --dry-run prints each engine\'s request shapes and sends nothing', async () => {
  const { dir, file } = tempQueries();
  const { promise, calls } = run([file, '--dry-run'], { dir });
  const out = await promise;
  assert.equal(calls.brave.length + calls.exa.length + calls.llm.length, 0);
  assert.deepEqual(fs.readdirSync(dir), ['queries.jsonl']);
  assert.match(out, /# dry run: row q1, nothing sent/);
  assert.match(out, /## brave\n\n```json[\s\S]*"kind": "search"[\s\S]*"apiKey": "set"[\s\S]*"purpose": "search-summary"/);
  assert.match(out, /## openrouter\n\n```json[\s\S]*"plugins"/);
  assert.doesNotMatch(out, /brave-test-key/);
});

test('search-compare: Brave without its key is skipped for every row, not an error', async () => {
  const { dir, file } = tempQueries();
  const { promise, calls } = run([file, '--out', 'nokey'], { dir, env: {} });
  const out = await promise;
  assert.equal(calls.brave.length, 0);
  const results = readJsonl(path.join(dir, 'nokey', 'results.jsonl'));
  const brave = results.filter((r) => r.engine === 'brave');
  assert.deepEqual(brave.map((r) => [r.id, r.ok, r.reason, r.ms_total]), [['q1', false, 'skipped', null], ['q2', false, 'skipped', null]]);
  assert.match(out, /\| brave \| 2 \| 0 \| 0 \| 0 \| 2 \| - \| - \| - \| - \| - \| - \| 0\.0000 \| - \|/);
  assert.doesNotMatch(out, /\| brave \| skipped \|/);
  const key = JSON.parse(fs.readFileSync(path.join(dir, 'nokey', 'blind-key.json'), 'utf8'));
  assert.ok(!Object.values(key.q1).includes('brave'));
});

test('search-compare: --max-usd stops starting rows; --repeat records each run; bad input refused', async () => {
  const { dir, file } = tempQueries();
  const stopped = run([file, '--out', 'cap', '--max-usd', '0'], { dir });
  assert.match(await stopped.promise, /rows: 1, 1 not run \(max-usd\)/);
  assert.equal(readJsonl(path.join(dir, 'cap', 'results.jsonl')).length, 3);

  const repeated = run([file, '--out', 'rep', '--repeat', '2', '--engines', 'exa'], { dir });
  await repeated.promise;
  const rep = readJsonl(path.join(dir, 'rep', 'results.jsonl'));
  assert.deepEqual(rep.map((r) => [r.id, r.engine, r.run]), [['q1', 'exa', 1], ['q1', 'exa', 2], ['q2', 'exa', 1], ['q2', 'exa', 2]]);

  await assert.rejects(run([file], { dir }).promise, (err) => err instanceof CliError && /--out/.test(err.message));
  await assert.rejects(run([file, '--out', 'data/x'], { dir }).promise, (err) => err instanceof CliError && /under data/.test(err.message));
  await assert.rejects(run([file, '--out', 'x', '--engines', 'brave,bing'], { dir }).promise, (err) => err instanceof CliError && /--engines/.test(err.message));
  await assert.rejects(
    quietly(() => main([file, '--out', 'x', '--key', 'sk-or-abc'], { cwd: dir, rootDir: dir, hot: hotFixture(), searches: fakes({ clock: { t: 0 } }).searches, env: {} })),
    (err) => err instanceof CliError && /name of a variable/.test(err.message) && !err.message.includes('sk-or-abc'),
  );
});

test('replay-score --search: tallies a filled blind sheet against Brave', async () => {
  const { dir, file } = tempQueries();
  await run([file, '--out', 'out', '--seed', 's2'], { dir }).promise;
  const key = JSON.parse(fs.readFileSync(path.join(dir, 'out', 'blind-key.json'), 'utf8'));
  const letterOf = (engine) => Object.entries(key.q1).find(([, e]) => e === engine)[0];
  const grades = { [letterOf('exa')]: 'good', [letterOf('brave')]: 'ok', [letterOf('openrouter')]: 'bad' };
  const blindFile = path.join(dir, 'out', 'blind.md');
  const filled = fs
    .readFileSync(blindFile, 'utf8')
    .replace('score: A = ?, B = ?, C = ?', `score: ${['A', 'B', 'C'].map((l) => `${l} = ${grades[l]}`).join(', ')}`);
  fs.writeFileSync(blindFile, filled);
  const out = await scoreMain(['--search', blindFile, path.join(dir, 'out', 'blind-key.json')]);
  assert.match(out, /Against: brave/);
  assert.match(out, /Queries on the sheet: 2, scored: 1/);
  assert.match(out, /\| exa \| 1 \| 0 \| 0 \| 100% \| 0% \| 0 \| 1 \|/);
  assert.match(out, /\| openrouter \| 0 \| 0 \| 1 \| 0% \| 100% \| 0 \| 0 \|/);
  await assert.rejects(scoreMain(['--search', blindFile]), CliError);
});

test('parseBlindScores and tallySearchScores: score lines, best lines, ties, unknown queries', () => {
  const md = ['## query a', '### A', '### B', 'score: A = 3, B = 3', '## query b', '### A', '### B', '### C', 'best: C', '## query c', '### A', 'score: A = ?'].join('\n');
  const scores = parseBlindScores(md);
  assert.deepEqual(scores, { a: { A: 3, B: 3 }, b: { A: 0, B: 0, C: 1 } });
  const tally = tallySearchScores({ key: { a: { A: 'brave', B: 'exa' }, b: { A: 'exa', B: 'openrouter', C: 'brave' }, c: { A: 'exa' } }, scores });
  assert.deepEqual(tally.engines, [
    { engine: 'exa', win: 0, tie: 1, lose: 1, unscored: 0, noBaseline: 1 },
    { engine: 'openrouter', win: 0, tie: 0, lose: 1, unscored: 0, noBaseline: 0 },
  ]);
  assert.throws(() => tallySearchScores({ key: {}, scores: { z: { A: 1 } } }), /not in the key/);
});

test('parseQueries: rows checked line by line', () => {
  const text = ['{"id":"a","query":"x"}', '', '{"id":2,"query":"y","asked":"why?"}', 'nope', '{"id":"a","query":"z"}', '{"id":"b","query":" "}'].join('\n');
  const { rows, errors } = parseQueries(text);
  assert.deepEqual(rows, [{ id: 'a', query: 'x', asked: '', note: '' }, { id: '2', query: 'y', asked: 'why?', note: '' }]);
  assert.deepEqual(errors, ['line 4: not JSON', 'line 5: duplicate id a', 'line 6: no query']);
});
