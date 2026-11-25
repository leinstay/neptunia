// Tests for src/memory/affinity.ts: pure attitude scoring for
// features.relationships (docs/prompt-contract.md, "The analyzer").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { affinityBand, decayAffinity, roundScore } from '../../../src/memory/affinity.ts';
import type { Untyped } from '../../../src/tools/types.ts';

// The records come back typed as `object` or `unknown`; the tests read their fields through `loose`.
const loose = (value: unknown): Record<string, Untyped> => value as Record<string, Untyped>;

// --- affinityBand: every boundary from the contract ---------------------

const BAND_CASES: Array<[number, string]> = [
  [-100, 'hostile'],
  [-60, 'hostile'],
  [-59, 'dislike'],
  [-25, 'dislike'],
  [-24, 'cool'],
  [-8, 'cool'],
  [-7, 'neutral'],
  [0, 'neutral'],
  [7, 'neutral'],
  [8, 'warm'],
  [24, 'warm'],
  [25, 'fond'],
  [59, 'fond'],
  [60, 'devoted'],
  [100, 'devoted'],
];

test('affinityBand: every boundary from the contract falls in its band', () => {
  for (const [score, band] of BAND_CASES) {
    assert.equal(affinityBand(score), band, `${score} -> ${band}`);
  }
});

// --- roundScore --------------------------------------------------------------
// Everything shown to the model or the owner (the prompt's {score}, `memory show`,
// `memory affinity`, the analyzer's <existing_profiles>) rounds through this.

test('roundScore: rounds a fractional score to the nearest integer', () => {
  assert.equal(roundScore(60.4), 60);
  assert.equal(roundScore(60.6), 61);
  assert.equal(roundScore(-60.6), -61);
});

test('roundScore: a non-finite score displays as 0', () => {
  assert.equal(roundScore(NaN), 0);
  // @ts-expect-error: the test passes a value the signature refuses, to check how the function copes with a bad one
  assert.equal(roundScore(undefined), 0);
});

// --- decayAffinity -----------------------------------------------------------
// Daily drift toward zero (relationships.decayPerDay / decayPower): per elapsed
// day the score loses decayPerDay * |score| * (|score| / 100) ** decayPower.

const DAY_MS = 24 * 60 * 60 * 1000;
const DECAY_T0 = Date.UTC(2026, 9, 1, 12, 0, 0);
const DECAY_CFG = { decayPerDay: 0.04, decayPower: 1 };

function stamped(score: number, at = DECAY_T0) {
  return { score, reason: 'r', history: [{ ts: 't', delta: 1 }], decayedAt: new Date(at).toISOString() };
}

test('decayAffinity: one day at 100 loses 4, at 64 about 1.64', () => {
  assert.equal(loose(decayAffinity(stamped(100), DECAY_T0 + DAY_MS, DECAY_CFG).affinity).score, 96);
  assert.equal(loose(decayAffinity(stamped(64), DECAY_T0 + DAY_MS, DECAY_CFG).affinity).score, 62.36);
});

test('decayAffinity: a negative score moves up toward zero by the same amount', () => {
  assert.equal(loose(decayAffinity(stamped(-64), DECAY_T0 + DAY_MS, DECAY_CFG).affinity).score, -62.36);
});

test('decayAffinity: never crosses zero, even with a huge decayPerDay', () => {
  const up = decayAffinity(stamped(50), DECAY_T0 + 3 * DAY_MS, { decayPerDay: 5, decayPower: 1 });
  assert.equal(loose(up.affinity).score, 0);
  const down = decayAffinity(stamped(-50), DECAY_T0 + 3 * DAY_MS, { decayPerDay: 5, decayPower: 1 });
  assert.equal(loose(down.affinity).score, 0);
});

test('decayAffinity: several days apply one step per day, in order', () => {
  const { affinity, days } = decayAffinity(stamped(100), DECAY_T0 + 2 * DAY_MS, DECAY_CFG);
  assert.equal(days, 2);
  // 100 -> 96 -> 96 - 0.04 * 96 * 0.96 = 92.3136
  assert.equal(loose(affinity).score, 92.31);
});

test('decayAffinity: missing or malformed decayedAt only stamps the baseline, the score stays', () => {
  for (const decayedAt of [undefined, 'not a date']) {
    const start = { score: 80, reason: 'r', history: [], decayedAt };
    const { affinity, days } = decayAffinity(start, DECAY_T0, DECAY_CFG);
    assert.equal(days, 0);
    assert.equal(loose(affinity).score, 80);
    assert.equal(loose(affinity).decayedAt, new Date(DECAY_T0).toISOString());
    assert.equal(loose(affinity).reason, 'r');
  }
});

test('decayAffinity: only whole days apply, the remainder carries over to the next sweep', () => {
  const first = decayAffinity(stamped(100), DECAY_T0 + DAY_MS + 5 * 3600_000, DECAY_CFG);
  assert.equal(first.days, 1);
  assert.equal(
    loose(first.affinity).decayedAt,
    new Date(DECAY_T0 + DAY_MS).toISOString(),
    'advanced by exactly one day'
  );
  const second = decayAffinity(first.affinity, DECAY_T0 + 2 * DAY_MS + 1000, DECAY_CFG);
  assert.equal(second.days, 1, 'the 5 leftover hours plus 19 more make the second day');
  assert.equal(loose(second.affinity).decayedAt, new Date(DECAY_T0 + 2 * DAY_MS).toISOString());
});

