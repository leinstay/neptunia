// The persona's journal: one record per thing that happened -- a turn started, a turn
// ended (what it saw, what it thought, what it posted), an action's phase, a memory change, a
// system event -- written to the memory database through the write kind `journal-lines`
// (`memoryDb.writeJournalLines`, src/memory/db/journal-lines.ts) in the unit of its place's day, so it
// keeps its order. The day is the UTC day of the record's `occurredAt`; a private chat has its own
// units under the partner's private directory and is never written to the place's journal. Every record carries the same envelope (`v`, `id`,
// `kind`, `occurredAt`, `recordedAt`, `placeId`, `scope`, `participants`, `sourceMessageIds`,
// `origin`); a record missing a list is written with an empty one, never rejected: a journal
// line lost to validation is worse than an incomplete one. The model's `think` is stored whole,
// never shown back to it.
//
// Every side effect is an operation with its own `opId` (`op`): a `started` line before the
// call, one closing line after it (`succeeded`, `failed` or `unknown`). After a restart the
// operations of the last days left without a closing line are reconciled (`reconcile`): a
// post is looked for among the persona's last own messages of its channel by the message it
// replied to and the first INTENT_CHARS characters of its text; nothing is ever sent again.
//
// A `.running` marker under data/run/journal/<interface>/, written at start and
// removed on a clean stop (`markRunning` / `clearRunning`), lets the next start record an `unclean-stop`.
//
// `withWriterLock(fn)` holds every new line back while `fn` runs, after
// the append stores flushed what they had: the journal's own lines here, and the
// record's and the archive's appends, which wait on `waitUnlocked` (src/memory/record.ts,
// src/memory/archive.ts `writerGate`; the append stores are flushed through `lockStores`). A copy of
// `data/` taken inside it sees no line half-way.
//
// The persona's time away (`offPeriods`, `createOffPeriodsReader`): the owner's pauses and the
// service's stops of the last hours, read from the system records (`timeline`), for her request.
//
// Messages that may have been left without an answer (src/behavior/missed.js) are `answer`
// records (`answer`), scoped to their channel: `event` `fact` (a `reason`, the message's
// `messageId`, `authorId`, `at` and whether it carries a question mark; `replacedBy`, `failure`
// or `turnId` when known), `address` (the address check's "no": `verdict` `not-addressed`,
// `messageId`, `authorId`, `at`), `verdict` (the sweep's `verdict` and `by` -- `model` or `code` --,
// `shadow` for an owed one nothing was posted for), `resolved` (`by`), `expired`, and `recovery`
// (the `messageIds` of one recovery turn, its `triggerId` and `outcome`). Ids only, no text.
//
// Which message started the turn that posted each of her messages (`triggerLinks`,
// `triggerLinksOf`): read once at start, so her transcript lines keep naming their turn's trigger
// across a restart (src/behavior/turn.js). Her skill calls (`callMarks`, `callMarksOf`) are read
// the same way, so her lines keep showing what she called and how it went. Her lookups (`lookupsOfRecords`, with the
// identities of the lines each `#n` named) and what each turn raised for the graph reader (`seedsOfRecords`) are read
// at start too, so `<recall>` and `<memory>` are the same after a restart as before it.
//
// Which turn posted one of her messages (`findTurn`, `turnOfMessage`, shown by `turnView`): for
// `/nep memory journal message:`, the turn record whole, its think included.
//
// Logs carry the kind and an error code, never the record's contents.

import path from 'node:path';
import * as nodeFs from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { PERSONA_ID } from './db/ids.ts';
import { placeOrPersona } from './db/unit-keys.ts';
import type { UnitKey } from './db/unit-keys.ts';

import { log as defaultLog } from '../log.ts';
import { oneLine } from './clamp.ts';
import { memoryRootOf } from './root.ts';

import { journalLastWrite, journalLines } from './db/journal-lines.ts';
import { DAY_MS, HOUR_MS, MINUTE_MS, utcDay } from '../time.ts';
import { currentToolName } from '../tools/definitions.ts';
import { propOf, isFiniteNumber, isIntegerNumber, readSeamOf } from './types.ts';
import type { Log, StoredRecord, MemoryDb, Untyped } from './types.ts';
import type { AppendStore } from './append-store.ts';

/** The schema version every record carries. */
export const JOURNAL_VERSION = 1;

const DEFAULT_READ_N = 50;
const DAY_RE = /^\d{4}-\d{2}-\d{2}/;
/** How many characters of a post's text its `started` line keeps for the reconciliation. */
export const INTENT_CHARS = 80;
/** How many of a channel's last messages the reconciliation reads for the persona's own. */
export const RECONCILE_FETCH = 20;
/** How much earlier than its `started` line a message may be dated and still be the post (clock skew). */
const RECONCILE_SKEW_MS = 60_000;
/** The phases that close an operation. */
const CLOSING_PHASES = new Set(['succeeded', 'failed', 'unknown']);
/** The fields a closing line repeats from its operation (never the input or the intent). */
const OP_FIELDS = ['turnId', 'name', 'by', 'placeId', 'scope', 'participants', 'sourceMessageIds', 'dryRun'];
/** The characters of `think` a `/nep journal` line shows. */
export const LINE_THINK_CHARS = 80;

/** The records of a parsed journal read: the entries that are objects (anything else says nothing). */
function recordsOf(records: Array<unknown>): Array<StoredRecord> {
  return (Array.isArray(records) ? records : []).filter(
    (record): record is StoredRecord => Boolean(record) && typeof record === 'object'
  );
}

/**
 * One record as a short owner-facing line: `HH:MM:SS kind <short>` (the UTC clock of
 * `occurredAt`). A turn: `mode outcome <n> msgs, think: <first 80 characters>`; a turn start:
 * `mode trigger`; an action: `name phase`; a memory record: `batch <n> lines, users <k>, episodes
 * <e>`; a system event: `event by note`; an answer record: `event reason verdict outcome`
 * (what is present).
 */
export function journalLine(record: StoredRecord): string {
  const at = typeof record?.occurredAt === 'string' ? record.occurredAt.slice(11, 19) : '--:--:--';
  const kind = String(record?.kind ?? '?');
  const words = (...parts: Array<unknown>) =>
    parts.filter((part) => part !== null && part !== undefined && part !== '').join(' ');
  const count = (value: Untyped) => (Array.isArray(value) ? value.length : 0);
  let short;
  if (kind === 'turn') {
    const think =
      typeof record.think === 'string' && record.think.trim()
        ? Array.from(oneLine(record.think)).slice(0, LINE_THINK_CHARS).join('')
        : '-';
    short = `${words(record.mode ?? '-', record.outcome ?? '-')} ${count(record.seen?.messageIds)} msgs, think: ${think}`;
  } else if (kind === 'turn.start') {
    short = words(record.mode ?? '-', record.trigger?.kind);
  } else if (kind === 'action') {
    short = words(record.name ?? '-', record.phase ?? '-');
  } else if (kind === 'memory') {
    const lines = isFiniteNumber(record.batch?.consumed) ? record.batch.consumed : count(record.batch?.messageIds);
    short = `batch ${lines} lines, users ${count(record.changed?.users)}, episodes ${count(record.episodes)}`;
  } else if (kind === 'system') {
    short = words(record.event ?? '-', record.by, record.note);
  } else if (kind === 'answer') {
    short = words(record.event ?? '-', record.reason, record.verdict, record.outcome);
  } else if (kind === 'inner') {
    short = words(
      record.event ?? '-',
      record.wake?.kind,
      record.cap,
      record.outcome,
      record.reason,
      Array.isArray(record.actions) ? `${record.actions.length} actions` : null
    );
  } else {
    short = '';
  }
  return words(at, kind, short);
}

