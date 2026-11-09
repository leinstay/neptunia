// interfaces/cli/layout.ts and interfaces/cli/transcript.ts: cell geometry and the transcript window as pure functions over fixed text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  caretCell,
  cellWidth,
  composerViewport,
  graphemes,
  transcriptBudget,
  wrapCells,
} from '../interfaces/cli/layout.ts';
import { displaySafe, scrollView, TAIL, transcriptWindow } from '../interfaces/cli/transcript.ts';
import type { TranscriptView } from '../interfaces/cli/transcript.ts';
import { backspace, emptyInput, insert, moveCursor } from '../interfaces/cli/state.ts';

const FAMILY = '👨‍👩‍👧';
const ACCENT = 'é';

test('a grapheme is what the eye counts, whatever its code points', () => {
  // Bug: a cursor step lands inside a family emoji or between a letter and its accent.
  assert.deepEqual(graphemes(`a${FAMILY}${ACCENT}あ`), ['a', FAMILY, ACCENT, 'あ']);
  assert.deepEqual(graphemes(''), []);
});

test('cell width counts wide glyphs as two and combining marks as none', () => {
  // Bug: wrapping by string length overflows the border on CJK, or wraps early on an accent.
  assert.equal(cellWidth('abc'), 3);
  assert.equal(cellWidth('あい'), 4);
  assert.equal(cellWidth(ACCENT), 1);
  assert.equal(cellWidth(FAMILY), 2);
  assert.equal(cellWidth(''), 0);
});

test('Backspace removes a whole grapheme, and the cursor crosses one in one step', () => {
  // Bug: Backspace leaves half a family emoji, or the accent without its letter.
  assert.equal(backspace(insert(emptyInput(), `a${FAMILY}`)).text, 'a');
  assert.equal(backspace(insert(emptyInput(), `a${ACCENT}`)).text, 'a');
  const state = insert(emptyInput(), `a${FAMILY}b`);
  const before = moveCursor(moveCursor(state, -1), -1);
  assert.equal(before.cursor, 1);
  assert.equal(moveCursor(before, 1).cursor, 1 + FAMILY.length);
});

test('wrapping never exceeds the width and never splits a wide glyph', () => {
  // Bug: a wide glyph straddles the last column and the border shifts one cell.
  const rows = wrapCells('aあいうえお', 4);
  assert.deepEqual(
    rows.map((row) => row.text),
    ['aあ', 'いう', 'えお']
  );
  assert.equal(
    rows.every((row) => cellWidth(row.text) <= 4),
    true
  );
});

test('wrapping keeps explicit newlines as rows and offsets into the original text', () => {
  // Bug: an empty line of a draft vanishes, and the caret maps to the wrong character after it.
  const rows = wrapCells('ab\n\ncd', 10);
  assert.deepEqual(
    rows.map((row) => [row.text, row.start, row.end]),
    [
      ['ab', 0, 2],
      ['', 3, 3],
      ['cd', 4, 6],
    ]
  );
  assert.deepEqual(wrapCells('', 10), [{ text: '', start: 0, end: 0 }]);
});

test('a glyph wider than the terminal takes its own row instead of looping forever', () => {
  // Bug: one column of width hangs the chat in the wrap loop.
  assert.deepEqual(
    wrapCells('あa', 1).map((row) => row.text),
    ['あ', 'a']
  );
});

test('the caret maps to the cell after what precedes it, across wide glyphs and full rows', () => {
  // Bug: the caret draws inside a wide glyph, or past the border at the end of a full row.
  assert.deepEqual(caretCell('あいう', 'あ'.length, 4), { row: 0, col: 2 });
  assert.deepEqual(caretCell('あいう', 'あいう'.length, 4), { row: 1, col: 2 });
  assert.deepEqual(caretCell('abcd', 4, 4), { row: 1, col: 0 });
  assert.deepEqual(caretCell('ab\ncd', 3, 10), { row: 1, col: 0 });
  assert.deepEqual(caretCell('', 0, 10), { row: 0, col: 0 });
});

test('the composer viewport keeps the caret row in view and counts what it hides', () => {
  // Bug: a long draft pushes the caret off the screen, or the hidden rows are not announced.
  assert.deepEqual(composerViewport({ rowCount: 3, caretRow: 2, maxRows: 8 }), {
    first: 0,
    rows: 3,
    hiddenAbove: 0,
    hiddenBelow: 0,
  });
  assert.deepEqual(composerViewport({ rowCount: 20, caretRow: 19, maxRows: 8 }), {
    first: 12,
    rows: 8,
    hiddenAbove: 12,
    hiddenBelow: 0,
  });
  assert.deepEqual(composerViewport({ rowCount: 20, caretRow: 0, maxRows: 8 }), {
    first: 0,
    rows: 8,
    hiddenAbove: 0,
    hiddenBelow: 12,
  });
});

test('the transcript budget is what the fixed rows, the composer and the overlay leave, and never negative', () => {
  // Bug: a composer taller than the terminal gives a negative slice that shows the wrong rows.
  assert.equal(transcriptBudget({ rows: 24, fixed: 4, composer: 3, overlay: 0 }), 17);
  assert.equal(transcriptBudget({ rows: 24, fixed: 4, composer: 3, overlay: 10 }), 7);
  assert.equal(transcriptBudget({ rows: 6, fixed: 4, composer: 3, overlay: 0 }), 0);
});

