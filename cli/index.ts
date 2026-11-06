// The entry of the interactive chat: `bin/neptunia.ts` starts it in a terminal. It imports nothing of the engine, and its
// caller gives it the commands and the link. Non-interactive output stays in `bin/` and never reaches this package.

import { createElement } from 'react';
import { render } from 'ink';
import { ChatApp } from './app.ts';
import type { ChatEnv } from './app.ts';
import { mouseFilter } from './mouse.ts';

export { reducedMotion } from './galaxy.ts';
export { mouseAvailable } from './mouse.ts';
export type { ChatEntry, ChatEnv, ChatImages, Panel, Question, StageResult } from './app.ts';
export type { ChatAttachment, Draft, DraftPart, PasteLimits } from './composer.ts';
export type { KeyBinding } from './keymap.ts';
export type { StatusBrief } from './state.ts';

/** Draws the chat until the owner leaves. Leaving ends this process only: the core goes on. */
export async function runInteractive(
  env: ChatEnv,
  streams: { stdin?: NodeJS.ReadStream; stdout?: NodeJS.WriteStream } = {}
): Promise<void> {
  const mouse = env.mouse === true ? mouseFilter(streams.stdin ?? process.stdin) : null;
  const stdout = streams.stdout ?? process.stdout;
  const input = mouse === null ? {} : { stdin: mouse.input };
  // Only a terminal reaches this chat, and Ink otherwise stops drawing under a `CI` variable.
  const app = render(createElement(ChatApp, { env, mouse: mouse?.reports ?? null }), {
    exitOnCtrlC: false,
    interactive: true,
    ...streams,
    ...input,
  });
  // SGR reports of buttons and the wheel, with no motion: the fewest reports that do the job.
  if (mouse !== null) stdout.write('\u001b[?1000h\u001b[?1006h');
  // A SIGINT leaves like Ctrl-C: the app unmounts, so the lines below run and the terminal comes back.
  const onSigint = () => app.unmount();
  process.once('SIGINT', onSigint);
  try {
    await app.waitUntilExit();
  } finally {
    process.off('SIGINT', onSigint);
  }
  if (mouse !== null) {
    stdout.write('\u001b[?1006l\u001b[?1000l');
    mouse.close();
  }
  // The frame ends on its footer line: the shell prompt starts on a fresh one.
  stdout.write('\n');
}
