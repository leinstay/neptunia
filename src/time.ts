// Time units, the UTC day key and the per-day counter, in one place. Every
// daily rail kept in state.json (LLM requests, pictures, web reads, posted
// GIFs, video watches) is a pair of fields -- the UTC
// day it counts for and the count -- that starts again from zero when the
// day turns; this module owns that rollover so the rails cannot drift apart:
// dailyCounter / bumpDaily for the owner that counts, countToday for every
// reader, which must never write the pair.
// Pure: the caller passes the clock reading and marks its state dirty.
// It also turns a local wall time of an IANA zone into an instant and back
// to a local date key (zonedEpoch / zonedDay), for dates a model writes in
// the bot's time zone.

/** One minute in milliseconds. */
export const MINUTE_MS = 60_000;
/** One hour in milliseconds. */
export const HOUR_MS = 60 * MINUTE_MS;
/** One day in milliseconds. */
export const DAY_MS = 24 * HOUR_MS;

/**
 * The UTC date key (`YYYY-MM-DD`) of an epoch timestamp.
 */
export function utcDay(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

/**
 * `YYYY-MM-DD HH:MM UTC` for an epoch ms or an ISO string; `-` for anything else.
 */
export function utcMinute(value: number | string | null | undefined): string {
  const ms = typeof value === 'number' ? value : Date.parse(String(value ?? ''));
  if (!Number.isFinite(ms)) return '-';
  return `${new Date(ms).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
}

/** A finite, non-negative count, or 0. */
function countOf(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0;
}

/**
 * Today's value of one daily counter kept as `state[dayKey]` / `state[countKey]`.
 * When the stored day is not the UTC day of `nowMs` the pair rolls over
 * (`state[dayKey] = day`, `state[countKey] = 0`) and `rolled` is true, so a
 * caller that persists the rollover knows to mark its state dirty. A missing
 * or invalid count reads as 0.
 * @param state                                 Mutated on a rollover only.
 */
export function dailyCounter(
  holder: object,
  { dayKey, countKey }: { dayKey: string; countKey: string },
  nowMs: number
): { day: string; count: number; rolled: boolean } {
  // The pair lives as two plain properties of the state's data object, which every caller types as an `object`.
  const state = holder as Record<string, unknown>;
  const day = utcDay(nowMs);
  let rolled = false;
  if (state[dayKey] !== day) {
    state[dayKey] = day;
    state[countKey] = 0;
    rolled = true;
  }
  return { day, count: countOf(state[countKey]), rolled };
}

/**
 * Today's value of one daily counter, read only: `state[countKey]` when
 * `state[dayKey]` is the UTC day of `nowMs`, 0 when the pair was stamped for
 * another day (yesterday's count reads as 0 from 00:00 UTC on) or carries no
 * stamp. Never writes: the pair is rolled over by dailyCounter / bumpDaily,
 * when its owner counts. For everything that only looks at a rail -- a
 * status line, a check before the work a refusal would waste. A missing or
 * invalid count reads as 0, by dailyCounter's rule; so does a `state` that
 * is not an object, and a `nowMs` that is neither a time nor a day key.
 * @param state                  Never mutated.
 * @param keys    The same pair dailyCounter takes.
 * @param nowMs  The clock in epoch ms; a caller that already holds the
 *   UTC day key (`YYYY-MM-DD`, from utcDay) passes the key itself.
 */
export function countToday(
  holder: object | null | undefined,
  { dayKey, countKey }: { dayKey: string; countKey: string },
  nowMs: number | string
): number {
  if (holder === null || typeof holder !== 'object') return 0;
  const state = holder as Record<string, unknown>;
  let day = null;
  if (typeof nowMs === 'string') day = nowMs;
  else if (Number.isFinite(nowMs)) day = utcDay(nowMs);
  if (!day || state[dayKey] !== day) return 0;
  return countOf(state[countKey]);
}

/**
 * Add `by` to today's value of one daily counter (rolling it over first, see
 * dailyCounter) and return the new value.
 */
export function bumpDaily(
  state: object,
  keys: { dayKey: string; countKey: string },
  nowMs: number,
  by: number = 1
): { day: string; count: number } {
  const { day, count } = dailyCounter(state, keys, nowMs);
  const next = count + by;
  (state as Record<string, unknown>)[keys.countKey] = next;
  return { day, count: next };
}

const DATE_KEY_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const zoneFormats = new Map();

/** One cached formatter per zone that writes every wall-clock field as digits (throws for an unknown zone). */
function zoneFormat(timezone: string | undefined) {
  let format = zoneFormats.get(timezone);
  if (!format) {
    format = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      hourCycle: 'h23',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });
    zoneFormats.set(timezone, format);
  }
  return format;
}

/** The wall clock of `ms` in `timezone` as numbers. */
function wallClock(ms: number, timezone: string | undefined) {
  const parts: Record<string, string> = {};
  for (const { type, value } of zoneFormat(timezone).formatToParts(ms)) parts[type] = value;
  return {
    year: Number(parts.year),
    month: Number(parts.month),
    day: Number(parts.day),
    hour: Number(parts.hour) % 24,
    minute: Number(parts.minute),
    second: Number(parts.second),
  };
}

/** How far `timezone`'s wall clock is ahead of UTC at the instant `ms`, in ms. */
function offsetAt(ms: number, timezone: string | undefined) {
  const w = wallClock(ms, timezone);
  const wall = Date.UTC(w.year, w.month - 1, w.day, w.hour, w.minute, w.second);
  return wall - (ms - (((ms % 1000) + 1000) % 1000));
}

/**
 * The instant (epoch ms) at which the wall clock of `timezone` reads
 * `dateKey` (`YYYY-MM-DD`) `hour`:`minute`. Daylight saving changes are
 * honoured: local midnight on both sides of a change lands on the right
 * instant. A wall time skipped by a spring-forward change lands just after
 * the gap; one repeated by a fall-back change gives one of its two instants.
 * NaN for a date that does not exist, an hour outside 0..23, a minute outside
 * 0..59, a non-integer field or an unknown zone. A missing zone reads as UTC.
 * @param [timezone]  IANA zone name.
 */
export function zonedEpoch(dateKey: string, hour: number, minute: number, timezone: string = 'UTC'): number {
  const match = DATE_KEY_RE.exec(String(dateKey ?? ''));
  if (!match) return NaN;
  if (!Number.isInteger(hour) || hour < 0 || hour > 23 || !Number.isInteger(minute) || minute < 0 || minute > 59)
    return NaN;
  const [year, month, day] = [Number(match[1]), Number(match[2]), Number(match[3])];
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  if (utcDay(wall) !== match[0]) return NaN;
  try {
    const guess = wall - offsetAt(wall, timezone ?? 'UTC');
    return wall - offsetAt(guess, timezone ?? 'UTC');
  } catch {
    return NaN;
  }
}

/**
 * The local date key (`YYYY-MM-DD`) of the instant `ms` in `timezone`; a
 * missing zone reads as UTC. Throws a RangeError for an unknown zone, as the
 * transcript's own date formatting does.
 * @param [timezone]  IANA zone name.
 */
export function zonedDay(ms: number, timezone: string = 'UTC'): string {
  const w = wallClock(ms, timezone ?? 'UTC');
  const pad = (n: number, width = 2) => String(n).padStart(width, '0');
  return `${pad(w.year, 4)}-${pad(w.month)}-${pad(w.day)}`;
}
