// Tests for tools/lib/recall-eval.mjs: the pure part of tools/recall-eval.mjs (the questions
// file, hit@k scoring, false confident recalls, the spend stop, the candidate sample) and the
// offline guild the local stages run against, through the real recall runner with fakes; and
// the `--web` readiness of tools/recall-eval.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  latestLines,
  recordMessage,
  renderSummary,
  localGuild,
  parseQuestions,
  percentile,
  costOf,
  runQuestions,
  sampleCandidates,
  scoreQuestion,
  summarize,
  comparePrefetch,
  prefetchWindows,
  renderPrefetchCompare,
  renderTraceCompare,
  topExcerptLine,
  traceAgreement,
} from '../tools/lib/recall-eval.mjs';
import { createRecall } from '../src/behavior/recall-run.js';
import { toRecordLine } from '../src/memory/record.js';
import { labels } from './fixtures/labels.js';
import { withCapturedLogs } from './fixtures/capture-logs.js';
import { createDiscordInterface } from '../interfaces/discord/index.js';
import { createLookup } from '../src/web/lookup.js';
import { createBraveSearch } from '../src/web/brave.js';
import { createExaSearch } from '../src/web/exa.js';
import { webSearchKeys, webSearchReady } from '../tools/recall-eval.mjs';

// The Discord interface's capabilities object, as src/index.js injects it.
const DISCORD = createDiscordInterface().capabilities;

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SHIPPED_CONFIG = JSON.parse(fs.readFileSync(path.join(ROOT, 'config.json'), 'utf8'));

const DAY = 86_400_000;
const NOW = Date.UTC(2026, 9, 16, 12, 0, 0);
const C1 = '100000000000000001';
const C2 = '100000000000000002';
const ASKER = '200000000000000001';
const ANA = '200000000000000002';
const SELF = '200000000000000009';
const id = (n) => `3000000000000${String(n).padStart(5, '0')}`;

/** A valid question with `fields` over it. */
function question(fields = {}) {
  return {
    id: 'q1',
    channelId: C1,
    askerId: ASKER,
    question: 'πού είναι το κουνέλι;',
    expected: [id(1)],
    kind: 'exact',
    ...fields,
  };
}

/** A record line of `channelId` at `ts` (src/memory/record.js#toRecordLine). */
function recLine(n, ts, text, { channelId = C1, by = ANA, kind = 'seen', revision = 1 } = {}) {
  return toRecordLine(
    { id: id(n), channelId, authorId: by, content: text, ts },
    { kind, revision, now: () => NOW, uuid: () => `u-${n}-${revision}` }
  );
}

/** A message list with these ids. */
const win = (...ns) => ns.map((n) => ({ id: id(n) }));

test('recall-eval: a valid questions file parses, every problem is named by position and id', () => {
  const ok = parseQuestions([
    question(),
    question({ id: 'q2', kind: 'none', expected: [], note: 'not there' }),
    question({ id: 'q3', kind: 'fuzzy', expected: [id(1), id(1), id(2)] }),
  ]);
  assert.deepEqual(ok.errors, []);
  assert.equal(ok.questions.length, 3);
  assert.deepEqual(ok.questions[2].expected, [id(1), id(2)], 'expected ids once each');
  assert.equal(ok.questions[1].note, 'not there');

  const bad = parseQuestions([
    question(),
    question(),
    question({ id: 'q4', channelId: 'general', kind: 'maybe' }),
    question({ id: 'q5', kind: 'none' }),
    question({ id: 'q6', expected: [] }),
    question({ id: 'q7', question: '  ', expected: ['x'] }),
    'text',
  ]);
  assert.equal(bad.questions.length, 1);
  assert.equal(bad.errors.length, 6);
  assert.match(bad.errors[0], /^question 2 \(q1\): a duplicate id$/);
  assert.match(
    bad.errors[1],
    /question 3 \(q4\): channelId is not a Discord id; kind is not one of exact, fuzzy, none/
  );
  assert.match(bad.errors[2], /q5\): a none question expects no message/);
  assert.match(bad.errors[3], /q6\): expected is empty/);
  assert.match(bad.errors[4], /q7\): no question text; expected holds a value that is not a Discord id/);
  assert.match(bad.errors[5], /question 7: not an object/);
  assert.ok(!bad.errors.join('\n').includes('κουνέλι'), 'errors never quote the question');
  assert.deepEqual(parseQuestions({}).errors, ['the file is not a JSON array']);
});

