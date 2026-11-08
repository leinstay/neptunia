// The transcript as rows: each entry wrapped to the terminal's width and folded unless it is expanded, and the window of
// rows that fits the budget. Following the tail and reading further up are different views: an off-tail view is anchored
// to an entry and a row inside it, so new entries and a resize leave the reader where they are. An expanded last entry may
// go past the budget while the tail is followed. The rows of an entry are kept until its width or folding changes, so a
// keystroke in a long session stays cheap. cli/app.ts draws the window, and the full text stays in its entries.
import { cellWidth, wrapWords } from './layout.ts';
import { foldedText } from './state.ts';

/**
 * `lead` is a muted prefix on the entry's first row, such as `[2026-11-08 13:04] [#3] `. Every other row of the entry,
 * wrapped or after a newline, starts `indent` cells in, the width of the lead unless it says otherwise, so the text keeps
 * one column as Hermes draws its message bodies (ui-tui/src/components/messageLine.tsx).
 */
export type TranscriptEntry = { id: string; text: string; lead?: string; indent?: number };
export type RowBlock = 'plain' | 'code' | 'quote' | 'heading';
/**
 * `lead` counts the cells of the muted prefix the row starts with, and `pad` the blank cells a later row of an entry starts
 * with, which a copy leaves out.
 */
export type TranscriptRow = {
  entryId: string;
  text: string;
  kind: 'text' | 'fold';
  block: RowBlock;
  lead?: number;
  pad?: number;
};
export type TranscriptView = { kind: 'tail' } | { kind: 'anchor'; entryId: string; row: number };
export type TranscriptDims = { columns: number; budget: number; expanded: ReadonlySet<string>; foldLines: number };
export type TranscriptWindow = {
  rows: Array<TranscriptRow>;
  atTail: boolean;
  hiddenAbove: number;
  hiddenBelow: number;
};

export const TAIL: TranscriptView = { kind: 'tail' };

const TAB_STOP = 8;
// C0 and C1 controls but newline and tab, DEL, the directional overrides and marks, the line and paragraph separators.
// eslint-disable-next-line no-control-regex
const UNSAFE = /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u061c\u200e\u200f\u2028-\u202e\u2066-\u2069]/g;
const C0_PICTURES = 0x2400;
const DEL_PICTURE = '\u2421';
/** Drawn for a control with no picture of its own: one cell, so a caret offset means the same in the stored text. */
const NO_PICTURE = '\u2370';

/**
 * Text that is safe to write to a terminal, one visible character for each control. A stored escape can neither run nor
 * vanish unseen, and the original value stays with the caller for a lossless export.
 */
export function displaySafe(text: string): string {
  return text.replace(UNSAFE, (char) => {
    const code = char.charCodeAt(0);
    if (code < 0x20) return String.fromCharCode(C0_PICTURES + code);
    return code === 0x7f ? DEL_PICTURE : NO_PICTURE;
  });
}

/**
 * When a line was sent, as the date and the minute in `timeZone` (`2026-11-08 13:04`), the machine's own zone when it is
 * absent or unknown.
 */
export function lineTime(at: number, timeZone?: string): string {
  const options: Intl.DateTimeFormatOptions = {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hourCycle: 'h23',
  };
  let format: Intl.DateTimeFormat;
  try {
    format = new Intl.DateTimeFormat('en-US', { ...options, timeZone });
  } catch {
    format = new Intl.DateTimeFormat('en-US', options);
  }
  const part = Object.fromEntries(format.formatToParts(new Date(at)).map((one) => [one.type, one.value]));
  return `${part.year}-${part.month}-${part.day} ${part.hour}:${part.minute}`;
}

/** The muted lead of a line: its date and minute in `timeZone`, then its number, as `[2026-11-08 13:04] [#3] `. */
export function lineLead(at: number, number: number, timeZone?: string): string {
  return `[${lineTime(at, timeZone)}] [#${number}] `;
}

function expandTabs(line: string): string {
  let out = '';
  for (const char of line) out += char === '\t' ? ' '.repeat(TAB_STOP - (out.length % TAB_STOP)) : char;
  return out;
}

