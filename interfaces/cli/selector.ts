// The selector over any list of rows: a pure reducer that owns the selected stable id, the query, the loading state, the
// overlay id and the generation, and the view that draws it. A row's stable id survives a refresh and its `value` is what
// a commit carries, so a label never stands in for what is saved. An answer that names another overlay or an older
// generation changes nothing. Browsing produces no effect. interfaces/cli/app.ts draws a closed question with it and
// interfaces/cli/model-picker.ts its steps.
import { createElement as h, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Box, Text, useInput } from 'ink';

export type SelectorRow = {
  id: string;
  label: string;
  value: string;
  detail?: string;
  /** what the row is in force as now, drawn beside its name */
  current?: string;
  /** why the row cannot be committed; it stays readable */
  disabled?: string;
};

export type SelectorState = {
  status: 'closed' | 'loading' | 'ready' | 'empty' | 'failed';
  overlayId: string | null;
  generation: number;
  rows: ReadonlyArray<SelectorRow>;
  query: string;
  selectedId: string | null;
  /** a commit left and its answer has not come */
  pending: boolean;
  error: string | null;
};

export type SelectorEvent =
  | { kind: 'open'; overlayId: string }
  | { kind: 'close' }
  | { kind: 'retry' }
  | { kind: 'enter' }
  | { kind: 'move'; delta: 1 | -1 }
  | { kind: 'filter'; query: string }
  | { kind: 'loaded'; overlayId: string | null; generation: number; rows: ReadonlyArray<SelectorRow> }
  | { kind: 'failed'; overlayId: string | null; generation: number; error: string }
  | { kind: 'applied'; overlayId: string | null; generation: number; ok: boolean; error?: string };

export type SelectorEffect =
  | { kind: 'load'; overlayId: string; generation: number }
  | { kind: 'commit'; overlayId: string; generation: number; rowId: string; value: string };

export type SelectorStep = { state: SelectorState; effects: Array<SelectorEffect> };

export const closedSelector: SelectorState = {
  status: 'closed',
  overlayId: null,
  generation: 0,
  rows: [],
  query: '',
  selectedId: null,
  pending: false,
  error: null,
};

const matches = (row: SelectorRow, asked: string): boolean =>
  `${row.id} ${row.label} ${row.detail ?? ''}`.toLowerCase().includes(asked);

function rowsOf(rows: ReadonlyArray<SelectorRow>, query: string): Array<SelectorRow> {
  const asked = query.trim().toLowerCase();
  return asked === '' ? [...rows] : rows.filter((row) => matches(row, asked));
}

/** The rows the query lets through. */
export function visibleRows(state: SelectorState): Array<SelectorRow> {
  return rowsOf(state.rows, state.query);
}

/** The selection among `rows`: the id it had while that row is there, else the row in force, else the first. */
function selectionIn(rows: ReadonlyArray<SelectorRow>, wanted: string | null): string | null {
  const kept = rows.find((row) => row.id === wanted) ?? rows.find((row) => row.current !== undefined) ?? rows[0];
  return kept?.id ?? null;
}

/** Whether an answer belongs to the overlay on the screen now. */
const isCurrent = (state: SelectorState, event: { overlayId: string | null; generation: number }): boolean =>
  state.status !== 'closed' && state.overlayId === event.overlayId && state.generation === event.generation;

function moved(state: SelectorState, delta: 1 | -1): SelectorState {
  const rows = visibleRows(state);
  const at = rows.findIndex((row) => row.id === state.selectedId);
  const next = rows[Math.min(rows.length - 1, Math.max(0, at + delta))];
  return next === undefined ? state : { ...state, selectedId: next.id };
}

function entered(state: SelectorState): SelectorStep {
  const row = visibleRows(state).find((one) => one.id === state.selectedId);
  if (state.status !== 'ready' || state.pending || row === undefined || row.disabled !== undefined)
    return { state, effects: [] };
  const { generation } = state;
  const overlayId = state.overlayId ?? '';
  return {
    state: { ...state, pending: true, error: null },
    effects: [{ kind: 'commit', overlayId, generation, rowId: row.id, value: row.value }],
  };
}

function loading(state: SelectorState, overlayId: string): SelectorStep {
  const generation = state.generation + 1;
  return {
    state: { ...closedSelector, status: 'loading', overlayId, generation },
    effects: [{ kind: 'load', overlayId, generation }],
  };
}

/** One event: the state after it, and what the caller must do. */
export function selectorReduce(state: SelectorState, event: SelectorEvent): SelectorStep {
  const still = { state, effects: [] };
  switch (event.kind) {
    case 'open':
      return loading(state, event.overlayId);
    case 'close':
      // The generation goes on counting, so nothing asked before this close can match what opens next.
      return { state: { ...closedSelector, generation: state.generation + 1 }, effects: [] };
    case 'retry':
      return state.status === 'failed' ? loading(state, state.overlayId ?? '') : still;
    case 'enter':
      return entered(state);
    case 'move':
      return { state: moved(state, event.delta), effects: [] };
    case 'filter': {
      const rows = rowsOf(state.rows, event.query);
      return { state: { ...state, query: event.query, selectedId: selectionIn(rows, state.selectedId) }, effects: [] };
    }
    case 'loaded': {
      if (!isCurrent(state, event)) return still;
      const selectedId = selectionIn(rowsOf(event.rows, state.query), state.selectedId);
      const status = event.rows.length === 0 ? 'empty' : 'ready';
      return { state: { ...state, status, rows: event.rows, selectedId, error: null }, effects: [] };
    }
    case 'failed':
      if (!isCurrent(state, event)) return still;
      return { state: { ...state, status: 'failed', pending: false, error: event.error }, effects: [] };
    case 'applied':
      if (!isCurrent(state, event)) return still;
      if (event.ok) return { state: { ...closedSelector, generation: state.generation + 1 }, effects: [] };
      return { state: { ...state, pending: false, error: event.error ?? 'It was refused.' }, effects: [] };
  }
}

