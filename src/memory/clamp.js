// Pure text clamping shared by every place the analyzer's free text is cut
// down to a configured limit (see docs/prompt-contract.md, "Limits
// are soft for the model, clean in code"). The model cannot count characters
// exactly and routinely overshoots a stated limit by 10-30%, and member
// mentions are `<@id>` tokens (20+ characters) that must never be split in
// half -- a blind `.slice(0, limit)` handles neither. `clampText` instead:
//
//   - lets a stored value overshoot the limit by up to `tolerance` (soft,
//     for prose the model wrote to a limit named in the prompt) before
//     touching it at all;
//   - once it must cut, prefers the end of the last complete sentence, then
//     the last whitespace, over a mid-word/mid-token cut;
//   - never splits a `<@digits>` mention token -- a token that straddles the
//     cut point is dropped whole, not chopped;
//   - counts length in Unicode code points, so a surrogate-pair emoji is
//     never split into two invalid halves;
//   - strips a trailing dangling opening bracket/quote or separator left
//     right at the new end, so a cut never reads as freshly broken.
//
// Identity-like short fields (an interest's `topic`, an alias `name`, a lore
// `title`/`key`) call this with `tolerance: 1` -- a HARD limit, still cut at
// a boundary and never inside a token, just with no overshoot allowed.
// `clampWithEllipsis` is that hard cut for display text, marked with `…`.
//
// Two blunt helpers live here too, for text that is not analyzer prose:
// `oneLine` (whitespace collapsed, so a value stays on its one line) and
// `clampChars` (a plain code-point cut, no boundary search); `clampAtBoundary`
// is the same limit with a sentence/word-boundary cut for free text sent on. `stripDashes` /
// `countDashes` clean em and en dashes out of the persona's outgoing text.

const SENTENCE_ENDERS = new Set(['.', '!', '?', '…']);
const SENTENCE_CLOSERS = new Set(['"', "'", '’', '”', ')', ']', '»']);
const STRIP_TRAILING = new Set([',', ';', ':', '-', '—', '(', '[', '«', '"']);
const SENTENCE_BOUNDARY_MIN_RATIO = 0.6;
const DEFAULT_TOLERANCE = 1.25;

function isWhitespace(ch) {
  return /\s/u.test(ch);
}

/** `tolerance` sanitized per the module contract: omitted -> the soft default
 * (1.25); given but not a finite number >= 1 -> 1 (a hard limit). */
function sanitizeTolerance(tolerance) {
  if (tolerance === undefined) return DEFAULT_TOLERANCE;
  const n = Number(tolerance);
  return Number.isFinite(n) && n >= 1 ? n : 1;
}

/** Code-point spans `[start, end)` of every `<@digits>` token in `codePoints`. */
function tokenSpans(codePoints) {
  const spans = [];
  let i = 0;
  while (i < codePoints.length) {
    if (codePoints[i] === '<' && codePoints[i + 1] === '@') {
      let j = i + 2;
      while (j < codePoints.length && /[0-9]/.test(codePoints[j])) j += 1;
      if (j > i + 2 && codePoints[j] === '>') {
        spans.push([i, j + 1]);
        i = j + 1;
        continue;
      }
    }
    i += 1;
  }
  return spans;
}

/** `index`, moved back to the start of any token span it falls strictly inside
 * (so the token is dropped whole rather than split). */
function avoidTokenSplit(index, spans) {
  for (const [start, end] of spans) {
    if (index > start && index < end) return start;
  }
  return index;
}

/** Repeatedly drop a trailing whitespace char or one of `STRIP_TRAILING` (a
 * dangling opening bracket/quote, or a separator left hanging at the cut). A
 * trailing `"` is ambiguous ASCII (it opens AND closes a quote) -- stripped
 * only when it is a dangling, unmatched opener (an odd number of `"` in the
 * text up to and including it); a `"` that legitimately closes a quote (an
 * even count) is kept. */
