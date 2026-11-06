// The fixture of scripts/inner-week.ts: a week's JSON made whole and checked (`parseFixture`), with the error it throws
// and the checks it shares with the harness in scripts/lib/inner-week.ts, which re-exports them.

import { parseEvery, isAttend, OCCURRENCE_CODES } from '../../src/intentions/model.ts';
import { DAY_MS, HOUR_MS, MINUTE_MS, zonedDay, zonedEpoch } from '../../src/time.ts';
import type { Untyped } from '../../src/tools/types.ts';

/** An object read by key whose values are not typed yet. */
type Rec = Record<string, Untyped>;

/** The most days a fixture may span. */
export const MAX_DAYS = 14;

/** The event kinds a fixture may script. */
export const EVENT_KINDS = Object.freeze([
  'message',
  'flood',
  'self',
  'intend',
  'errand_end',
  'planted',
  'restart',
  'stop',
  'start',
]);

/** `"30s"`, `"10m"`, `"2h"`, `"1d"` as milliseconds; null for anything else. */
export function parseDuration(text: Untyped): number | null {
  const match = /^(\d{1,6})\s*(s|m|h|d)$/i.exec(String(text ?? '').trim());
  if (!match) return null;
  const n = Number(match[1]);
  const unit = match[2].toLowerCase();
  return n * (unit === 's' ? 1000 : unit === 'm' ? MINUTE_MS : unit === 'h' ? HOUR_MS : DAY_MS);
}

/** The calendar date `days` after `date` (`YYYY-MM-DD`). */
export function addDays(date: Untyped, days: Untyped): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + days * DAY_MS).toISOString().slice(0, 10);
}

/**
 * A fixture time as epoch ms: `"<day> HH:MM"` (day 1 is the fixture's `start`, in its timezone;
 * day 0 and negative days lie before the week) or an ISO date-time. Null for anything else.
 */
export function fixtureTime(text: Untyped, { start, timezone }: Rec): number | null {
  const value = String(text ?? '').trim();
  const match = /^(-?\d{1,3})\s+(\d{1,2}):(\d{2})$/.exec(value);
  if (match) {
    const hour = Number(match[2]);
    const minute = Number(match[3]);
    if (hour > 23 || minute > 59) return null;
    const at = zonedEpoch(addDays(start, Number(match[1]) - 1), hour, minute, timezone);
    return Number.isFinite(at) ? at : null;
  }
  if (/^\d{4}-\d{2}-\d{2}T/.test(value)) {
    const at = Date.parse(value);
    return Number.isFinite(at) ? at : null;
  }
  return null;
}

// ---- the fixture --------------------------------------------------------------------

/** A fixture error: names the fixture and the field. */
export class FixtureError extends Error {}

export function need(condition: unknown, name: string, message: string): asserts condition {
  if (!condition) throw new FixtureError(`inner-week: fixture ${name}: ${message}`);
}

export const isObject = (value: Untyped): boolean => value && typeof value === 'object' && !Array.isArray(value);

/** The wake kinds a stub plan may answer. */
export const STUB_KINDS = Object.freeze(['intention_due', 'errand_deadline', 'review', 'attend', 'feedback']);

/** A stub plan (`[[action, ...], ...]`): every action `{ skill, args?, refuse? }` (`refuse`: the code the runner refuses it with). */
export function checkPlan(plan: Untyped, name: string, where: string): Array<Untyped> {
  need(
    Array.isArray(plan) && plan.every((answer) => Array.isArray(answer)),
    name,
    `${where} must be a list of answers (each a list of actions)`
  );
  for (const answer of plan) {
    for (const action of answer) {
      need(
        isObject(action) && typeof action.skill === 'string' && action.skill,
        name,
        `${where}: every action needs a skill`
      );
      need(
        action.refuse === undefined || (typeof action.refuse === 'string' && action.refuse),
        name,
        `${where}: \`refuse\` must be a code`
      );
      need(
        action.returns === undefined || (typeof action.returns === 'string' && action.returns),
        name,
        `${where}: \`returns\` must be a text (what the read returns)`
      );
      need(
        action.marker === undefined ||
          (typeof action.returns === 'string' && typeof action.marker === 'string' && action.marker.length >= 4),
        name,
        `${where}: a \`marker\` (4+ characters) goes with \`returns\``
      );
    }
  }
  return plan;
}

