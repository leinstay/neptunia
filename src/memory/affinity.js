// Pure logic for `features.relationships`: how much the persona likes or
// dislikes one member, on a -100 (can't stand them) .. 100 (adores them)
// scale, 0 = neutral. The memory-update analyzer is the only writer of a
// `delta`; this module clamps it, folds it into the stored score and keeps a
// short history of what moved it. Also used by `decideMention` to make the
// persona a little quicker to ignore someone it dislikes, a little slower to
// ignore someone it likes, and by the analyzer's request builder to decide
// when the stored relationship text no longer matches the score or was
// flagged for a forced rewrite (`relationshipStaleOf`). See
// docs/en/prompt-contract.md, "The analyzer".
// It is also the one home of the two attitude rules the two-stage analyzer
// (src/memory/voice.js) must apply as the store does: the reason's length
// (`REASON_CHARS`) and the reading of the delta cap (`deltaCapOf`).

import { clampText } from './clamp.js';
import { DAY_MS } from '../time.js';
import { sortByRank } from './ranking.js';
import { attachDropped } from './interests.js';

/** How long an attitude reason may be, in characters, before `memory.clampTolerance`. */
export const REASON_CHARS = 200;

/**
 * The size a delta is clamped to (`relationships.maxDeltaPerUpdate`, read by the caller): the
 * absolute value of a finite number, else Infinity -- a cap that is not a number caps nothing.
 * The caller applies its own fallback (config.json's 15) to a missing key before calling.
 * @param {unknown} maxDelta
 * @returns {number}
 */
export function deltaCapOf(maxDelta) {
  return Number.isFinite(maxDelta) ? Math.abs(maxDelta) : Infinity;
}

/** A member's attitude before anything has been observed about them. A stored affinity may also
 * carry `decayedAt` (ISO string, see `decayAffinity`); every function here keeps it. */
export function emptyAffinity() {
  return { score: 0, reason: '', history: [] };
}

/**
 * Which named band a score falls into. Thresholds are fixed in code (the
 * band NAMES are the writer's wording, via labels.affinity.bands.*):
 * <=-60 hostile · <=-25 dislike · <=-8 cool · <8 neutral · <25 warm · <60 fond · >=60 devoted.
 * @param {number} score
 * @returns {'hostile'|'dislike'|'cool'|'neutral'|'warm'|'fond'|'devoted'}
 */
export function affinityBand(score) {
  if (score <= -60) return 'hostile';
  if (score <= -25) return 'dislike';
  if (score <= -8) return 'cool';
  if (score < 8) return 'neutral';
  if (score < 25) return 'warm';
  if (score < 60) return 'fond';
  return 'devoted';
}

// Each band's lowest and highest edge, the thresholds of `affinityBand` above. Which side of an
// edge a score exactly on it belongs to is `affinityBand`'s business; to `bandGap` an edge value
// is 0 away from both bands that meet there.
const BAND_EDGES = Object.freeze({
  hostile: [-Infinity, -60],
  dislike: [-60, -25],
  cool: [-25, -8],
  neutral: [-8, 8],
  warm: [8, 25],
  fond: [25, 60],
  devoted: [60, Infinity],
});

/**
 * How far `score` lies outside `band`: 0 inside it (or exactly on one of its edges), else the
 * distance to the nearest edge, rounded to the stored precision (2 decimals). The edges are
 * `affinityBand`'s thresholds. An unknown band name or a score that is not a finite number gives
 * 0: no distance is measured, so nothing is ever flagged on it.
 * @param {number} score
 * @param {string} band  One of the names `affinityBand` returns.
 * @returns {number}
 */
export function bandGap(score, band) {
  const edges = Object.hasOwn(BAND_EDGES, band) ? BAND_EDGES[band] : null;
  if (!edges || !Number.isFinite(score)) return 0;
  const [low, high] = edges;
  if (score < low) return round2(low - score);
  if (score > high) return round2(score - high);
  return 0;
}

/**
 * Code fallbacks of the `relationships.*` keys `relationshipStaleOf` reads, equal to config.json:
 * `bandHysteresis` points past the old band's edge before a band change counts, `rewriteOnDrift`
 * score points since the text was written, `rewriteAfterMoves` attitude moves since then.
 */
