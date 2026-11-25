// Tests for src/memory/interests.ts: normalizeInterests (validates stored items) and the isConfirmed/isStale
// helpers. Pure, no I/O.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { normalizeInterests, normalizeTopic, isConfirmed, isStale } from '../../../src/memory/interests.ts';
import { wrongly } from '../../fixtures/loose-types.ts';

const NOW = Date.UTC(2026, 8, 21, 12, 0, 0); // 2026-09-21T12:00:00Z
const HOUR = 3_600_000;
const DAY = 24 * HOUR;

// ---- normalizeTopic ---------------------------------------------------------

test('normalizeTopic: trims, collapses inner whitespace, lowercases', () => {
  assert.equal(normalizeTopic('  Board   Games  '), 'board games');
});

// ---- isConfirmed / isStale ----------------------------------------------------

test('isConfirmed: weight at or above confirmAfter is confirmed', () => {
  assert.equal(isConfirmed({ weight: 5 }, 3), true);
  assert.equal(isConfirmed({ weight: 2 }, 3), false);
});

test('isStale: older than staleDays is stale, within it is not', () => {
  const item = { lastSeen: new Date(NOW - 100 * DAY).toISOString() };
  assert.equal(isStale(item, NOW, 90), true);
  assert.equal(isStale({ lastSeen: new Date(NOW - 10 * DAY).toISOString() }, NOW, 90), false);
});

test('isStale: an unknown lastSeen is never stale', () => {
  assert.equal(isStale({ lastSeen: null }, NOW, 90), false);
  assert.equal(isStale({}, NOW, 90), false);
});

test('isStale: staleDays not a positive number means never stale', () => {
  const item = { lastSeen: new Date(NOW - 1000 * DAY).toISOString() };
  assert.equal(isStale(item, NOW, 0), false);
  assert.equal(isStale(item, NOW, undefined), false);
});

// ---- normalizeInterests: array validation -------------------------------------

test('normalizeInterests: well-formed items pass through validated, missing optional fields get sane defaults', () => {
  const rows = [
    [
      'an array of well-formed items passes through validated',
      [{ topic: 'Chess', note: 'plays weekly', weight: 4, firstSeen: 'a', lastSeen: 'b' }],
      [{ topic: 'Chess', note: 'plays weekly', weight: 4, firstSeen: 'a', lastSeen: 'b' }],
    ],
    [
      'array items missing optional fields get sane defaults',
      [{ topic: 'Chess' }],
      [{ topic: 'Chess', note: '', weight: 1, firstSeen: null, lastSeen: null }],
    ],
  ];
  for (const [label, input, expected] of rows) {
    assert.deepEqual(normalizeInterests(input), expected, wrongly(label));
  }
});

test('normalizeInterests: garbage entries inside an array are dropped, valid ones survive', () => {
  const items = normalizeInterests([null, 42, 'garbage', { topic: '' }, { note: 'no topic at all' }, { topic: 'OK' }]);
  assert.deepEqual(items, [{ topic: 'OK', note: '', weight: 1, firstSeen: null, lastSeen: null }]);
});

// ---- normalizeInterests: anything else -----------------------------------------

test('normalizeInterests: null/undefined/number/string/object all yield []', () => {
  assert.deepEqual(normalizeInterests(null), []);
  assert.deepEqual(normalizeInterests('Chess, Anime'), []);
  assert.deepEqual(normalizeInterests({ not: 'an array' }), []);
});
