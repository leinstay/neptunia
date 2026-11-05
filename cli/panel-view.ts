// Keyboard panels for settings, setup and help. Commands are callbacks supplied by the entry point; this component
// owns only tabs, search, selection, the value editor and feedback. A core credential dialog temporarily takes focus.
import { createElement as h, useState } from 'react';
import type { ReactElement } from 'react';
import { Box, Text, useInput, useStdout } from 'ink';
import type { Key } from 'ink';
import type { Panel, PanelRow } from './panel.ts';
import { panelRows } from './panel.ts';
import { displaySafe } from './transcript.ts';
import { backspace, emptyInput, insert, moveCursor } from './state.ts';
import type { InputState } from './state.ts';

type Props = { panel: Panel; active: boolean; close: () => void; prefill: (line: string) => void };

export function PanelView({ panel, active, close, prefill }: Props): ReactElement {
  const { stdout } = useStdout();
  const height = Math.max(3, ((stdout as { rows?: number }).rows ?? 24) - 15);
  const groups = [...new Set(panel.rows?.map((row) => row.group) ?? [])];
  const [tab, setTab] = useState(0);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(0);
  const [editing, setEditing] = useState<InputState | null>(null);
  const [values, setValues] = useState<Record<string, string>>({});
  const [feedback, setFeedback] = useState('');
  const [busy, setBusy] = useState(false);
  const rows = panelRows(panel, groups[tab] ?? '', search);
  const lines = panel.lines.filter((line) => line.toLowerCase().includes(search.toLowerCase()));
  const count = panel.rows === undefined ? lines.length : rows.length;
  const index = Math.min(selected, Math.max(0, count - 1));
  const row = rows[index];
  const start = Math.max(0, index - height + 1);
  const valueOf = (one: PanelRow): string => values[one.id] ?? one.edit?.value ?? one.value ?? '';

  function apply(one: PanelRow, value: string): void {
    if (one.apply === undefined) return;
    setBusy(true);
    setFeedback('Working…');
    void one
      .apply(value)
      .then((result) => {
        setFeedback(result.text);
        if (result.status === 'ok') {
          setValues((old) => ({ ...old, [one.id]: value }));
          setEditing(null);
        }
      })
      .catch((error: unknown) => {
        setFeedback(error instanceof Error ? error.message : 'The command failed.');
      })
      .finally(() => setBusy(false));
  }

  function activate(): void {
    if (row === undefined) return;
    if (row.prefill !== undefined) {
      prefill(row.prefill);
      return;
    }
    const value = valueOf(row);
    if (row.edit?.kind === 'boolean') apply(row, value === 'true' ? 'false' : 'true');
    else if (row.edit !== undefined) setEditing({ ...emptyInput(), text: value, cursor: value.length });
    else apply(row, '');
  }

  function switchTab(delta: number): void {
    if (groups.length === 0) return;
    setTab((old) => (old + delta + groups.length) % groups.length);
    setSelected(0);
    setSearch('');
    setFeedback('');
  }

  function editInput(typed: string, key: Key): void {
    if (editing !== null) {
      if (key.escape) setEditing(null);
      else if (key.return && row !== undefined) apply(row, editing.text);
      else if (key.leftArrow) setEditing(moveCursor(editing, -1));
      else if (key.rightArrow) setEditing(moveCursor(editing, 1));
      else if (key.backspace || key.delete) setEditing(backspace(editing));
      else if (key.ctrl && typed === 'u') setEditing(emptyInput());
      else if (!key.ctrl && !key.meta && typed !== '') setEditing(insert(editing, typed));
      return;
    }
  }

  useInput(
    (typed, key) => {
      if (key.ctrl && typed === 'c') return;
      if (busy) return;
      if (editing !== null) {
        editInput(typed, key);
        return;
      }
      if (key.escape) close();
      else if (key.tab) switchTab(key.shift ? -1 : 1);
      else if (key.leftArrow) switchTab(-1);
      else if (key.rightArrow) switchTab(1);
      else if (key.upArrow) setSelected(Math.max(0, index - 1));
      else if (key.downArrow) setSelected(Math.min(count - 1, index + 1));
      else if (key.return) activate();
      else if (key.backspace || key.delete) {
        setSearch((old) => [...old].slice(0, -1).join(''));
        setSelected(0);
      } else if (!key.ctrl && !key.meta && typed !== '') {
        setSearch((old) => old + typed);
        setSelected(0);
      }
    },
    { isActive: active }
  );

  const shownGroups = groups.slice(Math.max(0, tab - 1), Math.max(0, tab - 1) + 5);
  return h(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: 'cyan', paddingX: 1 },
    h(Text, { bold: true, color: 'cyan' }, panel.title),
    groups.length > 0
      ? h(
          Box,
          { gap: 2 },
          ...shownGroups.map((name) => h(Text, { key: name, inverse: name === groups[tab] }, ` ${name} `))
        )
      : null,
    h(Text, { dimColor: true }, `search: ${search || 'type to filter'}${search ? ' (all tabs)' : ''}`),
    ...(panel.rows === undefined
      ? lines.slice(start, start + height).map((line, i) => h(Text, { key: String(i) }, line))
      : rows
          .slice(start, start + height)
          .map((one, i) =>
            h(
              Text,
              { key: one.id, inverse: start + i === index, wrap: 'truncate' },
              `${start + i === index ? '›' : ' '} ${one.label}  ${displaySafe(valueOf(one))}`
            )
          )),
    count === 0 ? h(Text, { dimColor: true }, 'No matches') : h(Text, { dimColor: true }, `${index + 1}/${count}`),
    row === undefined ? null : h(Text, { dimColor: true, wrap: 'wrap' }, row.detail),
    editing === null
      ? null
      : h(
          Text,
          null,
          'Value: ',
          editing.text.slice(0, editing.cursor),
          h(Text, { inverse: true }, editing.text[editing.cursor] ?? ' '),
          editing.text.slice(editing.cursor + 1)
        ),
    feedback === ''
      ? null
      : h(Text, { color: busy ? 'yellow' : undefined }, feedback.split('\n').slice(0, 3).join('\n')),
    h(
      Text,
      { dimColor: true },
      editing === null
        ? '↑↓ select · Enter open/toggle · Tab switch · Esc close'
        : 'Enter save · Ctrl+U clear · Esc cancel'
    )
  );
}