export const RELATIONSHIP_STALE_DEFAULTS = Object.freeze({ bandHysteresis: 2, rewriteOnDrift: 8, rewriteAfterMoves: 6 });

/** A finite number of at least 0, else `fallback` (a missing or unusable setting). */
function settingOf(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
}

/** How many `history` moves are stamped strictly after `writtenAt` (an ISO string): every stored
 * move when the stamp is missing or unreadable. Either way a move whose own `ts` cannot be read
 * never counts. */
function movesSince(history, writtenAt) {
  const times = (Array.isArray(history) ? history : []).map((move) => Date.parse(move?.ts)).filter(Number.isFinite);
  const since = typeof writtenAt === 'string' ? Date.parse(writtenAt) : NaN;
  if (!Number.isFinite(since)) return times.length;
  return times.filter((ts) => ts > since).length;
}

/**
 * Whether a member's stored relationship text is due for a rewrite, and why: the
 * `relationshipStale` marker the analyzer sees (src/memory/update.js#buildMemoryRequest), or null.
 * First match wins:
 *   - `rewrite`: the text is non-empty and the profile is flagged for a forced rewrite
 *     (`view.rewrite === true`, the profile's `relationshipRewrite`, set by the owner): the stored
 *     text is rewritten to the current wording rules. It says nothing about the standing, so
 *     `writtenAt` and `now` are the bands as for every other cause, never adjusted. Not tied to
 *     `rewriteOnBandChange`; an empty text ignores the flag;
 *   - `first`: the text is empty and the profile has something a first version can be written
 *     from (a non-zero score, a reason, episodes). `writtenAt` is then `'none'`;
 *   - `band`: the score left the band the text was written in by at least `bandHysteresis` points
 *     past that band's edge (`bandGap`), so a score wandering back and forth across one edge does
 *     not flip the text each time; 0 = any band change counts;
 *   - `drift`: the score moved `rewriteOnDrift` points or more since the text was written, inside
 *     one band or not (0 = off);
 *   - `moves`: `rewriteAfterMoves` attitude moves or more are stamped after the text was written
 *     (`writtenAt`); with no readable stamp every stored move counts (0 = off). A move whose own
 *     `ts` cannot be read never counts. The history keeps `relationships.historySize` moves, so a
 *     larger number never fires. A move stamped at the very moment of writing (the batch that
 *     wrote the text) is not counted.
 * `now` is always the band of `score`, the band the request shows as `affinity.band`. So a
 * `drift` or `moves` marker can carry two different bands: a crossing still inside
 * `bandHysteresis`, or `rewriteOnBandChange` off.
 * `rewriteOnBandChange: false` turns off `band` AND `first`, the reach that switch always had;
 * `drift` and `moves` have their own 0.
 * A private view (src/memory/update.js#analyzePrivate) passes the effective score and the private
 * layer's OWN history, stamped on the private batch clock like its `relationshipWrittenAt`: the
 * private text counts its own moves, while a public move reaches it only through the effective
 * score (`band`, `drift`).
 * @param {{ text?: string, score?: number, writtenScore?: number, writtenAt?: string,
 *   history?: object[], hasReason?: boolean, hasEpisodes?: boolean, rewrite?: boolean }} view
 *   `text`: the stored relationship text; `score`: the current (precise) score, missing = 0;
 *   `writtenScore`: `relationshipScore`, the score the text was written at, missing = 0;
 *   `writtenAt`: `relationshipWrittenAt`, when it was written (ISO); `history`: `affinity.history`
 *   (entries with an ISO `ts`); `hasReason` / `hasEpisodes`: the profile has a reason / episodes;
 *   `rewrite`: the profile is flagged for a forced rewrite (only `true` counts).
 * @param {{ rewriteOnBandChange?: boolean, bandHysteresis?: number, rewriteOnDrift?: number,
 *   rewriteAfterMoves?: number }} [cfg]  `config.relationships`, read by the caller at the moment
 *   of use. `rewriteOnBandChange` missing = on; a number missing or not a finite number of at
 *   least 0 falls back to RELATIONSHIP_STALE_DEFAULTS.
 * @returns {{ writtenAt: string, now: string, cause: 'rewrite'|'first'|'band'|'drift'|'moves' }|null}
 *   `writtenAt`: the band of `writtenScore` (or `'none'`), `now`: the band of `score`.
 */
