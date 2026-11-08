// The replay's checks over a rendered request (plan 2026-11-06-turn-frame, slice 2): each takes the request's user
// text and the labels it was rendered with, since a deployment rewords them, and returns its findings, one line each,
// empty when the request passes. scripts/replay-compare.ts runs them over the requests of both arms. Pure.
//
//   chatInTimeOrder   every line of `<chat>` stands in time order, a date marker moving the clock to the next day,
//                     and shows one clock and nothing more in its brackets
//   placeBound        `<spatial_awareness>` puts her in the place the request was built for, the first place of its
//                     path, never a parent further up
//   counterpartFirst  the first entry of `<memory>`'s `<people>` is the person she answers, marked so
//   lookupRecalled    a lookup made in turn n stands in `<recall>` of turn n+1 with its tool and its query

/** The labels the checks read: the transcript's markers and the spatial block's phrasing. */
export type CheckLabels = {
  readonly transcript?: Readonly<Record<string, unknown>>;
  readonly spatial?: Readonly<{
    place?: string;
    within?: string;
    kind?: string;
    kinds?: Readonly<Record<string, string>>;
  }>;
  readonly memory?: Readonly<Record<string, unknown>>;
  readonly recall?: Readonly<Record<string, unknown>>;
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
 * read through `spatial.kind` or `spatial.kinds`, is that name. No block, no place sentence or another first place is a finding.
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
  const kinds = [labels.spatial?.kind, ...Object.values(labels.spatial?.kinds ?? {})];
  const names = kinds
    .map((kind) => patternOf(kind, 'name')?.exec(first)?.[1] ?? null)
    .filter((name): name is string => name !== null);
  if (names.length === 0) names.push(first);
  return names.includes(placeName) ? [] : [`<spatial_awareness> puts her in ${first}, not in ${placeName}`];
}

/** `text` as a stored value renders it in a request: `<` and `>` as entities (src/turn/request/text.ts#escapeStored). */
const stored = (text: string): string => text.replace(/</g, '&lt;').replace(/>/g, '&gt;');

/**
 * The first entry of `<people>` inside `<memory>` is `counterpartName`, marked as the person she answers: its heading,
 * after a mention handle, is `memory.entry` with that name and an origin that holds `memory.counterpart`. No block, no
 * entry, another name first or a first entry without the mark is a finding.
 */
export function counterpartFirst(request: string, counterpartName: string, labels: CheckLabels): Array<string> {
  const memory = blockOf(request, 'memory');
  if (memory === null) return ['no <memory> block'];
  const people = blockOf(memory, 'people');
  if (people === null) return ['no <people> in <memory>'];
  const heading = (people.split('\n')[0] ?? '').replace(/^@\S+ /u, '');
  const entry = patternOf(labels.memory?.entry, 'name');
  const name = entry?.exec(heading)?.[1] ?? heading;
  const findings: Array<string> = [];
  if (name !== stored(counterpartName))
    findings.push(`<people> opens with ${heading.slice(0, 80)}, not ${counterpartName}`);
  const mark = labels.memory?.counterpart;
  if (typeof mark === 'string' && mark !== '' && !heading.includes(mark))
    findings.push(`the first entry of <people> is not marked as the person she answers: ${heading.slice(0, 80)}`);
  return findings;
}

/**
 * The request of turn n+1 holds in `<recall>` a line of `recall.item` naming the lookup of turn n: its `tool` and its
 * `query` as the item renders them. No block, or no such line, is a finding.
 */
export function lookupRecalled(
  nextRequest: string,
  lookup: { tool: string; query: string },
  labels: CheckLabels
): Array<string> {
  const recall = blockOf(nextRequest, 'recall');
  if (recall === null) return ['no <recall> block'];
  const item = patternOf(labels.recall?.item);
  const named = recall
    .split('\n')
    .some(
      (row) =>
        (item === null || item.test(row)) && row.includes(stored(lookup.tool)) && row.includes(stored(lookup.query))
    );
  return named ? [] : [`<recall> does not name the lookup ${lookup.tool} ${lookup.query.slice(0, 60)}`];
}