test('decayAffinity: less than a day elapsed returns the same object', () => {
  const start = stamped(100);
  const { affinity, days } = decayAffinity(start, DECAY_T0 + DAY_MS - 1, DECAY_CFG);
  assert.equal(affinity, start);
  assert.equal(days, 0);
});

test('decayAffinity: a decayedAt in the future changes nothing', () => {
  const start = stamped(100, DECAY_T0 + 5 * DAY_MS);
  assert.equal(decayAffinity(start, DECAY_T0, DECAY_CFG).affinity, start);
});

test('decayAffinity: score 0 moves only the stamp', () => {
  const { affinity, days } = decayAffinity(stamped(0), DECAY_T0 + 3 * DAY_MS, DECAY_CFG);
  assert.equal(days, 3);
  assert.equal(loose(affinity).score, 0);
  assert.equal(loose(affinity).decayedAt, new Date(DECAY_T0 + 3 * DAY_MS).toISOString());
});

test('decayAffinity: decayPerDay 0, missing or non-finite is off -- same object, no stamp', () => {
  for (const cfg of [{ decayPerDay: 0 }, {}, { decayPerDay: NaN }]) {
    const start = stamped(100);
    assert.equal(decayAffinity(start, DECAY_T0 + 10 * DAY_MS, cfg).affinity, start);
    const unstamped = { score: 100, reason: '', history: [] };
    assert.equal(decayAffinity(unstamped, DECAY_T0, cfg).affinity, unstamped);
  }
});

test('decayAffinity: decayPower falls back to 1 when it is not a positive finite number', () => {
  for (const decayPower of [0, NaN, 'x']) {
    // @ts-expect-error: the test passes a value the signature refuses, to check how the function copes with a bad one
    const { affinity } = decayAffinity(stamped(64), DECAY_T0 + DAY_MS, { decayPerDay: 0.04, decayPower });
    assert.equal(loose(affinity).score, 62.36, `decayPower ${decayPower} should fall back to 1`);
  }
});

test('decayAffinity: decayPower 2 makes a middling score decay slower', () => {
  // 64 - 0.04 * 64 * 0.64 ** 2 = 62.951...
  const { affinity } = decayAffinity(stamped(64), DECAY_T0 + DAY_MS, { decayPerDay: 0.04, decayPower: 2 });
  assert.equal(loose(affinity).score, 62.95);
});

test('decayAffinity: keeps reason and history untouched, adds no history entry', () => {
  const start = stamped(100);
  const { affinity } = decayAffinity(start, DECAY_T0 + DAY_MS, DECAY_CFG);
  assert.equal(loose(affinity).reason, 'r');
  assert.deepEqual(loose(affinity).history, start.history);
  assert.equal(start.score, 100, 'the input is not mutated');
});

test('decayAffinity: the loop is capped (3650 days) and the stamp advances only by the days applied', () => {
  const start = stamped(100, DECAY_T0 - 5000 * DAY_MS);
  const { days, affinity } = decayAffinity(start, DECAY_T0, DECAY_CFG);
  assert.equal(days, 3650);
  assert.equal(loose(affinity).decayedAt, new Date(DECAY_T0 - 1350 * DAY_MS).toISOString());
});

test('decayAffinity: time the persona was not running (skipMs) does not count; the stamp moves forward, never past now', () => {
  const day = 86_400_000;
  const stamp = Date.UTC(2026, 9, 1);
  const affinity = { score: 50, reason: 'r', history: [], decayedAt: new Date(stamp).toISOString() };
  const cfg = { decayPerDay: 0.04, decayPower: 1 };
  // A week passed, all of it downtime but one hour: nothing decays, the stamp moves by the downtime.
  const week = decayAffinity(affinity, stamp + 7 * day, { ...cfg, skipMs: 7 * day - 3_600_000 });
  assert.equal(week.days, 0);
  assert.equal(loose(week.affinity).score, 50);
  assert.equal(loose(week.affinity).decayedAt, new Date(stamp + 7 * day - 3_600_000).toISOString());
  // Three days passed, one of them downtime: two days decay.
  const three = decayAffinity(affinity, stamp + 3 * day, { ...cfg, skipMs: day });
  assert.equal(three.days, 2);
  assert.equal(loose(three.affinity).score, loose(decayAffinity(affinity, stamp + 2 * day, cfg).affinity).score);
  // A skip longer than the gap stops at now.
  const over = decayAffinity(affinity, stamp + day, { ...cfg, skipMs: 10 * day });
  assert.equal(over.days, 0);
  assert.equal(loose(over.affinity).decayedAt, new Date(stamp + day).toISOString());
  // No skip: as before.
  assert.equal(decayAffinity(affinity, stamp + 3 * day, cfg).days, 3);
});