export function relationshipStaleOf(view, cfg = {}) {
  const score = Number.isFinite(view?.score) ? view.score : 0;
  const now = affinityBand(score);
  const bandRule = cfg?.rewriteOnBandChange !== false;
  const text = typeof view?.text === 'string' ? view.text.trim() : '';
  if (!text) {
    if (!bandRule) return null;
    return score !== 0 || view?.hasReason || view?.hasEpisodes ? { writtenAt: 'none', now, cause: 'first' } : null;
  }

  const writtenScore = Number.isFinite(view?.writtenScore) ? view.writtenScore : 0;
  const writtenAt = affinityBand(writtenScore);
  const marker = (cause) => ({ writtenAt, now, cause });
  if (view?.rewrite === true) return marker('rewrite');
  const hysteresis = settingOf(cfg?.bandHysteresis, RELATIONSHIP_STALE_DEFAULTS.bandHysteresis);
  if (bandRule && writtenAt !== now && bandGap(score, writtenAt) >= hysteresis) return marker('band');
  const drift = settingOf(cfg?.rewriteOnDrift, RELATIONSHIP_STALE_DEFAULTS.rewriteOnDrift);
  if (drift > 0 && round2(Math.abs(score - writtenScore)) >= drift) return marker('drift');
  const moves = settingOf(cfg?.rewriteAfterMoves, RELATIONSHIP_STALE_DEFAULTS.rewriteAfterMoves);
  if (moves > 0 && movesSince(view?.history, view?.writtenAt) >= moves) return marker('moves');
  return null;
}

function normalizeAffinity(affinity) {
  const score = Number.isFinite(affinity?.score) ? affinity.score : 0;
  const reason = typeof affinity?.reason === 'string' ? affinity.reason : '';
  const history = Array.isArray(affinity?.history) ? affinity.history : [];
  return { score, reason, history };
}

function clamp(value, min, max) {
  return Math.min(max, Math.max(min, value));
}

/** Rounds to 2 decimal places -- the score's stored precision, see `applyDelta`. */
function round2(value) {
  return Math.round(value * 100) / 100;
}

/**
 * A score kept inside -100..100 and rounded to the stored precision (2
 * decimals) -- what `applyDelta` stores, for a caller that combines scores
 * (src/behavior/private.js#effectiveAffinity).
 * @param {number} value
 * @returns {number}
 */
export function clampScore(value) {
  return round2(clamp(value, -100, 100));
}

