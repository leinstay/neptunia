// Tests for src/memory/record-index.js: the in-memory word index of the record the automatic memory
// prefetch searches -- its words, the word endings it learns from the record, the documents it
// keeps, the distinctive terms and phrases of a query, the search, the support of a meaning hit and
// the cache with its background refresh. No I/O: the record is a fake.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  REFRESH_OVERLAP_MS,
  addRecordLines,
  buildRecordIndex,
  indexQuery,
  indexWords,
  learnEndings,
  nameAlternates,
  querySupport,
  recordIndexOf,
  searchRecordIndex,
  stemmerOf,
} from '../src/memory/record-index.js';

const T0 = Date.UTC(2026, 9, 1, 12, 0, 0);
const MIN = 60 * 1000;

/** A record line: a `seen` message (or `kind`) at T0 + `at` minutes. */
function line(messageId, at, text, { kind = 'seen', revision = 1, channel = 'c1', by = 'u1' } = {}) {
  return { v: 1, kind, messageId, revision, occurredAt: new Date(T0 + at * MIN).toISOString(), scope: { channel }, by, text };
}

/** Filler lines: common words only, so the words of the scene's stories are rare among them. */
function filler(count) {
  const texts = ['the cat and the hat', 'and then the rain came in', 'the end of the day', 'in the evening and the night', 'the plan in the end'];
  return Array.from({ length: count }, (_, i) => line(`f${i}`, 100 + i, texts[i % texts.length]));
}

const STORY = [
  line('d1', 1, 'we walked the dog in the forest'),
  line('d2', 2, 'the dog barked at the mailman'),
  line('d3', 3, 'plus ultra is the motto'),
  line('d4', 4, 'plus ultra again and again'),
  line('d5', 5, 'plus one for the cat'),
  line('d6', 6, 'a forest of signs'),
];

test('indexWords: folded words, URLs and long digit runs left out', () => {
  assert.deepEqual(indexWords('Élodie SAW https://example.com/a/b?c=1 the Δάσος <@123456789012345678> r34'), ['elodie', 'saw', 'the', 'δασος', 'r34']);
  assert.deepEqual(indexWords(''), []);
  assert.deepEqual(indexWords(`x${'y'.repeat(45)} ok`), ['ok'], 'a pasted token is no word');
});

test('learnEndings and stemmerOf: endings many stems share are learned from the vocabulary; inflected forms share a key', () => {
  const stems = ['walk', 'talk', 'jump', 'paint', 'climb', 'play'];
  const words = stems.flatMap((stem) => [stem, `${stem}s`, `${stem}ed`, `${stem}ing`]);
  const learned = learnEndings([...words, 'zebra', 'r2d2']);
  assert.deepEqual([...learned.endings].sort(), ['ed', 'ing', 's']);
  const stem = stemmerOf(learned);
  assert.deepEqual(['walking', 'walks', 'walked', 'walk'].map(stem), ['walk', 'walk', 'walk', 'walk']);
  assert.equal(stem('zebras'), 'zebras', 'no productive stem: the word is its own key');
  assert.equal(stem('r2d2s'), 'r2d2s', 'a word with a digit is its own key');
  assert.equal(stem('jumping'), 'jump');
});

test('buildRecordIndex and addRecordLines: the newest revision of a message stands, a deleted one goes, felt lines are no chat', () => {
  const index = buildRecordIndex([
    line('m1', 1, 'old words here'),
    line('m1', 2, 'fresh words here', { revision: 2 }),
    line('m2', 3, 'gone soon'),
    line('m2', 4, '', { kind: 'deleted' }),
    line('m3', 5, 'a feeling', { kind: 'felt' }),
  ]);
  assert.equal(index.alive, 1);
  const live = index.docs.filter((doc) => !doc.dead);
  assert.deepEqual(live.map((doc) => doc.messageId), ['m1']);
  assert.equal(index.terms.has('old'), false, 'the older revision is not indexed');
  addRecordLines(index, [line('m1', 2, 'newest words', { revision: 3 }), line('m4', 6, 'brand new'), line('m4', 6, 'brand new'), line('m1', 2, 'stale', { revision: 2 })]);
  assert.equal(index.alive, 2, 'a newer revision replaces its message, a repeat or an older one changes nothing');
  assert.deepEqual(index.docs.filter((doc) => !doc.dead).map((doc) => doc.messageId).sort(), ['m1', 'm4']);
  addRecordLines(index, [line('m4', 7, '', { kind: 'deleted' }), line('m4', 6, 'brand new', { revision: 5 })]);
  assert.equal(index.alive, 1, 'a deleted message stays gone');
});

