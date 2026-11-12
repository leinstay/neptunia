// What she made today at a person's asking and what that person wrote to her, for `<my_day>` (src/turn/request/my-day.ts).
// A thing made is a call of hers that reached `succeeded`, of a skill the caller names a kind for: the `day` rows of
// `what = 'action'` hold one line per phase of a call, the lines of one call share `extra.opId`, and only the line that
// started it carries `extra.input.skill`. The person a call was made for is the author of the message that started its
// turn: the turn's `what = 'turn.start'` row holds `extra.trigger.authorId`, an account's native id on the interface of
// the turn's place. A call of an inner turn, of a turn with no start row and of no turn is her own accord. A call counts
// for the day it was made, by the turn's timezone, and the week holds today and the six days before it. What a person addressed
// to her is the number of turns of today that a line of theirs started, each turn once whatever its attempts. Every row is read
// under the turn's context through `whereFor`, as `myDayOf` reads her day, so a group turn counts nothing made in a
// direct chat.

import { zonedDay, zonedEpoch } from '../../time.ts';
import { survivorOf } from './ids.ts';
import { whereFor } from './scope.ts';
import type { Context } from './scope.ts';
import type { Db } from './types.ts';

/** What she made for one person and how many lines of theirs were addressed to her, the counts keyed by skill name. */
export type PersonCount = {
  person: string;
  today: Record<string, number>;
  week: Record<string, number>;
  addressedToday: number;
};

/** The day in numbers: the person she answers, the other people who asked today, and the two sums of her day. */
export type MadeAndGiven = {
  answering: PersonCount | null;
  others: Array<PersonCount>;
  own: number;
  forOthers: number;
};

/** What the reader is asked: the clock, the person she answers, the skills that count and how many others to name. */
export type MadeAndGivenInput = {
  now: number;
  timezone: string;
  answering: string | null;
  kinds: ReadonlyArray<string>;
  people: number;
};

const DAY_MS = 24 * 60 * 60 * 1000;

const nothing = (): MadeAndGiven => ({ answering: null, others: [], own: 0, forOthers: 0 });

const textOf = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

