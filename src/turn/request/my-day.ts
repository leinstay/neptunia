// What she did today, for `<my_day>` inside `<inner>`: the journal's `post`, `skill`, `gif` and `react` operations that
// succeeded and the executed actions of her inner turns, from the start of the day `now` falls in by the server zone
// to `now`, read under the turn's context so that a group turn never lists what she did in a direct chat. One line per
// action with its clock and the place by name, newest last, the newest `lines` of them. The place is the one the call
// acted in (its `started` line's `target.channel`) when that chat is a stored place the context may read, else the
// place of the turn that made the call. Above them stand the lines of what she made at people's asking
// (`madeAndGivenLines`, over src/memory/db/made-and-given.ts). buildTurnRequest
// (src/turn/phases/request/build.ts) asks for both through the turn runner's `myDay` reader.

import { handleOf } from '../../behavior/handles.ts';
import { fill, formatClock } from '../../format.ts';
import { madeAndGivenOf } from '../../memory/db/made-and-given.ts';
import type { MadeAndGiven, PersonCount } from '../../memory/db/made-and-given.ts';
import { firstChannelOf, placeOfChannel } from '../../memory/db/native-rows.ts';
import { placeVisibleWhere } from '../../memory/db/places-read.ts';
import { whereFor } from '../../memory/db/scope.ts';
import type { Context } from '../../memory/db/scope.ts';
import type { Db } from '../../memory/db/types.ts';
import { currentToolName } from '../../tools/definitions.ts';
import { zonedDay, zonedEpoch } from '../../time.ts';

/** The journal as `myDayOf` reads it: the memory database's read handle, where the journal's lines are `day` rows. */
export type JournalReader = Db;

/**
 * The words of one line (`labels.myDay` of config/labels.json): `line` with `{time}`, `{action}` and `{place}`,
 * `lineNoPlace` with `{time}` and `{action}`, and the action per operation (`post`, `react`, `gif`, `skill` with
 * `{skill}`).
 */
export type MyDayLabels = Readonly<Record<string, unknown>>;

/**
 * How many lines, the words to write them in, the person she answers (a person id) and how many other people the
 * count of what she made names (`context.myDay.people`, 3 when absent).
 */
export type MyDayOptions = {
  lines: number;
  labels?: MyDayLabels | null;
  answering?: string | null;
  people?: number;
};

/** What the turn runner is given to read her day: myDayOf over the open memory, `[]` while it is closed. */
export type MyDayReader = (ctx: unknown, now: number, timezone: string, options: MyDayOptions) => Array<string>;

/** The operations of the journal a line is written for. */
const LISTED_OPS: ReadonlySet<string> = new Set(['post', 'skill', 'gif', 'react']);

/** One action of hers today. */
type Done = {
  at: number;
  op: string;
  skill: string | null;
  placeId: string | null;
  target: string | null;
  turnId: string | null;
};

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

const textOf = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

/** The chat a `target` object names (`{ channel }`), else null. */
function channelOf(target: unknown): string | null {
  return target && typeof target === 'object' ? textOf((target as Record<string, unknown>).channel) : null;
}

/** Where and when a journal row was written, as each action read from it carries it. */
type RowBase = Pick<Done, 'at' | 'placeId' | 'turnId'>;

/** What an operation's lines said before its closing line: the skill it called and the chat the call acted in. */
type OpSeen = { skill: string | null; target: string | null };

/** The action an `action` line closes, once it succeeded; every line of the operation adds what it says to `seen`. */
function opDone(base: RowBase, extra: Record<string, unknown>, seen: Map<string, OpSeen>): Done | null {
  const opId = textOf(extra.opId);
  const known = (opId ? seen.get(opId) : undefined) ?? { skill: null, target: null };
  known.skill = textOf((extra.input as Record<string, unknown> | undefined)?.skill) ?? known.skill;
  known.target = channelOf(extra.target) ?? known.target;
  if (opId) seen.set(opId, known);
  const op = textOf(extra.name);
  if (extra.phase !== 'succeeded' || !op || !LISTED_OPS.has(op)) return null;
  if (!opId) return { ...base, op, skill: null, target: null };
  return { ...base, op, skill: op === 'skill' ? known.skill : null, target: known.target };
}

/** The executed actions an `inner` line lists. */
function innerDone(base: RowBase, extra: Record<string, unknown>): Array<Done> {
  const done: Array<Done> = [];
  for (const entry of Array.isArray(extra.actions) ? (extra.actions as Array<Record<string, unknown>>) : []) {
    if (entry?.status !== 'executed' || entry.result !== 'ok' || typeof entry.skill !== 'string') continue;
    done.push({ ...base, op: 'skill', skill: entry.skill, target: channelOf(entry.target) });
  }
  return done;
}

/** The actions of the rows: each operation that succeeded once, at its closing line, and each executed inner action. */
function actionsOf(rows: ReadonlyArray<Record<string, unknown>>): Array<Done> {
  const seen = new Map<string, OpSeen>();
  const ops: Array<Done> = [];
  const inner: Array<Done> = [];
  for (const row of rows) {
    const extra = extraOf(row.extra);
    const base = { at: Date.parse(String(row.at)), placeId: textOf(row.place_id), turnId: textOf(row.turn_id) };
    if (!Number.isFinite(base.at)) continue;
    const closed = row.what === 'action' ? opDone(base, extra, seen) : null;
    if (closed) ops.push(closed);
    if (row.what === 'inner') inner.push(...innerDone(base, extra));
  }
  // An inner turn's action that its own operation already lists stays once.
  const key = (one: Done): string => `${one.turnId ?? ''}\u0000${one.skill ?? ''}`;
  const listed = new Set(ops.filter((one) => one.turnId).map(key));
  return [...ops, ...inner.filter((one) => !one.turnId || !listed.has(key(one)))].sort((a, b) => a.at - b.at);
}

