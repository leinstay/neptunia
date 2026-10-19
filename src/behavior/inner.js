// The persona's inner life, step 2 (docs/inner-life.md): a deterministic scheduler that lists
// what is due for her -- an intention whose time came, an errand she waits for that ran past its
// deadline, and one review a day at a random moment inside the hours she usually speaks in (drawn
// from her own `said` lines in the record, re-drawn every local day) -- and hands each as an
// `inner.wake` event through the core's event door (src/interface/door.js). Listing is not
// choosing: no model runs here, nothing ranks or invents a reason. A queued wake keeps its due
// time while people's turns hold the one attention; compatible wakes (the same conversation, and
// the day's review with any server one) coalesce into one inner turn; a queue past
// `innerLife.queueMax` records the overflow. The inner turn itself is the turn runner's
// (src/behavior/turn.js, mode `inner`): no human message, a `<wake>` block, her tools.
//
// Bounds are code, not prose (`innerLife.caps`, a ceiling the owner accepted): inner turns per
// local day and per rolling hour, per causal chain (an intention's `chainId`, else the intention
// itself; a review is its day's chain), public posts per local day. No bound is in dollars: what
// a turn and the errands it hands off cost is recorded (`state.spend`, the `errand-cost` journal
// event) and reported, never limited.
// A review's `<wake>` also tells her once which intentions of hers expired untouched since she was
// last told (`innerLife.review.expiredMax` newest, the rest counted; a candidate never): each is marked
// shown on its record once the review turn ran, so a held or erred review lists them again.
// Over a cap no turn runs and the refusal is journalled once per wake. What is left and when it
// resets reach her as facts in `<wake>`, never as a rule.
//
// Feedback on her own turn (docs/inner-life.md "Feedback on her own turn"): when an inner turn
// ends, `feedbackFacts` lists from its result what did not go through -- output she wrote outside
// a call and lost, calls that ended unknown or refused, an intention she closed as done while no
// delivery call went through, the loop cut with calls dropped, and a wake of hers the engine
// dropped (`no-channel`) or has held on a cap for over an hour. A non-empty list queues ONE
// `feedback` wake (`inner.wake:feedback:<turnId>`) in the turn's chain and conversation, due at
// the next tick, carrying the facts; a feedback turn's own misses are journalled only, never a
// second wake (no loops). The same facts ride the turn's memory episode (`episode.feedback`).
//
// A recurring intention (`every`, src/intentions/model.js) is advanced to its next occurrence
// whenever a wake naming it is marked handled -- her turn ended (whatever its outcome), or the
// engine dropped the wake (`no-channel`, `overflow`, `stale`, the chain cap, the stop) --
// through the intention service's `advance`: `recurred` when a call of the turn named it (the
// turn result's `inner.intentIds`), `missed` otherwise. Without a chain of its own each occurrence
// is its own chain (`intention:<id>:<dueAt>`), so the per-chain cap bounds one occurrence. The
// last occurrence before its expiry carries the note `last-occurrence` on its `<wake>` line.
//
// Her attention (docs/inner-life.md "Her attention"): an open intention of kind `attend`
// (src/intentions/model.js) names a place; the tick counts the place's lines in the record since
// her last look there -- her last own line in that place, or the last attend wake handled for
// that place, whichever is later, and never before the attention was set -- and, once the newest
// line is `settle` seconds old, lists one `attend` wake (`inner.wake:attend:<intentionId>:<newestLineId>`,
// each wake its own chain). One queued wake per attention: a newer burst replaces the queued wake's
// id and newest line, nothing observed lost (the turn's history is the place's lines). With
// `people` on the attention only their lines count and the wake names them. Past the attention's
// own `perDay` the wake waits in the queue (`capped: 'attend-per-day'`) like a wake past a cap of
// the day. The record is read incrementally (a per-guild place index over the last
// `innerLife.attention.lookbackHours`), the same store the review's hours come from; the same
// index feeds `places` (her `places.list` skill and the page in `<wake>`): per place the
// interface publishes (`places`, an injected directory of opaque addresses; nothing of the
// interface's own objects is read here), its lines and people since her last look there.
//
// `innerLife.mode`: `shadow` (the default) runs the turn with nothing leaving it -- her reads run,
// every other call is recorded as proposed -- and `live` lets her calls run through the gateway on
// her own grants. The kill switch (`/nep task inner action:stop`) is persisted with the state,
// drops the queue, and is asked again right before any external action of a running inner turn
// (`mayAct`). Off (`features.innerLife` not exactly true, read at every tick) nothing is listed and
// nothing is written. State per guild in `data/guilds/<id>/inner.json` (queue, handled ids, the
// day's review, the counters, the stop), written whole after every change, so a restart resumes;
// ticks missed while down coalesce into the first tick after it. Logs carry ids, codes and
// counts, never text.

import fs from 'node:fs';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { log as defaultLog, onLog } from '../log.js';
import { writeJsonAtomic } from '../memory/index.js';
import { DAY_MS, HOUR_MS, MINUTE_MS, zonedDay, zonedEpoch } from '../time.js';
import { localHour } from '../format.js';
import { attendCounter, expiredToShow, intentionsOn, isAttend, nextOccurrence } from '../intentions/model.js';
import { foldText } from '../memory/recent.js';
import { errorCodeOf } from '../llm/openrouter.js';

/** The wake kinds, as the `<wake>` block names them. */
export const WAKE_KINDS = Object.freeze(['intention_due', 'review', 'errand_deadline', 'attend', 'feedback']);

/** The defaults of the `innerLife` section (config.json carries the same). */
export const INNER_DEFAULTS = Object.freeze({
  mode: 'shadow',
  tickSeconds: 60,
  queueMax: 20,
  chatMessages: 30,
  review: Object.freeze({ enabled: true, historyDays: 14, expiredMax: 5 }),
  caps: Object.freeze({ perDay: 24, perHour: 4, perChain: 3, publicPostsPerDay: 2 }),
  attention: Object.freeze({ settleSeconds: 90, perDayDefault: 12, pageSize: 12, placesInWake: 8, lookbackHours: 24 }),
  loop: Object.freeze({ maxSteps: 4, timeBudgetMs: 180000, maxCallsPerStep: 4, callTimeoutMs: 60000 }),
  retry: Object.freeze({ delaysMinutes: Object.freeze([1, 5, 15, 60]), maxHours: 6 }),
});

/** The orders the places view knows (`places.list` `sort=`). */
export const PLACE_SORTS = Object.freeze(['recent', 'name', 'lines']);
/** The wake id prefix of an attend wake (its intention and newest line follow). */
const ATTEND_PREFIX = 'inner.wake:attend:';
/** The outcomes of a wake the engine dropped, told to her once at her next turn (`wakeDropped`'s code is the outcome). */
/** The error codes of a failed turn whose wakes are retried; any other error is handled as an ended turn. */
const RETRY_CODES = new Set(['provider-limit', 'provider-error', 'timeout']);
const DROP_TOLD = new Set(['no-channel', 'provider']);
/** How far behind the last scan the record is read again (a line appended late is still seen; ids de-duplicate). */
const SCAN_LAG_MS = 5 * MINUTE_MS;

/** The state file's schema version. */
const VERSION = 1;
/** How long a turn, a spend or a post is kept in the state (the longest window is a day). */
const KEEP_MS = 2 * DAY_MS;
/**
 * How long a chain's count and a handled wake id are kept: longer than an intention lives
 * (`intentions.expiresDays`), so a due item she left alone never wakes her a second time.
 */
const CHAIN_KEEP_MS = 30 * DAY_MS;
/** The inner turn ids kept, so an errand one of them handed off counts its cost when it ends. */
const TURN_IDS_MAX = 100;
/** The channels of her recent lines a review remembers, newest first. */
const REVIEW_CHANNELS_MAX = 3;
/** The outcomes of runTurn that mean the turn never ran: the wake waits. */
const HELD = new Set(['busy', 'paused']);
/** The outcomes of runTurn that mean a turn ran for the wake (src/behavior/turn.js#TurnOutcome less the held ones). */
const TURN_OUTCOMES = new Set(['spoke', 'skip', 'refused', 'not-now', 'error']);
/** The skills that post where people read (a public post counts against `publicPostsPerDay`). */
export const POSTING_SKILLS = Object.freeze(['message.create', 'draw.create', 'diary.post']);
/** The calls that deliver something out of an inner turn: a post, a picture, an errand, a diary entry. */
export const DELIVERY_SKILLS = Object.freeze(['message.create', 'draw.create', 'task.run', 'diary.post']);
/** The kinds of feedback facts, as `labels.wake.feedback.<kind>` names them. */
export const FEEDBACK_KINDS = Object.freeze(['callFailed', 'doneWithoutDelivery', 'loopCut', 'wakeDropped']);
/** How long a capped wake waits before it is a feedback fact. */
const WAKE_HELD_MS = HOUR_MS;

/**
 * What did not go through in one inner turn, from its result (src/behavior/turn.js's
 * `{ outcome, inner: { actions, intentIds, loop } }`), as a list of facts, each
 * `{ kind, ... }` (FEEDBACK_KINDS), in this order: one `callFailed` per call that ended `unknown`, `timeout` or refused
 * (`skill`, `status`, `code`; a tag of hers refused by the gate is the `message.create` it was lowered into); one `doneWithoutDelivery` per intention an executed `intent.update`
 * closed as done (`state` `done` on the action, its `intentionId`, else the one id in `named`)
 * while no delivery call (`posting`, DELIVERY_SKILLS) was executed in the turn (`named` defaults
 * to the result's `inner.intentIds`; `intentionId`,
 * `purpose` from `intentions` when known); `loopCut` when the loop ended by its step or time
 * bound with calls dropped (`cut`, `droppedCalls`, `steps`); one `wakeDropped` per entry of
 * `wakes` (the caller's: wakes of hers dropped `no-channel` or held on a cap over an hour, each
 * `{ id, kind, code, intentionIds }`; `intentionId`, `purpose` from `intentions`). [] when
 * nothing is wrong. Pure.
 * @param {object|null} turnResult
 * @param {{ wakes?: object[], named?: string[], posting?: readonly string[], intentions?: object[] }} [options]
 * @returns {object[]}
 */
