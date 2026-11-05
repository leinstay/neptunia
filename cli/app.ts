// The interactive chat's screen, written with `React.createElement`, so no build step appears: a header with the rotating
// galaxy and the status line, the conversation with long answers folded, the input with its slash menu, and panels over
// the chat for `/help`, `/status` and `/config` with a search. The commands and their
// answers come from the caller, this file knows no command's meaning. A question the core asks replaces the input and
// keeps the draft it interrupted, a secret drawn as stars and kept out of the history, and a closed question is a selector
// over its choices. Keys and a paste have one owner at a time (`focusOwner`), and the answer of a panel that was replaced
// or closed opens nothing and runs nothing. Clearing the display touches nothing else, and leaving ends only this process.
// cli/index.ts starts it.

import { createElement as h, useEffect, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Box, Text, useApp, useInput, useStdout } from 'ink';
import { galaxyFrame } from './galaxy.ts';
import { PanelView } from './panel-view.ts';
import type { Panel } from './panel.ts';
export type { Panel } from './panel.ts';
import { ChoiceSelector } from './selector.ts';
import { backspace, browse, emptyInput, foldedText, insert, menuOf, moveCursor, statusLine, submit } from './state.ts';
import type { InputState, MenuCommand, StatusBrief } from './state.ts';

export type ChatEntry = { who: 'owner' | 'her' | 'system'; text: string };
export type Question = {
  question: string;
  secret: boolean;
  /** a closed question: the answer is one of these, exactly as given */
  choices?: ReadonlyArray<string> | null;
  answer: (text: string) => void;
};
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
  initialInput?: string;
};

const GALAXY_MS = 200;
const POLL_MS = 15_000;
/** The rows a question's selector draws at most; the input it replaces stays out of the way of the panel above it. */
const QUESTION_ROWS = 8;

/** Who takes the keys and a paste now. A question goes first, because the core is waiting on it. */
function focusOwner(question: Question | null, panel: Panel | null): 'choices' | 'input' | 'panel' {
  if (question !== null) return (question.choices?.length ?? 0) > 0 ? 'choices' : 'input';
  return panel === null ? 'input' : 'panel';
}

function Header({ env, line }: { env: ChatEnv; line: string }) {
  const [tick, setTick] = useState(0);
  useEffect(() => {
    if (env.still) return undefined;
    const timer = setInterval(() => setTick((value) => value + 1), GALAXY_MS);
    return () => clearInterval(timer);
  }, [env.still]);
  return h(
    Box,
    { paddingX: 1, gap: 2, marginBottom: 1 },
    h(Text, { color: 'magenta' }, galaxyFrame(tick).join('\n')),
    h(
      Box,
      { flexDirection: 'column' },
      h(Text, { bold: true, color: 'cyan' }, env.title),
      h(Text, { wrap: 'wrap' }, line)
    )
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
      .slice(Math.max(0, selected - 7), Math.max(0, selected - 7) + 8)
      .map((item, index) =>
        h(
          Text,
          { key: item.name, inverse: index + Math.max(0, selected - 7) === selected },
          `/${item.name}  `,
          h(Text, { dimColor: index + Math.max(0, selected - 7) !== selected }, item.help)
        )
      )
  );
}

