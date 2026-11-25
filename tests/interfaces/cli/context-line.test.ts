// interfaces/cli/context-line.ts: the context line over the numbers it is given. It reads what it is given and starts nothing by being opened.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { contextLine } from '../../../interfaces/cli/context-line.ts';

test('the context line shows supplied numbers as they are', () => {
  // Bug: the percentage is computed against a guessed limit, or a route's model is hidden.
  const line = contextLine({ usedTokens: 5000, limitTokens: 20000, route: 'zeta-route', model: 'zeta-model' });
  assert.match(line, /25%/);
  assert.match(line, /zeta-route/);
  assert.match(line, /zeta-model/);
});

test('a missing field is unknown, never zero', () => {
  // Bug: an absent limit reads as 0% used, and the owner trusts a number nobody measured.
  const line = contextLine({ usedTokens: 5000, limitTokens: null, route: null, model: null });
  assert.equal(line.includes('%'), false);
  assert.ok(line.includes('5000') || line.includes('5,000') || line.includes('5k'));
  const empty = contextLine({ usedTokens: null, limitTokens: null, route: null, model: null });
  assert.equal(/\b0\b/.test(empty), false);
  assert.match(empty, /unknown/i);
});
