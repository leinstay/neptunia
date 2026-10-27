// The persona's journal: one record per thing that happened -- a turn started, a turn
// ended (what it saw, what it thought, what it posted), an action's phase, a memory change, a
// system event -- written to the memory database (src/memory/db/service.js, `memoryDb.writeUnit`) in
// the unit of its day, `guilds/<g>/journal/<YYYY-MM-DD>.jsonl`, as the journal mapper maps it, so it
// keeps its order. The day is the UTC day of the record's `occurredAt`; a private chat has its own
// units under the partner's private directory and is never written to the guild's journal. Every record carries the same envelope (`v`, `id`,
// `kind`, `occurredAt`, `recordedAt`, `guildId`, `scope`, `participants`, `sourceMessageIds`,
// `origin`); a record missing a list is written with an empty one, never rejected: a journal
// line lost to validation is worse than an incomplete one. The model's `think` is stored
// capped at `journal.thinkChars`, never shown back to it.
//
// Every side effect is an operation with its own `opId` (`op`): a `started` line before the
// call, one closing line after it (`succeeded`, `failed` or `unknown`). After a restart the
// operations of the last days left without a closing line are reconciled (`reconcile`): a
// post is looked for among the persona's last own messages of its channel by the message it
// replied to and the first INTENT_CHARS characters of its text; nothing is ever sent again.
//
// A `.running` marker in the guild's journal directory (an operational file), written at start and
// removed on a clean stop (`markRunning` / `clearRunning`), lets the next start record an `unclean-stop`.
//
// Request dumps (`dumpRequest`): beside the journal, `requests/<day>/<turnId>-<attempt>.json` holds the
// request as the client sent it (a tool-loop step's or the follow-up's request after a call, the
// same shape with its `step`, `<turnId>-<attempt>-s<step>.json`) (system string and message parts, pictures reduced to their size)
// with the model's raw answer and its usage, written whole through a `.tmp` file and a rename
// (not the append store: it is one document, not a line). Written only while
// `journal.keepRequests` is above 0; `pruneRequests` deletes the day directories older than that
// many days, a private chat's included. A dump is a debugging copy: it may hold the chat's text.
//
// `withWriterLock(fn)` (`/nep memory snapshot`) holds every new line back while `fn` runs, after
// the append stores flushed what they had: the journal's own lines and request dumps here, and the
// record's and the archive's appends, which wait on `waitUnlocked` (src/memory/record.js,
// src/memory/archive.js `writerGate`; the append stores are flushed through `lockStores`). A copy of
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
// the same way, so her lines keep showing what she called and how it went.
//
// Which turn posted one of her messages (`findTurn`, `turnOfMessage`, shown by `turnView`): for
// `/nep memory journal message:`, the turn record whole, its think included.
//
// Logs carry the kind and an error code, never the record's contents.

import path from 'node:path';
import * as nodeFs from 'node:fs/promises';
import { createHash, randomUUID } from 'node:crypto';
import { log as defaultLog } from '../log.js';
import { clampText, oneLine } from './clamp.js';
import { memoryRootOf } from './root.js';
import { createReadSeam } from './db/readers/common.js';
import { journalLastWrite, journalLines } from './db/readers/journal.js';
import { DAY_MS, HOUR_MS, MINUTE_MS, utcDay } from '../time.js';
import { currentToolName } from '../tools/definitions.ts';

/** The schema version every record carries. */
export const JOURNAL_VERSION = 1;

const DEFAULT_THINK_CHARS = 4000;
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
const OP_FIELDS = ['turnId', 'name', 'by', 'channelId', 'privateUserId', 'participants', 'sourceMessageIds', 'dryRun'];
/** A member id usable as a directory name. */
const USER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** A request-dump directory's name. */
const REQUEST_DAY_RE = /^\d{4}-\d{2}-\d{2}$/;
/** The characters of `think` a `/nep journal` line shows. */
export const LINE_THINK_CHARS = 80;

/** The hash a dump names a stored `tools` array by: sha256 of its JSON, hex. */
export function toolsHashOf(tools) {
  return createHash('sha256').update(JSON.stringify(tools)).digest('hex');
}

/**
 * One record as a short owner-facing line: `HH:MM:SS kind <short>` (the UTC clock of
 * `occurredAt`). A turn: `mode outcome <n> msgs, think: <first 80 characters>`; a turn start:
 * `mode trigger`; an action: `name phase`; a memory record: `batch <n> lines, users <k>, episodes
 * <e>`; a system event: `event by note`; an answer record: `event reason verdict outcome`
 * (what is present).
 * @param {object} record
 * @returns {string}
 */
