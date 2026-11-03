// The interactive chat's screen, written with `React.createElement`, so no build step appears: a header with the rotating
// galaxy and the status line, the conversation with long answers folded, the input with its slash menu, and panels over
// the chat for `/help`, `/status` and `/config` with a search. The commands and their answers come from the caller, this
// file knows no command's meaning. A question the core asks replaces the input, a secret drawn as stars and kept out of
// the history. Clearing the display touches nothing else, and leaving ends only this process. cli/index.ts starts it.

import { createElement as h, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { galaxyFrame } from './galaxy.ts';
import {
  backspace,
  browse,
  emptyInput,
  filterLines,
  foldedText,
  insert,
  menuOf,
  moveCursor,
  statusLine,
  submit,
} from './state.ts';
import type { MenuCommand, StatusBrief } from './state.ts';

export type ChatEntry = { who: 'owner' | 'her' | 'system'; text: string };
export type Question = { question: string; secret: boolean; answer: (text: string) => void };
export type Panel = { title: string; lines: ReadonlyArray<string> };
export type ChatEnv = {
  title: string;
  commands: ReadonlyArray<MenuCommand>;
  history: ReadonlyArray<string>;
  still: boolean;
  /** One line typed: a command or a chat line. The answer, when it is text for the chat, comes through `onEntry`. */
  send: (line: string) => void;
  /** The text of a panel a command opens, or null when this line opens none. */
  panelOf: (line: string) => Promise<Panel | null>;
  /** Registers the listeners of what arrives from the core. */
  subscribe: (listeners: {
    entry: (entry: ChatEntry) => void;
    question: (question: Question) => void;
    connected: (connected: boolean) => void;
  }) => void;
  status: () => Promise<StatusBrief | null>;
  saveHistory: (history: ReadonlyArray<string>) => void;
  now: () => number;
};

const GALAXY_MS = 200;
const POLL_MS = 15_000;

function Header({ env, line }: { env: ChatEnv; line: string }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (env.still) return undefined;
    const timer = setInterval(() => setTick((value) => value + 1), GALAXY_MS);
    return () => clearInterval(timer);
  }, [env.still]);
  return h(
    Box,
    { borderStyle: 'round', paddingX: 1, gap: 2 },
    h(Text, null, galaxyFrame(tick).join('\n')),
    h(Box, { flexDirection: 'column' }, h(Text, { bold: true }, env.title), h(Text, { wrap: 'wrap' }, line))
  );
}

function Entry({ entry, expanded }: { entry: ChatEntry; expanded: boolean }) {
  const folded = foldedText(entry.text, expanded);
  const mark = entry.who === 'owner' ? '> ' : '';
  return h(
    Box,
    { flexDirection: 'column' },
    h(Text, { dimColor: entry.who === 'system' }, `${mark}${folded.text}`),
    folded.hidden > 0 ? h(Text, { dimColor: true }, `… ${folded.hidden} more lines, ctrl+o shows them`) : null
  );
}

function Menu({ items, selected }: { items: ReadonlyArray<MenuCommand>; selected: number }) {
  return h(
    Box,
    { flexDirection: 'column' },
    ...items
      .slice(0, 10)
      .map((item, index) =>
        h(
          Text,
          { key: item.name, inverse: index === selected },
          `/${item.name}  `,
          h(Text, { dimColor: index !== selected }, item.help)
        )
      )
  );
}

function PanelView({ panel, search }: { panel: Panel; search: string }) {
  const { stdout } = useStdout();
  const rows = Math.max(5, ((stdout as { rows?: number }).rows ?? 24) - 8);
  return h(
    Box,
    { flexDirection: 'column', borderStyle: 'round', paddingX: 1 },
    h(Text, { bold: true }, panel.title),
    h(Text, { dimColor: true }, `search: ${search}  (esc closes)`),
    h(Text, null, filterLines(panel.lines, search).slice(0, rows).join('\n'))
  );
}

