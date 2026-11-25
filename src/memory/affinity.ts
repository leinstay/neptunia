// Pure logic for `features.relationships`: how much the persona likes or dislikes one member, on a -100 (can't stand
// them) .. 100 (adores them) scale, 0 = neutral. A stored affinity is `{ score, reason, history }`; this module reads
// it, names its band, rounds it for display and lets it drift toward zero day by day (`decayAffinity`).

import { DAY_MS } from '../time.ts';
import { isFiniteNumber } from './types.ts';
import type { Untyped } from './types.ts';

/** A member's attitude before anything has been observed about them. A stored affinity may also
 * carry `decayedAt` (ISO string, see `decayAffinity`); every function here keeps it. */
export function emptyAffinity(): { score: number; reason: string; history: Array<object> } {
  return { score: 0, reason: '', history: [] };
}

/**
 * Which named band a score falls into. Thresholds are fixed in code (the
 * band NAMES are the writer's wording, via labels.affinity.bands.*):
 * <=-60 hostile · <=-25 dislike · <=-8 cool · <8 neutral · <25 warm · <60 fond · >=60 devoted.
 */
export function affinityBand(score: number): 'hostile' | 'dislike' | 'cool' | 'neutral' | 'warm' | 'fond' | 'devoted' {
  if (score <= -60) return 'hostile';
  if (score <= -25) return 'dislike';
  if (score <= -8) return 'cool';
  if (score < 8) return 'neutral';
  if (score < 25) return 'warm';
  if (score < 60) return 'fond';
  return 'devoted';
}

function normalizeAffinity(affinity: Untyped) {
  const score = isFiniteNumber(affinity?.score) ? affinity.score : 0;
  const reason = typeof affinity?.reason === 'string' ? affinity.reason : '';
  const history = Array.isArray(affinity?.history) ? affinity.history : [];
  return { score, reason, history };
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}

/** Rounds to 2 decimal places, the score's stored precision. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * A score kept inside -100..100 and rounded to the stored precision (2
 * decimals), for a caller that combines scores
 * (src/behavior/private.js#effectiveAffinity).
 */
export function clampScore(value: number): number {
  return round2(clamp(value, -100, 100));
}

/**
 * The stored score rounded to a whole number, for anything shown to the model or a reader --
 * the prompt's `{score}` label, `memory show`, `memory affinity`, the analyzer's view of
 * `<existing_profiles>`. `affinityBand` and `ignoreAdjustment` use the precise (unrounded) score
 * instead, so small movements keep telling members apart even once the integer display stalls.
 */
export function roundScore(score: number): number {
  return isFiniteNumber(score) ? Math.round(score) : 0;
}

/** Upper bound on the days one `decayAffinity` call applies; the rest waits for the next sweep. */
const MAX_DECAY_DAYS = 3650;

/**
 * `relationships.decayPerDay` / `decayPower`: the daily drift of a score toward zero, stronger the
 * further it is from zero. Per whole day elapsed since `affinity.decayedAt` the score loses
 * `decayPerDay * |score| * (|score| / 100) ** decayPower`, never crossing zero; the result is
 * rounded to 2 decimals (the stored precision). `decayedAt` advances by exactly
 * the whole days applied, so the remainder carries over to the next call. No history entry is
 * written: history stays what the analyzer moved.
 *
 * A missing or malformed `decayedAt` is only stamped with `nowMs` (the first sweep sets the
 * baseline, nothing is applied retroactively). A score of 0 only moves the stamp.
 *
 * @param affinity  Stored `{ score, reason, history, decayedAt? }`, or malformed/undefined.
 * @param nowMs     Epoch milliseconds.
 * @param [cfg]  `config.relationships`.
 *   `decayPerDay` 0, missing or non-finite = off; `decayPower` not a positive finite number = 1; `skipMs` the time the
 *   persona was not running since the last sweep (index.js), which moves the stamp forward before any day is counted.
 * @returns `affinity` is the SAME object when nothing
 *   changes (off, less than a day elapsed, a stamp in the future); `days` = whole days applied.
 */
export function decayAffinity(
  affinity: Untyped,
  nowMs: number,
  cfg: { decayPerDay?: number; decayPower?: number; skipMs?: number } = {}
): { affinity: object; days: number } {
  const rate = cfg?.decayPerDay;
  if (!isFiniteNumber(rate) || rate <= 0 || !isFiniteNumber(nowMs)) return { affinity, days: 0 };
  const power = isFiniteNumber(cfg?.decayPower) && cfg.decayPower > 0 ? cfg.decayPower : 1;
  const extra = affinity && typeof affinity === 'object' && !Array.isArray(affinity) ? affinity : {};
  const base = { ...extra, ...normalizeAffinity(affinity) };

  const stamped = typeof base.decayedAt === 'string' ? Date.parse(base.decayedAt) : NaN;
  if (!isFiniteNumber(stamped)) {
    return { affinity: { ...base, decayedAt: new Date(nowMs).toISOString() }, days: 0 };
  }
  // Time the persona was not running does not count, since decay happens only while they are awake: `skipMs`, the
  // downtime since the last sweep, moves the stamp forward first, never past now.
  const skip = isFiniteNumber(cfg?.skipMs) && cfg.skipMs > 0 ? cfg.skipMs : 0;
  const since = skip > 0 ? Math.max(stamped, Math.min(nowMs, stamped + skip)) : stamped;

  const days = Math.min(MAX_DECAY_DAYS, Math.floor((nowMs - since) / DAY_MS));
  if (days < 1)
    return since === stamped
      ? { affinity, days: 0 }
      : { affinity: { ...base, decayedAt: new Date(since).toISOString() }, days: 0 };

  let score = base.score;
  for (let i = 0; i < days && score !== 0; i += 1) {
    const magnitude = Math.min(100, Math.abs(score));
    const loss = rate * magnitude * (magnitude / 100) ** power;
    score = score > 0 ? Math.max(0, score - loss) : Math.min(0, score + loss);
  }

  // `|| 0` turns a rounded -0 into 0.
  return {
    affinity: { ...base, score: round2(score) || 0, decayedAt: new Date(since + days * DAY_MS).toISOString() },
    days,
  };
}