test('indexQuery: the rare words of the text as terms, rarest first; common ones, her names and unknown words left out', () => {
  const index = buildRecordIndex([...STORY, ...filler(20)]);
  const query = indexQuery(index, 'Remember Nep, the dog in the forest?', { maxTermShare: 0.1, rareTermDf: 0, skipWords: ['Nep'] });
  assert.deepEqual(query.terms.map((term) => term.word).sort(), ['dog', 'forest']);
  assert.ok(query.terms.every((term) => term.df >= 1 && term.weight > 0));
  assert.ok(!query.terms.some((term) => term.word === 'the' || term.word === 'in'), 'common words are no terms');
  const capped = indexQuery(index, 'the dog in the forest', { maxTermShare: 0.1, rareTermDf: 0, maxTerms: 1 });
  const small = indexQuery(index, 'the dog in the forest', { maxTermShare: 0, rareTermDf: 3 });
  assert.deepEqual(small.terms.map((term) => term.word).sort(), ['dog', 'forest'], 'a rare word is a term however small the record');
  assert.equal(capped.terms.length, 1);
  const until = indexQuery(index, 'dog barked', { maxTermShare: 0.1, rareTermDf: 0, until: T0 + 1.5 * MIN });
  assert.deepEqual(until.terms.map((term) => term.word), ['dog'], 'only what existed then counts: barked came later');
  const excluded = indexQuery(index, 'dog barked', { maxTermShare: 0.1, rareTermDf: 0, exclude: new Set(['d2']) });
  assert.deepEqual(excluded.terms.map((term) => term.word), ['dog'], 'the turn\'s own chat does not count');
});

test('indexQuery: a set phrase of the record is a phrase; words that merely meet are not; a quoted phrase counts when it occurs', () => {
  const index = buildRecordIndex([...STORY, ...filler(20)]);
  const query = indexQuery(index, 'you know, plus ultra!', { maxTermShare: 0.1 });
  assert.deepEqual(query.phrases.map((phrase) => phrase.text), ['plus ultra']);
  assert.equal(query.phrases[0].df, 2);
  assert.deepEqual(indexQuery(index, 'ultra is great', { maxTermShare: 0.1 }).phrases, [], 'a short word makes no phrase');
  const busy = buildRecordIndex([
    ...['house', 'tree', 'deal', 'day', 'mess'].map((word, i) => line(`b${i}`, 10 + i, `big ${word}`)),
    ...['apple', 'car', 'hat', 'door', 'sky'].map((word, i) => line(`r${i}`, 20 + i, `red ${word}`)),
    line('br', 30, 'a big red ball'),
    ...filler(20),
  ]);
  assert.deepEqual(indexQuery(busy, 'the big red one', { maxTermShare: 0.5 }).phrases, [], 'two common words that met once are no set phrase');
  const quoted = indexQuery(index, 'he said "again and again"', { maxTermShare: 0.1, quoted: ['again and again'] });
  assert.equal(quoted.phrases[0].text, 'again and again');
  assert.equal(quoted.phrases[0].quoted, true);
});

test('nameAlternates and indexQuery: a member\'s other names and aliases count as the same term', () => {
  const alternates = nameAlternates([{ id: 'u7', names: ['Rosalind'], aliases: [{ name: 'Roz' }, { name: 'Rosie' }] }, { id: 'self', names: ['Nep', 'Neppy'], aliases: [] }], 'self');
  assert.deepEqual(alternates.get('rosalind'), ['roz', 'rosie']);
  assert.equal(alternates.has('nep'), false, 'the persona\'s own profile is left out');
  const index = buildRecordIndex([line('r1', 1, 'rosie baked a cake'), line('r2', 2, 'rosalind came over'), ...filler(20)]);
  const query = indexQuery(index, 'what did Rosalind bake', { alternates, maxTermShare: 0.1, rareTermDf: 0 });
  const term = query.terms.find((t) => t.word === 'rosalind');
  assert.equal(term.df, 2, 'either name finds her');
});

