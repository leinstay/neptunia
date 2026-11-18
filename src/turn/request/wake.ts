// What a turn's request carries from the persona's own life beside the chat: her errands and the result that opened
// the turn, her intentions, an inner turn's wake, the places page and her previous think. The turn renders all but
// the last (src/errands/blocks.ts, src/intentions/blocks.ts, src/behavior/wake.ts). buildRequest
// (src/behavior/prompt.ts) puts them in the tail, never cut.

import { fill, formatDuration } from '../../format.ts';
import { inertThink } from '../../behavior/previous-think.ts';
import type { Labels, RequestInput } from './types.ts';

/**
 * Her think of the latest earlier turn in this place (src/behavior/previous-think.ts), and the older thinks before
 * it, oldest first.
 */
export type PreviousThink = {
  readonly text: string;
  readonly ageMs?: number;
  readonly earlier?: ReadonlyArray<{ readonly text: string; readonly ageMs: number }>;
};

/** One think under its line of age (`labels.previousThink.earlier` with `{ago}`), '' for an empty think. */
function earlierThinkLines(text: unknown, ageMs: unknown, meta: string, labels: Labels): string {
  const think = inertThink(text);
  if (!think) return '';
  const ago = formatDuration(Math.max(0, Number(ageMs) || 0), labels.units ?? {});
  return `${fill(meta, { ago })}\n${think}`;
}

/**
 * The `<previous_think>` body (docs/prompt-contract.md): `labels.previousThink.note`, then each think under its line
 * of age (`labels.previousThink.earlier` with `{ago}`) as inert text (src/behavior/previous-think.ts#inertThink), the
 * older thinks first. '' without a think, without the note label or without the label of the line of age. Pure.
 */
export function previousThinkBody(previous: PreviousThink | null | undefined, labels: Labels): string {
  const l = labels?.previousThink;
  if (!previous || !inertThink(previous.text) || typeof l?.note !== 'string' || !l.note) return '';
  const meta = l.earlier;
  if (typeof meta !== 'string' || !meta) return '';
  const thinks = [...(previous.earlier ?? []), previous].map((one) =>
    earlierThinkLines(one.text, one.ageMs, meta, labels)
  );
  return [l.note, ...thinks.filter(Boolean)].join('\n');
}

/** What the turn rendered from her own life for the tail: her errands, her intentions, the wake, the places, her day, her think. */
export type WakeTexts = {
  errandsText: { list: string; result: string };
  intentionsText: string;
  wakeText: string;
  myDayText: string;
  callsText: string;
  previousThinkText: string;
};

/** The bodies of `<errands>`, `<errand_result>`, `<intentions>`, `<wake>`, `<places>`, `<my_day>`, `<calls>` and `<previous_think>`. */
// health: allow complexity until 2027-04-01 -- moved from buildRequest in src/behavior/prompt.ts in stage 5d, a pure split
export function wakeTexts(given: RequestInput, labels: Labels): WakeTexts {
  // The errands' bodies as the turn rendered them (src/errands/blocks.ts); a missing one is ''.
  const errands = given.errands as { list?: unknown; result?: unknown } | null | undefined;
  // `<errands>` and `<errand_result>`: rendered by the turn (src/errands/blocks.ts), never cut.
  const errandsText = {
    list: typeof errands?.list === 'string' ? errands.list : '',
    result: typeof errands?.result === 'string' ? errands.result : '',
  };
  // `<intentions>`: rendered and cut to its own budget by the turn (src/intentions/blocks.ts), never cut here.
  const intentionsText = typeof given.intentions === 'string' ? given.intentions : '';
  // `<wake>`: an inner turn's reason to be awake, rendered by the turn (src/behavior/wake.ts), never cut.
  const wakeText = typeof given.wake === 'string' ? given.wake : '';
  // `<previous_think>`: her reasoning from the request before this one (features.previousThink, chosen by the turn), never cut.
  const previousThinkText = previousThinkBody(given.previousThink, labels);
  // `<my_day>` and `<calls>`: her day and her calls, headed by the turn and bounded by context.myDay.lines and
  // context.calls.lines, never cut.
  const myDayText = (given.myDay ?? []).join('\n');
  const callsText = (given.calls ?? []).join('\n');
  return { errandsText, intentionsText, wakeText, myDayText, callsText, previousThinkText };
}
