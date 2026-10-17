// Tests for tools/search-policy-eval.mjs and its pure part tools/lib/search-policy-eval.mjs: the
// sheet read, the decisions, the confusion matrix, the disagreement list, `--dry-run` and
// `--limit`, with an injected fake llm and a temporary sheet (no network, no real prompts or data).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { main } from '../tools/search-policy-eval.mjs';
import { CliError } from '../tools/lib/cli.mjs';
import { decisionOf, parseSheet, rowChat, summarize } from '../tools/lib/search-policy-eval.mjs';
import { lookupClassifierInput } from '../src/behavior/turn.js';
import { labels } from './fixtures/labels.js';

const NOW = Date.UTC(2026, 9, 17, 12, 0, 0);
const ROWS = [
  { id: 'r1', source: 'searched', question: 'what is the weather in Lisboa today', context: [], tier: 'fast', note: '' },
  { id: 'r2', source: 'not-searched', question: 'good night all', context: [{ author: 'Eleni', text: 'café time' }, { author: 'Persona', text: 'sure' }], tier: 'none', note: '' },
  { id: 'r3', source: 'owner', question: 'what did Nikos say about the chess night', context: [], tier: 'agent', note: 'needs digging' },
];
const ANSWERS = new Map([
  ['what is the weather in Lisboa today', 'web: Lisboa weather today'],
  ['good night all', 'none'],
  ['what did Nikos say about the chess night', 'server: chess night\nwho: Nikos'],
]);

function hotFixture(overrides = {}) {
  return {
    config: {
      bot: { timezone: 'UTC', nameTriggers: ['Persona'] },
      features: { skills: false },
      roles: { reasoner: 'test/reasoner' },
      context: { maxMessageChars: 2000 },
      web: { search: { contextMessages: 50, classifierMaxOutputTokens: 300 } },
      llm: { helperTimeoutMs: 9000 },
      ...overrides,
    },
    prompts: { lookup: 'Today is {{today}}. You are {{name}}.{{skills}}', labels },
  };
}

/** A fake llm answering each candidate from ANSWERS, every call recorded. */
function fakeLlm({ fail = new Set() } = {}) {
  const calls = [];
  return {
    calls,
    async complete(messages, options) {
      calls.push({ messages, options });
      const question = /<candidate>\n[^\n]*?: ([^\n]*)\n<\/candidate>/.exec(messages[1].content)?.[1];
      if (fail.has(question)) throw Object.assign(new Error('boom'), { name: 'ProviderError' });
      return { text: ANSWERS.get(question) ?? '', usage: { cost: 0.001 } };
    },
  };
}

function tempSheet(rows = ROWS) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'nep-search-policy-eval-'));
  const sheet = path.join(dir, 'sheet.jsonl');
  fs.writeFileSync(sheet, `${rows.map((r) => JSON.stringify(r)).join('\n')}\n`);
  return { dir, sheet };
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

function run(argv, { dir, llmClient, hot = hotFixture() }) {
  return quietly(() => main(argv, { cwd: dir, rootDir: dir, now: () => NOW, hot, llmClient, env: {} }));
}