test('searchRecordIndex: a phrase, two terms or one rare term; scope, moment and own chat applied; best first', () => {
  const index = buildRecordIndex([...STORY, line('d7', 7, 'the dog is fine', { channel: 'hidden' }), ...filler(20)]);
  const query = indexQuery(index, 'any dog or forest', { maxTermShare: 0.2, rareTermDf: 0 });
  assert.deepEqual(query.phrases, []);
  const hits = searchRecordIndex(index, query, { rareTermDf: 0 });
  assert.deepEqual(hits.map((hit) => hit.messageId), ['d1'], 'one common-enough term alone finds nothing');
  assert.deepEqual([hits[0].terms, hits[0].phrases], [2, 0]);
  const rare = searchRecordIndex(index, query, { rareTermDf: 3, allow: (doc) => doc.channelId !== 'hidden' });
  assert.deepEqual(rare.map((hit) => hit.messageId), ['d1', 'd6', 'd2'], 'two terms first, then one rare term by weight; the hidden channel refused');
  assert.deepEqual(searchRecordIndex(index, query, { rareTermDf: 3, until: T0 + 1.5 * MIN }).map((hit) => hit.messageId), ['d1']);
  assert.deepEqual(searchRecordIndex(index, query, { rareTermDf: 0, exclude: new Set(['d1']) }), []);
  const phrase = searchRecordIndex(index, indexQuery(index, 'plus ultra', { maxTermShare: 0.2, rareTermDf: 0 }), { rareTermDf: 0 });
  assert.deepEqual(phrase.map((hit) => hit.messageId).sort(), ['d3', 'd4']);
  assert.ok(phrase.every((hit) => hit.phrases === 1));
  assert.equal(searchRecordIndex(index, query, { rareTermDf: 3, limit: 1 }).length, 1);
  assert.deepEqual(searchRecordIndex(index, { terms: [], phrases: [] }), []);
});

test('querySupport: the terms and phrases of a query found in texts, by key', () => {
  const index = buildRecordIndex([...STORY, ...filler(20)]);
  const query = indexQuery(index, 'dog or forest, plus ultra', { maxTermShare: 0.2, rareTermDf: 0 });
  assert.deepEqual(querySupport(index, ['A DOG!', 'nothing else'], query), { terms: 1, phrases: 0 });
  assert.deepEqual(querySupport(index, ['plus ultra', 'forest'], query), { terms: 3, phrases: 1 });
  assert.deepEqual(querySupport(index, ['cat and hat'], query), { terms: 0, phrases: 0 });
  assert.deepEqual(querySupport(index, ['dog'], null), { terms: 0, phrases: 0 });
});

test('recordIndexOf: built once per record and guild, refreshed in the background from before its last check, rebuilt whole later', async () => {
  const lines = [line('a1', 1, 'first words')];
  const queries = [];
  const record = {
    async *iterate(guildId, query = {}) {
      queries.push(query);
      const from = query.from ? Date.parse(query.from) : -Infinity;
      for (const l of lines) if (Date.parse(l.occurredAt) >= from) yield l;
    },
  };
  let clock = T0 + 10 * MIN;
  const now = () => clock;
  const settle = () => new Promise((resolve) => setImmediate(resolve));
  const first = await recordIndexOf(record, 'g1', { now, refreshMs: 1000, rebuildMs: 60 * MIN });
  assert.equal(first.alive, 1);
  assert.deepEqual(queries, [{}]);
  lines.push(line('a2', 11, 'second words'));
  assert.equal(await recordIndexOf(record, 'g1', { now, refreshMs: 1000, rebuildMs: 60 * MIN }), first, 'within refreshMs: the same index, no read');
  assert.equal(queries.length, 1);
  clock += 2000;
  await recordIndexOf(record, 'g1', { now, refreshMs: 1000, rebuildMs: 60 * MIN });
  await settle();
  await settle();
  assert.equal(queries.length, 2);
  assert.equal(queries[1].from, new Date(T0 + 10 * MIN - REFRESH_OVERLAP_MS).toISOString(), 'read again from before the last check');
  assert.equal(first.alive, 2, 'the new line folded in');
  const other = await recordIndexOf(record, 'g2', { now });
  assert.notEqual(other, first, 'one index per guild');
  const owner = await recordIndexOf(record, 'g1', { privateUserId: 'u5', now });
  assert.deepEqual(queries[queries.length - 1], { privateUserId: 'u5' }, 'a private owner\'s record on its own');
  assert.notEqual(owner, first);
  clock += 61 * MIN;
  await recordIndexOf(record, 'g1', { now, refreshMs: 1000, rebuildMs: 60 * MIN });
  await settle();
  await settle();
  const rebuilt = await recordIndexOf(record, 'g1', { now, refreshMs: 1000, rebuildMs: 60 * MIN });
  assert.notEqual(rebuilt, first, 'rebuilt whole and swapped in');
  assert.equal(rebuilt.alive, 2);
  const failing = { iterate: async function* () { throw new Error('disk'); } };
  await assert.rejects(recordIndexOf(failing, 'g1', { now }));
  await assert.rejects(recordIndexOf(failing, 'g1', { now }), 'a failed build is forgotten and tried again');
});
