// The interactive chat's screen, written with `React.createElement`, so no build step appears: the header, the rows of the
// transcript that fit, the input with its slash menu, and panels over the chat for `/help`, `/status` and `/config` with a
// search, and the model selector for `/model`. A closed question is a selector over its choices. What each key does and what
// each row holds comes from cli/chat-controller.ts, and cli/index.ts starts it.

import { createElement as h, useEffect, useReducer, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Box, Text, useApp, useInput, usePaste, useStdout } from 'ink';
import { ComposerBox, Header, Menu, TranscriptRows } from './chat-view.ts';
import { ChatController } from './chat-controller.ts';
import { osc52 } from './clipboard.ts';
import type { ChatEnv, ChatFrame } from './chat-controller.ts';
export type { ChatEntry, ChatEnv, ChatImages, Question, StageResult } from './chat-controller.ts';
import { ModelPicker } from './model-picker.ts';
import type { MouseSource } from './mouse.ts';
import { PanelView } from './panel-view.ts';
export type { Panel } from './panel.ts';
import { ChoiceSelector } from './selector.ts';
import { THEME } from './theme.ts';

const POLL_MS = 15_000;

/** The panel over the transcript, with the keys while it owns them. */
function OpenPanel({ chat, frame, request }: { chat: ChatController; frame: ChatFrame; request: number }) {
  const { panel } = chat.model;
  if (panel === null) return null;
  const active = frame.owner === 'panel';
  const close = (): void => chat.closePanel();
  if (panel.picker !== undefined) return h(ModelPicker, { key: String(request), env: panel.picker, active, close });
  return h(PanelView, {
    key: String(request),
    panel,
    active,
    close,
    prefill: (line: string) => chat.prefill(line),
  });
}

/** The question, the notice, and the input or a closed question's selector. */
function Bottom({ chat, frame }: { chat: ChatController; frame: ChatFrame }) {
  const { question: pending, notice, selected } = chat.model;
  const { items, menuHeight, hasChoices, choiceRows, layout, isLinear, owner, turnRow } = frame;
  return h(
    Box,
    { flexDirection: 'column', flexShrink: 0 },
    menuHeight > 0 ? h(Menu, { items, selected, height: menuHeight }) : null,
    pending === null ? null : h(Text, { bold: true }, pending.question),
    turnRow === null ? null : h(Text, { ...THEME.muted, wrap: 'truncate' }, turnRow),
    notice === null ? null : h(Text, { ...THEME.warning, wrap: 'truncate' }, notice),
    hasChoices && pending !== null
      ? h(ChoiceSelector, {
          key: pending.question,
          choices: pending.choices ?? [],
          active: true,
          height: choiceRows,
          answer: (value: string) => chat.closeQuestion(value),
          cancel: () => chat.closeQuestion(''),
        })
      : h(ComposerBox, { layout, isLinear, isActive: owner === 'input' })
  );
}

export function ChatApp({ env, mouse = null }: { env: ChatEnv; mouse?: MouseSource | null }): ReactElement {
  const { exit, suspendTerminal } = useApp();
  const { stdout } = useStdout();
  const sizeOf = (): { rows: number; columns: number } => {
    const { rows, columns } = stdout as { rows?: number; columns?: number };
    return { rows: rows || 24, columns: columns || 80 };
  };
  const [{ rows, columns }, setSize] = useState(sizeOf);
  useEffect(() => {
    const resize = (): void => setSize(sizeOf());
    stdout.on('resize', resize);
    return () => {
      stdout.off('resize', resize);
    };
  }, [stdout]);
  const [, paint] = useReducer((tick: number) => tick + 1, 0);
  // A copy goes straight to the terminal: the sequence draws nothing, so Ink's frame stays as it is.
  const copy = (text: string): void => void stdout.write(osc52(text));
  const [chat] = useState(() => new ChatController(env, { exit, suspendTerminal, paint, copy }));
  const subscribed = useRef(false);
  useEffect(() => {
    if (subscribed.current) return;
    subscribed.current = true;
    chat.subscribe();
  }, [chat]);
  useEffect(() => {
    chat.pollStatus();
    const timer = setInterval(() => chat.pollStatus(), POLL_MS);
    return () => clearInterval(timer);
  }, [chat]);
  useEffect(() => mouse?.onReport((report) => chat.onMouse(report)), [chat, mouse]);

  const frame = chat.frame(rows, columns);
  useInput((text, key) => chat.onKey(text, key, frame.owner));
  // Only while the input holds the keys: otherwise Ink hands a paste to the owner's key handler, as text.
  usePaste((payload) => chat.onPaste(payload), { isActive: frame.owner === 'input' });

  return h(
    Box,
    // The whole window and never a row more: a taller frame would scroll the screen and break the next redraw.
    { flexDirection: 'column', ...(frame.isLinear ? {} : { height: rows, overflow: 'hidden' }) },
    h(Header, { mode: frame.mode, title: env.title, still: env.still, status: frame.status }),
    h(
      Box,
      { flexDirection: 'column', flexGrow: 1, flexShrink: 1, overflow: 'hidden' },
      h(TranscriptRows, {
        rows: frame.transcript.rows,
        marks: frame.marks,
        whoOf: (entryId: string) => chat.whoOf(entryId),
      }),
      frame.isOffTail
        ? h(Text, { ...THEME.muted, wrap: 'truncate' }, `↓ ${frame.transcript.hiddenBelow} rows below · Page Down`)
        : null,
      h(OpenPanel, { chat, frame, request: chat.panelRequest })
    ),
    h(Bottom, { chat, frame })
  );
}