function sign(value) {
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
function dampedDelta(scoreBeforeDelta, delta, dampingPower) {
  if (delta === 0) return 0;
  const scoreSign = sign(scoreBeforeDelta);
  const movingAway = scoreSign !== 0 && scoreSign === sign(delta);
  if (!movingAway) return delta;
  const power = Number.isFinite(dampingPower) && dampingPower > 0 ? dampingPower : 1;
  return delta * (1 - Math.abs(scoreBeforeDelta) / 100) ** power;
}

/** How far one history move pushed the score: `appliedDelta`, falling back to `delta`; 0 when
 * neither is a finite number. Its sign is the move's direction. */
function moveSize(move) {
  if (Number.isFinite(move?.appliedDelta)) return move.appliedDelta;
  return Number.isFinite(move?.delta) ? move.delta : 0;
}

/**
 * Which of the stored attitude moves (`affinity.history`) the persona is shown as the "why" behind
 * its attitude, up to `max` of them, returned OLDEST first (the stored objects themselves).
 * Skipped: anything that is not an object, a move with an empty reason, a move whose reason equals
 * `currentReason` (the attitude line already shows that one), a move whose `ts` cannot be read and
 * a move of size 0. The rest are ranked by strength, `|appliedDelta|` (falling back to `|delta|`),
 * through the shared src/memory/ranking.js#sortByRank with no decay: the history only holds the
 * last `relationships.historySize` moves, so recency breaks a tie in strength (the newer move
 * wins) instead of weighing against it. With `max` of 2 or more and moves of both signs left, the
 * pick holds at least one of each: when the top `max` are all one sign, the weakest of them gives
 * way to the strongest move of the other sign. `max` not a non-negative integer counts as 0.
 * @param {object[]|undefined} history  `affinity.history`.
 * @param {{ max?: number, currentReason?: string }} [opts]
 * @returns {object[]}
 */
export function strongestMoves(history, { max, currentReason } = {}) {
  const cap = Number.isInteger(max) && max > 0 ? max : 0;
  if (cap === 0 || !Array.isArray(history)) return [];
  const current = typeof currentReason === 'string' ? currentReason.trim() : '';
  const candidates = [];
  history.forEach((move, index) => {
    if (!move || typeof move !== 'object') return;
    const reason = typeof move.reason === 'string' ? move.reason.trim() : '';
    if (!reason || reason === current) return;
    const ms = Date.parse(move.ts);
    const size = moveSize(move);
    if (!Number.isFinite(ms) || size === 0) return;
    candidates.push({ move, index, ms, sign: Math.sign(size), weight: Math.abs(size), lastSeen: move.ts });
  });
  const ranked = sortByRank(candidates);
  const chosen = ranked.slice(0, cap);
  if (cap >= 2 && chosen.every((c) => c.sign === chosen[0]?.sign)) {
    const other = ranked.find((c) => c.sign !== chosen[0]?.sign);
    if (other) chosen[chosen.length - 1] = other;
  }
  return chosen.sort((a, b) => a.ms - b.ms || a.index - b.index).map((c) => c.move);
}

/**
 * The stored score rounded to a whole number, for anything shown to the model or the owner --
 * the prompt's `{score}` label, `memory show`, `memory affinity`, the analyzer's view of
 * `<existing_profiles>`. `affinityBand` and `ignoreAdjustment` use the precise (unrounded) score
 * instead, so small movements keep telling members apart even once the integer display stalls.
 * @param {number} score
 * @returns {number}
 */
export function roundScore(score) {
  return Number.isFinite(score) ? Math.round(score) : 0;
}

/**
 * Fold one analyzer-provided delta into a stored affinity. Never throws, even
 * when `affinity` is undefined/malformed (a profile written before this
 * feature existed).
 *
 * @param {object} affinity           Current `{ score, reason, history }`, or malformed/undefined.
 * @param {number} delta              Raw delta from the model; coerced to an integer (unless `opts.truncate` is false).
 * @param {string} reason             One-line reason for this change, trimmed and clamped. The new
 *   history entry records it as given (`''` when there is none, e.g. a two-stage move whose
 *   reason the voice run fills in later through src/memory/store.js#fillAffinityReason). It also
 *   becomes `affinity.reason`; with none, `affinity.reason` keeps the previous one. The newest
 *   entry's reason is therefore not always the stored one: a reader that restores an earlier
 *   state from the history (src/mentor/moment.js#affinityBefore) has to look past the entries
 *   without a reason.
 * @param {object} opts
 * @param {number} opts.maxDelta      `delta` is clamped to +-`deltaCapOf(maxDelta)` BEFORE damping,
 *   and before it is applied.
 * @param {number} opts.historySize   History is trimmed to the last N entries.
 * @param {number} [opts.now]         Epoch ms for the history entry's timestamp.
 * @param {number} [opts.clampTolerance]  How far `reason` (free text) may run over its
 *   `REASON_CHARS` limit before being cut, at a clean boundary -- see src/memory/clamp.js.
 * @param {boolean} [opts.damping=false]  `relationships.damping`. When true, `dampedDelta` above
 *   decides how much of the (already clamped) delta actually lands; when false (or omitted), the
 *   whole clamped delta is applied, same as before this option existed.
 * @param {number} [opts.dampingPower=1]  `relationships.dampingPower`, only used when `damping`
 *   is true: raises the `(1 - |score| / 100)` factor to this power, steepening (>1) or flattening
 *   (<1) the curve. Not a positive finite number falls back to `1`.
 * @param {boolean} [opts.truncate=true]  Whether `delta` is truncated to an integer first -- the
 *   analyzer's contract is an integer delta. The owner's absolute `/nep memory affinity <user>
 *   <score>` needs the exact (possibly fractional, since a damped score itself carries two
 *   decimals) gap applied, so it passes `false`.
 * @returns {{ score: number, reason: string, history: object[] }} A NEW affinity object,
 *   or the (normalized) input unchanged when the score does not actually move. A new object
 *   carries the non-enumerable `droppedMoves` (src/memory/interests.js#attachDropped, so it is
 *   never stored): the history entries that fell off `historySize`, as stored (their `itemId`
 *   included), oldest first; `[]` when none fell. The unchanged input carries none (nothing fell).
 */
export function applyDelta(
  affinity,
  delta,
  reason,
  { maxDelta, historySize, now = Date.now(), clampTolerance, damping = false, dampingPower = 1, truncate = true } = {},
) {
  const base = normalizeAffinity(affinity);

  const numeric = Number(delta);
  let rawDelta = Number.isFinite(numeric) ? numeric : 0;
  if (truncate) rawDelta = Math.trunc(rawDelta);
  const cap = deltaCapOf(maxDelta);
  const clampedDelta = clamp(rawDelta, -cap, cap);

  const appliedRaw = damping ? dampedDelta(base.score, clampedDelta, dampingPower) : clampedDelta;
  const newScore = round2(clamp(base.score + appliedRaw, -100, 100));
  const appliedDelta = round2(newScore - base.score);
  if (appliedDelta === 0) return affinity && typeof affinity === 'object' && !Array.isArray(affinity) ? affinity : base;

  const trimmedReason = typeof reason === 'string' ? clampText(reason, REASON_CHARS, { tolerance: clampTolerance }) : '';
  const finalReason = trimmedReason || base.reason;

  // The entry is this move's own record: an earlier reason is never copied onto a move it did not cause.
  const entry = { ts: new Date(now).toISOString(), delta: clampedDelta, appliedDelta, score: newScore, reason: trimmedReason };
  const size = Number.isFinite(historySize) && historySize > 0 ? historySize : 0;
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
 * @param {object} affinity  Stored `{ score, reason, history, decayedAt? }`, or malformed/undefined.
 * @param {number} nowMs     Epoch milliseconds.
 * @param {{ decayPerDay?: number, decayPower?: number }} [cfg]  `config.relationships`.
 *   `decayPerDay` 0, missing or non-finite = off; `decayPower` not a positive finite number = 1.
 * @returns {{ affinity: object, days: number }}  `affinity` is the SAME object when nothing
 *   changes (off, less than a day elapsed, a stamp in the future); `days` = whole days applied.
 */
export function decayAffinity(affinity, nowMs, cfg = {}) {
  const rate = cfg?.decayPerDay;
  if (!Number.isFinite(rate) || rate <= 0 || !Number.isFinite(nowMs)) return { affinity, days: 0 };
  const power = Number.isFinite(cfg?.decayPower) && cfg.decayPower > 0 ? cfg.decayPower : 1;
  const extra = affinity && typeof affinity === 'object' && !Array.isArray(affinity) ? affinity : {};
  const base = { ...extra, ...normalizeAffinity(affinity) };

  const since = typeof base.decayedAt === 'string' ? Date.parse(base.decayedAt) : NaN;
  if (!Number.isFinite(since)) {
    return { affinity: { ...base, decayedAt: new Date(nowMs).toISOString() }, days: 0 };
  }

  const days = Math.min(MAX_DECAY_DAYS, Math.floor((nowMs - since) / DAY_MS));
  if (days < 1) return { affinity, days: 0 };

  let score = base.score;
  for (let i = 0; i < days && score !== 0; i += 1) {
    const magnitude = Math.min(100, Math.abs(score));
    const loss = rate * magnitude * (magnitude / 100) ** power;
    score = score > 0 ? Math.max(0, score - loss) : Math.min(0, score + loss);
  }

  // `|| 0` turns a rounded -0 into 0.
  return { affinity: { ...base, score: round2(score) || 0, decayedAt: new Date(since + days * DAY_MS).toISOString() }, days };
}

/**
 * Extra chance to ignore a call, driven by how the persona feels about the
 * caller: a disliked person is ignored a bit more (up to `+affinityIgnoreBonus`
 * at score -100), a liked person a bit less (up to `-affinityLikeBonus` at
 * score +100). 0 or a non-finite score changes nothing.
 * @param {number} score
 * @param {{ affinityIgnoreBonus: number, affinityLikeBonus: number }} cfg  config.mention
 */
export function ignoreAdjustment(score, cfg) {
  if (!Number.isFinite(score) || score === 0) return 0;
  const magnitude = Math.min(100, Math.abs(score)) / 100;
  return score < 0 ? cfg.affinityIgnoreBonus * magnitude : -cfg.affinityLikeBonus * magnitude;
}
