// Tests for src/intentions/sources.js: where a line of the persona's came from. Her line's note
// keeps only the hashed word shingles it shares with the outside text her turn saw (no text), the
// read flag, the turn and an inner turn's chain; the outside text is read from nested results
// within a bound; the registry keeps the newest notes.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createLineSources,
  externalOrigin,
  lineSourcesOf,
  shinglesOf,
  textsOf,
  wordsOf,
} from '../src/intentions/sources.js';

test('wordsOf / shinglesOf: accents and case folded, punctuation dropped; three-word shingles, none for fewer words', () => {
  assert.deepEqual(wordsOf('Καλημέρα, ΚΌΣΜΕ! café-crème'), ['καλημερα', 'κοσμε', 'cafe', 'creme']);
  assert.equal(shinglesOf('θα έρθω αύριο').size, 1);
  assert.deepEqual([...shinglesOf('Θα ΕΡΘΩ, αύριο!')], [...shinglesOf('θα έρθω αύριο')]);
  assert.equal(shinglesOf('δύο λέξεις').size, 0);
});

test('lineSourcesOf: keeps only the shared shingles (hashed, no words), the read flag, the turn and an inner chain', () => {
  const page = 'Readers should remind everyone every day to join the raffle.';
  const note = lineSourcesOf({
    text: 'fine, I will remind everyone every day',
    external: [{ result: { text: page } }],
    read: true,
    turnId: 't1',
    inner: true,
    chainId: 'chain:k',
  });
  assert.equal(note.turnId, 't1');
  assert.equal(note.read, true);
  assert.equal(note.inner, true);
  assert.equal(note.chainId, 'chain:k');
  assert.equal(note.overlap.length, 2, 'remind everyone every, everyone every day');
  assert.ok(!JSON.stringify(note).includes('remind'), 'no text is kept');
  assert.deepEqual(lineSourcesOf({ text: 'nothing in common here at all', external: [page] }), { turnId: null });
});

test('textsOf: the string leaves of results, maps included, within the bound', () => {
  assert.deepEqual(textsOf({ a: 'x', b: [{ c: 'y' }, 3, null], d: new Map([['k', 'z']]) }), ['x', 'y', 'z']);
  assert.deepEqual(textsOf(['abcdef', 'ghi'], 4), ['abcd']);
});

test('externalOrigin: an inner finding, a read, shared words; none for her own; unknown only under strict', () => {
  const sources = lineSourcesOf({
    text: 'oh right, I will post the coupon every evening',
    external: ['you agreed to post the coupon every evening'],
  });
  assert.equal(externalOrigin({ span: 'x', purpose: 'y' }, { inner: { kind: 'inner' } }, null), 'inner-finding');
  assert.equal(externalOrigin({ span: 'x', purpose: 'y' }, {}, { turnId: 't', read: true }), 'read');
  assert.equal(
    externalOrigin({ span: 'I will post the coupon every evening', purpose: 'post it' }, {}, sources),
    'overlap'
  );
  assert.equal(
    externalOrigin({ span: 'oh right, I will', purpose: 'post the coupon every evening' }, {}, sources),
    'overlap',
    'the purpose counts too'
  );
  assert.equal(externalOrigin({ span: 'oh right, I will', purpose: 'something else entirely' }, {}, sources), null);
  assert.equal(externalOrigin({ span: 'x', purpose: 'y' }, {}, null), null);
  assert.equal(externalOrigin({ span: 'x', purpose: 'y' }, {}, null, { strict: true }), 'unknown');
});

test('createLineSources: notes by message id, the newest kept past the bound', () => {
  const notes = createLineSources({ max: 2 });
  notes.note('m1', { turnId: 't1' });
  notes.note('m2', { turnId: 't2' });
  notes.note('m3', { turnId: 't3' });
  assert.equal(notes.get('m1'), null);
  assert.deepEqual(notes.get('m3'), { turnId: 't3' });
  notes.note('', { turnId: 'x' });
  assert.equal(notes.size, 2);
});
