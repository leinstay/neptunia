// The entry of the interactive chat: `bin/neptunia.ts` starts it in a terminal. It imports nothing of the engine, and its
// caller gives it the commands and the link. Non-interactive output stays in `bin/` and never reaches this package.

import { createElement } from 'react';
import { render } from 'ink';
import { ChatApp } from './app.ts';
import type { ChatEnv } from './app.ts';

export { reducedMotion } from './galaxy.ts';
export type { ChatEntry, ChatEnv, Panel, Question } from './app.ts';
export type { StatusBrief } from './state.ts';

/** Draws the chat until the owner leaves. Leaving ends this process only: the core goes on. */
export async function runInteractive(
  env: ChatEnv,
  streams: { stdin?: NodeJS.ReadStream; stdout?: NodeJS.WriteStream } = {}
): Promise<void> {
  // Only a terminal reaches this chat, and Ink otherwise stops drawing under a `CI` variable.
  const app = render(createElement(ChatApp, { env }), { exitOnCtrlC: false, interactive: true, ...streams });
  await app.waitUntilExit();
}