/**
 * The first INTENT_CHARS characters (code points) of `text`: what a post's `started` line
 * keeps and what the reconciliation compares a message's content with.
 */
export function intentText(text: unknown): string {
  return Array.from(typeof text === 'string' ? text : '')
    .slice(0, INTENT_CHARS)
    .join('');
}

/** An epoch-ms time of a message's `createdAt` (a number, a Date or an ISO string), else null. */
function timeOf(value: Untyped) {
  if (isFiniteNumber(value)) return value;
  if (value instanceof Date) return value.getTime();
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return isFiniteNumber(parsed) ? parsed : null;
}

/** Distinct non-empty strings of `value` (an array), in order; anything else -> []. */
function idList(value: Untyped) {
  if (!Array.isArray(value)) return [];
  const out: Array<string> = [];
  for (const item of value) {
    if (typeof item === 'string' && item && !out.includes(item)) out.push(item);
  }
  return out;
}

/** How many off periods the persona's request shows at most. */
export const OFF_PERIODS_MAX = 3;
/** Off periods closer than this are one. */
const OFF_MERGE_MS = MINUTE_MS;
/** How long a computed list of off periods is reused (createOffPeriodsReader). */
const OFF_CACHE_MS = MINUTE_MS;
/** The hours of off periods a read covers. Production value, config cut of 2026-10-31. */
const DEFAULT_OFF_WINDOW_HOURS = 24;
// The envelope's first fields, in the order `envelope` writes them: a line's kind and time read
// without parsing the whole record (a turn line carries the model's think).
const ENVELOPE_HEAD_RE = /^\{"v":\d+,"id":"[^"\\]*","kind":"([^"\\]+)","occurredAt":"([^"\\]+)"/;

/**
 * The persona's off periods from a journal timeline (`timeline`'s entries, `{ at, kind, event }`,
 * any order): an owner `pause` to the next `resume` is `paused`; a service `stop` to the next
 * `start` is `stopped`, and a `start` with no `stop` before it (a crash) is `stopped` from the
 * last record before it (an `unclean-stop` record, written at that start, does not count). A
 * pause with no resume yet is left out (the persona says nothing while paused), and so is a
 * start with nothing before it. Periods that overlap or lie less than a minute apart are one,
 * of the kind of its longest part. Only periods that ended within `windowMs` before `now`
 * count, and with `minMs` only those that lasted at least that long once merged, taken before the cut to `max`, so
 * short restarts never push a long absence out of the list; at most `max`, newest first. Pure.
 */
export function offPeriods(
  timeline: Array<{ at: number; kind: string; event?: string | null }>,
  { now, windowMs, max = OFF_PERIODS_MAX, minMs = 0 }: { now: number; windowMs: number; max?: number; minMs?: number }
): Array<{ kind: 'paused' | 'stopped'; from: number; to: number }> {
  const entries = (Array.isArray(timeline) ? timeline : [])
    .filter((entry) => isFiniteNumber(entry?.at))
    .map((entry, i) => ({ entry, i }))
    .sort((a, b) => a.entry.at - b.entry.at || a.i - b.i)
    .map(({ entry }) => entry);
  const found: Array<{ kind: 'paused' | 'stopped'; from: number; to: number }> = [];
  let pausedAt: number | null = null;
  let stoppedAt: number | null = null;
  let lastAt: number | null = null;
  for (const { at, kind, event } of entries) {
    const system = kind === 'system';
    if (system && event === 'pause') {
      if (pausedAt === null) pausedAt = at;
    } else if (system && event === 'resume') {
      if (pausedAt !== null) found.push({ kind: 'paused', from: pausedAt, to: at });
      pausedAt = null;
    } else if (system && event === 'stop') {
      if (stoppedAt === null) stoppedAt = at;
    } else if (system && event === 'start') {
      const from = stoppedAt ?? lastAt;
      if (from !== null) found.push({ kind: 'stopped', from, to: at });
      stoppedAt = null;
    }
    if (!(system && event === 'unclean-stop')) lastAt = at;
  }
  const merged: Array<{ kind: 'paused' | 'stopped'; from: number; to: number; longest: number }> = [];
  for (const period of found.sort((a, b) => a.from - b.from)) {
    const last = merged.at(-1);
    if (last && period.from - last.to < OFF_MERGE_MS) {
      const lastLongest = last.longest;
      const length = period.to - period.from;
      if (length > lastLongest) {
        last.kind = period.kind;
        last.longest = length;
      }
      last.to = Math.max(last.to, period.to);
    } else {
      merged.push({ ...period, longest: period.to - period.from });
    }
  }
  return merged
    .filter((period) => period.to >= now - windowMs && period.to <= now && period.to - period.from >= minMs)
    .sort((a, b) => b.to - a.to)
    .slice(0, max)
    .map(({ kind, from, to }) => ({ kind, from, to }));
}

/**
 * The off periods of a place's last `windowHours` hours (`DEFAULT_OFF_WINDOW_HOURS` when omitted), read through
 * `journal.timeline` and reused for a minute per place, window and `minMinutes` (the shortest period kept, 0: all), so a busy channel does not read
 * the day files every turn. A read that fails gives no period and one warn (`journal: off periods
 * unread`, the place and the error code); no journal, or one without `timeline`, gives none.
 */
export function createOffPeriodsReader({
  journal,
  now = Date.now,
  log = defaultLog,
}: {
  journal: { timeline: Untyped } | null;
  now?: () => number;
  log?: Pick<Log, 'warn'>;
}): (
  placeId: string,
  options?: { windowHours?: number; minMinutes?: number }
) => Promise<Array<{ kind: string; from: number; to: number }>> {
  const cache = new Map(); // `${placeId}:${hours}:${minMs}` -> { at, periods }
  return async function read(placeId, { windowHours, minMinutes } = {}) {
    if (!journal || typeof journal.timeline !== 'function' || !placeId) return [];
    const hours =
      typeof windowHours === 'number' && isFiniteNumber(windowHours) && windowHours > 0
        ? windowHours
        : DEFAULT_OFF_WINDOW_HOURS;
    const at = now();
    const minMs =
      typeof minMinutes === 'number' && isFiniteNumber(minMinutes) && minMinutes > 0 ? minMinutes * MINUTE_MS : 0;
    const key = `${placeId}:${hours}:${minMs}`;
    const cached = cache.get(key);
    if (cached && at - cached.at >= 0 && at - cached.at < OFF_CACHE_MS) return cached.periods;
    const windowMs = hours * HOUR_MS;
    let periods: Array<{ kind: string; from: number; to: number }> = [];
    try {
      periods = offPeriods(await journal.timeline(placeId, { from: at - windowMs }), { now: at, windowMs, minMs });
    } catch (error) {
      log.warn('journal: off periods unread', { placeId: String(placeId), code: propOf(error, 'code') ?? null });
    }
    cache.clear();
    cache.set(key, { at, periods });
    return periods;
  };
}

/**
 * Which message started the turn that posted each of the persona's messages, from journal
 * records (parsed lines, any kinds, oldest first): a `turn.start` names its turn's trigger
 * (`trigger.messageId`), a `turn` record its posts (`posted[].messageId`), joined by `turnId`.
 * A turn without a trigger (a spontaneous turn, the selfreflection) or whose `turn.start` is not among the
 * records links nothing. `[postedId, triggerId]` pairs in the order of the posts. Pure.
 */