test('search-policy-eval: three rows -> decisions, results.jsonl, the confusion matrix and the disagreement', async () => {
  const { dir, sheet } = tempSheet();
  const llm = fakeLlm();
  const out = await run([sheet, '--out', 'run1'], { dir, llmClient: llm });

  const results = fs.readFileSync(path.join(dir, 'run1', 'results.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(results, [
    { id: 'r1', source: 'searched', tier: 'fast', decision: 'fast', query: 'Lisboa weather today', forms: [], who: [], ms: 0, ok: true },
    { id: 'r2', source: 'not-searched', tier: 'none', decision: 'none', query: null, forms: [], who: [], ms: 0, ok: true },
    { id: 'r3', source: 'owner', tier: 'agent', decision: 'memory', query: null, forms: ['chess night'], who: ['nikos'], ms: 0, ok: true },
  ]);

  const summary = fs.readFileSync(path.join(dir, 'run1', 'summary.md'), 'utf8');
  assert.ok(out.startsWith(summary));
  assert.match(summary, /agreement: 2\/3 \(67%\)/);
  assert.match(summary, /The classifier cannot say `agent` today/);
  assert.match(summary, /\| tier \| none \| fast \| memory \| agent \| failed \| total \|/);
  assert.match(summary, /\| none \| 1 \| 0 \| 0 \| 0 \| 0 \| 1 \|/);
  assert.match(summary, /\| fast \| 0 \| 1 \| 0 \| 0 \| 0 \| 1 \|/);
  assert.match(summary, /\| agent \| 0 \| 0 \| 1 \| 0 \| 0 \| 1 \|/);
  assert.match(summary, /\| owner \| 0\/1 \(0%\) \|/);
  assert.match(summary, /## Disagreements \(1\)/);
  assert.match(summary, /\| r3 \| agent \| memory \| chess night, nikos \|/);
  assert.match(summary, /cost: 0\.0030 USD/);
  assert.match(summary, /model: test\/reasoner/);
  assert.doesNotMatch(summary, /\| r1 \||\| r2 \|/);

  // The request is the turn's: the reasoner role, the helper options, the tool's origin, outside the daily cap.
  assert.equal(llm.calls.length, 3);
  const { messages, options } = llm.calls[1];
  assert.equal(options.model, 'test/reasoner');
  assert.equal(options.role, 'reasoner');
  assert.equal(options.purpose, 'lookup');
  assert.equal(options.maxOutputTokens, 300);
  assert.equal(options.helper, true);
  assert.equal(options.timeoutMs, 9000);
  assert.equal(options.origin, 'search-policy-eval');
  assert.equal(options.countAgainstDailyCap, false);
  assert.equal(options.cache, false);
  assert.equal(messages[0].content, 'Today is 2026-10-17. You are Persona.');
  // The user message is the turn's own rendering of the row's chat.
  const config = hotFixture().config;
  const { history, trigger } = rowChat({ ...ROWS[1], context: ROWS[1].context }, { now: NOW, selfName: 'Persona' });
  assert.equal(messages[1].content, lookupClassifierInput({ config, labels, selfName: 'Persona', history, trigger }).user);
  assert.match(messages[1].content, /^<transcript>\n[\s\S]*Eleni[\s\S]*café time[\s\S]*Persona \(you\)[\s\S]*<\/transcript>\n<candidate>\n-: good night all\n<\/candidate>$/);
  assert.equal(llm.calls[0].messages[1].content, '<candidate>\n-: what is the weather in Lisboa today\n</candidate>');
});

test('search-policy-eval: an agent: answer is decided agent, beside web: too; the summary no longer says agent cannot be said', async () => {
  const rows = [
    { id: 'a1', source: 'owner', question: 'find me a calm piano track for studying', context: [], tier: 'agent', note: '' },
    { id: 'a2', source: 'owner', question: 'is the café open and find a photo of its terrace', context: [], tier: 'agent', note: '' },
  ];
  const { dir, sheet } = tempSheet(rows);
  ANSWERS.set(rows[0].question, 'agent: find a calm piano track for studying, under five minutes');
  ANSWERS.set(rows[1].question, 'web: café opening hours\nagent: find a photo of the café terrace');
  try {
    const out = await run([sheet, '--out', 'agent'], { dir, llmClient: fakeLlm() });
    const results = fs.readFileSync(path.join(dir, 'agent', 'results.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
    assert.deepEqual(results.map((r) => [r.id, r.decision, r.query]), [['a1', 'agent', null], ['a2', 'agent', 'café opening hours']]);
    assert.match(out, /agreement: 2\/2 \(100%\)/);
    assert.doesNotMatch(out, /cannot say `agent`/);
  } finally {
    for (const row of rows) ANSWERS.delete(row.question);
  }
});

test('search-policy-eval: --dry-run prints the first request and sends nothing', async () => {
  const { dir, sheet } = tempSheet([ROWS[1], ROWS[0]]);
  const llm = fakeLlm();
  const out = await run([sheet, '--dry-run'], { dir, llmClient: llm });
  assert.equal(llm.calls.length, 0);
  assert.match(out, /# row r2 \(model test\/reasoner\)/);
  assert.match(out, /## system\n\nToday is 2026-10-17\. You are Persona\./);
  assert.match(out, /## user\n\n<transcript>\n[\s\S]*<candidate>\n-: good night all\n<\/candidate>/);
  assert.deepEqual(fs.readdirSync(dir), ['sheet.jsonl']);
});

test('search-policy-eval: --limit asks the first N rows only; --model pins the model', async () => {
  const { dir, sheet } = tempSheet();
  const llm = fakeLlm();
  const out = await run([sheet, '--out', 'run2', '--limit', '2', '--model', 'test/other'], { dir, llmClient: llm });
  assert.equal(llm.calls.length, 2);
  assert.deepEqual(llm.calls.map((c) => c.options.model), ['test/other', 'test/other']);
  const results = fs.readFileSync(path.join(dir, 'run2', 'results.jsonl'), 'utf8').trim().split('\n').map((l) => JSON.parse(l));
  assert.deepEqual(results.map((r) => [r.id, r.decision]), [['r1', 'fast'], ['r2', 'none']]);
  assert.match(out, /agreement: 2\/2 \(100%\)/);
  assert.match(out, /## Disagreements \(0\)\n\nNone\./);
});

test('search-policy-eval: a failed call is decided failed; the cost stop leaves rows unasked', async () => {
  const { dir, sheet } = tempSheet();
  const llm = fakeLlm({ fail: new Set(['good night all']) });
  const out = await run([sheet, '--out', 'run3', '--concurrency', '1'], { dir, llmClient: llm });
  assert.match(out, /failed calls: 1/);
  assert.match(out, /\| r2 \| none \| failed \|  \|/);
  const stopped = await run([sheet, '--out', 'run4', '--concurrency', '1', '--max-usd', '0'], { dir, llmClient: fakeLlm() });
  assert.match(stopped, /rows: 1, 2 not asked \(max-usd\)/);
});

test('search-policy-eval: refuses a bad sheet, a missing --out, an --out under data/ and a key value for --key', async () => {
  const { dir, sheet } = tempSheet();
  const llm = fakeLlm();
  await assert.rejects(run([sheet], { dir, llmClient: llm }), (err) => err instanceof CliError && /--out/.test(err.message));
  await assert.rejects(run([sheet, '--out', 'data/x'], { dir, llmClient: llm }), (err) => err instanceof CliError && /under data/.test(err.message));
  const bad = path.join(dir, 'bad.jsonl');
  fs.writeFileSync(bad, '{"id":"a","question":"q","tier":"later"}\n');
  await assert.rejects(run([bad, '--out', 'x'], { dir, llmClient: llm }), (err) => err instanceof CliError && /tier must be one of/.test(err.message));
  await assert.rejects(
    quietly(() => main([sheet, '--out', 'x', '--key', 'sk-or-abc'], { cwd: dir, rootDir: dir, now: () => NOW, hot: hotFixture(), env: {} })),
    (err) => err instanceof CliError && /name of a variable/.test(err.message) && !err.message.includes('sk-or-abc'),
  );
  await assert.rejects(
    quietly(() => main([sheet, '--out', 'x', '--key', 'SOME_KEY'], { cwd: dir, rootDir: dir, now: () => NOW, hot: hotFixture(), env: {} })),
    (err) => err instanceof CliError && /SOME_KEY is not set/.test(err.message),
  );
  assert.equal(llm.calls.length, 0);
});

test('parseSheet: rows checked line by line; blank lines skipped', () => {
  const text = [JSON.stringify(ROWS[0]), '', '{"id":2,"question":"q","tier":"memory"}', 'nope', '{"id":"r1","question":"q","tier":"none"}', '{"id":"x","question":" ","tier":"none"}', '{"id":"y","question":"q","tier":"none","context":[{"author":"a"}]}'].join('\n');
  const { rows, errors } = parseSheet(text);
  assert.deepEqual(rows.map((r) => [r.id, r.tier, r.source, r.context.length]), [['r1', 'fast', 'searched', 0], ['2', 'memory', '', 0]]);
  assert.deepEqual(errors, ['line 4: not JSON', 'line 5: duplicate id r1', 'line 6: no question', 'line 7: context must be [{ author, text }]']);
});

test('decisionOf: web -> fast, a server part -> memory, nothing -> none, an agent part -> agent', () => {
  assert.equal(decisionOf({ web: 'q', server: { forms: ['a'], who: [] } }), 'fast');
  assert.equal(decisionOf({ web: null, server: { forms: [], who: ['nikos'] } }), 'memory');
  assert.equal(decisionOf({ web: null, server: null, reason: 'none' }), 'none');
  assert.equal(decisionOf({ web: null, server: null, reason: 'unparsed' }), 'none');
  assert.equal(decisionOf({ agent: 'dig', web: 'q' }), 'agent');
});

test('summarize: agreement per source and latency percentiles', () => {
  const s = summarize([
    { id: 'a', source: 's1', tier: 'none', decision: 'none', ms: 100, ok: true, costUsd: 0.5 },
    { id: 'b', source: 's1', tier: 'fast', decision: 'failed', ms: 300, ok: false, costUsd: 0 },
    { id: 'c', source: 's2', tier: 'agent', decision: 'agent', ms: 200, ok: true, costUsd: 0.25 },
  ]);
  assert.equal(s.agreed, 2);
  assert.equal(s.failed, 1);
  assert.equal(s.saidAgent, true);
  assert.deepEqual(s.bySource, [{ source: 's1', rows: 2, agreed: 1 }, { source: 's2', rows: 1, agreed: 1 }]);
  assert.deepEqual(s.latency, { p50: 200, p95: 300 });
  assert.equal(s.costUsd, 0.75);
  assert.deepEqual(s.disagreements, [{ id: 'b', tier: 'fast', decision: 'failed', query: '' }]);
});
