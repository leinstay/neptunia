// Tests for src/behavior/recall.js: the pure core of recall (the lookup
// answer parser, the search plan, clustering, window rendering, the summary
// request and its answer). No I/O, no real clock.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  HIT_MARK,
  RECALL_DEFAULTS,
  buildRecallRequest,
  clusterHits,
  clusterScore,
  cutStretch,
  dropChatHits,
  fallbackWindow,
  followConversation,
  isRecentCue,
  matchMemory,
  matchRecord,
  mergeWindows,
  parseLookupAnswer,
  parseRecallAnswer,
  queryKey,
  rankClusters,
  rareFormKeys,
  recallContext,
  recallSettings,
  renderRecallWindows,
  sampleOffsets,
  scanArchive,
  searchPlan,
  snowflakeAt,
} from '../src/behavior/recall.js';
import { estimateTokens } from '../src/llm/tokens.js';
import { createAppendStore } from '../src/memory/append-store.js';
import { createRecord, toRecordLine } from '../src/memory/record.js';
import { labels } from './fixtures/labels.js';
import fs, { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const SHIPPED_CONFIG = JSON.parse(readFileSync(new URL('../config.json', import.meta.url), 'utf8'));

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const NOW = Date.UTC(2026, 9, 5, 12, 0, 0);
const BERLIN = 'Europe/Berlin';

/** The snowflake's timestamp back in ms. */
const tsOf = (id) => Number((BigInt(id) >> 22n) + 1420070400000n);

// ---- settings ------------------------------------------------------------------------------

test('recallSettings: a missing switch counts as on, false turns it off, unusable numbers fall back', () => {
  assert.equal(recallSettings({ features: { recall: false } }), null);
  assert.deepEqual(recallSettings({}), { ...RECALL_DEFAULTS });
  const s = recallSettings({ recall: { maxForms: 3.9, maxPeople: 0, dateSamples: 0, windowMessages: 500, timeoutMs: 'x', stretchChars: -1 } });
  assert.equal(s.maxForms, 3);
  assert.equal(s.maxPeople, 0, '0 people is a usable value');
  assert.equal(s.dateSamples, RECALL_DEFAULTS.dateSamples, 'below 1 falls back');
  assert.equal(s.windowMessages, 100, 'one page at most');
  assert.equal(s.timeoutMs, RECALL_DEFAULTS.timeoutMs);
  assert.equal(s.stretchChars, RECALL_DEFAULTS.stretchChars);
  assert.equal(recallSettings({ recall: { minSummaryMs: -1 } }).minSummaryMs, RECALL_DEFAULTS.minSummaryMs);
  assert.equal(recallSettings({ recall: { minSummaryMs: 0 } }).minSummaryMs, 0, 'the summary asked whatever is left');
  assert.equal(recallSettings({ recall: { keepOldest: 0 } }).keepOldest, 0, '0 keeps only the newest');
  assert.equal(recallSettings({ recall: { keepOldest: 2.7 } }).keepOldest, 2);
  assert.equal(recallSettings({ recall: { keepOldest: -1 } }).keepOldest, RECALL_DEFAULTS.keepOldest);
});

// ---- the lookup answer -----------------------------------------------------------------------

test('parseLookupAnswer: the old single-line answer is still a web query, none is none', () => {
  assert.deepEqual(parseLookupAnswer('"Café Müller opening hours".'), { web: 'Café Müller opening hours', server: null, reason: 'ok' });
  assert.deepEqual(parseLookupAnswer('None needed.'), { web: null, server: null, reason: 'none' });
  assert.deepEqual(parseLookupAnswer('`none`'), { web: null, server: null, reason: 'none' });
  assert.deepEqual(parseLookupAnswer('  \n '), { web: null, server: null, reason: 'empty' });
  assert.deepEqual(parseLookupAnswer(null), { web: null, server: null, reason: 'empty' });
  assert.equal(parseLookupAnswer('first line\nsecond line').web, 'first line', 'only the first line of the old shape');
  assert.equal([...parseLookupAnswer('x'.repeat(300)).web].length, 200);
});

test('parseLookupAnswer: the old shape -- none only as a whole first word in any wrapping; a line of punctuation alone is empty', () => {
  for (const raw of ['"none"', "'None.'", 'none!', 'NONE -- nothing to look up', '“none”', '``none``', '  NONE.\nextra']) {
    assert.deepEqual(parseLookupAnswer(raw), { web: null, server: null, reason: 'none' }, raw);
  }
  assert.equal(parseLookupAnswer('nonexistent planets list').web, 'nonexistent planets list');
  assert.equal(parseLookupAnswer('nonetheless the score').web, 'nonetheless the score');
  assert.deepEqual(parseLookupAnswer('"..."'), { web: null, server: null, reason: 'empty' });
});

test('parseLookupAnswer: labelled lines in any order and case; unlabelled lines are ignored', () => {
  const answer = ['Here you go:', 'WHO: Ἀλέξανδρος, alexandros', 'Server: "κουνέλι", κουνελιού, κουνέλι', '- **web:** rabbit hunting season', 'When: none'].join('\n');
  const parsed = parseLookupAnswer(answer, { timezone: 'UTC', now: NOW });
  assert.equal(parsed.reason, 'ok');
  assert.equal(parsed.web, 'rabbit hunting season');
  assert.deepEqual(parsed.server, { forms: ['κουνέλι', 'κουνελιού'], who: ['ἀλέξανδρος', 'alexandros'], from: null, to: null });
});

test('parseLookupAnswer: forms are cleaned, bounded in length and words, capped at maxForms', () => {
  const parsed = parseLookupAnswer('server: a, "Νέο Έτος", one two three four, ' + 'x'.repeat(41) + ', ÉTÉ., été, b2, c3, d4', { maxForms: 4 });
  assert.deepEqual(parsed.server.forms, ['νέο έτος', 'été', 'b2', 'c3']);
  assert.equal(parsed.web, null);
});

test('parseLookupAnswer: labelled lines that all say none are none; unusable ones are unparsed', () => {
  assert.deepEqual(parseLookupAnswer('web: none\nserver: none'), { web: null, server: null, reason: 'none' });
  assert.deepEqual(parseLookupAnswer('when: last tuesday', { now: NOW }), { web: null, server: null, reason: 'unparsed' });
  assert.deepEqual(parseLookupAnswer('server: x', { now: NOW }), { web: null, server: null, reason: 'unparsed' });
});

test('parseLookupAnswer: a range alone makes a server search; one date is that whole local day', () => {
  const parsed = parseLookupAnswer('when: 2025-12-18', { timezone: BERLIN, now: NOW });
  assert.deepEqual(parsed.server, { forms: [], who: [], from: Date.UTC(2025, 11, 17, 23, 0), to: Date.UTC(2025, 11, 18, 23, 0) - 1 });
});

test('parseLookupAnswer: a range across a daylight saving change keeps local wall times', () => {
  const parsed = parseLookupAnswer('when: 2026-03-28 18:00 .. 2026-03-29 06:00', { timezone: BERLIN, now: NOW });
  assert.equal(parsed.server.from, Date.UTC(2026, 2, 28, 17, 0), 'before the change: +01:00');
  assert.equal(parsed.server.to, Date.UTC(2026, 2, 29, 4, 0), 'after the change: +02:00');
  const days = parseLookupAnswer('when: 2025-10-26..2025-10-26', { timezone: BERLIN, now: NOW });
  assert.equal(days.server.to + 1 - days.server.from, 25 * HOUR, 'a fall-back day lasts 25 hours');
});

test('parseLookupAnswer: reversed bounds are swapped, a future end is clamped, a future start drops the range', () => {
  const reversed = parseLookupAnswer('when: 2026-01-01 .. 2025-12-31', { timezone: 'UTC', now: NOW });
  assert.equal(reversed.server.from, Date.UTC(2025, 11, 31));
  assert.equal(reversed.server.to, Date.UTC(2026, 0, 2) - 1);
  const today = parseLookupAnswer('when: 2026-10-05', { timezone: 'UTC', now: NOW });
  assert.equal(today.server.to, NOW);
  assert.equal(parseLookupAnswer('when: 2026-12-01', { timezone: 'UTC', now: NOW }).server, null);
});

test('parseLookupAnswer: an open side is allowed; an unparsable side gives no range', () => {
  const open = parseLookupAnswer('when: 2025-12-31 18:00 ..', { timezone: 'UTC', now: NOW });
  assert.deepEqual([open.server.from, open.server.to], [Date.UTC(2025, 11, 31, 18, 0), null]);
  const bad = parseLookupAnswer('server: κουνέλι\nwhen: 2025-12-31 .. soon', { timezone: 'UTC', now: NOW });
  assert.deepEqual(bad.server, { forms: ['κουνέλι'], who: [], from: null, to: null });
  assert.equal(parseLookupAnswer('when: 2025-02-30', { now: NOW }).server, null, 'a date that does not exist');
});

// ---- the plan ------------------------------------------------------------------------------

test('snowflakeAt: a time maps to the first snowflake of its millisecond', () => {
  const at = Date.UTC(2026, 9, 1, 18, 44, 0, 123);
  assert.equal(tsOf(snowflakeAt(at)), at);
  assert.equal(snowflakeAt(0), '0');
  assert.equal(snowflakeAt(NaN), '0');
});

test('searchPlan: content forms round-robin server and who forms up to maxForms, then authors', () => {
  const plan = searchPlan({ forms: ['α', 'β', 'γ'], who: ['δ', 'α'], memberIds: ['u1', 'u1', 'u2'], maxForms: 4 });
  assert.deepEqual(
    plan.map((q) => q.content ?? q.authorId),
    ['α', 'δ', 'β', 'γ', 'u1', 'u2'],
  );
  assert.ok(plan.every((q) => q.minId === null && q.maxId === null));
});

test('searchPlan: each content query carries its kind, form for a server form and who for a name form', () => {
  const plan = searchPlan({ forms: ['α', 'β', 'γ'], who: ['δ', 'α'], memberIds: ['u1', 'u1', 'u2'], maxForms: 4 });
  assert.deepEqual(plan.map((q) => q.kind), ['form', 'who', 'form', 'form', 'author', 'author']);
  const shared = searchPlan({ forms: ['β', 'α'], who: ['α'], maxForms: 4 });
  assert.deepEqual(shared.map((q) => [q.content, q.kind]), [['β', 'form'], ['α', 'form']], 'a form in both lists is a server form');
});

test('searchPlan: the range bounds every query; the turn\'s own chat caps the end', () => {
  const from = Date.UTC(2025, 11, 31, 18);
  const to = Date.UTC(2026, 0, 1, 6);
  const [query] = searchPlan({ forms: ['α'], from, to, maxForms: 8 });
  assert.equal(tsOf(query.minId), from);
  assert.equal(tsOf(query.maxId), to + 1);
  const before = Date.UTC(2026, 9, 5, 11);
  const [capped] = searchPlan({ forms: ['α'], maxForms: 8, before });
  assert.equal(capped.minId, null);
  assert.equal(tsOf(capped.maxId), before);
  assert.deepEqual(searchPlan({ forms: ['α'], from: before + HOUR, maxForms: 8, before }), [], 'a range inside the visible chat');
});

test('searchPlan: a range and nothing else is one range query; nothing at all is no query', () => {
  const plan = searchPlan({ from: Date.UTC(2025, 11, 18), to: Date.UTC(2025, 11, 19) - 1, maxForms: 8 });
  assert.equal(plan.length, 1);
  assert.equal(plan[0].kind, 'range');
  assert.deepEqual(searchPlan({ maxForms: 8 }), []);
  assert.deepEqual(searchPlan({ forms: ['α'], maxForms: 0 }), []);
});

test('sampleOffsets: evenly spaced over the total, one page when it fits', () => {
  assert.deepEqual(sampleOffsets(2115, 4), [0, 528, 1057, 1586]);
  assert.deepEqual(sampleOffsets(20, 4), [0]);
  assert.deepEqual(sampleOffsets(100000, 2), [0, 9975]);
});

// ---- clusters and windows ------------------------------------------------------------------

test('clusterHits: hits of one channel closer than the gap join; the newest clusters are kept', () => {
  const t = Date.UTC(2026, 9, 1, 15, 19);
  const hits = [
    { id: 'a1', channelId: 'c1', ts: t },
    { id: 'a2', channelId: 'c1', ts: t + 20 * MINUTE },
    { id: 'a3', channelId: 'c1', ts: t + 27 * MINUTE },
    { id: 'b1', channelId: 'c1', ts: t + 34 * HOUR },
    { id: 'x1', channelId: 'c2', ts: t + 21 * MINUTE },
    { id: 'old', channelId: 'c1', ts: t - 40 * HOUR },
    { id: 'a2', channelId: 'c1', ts: t + 20 * MINUTE },
  ];
  const clusters = clusterHits(hits, { gapMinutes: 30, maxClusters: 3, keepOldest: 0 });
  assert.deepEqual(
    clusters.map((c) => [c.channelId, c.ids, c.middleId]),
    [
      ['c1', ['b1'], 'b1'],
      ['c1', ['a1', 'a2', 'a3'], 'a2'],
      ['c2', ['x1'], 'x1'],
    ],
  );
  assert.equal(clusters[1].startTs, t);
  assert.equal(clusters[1].endTs, t + 27 * MINUTE);
});

/** Seven one-hit clusters, two hours apart, alternating two channels; ids `k0` (oldest) .. `k6` (newest). */
function sevenClusters() {
  const t = Date.UTC(2026, 9, 1, 8);
  return Array.from({ length: 7 }, (_, i) => ({ id: `k${i}`, channelId: i % 2 === 0 ? 'c1' : 'c2', ts: t + i * 2 * HOUR }));
}

/** A hit of channel `channelId` at `ts` found by the queries `keys`. */
function found(id, ts, keys, channelId = 'c1') {
  return { id, channelId, ts, queries: keys };
}

test('queryKey: one key per search query by kind, every sampled page of a range under one', () => {
  assert.equal(queryKey({ kind: 'form', content: 'κουνέλι', minId: null, maxId: null }), 'form:κουνέλι');
  assert.equal(queryKey({ kind: 'who', content: 'éloïse', minId: null, maxId: null }), 'who:éloïse');
  assert.equal(queryKey({ kind: 'author', authorId: 'u7', minId: null, maxId: null }), 'author:u7');
  assert.equal(queryKey({ kind: 'range', minId: '1', maxId: '2' }), 'range');
  assert.equal(queryKey({ kind: 'range', minId: '1', maxId: '2' }), queryKey({ kind: 'range', minId: '1', maxId: '2', offset: 528 }));
  assert.notEqual(queryKey({ kind: 'form', content: 'u7' }), queryKey({ kind: 'author', authorId: 'u7' }));
  assert.notEqual(queryKey({ kind: 'form', content: 'ana' }), queryKey({ kind: 'who', content: 'ana' }));
});

test('clusterHits: clusters rank by distinct form queries, then all distinct queries, then the newest; the kept ones stay newest first', () => {
  const t = Date.UTC(2026, 9, 1, 8);
  const hits = [
    found('n1', t + 10 * HOUR, ['form:a']),
    found('n2', t + 12 * HOUR, ['form:a']),
    found('n3', t + 14 * HOUR, ['form:a']),
    found('d1', t - 400 * HOUR, ['form:a', 'form:b']),
    found('d2', t - 400 * HOUR + 5 * MINUTE, ['form:c']),
    found('w1', t, ['form:a', 'author:u2'], 'c2'),
  ];
  const clusters = clusterHits(hits, { gapMinutes: 30, maxClusters: 3, keepOldest: 0 });
  assert.deepEqual(
    clusters.map((c) => [c.middleId, c.forms, c.queries]),
    [
      ['n3', 1, 1],
      ['w1', 1, 2],
      ['d2', 3, 3],
    ],
    'the three-form cluster, the one form with an author, then the newest of the one-form clusters; shown newest first',
  );
  assert.deepEqual(clusterHits(hits, { gapMinutes: 30, maxClusters: 9, keepOldest: 0 }).map((c) => c.middleId), ['n3', 'n2', 'n1', 'w1', 'd2'], 'a one-hit cluster still counts');
});

test('clusterHits: a message found by two queries counts both; hits without queries count none', () => {
  const t = Date.UTC(2026, 9, 1, 8);
  const [one] = clusterHits([found('x', t, ['form:a']), found('x', t, ['who:b', 'form:a'])], { gapMinutes: 30 });
  assert.deepEqual([one.ids, one.forms, one.queries], [['x'], 1, 2]);
  const [bare] = clusterHits([{ id: 'y', channelId: 'c1', ts: t }], { gapMinutes: 30 });
  assert.deepEqual([bare.forms, bare.queries], [0, 0]);
});

test('clusterHits: a recent cluster of name and author hits loses to an older cluster of two forms', () => {
  const t = Date.UTC(2026, 9, 1, 8);
  const hits = [
    found('p1', t, ['who:éloïse', 'author:u3']),
    found('p2', t + 5 * MINUTE, ['author:u3']),
    found('o1', Date.UTC(2025, 2, 1, 20), ['form:κουνέλι']),
    found('o2', Date.UTC(2025, 2, 1, 20, 4), ['form:σκελετός']),
  ];
  assert.deepEqual(clusterHits(hits, { gapMinutes: 30, maxClusters: 1, keepOldest: 0 }).map((c) => c.middleId), ['o2']);
});

test('clusterHits: one form hit outranks a cluster of name and author hits only', () => {
  const t = Date.UTC(2026, 9, 1, 8);
  const hits = [
    found('p1', t, ['who:éloïse', 'author:u3']),
    found('o1', Date.UTC(2024, 5, 1), ['form:κουνέλι'], 'c2'),
  ];
  assert.deepEqual(clusterHits(hits, { gapMinutes: 30, maxClusters: 1, keepOldest: 0 }).map((c) => c.middleId), ['o1']);
});

test('clusterHits: on equal forms the cluster with more distinct queries wins, then the newer', () => {
  const t = Date.UTC(2026, 9, 1, 8);
  const older = found('o1', t - 100 * HOUR, ['form:a', 'who:éloïse']);
  const newer = found('n1', t, ['form:b']);
  assert.deepEqual(clusterHits([older, newer], { gapMinutes: 30, maxClusters: 1, keepOldest: 0 }).map((c) => c.middleId), ['o1'], 'more keys');
  const tie = found('n2', t, ['form:b', 'author:u3']);
  assert.deepEqual(clusterHits([older, tie], { gapMinutes: 30, maxClusters: 1, keepOldest: 0 }).map((c) => c.middleId), ['n2'], 'same keys: the newer');
});

test('clusterHits: keepOldest needs two distinct form queries, name and author hits do not count', () => {
  const t = Date.UTC(2026, 9, 1, 8);
  const newer = Array.from({ length: 3 }, (_, i) => found(`n${i}`, t + i * 2 * HOUR, ['form:a', 'form:b']));
  const named = found('w', Date.UTC(2020, 4, 1), ['form:a', 'who:éloïse', 'author:u3']);
  const topical = found('f', Date.UTC(2022, 4, 1), ['form:a', 'form:c']);
  const ids = (hits) => clusterHits(hits, { gapMinutes: 30, maxClusters: 2, keepOldest: 1 }).map((c) => c.middleId);
  assert.deepEqual(ids([...newer, named, topical]), ['n2', 'f'], 'the oldest cluster has one form only');
  const singles = Array.from({ length: 3 }, (_, i) => found(`s${i}`, t + i * 2 * HOUR, ['form:a', 'author:u3']));
  assert.deepEqual(ids([...singles, named]), ['s2', 'w'], 'no cluster of two forms: the slot goes by rank');
});

test('clusterHits: an old single-hit cluster loses to a dense old cluster', () => {
  const t = Date.UTC(2026, 9, 1, 8);
  const recent = Array.from({ length: 5 }, (_, i) => found(`r${i}`, t + i * 2 * HOUR, ['form:word']));
  const ancient = found('z', Date.UTC(2020, 4, 1, 12), ['form:word']);
  const dense = [
    found('o1', Date.UTC(2026, 8, 28, 20), ['form:coined']),
    found('o2', Date.UTC(2026, 8, 28, 20, 3), ['form:pun', 'form:word']),
  ];
  for (const keepOldest of [0, 1]) {
    const kept = clusterHits([...recent, ancient, ...dense], { gapMinutes: 30, maxClusters: 5, keepOldest }).map((c) => c.middleId);
    assert.deepEqual(kept, ['r4', 'r3', 'r2', 'r1', 'o2'], String(keepOldest));
  }
});

test('clusterHits: keepOldest takes the oldest clusters of at least two queries from the rest, never a single-hit one', () => {
  const t = Date.UTC(2026, 9, 1, 8);
  const newer = Array.from({ length: 4 }, (_, i) => found(`n${i}`, t + i * 2 * HOUR, ['form:a', 'form:b']));
  const older = [found('o1', Date.UTC(2021, 2, 1), ['form:a', 'form:c']), found('o2', Date.UTC(2022, 2, 1), ['form:b', 'form:c'])];
  const single = found('z', Date.UTC(2020, 4, 1), ['form:a']);
  const ids = (hits, keepOldest) => clusterHits(hits, { gapMinutes: 30, maxClusters: 3, keepOldest }).map((c) => c.middleId);
  const all = [...newer, ...older, single];
  assert.deepEqual(ids(all, 1), ['n3', 'n2', 'o1'], 'the oldest two-query cluster, not the older single hit');
  assert.deepEqual(ids(all, 2), ['n3', 'o2', 'o1']);
  assert.deepEqual(ids(all, 0), ['n3', 'n2', 'n1'], '0 reserves nothing');
  const singles = Array.from({ length: 4 }, (_, i) => found(`s${i}`, t + i * 2 * HOUR, ['form:a']));
  assert.deepEqual(ids([...singles, single], 1), ['s3', 's2', 's1'], 'no eligible cluster in the rest: the slot goes by rank');
  assert.deepEqual(ids(all, 9), ['n0', 'o2', 'o1'], 'never more than maxClusters');
});

test('clusterHits: a missing keepOldest falls back to the shipped config value', () => {
  const t = Date.UTC(2026, 9, 1, 8);
  const hits = [
    ...Array.from({ length: 4 }, (_, i) => found(`n${i}`, t + i * 2 * HOUR, ['form:a', 'form:b'])),
    found('o1', Date.UTC(2021, 2, 1), ['form:a', 'form:c']),
  ];
  const shipped = SHIPPED_CONFIG.recall.keepOldest;
  assert.equal(RECALL_DEFAULTS.keepOldest, shipped);
  assert.equal(recallSettings({ recall: {} }).keepOldest, shipped);
  assert.deepEqual(
    clusterHits(hits, { gapMinutes: 30, maxClusters: 3 }).map((c) => c.middleId),
    clusterHits(hits, { gapMinutes: 30, maxClusters: 3, keepOldest: shipped }).map((c) => c.middleId),
  );
});

test('rareFormKeys: the form keys whose search totals at most rareHits; 0 marks none', () => {
  const totals = new Map([
    ['form:κουνέλι', 1],
    ['form:σκελετός', 5],
    ['form:λέξη', 6],
    ['who:éloïse', 1],
    ['author:u3', 1],
    ['range', 1],
    ['form:άγνωστο', 'x'],
  ]);
  assert.deepEqual([...rareFormKeys(totals, 5)].sort(), ['form:κουνέλι', 'form:σκελετός']);
  assert.deepEqual([...rareFormKeys(totals, 1)], ['form:κουνέλι']);
  assert.equal(rareFormKeys(totals, 0).size, 0, '0 = no rarity bonus');
  assert.equal(rareFormKeys(null, 5).size, 0);
});

test('clusterHits: a one-hit old cluster with a rare form beats a newer cluster with one common form', () => {
  const t = Date.UTC(2026, 9, 1, 8);
  const hits = [
    found('o1', Date.UTC(2021, 2, 1, 20), ['form:σκελετός']),
    found('n1', t, ['form:κουνέλι'], 'c2'),
    found('n2', t + 5 * MINUTE, ['form:κουνέλι'], 'c2'),
  ];
  const kept = (rareForms) => clusterHits(hits, { gapMinutes: 30, maxClusters: 1, keepOldest: 0, rareForms });
  const [rare] = kept(new Set(['form:σκελετός']));
  assert.deepEqual([rare.middleId, rare.forms, rare.topic], ['o1', 1, 2]);
  assert.deepEqual(kept(undefined).map((c) => c.middleId), ['n2'], 'no rare form: the newer one-form cluster');
  assert.deepEqual(kept(rareFormKeys(new Map([['form:σκελετός', 1]]), 0)).map((c) => c.middleId), ['n2'], 'rareHits 0 disables the bonus');
});

test('clusterHits: two common forms tie with one rare form and recency decides', () => {
  const t = Date.UTC(2026, 9, 1, 8);
  // Equal topic score (2) and equal distinct keys (2): only then does recency decide.
  const rare = found('o1', Date.UTC(2021, 2, 1, 20), ['form:σκελετός', 'who:éloïse']);
  const common = found('n1', t, ['form:κουνέλι', 'form:λέξη'], 'c2');
  const ids = (hits) => clusterHits(hits, { gapMinutes: 30, maxClusters: 1, keepOldest: 0, rareForms: ['form:σκελετός'] }).map((c) => c.middleId);
  assert.deepEqual(ids([rare, common]), ['n1'], 'equal topic score and keys: the newer');
  const older = found('n1', Date.UTC(2020, 2, 1, 20), ['form:κουνέλι', 'form:λέξη'], 'c2');
  assert.deepEqual(ids([rare, older]), ['o1'], 'equal topic score and keys: the rare one is newer now');
  const named = found('n1', Date.UTC(2020, 2, 1, 20), ['form:κουνέλι', 'form:λέξη', 'who:éloïse'], 'c2');
  assert.deepEqual(ids([rare, named]), ['n1'], 'equal topic score: more distinct keys first');
});

test('clusterHits: keepOldest takes a cluster of one rare form, never one of one common form', () => {
  const t = Date.UTC(2026, 9, 1, 8);
  const newer = Array.from({ length: 3 }, (_, i) => found(`n${i}`, t + i * 2 * HOUR, ['form:a', 'form:b']));
  const common = found('c', Date.UTC(2020, 4, 1), ['form:a']);
  const rare = found('r', Date.UTC(2022, 4, 1), ['form:z']);
  const ids = (rareForms) => clusterHits([...newer, common, rare], { gapMinutes: 30, maxClusters: 2, keepOldest: 1, rareForms }).map((c) => c.middleId);
  assert.deepEqual(ids(['form:z']), ['n2', 'r'], 'one rare form scores 2');
  assert.deepEqual(ids([]), ['n2', 'n0'], 'no rare form: the oldest two-form cluster, never the one common form');
});

test('recallSettings: a missing rareHits falls back to the shipped config value; 0 is kept', () => {
  const shipped = SHIPPED_CONFIG.recall.rareHits;
  assert.equal(typeof shipped, 'number');
  assert.equal(RECALL_DEFAULTS.rareHits, shipped);
  assert.equal(recallSettings({ recall: {} }).rareHits, shipped);
  assert.equal(recallSettings({ recall: { rareHits: 0 } }).rareHits, 0, '0 = no rarity bonus');
  assert.equal(recallSettings({ recall: { rareHits: 2.7 } }).rareHits, 2);
  assert.equal(recallSettings({ recall: { rareHits: -1 } }).rareHits, shipped);
});

test('clusterHits: with no more clusters than maxClusters, keepOldest changes nothing', () => {
  const hits = sevenClusters().slice(2);
  for (const keepOldest of [0, 1, 2]) {
    assert.deepEqual(
      clusterHits(hits, { gapMinutes: 30, maxClusters: 5, keepOldest }).map((c) => c.middleId),
      ['k6', 'k5', 'k4', 'k3', 'k2'],
      String(keepOldest),
    );
  }
  assert.deepEqual(clusterHits(hits.slice(0, 3), { gapMinutes: 30, maxClusters: 5, keepOldest: 2 }).map((c) => c.middleId), ['k4', 'k3', 'k2']);
});

/** A normalized message. */
function msg(id, ts, extra = {}) {
  return { id, channelId: 'c1', authorId: 'u1', authorName: 'Ana', self: false, bot: false, content: `line ${id}`, ts, attachments: [], links: [], stickers: [], emojis: [], forwarded: [], reactions: [], replyToId: null, ...extra };
}

test('mergeWindows: windows of one channel sharing a message become one', () => {
  const t = Date.UTC(2026, 9, 1, 15);
  const merged = mergeWindows([
    { channelId: 'c1', channelName: 'general', messages: [msg('m1', t), msg('m2', t + 1)], hitIds: ['m1'] },
    { channelId: 'c2', channelName: 'garden', messages: [msg('n1', t)], hitIds: ['n1'] },
    { channelId: 'c1', channelName: 'general', messages: [msg('m2', t + 1), msg('m3', t + 2)], hitIds: ['m3'] },
    { channelId: 'c1', channelName: 'general', messages: [], hitIds: [] },
  ]);
  assert.equal(merged.length, 2);
  assert.deepEqual(merged[0].messages.map((m) => m.id), ['m1', 'm2', 'm3']);
  assert.deepEqual([...merged[0].hitIds].sort(), ['m1', 'm3']);
});

test('fallbackWindow: the newest window with the most matched lines among the newest three', () => {
  const t = Date.UTC(2026, 9, 1, 15);
  const win = (name, ids, hitIds) => ({ channelId: name, channelName: name, messages: ids.map((id, i) => msg(id, t + i)), hitIds: new Set(hitIds) });
  const newest = win('a', ['a1', 'a2'], ['a1']);
  const second = win('b', ['b1', 'b2', 'b3'], ['b1', 'b3']);
  const third = win('c', ['c1', 'c2'], ['c1', 'c2']);
  const fourth = win('d', ['d1', 'd2', 'd3', 'd4'], ['d1', 'd2', 'd3', 'd4']);
  assert.equal(fallbackWindow([newest, second, third, fourth]), second, 'most matched lines, the newer on a tie; the fourth is out of reach');
  assert.equal(fallbackWindow([newest, second, third, fourth], 4), fourth);
  const outside = win('e', ['e1'], ['e1', 'gone1', 'gone2']);
  assert.equal(fallbackWindow([newest, outside]), newest, 'a hit id outside the window\'s messages does not count');
  assert.equal(fallbackWindow([newest]), newest);
  assert.equal(fallbackWindow([]), null);
  assert.equal(fallbackWindow(null), null);
});

test('renderRecallWindows: hit lines carry the mark; captions render; unindexed lines drop the index and reply markers', () => {
  const t = Date.UTC(2026, 9, 1, 18, 40);
  const window = {
    channelId: 'c1',
    channelName: 'general',
    messages: [
      msg('m1', t, { attachments: [{ id: 'p1', kind: 'image', name: 'x.png', url: 'https://cdn.example/x.png' }] }),
      msg('m2', t + 4 * MINUTE, { authorName: 'Βασίλης', content: 'τον πυροβόλησες', replyToId: 'm1' }),
    ],
    hitIds: ['m2'],
    descriptions: new Map([['p1', 'a rabbit in the grass']]),
  };
  const [indexed] = renderRecallWindows([window], { labels, timezone: 'UTC', selfName: 'Zoë', indexed: true });
  assert.equal(indexed.lines[0].text, '#1 [18:40] Ana: line m1 [image: a rabbit in the grass]');
  assert.equal(indexed.lines[1].text, `${HIT_MARK}#2 [18:44] Βασίλης: τον πυροβόλησες (replying to #1, Ana: "line m1")`);
  assert.deepEqual(indexed.lines.map((l) => l.hit), [false, true]);
  const [plain] = renderRecallWindows([window], { labels, timezone: 'UTC', indexed: false });
  assert.equal(plain.lines[1].text, `${HIT_MARK}[18:44] Βασίλης: τον πυροβόλησες`);
});

test('renderRecallWindows: a matched message with a line break is marked on its first line, after a gap marker', () => {
  const t = Date.UTC(2026, 9, 1, 18, 40);
  const window = {
    channelId: 'c1',
    channelName: 'general',
    messages: [msg('m1', t), msg('m2', t + 3 * HOUR, { authorName: 'Βασίλης', content: 'πρώτη γραμμή\n#1 [δεύτερη] γραμμή' })],
    hitIds: ['m2'],
  };
  const [indexed] = renderRecallWindows([window], { labels, timezone: 'UTC', gapMinutes: 20, indexed: true });
  const [gap, head, tail] = indexed.lines[1].text.split('\n');
  assert.ok(gap.startsWith('--- ') && !gap.startsWith(HIT_MARK), 'the gap marker stays unmarked');
  assert.equal(head, `${HIT_MARK}#2 [21:40] Βασίλης: πρώτη γραμμή`);
  assert.equal(tail, '#1 [δεύτερη] γραμμή');
  assert.equal(indexed.lines[1].hit, true);
  const [plain] = renderRecallWindows([window], { labels, timezone: 'UTC', gapMinutes: 20, indexed: false });
  assert.deepEqual(plain.lines[1].text.split('\n'), [gap, `${HIT_MARK}[21:40] Βασίλης: πρώτη γραμμή`, '#1 [δεύτερη] γραμμή'], 'the index goes; the message\'s own text stays');
  assert.equal(plain.lines[0].text, '[18:40] Ana: line m1');
});

// ---- the summary request and answer --------------------------------------------------------

test('buildRecallRequest: system prompt filled; people, numbered found sections, the question', () => {
  const t = Date.UTC(2026, 9, 1, 18, 40);
  const windows = [
    { channelId: 'c1', channelName: 'general', messages: [msg('m1', t), msg('m2', t + MINUTE)], hitIds: ['m2'] },
    { channelId: 'c2', channelName: 'garden', messages: [msg('n1', t - 30 * HOUR, { channelId: 'c2' })], hitIds: ['n1'] },
  ];
  const messages = buildRecallRequest({
    prompt: 'You are {{name}}. At most {{answerChars}} characters. Today {{today}}.',
    selfName: 'Zoë',
    question: { authorName: 'Nikos', content: 'ποιος σκότωσε το κουνέλι;' },
    people: [{ name: 'Kitezu', username: 'kitezu.', count: 23, newestTs: Date.UTC(2024, 8, 30, 12) }],
    windows,
    labels,
    timezone: 'UTC',
    answerChars: 900,
    now: NOW,
  });
  assert.equal(messages[0].content, 'You are Zoë. At most 900 characters. Today 2026-10-05.');
  assert.equal(
    messages[1].content,
    [
      '<people>',
      'Kitezu | kitezu. | 23 | 2024-09-30',
      '</people>',
      '<found>',
      '## 1 | 2026-10-01 | #general',
      '#1 [18:40] Ana: line m1',
      `${HIT_MARK}#2 [18:41] Ana: line m2`,
      '',
      '## 2 | 2026-09-30 | #garden',
      `${HIT_MARK}#3 [12:40] Ana: line n1`,
      '</found>',
      '<question>',
      'Nikos: ποιος σκότωσε το κουνέλι;',
      '</question>',
    ].join('\n'),
  );
});

test('buildRecallRequest: no prompt or no window line gives null; no people leaves the block out', () => {
  const base = { selfName: 'Zoë', question: { authorName: 'A', content: 'q' }, labels, answerChars: 100 };
  const windows = [{ channelId: 'c1', channelName: 'general', messages: [msg('m1', NOW)], hitIds: [] }];
  assert.equal(buildRecallRequest({ ...base, prompt: ' ', windows }), null);
  assert.equal(buildRecallRequest({ ...base, prompt: 'p', windows: [] }), null);
  const user = buildRecallRequest({ ...base, prompt: 'p', windows })[1].content;
  assert.ok(user.startsWith('<found>\n') && !user.includes('<people>'));
});

test('parseRecallAnswer: a stretch line names a section; out of range or none names nothing', () => {
  assert.deepEqual(parseRecallAnswer('stretch: 2\nAna did it on October 1.', { answerChars: 500, count: 3 }), { text: 'Ana did it on October 1.', stretch: 2 });
  assert.deepEqual(parseRecallAnswer('Stretch: #1\nΗ Άννα.', { answerChars: 500, count: 1 }), { text: 'Η Άννα.', stretch: 1 });
  assert.deepEqual(parseRecallAnswer('stretch: 4\nAna.', { answerChars: 500, count: 3 }), { text: 'Ana.', stretch: null });
  assert.deepEqual(parseRecallAnswer('stretch: none\nAna.', { answerChars: 500, count: 3 }), { text: 'Ana.', stretch: null });
  assert.deepEqual(parseRecallAnswer('Ana did it.\nstretch: 1', { answerChars: 500, count: 3 }), { text: 'Ana did it.\nstretch: 1', stretch: null }, 'only a first line names one');
});

test('parseRecallAnswer: nothing or an empty answer gives no text and no stretch; the text is clamped', () => {
  for (const raw of ['nothing', 'Nothing.', '"nothing"', 'stretch: 1\nnothing', '', '  ', 'stretch: 2', null]) {
    assert.deepEqual(parseRecallAnswer(raw, { answerChars: 500, count: 3 }), { text: null, stretch: null }, String(raw));
  }
  const long = 'Ana did it. '.repeat(40).trim();
  const { text } = parseRecallAnswer(long, { answerChars: 100, count: 0 });
  assert.ok(text.length <= 125 && text.endsWith('.'), text);
});

// ---- stored memory -------------------------------------------------------------------------

const ANA = '411111111111111111';
const KITE = '477777777777777777';
const ELO = '433333333333333333';

/** A stored episode. */
function ep(date, what, { quote = '', feeling = '', weight = 3, addedAt = `${date}T20:00:00.000Z` } = {}) {
  return { date, what, quote, feeling, weight, addedAt };
}

test('matchMemory: forms match word stems, folded; an inflected form matches its other endings; more forms rank first', () => {
  const profiles = [
    {
      id: ANA,
      names: ['Ana'],
      aliases: [],
      episodes: [
        ep('2026-10-01', 'shot the κουνέλι behind the shed', { weight: 5 }),
        ep('2026-10-02', 'held a funeral for the κουνέλι at the κουνελιού grave', { weight: 1 }),
        ep('2026-09-01', 'showed photos of κουνελάκια', { weight: 5 }),
        ep('2026-09-02', 'said nothing about animals', { quote: 'το ΚΟΥΝΈΛΙ μου', weight: 2 }),
      ],
    },
  ];
  const lore = [
    { id: 'l1', title: 'Le Lapin', keys: ['lapin'], text: 'The rabbit of the garden, buried in L’Été.', weight: 3, updatedAt: '2026-09-10T00:00:00.000Z' },
    { id: 'l2', title: 'Lapinouchette', keys: ['lapinouchette'], text: 'A plush toy.', weight: 3 },
    { id: 'l3', title: 'Lapins', keys: ['lapins'], text: 'The hutch.', weight: 1 },
  ];
  const items = matchMemory({ forms: ['κουνέλι', 'κουνελιού', 'ete'], profiles, lore, max: 10 });
  assert.deepEqual(
    items.map((i) => [i.kind, i.score, i.text]),
    [
      ['episode', 2, 'shot the κουνέλι behind the shed'],
      ['episode', 2, 'said nothing about animals "το ΚΟΥΝΈΛΙ μου"'],
      ['episode', 2, 'held a funeral for the κουνέλι at the κουνελιού grave'],
      ['episode', 1, 'showed photos of κουνελάκια'],
      ['lore', 1, 'Le Lapin: The rabbit of the garden, buried in L’Été.'],
    ],
    'κουνελιού reaches κουνέλι by its stem; κουνελάκια is in reach of κουνέλι only',
  );
  assert.deepEqual([items[0].date, items[0].memberId], ['2026-10-01', ANA]);
  assert.deepEqual([items[4].date, items[4].memberId], [null, null]);
  assert.deepEqual(
    matchMemory({ forms: ['lapin'], lore, max: 10 }).map((i) => i.text),
    ['Le Lapin: The rabbit of the garden, buried in L’Été.', 'Lapins: The hutch.'],
    'an ending matches, a word four letters longer does not',
  );
  assert.equal(matchMemory({ forms: ['κουνέλι'], profiles, max: 1 }).length, 1, 'capped at max');
  assert.deepEqual(matchMemory({ forms: ['κουνέλι'], profiles, max: 0 }), []);
  assert.deepEqual(matchMemory({ forms: [], who: [], profiles, lore, max: 10 }), [], 'nothing asked, nothing found');
});

test('matchMemory: a feeling is never searched; learned items and recent lines are', () => {
  const profiles = [{ id: ANA, names: ['Ana'], episodes: [ep('2026-10-01', 'a quiet evening', { feeling: 'the κουνέλι made her sad' })] }];
  const learned = [{ id: 1, text: 'a κουνέλι lives in the garden', from: `<@${ELO}>`, weight: 1, firstSeen: '2026-09-01T00:00:00.000Z', lastSeen: '2026-09-05T00:00:00.000Z' }];
  const recentLines = [{ id: 1, at: Date.UTC(2026, 9, 4, 22, 30), channelId: 'c1', text: `<@${ANA}> lost her κουνέλι`, who: [ANA], weight: 2 }];
  const items = matchMemory({ forms: ['κουνέλι'], profiles, learned, recentLines, max: 10, timezone: 'Europe/Berlin' });
  assert.deepEqual(
    items.map((i) => [i.kind, i.date, i.memberId, i.text]),
    [
      ['recent', '2026-10-05', null, `<@${ANA}> lost her κουνέλι`],
      ['learned', null, ELO, 'a κουνέλι lives in the garden'],
    ],
    'the newer first among equals; a recent line dated in the zone',
  );
});

test('matchMemory: name forms bring the member\'s moments and the lines that name them', () => {
  const profiles = [
    {
      id: KITE,
      names: ['Kitezu'],
      aliases: [{ name: 'Κιτέζου', weight: 1 }],
      episodes: [ep('2026-01-01', 'won the chess night', { weight: 2 }), ep('2025-06-01', 'moved to the coast', { weight: 4 })],
    },
    { id: ANA, names: ['Ana'], episodes: [ep('2026-05-01', `argued with <@${KITE}> about chess`, { weight: 1 }), ep('2026-05-02', 'baked bread', { weight: 5 })] },
  ];
  const items = matchMemory({ forms: [], who: ['κιτέζου'], profiles, max: 10 });
  assert.deepEqual(
    items.map((i) => [i.memberId, i.text, i.score]),
    [
      [KITE, 'moved to the coast', 1],
      [KITE, 'won the chess night', 1],
      [ANA, `argued with <@${KITE}> about chess`, 1],
    ],
  );
  const both = matchMemory({ forms: ['chess'], who: ['kitezu'], profiles, max: 10 });
  assert.deepEqual(both.map((i) => [i.text, i.score]).slice(0, 2), [
    ['won the chess night', 2],
    [`argued with <@${KITE}> about chess`, 2],
  ]);
});

test('matchMemory: a range keeps only dated items inside it', () => {
  const profiles = [{ id: ANA, names: ['Ana'], episodes: [ep('2025-12-31', 'κουνέλι fireworks'), ep('2026-01-01', 'κουνέλι brunch'), ep('2026-01-03', 'κουνέλι walk'), { what: 'κουνέλι undated', weight: 3 }] }];
  const lore = [{ title: 'κουνέλι', keys: ['κουνέλι'], text: 'timeless' }];
  const recentLines = [
    { id: 1, at: Date.UTC(2026, 0, 1, 10), channelId: 'c1', text: 'κουνέλι inside', weight: 2 },
    { id: 2, at: Date.UTC(2026, 0, 2, 10), channelId: 'c1', text: 'κουνέλι after', weight: 2 },
  ];
  const from = Date.UTC(2025, 11, 31, 23);
  const to = Date.UTC(2026, 0, 1, 23) - 1;
  const items = matchMemory({ forms: ['κουνέλι'], profiles, lore, recentLines, from, to, max: 10, timezone: 'Europe/Berlin' });
  assert.deepEqual(items.map((i) => i.text).sort(), ['κουνέλι brunch', 'κουνέλι inside']);
  const open = matchMemory({ forms: ['κουνέλι'], profiles, from: Date.UTC(2026, 0, 2), max: 10 });
  assert.deepEqual(open.map((i) => i.text), ['κουνέλι walk'], 'an open end');
});

test('buildRecallRequest: the memory block comes before found, one structural line per item, tokens resolved', () => {
  const t = Date.UTC(2026, 9, 1, 18, 40);
  const memory = [
    { kind: 'episode', text: `shot the κουνέλι with <@${KITE}>`, date: '2026-10-01', memberId: ANA, score: 2 },
    { kind: 'lore', text: 'Le Lapin: the garden rabbit', date: null, memberId: null, score: 1 },
    { kind: 'learned', text: 'a fact', date: null, memberId: '499999999999999999', score: 1 },
  ];
  const names = { [ANA]: 'Ana', [KITE]: 'Kitezu' };
  const base = { prompt: 'p', selfName: 'Zoë', question: { authorName: 'Nikos', content: 'q' }, labels, timezone: 'UTC', answerChars: 100, memory, nameOf: (id) => names[id] ?? null };
  const user = buildRecallRequest({ ...base, windows: [{ channelId: 'c1', channelName: 'general', messages: [msg('m1', t)], hitIds: ['m1'] }] })[1].content;
  assert.ok(
    user.startsWith(
      ['<memory>', 'episode | 2026-10-01 | Ana | shot the κουνέλι with Kitezu', 'lore | - | - | Le Lapin: the garden rabbit', 'learned | - | - | a fact', '</memory>', '<found>\n'].join('\n'),
    ),
    user,
  );
  const alone = buildRecallRequest({ ...base, windows: [] });
  assert.equal(alone[1].content, ['<memory>', 'episode | 2026-10-01 | Ana | shot the κουνέλι with Kitezu', 'lore | - | - | Le Lapin: the garden rabbit', 'learned | - | - | a fact', '</memory>', '<question>', 'Nikos: q', '</question>'].join('\n'));
  assert.equal(buildRecallRequest({ ...base, memory: [], windows: [] }), null, 'neither memory nor a window');
});

test('cutStretch: whole lines go from the far ends, matched lines stay', () => {
  const lines = ['aaaa', 'bbbb', 'cccc', 'HHHH', 'dddd'].map((text) => ({ text, hit: text === 'HHHH' }));
  assert.deepEqual(cutStretch(lines, 14).map((l) => l.text), ['cccc', 'HHHH', 'dddd']);
  assert.deepEqual(cutStretch(lines, 9).map((l) => l.text), ['HHHH', 'dddd']);
  assert.deepEqual(cutStretch(lines, 1).map((l) => l.text), ['HHHH'], 'a matched line is never dropped');
  assert.deepEqual(cutStretch(lines, 1000).map((l) => l.text), lines.map((l) => l.text));
});

// ---- the current conversation, the persona's own stretches, the summary's context --------------

test('dropChatHits: hits already shown in the chat go before clustering and are counted', () => {
  const t = Date.UTC(2026, 9, 10, 20);
  const hits = [found('old', t - 5 * HOUR, ['form:a']), found('c1', t, ['form:a']), found('c2', t + MINUTE, ['form:a'])];
  const { hits: kept, dropped } = dropChatHits(hits, new Set(['c1', 'c2', 'zz']));
  assert.equal(dropped, 2);
  assert.deepEqual(kept.map((h) => h.id), ['old']);
  assert.deepEqual(clusterHits(kept, { gapMinutes: 30 }).map((c) => c.ids), [['old']], 'the chat lines never form a cluster');
  assert.deepEqual(dropChatHits(hits, null), { hits, dropped: 0 }, 'no ids drops nothing');
  assert.equal(dropChatHits(hits, ['c1']).dropped, 1, 'an array of ids works too');
});

test('rankClusters: a window with the persona\'s line gets selfBonus on its topic; recency stays the last tiebreak', () => {
  const t = Date.UTC(2026, 9, 10, 8);
  const clusters = [
    { channelId: 'c1', middleId: 'a', endTs: t + 3 * HOUR, topic: 2, queries: 2, self: false },
    { channelId: 'c2', middleId: 'b', endTs: t + 2 * HOUR, topic: 1, queries: 1, self: true },
    { channelId: 'c1', middleId: 'c', endTs: t + HOUR, topic: 2, queries: 2, self: true },
    { channelId: 'c2', middleId: 'd', endTs: t, topic: 1, queries: 1, self: false },
  ];
  const ids = (list) => list.map((c) => c.middleId);
  assert.deepEqual(ids(rankClusters(clusters, { maxClusters: 2, keepOldest: 0, selfBonus: 1 })), ['a', 'c'], 'c scores 3, a beats b (both 2) on queries; kept newest first');
  assert.deepEqual(ids(rankClusters(clusters, { maxClusters: 1, keepOldest: 0, selfBonus: 1 })), ['c']);
  assert.deepEqual(ids(rankClusters(clusters, { maxClusters: 1, keepOldest: 0, selfBonus: 0 })), ['a'], 'no bonus: a and c tie, the newer wins');
  assert.deepEqual(ids(rankClusters(clusters, { maxClusters: 3, keepOldest: 0, selfBonus: 2 })), ['a', 'b', 'c'], 'b (3) passes a (2)');
  assert.equal(clusterScore(clusters[2], 1), 3);
  assert.equal(clusterScore(clusters[0], 1), 2);
});

test('rankClusters: without a persona line it keeps what clusterHits keeps', () => {
  const t = Date.UTC(2026, 9, 1, 8);
  const hits = [
    found('n1', t + 10 * HOUR, ['form:a']),
    found('n2', t + 12 * HOUR, ['form:a']),
    found('d1', t - 400 * HOUR, ['form:a', 'form:b']),
    found('d2', t - 400 * HOUR + 5 * MINUTE, ['form:c']),
    found('w1', t, ['form:a', 'author:u2'], 'c2'),
    found('o1', t - 900 * HOUR, ['form:a', 'form:b']),
  ];
  for (const [maxClusters, keepOldest] of [[2, 0], [3, 1], [1, 0]]) {
    const wide = clusterHits(hits, { gapMinutes: 30, maxClusters: 9, keepOldest: 0 });
    assert.deepEqual(
      rankClusters(wide, { maxClusters, keepOldest, selfBonus: 1 }).map((c) => c.middleId),
      clusterHits(hits, { gapMinutes: 30, maxClusters, keepOldest }).map((c) => c.middleId),
      `${maxClusters}/${keepOldest}`,
    );
  }
});

test('recallSettings: the trace cap, the self bonus, the extra windows and the context lines', () => {
  const s = recallSettings({});
  for (const key of ['traceMaxLines', 'selfBonus', 'selfExtra', 'contextMessages']) assert.equal(s[key], SHIPPED_CONFIG.recall[key], key);
  const zero = recallSettings({ recall: { traceMaxLines: 0, selfBonus: 0, selfExtra: 0, contextMessages: 0 } });
  assert.equal(zero.traceMaxLines, SHIPPED_CONFIG.recall.traceMaxLines, 'the trace keeps at least one line');
  assert.equal(zero.selfBonus, 0);
  assert.equal(zero.selfExtra, 0);
  assert.equal(zero.contextMessages, 0);
  const set = recallSettings({ recall: { traceMaxLines: 7.5, selfBonus: 1.5, selfExtra: 2.9, contextMessages: -1 } });
  assert.deepEqual([set.traceMaxLines, set.selfBonus, set.selfExtra, set.contextMessages], [7, 1.5, 2, SHIPPED_CONFIG.recall.contextMessages]);
});

test('recallContext: the last lines before the question, the question itself left out', () => {
  const t = Date.UTC(2026, 9, 10, 20);
  const history = Array.from({ length: 5 }, (_, i) => msg(`h${i}`, t + i * MINUTE));
  assert.deepEqual(recallContext(history, history[4], 3).map((m) => m.id), ['h1', 'h2', 'h3']);
  assert.deepEqual(recallContext(history, { id: 'elsewhere' }, 2).map((m) => m.id), ['h3', 'h4']);
  assert.deepEqual(recallContext(history, history[4], 0), []);
  assert.deepEqual(recallContext(null, history[4], 3), []);
});

/** The fixture labels with the two stretch flags (the shipped wording is the writer's). */
const flagged = { ...labels, lookup: { ...labels.lookup, stretchSelf: '[SELF]', stretchCurrent: '[CURRENT]' } };

test('buildRecallRequest: the context block sits right before the question, own lines marked with labels.self', () => {
  const t = Date.UTC(2026, 9, 10, 20, 0);
  const windows = [{ channelId: 'c2', channelName: 'garden', messages: [msg('w1', t - 5 * HOUR, { channelId: 'c2' })], hitIds: ['w1'] }];
  const context = [msg('h1', t, { authorName: 'Nikos', content: 'θυμάσαι τι είπες για το κουνέλι;' }), msg('h2', t + MINUTE, { self: true, authorId: 'self', content: 'ποιο κουνέλι;' })];
  const user = buildRecallRequest({
    prompt: 'p',
    selfName: 'Zoë',
    question: { authorName: 'Nikos', content: 'αυτό που είπες πριν' },
    windows,
    context,
    labels,
    timezone: 'UTC',
    answerChars: 100,
  })[1].content;
  const lines = user.split('\n');
  assert.deepEqual(lines.slice(0, 4), ['<found>', '## 1 | 2026-10-10 | #garden', `${HIT_MARK}#1 [15:00] Ana: line w1`, '</found>']);
  assert.equal(lines[4], '<context>');
  assert.match(lines[5], /^=== .+ ===$/, 'the transcript header, as the classifier transcripts have it');
  assert.deepEqual(lines.slice(6), [
    '#2 [20:00] Nikos: θυμάσαι τι είπες για το κουνέλι;',
    '#3 [20:01] Zoë (you): ποιο κουνέλι;',
    '</context>',
    '<question>',
    'Nikos: αυτό που είπες πριν',
    '</question>',
  ]);
  const none = buildRecallRequest({ prompt: 'p', selfName: 'Zoë', question: { authorName: 'A', content: 'q' }, windows, context: [], labels, answerChars: 100 })[1].content;
  assert.ok(!none.includes('<context>'), 'no line, no block');
});

test('buildRecallRequest: a stretch header carries the self flag, then the current-chat flag; a missing label omits its suffix', () => {
  const t = Date.UTC(2026, 9, 10, 15);
  const windows = [
    { channelId: 'c1', channelName: 'general', messages: [msg('a1', t), msg('a2', t + MINUTE, { self: true, authorId: 'self' })], hitIds: ['a1'], overlapsChat: true },
    { channelId: 'c2', channelName: 'garden', messages: [msg('b1', t - HOUR, { channelId: 'c2', self: true, authorId: 'self' })], hitIds: ['b1'] },
    { channelId: 'c3', channelName: 'news', messages: [msg('c1', t - 2 * HOUR, { channelId: 'c3' })], hitIds: ['c1'], overlapsChat: true },
    { channelId: 'c4', channelName: 'misc', messages: [msg('d1', t - 3 * HOUR, { channelId: 'c4' })], hitIds: ['d1'] },
  ];
  const base = { prompt: 'p', selfName: 'Zoë', question: { authorName: 'A', content: 'q' }, windows, timezone: 'UTC', answerChars: 100 };
  const headers = (l) => buildRecallRequest({ ...base, labels: l })[1].content.split('\n').filter((line) => line.startsWith('## '));
  assert.deepEqual(headers(flagged), [
    '## 1 | 2026-10-10 | #general [SELF] [CURRENT]',
    '## 2 | 2026-10-10 | #garden [SELF]',
    '## 3 | 2026-10-10 | #news [CURRENT]',
    '## 4 | 2026-10-10 | #misc',
  ]);
  const onlyCurrent = { ...labels, lookup: { ...labels.lookup, stretchSelf: undefined, stretchCurrent: '[CURRENT]' } };
  assert.deepEqual(headers(onlyCurrent).slice(0, 2), ['## 1 | 2026-10-10 | #general [CURRENT]', '## 2 | 2026-10-10 | #garden']);
  const bare = { ...labels, lookup: { ...labels.lookup, stretchSelf: undefined, stretchCurrent: undefined } };
  assert.equal(headers(bare)[0], '## 1 | 2026-10-10 | #general');
  const spaced = { ...labels, lookup: { ...labels.lookup, stretchSelf: ' [SELF]', stretchCurrent: '   ' } };
  assert.equal(headers(spaced)[0], '## 1 | 2026-10-10 | #general [SELF]', 'one space, whatever the label carries; a blank label adds nothing');
});

test('mergeWindows: a merged window overlaps the chat when any of its parts does', () => {
  const t = Date.UTC(2026, 9, 1, 15);
  const merged = mergeWindows([
    { channelId: 'c1', channelName: 'general', messages: [msg('m1', t), msg('m2', t + 1)], hitIds: ['m1'] },
    { channelId: 'c1', channelName: 'general', messages: [msg('m2', t + 1), msg('m3', t + 2)], hitIds: ['m3'], overlapsChat: true },
    { channelId: 'c2', channelName: 'garden', messages: [msg('n1', t)], hitIds: ['n1'] },
  ]);
  assert.deepEqual(merged.map((w) => w.overlapsChat), [true, false]);
});

// ---- the archive and the recent record as sources -------------------------------------------

/** An archive entry as src/memory/archive.js#archiveEntry writes it (the fields recall reads). */
function archived(itemKind, itemId, text, { observedAt = { date: '2026-08-01', precision: 'day' }, scope = { user: ANA }, recordedAt = '2026-10-01T00:00:00.000Z', neutral = null, weight } = {}) {
  return { v: 1, id: `a-${itemId}-${recordedAt}`, kind: 'archive', event: 'evicted', itemKind, itemId, revisionId: `rv-${recordedAt}`, scope, participants: scope.user ? [scope.user] : [], observedAt, neutral, text, ...(weight === undefined ? {} : { weight }), stored: {}, recordedAt, guildId: 'g1' };
}

test('recall: archive hits render as archived <kind> with the date and dedupe against hot by itemId', async () => {
  const profiles = [{ id: ANA, names: ['Ana'], aliases: [], episodes: [{ ...ep('2026-10-02', 'fed the κουνέλι'), itemId: 'ep-hot' }] }];
  const entries = [
    archived('episode', 'ep-hot', { what: 'fed the κουνέλι an old carrot' }, { observedAt: { date: '2026-10-02', precision: 'day' } }),
    archived('episode', 'ep-old', { what: 'buried the κουνέλι', quote: '', feeling: '' }, { recordedAt: '2026-09-01T00:00:00.000Z' }),
    archived('episode', 'ep-old', { what: 'buried the κουνέλι under the oak', quote: 'αντίο', feeling: '' }, { recordedAt: '2026-09-20T00:00:00.000Z' }),
    archived('episode', 'ep-felt', { what: 'a quiet evening', feeling: 'the κουνέλι made her sad' }),
    archived('interest', 'in-1', { topic: 'pets', note: 'keeps one' }, { neutral: 'Ana keeps a κουνέλι', observedAt: { date: '2026-07-01T22:30:00.000Z', precision: 'time' } }),
  ];
  const scanned = await scanArchive((async function* () { yield* entries; })(), { forms: ['κουνέλι'], profiles, max: 6, timezone: BERLIN });
  assert.ok(!scanned.some((e) => e.itemId === 'ep-felt'), 'a feeling is never searched');
  const items = matchMemory({ forms: ['κουνέλι'], profiles, archived: scanned, max: 10, timezone: BERLIN });
  assert.deepEqual(
    items.map((i) => [i.kind, i.itemId, i.date, i.memberId, i.text]),
    [
      ['episode', 'ep-hot', '2026-10-02', ANA, 'fed the κουνέλι'],
      ['archived episode', 'ep-old', '2026-08-01', ANA, 'buried the κουνέλι under the oak "αντίο"'],
      ['archived interest', 'in-1', '2026-07-02', ANA, 'pets: keeps one'],
    ],
    'the hot copy wins its itemId, the newest revision of an archived item stands for it, a time is dated in the zone',
  );
  const user = buildRecallRequest({ prompt: 'p', selfName: 'Zoë', question: { authorName: 'Nikos', content: 'q' }, windows: [], memory: items, nameOf: (id) => (id === ANA ? 'Ana' : null), labels, timezone: BERLIN, answerChars: 100 })[1].content;
  assert.ok(user.includes('archived episode | 2026-08-01 | Ana | buried the κουνέλι under the oak "αντίο"'), user);
  const ranged = matchMemory({ forms: ['κουνέλι'], profiles, archived: scanned, from: Date.UTC(2026, 6, 25), to: Date.UTC(2026, 7, 5), max: 10, timezone: BERLIN });
  assert.deepEqual(ranged.map((i) => i.itemId), ['ep-old'], 'a when: range matches observedAt');
});

test('recall: a vague recently ranks recency first and her own exchanges first', () => {
  assert.equal(parseLookupAnswer('server: κουνέλι\nrecent: yes', { now: NOW }).server.recent, true);
  assert.equal('recent' in parseLookupAnswer('server: κουνέλι\nrecent: no', { now: NOW }).server, false);
  assert.deepEqual(parseLookupAnswer('recent: yes', { now: NOW }), { web: null, server: null, reason: 'none' }, 'recent alone asks nothing');
  const DAY = 24 * HOUR;
  assert.equal(isRecentCue({ forms: ['κουνέλι'], who: [], from: null, to: null, recent: true }, { now: NOW, recordDays: 3 }), true);
  assert.equal(isRecentCue({ forms: ['κουνέλι'], who: [], from: null, to: null }, { now: NOW, recordDays: 3 }), false);
  assert.equal(isRecentCue({ forms: [], who: [], from: NOW - 2 * DAY, to: NOW }, { now: NOW, recordDays: 3 }), true, 'a range over the last days');
  assert.equal(isRecentCue({ forms: [], who: [], from: NOW - 30 * DAY, to: NOW - 20 * DAY, recent: true }, { now: NOW, recordDays: 3 }), false, 'a dated range wins over the flag');

  const profiles = [{ id: ANA, names: ['Ana'], episodes: [{ ...ep('2026-10-04', 'κουνέλι and καρότο'), itemId: 'ep-a' }] }];
  const recentLines = [{ id: 1, itemId: 'rc-1', at: Date.UTC(2026, 9, 5, 9), channelId: 'c1', text: 'a κουνέλι ran past', weight: 2 }];
  const entries = [
    archived('episode', 'ep-b', { what: 'the κουνέλι escaped' }, { observedAt: { date: '2026-10-03', precision: 'day' } }),
    archived(
      'participation',
      'pt-1',
      {
        messages: [
          { id: 'p1', ts: Date.UTC(2026, 9, 2, 10), authorId: ANA, name: 'Ana', self: false, text: 'look, a κουνέλι' },
          { id: 'p2', ts: Date.UTC(2026, 9, 2, 10, 1), authorId: '', name: 'Zoë', self: true, text: 'so fluffy' },
        ],
      },
      { observedAt: { date: '2026-10-02T10:00:00.000Z', precision: 'time' }, scope: { channel: 'c2' } },
    ),
  ];
  const ask = (recent) => matchMemory({ forms: ['κουνέλι', 'καρότο'], profiles, recentLines, archived: entries, max: 10, timezone: 'UTC', recent }).map((i) => i.itemId);
  assert.deepEqual(ask(false), ['ep-a', 'rc-1', 'ep-b', 'pt-1'], 'by score, then weight, then the newer');
  assert.deepEqual(ask(true), ['pt-1', 'rc-1', 'ep-a', 'ep-b'], 'her own exchange first, then the newest');
  const own = matchMemory({ forms: ['κουνέλι'], archived: entries, max: 10, timezone: 'UTC', recent: true });
  assert.equal(own[0].self, true);
  assert.equal(own[0].text, 'Ana: look, a κουνέλι / Zoë: so fluffy');
});

test('recall: the memory block stops at memoryTokens', () => {
  const memory = [
    { kind: 'episode', text: 'one κουνέλι line', date: '2026-10-01', memberId: null, score: 1 },
    { kind: 'lore', text: 'two: a longer lore text about the garden', date: null, memberId: null, score: 1 },
    { kind: 'learned', text: 'three', date: null, memberId: null, score: 1 },
  ];
  const lines = ['episode | 2026-10-01 | - | one κουνέλι line', 'lore | - | - | two: a longer lore text about the garden', 'learned | - | - | three'];
  const base = { prompt: 'p', selfName: 'Zoë', question: { authorName: 'Nikos', content: 'q' }, windows: [], memory, labels, timezone: 'UTC', answerChars: 100 };
  const memoryBlock = (cap) => {
    const out = buildRecallRequest({ ...base, memoryTokens: cap });
    return out ? out[1].content.split('\n<question>')[0] : null;
  };
  const [a, b] = lines.map((l) => estimateTokens(l));
  assert.equal(memoryBlock(a + b), ['<memory>', lines[0], lines[1], '</memory>'].join('\n'));
  assert.equal(memoryBlock(a + b - 1), ['<memory>', lines[0], '</memory>'].join('\n'), 'the block stops at the first line that does not fit');
  assert.equal(memoryBlock(a - 1), null, 'no line fits and no window: nothing to ask');
  assert.equal(memoryBlock(undefined), ['<memory>', ...lines, '</memory>'].join('\n'), 'no cap given');
  assert.equal(recallSettings({}).memoryTokens, SHIPPED_CONFIG.recall.memoryTokens);
  assert.equal(recallSettings({ recall: { recordDays: 0 } }).recordDays, 0, 'the record reader off');
  assert.equal(recallSettings({ recall: { archiveMonths: 0 } }).archiveMonths, 0, 'the archive not searched');
});

/** A record line of `channelId` (src/memory/record.js#toRecordLine), `kind` seen unless said. */
function rec(id, ts, { channelId = 'c2', by = ANA, text = `line ${id}`, replyTo = null, kind = 'seen', revision = 1 } = {}) {
  return toRecordLine({ id, channelId, authorId: by, content: text, ts, replyToId: replyTo }, { kind, revision, now: () => NOW, uuid: () => `x-${id}-${revision}` });
}

/** A fake record over `lines`: iterate keeps the query's [from, to] on occurredAt and notes each query. */
function fakeRecord(lines) {
  const queries = [];
  return {
    queries,
    async *iterate(guildId, query = {}) {
      queries.push({ guildId, ...query });
      const from = query.from ? Date.parse(query.from) : -Infinity;
      const to = query.to ? Date.parse(query.to) : Infinity;
      for (const line of lines) {
        const at = Date.parse(line.occurredAt);
        if (at >= from && at <= to) yield line;
      }
    },
  };
}

test('recall: the record reader returns the matching lines with reply chain and recordContext neighbours from the last recordDays', async () => {
  const T = NOW - 20 * HOUR;
  const lines = [
    rec('old', NOW - 2.5 * 24 * HOUR - 5 * HOUR, { text: 'το κουνέλι long ago' }),
    rec('q1', T - 5 * HOUR, { by: ELO, text: 'who has a pet' }),
    rec('q2', T - 4 * HOUR, { text: 'I do', replyTo: 'q1' }),
    rec('f1', T - 4 * MINUTE),
    rec('f2', T - 3 * MINUTE),
    rec('f3', T - 2 * MINUTE),
    rec('f4', T - MINUTE),
    rec('h1', T, { by: KITE, text: 'το κουνέλι μου', replyTo: 'q2' }),
    rec('other', T + 30_000, { channelId: 'c1', text: 'unrelated' }),
    rec('n1', T + MINUTE, { kind: 'said', text: 'ωραίο' }),
    rec('n2', T + 2 * MINUTE, { text: 'x' }),
    rec('n2', T + 2 * MINUTE, { text: 'x edited', revision: 2 }),
    rec('n3', T + 3 * MINUTE, { text: 'gone' }),
    { ...rec('n3', T + 3 * MINUTE), kind: 'deleted' },
    rec('n4', T + 4 * MINUTE),
    rec('n5', T + 5 * MINUTE),
    rec('k1', T + 2 * HOUR, { channelId: 'c3', text: 'ask Κιτέζου' }),
  ];
  const record = fakeRecord(lines);
  const names = { [ANA]: 'Ana', [ELO]: 'Éloïse', [KITE]: 'Kitezu' };
  const options = { record, range: { from: null, to: null }, participants: [], forms: ['κουνέλι'], aliases: [], recordDays: 2, recordContext: 3, followMessages: 0, now: NOW, maxWindows: 5, nameOf: (id) => names[id] ?? null, selfName: 'Zoë' };
  const { windows } = await matchRecord('g1', options);
  assert.equal(windows.length, 1, 'the line older than recordDays is not read');
  const [window] = windows;
  assert.equal(window.source, 'record');
  assert.equal(window.channelId, 'c2');
  assert.deepEqual(window.messages.map((m) => m.id), ['q1', 'q2', 'f2', 'f3', 'f4', 'h1', 'n1', 'n2', 'n4'], 'the reply chain, three before, three after (a deleted line is gone)');
  assert.deepEqual([...window.hitIds], ['h1']);
  const byId = Object.fromEntries(window.messages.map((m) => [m.id, m]));
  assert.deepEqual([byId.n1.self, byId.n1.authorName, byId.h1.authorName, byId.n2.content, byId.h1.replyToId], [true, 'Zoë', 'Kitezu', 'x edited', 'q2']);
  assert.equal(record.queries[0].from, new Date(NOW - 2 * 24 * HOUR).toISOString(), 'never further back than recordDays');

  const aliased = await matchRecord('g1', { ...options, forms: [], aliases: ['κιτέζου'] });
  assert.deepEqual(aliased.windows.map((w) => [...w.hitIds]), [['k1']], 'an alias matches as a whole word');
  const inflected = await matchRecord('g1', { ...options, forms: ['κουνελιού'] });
  assert.deepEqual(inflected.windows.map((w) => [...w.hitIds]), [['h1']], 'another ending of the form matches by its stem');
  const person = await matchRecord('g1', { ...options, forms: [], participants: [ELO] });
  assert.deepEqual(person.windows.flatMap((w) => [...w.hitIds]), ['q1'], 'a participant matches the lines naming them');
  const off = await matchRecord('g1', { ...options, recordDays: 0 });
  assert.equal(off.windows.length, 0);
});

test('recall: a dateless, not-recent record read keeps the window of the earliest best match within maxWindows', async () => {
  const D = 24 * HOUR;
  const lines = [
    rec('origin', NOW - 21 * D, { channelId: 'c1', text: 'το κουνέλι started here' }),
    rec('noise', NOW - 25 * D, { channelId: 'c1', text: 'nothing' }),
    ...Array.from({ length: 10 }, (_, i) => rec(`rep${i}`, NOW - (10 - i) * D, { text: `κουνέλι again ${i}` })),
  ];
  const base = { record: fakeRecord(lines), range: { from: null, to: null }, participants: [], forms: ['κουνέλι'], aliases: [], recordDays: 30, recordContext: 0, now: NOW, maxWindows: 3 };
  const { windows } = await matchRecord('g1', base);
  assert.equal(windows.length, 3, 'capped at maxWindows');
  assert.deepEqual(windows.map((w) => [...w.hitIds]), [['rep9'], ['rep8'], ['origin']], 'the newest repeats and the earliest match, newest first');

  const recent = await matchRecord('g1', { ...base, record: fakeRecord(lines), recent: true });
  assert.deepEqual(recent.windows.map((w) => [...w.hitIds]), [['rep9'], ['rep8'], ['rep7']], 'a recent question keeps the newest only');
  const ranged = await matchRecord('g1', { ...base, record: fakeRecord(lines), range: { from: NOW - 30 * D, to: NOW } });
  assert.deepEqual(ranged.windows.map((w) => [...w.hitIds]), [['rep9'], ['rep8'], ['rep7']], 'a dated question keeps its own order');
  const near = await matchRecord('g1', { ...base, record: fakeRecord(lines), maxWindows: 20 });
  assert.equal(near.windows.length, 11, 'the earliest already kept: nothing changes');
});

test('recall: a record line outside the range is not scanned', async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'nep-recall-record-'));
  const quiet = { info() {}, warn() {} };
  try {
    const appendStore = createAppendStore({ fsyncMs: 0, log: quiet });
    const opened = [];
    const watched = {
      ...appendStore,
      iterate: (file, opts) => {
        opened.push(path.basename(file));
        return appendStore.iterate(file, opts);
      },
    };
    const record = createRecord({ appendStore: watched, dataDir, log: quiet, now: () => NOW });
    await record.append('g1', [rec('new', NOW - 24 * HOUR, { text: 'το κουνέλι today' }), rec('old', NOW - 5 * 24 * HOUR, { text: 'το κουνέλι back then' })]);
    await appendStore.close();
    const base = { record, participants: [], forms: ['κουνέλι'], aliases: [], recordDays: 3, recordContext: 3, now: NOW, maxWindows: 5 };
    opened.length = 0;
    const recent = await matchRecord('g1', { ...base, range: { from: null, to: null } });
    assert.deepEqual(recent.windows.flatMap((w) => [...w.hitIds]), ['new']);
    assert.ok(!opened.includes('2026-09-30.jsonl'), `the old day file is never opened: ${opened}`);
    opened.length = 0;
    const back = await matchRecord('g1', { ...base, range: { from: NOW - 6 * 24 * HOUR, to: NOW - 4 * 24 * HOUR } });
    assert.deepEqual(back.windows.flatMap((w) => [...w.hitIds]), ['old'], 'an older range reads its own days');
    assert.ok(!opened.includes('2026-10-04.jsonl'), `${opened}`);
  } finally {
    fs.rmSync(dataDir, { recursive: true, force: true });
  }
});