/**
 * The place an action names: the stored place of the chat its call acted in when `ctx` may read it (its newest
 * generation under the interface of the turn's place, else its first), else the turn's place.
 */
function placeOf(db: Db, ctx: Context, one: Done): string | null {
  if (!one.target) return one.placeId;
  const home = one.placeId ? db.prepare('SELECT iface FROM places WHERE id = ?').get(one.placeId) : undefined;
  const iface = textOf(home?.iface) ?? ctx.iface ?? null;
  if (!iface) return one.placeId;
  const visible = placeVisibleWhere(ctx, 'p');
  for (const id of [placeOfChannel(db, iface, one.target), firstChannelOf(db, iface, one.target)]) {
    if (!id) continue;
    const row = db.prepare(`SELECT p.id FROM places p WHERE p.id = ? AND ${visible.sql}`).get(id, ...visible.params);
    if (row) return id;
  }
  return one.placeId;
}

/** One action as its line: the labels' words when they are set, else the operation's own name. */
function lineOf(one: Done, place: string | null, time: string, labels: MyDayLabels | null | undefined): string {
  const skill = one.skill ? currentToolName(one.skill) : '';
  const word = labels?.[one.op];
  const action = typeof word === 'string' && word ? fill(word, { skill }) : [one.op, skill].filter(Boolean).join(' ');
  const template = place ? labels?.line : labels?.lineNoPlace;
  if (typeof template === 'string' && template) return fill(template, { time, action, place: place ?? '' });
  return [`[${time}]`, action, place].filter(Boolean).join(' ');
}

/** The kinds `labels.kinds` names a word for, in the order the labels list them. */
function kindsOf(labels: MyDayLabels | null | undefined): Array<[string, string]> {
  const kinds = labels?.kinds;
  if (!kinds || typeof kinds !== 'object') return [];
  return Object.entries(kinds as Record<string, unknown>).flatMap(([skill, word]) =>
    typeof word === 'string' && word ? [[skill, word] as [string, string]] : []
  );
}

const wordOf = (labels: MyDayLabels, key: string): string => (typeof labels[key] === 'string' ? labels[key] : '');

/** `3 pictures, 1 voice line`: the counts per kind in the labels' order, a skill with no word left out. */
function madeText(counts: Record<string, number>, labels: MyDayLabels): string {
  const item = wordOf(labels, 'madeItem');
  return kindsOf(labels)
    .flatMap(([skill, kind]) => {
      const count = counts[skill];
      return count ? [fill(item, { count: String(count), kind })] : [];
    })
    .join(wordOf(labels, 'madeJoin'));
}

const totalOf = (counts: Record<string, number>): number => Object.values(counts).reduce((sum, n) => sum + n, 0);

function personLine(one: PersonCount, labels: MyDayLabels): string {
  return fill(wordOf(labels, 'madeFor'), {
    who: `@${handleOf(one.person)}`,
    made: madeText(one.today, labels),
    lines: String(one.addressedToday),
  });
}

/**
 * What she made today at people's asking, in the labels' words (`labels.myDay`): the line of the person she answers,
 * a line for the last seven days when it holds more than today, a line per other person, and her day last. No lines
 * for a day with nothing made.
 */
export function madeAndGivenLines(value: MadeAndGiven, labels: MyDayLabels | null | undefined): Array<string> {
  if (!labels || (!value.answering && value.others.length === 0 && value.own + value.forOthers === 0)) return [];
  const lines: Array<string> = [];
  const { answering } = value;
  if (answering) {
    lines.push(personLine(answering, labels));
    if (totalOf(answering.week) > totalOf(answering.today))
      lines.push(fill(wordOf(labels, 'madeWeek'), { made: madeText(answering.week, labels) }));
  }
  for (const other of value.others) lines.push(personLine(other, labels));
  lines.push(fill(wordOf(labels, 'madeDay'), { forOthers: String(value.forOthers), own: String(value.own) }));
  return lines;
}

/**
 * Her actions of the day that `now` falls in by `timezone`, as lines (see the file's head), read under `ctx` through
 * `whereFor`. `placeNames(id)` names a memory place, null when unknown (the line then names no place). Empty when
 * `options.lines` is not a positive number.
 */
export function myDayOf(
  journal: JournalReader,
  ctx: unknown,
  placeNames: (id: string) => string | null,
  now: number,
  timezone: string,
  options: MyDayOptions
): Array<string> {
  const cap = Math.floor(options.lines);
  if (!Number.isFinite(cap) || cap <= 0) return [];
  const made = madeAndGivenLines(
    madeAndGivenOf(journal, ctx as Context, {
      now,
      timezone,
      answering: options.answering ?? null,
      kinds: kindsOf(options.labels).map(([skill]) => skill),
      people: options.people ?? 3,
    }),
    options.labels
  );
  const start = zonedEpoch(zonedDay(now, timezone), 0, 0, timezone);
  const where = whereFor(ctx);
  const context = ctx as Context;
  const rows = journal
    .prepare(
      `SELECT at, what, place_id, turn_id, extra FROM day
       WHERE what IN ('action', 'inner') AND retired_at IS NULL AND at >= ? AND at <= ? AND ${where.sql}
       ORDER BY at, position`
    )
    .all(new Date(start).toISOString(), new Date(now).toISOString(), ...where.params) as Array<Record<string, unknown>>;
  const day = actionsOf(rows)
    .slice(-cap)
    .map((one) => {
      const placeId = placeOf(journal, context, one);
      return lineOf(one, placeId ? placeNames(placeId) : null, formatClock(one.at, timezone, 'en-GB'), options.labels);
    });
  return [...made, ...day];
}