export function triggerLinksOf(records: Array<unknown>): Array<[string, string]> {
  const list = recordsOf(records);
  const triggers = new Map(); // turnId -> trigger messageId
  for (const record of list) {
    const triggerId = record?.trigger?.messageId;
    if (
      record?.kind === 'turn.start' &&
      typeof record.turnId === 'string' &&
      typeof triggerId === 'string' &&
      triggerId
    ) {
      triggers.set(record.turnId, triggerId);
    }
  }
  const out: Array<[string, string]> = [];
  for (const record of list) {
    if (record?.kind !== 'turn' || !triggers.has(record.turnId) || !Array.isArray(record.posted)) continue;
    const triggerId = triggers.get(record.turnId);
    for (const post of record.posted) {
      const postedId = post?.messageId;
      if (typeof postedId === 'string' && postedId && postedId !== triggerId) out.push([postedId, triggerId]);
    }
  }
  return out;
}

/** The message id of one `posted` item: `{ messageId }`, or a bare id string as an old record may hold; else null. */
function postedIdOf(post: Untyped) {
  const id = typeof post === 'string' ? post : post?.messageId;
  return typeof id === 'string' && id ? id : null;
}

/** The `messageId` a `succeeded` action line's result names, else null. */
function succeededIdOf(record: StoredRecord) {
  const id = record?.kind === 'action' && record.phase === 'succeeded' ? record.result?.messageId : null;
  return typeof id === 'string' && id ? id : null;
}

/** A call result's status as a closing line keeps it (`ok`, `not_configured`, ...). */
const CALL_STATUS_RE = /^[a-z_]{1,32}$/;

/**
 * The persona's skill calls, from journal records (parsed lines, any kinds, oldest first), for
 * the call marks of her transcript lines (src/format.ts#callMarksFor): every `skill`
 * operation of a place channel as `{ placeId, at, skill, status, target, postedId, posted }` --
 * `placeId` the channel of its turn (the operation's scope), `at` the time of its last line
 * (epoch ms), `skill` its `input.skill`, `status` the closing line's: `ok` for `succeeded`,
 * `unknown` for `unknown`, a `failed` line's `result.status` (`failed` when it has none: an older
 * line), `unknown` with no closing line; `code` and `reason` of a `failed` or `unknown` closing
 * line's `result`, each only when that line has it (src/tools/executors.ts#outcomeDetail reads
 * them); `target` its `started` line's ids (`{ messageId, placeId
 * }`: `message`, else `reply`; null fields when unknown), `postedId` the message it posted
 * (`succeeded` with a `messageId`), `posted` every message its turn posted (its `turn` records'
 * `posted` and its operations' succeeded ids, once each, in order). `postedFrom`: `[postedId,
 * placeId]` for a call that posted in another channel than its turn's. Pure.
 */
export function callMarksOf(records: Array<unknown>): {
  calls: Array<object>;
  postedFrom: Array<[string, string]>;
} {
  const list = recordsOf(records);
  const text = (value: Untyped) => (typeof value === 'string' && value ? value : null);
  const postedByTurn = new Map<string, Array<string>>(); // turnId -> message ids, in order
  const addPosted = (turnId: Untyped, id: string | null) => {
    if (!text(turnId) || !id) return;
    const ids = postedByTurn.get(turnId) ?? [];
    if (!ids.includes(id)) ids.push(id);
    postedByTurn.set(turnId, ids);
  };
  for (const record of list) {
    if (record.kind === 'turn')
      for (const post of Array.isArray(record.posted) ? record.posted : []) addPosted(record.turnId, postedIdOf(post));
    else if (record.kind === 'action') addPosted(record.turnId, succeededIdOf(record));
  }
  const ops = new Map(); // opId -> what its lines said
  // A call an inner turn only proposed (shadow mode, src/behavior/inner.ts) never ran: no mark.
  const shadowOps = new Set(
    list
      .filter((record) => record.kind === 'action' && record.shadow === true && text(record.opId))
      .map((record) => record.opId)
  );
  for (const record of list) {
    if (record.kind !== 'action' || record.name !== 'skill' || !text(record.opId) || shadowOps.has(record.opId))
      continue;
    const op = ops.get(record.opId) ?? {
      turnId: null,
      placeId: null,
      skill: null,
      target: null,
      status: null,
      code: null,
      reason: null,
      postedId: null,
      at: null,
      values: null,
    };
    op.turnId = text(record.turnId) ?? op.turnId;
    op.placeId = text(record.scope?.channel) ?? op.placeId;
    op.skill = currentToolName(text(record.input?.skill)) ?? op.skill;
    if (record.target && typeof record.target === 'object') op.target = record.target;
    if (record.phase === 'succeeded') op.status = 'ok';
    else if (record.phase === 'unknown') op.status = 'unknown';
    else if (record.phase === 'failed')
      op.status = CALL_STATUS_RE.test(String(record.result?.status ?? '')) ? record.result.status : 'failed';
    // Why a call that did not work did not: its code and the machine reason (a schema path, an option name).
    if (record.phase === 'failed' || record.phase === 'unknown') {
      op.code = text(record.result?.code);
      op.reason = text(record.result?.reason);
      op.values =
        record.result?.values && typeof record.result.values === 'object' && !Array.isArray(record.result.values)
          ? record.result.values
          : null;
    }
    op.postedId = succeededIdOf(record) ?? op.postedId;
    const at = Date.parse(String(record.occurredAt));
    if (isFiniteNumber(at)) op.at = at;
    ops.set(record.opId, op);
  }
  const calls = [];
  const postedFrom: Array<[string, string]> = [];
  for (const op of ops.values()) {
    if (!op.placeId || !op.skill) continue;
    const target = {
      messageId: text(op.target?.message) ?? text(op.target?.reply),
      placeId: text(op.target?.channel),
    };
    calls.push({
      placeId: op.placeId,
      at: op.at,
      skill: op.skill,
      status: op.status ?? 'unknown',
      ...(op.code ? { code: op.code } : {}),
      ...(op.reason ? { reason: op.reason } : {}),
      ...(op.values ? { values: op.values } : {}),
      target,
      postedId: op.postedId,
      posted: [...(postedByTurn.get(op.turnId) ?? [])],
    });
    if (op.postedId && target.placeId && target.placeId !== op.placeId) postedFrom.push([op.postedId, op.placeId]);
  }
  return { calls, postedFrom };
}

/** Text items of a stored list, the rest left out. */
const textsOf = (value: Untyped): Array<string> =>
  Array.isArray(value) ? value.filter((one): one is string => typeof one === 'string' && one !== '') : [];

/** The messages each turn of `list` posted, by turn id: its `turn` records' `posted` and its succeeded operations'. */
function postedOfTurns(list: Array<StoredRecord>): Map<string, Array<string>> {
  const posted = new Map<string, Array<string>>();
  for (const record of list) {
    if (typeof record.turnId !== 'string') continue;
    const ids = record.kind === 'turn' && Array.isArray(record.posted) ? record.posted.map(postedIdOf) : [];
    const known = posted.get(record.turnId) ?? [];
    for (const id of [...ids, succeededIdOf(record)]) if (typeof id === 'string' && !known.includes(id)) known.push(id);
    posted.set(record.turnId, known);
  }
  return posted;
}

const isObject = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === 'object' && !Array.isArray(value);
const textOrNull = (value: unknown): string | null => (typeof value === 'string' ? value : null);