test('recall-eval: hit@1 and hit@5 count the matched ids in window order, the rest of a window only as seen', () => {
  const q = question({ expected: [id(7)] });
  // Matched ids come first, in window order, then the other lines.
  const first = scoreQuestion(q, { windows: [win(1, 7, 2), win(3)], matched: [id(7), id(3)] });
  assert.deepEqual([first.rank, first.hit1, first.hit5, first.seen, first.windowRank], [1, true, true, true, 1]);
  assert.deepEqual(first.surfaced, [id(7), id(3), id(1), id(2)]);

  const fifth = scoreQuestion(q, {
    windows: [win(1, 2), win(3, 4), win(5, 7)],
    matched: [id(1), id(2), id(3), id(4), id(7)],
  });
  assert.deepEqual([fifth.rank, fifth.hit1, fifth.hit5, fifth.windowRank], [5, false, true, 3]);

  const sixth = scoreQuestion(q, {
    windows: [win(1, 2, 3, 4, 5, 6, 7)],
    matched: [id(1), id(2), id(3), id(4), id(5), id(7)],
  });
  assert.deepEqual([sixth.rank, sixth.hit5], [6, false]);

  // In a window but never matched: no hit, yet the summary saw it.
  const context = scoreQuestion(q, { windows: [win(1, 7)], matched: [id(1)] });
  assert.deepEqual([context.rank, context.hit5, context.seen], [null, false, true]);

  const nothing = scoreQuestion(q, {});
  assert.deepEqual(
    [nothing.rank, nothing.hit1, nothing.hit5, nothing.seen, nothing.windowRank],
    [null, false, false, false, null]
  );
});

test('recall-eval: a confident answer to a none question is a false confident recall, answerable ones never count', () => {
  const none = question({ id: 'n1', kind: 'none', expected: [] });
  const results = [
    { id: 'n1', kind: 'none', score: scoreQuestion(none, { confident: true }), latencyMs: 100, costUsd: 0.01 },
    {
      id: 'n2',
      kind: 'none',
      score: scoreQuestion(none, { confident: false, windows: [win(1)], matched: [id(1)] }),
      latencyMs: 300,
      costUsd: 0.02,
    },
    {
      id: 'a1',
      kind: 'exact',
      question: 'α;',
      score: scoreQuestion(question(), { confident: true, windows: [win(1)], matched: [id(1)] }),
      latencyMs: 200,
      costUsd: 0.03,
    },
    {
      id: 'a2',
      kind: 'fuzzy',
      question: 'β;',
      score: scoreQuestion(question(), { confident: true, windows: [win(2)], matched: [id(2)] }),
      latencyMs: 900,
      costUsd: 0,
      answer: 'ναι',
    },
    { id: 'a3', kind: 'exact', question: 'γ;', score: null, error: 'classifier-failed', latencyMs: 50, costUsd: 0 },
  ];
  assert.equal(results[1].score.falseConfident, false);
  assert.equal(results[2].score.falseConfident, null);
  const summary = summarize(results);
  assert.deepEqual(
    [
      summary.questions,
      summary.answerable,
      summary.hit1,
      summary.hit5,
      summary.noneQuestions,
      summary.falseConfident,
      summary.failed,
    ],
    [5, 3, 1, 1, 2, 1, 1]
  );
  assert.deepEqual(
    summary.misses.map((m) => m.id),
    ['a2', 'a3']
  );
  assert.deepEqual(summary.misses[0].surfaced, [id(2)]);
  assert.equal(summary.misses[1].error, 'classifier-failed');
  assert.deepEqual(summary.latencyMs, { median: 200, p90: 900 });
  assert.equal(summary.costUsd, 0.06);
  assert.equal(percentile([], 50), null);
  assert.equal(costOf({ cost: 0.2, cost_details: { upstream_inference_cost: 0.5 } }), 0.5);
  assert.equal(costOf({ cost: 0.2 }), 0.2);
  assert.equal(costOf(null), 0);
});

