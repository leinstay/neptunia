// Tests for src/memory/ranking.js: rank (the weight/recency formula shared by
// interests and details), sortByRank and topByRank. Pure, no I/O.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rank, sortByRank, topByRank } from '../src/memory/ranking.js';

const DAY = 24 * 3_600_000;
const NOW = Date.UTC(2026, 8, 21, 12, 0, 0); // 2026-09-21T12:00:00Z

function item(weight, lastSeenMs, firstSeenMs) {
  return {
    weight,
    lastSeen: lastSeenMs != null ? new Date(lastSeenMs).toISOString() : null,
    firstSeen: firstSeenMs != null ? new Date(firstSeenMs).toISOString() : null,
  };
}

// ---- rank: no-decay fallback --------------------------------------------------

test('rank: halfLifeDays not a positive number disables decay -- rank is pure log2(weight + 0.5)', () => {
  const recent = item(5, NOW);
  const ancient = item(5, NOW - 3650 * DAY);
  for (const halfLifeDays of [undefined, 0, 'not a number']) {
    assert.equal(rank(recent, halfLifeDays), Math.log2(5.5));
    assert.equal(
      rank(recent, halfLifeDays),
      rank(ancient, halfLifeDays),
      `date must not matter when halfLifeDays=${halfLifeDays}`
    );
  }
});

// ---- rank: unknown dates --------------------------------------------------

test('rank: lastSeen unknown falls back to firstSeen', () => {
  const withFirstSeenOnly = { weight: 3, lastSeen: null, firstSeen: new Date(NOW).toISOString() };
  const withLastSeen = { weight: 3, lastSeen: new Date(NOW).toISOString(), firstSeen: null };
  assert.equal(rank(withFirstSeenOnly, 180), rank(withLastSeen, 180));
});

test('rank: an unparsable date string is treated the same as a missing one, never throws', () => {
  const garbage = { weight: 3, lastSeen: 'not a date', firstSeen: null };
  const noDates = { weight: 3, lastSeen: null, firstSeen: null };
  assert.doesNotThrow(() => rank(garbage, 180));
  assert.equal(rank(garbage, 180), rank(noDates, 180));
});

test('rank: a missing weight counts as 0, both dates unknown fall back to the epoch (0)', () => {
  const rows = [
    ['a missing weight counts as 0', rank({}, 180), Math.log2(0.5)],
    [
      'both dates unknown falls back to the epoch (0)',
      rank({ weight: 3, lastSeen: null, firstSeen: null }, 180),
      rank({ weight: 3, lastSeen: new Date(0).toISOString() }, 180),
    ],
  ];
  for (const [label, actual, expected] of rows) {
    assert.equal(actual, expected, label);
  }
});

// ---- rank: decay math ------------------------------------------------------

test('rank: one half-life of silence costs exactly 1 off the rank -- the same as one doubling of weight (a unit in log2)', () => {
  const halfLifeDays = 90;
  const recent = item(4, NOW);
  const oneHalfLifeAgo = item(4, NOW - halfLifeDays * DAY);
  assert.equal(rank(recent, halfLifeDays) - rank(oneHalfLifeAgo, halfLifeDays), 1);
});

// ---- sortByRank / topByRank -------------------------------------------------

test('sortByRank: orders best (highest rank) first, no decay', () => {
  const a = item(1, NOW);
  const b = item(5, NOW);
  const c = item(3, NOW);
  assert.deepEqual(sortByRank([a, b, c], undefined), [b, c, a]);
});

test('sortByRank: with decay, a recent lower-weight item can outrank an ancient heavy one', () => {
  const halfLifeDays = 180;
  const ancientHeavy = item(10, NOW - 5 * 365 * DAY); // ~5 years of silence
  const recentLight = item(2, NOW);
  const [best] = sortByRank([ancientHeavy, recentLight], halfLifeDays);
  assert.equal(best, recentLight, 'five years of silence outweighs a modest weight edge');
});

test('sortByRank: ties in rank are broken by the newer lastSeen', () => {
  const older = item(2, NOW - 10 * DAY);
  const newer = item(2, NOW);
  assert.deepEqual(sortByRank([older, newer], undefined), [newer, older]);
});

test('sortByRank: never mutates the input array', () => {
  const a = item(1, NOW);
  const b = item(5, NOW);
  const input = [a, b];
  const copy = [...input];
  sortByRank(input, 180);
  assert.deepEqual(input, copy);
});

test('topByRank: keeps only the top n, best first', () => {
  const a = item(1, NOW);
  const b = item(5, NOW);
  const c = item(3, NOW);
  assert.deepEqual(topByRank([a, b, c], 2, undefined), [b, c]);
});

test('topByRank: n not a non-negative integer keeps everything', () => {
  const a = item(1, NOW);
  const b = item(5, NOW);
  for (const n of [undefined, -1, 'x']) {
    assert.equal(topByRank([a, b], n, undefined).length, 2);
  }
});

test('topByRank: n of 0 keeps nothing', () => {
  const a = item(1, NOW);
  assert.deepEqual(topByRank([a], 0, undefined), []);
});
