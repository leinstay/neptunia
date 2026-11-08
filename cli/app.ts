// The interactive chat's screen, written with `React.createElement`, so no build step appears: the header, the rows of the
// transcript that fit, the command window with every slash command's answer and the live panel of the newest (`/help`,
// `/config` with a search, the model selector for `/model`), and the input with its slash menu. A closed question is a
// selector over its choices. What each key does and what each row holds comes from cli/chat-controller.ts, and
// cli/index.ts starts it.

import { createElement as h, useEffect, useReducer, useRef, useState } from 'react';
import type { ReactElement } from 'react';
import { Box, Text, useApp, useInput, usePaste, useStdout } from 'ink';
import { ComposerBox, Header, Menu, TranscriptRows } from './chat-view.ts';
import { ChatController } from './chat-controller.ts';
import { osc52 } from './clipboard.ts';
import { CommandWindow } from './command-window.ts';
import type { ChatEnv, ChatFrame } from './chat-controller.ts';
export type { ChatEntry, ChatEnv, ChatImages, LineFile, LineFiles, Question, StageResult } from './chat-controller.ts';
import { ModelPicker } from './model-picker.ts';
import type { MouseSource } from './mouse.ts';
import type { GraphicsSupport, Placement } from './terminal-replies.ts';
import { PanelView } from './panel-view.ts';
export type { Panel } from './panel.ts';
import { ChoiceSelector } from './selector.ts';
import { THEME } from './theme.ts';

const POLL_MS = 15_000;

/** The rows a panel draws around its list: its title, filter, count, detail and keys. */
const PANEL_CHROME_ROWS = 6;
const PICKER_CHROME_ROWS = 4;

/** The live panel inside the command window, with the keys while it owns them, or null with none. */
function openPanel(chat: ChatController, frame: ChatFrame, body: number): ReactElement | null {
  const { panel } = chat.model;
  if (panel === null) return null;
  const active = frame.owner === 'panel';
  const close = (): void => chat.closePanel();
  const key = String(chat.panelRequest);
  if (panel.picker !== undefined)
    return h(ModelPicker, { key, env: panel.picker, active, close, height: Math.max(1, body - PICKER_CHROME_ROWS) });
  return h(PanelView, {
    key,
    panel,
    active,
    close,
    prefill: (line: string) => chat.prefill(line),
    height: Math.max(1, body - PANEL_CHROME_ROWS),
  });
}

/** The slash menu, the question, the input or a closed question's selector, and the status row under them. */
function Bottom({ chat, frame, columns }: { chat: ChatController; frame: ChatFrame; columns: number }) {
  const { question: pending, notice, selected } = chat.model;
  const { items, menuHeight, hasChoices, choiceRows, layout, isLinear, owner, statusRow, hasNotice } = frame;
  const rest = hasNotice && notice !== null ? statusRow.slice(notice.length) : statusRow;
  return h(
    Box,
    { flexDirection: 'column', flexShrink: 0 },
    menuHeight > 0 ? h(Menu, { items, selected, height: menuHeight, columns }) : null,
    pending === null ? null : h(Text, { bold: true }, pending.question),
    hasChoices && pending !== null
      ? h(ChoiceSelector, {
          key: pending.question,
          choices: pending.choices ?? [],
          active: true,
          height: choiceRows,
          answer: (value: string) => chat.closeQuestion(value),
          cancel: () => chat.closeQuestion(''),
        })
      : h(ComposerBox, { layout, isLinear, isActive: owner === 'input' }),
    // One row always, blank with nothing to say, so a notice coming or going moves nothing.
    h(
      Text,
      { wrap: 'truncate' },
      hasNotice && notice !== null ? h(Text, THEME.warning, notice) : null,
      h(Text, THEME.muted, rest === '' && !hasNotice ? ' ' : rest)
    )
  );
}

export function ChatApp({
  env,
  mouse = null,
  graphics,
}: {
  env: ChatEnv;
  mouse?: MouseSource | null;
  /** What the terminal draws pictures with, and the overlay that draws the placed one over each frame. */
  graphics?: { probe: () => Promise<GraphicsSupport>; place: (placement: Placement | null) => void };
}): ReactElement {
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
  const [chat] = useState(
    () =>
      new ChatController(env, {
        exit,
        suspendTerminal,
        paint,
        copy,
        ...(graphics === undefined ? {} : { graphics: graphics.probe }),
      })
  );
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
  // The picture goes over the frame Ink is about to write: the overlay draws it after that write.
  graphics?.place(frame.graphic);
  useInput((text, key) => chat.onKey(text, key, frame.owner));
  // Only while the input holds the keys: otherwise Ink hands a paste to the owner's key handler, as text.
  usePaste((payload) => chat.onPaste(payload), { isActive: frame.owner === 'input' });

  return h(
    Box,
    // The whole window and never a row more: a taller frame would scroll the screen and break the next redraw.
    { flexDirection: 'column', ...(frame.isLinear ? {} : { height: rows, overflow: 'hidden' }) },
    // The galaxy holds still under a picture, so the terminal is not sent the picture again on every tick.
    h(Header, { mode: frame.mode, title: env.title, still: env.still || frame.graphic !== null, status: frame.status }),
    h(
      Box,
      { flexDirection: 'column', flexGrow: 1, flexShrink: 1, overflow: 'hidden' },
      h(TranscriptRows, {
        rows: frame.transcript.rows,
        marks: frame.marks,
        whoOf: (entryId: string) => chat.whoOf(entryId),
      })
    ),
    frame.window === null
      ? null
      : h(CommandWindow, {
          height: frame.window.height,
          columns,
          rows: frame.window.rows,
          marks: frame.window.marks,
          panel: openPanel(chat, frame, frame.window.body),
        }),
    h(Bottom, { chat, frame, columns })
  );
}
