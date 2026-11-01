// The rule for stored prose that a model rewrites: a cut at the end of a merged
// text is the one guaranteed loss in the memory, so code may refuse a rewrite
// or keep the previous text, but never shortens one. Only a first write (the
// field was empty, nothing to lose yet) is clamped, as before. `sentenceDiff`
// counts kept / removed / added sentences between two versions: the canary for
// a silent loss (a rewrite that keeps none of the old sentences is a paraphrase).
// Pure: no I/O, no clock.

import { clampText } from './clamp.ts';

const SENTENCE_SPLIT = /(?<=[.!?…])\s+/u;

function length(text) {
  return [...text].length;
}

function isBlank(value) {
  return typeof value !== 'string' || value.trim() === '';
}

function sentencesOf(text) {
  const set = new Set();
  if (typeof text !== 'string') return set;
  for (const part of text.split(SENTENCE_SPLIT)) {
    const sentence = part.trim().replace(/\s+/gu, ' ');
    if (sentence) set.add(sentence);
  }
  return set;
}

/**
 * Decide what to store when a model returns `next` for a prose field holding
 * `previous`. A rewrite is never clamped: within `limit` it is taken as is,
 * over it the previous text stays. Only a first write is clamped.
 * Outcomes: `empty` (nothing said), `same`, `first`, `replaced`, `over`.
 * A `limit` that is not a finite number > 0 means no limit.
 * @param {string|undefined} previous
 * @param {unknown} next
 * @param {number} limit
 * @param {{ tolerance?: number }} [opts] widens only a first write
 * @returns {{ text: string, outcome: 'same'|'first'|'replaced'|'over'|'empty' }}
 */
export function acceptProse(previous, next, limit, { tolerance } = {}) {
  const prev = typeof previous === 'string' ? previous : '';
  if (isBlank(next)) return { text: prev, outcome: 'empty' };
  const trimmed = next.trim();
  if (trimmed === prev.trim()) return { text: prev, outcome: 'same' };
  if (isBlank(prev)) return { text: clampText(next, limit, { tolerance }), outcome: 'first' };
  const max = Number(limit);
  if (Number.isFinite(max) && max > 0 && length(trimmed) > max) return { text: prev, outcome: 'over' };
  return { text: trimmed, outcome: 'replaced' };
}

/**
 * The string fields longer than their limit, in code points, for the
 * `<over_limit>` block. Fields without a finite limit are skipped.
 * @param {Record<string, unknown>} fields
 * @param {Record<string, number>} limits
 * @returns {Record<string, { chars: number, limit: number }>}
 */
export function overLimitOf(fields, limits) {
  const out = {};
  for (const [field, value] of Object.entries(fields ?? {})) {
    const limit = limits?.[field];
    if (typeof value !== 'string' || !Number.isFinite(limit)) continue;
    const chars = length(value);
    if (chars > limit) out[field] = { chars, limit };
  }
  return out;
}

/**
 * Sentence-level comparison of two texts (sets after whitespace
 * normalisation): how many sentences each has and how many were kept,
 * removed and added.
 * @param {string} before
 * @param {string} after
 * @returns {{ before: number, after: number, kept: number, removed: number, added: number }}
 */
export function sentenceDiff(before, after) {
  const a = sentencesOf(before);
  const b = sentencesOf(after);
  let kept = 0;
  for (const s of a) if (b.has(s)) kept += 1;
  return { before: a.size, after: b.size, kept, removed: a.size - kept, added: b.size - kept };
}
