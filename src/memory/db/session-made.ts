// The lines of a memory session's `<people>` entry that say what she made for a person while the batch was written:
// one for the span from the batch's first line to its last, and one for the day of its last line when the day holds
// more (`labels.memory.sessionMade`, `labels.memory.sessionMadeDay`). The items are built as the lines of `<my_day>`
// build them (madeText in src/turn/request/my-day.ts), from `labels.myDay`. Both counts end at the batch's last line,
// never at the clock, so two requests of one batch hold the same bytes.

import { fill } from '../../format.ts';
import { zonedDay, zonedEpoch } from '../../time.ts';
import { kindsOf, madeText } from '../../turn/request/my-day.ts';
import { madeInSpanOf } from './made-and-given.ts';
import type { SpanCount } from './made-and-given.ts';
import type { Context } from './scope.ts';
import type { Db, Row } from './types.ts';

const totalOf = (counts: Record<string, number>): number => Object.values(counts).reduce((sum, n) => sum + n, 0);

const wordOf = (labels: Row | undefined, key: string): string => (typeof labels?.[key] === 'string' ? labels[key] : '');

/**
 * The made lines per person id of `people`: the span's line, then the day's line when the day holds more. A person
 * she made nothing for, and a line whose label is missing, give no line.
 */
export function sessionMadeLines(
  db: Db,
  ctx: Context,
  input: { from: number; to: number; people: ReadonlyArray<string>; labels: Row; timezone: string }
): Map<string, Array<string>> {
  const lines = new Map<string, Array<string>>();
  const myDay = input.labels.myDay as Row | undefined;
  const memory = input.labels.memory as Row | undefined;
  const kinds = kindsOf(myDay).map(([skill]) => skill);
  if (!myDay || kinds.length === 0 || input.people.length === 0) return lines;
  const dayStart = zonedEpoch(zonedDay(input.to, input.timezone), 0, 0, input.timezone);
  const read = (from: number): Map<string, SpanCount> =>
    new Map(madeInSpanOf(db, ctx, { from, to: input.to, people: input.people, kinds }).map((one) => [one.person, one]));
  const span = read(input.from);
  const day = Number.isFinite(dayStart) && dayStart < input.from ? read(dayStart) : span;
  const spanWord = wordOf(memory, 'sessionMade');
  const dayWord = wordOf(memory, 'sessionMadeDay');
  for (const [person, one] of span) {
    const out: Array<string> = [];
    if (spanWord) out.push(fill(spanWord, { made: madeText(one.made, myDay), turns: String(one.started) }));
    const whole = day.get(person);
    if (dayWord && whole && totalOf(whole.made) > totalOf(one.made))
      out.push(fill(dayWord, { made: madeText(whole.made, myDay) }));
    lines.set(person, out);
  }
  return lines;
}
