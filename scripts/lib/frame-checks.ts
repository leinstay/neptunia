// The replay's checks over a rendered request (plan 2026-11-06-turn-frame, slice 2): each takes the request's user
// text and the labels it was rendered with, since a deployment rewords them, and returns its findings, one line each,
// empty when the request passes. scripts/replay-compare.ts runs them over the requests of both arms. Pure.
//
//   chatInTimeOrder   every line of `<chat>` stands in time order, a date marker moving the clock to the next day,
//                     and shows one clock and nothing more in its brackets
//   placeBound        `<spatial_awareness>` puts her in the place the request was built for, the first place of its
//                     path, never a parent further up

/** The labels the checks read: the transcript's markers and the spatial block's phrasing. */
export type CheckLabels = {
  readonly transcript?: Readonly<Record<string, unknown>>;
  readonly spatial?: Readonly<{ place?: string; within?: string; kinds?: Readonly<Record<string, string>> }>;
};

/** The body of `<tag>` in `request`, null when it has none. */
function blockOf(request: string, tag: string): string | null {
  const open = `<${tag}>\n`;
  const start = request.indexOf(open);
  if (start === -1) return null;
  const end = request.indexOf(`\n</${tag}>`, start + open.length);
  return end === -1 ? null : request.slice(start + open.length, end);
}

/** `text` safe inside a regular expression. */
const escaped = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** A label as a whole-line pattern, each placeholder matching any text; null for a missing or blank label. */
function patternOf(label: unknown, capture: string | null = null): RegExp | null {
  if (typeof label !== 'string' || !label) return null;
  const parts = label.split(/(\{\w+\})/);
  const body = parts
    .map((part) => {
      const slot = /^\{(\w+)\}$/.exec(part);
      if (!slot) return escaped(part);
      return slot[1] === capture ? '(.+?)' : '.+?';
    })
    .join('');
  return new RegExp(`^${body}$`, 'u');
}

/** The head of a line of `<chat>`: its optional `#n`, then what its brackets hold. */
const LINE_HEAD = /^(?:#\d+ )?\[([^\]]*)\]/u;
/** One clock and nothing more. */
const CLOCK = /^(\d{1,2}):(\d{2})$/u;

/**
 * Every line of `<chat>` in time order with one clock: the header opens the first day, a date marker (`date`,
 * `gapWithDate`) opens the next one, and the minutes of the day may not run back within a day. A line whose brackets
 * hold more than a clock, such as an age, is a finding. No `<chat>` block is a finding of its own.
 */
export function chatInTimeOrder(request: string, labels: CheckLabels): Array<string> {
  const chat = blockOf(request, 'chat');
  if (chat === null) return ['no <chat> block'];
  const t = labels.transcript ?? {};
  const newDay = [patternOf(t.gapWithDate), patternOf(t.date)].filter((one): one is RegExp => one !== null);
  const sameDay = patternOf(t.gap);
  const findings: Array<string> = [];
  let day = 0;
  let last: { day: number; minute: number; row: string } | null = null;
  for (const row of chat.split('\n')) {
    if (sameDay?.test(row)) continue;
    if (newDay.some((pattern) => pattern.test(row))) {
      day += 1;
      continue;
    }
    const head = LINE_HEAD.exec(row);
    if (!head) continue;
    const clock = CLOCK.exec(head[1] ?? '');
    if (!clock) {
      findings.push(`a line shows more than one clock: ${row.slice(0, 80)}`);
      continue;
    }
    const minute = Number(clock[1]) * 60 + Number(clock[2]);
    if (last && (day < last.day || (day === last.day && minute < last.minute)))
      findings.push(`a line stands before an earlier one: ${row.slice(0, 80)} after ${last.row.slice(0, 80)}`);
    last = { day, minute, row };
  }
  return findings;
}

/**
 * `<spatial_awareness>` puts her in `placeName`: its place sentence (`spatial.place`) names a path whose first link,
 * read through `spatial.kinds`, is that name. No block, no place sentence or another first place is a finding.
 */
export function placeBound(request: string, placeName: string, labels: CheckLabels): Array<string> {
  const spatial = blockOf(request, 'spatial_awareness');
  if (spatial === null) return ['no <spatial_awareness> block'];
  const sentence = patternOf(labels.spatial?.place, 'path');
  const path = spatial
    .split('\n')
    .map((row) => sentence?.exec(row)?.[1] ?? null)
    .find((found) => found !== null);
  if (!path) return ['<spatial_awareness> names no place'];
  const within = labels.spatial?.within ?? ' ';
  const first = path.split(within)[0] ?? '';
  const kinds = Object.values(labels.spatial?.kinds ?? {});
  const names = kinds
    .map((kind) => patternOf(kind, 'name')?.exec(first)?.[1] ?? null)
    .filter((name): name is string => name !== null);
  if (names.length === 0) names.push(first);
  return names.includes(placeName) ? [] : [`<spatial_awareness> puts her in ${first}, not in ${placeName}`];
}