export function ChatApp({ env }: { env: ChatEnv }): ReactElement {
  const { exit } = useApp();
  const { stdout } = useStdout();
  const [rows, setRows] = useState<number>((stdout as { rows?: number }).rows || 24);
  useEffect(() => {
    const resize = (): void => setRows((stdout as { rows?: number }).rows || 24);
    stdout.on('resize', resize);
    return () => {
      stdout.off('resize', resize);
    };
  }, [stdout]);
  const [entries, setEntries] = useState<ReadonlyArray<ChatEntry>>([]);
  const [input, setInput] = useState(() => {
    const state = emptyInput(env.history);
    return { ...state, text: env.initialInput ?? '', cursor: env.initialInput?.length ?? 0 };
  });
  const [selected, setSelected] = useState(0);
  const [expanded, setExpanded] = useState(false);
  const [panel, setPanel] = useState<Panel | null>(null);
  const [question, setQuestion] = useState<Question | null>(null);
  const [connected, setConnected] = useState(true);
  const [brief, setBrief] = useState<StatusBrief | null>(null);
  const [polledAt, setPolledAt] = useState<number | null>(null);
  const subscribed = useRef(false);
  // Counts the panel requests: an answer that is not of the newest one belongs to an overlay the owner left.
  const panelRequest = useRef(0);
  // The composer as a question found it. The answer is typed in another buffer, so it can reach neither the draft nor the screen.
  const draft = useRef<InputState | null>(null);
  const latestInput = useRef(input);
  latestInput.current = input;
  const latestQuestion = useRef(question);
  latestQuestion.current = question;

  useEffect(() => {
    if (subscribed.current) return;
    subscribed.current = true;
    env.subscribe({
      entry: (entry) => setEntries((list) => [...list, entry]),
      question: (asked) => {
        const open = latestQuestion.current;
        // Only one question fits the screen: the older command gets the empty answer of a cancelled one.
        if (open === null) draft.current = latestInput.current;
        else open.answer('');
        latestQuestion.current = asked;
        setInput(emptyInput(latestInput.current.history));
        setQuestion(asked);
      },
      connected: (now) => setConnected(now),
    });
  }, [env]);

  // A read of what the core already knows: no probe and no provider call for the display.
  useEffect(() => {
    const poll = (): void => {
      void env
        .status()
        .then((answer) => {
          if (answer !== null) {
            setBrief(answer);
            setPolledAt(env.now());
          }
        })
        .catch(() => {});
    };
    poll();
    const timer = setInterval(poll, POLL_MS);
    return () => clearInterval(timer);
  }, [env]);

  const items = question === null ? menuOf(input.text, env.commands) : [];
  const owner = focusOwner(question, panel);

  /** Closes the question and gives the composer back what it held, with what `history` says now. */
  function endQuestion(history: ReadonlyArray<string>): void {
    const held = draft.current;
    draft.current = null;
    latestQuestion.current = null;
    setQuestion(null);
    setInput(held === null ? emptyInput(history) : { ...held, history, browsing: null });
  }

  function send(): void {
    if (
      question === null &&
      items[selected] !== undefined &&
      !env.commands.some((one) => input.text === `/${one.name}`)
    ) {
      setInput(emptyInputWith(input, `/${items[selected].name} `));
      return;
    }
    const secret = question?.secret === true;
    const { line, next } = submit(input, { secret });
    setInput(next);
    setSelected(0);
    if (question !== null) {
      question.answer(line);
      endQuestion(next.history);
      return;
    }
    if (line.trim() === '') return;
    env.saveHistory(next.history);
    if (line.trim() === '/clear') {
      setEntries([]);
      return;
    }
    setEntries((list) => [...list, { who: 'owner', text: line }]);
    // A chat line replaces no overlay; a command does, and the older request's answer is dropped whatever it is.
    if (line.trim().startsWith('/')) panelRequest.current += 1;
    const request = panelRequest.current;
    void env
      .panelOf(line.trim())
      .then((opened) => {
        if (request !== panelRequest.current) return;
        if (opened === null) env.send(line);
        else setPanel(opened);
      })
      .catch((error: unknown) =>
        setEntries((old) => [
          ...old,
          { who: 'system', text: error instanceof Error ? error.message : 'The command failed.' },
        ])
      );
  }

  // health: allow complexity until 2027-04-01 -- one table of the keys of the chat, and split up it would hide which key does what
  useInput((typed, key) => {
    if (key.ctrl && typed === 'c') {
      exit();
      return;
    }
    if (owner !== 'input') return;
    if (key.ctrl && typed === 'o') setExpanded((value) => !value);
    else if (key.ctrl && typed === 'd' && input.text === '') exit();
    else if (key.ctrl && typed === 'j') setInput((state) => insert(state, '\n'));
    else if (key.return && key.meta) setInput((state) => insert(state, '\n'));
    else if (key.return) send();
    else if (key.tab && items[selected] !== undefined) setInput(emptyInputWith(input, `/${items[selected].name} `));
    else if (key.escape) {
      if (question !== null) {
        question.answer('');
        endQuestion(input.history);
        return;
      }
      // The panel still on its way opens nothing now.
      panelRequest.current += 1;
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
    { flexDirection: 'column', minHeight: Math.max(10, rows) },
    h(Header, { env, line: statusLine(brief, { connected, polledAt, now: env.now() }) }),
    h(
      Box,
      { flexDirection: 'column', flexGrow: 1 },
      h(
        Box,
        { flexDirection: 'column', flexGrow: 1, justifyContent: 'flex-end' },
        ...entries.map((entry, index) => h(Entry, { key: String(index), entry, expanded }))
      ),
      panel === null
        ? null
        : h(PanelView, {
            key: String(panelRequest.current),
            panel,
            active: owner === 'panel',
            close: () => setPanel(null),
            prefill: (line: string) => {
              setPanel(null);
              setInput(emptyInputWith(input, line));
            },
          })
    ),
    h(
      Box,
      { flexDirection: 'column', flexShrink: 0 },
      panel === null && items.length > 0 ? h(Menu, { items, selected }) : null,
      question === null ? null : h(Text, { bold: true }, question.question),
      owner === 'choices' && question !== null
        ? h(ChoiceSelector, {
            key: question.question,
            choices: question.choices ?? [],
            active: true,
            height: QUESTION_ROWS,
            answer: (value: string) => {
              question.answer(value);
              endQuestion(input.history);
            },
            cancel: () => {
              question.answer('');
              endQuestion(input.history);
            },
          })
        : h(
            Box,
            { borderStyle: 'round', paddingX: 1 },
            h(Text, null, '> ', before, h(Text, { inverse: true }, after[0] ?? ' '), after.slice(1))
          ),
      h(
        Text,
        { dimColor: true },
        question !== null
          ? owner === 'choices'
            ? '↑↓ select · type to filter · Enter choose · Esc cancel'
            : 'Enter continue · Esc cancel'
          : '/ commands · /setup connections · /config settings · Ctrl+O expand'
      )
    )
  );
}

function emptyInputWith(state: ReturnType<typeof emptyInput>, text: string): ReturnType<typeof emptyInput> {
  return { ...state, text, cursor: text.length, browsing: null };
}
