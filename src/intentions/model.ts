// The persona's intentions as data (docs/inner-life.md): what she means to do later, set by her
// own call (`intention.set`, provenance `self`, born `pending`) or proposed by the memory analyzer
// from one of her own lines (provenance `candidate`, born `proposed`, never active until she
// accepts it). Pure: every function takes the record and the clock (`now`, epoch ms) and answers
// a new record, never mutating its input; the store (src/intentions/store.ts) persists them.
//
// Statuses: `proposed` -> `pending` (accepted) | `cancelled` (rejected) | `expired`;
// `pending` -> `waiting` | `done` | `cancelled` | `expired`; `waiting` -> `pending` (the awaited
// errand ended, or its wait deadline passed, or the errand is gone) | `done` | `cancelled` |
// `expired`; any open one (`proposed`, `pending`, `waiting`) -> `dropped`, a desire she considered
// and let go, with a required `reason` (REASON_CHARS) and its moment `droppedAt`; a record may also
// be born `dropped` (createIntention with `dropped: true`: no due time, no recurrence, no
// attention). `done`, `cancelled`, `expired` and `dropped` are terminal: nothing moves out of them
// (a dropped one is not open, never due, and kept like any closed one). The
// invariants every record keeps (checkInvariants): an `expiresAt` (every intention ends), and a
// `waiting` one has both `awaitingErrandId` and `waitDeadline` -- there is no wait without a real
// errand and a deadline. Expiry comes from the clock (expireAt); `dueList` lists what is due for
// the scheduler of step 2 (listing, not choosing). Codes are kebab-case; no wording here.
//
// A recurring intention carries `every` (`{ period: 'day'|'week'|'<n>h'|'<n>d', at: 'HH:MM'|null }`,
// parseEvery; `at` pins the wall-clock time of `day` and `week` in the bot's timezone, pinEvery)
// and always a `dueAt` (the current occurrence). An occurrence ends and the intention goes on:
// advanceOccurrence moves `dueAt` to the next occurrence after now (nextOccurrence, DST-safe
// through src/time.js, skipping occurrences already past) with the occurrence's code in the
// history (`recurred`, `missed`, `done-occurrence`); such a record is never `done` (invariant
// `recurring-done`): `cancelled` and `expired` end it, and expiry stays binding (the next
// occurrence may lie past `expiresAt`; the clock expires the record first).
//
// An attention (docs/inner-life.md "Her attention") is an intention of kind `attend`: `attend:
// { place, people, settle, perDay, today }` -- an opaque place address the interface published,
// the people whose lines count (ids; empty: everyone), the quiet seconds before a wake, her own
// per-day bound and the day's counter (`today: { day, wakes }`, the local day of `bot.timezone`,
// reset by the service when the day changes). It has no due time and no recurrence (invariants
// `attend-with-due`, `attend-with-every`); the scheduler wakes her on the place's lines
// (src/behavior/inner.ts). normalizeAttend fills the defaults (ATTEND_DEFAULTS, or
// `innerLife.attention.*` through attentionSettings); validAttend checks the shape.

import { createHash, randomUUID } from 'node:crypto';
import { DAY_MS, HOUR_MS, MINUTE_MS, zonedDay, zonedEpoch } from '../time.js';
import { clampChars, oneLine } from '../memory/clamp.js';
import { isWordChar, occursAsWholeWord } from '../memory/mentions.ts';
import { foldText as foldName } from '../memory/recent.js';
import { externalOrigin } from './sources.ts';
import { CODE } from '../tools/codes.ts';
import { isFiniteNumber, isObj, listOf, objOf } from '../tools/types.ts';
import type { Untyped } from '../tools/types.ts';
import type {
  Attend,
  AttentionSettings,
  Candidate,
  CreateInput,
  Created,
  Due,
  Every,
  HistoryEntry,
  ErrandLike,
  Intention,
  IntentionSettings,
  IntentionStatus,
  Moved,
  Provenance,
} from './types.ts';

/** Every status an intention may have. */
export const STATUSES: ReadonlyArray<IntentionStatus> = Object.freeze([
  'proposed',
  'pending',
  'waiting',
  'done',
  'cancelled',
  'expired',
  'dropped',
] as const);
/** The statuses nothing moves out of. */
export const TERMINAL: ReadonlyArray<string> = Object.freeze(['done', 'cancelled', 'expired', 'dropped'] as const);
/** The statuses of an intention still open. */
export const OPEN: ReadonlyArray<string> = Object.freeze(['proposed', 'pending', 'waiting'] as const);
/** Where an intention came from. */
export const PROVENANCE_KINDS: ReadonlyArray<string> = Object.freeze(['self', 'candidate'] as const);

/** The statuses as values to test an unchecked record against. */
const STATUS_VALUES: ReadonlyArray<unknown> = STATUSES;

/** The moves each status allows. */
const MOVES: Readonly<Record<IntentionStatus, ReadonlyArray<IntentionStatus>>> = Object.freeze({
  proposed: ['pending', 'cancelled', 'expired', 'dropped'],
  pending: ['waiting', 'done', 'cancelled', 'expired', 'dropped'],
  waiting: ['pending', 'done', 'cancelled', 'expired', 'dropped'],
  done: [],
  cancelled: [],
  expired: [],
  dropped: [],
} as const);

/** The defaults of the `intentions` config section (config.json carries the same). */
export const DEFAULTS: Readonly<IntentionSettings> = Object.freeze({
  expiresDays: 14,
  recurringExpiresDays: 30,
  maxOpen: 20,
  maxCandidates: 5,
  candidateExpiresHours: 48,
  waitHours: 2,
  expiryNoticeDays: 2,
});
/** The defaults of `innerLife.attention` an attention record needs (config.json carries the same). */
export const ATTEND_DEFAULTS: Readonly<AttentionSettings> = Object.freeze({ settleSeconds: 90, perDayDefault: 12 });
/** The most people an attention record names. */
export const ATTEND_PEOPLE_MAX = 20;
/** The periods `every` names by a word; `<n>h` and `<n>d` are the interval forms. */
export const EVERY_PERIODS: ReadonlyArray<string> = Object.freeze(['day', 'week'] as const);
/** The occurrence codes advanceOccurrence writes to the history. */
export const OCCURRENCE_CODES: ReadonlyArray<string> = Object.freeze([
  'recurred',
  'missed',
  'done-occurrence',
] as const);
/** A purpose's length (characters). */
export const PURPOSE_CHARS = 300;
/** A dropped intention's reason length (characters). */
export const REASON_CHARS = 300;
/** A quoted span's length (characters). */
export const SPAN_CHARS = 300;
/** A completion condition's length (characters). */
export const CONDITION_CHARS = 300;
/** A chain id's length (characters). */
export const CHAIN_CHARS = 64;
/** The history entries a record keeps (the oldest dropped). */
export const HISTORY_MAX = 20;
/** The members of the conversation a record's provenance keeps. */
export const PARTICIPANTS_MAX = 20;
/** A name shorter than this (in letters and digits) is never matched by a forget. */
const MIN_FORGET_NAME = 3;