test('recall-eval: the run stops asking once the summed cost passes --max-usd, and keeps to --limit', async () => {
  const questions = ['a', 'b', 'c', 'd', 'e'].map((q) => question({ id: q }));
  const asked = [];
  const ask = async (q) => {
    asked.push(q.id);
    return { id: q.id, costUsd: 0.4 };
  };
  const stopped = await runQuestions(questions, { ask, maxUsd: 1 });
  // 0.4, 0.8, 1.2 > 1: the fourth is never asked.
  assert.deepEqual(asked, ['a', 'b', 'c']);
  assert.deepEqual([stopped.stopped, stopped.skipped, stopped.results.length], ['max-usd', 2, 3]);
  assert.ok(Math.abs(stopped.spentUsd - 1.2) < 1e-9);

  asked.length = 0;
  const limited = await runQuestions(questions, { ask, maxUsd: 100, limit: 2 });
  assert.deepEqual(asked, ['a', 'b']);
  assert.deepEqual([limited.stopped, limited.skipped], [null, 0]);

  // One at a time: a question starts only after the previous one resolved.
  let inFlight = 0;
  let most = 0;
  await runQuestions(questions, {
    maxUsd: 3,
    ask: async (q) => {
      inFlight += 1;
      most = Math.max(most, inFlight);
      await new Promise((resolve) => setImmediate(resolve));
      inFlight -= 1;
      return { id: q.id, costUsd: 0 };
    },
  });
  assert.equal(most, 1);
});

test('recall-eval: the newest revision of a message stands and a deleted one is gone', () => {
  const lines = latestLines([
    recLine(1, NOW - 5 * DAY, 'πρώτη μορφή'),
    recLine(1, NOW - 5 * DAY, 'δεύτερη μορφή', { revision: 2 }),
    recLine(2, NOW - 4 * DAY, 'θα σβηστεί'),
    { ...recLine(2, NOW - 4 * DAY, ''), kind: 'deleted' },
    { kind: 'felt', messageId: null },
  ]);
  assert.deepEqual(
    lines.map((l) => [l.messageId, l.text]),
    [[id(1), 'δεύτερη μορφή']]
  );
});

test('recall-eval: the sample keeps substantive lines of members only, outside the last two days, spread across channels', () => {
  const long = (word) => `${word} ${'λέξη '.repeat(10)}`.trim();
  const lines = latestLines([
    recLine(1, NOW - 40 * DAY, long('πολύ παλιά')),
    recLine(2, NOW - 10 * DAY, long('πριν')),
    recLine(3, NOW - 10 * DAY + 1000, long('μέση')),
    recLine(4, NOW - 10 * DAY + 2000, 'σύντομο'),
    recLine(5, NOW - 10 * DAY + 3000, long('δική της'), { kind: 'said', by: null }),
    recLine(6, NOW - 10 * DAY + 4000, long('το bot γράφει'), { by: SELF }),
    recLine(7, NOW - 10 * DAY + 5000, long('μετά')),
    recLine(8, NOW - DAY, long('πρόσφατο')),
    recLine(9, NOW - 9 * DAY, long('άλλο κανάλι'), { channelId: C2 }),
    recLine(10, NOW - 8 * DAY, long('άλλο κανάλι ξανά'), { channelId: C2 }),
  ]);
  let seed = 7;
  const rng = () => {
    seed = (seed * 16807) % 2147483647;
    return (seed - 1) / 2147483646;
  };
  const all = sampleCandidates(lines, {
    n: 50,
    days: 30,
    now: NOW,
    rng,
    selfId: SELF,
    nameOf: (who) => (who === ANA ? 'Ana' : null),
  });
  assert.deepEqual(all.map((c) => c.id).sort(), [id(2), id(3), id(7), id(9), id(10)]);
  const middle = all.find((c) => c.id === id(3));
  assert.deepEqual([middle.channelId, middle.authorId, middle.authorName, middle.self], [C1, ANA, 'Ana', false]);
  assert.deepEqual(
    middle.before.map((l) => l.id),
    [id(1), id(2)],
    'an old line is still a neighbour'
  );
  assert.deepEqual(
    middle.after.map((l) => l.id),
    [id(4), id(5), id(6)],
    'neighbours are any lines of the channel, hers included'
  );
  assert.equal(middle.after[1].self, true);

  // Two picks: one from each channel before a second from either.
  for (let s = 1; s < 20; s += 1) {
    seed = s;
    const two = sampleCandidates(lines, { n: 2, days: 30, now: NOW, rng, selfId: SELF });
    assert.deepEqual(two.map((c) => c.channelId).sort(), [C1, C2]);
  }
});

