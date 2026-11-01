// The rule for stored prose that a model rewrites: a cut at the end of a merged
// text is the one guaranteed loss in the memory, so code may refuse a rewrite
// or keep the previous text, but never shortens one. Only a first write (the
// field was empty, nothing to lose yet) is clamped, as before. `sentenceDiff`
// counts kept / removed / added sentences between two versions: the canary for
// a silent loss (a rewrite that keeps none of the old sentences is a paraphrase).
// Pure: no I/O, no clock.

import { clampText } from './clamp.ts';
import { isFiniteNumber } from './types.ts';

const SENTENCE_SPLIT = /(?<=[.!?…])\s+/u;

function length(text: string): number {
  return [...text].length;
}

function isBlank(value: unknown): boolean {
  return typeof value !== 'string' || value.trim() === '';
}

function sentencesOf(text: unknown): Set<string> {
  const set = new Set<string>();
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
 * @param [opts] widens only a first write
 */
export function acceptProse(
  previous: string | undefined,
  next: unknown,
  limit: number,
  { tolerance }: { tolerance?: number } = {}
): { text: string; outcome: 'same' | 'first' | 'replaced' | 'over' | 'empty' } {
  const prev = typeof previous === 'string' ? previous : '';
  if (typeof next !== 'string' || isBlank(next)) return { text: prev, outcome: 'empty' };
  const trimmed = next.trim();
  if (trimmed === prev.trim()) return { text: prev, outcome: 'same' };
  if (isBlank(prev)) return { text: clampText(next, limit, { tolerance }), outcome: 'first' };
  const max = Number(limit);
  if (isFiniteNumber(max) && max > 0 && length(trimmed) > max) return { text: prev, outcome: 'over' };
  return { text: trimmed, outcome: 'replaced' };
}

/**
 * The string fields longer than their limit, in code points, for the
 * `<over_limit>` block. Fields without a finite limit are skipped.
 */
export function overLimitOf(
  fields: Record<string, unknown>,
  limits: Record<string, number>
): Record<string, { chars: number; limit: number }> {
  const out: Record<string, { chars: number; limit: number }> = {};
  for (const [field, value] of Object.entries(fields ?? {})) {
    const limit = limits?.[field];
    if (typeof value !== 'string' || typeof limit !== 'number' || !isFiniteNumber(limit)) continue;
    const chars = length(value);
    if (chars > limit) out[field] = { chars, limit };
  }
  return out;
}

/**
 * Sentence-level comparison of two texts (sets after whitespace
 * normalisation): how many sentences each has and how many were kept,
 * removed and added.
 */
export function sentenceDiff(
  before: string,
  after: string
): { before: number; after: number; kept: number; removed: number; added: number } {
  const a = sentencesOf(before);
  const b = sentencesOf(after);
  let kept = 0;
  for (const s of a) if (b.has(s)) kept += 1;
  return { before: a.size, after: b.size, kept, removed: a.size - kept, added: b.size - kept };
}
