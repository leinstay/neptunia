// A question of a command that nobody can answer: what the link answers when the command line has no one to ask, and
// what bin/neptunia-request.ts throws for a question stdin cannot answer. It imports nothing, so a process with no
// terminal loads it without the Ink chat.

/** The flag that gives the answer to a command's secret question on stdin. */
export const SECRET_STDIN = '--secret-stdin';

/** A question this process cannot answer: its message says what is missing. */
export class UnansweredQuestion extends Error {}

/** What a question says when nobody can answer it; a secret one names the channel that can. */
export function unansweredText(prompt: string, secret: boolean): string {
  const way = secret
    ? `run the command at a terminal, or give the value on stdin with ${SECRET_STDIN}`
    : 'run the command at a terminal';
  return `${prompt}\nthis command asks a question and nobody is here to answer it: ${way}`;
}
