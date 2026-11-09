// What `neptunia` makes of its words before anything connects, for bin/neptunia.ts: `parseRequest` reads a command's
// words through the chat's table (src/interface/commands/table.ts) and takes `--secret-stdin` off a leaf that asks for a
// secret, where the same word on any other leaf stays plain text. `panelRefusal` says what a request that needs a
// terminal does instead, and `secretFromStdin` answers one secret question from stdin. Nothing here opens a link or
// imports the Ink chat (interfaces/cli/), which a process with no terminal must never load.

import { COMMANDS, commandLineWords, parseCommandWords, takesSecretStdin } from '../src/interface/commands/table.ts';
import type { Parsed } from '../src/interface/commands/table.ts';
import type { Answers } from './secret-prompt.ts';

/** The flag that gives the answer to a command's secret question on stdin. */
const SECRET_STDIN = '--secret-stdin';

/** Every command of the table, for a usage text. */
export const COMMAND_NAMES: ReadonlyArray<string> = COMMANDS.map((command) => command.name);

/** The commands line of the usage and of an explanation. */
export const COMMANDS_LINE = `commands: ${COMMAND_NAMES.join(', ')}`;

/** A parsed command, and whether its secret question takes stdin. */
export type Request = { parsed: Parsed; secretStdin: boolean };

/** One command as argv words, none of them joined or split. */
export function parseRequest(words: ReadonlyArray<string>): Request {
  const others = words.filter((word) => word !== SECRET_STDIN);
  if (others.length < words.length) {
    const parsed = parseCommandWords(others);
    if (parsed.ok && takesSecretStdin(parsed.name)) return { parsed, secretStdin: true };
  }
  return { parsed: parseCommandWords(words), secretStdin: false };
}

/** One command as the line of `-p`. */
export const parseLineRequest = (line: string): Request => parseRequest(commandLineWords(line));

/** What a panel-only request says with no terminal to draw on: what it needs, and what runs without one. */
export const panelRefusal = (what: string): string =>
  [
    `${what} needs a terminal, and this process has none.`,
    'Run one command with neptunia <command> [args] or neptunia -p "/<command> [args]",',
    'and one turn with her with neptunia -p "<text>".',
    COMMANDS_LINE,
  ].join('\n');

/** A question this process cannot answer: its message says what is missing. */
export class UnansweredQuestion extends Error {}

/** What a question says when nobody can answer it; a secret one names the channel that can. */
export function unansweredText(prompt: string, secret: boolean): string {
  const way = secret
    ? `run the command at a terminal, or give the value on stdin with ${SECRET_STDIN}`
    : 'run the command at a terminal';
  return `${prompt}\nthis command asks a question and nobody is here to answer it: ${way}`;
}

async function readAll(input: NodeJS.ReadableStream): Promise<string> {
  const chunks: Array<Buffer> = [];
  for await (const chunk of input) chunks.push(Buffer.from(chunk as Buffer));
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * The answers of `--secret-stdin`: the first question, when secret, takes all of stdin less one trailing newline.
 * Every other question, and an empty stdin, throws UnansweredQuestion, so no answer is made up.
 */
export function secretFromStdin(input: NodeJS.ReadableStream): Answers {
  let used = false;
  return {
    async ask(prompt, secret) {
      if (!secret || used) throw new UnansweredQuestion(unansweredText(prompt, false));
      used = true;
      const value = (await readAll(input)).replace(/\r?\n$/, '');
      if (value === '') throw new UnansweredQuestion(`${SECRET_STDIN}: stdin is empty, so nothing was sent`);
      return value;
    },
    take: () => false,
    secretWaiting: () => false,
  };
}
