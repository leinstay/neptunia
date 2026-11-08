// What the chat draws: the header, the transcript's rows, the slash menu and the input box, with the row counts each of
// them takes, so cli/app.ts can give the transcript exactly what is left. The linear mode drops the borders and the galaxy
// and keeps the reading order. Nothing here holds state but the galaxy's tick.
import { createElement as h, useEffect, useState } from 'react';
import type { ReactElement } from 'react';
import { Box, Text } from 'ink';
import { galaxyFrame } from './galaxy.ts';
import { caretCell, composerViewport, graphemes, sliceCells, wrapCells } from './layout.ts';
import type { MenuCommand } from './state.ts';
import { THEME } from './theme.ts';
import { displaySafe } from './transcript.ts';
import type { RowBlock, TranscriptRow } from './transcript.ts';

const GALAXY_MS = 200;
const GALAXY_ROWS = 5;
/** The galaxy's fixed box: every frame is drawn in it, so the title beside it never moves. */
const GALAXY_COLUMNS = galaxyFrame(0)[0]?.length ?? 13;
const GALAXY_GAP_ROWS = 1;
/** Below these sizes the galaxy leaves its rows to the chat (measured: docs/cli.md, "Measured geometry"). */
const FULL_HEADER_MIN_ROWS = 16;
const FULL_HEADER_MIN_COLUMNS = 40;
/** Below this height the header goes altogether, and the input keeps what is left. */
const LINE_HEADER_MIN_ROWS = 8;
/** The tallest the input grows. Past it the draft scrolls inside the box. */
const COMPOSER_MAX_ROWS = 8;
const BORDER_ROWS = 2;
/** Border, padding and the `> ` prompt on both sides of a draft row. */
const BOX_COLUMNS = 6;
const PROMPT_COLUMNS = 2;
const MENU_MAX_ROWS = 8;

export type HeaderMode = 'full' | 'line' | 'none';

export function headerMode(rows: number, columns: number, isLinear: boolean): HeaderMode {
  if (rows < LINE_HEADER_MIN_ROWS) return 'none';
  return !isLinear && rows >= FULL_HEADER_MIN_ROWS && columns >= FULL_HEADER_MIN_COLUMNS ? 'full' : 'line';
}

export function headerRows(mode: HeaderMode): number {
  if (mode === 'full') return GALAXY_ROWS + GALAXY_GAP_ROWS;
  return mode === 'line' ? 1 : 0;
}

export function Header({
  mode,
  title,
  still,
  status,
}: {
  mode: HeaderMode;
  title: string;
  still: boolean;
  status: string;
}): ReactElement | null {
  const [tick, setTick] = useState(0);
  const isMoving = mode === 'full' && !still;
  useEffect(() => {
    if (!isMoving) return undefined;
    const timer = setInterval(() => setTick((value) => value + 1), GALAXY_MS);
    return () => clearInterval(timer);
  }, [isMoving]);
  if (mode === 'none') return null;
  if (mode === 'line')
    return h(Text, { wrap: 'truncate' }, h(Text, THEME.title, title), ` · ${status.split('\n')[0] ?? ''}`);
  return h(
    Box,
    { paddingX: 1, gap: 2, marginBottom: GALAXY_GAP_ROWS, flexShrink: 0 },
    h(
      Box,
      { width: GALAXY_COLUMNS, height: GALAXY_ROWS, flexShrink: 0 },
      h(Text, { ...THEME.mark, wrap: 'truncate' }, galaxyFrame(tick).join('\n'))
    ),
    // A status line wider than the terminal is cut here and never squeezes the galaxy.
    h(
      Box,
      { flexDirection: 'column', flexShrink: 1, minWidth: 0 },
      h(Text, THEME.title, title),
      ...status.split('\n').map((line) => h(Text, { key: line, wrap: 'truncate' }, line))
    )
  );
}

const BLOCK_STYLE: Readonly<Record<RowBlock, object>> = {
  plain: THEME.text,
  code: THEME.code,
  quote: THEME.quote,
  heading: THEME.heading,
};

type Who = 'owner' | 'her' | 'system';

function rowStyle(row: TranscriptRow, who: Who | undefined): object {
  if (row.kind === 'fold' || who === 'system') return THEME.muted;
  return who === 'owner' ? THEME.owner : who === 'her' && row.block === 'plain' ? THEME.her : BLOCK_STYLE[row.block];
}

/** A row's text with the cells of a mouse selection in the selection style, and its lead muted when nothing is selected. */
function markedText(row: TranscriptRow, mark: { from: number; to: number } | null): Array<ReactElement | string> {
  const { text } = row;
  if (mark === null && row.lead !== undefined)
    return [
      h(Text, { key: 'lead', ...THEME.muted }, sliceCells(text, 0, row.lead)),
      sliceCells(text, row.lead, Infinity),
    ];
  if (mark === null) return [text || ' '];
  const on = sliceCells(text, mark.from, mark.to);
  return [
    sliceCells(text, 0, mark.from),
    h(Text, { key: 'on', ...THEME.selection }, on || ' '),
    sliceCells(text, mark.to, Infinity),
  ];
}