test('recallSettings: followMessages and followGapMinutes read like the rest, followMessages 0 is off', () => {
  const s = recallSettings({ recall: { followMessages: 7.8, followGapMinutes: 2.5 } });
  assert.deepEqual([s.followMessages, s.followGapMinutes], [7, 2.5]);
  assert.equal(recallSettings({ recall: { followMessages: 0 } }).followMessages, 0, 'the follow off');
  assert.equal(recallSettings({ recall: { followMessages: 500 } }).followMessages, 100, 'one Discord page at most');
  assert.equal(recallSettings({ recall: { followMessages: -1 } }).followMessages, RECALL_DEFAULTS.followMessages);
  assert.equal(recallSettings({ recall: { followGapMinutes: 'x' } }).followGapMinutes, RECALL_DEFAULTS.followGapMinutes);
});

test('followConversation: takes the following lines until a silence longer than the gap or the cap', () => {
  const T = NOW - HOUR;
  const after = [5, 1, 3, 9, 30].map((m) => ({ id: `a${m}`, ts: T + m * MINUTE }));
  const ids = (list) => list.map((m) => m.id);
  assert.deepEqual(ids(followConversation(T, after, { followMessages: 24, followGapMinutes: 5 })), ['a1', 'a3', 'a5', 'a9'], 'oldest first; 9 -> 30 is a silence');
  assert.deepEqual(ids(followConversation(T, after, { followMessages: 2, followGapMinutes: 5 })), ['a1', 'a3'], 'the cap');
  assert.deepEqual(ids(followConversation(T, after, { followMessages: 24, followGapMinutes: 1 })), ['a1'], 'a shorter gap stops sooner');
  assert.deepEqual(followConversation(T - 10 * MINUTE, after, { followMessages: 24, followGapMinutes: 5 }), [], 'a silence right after the last line');
  assert.deepEqual(followConversation(T, after, { followMessages: 0, followGapMinutes: 5 }), [], 'followMessages 0: off');
});

