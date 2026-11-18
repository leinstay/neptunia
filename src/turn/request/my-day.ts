// Her day for `<inner>`: `<my_day>` with the events of her day and `<calls>` with her calls of today, each headed, in
// the labels' words (`labels.myDay` and `labels.calls`), read from the engine's records with no model request and
// under the turn's context through `whereFor`, so a group turn never reads what she did in a direct chat. A reply turn and a heartbeat read the events of the day `now` falls in by the server zone, a diary request
// those since her last stored entry. A place reads as the caller's namer gives it (the request's own naming of a
// place), a person as the `@handle` the rest of the request uses. buildTurnRequest and plannerRequest
// (src/turn/phases/request/build.ts) ask for both through the turn runner's `day` reader.
//
// The calls are the journal's `post`, `skill`, `gif` and `react` operations that succeeded and the executed actions of
// her inner turns. The place of a call is the chat its `started` line's `target.channel` names when that chat is a
// stored place the context may read, else the place of the turn that made the call.
//
// The events are five kinds. A conversation is her posted lines in one place, cut where she wrote nothing there for
// SILENCE_MS, with the people she answered: the author of the message that started the turn of a line (the turn's
// `turn.start` row, `extra.trigger.authorId`) and the author of the line a line of hers replies to (`reply_to`). A
// thing made is a call of hers that succeeded of a skill in `made`, for the author of the message that started its
// turn, or of her own accord when no member started it. An intention carried out is an ended wake run of the kind
// `intention_due` with each intention its view carried and the places of the lines its turn wrote (src/memory/db/past-acts.ts). Her
// lines of such a run are told by its event and by no conversation. Her own time is an ended wake run of the kind
// `heartbeat` with the places its calls read, the text of its search calls from the archive of requests and the
// intention its end set. A diary entry is a row of `diary`.

import { handleOf } from '../../behavior/handles.ts';
import { fill, formatClock, formatDate } from '../../format.ts';
import { whereFor } from '../../memory/db/scope.ts';
import type { Context } from '../../memory/db/scope.ts';
import type { Db } from '../../memory/db/types.ts';
import { zonedDay, zonedEpoch } from '../../time.ts';
import { bodyOf, currentToolName, skillNameOfApi } from '../../tools/definitions.ts';
import { readDiary } from '../../memory/db/diary-past.ts';
import { survivorOf } from '../../memory/db/ids.ts';
import { accountOfMember, firstChannelOf, mintedAccount, placeOfChannel } from '../../memory/db/native-rows.ts';
import { carriedIntentions, ownOf, sentLinesOf } from '../../memory/db/past-acts.ts';
import { placeVisibleWhere } from '../../memory/db/places-read.ts';

/** A silence of hers this long in one place ends a conversation there. */
const SILENCE_MS = 30 * 60_000;
/** How long before her first line of a window the start row of its turn may lie: the longest turn runs shorter. */
const TURN_REACH_MS = 60 * 60_000;

/** The operations of the journal a call line is written for. */
const LISTED_OPS: ReadonlySet<string> = new Set(['post', 'skill', 'gif', 'react']);

/** One call of hers: when it closed, its operation, its skill and the place it acted in. */
type Call = { at: number; op: string; skill: string | null; placeId: string | null };

/** One event of her day; a person is a person id, or an account id where no person holds the account. */
type DayEvent =
  | { kind: 'conversation'; at: number; end: number; placeId: string; lines: number; people: Array<string> }
  | { kind: 'made'; at: number; skill: string; who: string | null }
  | { kind: 'intention'; at: number; purpose: string; placeIds: Array<string> }
  | { kind: 'heartbeat'; at: number; placeIds: Array<string>; queries: Array<string>; set: string | null }
  | { kind: 'diary'; at: number; entry: string | null };

