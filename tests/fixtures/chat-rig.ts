// The owner chat mounted through its public entry point into a fake terminal, for the terminal specs. Stdin is a real
// Readable with its real encoding decoder, so a chunk boundary inside a UTF-8 character reaches Ink as a real terminal's
// would. No core, no provider. `screen` is the last full frame without its styles, `rawScreen` the same frame with them.
import { Readable, Writable } from 'node:stream';
import { stripVTControlCharacters } from 'node:util';
import { runInteractive } from '../../interfaces/cli/index.ts';
import type { ChatEntry, ChatEnv, Question } from '../../interfaces/cli/index.ts';

export type Rig = {
  stdout: Writable & { columns: number; rows: number; isTTY: boolean };
  stdin: Readable;
  type: (text: string | Buffer) => void;
  resize: (columns: number, rows: number) => void;
  frames: () => string;
  rawScreen: () => string;
  screen: () => Array<string>;
};

export function terminal(columns = 80, rows = 24): Rig {
  let frames = '';
  let raw = '';
  const stdout = Object.assign(
    new Writable({
      write(chunk: Buffer | string, _encoding, done) {
        const text = String(chunk);
        frames += text;
        if (stripVTControlCharacters(text).includes('\n')) raw = text;
        done();
      },
    }),
    { columns, rows, isTTY: true }
  );
  const stdin = Object.assign(new Readable({ read() {} }), {
    isTTY: true,
    setRawMode: () => stdin,
    ref: () => stdin,
    unref: () => stdin,
  });
  return {
    stdout,
    stdin,
    type: (text: string | Buffer): void => void stdin.push(text),
    resize(nextColumns: number, nextRows: number): void {
      stdout.columns = nextColumns;
      stdout.rows = nextRows;
      stdout.emit('resize');
    },
    frames: () => frames,
    rawScreen: () => raw,
    screen: () => stripVTControlCharacters(raw).replace(/\n$/, '').split('\n'),
  };
}

export const pause = (ms = 40): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

const turn = (): Promise<void> => new Promise((resolve) => setImmediate(resolve));

/**
 * Polls until the condition holds or the deadline passes; a condition that never held fails in the assertion after it.
 * Once it holds, two turns of the event loop let React run the effects of the frame just drawn, which bind the key
 * handler to the new owner: a key typed in that gap reaches the handler of the frame before.
 */
export async function until(condition: () => boolean, deadlineMs = 5000): Promise<void> {
  const end = Date.now() + deadlineMs;
  while (!condition() && Date.now() < end) await pause(10);
  await turn();
  await turn();
}

/** A condition that holds while the screen shows the text (or the pattern) anywhere. */
export const shows =
  (rig: Rig, needle: string | RegExp) =>
  (): boolean => {
    const text = rig.screen().join('\n');
    return typeof needle === 'string' ? text.includes(needle) : needle.test(text);
  };

/** Types one input and waits until the app shows its effect, so the next input meets the state it depends on. */
export async function press(rig: Rig, input: string | Buffer, landed: () => boolean): Promise<void> {
  rig.type(input);
  await until(landed);
}

export const KEY = {
  enter: '\r',
  escape: '\u001b',
  backspace: '\u007f',
  up: '\u001b[A',
  down: '\u001b[B',
  left: '\u001b[D',
  right: '\u001b[C',
  pageUp: '\u001b[5~',
  pageDown: '\u001b[6~',
  ctrlC: '\u0003',
  ctrlG: '\u0007',
  ctrlJ: '\n',
  ctrlO: '\u000f',
  ctrlR: '\u0012',
  ctrlS: '\u0013',
  ctrlV: '\u0016',
  ctrlY: '\u0019',
  ctrlZ: '\u001a',
} as const;

export const bracketed = (payload: string): string => `\u001b[200~${payload}\u001b[201~`;

export type Listeners = Parameters<ChatEnv['subscribe']>[0];

/** A chat env over fakes: what was sent, what history was saved, and the listeners the app registered. */
export function chatEnv(over: Partial<ChatEnv> = {}): {
  env: ChatEnv;
  sent: Array<string>;
  saved: Array<ReadonlyArray<string>>;
  listeners: Partial<Listeners>;
  entry: (one: ChatEntry) => void;
  question: (one: Question) => void;
} {
  const sent: Array<string> = [];
  const saved: Array<ReadonlyArray<string>> = [];
  const listeners: Partial<Listeners> = {};
  const env: ChatEnv = {
    title: 'neptunia',
    commands: [
      { name: 'status', help: 'the short summary' },
      { name: 'help', help: 'this list' },
    ],
    history: [],
    still: true,
    send: (line) => void sent.push(line),
    panelOf: () => Promise.resolve(null),
    subscribe: (given) => void Object.assign(listeners, given),
    status: () => Promise.resolve(null),
    saveHistory: (lines) => void saved.push(lines),
    now: () => 1000,
    ...over,
  };
  return {
    env,
    sent,
    saved,
    listeners,
    entry: (one: ChatEntry) => listeners.entry?.(one),
    question: (one: Question) => listeners.question?.(one),
  };
}

export async function withChat(
  env: ChatEnv,
  body: (rig: Rig) => Promise<void>,
  size: { columns?: number; rows?: number } = {}
): Promise<void> {
  const rig = terminal(size.columns, size.rows);
  let subscribed = false;
  const watched: ChatEnv = {
    ...env,
    subscribe: (given) => {
      subscribed = true;
      return env.subscribe(given);
    },
  };
  const running = runInteractive(watched, { stdin: rig.stdin as never, stdout: rig.stdout as never });
  // The first frame is drawn and the app listens for entries: a key or a question sent earlier would be lost.
  await until(() => subscribed && rig.screen().join('').trim() !== '');
  // A failed assertion still closes the chat, so a red test reports instead of hanging the run.
  try {
    await body(rig);
  } finally {
    rig.type(KEY.ctrlC);
    await running;
  }
}