function stripTrailing(codePoints) {
  let end = codePoints.length;
  while (end > 0) {
    const ch = codePoints[end - 1];
    if (isWhitespace(ch)) {
      end -= 1;
      continue;
    }
    if (ch === '"') {
      const quoteCount = codePoints.slice(0, end).reduce((count, c) => count + (c === '"' ? 1 : 0), 0);
      if (quoteCount % 2 === 1) {
        end -= 1;
        continue;
      }
      break;
    }
    if (STRIP_TRAILING.has(ch)) {
      end -= 1;
      continue;
    }
    break;
  }
  return codePoints.slice(0, end).join('');
}

/**
 * Clamp `text` to at most `limit * tolerance` Unicode code points, cutting at
 * a clean boundary rather than mid-word/mid-token. See the module header for
 * the full rule. Non-string `text` -> `''`. A non-finite/non-positive `limit`
 * means no limit at all (the trimmed text is returned unchanged).
 * @param {string} text
 * @param {number} limit
 * @param {{ tolerance?: number }} [opts]
 * @returns {string}
 */
export function clampText(text, limit, { tolerance } = {}) {
  if (typeof text !== 'string') return '';
  const trimmed = text.trim();
  if (!trimmed) return '';

  const numericLimit = Number(limit);
  if (!Number.isFinite(numericLimit) || numericLimit <= 0) return trimmed;

  const tol = sanitizeTolerance(tolerance);
  const maxAllowed = Math.floor(numericLimit * tol);
  if (maxAllowed <= 0) return '';

  const codePoints = Array.from(trimmed);
  if (codePoints.length <= maxAllowed) return trimmed;

  const spans = tokenSpans(codePoints);
  const window = codePoints.slice(0, maxAllowed);

  // 1. The end of the last complete sentence (with an optional trailing
  // closing quote/bracket), when that keeps at least 60% of the allowed length.
  let sentenceCut = -1;
  for (let i = 0; i < window.length; i += 1) {
    if (!SENTENCE_ENDERS.has(window[i])) continue;
    let end = i + 1;
    while (end < window.length && SENTENCE_ENDERS.has(window[end])) end += 1;
    if (end < window.length && SENTENCE_CLOSERS.has(window[end])) end += 1;
    sentenceCut = end;
  }

  let cut;
  if (sentenceCut !== -1 && sentenceCut >= maxAllowed * SENTENCE_BOUNDARY_MIN_RATIO) {
    cut = sentenceCut;
  } else {
    // 2. The last whitespace at or before the allowed length -- checking one
    // code point past the window too, in case a whole word happens to end
    // exactly at the boundary (its trailing space sits just past `maxAllowed`).
    let lastSpace = -1;
    for (let i = Math.min(maxAllowed, codePoints.length - 1); i >= 0; i -= 1) {
      if (isWhitespace(codePoints[i])) {
        lastSpace = i;
        break;
      }
    }
    // 3. No boundary at all (a single very long word) -- a hard cut is the only option left.
    cut = lastSpace !== -1 ? lastSpace : maxAllowed;
  }

  cut = avoidTokenSplit(cut, spans);
  return stripTrailing(codePoints.slice(0, cut));
}

/**
 * `text` (trimmed) cut to at most `limit` code points with clampText as a hard
 * limit (`tolerance: 1`: a sentence end, else a word boundary, never inside a
 * token), and an ellipsis `…` appended when something was cut and the kept
 * part does not already end a sentence -- the ellipsis counts within `limit`.
 * For display text a reader must not take for whole (a list caption, a
 * quoted line). A `limit` below 2 is a plain clampText cut (no room for the
 * mark); a non-finite/non-positive `limit` leaves the text whole, as
 * clampText does. Non-string `text` -> `''`.
 * @param {string} text
 * @param {number} limit
 * @returns {string}
 */