test('recall-eval: the local guild runs the record stage of the real recall, surfaces its window and searches no Discord', async () => {
  const record = {
    async *iterate() {
      yield recLine(1, NOW - DAY, 'το κουνέλι κρύφτηκε στον κήπο');
      yield recLine(2, NOW - DAY + 60_000, 'το είδα κι εγώ', { by: ASKER });
      yield recLine(3, NOW - DAY + 120_000, 'άσχετο', { channelId: C2 });
    },
  };
  const guild = localGuild({ guildId: 'g1', selfId: SELF, channelNameOf: (cid) => (cid === C1 ? 'garden' : null) });
  const channel = guild.channels.cache.get(C1);
  assert.equal(channel.name, 'garden');
  assert.equal(guild.channels.cache.get(C2).name, C2);
  const traces = [];
  const store = {
    state: { data: {}, markDirty() {} },
    listUserProfiles: () => [],
    appendRecallTrace: (gid, line) => traces.push(line),
  };
  const config = structuredClone(SHIPPED_CONFIG);
  config.bot = { ...config.bot, timezone: 'UTC' };
  config.features = { ...config.features, recall: true, recallTrace: true, meaningSearch: false };
  config.recall = { ...config.recall, recordDays: 3, recordContext: 3, maxPerDay: 100, timeoutMs: 30000 };
  const calls = [];
  const llm = {
    capLeft: () => 100,
    complete: async (messages) => (calls.push(messages), { text: 'stretch: 1\nIn the garden.' }),
  };
  const recall = createRecall({
    discord: DISCORD,
    hot: { config, prompts: { 'recall-summary': 'You are {{name}}; {{answerChars}}.', labels } },
    store,
    llm,
    record,
    now: () => NOW,
  });
  const windows = [];
  const candidate = {
    id: 'q',
    channelId: C1,
    authorId: ASKER,
    authorName: 'Nikos',
    content: 'πού είναι το κουνέλι;',
    ts: NOW,
    self: false,
    bot: false,
  };
  const { result: out } = await withCapturedLogs(() =>
    recall.run({
      guild,
      guildId: 'g1',
      channel,
      selfId: SELF,
      selfName: 'Zoë',
      history: [candidate],
      candidate,
      server: { forms: ['κουνέλι'], who: [], from: null, to: null },
      decorate: (messages) => {
        windows.push(messages);
        return messages;
      },
    })
  );
  assert.equal(out.text, 'In the garden.');
  assert.equal(calls.length, 1);
  assert.deepEqual(
    windows.map((w) => w.map((m) => m.id)),
    [[id(1), id(2)]],
    'the decorate hook sees each window the summary reads'
  );
  assert.equal(traces.length, 1);
  assert.deepEqual(
    traces[0].record.filter((w) => w.kept).flatMap((w) => w.hitIds),
    [id(1)]
  );
  assert.deepEqual(
    traces[0].plan.map((p) => p.sent),
    [true],
    'the Discord search was sent to the local guild'
  );
  assert.deepEqual([traces[0].hits, traces[0].clusters.length], [0, 0], 'and found nothing');
  const score = scoreQuestion(question({ expected: [id(1)] }), {
    windows,
    matched: traces[0].record.flatMap((w) => w.hitIds),
    confident: Boolean(out.text),
  });
  assert.deepEqual([score.rank, score.hit1], [1, true]);
});

