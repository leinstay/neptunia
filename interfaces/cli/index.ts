// The entry of the `cli` interface: `start(host)` of the interface contract (link.ts), and the interactive chat that
// `bin/neptunia.ts` draws in a terminal over the commands and the link it gives. Non-interactive output stays in `bin/`,
// which imports link.ts alone for it, so a process with no terminal never loads Ink.

import { createElement } from 'react';
import { render } from 'ink';
import { ChatApp } from './app.ts';
import type { ChatEnv } from './app.ts';
import { mouseFilter } from './mouse.ts';
import { DEFAULT_CELL } from './terminal-graphics.ts';
import { graphicsOverlay, graphicsProbe, replyFilter } from './terminal-replies.ts';
import type { GraphicsSupport, Placement } from './terminal-replies.ts';

export { start } from './link.ts';
export type { CliHost, RunningCli } from './link.ts';
export { reducedMotion } from './galaxy.ts';
export { mouseAvailable } from './mouse.ts';
export type { ChatEntry, ChatEnv, ChatImages, LineFile, LineFiles, Panel, Question, StageResult } from './app.ts';
export type { KeptRead } from './attachment-actions.ts';
export type { ChatAttachment, Draft, DraftPart, PasteLimits } from './composer.ts';
export type { KeyBinding } from './keymap.ts';
export type { StatusBrief } from './state.ts';

// Buttons, the wheel and motion while a button is held, in SGR form: the fewest reports a drag selection needs.
const MOUSE_ON = '\u001b[?1000h\u001b[?1002h\u001b[?1006h';
const MOUSE_OFF = '\u001b[?1006l\u001b[?1002l\u001b[?1000l';
const LEAVE_SCREEN = '\u001b[?1049l\u001b[?25h';

/**
 * Draws the chat until the owner leaves. Leaving ends this process only: the core goes on. Outside the linear mode the
 * chat owns the whole window on the alternate screen, so no frame reaches the terminal's scrollback, and the primary
 * screen comes back as it was on Ctrl-C, a SIGINT, a SIGTERM or a crash.
 */
export async function runInteractive(
  env: ChatEnv,
  streams: { stdin?: NodeJS.ReadStream; stdout?: NodeJS.WriteStream } = {}
): Promise<void> {
  // The terminal's answers about its graphics come on stdin and are taken out before the mouse filter and Ink.
  const replies = replyFilter(streams.stdin ?? process.stdin);
  const mouse = env.mouse === true ? mouseFilter(replies.input) : null;
  const stdout = streams.stdout ?? process.stdout;
  const overlay = graphicsOverlay(stdout);
  // The linear mode stays inline: a screen reader reads the column in the terminal's own history, and gets no picture.
  const alternateScreen = env.linear !== true;
  const probe = alternateScreen
    ? graphicsProbe({ write: (text) => void stdout.write(text), replies: replies.answers, env: process.env })
    : (): Promise<GraphicsSupport> => Promise.resolve({ protocol: 'none', cell: DEFAULT_CELL });
  const graphics = { probe, place: (placement: Placement | null) => overlay.place(placement) };
  // Only a terminal reaches this chat, and Ink otherwise stops drawing under a `CI` variable.
  const app = render(createElement(ChatApp, { env, mouse: mouse?.reports ?? null, graphics }), {
    exitOnCtrlC: false,
    interactive: true,
    alternateScreen,
    ...streams,
    stdout: overlay.stdout,
    stdin: mouse?.input ?? replies.input,
  });
  if (mouse !== null) stdout.write(MOUSE_ON);
  let restored = false;
  /** Mouse tracking off, once. Ink leaves the alternate screen itself when the app unmounts. */
  const restore = (): void => {
    if (restored) return;
    restored = true;
    overlay.place(null);
    replies.close();
    if (mouse === null) return;
    stdout.write(MOUSE_OFF);
    mouse.close();
  };
  // A SIGINT or a SIGTERM leaves like Ctrl-C: the app unmounts, so the lines below run and the terminal comes back.
  const onSignal = () => app.unmount();
  // A crash ends the process before the app unmounts: the primary screen and the cursor come back here.
  const onExit = (): void => {
    if (alternateScreen) stdout.write(LEAVE_SCREEN);
    restore();
  };
  process.once('SIGINT', onSignal);
  process.once('SIGTERM', onSignal);
  process.once('exit', onExit);
  try {
    await app.waitUntilExit();
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    process.off('exit', onExit);
    restore();
  }
  // Inline, the frame ends on its last line: the shell prompt starts on a fresh one.
  if (!alternateScreen) stdout.write('\n');
}
