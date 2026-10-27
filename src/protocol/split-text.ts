// Cuts a text into parts an adapter can post one by one when the platform limits a message. Every
// adapter shares it, so a long reply splits the same way everywhere: the parts join back to the
// input, none is longer than the limit in code points, and a cut avoids the inside of a character
// that looks like one (a grapheme) and of a `<...>` token such as a mention. Pure, no I/O.

// A mention or custom emoji markup is `<` to `>` with no space inside. The longest a chat platform writes is
// under this, and a longer run is ordinary text.
const TOKEN_MAX = 64;

const segmenter = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

// The positions (in code points) where a grapheme starts, plus the end of the text.
function graphemeBoundaries(text: string): Set<number> {
  const boundaries = new Set<number>([0]);
  let at = 0;
  for (const { segment } of segmenter.segment(text)) {
    at += Array.from(segment).length;
    boundaries.add(at);
  }
  return boundaries;
}

// The end of the token that opens at `open`, or -1 when none does.
function tokenEnd(chars: ReadonlyArray<string>, open: number): number {
  if (chars[open] !== '<') return -1;
  const last = Math.min(chars.length, open + TOKEN_MAX);
  for (let at = open + 1; at < last; at++) {
    const char = chars[at] ?? '';
    if (char === '>') return at + 1;
    if (char === '<' || /\s/.test(char)) return -1;
  }
  return -1;
}

// The start of the token that the cut at `cut` falls inside, or `cut` when it falls in none.
function tokenStartAround(chars: ReadonlyArray<string>, cut: number): number {
  for (let open = cut - 1; open > cut - TOKEN_MAX && open >= 0; open--) {
    if (tokenEnd(chars, open) > cut) return open;
  }
  return cut;
}

// Where the part that starts at `start` ends: after the last newline of the window, else after
// the last whitespace, else at the window's end, moved back out of a token and onto a grapheme
// boundary. A cut that would leave the part empty falls at the window's end.
function cutAfter(
  chars: ReadonlyArray<string>,
  start: number,
  maxChars: number,
  boundaries: ReadonlySet<number>
): number {
  const edge = start + maxChars;
  const window = chars.slice(start, edge);
  const newline = window.lastIndexOf('\n');
  const space = window.findLastIndex((char) => /\s/.test(char));
  const breakAt = newline >= 0 ? newline : space;
  if (breakAt >= 0) return start + breakAt + 1;
  let cut = tokenStartAround(chars, edge);
  while (cut > start && !boundaries.has(cut)) cut--;
  return cut > start ? cut : edge;
}

export function splitText(text: string, maxChars: number): Array<string> {
  if (!Number.isInteger(maxChars) || maxChars < 1) {
    throw new RangeError(`maxChars must be a positive integer, got ${maxChars}`);
  }
  const chars = Array.from(text);
  if (chars.length <= maxChars) return [text];
  const boundaries = graphemeBoundaries(text);
  const parts: Array<string> = [];
  let start = 0;
  while (chars.length - start > maxChars) {
    const cut = cutAfter(chars, start, maxChars, boundaries);
    parts.push(chars.slice(start, cut).join(''));
    start = cut;
  }
  parts.push(chars.slice(start).join(''));
  return parts;
}