function entryRows(
  entry: TranscriptEntry,
  columns: number,
  isExpanded: boolean,
  foldLines: number
): Array<TranscriptRow> {
  const folded = foldedText(entry.text, isExpanded, foldLines);
  const rows: Array<TranscriptRow> = [];
  let inCode = false;
  const lead = entry.lead ?? '';
  const leadCells = cellWidth(lead);
  // A terminal narrower than the lead wraps the text under it from the left edge.
  const indent = Math.min(entry.indent ?? leadCells, Math.max(0, columns - 1));
  const pad = ' '.repeat(indent);
  let isFirst = true;
  for (const line of folded.text.split('\n')) {
    const isFence = line.trimStart().startsWith('```');
    const block: RowBlock =
      inCode || isFence ? 'code' : line.startsWith('>') ? 'quote' : /^#{1,6} /.test(line) ? 'heading' : 'plain';
    if (isFence) inCode = !inCode;
    for (const row of wrapWords(expandTabs(line), Math.max(1, columns - indent))) {
      const head = isFirst && lead !== '' ? lead + ' '.repeat(Math.max(0, indent - leadCells)) : pad;
      rows.push({
        entryId: entry.id,
        text: head + row.text,
        kind: 'text',
        block,
        ...(isFirst && lead !== '' ? { lead: leadCells } : indent > 0 ? { pad: indent } : {}),
      });
      isFirst = false;
    }
  }
  if (folded.hidden > 0)
    rows.push({
      entryId: entry.id,
      text: `${pad}… ${folded.hidden} more lines, ctrl+o shows them`,
      kind: 'fold',
      block: 'plain',
      ...(indent > 0 ? { pad: indent } : {}),
    });
  return rows;
}

const kept = new WeakMap<TranscriptEntry, { key: string; rows: Array<TranscriptRow> }>();

function rowsOf(entry: TranscriptEntry, dims: TranscriptDims): Array<TranscriptRow> {
  const isExpanded = dims.expanded.has(entry.id);
  const key = `${dims.columns}|${isExpanded}|${dims.foldLines}`;
  const found = kept.get(entry);
  if (found?.key === key && found !== undefined) return found.rows;
  const rows = entryRows(entry, dims.columns, isExpanded, dims.foldLines);
  kept.set(entry, { key, rows });
  return rows;
}

const totalRows = (entries: ReadonlyArray<TranscriptEntry>, dims: TranscriptDims): number =>
  entries.reduce((sum, entry) => sum + rowsOf(entry, dims).length, 0);

/** The row an anchor stands on, counted from the first row; null when its entry is gone. */
function anchorRow(
  entries: ReadonlyArray<TranscriptEntry>,
  view: Extract<TranscriptView, { kind: 'anchor' }>,
  dims: TranscriptDims
): number | null {
  let before = 0;
  for (const entry of entries) {
    const count = rowsOf(entry, dims).length;
    if (entry.id === view.entryId) return before + Math.min(view.row, count - 1);
    before += count;
  }
  return null;
}

function rowsFrom(
  entries: ReadonlyArray<TranscriptEntry>,
  top: number,
  count: number,
  dims: TranscriptDims
): Array<TranscriptRow> {
  const out: Array<TranscriptRow> = [];
  let at = 0;
  for (const entry of entries) {
    const rows = rowsOf(entry, dims);
    if (at + rows.length > top && out.length < count) {
      const skip = Math.max(0, top - at);
      out.push(...rows.slice(skip, skip + count - out.length));
    }
    at += rows.length;
    if (out.length >= count) break;
  }
  return out;
}

/** The rows on the screen and how many are out of it on each side. */
export function transcriptWindow(
  entries: ReadonlyArray<TranscriptEntry>,
  view: TranscriptView,
  dims: TranscriptDims
): TranscriptWindow {
  if (dims.budget <= 0) return { rows: [], atTail: view.kind === 'tail', hiddenAbove: 0, hiddenBelow: 0 };
  const total = totalRows(entries, dims);
  const anchored = view.kind === 'anchor' ? anchorRow(entries, view, dims) : null;
  if (anchored !== null) {
    const rows = rowsFrom(entries, anchored, dims.budget, dims);
    return { rows, atTail: false, hiddenAbove: anchored, hiddenBelow: total - anchored - rows.length };
  }
  const last = entries.at(-1);
  const tallest = last !== undefined && dims.expanded.has(last.id) ? rowsOf(last, dims).length : 0;
  const count = Math.max(dims.budget, tallest);
  const top = Math.max(0, total - count);
  return { rows: rowsFrom(entries, top, count, dims), atTail: true, hiddenAbove: top, hiddenBelow: 0 };
}

/** The view `delta` rows from this one: stopped at both ends, and following the tail again once it reaches the end. */
export function scrollView(
  entries: ReadonlyArray<TranscriptEntry>,
  view: TranscriptView,
  delta: number,
  dims: TranscriptDims
): TranscriptView {
  const lastTop = Math.max(0, totalRows(entries, dims) - dims.budget);
  const from = view.kind === 'anchor' ? (anchorRow(entries, view, dims) ?? lastTop) : lastTop;
  const top = Math.max(0, Math.min(from + delta, lastTop));
  if (top >= lastTop) return TAIL;
  let at = 0;
  for (const entry of entries) {
    const count = rowsOf(entry, dims).length;
    if (top < at + count) return { kind: 'anchor', entryId: entry.id, row: top - at };
    at += count;
  }
  return TAIL;
}
