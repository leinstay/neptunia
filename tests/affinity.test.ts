// Tests for src/memory/affinity.ts: pure attitude scoring for
// features.relationships (docs/prompt-contract.md, "The analyzer").
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  emptyAffinity,
  affinityBand,
  applyDelta,
  decayAffinity,
  roundScore,
  REASON_CHARS,
  deltaCapOf,
} from '../src/memory/affinity.ts';
import type { Untyped } from '../src/tools/types.ts';

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
  // @ts-expect-error: the test passes a value the signature refuses, to check how the function copes with a bad one
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
    // @ts-expect-error: the test passes a value the signature refuses, to check how the function copes with a bad one
    const result = applyDelta(start, 2, reason, OPTS);
    assert.equal(result.score, 7, String(reason));
    assert.equal(result.reason, 'παλιός λόγος', `${String(reason)}: the stored reason stays the last one given`);
    assert.equal(result.history.length, 2);
    assert.equal(loose(result.history[0]).reason, 'παλιός λόγος', 'an earlier entry is untouched');
    assert.deepEqual(
      result.history[1],
      { ts: new Date(OPTS.now).toISOString(), delta: 2, appliedDelta: 2, score: 7, reason: '' },
      String(reason)
    );
  }
  const given = applyDelta(start, -3, '  νέος λόγος  ', OPTS);
  assert.equal(given.reason, 'νέος λόγος');
  assert.equal(loose(given.history[1]).reason, 'νέος λόγος', 'a given reason is recorded trimmed');
});

test('REASON_CHARS: the limit applyDelta cuts a reason at, on the entry and the stored reason alike', () => {
  const result = applyDelta(undefined, 5, 'α'.repeat(1000), {
    maxDelta: 15,
    historySize: 10,
    now: OPTS.now,
    clampTolerance: 1,
  });
  assert.equal([...result.reason].length, REASON_CHARS);
  assert.equal(loose(result.history[0]).reason, result.reason);
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
    // @ts-expect-error: the test passes a value the signature refuses, to check how the function copes with a bad one
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
  assert.equal(loose(affinity.history.at(-1)).reason, 'step 14');
  assert.equal(affinity.score, 15);
});

test('applyDelta: tolerates a malformed/undefined affinity (a profile written before this feature)', () => {
  assert.equal(applyDelta(undefined, 5, 'x', OPTS).score, 5);
  assert.equal(applyDelta({ score: 'not a number' }, 5, 'x', OPTS).score, 5);
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
      // @ts-expect-error: the test passes a value the signature refuses, to check how the function copes with a bad one
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

test('applyDelta: keeps decayedAt when it folds a delta', () => {
  const start = stamped(10);
  const result = applyDelta(start, 5, 'x', { maxDelta: 15, historySize: 10, now: DECAY_T0 });
  assert.equal(result.score, 15);
  assert.equal(loose(result).decayedAt, start.decayedAt);
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
    next.history.map((move) => loose(move).itemId),
    ['mv-second', undefined]
  );
  assert.deepEqual(loose(next).droppedMoves, [first]);
  assert.deepEqual(Object.keys(next), ['score', 'reason', 'history'], 'droppedMoves is never stored');
  assert.equal(JSON.parse(JSON.stringify(next)).droppedMoves, undefined);
  const roomy = applyDelta({ score: 3, reason: '', history: [first] }, 1, '', { maxDelta: 5, historySize: 5 });
  assert.deepEqual(loose(roomy).droppedMoves, []);
});

test('decayAffinity: time she was not running (skipMs) does not count; the stamp moves forward, never past now', () => {
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
