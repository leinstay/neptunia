// What she did today, for `<my_day>` inside `<inner>`: the journal's `post`, `skill`, `gif` and `react` operations that
// succeeded and the executed actions of her inner turns, from the start of the day `now` falls in by the server zone
// to `now`, read under the turn's context so that a group turn never lists what she did in a direct chat. One line per
// action with its clock and the place by name, newest last, the newest `lines` of them. buildTurnRequest
// (src/turn/phases/request/build.ts) asks for them through the turn runner's `myDay` reader; the heartbeat keeps its own
// reader (src/behavior/heartbeat-view.ts#lifeOf).

import { fill, formatClock } from '../../format.ts';
import { whereFor } from '../../memory/db/scope.ts';
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

/** How many lines, and the words to write them in. */
export type MyDayOptions = { lines: number; labels?: MyDayLabels | null };

/** What the turn runner is given to read her day: myDayOf over the open memory, `[]` while it is closed. */
export type MyDayReader = (ctx: unknown, now: number, timezone: string, options: MyDayOptions) => Array<string>;

/** The operations of the journal a line is written for. */
const LISTED_OPS: ReadonlySet<string> = new Set(['post', 'skill', 'gif', 'react']);

/** One action of hers today. */
type Done = { at: number; op: string; skill: string | null; placeId: string | null; turnId: string | null };

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

/** The actions of the rows: each operation that succeeded once, at its closing line, and each executed inner action. */
function actionsOf(rows: ReadonlyArray<Record<string, unknown>>): Array<Done> {
  const skillByOp = new Map<string, string>();
  const ops: Array<Done> = [];
  const inner: Array<Done> = [];
  for (const row of rows) {
    const extra = extraOf(row.extra);
    const at = Date.parse(String(row.at));
    if (!Number.isFinite(at)) continue;
    const turnId = textOf(row.turn_id);
    if (row.what === 'action') {
      const opId = textOf(extra.opId);
      const skill = textOf((extra.input as Record<string, unknown> | undefined)?.skill);
      if (opId && skill) skillByOp.set(opId, skill);
      const op = textOf(extra.name);
      if (extra.phase !== 'succeeded' || !op || !LISTED_OPS.has(op)) continue;
      const named = op === 'skill' && opId ? (skillByOp.get(opId) ?? null) : null;
      ops.push({ at, op, skill: named, placeId: textOf(row.place_id), turnId });
    } else if (row.what === 'inner') {
      for (const entry of Array.isArray(extra.actions) ? (extra.actions as Array<Record<string, unknown>>) : []) {
        if (entry?.status !== 'executed' || entry.result !== 'ok' || typeof entry.skill !== 'string') continue;
        const target = entry.target as Record<string, unknown> | string | null | undefined;
        const channel = target && typeof target === 'object' ? textOf(target.channel) : null;
        inner.push({ at, op: 'skill', skill: entry.skill, placeId: channel, turnId });
      }
    }
  }
  // An inner turn's action that its own operation already lists stays once.
  const key = (one: Done): string => `${one.turnId ?? ''}\u0000${one.skill ?? ''}`;
  const listed = new Set(ops.filter((one) => one.turnId).map(key));
  return [...ops, ...inner.filter((one) => !one.turnId || !listed.has(key(one)))].sort((a, b) => a.at - b.at);
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
  const start = zonedEpoch(zonedDay(now, timezone), 0, 0, timezone);
  const where = whereFor(ctx);
  const rows = journal
    .prepare(
      `SELECT at, what, place_id, turn_id, extra FROM day
       WHERE what IN ('action', 'inner') AND retired_at IS NULL AND at >= ? AND at <= ? AND ${where.sql}
       ORDER BY at, position`
    )
    .all(new Date(start).toISOString(), new Date(now).toISOString(), ...where.params) as Array<Record<string, unknown>>;
  return actionsOf(rows)
    .slice(-cap)
    .map((one) =>
      lineOf(one, one.placeId ? placeNames(one.placeId) : null, formatClock(one.at, timezone, 'en-GB'), options.labels)
    );
}
