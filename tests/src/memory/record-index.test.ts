// Tests for src/memory/record-index.ts: the words of the record and the word endings learned from it. No I/O.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { indexWords, learnEndings, stemmerOf } from '../../../src/memory/record-index.ts';

test('indexWords: folded words, URLs and long digit runs left out', () => {
  assert.deepEqual(indexWords('Élodie SAW https://example.com/a/b?c=1 the Δάσος <@123456789012345678> r34'), [
    'elodie',
    'saw',
    'the',
    'δασος',
    'r34',
  ]);
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