test("recall-eval: an expected line in the asking channel's chat is answered by the chat, never a miss", () => {
  const q = question({ expected: [id(7)] });
  const chat = [id(5), id(7), id(9)];
  const byChat = scoreQuestion(q, { windows: [win(1)], matched: [id(1)], chatIds: chat });
  assert.deepEqual([byChat.inChat, byChat.hit5, byChat.outcome], [true, false, 'in-chat']);
  const asked = scoreQuestion(q, { chatIds: chat });
  assert.deepEqual([asked.inChat, asked.outcome], [true, 'in-chat'], 'also when the classifier asked no search');
  const both = scoreQuestion(q, { windows: [win(7)], matched: [id(7)], chatIds: chat });
  assert.deepEqual([both.inChat, both.outcome], [true, 'hit'], 'a hit stays a hit');
  const missed = scoreQuestion(q, { windows: [win(7)], matched: [], chatIds: [id(5)] });
  assert.deepEqual([missed.inChat, missed.outcome], [false, 'miss']);
  const none = scoreQuestion(question({ kind: 'none', expected: [] }), { chatIds: chat });
  assert.deepEqual([none.inChat, none.outcome], [null, null]);
});

test('recall-eval: the summary counts answered by chat, hits with and without it, and web answers', () => {
  const chat = [id(3)];
  const results = [
    {
      id: 'a1',
      kind: 'exact',
      question: 'α;',
      score: scoreQuestion(question(), { windows: [win(1)], matched: [id(1)], chatIds: chat }),
      latencyMs: 1,
      costUsd: 0,
    },
    {
      id: 'a2',
      kind: 'exact',
      question: 'β;',
      score: scoreQuestion(question({ expected: [id(3)] }), { windows: [win(3)], matched: [], chatIds: chat }),
      latencyMs: 1,
      costUsd: 0,
    },
    {
      id: 'a3',
      kind: 'fuzzy',
      question: 'γ;',
      score: scoreQuestion(question({ expected: [id(4)] }), { windows: [win(4)], matched: [], chatIds: chat }),
      latencyMs: 1,
      costUsd: 0,
      web: { query: 'δ', found: true, sources: 3 },
    },
    {
      id: 'n1',
      kind: 'none',
      question: 'ε;',
      score: scoreQuestion(question({ kind: 'none', expected: [] }), { chatIds: chat }),
      latencyMs: 1,
      costUsd: 0,
      web: { query: 'ζ', found: false, sources: 0 },
    },
  ];
  const summary = summarize(results);
  assert.deepEqual(
    [
      summary.hit1,
      summary.hit5,
      summary.seen,
      summary.answeredByChat,
      summary.hit1OrChat,
      summary.hit5OrChat,
      summary.seenOrChat,
      summary.webAnswered,
    ],
    [1, 1, 3, 1, 2, 2, 3, 1]
  );
  assert.deepEqual(
    summary.misses.map((m) => m.id),
    ['a3'],
    'the chat-answered question is not a miss'
  );
  const text = renderSummary(summary, { reportPath: 'r.json', stages: { record: true, web: true } });
  assert.match(text, /\| answered by the chat .*\| 1\/3 \(33 %\) \|/);
  assert.match(text, /\| hit@5 or answered by the chat \| 2\/3 \(67 %\) \|/);
  assert.match(text, /\| answered by the web \| 1\/4 \(25 %\) \|/);
  assert.doesNotMatch(
    renderSummary(summary, { reportPath: 'r.json', stages: { record: true, web: false } }),
    /answered by the web/
  );
});