export function checkStub(stub: Untyped, name: string, where: string): Rec {
  const out: Untyped = {};
  if (stub === undefined) return out;
  need(isObject(stub), name, `${where} must be an object`);
  for (const kind of STUB_KINDS)
    if (stub[kind] !== undefined) out[kind] = checkPlan(stub[kind], name, `${where}.${kind}`);
  return out;
}

export type FixtureChannel = { id: string; name: string; writable: boolean };
export type FixtureTask = { id: string; agent: string; state: 'queued' | 'running' };

/** One scripted event of the week; the fields past the three every event has depend on its `kind`. */
export type FixtureEvent = { kind: string; at: number; order: number; [field: string]: Untyped };

/** What a fixture promises the week will show (the gates of scripts/inner-week.ts check each). */
export type FixtureExpect = {
  silent: boolean;
  maxPosts: number;
  turns: Rec | null;
  capped: Array<string>;
  journal: Rec;
  kept: number | null;
  planted: number | null;
  occurrences: Rec | null;
  feedback: { wakes: number | null; facts: Array<string>; code: string | null; intention: string | null } | null;
  attention: {
    turns: Array<{ day: number; lines: number }> | null;
    capped: number | null;
    listenOnly: string | null;
  } | null;
};

/** A fixture made whole: what `parseFixture` returns and the week runs over. */
export type Fixture = {
  name: string;
  description: string;
  seed: number;
  start: string;
  days: number;
  timezone: string;
  startMs: number;
  endMs: number;
  placeId: string;
  mode: 'shadow' | 'live';
  turnSeconds: number;
  wakes: Rec;
  agents: Rec;
  intentionsConfig: Rec;
  channels: Array<FixtureChannel>;
  people: Rec;
  tasks: Array<FixtureTask>;
  history: { selfHours: Array<number>; channel: string; days: number };
  stub: { usdPerRequest: number; [kind: string]: Untyped };
  events: Array<FixtureEvent>;
  expect: FixtureExpect;
  /** The intentions by key, set once the week runs. */
  intentionsByKey?: Map<Untyped, Untyped>;
};

/** What `runWeek` returns: the record of one virtual week, which the gates and the report read. */
export type WeekRun = {
  fixture: string;
  mode: string;
  placeId: string;
  startMs: number;
  endMs: number;
  settings: Rec;
  turns: Array<Rec>;
  journal: Array<Rec>;
  errandCosts: Array<Rec>;
  ticks: { count: number; listed: number; submitted: number };
  steps: number;
  dueSeen: Array<Rec>;
  state: Rec;
  intentions: Array<Rec>;
  keys: Rec;
  chat: Record<string, Array<Rec>>;
  planted: Array<{ marker: string; [field: string]: Untyped }>;
  stopSpans: Array<{ from: number; to: number | null }>;
  stoppedAtEnd: boolean;
  timezone: string;
};

const attentionTurnOf = (t: Rec) => ({ day: Number(t?.day), lines: Number(t?.lines) });

/**
 * A fixture made whole and checked: times resolved against `start` in `timezone`, floods expanded
 * into messages, events sorted by time (the file's order kept for equal times). Throws a
 * FixtureError naming what is wrong.
 * @param raw The parsed JSON, or its text.
 */