export function ChatApp({ env }: { env: ChatEnv }): ReactElement {
  const { exit } = useApp();
  const [entries, setEntries] = useState<ReadonlyArray<ChatEntry>>([]);
  const [input, setInput] = useState(() => emptyInput(env.history));
  const [selected, setSelected] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [search, setSearch] = useState('');
  const [question, setQuestion] = useState<Question | null>(null);
  const [connected, setConnected] = useState(true);
  const [brief, setBrief] = useState<StatusBrief | null>(null);
  const [polledAt, setPolledAt] = useState<number | null>(null);
  const subscribed = useRef(false);

  useEffect(() => {
    if (subscribed.current) return;
    subscribed.current = true;
    env.subscribe({
      entry: (entry) => setEntries((list) => [...list, entry]),
      question: (asked) => setQuestion(asked),
      connected: (now) => setConnected(now),
    });
  }, [env]);

  // A read of what the core already knows: no probe and no provider call for the display.
  useEffect(() => {
    const poll = (): void => {
      void env.status().then((answer) => {
        if (answer !== null) {
          setBrief(answer);
          setPolledAt(env.now());
        }
      });
    };
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => clearInterval(timer);
  }, [env]);

  const items = question === null ? menuOf(input.text, env.commands) : [];

  function send(): void {
    const secret = question?.secret === true;
    const { line, next } = submit(input, { secret });
    setInput(next);
    setSelected(0);
    if (question !== null) {
      question.answer(line);
      setQuestion(null);
      return;
    }
    if (line.trim() === '') return;
    env.saveHistory(next.history);
    if (line.trim() === '/clear') {
      setEntries([]);
      return;
    }
    setEntries((list) => [...list, { who: 'owner', text: line }]);
    void env.panelOf(line.trim()).then((opened) => {
      if (opened === null) env.send(line);
      else {
        setSearch('');
        setPanel(opened);
      }
    });
  }

  // health: allow complexity until 2027-04-01 -- one table of the keys of the chat, and split up it would hide which key does what
  useInput((typed, key) => {
    if (key.ctrl && typed === 'c') {
      exit();
      return;
    }
    if (panel !== null) {
      if (key.escape) setPanel(null);
      else if (key.backspace || key.delete) setSearch((text) => text.slice(0, -1));
      else if (!key.ctrl && !key.meta && typed !== '') setSearch((text) => text + typed);
      return;
    }
    if (key.ctrl && typed === 'o') setExpanded((value) => !value);
    else if (key.ctrl && typed === 'd' && input.text === '') exit();
    else if (key.ctrl && typed === 'j') setInput((state) => insert(state, '\n'));
    else if (key.return && key.meta) setInput((state) => insert(state, '\n'));
    else if (key.return) send();
    else if (key.tab && items[selected] !== undefined) setInput(emptyInputWith(input, `/${items[selected].name} `));
    else if (key.escape) {
      if (question !== null) {
        question.answer('');
        setQuestion(null);
      }
      setInput((state) => ({ ...state, text: '', cursor: 0 }));
    } else if (key.upArrow) {
      if (items.length > 0) setSelected((value) => Math.max(0, value - 1));
      else if (question === null) setInput((state) => browse(state, -1));
    } else if (key.downArrow) {
      if (items.length > 0) setSelected((value) => Math.min(items.length - 1, value + 1));
      else if (question === null) setInput((state) => browse(state, 1));
    } else if (key.leftArrow) setInput((state) => moveCursor(state, -1));
    else if (key.rightArrow) setInput((state) => moveCursor(state, 1));
    else if (key.backspace || key.delete) setInput((state) => backspace(state));
    else if (typed !== '' && !key.ctrl && !key.meta) {
      setSelected(0);
      setInput((state) => insert(state, typed));
    }
  });

  const shown = question?.secret === true ? '*'.repeat([...input.text].length) : input.text;
  const before = shown.slice(0, input.cursor);
  const after = shown.slice(input.cursor);
  return h(
    Box,
    { flexDirection: 'column' },
    h(Header, { env, line: statusLine(brief, { connected, polledAt, now: env.now() }) }),
    ...entries.map((entry, index) => h(Entry, { key: String(index), entry, expanded })),
    panel === null ? null : h(PanelView, { panel, search }),
    question === null ? null : h(Text, { bold: true }, question.question),
    h(
      Box,
      { borderStyle: 'round', paddingX: 1 },
      h(Text, null, '> ', before, h(Text, { inverse: true }, after[0] ?? ' '), after.slice(1))
    ),
    items.length > 0 ? h(Menu, { items, selected }) : null
  );
}

function emptyInputWith(state: ReturnType<typeof emptyInput>, text: string): ReturnType<typeof emptyInput> {
  return { ...state, text, cursor: text.length, browsing: null };
}