test('recall-eval: a record line becomes a chat message with its link previews, as the live recall reads it', () => {
  const line = toRecordLine(
    {
      id: id(1),
      channelId: C1,
      authorId: ANA,
      content: 'δες https://example.org/faros',
      ts: NOW - DAY,
      linkCards: [
        { kind: 'link', url: 'https://example.org/faros', title: 'Ο φάρος', text: 'Ένα θαύμα.', site: 'example.org' },
      ],
    },
    { now: () => NOW, uuid: () => 'u-1' }
  );
  const message = recordMessage(line, { nameOf: () => 'Ana', selfName: 'Zoë' });
  assert.equal(message.authorName, 'Ana');
  assert.deepEqual(
    message.links.map((l) => [l.kind, l.title, l.text, l.site, l.url]),
    [['link', 'Ο φάρος', 'Ένα θαύμα.', 'example.org', 'https://example.org/faros']]
  );
  assert.deepEqual(recordMessage(recLine(2, NOW, 'χωρίς'), { nameOf: () => null, selfName: 'Zoë' }).links, []);
});

test('recall-eval: --web readiness follows web.search.engine through the lookup, not the Brave key alone', () => {
  const searches = { brave: createBraveSearch(), exa: createExaSearch() };
  const hotOf = (engine) => ({ config: { web: { search: { engine } } }, prompts: {} });
  const ready = (engine, env) => webSearchReady({ hot: hotOf(engine), createLookup, searches, env });
  assert.equal(ready('openrouter', {}), true, 'openrouter needs no Brave key');
  assert.equal(ready('exa', {}), true, 'exa needs no key');
  assert.equal(ready('brave', {}), false, 'brave without its key cannot search');
  assert.equal(ready('brave', { BRAVE_SEARCH_API_KEY: '   ' }), false, 'a blank key is no key');
  assert.equal(ready('brave', { BRAVE_SEARCH_API_KEY: 'k' }), true);
  assert.deepEqual(webSearchKeys({ BRAVE_SEARCH_API_KEY: ' k ', EXA_API_KEY: '' }), { brave: 'k', exa: null });
});

// ---- the prefetch comparison (--prefetch) and the live traces (traces) ------------------------

const PREFETCHED = {
  status: 'ok',
  excerpts: [
    {
      source: 'history',
      channelId: 'c2',
      ids: ['111', '222', '333'],
      hitIds: ['222'],
      startTs: Date.UTC(2026, 9, 1, 9),
      endTs: Date.UTC(2026, 9, 1, 10),
      lines: '[09:00] Ana: πριν\n>> [09:05] Ana: το δάσος και ο σκύλος',
    },
    { source: 'memory', id: 'ep1', lines: 'a note' },
  ],
};

test('prefetchWindows: the history excerpts as windows, their relevant lines first as the matched ids', () => {
  assert.deepEqual(prefetchWindows(PREFETCHED), {
    windows: [[{ id: '111' }, { id: '222' }, { id: '333' }]],
    matched: ['222'],
  });
  assert.deepEqual(prefetchWindows(null), { windows: [], matched: [] });
  const q = { kind: 'exact', expected: ['222'] };
  assert.equal(scoreQuestion(q, prefetchWindows(PREFETCHED)).rank, 1);
});

test('comparePrefetch: both paths summed up; which questions only one of them hit; not-in-memory questions the prefetch still showed something for', () => {
  const results = [
    {
      id: 'q1',
      kind: 'exact',
      question: 'α',
      score: { hit5: true, rank: 1 },
      prefetch: { status: 'ok', excerpts: 1, score: { hit5: false, rank: null }, ms: 300 },
    },
    {
      id: 'q2',
      kind: 'fuzzy',
      question: 'β',
      score: { hit5: false, rank: null },
      prefetch: { status: 'ok', excerpts: 2, score: { hit5: true, rank: 2 }, ms: 500 },
    },
    {
      id: 'q3',
      kind: 'none',
      question: 'γ',
      score: { falseConfident: false },
      prefetch: { status: 'ok', excerpts: 1, score: null, ms: 100 },
    },
    {
      id: 'q4',
      kind: 'none',
      question: 'δ',
      score: { falseConfident: false },
      prefetch: { status: 'none', excerpts: 0, score: null, ms: 100 },
    },
  ];
  const compare = comparePrefetch(results);
  assert.deepEqual([compare.classifier.hit5, compare.prefetch.hit5], [1, 1]);
  assert.deepEqual(compare.onlyClassifier, ['q1']);
  assert.deepEqual(compare.onlyPrefetch, ['q2']);
  assert.deepEqual(compare.noneShown, ['q3']);
  assert.deepEqual(compare.statuses, { ok: 3, none: 1 });
  const text = renderPrefetchCompare(compare, results, { reportPath: 'r.json' });
  assert.ok(text.includes('| hit@5 | 1/2 (50 %) | 1/2 (50 %) |'), text);
  assert.ok(text.includes('| q2 | fuzzy | - | 2 | ok | 2 | β |'), text);
});