export function parseFixture(raw: Rec | string, { name = 'fixture' }: { name?: string } = {}): Fixture {
  let data: Untyped = raw;
  if (typeof raw === 'string') {
    try {
      data = JSON.parse(raw);
    } catch (err: Untyped) {
      throw new FixtureError(`inner-week: fixture ${name}: not JSON (${err.message})`);
    }
  }
  need(isObject(data), name, 'must be an object');
  const id: string = typeof data.name === 'string' && data.name ? data.name : name;
  need(
    typeof data.start === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(data.start),
    id,
    '`start` must be a date YYYY-MM-DD'
  );
  const days = data.days ?? 7;
  need(Number.isInteger(days) && days >= 1 && days <= MAX_DAYS, id, `\`days\` must be 1..${MAX_DAYS}`);
  const timezone = typeof data.timezone === 'string' && data.timezone ? data.timezone : 'UTC';
  need(Number.isFinite(zonedEpoch(data.start, 0, 0, timezone)), id, `unknown timezone ${timezone}`);
  const ctx = { start: data.start, timezone };
  const startMs = zonedEpoch(data.start, 0, 0, timezone);
  const endMs = zonedEpoch(addDays(data.start, days), 0, 0, timezone);
  const time = (value: Untyped, where: string) => {
    const at = fixtureTime(value, ctx);
    need(at !== null, id, `${where}: bad time ${JSON.stringify(value)} (use "<day> HH:MM")`);
    return at;
  };

  need(Array.isArray(data.channels) && data.channels.length > 0, id, '`channels` must list at least one channel');
  const channels = data.channels.map((channel: Rec, i: number) => {
    need(isObject(channel) && typeof channel.id === 'string' && channel.id, id, `channels[${i}] needs an id`);
    return {
      id: channel.id,
      name: typeof channel.name === 'string' ? channel.name : channel.id,
      writable: channel.writable !== false,
    };
  });
  const placeIds = new Set(channels.map((channel: Rec) => channel.id));
  const channel = (value: Untyped, where: string) => {
    need(placeIds.has(value), id, `${where}: unknown channel ${JSON.stringify(value)}`);
    return value;
  };

  const people = isObject(data.people) ? data.people : {};
  const intentionOf = (item: Untyped, where: string) => {
    need(isObject(item) && typeof item.purpose === 'string' && item.purpose.trim(), id, `${where} needs a purpose`);
    need(typeof item.key === 'string' && item.key, id, `${where} needs a key`);
    const out: Untyped = {
      key: item.key,
      purpose: item.purpose,
      channel: channel(item.channel ?? channels[0].id, `${where}.channel`),
      dueAt: item.due === undefined || item.due === null ? null : time(item.due, `${where}.due`),
      expiresAt: item.expires === undefined || item.expires === null ? null : time(item.expires, `${where}.expires`),
      chain: typeof item.chain === 'string' ? item.chain : null,
      condition: typeof item.condition === 'string' ? item.condition : null,
      stub: checkStub(item.stub, id, `${where}.stub`),
      // When she made it (default: the week's start) and the exact text of her scripted line that
      // made it (its id and text become the record's provenance, as her memory of the week has them).
      at: item.at === undefined || item.at === null ? null : time(item.at, `${where}.at`),
      span: typeof item.span === 'string' && item.span ? item.span : null,
      // A recurrence, as her own `every=` argument (src/intentions/model.ts#parseEvery).
      every: null,
      // An attention: she listens to `channel` (the people by their fixture names, the settle seconds, her per-day bound).
      attend: null,
    };
    if (item.every !== undefined && item.every !== null) {
      const parsed = parseEvery(item.every);
      need(parsed.ok && parsed.every !== null, id, `${where}.every: day, week, <n>h or <n>d`);
      need(out.dueAt !== null, id, `${where}.every needs a due time`);
      out.every = parsed.every;
    }
    if (item.attend === true) {
      need(out.dueAt === null && out.every === null, id, `${where}.attend: an attention has no due time and no every`);
      const names = item.people === undefined ? [] : item.people;
      need(
        Array.isArray(names) && names.every((n) => typeof n === 'string' && people[n]),
        id,
        `${where}.people must name fixture people`
      );
      need(
        item.settle === undefined || (Number.isFinite(item.settle) && item.settle >= 0),
        id,
        `${where}.settle must be seconds >= 0`
      );
      need(
        item.perDay === undefined || (Number.isInteger(item.perDay) && item.perDay >= 1),
        id,
        `${where}.perDay must be a whole number >= 1`
      );
      out.attend = {
        place: out.channel,
        people: names.map((n: number) => people[n]),
        ...(item.settle !== undefined ? { settle: item.settle } : {}),
        ...(item.perDay !== undefined ? { perDay: item.perDay } : {}),
      };
    }
    need(out.at === null || (out.at >= startMs && out.at < endMs), id, `${where}.at: outside the week`);
    if (item.wait !== undefined) {
      need(isObject(item.wait) && typeof item.wait.task === 'string', id, `${where}.wait needs a task`);
      out.wait = { task: item.wait.task, deadline: time(item.wait.deadline, `${where}.wait.deadline`) };
    }
    return out;
  };

  const events: Array<Untyped> = [];
  const intentions = (Array.isArray(data.intentions) ? data.intentions : []).map((item: Untyped, i: number) =>
    intentionOf(item, `intentions[${i}]`)
  );
  for (const item of intentions) events.push({ kind: 'intend', at: item.at ?? startMs, intention: item, order: -1 });
  const tasks = (Array.isArray(data.tasks) ? data.tasks : []).map((task: Rec, i: number) => {
    need(isObject(task) && typeof task.id === 'string' && task.id, id, `tasks[${i}] needs an id`);
    return {
      id: task.id,
      agent: typeof task.agent === 'string' ? task.agent : 'scout',
      state: task.state === 'queued' ? 'queued' : 'running',
    };
  });

  (Array.isArray(data.events) ? data.events : []).forEach((event: Untyped, i: number) => {
    const where = `events[${i}]`;
    need(
      isObject(event) && EVENT_KINDS.includes(event.kind),
      id,
      `${where}: kind must be one of ${EVENT_KINDS.join(', ')}`
    );
    const at = time(event.at, `${where}.at`);
    need(at >= startMs && at < endMs, id, `${where}: outside the week`);
    const base = { kind: event.kind, at, order: i };
    if (event.kind === 'message' || event.kind === 'planted') {
      need(typeof event.text === 'string' && event.text, id, `${where} needs a text`);
      need(typeof event.author === 'string' && event.author, id, `${where} needs an author`);
      if (event.kind === 'planted')
        need(
          typeof event.marker === 'string' && event.marker.length >= 4,
          id,
          `${where} needs a marker (4+ characters) that only the planted text carries`
        );
      events.push({
        ...base,
        channel: channel(event.channel ?? channels[0].id, `${where}.channel`),
        author: event.author,
        text: event.text,
        addressed: event.addressed === true,
        ...(event.kind === 'planted' ? { marker: event.marker } : {}),
      });
    } else if (event.kind === 'flood') {
      const every = parseDuration(event.every ?? '30s');
      need(
        Number.isInteger(event.count) && event.count >= 1 && event.count <= 5000,
        id,
        `${where}.count must be 1..5000`
      );
      need(every !== null && every > 0, id, `${where}.every must be a duration`);
      const authors =
        Array.isArray(event.authors) && event.authors.length > 0 ? event.authors.map(String) : ['someone'];
      const ch = channel(event.channel ?? channels[0].id, `${where}.channel`);
      for (let n = 0; n < event.count; n += 1) {
        const when = at + n * every;
        if (when >= endMs) break;
        events.push({
          kind: 'message',
          at: when,
          order: i + n / (event.count + 1),
          channel: ch,
          author: authors[n % authors.length],
          text: `${event.text ?? 'flood line'} ${n + 1}`,
          addressed: event.addressed !== false,
        });
      }
    } else if (event.kind === 'self') {
      need(typeof event.text === 'string' && event.text, id, `${where} needs a text`);
      // What her ordinary turn read (`read`: a skill's result, a page) or saw from outside (`seen`:
      // someone's message she answered, retrieved memory) before the line went out.
      const outside = (list: Untyped, key: string) =>
        (list === undefined ? [] : list).map((item: Rec, n: number) => {
          need(isObject(item) && typeof item.text === 'string' && item.text, id, `${where}.${key}[${n}] needs a text`);
          need(
            item.marker === undefined || (typeof item.marker === 'string' && item.marker.length >= 4),
            id,
            `${where}.${key}[${n}].marker needs 4+ characters`
          );
          return {
            skill: typeof item.skill === 'string' ? item.skill : null,
            text: item.text,
            ...(item.marker ? { marker: item.marker } : {}),
          };
        });
      need(event.read === undefined || Array.isArray(event.read), id, `${where}.read must be a list`);
      need(event.seen === undefined || Array.isArray(event.seen), id, `${where}.seen must be a list`);
      events.push({
        ...base,
        channel: channel(event.channel ?? channels[0].id, `${where}.channel`),
        text: event.text,
        read: outside(event.read, 'read'),
        seen: outside(event.seen, 'seen'),
      });
    } else if (event.kind === 'intend') {
      events.push({ ...base, intention: intentionOf(event, where) });
    } else if (event.kind === 'errand_end') {
      need(typeof event.task === 'string' && event.task, id, `${where} needs a task`);
      need(
        ['done', 'failed', 'cancelled'].includes(event.state ?? 'done'),
        id,
        `${where}.state must be done, failed or cancelled`
      );
      events.push({
        ...base,
        task: event.task,
        state: event.state ?? 'done',
        usd: Number.isFinite(event.usd) ? event.usd : 0,
      });
    } else {
      events.push({ ...base, by: typeof event.by === 'string' ? event.by : 'owner' });
    }
  });
  events.sort((a, b) => a.at - b.at || a.order - b.order);
  // An intention's span is a line of hers, scripted (in any channel: its destination may be
  // another one) before it is born.
  for (const event of events) {
    if (event.kind !== 'intend' || !event.intention.span) continue;
    const { key, span } = event.intention;
    need(
      events.some((e) => e.kind === 'self' && e.text === span && e.at < event.at),
      id,
      `intention ${key}: span is not a self line of hers scripted before it is born`
    );
  }

  const history = isObject(data.history) ? data.history : {};
  const selfHours = Array.isArray(history.selfHours)
    ? history.selfHours.filter((h: Untyped) => Number.isInteger(h) && h >= 0 && h <= 23)
    : [];
  const historyChannel = channel(history.channel ?? channels[0].id, 'history.channel');

  const stub = isObject(data.stub) ? data.stub : {};
  const { feedback: wantFeedback, attention: wantAttention, ...expect } = isObject(data.expect) ? data.expect : {};
  return {
    name: id,
    description: typeof data.description === 'string' ? data.description : '',
    seed: Number.isFinite(data.seed) ? data.seed : 1,
    start: data.start,
    days,
    timezone,
    startMs,
    endMs,
    placeId: typeof data.placeId === 'string' && data.placeId ? data.placeId : 'g-week',
    mode: data.mode === 'shadow' ? 'shadow' : 'live',
    turnSeconds: Number.isFinite(data.turnSeconds) && data.turnSeconds >= 0 ? data.turnSeconds : 20,
    wakes: isObject(data.wakes) ? data.wakes : {},
    agents: isObject(data.agents) ? data.agents : {},
    intentionsConfig: isObject(data.intentionsConfig) ? data.intentionsConfig : {},
    channels,
    people,
    tasks,
    history: {
      selfHours,
      channel: historyChannel,
      days: Number.isInteger(history.days) && history.days > 0 ? history.days : 14,
    },
    stub: {
      ...checkStub(Object.fromEntries(STUB_KINDS.map((kind) => [kind, stub[kind]])), id, 'stub'),
      usdPerRequest: Number.isFinite(stub.usdPerRequest) && stub.usdPerRequest >= 0 ? stub.usdPerRequest : 0.03,
    },
    events,
    expect: {
      silent: expect.silent === true,
      maxPosts: Number.isInteger(expect.maxPosts) ? expect.maxPosts : 0,
      turns: isObject(expect.turns) ? expect.turns : null,
      capped: Array.isArray(expect.capped) ? expect.capped.map(String) : [],
      journal: isObject(expect.journal) ? expect.journal : {},
      kept: Number.isInteger(expect.kept) ? expect.kept : null,
      planted: Number.isInteger(expect.planted) ? expect.planted : null,
      // Occurrence codes of recurring intentions, each an exact count over the week (src/intentions/model.ts#OCCURRENCE_CODES).
      occurrences: isObject(expect.occurrences)
        ? Object.fromEntries(
            Object.entries(expect.occurrences).filter(
              ([code, n]) => OCCURRENCE_CODES.includes(code) && Number.isInteger(n)
            )
          )
        : null,
      // The feedback wakes (the `feedback` gate): how many over the week (`wakes`), the fact kinds
      // they must carry (`facts`), a refusal code a `callFailed` fact must name (`code`), the intention (by key)
      // one must name as closed without delivery (`intention`).
      feedback: isObject(wantFeedback)
        ? {
            wakes: Number.isInteger(wantFeedback.wakes) ? wantFeedback.wakes : null,
            facts: Array.isArray(wantFeedback.facts) ? wantFeedback.facts.map(String) : [],
            code: typeof wantFeedback.code === 'string' ? wantFeedback.code : null,
            intention: typeof wantFeedback.intention === 'string' ? wantFeedback.intention : null,
          }
        : null,
      // Her attention (the `attention` gate): the attend turns in order (`{ day, lines }`), how many
      // attend wakes waited on her per-day bound and ran after the reset, and a listen-only channel
      // the places page must list with lines.
      attention: isObject(wantAttention)
        ? {
            turns: Array.isArray(wantAttention.turns) ? wantAttention.turns.map(attentionTurnOf) : null,
            capped: Number.isInteger(wantAttention.capped) ? wantAttention.capped : null,
            listenOnly:
              typeof wantAttention.listenOnly === 'string'
                ? channel(wantAttention.listenOnly, 'expect.attention.listenOnly')
                : null,
          }
        : null,
    },
  };
}

