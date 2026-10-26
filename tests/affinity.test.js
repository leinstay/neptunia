// Tests for src/memory/affinity.js: pure attitude scoring for
// features.relationships (docs/prompt-contract.md, "The analyzer").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyAffinity,
  affinityBand,
  applyDelta,
  decayAffinity,
  ignoreAdjustment,
  roundScore,
  bandGap,
  relationshipStaleOf,
  RELATIONSHIP_STALE_DEFAULTS,
  REASON_CHARS,
  deltaCapOf,
  strongestMoves,
} from '../src/memory/affinity.js';

// --- affinityBand: every boundary from the contract ---------------------

const BAND_CASES = [
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

// --- applyDelta ----------------------------------------------------------

const OPTS = { maxDelta: 15, historySize: 10, now: Date.UTC(2026, 0, 1, 12, 0, 0) };

test('applyDelta: a plain positive delta is added to the score', () => {
  const result = applyDelta(emptyAffinity(), 5, 'was nice', OPTS);
  assert.equal(result.score, 5);
  assert.equal(result.reason, 'was nice');
  assert.equal(result.history.length, 1);
  assert.deepEqual(result.history[0], {
    ts: new Date(OPTS.now).toISOString(),
    delta: 5,
    appliedDelta: 5,
    score: 5,
    reason: 'was nice',
  });
});

test('applyDelta: delta is clamped to +-maxDeltaPerUpdate before being applied', () => {
  const result = applyDelta(emptyAffinity(), 999, 'x', OPTS);
  assert.equal(result.score, 15);
  const negative = applyDelta(emptyAffinity(), -999, 'x', OPTS);
  assert.equal(negative.score, -15);
});

test('applyDelta: the resulting score is clamped to [-100, 100]', () => {
  const near = { score: 95, reason: 'r', history: [] };
  const result = applyDelta(near, 15, 'x', OPTS);
  assert.equal(result.score, 100);
});

test('applyDelta: a non-integer delta is truncated', () => {
  const result = applyDelta(emptyAffinity(), 3.9, 'x', OPTS);
  assert.equal(result.score, 3);
});

test('applyDelta: a NaN delta is treated as 0 (no-op)', () => {
  const start = emptyAffinity();
  const result = applyDelta(start, NaN, 'x', OPTS);
  assert.equal(result, start);
});

test('applyDelta: a string delta is coerced numerically', () => {
  const result = applyDelta(emptyAffinity(), '7', 'x', OPTS);
  assert.equal(result.score, 7);
});

test('applyDelta: a delta that clamps to zero net change at the score boundary is also a no-op', () => {
  const atCap = { score: 100, reason: 'r', history: [] };
  const result = applyDelta(atCap, 15, 'x', OPTS);
  assert.deepEqual(result, atCap);
});

test('applyDelta: reason within the clamp tolerance is kept whole, trimmed', () => {
  const result = applyDelta(emptyAffinity(), 1, `  ${'x'.repeat(250)}  `, { ...OPTS, clampTolerance: 1.25 });
  assert.equal(result.reason.length, 250);
  assert.equal(result.reason, 'x'.repeat(250));
});

test('applyDelta: each history entry records the reason of its own move, empty when none was given', () => {
  const start = {
    score: 5,
    reason: 'παλιός λόγος',
    history: [{ ts: 't0', delta: 5, appliedDelta: 5, score: 5, reason: 'παλιός λόγος' }],
  };
  for (const reason of ['   ', 42]) {
    const result = applyDelta(start, 2, reason, OPTS);
    assert.equal(result.score, 7, String(reason));
    assert.equal(result.reason, 'παλιός λόγος', `${String(reason)}: the stored reason stays the last one given`);
    assert.equal(result.history.length, 2);
    assert.equal(result.history[0].reason, 'παλιός λόγος', 'an earlier entry is untouched');
    assert.deepEqual(
      result.history[1],
      { ts: new Date(OPTS.now).toISOString(), delta: 2, appliedDelta: 2, score: 7, reason: '' },
      String(reason)
    );
  }
  const given = applyDelta(start, -3, '  νέος λόγος  ', OPTS);
  assert.equal(given.reason, 'νέος λόγος');
  assert.equal(given.history[1].reason, 'νέος λόγος', 'a given reason is recorded trimmed');
});

test('REASON_CHARS: the limit applyDelta cuts a reason at, on the entry and the stored reason alike', () => {
  const result = applyDelta(undefined, 5, 'α'.repeat(1000), {
    maxDelta: 15,
    historySize: 10,
    now: OPTS.now,
    clampTolerance: 1,
  });
  assert.equal([...result.reason].length, REASON_CHARS);
  assert.equal(result.history[0].reason, result.reason);
});

// --- deltaCapOf: the one reading of relationships.maxDeltaPerUpdate ----------

test('deltaCapOf: a finite number caps at its absolute value, anything else caps nothing', () => {
  const rows = [
    [15, 15],
    [-10, 10],
    [0, 0],
    [undefined, Infinity],
    [Infinity, Infinity],
    ['15', Infinity],
  ];
  for (const [maxDelta, cap] of rows) assert.equal(deltaCapOf(maxDelta), cap, String(maxDelta));
});

test('applyDelta: the delta is clamped to deltaCapOf(maxDelta)', () => {
  assert.equal(
    applyDelta(emptyAffinity(), -40, 'x', { ...OPTS, maxDelta: undefined }).score,
    -40,
    'no cap: the delta lands whole'
  );
  const start = emptyAffinity();
  assert.equal(applyDelta(start, 40, 'x', { ...OPTS, maxDelta: 0 }), start, 'a cap of 0 lets nothing through');
});

test('applyDelta: history is trimmed to the last historySize entries', () => {
  let affinity = emptyAffinity();
  for (let i = 0; i < 15; i += 1) {
    affinity = applyDelta(affinity, 1, `step ${i}`, { maxDelta: 15, historySize: 3, now: OPTS.now + i });
  }
  assert.equal(affinity.history.length, 3);
  assert.equal(affinity.history.at(-1).reason, 'step 14');
  assert.equal(affinity.score, 15);
});

test('applyDelta: tolerates a malformed/undefined affinity (a profile written before this feature)', () => {
  assert.equal(applyDelta(undefined, 5, 'x', OPTS).score, 5);
  assert.equal(applyDelta({ score: 'not a number' }, 5, 'x', OPTS).score, 5);
});

// --- ignoreAdjustment ------------------------------------------------------

const MENTION_CFG = { affinityIgnoreBonus: 0.3, affinityLikeBonus: 0.08 };

// [label, score, expected adjustment]
const IGNORE_CASES = [
  ['0 changes nothing', 0, 0],
  ['a non-finite score (NaN) changes nothing', NaN, 0],
  ['score -100 adds the full affinityIgnoreBonus', -100, MENTION_CFG.affinityIgnoreBonus],
  ['score 100 subtracts the full affinityLikeBonus', 100, -MENTION_CFG.affinityLikeBonus],
];

test('ignoreAdjustment: nothing at 0 or a non-finite score, the full bonus at either end of the scale', () => {
  for (const [label, score, expected] of IGNORE_CASES) {
    assert.equal(ignoreAdjustment(score, MENTION_CFG), expected, label);
  }
});

test('ignoreAdjustment: score -50 adds half the affinityIgnoreBonus (linear)', () => {
  assert.equal(ignoreAdjustment(-50, MENTION_CFG), MENTION_CFG.affinityIgnoreBonus * 0.5);
});

// --- applyDelta: relationships.damping --------------------------------------
// Undamped growth saturates every active member at +-100 well before a
// server's history runs out. `opts.damping` (config `relationships.damping`,
// default true) scales a delta that pushes the score further from zero by
// `(1 - |score| / 100)`; a delta that moves toward zero, starts at zero, or
// crosses zero is applied in full -- the direction is decided by the score's
// sign BEFORE the delta (the simpler of the two alternatives the task allows).

test('applyDelta: damping off applies the whole clamped delta', () => {
  const near = { score: 60, reason: 'r', history: [] };
  const explicitlyOff = applyDelta(near, 1, 'x', { maxDelta: 15, historySize: 10, now: OPTS.now, damping: false });
  assert.equal(explicitlyOff.score, 61);
});

test('applyDelta: damping on, a delta moving away from zero is scaled by (1 - |score| / 100)', () => {
  const start = { score: 50, reason: 'r', history: [] };
  const result = applyDelta(start, 10, 'x', { maxDelta: 15, historySize: 10, now: OPTS.now, damping: true });
  // factor = 1 - 50/100 = 0.5 -> applied delta = 5
  assert.equal(result.score, 55);
});

test('applyDelta: damping on, a delta moving toward zero is applied in full', () => {
  const start = { score: 50, reason: 'r', history: [] };
  const result = applyDelta(start, -10, 'x', { maxDelta: 15, historySize: 10, now: OPTS.now, damping: true });
  assert.equal(result.score, 40);
});

test('applyDelta: damping on, a delta that crosses zero is applied in full (sign decided before the delta)', () => {
  const start = { score: 5, reason: 'r', history: [] };
  const result = applyDelta(start, -20, 'x', { maxDelta: 30, historySize: 10, now: OPTS.now, damping: true });
  assert.equal(result.score, -15, 'moving away from the score before the delta (positive) is not what happened here');
});

test('applyDelta: damping is symmetric for negative scores', () => {
  const positive = applyDelta({ score: 50, reason: 'r', history: [] }, 10, 'x', {
    maxDelta: 15,
    historySize: 10,
    now: OPTS.now,
    damping: true,
  });
  const negative = applyDelta({ score: -50, reason: 'r', history: [] }, -10, 'x', {
    maxDelta: 15,
    historySize: 10,
    now: OPTS.now,
    damping: true,
  });
  assert.equal(positive.score, 55);
  assert.equal(negative.score, -55);
});

test('applyDelta: damping never lets the score exceed +-100, even for a huge delta', () => {
  const near = { score: 99, reason: 'r', history: [] };
  const result = applyDelta(near, 1_000_000, 'x', {
    maxDelta: Infinity,
    historySize: 10,
    now: OPTS.now,
    damping: true,
  });
  assert.equal(result.score, 100);

  const atCap = { score: 100, reason: 'r', history: [] };
  const noOp = applyDelta(atCap, 1_000_000, 'x', { maxDelta: Infinity, historySize: 10, now: OPTS.now, damping: true });
  assert.deepEqual(noOp, atCap, 'the damping factor is exactly 0 at the cap, so this is a no-op');
});

test('applyDelta: relationships.maxDeltaPerUpdate clamps the model delta BEFORE damping, not after', () => {
  const start = { score: 50, reason: 'r', history: [] };
  const result = applyDelta(start, 999, 'x', { maxDelta: 10, historySize: 10, now: OPTS.now, damping: true });
  // clamp(999, +-10) = 10 first, THEN factor 0.5 -> applied delta = 5 -> score 55.
  // Damping the raw 999 first (factor 0.5 -> 499.5) and clamping to 10 afterwards would give 60.
  assert.equal(result.score, 55);
});

test('applyDelta: tiny steps accumulate instead of rounding to zero forever', () => {
  const start = { score: 60, reason: 'r', history: [] };
  const step1 = applyDelta(start, 1, 'x', { maxDelta: 15, historySize: 10, now: OPTS.now, damping: true });
  // factor = 1 - 60/100 = 0.4 -> a plain integer round would floor this to 0 and never move again.
  assert.equal(step1.score, 60.4);
  assert.notDeepEqual(step1, start);
});

test("applyDelta: history keeps the model's original (clamped) delta and, separately, the applied delta", () => {
  const start = { score: 50, reason: 'r', history: [] };
  const result = applyDelta(start, 10, 'kind gesture', { maxDelta: 15, historySize: 10, now: OPTS.now, damping: true });
  assert.deepEqual(result.history[0], {
    ts: new Date(OPTS.now).toISOString(),
    delta: 10,
    appliedDelta: 5,
    score: 55,
    reason: 'kind gesture',
  });
});

test("applyDelta: truncate:false applies an exact (possibly fractional) delta -- the owner's absolute set", () => {
  // A score that carries two decimals (from a previous damped update), set to an exact target via
  // `delta = target - current`: truncating that delta first would strand the result off-target.
  const start = { score: 60.4, reason: 'r', history: [] };
  const result = applyDelta(start, 70 - 60.4, 'set by owner', {
    maxDelta: Infinity,
    historySize: 10,
    now: OPTS.now,
    damping: false,
    truncate: false,
  });
  assert.equal(result.score, 70);
});

// --- applyDelta: relationships.dampingPower ---------------------------------
// Tunable curve steepness: the damping factor becomes (1 - |score| / 100) ** dampingPower.
// dampingPower 1 is exactly the plain curve above; missing/garbage falls back to 1 too.

test('applyDelta: dampingPower > 1 flattens the curve less near zero, steepens it near the cap', () => {
  const start = { score: 60, reason: 'r', history: [] };
  // factor = (1 - 60/100) ** 2 = 0.16 -> applied delta = 0.16, smaller than power 1's 0.4.
  const result = applyDelta(start, 1, 'x', {
    maxDelta: 15,
    historySize: 10,
    now: OPTS.now,
    damping: true,
    dampingPower: 2,
  });
  assert.equal(result.score, 60.16);
});

test('applyDelta: dampingPower falls back to 1 for a non-positive, non-finite or garbage value', () => {
  const start = { score: 60, reason: 'r', history: [] };
  const cases = [0, NaN, 'not a number'];
  for (const dampingPower of cases) {
    const result = applyDelta(start, 1, 'x', {
      maxDelta: 15,
      historySize: 10,
      now: OPTS.now,
      damping: true,
      dampingPower,
    });
    assert.equal(result.score, 60.4, `dampingPower ${dampingPower} should fall back to 1`);
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
  assert.equal(roundScore(undefined), 0);
});

// --- decayAffinity -----------------------------------------------------------
// Daily drift toward zero (relationships.decayPerDay / decayPower): per elapsed
// day the score loses decayPerDay * |score| * (|score| / 100) ** decayPower.

const DAY_MS = 24 * 60 * 60 * 1000;
const DECAY_T0 = Date.UTC(2026, 9, 1, 12, 0, 0);
const DECAY_CFG = { decayPerDay: 0.04, decayPower: 1 };

function stamped(score, at = DECAY_T0) {
  return { score, reason: 'r', history: [{ ts: 't', delta: 1 }], decayedAt: new Date(at).toISOString() };
}

test('decayAffinity: one day at 100 loses 4, at 64 about 1.64', () => {
  assert.equal(decayAffinity(stamped(100), DECAY_T0 + DAY_MS, DECAY_CFG).affinity.score, 96);
  assert.equal(decayAffinity(stamped(64), DECAY_T0 + DAY_MS, DECAY_CFG).affinity.score, 62.36);
});

test('decayAffinity: a negative score moves up toward zero by the same amount', () => {
  assert.equal(decayAffinity(stamped(-64), DECAY_T0 + DAY_MS, DECAY_CFG).affinity.score, -62.36);
});

test('decayAffinity: never crosses zero, even with a huge decayPerDay', () => {
  const up = decayAffinity(stamped(50), DECAY_T0 + 3 * DAY_MS, { decayPerDay: 5, decayPower: 1 });
  assert.equal(up.affinity.score, 0);
  const down = decayAffinity(stamped(-50), DECAY_T0 + 3 * DAY_MS, { decayPerDay: 5, decayPower: 1 });
  assert.equal(down.affinity.score, 0);
});

test('decayAffinity: several days apply one step per day, in order', () => {
  const { affinity, days } = decayAffinity(stamped(100), DECAY_T0 + 2 * DAY_MS, DECAY_CFG);
  assert.equal(days, 2);
  // 100 -> 96 -> 96 - 0.04 * 96 * 0.96 = 92.3136
  assert.equal(affinity.score, 92.31);
});

test('decayAffinity: missing or malformed decayedAt only stamps the baseline, the score stays', () => {
  for (const decayedAt of [undefined, 'not a date']) {
    const start = { score: 80, reason: 'r', history: [], decayedAt };
    const { affinity, days } = decayAffinity(start, DECAY_T0, DECAY_CFG);
    assert.equal(days, 0);
    assert.equal(affinity.score, 80);
    assert.equal(affinity.decayedAt, new Date(DECAY_T0).toISOString());
    assert.equal(affinity.reason, 'r');
  }
});

test('decayAffinity: only whole days apply, the remainder carries over to the next sweep', () => {
  const first = decayAffinity(stamped(100), DECAY_T0 + DAY_MS + 5 * 3600_000, DECAY_CFG);
  assert.equal(first.days, 1);
  assert.equal(first.affinity.decayedAt, new Date(DECAY_T0 + DAY_MS).toISOString(), 'advanced by exactly one day');
  const second = decayAffinity(first.affinity, DECAY_T0 + 2 * DAY_MS + 1000, DECAY_CFG);
  assert.equal(second.days, 1, 'the 5 leftover hours plus 19 more make the second day');
  assert.equal(second.affinity.decayedAt, new Date(DECAY_T0 + 2 * DAY_MS).toISOString());
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
  assert.equal(affinity.score, 0);
  assert.equal(affinity.decayedAt, new Date(DECAY_T0 + 3 * DAY_MS).toISOString());
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
    const { affinity } = decayAffinity(stamped(64), DECAY_T0 + DAY_MS, { decayPerDay: 0.04, decayPower });
    assert.equal(affinity.score, 62.36, `decayPower ${decayPower} should fall back to 1`);
  }
});

test('decayAffinity: decayPower 2 makes a middling score decay slower', () => {
  // 64 - 0.04 * 64 * 0.64 ** 2 = 62.951...
  const { affinity } = decayAffinity(stamped(64), DECAY_T0 + DAY_MS, { decayPerDay: 0.04, decayPower: 2 });
  assert.equal(affinity.score, 62.95);
});

test('decayAffinity: keeps reason and history untouched, adds no history entry', () => {
  const start = stamped(100);
  const { affinity } = decayAffinity(start, DECAY_T0 + DAY_MS, DECAY_CFG);
  assert.equal(affinity.reason, 'r');
  assert.deepEqual(affinity.history, start.history);
  assert.equal(start.score, 100, 'the input is not mutated');
});

test('decayAffinity: the loop is capped (3650 days) and the stamp advances only by the days applied', () => {
  const start = stamped(100, DECAY_T0 - 5000 * DAY_MS);
  const { days, affinity } = decayAffinity(start, DECAY_T0, DECAY_CFG);
  assert.equal(days, 3650);
  assert.equal(affinity.decayedAt, new Date(DECAY_T0 - 1350 * DAY_MS).toISOString());
});

test('applyDelta: keeps decayedAt when it folds a delta', () => {
  const start = stamped(10);
  const result = applyDelta(start, 5, 'x', { maxDelta: 15, historySize: 10, now: DECAY_T0 });
  assert.equal(result.score, 15);
  assert.equal(result.decayedAt, start.decayedAt);
});

// --- bandGap / relationshipStaleOf: when the relationship text is due --------

test('bandGap: 0 inside the band, the distance to the nearest edge outside', () => {
  for (const [score, band] of BAND_CASES) assert.equal(bandGap(score, band), 0, `${score} sits in ${band}`);
  assert.equal(bandGap(64, 'fond'), 4);
  assert.equal(bandGap(20, 'fond'), 5);
  assert.equal(bandGap(-30, 'neutral'), 22);
  assert.equal(bandGap(-70, 'dislike'), 10);
  assert.equal(bandGap(61.5, 'fond'), 1.5);
  assert.equal(bandGap(60, 'fond'), 0, 'the first point past an edge is still 0 away from it');
  assert.equal(bandGap(-8, 'neutral'), 0);
  assert.equal(bandGap(-100, 'devoted'), 160);
});

test('bandGap: an unknown band or a score that is not a number gives 0', () => {
  assert.equal(bandGap(50, 'adoring'), 0);
  assert.equal(bandGap(NaN, 'fond'), 0);
});

const WRITTEN_MS = Date.UTC(2026, 9, 1, 12, 0, 0);
const WRITTEN_AT = new Date(WRITTEN_MS).toISOString();

/** A stored attitude history of `count` moves, the first `before` of them stamped before the text was written. */
function movesAround(count, before = 0) {
  return Array.from({ length: count }, (_, i) => ({
    ts: new Date(WRITTEN_MS + (i < before ? -(before - i) : i - before + 1) * 3600_000).toISOString(),
    delta: 1,
    appliedDelta: 1,
    score: i,
    reason: 'μια κουβέντα',
  }));
}

/** A view of a member with a written text, overriding any field. */
function writtenView(overrides = {}) {
  return {
    text: 'Φίλοι από παλιά.',
    score: 30,
    writtenScore: 30,
    writtenAt: WRITTEN_AT,
    history: [],
    hasReason: true,
    hasEpisodes: true,
    ...overrides,
  };
}

const STALE_CFG = { rewriteOnBandChange: true, bandHysteresis: 2, rewriteOnDrift: 8, rewriteAfterMoves: 6 };

test('relationshipStaleOf: a band change inside the hysteresis margin is not flagged, past it is cause band', () => {
  // Written at 59 (fond); 61 is devoted, but only 1 point past the edge at 60.
  assert.equal(relationshipStaleOf(writtenView({ writtenScore: 59, score: 61 }), STALE_CFG), null);
  assert.deepEqual(relationshipStaleOf(writtenView({ writtenScore: 59, score: 62 }), STALE_CFG), {
    writtenAt: 'fond',
    now: 'devoted',
    cause: 'band',
  });
  // Downward the same: written at 9 (warm), 7 is neutral but 1 point under the edge at 8.
  assert.equal(relationshipStaleOf(writtenView({ writtenScore: 9, score: 7 }), STALE_CFG), null);
  assert.deepEqual(relationshipStaleOf(writtenView({ writtenScore: 9, score: 6 }), STALE_CFG), {
    writtenAt: 'warm',
    now: 'neutral',
    cause: 'band',
  });
});

test('relationshipStaleOf: back and forth across one edge is never flagged inside the margin', () => {
  // Written at 7.5 (neutral); the score wanders 8.5, 7, 9.9, 6.5: each is under 2 points from 8.
  for (const score of [8.5, 6.5]) {
    assert.equal(relationshipStaleOf(writtenView({ writtenScore: 7.5, score }), STALE_CFG), null, `score ${score}`);
  }
});

test('relationshipStaleOf: bandHysteresis 0 flags a band change at the edge itself, as before the margin existed', () => {
  const cfg = { ...STALE_CFG, bandHysteresis: 0 };
  assert.deepEqual(relationshipStaleOf(writtenView({ writtenScore: 59, score: 60 }), cfg), {
    writtenAt: 'fond',
    now: 'devoted',
    cause: 'band',
  });
});

test('relationshipStaleOf: a drift of rewriteOnDrift points inside one band is cause drift', () => {
  assert.equal(relationshipStaleOf(writtenView({ writtenScore: 26, score: 33.99 }), STALE_CFG), null, '7.99 points');
  assert.deepEqual(relationshipStaleOf(writtenView({ writtenScore: 26, score: 34 }), STALE_CFG), {
    writtenAt: 'fond',
    now: 'fond',
    cause: 'drift',
  });
  assert.deepEqual(
    relationshipStaleOf(writtenView({ writtenScore: 59, score: 51 }), STALE_CFG),
    { writtenAt: 'fond', now: 'fond', cause: 'drift' },
    'downward too'
  );
  // Inside the band margin a move of 8 points can still cross an edge: drift names it.
  assert.deepEqual(relationshipStaleOf(writtenView({ writtenScore: 0, score: 8.5 }), STALE_CFG), {
    writtenAt: 'neutral',
    now: 'warm',
    cause: 'drift',
  });
});

test('relationshipStaleOf: band wins over drift and moves when several apply', () => {
  const view = writtenView({ writtenScore: 26, score: 64, history: movesAround(8) });
  assert.equal(relationshipStaleOf(view, STALE_CFG).cause, 'band');
  assert.equal(relationshipStaleOf({ ...view, score: 40 }, STALE_CFG).cause, 'drift');
});

test('relationshipStaleOf: rewriteAfterMoves moves since the text was written is cause moves; no stamp counts the whole history', () => {
  assert.equal(
    relationshipStaleOf(writtenView({ history: movesAround(5) }), STALE_CFG),
    null,
    '5 moves since the text'
  );
  assert.deepEqual(relationshipStaleOf(writtenView({ history: movesAround(6) }), STALE_CFG), {
    writtenAt: 'fond',
    now: 'fond',
    cause: 'moves',
  });
  assert.equal(
    relationshipStaleOf(writtenView({ history: movesAround(9, 4) }), STALE_CFG),
    null,
    'only the 5 moves after the stamp count'
  );
  assert.equal(
    relationshipStaleOf(writtenView({ history: movesAround(10, 4) }), STALE_CFG).cause,
    'moves',
    '6 after the stamp'
  );

  const unstamped = writtenView({ writtenAt: undefined, history: movesAround(6, 6) });
  assert.equal(relationshipStaleOf(unstamped, STALE_CFG).cause, 'moves', 'no stamp: every stored move counts');
  assert.equal(
    relationshipStaleOf({ ...unstamped, writtenAt: 'not a date' }, STALE_CFG).cause,
    'moves',
    'an unreadable stamp counts as none'
  );
  assert.equal(relationshipStaleOf({ ...unstamped, history: movesAround(5, 5) }, STALE_CFG), null);
});

test('relationshipStaleOf: a move stamped at the moment the text was written is not a move since it', () => {
  const sameBatch = [{ ts: WRITTEN_AT, delta: 3, appliedDelta: 3, score: 30, reason: 'ίδια παρτίδα' }];
  const history = [...sameBatch, ...movesAround(5)];
  assert.equal(relationshipStaleOf(writtenView({ history }), STALE_CFG), null);
  const unreadable = [...movesAround(5), { ts: 'ποτέ', delta: 1 }, null];
  assert.equal(
    relationshipStaleOf(writtenView({ history: unreadable }), STALE_CFG),
    null,
    'a move with no readable time never counts'
  );
});

test('relationshipStaleOf: zeros switch drift and moves off, rewriteOnBandChange false switches band off', () => {
  const drifted = writtenView({ writtenScore: 26, score: 50 });
  assert.equal(relationshipStaleOf(drifted, { ...STALE_CFG, rewriteOnDrift: 0 }), null);
  const moved = writtenView({ history: movesAround(10) });
  assert.equal(relationshipStaleOf(moved, { ...STALE_CFG, rewriteAfterMoves: 0 }), null);
  const banded = writtenView({ writtenScore: 26, score: 64 });
  assert.equal(relationshipStaleOf(banded, { ...STALE_CFG, rewriteOnBandChange: false, rewriteOnDrift: 0 }), null);
  assert.equal(
    relationshipStaleOf(banded, { ...STALE_CFG, rewriteOnBandChange: false }).cause,
    'drift',
    'the switch reaches only band (and first)'
  );
});

test('relationshipStaleOf: rewriteOnBandChange false keeps the first marker off too, as it always did', () => {
  const empty = { text: '', score: 40, writtenScore: undefined, history: [], hasReason: true, hasEpisodes: true };
  assert.equal(relationshipStaleOf(empty, { ...STALE_CFG, rewriteOnBandChange: false }), null);
});

test('relationshipStaleOf: an empty text with a score, reason or episodes is cause first', () => {
  const empty = { text: '  ', score: 0, history: movesAround(8), hasReason: false, hasEpisodes: false };
  assert.equal(
    relationshipStaleOf(empty, STALE_CFG),
    null,
    'nothing to write a first version from; moves never apply to no text'
  );
  assert.deepEqual(relationshipStaleOf({ ...empty, score: 30 }, STALE_CFG), {
    writtenAt: 'none',
    now: 'fond',
    cause: 'first',
  });
  assert.deepEqual(relationshipStaleOf({ ...empty, hasReason: true }, STALE_CFG), {
    writtenAt: 'none',
    now: 'neutral',
    cause: 'first',
  });
  assert.deepEqual(relationshipStaleOf({ ...empty, hasEpisodes: true }, STALE_CFG), {
    writtenAt: 'none',
    now: 'neutral',
    cause: 'first',
  });
  assert.deepEqual(relationshipStaleOf({ ...empty, text: undefined, score: -12 }, STALE_CFG), {
    writtenAt: 'none',
    now: 'cool',
    cause: 'first',
  });
});

test('relationshipStaleOf: a missing relationshipScore counts as 0, a missing score as 0', () => {
  assert.deepEqual(relationshipStaleOf(writtenView({ writtenScore: undefined, score: 30 }), STALE_CFG), {
    writtenAt: 'neutral',
    now: 'fond',
    cause: 'band',
  });
  assert.equal(relationshipStaleOf(writtenView({ writtenScore: undefined, score: undefined }), STALE_CFG), null);
});

test('relationshipStaleOf: missing or unusable settings behave as RELATIONSHIP_STALE_DEFAULTS', () => {
  const defaults = { rewriteOnBandChange: true, ...RELATIONSHIP_STALE_DEFAULTS };
  const views = [
    writtenView({ writtenScore: 59, score: 61 }),
    writtenView({ writtenScore: 59, score: 62 }),
    writtenView({ writtenScore: 26, score: 34 }),
    writtenView({ history: movesAround(5) }),
    writtenView({ history: movesAround(6) }),
  ];
  for (const cfg of [
    undefined,
    {},
    { rewriteOnBandChange: 'yes', bandHysteresis: -1, rewriteOnDrift: 'x', rewriteAfterMoves: NaN },
  ]) {
    for (const view of views) assert.deepEqual(relationshipStaleOf(view, cfg), relationshipStaleOf(view, defaults));
  }
});

test('relationshipStaleOf: an empty history never flags moves, stamped or not', () => {
  const unstamped = writtenView({ writtenAt: undefined, history: [] });
  assert.equal(relationshipStaleOf(unstamped, { ...STALE_CFG, rewriteAfterMoves: 1 }), null);
  assert.equal(relationshipStaleOf(writtenView({ history: [] }), { ...STALE_CFG, rewriteAfterMoves: 1 }), null);
  assert.equal(relationshipStaleOf(writtenView({ history: undefined }), { ...STALE_CFG, rewriteAfterMoves: 1 }), null);
});

test('relationshipStaleOf: now is the band of the current score for drift and moves too, even across an edge', () => {
  // Written at 53 (fond), now 61 (devoted): 1 point past the edge, inside the margin, so not
  // band; 8 points of drift. `now` names where the score is, the band the request shows.
  assert.deepEqual(relationshipStaleOf(writtenView({ writtenScore: 53, score: 61 }), STALE_CFG), {
    writtenAt: 'fond',
    now: 'devoted',
    cause: 'drift',
  });
  assert.deepEqual(
    relationshipStaleOf(writtenView({ writtenScore: 59, score: 61, history: movesAround(6) }), STALE_CFG),
    {
      writtenAt: 'fond',
      now: 'devoted',
      cause: 'moves',
    }
  );
  assert.deepEqual(
    relationshipStaleOf(writtenView({ writtenScore: 26, score: 64 }), { ...STALE_CFG, rewriteOnBandChange: false }),
    {
      writtenAt: 'fond',
      now: 'devoted',
      cause: 'drift',
    }
  );
});

// --- strongestMoves --------------------------------------------------------

/** One stored history move, `day` days into 2026-03. */
function move(day, delta, reason, appliedDelta = delta) {
  return { ts: new Date(Date.UTC(2026, 2, day, 12)).toISOString(), delta, appliedDelta, score: 0, reason };
}

test('strongestMoves: the strongest by |appliedDelta| are chosen and returned oldest first', () => {
  const history = [move(1, 2, 'α'), move(2, 6, 'β'), move(3, 1, 'γ'), move(4, 4, 'δ')];
  assert.deepEqual(
    strongestMoves(history, { max: 2 }).map((m) => m.reason),
    ['β', 'δ']
  );
});

test('strongestMoves: a missing appliedDelta falls back to |delta|', () => {
  const history = [{ ...move(1, 9, 'α'), appliedDelta: undefined }, move(2, 3, 'β')];
  assert.deepEqual(
    strongestMoves(history, { max: 1 }).map((m) => m.reason),
    ['α']
  );
});

test('strongestMoves: an equal strength goes to the newer move', () => {
  const history = [move(1, 3, 'α'), move(2, 3, 'β'), move(3, 3, 'γ')];
  assert.deepEqual(
    strongestMoves(history, { max: 2 }).map((m) => m.reason),
    ['β', 'γ']
  );
});

test('strongestMoves: both signs are kept when both exist and the cap allows', () => {
  const history = [move(1, -1, 'neg'), move(2, 5, 'α'), move(3, 4, 'β'), move(4, 3, 'γ')];
  assert.deepEqual(
    strongestMoves(history, { max: 3 }).map((m) => m.reason),
    ['neg', 'α', 'β']
  );
  const negatives = [move(1, -5, 'α'), move(2, -4, 'β'), move(3, 1, 'pos')];
  assert.deepEqual(
    strongestMoves(negatives, { max: 2 }).map((m) => m.reason),
    ['α', 'pos']
  );
});

test('strongestMoves: a cap of one keeps the single strongest, whatever its sign', () => {
  const history = [move(1, -1, 'neg'), move(2, 5, 'α')];
  assert.deepEqual(
    strongestMoves(history, { max: 1 }).map((m) => m.reason),
    ['α']
  );
});

test('strongestMoves: an empty reason and the current reason are skipped', () => {
  const history = [move(1, 9, ''), move(2, 8, '   '), move(3, 7, 'current'), move(4, 1, 'α')];
  assert.deepEqual(
    strongestMoves(history, { max: 4, currentReason: 'current' }).map((m) => m.reason),
    ['α']
  );
});

test('strongestMoves: a move with an unreadable time or no size is skipped', () => {
  const history = [{ ...move(1, 9, 'α'), ts: 'never' }, { ts: move(2, 0, '').ts, reason: 'β' }, move(3, 1, 'γ')];
  assert.deepEqual(
    strongestMoves(history, { max: 4 }).map((m) => m.reason),
    ['γ']
  );
});

test('strongestMoves: a cap of 0, a bad cap or no history chooses nothing', () => {
  const history = [move(1, 3, 'α')];
  for (const max of [0, -1, 1.5, undefined, 'x']) assert.deepEqual(strongestMoves(history, { max }), [], String(max));
  assert.deepEqual(strongestMoves(undefined, { max: 3 }), []);
  assert.deepEqual(strongestMoves([null, 'x'], { max: 3 }), []);
});

test('relationshipStaleOf: a flagged non-empty text is cause rewrite before band, drift and moves', () => {
  assert.deepEqual(relationshipStaleOf(writtenView({ rewrite: true }), STALE_CFG), {
    writtenAt: 'fond',
    now: 'fond',
    cause: 'rewrite',
  });
  // A band change, a drift and enough moves would each fire too: the flag still wins, bands as computed.
  assert.deepEqual(
    relationshipStaleOf(writtenView({ rewrite: true, writtenScore: 9, score: 70, history: movesAround(8) }), STALE_CFG),
    {
      writtenAt: 'warm',
      now: 'devoted',
      cause: 'rewrite',
    }
  );
  // Only `true` counts as the flag.
  assert.equal(relationshipStaleOf(writtenView({ rewrite: 'yes' }), STALE_CFG), null);
  assert.equal(relationshipStaleOf(writtenView({ rewrite: false }), STALE_CFG), null);
});

test('relationshipStaleOf: the rewrite flag on an empty text is ignored, the empty-text rules apply', () => {
  assert.deepEqual(relationshipStaleOf(writtenView({ text: '  ', rewrite: true }), STALE_CFG), {
    writtenAt: 'none',
    now: 'fond',
    cause: 'first',
  });
  assert.equal(relationshipStaleOf({ text: '', score: 0, rewrite: true }, STALE_CFG), null);
});

test('affinity: eviction returns the dropped items with their itemId', () => {
  const first = {
    ts: '2026-09-01T00:00:00.000Z',
    delta: 2,
    appliedDelta: 2,
    score: 2,
    reason: 'café',
    itemId: 'mv-first',
  };
  const second = {
    ts: '2026-09-02T00:00:00.000Z',
    delta: 1,
    appliedDelta: 1,
    score: 3,
    reason: 'σκάκι',
    itemId: 'mv-second',
  };
  const next = applyDelta({ score: 3, reason: 'σκάκι', history: [first, second] }, 2, 'τραγούδι', {
    maxDelta: 5,
    historySize: 2,
    now: Date.UTC(2026, 8, 3),
  });
  assert.deepEqual(
    next.history.map((move) => move.itemId),
    ['mv-second', undefined]
  );
  assert.deepEqual(next.droppedMoves, [first]);
  assert.deepEqual(Object.keys(next), ['score', 'reason', 'history'], 'droppedMoves is never stored');
  assert.equal(JSON.parse(JSON.stringify(next)).droppedMoves, undefined);
  const roomy = applyDelta({ score: 3, reason: '', history: [first] }, 1, '', { maxDelta: 5, historySize: 5 });
  assert.deepEqual(roomy.droppedMoves, []);
});

test('decayAffinity: time she was not running (skipMs) does not count; the stamp moves forward, never past now', () => {
  const day = 86_400_000;
  const stamp = Date.UTC(2026, 9, 1);
  const affinity = { score: 50, reason: 'r', history: [], decayedAt: new Date(stamp).toISOString() };
  const cfg = { decayPerDay: 0.04, decayPower: 1 };
  // A week passed, all of it downtime but one hour: nothing decays, the stamp moves by the downtime.
  const week = decayAffinity(affinity, stamp + 7 * day, { ...cfg, skipMs: 7 * day - 3_600_000 });
  assert.equal(week.days, 0);
  assert.equal(week.affinity.score, 50);
  assert.equal(week.affinity.decayedAt, new Date(stamp + 7 * day - 3_600_000).toISOString());
  // Three days passed, one of them downtime: two days decay.
  const three = decayAffinity(affinity, stamp + 3 * day, { ...cfg, skipMs: day });
  assert.equal(three.days, 2);
  assert.equal(three.affinity.score, decayAffinity(affinity, stamp + 2 * day, cfg).affinity.score);
  // A skip longer than the gap stops at now.
  const over = decayAffinity(affinity, stamp + day, { ...cfg, skipMs: 10 * day });
  assert.equal(over.days, 0);
  assert.equal(over.affinity.decayedAt, new Date(stamp + day).toISOString());
  // No skip: as before.
  assert.equal(decayAffinity(affinity, stamp + 3 * day, cfg).days, 3);
});