test('recall: a record window follows its conversation past recordContext until the gap, in its own channel only', async () => {
  const T = NOW - 20 * HOUR;
  const lines = [
    rec('b1', T - MINUTE),
    rec('h1', T, { text: 'είναι το όνομά μου Ίρις;' }),
    rec('n1', T + MINUTE),
    rec('x1', T + 2 * MINUTE, { channelId: 'c3', text: 'elsewhere' }),
    rec('n2', T + 4 * MINUTE),
    rec('n3', T + 8 * MINUTE),
    rec('n4', T + 12 * MINUTE, { text: 'κέρδισες, Ηλέκτρα' }),
    rec('late', T + 40 * MINUTE),
  ];
  const base = { range: { from: null, to: null }, participants: [], forms: ['όνομά'], aliases: [], recordDays: 2, recordContext: 1, now: NOW, maxWindows: 5 };
  const followed = await matchRecord('g1', { ...base, record: fakeRecord(lines), followMessages: 24, followGapMinutes: 5 });
  assert.deepEqual(followed.windows.map((w) => w.messages.map((m) => m.id)), [['b1', 'h1', 'n1', 'n2', 'n3', 'n4']], 'up to the 28-minute silence; the other channel stays out');
  const capped = await matchRecord('g1', { ...base, record: fakeRecord(lines), followMessages: 2, followGapMinutes: 5 });
  assert.deepEqual(capped.windows[0].messages.map((m) => m.id), ['b1', 'h1', 'n1', 'n2', 'n3'], 'two lines past the recordContext neighbour');
  const gap = await matchRecord('g1', { ...base, record: fakeRecord(lines), followMessages: 24, followGapMinutes: 3 });
  assert.deepEqual(gap.windows[0].messages.map((m) => m.id), ['b1', 'h1', 'n1', 'n2'], 'n2 -> n3 is four minutes: stops');
  const off = await matchRecord('g1', { ...base, record: fakeRecord(lines), followMessages: 0, followGapMinutes: 5 });
  assert.deepEqual(off.windows[0].messages.map((m) => m.id), ['b1', 'h1', 'n1']);
  const chat = await matchRecord('g1', { ...base, record: fakeRecord(lines), followMessages: 24, followGapMinutes: 5, exclude: new Set(['n3']) });
  assert.deepEqual(chat.windows[0].messages.map((m) => m.id), ['b1', 'h1', 'n1', 'n2', 'n4'], 'a chat line is left out');
  assert.equal(chat.windows[0].overlapsChat, true);
  const hidden = await matchRecord('g1', { ...base, record: fakeRecord(lines), followMessages: 24, followGapMinutes: 5, allowLine: (line) => line.messageId !== 'n2' });
  assert.deepEqual(hidden.windows[0].messages.map((m) => m.id), ['b1', 'h1', 'n1'], 'a refused line is never read: n1 -> n3 is seven minutes');
});

test('recall: record windows that meet after following still merge into one', async () => {
  const T = NOW - 20 * HOUR;
  const lines = [
    rec('h1', T, { text: 'όνομά one' }),
    ...[1, 2, 3, 4, 5, 6].map((m) => rec(`n${m}`, T + m * MINUTE)),
    rec('h2', T + 7 * MINUTE, { text: 'όνομά two' }),
  ];
  const { windows } = await matchRecord('g1', { record: fakeRecord(lines), range: { from: null, to: null }, participants: [], forms: ['όνομά'], aliases: [], recordDays: 2, recordContext: 1, followMessages: 24, followGapMinutes: 5, now: NOW, maxWindows: 5 });
  assert.equal(windows.length, 1);
  assert.deepEqual(windows[0].messages.map((m) => m.id), ['h1', 'n1', 'n2', 'n3', 'n4', 'n5', 'n6', 'h2']);
  assert.deepEqual([...windows[0].hitIds].sort(), ['h1', 'h2']);
});