test('traceAgreement: the same lines or an overlapping kept window is the same; the same channel near it partial; a run that kept nothing n/a', () => {
  const trace = {
    clusters: [
      { channelId: 'c2', from: '2026-10-01T08:50:00.000Z', to: '2026-10-01T09:30:00.000Z', kept: true },
      { channelId: 'c3', from: '2026-09-01T00:00:00.000Z', to: '2026-09-01T01:00:00.000Z', kept: false },
    ],
    record: [
      {
        channelId: 'c5',
        from: '2026-08-01T00:00:00.000Z',
        to: '2026-08-01T00:10:00.000Z',
        hitIds: ['999'],
        kept: true,
      },
    ],
    meaning: { kept: [{ id: '777', kind: 'record' }] },
  };
  assert.equal(traceAgreement(trace, PREFETCHED.excerpts), 'same', 'overlaps the kept cluster in time');
  assert.equal(
    traceAgreement(trace, [{ source: 'history', channelId: 'c9', ids: ['999'], startTs: 0 }]),
    'same',
    'holds a kept record hit'
  );
  assert.equal(
    traceAgreement(trace, [
      {
        source: 'history',
        channelId: 'c2',
        ids: ['1'],
        startTs: Date.UTC(2026, 9, 1, 20),
        endTs: Date.UTC(2026, 9, 1, 21),
      },
    ]),
    'partial'
  );
  assert.equal(
    traceAgreement(trace, [{ source: 'history', channelId: 'c3', ids: ['1'], startTs: Date.UTC(2026, 8, 1) }]),
    'none',
    'a window the run did not keep'
  );
  assert.equal(traceAgreement({ clusters: [], record: [] }, PREFETCHED.excerpts), 'n/a');
});

test('renderTraceCompare: totals for the runs the classifier answered and those it did not, one row per run with the top hit', () => {
  assert.equal(topExcerptLine(PREFETCHED), '>> [09:05] Ana: το δάσος και ο σκύλος');
  const rows = [
    {
      at: '2026-10-14T10:00:00.000Z',
      trigger: 'θυμάσαι το δάσος;',
      forms: ['δάσος'],
      answer: 'text',
      agreement: 'same',
      status: 'ok',
      excerpts: 1,
      top: '>> το δάσος',
    },
    {
      at: '2026-10-15T10:00:00.000Z',
      trigger: 'plus ultra',
      forms: ['ultra'],
      answer: 'nothing',
      agreement: 'n/a',
      status: 'ok',
      excerpts: 2,
      top: '>> plus ultra',
    },
    { at: '2026-10-16T10:00:00.000Z', forms: [], answer: 'text', error: 'no-trigger-in-record' },
  ];
  const text = renderTraceCompare(rows, { reportPath: 'r.json' });
  assert.ok(text.includes('| classifier answered: prefetch found the same | 1/1 (100 %) |'), text);
  assert.ok(text.includes('| classifier found nothing: prefetch showed anything | 1/1 (100 %) |'), text);
  assert.ok(text.includes('| 2026-10-14 10:00 | θυμάσαι το δάσος; | δάσος | Y | Y | ok (1) | >> το δάσος |'), text);
  assert.ok(text.includes('error: no-trigger-in-record'));
});
