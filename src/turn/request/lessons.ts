// `<lessons>` inside `<self>`: what people taught her, one line each, from every place the turn's context may read. The
// reads rank them (src/memory/db/frame-reads.ts#lessonsOf); this module cuts them to their own budget and words them
// (`lessons.header`, `lessons.line`), so the cut and the words are the same for the graph reader's seeds and for the
// request. Pure.

import { handleOf } from '../../behavior/handles.ts';
import { fill, mentionsNamed } from '../../format.ts';
import type { Lesson } from '../../memory/db/frame-reads.ts';
import { escapeStored } from './text.ts';
import type { Labels } from './types.ts';

/** The words and the price of a request's lessons. */
export type LessonWords = {
  labels: Labels;
  /** How a `<@id>` of a stored text reads (the same form `<self_facts>` uses). */
  mention: (native: string) => string;
  cost: (text: string) => number;
};

/** `context.lessons.budgetTokens` of the live config; null when it is no whole non-negative number. */
export function lessonsBudgetOf(
  config: { context?: { lessons?: { budgetTokens?: unknown } } } | null | undefined
): number | null {
  const budget = config?.context?.lessons?.budgetTokens;
  return typeof budget === 'number' && Number.isInteger(budget) && budget >= 0 ? budget : null;
}

/** The people who taught the lessons, each once, in order. */
export function teachersOf(lessons: ReadonlyArray<Lesson>): Array<string> {
  return [...new Set(lessons.flatMap((lesson) => (lesson.teacher === null ? [] : [lesson.teacher])))];
}

/**
 * The lessons that fit `budget` (best first, as given), each priced by `price`: the first ones, up to the first that
 * does not fit, so a lesson of lower rank never stands where a better one was left out.
 */
export function lessonsCut(
  lessons: ReadonlyArray<Lesson>,
  budget: number,
  price: (lesson: Lesson) => number
): Array<Lesson> {
  let left = budget;
  const kept: Array<Lesson> = [];
  for (const lesson of lessons) {
    left -= price(lesson);
    if (left < 0) break;
    kept.push(lesson);
  }
  return kept;
}

/** One lesson as a line: its text through the rendering of every stored text, its teacher by `@handle`. */
function lineOf(lesson: Lesson, words: LessonWords): string {
  const { labels, mention } = words;
  const from = lesson.teacher === null ? (labels.authors?.unknown ?? '') : `@${handleOf(lesson.teacher)}`;
  const text = escapeStored(String(mentionsNamed(lesson.text.trim(), mention)));
  return fill(labels.lessons?.line ?? '{text} ({from})', { text, from });
}

/**
 * The block's header and lines for `lessons` within `budget` tokens, the header's price included; no lines when the
 * labels name no header or none fits.
 */
export function lessonsBlockOf(
  lessons: ReadonlyArray<Lesson>,
  budget: number,
  words: LessonWords
): { header: string; lines: Array<string> } {
  const header = words.labels.lessons?.header ?? '';
  const lines = lessonsCut(lessons, budget - words.cost(header), (lesson) => words.cost(lineOf(lesson, words))).map(
    (lesson) => lineOf(lesson, words)
  );
  return { header, lines };
}