/** A row's `extra` as an object, {} when it is not one. */
function extraOf(text: unknown): Record<string, unknown> {
  if (typeof text !== 'string') return {};
  try {
    const value: unknown = JSON.parse(text);
    return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const objectOf = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

/** A call that succeeded: when it closed, the skill it called and the turn that made it. */
type Made = { at: number; skill: string; turn: string | null };

/** The calls of the rows that reached `succeeded`, once each, of a skill in `kinds`. */
function madeCalls(rows: ReadonlyArray<Record<string, unknown>>, kinds: ReadonlySet<string>): Array<Made> {
  const skills = new Map<string, string>();
  const closed: Array<{ at: number; opId: string | null; own: string | null; turn: string | null }> = [];
  for (const row of rows) {
    const extra = extraOf(row.extra);
    if (extra.name !== 'skill') continue;
    const opId = textOf(extra.opId);
    const skill = textOf(objectOf(extra.input).skill);
    if (opId && skill) skills.set(opId, skill);
    if (extra.phase !== 'succeeded') continue;
    const at = Date.parse(String(row.at));
    if (Number.isFinite(at)) closed.push({ at, opId, own: skill, turn: textOf(row.turn_id) });
  }
  const made: Array<Made> = [];
  for (const call of closed) {
    const skill = call.own ?? (call.opId ? skills.get(call.opId) : undefined);
    if (skill && kinds.has(skill)) made.push({ at: call.at, skill, turn: call.turn });
  }
  return made;
}

/** One `turn.start` row as the reader needs it: its turn, when it began and the person whose line started it. */
type Start = { turn: string; at: number; person: string };

/**
 * The turn starts between `from` and `to` whose trigger's author is an account of a person, once per turn. A turn that
 * an inner wake started, or whose author no account row holds, is left out. `ctx` narrows the rows to what the turn
 * may read; null reads them all.
 */
function startsOf(db: Db, ctx: Context | null, from: number, to: number): Array<Start> {
  const where = ctx ? whereFor(ctx, 'd') : { sql: '1 = 1', params: [] };
  const rows = db
    .prepare(
      `SELECT d.turn_id, d.at, d.extra, p.iface FROM day d LEFT JOIN places p ON p.id = d.place_id
       WHERE d.what = 'turn.start' AND d.retired_at IS NULL AND d.at >= ? AND d.at <= ? AND ${where.sql}`
    )
    .all(new Date(from).toISOString(), new Date(to).toISOString(), ...where.params);
  const account = db.prepare(
    'SELECT person_id FROM accounts WHERE iface = ? AND native_id = ? AND person_id IS NOT NULL AND retired_at IS NULL ORDER BY generation DESC LIMIT 1'
  );
  const known = new Map<string, string | null>();
  const seen = new Set<string>();
  const starts: Array<Start> = [];
  for (const row of rows) {
    const turn = textOf(row.turn_id);
    const at = Date.parse(String(row.at));
    if (!turn || seen.has(turn) || !Number.isFinite(at)) continue;
    const author = textOf(objectOf(extraOf(row.extra).trigger).authorId);
    const iface = textOf(row.iface);
    if (!author || !iface) continue;
    const key = `${iface}\u0000${author}`;
    if (!known.has(key)) {
      const person = textOf(account.get(iface, author)?.person_id);
      known.set(key, person === null ? null : survivorOf(db, person));
    }
    const person = known.get(key);
    if (!person) continue;
    seen.add(turn);
    starts.push({ turn, at, person });
  }
  return starts;
}

const add = (counts: Record<string, number>, skill: string): void => {
  counts[skill] = (counts[skill] ?? 0) + 1;
};

const sumOf = (counts: Record<string, number>): number => Object.values(counts).reduce((total, n) => total + n, 0);

/** The calls added up: per person who asked, today and over the week, and today's sums of her own and of others'. */
function tally(
  made: ReadonlyArray<Made>,
  asked: ReadonlyMap<string, string>,
  dayStart: number
): { byPerson: Map<string, PersonCount>; own: number; forOthers: number } {
  const byPerson = new Map<string, PersonCount>();
  let own = 0;
  let forOthers = 0;
  for (const call of made) {
    const person = call.turn ? asked.get(call.turn) : undefined;
    const today = call.at >= dayStart;
    if (!person) {
      if (today) own += 1;
      continue;
    }
    const count = byPerson.get(person) ?? { person, today: {}, week: {}, addressedToday: 0 };
    byPerson.set(person, count);
    add(count.week, call.skill);
    if (today) {
      add(count.today, call.skill);
      forOthers += 1;
    }
  }
  return { byPerson, own, forOthers };
}

/**
 * What she made today for the person she answers and for the others who asked, by skill, how many lines each wrote to
 * her, and her whole day in two sums (see the file's head). `others` are the people who had something made today, the
 * most made first, cut to `input.people`; `forOthers` counts the cut ones too. A day with nothing made is the empty
 * value, whatever people wrote.
 */
export function madeAndGivenOf(db: Db, ctx: Context, input: MadeAndGivenInput): MadeAndGiven {
  const kinds = new Set(input.kinds);
  if (kinds.size === 0) return nothing();
  const dayStart = zonedEpoch(zonedDay(input.now, input.timezone), 0, 0, input.timezone);
  if (!Number.isFinite(dayStart)) return nothing();
  // Noon of the day six days back names that day whatever the clocks did in between.
  const weekStart = zonedEpoch(zonedDay(dayStart - 6 * DAY_MS + DAY_MS / 2, input.timezone), 0, 0, input.timezone);
  const from = Number.isFinite(weekStart) ? weekStart : dayStart;
  const where = whereFor(ctx);
  const rows = db
    .prepare(
      `SELECT at, turn_id, extra FROM day
       WHERE what = 'action' AND retired_at IS NULL AND at >= ? AND at <= ? AND ${where.sql}
       ORDER BY at, position`
    )
    .all(new Date(from).toISOString(), new Date(input.now).toISOString(), ...where.params) as Array<
    Record<string, unknown>
  >;
  const made = madeCalls(rows, kinds);
  const turns = new Set(made.flatMap((call) => (call.turn ? [call.turn] : [])));
  // A turn that started before the week's first moment still asked for what it made after it.
  const asked = new Map<string, string>();
  if (turns.size > 0)
    for (const start of startsOf(db, null, from - DAY_MS, input.now))
      if (turns.has(start.turn)) asked.set(start.turn, start.person);
  const { byPerson, own, forOthers } = tally(made, asked, dayStart);
  if (own + forOthers === 0) return nothing();
  const asking = [...byPerson.values()]
    .filter((count) => sumOf(count.today) > 0)
    .sort((a, b) => sumOf(b.today) - sumOf(a.today) || (a.person < b.person ? -1 : 1));
  const answeringPerson = input.answering === null ? null : survivorOf(db, input.answering);
  const answering = asking.find((count) => count.person === answeringPerson) ?? null;
  const cap = Math.max(0, Math.floor(input.people));
  const others = asking.filter((count) => count !== answering).slice(0, cap);
  const shown = answering ? [answering, ...others] : others;
  const started = new Map<string, number>();
  for (const start of startsOf(db, ctx, dayStart, input.now))
    started.set(start.person, (started.get(start.person) ?? 0) + 1);
  for (const count of shown) count.addressedToday = started.get(count.person) ?? 0;
  return { answering, others, own, forOthers };
}

/** What she made for one person in a span and how many of her turns a line of theirs started in it. */
export type SpanCount = { person: string; made: Record<string, number>; started: number };

/**
 * For each of `people` (person ids) with a thing made in the span from `from` to `to` (epoch ms, both included): what
 * she made by skill and how many turns a line of theirs started, in the order of `people`. A call counts for the
 * person whose line started its turn, wherever that turn began. Every row is read under `ctx`.
 */
export function madeInSpanOf(
  db: Db,
  ctx: Context,
  input: { from: number; to: number; people: ReadonlyArray<string>; kinds: ReadonlyArray<string> }
): Array<SpanCount> {
  const kinds = new Set(input.kinds);
  if (kinds.size === 0 || input.people.length === 0 || !(input.from <= input.to)) return [];
  const where = whereFor(ctx);
  const rows = db
    .prepare(
      `SELECT at, turn_id, extra FROM day
       WHERE what = 'action' AND retired_at IS NULL AND at >= ? AND at <= ? AND ${where.sql}
       ORDER BY at, position`
    )
    .all(new Date(input.from).toISOString(), new Date(input.to).toISOString(), ...where.params) as Array<
    Record<string, unknown>
  >;
  const made = madeCalls(rows, kinds);
  const turns = new Set(made.flatMap((call) => (call.turn ? [call.turn] : [])));
  // A turn that started before the span still asked for what it made inside it.
  const asked = new Map<string, string>();
  if (turns.size > 0)
    for (const start of startsOf(db, null, input.from - DAY_MS, input.to))
      if (turns.has(start.turn)) asked.set(start.turn, start.person);
  const byPerson = new Map<string, Record<string, number>>();
  for (const call of made) {
    const person = call.turn ? asked.get(call.turn) : undefined;
    if (!person) continue;
    const counts = byPerson.get(person) ?? {};
    byPerson.set(person, counts);
    add(counts, call.skill);
  }
  const started = new Map<string, number>();
  for (const start of startsOf(db, ctx, input.from, input.to))
    started.set(start.person, (started.get(start.person) ?? 0) + 1);
  const result: Array<SpanCount> = [];
  for (const person of input.people) {
    const counts = byPerson.get(survivorOf(db, person));
    if (counts) result.push({ person, made: counts, started: started.get(survivorOf(db, person)) ?? 0 });
  }
  return result;
}