/** The stored source of a kept line, as ids: null without one or when its ids are broken. */
function storedOfKept(value: unknown): object | null {
  if (!isObject(value) || typeof value.sourceId !== 'string' || typeof value.placeId !== 'string') return null;
  const native = value.native;
  const located =
    isObject(native) &&
    typeof native.iface === 'string' &&
    typeof native.chatId === 'string' &&
    typeof native.messageId === 'string';
  return {
    sourceId: value.sourceId,
    placeId: value.placeId,
    iface: textOrNull(value.iface),
    ...(isIntegerNumber(value.revision) || value.revision === null ? { revision: value.revision } : {}),
    ...(located ? { native: { iface: native.iface, chatId: native.chatId, messageId: native.messageId } } : {}),
  };
}

/**
 * The lines a closing line kept for its lookup's numbers (src/turn/calls.ts#lineIdentities), each as the turn's registry
 * holds a line: its number, message id, place, author, whether it is hers or deleted, and its stored source. A line with
 * no whole number or no id is left out.
 */
function keptLines(value: unknown): Array<object> {
  if (!Array.isArray(value)) return [];
  return value.flatMap((line: unknown) => {
    if (!isObject(line) || !isIntegerNumber(line.n)) return [];
    const id = line.id;
    if (typeof id !== 'string' && !isFiniteNumber(id)) return [];
    const stored = storedOfKept(line.stored);
    return [
      {
        n: line.n,
        id,
        ...(line.placeId !== undefined ? { placeId: textOrNull(line.placeId) } : {}),
        ...(line.authorId !== undefined ? { authorId: textOrNull(line.authorId) } : {}),
        ...(typeof line.self === 'boolean' ? { self: line.self } : {}),
        ...(line.deleted === true ? { deleted: true } : {}),
        ...(stored ? { stored } : {}),
      },
    ];
  });
}

/** The lookup one closing line kept, with the messages its turn posted among its anchors; null for any other line. */
function lookupOfRecord(record: StoredRecord, posted: ReadonlyArray<string>): object | null {
  const kept = record.kind === 'action' && record.name === 'skill' ? record.result?.lookup : null;
  const place = kept?.place;
  const at = Date.parse(String(record.occurredAt));
  if (!kept || typeof place?.id !== 'string' || typeof record.turnId !== 'string' || !isFiniteNumber(at)) return null;
  const args: unknown = kept.args;
  const lines = keptLines(kept.lines);
  return {
    turnId: record.turnId,
    at,
    tool: currentToolName(typeof kept.tool === 'string' ? kept.tool : null) ?? '',
    args: args && typeof args === 'object' && !Array.isArray(args) ? args : {},
    place: { id: place.id, path: textsOf(place.path) },
    status: typeof kept.status === 'string' ? kept.status : 'unknown',
    extract: typeof kept.extract === 'string' ? kept.extract : '',
    sourceIds: textsOf(kept.sourceIds),
    anchorMessageIds: [...new Set([...textsOf(kept.anchorMessageIds), ...posted])],
    ...(lines.length > 0 ? { lines } : {}),
  };
}

/**
 * Her lookups from journal records (parsed lines, any kinds, oldest first): every closing line of a `skill` operation that
 * kept a `lookup` (src/turn/calls.ts#lookupOfCall), as the ring of `<recall>` holds it, with the messages its turn posted
 * joined to its anchors. Pure.
 */
export function lookupsOfRecords(records: Array<unknown>): Array<object> {
  const list = recordsOf(records);
  const posted = postedOfTurns(list);
  return list
    .map((record) => lookupOfRecord(record, posted.get(String(record.turnId)) ?? []))
    .filter((one): one is object => one !== null);
}

/**
 * What each turn of journal records (parsed lines, any kinds, oldest first) raised for the graph reader of the next
 * turns in its place (src/turn/seed-ring.ts): every `turn` record that kept `seeds`, as `{ placeId, turnId, refs }`,
 * `placeId` the ring's place and the refs `{ kind, rowId }` pairs, in the order of the records. Pure.
 */
export function seedsOfRecords(
  records: Array<unknown>
): Array<{ placeId: string; turnId: string; refs: Array<{ kind: string; rowId: string }> }> {
  return recordsOf(records).flatMap((record) => {
    const kept: unknown = record.seeds;
    if (record.kind !== 'turn' || typeof record.turnId !== 'string' || !isObject(kept)) return [];
    const { placeId, refs: seeds } = kept;
    if (typeof placeId !== 'string' || !Array.isArray(seeds)) return [];
    const refs = seeds.flatMap((one: unknown) =>
      isObject(one) && typeof one.kind === 'string' && typeof one.rowId === 'string'
        ? [{ kind: one.kind, rowId: one.rowId }]
        : []
    );
    return [{ placeId, turnId: record.turnId, refs }];
  });
}

/**
 * The turn that posted message `messageId`, from journal records (parsed lines, any kinds, oldest
 * first): the `turn` record whose `posted` names it, else -- an old record without the ids, or a
 * message her skill call posted -- the `turn` record of the turn whose operation closed
 * `succeeded` with that `messageId` (the attempt whose `actions` list that operation, else the
 * turn's last). With it: its `turn.start` (the same attempt, else the turn's last; null when not
 * among the records), every message id the attempt posted (its `posted`, then its succeeded
 * operations', once each) and its skill calls (`skill` operations: `{ skill, args, target,
 * phase, code, messageId }`, `args` the attribute names, `phase` the last one written). Null when
 * no turn among the records posted it. Pure.
 */
export function turnOfMessage(
  records: Array<unknown>,
  messageId: string
): { turn: object; start: object | null; posted: Array<string>; calls: Array<object> } | null {
  const list = recordsOf(records);
  const id = String(messageId ?? '');
  if (!id) return null;
  const turns = list.filter((record) => record.kind === 'turn' && typeof record.turnId === 'string');
  let turn =
    turns.find(
      (record) => Array.isArray(record.posted) && record.posted.some((post: Untyped) => postedIdOf(post) === id)
    ) ?? null;
  if (!turn) {
    const op = list.find((record) => succeededIdOf(record) === id && typeof record.turnId === 'string');
    if (!op) return null;
    const ofTurn = turns.filter((record) => record.turnId === op.turnId);
    turn =
      ofTurn.find((record) => Array.isArray(record.actions) && record.actions.includes(op.opId)) ??
      ofTurn.at(-1) ??
      null;
    if (!turn) return null;
  }
  const starts = list.filter((record) => record.kind === 'turn.start' && record.turnId === turn.turnId);
  const start = starts.find((record) => record.attemptId === turn.attemptId) ?? starts.at(-1) ?? null;
  // The attempt's operations: those its `actions` lists, else every one of the turn.
  const mine = (record: StoredRecord) =>
    record.kind === 'action' &&
    record.turnId === turn.turnId &&
    (!Array.isArray(turn.actions) || turn.actions.includes(record.opId));
  const ops = list.filter(mine);
  const posted: Array<string> = [];
  const add = (postedId: string | null) => {
    if (postedId && !posted.includes(postedId)) posted.push(postedId);
  };
  for (const post of Array.isArray(turn.posted) ? turn.posted : []) add(postedIdOf(post));
  for (const record of ops) add(succeededIdOf(record));
  const calls = new Map(); // opId -> call
  for (const record of ops) {
    if (record.name !== 'skill' || typeof record.opId !== 'string') continue;
    const call = calls.get(record.opId) ?? {
      skill: null,
      args: [],
      target: null,
      phase: null,
      code: null,
      messageId: null,
    };
    if (typeof record.input?.skill === 'string') call.skill = currentToolName(record.input.skill);
    const args = record.input?.args;
    if (Array.isArray(args)) call.args = args.filter((name: string) => typeof name === 'string');
    if (record.target && typeof record.target === 'object') call.target = record.target;
    if (typeof record.phase === 'string') call.phase = record.phase;
    if (typeof record.result?.code === 'string') call.code = record.result.code;
    if (succeededIdOf(record)) call.messageId = succeededIdOf(record);
    calls.set(record.opId, call);
  }
  return { turn, start, posted, calls: [...calls.values()] };
}

