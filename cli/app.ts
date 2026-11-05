// The interactive chat's screen, written with `React.createElement`, so no build step appears: the header, the rows of the
// transcript that fit, the input with its slash menu, and panels over the chat for `/help`, `/status` and `/config` with a
// search, and the model selector for `/model`. A closed question is a selector over its choices. What each key does and what
// each row holds comes from cli/chat-controller.ts, and cli/index.ts starts it.

import { createElement as h, useEffect, useReducer, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Box, Text, useApp, useInput, usePaste, useStdout } from 'ink';
import { ComposerBox, Header, Menu, TranscriptRows } from './chat-view.ts';
import { ChatController } from './chat-controller.ts';
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

/** The question, the notice, the input or a closed question's selector, and the footer. */
function Bottom({ chat, frame }: { chat: ChatController; frame: ChatFrame }) {
  const { question, notice, selected } = chat.model;
  const { items, menuHeight, hasChoices, choiceRows, layout, isLinear, owner, footer, turnRow } = frame;
  return h(
    Box,
    { flexDirection: 'column', flexShrink: 0 },
    menuHeight > 0 ? h(Menu, { items, selected, height: menuHeight }) : null,
    question === null ? null : h(Text, { bold: true }, question.question),
    turnRow === null ? null : h(Text, { ...THEME.muted, wrap: 'truncate' }, turnRow),
    notice === null ? null : h(Text, { ...THEME.warning, wrap: 'truncate' }, notice),
    hasChoices && question !== null
      ? h(ChoiceSelector, {
          key: question.question,
          choices: question.choices ?? [],
          active: true,
          height: choiceRows,
          answer: (value: string) => chat.closeQuestion(value),
          cancel: () => chat.closeQuestion(''),
        })
      : h(ComposerBox, { layout, isLinear, isActive: owner === 'input' }),
    h(Text, { ...THEME.muted, wrap: 'truncate' }, footer)
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
  const [chat] = useState(() => new ChatController(env, { exit, suspendTerminal, paint }));
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
    { flexDirection: 'column', ...(frame.isLinear ? {} : { minHeight: rows }) },
    h(Header, { mode: frame.mode, title: env.title, still: env.still, status: frame.status }),
    h(
      Box,
      { flexDirection: 'column', flexGrow: 1 },
      h(TranscriptRows, { rows: frame.transcript.rows, whoOf: (entryId: string) => chat.whoOf(entryId) }),
      frame.isOffTail
        ? h(Text, { ...THEME.muted, wrap: 'truncate' }, `↓ ${frame.transcript.hiddenBelow} rows below · Page Down`)
        : null,
      h(OpenPanel, { chat, frame, request: chat.panelRequest })
    ),
    h(Bottom, { chat, frame })
  );
}
