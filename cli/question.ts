// A setup question in the same visual language as the chat. An explicit choice list gets arrow selection; other
// questions keep editable text and a default. Secrets are masked and this component writes no input history.
import { createElement as h, useState } from 'react';
import type { ReactElement } from 'react';
import { Box, Text, render, useApp, useInput } from 'ink';
import { backspace, emptyInput, insert, moveCursor } from './state.ts';

type Options = { secret?: boolean; choices?: ReadonlyArray<string> };
type Props = { question: string; offered: string | null; options: Options; answer: (text: string | null) => void };

function QuestionView({ question, offered, options, answer }: Props): ReactElement {
  const { exit } = useApp();
  const [input, setInput] = useState(emptyInput());
  const choices = options.choices ?? [];
  const [selected, setSelected] = useState(Math.max(0, choices.indexOf(offered ?? '')));
  const finish = (text: string | null): void => {
    answer(text);
    exit();
  };
  useInput((typed, key) => {
    if (key.escape || (key.ctrl && typed === 'c')) {
      finish(null);
      return;
    }
    if (key.return) {
      finish(choices[selected] ?? input.text);
      return;
    }
    if (choices.length > 0) {
      if (key.upArrow) setSelected((old) => Math.max(0, old - 1));
      else if (key.downArrow) setSelected((old) => Math.min(choices.length - 1, old + 1));
      return;
    }
    if (key.leftArrow) setInput((old) => moveCursor(old, -1));
    else if (key.rightArrow) setInput((old) => moveCursor(old, 1));
    else if (key.backspace || key.delete) setInput((old) => backspace(old));
    else if (key.ctrl && typed === 'u') setInput(emptyInput());
    else if (!key.ctrl && !key.meta && typed !== '') setInput((old) => insert(old, typed));
  });
  const text = options.secret === true ? '*'.repeat([...input.text].length) : input.text;
  return h(
    Box,
    { flexDirection: 'column', borderStyle: 'round', borderColor: 'cyan', paddingX: 1 },
    h(Text, { bold: true, color: 'cyan' }, 'Project Neptunia · Setup'),
    h(Text, null, question),
    offered === null || options.secret === true ? null : h(Text, { dimColor: true }, `Default: ${offered}`),
    ...(choices.length > 0
      ? choices.map((choice, i) =>
          h(Text, { key: choice, inverse: i === selected }, `${i === selected ? '›' : ' '} ${choice}`)
        )
      : [h(Text, { key: 'input' }, `› ${text}▏`)]),
    h(
      Text,
      { dimColor: true },
      choices.length > 0 ? '↑↓ choose · Enter continue · Esc cancel' : 'Enter continue · Ctrl+U clear · Esc cancel'
    )
  );
}

export async function askQuestion(
  question: string,
  offered: string | null,
  options: Options = {},
  streams: { stdin?: NodeJS.ReadStream; stdout?: NodeJS.WriteStream } = {}
): Promise<string> {
  let answer: string | null = null;
  const app = render(
    h(QuestionView, {
      question,
      offered,
      options,
      answer: (text) => {
        answer = text;
      },
    }),
    { exitOnCtrlC: false, interactive: true, ...streams }
  );
  try {
    await app.waitUntilExit();
  } finally {
    app.unmount();
  }
  if (answer === null) throw new Error('Setup cancelled. Run setup again to continue.');
  return answer;
}
