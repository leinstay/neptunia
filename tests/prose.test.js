import { test } from 'node:test';
import assert from 'node:assert/strict';
import { acceptProse, overLimitOf, sentenceDiff } from '../src/memory/prose.js';

test('acceptProse: a rewrite at the limit is replaced, one over is refused and keeps the previous text', () => {
  const prev = 'Παλιό κείμενο.';
  assert.deepEqual(acceptProse(prev, 'α'.repeat(10), 10), { text: 'α'.repeat(10), outcome: 'replaced' });
  assert.deepEqual(
    acceptProse(prev, 'α'.repeat(11), 10, { tolerance: 1.25 }),
    { text: prev, outcome: 'over' },
    'tolerance never widens a rewrite'
  );
  assert.deepEqual(acceptProse(prev, prev, 10), { text: prev, outcome: 'same' });
  assert.deepEqual(acceptProse(prev, '   ', 10), { text: prev, outcome: 'empty' });
  assert.deepEqual(acceptProse(prev, 'νέο', 0), { text: 'νέο', outcome: 'replaced' }, 'no limit');
});

test('acceptProse: a first write over the limit is clamped and stored, never refused', () => {
  const r = acceptProse('', 'Μία πρόταση. '.repeat(20), 40, { tolerance: 1 });
  assert.equal(r.outcome, 'first');
  assert.ok(r.text.length > 0 && r.text.length <= 40);
  assert.equal(acceptProse(undefined, 'νέο', 10).outcome, 'first');
});

test('overLimitOf: lists only the fields over their limit with code-point counts', () => {
  assert.deepEqual(overLimitOf({ purpose: 'αβγ', topics: 'αβγδε', tone: 7 }, { purpose: 3, topics: 4, tone: 1 }), {
    topics: { chars: 5, limit: 4 },
  });
  assert.deepEqual(overLimitOf({ a: 'x' }, {}), {});
});

test('sentenceDiff: counts kept, removed and added sentences as sets', () => {
  const before = 'Ένα. Δύο! Τρία?';
  const after = 'Δύο!  Τρία? Τέσσερα.';
  assert.deepEqual(sentenceDiff(before, after), { before: 3, after: 3, kept: 2, removed: 1, added: 1 });
  assert.deepEqual(sentenceDiff('', 'Ένα.'), { before: 0, after: 1, kept: 0, removed: 0, added: 1 });
});