/** What the reader is asked: the moments, the skills that make a thing and how many events to read at most. */
type DayWindow = {
  /** The first moment of the events. */
  from: number;
  /** The first moment of the calls: the start of the day. */
  callsFrom: number;
  now: number;
  made: ReadonlySet<string>;
  limit: number;
};

/** The calls of the window and its events, oldest first. */
type DayRecords = { calls: Array<Call>; events: Array<DayEvent> };

/** One call as the journal's rows give it, with the turn that made it and the chat it named. */
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
    // A torn `extra`, which the journal's own reader skips as well.
    return {};
  }
}

const textOf = (value: unknown): string | null => (typeof value === 'string' && value ? value : null);

const objectOf = (value: unknown): Record<string, unknown> =>
  value && typeof value === 'object' ? (value as Record<string, unknown>) : {};

/** The chat a `target` object names (`{ channel }`), else null. */
const channelOf = (target: unknown): string | null => textOf(objectOf(target).channel);

/** Where and when a journal row was written, as each call read from it carries it. */
type RowBase = Pick<Done, 'at' | 'placeId' | 'turnId'>;

/** What an operation's lines said before its closing line: the skill it called and the chat the call acted in. */
type OpSeen = { skill: string | null; target: string | null };

/** The call an `action` line closes, once it succeeded; every line of the operation adds what it says to `seen`. */
function opDone(base: RowBase, extra: Record<string, unknown>, seen: Map<string, OpSeen>): Done | null {
  const opId = textOf(extra.opId);
  const known = (opId ? seen.get(opId) : undefined) ?? { skill: null, target: null };
  known.skill = textOf(objectOf(extra.input).skill) ?? known.skill;
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

/** The calls of the rows: each operation that succeeded once, at its closing line, and each executed inner action. */
function callsOfRows(rows: ReadonlyArray<Record<string, unknown>>): Array<Done> {
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

/** Whether `ctx` may read the stored place `id`, over its primary key. */
function visible(db: Db, ctx: Context, id: string): boolean {
  const where = placeVisibleWhere(ctx, 'p');
  return db.prepare(`SELECT p.id FROM places p WHERE p.id = ? AND ${where.sql}`).get(id, ...where.params) !== undefined;
}

/**
 * The place a call names: the stored place of the chat its call acted in when `ctx` may read it (its newest
 * generation under the interface of the turn's place, else its first), else the turn's place.
 */
function placeOf(db: Db, ctx: Context, one: Done): string | null {
  if (!one.target) return one.placeId;
  const home = one.placeId ? db.prepare('SELECT iface FROM places WHERE id = ?').get(one.placeId) : undefined;
  const iface = textOf(home?.iface) ?? ctx.iface ?? null;
  if (!iface) return one.placeId;
  for (const id of [placeOfChannel(db, iface, one.target), firstChannelOf(db, iface, one.target)])
    if (id && visible(db, ctx, id)) return id;
  return one.placeId;
}

/** The person of a member of `iface`: the survivor of its account's person, the account, or the id it would take. */
function memberOf(db: Db, iface: string, native: string): string {
  const account = accountOfMember(db, iface, native);
  if (!account) return mintedAccount(iface, native);
  const person = textOf(db.prepare('SELECT person_id FROM accounts WHERE id = ?').get(account)?.person_id);
  return person ? survivorOf(db, person) : account;
}

/** The member who started each turn of the rows, by turn id; a turn a wake started is absent. */
function startersOf(db: Db, rows: ReadonlyArray<Record<string, unknown>>): Map<string, string> {
  const starters = new Map<string, string>();
  for (const row of rows) {
    const turn = textOf(row.turn_id);
    if (row.what !== 'turn.start' || !turn || starters.has(turn)) continue;
    const author = textOf(objectOf(extraOf(row.extra).trigger).authorId);
    const place = textOf(row.place_id);
    const iface = place ? textOf(db.prepare('SELECT iface FROM places WHERE id = ?').get(place)?.iface) : null;
    if (author && iface) starters.set(turn, memberOf(db, iface, author));
  }
  return starters;
}

/** One line of hers in the window. */
type Line = { placeId: string; at: number; turnId: string | null; replyTo: string | null };

/**
 * Her lines between `from` and `to` that `ctx` may read: every place, then its range of `sources_place_time`.
 */
function linesOf(db: Db, ctx: Context, from: number, to: number): Array<Line> {
  const where = whereFor(ctx, 's');
  return db
    .prepare(
      `SELECT s.place_id, s.occurred_at, s.turn_id, s.reply_to FROM places p CROSS JOIN sources s ON s.place_id = p.id
       WHERE s.occurred_at >= ? AND s.occurred_at <= ? AND s.kind = 'said' AND s.retired_at IS NULL AND ${where.sql}`
    )
    .all(new Date(from).toISOString(), new Date(to).toISOString(), ...where.params)
    .flatMap((row) => {
      const at = Date.parse(String(row.occurred_at));
      const placeId = textOf(row.place_id);
      if (!placeId || !Number.isFinite(at)) return [];
      return [{ placeId, at, turnId: textOf(row.turn_id), replyTo: textOf(row.reply_to) }];
    })
    .sort((a, b) => a.at - b.at);
}

/** The author of the line `native` in `placeId`, over `sources_native`; null for a line no row holds. */
function repliedTo(db: Db, placeId: string, native: string): string | null {
  const row = db
    .prepare(
      `SELECT author_person, author_account FROM sources
       WHERE native_id = ? AND place_id = ? AND kind = 'seen' AND retired_at IS NULL LIMIT 1`
    )
    .get(native, placeId);
  const person = textOf(row?.author_person);
  return person ? survivorOf(db, person) : textOf(row?.author_account);
}

/** Her lines as conversations: by place, cut at each silence of hers longer than SILENCE_MS. */
function conversationsOf(db: Db, lines: ReadonlyArray<Line>, starters: ReadonlyMap<string, string>): Array<DayEvent> {
  const open = new Map<string, Extract<DayEvent, { kind: 'conversation' }>>();
  const out: Array<DayEvent> = [];
  for (const line of lines) {
    let talk = open.get(line.placeId);
    if (!talk || line.at - talk.end > SILENCE_MS) {
      talk = { kind: 'conversation', at: line.at, end: line.at, placeId: line.placeId, lines: 0, people: [] };
      open.set(line.placeId, talk);
      out.push(talk);
    }
    talk.end = line.at;
    talk.lines += 1;
    const starter = line.turnId ? starters.get(line.turnId) : undefined;
    const replied = line.replyTo ? repliedTo(db, line.placeId, line.replyTo) : null;
    for (const who of [starter, replied]) if (who && !talk.people.includes(who)) talk.people.push(who);
  }
  return out;
}

/** The text of the search calls the archive of requests holds for `turnId`, over `model_requests_turn`, each once. */
function queriesOf(db: Db, turnId: string): Array<string> {
  const queries: Array<string> = [];
  for (const row of db
    .prepare('SELECT tool_calls FROM model_requests WHERE turn_id = ? AND tool_calls IS NOT NULL ORDER BY step')
    .all(turnId)) {
    const calls: unknown = JSON.parse(String(row.tool_calls));
    for (const call of Array.isArray(calls) ? calls : []) {
      const skill = skillNameOfApi(objectOf(call).name);
      const body = skill?.endsWith('.search') ? bodyOf(skill) : null;
      const query = body ? textOf(objectOf(objectOf(call).parsed)[body]) : null;
      if (query && !queries.includes(query)) queries.push(query);
    }
  }
  return queries;
}

/**
 * The purpose of the stored intention `id` when `where` lets the turn read it, over the primary key; null for one the
 * store holds no live row of or the turn may not read. A group intention is written with no interface
 * (intentions-write.ts#stringScope), so the scope test passes every row of the scope `group`.
 */
function purposeOf(db: Db, id: string, where: { sql: string; params: Array<string> }): string | null {
  const row = db
    .prepare(
      `SELECT record FROM intentions WHERE id = ? AND retired_at IS NULL AND (scope_kind = 'group' OR ${where.sql})`
    )
    .get(id, ...where.params);
  return row === undefined ? null : (ownOf(row.record)?.purpose ?? null);
}

/** The intention the end of the inner turn `turnId` set, from its `inner` row: its id, else null. */
function setBy(rows: ReadonlyArray<Record<string, unknown>>, turnId: string): string | null {
  for (const row of rows) {
    if (row.what !== 'inner' || row.turn_id !== turnId) continue;
    for (const action of Array.isArray(extraOf(row.extra).actions)
      ? (extraOf(row.extra).actions as Array<unknown>)
      : []) {
      const one = objectOf(action);
      if (one.skill === 'intention.set' && one.status === 'executed' && one.result === 'ok')
        return textOf(one.createdId);
    }
  }
  return null;
}

/** The ended wake runs of `heartbeat` and `intention_due` that started in the window, over `wake_runs_status`. */
function runsOf(db: Db, from: number, to: number): Array<{ id: string; kind: string; at: number; inputs: unknown }> {
  return db
    .prepare(
      `SELECT id, kind, started_at, inputs FROM wake_runs
       WHERE status IN ('succeeded', 'failed', 'interrupted') AND started_at >= ? AND started_at <= ?
         AND kind IN ('heartbeat', 'intention_due')`
    )
    .all(new Date(from).toISOString(), new Date(to).toISOString())
    .map((row) => ({
      id: String(row.id),
      kind: String(row.kind),
      at: Date.parse(String(row.started_at)),
      inputs: row.inputs,
    }));
}

/**
 * Her calls since `window.callsFrom` and her events since `window.from`, both up to `window.now` and oldest first
 * (see the file's head). The events are her newest `window.limit` and how many older ones the window holds.
 */
function dayRecordsOf(db: Db, ctx: Context, window: DayWindow): DayRecords & { dropped: number } {
  const { from, callsFrom, now } = window;
  const where = whereFor(ctx);
  const rows = db
    .prepare(
      `SELECT at, what, place_id, turn_id, extra FROM day
       WHERE what IN ('action', 'inner', 'turn.start') AND retired_at IS NULL AND at >= ? AND at <= ? AND ${where.sql}
       ORDER BY at, position`
    )
    .all(
      new Date(Math.min(from, callsFrom) - TURN_REACH_MS).toISOString(),
      new Date(now).toISOString(),
      ...where.params
    );
  const done = callsOfRows(rows);
  const calls = done
    .filter((one) => one.at >= callsFrom)
    .map((one) => ({ at: one.at, op: one.op, skill: one.skill, placeId: placeOf(db, ctx, one) }));
  const starters = startersOf(db, rows);
  const events: Array<DayEvent> = [];
  const told = new Set<string>();
  for (const run of runsOf(db, from, now)) {
    if (run.kind === 'heartbeat') {
      const places = done.filter((one) => one.turnId === run.id).map((one) => placeOf(db, ctx, one));
      const set = setBy(rows, run.id);
      events.push({
        kind: 'heartbeat',
        at: run.at,
        placeIds: [...new Set(places.filter((id): id is string => id !== null && visible(db, ctx, id)))],
        queries: queriesOf(db, run.id),
        set: set ? purposeOf(db, set, { sql: '1 = 1', params: [] }) : null,
      });
      continue;
    }
    const sent = sentLinesOf(db, run.id, run.at).filter((line) => visible(db, ctx, line.placeId));
    for (const id of carriedIntentions(run.inputs)) {
      const purpose = purposeOf(db, id, where);
      if (purpose === null) continue;
      told.add(run.id);
      events.push({ kind: 'intention', at: run.at, purpose, placeIds: [...new Set(sent.map((line) => line.placeId))] });
    }
  }
  const lines = linesOf(db, ctx, from, now).filter((line) => !line.turnId || !told.has(line.turnId));
  events.push(...conversationsOf(db, lines, starters));
  for (const one of done)
    if (one.at >= from && one.skill && window.made.has(one.skill))
      events.push({
        kind: 'made',
        at: one.at,
        skill: one.skill,
        who: (one.turnId && starters.get(one.turnId)) || null,
      });
  for (const entry of readDiary(db, ctx, window.limit))
    if (entry.at > from && entry.at <= now) events.push({ kind: 'diary', at: entry.at, entry: entry.kind });
  events.sort((a, b) => a.at - b.at);
  const dropped = Math.max(0, events.length - window.limit);
  return { calls, events: events.slice(dropped), dropped };
}

/** The moment of her newest diary entry `ctx` may read, null before her first. */
function lastEntryOf(db: Db, ctx: Context): number | null {
  return readDiary(db, ctx, 1)[0]?.at ?? null;
}

/** The journal as `dayOf` reads it: the memory database's read handle. */
export type JournalReader = Db;

/** The words of one block (`labels.myDay` or `labels.calls` of config/labels.json). */
export type DayLabels = Readonly<Record<string, unknown>>;

/**
 * How many events (`context.myDay.lines`) and calls (`context.calls.lines`) to show, whether the events start at her
 * last diary entry, and the words to write them in.
 */
export type DayOptions = {
  events: number;
  calls: number;
  sinceLastEntry: boolean;
  labels: { myDay?: DayLabels | null; calls?: DayLabels | null; locale?: string };
};

/** The bodies of `<my_day>` and `<calls>`, each its header and its lines, [] for an empty block. */
export type Day = { events: Array<string>; calls: Array<string> };

/** What the turn runner is given to read her day: dayOf over the open memory, empty while it is closed. */
export type DayReader = (ctx: unknown, now: number, timezone: string, options: DayOptions) => Day;

const NO_DAY: Day = { events: [], calls: [] };

const wordOf = (labels: DayLabels | null | undefined, key: string): string => {
  const word = labels?.[key];
  return typeof word === 'string' ? word : '';
};

/** One call as its line: the labels' words when they are set, else the operation's own name. */
function callLine(one: Call, place: string | null, time: string, labels: DayLabels | null | undefined): string {
  const skill = one.skill ? currentToolName(one.skill) : '';
  const word = labels?.[one.op];
  const action = typeof word === 'string' && word ? fill(word, { skill }) : [one.op, skill].filter(Boolean).join(' ');
  const template = place ? labels?.line : labels?.lineNoPlace;
  if (typeof template === 'string' && template) return fill(template, { time, action, place: place ?? '' });
  return [`[${time}]`, action, place].filter(Boolean).join(' ');
}

/** The skills `labels.things` names a thing for: the calls that make something. */
function thingsOf(labels: DayLabels | null | undefined): Record<string, string> {
  const things = labels?.things;
  return things && typeof things === 'object' ? (things as Record<string, string>) : {};
}

/** One event as its line in the labels' words. */
function eventLine(
  event: DayEvent,
  labels: DayLabels,
  clock: (at: number) => string,
  named: (id: string) => string
): string {
  const time = clock(event.at);
  const list = (items: ReadonlyArray<string>): string => items.join(wordOf(labels, 'join'));
  switch (event.kind) {
    case 'conversation': {
      const shown = event.people.slice(0, 3).map((who) => `@${handleOf(who)}`);
      const more = event.people.length - shown.length;
      const people = more > 0 ? fill(wordOf(labels, 'peopleMore'), { people: list(shown), more }) : list(shown);
      const values = { time, end: clock(event.end), place: named(event.placeId), lines: event.lines, people };
      return fill(wordOf(labels, people ? 'conversation' : 'conversationAlone'), values);
    }
    case 'made': {
      const thing = thingsOf(labels)[event.skill] ?? event.skill;
      if (event.who === null) return fill(wordOf(labels, 'madeOwn'), { time, thing });
      return fill(wordOf(labels, 'madeFor'), { time, thing, who: `@${handleOf(event.who)}` });
    }
    case 'intention': {
      if (event.placeIds.length === 0) return fill(wordOf(labels, 'intentionSilent'), { time, purpose: event.purpose });
      return fill(wordOf(labels, 'intention'), {
        time,
        purpose: event.purpose,
        places: list(event.placeIds.map(named)),
      });
    }
    case 'heartbeat': {
      const parts = [
        event.placeIds.length > 0
          ? fill(wordOf(labels, 'heartbeatRead'), { places: list(event.placeIds.map(named)) })
          : '',
        event.queries.length > 0
          ? fill(wordOf(labels, 'heartbeatSearched'), {
              queries: list(event.queries.map((query) => fill(wordOf(labels, 'query'), { query }))),
            })
          : '',
        event.set === null
          ? wordOf(labels, 'heartbeatNothing')
          : fill(wordOf(labels, 'heartbeatSet'), { purpose: event.set }),
      ];
      return fill(wordOf(labels, 'heartbeat'), { time, what: parts.filter(Boolean).join(wordOf(labels, 'partsJoin')) });
    }
    case 'diary':
      return event.entry === null
        ? fill(wordOf(labels, 'diaryNoKind'), { time })
        : fill(wordOf(labels, 'diary'), { time, kind: event.entry });
  }
}

/**
 * Her day as the bodies of `<my_day>` and `<calls>` (see the file's head), read under `ctx`. `placeNames(id)` names a
 * memory place the way the request names it, null when unknown. A block whose number is not positive is empty, and so
 * is a block with no line.
 */
export function dayOf(
  journal: JournalReader,
  ctx: unknown,
  placeNames: (id: string) => string | null,
  now: number,
  timezone: string,
  options: DayOptions
): Day {
  const eventCap = Math.max(0, Math.floor(options.events) || 0);
  const callCap = Math.max(0, Math.floor(options.calls) || 0);
  if (eventCap === 0 && callCap === 0) return NO_DAY;
  const context = ctx as Context;
  const { myDay, calls: callWords, locale } = options.labels;
  const dayStart = zonedEpoch(zonedDay(now, timezone), 0, 0, timezone);
  const since = options.sinceLastEntry ? lastEntryOf(journal, context) : null;
  const records = dayRecordsOf(journal, context, {
    from: since ?? dayStart,
    callsFrom: dayStart,
    now,
    made: new Set(Object.keys(thingsOf(myDay))),
    limit: Math.max(eventCap, 1),
  });
  const clock = (at: number): string => formatClock(at, timezone, 'en-GB');
  const date = (at: number): string => formatDate(at, timezone, locale);
  const callLines = records.calls
    .slice(-callCap || records.calls.length)
    .map((one) => callLine(one, one.placeId ? placeNames(one.placeId) : null, clock(one.at), callWords));
  const named = (id: string): string => placeNames(id) ?? wordOf(myDay, 'unnamed');
  const eventLines = eventCap > 0 && myDay ? records.events.map((one) => eventLine(one, myDay, clock, named)) : [];
  const header =
    since === null
      ? fill(wordOf(myDay, 'header'), { date: date(now) })
      : fill(wordOf(myDay, 'headerSince'), { date: date(since), time: clock(since) });
  const dropped = records.dropped > 0 ? fill(wordOf(myDay, 'dropped'), { count: records.dropped }) : '';
  return {
    events: eventLines.length > 0 ? [header, dropped, ...eventLines].filter(Boolean) : [],
    calls:
      callCap > 0 && callLines.length > 0
        ? [fill(wordOf(callWords, 'header'), { date: date(now) }), ...callLines].filter(Boolean)
        : [],
  };
}