/** The `origin` of an intention a heartbeat turn created (docs/inner-life.md "What a heartbeat may do"). */
export const HEARTBEAT_ORIGIN = 'heartbeat' as const;
/** What a heartbeat may hold open at once (`innerLife.heartbeat.maxOpen` / `maxRecurring`; config.json carries the same). */
export const HEARTBEAT_LIMITS: Readonly<{ maxOpen: number; maxRecurring: number }> = Object.freeze({
  maxOpen: 3,
  maxRecurring: 1,
});

/** `innerLife.heartbeat.maxOpen` and `maxRecurring`, read from the live config now, each a whole number >= 0 or the default. */
export function heartbeatLimits(config: Untyped): { maxOpen: number; maxRecurring: number } {
  const set = objOf(config?.innerLife?.heartbeat);
  const pick = (key: 'maxOpen' | 'maxRecurring'): number => {
    const value = set[key];
    return isFiniteNumber(value) && value >= 0 ? Math.floor(value) : HEARTBEAT_LIMITS[key];
  };
  return { maxOpen: pick('maxOpen'), maxRecurring: pick('maxRecurring') };
}

/** `innerLife.heartbeat.dueJitterMinutes` (minutes, 0 disables), read from the live config now. */
export const DUE_JITTER_MINUTES = 20;
export function dueJitterMinutes(config: Untyped): number {
  const value: unknown = config?.innerLife?.heartbeat?.dueJitterMinutes;
  return isFiniteNumber(value) && value >= 0 ? value : DUE_JITTER_MINUTES;
}

/**
 * The moment a record's due wake fires. An intention a heartbeat made (`origin: heartbeat`) is
 * shifted off its round clock time by an offset uniform in +-`jitterMinutes`, derived from a hash
 * of `id` and `dueAt` (the same item and due time always give the same offset, nothing stored).
 * The magnitude is at most a quarter of the lead time (`dueAt` minus the later of `createdAt` and
 * `updatedAt`, the last moment the record was seen as not yet due), so the wake is never before
 * that moment and a due of "right away" does not move; it never reaches `expiresAt` (clamped to
 * before it). Every other record, and a record with no due time, is exact. What she sees keeps
 * `dueAt`; only the wake moves.
 * Gives `dueAt` for an exact record and NaN with no due time.
 */
export function wakeTimeOf(record: Intention, jitterMinutes = 0): number {
  const dueAt = record?.dueAt;
  if (!isFiniteNumber(dueAt)) return NaN;
  if (record.origin !== HEARTBEAT_ORIGIN || !(jitterMinutes > 0)) return dueAt;
  const base = Math.max(
    isFiniteNumber(record.createdAt) ? record.createdAt : -Infinity,
    isFiniteNumber(record.updatedAt) ? record.updatedAt : -Infinity
  );
  const lead = Number.isFinite(base) ? dueAt - base : 0;
  const cap = Math.min(jitterMinutes * 60 * 1000, Math.max(0, lead) / 4);
  if (!(cap > 0)) return dueAt;
  const unit = createHash('sha256').update(`${record.id}:${dueAt}`).digest().readUInt32BE(0) / 2 ** 32;
  let at = Math.round(dueAt + (unit * 2 - 1) * cap);
  if (isFiniteNumber(record.expiresAt) && at >= record.expiresAt)
    at = dueAt < record.expiresAt ? record.expiresAt - 1 : dueAt;
  return at;
}

/** The open (pending or waiting) intentions a heartbeat created, among `records`. */
export function openFromHeartbeat(records: unknown): Array<Intention> {
  return listOf(records).filter((record): record is Intention => {
    const given = objOf(record);
    return given.origin === HEARTBEAT_ORIGIN && (given.status === 'pending' || given.status === 'waiting');
  });
}

/** The `intentions` section's numbers, read from the live config now, each falling back to DEFAULTS. */
export function intentionSettings(config: Untyped): IntentionSettings {
  const set = objOf(config?.intentions);
  const pick = (key: keyof IntentionSettings): number => {
    const value = set[key];
    return isFiniteNumber(value) && value >= 0 ? value : DEFAULTS[key];
  };
  return {
    expiresDays: pick('expiresDays'),
    recurringExpiresDays: pick('recurringExpiresDays'),
    maxOpen: pick('maxOpen'),
    maxCandidates: pick('maxCandidates'),
    candidateExpiresHours: pick('candidateExpiresHours'),
    waitHours: pick('waitHours'),
    expiryNoticeDays: pick('expiryNoticeDays'),
  };
}

/**
 * The `innerLife.attention` numbers an attention is born with, read from the live config now, each
 * falling back to ATTEND_DEFAULTS: `settleSeconds` (>= 0) and `perDayDefault` (an integer >= 1).
 */
export function attentionSettings(config: Untyped): AttentionSettings {
  const set = objOf(config?.innerLife?.attention);
  const { settleSeconds, perDayDefault } = set;
  return {
    settleSeconds: isFiniteNumber(settleSeconds) && settleSeconds >= 0 ? settleSeconds : ATTEND_DEFAULTS.settleSeconds,
    perDayDefault:
      typeof perDayDefault === 'number' && Number.isInteger(perDayDefault) && perDayDefault >= 1
        ? perDayDefault
        : ATTEND_DEFAULTS.perDayDefault,
  };
}

/** Whether `features.intentions` is exactly true (a missing key counts as off). */
export function intentionsOn(config: Untyped): boolean {
  return config?.features?.intentions === true;
}

/** True for a status nothing moves out of. */
export function isTerminal(status: unknown): boolean {
  return typeof status === 'string' && TERMINAL.includes(status);
}

/** True for an open status. */
export function isOpen(status: unknown): boolean {
  return typeof status === 'string' && OPEN.includes(status);
}

/** A fresh intention id (`i` + 8 hex characters). */
export function newIntentionId(uuid: () => string = randomUUID): string {
  return `i${uuid().replace(/-/g, '').slice(0, 8)}`;
}

/** One token shaped like an intention id (newIntentionId's `i` + hex digits), nothing around it. */
const INTENTION_ID_RE = /^i[0-9a-f]{1,32}$/i;

/**
 * Whether `value` is one bare token that looks like an intention id (`i` + hex digits, as
 * newIntentionId makes them): what a call's body is when she wrote the id there and nothing else.
 */
export function isIntentionId(value: unknown): boolean {
  return typeof value === 'string' && INTENTION_ID_RE.test(value.trim());
}