/**
 * One turn as `turnOfMessage` found it, for the owner (`/nep memory journal message:`): its id
 * and attempt, start and end time, channel, mode, trigger kind and message id, outcome and
 * reason, the message ids it posted, its skill calls, then the stored `think` whole (saying so
 * when a record stored before the cap was lifted was cut). Multi-line text. Pure.
 */
export function turnView({
  turn,
  start = null,
  posted = [],
  calls = [],
}: {
  turn: Untyped;
  start?: Untyped;
  posted?: Array<string>;
  calls?: Array<Untyped>;
}): string {
  const text = (value: Untyped) => (typeof value === 'string' && value ? value : '-');
  const channel = turn.scope?.channel ?? (turn.scope?.private ? 'private' : null);
  const trigger = start?.trigger ?? null;
  const callText = (call: Untyped) => {
    const target = call.target
      ? Object.entries<Untyped>(call.target)
          .map(([key, value]) => `${key}=${value}`)
          .join(' ')
      : '';
    return [
      text(call.skill),
      text(call.phase),
      call.code,
      call.args.length > 0 ? `args: ${call.args.join(', ')}` : '',
      target ? `target: ${target}` : '',
      call.messageId ? `posted: ${call.messageId}` : '',
    ]
      .filter(Boolean)
      .join(' ');
  };
  const think = typeof turn.think === 'string' && turn.think.trim() ? turn.think : null;
  return [
    `turn ${text(turn.turnId)} (attempt ${isIntegerNumber(turn.attemptId) ? turn.attemptId : '-'})`,
    `time: ${text(turn.startedAt ?? start?.occurredAt)} -> ${text(turn.occurredAt)}`,
    `channel: ${text(channel)}`,
    `mode: ${text(turn.mode)}`,
    `trigger: ${trigger ? `${text(trigger.kind)} ${text(trigger.messageId)}` : 'none'}`,
    `outcome: ${text(turn.outcome)}, reason: ${text(turn.reason)}`,
    `posted: ${posted.length > 0 ? posted.join(', ') : 'none'}`,
    ...(calls.length > 0 ? calls.map((call) => `call: ${callText(call)}`) : ['call: none']),
    think
      ? `think (${Array.from(think).length} chars${turn.thinkTruncated === true ? ', cut when stored' : ''}):`
      : 'think: none',
    ...(think ? [think] : []),
  ].join('\n');
}

/**
 * The record's scope: the chat it happened in, when it names one. A turn with no chat runs in her own stand-in
 * (`PERSONA_ID`), which is no chat, so its record names none and its rows hold no place.
 */
function scopeOf(chatId: unknown): { channel?: string } {
  return typeof chatId === 'string' && chatId && chatId !== PERSONA_ID ? { channel: chatId } : {};
}

/** The persona's own latest messages in a channel, as the interface reads them again. */
type ReconcileFetch = (
  placeId: string,
  n: number
) => Promise<Array<{ id: string; content: string; replyToId: string | null; createdAt: unknown }>>;

/** The journal of a deployment: one append-only file per place and day, read back by the owner's commands and the turn. */
export type Journal = {
  /** Whatever the writer still holds (a stand-in may have nothing to wait for). */
  flush?(): Promise<void>;
  start(
    placeId: string,
    input: {
      placeId?: string;
      mode?: string;
      trigger?: object;
      participants?: Array<string>;
      sourceMessageIds?: Array<string>;
      turnId?: string;
      attemptId?: number;
    }
  ): { turnId: string; attemptId: number; startedAt: string };
  turn(placeId: string, record: object): Promise<void>;
  action(placeId: string, record: object): Promise<void>;
  actionLine(placeId: string, record: object): { placeId: string | null; line: unknown };
  memory(placeId: string, record: object): Promise<void>;
  system(record: object): Promise<void>;
  answer(placeId: string, record: object): Promise<void>;
  inner(placeId: string, record: object): Promise<void>;
  read(placeId: string | null, query?: { day?: string; kind?: string | null; n?: number }): Promise<Array<object>>;
  timeline(
    placeId: string,
    query?: { from?: number }
  ): Promise<Array<{ at: number; kind: string; event: string | null }>>;
  triggerLinks(placeId: string, query?: { days?: Array<string> }): Promise<Array<[string, string]>>;
  callMarks(
    placeId: string,
    query?: { days?: Array<string> }
  ): Promise<{ calls: Array<object>; postedFrom: Array<[string, string]> }>;
  findTurn(
    placeId: string,
    query?: { messageId?: string; at?: number }
  ): Promise<{ turn: object; start: object | null; posted: Array<string>; calls: Array<object> } | null>;
  dayFile(placeId: string, dateIso: string): string;
  op(
    placeId: string,
    base: object
  ): {
    opId: string;
    proposed(extra?: object): Promise<void>;
    started(extra?: object): Promise<void>;
    succeeded(result?: object): Promise<void>;
    failed(code: string, result?: object): Promise<void>;
    unknown(result?: object): Promise<void>;
  };
  pending(
    placeId: string,
    query?: { day?: string | null; days?: Array<string> | null; before?: number | null }
  ): Promise<
    Array<{ opId: string; turnId: string | null; name: string | null; intent: object; placeId: string | null }>
  >;
  turnOperations(
    placeId: string,
    query?: { turnId?: string; days?: Array<string> }
  ): Promise<
    Array<{
      opId: string;
      name: string | null;
      by: string | null;
      phase: 'succeeded' | 'failed' | 'unknown' | 'open' | 'proposed';
      skill: string | null;
      text: string | null;
      dryRun: boolean;
      shadow: boolean;
    }>
  >;
  reconcile(
    placeId: string,
    options?: { days?: Array<string>; before?: number | null; fetchOwnMessages?: ReconcileFetch }
  ): Promise<{ succeeded: number; unknown: number }>;
  stalled(): boolean;
  markRunning(): Promise<{ unclean: boolean }>;
  clearRunning(): Promise<void>;
  withWriterLock<TResult>(fn: () => Promise<TResult> | TResult): Promise<TResult>;
  waitUnlocked(): Promise<void>;
  stats(placeId: string, query?: { now?: number }): Promise<{ lastWriteMs: number | null }>;
};

type ReconcileOptions = { days?: Array<string>; fetchOwnMessages?: ReconcileFetch; before?: number | null };

type TurnOperationsQuery = { turnId?: string; days?: Array<string> };

type PendingQuery = { day?: string | null; days?: Array<string> | null; before?: number | null };

type ReadQuery = { day?: string; kind?: string | null; n?: number };

type StartInput = {
  placeId?: string | null;
  mode?: string | null;
  trigger?: Untyped;
  participants?: Array<string>;
  sourceMessageIds?: Array<string>;
  turnId?: string | null;
  attemptId?: number | null;
};

