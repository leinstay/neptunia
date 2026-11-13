// The persona's view of her intentions in a request, as text: the `<intentions>` block's body
// (src/behavior/prompt.js puts it in the per-turn tail right after `<errands>` and `<errand_result>`).
// Her active intentions first (`pending`, then `waiting` with the errand it awaits and the wait's
// deadline), each with its due time (the next occurrence of a recurring one, with its `every`
// period as she wrote it) -- or, for one with no due time and no wait (nothing will wake her for
// it), the fact and its expiry (`labels.intentions.noDue`) -- and, after a wait ended, the
// errand's outcome or the reason the wait ended; an attention (`attend`) with its place, the
// people whose lines count and the day's wakes against her own bound (`labels.intentions.attend`,
// `attendPeople`); a line whose expiry is within `intentions.expiryNoticeDays` ends with it
// (`labels.intentions.expiresSoon`, unless the no-date part already says it). Cut to a token budget (`context.caps.intentions`):
// whole lines only, in order. Pure: every
// word comes from `labels.intentions` (prompts/labels.json); without its header or line label
// the block is left out (''). Ids, codes and times are data, not wording.

import { fill, formatClock, formatDate } from '../format.ts';
import { estimateTokens } from '../llm/tokens.ts';
import { clampWithEllipsis, oneLine } from '../memory/clamp.ts';
import { DAY_MS } from '../time.ts';
import { DEFAULTS } from './model.ts';
import { isFiniteNumber, listOf, objOf } from '../tools/types.ts';
import type { Untyped } from '../tools/types.ts';
import type { Intention } from './types.ts';

/** What the lines of the block read from the caller: the clock, the names and the expiry notice. */
type LineOptions = {
  timezone: string;
  locale: string;
  channelNameOf: (id: string) => string | null;
  nameOf: (id: string) => string | null;
  /** The handle (with `@`) of the person behind an attended account id; absent: people by name. */
  handleOf: ((id: string) => string | null) | null;
  /** `authors.unknown` and `spatial.unnamed`: a person and a place no reader names. */
  unknown: string;
  unnamed: string;
  now: number | null;
  noticeMs: number;
  /** Whether the line keeps the whole purpose: the intention that woke her. */
  whole?: boolean;
};

/** `context.caps.intentions` when it is missing (config.json carries the same). */
export const DEFAULT_INTENTIONS_CAP = 600;
/** A purpose's length on a line (characters). */
export const PURPOSE_LINE_CHARS = 200;

/** A moment in words: the date and the clock in `timezone`. */
function when(ts: number | null, timezone: string, locale: string): string {
  return `${formatDate(ts ?? 0, timezone, locale)} ${formatClock(ts ?? 0, timezone, locale)}`;
}

/** A label of `l` filled, or '' when it is missing. */
function part(l: Untyped, key: string, values: Record<string, unknown>): string {
  return typeof l?.[key] === 'string' && l[key] ? fill(l[key], values) : '';
}

/** An intention's purpose on one line: whole, or cut to PURPOSE_LINE_CHARS. */
const purposeText = (record: Intention, whole: boolean): string =>
  whole ? oneLine(record.purpose) : clampWithEllipsis(oneLine(record.purpose), PURPOSE_LINE_CHARS);

/**
 * One active intention's line: its own, then its due time and recurrence (or, with neither a
 * due time, a wait nor an attention, the no-date part with its expiry), its attention, its wait,
 * its outcome or note, its destination, and its expiry when that is within `noticeMs` of `now`.
 */
