import { test } from 'node:test';
import assert from 'node:assert/strict';
import { sentenceDiff } from '../../../src/memory/prose.ts';

test('sentenceDiff: counts kept, removed and added sentences as sets', () => {
  const before = 'Ένα. Δύο! Τρία?';
  const after = 'Δύο!  Τρία? Τέσσερα.';
  assert.deepEqual(sentenceDiff(before, after), { before: 3, after: 3, kept: 2, removed: 1, added: 1 });
  assert.deepEqual(sentenceDiff('', 'Ένα.'), { before: 0, after: 1, kept: 0, removed: 0, added: 1 });
});
