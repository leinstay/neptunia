// What she made today at a person's asking and what that person wrote to her, for `<my_day>` (src/turn/request/my-day.ts).
// A thing made is a call of hers that reached `succeeded`, of a skill the caller names a kind for: the `day` rows of
// `what = 'action'` hold one line per phase of a call, the lines of one call share `extra.opId`, and only the line that
// started it carries `extra.input.skill`. The person a call was made for is the author of the message that started its
// turn: the turn's `what = 'turn.start'` row holds `extra.trigger.authorId`, an account's native id on the interface of
// the turn's place. A call of an inner turn, of a turn with no start row and of no turn is her own accord. A call counts
// for the day it was made, by the turn's timezone, and the week holds today and the six days before it. Lines addressed
// to her are a person's live `sources` rows of today that are `direct` or reply to a line of hers. Every row is read
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

/** The person each turn answered, keyed by turn id; a turn that answered nobody or has no start row is absent. */
function askersOf(db: Db, turns: ReadonlySet<string>, from: number, to: number): Map<string, string> {
  const asked = new Map<string, string>();
  if (turns.size === 0) return asked;
  const rows = db
    .prepare(
      `SELECT d.turn_id, d.extra, p.iface FROM day d LEFT JOIN places p ON p.id = d.place_id
       WHERE d.what = 'turn.start' AND d.retired_at IS NULL AND d.at >= ? AND d.at <= ?`
    )
    .all(new Date(from).toISOString(), new Date(to).toISOString());
  const account = db.prepare(
    'SELECT person_id FROM accounts WHERE iface = ? AND native_id = ? AND person_id IS NOT NULL AND retired_at IS NULL ORDER BY generation DESC LIMIT 1'
  );
  const known = new Map<string, string | null>();
  for (const row of rows) {
    const turn = textOf(row.turn_id);
    if (!turn || !turns.has(turn) || asked.has(turn)) continue;
    const author = textOf(objectOf(extraOf(row.extra).trigger).authorId);
    const iface = textOf(row.iface);
    if (!author || !iface) continue;
    const key = `${iface}\u0000${author}`;
    if (!known.has(key)) {
      const person = textOf(account.get(iface, author)?.person_id);
      known.set(key, person === null ? null : survivorOf(db, person));
    }
    const person = known.get(key);
    if (person) asked.set(turn, person);
  }
  return asked;
}

const add = (counts: Record<string, number>, skill: string): void => {
  counts[skill] = (counts[skill] ?? 0) + 1;
};

const sumOf = (counts: Record<string, number>): number => Object.values(counts).reduce((total, n) => total + n, 0);

/**
 * How many lines each person addressed to her between `from` and `to` under `ctx`: live lines of their accounts that
 * are `direct` or reply to a line of hers, a line that is both counted once. Keyed by person.
 */
function addressedOf(
  db: Db,
  ctx: Context,
  people: ReadonlyArray<string>,
  from: number,
  to: number
): Map<string, number> {
  const counts = new Map<string, number>();
  if (people.length === 0) return counts;
  const where = whereFor(ctx, 's');
  const accounts = new Map<string, string>();
  const members = db.prepare(
    `WITH RECURSIVE ids(p) AS (SELECT ? UNION SELECT m.from_person FROM people_merges m JOIN ids ON m.into_person = ids.p)
     SELECT a.id FROM accounts a WHERE a.person_id IN (SELECT p FROM ids)`
  );
  for (const person of people)
    for (const row of members.all(person)) {
      const id = textOf(row.id);
      if (id) accounts.set(id, person);
    }
  if (accounts.size === 0) return counts;
  const ids = [...accounts.keys()];
  const rows = db
    .prepare(
      `SELECT s.author_account AS account, COUNT(DISTINCT COALESCE(s.native_id, s.id)) AS n FROM sources s
       WHERE s.author_account IN (${ids.map(() => '?').join(', ')}) AND s.retired_at IS NULL
         AND s.occurred_at >= ? AND s.occurred_at <= ? AND ${where.sql}
         AND (s.direct = 1 OR EXISTS (
           SELECT 1 FROM source_relations r JOIN sources t ON t.id = r.target_source_id
           WHERE r.source_id = s.id AND r.predicate = 'replies_to' AND t.kind = 'said'))
       GROUP BY s.author_account`
    )
    .all(...ids, new Date(from).toISOString(), new Date(to).toISOString(), ...where.params);
  for (const row of rows) {
    const person = accounts.get(String(row.account));
    if (person) counts.set(person, (counts.get(person) ?? 0) + Number(row.n));
  }
  return counts;
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
  const asked = askersOf(db, turns, from - DAY_MS, input.now);
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
  if (own + forOthers === 0) return nothing();
  const asking = [...byPerson.values()]
    .filter((count) => sumOf(count.today) > 0)
    .sort((a, b) => sumOf(b.today) - sumOf(a.today) || (a.person < b.person ? -1 : 1));
  const answeringPerson = input.answering === null ? null : survivorOf(db, input.answering);
  const answering = asking.find((count) => count.person === answeringPerson) ?? null;
  const cap = Math.max(0, Math.floor(input.people));
  const others = asking.filter((count) => count !== answering).slice(0, cap);
  const shown = answering ? [answering, ...others] : others;
  const addressed = addressedOf(
    db,
    ctx,
    shown.map((count) => count.person),
    dayStart,
    input.now
  );
  for (const count of shown) count.addressedToday = addressed.get(count.person) ?? 0;
  return { answering, others, own, forOthers };
}
