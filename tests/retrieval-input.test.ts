// The words of a stored fact's standing. The queries and budgets of src/memory/retrieval-input.ts have their tests in
// tests/memory-retrieval-consumers.test.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { factStateWords } from '../src/memory/retrieval-input.ts';

const STATES = { current: 'in force', unknown: 'unverified', negative: 'not so' };

test('a negative fact says so beside its state', () => {
  // Bug: "did not attend" reads as a plain current fact.
  assert.equal(factStateWords({ state: 'current', polarity: 'negative' }, STATES), 'in force, not so');
});

test('a state with no word and absent labels add nothing', () => {
  // Bug: a missing label prints `undefined` into her request.
  assert.equal(factStateWords({ state: 'retired', polarity: 'positive' }, STATES), '');
  assert.equal(factStateWords({ state: 'current' }, null), '');
});

test('an old fact with no state reads as unverified', () => {
  // Bug: a version with no snapshot is shown as if it were known to be current.
  assert.equal(factStateWords({}, STATES), 'unverified');
});
