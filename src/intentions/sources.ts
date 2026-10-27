// Where a line of the persona's came from, for the injection guard of her intentions
// (docs/inner-life.md). A goal planted in a web page, a
// memory result or a tool's output can reach her own words -- she quotes or paraphrases it in a
// line of hers -- and then the analyzer's quote check (src/intentions/model.ts#candidatesFromAnswer)
// passes, because nobody else's line holds those words. So each line she posts is noted with what
// her turn had in front of it when she wrote it (`lineSourcesOf`):
//
// - `read`: her turn read outside material before the line went out -- a read call that returned
//   text (web.search, web.read, memory.search, errand.status, ...), a page read from a link, a web
//   lookup, an errand's result. A paraphrase cannot be traced by its words, so this alone makes a
//   candidate from that line `external`.
// - `overlap`: the word shingles of her line that also occur in the outside text of her turn
//   (someone's message she answered, the retrieved memory, those reads), hashed: no text is kept.
//   A candidate whose quoted span or purpose shares one is `external`.
// - `inner` and `chainId`: the line came from an inner turn of that causal chain.
//
// `externalOrigin` judges a candidate against its anchor line. A line marked `line.inner` (what
// her reads returned in an inner turn) is always outside material. Pure, except the small
// in-process registry (`createLineSources`) that holds the notes from her post for the candidates
// judged against it (src/intentions/service.ts#addCandidates).

/** Words per shingle. */
export const SHINGLE_WORDS = 3;
/** The most hashed shingles a line's note keeps. */
export const OVERLAP_MAX = 200;
/** The most characters of outside text one turn's note reads. */
export const SOURCE_CHARS_MAX = 60_000;
/** The notes the registry holds (the oldest dropped first). */
export const LINE_SOURCES_MAX = 500;

/** The words of `text`, accents folded and lower-cased (letters and digits only). */
export function wordsOf(text) {
  return String(text ?? '')
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .split(/[^\p{L}\p{N}]+/u)
    .filter(Boolean);
}

/** FNV-1a 32-bit of `text`, base 36. */
function hash(text) {
  let h = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 0x01000193) >>> 0;
  }
  return h.toString(36);
}

/** The hashed `SHINGLE_WORDS`-word shingles of `text` (none for a shorter text). */
export function shinglesOf(text) {
  const words = wordsOf(text);
  const out = new Set();
  for (let i = 0; i + SHINGLE_WORDS <= words.length; i += 1) out.add(hash(words.slice(i, i + SHINGLE_WORDS).join(' ')));
  return out;
}

/**
 * The string leaves of `value` (a text, an array, an object: an excerpt list, a lookup's answer,
 * an errand's result), at most `max` characters in all.
 */
export function textsOf(value, max = SOURCE_CHARS_MAX) {
  const out = [];
  let left = max;
  const walk = (item, depth) => {
    if (left <= 0 || depth > 6 || item === null || item === undefined) return;
    if (typeof item === 'string') {
      if (!item) return;
      const piece = item.slice(0, left);
      out.push(piece);
      left -= piece.length;
    } else if (item instanceof Map || item instanceof Set) {
      for (const entry of item.values()) walk(entry, depth + 1);
    } else if (Array.isArray(item)) {
      for (const entry of item) walk(entry, depth + 1);
    } else if (typeof item === 'object') {
      for (const entry of Object.values(item)) walk(entry, depth + 1);
    }
  };
  walk(value, 0);
  return out;
}

/**
 * The note of one line of hers: `text` as she posted it, `external` the outside texts her turn had
 * seen before it went out, `read` whether that included outside material (see the header), the
 * turn, and the inner turn's chain. Pure.
 * @param {{ text: string, external?: unknown, read?: boolean, turnId?: string|null, inner?: boolean, chainId?: string|null }} input
 * @returns {{ turnId: string|null, read?: true, inner?: true, chainId?: string, overlap?: string[] }}
 */
export function lineSourcesOf({ text, external = [], read = false, turnId = null, inner = false, chainId = null }) {
  const own = shinglesOf(text);
  const outside = new Set();
  for (const piece of textsOf(external)) for (const shingle of shinglesOf(piece)) outside.add(shingle);
  const overlap = [...own].filter((shingle) => outside.has(shingle)).slice(0, OVERLAP_MAX);
  return {
    turnId: typeof turnId === 'string' && turnId ? turnId : null,
    ...(read ? { read: true } : {}),
    ...(inner ? { inner: true, ...(typeof chainId === 'string' && chainId ? { chainId } : {}) } : {}),
    ...(overlap.length > 0 ? { overlap } : {}),
  };
}

/**
 * Why candidate `candidate` (`{ span, purpose }`) is not hers alone, judged on its anchor line
 * `line` (a buffered line of hers) and that line's note `sources` (lineSourcesOf's, or null when
 * none is known): `inner-finding` (a line marked `inner`), `read` (her turn read
 * outside material first), `overlap` (its span or purpose shares a shingle with outside text of
 * her turn), `unknown` (no note while `strict`: the turn that wrote the line is not known). Null
 * when it is her own. Pure.
 * @param {{ span: string, purpose: string }} candidate
 * @param {object} line
 * @param {object|null} sources
 * @param {{ strict?: boolean }} [options]
 * @returns {'inner-finding'|'read'|'overlap'|'unknown'|null}
 */
export function externalOrigin(candidate, line, sources, { strict = false } = {}) {
  if (line?.inner) return 'inner-finding';
  if (!sources || typeof sources !== 'object') return strict ? 'unknown' : null;
  if (sources.read === true) return 'read';
  const overlap = new Set(Array.isArray(sources.overlap) ? sources.overlap : []);
  if (overlap.size > 0) {
    for (const text of [candidate?.span, candidate?.purpose])
      for (const shingle of shinglesOf(text)) if (overlap.has(shingle)) return 'overlap';
  }
  return null;
}

/**
 * The notes of her recent lines by message id, in process, the oldest dropped past `max`: kept from
 * the moment a line is posted until the memory buffer takes it (and asked again by the analyzer's
 * candidates for a line the buffer took before its note was written).
 * @param {{ max?: number }} [options]
 */
export function createLineSources({ max = LINE_SOURCES_MAX } = {}) {
  const notes = new Map();
  return {
    note(messageId, sources) {
      if (typeof messageId !== 'string' || !messageId || !sources || typeof sources !== 'object') return;
      notes.delete(messageId);
      notes.set(messageId, sources);
      while (notes.size > max) notes.delete(notes.keys().next().value);
    },
    get(messageId) {
      return typeof messageId === 'string' ? (notes.get(messageId) ?? null) : null;
    },
    get size() {
      return notes.size;
    },
  };
}