export function journalLine(record) {
  const at = typeof record?.occurredAt === 'string' ? record.occurredAt.slice(11, 19) : '--:--:--';
  const kind = String(record?.kind ?? '?');
  const words = (...parts) => parts.filter((part) => part !== null && part !== undefined && part !== '').join(' ');
  const count = (value) => (Array.isArray(value) ? value.length : 0);
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
    const lines = Number.isFinite(record.batch?.consumed) ? record.batch.consumed : count(record.batch?.messageIds);
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
 * @param {unknown} text
 * @returns {string}
 */
export function intentText(text) {
  return Array.from(typeof text === 'string' ? text : '')
    .slice(0, INTENT_CHARS)
    .join('');
}

/** An epoch-ms time of a message's `createdAt` (a number, a Date or an ISO string), else null. */
function timeOf(value) {
  if (Number.isFinite(value)) return value;
  if (value instanceof Date) return value.getTime();
  const parsed = typeof value === 'string' ? Date.parse(value) : NaN;
  return Number.isFinite(parsed) ? parsed : null;
}

/** Distinct non-empty strings of `value` (an array), in order; anything else -> []. */
function idList(value) {
  if (!Array.isArray(value)) return [];
  const out = [];
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
/** `journal.offWindowHours`' fallback (config.json carries the same). */
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
 * count; at most `max`, newest first. Pure.
 * @param {Array<{ at: number, kind: string, event?: string|null }>} timeline
 * @param {{ now: number, windowMs: number, max?: number }} options
 * @returns {Array<{ kind: 'paused'|'stopped', from: number, to: number }>}
 */
export function offPeriods(timeline, { now, windowMs, max = OFF_PERIODS_MAX }) {
  const entries = (Array.isArray(timeline) ? timeline : [])
    .filter((entry) => Number.isFinite(entry?.at))
    .map((entry, i) => ({ entry, i }))
    .sort((a, b) => a.entry.at - b.entry.at || a.i - b.i)
    .map(({ entry }) => entry);
  const found = [];
  let pausedAt = null;
  let stoppedAt = null;
  let lastAt = null;
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
  const merged = [];
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
    .filter((period) => period.to >= now - windowMs && period.to <= now)
    .sort((a, b) => b.to - a.to)
    .slice(0, max)
    .map(({ kind, from, to }) => ({ kind, from, to }));
}

/**
 * The off periods of a guild's last `windowHours` hours (`journal.offWindowHours`), read through
 * `journal.timeline` and reused for a minute per guild and window, so a busy channel does not read
 * the day files every turn. A read that fails gives no period and one warn (`journal: off periods
 * unread`, the guild and the error code); no journal, or one without `timeline`, gives none.
 * @param {{ journal: { timeline: Function }|null, now?: () => number, log?: { warn: Function } }} options
 * @returns {(guildId: string, options?: { windowHours?: number }) => Promise<Array<{ kind: string, from: number, to: number }>>}
 */
export function createOffPeriodsReader({ journal, now = Date.now, log = defaultLog }) {
  const cache = new Map(); // `${guildId}:${hours}` -> { at, periods }
  return async function read(guildId, { windowHours } = {}) {
    if (!journal || typeof journal.timeline !== 'function' || !guildId) return [];
    const hours = Number.isFinite(windowHours) && windowHours > 0 ? windowHours : DEFAULT_OFF_WINDOW_HOURS;
    const at = now();
    const key = `${guildId}:${hours}`;
    const cached = cache.get(key);
    if (cached && at - cached.at >= 0 && at - cached.at < OFF_CACHE_MS) return cached.periods;
    const windowMs = hours * HOUR_MS;
    let periods = [];
    try {
      periods = offPeriods(await journal.timeline(guildId, { from: at - windowMs }), { now: at, windowMs });
    } catch (error) {
      log.warn('journal: off periods unread', { guildId: String(guildId), code: error?.code ?? null });
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
 * A turn without a trigger (a spontaneous turn, the diary) or whose `turn.start` is not among the
 * records links nothing. `[postedId, triggerId]` pairs in the order of the posts. Pure.
 * @param {unknown[]} records
 * @returns {Array<[string, string]>}
 */
export function triggerLinksOf(records) {
  const list = Array.isArray(records) ? records : [];
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
  const out = [];
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
function postedIdOf(post) {
  const id = typeof post === 'string' ? post : post?.messageId;
  return typeof id === 'string' && id ? id : null;
}

/** The `messageId` a `succeeded` action line's result names, else null. */
function succeededIdOf(record) {
  const id = record?.kind === 'action' && record.phase === 'succeeded' ? record.result?.messageId : null;
  return typeof id === 'string' && id ? id : null;
}

/** A call result's status as a closing line keeps it (`ok`, `not_configured`, ...). */
const CALL_STATUS_RE = /^[a-z_]{1,32}$/;

/**
 * The persona's skill calls, from journal records (parsed lines, any kinds, oldest first), for
 * the call marks of her transcript lines (src/format.js#withCalls): every `skill`
 * operation of a guild channel as `{ channelId, at, skill, status, target, postedId, posted }` --
 * `channelId` the channel of its turn (the operation's scope), `at` the time of its last line
 * (epoch ms), `skill` its `input.skill`, `status` the closing line's: `ok` for `succeeded`,
 * `unknown` for `unknown`, a `failed` line's `result.status` (`failed` when it has none: an older
 * line), `unknown` with no closing line; `code` and `reason` of a `failed` or `unknown` closing
 * line's `result`, each only when that line has it (src/tools/executors.ts#outcomeDetail reads
 * them); `target` its `started` line's ids (`{ messageId, channelId
 * }`: `message`, else `reply`; null fields when unknown), `postedId` the message it posted
 * (`succeeded` with a `messageId`), `posted` every message its turn posted (its `turn` records'
 * `posted` and its operations' succeeded ids, once each, in order). `postedFrom`: `[postedId,
 * channelId]` for a call that posted in another channel than its turn's. Pure.
 * @param {unknown[]} records
 * @returns {{ calls: object[], postedFrom: Array<[string, string]> }}
 */
export function callMarksOf(records) {
  const list = Array.isArray(records) ? records.filter((record) => record && typeof record === 'object') : [];
  const text = (value) => (typeof value === 'string' && value ? value : null);
  const postedByTurn = new Map(); // turnId -> message ids, in order
  const addPosted = (turnId, id) => {
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
      channelId: null,
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
    op.channelId = text(record.scope?.channel) ?? op.channelId;
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
    const at = Date.parse(record.occurredAt);
    if (Number.isFinite(at)) op.at = at;
    ops.set(record.opId, op);
  }
  const calls = [];
  const postedFrom = [];
  for (const op of ops.values()) {
    if (!op.channelId || !op.skill) continue;
    const target = {
      messageId: text(op.target?.message) ?? text(op.target?.reply),
      channelId: text(op.target?.channel),
    };
    calls.push({
      channelId: op.channelId,
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
    if (op.postedId && target.channelId && target.channelId !== op.channelId)
      postedFrom.push([op.postedId, op.channelId]);
  }
  return { calls, postedFrom };
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
 * @param {unknown[]} records
 * @param {string} messageId
 * @returns {{ turn: object, start: object|null, posted: string[], calls: object[] }|null}
 */
export function turnOfMessage(records, messageId) {
  const list = Array.isArray(records) ? records.filter((record) => record && typeof record === 'object') : [];
  const id = String(messageId ?? '');
  if (!id) return null;
  const turns = list.filter((record) => record.kind === 'turn' && typeof record.turnId === 'string');
  let turn =
    turns.find((record) => Array.isArray(record.posted) && record.posted.some((post) => postedIdOf(post) === id)) ??
    null;
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
  const mine = (record) =>
    record.kind === 'action' &&
    record.turnId === turn.turnId &&
    (!Array.isArray(turn.actions) || turn.actions.includes(record.opId));
  const ops = list.filter(mine);
  const posted = [];
  const add = (postedId) => {
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
    if (Array.isArray(record.input?.args)) call.args = record.input.args.filter((name) => typeof name === 'string');
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
 * when it was cut at `journal.thinkChars` on the way in). Multi-line text. Pure.
 * @param {{ turn: object, start?: object|null, posted?: string[], calls?: object[] }} found
 * @returns {string}
 */
export function turnView({ turn, start = null, posted = [], calls = [] }) {
  const text = (value) => (typeof value === 'string' && value ? value : '-');
  const channel = turn.scope?.channel ?? (turn.scope?.private ? 'private' : null);
  const trigger = start?.trigger ?? null;
  const callText = (call) => {
    const target = call.target
      ? Object.entries(call.target)
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
    `turn ${text(turn.turnId)} (attempt ${Number.isInteger(turn.attemptId) ? turn.attemptId : '-'})`,
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

/** The record's scope: the partner's private layer, a channel, or the whole guild. */
function scopeOf({ privateUserId = null, channelId = null } = {}) {
  if (typeof privateUserId === 'string' && privateUserId) return { user: privateUserId, private: true };
  if (typeof channelId === 'string' && channelId) return { channel: channelId };
  return { guild: true };
}

/**
 * Create the journal.
 *
 * @param {object} options
 * @param {{ append?: Function, iterate?: Function, flush?: Function, stats?: Function }|null} [options.appendStore]  src/memory/append-store.js, optional:
 *   flushed by `withWriterLock`; its `stats().stalled` is `stalled()`
 * @param {string} options.dataDir  the `data/` directory
 * @param {() => ({ thinkChars?: number }|undefined)} [options.config]  the live `journal` config
 *   section, read at each write (`hot.config.journal`)
 * @param {() => number} [options.now=Date.now]
 * @param {() => string} [options.uuid=randomUUID]
 * @param {{ warn: Function }} [options.log]
 * @param {object} [options.fs]  a `node:fs/promises`-shaped API (the `.running` marker and the request dumps)
 * @param {Array<{ flush: Function }>} [options.lockStores]  other append stores `withWriterLock`
 *   flushes before `fn` (the record's and the archive's, src/index.js)
 * @param {object|null} options.memoryDb  the memory database service (src/memory/db/service.js): the day reads
 *   (`read`, `timeline`, and so `findTurn`, `turnOperations`, `pending`, `triggerLinks`, `callMarks`,
 *   `reconcile`'s scan) and `stats` are answered from it (src/memory/db/readers/journal.js; a failed read rejects
 *   with a code), and every line the writers write goes to it as the journal mapper maps it (`day`, `decisions`,
 *   her answers' `sources`, `affinity_events`, in the day's unit, `memoryDb.writeUnit`): the request dumps and the
 *   `.running` marker stay files.
 * @returns {{
 *   start(guildId: string, input: { channelId?: string, mode?: string, trigger?: object|null,
 *     participants?: string[], sourceMessageIds?: string[], privateUserId?: string|null,
 *     turnId?: string, attemptId?: number }): { turnId: string, attemptId: number, startedAt: string },
 *   turn(guildId: string, record: object): Promise<void>,
 *   action(guildId: string, record: object): Promise<void>,
 *   memory(guildId: string, record: object): Promise<void>,
 *   system(guildId: string, record: object): Promise<void>,
 *   answer(guildId: string, record: object): Promise<void>,
 *   read(guildId: string, query: { day: string, kind?: string, n?: number, privateUserId?: string|null }): Promise<object[]>,
 *   timeline(guildId: string, query: { from: number }): Promise<Array<{ at: number, kind: string, event: string|null }>>,
 *   triggerLinks(guildId: string, query: { days: string[] }): Promise<Array<[string, string]>>,
 *   callMarks(guildId: string, query: { days: string[] }): Promise<{ calls: object[], postedFrom: Array<[string, string]> }>,
 *   findTurn(guildId: string, query: { messageId: string, at: number }): Promise<{ turn: object, start: object|null,
 *     posted: string[], calls: object[] }|null>,
 *   dayFile(guildId: string, dateIso: string, privateUserId?: string|null): string,
 *   op(guildId: string, base: object): { opId: string, proposed(extra?: object): Promise<void>, started(extra?: object): Promise<void>,
 *     succeeded(result?: object): Promise<void>, failed(code: string, result?: object): Promise<void>,
 *     unknown(result?: object): Promise<void> },
 *   pending(guildId: string, query: { day?: string, days?: string[], before?: number }): Promise<Array<{ opId: string,
 *     turnId: string|null, name: string|null, intent: object|null, channelId: string|null }>>,
 *   turnOperations(guildId: string, query: { turnId: string, days: string[], privateUserId?: string|null }): Promise<Array<{ opId: string,
 *     name: string|null, by: string|null, phase: 'succeeded'|'failed'|'unknown'|'open'|'proposed', skill: string|null, text: string|null,
 *     dryRun: boolean, shadow: boolean }>>,
 *   reconcile(guildId: string, options: { days: string[], before?: number, fetchOwnMessages: (channelId: string, n: number) =>
 *     Promise<Array<{ id: string, content: string, replyToId: string|null, createdAt: unknown }>> }):
 *     Promise<{ succeeded: number, unknown: number }>,
 *   stalled(): boolean,
 *   markRunning(guildId: string): Promise<{ unclean: boolean }>,
 *   clearRunning(guildId: string): Promise<void>,
 *   dumpRequest(guildId: string, dump: object): Promise<void>,
 *   pruneRequests(guildId: string): Promise<{ removed: number }>,
 *   withWriterLock<T>(fn: () => Promise<T>|T): Promise<T>,
 *   waitUnlocked(): Promise<void>,
 *   stats(guildId: string, query?: { now?: number }): Promise<{ lastWriteMs: number|null }>,
 * }}
 *   `stats` says when the guild journal was last written: the latest `recordedAt` of the lines of the day of `now`
 *   and the day before (the first hour after midnight); null when neither holds one.
 *   `start` writes a `turn.start` line (not awaited: a failed append is logged) and returns the
 *   turn's id: a new one, or `input.turnId` with `input.attemptId` for a later attempt of the
 *   same turn. The writers resolve once the database's writer committed the line and never reject (a
 *   refused write is logged as `journal: append failed` with its code). `read` returns the
 *   last `n` records of the day (of `kind` when given), newest last.
 *
 *   `op` allots an operation's `opId` (`op-<uuid>`) for one side effect; `base` holds its
 *   `turnId`, `name`, `by` (`persona` | `engine`), `channelId`, `privateUserId`,
 *   `participants`, `sourceMessageIds`, `input`, `intent` (a post's `{ replyTo, text }`, the
 *   text cut to INTENT_CHARS) and `dryRun`. `proposed(extra)` writes a `proposed` line (a skill
 *   call the persona asked for, before its checks; never pending without a `started` line);
 *   `started(extra)` writes the `started` line (`extra`
 *   adds fields known only then); the first of `succeeded(result)`, `failed(code, result)`
 *   (`result.code`) or `unknown(result)` writes the closing line, any later one is ignored.
 *   `pending` lists the guild journal's operations of `day` (or of every day of `days`) whose
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
  config = () => ({}),
  now = Date.now,
  uuid = randomUUID,
  log = defaultLog,
  fs = nodeFs,
  lockStores = [],
  memoryDb = null,
}) {
  const root = memoryRootOf(dataDir);
  const seam = createReadSeam({ memoryDb, log, reader: 'journal' });
  const guildDir = root.guildDir;
  function journalDir(guildId, privateUserId = null) {
    return typeof privateUserId === 'string' && privateUserId
      ? path.join(guildDir(guildId), 'private', privateUserId, 'journal')
      : path.join(guildDir(guildId), 'journal');
  }
  const runningFile = (guildId) => path.join(journalDir(guildId), '.running');

  function dayFile(guildId, dateIso, privateUserId = null) {
    const day = String(dateIso).match(DAY_RE)?.[0] ?? utcDay(now());
    return path.join(journalDir(guildId, privateUserId), `${day}.jsonl`);
  }

  function thinkLimit() {
    const value = config()?.thinkChars;
    return Number.isFinite(value) ? value : DEFAULT_THINK_CHARS;
  }

  /** `fields` wrapped in the envelope; `channelId` and `privateUserId` decide the scope, not stored twice. */
  function envelope(guildId, kind, fields) {
    const {
      channelId = null,
      privateUserId = null,
      participants,
      sourceMessageIds,
      occurredAt,
      ...rest
    } = fields ?? {};
    const at = new Date(now()).toISOString();
    return {
      record: {
        v: JOURNAL_VERSION,
        id: uuid(),
        kind,
        occurredAt: typeof occurredAt === 'string' && occurredAt ? occurredAt : at,
        recordedAt: at,
        guildId: String(guildId),
        scope: scopeOf({ privateUserId, channelId }),
        participants: idList(participants),
        sourceMessageIds: idList(sourceMessageIds),
        origin: 'live',
        ...rest,
      },
      privateUserId,
    };
  }

  // While a writer lock is held (withWriterLock), the promise it resolves on release; else null.
  let held = null;

  /** Wait until no writer lock is held. */
  async function unlocked() {
    while (held) await held;
  }

  async function write(guildId, kind, fields) {
    try {
      const { record, privateUserId } = envelope(guildId, kind, fields);
      await unlocked();
      const file = dayFile(guildId, record.occurredAt, privateUserId);
      if (typeof memoryDb?.writeUnit !== 'function')
        throw Object.assign(new Error('memory db: no writer'), { code: 'DB_CLOSED' });
      await memoryDb.writeUnit({ op: 'lines', owner: root.relative(file), lines: [record] });
    } catch (error) {
      log.warn('journal: append failed', { kind, code: error?.code ?? null, guildId: String(guildId) });
    }
  }

  function start(
    guildId,
    {
      channelId = null,
      mode = null,
      trigger = null,
      participants,
      sourceMessageIds,
      privateUserId = null,
      turnId = null,
      attemptId = null,
    } = {}
  ) {
    const id = typeof turnId === 'string' && turnId ? turnId : `t-${uuid()}`;
    const attempt = Number.isInteger(attemptId) && attemptId > 0 ? attemptId : 1;
    const startedAt = new Date(now()).toISOString();
    write(guildId, 'turn.start', {
      channelId,
      privateUserId,
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

  function turn(guildId, record) {
    const { think, ...rest } = record ?? {};
    const fields = { ...rest };
    if (typeof think === 'string') {
      const limit = thinkLimit();
      const cut = limit > 0 && Array.from(think.trim()).length > limit;
      fields.think = cut ? clampText(think, limit, { tolerance: 1 }) : think;
      if (cut) fields.thinkTruncated = true;
    } else {
      fields.think = null;
    }
    return write(guildId, 'turn', fields);
  }

  const action = (guildId, record) => write(guildId, 'action', record);
  const memory = (guildId, record) => write(guildId, 'memory', { ...record, channelId: null });
  const system = (guildId, record) => write(guildId, 'system', { ...record, channelId: null });
  const answer = (guildId, record) => write(guildId, 'answer', record);
  // The inner life's scheduler and turns (src/behavior/inner.ts): `event` `wake`, `turn`,
  // `capped`, `overflow`, `stale`, `no-channel`, `review-drawn`, `review-missed`, `errand-cost`,
  // `stopped`, `started`. Ids, codes, counts and costs only.
  const inner = (guildId, record) => write(guildId, 'inner', record);

  /** The names of `dir` (none when it is absent). */
  async function namesIn(dir) {
    try {
      return await fs.readdir(dir);
    } catch (error) {
      if (error?.code === 'ENOENT' || error?.code === 'ENOTDIR') return [];
      throw error;
    }
  }

  /** The lines (text) of one day's unit in the database. */
  function* dayLines(db, file) {
    for (const line of seam.run(() => journalLines(db, root.relative(file)))) yield line;
  }

  async function read(guildId, { day, kind = null, n = DEFAULT_READ_N, privateUserId = null } = {}) {
    const db = seam.db();
    const limit = Number.isInteger(n) && n > 0 ? n : DEFAULT_READ_N;
    const out = [];
    for (const line of dayLines(db, dayFile(guildId, day, privateUserId))) {
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
   * The guild journal's records from the UTC day of `from` (epoch ms) through today, oldest
   * first, each as `{ at, kind, event }` (`event` of a system record, else null): the times
   * offPeriods reads, nothing about anyone. A line's kind and time come from the envelope's head;
   * only a system line, or one whose head does not match, is parsed whole. A private journal is
   * not read.
   */
  async function timeline(guildId, { from } = {}) {
    const db = seam.db();
    const end = now();
    const start = Number.isFinite(from) ? Math.min(from, end) : end;
    const out = [];
    for (let day = Date.parse(`${utcDay(start)}T00:00:00Z`); day <= end; day += DAY_MS) {
      for (const line of dayLines(db, dayFile(guildId, utcDay(day)))) {
        const head = ENVELOPE_HEAD_RE.exec(line);
        let kind = head?.[1] ?? null;
        let occurredAt = head?.[2] ?? null;
        let event = null;
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
        const at = Date.parse(occurredAt);
        if (typeof kind === 'string' && Number.isFinite(at)) out.push({ at, kind, event });
      }
    }
    return out
      .map((entry, i) => ({ entry, i }))
      .sort((a, b) => a.entry.at - b.entry.at || a.i - b.i)
      .map(({ entry }) => entry);
  }

  /**
   * The guild journal's `[postedId, triggerId]` pairs of `days` (UTC day keys, oldest first;
   * triggerLinksOf over their `turn.start` and `turn` records, read in that order, so a turn that
   * closed the day after it started is joined). A private journal is not read.
   */
  async function triggerLinks(guildId, { days = [] } = {}) {
    const records = [];
    for (const day of Array.isArray(days) ? days : []) {
      for (const record of await read(guildId, { day, n: Number.MAX_SAFE_INTEGER })) {
        if (record.kind === 'turn.start' || record.kind === 'turn') records.push(record);
      }
    }
    return triggerLinksOf(records);
  }

  /**
   * The guild journal's skill calls of `days` (UTC day keys, oldest first; callMarksOf over their
   * `turn` and `action` records, read in that order). A private journal is not read.
   */
  async function callMarks(guildId, { days = [] } = {}) {
    const records = [];
    for (const day of Array.isArray(days) ? days : []) {
      for (const record of await read(guildId, { day, n: Number.MAX_SAFE_INTEGER })) {
        if (record.kind === 'turn' || record.kind === 'action') records.push(record);
      }
    }
    return callMarksOf(records);
  }

  /**
   * The turn that posted message `messageId` (turnOfMessage), sent at `at` (epoch ms, its
   * snowflake's time): searched in the guild journal's UTC day of `at` and the next (a turn
   * record is written when the turn ends, maybe after midnight); a turn found without its
   * `turn.start` there (one that started before midnight) has it looked for in the day before.
   * Null when none posted it. A private journal is not read.
   */
  async function findTurn(guildId, { messageId, at } = {}) {
    const id = typeof messageId === 'string' ? messageId : '';
    if (!id || !Number.isFinite(at)) return null;
    const records = [];
    for (const day of [utcDay(at), utcDay(at + DAY_MS)]) {
      for (const record of await read(guildId, { day, n: Number.MAX_SAFE_INTEGER })) {
        if (record.kind === 'turn.start' || record.kind === 'turn' || record.kind === 'action') records.push(record);
      }
    }
    const found = turnOfMessage(records, id);
    if (!found || found.start) return found;
    const before = await read(guildId, { day: utcDay(at - DAY_MS), kind: 'turn.start', n: Number.MAX_SAFE_INTEGER });
    return turnOfMessage([...before, ...records], id);
  }

  function op(guildId, base = {}) {
    const opId = `op-${uuid()}`;
    const { intent, ...rest } = base ?? {};
    const common = { ...rest, opId };
    if (intent && typeof intent === 'object') {
      common.intent = {
        replyTo: typeof intent.replyTo === 'string' && intent.replyTo ? intent.replyTo : null,
        text: intentText(intent.text),
      };
    }
    const closingBase = { opId };
    for (const key of OP_FIELDS) if (key in rest) closingBase[key] = rest[key];
    let closed = false;
    const close = (phase, result) => {
      if (closed) return Promise.resolve();
      closed = true;
      return write(guildId, 'action', { ...closingBase, phase, ...(result !== undefined ? { result } : {}) });
    };
    return {
      opId,
      proposed: (extra = {}) => write(guildId, 'action', { ...common, ...extra, opId, phase: 'proposed' }),
      started: (extra = {}) => write(guildId, 'action', { ...common, ...extra, opId, phase: 'started' }),
      succeeded: (result = {}) => close('succeeded', result),
      failed: (code, result = {}) =>
        close('failed', { ...result, code: typeof code === 'string' && code ? code : 'error' }),
      unknown: (result) => close('unknown', result),
    };
  }

  /**
   * The `started` action lines of `days` (guild journal) with no closing line in those days, in
   * order; with `before` (epoch ms) only those that started earlier.
   */
  async function openOperations(guildId, days, before = null) {
    const started = new Map();
    const closedIds = new Set();
    for (const day of days) {
      for (const record of await read(guildId, { day, kind: 'action', n: Number.MAX_SAFE_INTEGER })) {
        if (typeof record.opId !== 'string' || !record.opId) continue;
        if (record.phase === 'started' && !started.has(record.opId)) started.set(record.opId, record);
        else if (CLOSING_PHASES.has(record.phase)) closedIds.add(record.opId);
      }
    }
    const earlier = (record) => !Number.isFinite(before) || Date.parse(record.occurredAt) < before;
    return [...started.values()].filter((record) => !closedIds.has(record.opId) && earlier(record));
  }

  async function pending(guildId, { day = null, days = null, before = null } = {}) {
    const list = Array.isArray(days) ? days : [day ?? utcDay(now())];
    return (await openOperations(guildId, list, before)).map((record) => ({
      opId: record.opId,
      turnId: record.turnId ?? null,
      name: record.name ?? null,
      intent: record.intent ?? null,
      channelId: record.scope?.channel ?? null,
    }));
  }

  /**
   * The operations of one turn (`turnId`) in the journal of `days`, each `{ opId, name, by, phase, skill, text, dryRun, shadow }`:
   * `phase` is how it ended (`succeeded`, `failed`, `unknown`; `open` when it started and has no closing line; `proposed`
   * when it never started). `privateUserId` reads that member's private journal instead of the guild's.
   */
  async function turnOperations(guildId, { turnId, days, privateUserId = null } = {}) {
    const ops = new Map();
    if (typeof turnId !== 'string' || !turnId) return [];
    for (const day of Array.isArray(days) ? days : []) {
      for (const record of await read(guildId, { day, kind: 'action', n: Number.MAX_SAFE_INTEGER, privateUserId })) {
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

  /** The persona's last own messages of `channelId`, fetched once per reconciliation; null when the fetch failed. */
  function ownMessagesOnce(fetches, fetchOwnMessages, guildId, channelId) {
    if (!fetches.has(channelId)) {
      const fetching = Promise.resolve()
        .then(() => fetchOwnMessages(channelId, RECONCILE_FETCH))
        .catch((error) => {
          log.warn('journal: reconcile fetch failed', {
            code: error?.code ?? null,
            channelId,
            guildId: String(guildId),
          });
          return null;
        });
      fetches.set(channelId, fetching);
    }
    return fetches.get(channelId);
  }

  async function reconcile(guildId, { days, fetchOwnMessages, before = null } = {}) {
    const open = await openOperations(guildId, Array.isArray(days) ? days : [utcDay(now())], before);
    const fetches = new Map();
    const used = new Set();
    const counts = { succeeded: 0, unknown: 0 };
    for (const record of open) {
      const channelId = record.scope?.channel ?? null;
      const closing = { opId: record.opId, channelId, reconciled: true };
      for (const key of OP_FIELDS) if (key !== 'channelId' && key in record) closing[key] = record[key];
      let match = null;
      if (record.name === 'post' && channelId && record.intent && typeof fetchOwnMessages === 'function') {
        const messages = await ownMessagesOnce(fetches, fetchOwnMessages, guildId, channelId);
        const startedAt = Date.parse(record.occurredAt);
        const replyTo = record.intent.replyTo ?? null;
        match =
          (Array.isArray(messages) ? messages : []).find((message) => {
            if (!message || typeof message.id !== 'string' || used.has(message.id)) return false;
            if ((message.replyToId ?? null) !== replyTo) return false;
            if (intentText(message.content) !== record.intent.text) return false;
            const createdAt = timeOf(message.createdAt);
            return createdAt === null || !Number.isFinite(startedAt) || createdAt >= startedAt - RECONCILE_SKEW_MS;
          }) ?? null;
      }
      if (match) {
        used.add(match.id);
        counts.succeeded += 1;
        await write(guildId, 'action', { ...closing, phase: 'succeeded', result: { messageId: match.id } });
      } else {
        counts.unknown += 1;
        await write(guildId, 'action', { ...closing, phase: 'unknown' });
      }
    }
    return counts;
  }

  /** Days the request dumps are kept; 0 (or anything unusable) means none. */
  function keepRequests() {
    const value = config()?.keepRequests;
    return Number.isFinite(value) && value > 0 ? Math.floor(value) : 0;
  }

  /** The text of a system message's content (a string, or text parts joined). */
  function textOfContent(content) {
    if (typeof content === 'string') return content;
    if (!Array.isArray(content)) return '';
    return content.map((part) => (typeof part?.text === 'string' ? part.text : '')).join('');
  }

  /** One user-message part as stored: a picture becomes its size, a data: URL is never kept. */
  function dumpPart(part) {
    if (part?.type !== 'image_url') return part;
    const url = typeof part.image_url?.url === 'string' ? part.image_url.url : '';
    const comma = url.startsWith('data:') ? url.indexOf(',') : -1;
    const bytes = comma >= 0 ? Math.floor(((url.length - comma - 1) * 3) / 4) : null;
    return { image: typeof part.messageId === 'string' && part.messageId ? part.messageId : 'attachment', bytes };
  }

  /**
   * The messages after the first two as stored (`later`): role, content (a picture part reduced like
   * `dumpPart`), an assistant message's `tool_calls`, a tool message's `tool_call_id`, kept as sent.
   */
  function dumpLater(later) {
    return later.map((message) => {
      if (!message || typeof message !== 'object') return message;
      return Array.isArray(message.content) ? { ...message, content: message.content.map(dumpPart) } : { ...message };
    });
  }

  // The tool-definition copies written by this process (`requests/tools/<sha>.json`).
  const toolsWritten = new Set();

  /**
   * Write one request and its raw answer as `requests/<day>/<turnId>-<attemptId>.json` (the day
   * of now, UTC; with a `step`, a later request of the turn's tool loop or its follow-up,
   * `<turnId>-<attemptId>-s<step>.json` with `step` in the body) when `journal.keepRequests` is above 0. `request` is the client's message list
   * (`{ messages }`: the system message, then the user message) or `{ system, parts }`. With `tools`
   * (the array the request carried) the dump holds `tools` (its sha256, `toolsHashOf`) and `toolChoice`,
   * the array itself stored once as `requests/tools/<sha>.json`; `toolCalls` (the answer's) sit beside
   * `raw`. `later` (the messages after the first two: her assistant messages with their tool calls, the tool messages, appended user notes) is stored as `later`, pictures reduced; absent when there are none. Rejects on a disk error; the caller logs it.
   * @param {string} guildId
   * @param {{ turnId: string, attemptId?: number, step?: number|null, request: object, raw?: string, usage?: object|null, privateUserId?: string|null, tools?: object[]|null, toolChoice?: string|object|null, toolCalls?: object[]|null, later?: object[]|null }} dump
   * @returns {Promise<void>}
   */
  async function dumpRequest(
    guildId,
    {
      turnId,
      attemptId = 1,
      step = null,
      request,
      raw = '',
      usage = null,
      privateUserId = null,
      tools = null,
      toolChoice = null,
      toolCalls = null,
      later = null,
    } = {}
  ) {
    if (keepRequests() === 0) return;
    const messages = Array.isArray(request?.messages) ? request.messages : [];
    const system = typeof request?.system === 'string' ? request.system : textOfContent(messages[0]?.content);
    const userContent = Array.isArray(request?.parts) ? request.parts : messages[1]?.content;
    const parts = (Array.isArray(userContent) ? userContent : [{ type: 'text', text: textOfContent(userContent) }]).map(
      dumpPart
    );
    const at = new Date(now()).toISOString();
    const dir = path.join(journalDir(guildId, privateUserId), 'requests', utcDay(now()));
    const stepped = Number.isInteger(step) && step > 0;
    const file = path.join(dir, stepped ? `${turnId}-${attemptId}-s${step}.json` : `${turnId}-${attemptId}.json`);
    // A request that carried tools: the array is stored once per hash beside the day directories
    // (`requests/tools/<sha>.json`), the dump names it by that hash; the answer's tool calls sit beside `raw`.
    const withTools = Array.isArray(tools) && tools.length > 0;
    const toolsHash = withTools ? toolsHashOf(tools) : null;
    const body = JSON.stringify({
      v: JOURNAL_VERSION,
      turnId,
      attemptId,
      ...(stepped ? { step } : {}),
      recordedAt: at,
      system,
      parts,
      raw: typeof raw === 'string' ? raw : '',
      usage,
      ...(withTools ? { tools: toolsHash, toolChoice: toolChoice ?? 'auto' } : {}),
      ...(Array.isArray(toolCalls) && toolCalls.length > 0 ? { toolCalls } : {}),
      ...(Array.isArray(later) && later.length > 0 ? { later: dumpLater(later) } : {}),
    });
    await unlocked();
    if (withTools) {
      const toolsDir = path.join(journalDir(guildId, privateUserId), 'requests', 'tools');
      const toolsFile = path.join(toolsDir, `${toolsHash}.json`);
      // Written once per process and hash (the content is its name: a rewrite after a restart is harmless).
      if (!toolsWritten.has(toolsFile)) {
        await fs.mkdir(toolsDir, { recursive: true });
        await fs.writeFile(`${toolsFile}.tmp`, JSON.stringify(tools));
        await fs.rename(`${toolsFile}.tmp`, toolsFile);
        toolsWritten.add(toolsFile);
      }
    }
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(`${file}.tmp`, body);
    await fs.rename(`${file}.tmp`, file);
  }

  /**
   * Delete the request-dump day directories (the guild's and every private journal's) dated
   * earlier than `journal.keepRequests` days ago, by directory name; with 0 nothing is deleted.
   * @param {string} guildId
   * @returns {Promise<{ removed: number }>}
   */
  async function pruneRequests(guildId) {
    const keep = keepRequests();
    if (keep === 0) return { removed: 0 };
    const cutoff = utcDay(now() - keep * DAY_MS);
    let removed = 0;
    for (const root of await requestRoots(guildId)) {
      for (const name of await namesIn(root)) {
        if (!REQUEST_DAY_RE.test(name) || name >= cutoff) continue;
        await fs.rm(path.join(root, name), { recursive: true, force: true });
        removed += 1;
      }
    }
    return { removed };
  }

  /** The request-dump roots of the guild: its own, then every private journal's. */
  async function requestRoots(guildId) {
    const roots = [path.join(journalDir(guildId), 'requests')];
    for (const userId of await namesIn(path.join(guildDir(guildId), 'private'))) {
      if (USER_ID_RE.test(userId)) roots.push(path.join(journalDir(guildId, userId), 'requests'));
    }
    return roots;
  }

  /**
   * Run `fn` with every journal write held back, and the record's and the archive's appends too
   * (they wait on `waitUnlocked` through their `writerGate`): the lock waits for one already
   * held, the append store and every `lockStores` store flush (queued lines retried, files
   * fsynced), then `fn` runs; lines and request dumps written meanwhile wait and land after it in
   * their order. The lock is released however `fn` ends; its
   * result or rejection is passed on.
   * @template T
   * @param {() => Promise<T>|T} fn
   * @returns {Promise<T>}
   */
  async function withWriterLock(fn) {
    // Checked again right before taking it: another caller may have taken it meanwhile.
    while (held) await held;
    let release;
    held = new Promise((resolve) => {
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
      release();
    }
  }

  const stalled = () => typeof appendStore?.stats === 'function' && appendStore.stats()?.stalled === true;

  /**
   * At start: a `.running` marker left by a run that never stopped cleanly writes an
   * `unclean-stop` system record first; then the marker is written for this run.
   * @param {string} guildId
   * @returns {Promise<{ unclean: boolean }>}
   */
  async function markRunning(guildId) {
    const file = runningFile(guildId);
    let unclean = false;
    try {
      await fs.stat(file);
      unclean = true;
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
    if (unclean) await system(guildId, { event: 'unclean-stop' });
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, `${JSON.stringify({ startedAt: new Date(now()).toISOString() })}\n`);
    return { unclean };
  }

  /** On a clean stop: the `.running` marker goes. */
  async function clearRunning(guildId) {
    await fs.rm(runningFile(guildId), { force: true });
  }

  async function stats(guildId, { now: at = now() } = {}) {
    const files = [at, at - DAY_MS].map((ms) => dayFile(guildId, new Date(ms).toISOString()));
    const db = seam.db();
    return {
      lastWriteMs: seam.run(() =>
        journalLastWrite(
          db,
          files.map((file) => root.relative(file))
        )
      ),
    };
  }

  return {
    start,
    turn,
    action,
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
    dumpRequest,
    pruneRequests,
    withWriterLock,
    waitUnlocked: unlocked,
  };
}
