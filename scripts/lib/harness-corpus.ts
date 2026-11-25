// The corpus of a scripts/harness.ts run: one stored turn per line, as `<group> <turnId>`, blank lines skipped. The
// group names why the turn was chosen and only labels the run's stderr.

import { CliError } from './cli.ts';

/** One turn of the corpus. */
export type CorpusTurn = { group: string; turnId: string };

/** The turns of a corpus file's text, in its order. Refuses a line that is not two words. */
export function readCorpus(text: string): Array<CorpusTurn> {
  const turns: Array<CorpusTurn> = [];
  for (const [index, line] of text.split('\n').entries()) {
    const words = line.trim().split(/\s+/).filter(Boolean);
    if (words.length === 0) continue;
    const [group, turnId] = words;
    if (words.length !== 2 || group === undefined || turnId === undefined)
      throw new CliError(`harness: corpus line ${index + 1} is not "<group> <turnId>"`);
    turns.push({ group, turnId });
  }
  return turns;
}