export function feedbackFacts(turnResult, { wakes = [], named = null, posting = DELIVERY_SKILLS, intentions = [] } = {}) {
  const inner = turnResult?.inner ?? {};
  const actions = list(inner.actions);
  const facts = [];
  const purposeOf = (id) => {
    const record = list(intentions).find((item) => item && String(item.id) === String(id));
    return typeof record?.purpose === 'string' ? record.purpose : '';
  };
  for (const action of actions) {
    if (!action || typeof action.skill !== 'string') continue;
    const failed = action.status === 'refused' || action.result === 'unknown' || action.result === 'timeout' || action.code === 'timeout';
    if (!failed) continue;
    const status = action.status === 'refused' ? 'refused' : action.result === 'timeout' || action.code === 'timeout' ? 'timeout' : 'unknown';
    facts.push({ kind: 'callFailed', skill: action.skill, status, code: typeof action.code === 'string' && action.code ? action.code : null });
  }
  const delivered = actions.some((action) => action?.status === 'executed' && action.result === 'ok' && posting.includes(action.skill));
  if (!delivered) {
    const ids = list(named ?? inner.intentIds).map(String);
    const closed = [];
    for (const action of actions) {
      if (action?.skill !== 'intent.update' || action.status !== 'executed' || action.result !== 'ok' || action.state !== 'done') continue;
      const id = typeof action.intentionId === 'string' && action.intentionId ? action.intentionId : ids.length === 1 ? ids[0] : null;
      if (id && !closed.includes(id)) closed.push(id);
    }
    for (const id of closed) facts.push({ kind: 'doneWithoutDelivery', intentionId: id, purpose: purposeOf(id) });
  }
  const loop = inner.loop;
  if (loop && typeof loop.cut === 'string' && loop.cut && Number.isFinite(loop.droppedCalls) && loop.droppedCalls > 0) {
    facts.push({ kind: 'loopCut', cut: loop.cut, droppedCalls: loop.droppedCalls, steps: Number.isFinite(loop.steps) ? loop.steps : 0 });
  }
  for (const wake of list(wakes)) {
    if (!wake || typeof wake.id !== 'string') continue;
    const intentionId = list(wake.intentionIds).map(String)[0] ?? null;
    facts.push({ kind: 'wakeDropped', id: wake.id, wake: typeof wake.kind === 'string' ? wake.kind : null, code: typeof wake.code === 'string' ? wake.code : null, intentionId, purpose: intentionId ? purposeOf(intentionId) : '' });
  }
  return facts;
}

/** Whether the inner life runs (`features.innerLife` exactly true). */
export function innerOn(config) {
  return config?.features?.innerLife === true;
}

const count = (value, fallback) => (Number.isFinite(value) && value >= 0 ? value : fallback);
/** A whole number of at least `min`, else `fallback`. */
const whole = (value, fallback, min = 1) => (Number.isInteger(value) && value >= min ? value : fallback);
/** A positive finite number, else `fallback`. */
const positive = (value, fallback) => (typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback);

/**
 * The `innerLife` section with every number checked against INNER_DEFAULTS (a missing or bad value
 * takes the default). `mode` is `live` only when it says so exactly. `loop`: the tool loop's
 * bounds of an inner turn (src/behavior/turn.js#loopSettings with `inner`; nobody waits for
 * one, so its budget is generous): `maxSteps`, `timeBudgetMs`, `maxCallsPerStep` as
 * `skills.loop`'s, `callTimeoutMs` the most one call of hers may run.
 * @param {object} config
 */
export function innerSettings(config) {
  const raw = config?.innerLife ?? {};
  const caps = raw.caps ?? {};
  const review = raw.review ?? {};
  const attention = raw.attention ?? {};
  const loop = raw.loop ?? {};
  const retry = raw.retry ?? {};
  const d = INNER_DEFAULTS;
  return {
    mode: raw.mode === 'live' ? 'live' : 'shadow',
    tickSeconds: Math.max(1, count(raw.tickSeconds, d.tickSeconds)),
    queueMax: Math.max(1, Math.floor(count(raw.queueMax, d.queueMax))),
    chatMessages: Math.max(1, Math.floor(count(raw.chatMessages, d.chatMessages))),
    review: { enabled: review.enabled !== false, historyDays: Math.max(1, count(review.historyDays, d.review.historyDays)), expiredMax: Math.floor(count(review.expiredMax, d.review.expiredMax)) },
    caps: {
      perDay: Math.floor(count(caps.perDay, d.caps.perDay)),
      perHour: Math.floor(count(caps.perHour, d.caps.perHour)),
      perChain: Math.floor(count(caps.perChain, d.caps.perChain)),
      publicPostsPerDay: Math.floor(count(caps.publicPostsPerDay, d.caps.publicPostsPerDay)),
    },
    attention: {
      settleSeconds: count(attention.settleSeconds, d.attention.settleSeconds),
      perDayDefault: Math.max(1, Math.floor(count(attention.perDayDefault, d.attention.perDayDefault))),
      pageSize: Math.max(1, Math.floor(count(attention.pageSize, d.attention.pageSize))),
      placesInWake: Math.floor(count(attention.placesInWake, d.attention.placesInWake)),
      lookbackHours: Math.max(1, count(attention.lookbackHours, d.attention.lookbackHours)),
    },
    loop: {
      maxSteps: whole(loop.maxSteps, d.loop.maxSteps),
      timeBudgetMs: positive(loop.timeBudgetMs, d.loop.timeBudgetMs),
      maxCallsPerStep: whole(loop.maxCallsPerStep, d.loop.maxCallsPerStep),
      callTimeoutMs: positive(loop.callTimeoutMs, d.loop.callTimeoutMs),
    },
    // A failed turn's wakes come back after the next of these delays while the first failure is younger than maxHours.
    retry: {
      delaysMinutes: Array.isArray(retry.delaysMinutes) && retry.delaysMinutes.length > 0 && retry.delaysMinutes.every((m) => positive(m, 0) > 0) ? [...retry.delaysMinutes] : [...d.retry.delaysMinutes],
      maxHours: positive(retry.maxHours, d.retry.maxHours),
    },
  };
}

/** A fresh state. */
export function emptyState() {
  return { v: VERSION, stopped: false, stoppedAt: null, stoppedBy: null, queue: [], handled: {}, review: null, turns: [], spend: [], posts: [], chains: {}, turnIds: [] };
}

const list = (value) => (Array.isArray(value) ? value : []);
const object = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});

/** A state read from disk made whole (a missing part empty). */
export function normalizeState(raw) {
  const base = emptyState();
  if (!raw || typeof raw !== 'object') return base;
  return {
    ...base,
    stopped: raw.stopped === true,
    stoppedAt: Number.isFinite(raw.stoppedAt) ? raw.stoppedAt : null,
    stoppedBy: typeof raw.stoppedBy === 'string' ? raw.stoppedBy : null,
    queue: list(raw.queue).filter((wake) => wake && typeof wake.id === 'string' && WAKE_KINDS.includes(wake.kind)),
    handled: object(raw.handled),
    review: raw.review && typeof raw.review.day === 'string' ? raw.review : null,
    turns: list(raw.turns).filter((turn) => Number.isFinite(turn?.at)),
    spend: list(raw.spend).filter((item) => Number.isFinite(item?.at) && Number.isFinite(item?.usd)),
    posts: list(raw.posts).filter(Number.isFinite),
    chains: object(raw.chains),
    turnIds: list(raw.turnIds).filter((id) => typeof id === 'string'),
  };
}

/**
 * `state` without what is older than its windows (handled ids, turns, spend, posts, idle chains).
 */
export function pruneState(state, now) {
  const since = now - KEEP_MS;
  const handled = Object.fromEntries(Object.entries(state.handled).filter(([, entry]) => Number.isFinite(entry?.at) && entry.at >= now - CHAIN_KEEP_MS));
  const chains = Object.fromEntries(Object.entries(state.chains).filter(([, entry]) => Number.isFinite(entry?.lastAt) && entry.lastAt >= now - CHAIN_KEEP_MS));
  return {
    ...state,
    handled,
    chains,
    turns: state.turns.filter((turn) => turn.at >= since),
    spend: state.spend.filter((item) => item.at >= since),
    posts: state.posts.filter((at) => at >= since),
    turnIds: state.turnIds.slice(-TURN_IDS_MAX),
  };
}

/** Where an intention lands: its destination, else the conversation it came from; and whether that is a private chat. */
function targetOf(intention) {
  const privateChat = intention?.provenance?.scope === 'dm';
  const channelId = privateChat ? (intention.provenance?.channelId ?? null) : (intention?.destination ?? intention?.provenance?.channelId ?? null);
  return { channelId: channelId ? String(channelId) : null, privateChat };
}

/**
 * The current channel of an inner turn for `group` (the coalesced wakes) and why it is that one,
 * chosen by the cause of the wake, never by recency: the first wake that is not a review is the
 * cause. An `intention_due` wake: the intention's destination when recorded, else the channel it
 * was asked in (the wake's `channelId`, targetOf; a private chat's is that chat); `attend`: the
 * place; `errand_deadline`: the channel of the intention that waits on the errand; `feedback`:
 * the current channel of the turn it reports (`here`, null when that turn had none). A review, or
 * a wake with no channel: none. `why` is a short machine word (`destination`, `asked`, `attend`,
 * `errand`, `feedback`), null with no channel.
 * @param {object[]} group
 * @param {object[]} [records]  The open intentions of the group, for the destination.
 * @returns {{ channelId: string|null, why: string|null }}
 */