type JournalDeps = {
  appendStore?: Partial<Pick<AppendStore, 'append' | 'iterate' | 'flush' | 'stats'>> | null;
  dataDir: string;
  config?: () => Record<string, unknown> | undefined;
  now?: () => number;
  uuid?: () => string;
  log?: Pick<Log, 'warn'>;
  fs?: Pick<typeof nodeFs, 'mkdir' | 'writeFile' | 'rename' | 'rm' | 'stat' | 'readdir'>;
  lockStores?: Array<{ flush: Untyped }>;
  memoryDb: MemoryDb | null;
};

/**
 * Create the journal.
 *
 * @param [options.appendStore]  src/memory/append-store.ts, optional:
 *   flushed by `withWriterLock`; its `stats().stalled` is `stalled()`
 * @param options.dataDir  the `data/` directory
 * @param [options.config]  accepted and ignored: the journal reads no setting
 * @param [options.fs]  a `node:fs/promises`-shaped API (the `.running` marker)
 * @param [options.lockStores]  other append stores `withWriterLock`
 *   flushes before `fn` (the record's and the archive's, src/index.js)
 * @param options.memoryDb  the memory database service (src/memory/db/service.ts): the day reads
 *   (`read`, `timeline`, and so `findTurn`, `turnOperations`, `pending`, `triggerLinks`, `callMarks`,
 *   `reconcile`'s scan) and `stats` are answered from it (src/memory/db/journal-lines.ts; a failed read rejects
 *   with a code), and every line the writers write goes to it (`day`, `decisions`, her answers' `sources`,
 *   `affinity_events`, in the day's unit, `memoryDb.writeJournalLines`); the
 *   `.running` marker stays a file.
 *   `actionLine` builds an `action` line and names the place whose journal takes it, without writing it: an errand's
 *   end writes it with its board move.
 *   `stats` says when the place journal was last written: the latest `recordedAt` of the lines of the day of `now`
 *   and the day before (the first hour after midnight); null when neither holds one.
 *   `start` writes a `turn.start` line (not awaited: a failed append is logged) and returns the
 *   turn's id: a new one, or `input.turnId` with `input.attemptId` for a later attempt of the
 *   same turn. The writers resolve once the database's writer committed the line and never reject (a
 *   refused write is logged as `journal: append failed` with its code). `read` returns the
 *   last `n` records of the day (of `kind` when given), newest last.
 *
 *   `op` allots an operation's `opId` (`op-<uuid>`) for one side effect; `base` holds its
 *   `turnId`, `name`, `by` (`persona` | `engine`), `placeId`,
 *   `participants`, `sourceMessageIds`, `input`, `intent` (a post's `{ replyTo, text }`, the
 *   text cut to INTENT_CHARS) and `dryRun`. `proposed(extra)` writes a `proposed` line (a skill
 *   call the persona asked for, before its checks; never pending without a `started` line);
 *   `started(extra)` writes the `started` line (`extra`
 *   adds fields known only then); the first of `succeeded(result)`, `failed(code, result)`
 *   (`result.code`) or `unknown(result)` writes the closing line, any later one is ignored.
 *   `pending` lists the place journal's operations of `day` (or of every day of `days`) whose
 *   `started` line has no closing line in those days (with `before`, epoch ms: only those started
 *   earlier, so an operation of a turn running meanwhile is left alone). `reconcile` closes them, never sending
 *   anything: a `post` whose channel's last RECONCILE_FETCH own messages (one fetch per
 *   channel) hold one replying to `intent.replyTo` whose content starts with `intent.text`
 *   (dated no earlier than the `started` line, less a minute of skew; one message closes one
 *   post) gets `succeeded` with its `messageId`; any other post, a failed fetch, and every
 *   other operation get `unknown`; each closing line carries `reconciled: true`.
 *
 *   `stalled` says whether the append store's retry queue is full (`stats().stalled`; false for a
 *   store without stats): what depends on a record being taken (memory application) waits.
 */
