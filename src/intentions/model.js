// The persona's intentions as data (docs/intentions.md): what she means to do later, set by her
// own call (`intent.set`, provenance `self`, born `pending`) or proposed by the memory analyzer
// from one of her own lines (provenance `candidate`, born `proposed`, never active until she
// accepts it). Pure: every function takes the record and the clock (`now`, epoch ms) and answers
// a new record, never mutating its input; the store (src/intentions/store.js) persists them.
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
// `waiting` one has both `awaitingTaskId` and `waitDeadline` -- there is no wait without a real
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
// (src/behavior/inner.js). normalizeAttend fills the defaults (ATTEND_DEFAULTS, or
// `innerLife.attention.*` through attentionSettings); validAttend checks the shape.

import { createHash, randomUUID } from 'node:crypto';
import { DAY_MS, HOUR_MS, MINUTE_MS, zonedDay, zonedEpoch } from '../time.js';
import { clampChars, oneLine } from '../memory/clamp.js';
import { isWordChar, occursAsWholeWord } from '../memory/mentions.js';
import { foldText as foldName } from '../memory/recent.js';
import { externalOrigin } from './sources.js';
import { CODE } from '../skills/codes.js';

/** Every status an intention may have. */
export const STATUSES = Object.freeze(['proposed', 'pending', 'waiting', 'done', 'cancelled', 'expired', 'dropped']);
/** The statuses nothing moves out of. */
export const TERMINAL = Object.freeze(['done', 'cancelled', 'expired', 'dropped']);
/** The statuses of an intention still open. */
export const OPEN = Object.freeze(['proposed', 'pending', 'waiting']);
/** Where an intention came from. */
export const PROVENANCE_KINDS = Object.freeze(['self', 'candidate']);

/** The moves each status allows. */
const MOVES = Object.freeze({
  proposed: ['pending', 'cancelled', 'expired', 'dropped'],
  pending: ['waiting', 'done', 'cancelled', 'expired', 'dropped'],
  waiting: ['pending', 'done', 'cancelled', 'expired', 'dropped'],
  done: [],
  cancelled: [],
  expired: [],
  dropped: [],
});

/** The defaults of the `intentions` config section (config.json carries the same). */
export const DEFAULTS = Object.freeze({ expiresDays: 14, recurringExpiresDays: 30, maxOpen: 20, maxCandidates: 5, candidateExpiresHours: 48, waitHours: 2, expiryNoticeDays: 2 });
/** The defaults of `innerLife.attention` an attention record needs (config.json carries the same). */
export const ATTEND_DEFAULTS = Object.freeze({ settleSeconds: 90, perDayDefault: 12 });
/** The most people one attention names. */
export const ATTEND_PEOPLE_MAX = 20;
/** The periods `every` names by a word; `<n>h` and `<n>d` are the interval forms. */
export const EVERY_PERIODS = Object.freeze(['day', 'week']);
/** The occurrence codes advanceOccurrence writes to the history. */
export const OCCURRENCE_CODES = Object.freeze(['recurred', 'missed', 'done-occurrence']);
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
export const HEARTBEAT_ORIGIN = 'heartbeat';
/** What a heartbeat may hold open at once (`innerLife.heartbeat.maxOpen` / `maxRecurring`; config.json carries the same). */
export const HEARTBEAT_LIMITS = Object.freeze({ maxOpen: 3, maxRecurring: 1 });

/** `innerLife.heartbeat.maxOpen` and `maxRecurring`, read from the live config now, each a whole number >= 0 or the default. */
export function heartbeatLimits(config) {
  const set = config?.innerLife?.heartbeat ?? {};
  const pick = (key) => (Number.isFinite(set[key]) && set[key] >= 0 ? Math.floor(set[key]) : HEARTBEAT_LIMITS[key]);
  return { maxOpen: pick('maxOpen'), maxRecurring: pick('maxRecurring') };
}

