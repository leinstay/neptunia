// `<attitudes>` inside `<self>`: the people she feels most strongly about, warm and cool together, one line each. The
// read ranks them (src/memory/db/frame-reads.ts#strongestAttitudesOf); this module words them (`attitudes.header`,
// `attitudes.line`, the band words of `affinity.bands`) and reads `context.attitudes.shown`. Pure.

import { affinityBand } from '../../memory/affinity.ts';
import { fill } from '../../format.ts';
import type { StrongAttitude } from '../../memory/db/frame-reads.ts';
import type { Labels } from './types.ts';

/** The words of a request's attitudes: the labels and how a person is declared (`@handle: Name`). */
export type AttitudeWords = { labels: Labels; who: (person: string) => string };

/** `context.attitudes.shown` of the live config; null when it is no whole non-negative number. */
export function attitudesShownOf(
  config: { context?: { attitudes?: { shown?: unknown } } } | null | undefined
): number | null {
  const attitudes = config?.context?.attitudes;
  const shown = attitudes?.shown;
  return typeof shown === 'number' && Number.isInteger(shown) && shown >= 0 ? shown : null;
}

/**
 * The block's text without its tags: `attitudes.header`, then one `attitudes.line` per person in the order given, with
 * `{who}` and `{band}`, the word of `affinity.bands` for the band of the score. '' when the list is empty or a label is
 * missing.
 */
export function attitudesText(list: ReadonlyArray<StrongAttitude>, words: AttitudeWords): string {
  const { attitudes: own, affinity } = words.labels;
  const bands = affinity?.bands;
  if (list.length === 0 || typeof own?.header !== 'string' || typeof own.line !== 'string') return '';
  const lines = list.map((one) =>
    fill(own.line ?? '', { who: words.who(one.person), band: bands?.[affinityBand(one.score)] ?? '' })
  );
  return [own.header, ...lines].join('\n');
}