// ---- the gates ------------------------------------------------------------------------

/** The day of `ms` in `timezone`. */
export const dayKey = (ms: number, timezone: string): string => zonedDay(ms, timezone);

/** The occurrence codes of the week's recurring intentions, counted over their histories (OCCURRENCE_CODES). */
export function occurrences(run: Pick<WeekRun, 'intentions'>): { [k: string]: number } {
  const counts = Object.fromEntries(OCCURRENCE_CODES.map((code) => [code, 0]));
  for (const record of run.intentions)
    for (const entry of record.history ?? []) if (OCCURRENCE_CODES.includes(entry.code)) counts[entry.code] += 1;
  return counts;
}

/** The turn outcomes that mean a turn ran for the wake (src/behavior/turn.ts#TurnOutcome less the held ones). */
export const RAN = new Set(['spoke', 'skip', 'refused', 'not-now', 'error']);

/**
 * Her attention over the week: the attend turns (`{ at, day, lines, channel }`: the lines of the
 * attend items of each turn), the attend wakes listed in a channel no attention of hers covered at
 * that moment (`unattended`), the wakes that waited on her per-day bound (`capped`) and how many
 * of them ran later (`cappedRan`), and the attend wakes after an attention was dropped (`afterDrop`).
 */
export function attention(run: WeekRun): {
  turns: Untyped;
  unattended: Untyped;
  afterDrop: Untyped;
  capped: Untyped;
  cappedRan: Untyped;
} {
  const timezone = run.timezone;
  const dayNumber = (ms: Untyped) =>
    Math.round(
      (Date.parse(`${dayKey(ms, timezone)}T00:00:00Z`) - Date.parse(`${dayKey(run.startMs, timezone)}T00:00:00Z`)) /
        DAY_MS
    ) + 1;
  const turns = run.turns
    .filter((turn: Rec) => (turn.items ?? []).some((item: Rec) => item.kind === 'attend'))
    .map((turn: Rec) => ({
      at: turn.at,
      day: dayNumber(turn.at),
      channel: turn.placeId,
      lines: (turn.items ?? [])
        .filter((item: Rec) => item.kind === 'attend')
        .reduce((sum: number, item: Rec) => sum + (item.attend?.lines ?? 0), 0),
    }));
  const attentions = run.intentions.filter((record: Rec) => isAttend(record));
  const spans = attentions.map((record: Rec) => {
    const end = (record.history ?? []).find((h: Rec) => h.to === 'cancelled' || h.to === 'expired')?.at ?? Infinity;
    return { place: record.attend.place, from: record.createdAt, to: end };
  });
  const covered = (place: Rec, at: Untyped) =>
    spans.some((span: Rec) => span.place === place && at >= span.from && at < span.to);
  const wakes = run.journal.filter((e: Rec) => e.event === 'wake' && e.wake?.kind === 'attend');
  const unattended = wakes.filter((e: Rec) => !covered(e.wake.place, e.at)).map((e: Rec) => e.wake.id);
  const afterDrop = wakes
    .filter((e: Rec) =>
      spans.some((span: Rec) => span.place === e.wake.place && Number.isFinite(span.to) && e.at >= span.to)
    )
    .map((e: Rec) => e.wake.id);
  const capped = run.journal
    .filter((e: Rec) => e.event === 'capped' && e.cap === 'attend-per-day')
    .map((e: Rec) => e.wake.id);
  const handled = run.state.handled ?? {};
  const cappedRan = capped.filter((id: string) => RAN.has(handled[id]?.outcome)).length;
  return { turns, unattended, afterDrop, capped, cappedRan };
}