/** `innerLife.heartbeat.dueJitterMinutes` (minutes, 0 disables), read from the live config now. */
export const DUE_JITTER_MINUTES = 20;
export function dueJitterMinutes(config) {
  const value = config?.innerLife?.heartbeat?.dueJitterMinutes;
  return Number.isFinite(value) && value >= 0 ? value : DUE_JITTER_MINUTES;
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
 * @param {object} record
 * @param {number} jitterMinutes
 * @returns {number} `dueAt` for an exact record; NaN with no due time.
 */
export function wakeTimeOf(record, jitterMinutes = 0) {
  const dueAt = record?.dueAt;
  if (!Number.isFinite(dueAt)) return NaN;
  if (record.origin !== HEARTBEAT_ORIGIN || !(jitterMinutes > 0)) return dueAt;
  const base = Math.max(Number.isFinite(record.createdAt) ? record.createdAt : -Infinity, Number.isFinite(record.updatedAt) ? record.updatedAt : -Infinity);
  const lead = Number.isFinite(base) ? dueAt - base : 0;
  const cap = Math.min(jitterMinutes * 60 * 1000, Math.max(0, lead) / 4);
  if (!(cap > 0)) return dueAt;
  const unit = createHash('sha256').update(`${record.id}:${dueAt}`).digest().readUInt32BE(0) / 2 ** 32;
  let at = Math.round(dueAt + (unit * 2 - 1) * cap);
  if (Number.isFinite(record.expiresAt) && at >= record.expiresAt) at = dueAt < record.expiresAt ? record.expiresAt - 1 : dueAt;
  return at;
}

/** The open (pending or waiting) intentions a heartbeat created, among `records`. */
export function openFromHeartbeat(records) {
  return (Array.isArray(records) ? records : []).filter((record) => record?.origin === HEARTBEAT_ORIGIN && (record.status === 'pending' || record.status === 'waiting'));
}

/** The `intentions` section's numbers, read from the live config now, each falling back to DEFAULTS. */
export function intentionSettings(config) {
  const set = config?.intentions ?? {};
  const pick = (key) => (Number.isFinite(set[key]) && set[key] >= 0 ? set[key] : DEFAULTS[key]);
  return { expiresDays: pick('expiresDays'), recurringExpiresDays: pick('recurringExpiresDays'), maxOpen: pick('maxOpen'), maxCandidates: pick('maxCandidates'), candidateExpiresHours: pick('candidateExpiresHours'), waitHours: pick('waitHours'), expiryNoticeDays: pick('expiryNoticeDays') };
}

/**
 * The `innerLife.attention` numbers an attention is born with, read from the live config now, each
 * falling back to ATTEND_DEFAULTS: `settleSeconds` (>= 0) and `perDayDefault` (an integer >= 1).
 */
export function attentionSettings(config) {
  const set = config?.innerLife?.attention ?? {};
  return {
    settleSeconds: Number.isFinite(set.settleSeconds) && set.settleSeconds >= 0 ? set.settleSeconds : ATTEND_DEFAULTS.settleSeconds,
    perDayDefault: Number.isInteger(set.perDayDefault) && set.perDayDefault >= 1 ? set.perDayDefault : ATTEND_DEFAULTS.perDayDefault,
  };
}

/** Whether `features.intentions` is exactly true (a missing key counts as off). */
export function intentionsOn(config) {
  return config?.features?.intentions === true;
}

/** True for a status nothing moves out of. */
export function isTerminal(status) {
  return TERMINAL.includes(status);
}

/** True for an open status. */
export function isOpen(status) {
  return OPEN.includes(status);
}

/** A fresh intention id (`i` + 8 hex characters). */
export function newIntentionId(uuid = randomUUID) {
  return `i${uuid().replace(/-/g, '').slice(0, 8)}`;
}

/** One token shaped like an intention id (newIntentionId's `i` + hex digits), nothing around it. */
const INTENTION_ID_RE = /^i[0-9a-f]{1,32}$/i;

/**
 * Whether `value` is one bare token that looks like an intention id (`i` + hex digits, as
 * newIntentionId makes them): what a call's body is when she wrote the id there and nothing else.
 * @param {unknown} value
 * @returns {boolean}
 */
export function isIntentionId(value) {
  return typeof value === 'string' && INTENTION_ID_RE.test(value.trim());
}

const RELATIVE_RE = /^(\d{1,5})\s*(m|min|h|d)$/i;
const CLOCK_RE = /^(?:(mon|tue|wed|thu|fri|sat|sun)\s+)?(\d{1,2}):(\d{2})$/i;
/** The weekdays as `<weekday> HH:MM` names them, Sunday first (Date#getUTCDay's order). */
const WEEKDAYS = Object.freeze(['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat']);

/** The calendar date `days` after `dateKey` (`YYYY-MM-DD`). */
function addDays(dateKey, days) {
  return new Date(Date.parse(`${dateKey}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/** The weekday (0 Sunday .. 6 Saturday) of the calendar date `dateKey`. */
function weekdayOf(dateKey) {
  return new Date(Date.parse(`${dateKey}T00:00:00Z`)).getUTCDay();
}

/** `HH:MM` of the instant `ms` on the wall clock of `timezone`. */
function wallTime(ms, timezone) {
  const parts = new Intl.DateTimeFormat('en-US', { timeZone: timezone, hourCycle: 'h23', hour: '2-digit', minute: '2-digit' }).formatToParts(ms);
  const get = (type) => parts.find((part) => part.type === type)?.value ?? '00';
  return `${String(Number(get('hour')) % 24).padStart(2, '0')}:${get('minute')}`;
}

/** `{ hour, minute }` of an `HH:MM` text, or null when it is not a time of day. */
function clockOf(text) {
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
function nextWallClock({ fromDay, hour, minute, stepDays, timezone, after }) {
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
 * @param {unknown} text
 * @param {number} now
 * @param {{ timezone?: string }} [options]
 * @returns {number|null}
 */
export function parseWhen(text, now, { timezone = 'UTC' } = {}) {
  const value = String(text ?? '').trim();
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
    let day;
    try {
      day = zonedDay(now, timezone || 'UTC');
    } catch {
      return null;
    }
    const weekday = clock[1] ? WEEKDAYS.indexOf(clock[1].toLowerCase()) : -1;
    if (weekday >= 0) day = addDays(day, (weekday - weekdayOf(day) + 7) % 7);
    const at = nextWallClock({ fromDay: day, ...time, stepDays: weekday >= 0 ? 7 : 1, timezone: timezone || 'UTC', after: now });
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
 * @param {unknown} text
 * @returns {{ ok: true, every: { period: string, at: null }|null }|{ ok: false, code: 'bad-every' }}
 */
export function parseEvery(text) {
  const value = String(typeof text === 'string' ? text : '').trim().toLowerCase();
  if (value === 'none') return { ok: true, every: null };
  if (EVERY_PERIODS.includes(value)) return { ok: true, every: { period: value, at: null } };
  const interval = INTERVAL_RE.exec(value);
  if (interval && Number(interval[1]) >= 1) return { ok: true, every: { period: `${Number(interval[1])}${interval[2].toLowerCase()}`, at: null } };
  return { ok: false, code: CODE.BAD_EVERY };
}

/** Whether `every` is a well-formed recurrence (null counts as a one-off, which is fine). */
export function validEvery(every) {
  if (every === null || every === undefined) return true;
  if (!every || typeof every !== 'object' || Array.isArray(every)) return false;
  const period = typeof every.period === 'string' ? parseEvery(every.period) : null;
  if (!period?.ok || period.every === null) return false;
  return every.at === null || every.at === undefined || clockOf(every.at) !== null;
}

/** The step of an interval period (`<n>h`, `<n>d`) in ms, or null for `day` and `week`. */
function intervalMs(period) {
  const match = INTERVAL_RE.exec(String(period ?? ''));
  return match ? Number(match[1]) * (match[2].toLowerCase() === 'd' ? DAY_MS : HOUR_MS) : null;
}

/**
 * `every` with its wall-clock time pinned from the first occurrence `dueAt` in `timezone` (for
 * `day` and `week`, when it has none yet), so a daily 21:00 stays 21:00 across a DST change.
 * An interval period and a one-off (null) come back as they are.
 * @param {{ period: string, at: string|null }|null} every
 * @param {number|null} dueAt
 * @param {string} timezone
 */
export function pinEvery(every, dueAt, timezone) {
  if (!every || !EVERY_PERIODS.includes(every.period) || every.at || !Number.isFinite(dueAt)) return every ?? null;
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
 * @param {{ every: object|null, dueAt: number|null }} record
 * @param {number} now
 * @param {string} timezone
 * @returns {number|null}
 */
export function nextOccurrence(record, now, timezone = 'UTC') {
  const every = record?.every;
  if (!validEvery(every) || !every || !Number.isFinite(record?.dueAt)) return null;
  const after = Math.max(now, record.dueAt);
  const step = intervalMs(every.period);
  if (step) {
    const steps = Math.floor((after - record.dueAt) / step) + 1;
    return record.dueAt + steps * step;
  }
  try {
    const zone = timezone || 'UTC';
    const time = clockOf(every.at ?? wallTime(record.dueAt, zone));
    if (!time) return null;
    const at = nextWallClock({ fromDay: zonedDay(record.dueAt, zone), ...time, stepDays: every.period === 'week' ? 7 : 1, timezone: zone, after });
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
export function validAttend(attend) {
  if (attend === null || attend === undefined) return true;
  if (!attend || typeof attend !== 'object' || Array.isArray(attend)) return false;
  if (typeof attend.place !== 'string' || !attend.place) return false;
  if (!Array.isArray(attend.people) || attend.people.some((id) => typeof id !== 'string' || !id)) return false;
  if (!(Number.isFinite(attend.settle) && attend.settle >= 0)) return false;
  if (!(Number.isInteger(attend.perDay) && attend.perDay >= 1)) return false;
  const today = attend.today;
  if (today === null || today === undefined) return true;
  return Boolean(today) && typeof today === 'object' && typeof today.day === 'string' && Number.isInteger(today.wakes) && today.wakes >= 0;
}

/**
 * Her `attend` input (`{ place, people?, settle?, perDay?, today? }`: the place as the interface
 * addresses it, people as ids, strings or numbers) as a record's `attend`, the defaults filled
 * from `settings` (attentionSettings' shape): distinct people, at most ATTEND_PEOPLE_MAX, blank
 * tokens dropped. Null when it is not a well-formed attention (validAttend).
 * @param {object} input
 * @param {{ settleSeconds?: number, perDayDefault?: number }} [settings]
 * @returns {{ place: string, people: string[], settle: number, perDay: number, today: { day: string, wakes: number }|null }|null}
 */
export function normalizeAttend(input, { settleSeconds = ATTEND_DEFAULTS.settleSeconds, perDayDefault = ATTEND_DEFAULTS.perDayDefault } = {}) {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return null;
  const place = typeof input.place === 'string' ? input.place.trim() : typeof input.place === 'number' ? String(input.place) : '';
  const raw = input.people === undefined || input.people === null ? [] : input.people;
  if (!Array.isArray(raw)) return null;
  const people = [...new Set(raw.map((id) => (typeof id === 'string' ? id.trim() : typeof id === 'number' && Number.isFinite(id) ? String(id) : null)))].filter((id) => typeof id === 'string' && id).slice(0, ATTEND_PEOPLE_MAX);
  if (raw.some((id) => typeof id !== 'string' && typeof id !== 'number')) return null;
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
export function isAttend(record) {
  return Boolean(record?.attend && typeof record.attend === 'object' && typeof record.attend.place === 'string' && record.attend.place);
}

/**
 * The per-day counter of attention `record` on local day `day` (`YYYY-MM-DD` of `bot.timezone`):
 * `{ day, wakes }`, zero when the counter is of another day (the day changed). Pure.
 */
export function attendCounter(record, day) {
  const today = record?.attend?.today;
  return today && today.day === day ? { day, wakes: today.wakes } : { day, wakes: 0 };
}

/**
 * `record` with one more attend wake counted on local day `day` (a counter of another day starts
 * at zero): `{ ok: true, intention, changed: true }`, or `{ ok: false, code: 'not-attend' }`.
 */
export function bumpAttend(record, day) {
  if (!isAttend(record)) return { ok: false, code: CODE.NOT_ATTEND };
  const current = attendCounter(record, day);
  return { ok: true, intention: { ...record, attend: { ...record.attend, today: { day, wakes: current.wakes + 1 } } }, changed: true };
}

/** One line of text cut to `max` characters; '' for nothing. */
function line(text, max) {
  return clampChars(oneLine(typeof text === 'string' ? text : ''), max);
}

/** A string id or null. */
function idOrNull(value) {
  return (typeof value === 'string' && value) || (typeof value === 'number' && Number.isFinite(value)) ? String(value) : null;
}

/** The distinct non-empty string ids of `list`, at most PARTICIPANTS_MAX. */
function participantIds(list) {
  return [...new Set((Array.isArray(list) ? list : []).filter((id) => typeof id === 'string' && id))].slice(0, PARTICIPANTS_MAX);
}

/**
 * The invariant `record` breaks, as a code, or null: `bad-status`, `no-purpose`, `no-expiry`,
 * `wait-without-task`, `wait-without-deadline`, `bad-attend`, `attend-with-due`, `attend-with-every`
 * (an attention has no due time and no recurrence), `bad-every`, `every-without-due` (a recurring
 * one always has its current occurrence), `recurring-done` (a recurring one is never done).
 * @param {object} record
 * @returns {string|null}
 */
export function checkInvariants(record) {
  if (!record || !STATUSES.includes(record.status)) return 'bad-status';
  if (typeof record.purpose !== 'string' || !record.purpose) return 'no-purpose';
  if (!Number.isFinite(record.expiresAt)) return 'no-expiry';
  if (record.status === 'dropped' && (typeof record.reason !== 'string' || !record.reason)) return 'reason-required';
  if (!validAttend(record.attend)) return 'bad-attend';
  if (record.attend) {
    if (record.dueAt !== null && record.dueAt !== undefined) return 'attend-with-due';
    if (record.every) return 'attend-with-every';
  }
  if (!validEvery(record.every)) return 'bad-every';
  if (record.every) {
    if (!Number.isFinite(record.dueAt)) return 'every-without-due';
    if (record.status === 'done') return 'recurring-done';
  }
  if (record.status === 'waiting') {
    if (typeof record.awaitingTaskId !== 'string' || !record.awaitingTaskId) return 'wait-without-task';
    if (!Number.isFinite(record.waitDeadline)) return 'wait-without-deadline';
  }
  return null;
}

/** `record` with one more history entry (the oldest dropped past HISTORY_MAX). */
function withHistory(record, entry) {
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
 * @param {{ purpose: string, provenance: { kind: string, turnId?: string|null, messageId?: string|null, channelId?: string|null, span?: string|null, scope?: 'dm'|'group', participants?: string[] },
 *   dueAt?: number|null, every?: { period: string, at: string|null }|null, expiresAt?: number|null, destination?: string|null,
 *   completionCondition?: string|null, chainId?: string|null, attend?: object|null, now: number, settings?: object, id?: string, by?: string }} input
 */
export function createIntention({ purpose, provenance, dueAt = null, every = null, expiresAt = null, destination = null, completionCondition = null, chainId = null, attend = null, origin = null, dropped = false, reason = null, now, settings = DEFAULTS, id = newIntentionId(), by = 'persona' }) {
  const text = line(purpose, PURPOSE_CHARS);
  if (!text) return { ok: false, code: CODE.NO_PURPOSE };
  if (!PROVENANCE_KINDS.includes(provenance?.kind)) return { ok: false, code: CODE.BAD_PROVENANCE };
  if (dropped) return createDropped({ text, provenance, reason, now, settings, id, by });
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
  const status = candidate ? 'proposed' : 'pending';
  const intention = {
    id,
    purpose: text,
    provenance: {
      kind: provenance.kind,
      turnId: idOrNull(provenance.turnId),
      ...(idOrNull(provenance.messageId) ? { messageId: idOrNull(provenance.messageId) } : {}),
      ...(idOrNull(provenance.channelId) ? { channelId: idOrNull(provenance.channelId) } : {}),
      ...(span ? { span } : {}),
      scope: provenance.scope === 'dm' ? 'dm' : 'group',
      ...(participants.length > 0 ? { participants } : {}),
      // A candidate's origin (candidatesFromAnswer): `external` when its words came from outside
      // material, which only her explicit accept in a later ordinary turn activates (acceptRefusal).
      ...(candidate ? { origin: provenance.origin === 'external' ? 'external' : 'own' } : {}),
      ...(candidate && provenance.origin === 'external' && typeof provenance.originReason === 'string' ? { originReason: provenance.originReason } : {}),
      ...(candidate && provenance.bornInner === true ? { bornInner: true, ...(line(provenance.innerChainId, CHAIN_CHARS + 16) ? { innerChainId: line(provenance.innerChainId, CHAIN_CHARS + 16) } : {}) } : {}),
    },
    status,
    createdAt: now,
    updatedAt: now,
    dueAt: dueAt ?? null,
    every: every ? { period: every.period, at: every.at ?? null } : null,
    expiresAt: expires,
    awaitingTaskId: null,
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
function createDropped({ text, provenance, reason, now, settings, id, by }) {
  if (provenance.kind !== 'self') return { ok: false, code: CODE.BAD_PROVENANCE };
  const why = line(reason, REASON_CHARS);
  if (!why) return { ok: false, code: CODE.REASON_REQUIRED };
  const span = line(provenance.span, SPAN_CHARS);
  const participants = participantIds(provenance.participants);
  const intention = {
    id,
    purpose: text,
    provenance: {
      kind: 'self',
      turnId: idOrNull(provenance.turnId),
      ...(idOrNull(provenance.messageId) ? { messageId: idOrNull(provenance.messageId) } : {}),
      ...(idOrNull(provenance.channelId) ? { channelId: idOrNull(provenance.channelId) } : {}),
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
    awaitingTaskId: null,
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
export function dropIntention(record, { reason, now, by = 'persona' }) {
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
 * @param {object} record
 * @param {{ by?: string, initiative?: boolean, chainId?: string|null, turnId?: string|null }} caller
 * @returns {'candidate-same-turn'|'candidate-external'|'candidate-same-chain'|null}
 */
export function acceptRefusal(record, { by = 'persona', initiative = false, chainId = null, turnId = null } = {}) {
  if (record?.status !== 'proposed' || by !== 'persona') return null;
  const provenance = record.provenance ?? {};
  if (turnId && provenance.turnId && String(provenance.turnId) === String(turnId)) return 'candidate-same-turn';
  if (!initiative) return null;
  if (provenance.origin === 'external') return 'candidate-external';
  if (provenance.bornInner === true && chainId && provenance.innerChainId === String(chainId)) return 'candidate-same-chain';
  return null;
}

/**
 * `record` moved to `to`: `{ ok: true, intention, changed: true }`, or `{ ok: false, code }`
 * (`terminal` out of a terminal status, `bad-move` for a move its status does not allow, or the
 * invariant the result would break). `patch` sets fields along with the move (a wait's task and
 * deadline, an outcome, a note); `by` and `code` go to the history entry.
 * @param {object} record
 * @param {string} to
 * @param {{ now: number, by?: string, code?: string|null, patch?: object }} options
 */
export function transition(record, to, { now, by = 'persona', code = null, patch = {} }) {
  if (isTerminal(record?.status)) return { ok: false, code: CODE.TERMINAL };
  if (!MOVES[record?.status]?.includes(to)) return { ok: false, code: CODE.BAD_MOVE };
  const leavingWait = record.status === 'waiting' && to !== 'waiting';
  let next = { ...record, ...patch, status: to, updatedAt: now };
  // Out of a wait the errand stays named in `outcome`/`lastTaskId`, never as an open wait.
  if (leavingWait) next = { ...next, awaitingTaskId: null, waitDeadline: null, lastTaskId: record.awaitingTaskId ?? null };
  const broken = checkInvariants(next);
  if (broken) return { ok: false, code: broken };
  next = withHistory(next, { at: now, from: record.status, to, by, ...(code ? { code } : {}) });
  return { ok: true, intention: next, changed: true };
}

/**
 * `record` set waiting on errand `taskId` until `deadline` (epoch ms, after `now`): from `pending`,
 * or from `waiting` on another errand (the wait moves to the new one). `{ ok: false, code }`:
 * `wait-without-task`, `bad-deadline`, or transition's codes.
 */
export function waitOn(record, { taskId, deadline, now, by = 'persona' }) {
  const id = idOrNull(taskId);
  if (!id) return { ok: false, code: CODE.WAIT_WITHOUT_TASK };
  if (!Number.isFinite(deadline) || deadline <= now) return { ok: false, code: CODE.BAD_DEADLINE };
  const patch = { awaitingTaskId: id, waitDeadline: deadline, waitRequested: null };
  if (record?.status === 'waiting') {
    const next = { ...record, ...patch, updatedAt: now };
    return { ok: true, intention: withHistory(next, { at: now, from: 'waiting', to: 'waiting', by, code: CODE.REWAIT }), changed: true };
  }
  return transition(record, 'waiting', { now, by, code: CODE.WAIT, patch });
}

/** The terminal task states (src/errands/store.js#TASK_STATES less the open ones). */
const TASK_ENDS = Object.freeze(['done', 'failed', 'cancelled']);

/**
 * The end of errand `task` reaching `record`: a `waiting` record awaiting that very task moves to
 * `pending` with `outcome: { taskId, state, error?, at }` (`code` `task-<state>`). Anything else
 * -- another task, a record no longer waiting (the same end delivered twice), a task still open
 * -- changes nothing: `{ ok: true, intention: record, changed: false }`.
 */
export function arrive(record, task, { now }) {
  if (record?.status !== 'waiting' || !task || record.awaitingTaskId !== String(task.id) || !TASK_ENDS.includes(task.state)) {
    return { ok: true, intention: record, changed: false };
  }
  const at = Number.isFinite(task.endedAt) ? task.endedAt : now;
  const outcome = { taskId: String(task.id), state: task.state, ...(task.error ? { error: String(task.error) } : {}), at };
  // The end is a fresh due moment when the old one has passed: the scheduler's wake id carries
  // the due time, and the old moment was handled when she set the wait, so without this nothing
  // would wake her for the outcome once the result turn leaves the record open.
  const dueAt = Number.isFinite(record.dueAt) && record.dueAt > at ? record.dueAt : at;
  return transition(record, 'pending', { now, by: 'engine', code: `task-${task.state}`, patch: { outcome, note: `task-${task.state}`, dueAt } });
}

/** `record` expired when it is open and `now` is at or past its `expiresAt`; unchanged otherwise. */
export function expireAt(record, now) {
  if (!isOpen(record?.status) || !(now >= record.expiresAt)) return { ok: true, intention: record, changed: false };
  return transition(record, 'expired', { now, by: 'engine', code: CODE.EXPIRED });
}

/** When `record` expired: its last history entry's `at` (the expiry's), else `updatedAt`. */
export function expiredAtOf(record) {
  const last = Array.isArray(record?.history) ? record.history.at(-1) : null;
  return Number.isFinite(last?.at) ? last.at : record?.updatedAt ?? 0;
}

/**
 * The expired intentions of hers she has not been told about yet, for the `<wake>` of her next
 * review (docs/inner-life.md): `expired` records without `expiredShownAt`, a candidate
 * (provenance `candidate`: never hers) left out, the newest expiry first, at most `max` as
 * `items` (`{ id, purpose, at }`, `at` the expiry's moment, expiredAtOf) and the rest counted
 * in `more`. Pure.
 * @param {object[]} records
 * @param {{ max?: number }} [options]
 * @returns {{ items: { id: string, purpose: string, at: number }[], more: number }}
 */
export function expiredToShow(records, { max = 5 } = {}) {
  const list = (Array.isArray(records) ? records : [])
    .filter((record) => record?.status === 'expired' && !Number.isFinite(record.expiredShownAt) && record.provenance?.kind !== 'candidate')
    .sort((a, b) => expiredAtOf(b) - expiredAtOf(a));
  const cap = Math.max(0, Math.floor(max));
  return { items: list.slice(0, cap).map((record) => ({ id: record.id, purpose: record.purpose, at: expiredAtOf(record) })), more: Math.max(0, list.length - cap) };
}

/**
 * `record` marked as shown to her after its expiry (`expiredShownAt: now`), a store `update`
 * move: an expired record not yet marked changes; any other answers unchanged.
 */
export function markExpiredShown(record, now) {
  if (record?.status !== 'expired' || Number.isFinite(record.expiredShownAt)) return { ok: true, intention: record, changed: false };
  return { ok: true, intention: { ...record, expiredShownAt: now }, changed: true };
}

/**
 * Recurring `record`'s current occurrence closed and the next one set: `pending` (a wait closed on
 * the way, its errand kept as `lastTaskId`), `dueAt` the next occurrence after `now`
 * (nextOccurrence: the ones already past are skipped; it may lie past `expiresAt`, which then
 * wins), the past occurrence's `note` and `outcome` cleared unless `keepWaitEnd` (the wait's end
 * is what moved it), and the history entry `{ from, to: 'pending', by, code }` with `code` one
 * of OCCURRENCE_CODES: `done-occurrence` (her `state=done`), `recurred` (she touched it),
 * `missed` (nothing of hers named it). `{ ok: false, code }`: `not-recurring`, `terminal`,
 * `bad-move` (a candidate), `no-next` (the next occurrence cannot be told).
 * @param {object} record
 * @param {{ now: number, timezone?: string, code: string, by?: string, keepWaitEnd?: boolean }} options
 */
export function advanceOccurrence(record, { now, timezone = 'UTC', code, by = 'persona', keepWaitEnd = false }) {
  if (!record?.every) return { ok: false, code: CODE.NOT_RECURRING };
  if (isTerminal(record.status)) return { ok: false, code: CODE.TERMINAL };
  if (record.status !== 'pending' && record.status !== 'waiting') return { ok: false, code: CODE.BAD_MOVE };
  const dueAt = nextOccurrence(record, now, timezone);
  if (!Number.isFinite(dueAt)) return { ok: false, code: CODE.NO_NEXT };
  const leavingWait = record.status === 'waiting';
  let next = {
    ...record,
    status: 'pending',
    dueAt,
    updatedAt: now,
    awaitingTaskId: null,
    waitDeadline: null,
    waitRequested: null,
    ...(leavingWait ? { lastTaskId: record.awaitingTaskId ?? null } : {}),
    ...(keepWaitEnd ? {} : { note: null, outcome: null }),
  };
  const broken = checkInvariants(next);
  if (broken) return { ok: false, code: broken };
  next = withHistory(next, { at: now, from: record.status, to: 'pending', by, ...(code ? { code } : {}) });
  return { ok: true, intention: next, changed: true };
}

/**
 * One `waiting` record reconciled against the task store (`taskOf(id)`: the task, or null when
 * the store has none): the task gone -> `pending` with note `task-missing`; the task ended ->
 * as `arrive`; the wait deadline passed -> `pending` with note `wait-deadline`; else unchanged.
 */
export function reconcileWait(record, { taskOf, now }) {
  if (record?.status !== 'waiting') return { ok: true, intention: record, changed: false };
  const task = typeof taskOf === 'function' ? taskOf(record.awaitingTaskId) : null;
  if (!task) return transition(record, 'pending', { now, by: 'engine', code: CODE.TASK_MISSING, patch: { note: 'task-missing' } });
  if (TASK_ENDS.includes(task.state)) return arrive(record, task, { now });
  if (now >= record.waitDeadline) return transition(record, 'pending', { now, by: 'engine', code: CODE.WAIT_DEADLINE, patch: { note: 'wait-deadline' } });
  return { ok: true, intention: record, changed: false };
}

/**
 * What is due at `now`, for the scheduler of step 2 (listing, not choosing): every `pending` or
 * `waiting` record whose `dueAt` is at or before `now` (`reason: 'due'`), and every `waiting` one
 * past its `waitDeadline` (`reason: 'wait-deadline'`), the earliest moment first. A proposed
 * candidate is never due: it wakes nobody.
 * @param {object[]} records
 * @param {number} now
 * @returns {{ intention: object, reason: 'due'|'wait-deadline', at: number }[]}
 */
export function dueList(records, now, jitterMinutes = 0) {
  const out = [];
  for (const record of Array.isArray(records) ? records : []) {
    if (record?.status !== 'pending' && record?.status !== 'waiting') continue;
    if (record.status === 'waiting' && Number.isFinite(record.waitDeadline) && record.waitDeadline <= now) out.push({ intention: record, reason: 'wait-deadline', at: record.waitDeadline });
    else if (Number.isFinite(record.dueAt) && wakeTimeOf(record, jitterMinutes) <= now) out.push({ intention: record, reason: 'due', at: record.dueAt });
  }
  return out.sort((a, b) => a.at - b.at);
}

/** Lower-cased, whitespace folded: how two texts are compared. */
export function foldText(text) {
  return oneLine(String(text ?? '')).toLowerCase();
}

/**
 * Whether candidate `candidate` (`{ purpose, messageId, span }`) repeats one of `records`' open
 * intentions: the same message and span, or the same purpose (folded).
 */
export function duplicates(candidate, records) {
  const purpose = foldText(candidate?.purpose);
  const span = foldText(candidate?.span);
  return (Array.isArray(records) ? records : []).some((record) => {
    if (!isOpen(record?.status)) return false;
    if (purpose && foldText(record.purpose) === purpose) return true;
    return Boolean(candidate?.messageId) && record.provenance?.messageId === candidate.messageId && span && foldText(record.provenance?.span) === span;
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
 * (src/intentions/sources.js#externalOrigin over the line and its note, `sourcesOf(line)`, the
 * line's own `sources` by default; `strict`: a line of hers with no note counts as external):
 * `external` with its `originReason`, else `own`; and the turn that wrote the line (`turnId`), and
 * whether it was an inner turn of which chain (`bornInner`, `innerChainId`). Never throws.
 * @param {unknown} raw
 * @param {object[]} messages
 * @param {{ max: number, sourcesOf?: ((line: object) => object|null)|null, strict?: boolean }} options
 * @returns {{ candidates: { purpose: string, span: string, messageId: string, channelId: string|null, ts: number|null, participants?: string[],
 *   origin: 'own'|'external', originReason?: string, turnId: string|null, bornInner?: true, innerChainId?: string }[],
 *   dropped: { invalid: number, unanchored: number, quoted: number, over: number } }}
 */
export function candidatesFromAnswer(raw, messages, { max, sourcesOf = null, strict = false }) {
  const dropped = { invalid: 0, unanchored: 0, quoted: 0, over: 0 };
  const candidates = [];
  const list = Array.isArray(raw) ? raw : [];
  const lines = Array.isArray(messages) ? messages.filter((m) => m && typeof m.content === 'string') : [];
  const hers = lines.filter((m) => m.self === true);
  const others = lines.filter((m) => m.self !== true);
  // The members of a line's conversation: the other authors of its channel in the batch.
  const membersOf = (own) => participantIds(others.filter((m) => String(m.channelId ?? '') === String(own.channelId ?? '') && m.authorId !== undefined && m.authorId !== null).map((m) => String(m.authorId)));
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
    let sources = null;
    try {
      sources = (typeof sourcesOf === 'function' ? sourcesOf(own) : null) ?? own.sources ?? null;
    } catch {
      sources = null;
    }
    const reason = externalOrigin({ span, purpose }, own, sources, { strict });
    const turnId = idOrNull(sources?.turnId) ?? idOrNull(own.inner?.turnId);
    candidates.push({
      purpose,
      span,
      messageId: String(own.id),
      channelId: own.channelId ? String(own.channelId) : null,
      ts: Number.isFinite(own.ts) ? own.ts : null,
      ...(participants.length > 0 ? { participants } : {}),
      origin: reason ? 'external' : 'own',
      ...(reason ? { originReason: reason } : {}),
      turnId,
      ...(sources?.inner === true || own.inner ? { bornInner: true, ...(idOrNull(sources?.chainId) ? { innerChainId: idOrNull(sources.chainId) } : {}) } : {}),
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
 * @param {object} record
 * @param {{ userId: string, names?: string[] }} member
 * @returns {boolean}
 */
export function concernsMember(record, { userId, names = [] }) {
  const id = String(userId ?? '');
  if (!id || !record) return false;
  if (record.destination === id) return true;
  if (Array.isArray(record.attend?.people) && record.attend.people.includes(id)) return true;
  const provenance = record.provenance ?? {};
  if (Array.isArray(provenance.participants) && provenance.participants.includes(id)) return true;
  const texts = [record.purpose, provenance.span, record.completionCondition, record.chainId, record.reason, record.outcome?.error].filter((text) => typeof text === 'string' && text);
  if (texts.some((text) => text.includes(id))) return true;
  const folded = [...new Set((Array.isArray(names) ? names : []).filter((name) => typeof name === 'string').map(foldName))].filter(
    (name) => [...name].filter((ch) => isWordChar(ch) && ch !== '_').length >= MIN_FORGET_NAME,
  );
  if (folded.length === 0) return false;
  return texts.some((text) => {
    const haystack = foldName(text);
    return folded.some((name) => occursAsWholeWord(haystack, name));
  });
}