/** The rows that fit `height`, with the selected one among them at any height. */
export function selectorViewport(
  state: SelectorState,
  height: number
): { rows: Array<SelectorRow>; start: number; total: number } {
  const all = visibleRows(state);
  const fits = Math.max(1, Math.floor(height));
  const at = Math.max(
    0,
    all.findIndex((row) => row.id === state.selectedId)
  );
  const start = Math.max(0, Math.min(at - fits + 1 + Math.floor((fits - 1) / 2), all.length - fits));
  return { rows: all.slice(start, start + fits), start, total: all.length };
}

/** The list as it stands. Geometry comes from the caller, which knows what else shares the terminal. */
export function SelectorView({ state, height }: { state: SelectorState; height: number }): ReactElement | null {
  if (state.status === 'closed') return null;
  if (state.status === 'loading') return h(Text, { dimColor: true }, 'Loading…');
  if (state.status === 'failed')
    return h(
      Box,
      { flexDirection: 'column' },
      h(Text, { color: 'red' }, state.error ?? 'It could not be read.'),
      h(Text, { dimColor: true }, 'Enter tries again · Esc goes back')
    );
  if (state.status === 'empty') return h(Text, { dimColor: true }, 'Nothing to choose from.');
  const view = selectorViewport(state, height);
  const selected = view.rows.find((row) => row.id === state.selectedId);
  const about = [selected?.disabled, selected?.detail].filter((part) => part !== undefined).join(' · ');
  return h(
    Box,
    { flexDirection: 'column' },
    ...view.rows.map((row) =>
      h(
        Text,
        {
          key: row.id,
          inverse: row.id === state.selectedId,
          dimColor: row.disabled !== undefined,
          wrap: 'truncate',
        },
        `${row.id === state.selectedId ? '›' : ' '} ${row.label}`,
        row.current === undefined ? '' : `  (${row.current})`,
        row.disabled === undefined || row.id === state.selectedId ? '' : `  ${row.disabled}`
      )
    ),
    view.rows.length === 0 ? h(Text, { dimColor: true }, 'No matches') : null,
    about === '' ? null : h(Text, { dimColor: true, wrap: 'wrap' }, about),
    state.error === null ? null : h(Text, { color: 'red', wrap: 'wrap' }, state.error)
  );
}

/** The query of a selector, drawn as a filter so it never reads as the chat's own text. */
export function FilterLine({ query }: { query: string }): ReactElement {
  return h(Text, { dimColor: true }, `filter: ${query === '' ? 'type to narrow the list' : query}`);
}

/**
 * A closed question as a selector: filtering and Enter answer with the original choice, once, and Esc cancels. It holds
 * the keys while `active`, so typed or pasted text narrows the list and never reaches the composer behind it.
 */
export function ChoiceSelector({
  choices,
  active,
  height,
  answer,
  cancel,
}: {
  choices: ReadonlyArray<string>;
  active: boolean;
  height: number;
  answer: (value: string) => void;
  cancel: () => void;
}): ReactElement {
  const [state, setState] = useState<SelectorState>(() => {
    const opened = selectorReduce(closedSelector, { kind: 'open', overlayId: 'question' }).state;
    const rows = choices.map((choice) => ({ id: choice, label: choice, value: choice }));
    return selectorReduce(opened, {
      kind: 'loaded',
      overlayId: 'question',
      generation: opened.generation,
      rows,
    }).state;
  });
  const latest = useRef(state);
  const step = (event: SelectorEvent): void => {
    const next = selectorReduce(latest.current, event);
    latest.current = next.state;
    setState(next.state);
    for (const effect of next.effects) if (effect.kind === 'commit') answer(effect.value);
  };
  useInput(
    (typed, key) => {
      if (key.ctrl && typed === 'c') return;
      if (key.escape) cancel();
      else if (key.return) step({ kind: 'enter' });
      else if (key.upArrow) step({ kind: 'move', delta: -1 });
      else if (key.downArrow) step({ kind: 'move', delta: 1 });
      else if (key.backspace || key.delete)
        step({ kind: 'filter', query: [...latest.current.query].slice(0, -1).join('') });
      else if (!key.ctrl && !key.meta && !key.tab && typed !== '')
        step({ kind: 'filter', query: latest.current.query + typed });
    },
    { isActive: active }
  );
  return h(Box, { flexDirection: 'column' }, h(FilterLine, { query: state.query }), h(SelectorView, { state, height }));
}
