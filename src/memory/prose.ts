// The rule for stored prose that a model rewrites: a cut at the end of a merged
// text is the one guaranteed loss in the memory, so code may refuse a rewrite
// or keep the previous text, but never shortens one. Only a first write (the
// field was empty, nothing to lose yet) is clamped, as before. `sentenceDiff`
// counts kept / removed / added sentences between two versions: the canary for
// a silent loss (a rewrite that keeps none of the old sentences is a paraphrase).
// Pure: no I/O, no clock.

const SENTENCE_SPLIT = /(?<=[.!?…])\s+/u;

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
