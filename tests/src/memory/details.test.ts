// Tests for src/memory/details.ts: normalizeDetails (validates stored items). Pure, no I/O.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeDetails } from '../../../src/memory/details.ts';
import type { Untyped } from '../../../src/tools/types.ts';

// The records come back typed as `object` or `unknown`; the tests read their fields through `loose`.
const loose = (value: unknown): Record<string, Untyped> => value as Record<string, Untyped>;

// ---- normalizeDetails: array validation -------------------------------------

test('normalizeDetails: startId offsets the ids assigned to entries missing one', () => {
  const { items, nextId } = normalizeDetails([{ text: 'a' }, { text: 'b' }], 5);
  assert.deepEqual(
    items.map((i) => loose(i).id),
    [5, 6]
  );
  assert.equal(nextId, 7);
});

test('normalizeDetails: an array already in the item shape passes through, keeping valid ids', () => {
  const { items, nextId } = normalizeDetails(
    [{ id: 7, text: 'Owns a cat', weight: 3, firstSeen: 'a', lastSeen: 'b' }],
    1
  );
  assert.deepEqual(items, [{ id: 7, text: 'Owns a cat', weight: 3, firstSeen: 'a', lastSeen: 'b' }]);
  assert.equal(nextId, 8, 'the sequence continues past the highest id seen');
});

test('normalizeDetails: item-shaped entries missing a valid id get one assigned fresh', () => {
  const { items } = normalizeDetails([{ text: 'Owns a cat' }], 1);
  assert.deepEqual(items, [{ id: 1, text: 'Owns a cat', weight: 1, firstSeen: null, lastSeen: null }]);
});

test('normalizeDetails: garbage entries (including a bare string) never throw, valid ones survive', () => {
  const { items } = normalizeDetails([null, 42, {}, { text: '' }, 'Owns a cat', { text: 'Plays guitar' }], 1);
  assert.deepEqual(
    items.map((i) => loose(i).text),
    ['Plays guitar']
  );
});

test('normalizeDetails: null/undefined/number/string/object all yield an empty list', () => {
  assert.deepEqual(normalizeDetails(null).items, []);
  assert.deepEqual(normalizeDetails('Owns a cat, plays guitar').items, []);
  assert.deepEqual(normalizeDetails({ not: 'an array' }).items, []);
});

// ---- the optional `from` (who taught an item; used by root.learned) ---------

test('normalizeDetails: a valid string from survives, a garbage from is dropped', () => {
  const { items } = normalizeDetails(
    [
      { id: 1, text: 'Café closes at nine', weight: 2, firstSeen: 'a', lastSeen: 'b', from: '<@322222222222222222>' },
      { id: 2, text: 'Friday is τυρόπιτα day', weight: 1, firstSeen: 'a', lastSeen: 'b', from: 42 },
      { id: 3, text: 'Owns a cat', weight: 1, firstSeen: 'a', lastSeen: 'b', from: '  ' },
    ],
    1
  );
  assert.deepEqual(items[0], {
    id: 1,
    text: 'Café closes at nine',
    weight: 2,
    firstSeen: 'a',
    lastSeen: 'b',
    from: '<@322222222222222222>',
  });
  assert.equal('from' in items[1], false);
  assert.equal('from' in items[2], false);
});
