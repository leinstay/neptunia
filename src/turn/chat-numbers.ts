// The numbers of the lines of `<chat>` and the head of its window. A line is numbered by its place among the stored
// lines of its place, deleted ones counted, the oldest being 1: the number the owner's chat draws
// (src/memory/db/chat-lines.ts). The window starts at a line whose number moves in steps of `context.chatHeadStep`, so
// between two moves the block only gains lines at its end. The request setup (src/turn/phases/request/setup.ts) cuts the
// fetched history at the head, the gather step (src/turn/phases/request/gather.ts) numbers the lines the request shows,
// and src/format.ts#formatTranscript prints those numbers. Pure.

/**
 * `context.chatHeadStep` when the setting is missing or not a whole number of at least 0: the head moves with every
 * line. The tracked config/config.json holds the default step under every deployment's own settings.
 */
const HEAD_STEP_MISSING = 0;

/** What the memory gives of a place: its count of stored lines and the numbers of its newest lines by message id. */
export type StoredNumbers = { count: number; numbers: ReadonlyMap<string, number> };

/** A line as the numbering reads it: its message id, and its kind, which is `call` for a call mark. */
type NumberedLine = { readonly id?: unknown; readonly kind?: unknown };

/** `context.chatHeadStep`, read now: the step the window's head moves by, `0` for a head that moves with every line. */
export function chatHeadStepOf(config: { context?: { chatHeadStep?: unknown } } | null | undefined): number {
  const step = config?.context?.chatHeadStep;
  return typeof step === 'number' && Number.isInteger(step) && step >= 0 ? step : HEAD_STEP_MISSING;
}

/** How many lines a turn fetches so the window reaches its head: `count` and the lines a step can add before a move. */
export function chatFetchCount(count: number, step: number): number {
  return count + Math.max(0, step - 1);
}

/** Whether a line takes a number: a message with an id, never a call mark. */
const numbered = (line: NumberedLine): line is NumberedLine & { id: string } =>
  typeof line.id === 'string' && line.id !== '' && line.kind !== 'call';

/**
 * The number of each line of `lines` (in time order) by its id. A stored line takes its stored number. A line the memory
 * has not stored takes the number after the line before it, and a line before the first stored one takes the number
 * that fits before that line, or, with no stored line among them, the place's count plus its place among them. The
 * numbers rise strictly from the first line, at least 1, so no two lines of one request share a number. Without
 * `stored` the lines are numbered from 1.
 */
export function numberLines(
  lines: ReadonlyArray<NumberedLine | null | undefined>,
  stored: StoredNumbers | null
): Map<string, number> {
  const ids = lines
    .filter((line): line is NumberedLine & { id: string } => Boolean(line) && numbered(line!))
    .map((line) => line.id);
  const own = ids.map((id) => stored?.numbers.get(id) ?? null);
  const first = own.findIndex((n) => n !== null);
  // The number of the first line when it is not stored: the one that fits before the first stored line, else the next
  // after the place's count.
  const start = first > 0 ? (own[first] ?? 0) - first : (stored?.count ?? 0) + 1;
  const out = new Map<string, number>();
  let previous = 0;
  ids.forEach((id, i) => {
    const n = Math.max(own[i] ?? (i === 0 ? start : previous + 1), previous + 1);
    out.set(id, n);
    previous = n;
  });
  return out;
}

/**
 * The lines of `lines` from the head of the window on: the line numbered `h = max(1, step * floor((L - count + 1) /
 * step))`, `L` the highest number, or `L - count + 1` with a step of 0. A line without a number (a call mark) stays when
 * it comes after the head.
 */
export function chatHead<TLine extends NumberedLine>(
  lines: ReadonlyArray<TLine>,
  numbers: ReadonlyMap<string, number>,
  count: number,
  step: number
): Array<TLine> {
  const last = Math.max(0, ...numbers.values());
  const head = step > 0 ? Math.max(1, step * Math.floor((last - count + 1) / step)) : last - count + 1;
  const at = lines.findIndex((line) => typeof line.id === 'string' && (numbers.get(line.id) ?? 0) >= head);
  return at < 0 ? [] : lines.slice(at);
}

/** `lines` with each numbered line's number as `lineNumber`, the lines without one as they are. */
export function withLineNumbers<TLine extends NumberedLine>(
  lines: ReadonlyArray<TLine>,
  numbers: ReadonlyMap<string, number>
): Array<TLine & { lineNumber?: number }> {
  return lines.map((line) => {
    const n = typeof line.id === 'string' ? numbers.get(line.id) : undefined;
    return n === undefined ? line : { ...line, lineNumber: n };
  });
}