export function TranscriptRows({
  rows,
  whoOf,
  marks = [],
}: {
  rows: ReadonlyArray<TranscriptRow>;
  whoOf: (entryId: string) => Who | undefined;
  marks?: ReadonlyArray<{ from: number; to: number } | null>;
}): ReactElement {
  return h(
    Box,
    { flexDirection: 'column', flexGrow: 1, justifyContent: 'flex-end', overflow: 'hidden' },
    ...rows.map((row, index) =>
      h(Text, { key: String(index), ...rowStyle(row, whoOf(row.entryId)) }, ...markedText(row, marks[index] ?? null))
    )
  );
}

/** The rows the menu may take when `free` rows are left, at least one, so a small terminal still shows the selected row. */
export const menuRows = (itemCount: number, free: number): number =>
  Math.min(itemCount, MENU_MAX_ROWS, Math.max(1, free));

export function Menu({
  items,
  selected,
  height,
}: {
  items: ReadonlyArray<MenuCommand>;
  selected: number;
  height: number;
}): ReactElement {
  const first = Math.max(0, selected - height + 1);
  return h(
    Box,
    { flexDirection: 'column', flexShrink: 0 },
    ...items.slice(first, first + height).map((item, index) => {
      const isSelected = first + index === selected;
      return h(
        Text,
        { key: item.name, wrap: 'truncate', ...(isSelected ? THEME.selection : {}) },
        `${isSelected ? '›' : ' '} /${item.name}  `,
        h(Text, isSelected ? {} : THEME.muted, item.help)
      );
    })
  );
}

type DraftRow = { before: string; on: string | null; after: string };
export type ComposerLayout = {
  rows: ReadonlyArray<DraftRow>;
  hiddenAbove: number;
  hiddenBelow: number;
  /** the wrapped row drawn first, and the cells of a row: what turns a click into an offset */
  first: number;
  width: number;
  safe: string;
  /** the rows it takes on the screen, its borders and its count of hidden rows included */
  height: number;
};

/** The cap on the draft's rows when the fixed rows leave `rows`, always at least one. */
export const composerMaxRows = (rows: number, fixed: number, isLinear: boolean): number =>
  Math.max(1, Math.min(COMPOSER_MAX_ROWS, rows - fixed - (isLinear ? 0 : BORDER_ROWS) - 1));

/** The draft cut into rows of cells, with the caret's row split around one whole grapheme. */
export function composerLayout(
  shown: string,
  cursor: number,
  { columns, maxRows, isLinear }: { columns: number; maxRows: number; isLinear: boolean }
): ComposerLayout {
  const width = Math.max(1, columns - (isLinear ? PROMPT_COLUMNS : BOX_COLUMNS));
  // One visible character for each control, so the offsets of the draft still hold here.
  const safe = displaySafe(shown).replaceAll('\t', ' ');
  const wrapped = wrapCells(safe, width);
  const caret = caretCell(safe, cursor, width);
  const rowCount = Math.max(wrapped.length, caret.row + 1);
  const viewRows = rowCount > maxRows ? Math.max(1, maxRows - 1) : maxRows;
  const view = composerViewport({ rowCount, caretRow: caret.row, maxRows: viewRows });
  const rows: Array<DraftRow> = [];
  for (let index = view.first; index < view.first + view.rows; index += 1) {
    const row = wrapped[index] ?? { text: '', start: safe.length, end: safe.length };
    if (index !== caret.row) {
      rows.push({ before: row.text, on: null, after: '' });
      continue;
    }
    const cut = index < wrapped.length ? Math.max(0, cursor - row.start) : 0;
    const rest = graphemes(row.text.slice(cut));
    rows.push({ before: row.text.slice(0, cut), on: rest[0] ?? ' ', after: rest.slice(1).join('') });
  }
  const isCut = view.hiddenAbove > 0 || view.hiddenBelow > 0;
  return {
    rows,
    hiddenAbove: view.hiddenAbove,
    hiddenBelow: view.hiddenBelow,
    first: view.first,
    width,
    safe,
    height: rows.length + (isCut ? 1 : 0) + (isLinear ? 0 : BORDER_ROWS),
  };
}

export function ComposerBox({
  layout,
  isLinear,
  isActive,
}: {
  layout: ComposerLayout;
  isLinear: boolean;
  isActive: boolean;
}): ReactElement {
  const hidden = [
    layout.hiddenAbove > 0 ? `↑ ${layout.hiddenAbove}` : null,
    layout.hiddenBelow > 0 ? `↓ ${layout.hiddenBelow}` : null,
  ].filter((one) => one !== null);
  const body = h(
    Box,
    { flexDirection: 'column' },
    hidden.length > 0 ? h(Text, { ...THEME.muted, wrap: 'truncate' }, `${hidden.join(' · ')} more rows`) : null,
    ...layout.rows.map((row, index) =>
      h(
        Text,
        { key: String(index) },
        index === 0 ? '> ' : '  ',
        row.before,
        row.on === null ? null : h(Text, THEME.caret, row.on),
        row.after
      )
    )
  );
  if (isLinear) return body;
  return h(
    Box,
    { borderStyle: 'round', paddingX: 1, flexShrink: 0, ...(isActive ? THEME.activeBorder : THEME.inactiveBorder) },
    body
  );
}
