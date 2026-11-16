// Pure logic for `features.relationships`: how much the persona likes or
// dislikes one member, on a -100 (can't stand them) .. 100 (adores them)
// scale, 0 = neutral. The memory-update analyzer is the only writer of a
// `delta`; this module clamps it, folds it into the stored score and keeps a
// short history of what moved it. See docs/prompt-contract.md, "The analyzer".
// It is also the one home of two attitude rules: the reason's length
// (`REASON_CHARS`) and the reading of the delta cap (`deltaCapOf`).

import { clampText, stripUrls } from './clamp.ts';
import { DAY_MS } from '../time.ts';
import { attachDropped } from './interests.ts';
import { isFiniteNumber } from './types.ts';
import type { Untyped } from './types.ts';

/** How long an attitude reason may be, in characters, before `memory.clampTolerance`. */
export const REASON_CHARS = 200;

/**
 * The size a delta is clamped to (`relationships.maxDeltaPerUpdate`, read by the caller): the
 * absolute value of a finite number, else Infinity -- a cap that is not a number caps nothing.
 * The caller applies its own fallback (config.json's 15) to a missing key before calling.
 */
export function deltaCapOf(maxDelta: unknown): number {
  return isFiniteNumber(maxDelta) ? Math.abs(maxDelta) : Infinity;
}

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

