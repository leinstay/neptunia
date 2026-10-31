// What a turn's request carries from the persona's own life beside the chat: her errands and the result that opened
// the turn, her intentions, an inner turn's wake, the places page and her previous think. The turn renders all but
// the last (src/errands/blocks.ts, src/intentions/blocks.ts, src/behavior/wake.ts). buildRequest
// (src/behavior/prompt.js) puts them in the tail, never cut.

import { fill, formatDuration } from '../../format.js';
import { inertThink } from '../../behavior/previous-think.js';
import type { Labels, RequestInput } from './types.ts';

/** Her one previous think (src/behavior/previous-think.js), and whether it was this conversation's last request. */
export type PreviousThink = { readonly text: string; readonly relation: 'same' | 'earlier'; readonly ageMs?: number };

/**
 * The `<previous_think>` body (docs/prompt-contract.md): `labels.previousThink.note`, then one line of
 * engine metadata (`labels.previousThink.same`, or `earlier` with `{ago}`), then the think as inert
 * text (src/behavior/previous-think.js#inertThink). '' without a think, without the note label or
 * without the metadata label of its relation. Pure.
 */
export function previousThinkBody(previous: PreviousThink | null | undefined, labels: Labels): string {
  const l = labels?.previousThink;
  const think = inertThink(previous?.text);
  if (!previous || !think || typeof l?.note !== 'string' || !l.note) return '';
  const meta = previous.relation === 'same' ? l.same : l.earlier;
  if (typeof meta !== 'string' || !meta) return '';
  const ago = formatDuration(Math.max(0, Number(previous.ageMs) || 0), labels.units ?? {});
  return [l.note, fill(meta, { ago }), think].join('\n');
}

/** What the turn rendered from her own life for the tail: her errands, her intentions, the wake, the places, her think. */
export type WakeTexts = {
  errandsText: { list: string; result: string };
  intentionsText: string;
  wakeText: string;
  placesText: string;
  previousThinkText: string;
};

/** The bodies of `<errands>`, `<errand_result>`, `<intentions>`, `<wake>`, `<places>` and `<previous_think>`. */
// health: allow complexity until 2027-04-01 -- moved from buildRequest in src/behavior/prompt.js in stage 5d, a pure split
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
  // `<places>`: an addressed turn's places page (context.places), rendered by the turn, never cut.
  const placesText = typeof given.places === 'string' ? given.places : '';
  // `<previous_think>`: her reasoning from the request before this one (features.previousThink, chosen by the turn), never cut.
  const previousThinkText = previousThinkBody(given.previousThink, labels);
  return { errandsText, intentionsText, wakeText, placesText, previousThinkText };
}