export function createJournal({
  appendStore = null,
  dataDir,
  now = Date.now,
  uuid = randomUUID,
  log = defaultLog,
  fs = nodeFs,
  lockStores = [],
  memoryDb = null,
}: JournalDeps): Journal {
  const root = memoryRootOf(dataDir);
  const seam = readSeamOf(memoryDb, log, 'journal');
  const journalDir = (placeId: string | null): string => path.join(root.placeDir(placeId), 'journal');
  const runningFile = (): string => path.join(dataDir, 'run', 'journal.running');

  function dayFile(placeId: string, dateIso: unknown) {
    const day = String(dateIso).match(DAY_RE)?.[0] ?? utcDay(now());
    return path.join(journalDir(placeId), `${day}.jsonl`);
  }

  /** `fields` wrapped in the envelope. */
  function envelope(kind: string, fields: Untyped) {
    const { placeId: chatId = null, participants, sourceMessageIds, occurredAt, ...rest } = fields ?? {};
    const at = new Date(now()).toISOString();
    return {
      record: {
        v: JOURNAL_VERSION,
        id: uuid(),
        kind,
        occurredAt: typeof occurredAt === 'string' && occurredAt ? occurredAt : at,
        recordedAt: at,
        scope: scopeOf(chatId),
        participants: idList(participants),
        sourceMessageIds: idList(sourceMessageIds),
        origin: 'live',
        ...rest,
      },
    };
  }

  // While a writer lock is held (withWriterLock), the promise it resolves on release; else null.
  let held: Promise<void> | null = null;

  /** Wait until no writer lock is held. */
  async function unlocked() {
    while (held) await held;
  }

  /** @returns a line of `kind` in its envelope, and the unit of its day */
  function lineOf(kind: string, fields: Untyped): unknown {
    return envelope(kind, fields).record;
  }

  async function write(placeId: string | null, kind: string, fields: Untyped) {
    try {
      const line = lineOf(kind, fields);
      await unlocked();
      if (typeof memoryDb?.writeJournalLines !== 'function')
        throw Object.assign(new Error('memory db: no writer'), { code: 'DB_CLOSED' });
      await memoryDb.writeJournalLines({ placeId, lines: [line as Record<string, unknown>] });
    } catch (error) {
      log.warn('journal: append failed', { kind, code: propOf(error, 'code') ?? null });
    }
  }

  function start(
    placeId: string,
    {
      placeId: chatId = null,
      mode = null,
      trigger = null,
      participants,
      sourceMessageIds,
      turnId = null,
      attemptId = null,
    }: StartInput = {}
  ) {
    const id = typeof turnId === 'string' && turnId ? turnId : `t-${uuid()}`;
    const attempt = typeof attemptId === 'number' && isIntegerNumber(attemptId) && attemptId > 0 ? attemptId : 1;
    const startedAt = new Date(now()).toISOString();
    write(placeId, 'turn.start', {
      placeId: chatId,
      occurredAt: startedAt,
      participants,
      sourceMessageIds,
      turnId: id,
      attemptId: attempt,
      mode,
      trigger,
    });
    return { turnId: id, attemptId: attempt, startedAt };
  }

  function turn(placeId: string, record: StoredRecord) {
    const { think, ...rest } = record ?? {};
    const fields = { ...rest };
    fields.think = typeof think === 'string' ? think : null;
    return write(placeId, 'turn', fields);
  }

  const action = (placeId: string, record: StoredRecord) => write(placeId, 'action', record);
  const memory = (placeId: string, record: StoredRecord) => write(placeId, 'memory', { ...record, placeId: null });
  const system = (record: StoredRecord) => write(null, 'system', { ...record, placeId: null });
  const answer = (placeId: string, record: StoredRecord) => write(placeId, 'answer', record);
  // The inner life's scheduler and turns (src/behavior/inner.ts): `event` `wake`, `turn`,
  // `capped`, `overflow`, `stale`, `no-channel`, `review-drawn`, `review-missed`, `errand-cost`,
  // `stopped`, `started`. Ids, codes, counts and costs only.
  const inner = (placeId: string, record: StoredRecord) => write(placeId, 'inner', record);

  /** The lines (text) of one day's unit in the database. */
  function* dayLines(db: Untyped, key: UnitKey) {
    for (const line of seam.run(() => journalLines(db, key))) yield line;
  }

  async function read(placeId: string | null, { day, kind = null, n = DEFAULT_READ_N }: ReadQuery = {}) {
    const db = seam.db();
    const limit = isIntegerNumber(n) && n > 0 ? n : DEFAULT_READ_N;
    const out: Array<StoredRecord> = [];
    for (const line of dayLines(
      db,
      placeOrPersona('journal', placeId, { partition: String(day).match(DAY_RE)?.[0] ?? utcDay(now()) })
    )) {
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        continue;
      }
      if (!record || typeof record !== 'object') continue;
      if (kind && record.kind !== kind) continue;
      out.push(record);
      if (out.length > limit) out.shift();
    }
    return out;
  }

  /**
   * The records of the place's journal and the persona's from the UTC day of `from` (epoch ms)
   * through today, oldest first, each as `{ at, kind, event }` (`event` of a system record, else
   * null): the times offPeriods reads, nothing about anyone. A line's kind and time come from the
   * envelope's head; only a system line, or one whose head does not match, is parsed whole.
   */
  async function timeline(placeId: string, { from }: { from?: number } = {}) {
    const db = seam.db();
    const end = now();
    const start = typeof from === 'number' && isFiniteNumber(from) ? Math.min(from, end) : end;
    const out: Array<{ at: number; kind: string; event: string | null }> = [];
    for (const holder of placeId === PERSONA_ID ? [PERSONA_ID] : [placeId, PERSONA_ID])
      for (let day = Date.parse(`${utcDay(start)}T00:00:00Z`); day <= end; day += DAY_MS) {
        for (const line of dayLines(db, placeOrPersona('journal', holder, { partition: utcDay(day) }))) {
          const head = ENVELOPE_HEAD_RE.exec(line);
          let kind: string | null = head?.[1] ?? null;
          let occurredAt: string | null = head?.[2] ?? null;
          let event: string | null = null;
          if (!head || kind === 'system') {
            let record;
            try {
              record = JSON.parse(line);
            } catch {
              continue;
            }
            if (!record || typeof record !== 'object') continue;
            kind = record.kind;
            occurredAt = record.occurredAt;
            event = kind === 'system' && typeof record.event === 'string' ? record.event : null;
          }
          const at = Date.parse(String(occurredAt));
          if (typeof kind === 'string' && isFiniteNumber(at)) out.push({ at, kind, event });
        }
      }
    return out
      .map((entry, i) => ({ entry, i }))
      .sort((a, b) => a.entry.at - b.entry.at || a.i - b.i)
      .map(({ entry }) => entry);
  }

  /**
   * The place journal's `[postedId, triggerId]` pairs of `days` (UTC day keys, oldest first;
   * triggerLinksOf over their `turn.start` and `turn` records, read in that order, so a turn that
   * closed the day after it started is joined). A private journal is not read.
   */
  async function triggerLinks(placeId: string, { days = [] }: { days?: Array<string> } = {}) {
    const records: Array<StoredRecord> = [];
    for (const day of Array.isArray(days) ? days : []) {
      for (const record of await read(placeId, { day, n: Number.MAX_SAFE_INTEGER })) {
        if (record.kind === 'turn.start' || record.kind === 'turn') records.push(record);
      }
    }
    return triggerLinksOf(records);
  }

  /**
   * The place journal's skill calls of `days` (UTC day keys, oldest first; callMarksOf over their
   * `turn` and `action` records, read in that order). A private journal is not read.
   */
  async function callMarks(placeId: string, { days = [] }: { days?: Array<string> } = {}) {
    const records: Array<StoredRecord> = [];
    for (const day of Array.isArray(days) ? days : []) {
      for (const record of await read(placeId, { day, n: Number.MAX_SAFE_INTEGER })) {
        if (record.kind === 'turn' || record.kind === 'action') records.push(record);
      }
    }
    return callMarksOf(records);
  }

  /**
   * The turn that posted message `messageId` (turnOfMessage), sent at `at` (epoch ms, its
   * snowflake's time): searched in the place journal's UTC day of `at` and the next (a turn
   * record is written when the turn ends, maybe after midnight); a turn found without its
   * `turn.start` there (one that started before midnight) has it looked for in the day before.
   * Null when none posted it. A private journal is not read.
   */
  async function findTurn(placeId: string, { messageId, at }: { messageId?: string; at?: number } = {}) {
    const id = typeof messageId === 'string' ? messageId : '';
    if (!id || typeof at !== 'number' || !isFiniteNumber(at)) return null;
    const records: Array<StoredRecord> = [];
    for (const day of [utcDay(at), utcDay(at + DAY_MS)]) {
      for (const record of await read(placeId, { day, n: Number.MAX_SAFE_INTEGER })) {
        if (record.kind === 'turn.start' || record.kind === 'turn' || record.kind === 'action') records.push(record);
      }
    }
    const found = turnOfMessage(records, id);
    if (!found || found.start) return found;
    const before = await read(placeId, { day: utcDay(at - DAY_MS), kind: 'turn.start', n: Number.MAX_SAFE_INTEGER });
    return turnOfMessage([...before, ...records], id);
  }

  function op(placeId: string, base: Untyped = {}) {
    const opId = `op-${uuid()}`;
    const { intent, ...rest } = base ?? {};
    const common: Record<string, Untyped> = { ...rest, opId };
    if (intent && typeof intent === 'object') {
      common.intent = {
        replyTo: typeof intent.replyTo === 'string' && intent.replyTo ? intent.replyTo : null,
        text: intentText(intent.text),
      };
    }
    const closingBase: Record<string, Untyped> = { opId };
    for (const key of OP_FIELDS) if (key in rest) closingBase[key] = rest[key];
    let closed = false;
    const close = (phase: Untyped, result: Untyped) => {
      if (closed) return Promise.resolve();
      closed = true;
      return write(placeId, 'action', { ...closingBase, phase, ...(result !== undefined ? { result } : {}) });
    };
    return {
      opId,
      proposed: (extra: Record<string, Untyped> = {}) =>
        write(placeId, 'action', { ...common, ...extra, opId, phase: 'proposed' }),
      started: (extra: Record<string, Untyped> = {}) =>
        write(placeId, 'action', { ...common, ...extra, opId, phase: 'started' }),
      succeeded: (result = {}) => close('succeeded', result),
      failed: (code: Untyped, result = {}) =>
        close('failed', { ...result, code: typeof code === 'string' && code ? code : 'error' }),
      unknown: (result: Untyped) => close('unknown', result),
    };
  }

  /**
   * The `started` action lines of `days` (place journal) with no closing line in those days, in
   * order; with `before` (epoch ms) only those that started earlier.
   */
  async function openOperations(placeId: string, days: Array<string>, before: number | null = null) {
    const started = new Map<string, StoredRecord>();
    const closedIds = new Set<string>();
    for (const day of days) {
      for (const record of await read(placeId, { day, kind: 'action', n: Number.MAX_SAFE_INTEGER })) {
        if (typeof record.opId !== 'string' || !record.opId) continue;
        if (record.phase === 'started' && !started.has(record.opId)) started.set(record.opId, record);
        else if (CLOSING_PHASES.has(record.phase)) closedIds.add(record.opId);
      }
    }
    const earlier = (record: StoredRecord) =>
      typeof before !== 'number' || !isFiniteNumber(before) || Date.parse(String(record.occurredAt)) < before;
    return [...started.values()].filter((record) => !closedIds.has(record.opId) && earlier(record));
  }

  async function pending(placeId: string, { day = null, days = null, before = null }: PendingQuery = {}) {
    const list = Array.isArray(days) ? days : [day ?? utcDay(now())];
    return (await openOperations(placeId, list, before)).map((record) => ({
      opId: record.opId,
      turnId: record.turnId ?? null,
      name: record.name ?? null,
      intent: record.intent ?? null,
      placeId: record.scope?.channel ?? null,
    }));
  }

  /**
   * The operations of one turn (`turnId`) in the journal of `days`, each `{ opId, name, by, phase, skill, text, dryRun, shadow }`:
   * `phase` is how it ended (`succeeded`, `failed`, `unknown`; `open` when it started and has no closing line; `proposed`
   * when it never started).
   */
  async function turnOperations(placeId: string, { turnId, days }: TurnOperationsQuery = {}) {
    const ops = new Map();
    if (typeof turnId !== 'string' || !turnId) return [];
    for (const day of Array.isArray(days) ? days : []) {
      for (const record of await read(placeId, { day, kind: 'action', n: Number.MAX_SAFE_INTEGER })) {
        if (record.turnId !== turnId || typeof record.opId !== 'string' || !record.opId) continue;
        const op = ops.get(record.opId) ?? {
          opId: record.opId,
          name: null,
          by: null,
          phase: 'proposed',
          skill: null,
          text: null,
          dryRun: false,
          shadow: false,
          started: false,
        };
        op.name = record.name ?? op.name;
        op.by = record.by ?? op.by;
        op.skill = currentToolName(record.input?.skill) ?? op.skill;
        op.text = record.intent?.text ?? op.text;
        op.dryRun = op.dryRun || record.dryRun === true;
        op.shadow = op.shadow || record.shadow === true;
        if (record.phase === 'started') op.started = true;
        if (CLOSING_PHASES.has(record.phase)) op.phase = record.phase;
        ops.set(record.opId, op);
      }
    }
    return [...ops.values()].map(({ started, ...op }) =>
      op.phase === 'proposed' && started ? { ...op, phase: 'open' } : op
    );
  }

  /** The persona's last own messages of a chat, fetched once per reconciliation; null when the fetch failed. */
  function ownMessagesOnce(fetches: Untyped, fetchOwnMessages: Untyped, chatId: string) {
    if (!fetches.has(chatId)) {
      const fetching = Promise.resolve()
        .then(() => fetchOwnMessages(chatId, RECONCILE_FETCH))
        .catch((error) => {
          log.warn('journal: reconcile fetch failed', {
            code: error?.code ?? null,
            placeId: chatId,
          });
          return null;
        });
      fetches.set(chatId, fetching);
    }
    return fetches.get(chatId);
  }

  async function reconcile(placeId: string, { days, fetchOwnMessages, before = null }: ReconcileOptions = {}) {
    const open = await openOperations(placeId, Array.isArray(days) ? days : [utcDay(now())], before);
    const fetches = new Map();
    const used = new Set();
    const counts = { succeeded: 0, unknown: 0 };
    for (const record of open) {
      const chatId = record.scope?.channel ?? null;
      const closing: Record<string, Untyped> = { opId: record.opId, placeId: chatId, reconciled: true };
      for (const key of OP_FIELDS) if (key !== 'placeId' && key in record) closing[key] = record[key];
      let match = null;
      if (record.name === 'post' && chatId && record.intent && typeof fetchOwnMessages === 'function') {
        const messages = await ownMessagesOnce(fetches, fetchOwnMessages, chatId);
        const startedAt = Date.parse(String(record.occurredAt));
        const replyTo = record.intent.replyTo ?? null;
        match =
          (Array.isArray(messages) ? messages : []).find((message) => {
            if (!message || typeof message.id !== 'string' || used.has(message.id)) return false;
            if ((message.replyToId ?? null) !== replyTo) return false;
            if (intentText(message.content) !== record.intent.text) return false;
            const createdAt = timeOf(message.createdAt);
            return createdAt === null || !isFiniteNumber(startedAt) || createdAt >= startedAt - RECONCILE_SKEW_MS;
          }) ?? null;
      }
      if (match) {
        used.add(match.id);
        counts.succeeded += 1;
        await write(placeId, 'action', { ...closing, phase: 'succeeded', result: { messageId: match.id } });
      } else {
        counts.unknown += 1;
        await write(placeId, 'action', { ...closing, phase: 'unknown' });
      }
    }
    return counts;
  }

  /**
   * Run `fn` with every journal write held back, and the record's and the archive's appends too
   * (they wait on `waitUnlocked` through their `writerGate`): the lock waits for one already
   * held, the append store and every `lockStores` store flush (queued lines retried, files
   * fsynced), then `fn` runs; lines written meanwhile wait and land after it in
   * their order. The lock is released however `fn` ends; its
   * result or rejection is passed on.
   */
  async function withWriterLock<TResult>(fn: () => Promise<TResult> | TResult): Promise<TResult> {
    // Checked again right before taking it: another caller may have taken it meanwhile.
    while (held) await held;
    let release: (() => void) | undefined;
    held = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      if (typeof appendStore?.flush === 'function') await appendStore.flush();
      for (const other of Array.isArray(lockStores) ? lockStores : []) {
        if (typeof other?.flush === 'function') await other.flush();
      }
      return await fn();
    } finally {
      held = null;
      release?.();
    }
  }

  const stalled = () => typeof appendStore?.stats === 'function' && appendStore.stats()?.stalled === true;

  /**
   * At start: a `.running` marker left by a run that never stopped cleanly writes an
   * `unclean-stop` system record first; then the marker is written for this run.
   */
  async function markRunning(): Promise<{ unclean: boolean }> {
    const file = runningFile();
    let unclean = false;
    try {
      await fs.stat(file);
      unclean = true;
    } catch (error) {
      if (propOf(error, 'code') !== 'ENOENT') throw error;
    }
    if (unclean) await system({ event: 'unclean-stop' });
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify({ startedAt: new Date(now()).toISOString() })}\n`);
    return { unclean };
  }

  /** On a clean stop: the `.running` marker goes. */
  async function clearRunning() {
    await fs.rm(runningFile(), { force: true });
  }

  async function stats(placeId: string, { now: at = now() } = {}) {
    const keys = [at, at - DAY_MS].map((ms) => placeOrPersona('journal', placeId, { partition: utcDay(ms) }));
    return {
      lastWriteMs: seam.run(() => journalLastWrite(seam.db(), keys)),
    };
  }

  return {
    start,
    turn,
    action,
    actionLine: (placeId, record) => ({ placeId, line: lineOf('action', record) }),
    memory,
    system,
    answer,
    inner,
    read,
    timeline,
    stats,
    triggerLinks,
    callMarks,
    findTurn,
    dayFile,
    op,
    pending,
    turnOperations,
    reconcile,
    stalled,
    markRunning,
    clearRunning,
    withWriterLock,
    waitUnlocked: unlocked,
  };
}