export function currentChannelOf(group, records = []) {
  const cause = list(group).find((wake) => wake && wake.kind !== 'review') ?? null;
  if (!cause) return { channelId: null, why: null };
  const pick = (id, why) => (id !== null && id !== undefined && String(id) !== '' ? { channelId: String(id), why } : { channelId: null, why: null });
  switch (cause.kind) {
    case 'intention_due': {
      const record = list(records).find((item) => item && String(item.id) === String(list(cause.intentionIds)[0]));
      return pick(cause.channelId, record?.destination && !cause.privateChat ? 'destination' : 'asked');
    }
    case 'attend':
      return pick(cause.channelId, 'attend');
    case 'errand_deadline':
      return pick(cause.channelId, 'errand');
    case 'feedback':
      return pick(Object.hasOwn(cause, 'here') ? cause.here : cause.channelId, 'feedback');
    default:
      return { channelId: null, why: null };
  }
}

/**
 * The wake of one entry of src/intentions/model.js#dueList (`{ intention, reason, at }`): an
 * `errand_deadline` for a wait past its deadline (its id names the errand), else an
 * `intention_due` (its id names the due time), so the same due item is always the same wake and
 * a new due time is a new one. Its chain is the intention's `chainId`, else the intention -- or,
 * for a recurring intention (`every`), this occurrence of it: each occurrence is its own chain.
 */
export function wakeOfDue({ intention, reason, at }) {
  const deadline = reason === 'wait-deadline';
  const kind = deadline ? 'errand_deadline' : 'intention_due';
  const taskId = deadline ? (intention.awaitingTaskId ?? intention.lastTaskId ?? null) : null;
  const { channelId, privateChat } = targetOf(intention);
  return {
    id: deadline ? `inner.wake:errand_deadline:${intention.id}:${taskId}` : `inner.wake:intention_due:${intention.id}:${at}`,
    kind,
    reason: deadline ? 'wait-deadline' : 'due',
    intentionIds: [intention.id],
    chainId: intention.chainId ? `chain:${intention.chainId}` : intention.every && !deadline ? `intention:${intention.id}:${at}` : `intention:${intention.id}`,
    dueAt: at,
    channelId,
    privateChat,
    ...(taskId ? { taskId: String(taskId) } : {}),
  };
}

/**
 * The `errand_deadline` wakes of intentions a reconciliation already moved back to `pending`
 * with the note `wait-deadline` (at start, before the scheduler's first tick): the same id as the
 * wake the wait itself would have given, so the two never wake her twice.
 */
export function deadlineWakes(records) {
  return list(records)
    .filter((record) => record?.status === 'pending' && record.note === 'wait-deadline' && record.lastTaskId)
    .map((record) => wakeOfDue({ intention: { ...record, awaitingTaskId: record.lastTaskId }, reason: 'wait-deadline', at: record.updatedAt ?? record.createdAt ?? 0 }));
}

/**
 * The attend wake of attention `record` over `lines` (the place's lines since her last look there,
 * `{ id, at, by, said }`: her own lines never count; with `attend.people` only theirs do) at `now`:
 * null when no line counts or the newest is younger than `attend.settle` seconds (the place is
 * still talking); else the wake named by the newest line, its own chain, due when the settle ends.
 * @param {object} record  An intention of kind attend.
 * @param {{ id: string, at: number, by: string|null, said?: boolean }[]} lines
 * @param {{ now: number, since?: number }} options  `since`: her last look (for the wake's record).
 */
export function attendWake(record, lines, { now, since = null }) {
  const attend = record?.attend;
  if (!attend?.place) return null;
  const people = Array.isArray(attend.people) ? attend.people : [];
  const counted = list(lines).filter((line) => line && !line.said && Number.isFinite(line.at) && (people.length === 0 || (line.by && people.includes(String(line.by)))));
  if (counted.length === 0) return null;
  const newest = counted.reduce((best, line) => (line.at > best.at ? line : best));
  const settleMs = (Number.isFinite(attend.settle) ? attend.settle : 0) * 1000;
  if (now - newest.at < settleMs) return null;
  return {
    id: `${ATTEND_PREFIX}${record.id}:${newest.id}`,
    kind: 'attend',
    reason: 'lines',
    intentionIds: [record.id],
    chainId: `attend:${record.id}:${newest.id}`,
    dueAt: newest.at + settleMs,
    channelId: String(attend.place),
    privateChat: false,
    attend: {
      place: String(attend.place),
      lines: counted.length,
      people: [...new Set(counted.map((line) => (line.by ? String(line.by) : null)).filter(Boolean))],
      since: Number.isFinite(since) ? since : null,
      newestAt: newest.at,
      newestId: String(newest.id),
    },
  };
}

/**
 * One page of the places view: `entries` (`{ id, name, writable, lines, people, newestAt, attended }`,
 * one per place) filtered by name (`filter`, case and accents folded), sorted (`recent`: the newest
 * line first, places without one last; `name`; `lines`: most first), cut to page `page` of
 * `pageSize`. The total and how many more follow the page are always said. Pure.
 * @returns {{ total: number, page: number, pageSize: number, more: number, items: object[] }}
 */
export function placesPage(entries, { filter = null, sort = 'recent', page = 1, pageSize = 12 } = {}) {
  const needle = typeof filter === 'string' && filter.trim() ? foldText(filter) : null;
  const kept = list(entries).filter((entry) => entry && (needle === null || foldText(String(entry.name ?? entry.id ?? '')).includes(needle)));
  const byName = (a, b) => String(a.name ?? a.id).localeCompare(String(b.name ?? b.id)) || String(a.id).localeCompare(String(b.id));
  const sorted = [...kept].sort((a, b) => {
    if (sort === 'name') return byName(a, b);
    if (sort === 'lines') return (b.lines ?? 0) - (a.lines ?? 0) || byName(a, b);
    return (b.newestAt ?? -Infinity) - (a.newestAt ?? -Infinity) || byName(a, b);
  });
  const size = Math.max(1, Math.floor(pageSize));
  const number = Math.max(1, Math.floor(page));
  const start = (number - 1) * size;
  const items = sorted.slice(start, start + size);
  return { total: sorted.length, page: number, pageSize: size, more: Math.max(0, sorted.length - start - items.length), items };
}

/** The day's review wake. */
export function reviewWake(day, at) {
  return { id: `inner.wake:review:${day}`, kind: 'review', reason: 'review', intentionIds: [], chainId: `review:${day}`, dueAt: at, channelId: null, privateChat: false };
}

/**
 * Her lines per local hour of `timezone` (24 counts): the `said` lines of `lines` (the record's).
 * @param {Iterable<object>} lines
 * @param {string} timezone
 */
export function hourWeights(lines, timezone) {
  const weights = new Array(24).fill(0);
  for (const line of lines ?? []) {
    if (line?.kind !== 'said') continue;
    const at = Date.parse(line.occurredAt);
    if (Number.isFinite(at)) weights[localHour(at, timezone)] += 1;
  }
  return weights;
}

/**
 * The review's moment on local day `day`: an hour drawn with the weight of her lines in it
 * (`weights`, hourWeights'; all hours alike when she has none), then a minute in it, never before
 * `notBefore` (the hours already past on the day it is drawn are not offered). Null when no hour
 * of the day is left. `rng` in [0, 1).
 * @param {{ day: string, weights: number[], timezone: string, rng: () => number, notBefore?: number }} input
 * @returns {number|null}
 */
export function drawReviewAt({ day, weights, timezone, rng, notBefore = -Infinity }) {
  const total = list(weights).reduce((sum, value) => sum + (value > 0 ? value : 0), 0);
  const hours = [];
  for (let hour = 0; hour < 24; hour += 1) {
    const end = zonedEpoch(day, hour, 59, timezone) + MINUTE_MS - 1;
    if (!Number.isFinite(end) || end < notBefore) continue;
    const weight = total > 0 ? Math.max(0, weights[hour] ?? 0) : 1;
    if (weight > 0) hours.push({ hour, weight });
  }
  if (hours.length === 0) return null;
  const sum = hours.reduce((acc, entry) => acc + entry.weight, 0);
  let pick = rng() * sum;
  let chosen = hours[hours.length - 1];
  for (const entry of hours) {
    if (pick < entry.weight) {
      chosen = entry;
      break;
    }
    pick -= entry.weight;
  }
  const start = zonedEpoch(day, chosen.hour, 0, timezone);
  const from = Math.max(start, Number.isFinite(notBefore) ? notBefore : start);
  const end = start + HOUR_MS;
  return Math.floor(from + rng() * Math.max(0, end - from - 1));
}

/**
 * The wakes of `queue` that run together, the earliest due first: the first wake that is not a
 * review is the anchor; every wake of the same conversation (and the same private-or-server kind)
 * joins it, and the day's review joins any server anchor. With only reviews queued, they go alone.
 * A retried wake (`retry`) joins only the wakes of its own failed group.
 * @param {object[]} queue
 * @returns {object[]}
 */
export function coalesceGroup(queue) {
  const sorted = [...list(queue)].sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0));
  if (sorted.length === 0) return [];
  const anchor = sorted.find((wake) => wake.kind !== 'review') ?? null;
  // A retried wake runs only with the wakes of its own failed group (the same attempt and first failure); a fresh one never joins them.
  const key = retryKey(anchor ?? sorted[0]);
  const same = sorted.filter((wake) => retryKey(wake) === key);
  if (!anchor) return same;
  return same.filter((wake) => (wake.kind === 'review' ? !anchor.privateChat : wake.channelId === anchor.channelId && Boolean(wake.privateChat) === Boolean(anchor.privateChat)));
}

/** What tells retried wakes of one failed group from fresh ones: '' for a fresh wake. */
const retryKey = (wake) => (wake?.retry ? `${wake.retry}:${wake.firstFailedAt ?? ''}` : '');

/** The start of the local day of `now` and of the next one. */
function dayBounds(now, timezone) {
  const day = zonedDay(now, timezone);
  const start = zonedEpoch(day, 0, 0, timezone);
  const next = zonedEpoch(zonedDay(start + 26 * HOUR_MS, timezone), 0, 0, timezone);
  return { day, start, next };
}