function activeLine(
  record: Intention,
  l: Untyped,
  { timezone, locale, channelNameOf, nameOf, handleOf, unknown, unnamed, now, noticeMs, whole = false }: LineOptions
): string {
  // A person by their handle, a place as the caller's namer gives it (the request's own naming of a place); the id only under labels with no word for one nobody names.
  const person = (id: string): string => (handleOf ? handleOf(id) : nameOf(id)) || unknown || id;
  const place = (id: string): string => channelNameOf(id) || unnamed || id;
  const state = typeof l.states?.[record.status] === 'string' ? l.states[record.status] : record.status;
  const pieces = [fill(l.line, { id: record.id, state, purpose: purposeText(record, whole) })];
  const dateless = !isFiniteNumber(record.dueAt) && record.status !== 'waiting' && !record.attend?.place;
  let noDue = '';
  if (isFiniteNumber(record.dueAt)) pieces.push(part(l, 'due', { when: when(record.dueAt, timezone, locale) }));
  else if (dateless && isFiniteNumber(record.expiresAt)) {
    noDue = part(l, 'noDue', { expires: when(record.expiresAt, timezone, locale) });
    pieces.push(noDue);
  }
  if (typeof record.every?.period === 'string' && record.every.period)
    pieces.push(part(l, 'every', { period: record.every.period }));
  if (record.attend?.place) {
    const attend = record.attend;
    pieces.push(
      part(l, 'attend', {
        place: place(attend.place),
        wakes: String(attend.today?.wakes ?? 0),
        perDay: String(attend.perDay),
        settle: String(attend.settle),
      })
    );
    if (Array.isArray(attend.people) && attend.people.length > 0)
      pieces.push(part(l, 'attendPeople', { people: attend.people.map((id) => oneLine(person(id))).join(', ') }));
  }
  if (record.status === 'waiting')
    pieces.push(
      part(l, 'waiting', { errand: record.awaitingErrandId, deadline: when(record.waitDeadline, timezone, locale) })
    );
  else if (record.outcome?.errandId)
    pieces.push(part(l, 'outcome', { errand: record.outcome.errandId, state: record.outcome.state }));
  else if (record.note && typeof l.notes?.[record.note] === 'string')
    pieces.push(fill(l.notes[record.note], { errand: record.lastErrandId ?? '' }));
  if (record.destination) pieces.push(part(l, 'destination', { channel: place(record.destination) }));
  if (!noDue && isFiniteNumber(record.expiresAt) && isFiniteNumber(now) && record.expiresAt - now <= noticeMs)
    pieces.push(part(l, 'expiresSoon', { when: when(record.expiresAt, timezone, locale) }));
  return pieces.filter(Boolean).join(' · ');
}

/**
 * The `<intentions>` block's body for `records` (src/intentions/service.ts#view's order), within
 * `maxTokens` (`cost` the estimate; whole lines, in order): `labels.intentions.header`, a line per
 * active one. '' when nothing fits or
 * the labels are missing.
 * `channelNameOf(id)` names a destination or attended channel the way the request names a place (null: unnamed);
 * `handleOf(id)` names an attended person by the handle (with `@`) of the person behind the account, `authors.unknown`
 * when it gives none; without it `nameOf(id)` names them. A place no reader names reads `spatial.unnamed`. An id stands
 * only under labels that hold neither word. `now` (epoch ms) and
 * `expiryNoticeDays` (`intentions.expiryNoticeDays`, read by the caller now) decide which lines
 * end with their expiry; without `now` none does. The intentions of `due` (the ones that woke her) come first, each
 * with its whole purpose, and are kept whatever the budget.
 */
export function intentionsBlockText(
  records: unknown,
  labels: Untyped,
  {
    timezone = 'UTC',
    locale = 'en-US',
    maxTokens = DEFAULT_INTENTIONS_CAP,
    cost = estimateTokens,
    channelNameOf = () => null,
    nameOf = () => null,
    handleOf = null,
    now = null,
    expiryNoticeDays = DEFAULTS.expiryNoticeDays,
    due = [],
  }: {
    timezone?: string;
    locale?: string;
    maxTokens?: number;
    cost?: (text: string) => number;
    channelNameOf?: (id: string) => string | null;
    nameOf?: (id: string) => string | null;
    handleOf?: ((id: string) => string | null) | null;
    now?: number | null;
    expiryNoticeDays?: number;
    due?: ReadonlyArray<string>;
  } = {}
): string {
  const l = labels?.intentions;
  const list = listOf(records).filter((record): record is Intention => typeof objOf(record).id === 'string');
  if (list.length === 0 || typeof l?.header !== 'string' || typeof l?.line !== 'string') return '';
  const out = [l.header];
  let used = cost(l.header);
  const fits = (text: string): boolean => used + cost(text) + 1 <= maxTokens;
  const take = (text: string): void => {
    out.push(text);
    used += cost(text) + 1;
  };
  const noticeMs =
    (isFiniteNumber(expiryNoticeDays) && expiryNoticeDays >= 0 ? expiryNoticeDays : DEFAULTS.expiryNoticeDays) * DAY_MS;
  const words = (value: unknown): string => (typeof value === 'string' ? value : '');
  const unknown = words(labels?.authors?.unknown);
  const unnamed = words(labels?.spatial?.unnamed);
  const options = { timezone, locale, channelNameOf, nameOf, handleOf, unknown, unnamed, now, noticeMs };
  for (const record of list.filter((one) => due.includes(one.id)))
    take(activeLine(record, l, { ...options, whole: true }));
  for (const record of list.filter((one) => !due.includes(one.id))) {
    const text = activeLine(record, l, options);
    if (!fits(text)) break;
    take(text);
  }
  return out.length > 1 ? out.join('\n') : '';
}
