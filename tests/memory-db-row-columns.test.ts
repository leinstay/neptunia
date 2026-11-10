// How a stored value is split into column values and a remainder and put back (src/memory/db/row-columns.ts): a value
// that does not fit its column stays in the remainder, and a key present as null comes back null. Synthetic values.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join, split } from '../src/memory/db/row-columns.ts';
import type { Spec } from '../src/memory/db/row-columns.ts';

const SPEC: Array<Spec> = [
  { col: 'text', key: 'text', type: 'text' },
  { col: 'weight', key: 'weight', type: 'num' },
  { col: 'shown', key: 'shown', type: 'bool' },
];

test('a value splits into its columns and its remainder and joins back the same', () => {
  const value = { text: 'a quiet café', weight: 2, shown: true, mood: 'calm' };
  const { cols, rest } = split(value, SPEC);
  assert.deepEqual(cols, { text: 'a quiet café', weight: 2, shown: 1 });
  assert.deepEqual(rest, { mood: 'calm' });
  assert.deepEqual(join(cols, JSON.stringify(rest), SPEC), value);
});

test('a value that does not fit its column stays in the remainder, and a null comes back null', () => {
  const value = { text: 7, weight: null };
  const { cols, rest } = split(value, SPEC);
  assert.deepEqual(cols, { text: null, weight: null, shown: null });
  assert.deepEqual(rest, { text: 7, $null: ['weight'] });
  assert.deepEqual(join(cols, rest, SPEC), value);
});