/**
 * What is left of each cap at `now` (her local day in `timezone`; the hour rolling): `day`,
 * `hour`, `posts`, each `{ used, cap, left,
 * resetAt }` (`resetAt` null when nothing is used in a rolling window). Pure.
 */
export function budgetsOf(state, settings, { now, timezone }) {
  const { start, next } = dayBounds(now, timezone);
  const caps = settings.caps;
  // A turn that ended in a provider or engine error (`failed`) is no turn against the day and hour caps: its wakes retry.
  const counted = state.turns.filter((turn) => turn.failed !== true);
  const today = counted.filter((turn) => turn.at >= start);
  const hour = counted.filter((turn) => turn.at > now - HOUR_MS);
  const posts = state.posts.filter((at) => at >= start).length;
  return {
    day: { used: today.length, cap: caps.perDay, left: Math.max(0, caps.perDay - today.length), resetAt: next },
    hour: { used: hour.length, cap: caps.perHour, left: Math.max(0, caps.perHour - hour.length), resetAt: hour.length > 0 ? Math.min(...hour.map((turn) => turn.at)) + HOUR_MS : null },
    posts: { used: posts, cap: caps.publicPostsPerDay, left: Math.max(0, caps.publicPostsPerDay - posts), resetAt: next },
  };
}

/**
 * What becomes of the wakes of `group` after a turn that ended in an error at `at`: `requeue` with
 * the next delay of `settings.retry.delaysMinutes` (the last one repeats) as long as the first
 * failure is younger than `retry.maxHours`, else `drop`. `n` is the attempt number that failed.
 * @returns {{ action: 'requeue'|'drop', n: number, firstFailedAt: number, notBefore: number|null }}
 */
export function planRetry(group, at, settings, code = 'error') {
  const n = group.reduce((most, wake) => Math.max(most, Number.isInteger(wake.retry) ? wake.retry : 0), 0) + 1;
  const firstFailedAt = group.reduce((first, wake) => Math.min(first, Number.isFinite(wake.firstFailedAt) ? wake.firstFailedAt : at), at);
  const { delaysMinutes, maxHours } = settings.retry;
  if (at - firstFailedAt >= maxHours * HOUR_MS) return { action: 'drop', n, firstFailedAt, notBefore: null, code };
  const delay = delaysMinutes[Math.min(n - 1, delaysMinutes.length - 1)] * MINUTE_MS;
  return { action: 'requeue', n, firstFailedAt, notBefore: at + delay, code };
}

/** How many inner turns chain `chainId` has had, and how many are left under `cap`. */
export function chainBudget(state, chainId, cap) {
  const used = Number.isFinite(state.chains?.[chainId]?.turns) ? state.chains[chainId].turns : 0;
  return { used, cap, left: Math.max(0, cap - used) };
}

/**
 * The cap an inner turn would break now, or null: `per-day`, `per-hour`, `per-chain`.
 */
export function capRefusal(budgets, chain) {
  if (budgets.day.left <= 0) return 'per-day';
  if (budgets.hour.left <= 0) return 'per-hour';
  if (chain.left <= 0) return 'per-chain';
  return null;
}

/**
 * The cost of whatever runs inside `run(fn)`: every `llm: usage` line (its `upstreamCost`, else
 * `cost`; the `core` role counted apart, as `voice`, the journal field's name since the role was called so) and `images: generated` line logged in its async context
 * (AsyncLocalStorage over the log listeners, src/log.js#onLog), helpers it starts included;
 * `running()`, asked inside it, says what it has cost so far and its costliest single request.
 * @param {{ subscribe?: (listener: Function) => Function }} [options]
 */
export function createCostMeter({ subscribe = onLog } = {}) {
  const scope = new AsyncLocalStorage();
  const round = (value) => Math.round(value * 1_000_000) / 1_000_000;
  const amount = (value) => (typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : 0);
  subscribe((entry) => {
    const box = scope.getStore();
    if (!box || !entry || typeof entry !== 'object') return;
    if (entry.msg === 'llm: usage') {
      const usd = amount(typeof entry.upstreamCost === 'number' ? entry.upstreamCost : entry.cost);
      box.usd += usd;
      box.peak = Math.max(box.peak, usd);
      box.requests += 1;
      if (entry.role === 'core') box.voice += 1;
    } else if (entry.msg === 'images: generated') {
      const usd = amount(entry.cost);
      box.usd += usd;
      box.peak = Math.max(box.peak, usd);
    }
  });
  return {
    async run(fn) {
      const box = { usd: 0, peak: 0, requests: 0, voice: 0 };
      const result = await scope.run(box, fn);
      return { result, usd: round(box.usd), requests: box.requests, voice: box.voice };
    },
    /**
     * What the `run` whose async context this is has cost so far (`usd`) and its costliest single
     * request or picture (`peak`); zeros outside one.
     */
    running() {
      const box = scope.getStore();
      return box ? { usd: round(box.usd), peak: round(box.peak) } : { usd: 0, peak: 0 };
    },
  };
}

/**
 * @param {object} options
 * @param {{ config: object }} options.hot
 * @param {string} options.dataDir
 * @param {{ runTurn: Function, isAnyBusy?: Function, isBusy?: Function }} options.turns
 * @param {object|null} [options.intentions]  src/intentions/service.js
 * @param {{ iterate: Function }|null} [options.record]  The record: her own lines for the review's
 *   hours, every place's lines for her attention.
 * @param {((guildId: string) => { id: string, name?: string|null, writable?: boolean|null }[])|null} [options.places]
 *   The places the interface publishes for the guild (opaque addresses, names, whether she can
 *   write there), for `places`; without it the places are the ones the record shows.
 * @param {((guildId: string, memberId: string) => string|null)|null} [options.nameOf]  A member's
 *   name for the `<wake>` lines (null: the id is shown).
 * @param {{ inner?: Function }|null} [options.journal]
 * @param {{ channels?: { fetch: Function } }|null} [options.client]
 * @param {{ canSend?: Function }|null} [options.discord]
 * @param {(event: object) => Promise<object>} [options.submit]  The event door's submit (src/index.js).
 * @param {{ state: { data: object } }|null} [options.store]  The memory store (its pause).
 * @param {() => string|null} [options.getGuildId]
 * @param {() => boolean} [options.isWarmingUp]
 * @param {() => boolean} [options.peopleWaiting]  Calls queued for the attention (people first).
 * @param {{ run: Function }} [options.meter]  createCostMeter's.
 * @param {((guildId: string, episode: object) => unknown)|null} [options.onEpisode]  What an inner
 *   turn did and found (its result's `inner.episode`), for her memory (src/memory/update.js#observeInner).
 * @param {() => number} [options.rng]
 * @param {() => number} [options.now]
 * @param {(fn: Function, ms: number) => unknown} [options.setTimer]
 * @param {{ info: Function, warn: Function }} [options.log]
 */