const RELATIVE_RE = /^(\d{1,5})\s*(m|min|h|d)$/i;
const CLOCK_RE = /^(?:(mon|tue|wed|thu|fri|sat|sun)\s+)?(\d{1,2}):(\d{2})$/i;
/** The weekdays as `<weekday> HH:MM` names them, Sunday first (Date#getUTCDay's order). */
const WEEKDAYS = Object.freeze(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']);

/** The calendar date `days` after `dateKey` (`YYYY-MM-DD`). */
function addDays(dateKey: string, days: number): string {
  return new Date(Date.parse(`${dateKey}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The weekday (0 Sunday .. 6 Saturday) of the calendar date `dateKey`. */
function weekdayOf(dateKey: string): number {
  return new Date(Date.parse(`${dateKey}T00:00:00Z`)).getUTCDay();
}

/** `HH:MM` of the instant `ms` on the wall clock of `timezone`. */
function wallTime(ms: number, timezone: string): string {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).formatToParts(ms);
  const get = (type: string): string => parts.find((part) => part.type === type)?.value ?? '00';
  return `${String(Number(get('hour')) % 24).padStart(2, '0')}:${get('minute')}`;
}

/** `{ hour, minute }` of an `HH:MM` text, or null when it is not a time of day. */
function clockOf(text: string | null | undefined): { hour: number; minute: number } | null {
  const match = /^(\d{1,2}):(\d{2})$/.exec(String(text ?? ''));
  if (!match) return null;
  const hour = Number(match[1]);
  const minute = Number(match[2]);
  return hour <= 23 && minute <= 59 ? { hour, minute } : null;
}

/**
 * The first instant at or after `from` (strictly after when `after`) whose wall clock in
 * `timezone` reads `hour`:`minute` on a day `stepDays` apart from `fromDay` (a calendar date;
 * every day with 1, the same weekday with 7). NaN for an unknown zone.
 */
function nextWallClock({
  fromDay,
  hour,
  minute,
  stepDays,
  timezone,
  after,
}: {
  fromDay: string;
  hour: number;
  minute: number;
  stepDays: number;
  timezone: string;
  after: number;
}): number {
  let day = fromDay;
  for (let i = 0; i < 400; i += 1) {
    const at = zonedEpoch(day, hour, minute, timezone);
    if (!Number.isFinite(at)) return NaN;
    if (at > after) return at;
    day = addDays(day, stepDays);
  }
  return NaN;
}

/**
 * A moment given as text, as epoch ms: a relative `<n>m`, `<n>h` or `<n>d` from `now`, an
 * ISO 8601 date or date-time, a wall-clock time `HH:MM` (the next such time after `now` in
 * `timezone`, UTC by default: today's when still ahead, else tomorrow's) or `<weekday> HH:MM`
 * (`mon`..`sun`: the next such weekday at that time, today's when still ahead). Null for anything
 * else (and for an empty text).
 */
export function parseWhen(text: unknown, now: number, { timezone = 'UTC' }: { timezone?: string } = {}): number | null {
  const value = typeof text === 'string' ? text.trim() : '';
  if (!value) return null;
  const relative = RELATIVE_RE.exec(value);
  if (relative) {
    const n = Number(relative[1]);
    const unit = relative[2].toLowerCase();
    return now + n * (unit === 'd' ? DAY_MS : unit === 'h' ? HOUR_MS : MINUTE_MS);
  }
  const clock = CLOCK_RE.exec(value);
  if (clock) {
    const time = clockOf(`${clock[2]}:${clock[3]}`);
    if (!time) return null;
    let day: string;
    try {
      day = zonedDay(now, timezone || 'UTC');
    } catch {
      return null;
    }
    const weekday = clock[1] ? WEEKDAYS.indexOf(clock[1].toLowerCase()) : -1;
    if (weekday >= 0) day = addDays(day, (weekday - weekdayOf(day) + 7) % 7);
    const at = nextWallClock({
      fromDay: day,
      ...time,
      stepDays: weekday >= 0 ? 7 : 1,
      timezone: timezone || 'UTC',
      after: now,
    });
    return Number.isFinite(at) ? at : null;
  }
  if (!/^\d{4}-\d{2}-\d{2}/.test(value)) return null;
  const at = Date.parse(value);
  return Number.isFinite(at) ? at : null;
}

const INTERVAL_RE = /^(\d{1,4})(h|d)$/i;

/**
 * Her `every=` argument as the record's `every`: `{ ok: true, every }` for `day`, `week`, `<n>h`,
 * `<n>d` (n >= 1; `at` null until pinEvery) and `{ ok: true, every: null }` for `none` (one-off
 * again); `{ ok: false, code: 'bad-every' }` for anything else.
 */
export function parseEvery(
  text: unknown
): { ok: true; every: Every | null; code?: undefined } | { ok: false; code: string; every?: undefined } {
  const value = String(typeof text === 'string' ? text : '')
    .trim()
    .toLowerCase();
  if (value === 'none') return { ok: true, every: null };
  if (EVERY_PERIODS.includes(value)) return { ok: true, every: { period: value, at: null } };
  const interval = INTERVAL_RE.exec(value);
  if (interval && Number(interval[1]) >= 1)
    return { ok: true, every: { period: `${Number(interval[1])}${interval[2].toLowerCase()}`, at: null } };
  return { ok: false, code: CODE.BAD_EVERY };
}

/** Whether `every` is a well-formed recurrence (null counts as a one-off, which is fine). */
export function validEvery(every: unknown): boolean {
  if (every === null || every === undefined) return true;
  if (!isObj(every)) return false;
  const period = typeof every.period === 'string' ? parseEvery(every.period) : null;
  if (!period?.ok || period.every === null) return false;
  const at = every.at;
  return at === null || at === undefined || (typeof at === 'string' && clockOf(at) !== null);
}

/** The step of an interval period (`<n>h`, `<n>d`) in ms, or null for `day` and `week`. */
function intervalMs(period: string | null | undefined): number | null {
  const match = INTERVAL_RE.exec(String(period ?? ''));
  return match ? Number(match[1]) * (match[2].toLowerCase() === 'd' ? DAY_MS : HOUR_MS) : null;
}

/**
 * `every` with its wall-clock time pinned from the first occurrence `dueAt` in `timezone` (for
 * `day` and `week`, when it has none yet), so a daily 21:00 stays 21:00 across a DST change.
 * An interval period and a one-off (null) come back as they are.
 */
export function pinEvery(every: Every | null, dueAt: number | null, timezone: string): Every | null {
  if (!every || !EVERY_PERIODS.includes(every.period) || every.at || !isFiniteNumber(dueAt)) return every ?? null;
  try {
    return { period: every.period, at: wallTime(dueAt, timezone || 'UTC') };
  } catch {
    return every;
  }
}

/**
 * The next occurrence of recurring `record` strictly after `now` (epoch ms), or null for a one-off:
 * `day` and `week` at the pinned wall-clock time (`every.at`, else the first due's) in `timezone`,
 * each calendar day or every seventh day from the current due's date (so the occurrences already
 * past are skipped and the weekday holds); `<n>h` and `<n>d` in fixed steps from the current due
 * instant. NaN-free: null when it cannot be told (an unknown zone, a record with no due).
 */
export function nextOccurrence(
  record: Pick<Intention, 'every' | 'dueAt'>,
  now: number,
  timezone = 'UTC'
): number | null {
  const every = record?.every;
  const dueAt = record?.dueAt;
  if (!validEvery(every) || !every || !isFiniteNumber(dueAt)) return null;
  const after = Math.max(now, dueAt);
  const step = intervalMs(every.period);
  if (step) {
    const steps = Math.floor((after - dueAt) / step) + 1;
    return dueAt + steps * step;
  }
  try {
    const zone = timezone || 'UTC';
    const time = clockOf(every.at ?? wallTime(dueAt, zone));
    if (!time) return null;
    const at = nextWallClock({
      fromDay: zonedDay(dueAt, zone),
      ...time,
      stepDays: every.period === 'week' ? 7 : 1,
      timezone: zone,
      after,
    });
    return Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

/**
 * Whether `attend` is a well-formed attention (null counts as none, which is fine): a non-empty
 * `place`, `people` an array of non-empty ids, `settle` seconds >= 0, `perDay` an integer >= 1,
 * and `today` null or `{ day, wakes }`.
 */
export function validAttend(attend: unknown): attend is Attend | null | undefined {
  if (attend === null || attend === undefined) return true;
  if (!isObj(attend)) return false;
  if (typeof attend.place !== 'string' || !attend.place) return false;
  if (!Array.isArray(attend.people) || attend.people.some((id: unknown) => typeof id !== 'string' || !id)) return false;
  const { settle, perDay, today } = attend;
  if (!(isFiniteNumber(settle) && settle >= 0)) return false;
  if (!(typeof perDay === 'number' && Number.isInteger(perDay) && perDay >= 1)) return false;
  if (today === null || today === undefined) return true;
  return (
    isObj(today) &&
    typeof today.day === 'string' &&
    typeof today.wakes === 'number' &&
    Number.isInteger(today.wakes) &&
    today.wakes >= 0
  );
}

/**
 * Her `attend` input (`{ place, people?, settle?, perDay?, today? }`: the place as the interface
 * addresses it, people as ids, strings or numbers) as a record's `attend`, the defaults filled
 * from `settings` (attentionSettings' shape): distinct people, at most ATTEND_PEOPLE_MAX, blank
 * tokens dropped. Null when it is not a well-formed attention (validAttend).
 */
export function normalizeAttend(
  input: unknown,
  {
    settleSeconds = ATTEND_DEFAULTS.settleSeconds,
    perDayDefault = ATTEND_DEFAULTS.perDayDefault,
  }: Partial<AttentionSettings> = {}
): Attend | null {
  if (!isObj(input)) return null;
  const place =
    typeof input.place === 'string' ? input.place.trim() : typeof input.place === 'number' ? String(input.place) : '';
  const raw: unknown = input.people === undefined || input.people === null ? [] : input.people;
  if (!Array.isArray(raw)) return null;
  const people = [
    ...new Set(
      raw.map((id: unknown) =>
        typeof id === 'string' ? id.trim() : typeof id === 'number' && Number.isFinite(id) ? String(id) : null
      )
    ),
  ]
    .filter((id): id is string => typeof id === 'string' && id !== '')
    .slice(0, ATTEND_PEOPLE_MAX);
  if (raw.some((id: unknown) => typeof id !== 'string' && typeof id !== 'number')) return null;
  const attend = {
    place,
    people,
    settle: input.settle === undefined || input.settle === null ? settleSeconds : input.settle,
    perDay: input.perDay === undefined || input.perDay === null ? perDayDefault : input.perDay,
    today: input.today === undefined ? null : input.today,
  };
  return validAttend(attend) ? attend : null;
}

/** True for an attention: a record with an `attend` place. */
export function isAttend(record: unknown): record is Intention & { attend: Attend } {
  const place = objOf(objOf(record).attend).place;
  return typeof place === 'string' && place !== '';
}

/**
 * The per-day counter of attention `record` on local day `day` (`YYYY-MM-DD` of `bot.timezone`):
 * `{ day, wakes }`, zero when the counter is of another day (the day changed). Pure.
 */
export function attendCounter(record: unknown, day: string): { day: string; wakes: number } {
  const today = objOf(objOf(record).attend).today;
  return isObj(today) && today.day === day && typeof today.wakes === 'number'
    ? { day, wakes: today.wakes }
    : { day, wakes: 0 };
}

/**
 * `record` with one more attend wake counted on local day `day` (a counter of another day starts
 * at zero): `{ ok: true, intention, changed: true }`, or `{ ok: false, code: 'not-attend' }`.
 */
export function bumpAttend(record: Intention, day: string): Moved {
  if (!isAttend(record)) return { ok: false, code: CODE.NOT_ATTEND };
  const current = attendCounter(record, day);
  return {
    ok: true,
    intention: { ...record, attend: { ...record.attend, today: { day, wakes: current.wakes + 1 } } },
    changed: true,
  };
}

/** One line of text cut to `max` characters; '' for nothing. */
function line(text: unknown, max: number): string {
  return clampChars(oneLine(typeof text === 'string' ? text : ''), max);
}

/** A string id or null. */
function idOrNull(value: unknown): string | null {
  return (typeof value === 'string' && value) || (typeof value === 'number' && Number.isFinite(value))
    ? String(value)
    : null;
}

/** The distinct non-empty string ids of `list`, at most PARTICIPANTS_MAX. */
function participantIds(list: unknown): Array<string> {
  return [
    ...new Set(
      (Array.isArray(list) ? list : []).filter((id: unknown): id is string => typeof id === 'string' && id !== '')
    ),
  ].slice(0, PARTICIPANTS_MAX);
}

/**
 * The invariant `record` breaks, as a code, or null: `bad-status`, `no-purpose`, `no-expiry`,
 * `wait-without-errand`, `wait-without-deadline`, `bad-attend`, `attend-with-due`, `attend-with-every`
 * (an attention has no due time and no recurrence), `bad-every`, `every-without-due` (a recurring
 * one always has its current occurrence), `recurring-done` (a recurring one is never done).
 */
export function checkInvariants(record: unknown): string | null {
  const given = objOf(record);
  if (!record || !STATUS_VALUES.includes(given.status)) return 'bad-status';
  if (typeof given.purpose !== 'string' || !given.purpose) return 'no-purpose';
  if (!isFiniteNumber(given.expiresAt)) return 'no-expiry';
  if (given.status === 'dropped' && (typeof given.reason !== 'string' || !given.reason)) return 'reason-required';
  if (!validAttend(given.attend)) return 'bad-attend';
  if (given.attend) {
    if (given.dueAt !== null && given.dueAt !== undefined) return 'attend-with-due';
    if (given.every) return 'attend-with-every';
  }
  if (!validEvery(given.every)) return 'bad-every';
  if (given.every) {
    if (!isFiniteNumber(given.dueAt)) return 'every-without-due';
    if (given.status === 'done') return 'recurring-done';
  }
  if (given.status === 'waiting') {
    if (typeof given.awaitingErrandId !== 'string' || !given.awaitingErrandId) return 'wait-without-errand';
    if (!isFiniteNumber(given.waitDeadline)) return 'wait-without-deadline';
  }
  return null;
}

/** `record` with one more history entry (the oldest dropped past HISTORY_MAX). */
function withHistory(record: Intention, entry: HistoryEntry): Intention {
  const history = [...(Array.isArray(record.history) ? record.history : []), entry];
  return { ...record, history: history.slice(-HISTORY_MAX) };
}

/**
 * A new intention: `{ ok: true, intention }` or `{ ok: false, code }` (`no-purpose`,
 * `bad-provenance`, `bad-attend`, `attend-with-due`, `attend-with-every`, `bad-due`, `bad-every`,
 * `every-without-due`, `bad-expiry`, `due-after-expiry`). `attend` (normalizeAttend's input; its
 * defaults from `settings.attention`, attentionSettings' shape) makes it an attention: no due
 * time, no recurrence, her own only.
 * Her own (`provenance.kind` `self`) is `pending`; a candidate is `proposed` and expires after
 * `candidateExpiresHours` unless `expiresAt` says otherwise; her own after `expiresDays`, or
 * after `recurringExpiresDays` with `every` set (parseEvery's shape, pinned by the caller).
 * `provenance.participants` (member ids) names the members of the conversation it came from: who
 * asked, who was answered or mentioned, the other authors of a candidate's channel (concernsMember).
 */
export function createIntention({
  purpose,
  provenance,
  dueAt = null,
  every = null,
  expiresAt = null,
  destination = null,
  completionCondition = null,
  chainId = null,
  attend = null,
  origin = null,
  dropped = false,
  reason = null,
  now,
  settings = DEFAULTS,
  id = newIntentionId(),
  by = 'persona',
}: CreateInput): Created {
  const text = line(purpose, PURPOSE_CHARS);
  if (!text) return { ok: false, code: CODE.NO_PURPOSE };
  if (!PROVENANCE_KINDS.includes(provenance?.kind)) return { ok: false, code: CODE.BAD_PROVENANCE };
  if (dropped) return createDropped({ text, provenance, reason, now, id, by });
  const candidate = provenance.kind === 'candidate';
  const attention = attend === null || attend === undefined ? null : normalizeAttend(attend, settings.attention);
  if (attend !== null && attend !== undefined && (!attention || candidate)) return { ok: false, code: CODE.BAD_ATTEND };
  if (attention && dueAt !== null && dueAt !== undefined) return { ok: false, code: CODE.ATTEND_WITH_DUE };
  if (attention && every) return { ok: false, code: CODE.ATTEND_WITH_EVERY };
  if (dueAt !== null && !Number.isFinite(dueAt)) return { ok: false, code: CODE.BAD_DUE };
  if (!validEvery(every)) return { ok: false, code: CODE.BAD_EVERY };
  if (every && dueAt === null) return { ok: false, code: CODE.EVERY_WITHOUT_DUE };
  const ownDays = every ? (settings.recurringExpiresDays ?? DEFAULTS.recurringExpiresDays) : settings.expiresDays;
  const defaultExpiry = candidate ? now + settings.candidateExpiresHours * HOUR_MS : now + ownDays * DAY_MS;
  const expires = expiresAt === null || expiresAt === undefined ? defaultExpiry : expiresAt;
  if (!Number.isFinite(expires) || expires <= now) return { ok: false, code: CODE.BAD_EXPIRY };
  if (dueAt !== null && dueAt > expires) return { ok: false, code: CODE.DUE_AFTER_EXPIRY };
  const span = line(provenance.span, SPAN_CHARS);
  const participants = participantIds(provenance.participants);
  const messageId = idOrNull(provenance.messageId);
  const channelId = idOrNull(provenance.channelId);
  const bornOrigin: Provenance['origin'] = provenance.origin === 'external' ? 'external' : 'own';
  const status = candidate ? 'proposed' : 'pending';
  const intention: Intention = {
    id,
    purpose: text,
    provenance: {
      kind: provenance.kind,
      turnId: idOrNull(provenance.turnId),
      ...(messageId ? { messageId } : {}),
      ...(channelId ? { channelId } : {}),
      ...(span ? { span } : {}),
      scope: provenance.scope === 'dm' ? 'dm' : 'group',
      ...(participants.length > 0 ? { participants } : {}),
      // A candidate's origin (candidatesFromAnswer): `external` when its words came from outside
      // material, which only her explicit accept in a later ordinary turn activates (acceptRefusal).
      ...(candidate ? { origin: bornOrigin } : {}),
      ...(candidate && provenance.origin === 'external' && typeof provenance.originReason === 'string'
        ? { originReason: provenance.originReason }
        : {}),
      ...(candidate && provenance.bornInner === true
        ? {
            bornInner: true,
            ...(line(provenance.innerChainId, CHAIN_CHARS + 16)
              ? { innerChainId: line(provenance.innerChainId, CHAIN_CHARS + 16) }
              : {}),
          }
        : {}),
    },
    status,
    createdAt: now,
    updatedAt: now,
    dueAt: dueAt ?? null,
    every: every ? { period: every.period, at: every.at ?? null } : null,
    expiresAt: expires,
    awaitingErrandId: null,
    waitDeadline: null,
    destination: idOrNull(destination),
    completionCondition: line(completionCondition, CONDITION_CHARS) || null,
    chainId: line(chainId, CHAIN_CHARS) || null,
    attend: attention,
    // Where the engine made it, when that matters (`heartbeat`): stamped by the engine, kept through every update, never read for priority.
    ...(origin === HEARTBEAT_ORIGIN ? { origin: HEARTBEAT_ORIGIN } : {}),
    history: [{ at: now, to: status, by }],
  };
  return { ok: true, intention };
}

/**
 * A record born `dropped` (createIntention's `dropped: true`): the purpose and the required
 * `reason` (`reason-required` without one), her own only (a candidate is `bad-provenance`), no due
 * time, recurrence or attention; its `expiresAt` is `now` (it is closed, nothing ever expires it).
 */
function createDropped({
  text,
  provenance,
  reason,
  now,
  id,
  by,
}: {
  text: string;
  provenance: CreateInput['provenance'];
  reason: string | null;
  now: number;
  id: string;
  by: string;
}): Created {
  if (provenance.kind !== 'self') return { ok: false, code: CODE.BAD_PROVENANCE };
  const why = line(reason, REASON_CHARS);
  if (!why) return { ok: false, code: CODE.REASON_REQUIRED };
  const span = line(provenance.span, SPAN_CHARS);
  const participants = participantIds(provenance.participants);
  const messageId = idOrNull(provenance.messageId);
  const channelId = idOrNull(provenance.channelId);
  const intention: Intention = {
    id,
    purpose: text,
    provenance: {
      kind: 'self',
      turnId: idOrNull(provenance.turnId),
      ...(messageId ? { messageId } : {}),
      ...(channelId ? { channelId } : {}),
      ...(span ? { span } : {}),
      scope: provenance.scope === 'dm' ? 'dm' : 'group',
      ...(participants.length > 0 ? { participants } : {}),
    },
    status: 'dropped',
    createdAt: now,
    updatedAt: now,
    dueAt: null,
    every: null,
    expiresAt: now,
    awaitingErrandId: null,
    waitDeadline: null,
    destination: null,
    completionCondition: null,
    chainId: null,
    attend: null,
    reason: why,
    droppedAt: now,
    history: [{ at: now, to: 'dropped', by }],
  };
  return { ok: true, intention };
}

/**
 * Open `record` dropped with `reason` (cut to REASON_CHARS): the `dropped` move with the reason and
 * `droppedAt` set. `{ ok: false, code }`: `reason-required` without a reason, else transition's
 * (`terminal`, `bad-move`).
 */
export function dropIntention(
  record: Intention,
  { reason, now, by = 'persona' }: { reason?: string | null; now: number; by?: string }
): Moved {
  const why = line(reason, REASON_CHARS);
  if (!why) return { ok: false, code: CODE.REASON_REQUIRED };
  return transition(record, 'dropped', { now, by, code: CODE.DROPPED, patch: { reason: why, droppedAt: now } });
}

/**
 * Why the persona may not accept candidate `record` (move it `proposed` -> `pending`) from where her
 * call comes, or null: `candidate-same-turn` (the turn that wrote the line it came from: an accept
 * comes in a later turn), and from an inner turn (`initiative`) `candidate-external` (its words came
 * from outside material: only an ordinary turn of hers accepts it) and `candidate-same-chain` (it
 * was born in an inner turn of the very chain asking). An owner's command (`by` not `persona`) is
 * never refused here. Pure.
 */
export function acceptRefusal(
  record: Intention,
  {
    by = 'persona',
    initiative = false,
    chainId = null,
    turnId = null,
  }: { by?: string; initiative?: boolean; chainId?: string | null; turnId?: string | null } = {}
): 'candidate-same-turn' | 'candidate-external' | 'candidate-same-chain' | null {
  if (record?.status !== 'proposed' || by !== 'persona') return null;
  const provenance: Partial<Provenance> = record.provenance ?? {};
  if (turnId && provenance.turnId && String(provenance.turnId) === String(turnId)) return 'candidate-same-turn';
  if (!initiative) return null;
  if (provenance.origin === 'external') return 'candidate-external';
  if (provenance.bornInner === true && chainId && provenance.innerChainId === String(chainId))
    return 'candidate-same-chain';
  return null;
}

/**
 * `record` moved to `to`: `{ ok: true, intention, changed: true }`, or `{ ok: false, code }`
 * (`terminal` out of a terminal status, `bad-move` for a move its status does not allow, or the
 * invariant the result would break). `patch` sets fields along with the move (a wait's errand and
 * deadline, an outcome, a note); `by` and `code` go to the history entry.
 */
export function transition(
  record: Intention,
  to: IntentionStatus,
  {
    now,
    by = 'persona',
    code = null,
    patch = {},
  }: { now: number; by?: string; code?: string | null; patch?: Partial<Intention> }
): Moved {
  if (isTerminal(record?.status)) return { ok: false, code: CODE.TERMINAL };
  if (!MOVES[record?.status]?.includes(to)) return { ok: false, code: CODE.BAD_MOVE };
  const leavingWait = record.status === 'waiting' && to !== 'waiting';
  let next: Intention = { ...record, ...patch, status: to, updatedAt: now };
  // Out of a wait the errand stays named in `outcome`/`lastErrandId`, never as an open wait.
  if (leavingWait)
    next = { ...next, awaitingErrandId: null, waitDeadline: null, lastErrandId: record.awaitingErrandId ?? null };
  const broken = checkInvariants(next);
  if (broken) return { ok: false, code: broken };
  next = withHistory(next, { at: now, from: record.status, to, by, ...(code ? { code } : {}) });
  return { ok: true, intention: next, changed: true };
}

/**
 * `record` set waiting on errand `errandId` until `deadline` (epoch ms, after `now`): from `pending`,
 * or from `waiting` on another errand (the wait moves to the new one). `{ ok: false, code }`:
 * `wait-without-errand`, `bad-deadline`, or transition's codes.
 */
export function waitOn(
  record: Intention,
  {
    errandId,
    deadline,
    now,
    by = 'persona',
  }: { errandId: unknown; deadline: number | null | undefined; now: number; by?: string }
): Moved {
  const id = idOrNull(errandId);
  if (!id) return { ok: false, code: CODE.WAIT_WITHOUT_ERRAND };
  if (!isFiniteNumber(deadline) || deadline <= now) return { ok: false, code: CODE.BAD_DEADLINE };
  const patch = { awaitingErrandId: id, waitDeadline: deadline, waitRequested: null };
  if (record?.status === 'waiting') {
    const next = { ...record, ...patch, updatedAt: now };
    return {
      ok: true,
      intention: withHistory(next, { at: now, from: 'waiting', to: 'waiting', by, code: CODE.REWAIT }),
      changed: true,
    };
  }
  return transition(record, 'waiting', { now, by, code: CODE.WAIT, patch });
}

/** The terminal errand states (src/errands/store.ts#ERRAND_STATES less the open ones). */
const ERRAND_ENDS: ReadonlyArray<string> = Object.freeze(['done', 'failed', 'cancelled'] as const);

/**
 * The end of errand `errand` reaching `record`: a `waiting` record awaiting that very errand moves to
 * `pending` with `outcome: { errandId, state, error?, at }` (`code` `errand-<state>`). Anything else
 * -- another errand, a record no longer waiting (the same end delivered twice), an errand still open
 * -- changes nothing: `{ ok: true, intention: record, changed: false }`.
 */
export function arrive(record: Intention, errand: ErrandLike, { now }: { now: number }): Moved {
  if (
    record?.status !== 'waiting' ||
    !errand ||
    record.awaitingErrandId !== String(errand.id) ||
    !ERRAND_ENDS.includes(errand.state)
  ) {
    return { ok: true, intention: record, changed: false };
  }
  const at = isFiniteNumber(errand.endedAt) ? errand.endedAt : now;
  const outcome = {
    errandId: String(errand.id),
    state: errand.state,
    ...(errand.error ? { error: String(errand.error) } : {}),
    at,
  };
  // The end is a fresh due moment when the old one has passed: the scheduler's wake id carries
  // the due time, and the old moment was handled when she set the wait, so without this nothing
  // would wake her for the outcome once the result turn leaves the record open.
  const dueAt = isFiniteNumber(record.dueAt) && record.dueAt > at ? record.dueAt : at;
  return transition(record, 'pending', {
    now,
    by: 'engine',
    code: `errand-${errand.state}`,
    patch: { outcome, note: `errand-${errand.state}`, dueAt },
  });
}

/** `record` expired when it is open and `now` is at or past its `expiresAt`; unchanged otherwise. */
export function expireAt(record: Intention, now: number): Moved {
  if (!isOpen(record?.status) || !(now >= record.expiresAt)) return { ok: true, intention: record, changed: false };
  return transition(record, 'expired', { now, by: 'engine', code: CODE.EXPIRED });
}

/** When `record` expired: its last history entry's `at` (the expiry's), else `updatedAt`. */
export function expiredAtOf(record: Intention): number {
  const last = Array.isArray(record?.history) ? record.history.at(-1) : null;
  return isFiniteNumber(last?.at) ? last.at : (record?.updatedAt ?? 0);
}

/**
 * The expired intentions of hers she has not been told about yet, for the `<wake>` of her next
 * review (docs/inner-life.md): `expired` records without `expiredShownAt`, a candidate
 * (provenance `candidate`: never hers) left out, the newest expiry first, at most `max` as
 * `items` (`{ id, purpose, at }`, `at` the expiry's moment, expiredAtOf) and the rest counted
 * in `more`. Pure.
 */
export function expiredToShow(
  records: unknown,
  { max = 5 }: { max?: number } = {}
): { items: Array<{ id: string; purpose: string; at: number }>; more: number } {
  const list = listOf(records)
    .filter((record): record is Intention => {
      const given = objOf(record);
      return (
        given.status === 'expired' &&
        !isFiniteNumber(given.expiredShownAt) &&
        objOf(given.provenance).kind !== 'candidate'
      );
    })
    .sort((a, b) => expiredAtOf(b) - expiredAtOf(a));
  const cap = Math.max(0, Math.floor(max));
  return {
    items: list.slice(0, cap).map((record) => ({ id: record.id, purpose: record.purpose, at: expiredAtOf(record) })),
    more: Math.max(0, list.length - cap),
  };
}

/**
 * `record` marked as shown to her after its expiry (`expiredShownAt: now`), a store `update`
 * move: an expired record not yet marked changes; any other answers unchanged.
 */
export function markExpiredShown(record: Intention, now: number): Moved {
  if (record?.status !== 'expired' || isFiniteNumber(record.expiredShownAt))
    return { ok: true, intention: record, changed: false };
  return { ok: true, intention: { ...record, expiredShownAt: now }, changed: true };
}

/**
 * Recurring `record`'s current occurrence closed and the next one set: `pending` (a wait closed on
 * the way, its errand kept as `lastErrandId`), `dueAt` the next occurrence after `now`
 * (nextOccurrence: the ones already past are skipped; it may lie past `expiresAt`, which then
 * wins), the past occurrence's `note` and `outcome` cleared unless `keepWaitEnd` (the wait's end
 * is what moved it), and the history entry `{ from, to: 'pending', by, code }` with `code` one
 * of OCCURRENCE_CODES: `done-occurrence` (her `state=done`), `recurred` (she touched it),
 * `missed` (nothing of hers named it). `{ ok: false, code }`: `not-recurring`, `terminal`,
 * `bad-move` (a candidate), `no-next` (the next occurrence cannot be told).
 */
export function advanceOccurrence(
  record: Intention,
  {
    now,
    timezone = 'UTC',
    code,
    by = 'persona',
    keepWaitEnd = false,
  }: { now: number; timezone?: string; code: string; by?: string; keepWaitEnd?: boolean }
): Moved {
  if (!record?.every) return { ok: false, code: CODE.NOT_RECURRING };
  if (isTerminal(record.status)) return { ok: false, code: CODE.TERMINAL };
  if (record.status !== 'pending' && record.status !== 'waiting') return { ok: false, code: CODE.BAD_MOVE };
  const dueAt = nextOccurrence(record, now, timezone);
  if (!isFiniteNumber(dueAt)) return { ok: false, code: CODE.NO_NEXT };
  const leavingWait = record.status === 'waiting';
  let next: Intention = {
    ...record,
    status: 'pending',
    dueAt,
    updatedAt: now,
    awaitingErrandId: null,
    waitDeadline: null,
    waitRequested: null,
    ...(leavingWait ? { lastErrandId: record.awaitingErrandId ?? null } : {}),
    ...(keepWaitEnd ? {} : { note: null, outcome: null }),
  };
  const broken = checkInvariants(next);
  if (broken) return { ok: false, code: broken };
  next = withHistory(next, { at: now, from: record.status, to: 'pending', by, ...(code ? { code } : {}) });
  return { ok: true, intention: next, changed: true };
}

/**
 * `record` after the wake of its due moment slept (the core was down or paused when it fell due; the owner, 2026-10-27):
 * a recurring one moves past that occurrence (advanceOccurrence, code `slept`), a one-off is cancelled with the code
 * `slept` and `sleptAt: now`, which her later calls on it answer. A closed record changes nothing.
 */
export function sleepIntention(record: Intention, { now, timezone }: { now: number; timezone: string }): Moved {
  if (!isOpen(record.status)) return { ok: true, intention: record, changed: false };
  if (record.every) return advanceOccurrence(record, { now, timezone, code: CODE.SLEPT, by: 'engine' });
  return transition(record, 'cancelled', { now, by: 'engine', code: CODE.SLEPT, patch: { sleptAt: now } });
}

/**
 * One `waiting` record reconciled against the errand store (`errandOf(id)`: the errand, or null when
 * the store has none): the errand gone -> `pending` with note `errand-missing`; the errand ended ->
 * as `arrive`; the wait deadline passed -> `pending` with note `wait-deadline`; else unchanged.
 */
export function reconcileWait(
  record: Intention,
  { errandOf, now }: { errandOf: ((id: string | null) => ErrandLike | null) | null | undefined; now: number }
): Moved {
  if (record?.status !== 'waiting') return { ok: true, intention: record, changed: false };
  const errand = typeof errandOf === 'function' ? errandOf(record.awaitingErrandId) : null;
  if (!errand)
    return transition(record, 'pending', {
      now,
      by: 'engine',
      code: CODE.ERRAND_MISSING,
      patch: { note: 'errand-missing' },
    });
  if (ERRAND_ENDS.includes(errand.state)) return arrive(record, errand, { now });
  if (isFiniteNumber(record.waitDeadline) && now >= record.waitDeadline)
    return transition(record, 'pending', {
      now,
      by: 'engine',
      code: CODE.WAIT_DEADLINE,
      patch: { note: 'wait-deadline' },
    });
  return { ok: true, intention: record, changed: false };
}

/**
 * What is due at `now`, for the scheduler of step 2 (listing, not choosing): every `pending` or
 * `waiting` record whose `dueAt` is at or before `now` (`reason: 'due'`), and every `waiting` one
 * past its `waitDeadline` (`reason: 'wait-deadline'`), the earliest moment first. A proposed
 * candidate is never due: it wakes nobody.
 */
export function dueList(records: unknown, now: number, jitterMinutes = 0): Array<Due> {
  const out: Array<Due> = [];
  const live = listOf(records).filter((record): record is Intention => {
    const status = objOf(record).status;
    return status === 'pending' || status === 'waiting';
  });
  for (const record of live) {
    if (record.status === 'waiting' && isFiniteNumber(record.waitDeadline) && record.waitDeadline <= now)
      out.push({ intention: record, reason: 'wait-deadline', at: record.waitDeadline });
    else if (isFiniteNumber(record.dueAt) && wakeTimeOf(record, jitterMinutes) <= now)
      out.push({ intention: record, reason: 'due', at: record.dueAt });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Lower-cased, whitespace folded: how two texts are compared. */
export function foldText(text: string | null | undefined): string {
  return oneLine(String(text ?? '')).toLowerCase();
}

/**
 * Whether candidate `candidate` (`{ purpose, messageId, span }`) repeats one of `records`' open
 * intentions: the same message and span, or the same purpose (folded).
 */
export function duplicates(
  candidate: { purpose?: string; messageId?: string; span?: string } | null | undefined,
  records: Array<Intention> | null | undefined
): boolean {
  const purpose = foldText(candidate?.purpose);
  const span = foldText(candidate?.span);
  const messageId = candidate?.messageId;
  return (Array.isArray(records) ? records : []).some((record) => {
    if (!isOpen(record?.status)) return false;
    if (purpose && foldText(record.purpose) === purpose) return true;
    return (
      Boolean(messageId) &&
      record.provenance?.messageId === messageId &&
      span &&
      foldText(record.provenance?.span) === span
    );
  });
}

/**
 * The intention candidates of one analyzer answer (`raw`: its `intentions` field, an array of
 * `{ span, purpose }`), anchored to the persona's own lines of the batch (`messages`, slim, `self`
 * true marking hers): a candidate whose `span` occurs (folded) in exactly her line is kept with
 * that line's id, channel and time, and the other authors of that channel in the batch
 * (`participants`, left out when none); a span found in none of her lines is dropped (`unanchored`),
 * and one that also occurs in another author's line of the batch is dropped as a quote of
 * someone else (`quoted`). At most `max` are kept (`over`). Each kept one carries its `origin`
 * (src/intentions/sources.ts#externalOrigin over the line and its note, `sourcesOf(line)`, the
 * line's own `sources` by default; `strict`: a line of hers with no note counts as external):
 * `external` with its `originReason`, else `own`; and the turn that wrote the line (`turnId`), and
 * whether it was an inner turn of which chain (`bornInner`, `innerChainId`). Never throws.
 */
export function candidatesFromAnswer(
  raw: unknown,
  messages: Array<Untyped> | null | undefined,
  {
    max,
    sourcesOf = null,
    strict = false,
  }: { max: number; sourcesOf?: ((line: Untyped) => Untyped) | null; strict?: boolean }
): {
  candidates: Array<Candidate>;
  dropped: { invalid: number; unanchored: number; quoted: number; over: number };
} {
  const dropped = { invalid: 0, unanchored: 0, quoted: 0, over: 0 };
  const candidates: Array<Candidate> = [];
  const list: Array<Untyped> = Array.isArray(raw) ? raw : [];
  const lines = Array.isArray(messages) ? messages.filter((m) => m && typeof m.content === 'string') : [];
  const hers = lines.filter((m) => m.self === true);
  const others = lines.filter((m) => m.self !== true);
  // The members of a line's conversation: the other authors of its channel in the batch.
  const membersOf = (own: Untyped): Array<string> =>
    participantIds(
      others
        .filter(
          (m) =>
            String(m.channelId ?? '') === String(own.channelId ?? '') && m.authorId !== undefined && m.authorId !== null
        )
        .map((m) => String(m.authorId))
    );
  for (const item of list) {
    const span = line(item?.span, SPAN_CHARS);
    const purpose = line(item?.purpose, PURPOSE_CHARS);
    if (!span || !purpose) {
      dropped.invalid += 1;
      continue;
    }
    const folded = foldText(span);
    const own = [...hers].reverse().find((m) => foldText(m.content).includes(folded));
    if (!own) {
      dropped.unanchored += 1;
      continue;
    }
    if (others.some((m) => foldText(m.content).includes(folded))) {
      dropped.quoted += 1;
      continue;
    }
    if (candidates.some((kept) => kept.messageId === String(own.id) && foldText(kept.span) === folded)) continue;
    if (candidates.length >= max) {
      dropped.over += 1;
      continue;
    }
    const participants = membersOf(own);
    let sources: Untyped = null;
    try {
      sources = (typeof sourcesOf === 'function' ? sourcesOf(own) : null) ?? own.sources ?? null;
    } catch {
      sources = null;
    }
    const reason = externalOrigin({ span, purpose }, own, sources, { strict });
    const turnId = idOrNull(sources?.turnId) ?? idOrNull(own.inner?.turnId);
    const chainId = idOrNull(sources?.chainId);
    candidates.push({
      purpose,
      span,
      messageId: String(own.id),
      channelId: own.channelId ? String(own.channelId) : null,
      ts: isFiniteNumber(own.ts) ? own.ts : null,
      ...(participants.length > 0 ? { participants } : {}),
      origin: reason ? 'external' : 'own',
      ...(reason ? { originReason: reason } : {}),
      turnId,
      ...(sources?.inner === true || own.inner
        ? { bornInner: true, ...(chainId ? { innerChainId: chainId } : {}) }
        : {}),
    });
  }
  return { candidates, dropped };
}

/**
 * Whether `record` concerns member `userId` (src/memory/db/session.js, the intentions her memory session shows): it is
 * meant for them (`destination`), an attention names them (`attend.people`), it came from a
 * conversation with them (`provenance.participants`),
 * or its words -- the purpose, the quoted span, the completion condition, the chain, an errand's
 * error -- carry their id (their `<@id>` token included) or one of `names` as a whole word
 * (accents folded; a name under three letters or digits is never matched).
 */
export function concernsMember(
  record: Intention,
  { userId, names = [] }: { userId: string; names?: Array<string> }
): boolean {
  const id = String(userId ?? '');
  if (!id || !record) return false;
  if (record.destination === id) return true;
  if (Array.isArray(record.attend?.people) && record.attend.people.includes(id)) return true;
  const provenance: Partial<Provenance> = record.provenance ?? {};
  if (Array.isArray(provenance.participants) && provenance.participants.includes(id)) return true;
  const texts = [
    record.purpose,
    provenance.span,
    record.completionCondition,
    record.chainId,
    record.reason,
    record.outcome?.error,
  ].filter((text): text is string => typeof text === 'string' && text !== '');
  if (texts.some((text) => text.includes(id))) return true;
  const folded = [
    ...new Set((Array.isArray(names) ? names : []).filter((name) => typeof name === 'string').map(foldName)),
  ].filter((name) => [...name].filter((ch) => isWordChar(ch) && ch !== '_').length >= MIN_FORGET_NAME);
  if (folded.length === 0) return false;
  return texts.some((text) => {
    const haystack = foldName(text);
    return folded.some((name) => occursAsWholeWord(haystack, name));
  });
}
