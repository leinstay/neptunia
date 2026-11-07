// The body of `<inner>`: her own state that lasts between turns (docs/prompt-contract.md). `<my_day>` with what she did
// today, `<intentions>`, `<errands>`, `<feedback>` with what she has not yet been told, a selfimprovement wake's `<work>`
// and `<board>`, and `<previous_think>`, in that order. Every stored text in it passes through `resolveRef` (src/turn/request/refs.ts), so a line's identity never
// reaches her raw. The request builder (src/turn/request/reader.ts) calls it. Pure.

import { block } from './text.ts';
import type { Labels } from './types.ts';
import { previousThinkBody } from './wake.ts';
import type { PreviousThink } from './wake.ts';

/** The parts of `<inner>` as the turn rendered them; `myDay` is already headed, a null part is absent. */
export type InnerParts = {
  myDay: ReadonlyArray<string>;
  intentions: string | null;
  errands: string | null;
  feedback: string | null;
  /** A selfimprovement wake's report of her own calls and the board's news; null on any other turn. */
  work?: string | null;
  board?: string | null;
  previousThink: PreviousThink | null;
};

const textOf = (text: string | null, resolveRef: (text: string) => string): string =>
  typeof text === 'string' && text.trim() !== '' ? resolveRef(text) : '';

/** The body of `<inner>`, '' when none of its parts has anything. */
export function innerBlockOf(parts: InnerParts, labels: Labels, resolveRef: (text: string) => string): string {
  const think = parts.previousThink
    ? previousThinkBody({ ...parts.previousThink, text: resolveRef(parts.previousThink.text) }, labels)
    : '';
  return [
    block('my_day', parts.myDay.filter((line) => typeof line === 'string' && line !== '').join('\n')),
    block('intentions', textOf(parts.intentions, resolveRef)),
    block('errands', textOf(parts.errands, resolveRef)),
    block('feedback', textOf(parts.feedback, resolveRef)),
    block('work', textOf(parts.work ?? null, resolveRef)),
    block('board', textOf(parts.board ?? null, resolveRef)),
    block('previous_think', think),
  ]
    .filter(Boolean)
    .join('\n');
}