export function createInnerLife({
  hot,
  dataDir,
  turns,
  intentions = null,
  record = null,
  places: placesOf = null,
  nameOf = null,
  journal = null,
  client = null,
  discord = null,
  submit = null,
  store = null,
  getGuildId = () => null,
  isWarmingUp = () => false,
  peopleWaiting = () => false,
  meter = null,
  onEpisode = null,
  rng = Math.random,
  now = Date.now,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  log = defaultLog,
}) {
  const states = new Map();
  // Per guild: the place index (the record's lines per place over the lookback window).
  const placeIndexes = new Map();
  const costs = meter ?? createCostMeter();
  // The ids of the wakes an inner turn is running for now (a stop leaves them to that turn).
  const running = new Set();
  let ticking = false;
  let timer = null;
  let stopped = false;

  const fileOf = (guildId) => path.join(dataDir, 'guilds', String(guildId), 'inner.json');
  const timezoneOf = () => hot.config?.bot?.timezone ?? 'UTC';

  function stateOf(guildId) {
    const key = String(guildId);
    if (!states.has(key)) {
      let raw = null;
      try {
        raw = JSON.parse(fs.readFileSync(fileOf(key), 'utf8'));
      } catch (err) {
        if (err?.code !== 'ENOENT') log.warn('inner: state unreadable, starting empty', { guildId: key, code: err?.code ?? 'parse' });
      }
      states.set(key, normalizeState(raw));
    }
    return states.get(key);
  }

  function save(guildId) {
    const key = String(guildId);
    // Pruned in place: whoever holds the state object keeps seeing the one that is written.
    const next = Object.assign(stateOf(key), pruneState(stateOf(key), now()));
    try {
      writeJsonAtomic(fileOf(key), next);
    } catch (err) {
      log.warn('inner: state write failed', { guildId: key, code: err?.code ?? null });
    }
    return next;
  }

  /** One `inner` journal record (features.journal exactly true, read now); never throws. */
  function note(guildId, fields) {
    if (hot.config?.features?.journal !== true || typeof journal?.inner !== 'function') return;
    Promise.resolve()
      .then(() => journal.inner(guildId, fields))
      .catch((err) => log.warn('inner: journal failed', { code: err?.code ?? null }));
  }

  function paused() {
    try {
      return store?.state?.data?.paused === true || isWarmingUp() === true;
    } catch {
      return false;
    }
  }

  /**
   * `wakes` marked handled with `outcome` and taken off the queue; every recurring intention they
   * name advances to its next occurrence (the service's `advance`: `recurred` for one in `named`,
   * the ids her turn's calls named, else `missed`). A one-off, a waiting one and an occurrence she
   * already closed or moved are left as they are by the service.
   */
  function markHandled(state, wakes, outcome, at, { guildId = null, named = null } = {}) {
    for (const wake of wakes) {
      state.handled[wake.id] = {
        at,
        outcome,
        ...(wake.kind === 'attend' ? { place: wake.channelId ?? null } : {}),
        // A drop she is told about at her next turn (feedbackFacts' `wakeDropped`): what the fact needs.
        ...(DROP_TOLD.has(outcome) ? { kind: wake.kind, intentionIds: list(wake.intentionIds), told: false } : {}),
      };
    }
    const ids = new Set(wakes.map((wake) => wake.id));
    state.queue = state.queue.filter((wake) => !ids.has(wake.id));
    if (!guildId || typeof intentions?.advance !== 'function') return;
    const touched = named instanceof Set ? named : new Set(Array.isArray(named) ? named.map(String) : []);
    for (const id of new Set(wakes.flatMap((wake) => (Array.isArray(wake.intentionIds) ? wake.intentionIds : [])))) {
      const result = intentions.advance(guildId, id, { named: touched.has(String(id)) });
      if (result?.changed) note(guildId, { event: 'recurred', intentionId: String(id), code: result.intention?.history?.at?.(-1)?.code ?? null, dueAt: result.intention?.dueAt ?? null, outcome });
    }
  }

  /**
   * The door's handler of `inner.wake`: the wake queued (persisted), unless it was handled
   * already, is queued, the inner life is stopped, or the queue is full (`overflow`, journalled
   * and handled so it is never dropped unseen). Answers what happened.
   */
  function onWake(event) {
    const guildId = event?.guildId ?? getGuildId();
    const wake = event?.wake;
    if (!guildId || !wake || !WAKE_KINDS.includes(wake.kind)) return { status: 'invalid' };
    const state = stateOf(guildId);
    const id = String(event.id ?? wake.id);
    if (state.stopped) return { status: 'stopped' };
    if (state.handled[id] || state.queue.some((queued) => queued.id === id)) return { status: 'duplicate' };
    const at = now();
    const queued = { ...wake, id, queuedAt: at };
    if (state.queue.length >= innerSettings(hot.config).queueMax) {
      markHandled(state, [queued], 'overflow', at, { guildId });
      save(guildId);
      log.warn('inner: queue overflow', { guildId, id, kind: wake.kind, queued: state.queue.length });
      note(guildId, { event: 'overflow', wake: wakeFields(queued), queued: state.queue.length });
      return { status: 'overflow' };
    }
    state.queue.push(queued);
    save(guildId);
    log.info('inner: wake', { guildId, id, kind: wake.kind, dueAt: wake.dueAt ?? null });
    note(guildId, { event: 'wake', wake: wakeFields(queued), channelId: wake.privateChat ? null : wake.channelId });
    return { status: 'queued' };
  }

  /** What the journal keeps of a wake: ids, codes and times. */
  function wakeFields(wake) {
    return {
      id: wake.id,
      kind: wake.kind,
      reason: wake.reason,
      dueAt: wake.dueAt ?? null,
      intentionIds: wake.intentionIds ?? [],
      chainId: wake.chainId ?? null,
      ...(wake.retry ? { retry: wake.retry, firstFailedAt: wake.firstFailedAt ?? null, notBefore: wake.notBefore ?? null } : {}),
      ...(wake.taskId ? { taskId: wake.taskId } : {}),
      ...(wake.attend ? { place: wake.attend.place, lines: wake.attend.lines, people: wake.attend.people.length } : {}),
      ...(wake.kind === 'feedback' ? { turnId: wake.turnId ?? null, facts: list(wake.facts) } : {}),
    };
  }

  async function enqueue(guildId, wake) {
    const event = { kind: 'inner.wake', at: now(), id: wake.id, guildId: String(guildId), wake };
    if (typeof submit === 'function') return submit(event);
    return { status: 'ok', result: onWake(event) };
  }

  /** Her `said` lines of the last `days` from the record, as the review's hours and channels. */
  async function ownLines(guildId, days) {
    const lines = [];
    if (typeof record?.iterate !== 'function') return lines;
    const from = new Date(now() - days * DAY_MS).toISOString();
    try {
      for await (const line of record.iterate(guildId, { from })) if (line?.kind === 'said') lines.push(line);
    } catch (err) {
      log.warn('inner: record read failed', { guildId, code: err?.code ?? null });
    }
    return lines;
  }

  function placeIndexOf(guildId) {
    const key = String(guildId);
    if (!placeIndexes.has(key)) placeIndexes.set(key, { scannedTo: null, places: new Map() });
    return placeIndexes.get(key);
  }

  /**
   * The place index brought up to `at`: the record's `seen` and `said` lines since the last scan
   * (a little behind it; a line already indexed is skipped by its message id), each as
   * `{ id, at, by, said }` under its place; lines older than the lookback window dropped. Never throws.
   */
  async function refreshPlaces(guildId, at, settings) {
    const index = placeIndexOf(guildId);
    const floor = at - settings.attention.lookbackHours * HOUR_MS;
    const from = index.scannedTo === null ? floor : Math.max(floor, index.scannedTo - SCAN_LAG_MS);
    if (typeof record?.iterate === 'function') {
      try {
        for await (const line of record.iterate(guildId, { from: new Date(from).toISOString() })) {
          if (line?.kind !== 'seen' && line?.kind !== 'said') continue;
          const place = line.scope?.channel;
          if (typeof place !== 'string' || !place) continue;
          const lineAt = Date.parse(line.occurredAt);
          if (!Number.isFinite(lineAt) || lineAt < floor || lineAt > at) continue;
          const id = String(line.messageId ?? line.id ?? '');
          if (!id) continue;
          if (!index.places.has(place)) index.places.set(place, { lines: [], ids: new Set() });
          const bucket = index.places.get(place);
          if (bucket.ids.has(id)) continue;
          bucket.ids.add(id);
          bucket.lines.push({ id, at: lineAt, by: line.kind === 'said' ? null : (typeof line.by === 'string' ? line.by : null), said: line.kind === 'said' });
        }
      } catch (err) {
        log.warn('inner: record read failed', { guildId, code: err?.code ?? null });
      }
    }
    index.scannedTo = at;
    for (const [place, bucket] of index.places) {
      if (bucket.lines.some((line) => line.at < floor)) {
        bucket.lines = bucket.lines.filter((line) => line.at >= floor);
        bucket.ids = new Set(bucket.lines.map((line) => line.id));
      }
      if (bucket.lines.length === 0) index.places.delete(place);
    }
    return index;
  }

  /**
   * When she last looked at `place`: her last own line there (the index), or the last attend wake
   * handled for that place, whichever is later; -Infinity when neither is known.
   */
  function lastLookAt(guildId, place) {
    let last = -Infinity;
    for (const line of placeIndexOf(guildId).places.get(String(place))?.lines ?? []) if (line.said && line.at > last) last = line.at;
    for (const [id, entry] of Object.entries(stateOf(guildId).handled)) {
      if (id.startsWith(ATTEND_PREFIX) && entry?.place === String(place) && Number.isFinite(entry.at) && entry.at > last) last = entry.at;
    }
    return last;
  }

  /** The indexed lines of `place` strictly after `since`. */
  function linesSince(guildId, place, since) {
    return (placeIndexOf(guildId).places.get(String(place))?.lines ?? []).filter((line) => line.at > since);
  }

  /** The guild's open attentions (the service's `attending`, else its list filtered). Never throws. */
  function openAttentions(guildId) {
    try {
      if (typeof intentions?.attending === 'function') return intentions.attending(guildId) ?? [];
      return (intentions?.list?.(guildId, { all: true }) ?? []).filter((record) => record?.status === 'pending' && isAttend(record));
    } catch (err) {
      log.warn('inner: attentions unreadable', { guildId, code: err?.code ?? null });
      return [];
    }
  }

  /** The attend wakes due now: one per open attention whose place has settled lines since her last look. */
  function attendWakes(guildId, at) {
    const out = [];
    for (const record of openAttentions(guildId)) {
      const place = String(record.attend.place);
      const since = Math.max(lastLookAt(guildId, place), Number.isFinite(record.createdAt) ? record.createdAt : -Infinity);
      const wake = attendWake(record, linesSince(guildId, place, since), { now: at, since: Number.isFinite(since) ? since : null });
      if (wake) out.push(wake);
    }
    return out;
  }

  /** The name of place `id`: the directory's, else the interface's cache, else the id. */
  function placeNameOf(guildId, id) {
    const named = directoryOf(guildId).find((entry) => entry.id === String(id));
    return named?.name ?? client?.channels?.cache?.get?.(String(id))?.name ?? String(id);
  }

  /** The places the interface publishes for the guild (`places`), else the places the record shows. */
  function directoryOf(guildId) {
    let listed = [];
    if (typeof placesOf === 'function') {
      try {
        listed = list(placesOf(String(guildId))).filter((entry) => entry && (typeof entry.id === 'string' || typeof entry.id === 'number'));
      } catch (err) {
        log.warn('inner: places unreadable', { guildId, code: err?.code ?? null });
        listed = [];
      }
      return listed.map((entry) => ({ id: String(entry.id), name: typeof entry.name === 'string' && entry.name ? entry.name : String(entry.id), writable: typeof entry.writable === 'boolean' ? entry.writable : null }));
    }
    return [...placeIndexOf(guildId).places.keys()].map((id) => ({ id, name: client?.channels?.cache?.get?.(id)?.name ?? id, writable: null }));
  }

  /**
   * The places view (her `places.list`, the page in `<wake>`): every place of the directory (and
   * every attended place), with the lines and distinct people since her last look there (the
   * index: at most the lookback window), its newest line, whether she can write there (null when
   * the interface did not say) and whether she attends it; filtered, sorted and paged (placesPage;
   * `pageSize` defaults to `innerLife.attention.pageSize`). Never throws.
   * @param {string} guildId
   * @param {{ filter?: string|null, sort?: string, page?: number, pageSize?: number|null }} [options]
   */
  function places(guildId = getGuildId(), { filter = null, sort = 'recent', page = 1, pageSize = null } = {}) {
    const settings = innerSettings(hot.config);
    const size = Number.isFinite(pageSize) && pageSize > 0 ? pageSize : settings.attention.pageSize;
    if (!guildId) return placesPage([], { filter, sort, page, pageSize: size });
    const attended = new Set(openAttentions(guildId).map((record) => String(record.attend.place)));
    const directory = directoryOf(guildId);
    const known = new Set(directory.map((entry) => entry.id));
    const entries = [...directory, ...[...attended].filter((id) => !known.has(id)).map((id) => ({ id, name: placeNameOf(guildId, id), writable: null }))];
    const rows = entries.map((entry) => {
      const lines = linesSince(guildId, entry.id, lastLookAt(guildId, entry.id)).filter((line) => !line.said);
      return {
        id: entry.id,
        name: entry.name,
        writable: entry.writable,
        lines: lines.length,
        people: new Set(lines.map((line) => line.by).filter(Boolean)).size,
        newestAt: lines.length > 0 ? Math.max(...lines.map((line) => line.at)) : null,
        attended: attended.has(entry.id),
      };
    });
    return placesPage(rows, { filter, sort: PLACE_SORTS.includes(sort) ? sort : 'recent', page, pageSize: size });
  }

  /** Today's review drawn (once per local day, persisted); the wake when its moment came. */
  async function reviewDue(guildId, settings, at) {
    if (!settings.review.enabled) return null;
    const state = stateOf(guildId);
    const timezone = timezoneOf();
    const day = zonedDay(at, timezone);
    if (state.review?.day !== day) {
      const previous = state.review;
      if (previous && previous.done !== true && Number.isFinite(previous.at)) note(guildId, { event: 'review-missed', day: previous.day });
      const lines = await ownLines(guildId, settings.review.historyDays);
      const weights = hourWeights(lines, timezone);
      const reviewAt = drawReviewAt({ day, weights, timezone, rng, notBefore: at });
      const channels = [];
      for (const line of [...lines].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))) {
        const channelId = line.scope?.channel;
        if (typeof channelId === 'string' && channelId && !channels.includes(channelId)) channels.push(channelId);
        if (channels.length >= REVIEW_CHANNELS_MAX) break;
      }
      // Re-read: the record scan awaited, a tick of the same day may have drawn it meanwhile.
      const current = stateOf(guildId);
      if (current.review?.day !== day) {
        // An earlier day's review still queued (held by a cap) gives way to today's.
        const older = current.queue.filter((wake) => wake.kind === 'review' && wake.id !== reviewWake(day, 0).id);
        if (older.length > 0) markHandled(current, older, 'superseded', at);
        current.review = { day, at: reviewAt, done: reviewAt === null, channels, lines: lines.length };
        save(guildId);
        log.info('inner: review drawn', { guildId, day, at: reviewAt, lines: lines.length });
        note(guildId, { event: 'review-drawn', day, at: reviewAt, lines: lines.length });
      }
    }
    const review = stateOf(guildId).review;
    if (!review || review.done || !Number.isFinite(review.at) || review.at > at) return null;
    return reviewWake(day, review.at);
  }

  /** Whether her actions may leave an inner turn now: the switch on, not stopped, not paused. */
  function mayAct(guildId) {
    return innerOn(hot.config) && !stateOf(guildId).stopped && !paused();
  }

  /**
   * One tick: with the switch on and nothing paused or stopped, what is due is listed and handed
   * to the door (intentions due, waits past their deadline, the day's review), the waits are
   * reconciled, then the queue is drained by one inner turn when the attention is free. Never
   * throws; answers what it did.
   */
  async function tick() {
    const config = hot.config;
    if (!innerOn(config)) return { ran: false, reason: 'off' };
    const guildId = getGuildId();
    if (!guildId) return { ran: false, reason: 'no-guild' };
    if (ticking) return { ran: false, reason: 'ticking' };
    if (paused()) return { ran: false, reason: 'paused' };
    if (stateOf(guildId).stopped) return { ran: false, reason: 'stopped' };
    ticking = true;
    try {
      const settings = innerSettings(config);
      const at = now();
      const listed = [];
      if (intentions && intentionsOn(config)) {
        let due = [];
        try {
          due = intentions.due(guildId) ?? [];
        } catch (err) {
          log.warn('inner: due list failed', { guildId, code: err?.code ?? null });
        }
        listed.push(...due.map(wakeOfDue));
        try {
          intentions.reconcile(guildId);
          listed.push(...deadlineWakes(intentions.list(guildId, { all: true })));
        } catch (err) {
          log.warn('inner: reconcile failed', { guildId, code: err?.code ?? null });
        }
      }
      const review = await reviewDue(guildId, settings, at);
      if (review) listed.push(review);
      if (intentions && intentionsOn(config)) {
        await refreshPlaces(guildId, at, settings);
        listed.push(...attendWakes(guildId, at));
      }
      const state = stateOf(guildId);
      let submitted = 0;
      for (const wake of listed) {
        if (state.handled[wake.id] || state.queue.some((queued) => queued.id === wake.id)) continue;
        // One queued wake per attention: a newer burst replaces the queued one (its history covers the gap).
        if (wake.kind === 'attend') {
          const older = state.queue.filter((queued) => queued.kind === 'attend' && queued.intentionIds?.[0] === wake.intentionIds[0] && !running.has(queued.id));
          if (older.length > 0) {
            state.queue = state.queue.filter((queued) => !older.includes(queued));
            save(guildId);
            for (const previous of older) note(guildId, { event: 'replaced', wake: wakeFields(previous), by: wake.id });
          }
        }
        await enqueue(guildId, wake);
        submitted += 1;
      }
      const drained = await drain(guildId);
      return { ran: true, listed: listed.length, submitted, drained };
    } catch (err) {
      log.warn('inner: tick failed', { error: err });
      return { ran: false, reason: 'error' };
    } finally {
      ticking = false;
    }
  }

  /**
   * The conversation an inner turn of `group` runs in, or null. An attend wake's place may be one
   * she can only read: she listens there and posts, if at all, through a call elsewhere.
   */
  async function conversationFor(guildId, group) {
    const anchor = group.find((wake) => wake.kind !== 'review') ?? null;
    const candidates = anchor ? [anchor.channelId] : (stateOf(guildId).review?.channels ?? []);
    const readOnlyOk = anchor?.kind === 'attend';
    for (const channelId of candidates) {
      if (!channelId) continue;
      const channel = await Promise.resolve(client?.channels?.fetch?.(String(channelId))).catch(() => null);
      if (!channel) continue;
      // A private chat only while private chats are on (features.privateMessages, read now).
      if (!channel.guild && hot.config?.features?.privateMessages !== true) continue;
      if (channel.guild && !readOnlyOk && typeof discord?.canSend === 'function') {
        let writable = false;
        try {
          writable = discord.canSend(channel);
        } catch {
          writable = false;
        }
        if (!writable) continue;
      }
      return channel;
    }
    return null;
  }

  /** The channel names of the review's recent channels, for `<wake>`. */
  function channelNames(guildId) {
    const ids = stateOf(guildId).review?.channels ?? [];
    return ids.map((id) => client?.channels?.cache?.get?.(String(id))?.name ?? null).filter(Boolean);
  }

  /**
   * One inner turn for the queue's first coalesced group, when the attention is free and no cap
   * refuses; a turn held back (`busy`, `paused`) leaves the group queued with its due times.
   */
  async function drain(guildId) {
    const state = stateOf(guildId);
    if (state.queue.length === 0) return null;
    if (state.stopped || paused()) return { deferred: 'stopped' };
    const oneAtATime = hot.config?.mention?.oneAtATime !== false;
    if (oneAtATime && typeof turns?.isAnyBusy === 'function' && turns.isAnyBusy()) return { deferred: 'busy' };
    if (peopleWaiting()) return { deferred: 'people' };
    const settings = innerSettings(hot.config);
    const at = now();

    // An intention closed since its wake was queued (done, cancelled, expired): the wake is stale.
    const openOf = (id) => {
      const intention = intentions?.store?.(guildId)?.get?.(id) ?? null;
      return intention && ['pending', 'waiting'].includes(intention.status) ? intention : null;
    };
    const stale = state.queue.filter((wake) => wake.kind !== 'review' && wake.intentionIds.length > 0 && wake.intentionIds.every((id) => !openOf(id)));
    if (stale.length > 0) {
      markHandled(state, stale, 'stale', at, { guildId });
      save(guildId);
      for (const wake of stale) note(guildId, { event: 'stale', wake: wakeFields(wake) });
      if (state.queue.length === 0) return { dropped: stale.length };
    }

    const timezone = timezoneOf();
    // An attention past its own per-day bound: its wakes wait for the next local day, the rest go on.
    const day = zonedDay(at, timezone);
    const overDay = (wake) => {
      if (wake.kind !== 'attend') return false;
      const record = openOf(wake.intentionIds[0]);
      return Boolean(record?.attend) && attendCounter(record, day).wakes >= record.attend.perDay;
    };
    const held = state.queue.filter(overDay);
    let heldFresh = 0;
    for (const wake of held) {
      if (wake.capped === 'attend-per-day') continue;
      wake.capped = 'attend-per-day';
      heldFresh += 1;
      note(guildId, { event: 'capped', cap: 'attend-per-day', wake: wakeFields(wake) });
    }
    if (heldFresh > 0) {
      save(guildId);
      log.info('inner: capped', { guildId, cap: 'attend-per-day', wakes: heldFresh });
    }
    // A wake of a failed turn waits for its retry time (`notBefore`).
    const eligible = state.queue.filter((wake) => !held.includes(wake) && !(wake.notBefore > at));
    if (eligible.length === 0) return held.length > 0 ? { refused: 'attend-per-day' } : { deferred: 'retry' };

    const group = coalesceGroup(eligible);
    const anchor = group.find((wake) => wake.kind !== 'review') ?? group[0];
    const chainId = anchor.chainId;
    const budgets = budgetsOf(state, settings, { now: at, timezone });
    const chain = chainBudget(state, chainId, settings.caps.perChain);
    const refusal = capRefusal(budgets, chain);
    if (refusal) {
      let fresh = 0;
      for (const wake of group) {
        if (wake.capped === refusal) continue;
        wake.capped = refusal;
        fresh += 1;
        note(guildId, { event: 'capped', cap: refusal, wake: wakeFields(wake) });
      }
      // A spent chain never comes back: its wakes are done with. The other caps reset.
      if (refusal === 'per-chain') markHandled(state, group, 'chain-cap', at, { guildId });
      if (fresh > 0 || refusal === 'per-chain') {
        save(guildId);
        log.info('inner: capped', { guildId, cap: refusal, wakes: group.length });
      }
      return { refused: refusal };
    }

    const channel = await conversationFor(guildId, group);
    if (!channel) {
      markHandled(state, group, 'no-channel', at, { guildId });
      save(guildId);
      log.info('inner: no conversation', { guildId, wakes: group.length });
      for (const wake of group) note(guildId, { event: 'no-channel', wake: wakeFields(wake) });
      return { dropped: group.length };
    }

    const records = [...new Set(group.flatMap((wake) => wake.intentionIds))].map(openOf).filter(Boolean);
    // A recurring intention whose next occurrence would fall past its expiry: this is its last one.
    const notes = {};
    for (const record of records) {
      if (!record.every) continue;
      const next = nextOccurrence(record, at, timezone);
      if (!Number.isFinite(next) || next > record.expiresAt) notes[record.id] = 'last-occurrence';
    }
    // A review tells her once which intentions of hers expired untouched: the expired records not yet
    // shown (never a candidate), the newest first, `review.expiredMax` of them; marked shown once the turn ran.
    const isReview = group.some((wake) => wake.kind === 'review');
    const expired = isReview && intentions && intentionsOn(hot.config) ? expiredToShow(intentions.store?.(guildId)?.list?.() ?? [], { max: settings.review.expiredMax }) : null;
    const shadow = settings.mode !== 'live';
    const posts = () => budgetsOf(stateOf(guildId), innerSettings(hot.config), { now: now(), timezone: timezoneOf() }).posts;
    // An attend wake's facts for `<wake>`: the place's name and the people's names (ids when unknown).
    const attendOf = (wake) => {
      if (!wake.attend) return {};
      const name = (id) => {
        try {
          return (typeof nameOf === 'function' ? nameOf(String(guildId), id) : null) ?? id;
        } catch {
          return id;
        }
      };
      return { attend: { ...wake.attend, placeName: placeNameOf(guildId, wake.attend.place), peopleNames: wake.attend.people.map(name) } };
    };
    const placesInWake = settings.attention.placesInWake;
    // The channels a promise of hers is kept to: the provenance channel of each woken intention (a feedback wake: the
    // intentions of the turn it reports) that someone other than herself asked for. A post there is a delivery.
    const selfId = client?.user?.id != null ? String(client.user.id) : null;
    const deliveryChannels = new Set();
    for (const id of new Set(group.flatMap((wake) => (wake.kind === 'intention_due' ? list(wake.intentionIds) : wake.kind === 'feedback' ? list(wake.deliveryFor) : [])))) {
      const provenance = intentions?.store?.(guildId)?.get?.(id)?.provenance;
      if (!provenance?.channelId || provenance.scope === 'dm') continue;
      if (list(provenance.participants).some((member) => String(member) !== selfId)) deliveryChannels.add(String(provenance.channelId));
    }
    const current = currentChannelOf(group, records);
    const info = {
      kind: anchor.kind,
      items: group.map((wake) => ({ kind: wake.kind, reason: wake.reason, intentionIds: wake.intentionIds, taskId: wake.taskId ?? null, ...attendOf(wake), ...(wake.retry ? { delayed: { minutes: Math.max(0, Math.round((at - (wake.dueAt ?? at)) / MINUTE_MS)), code: wake.lastCode ?? 'error' } } : {}), ...(wake.kind === 'feedback' ? { facts: list(wake.facts), turnId: wake.turnId ?? null } : {}) })),
      intentions: records,
      ...(Object.keys(notes).length > 0 ? { notes } : {}),
      ...(expired && expired.items.length > 0 ? { expired } : {}),
      now: at,
      timezone,
      channels: isReview ? channelNames(guildId) : [],
      // The places page: where life is, beyond this conversation (0 keeps it to her places.list skill).
      ...(placesInWake > 0 ? { places: places(guildId, { sort: 'recent', page: 1, pageSize: placesInWake }) } : {}),
      budgets: { day: budgets.day, hour: budgets.hour, chain, posts: budgets.posts },
      ...(deliveryChannels.size > 0 ? { delivery: [...deliveryChannels].map((id) => placeNameOf(guildId, id)) } : {}),
      chainId,
      // The current channel: where her output tags act, and why it is that one (`<wake>`).
      here: current.channelId ? { channel: placeNameOf(guildId, current.channelId), why: current.why } : null,
    };
    for (const wake of group) running.add(wake.id);
    let measured;
    try {
      measured = await costs.run(() =>
        turns.runTurn({
          channel,
          guildId,
          mode: 'inner',
          triggerKind: 'inner',
          inner: {
            wake: info,
            currentChannel: current.channelId,
            shadow,
            mayAct: () => mayAct(guildId),
            postAllowed: () => posts().left > 0,
            deliveryChannels,
            onPosted: () => {
              stateOf(guildId).posts.push(now());
              save(guildId);
            },
          },
        }),
      );
    } catch (err) {
      const code = errorCodeOf(err);
      log.warn('inner: turn failed', { guildId, code, error: err });
      measured = { result: { outcome: 'error', reason: code }, usd: 0, requests: 0, voice: 0 };
    } finally {
      for (const wake of group) running.delete(wake.id);
    }
    const result = measured.result ?? { outcome: 'error' };
    const outcome = result.outcome ?? 'error';
    const after = stateOf(guildId);
    if (HELD.has(outcome)) {
      // Stopped while it waited: its wakes go with the rest of the queue.
      if (after.stopped) {
        markHandled(after, group, 'stopped', now(), { guildId });
        save(guildId);
      }
      log.info('inner: turn held', { guildId, outcome, wakes: group.length });
      return { deferred: outcome };
    }
    const ended = now();
    const errorCode = outcome === 'error' ? (typeof result.reason === 'string' && result.reason ? result.reason : 'error') : null;
    after.turns.push({ at: ended, chainId, usd: measured.usd, outcome, kinds: [...new Set(group.map((wake) => wake.kind))], ...(errorCode ? { code: errorCode, failed: true } : {}) });
    // Each attention woken for counts the wake on its day (its own per-day bound).
    if (typeof intentions?.countAttendWake === 'function') {
      for (const id of new Set(group.filter((wake) => wake.kind === 'attend').flatMap((wake) => wake.intentionIds))) intentions.countAttendWake(guildId, id);
    }
    if (measured.usd > 0) after.spend.push({ at: ended, usd: measured.usd });
    // A failed attempt is no turn of the chain either: its wakes come back.
    if (!errorCode) after.chains[chainId] = { turns: (after.chains[chainId]?.turns ?? 0) + 1, lastAt: ended };
    const turnId = result.inner?.turnId ?? result.turnId ?? null;
    if (turnId) after.turnIds.push(String(turnId));
    const retry = errorCode && RETRY_CODES.has(errorCode) && !after.stopped ? planRetry(group, ended, settings, errorCode) : null;
    if (retry?.action === 'requeue') {
      const ids = new Set(group.map((wake) => wake.id));
      for (const wake of after.queue.filter((queued) => ids.has(queued.id))) Object.assign(wake, { retry: retry.n, firstFailedAt: retry.firstFailedAt, notBefore: retry.notBefore, lastCode: errorCode });
      log.info('inner: turn failed, wakes retried', { guildId, code: errorCode, retry: retry.n, wakes: group.length, notBefore: retry.notBefore });
      note(guildId, { event: 'retry', code: errorCode, retry: retry.n, notBefore: retry.notBefore, wakes: group.map(wakeFields) });
    } else {
      if (isReview && after.review) after.review = { ...after.review, done: true };
      if (retry?.action === 'drop') {
        markHandled(after, group, 'provider', ended, { guildId });
        log.warn('inner: turn failed, wakes dropped', { guildId, code: errorCode, retry: retry.n, wakes: group.length });
      } else {
        markHandled(after, group, outcome, ended, { guildId, named: result.inner?.intentIds ?? [] });
      }
    }
    // What did not go through (feedbackFacts): a feedback turn's own misses are journalled only;
    // any other turn's queue one feedback wake in its chain and conversation, due at the next tick.
    const isFeedback = anchor.kind === 'feedback';
    const feedback = feedbackOf(guildId, after, { result, records, isFeedback, at: ended });
    save(guildId);
    let feedbackWakeId = null;
    if (feedback.length > 0 && !isFeedback) {
      feedbackWakeId = `inner.wake:feedback:${turnId ?? ended}`;
      await enqueue(guildId, { id: feedbackWakeId, kind: 'feedback', reason: 'feedback', intentionIds: [], chainId, dueAt: ended, channelId: String(channel.id), privateChat: !channel.guild, here: current.channelId, turnId: turnId ? String(turnId) : null, facts: feedback, deliveryFor: [...new Set(group.flatMap((wake) => (wake.kind === 'intention_due' ? list(wake.intentionIds) : list(wake.deliveryFor))))] });
    }
    // The expired intentions the review listed were read: a turn that erred shows them again next time.
    if (expired && outcome !== 'error' && typeof intentions?.markExpiredShown === 'function') {
      for (const item of expired.items) intentions.markExpiredShown(guildId, item.id);
    }
    // What she did and found goes to her memory, shadow or live: her reads really ran; the
    // feedback facts ride the same episode (src/memory/inner-episode.js).
    if (result.inner?.episode && typeof onEpisode === 'function') {
      try {
        onEpisode(String(guildId), feedback.length > 0 ? { ...result.inner.episode, feedback } : result.inner.episode);
      } catch (err) {
        log.warn('inner: episode not handed to memory', { guildId, error: err });
      }
    }
    const actions = result.inner?.actions ?? [];
    log.info('inner: turn', { guildId, outcome, reason: result.reason ?? null, wakes: group.length, shadow, actions: actions.length, usd: measured.usd, voice: measured.voice });
    note(guildId, {
      event: 'turn',
      channelId: channel.guild ? String(channel.id) : null,
      outcome,
      reason: result.reason ?? null,
      shadow,
      turnId,
      wakes: group.map(wakeFields),
      coalesced: group.map((wake) => wake.id),
      actions,
      loop: result.inner?.loop ?? null,
      feedback: { facts: feedback, wake: feedbackWakeId },
      ...(errorCode ? { error: { code: errorCode } } : {}),
      cost: { usd: measured.usd, requests: measured.requests, voice: measured.voice },
    });
    return { outcome, wakes: group.length, usd: measured.usd, ...(feedbackWakeId ? { feedback: feedbackWakeId } : {}) };
  }

  /**
   * The feedback facts of a turn that just ended (feedbackFacts over `result`, with the purposes
   * of `records`): for a turn that is not itself a feedback turn, also the wakes of hers dropped
   * `no-channel` and the queued ones held on a cap with a due time over an hour past, each told
   * once (marked `told` on the state; the caller saves).
   */
  function feedbackOf(guildId, state, { result, records, isFeedback, at }) {
    const wakes = [];
    if (!isFeedback) {
      for (const [id, entry] of Object.entries(state.handled)) {
        if (!DROP_TOLD.has(entry?.outcome) || entry.told !== false) continue;
        wakes.push({ id, kind: entry.kind ?? null, code: entry.outcome, intentionIds: list(entry.intentionIds) });
        entry.told = true;
      }
      for (const wake of state.queue) {
        if (!wake.capped || wake.told === true || !(Number.isFinite(wake.dueAt) && wake.dueAt <= at - WAKE_HELD_MS)) continue;
        wakes.push({ id: wake.id, kind: wake.kind, code: String(wake.capped), intentionIds: list(wake.intentionIds) });
        wake.told = true;
      }
    }
    // The purposes of the dropped wakes' intentions, closed or not (the facts name them).
    const known = new Set(records.map((record) => String(record.id)));
    const more = wakes.flatMap((wake) => wake.intentionIds).filter((id) => !known.has(String(id))).map((id) => intentions?.store?.(guildId)?.get?.(id) ?? null).filter(Boolean);
    return feedbackFacts(result, { wakes, named: result.inner?.intentIds ?? [], intentions: [...records, ...more] });
  }

  /**
   * An errand's end: one an inner turn handed off has its cost recorded in the day's spend.
   * Answers whether a cost was counted. Never throws.
   */
  function onTaskFinished(task, guildId = getGuildId()) {
    try {
      if (!guildId || !task?.id) return false;
      const state = stateOf(guildId);
      const id = String(task.id);
      const handedOff = task.origin?.turnId && state.turnIds.includes(String(task.origin.turnId));
      const usd = Number(task.usage?.usd);
      const counted = Boolean(handedOff) && Number.isFinite(usd) && usd > 0;
      if (counted) state.spend.push({ at: now(), usd });
      if (!counted) return false;
      save(guildId);
      note(guildId, { event: 'errand-cost', taskId: id, usd: counted ? usd : 0 });
      return counted;
    } catch (err) {
      log.warn('inner: errand cost not counted', { code: err?.code ?? null });
      return false;
    }
  }

  /** The kill switch: stopped (persisted), the queue dropped (journalled). */
  function stop(guildId = getGuildId(), { by = null } = {}) {
    if (!guildId) return { ok: false, code: 'no-guild' };
    const state = stateOf(guildId);
    const at = now();
    const queued = state.queue.filter((wake) => !running.has(wake.id));
    const dropped = queued.length;
    markHandled(state, queued, 'stopped', at, { guildId });
    const already = state.stopped;
    state.stopped = true;
    state.stoppedAt = already ? state.stoppedAt : at;
    state.stoppedBy = by ? String(by) : state.stoppedBy;
    save(guildId);
    log.info('inner: stopped', { guildId, dropped, already });
    note(guildId, { event: 'stopped', dropped, by: by ? String(by) : null });
    return { ok: true, already, dropped };
  }

  /** The kill switch released (persisted). */
  function start(guildId = getGuildId(), { by = null } = {}) {
    if (!guildId) return { ok: false, code: 'no-guild' };
    const state = stateOf(guildId);
    const already = !state.stopped;
    state.stopped = false;
    state.stoppedAt = null;
    state.stoppedBy = null;
    save(guildId);
    log.info('inner: started', { guildId, already });
    note(guildId, { event: 'started', by: by ? String(by) : null });
    return { ok: true, already };
  }

  /** The earliest moment something will wake her (null when nothing is known), and what: `queue`, `intention` or `review`. */
  function nextWakeOf(state, open, at) {
    const found = [];
    for (const wake of state.queue) if (Number.isFinite(wake.notBefore ?? wake.dueAt)) found.push({ at: wake.notBefore ?? wake.dueAt, kind: 'queue' });
    // A time already past that she handled counts no more; one not yet handled wakes her at the next tick.
    const upcoming = (record, reason, when) => Number.isFinite(when) && (when > at || !state.handled[wakeOfDue({ intention: record, reason, at: when }).id]);
    for (const record of open) {
      if (record.status !== 'pending' && record.status !== 'waiting') continue;
      if (upcoming(record, 'due', record.dueAt)) found.push({ at: record.dueAt, kind: 'intention' });
      if (record.status === 'waiting' && upcoming(record, 'wait-deadline', record.waitDeadline)) found.push({ at: record.waitDeadline, kind: 'intention' });
    }
    const review = state.review;
    if (review && review.done !== true && Number.isFinite(review.at)) found.push({ at: review.at, kind: 'review' });
    return found.length > 0 ? found.reduce((first, item) => (item.at < first.at ? item : first)) : null;
  }

  /**
   * What the owner's status shows: the switch, the mode, the stop, the queue, the review, the budgets,
   * and for the status card the chains of the day, the open intentions by
   * status, the next wake and the last inner turn.
   */
  function status(guildId = getGuildId()) {
    const settings = innerSettings(hot.config);
    if (!guildId) return { on: innerOn(hot.config), mode: settings.mode, stopped: false, queue: [], review: null, budgets: null, chains: 0, spentUsd: 0, intentions: null, attention: null, next: null, lastTurn: null, lastError: null };
    const state = stateOf(guildId);
    const at = now();
    const timezone = timezoneOf();
    const { start } = dayBounds(at, timezone);
    let open = [];
    if (intentions && intentionsOn(hot.config)) {
      try {
        open = (intentions.list(guildId, { all: true }) ?? []).filter((record) => ['pending', 'waiting', 'proposed'].includes(record?.status));
      } catch (err) {
        log.warn('inner: status intentions failed', { guildId, code: err?.code ?? null });
      }
    }
    const countOf = (name) => open.filter((record) => record.status === name).length;
    const last = state.turns.reduce((latest, turn) => (!latest || turn.at >= latest.at ? turn : latest), null);
    const lastFailed = state.turns.reduce((latest, turn) => (turn.outcome === 'error' && (!latest || turn.at >= latest.at) ? turn : latest), null);
    // Her attention today: the attend wakes handled (run: a turn ran for it) and the queued ones.
    const attention = { open: open.filter((record) => record.status === 'pending' && isAttend(record)).length, listed: 0, run: 0, spoken: 0, skipped: 0, waiting: 0 };
    for (const [id, entry] of Object.entries(state.handled)) {
      if (!id.startsWith(ATTEND_PREFIX) || !(entry?.at >= start)) continue;
      attention.listed += 1;
      if (TURN_OUTCOMES.has(entry.outcome)) attention.run += 1;
      if (entry.outcome === 'spoke') attention.spoken += 1;
      if (entry.outcome === 'skip') attention.skipped += 1;
    }
    for (const wake of state.queue) {
      if (wake.kind !== 'attend') continue;
      attention.listed += 1;
      if (wake.capped) attention.waiting += 1;
    }
    return {
      on: innerOn(hot.config),
      mode: settings.mode,
      stopped: state.stopped,
      stoppedAt: state.stoppedAt,
      queue: state.queue.map((wake) => ({ id: wake.id, kind: wake.kind, dueAt: wake.dueAt ?? null, capped: wake.capped ?? null })),
      review: state.review ? { day: state.review.day, at: state.review.at ?? null, done: state.review.done === true } : null,
      budgets: budgetsOf(state, settings, { now: at, timezone }),
      chains: new Set(state.turns.filter((turn) => turn.at >= start).map((turn) => turn.chainId)).size,
      spentUsd: Math.round(state.spend.filter((item) => item.at >= start).reduce((sum, item) => sum + item.usd, 0) * 10000) / 10000,
      intentions: { pending: countOf('pending'), waiting: countOf('waiting'), proposed: countOf('proposed') },
      attention,
      next: nextWakeOf(state, open, at),
      lastTurn: last ? { at: last.at, outcome: typeof last.outcome === 'string' ? last.outcome : null } : null,
      lastError: lastFailed ? { at: lastFailed.at, code: typeof lastFailed.code === 'string' ? lastFailed.code : 'error' } : null,
    };
  }

  /** The tick on its own timer, every `innerLife.tickSeconds` (read before each wait). */
  function startTimer() {
    stopped = false;
    const schedule = () => {
      if (stopped) return;
      const ms = innerSettings(hot.config).tickSeconds * 1000;
      timer = setTimer(() => {
        Promise.resolve()
          .then(tick)
          .catch((err) => log.warn('inner: tick failed', { error: err }))
          .finally(schedule);
      }, ms);
      timer?.unref?.();
    };
    schedule();
  }

  function stopTimer() {
    stopped = true;
    if (timer) clearTimeout(timer);
    timer = null;
  }

  return { tick, drain, onWake, onTaskFinished, mayAct, stop, start, status, places, startTimer, stopTimer, state: stateOf };
}