export function clampWithEllipsis(text, limit) {
  if (typeof text !== 'string') return '';
  const trimmed = text.trim();
  const numericLimit = Math.floor(Number(limit));
  if (!Number.isFinite(numericLimit) || numericLimit <= 0) return trimmed;
  if (Array.from(trimmed).length <= numericLimit) return trimmed;
  if (numericLimit < 2) return clampText(trimmed, numericLimit, { tolerance: 1 });
  const cut = clampText(trimmed, numericLimit - 1, { tolerance: 1 });
  const points = Array.from(cut);
  let last = points.length - 1;
  while (last >= 0 && SENTENCE_CLOSERS.has(points[last])) last -= 1;
  return last >= 0 && SENTENCE_ENDERS.has(points[last]) ? cut : `${cut}…`;
}

// An em dash (U+2014) or en dash (U+2013); the hyphen (U+002D) is never one.
const DASH = /[–—]/gu;
// A run of dashes with the spaces/tabs around them (never a line break).
const DASH_RUN = /[^\S\n]*[–—](?:[^\S\n]*[–—])*[^\S\n]*/gu;
// Guillemets (U+00AB, U+00BB): typographic quotes nobody types in a chat.
const GUILLEMET = /[«»]/gu;

/**
 * `text` with every guillemet `«` `»` turned into a plain `"`, and without
 * any em dash `—` or en dash `–`: each run of them, with the
 * spaces around it, becomes one space, then each line that held one is
 * trimmed (a dash at a line's start or end goes with its space; a line of
 * dashes alone becomes empty) and the whole text is trimmed. Hyphens and line
 * breaks are untouched. Non-string `text` -> `''`. For the persona's outgoing
 * message text (src/behavior/turn.js, `format.stripDashes`).
 * @param {unknown} text
 * @returns {string}
 */
export function stripDashes(text) {
  if (typeof text !== 'string') return '';
  return text
    .replace(GUILLEMET, '"')
    .split('\n')
    .map((line) => (countDashes(line) > 0 ? line.replace(DASH_RUN, ' ').trim() : line))
    .join('\n')
    .trim();
}

/**
 * How many em/en dashes `text` holds (what stripDashes removes); 0 for a non-string.
 * @param {unknown} text
 * @returns {number}
 */
export function countDashes(text) {
  return typeof text === 'string' ? (text.match(DASH) ?? []).length : 0;
}

/**
 * `text` with every run of whitespace collapsed to one space and trimmed, so
 * it stays on one line. A null/undefined `text` reads as ''.
 * @param {unknown} text
 * @returns {string}
 */
export function oneLine(text) {
  return String(text ?? '')
    .replace(/\s+/gu, ' ')
    .trim();
}

/**
 * `text` cut to at most `max` code points at a clean boundary: the end of the
 * last sentence when it keeps at least 60% of `max`, else the last word
 * boundary, never inside a `<@id>` token or a surrogate pair. Text within the
 * limit is returned unchanged (untrimmed). A `max` that is not a finite
 * non-negative number leaves it whole; `0` gives ''. Non-string reads as ''.
 * For free text sent on (a drawing request) where a mid-word end would be read.
 * @param {unknown} text
 * @param {number} max
 * @returns {string}
 */
export function clampAtBoundary(text, max) {
  const value = String(text ?? '');
  if (!Number.isFinite(max) || max < 0) return value;
  const limit = Math.floor(max);
  if (limit === 0) return '';
  if (Array.from(value).length <= limit) return value;
  return clampText(value, limit, { tolerance: 1 });
}

/**
 * `text` cut to at most `max` code points (never inside a surrogate pair), with
 * no boundary search; a `max` that is not a finite non-negative number leaves
 * it whole. A null/undefined `text` reads as ''.
 * @param {unknown} text
 * @param {number} max
 * @returns {string}
 */
export function clampChars(text, max) {
  const value = String(text ?? '');
  return Number.isFinite(max) && max >= 0 ? [...value].slice(0, Math.floor(max)).join('') : value;
}
