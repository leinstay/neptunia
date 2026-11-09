// The questions a command asks the owner in the `neptunia` chat (the key value of `/keys add`): `createAnswers`
// takes the lines of a readline interface that a question is waiting for, so the line is the answer and never a command.
// A secret question follows hermes_cli/secret_prompt.py: nothing the owner types is echoed, one `*` stands for each
// character and backspace takes one away, and the answer never reaches the history of the chat (neither the
// interface's list nor the file bin/neptunia.ts keeps). The echo is silenced by `mutableOutput`, the writable the
// interface is given in place of the terminal: readline draws its characters into it, and it passes them on until
// it is muted. Ctrl-C and the end of the input abort a question with an empty answer. Used by bin/neptunia.ts.

import { Writable } from 'node:stream';
import type readline from 'node:readline';

/** A writable that passes everything to `target` until `muted` is set. */
export type MutableOutput = Writable & { muted: boolean };

export function mutableOutput(target: NodeJS.WritableStream): MutableOutput {
  const output = new Writable({
    write(chunk: Buffer | string, _encoding, done) {
      if (!output.muted) target.write(chunk);
      done();
    },
  }) as MutableOutput;
  output.muted = false;
  // readline wraps its lines by the width of its output and redraws on a resize: both come from the real terminal.
  Object.defineProperty(output, 'columns', { get: () => Reflect.get(target, 'columns') as number | undefined });
  target.on('resize', () => output.emit('resize'));
  return output;
}

/** The part of a keypress event the question reads. */
type Key = { name?: string; ctrl?: boolean; meta?: boolean; sequence?: string };

export type Answers = {
  /**
   * Asks `question` and resolves with the next line the owner enters. A secret answer is echoed as stars only, and a
   * closed question's `choices` are printed with it, because this prompt has no menu.
   */
  ask(question: string, secret: boolean, choices?: ReadonlyArray<string> | null): Promise<string>;
  /** Hands `line` to the question waiting for it; false when none waits, and the line is a command. */
  take(line: string): boolean;
  /** Whether a secret question is waiting: the chat must not write its history file meanwhile. */
  secretWaiting(): boolean;
};

type Waiting = { resolve: (text: string) => void; secret: boolean; stars: number };

/** The interface's list of lines, newest first (`rl.history`, documented by Node but missing from its types). */
function historyOf(rl: readline.Interface): Array<string> {
  const lines: unknown = Reflect.get(rl, 'history');
  return Array.isArray(lines) ? (lines as Array<string>) : [];
}

export function createAnswers({
  rl,
  input,
  output,
  target,
}: {
  /** The readline interface that reads the lines. */
  rl: readline.Interface;
  /** The stream it reads, which emits `keypress` in a terminal. */
  input: NodeJS.EventEmitter;
  /** The muted output the interface draws into, null without a terminal (then nothing is echoed anyway). */
  output: MutableOutput | null;
  /** Where the questions and the stars are written. */
  target: NodeJS.WritableStream;
}): Answers {
  let waiting: Waiting | null = null;

  const onKey = (typed: string | undefined, key: Key | undefined): void => {
    if (waiting === null || !waiting.secret) return;
    if (key?.name === 'backspace') {
      if (waiting.stars > 0) {
        waiting.stars -= 1;
        target.write('\b \b');
      }
      return;
    }
    // A control key, an arrow or Enter draws nothing; only a printed character counts.
    if (key?.ctrl === true || key?.meta === true || key?.name === 'return' || key?.name === 'enter') return;
    if (typed === undefined || typed === '' || (key?.sequence ?? typed).startsWith('\x1b')) return;
    waiting.stars += 1;
    target.write('*');
  };

  /** Ends the waiting question with `text` and restores the echo. */
  function finish(text: string, history: string | null): void {
    if (waiting === null) return;
    const done = waiting;
    waiting = null;
    if (done.secret) {
      if (output !== null) output.muted = false;
      input.off('keypress', onKey);
      rl.off('SIGINT', onInterrupt);
      rl.off('close', onClose);
      target.write('\n');
      // The line was added to the history before it came here: take it out again.
      const lines = historyOf(rl);
      if (history !== null && lines[0] === history) lines.shift();
    }
    done.resolve(text);
  }
  const onInterrupt = (): void => finish('', null);
  const onClose = (): void => finish('', null);

  return {
    ask(question, secret, choices) {
      return new Promise((resolve) => {
        waiting = { resolve, secret, stars: 0 };
        target.write(`${question}${choices == null ? '' : ` (${choices.join(', ')})`} `);
        if (!secret) return;
        if (output !== null) output.muted = true;
        input.on('keypress', onKey);
        rl.on('SIGINT', onInterrupt);
        rl.on('close', onClose);
      });
    },
    take(line) {
      if (waiting === null) return false;
      finish(line, line);
      return true;
    },
    secretWaiting: () => waiting?.secret === true,
  };
}