const ENTRIES = Array.from({ length: 50 }, (_, index) => ({ id: `e${index}`, text: `line ${index}` }));
const DIMS = { columns: 40, budget: 5, expanded: new Set<string>(), foldLines: 20 };
const shown = (view: TranscriptView, entries = ENTRIES, dims = DIMS): Array<string> =>
  transcriptWindow(entries, view, dims).rows.map((row) => row.text);

test('following the tail shows the newest rows, bounded by the budget', () => {
  // Bug: every entry stays mounted, and a long session slows each keystroke.
  const window = transcriptWindow(ENTRIES, TAIL, DIMS);
  assert.deepEqual(
    window.rows.map((row) => row.text),
    ['line 45', 'line 46', 'line 47', 'line 48', 'line 49']
  );
  assert.equal(window.atTail, true);
  assert.equal(window.hiddenAbove, 45);
});

test('an off-tail view stays on its rows while entries arrive', () => {
  // Bug: new content pulls the reader down, or shifts what they were reading by a row.
  const view = scrollView(ENTRIES, TAIL, -10, DIMS);
  const before = shown(view);
  assert.deepEqual(before, ['line 35', 'line 36', 'line 37', 'line 38', 'line 39']);
  const grown = [...ENTRIES, { id: 'new', text: 'line new' }];
  assert.deepEqual(shown(view, grown), before);
  assert.equal(transcriptWindow(grown, view, DIMS).atTail, false);
});

test('an off-tail view keeps its anchor entry when the width changes the wrapping', () => {
  // Bug: a resize moves the reader by the rows the wrap added above.
  const long = Array.from({ length: 20 }, (_, index) => ({ id: `e${index}`, text: `${index} ${'x'.repeat(30)}` }));
  const view = scrollView(long, TAIL, -6, { ...DIMS, columns: 40 });
  const first = transcriptWindow(long, view, { ...DIMS, columns: 40 }).rows[0]?.entryId;
  const narrow = transcriptWindow(long, view, { ...DIMS, columns: 10 });
  assert.equal(narrow.rows[0]?.entryId, first);
});

test('scrolling stops at both ends, and reaching the end follows the tail again', () => {
  // Bug: the first line is out of reach, or the view stays frozen after returning to the bottom.
  const top = scrollView(ENTRIES, TAIL, -1000, DIMS);
  assert.deepEqual(shown(top).at(0), 'line 0');
  assert.equal(transcriptWindow(ENTRIES, top, DIMS).hiddenAbove, 0);
  const back = scrollView(ENTRIES, top, 1000, DIMS);
  assert.equal(transcriptWindow(ENTRIES, back, DIMS).atTail, true);
  assert.equal(transcriptWindow([...ENTRIES, { id: 'n', text: 'newest' }], back, DIMS).rows.at(-1)?.text, 'newest');
});

test('an anchor whose entry is gone falls back to the tail', () => {
  // Bug: /clear while scrolled up leaves an empty screen with no way back.
  const view = scrollView(ENTRIES, TAIL, -10, DIMS);
  const fresh = [{ id: 'x', text: 'only' }];
  const window = transcriptWindow(fresh, view, DIMS);
  assert.deepEqual(
    window.rows.map((row) => row.text),
    ['only']
  );
  assert.equal(window.atTail, true);
});

test('no entries and no budget give no rows', () => {
  // Bug: a terminal with no room left for the transcript throws in the slice.
  assert.deepEqual(transcriptWindow([], TAIL, DIMS).rows, []);
  assert.deepEqual(transcriptWindow(ENTRIES, TAIL, { ...DIMS, budget: 0 }).rows, []);
});

test('folding is per entry: expanding one leaves its neighbour folded', () => {
  // Bug: one global switch unfolds every long answer in the session.
  const text = Array.from({ length: 10 }, (_, index) => `row ${index}`).join('\n');
  const entries = [
    { id: 'a', text },
    { id: 'b', text },
  ];
  const dims = { columns: 40, budget: 100, foldLines: 3, expanded: new Set(['b']) };
  const rows = transcriptWindow(entries, TAIL, dims).rows;
  assert.equal(rows.filter((row) => row.entryId === 'b' && row.text.startsWith('row')).length, 10);
  assert.equal(rows.filter((row) => row.entryId === 'a' && row.text.startsWith('row')).length, 3);
});

test('stored control characters are shown as visible text, with the original value untouched', () => {
  // Bug: a line from memory rewrites the clipboard through OSC 52, flips text with a bidi override, or clears the screen.
  const stored = 'a\u001b]52;c;QUJD\u0007b‮c\u0085d\n\te';
  const safe = displaySafe(stored);
  // eslint-disable-next-line no-control-regex
  assert.equal(/[\u0000-\u0008\u000b-\u001f\u007f-\u009f‪-‮⁦-⁩]/.test(safe), false);
  assert.ok(safe.includes('\n\te'), 'layout characters stay');
  assert.ok(safe.includes('52;c;QUJD'), 'the text around them stays readable');
  assert.notEqual(displaySafe('a\u0007b'), 'ab', 'the control is shown, not dropped');
  assert.equal(displaySafe('plain γραμμή あ'), 'plain γραμμή あ');
});
