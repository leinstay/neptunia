// interfaces/cli/layout.ts: cell geometry as pure functions over fixed text.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  caretCell,
  cellWidth,
  composerViewport,
  graphemes,
  transcriptBudget,
  wrapCells,
} from '../../../interfaces/cli/layout.ts';
import { KEY, chatEnv, until, withChat } from '../../fixtures/chat-rig.ts';
import type { Rig } from '../../fixtures/chat-rig.ts';

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

/** Cells of a fixture line: hiragana is the only wide script the fixtures use. */
const cells = (line: string): number => [...line].reduce((sum, glyph) => sum + (/[぀-ゟ]/.test(glyph) ? 2 : 1), 0);

const assertFits = (rig: Rig, columns: number, rows: number): void => {
  const screen = rig.screen();
  assert.ok(screen.length <= rows, `${screen.length} rows in a terminal of ${rows}`);
  for (const line of screen) assert.ok(cells(line) <= columns, `"${line}" is wider than ${columns} cells`);
};

test('wide glyphs in a narrow terminal stay inside the frame, all of them shown', async () => {
  // Bug: a wide glyph at the last column breaks the border or drops off the row.
  const { env } = chatEnv();
  await withChat(
    env,
    async (rig) => {
      rig.type('あ'.repeat(30));
      await until(() => rig.screen().join('').split('あ').length - 1 === 30);
      assertFits(rig, 14, 24);
      assert.equal(rig.screen().join('').split('あ').length - 1, 30);
    },
    { columns: 14, rows: 24 }
  );
});

test('a tall draft stops growing, keeps its last typed row and leaves the newest answer in view', async () => {
  // Bug: forty typed lines push the transcript and the header off the top, and the screen scrolls away.
  const { env, entry } = chatEnv();
  await withChat(env, async (rig) => {
    entry({ who: 'her', text: 'the-newest-answer' });
    await until(() => rig.screen().join('\n').includes('the-newest-answer'));
    for (let line = 0; line < 40; line += 1) rig.type(`draft-${line}${KEY.ctrlJ}`);
    rig.type('draft-last');
    await until(() => rig.screen().join('\n').includes('draft-last'));
    assertFits(rig, 80, 24);
    const shown = rig.screen().join('\n');
    assert.match(shown, /draft-last/);
    assert.match(shown, /the-newest-answer/);
    assert.equal(shown.includes('draft-0\n'), false, 'the top of the draft scrolled inside the composer');
  });
});
