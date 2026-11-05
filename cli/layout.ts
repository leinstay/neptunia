// Terminal geometry as pure functions: graphemes, cell widths, wrapping with offsets into the original text, the caret's
// cell, the composer's viewport and the transcript's budget. Fonts and pixels belong to the emulator, so everything here
// counts cells. cli/composer.ts, cli/transcript.ts, cli/mouse.ts and cli/chat-view.ts read it.

export type WrappedRow = { text: string; start: number; end: number };

const SEGMENTER = new Intl.Segmenter(undefined, { granularity: 'grapheme' });

// The ranges a terminal draws two cells wide: East Asian scripts, full-width forms and emoji that present as emoji.
// Half-width katakana (U+FF65 to U+FF9F) has Script=Katakana and stays one cell, so it is taken out first.
const HALF_WIDTH = /^[｡-ﾟﾠ-ￜ]/u;
const WIDE =
  /^[\p{Script=Han}\p{Script=Hiragana}\p{Script=Katakana}\p{Script=Hangul}\p{Emoji_Presentation}\p{Regional_Indicator}　-〿！-｠￠-￦]/u;
const ZERO_WIDTH = /^[\p{Mark}\p{Cf}\p{Cc}]/u;
const EMOJI_STYLE = '️';

/** The text as the eye counts it: a joined emoji or a letter with its accent is one item. */
export function graphemes(text: string): Array<string> {
  return Array.from(SEGMENTER.segment(text), (one) => one.segment);
}

function glyphWidth(glyph: string): number {
  if (ZERO_WIDTH.test(glyph)) return 0;
  if (HALF_WIDTH.test(glyph)) return 1;
  return WIDE.test(glyph) || glyph.includes(EMOJI_STYLE) ? 2 : 1;
}

/** How many cells the text takes on one row. */
export function cellWidth(text: string): number {
  let cells = 0;
  for (const glyph of graphemes(text)) cells += glyphWidth(glyph);
  return cells;
}

/** One explicit line broken into rows by a choice of where a full row ends. */
function wrapLine(
  line: string,
  offset: number,
  width: number,
  breakAt: (glyphs: ReadonlyArray<string>, upTo: number, from: number) => number
): Array<WrappedRow> {
  const glyphs = graphemes(line);
  const rows: Array<WrappedRow> = [];
  let from = 0;
  let cells = 0;
  let index = 0;
  let start = offset;
  while (index < glyphs.length) {
    const glyph = glyphs[index] ?? '';
    const cost = glyphWidth(glyph);
    if (cells + cost > width && index > from) {
      const end = breakAt(glyphs, index, from);
      const text = glyphs.slice(from, end).join('');
      rows.push({ text, start, end: start + text.length });
      start += text.length;
      from = end;
      index = end;
      cells = 0;
    } else {
      cells += cost;
      index += 1;
    }
  }
  const text = glyphs.slice(from).join('');
  rows.push({ text, start, end: start + text.length });
  return rows;
}

function wrapWith(
  text: string,
  width: number,
  breakAt: (glyphs: ReadonlyArray<string>, upTo: number, from: number) => number
): Array<WrappedRow> {
  const rows: Array<WrappedRow> = [];
  let offset = 0;
  for (const line of text.split('\n')) {
    rows.push(...wrapLine(line, offset, Math.max(1, width), breakAt));
    offset += line.length + 1;
  }
  return rows;
}

/**
 * Rows of at most `width` cells, cut between graphemes with explicit newlines kept as rows. Each row names its offsets in
 * the original text. A glyph wider than the width takes a row of its own.
 */
export function wrapCells(text: string, width: number): Array<WrappedRow> {
  return wrapWith(text, width, (_glyphs, upTo) => upTo);
}

/** The same rows for prose: a full row ends after its last space when it has one. */
export function wrapWords(text: string, width: number): Array<WrappedRow> {
  return wrapWith(text, width, (glyphs, upTo, from) => {
    for (let index = upTo; index > from + 1; index -= 1) if (glyphs[index - 1] === ' ') return index;
    return upTo;
  });
}

/** The cell the caret takes: after what precedes it, and on the next row when that row is full. */
export function caretCell(text: string, cursor: number, width: number): { row: number; col: number } {
  const rows = wrapCells(text, width);
  let row = 0;
  for (const [index, one] of rows.entries()) if (one.start <= cursor) row = index;
  const col = cellWidth(text.slice(rows[row]?.start ?? 0, cursor));
  return col >= Math.max(1, width) ? { row: row + 1, col: 0 } : { row, col };
}

/** Which rows of a tall draft show: the caret's row stays in view, and what is hidden is counted. */
export function composerViewport({
  rowCount,
  caretRow,
  maxRows,
}: {
  rowCount: number;
  caretRow: number;
  maxRows: number;
}): { first: number; rows: number; hiddenAbove: number; hiddenBelow: number } {
  const rows = Math.min(rowCount, Math.max(1, maxRows));
  const first = Math.max(0, Math.min(caretRow - rows + 1, rowCount - rows));
  return { first, rows, hiddenAbove: first, hiddenBelow: rowCount - first - rows };
}

/** What the fixed rows, the composer and the overlay leave for the transcript: `max(0, R - F - C - O)`. */
export function transcriptBudget({
  rows,
  fixed,
  composer,
  overlay,
}: {
  rows: number;
  fixed: number;
  composer: number;
  overlay: number;
}): number {
  return Math.max(0, rows - fixed - composer - overlay);
}
