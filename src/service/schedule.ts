// The schedule of a scheduled service, pure, with `now` given: the one string `<name>.schedule` holds (`at 00:00,12:00` or
// `every 6h`), its parsed form, and what is due at a moment. A slot is a moment of the UTC day. `last` is the moment the
// service last fired for, and null means it never did, so nothing is owed yet. At most one run is due however many slots
// passed, and that run is the newest slot. The command table, the service commands (src/service/commands.ts) and each
// mechanic's scheduler read it.

import { DAY_MS, MINUTE_MS } from '../time.ts';

/** The four scheduled mechanics of the `service` family. */
export const SERVICE_NAMES = ['heartbeat', 'selfreflection', 'selfimprovement', 'watcher'] as const;
export type ServiceName = (typeof SERVICE_NAMES)[number];

export type ServiceSchedule = { kind: 'at'; at: ReadonlyArray<string> } | { kind: 'every'; everyMinutes: number };

const CLOCK = /^(?:[01]\d|2[0-3]):[0-5]\d$/;
const AT = /^at (\S+)$/;
const EVERY = /^every ([1-9]\d*)([mh])$/;
const JITTER = /^(\d+)([mh])$/;
const MINUTES_PER_HOUR = 60;
const MINUTES_PER_DAY = 1440;

/** The schedule a setting holds, or null when the text means nothing. */
export function parseSchedule(value: unknown): ServiceSchedule | null {
  if (typeof value !== 'string') return null;
  const times = AT.exec(value)?.[1];
  if (times !== undefined) {
    const slots = times.split(',');
    if (!slots.every((slot) => CLOCK.test(slot)) || new Set(slots).size !== slots.length) return null;
    return { kind: 'at', at: slots.sort() };
  }
  const every = EVERY.exec(value);
  if (every === null) return null;
  const count = Number(every[1]);
  return { kind: 'every', everyMinutes: every[2] === 'h' ? count * MINUTES_PER_HOUR : count };
}

/** The one spelling a setting holds, hours when the interval is whole hours. */
export function formatSchedule(schedule: ServiceSchedule): string {
  if (schedule.kind === 'at') return `at ${schedule.at.join(',')}`;
  const minutes = schedule.everyMinutes;
  return minutes % MINUTES_PER_HOUR === 0 ? `every ${minutes / MINUTES_PER_HOUR}h` : `every ${minutes}m`;
}

/** The schedule of a `--at` or `--every` word, or null when it means nothing. */
export const scheduleOfFlag = (kind: 'at' | 'every', word: unknown): ServiceSchedule | null =>
  typeof word === 'string' ? parseSchedule(`${kind} ${word}`) : null;

/** A jitter written `30m` or `1h` in minutes, zero included; null when it is no duration. */
export function parseJitter(value: unknown): number | null {
  const found = typeof value === 'string' ? JITTER.exec(value) : null;
  if (found === null) return null;
  return found[2] === 'h' ? Number(found[1]) * MINUTES_PER_HOUR : Number(found[1]);
}

/**
 * Why the words of `setup` are refused, or null when they stand, for the table's parse and for a handler reached by
 * another route. Each reason names the flag it refuses.
 */
export function setupRefusal(name: string, args: Readonly<Record<string, unknown>>): string | null {
  const { at, every, jitter } = args;
  if (at !== undefined && every !== undefined) return '--at and --every exclude each other; give one';
  if (at !== undefined && scheduleOfFlag('at', at) === null)
    return `--at takes distinct times written HH:MM of the UTC day, separated by commas, not ${JSON.stringify(at)}`;
  if (every !== undefined && scheduleOfFlag('every', every) === null)
    return `--every takes a positive whole interval such as 6h or 90m, not ${JSON.stringify(every)}`;
  if (jitter === undefined) return null;
  if (name !== 'heartbeat') return `--jitter is for the heartbeat alone, not ${name}`;
  if (at !== undefined) return '--jitter moves an interval, and daily times stay exact';
  return parseJitter(jitter) === null
    ? `--jitter takes a duration such as 30m or 0m, not ${JSON.stringify(jitter)}`
    : null;
}

/** The minutes of the UTC day of each slot, oldest first. */
const slotMinutes = (at: ReadonlyArray<string>): Array<number> =>
  at.map((slot) => Number(slot.slice(0, 2)) * MINUTES_PER_HOUR + Number(slot.slice(3))).sort((a, b) => a - b);

const dayStartOf = (moment: number): number => Math.floor(moment / DAY_MS) * DAY_MS;

/**
 * The moments of `schedule` in the UTC day starting at `dayStart`, oldest first: the daily times, or an interval laid
 * from the start of that day. An interval longer than a day has no slot in some days, so it is laid from the epoch.
 */
export function slotsOfDay(schedule: ServiceSchedule, dayStart: number): Array<number> {
  if (schedule.kind === 'at') return slotMinutes(schedule.at).map((minute) => dayStart + minute * MINUTE_MS);
  const step = schedule.everyMinutes * MINUTE_MS;
  const first = schedule.everyMinutes <= MINUTES_PER_DAY ? dayStart : Math.ceil(dayStart / step) * step;
  const slots: Array<number> = [];
  for (let slot = first; slot < dayStart + DAY_MS; slot += step) slots.push(slot);
  return slots;
}

/** The newest daily slot at or before `moment`, and the first one after it. */
function slotsAround(at: ReadonlyArray<string>, moment: number): { before: number | null; after: number | null } {
  const today = dayStartOf(moment);
  const schedule: ServiceSchedule = { kind: 'at', at };
  const days = [today - DAY_MS, today, today + DAY_MS].flatMap((day) => slotsOfDay(schedule, day));
  return {
    before: days.filter((slot) => slot <= moment).at(-1) ?? null,
    after: days.find((slot) => slot > moment) ?? null,
  };
}

/** What a service owes at `now`: the moment of its one due run, and the first moment after that. */
export function evaluateSchedule(input: {
  schedule: ServiceSchedule;
  enabled: boolean;
  now: number;
  last: number | null;
}): { due: number | null; next: number | null } {
  const { schedule, enabled, now, last } = input;
  if (!enabled) return { due: null, next: null };
  if (schedule.kind === 'at') {
    const { before } = slotsAround(schedule.at, now);
    const due = last !== null && before !== null && before > last ? before : null;
    // A clock set back keeps `last` ahead of now, and the slot already fired is not the next one.
    return { due, next: slotsAround(schedule.at, last === null ? now : Math.max(now, last)).after };
  }
  const step = schedule.everyMinutes * MINUTE_MS;
  if (last === null) return { due: null, next: now + step };
  const passed = Math.max(0, Math.floor((now - last) / step));
  return { due: passed === 0 ? null : last + passed * step, next: last + (passed + 1) * step };
}

/**
 * The next `count` moments of `schedule` after `now`, for an answer to read. `onDayGrid` is the diary, which lays an
 * interval from the start of the UTC day; the other mechanics count an interval from their last run.
 */
export function nextMoments(
  schedule: ServiceSchedule,
  now: number,
  count: number,
  { onDayGrid = false }: { onDayGrid?: boolean } = {}
): Array<number> {
  const moments: Array<number> = [];
  if (onDayGrid) {
    for (let day = dayStartOf(now); moments.length < count; day += DAY_MS)
      moments.push(...slotsOfDay(schedule, day).filter((slot) => slot > now));
    return moments.slice(0, count);
  }
  let from = now;
  while (moments.length < count) {
    const { next } = evaluateSchedule({ schedule, enabled: true, now: from, last: null });
    if (next === null) break;
    moments.push(next);
    from = next;
  }
  return moments;
}