/** Rounds to 2 decimal places -- the score's stored precision, see `applyDelta`. */
function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * A score kept inside -100..100 and rounded to the stored precision (2
 * decimals) -- what `applyDelta` stores, for a caller that combines scores
 * (src/behavior/private.js#effectiveAffinity).
 */
export function clampScore(value: number): number {
  return round2(clamp(value, -100, 100));
}

function sign(value: number): number {
  return value > 0 ? 1 : value < 0 ? -1 : 0;
}

/**
 * `relationships.damping`: a delta is scaled by `(1 - |score| / 100) ** dampingPower` when it
 * pushes the score further from zero, applied in full otherwise. "Further from zero" is decided
 * by the sign of the score BEFORE this delta -- so a delta that starts at 0, moves toward 0, or
 * crosses 0 is never damped, only one that pushes an already one-sided score further the same
 * way. `dampingPower` (`relationships.dampingPower`) steepens (>1) or flattens (<1) the curve;
 * not a positive finite number falls back to `1`, the plain `(1 - |score| / 100)` curve.
 */
function dampedDelta(scoreBeforeDelta: number, delta: number, dampingPower: unknown): number {
  if (delta === 0) return 0;
  const scoreSign = sign(scoreBeforeDelta);
  const movingAway = scoreSign !== 0 && scoreSign === sign(delta);
  if (!movingAway) return delta;
  const power = isFiniteNumber(dampingPower) && dampingPower > 0 ? dampingPower : 1;
  return delta * (1 - Math.abs(scoreBeforeDelta) / 100) ** power;
}

/**
 * The stored score rounded to a whole number, for anything shown to the model or the owner --
 * the prompt's `{score}` label, `memory show`, `memory affinity`, the analyzer's view of
 * `<existing_profiles>`. `affinityBand` and `ignoreAdjustment` use the precise (unrounded) score
 * instead, so small movements keep telling members apart even once the integer display stalls.
 */
export function roundScore(score: number): number {
  return isFiniteNumber(score) ? Math.round(score) : 0;
}

/**
 * Fold one analyzer-provided delta into a stored affinity. Never throws, even
 * when `affinity` is undefined/malformed (a profile written before this
 * feature existed).
 *
 * @param affinity           Current `{ score, reason, history }`, or malformed/undefined.
 * @param delta              Raw delta from the model; coerced to an integer (unless `opts.truncate` is false).
 * @param reason             One-line reason for this change, trimmed and clamped. The new
 *   history entry records it as given (`''` when there is none). It also
 *   becomes `affinity.reason`; with none, `affinity.reason` keeps the previous one. The newest
 *   entry's reason is therefore not always the stored one: a reader that restores an earlier
 *   state from the history (src/behavior/sandbox.js#momentView) has to look past the entries
 *   without a reason.
 * @param opts.maxDelta      `delta` is clamped to +-`deltaCapOf(maxDelta)` BEFORE damping,
 *   and before it is applied.
 * @param opts.historySize   History is trimmed to the last N entries.
 * @param [opts.now]         Epoch ms for the history entry's timestamp.
 * @param [opts.clampTolerance]  `reason` loses its links first (src/memory/clamp.ts#stripUrls).
 *   How far `reason` (free text) may run over its
 *   `REASON_CHARS` limit before being cut, at a clean boundary -- see src/memory/clamp.ts.
 * @param [opts.damping=false]  `relationships.damping`. When true, `dampedDelta` above
 *   decides how much of the (already clamped) delta actually lands; when false (or omitted), the
 *   whole clamped delta is applied, same as before this option existed.
 * @param [opts.dampingPower=1]  `relationships.dampingPower`, only used when `damping`
 *   is true: raises the `(1 - |score| / 100)` factor to this power, steepening (>1) or flattening
 *   (<1) the curve. Not a positive finite number falls back to `1`.
 * @param [opts.truncate=true]  Whether `delta` is truncated to an integer first -- the
 *   analyzer's contract is an integer delta. The owner's absolute `/nep memory affinity <user>
 *   <score>` needs the exact (possibly fractional, since a damped score itself carries two
 *   decimals) gap applied, so it passes `false`.
 * @returns A NEW affinity object,
 *   or the (normalized) input unchanged when the score does not actually move. A new object
 *   carries the non-enumerable `droppedMoves` (src/memory/interests.ts#attachDropped, so it is
 *   never stored): the history entries that fell off `historySize`, as stored (their `itemId`
 *   included), oldest first; `[]` when none fell. The unchanged input carries none (nothing fell).
 */
export function applyDelta(
  affinity: Untyped,
  delta: number,
  reason: string,
  {
    maxDelta,
    historySize,
    now = Date.now(),
    clampTolerance,
    damping = false,
    dampingPower = 1,
    truncate = true,
  }: {
    maxDelta: number;
    historySize: number;
    now?: number;
    clampTolerance?: number;
    damping?: boolean;
    dampingPower?: number;
    truncate?: boolean;
  }
): { score: number; reason: string; history: Array<object> } {
  const base = normalizeAffinity(affinity);

  const numeric = Number(delta);
  let rawDelta = isFiniteNumber(numeric) ? numeric : 0;
  if (truncate) rawDelta = Math.trunc(rawDelta);
  const cap = deltaCapOf(maxDelta);
  const clampedDelta = clamp(rawDelta, -cap, cap);

  const appliedRaw = damping ? dampedDelta(base.score, clampedDelta, dampingPower) : clampedDelta;
  const newScore = round2(clamp(base.score + appliedRaw, -100, 100));
  const appliedDelta = round2(newScore - base.score);
  if (appliedDelta === 0) return affinity && typeof affinity === 'object' && !Array.isArray(affinity) ? affinity : base;

  const trimmedReason =
    typeof reason === 'string' ? clampText(stripUrls(reason), REASON_CHARS, { tolerance: clampTolerance }) : '';
  const finalReason = trimmedReason || base.reason;

  // The entry is this move's own record: an earlier reason is never copied onto a move it did not cause.
  const entry = {
    ts: new Date(now).toISOString(),
    delta: clampedDelta,
    appliedDelta,
    score: newScore,
    reason: trimmedReason,
  };
  const size = isFiniteNumber(historySize) && historySize > 0 ? historySize : 0;
  const all = [...base.history, entry];
  const history = size > 0 ? all.slice(-size) : [];
  const droppedMoves = base.history.slice(0, all.length - history.length);

  // Any other stored field (`decayedAt`, see `decayAffinity`) rides along untouched.
  const extra = affinity && typeof affinity === 'object' && !Array.isArray(affinity) ? affinity : {};
  return attachDropped({ ...extra, score: newScore, reason: finalReason, history }, 'droppedMoves', droppedMoves);
}

/** Upper bound on the days one `decayAffinity` call applies; the rest waits for the next sweep. */
const MAX_DECAY_DAYS = 3650;

/**
 * `relationships.decayPerDay` / `decayPower`: the daily drift of a score toward zero, stronger the
 * further it is from zero. Per whole day elapsed since `affinity.decayedAt` the score loses
 * `decayPerDay * |score| * (|score| / 100) ** decayPower`, never crossing zero; the result is
 * rounded to 2 decimals (the stored precision, see `applyDelta`). `decayedAt` advances by exactly
 * the whole days applied, so the remainder carries over to the next call. No history entry is
 * written: history stays what the analyzer moved.
 *
 * A missing or malformed `decayedAt` is only stamped with `nowMs` (the first sweep sets the
 * baseline, nothing is applied retroactively). A score of 0 only moves the stamp.
 *
 * @param affinity  Stored `{ score, reason, history, decayedAt? }`, or malformed/undefined.
 * @param nowMs     Epoch milliseconds.
 * @param [cfg]  `config.relationships`.
 *   `decayPerDay` 0, missing or non-finite = off; `decayPower` not a positive finite number = 1; `skipMs` the time she was
 *   not running since the last sweep (index.js), which moves the stamp forward before any day is counted.
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
  // Time she was not running does not count (owner, 2026-10-24: decay happens only while she is awake): `skipMs`, the
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
