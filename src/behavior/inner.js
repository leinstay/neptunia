// The persona's inner life, step 2 (docs/inner-life.md): a deterministic scheduler that lists
// what is due for her -- an intention whose time came, an errand she waits for that ran past its
// deadline, and one review a day at a random moment inside the hours she usually speaks in (drawn
// from her own `said` lines in the record, re-drawn every local day) -- and hands each as an
// `inner.wake` event through the core's event door (src/interface/door.js). Listing is not
// choosing: no model runs here, nothing ranks or invents a reason. A queued wake keeps its due
// time while people's turns hold the lease; compatible wakes (the same conversation, and
// the day's review with any server one) coalesce into one inner turn; a queue past
// `innerLife.queueMax` records the overflow. The inner turn itself is the turn runner's
// (src/behavior/turn.js, mode `inner`): no human message, a `<wake>` block, her tools.
//
// The heartbeat (docs/inner-life.md "The heartbeat"): a wake kind of its own on its own timer,
// `innerLife.heartbeat.everyMinutes` moved by a jitter either way, kept in the state
// (`heartbeat: { nextAt, lastAt }`, drawn again once its wake is handled). It has no place and its own chain
// (`heartbeat:<at>`), is never coalesced with another wake and goes before them in the queue; its `<wake>` facts
// are built by src/behavior/heartbeat-view.js.
//
// Bounds are code, not prose (`innerLife.caps`, a ceiling the owner accepted): inner turns per
// local day and per rolling hour, per causal chain (an intention's `chainId`, else the intention
// itself; a review is its day's chain), public posts per local day. No bound is in dollars: what
// a turn and the errands it hands off cost is recorded (`state.spend`, the `errand-cost` journal
// event) and reported, never limited.
// Every drop and every hold of a wake is a fact at the moment it happens, and so is every call
// outcome that did not go well: facts are kept in the state (`state.facts`) until a model answer
// that carried them completed (`told`), and are shown by the first turn that can carry them -- an
// inner turn's `<wake>`, or an addressed turn (src/behavior/turn.js). A fact of a private chat is
// shown only in that chat; a fact of the server never in a private chat.
// A review's `<wake>` also tells her once which intentions of hers expired untouched since she was
// last told (`innerLife.review.expiredMax` newest, the rest counted; a candidate never): each is marked
// shown on its record once the review turn ran, so a held or erred review lists them again.
// Over a cap no turn runs and the refusal is journalled once per wake and held as a fact (with the
// local midnight it waits for). What is left and when it resets reach her as facts in `<wake>`,
// never as a rule.
//
// Feedback on her own turn (docs/inner-life.md "Feedback on her own turn"): when an inner turn
// ends, `feedbackFacts` lists from its result what did not go through -- output she wrote outside
// a call and lost, every call whose status was not `ok`, an intention she closed as done while no
// delivery call went through, and the loop cut with calls dropped; a failed turn is a fact too
// (`turnFailed`). A non-empty list is kept as facts and queues ONE `feedback` wake
// (`inner.wake:feedback:<turnId>`) in the turn's chain and conversation, due at the next tick,
// carrying them -- unless the turn's own wakes come back for a retry, which carries them. The
// feedback wake is never held by a cap, never coalesced with another wake and does not count
// against the chain; a feedback turn's own misses are facts but queue no second wake (no loops).
//
// A recurring intention (`every`, src/intentions/model.ts) is advanced to its next occurrence
// whenever a wake naming it is marked handled -- her turn ended (whatever its outcome), or the
// engine dropped the wake (`no-channel`, `overflow`, `stale`, the stop) --
// through the intention service's `advance`: `recurred` when a call of the turn named it (the
// turn result's `inner.intentIds`), `missed` otherwise. Without a chain of its own each occurrence
// is its own chain (`intention:<id>:<dueAt>`), so the per-chain cap bounds one occurrence. The
// last occurrence before its expiry carries the note `last-occurrence` on its `<wake>` line.
//
// Her attention (docs/inner-life.md "Her attention"): an open intention of kind `attend`
// (src/intentions/model.ts) names a place; the tick counts the place's lines in the record since
// her last look there -- her last own line in that place, or the last attend wake handled for
// that place, whichever is later, and never before the attention was set -- and, once the newest
// line is `settle` seconds old, lists one `attend` wake (`inner.wake:attend:<intentionId>:<newestLineId>`,
// each wake its own chain). One queued wake per attention: a newer burst replaces the queued wake's
// id and newest line, nothing observed lost (the turn's history is the place's lines). With
// `people` on the attention only their lines count and the wake names them. Past the attention's
// own `perDay` the wake waits in the queue (`capped: 'attend-per-day'`), as a chain past
// `innerLife.caps.perChain` waits (`capped: 'per-chain'`). The record is read incrementally (a per-guild place index over the last
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
//
// With `memoryDb.wakeRuns` exactly true (read at the turn) each inner turn is also a wake run in the memory database
// (src/memory/db/wakes.js, through the service's writer): started before the turn runs (its id the in-flight turn id,
// its inputs the ids and versions its view showed, the envelope's policy version), each action recorded once by its
// number, ended `succeeded` or `failed` with the outcome. The journal and the state file are unchanged by it.

import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { AsyncLocalStorage } from 'node:async_hooks';
import { log as defaultLog, onLog } from '../log.js';
import { writeJsonAtomic } from '../memory/index.js';
import { DAY_MS, HOUR_MS, MINUTE_MS, utcDay, zonedDay, zonedEpoch } from '../time.js';
import { localHour } from '../format.js';
import {
  attendCounter,
  expiredToShow,
  intentionsOn,
  isAttend,
  nextOccurrence,
  openFromHeartbeat,
  wakeTimeOf,
  HEARTBEAT_ORIGIN,
} from '../intentions/model.ts';
import { foldText } from '../memory/recent.js';
import { errorCodeOf } from '../llm/openrouter.js';
import { CODE } from '../tools/codes.ts';
import { WAKE_POLICY_VERSION } from '../tools/access.ts';
import { buildHeartbeatFacts } from './heartbeat-view.js';
import { storedWakes } from './wake.js';

/** The wake kinds, as the `<wake>` block names them. */
export const WAKE_KINDS = Object.freeze([
  'intention_due',
  'review',
  'errand_deadline',
  'attend',
  'feedback',
  'heartbeat',
]);

/** The defaults of the `innerLife` section (config.json carries the same). */
export const INNER_DEFAULTS = Object.freeze({
  mode: 'shadow',
  tickSeconds: 60,
  queueMax: 20,
  chatMessages: 30,
  review: Object.freeze({ enabled: true, historyDays: 14, expiredMax: 5 }),
  heartbeat: Object.freeze({
    enabled: true,
    everyMinutes: 180,
    jitterMinutes: 60,
    people: 8,
    filteredShown: 10,
    closedShown: 10,
    historyDays: 14,
    placesHours: 6,
    placesShown: 6,
    placeLines: 2,
    maxTokens: 2500,
    intentionsOnly: true,
    maxOpen: 3,
    maxRecurring: 1,
    dueJitterMinutes: 20,
  }),
  caps: Object.freeze({ perChain: 3 }),
  attention: Object.freeze({ settleSeconds: 90, perDayDefault: 12, pageSize: 12, placesInWake: 8, lookbackHours: 24 }),
  loop: Object.freeze({ maxSteps: 4, timeBudgetMs: 180000, maxCallsPerStep: 4, callTimeoutMs: 60000 }),
  retry: Object.freeze({ delaysMinutes: Object.freeze([1, 5, 15, 60]), maxHours: 6 }),
  factsKeepDays: 7,
});

/** The orders the places view knows (`places.list` `sort=`). */
export const PLACE_SORTS = Object.freeze(['recent', 'name', 'lines']);
/** The wake id prefix of an attend wake (its intention and newest line follow). */
const ATTEND_PREFIX = 'inner.wake:attend:';
/** The error codes of a failed turn whose wakes are retried; any other error is handled as an ended turn. */
const RETRY_CODES = new Set(['provider-limit', 'provider-error', 'timeout']);
/** The outcomes of a wake that never ran a turn for it: each is a `wakeDropped` fact at the moment it happens. */
const DROP_OUTCOMES = new Set(['stopped', 'overflow', 'stale', 'superseded', 'error', 'provider', 'no-channel']);
/** How far behind the last scan the record is read again (a line appended late is still seen; ids de-duplicate). */
const SCAN_LAG_MS = 5 * MINUTE_MS;

/** The state file's schema version. */
const VERSION = 1;
/** How long a turn or a spend is kept in the state (the longest window is a day). */
const KEEP_MS = 2 * DAY_MS;
/**
 * How long a handled wake id is kept: longer than an intention lives
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
/** The skills that post where people read. */
export const POSTING_SKILLS = Object.freeze(['message.create', 'draw.create', 'voice.say']);
/** The calls that deliver something out of an inner turn: a post, a picture, an errand. */
export const DELIVERY_SKILLS = Object.freeze(['message.create', 'draw.create', 'voice.say', 'errand.run']);
/** The kinds of feedback facts, as `labels.wake.feedback.<kind>` names them. */
export const FEEDBACK_KINDS = Object.freeze([
  'callFailed',
  'doneWithoutDelivery',
  'loopCut',
  'wakeDropped',
  'wakeHeld',
  'turnFailed',
  'sendFailed',
  'stateLost',
  'memoryFailed',
  'interrupted',
  'diagnostic',
]);
/** The statuses of a call that did not go well (src/tools/executors.ts), as `callFailed` names them. */
const CALL_STATUSES = new Set([
  'failed',
  'partial',
  'invalid',
  'denied',
  'not_configured',
  'refused',
  'unknown',
  'timeout',
]);
/** The most facts one turn is shown; the rest stay for the next one. */
export const FACTS_SHOWN_MAX = 12;

/**
 * What did not go through in one inner turn, from its result (src/behavior/turn.js's
 * `{ outcome, inner: { actions, intentIds, loop } }`), as a list of facts, each
 * `{ kind, ... }` (FEEDBACK_KINDS), in this order: one `callFailed` per call whose status was not `ok`
 * and not `presented` in a later step of the turn (`failed`, `partial`, `invalid`, `denied`, `not_configured`, `refused`, `unknown`, `timeout`; `skill`, `status`, `code`, and the
 * operation's own `text` when it said one; a tag of hers refused by the gate is the `message.create` it was lowered into); one `doneWithoutDelivery` per intention an executed `intention.update`
 * closed as done (`state` `done` on the action, its `intentionId`, else the one id in `named`)
 * while no delivery call (`posting`, DELIVERY_SKILLS) was executed in the turn (`named` defaults
 * to the result's `inner.intentIds`; `intentionId`,
 * `purpose` from `intentions` when known); `loopCut` when the loop ended by its step or time
 * bound with calls dropped (`cut`, `droppedCalls`, `steps`); one `diagnostic` per parser diagnostic of her output that
 * no later step showed her (`inner.diagnostics`; `diagnostic` its kind). [] when nothing is wrong. Pure.
 * @param {object|null} turnResult
 * @param {{ named?: string[], posting?: readonly string[], intentions?: object[] }} [options]
 * @returns {object[]}
 */
export function feedbackFacts(turnResult, { named = null, posting = DELIVERY_SKILLS, intentions = [] } = {}) {
  const inner = turnResult?.inner ?? {};
  const actions = list(inner.actions);
  const facts = [];
  const purposeOf = (id) => {
    const record = list(intentions).find((item) => item && String(item.id) === String(id));
    return typeof record?.purpose === 'string' ? record.purpose : '';
  };
  for (const action of actions) {
    if (!action || typeof action.skill !== 'string') continue;
    // A call whose result a later step of the turn showed her is told already.
    if (action.status === 'proposed' || action.presented === true) continue;
    const refused = action.status === 'refused';
    const result = typeof action.result === 'string' ? action.result : 'ok';
    if (!refused && result === 'ok') continue;
    const status = refused
      ? 'refused'
      : result === 'timeout' || action.code === CODE.TIMEOUT
        ? 'timeout'
        : CALL_STATUSES.has(result)
          ? result
          : 'failed';
    facts.push({
      kind: 'callFailed',
      skill: action.skill,
      status,
      code: typeof action.code === 'string' && action.code ? action.code : null,
      ...(typeof action.text === 'string' && action.text ? { text: action.text } : {}),
    });
  }
  const delivered = actions.some(
    (action) => action?.status === 'executed' && action.result === 'ok' && posting.includes(action.skill)
  );
  if (!delivered) {
    const ids = list(named ?? inner.intentIds).map(String);
    const closed = [];
    for (const action of actions) {
      if (
        action?.skill !== 'intention.update' ||
        action.status !== 'executed' ||
        action.result !== 'ok' ||
        action.state !== 'done'
      )
        continue;
      const id =
        typeof action.intentionId === 'string' && action.intentionId
          ? action.intentionId
          : ids.length === 1
            ? ids[0]
            : null;
      if (id && !closed.includes(id)) closed.push(id);
    }
    for (const id of closed) facts.push({ kind: 'doneWithoutDelivery', intentionId: id, purpose: purposeOf(id) });
  }
  const loop = inner.loop;
  if (loop && typeof loop.cut === 'string' && loop.cut && Number.isFinite(loop.droppedCalls) && loop.droppedCalls > 0) {
    facts.push({
      kind: 'loopCut',
      cut: loop.cut,
      droppedCalls: loop.droppedCalls,
      steps: Number.isFinite(loop.steps) ? loop.steps : 0,
    });
  }
  // What the parser did with her output that no later step told her (src/llm/parse.js diagnostics).
  for (const diagnostic of list(inner.diagnostics)) {
    if (diagnostic && typeof diagnostic.kind === 'string') {
      const { kind, ...rest } = diagnostic;
      facts.push({ kind: 'diagnostic', diagnostic: kind, ...rest });
    }
  }
  return facts;
}

/** The state's facts that `scope` may see and that are not told yet, oldest first (the callers cut them to FACTS_SHOWN_MAX). `scope`: `{ channelId, privateChat, anywhere }`. */
export function pendingFactsOf(state, { channelId = null, privateChat = false, anywhere = false } = {}) {
  const here = channelId === null || channelId === undefined ? null : String(channelId);
  return list(state?.facts).filter((fact) => {
    if (fact.told) return false;
    if (privateChat === true) return fact.privateChat === true && here !== null && fact.channelId === here;
    if (fact.privateChat === true) return false;
    return anywhere || fact.channelId === null || fact.channelId === here;
  });
}

/** `fact` (`{ kind, channelId, privateChat, at, ...payload }`) appended to `state.facts` (an id given). Returns the stored fact. */
export function addFactTo(state, fact, id) {
  const { channelId = null, privateChat = false, at, ...payload } = fact;
  const stored = {
    ...payload,
    id,
    channelId: channelId === null || channelId === undefined ? null : String(channelId),
    privateChat: privateChat === true,
    at: Number.isFinite(at) ? at : 0,
    told: false,
  };
  state.facts = [...list(state.facts), stored];
  return stored;
}

/** The facts of `ids` marked told at `at`. */
export function markFactsTold(state, ids, at) {
  const set = new Set(list(ids).map(String));
  for (const fact of list(state?.facts)) if (set.has(fact.id) && !fact.told) fact.told = at;
}

/** A fact as the prompt shows it: its payload without the bookkeeping. */
export function factPayload(fact) {
  const { id, channelId, privateChat, at, told, ...payload } = fact;
  return payload;
}

/**
 * The facts of an addressed turn when no inner life keeps them (and of tests): the same three
 * calls as the inner life's `facts`, in process only, one list for every guild.
 * @param {{ now?: () => number }} [options]
 */
export function createLocalFacts({ now = Date.now } = {}) {
  const state = { facts: [] };
  let n = 0;
  return {
    enabled: () => true,
    add: (guildId, fact) => addFactTo(state, { at: now(), ...fact }, `local-${++n}`),
    pending: (guildId, scope) => pendingFactsOf(state, scope),
    markTold: (guildId, ids) => {
      markFactsTold(state, ids, now());
      state.facts = state.facts.filter((fact) => !fact.told);
    },
  };
}

/** Whether the inner life runs (`features.innerLife` exactly true). */
export function innerOn(config) {
  return config?.features?.innerLife === true;
}

const count = (value, fallback) => (Number.isFinite(value) && value >= 0 ? value : fallback);
/** A whole number of at least `min`, else `fallback`. */
const whole = (value, fallback, min = 1) => (Number.isInteger(value) && value >= min ? value : fallback);
/** A positive finite number, else `fallback`. */
const positive = (value, fallback) =>
  typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : fallback;

/**
 * The `innerLife` section with every number checked against INNER_DEFAULTS (a missing or bad value
 * takes the default). `mode` is `live` only when it says so exactly. `loop`: the tool loop's
 * bounds of an inner turn (src/behavior/turn.js#loopSettings with `inner`; nobody waits for
 * one, so its budget is generous): `maxSteps`, `timeBudgetMs`, `maxCallsPerStep` as
 * `tools.loop`'s, `callTimeoutMs` the most one call of hers may run.
 * @param {object} config
 */
export function innerSettings(config) {
  const raw = config?.innerLife ?? {};
  const caps = raw.caps ?? {};
  const heartbeat = raw.heartbeat ?? {};
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
    review: {
      enabled: review.enabled !== false,
      historyDays: Math.max(1, count(review.historyDays, d.review.historyDays)),
      expiredMax: Math.floor(count(review.expiredMax, d.review.expiredMax)),
    },
    heartbeat: {
      enabled: heartbeat.enabled !== false,
      everyMinutes: Math.max(1, count(heartbeat.everyMinutes, d.heartbeat.everyMinutes)),
      jitterMinutes: count(heartbeat.jitterMinutes, d.heartbeat.jitterMinutes),
      dueJitterMinutes: count(heartbeat.dueJitterMinutes, d.heartbeat.dueJitterMinutes),
      people: Math.floor(count(heartbeat.people, d.heartbeat.people)),
      filteredShown: Math.floor(count(heartbeat.filteredShown, d.heartbeat.filteredShown)),
      closedShown: Math.floor(count(heartbeat.closedShown, d.heartbeat.closedShown)),
      historyDays: Math.max(1, count(heartbeat.historyDays, d.heartbeat.historyDays)),
      placesHours: Math.max(1, count(heartbeat.placesHours, d.heartbeat.placesHours)),
      placesShown: Math.floor(count(heartbeat.placesShown, d.heartbeat.placesShown)),
      placeLines: Math.floor(count(heartbeat.placeLines, d.heartbeat.placeLines)),
      maxTokens: Math.floor(count(heartbeat.maxTokens, d.heartbeat.maxTokens)),
      intentionsOnly: heartbeat.intentionsOnly !== false,
      maxOpen: Math.floor(count(heartbeat.maxOpen, d.heartbeat.maxOpen)),
      maxRecurring: Math.floor(count(heartbeat.maxRecurring, d.heartbeat.maxRecurring)),
    },
    caps: {
      perChain: Math.floor(count(caps.perChain, d.caps.perChain)),
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
    // A fact not told yet is kept this many days.
    factsKeepDays: positive(raw.factsKeepDays, d.factsKeepDays),
    // A failed turn's wakes come back after the next of these delays while the first failure is younger than maxHours.
    retry: {
      delaysMinutes:
        Array.isArray(retry.delaysMinutes) &&
        retry.delaysMinutes.length > 0 &&
        retry.delaysMinutes.every((m) => positive(m, 0) > 0)
          ? [...retry.delaysMinutes]
          : [...d.retry.delaysMinutes],
      maxHours: positive(retry.maxHours, d.retry.maxHours),
    },
  };
}

/** A fresh state. */
export function emptyState() {
  return {
    v: VERSION,
    stopped: false,
    stoppedAt: null,
    stoppedBy: null,
    queue: [],
    handled: {},
    review: null,
    heartbeat: null,
    turns: [],
    spend: [],
    turnIds: [],
    facts: [],
    inflight: null,
  };
}

const list = (value) => (Array.isArray(value) ? value : []);
const object = (value) => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});

/** The in-flight mark of a turn read from disk (`state.inflight`), or null when it is not whole. */
function inflightOf(raw) {
  if (
    !raw ||
    typeof raw !== 'object' ||
    typeof raw.turnId !== 'string' ||
    !raw.turnId ||
    !Number.isFinite(raw.startedAt)
  )
    return null;
  const wakeIds = list(raw.wakeIds).filter((id) => typeof id === 'string');
  if (wakeIds.length === 0) return null;
  return {
    turnId: raw.turnId,
    wakeIds,
    kind: typeof raw.kind === 'string' ? raw.kind : '',
    startedAt: raw.startedAt,
    channelId: raw.channelId == null ? null : String(raw.channelId),
    privateChat: raw.privateChat === true,
    privateUserId: raw.privateUserId == null ? null : String(raw.privateUserId),
  };
}

/** A state read from disk made whole (a missing part empty). */
export function normalizeState(raw) {
  const base = emptyState();
  if (!raw || typeof raw !== 'object') return base;
  return {
    ...base,
    stopped: raw.stopped === true,
    stoppedAt: Number.isFinite(raw.stoppedAt) ? raw.stoppedAt : null,
    stoppedBy: typeof raw.stoppedBy === 'string' ? raw.stoppedBy : null,
    queue: storedWakes(raw.queue, WAKE_KINDS),
    handled: object(raw.handled),
    review: raw.review && typeof raw.review.day === 'string' ? raw.review : null,
    heartbeat:
      raw.heartbeat &&
      typeof raw.heartbeat === 'object' &&
      (Number.isFinite(raw.heartbeat.nextAt) || Number.isFinite(raw.heartbeat.lastAt))
        ? {
            nextAt: Number.isFinite(raw.heartbeat.nextAt) ? raw.heartbeat.nextAt : null,
            lastAt: Number.isFinite(raw.heartbeat.lastAt) ? raw.heartbeat.lastAt : null,
          }
        : null,
    turns: list(raw.turns).filter((turn) => Number.isFinite(turn?.at)),
    spend: list(raw.spend).filter((item) => Number.isFinite(item?.at) && Number.isFinite(item?.usd)),
    turnIds: list(raw.turnIds).filter((id) => typeof id === 'string'),
    facts: list(raw.facts).filter((fact) => fact && typeof fact.id === 'string' && typeof fact.kind === 'string'),
    inflight: inflightOf(raw.inflight),
  };
}

/**
 * `state` without what is older than its windows (handled ids, turns, spend).
 */
export function pruneState(state, now, { factsKeepMs = INNER_DEFAULTS.factsKeepDays * DAY_MS } = {}) {
  const since = now - KEEP_MS;
  const handled = Object.fromEntries(
    Object.entries(state.handled).filter(([, entry]) => Number.isFinite(entry?.at) && entry.at >= now - CHAIN_KEEP_MS)
  );
  return {
    ...state,
    handled,
    turns: state.turns.filter((turn) => turn.at >= since),
    spend: state.spend.filter((item) => item.at >= since),
    turnIds: state.turnIds.slice(-TURN_IDS_MAX),
    // A fact is dropped a day after it was told, or when it has waited the whole keep time.
    facts: list(state.facts).filter((fact) => (fact.told ? fact.told >= now - DAY_MS : fact.at >= now - factsKeepMs)),
  };
}

/** Where an intention lands: its destination, else the conversation it came from; and whether that is a private chat. */
function targetOf(intention) {
  const privateChat = intention?.provenance?.scope === 'dm';
  const channelId = privateChat
    ? (intention.provenance?.channelId ?? null)
    : (intention?.destination ?? intention?.provenance?.channelId ?? null);
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
  const cause = list(group).find((wake) => wake && !channelless(wake)) ?? null;
  if (!cause) return { channelId: null, why: null };
  const pick = (id, why) =>
    id !== null && id !== undefined && String(id) !== ''
      ? { channelId: String(id), why }
      : { channelId: null, why: null };
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
 * The wake of one entry of src/intentions/model.ts#dueList (`{ intention, reason, at }`): an `errand_deadline` for a
 * wait past its deadline (its id names the errand), else an `intention_due` (its id names the due time), so the same
 * due item is always the same wake and a new due time is a new one. Its chain is the intention's `chainId`, else the
 * intention -- or, for a recurring intention (`every`), this occurrence of it: each occurrence is its own chain.
 */
export function wakeOfDue({ intention, reason, at }) {
  const deadline = reason === 'wait-deadline';
  const kind = deadline ? 'errand_deadline' : 'intention_due';
  const errandId = deadline ? (intention.awaitingErrandId ?? intention.lastErrandId ?? null) : null;
  const { channelId, privateChat } = targetOf(intention);
  return {
    id: deadline
      ? `inner.wake:errand_deadline:${intention.id}:${errandId}`
      : `inner.wake:intention_due:${intention.id}:${at}`,
    kind,
    reason: deadline ? 'wait-deadline' : 'due',
    intentionIds: [intention.id],
    chainId: intention.chainId
      ? `chain:${intention.chainId}`
      : intention.every && !deadline
        ? `intention:${intention.id}:${at}`
        : `intention:${intention.id}`,
    dueAt: at,
    channelId,
    privateChat,
    ...(errandId ? { errandId: String(errandId) } : {}),
  };
}

/**
 * The `errand_deadline` wakes of intentions a reconciliation already moved back to `pending`
 * with the note `wait-deadline` (at start, before the scheduler's first tick): the same id as the
 * wake the wait itself would have given, so the two never wake her twice.
 */
export function deadlineWakes(records) {
  return list(records)
    .filter((record) => record?.status === 'pending' && record.note === 'wait-deadline' && record.lastErrandId)
    .map((record) =>
      wakeOfDue({
        intention: { ...record, awaitingErrandId: record.lastErrandId },
        reason: 'wait-deadline',
        at: record.updatedAt ?? record.createdAt ?? 0,
      })
    );
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
  const counted = list(lines).filter(
    (line) =>
      line &&
      !line.said &&
      Number.isFinite(line.at) &&
      (people.length === 0 || (line.by && people.includes(String(line.by))))
  );
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
  const kept = list(entries).filter(
    (entry) => entry && (needle === null || foldText(String(entry.name ?? entry.id ?? '')).includes(needle))
  );
  const byName = (a, b) =>
    String(a.name ?? a.id).localeCompare(String(b.name ?? b.id)) || String(a.id).localeCompare(String(b.id));
  const sorted = [...kept].sort((a, b) => {
    if (sort === 'name') return byName(a, b);
    if (sort === 'lines') return (b.lines ?? 0) - (a.lines ?? 0) || byName(a, b);
    return (b.newestAt ?? -Infinity) - (a.newestAt ?? -Infinity) || byName(a, b);
  });
  const size = Math.max(1, Math.floor(pageSize));
  const number = Math.max(1, Math.floor(page));
  const start = (number - 1) * size;
  const items = sorted.slice(start, start + size);
  return {
    total: sorted.length,
    page: number,
    pageSize: size,
    more: Math.max(0, sorted.length - start - items.length),
    items,
  };
}

/** The wakes that belong to no place: the day's review and the heartbeat (their turn runs in a channel she was lately active in, posts name their channel). */
const channelless = (wake) => wake?.kind === 'review' || wake?.kind === 'heartbeat';

/** The heartbeat wake due at `at` (its own chain, no place). */
export function heartbeatWake(at) {
  return {
    id: `inner.wake:heartbeat:${at}`,
    kind: 'heartbeat',
    reason: 'heartbeat',
    intentionIds: [],
    chainId: `heartbeat:${at}`,
    dueAt: at,
    channelId: null,
    privateChat: false,
  };
}

/**
 * The moment of the next heartbeat after `from`: `everyMinutes` plus a jitter drawn evenly in
 * +-`jitterMinutes`, never less than a minute after `from`. `rng` in [0, 1).
 * @param {{ from: number, everyMinutes: number, jitterMinutes?: number, rng: () => number }} input
 * @returns {number}
 */
export function drawHeartbeatAt({ from, everyMinutes, jitterMinutes = 0, rng }) {
  const jitter = (rng() * 2 - 1) * jitterMinutes;
  return Math.round(from + Math.max(1, everyMinutes + jitter) * MINUTE_MS);
}

/** The day's review wake. */
export function reviewWake(day, at) {
  return {
    id: `inner.wake:review:${day}`,
    kind: 'review',
    reason: 'review',
    intentionIds: [],
    chainId: `review:${day}`,
    dueAt: at,
    channelId: null,
    privateChat: false,
  };
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
 * A retried wake (`retry`) joins only the wakes of its own failed group. A wake `isHeld` says is held (its own chain
 * is over its cap) is left out of every group, so it never joins one and never makes a review or a feedback wake wait.
 * A feedback wake is never coalesced with another kind: the feedback wakes of one conversation run together, first.
 * @param {object[]} queue
 * @returns {object[]}
 */
export function coalesceGroup(queue, isHeld = () => false) {
  const sorted = list(queue)
    .filter((wake) => !isHeld(wake))
    .sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0));
  if (sorted.length === 0) return [];
  const feedback = sorted.filter((wake) => wake.kind === 'feedback');
  if (feedback.length > 0) {
    const first = feedback[0];
    return feedback.filter(
      (wake) =>
        wake.channelId === first.channelId &&
        Boolean(wake.privateChat) === Boolean(first.privateChat) &&
        retryKey(wake) === retryKey(first)
    );
  }
  // The heartbeat is never coalesced and never waits behind another wake (a running turn holds the whole drain, so it comes at the next tick): it goes alone, after the feedback wakes.
  const beat = sorted.find((wake) => wake.kind === 'heartbeat');
  if (beat) return [beat];
  const anchor = sorted.find((wake) => wake.kind !== 'review') ?? null;
  // A retried wake runs only with the wakes of its own failed group (the same attempt and first failure); a fresh one never joins them.
  const key = retryKey(anchor ?? sorted[0]);
  const same = sorted.filter((wake) => retryKey(wake) === key);
  if (!anchor) return same;
  return same.filter((wake) =>
    wake.kind === 'review'
      ? !anchor.privateChat
      : wake.channelId === anchor.channelId && Boolean(wake.privateChat) === Boolean(anchor.privateChat)
  );
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

/** How many inner turns ran at `now`'s local day in `timezone`, a failed one (provider or engine error: its wakes retry) not counted. */
export function turnsToday(state, { now, timezone }) {
  const { start } = dayBounds(now, timezone);
  return state.turns.filter((turn) => turn.failed !== true && turn.at >= start).length;
}

/**
 * What becomes of the wakes of `group` after a turn that failed at `at`: `requeue` after the next delay of
 * `settings.retry.delaysMinutes` while the first failure is under `retry.maxHours` old, else `drop`; `n` counts attempts.
 * @param {unknown} [code]  The failure's code.
 * @returns {{ action: 'requeue'|'drop', n: number, firstFailedAt: number, notBefore: number|null }}
 */
export function planRetry(group, at, settings, code = CODE.ERROR) {
  const n = group.reduce((most, wake) => Math.max(most, Number.isInteger(wake.retry) ? wake.retry : 0), 0) + 1;
  const firstFailedAt = group.reduce(
    (first, wake) => Math.min(first, Number.isFinite(wake.firstFailedAt) ? wake.firstFailedAt : at),
    at
  );
  const { delaysMinutes, maxHours } = settings.retry;
  if (at - firstFailedAt >= maxHours * HOUR_MS) return { action: 'drop', n, firstFailedAt, notBefore: null, code };
  const delay = delaysMinutes[Math.min(n - 1, delaysMinutes.length - 1)] * MINUTE_MS;
  return { action: 'requeue', n, firstFailedAt, notBefore: at + delay, code };
}

/**
 * How many inner turns chain `chainId` has had on `now`'s local day in `timezone` (a failed attempt is no turn), and
 * how many are left under `cap`. A chain at its cap waits for the next local day. A feedback turn (one that
 * ran for feedback wakes only) is not counted.
 */
export function chainBudget(state, chainId, cap, { now, timezone }) {
  const { start } = dayBounds(now, timezone);
  const feedbackOnly = (turn) =>
    Array.isArray(turn.kinds) && turn.kinds.length > 0 && turn.kinds.every((kind) => kind === 'feedback');
  const used = state.turns.filter(
    (turn) => turn.chainId === chainId && turn.failed !== true && !feedbackOnly(turn) && turn.at >= start
  ).length;
  return { used, cap, left: Math.max(0, cap - used) };
}

/**
 * The cost of whatever runs inside `run(fn)`: every `llm: usage` line (its `upstreamCost`, else
 * `cost`; the `core` role counted apart, as `voice`, the journal field's name since the role was called so) and `images: generated` line logged in its async context
 * (AsyncLocalStorage over the log listeners, src/log.js#onLog), side requests it starts included;
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
 * @param {object|null} [options.intentions]  src/intentions/service.ts
 * @param {{ iterate: Function }|null} [options.record]  The record: her own lines for the review's
 *   hours, every place's lines for her attention.
 * @param {((guildId: string) => { id: string, name?: string|null, writable?: boolean|null }[])|null} [options.places]
 *   The places the interface publishes for the guild (opaque addresses, names, whether she can
 *   write there), for `places`; without it the places are the ones the record shows.
 * @param {((guildId: string, memberId: string) => string|null)|null} [options.nameOf]  A member's
 *   name for the `<wake>` lines (null: the id is shown).
 * @param {{ inner?: Function }|null} [options.journal]
 * @param {import('../interface/reads.ts').Reads|null} [options.reads]  The core's reads of the interface: the conversation a turn runs in.
 * @param {() => string} [options.iface]  The interface the conversations belong to (from `hello`).
 * @param {(conversationId: string) => string|null} [options.conversationName]  The name an interface reported for a
 *   conversation (src/interface/directory.ts); null when it reported none, and the id is shown.
 * @param {(event: object) => Promise<object>} [options.submit]  The event door's submit (src/index.js).
 * @param {{ state: { data: object } }|null} [options.store]  The memory store (its pause).
 * @param {() => string|null} [options.getGuildId]
 * @param {() => boolean} [options.peopleWaiting]  Calls queued for the attention (people first).
 * @param {() => Promise<unknown>} [options.ready]  Resolves once the journal's start-up reconciliation is done (src/index.js);
 *   a turn that a restart cut off is resolved from the journal only after it.
 * @param {() => string} [options.uuid]  Ids for the turns this life starts (the in-flight mark names the turn before it runs).
 * @param {{ run: Function }} [options.meter]  createCostMeter's.
 * @param {{ tasks?: (guildId: string) => object[], skills?: () => string[], agents?: () => string[], selfId?: () => string|null, focusPeople?: (guildId: string) => object|null }} [options.heartbeat]
 *   The sources of the heartbeat's facts that are not the stores above (src/behavior/heartbeat-view.js).
 * @param {{ recordWake?: (update: object) => Promise<unknown>|null }|null} [options.memoryDb]  The memory database
 *   (src/memory/db/service.js): with `memoryDb.wakeRuns` on, each inner turn is recorded as a wake run with its actions.
 * @param {() => number} [options.rng]
 * @param {() => number} [options.now]
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
  reads = null,
  iface = () => '',
  conversationName = () => null,
  submit = null,
  store = null,
  getGuildId = () => null,
  peopleWaiting = () => false,
  ready = () => Promise.resolve(),
  uuid = randomUUID,
  meter = null,
  heartbeat: heartbeatSources = {},
  memoryDb = null,
  rng = Math.random,
  now = Date.now,
  log = defaultLog,
}) {
  const states = new Map();
  // Per guild: the place index (the record's lines per place over the lookback window).
  const placeIndexes = new Map();
  const costs = meter ?? createCostMeter();
  // The ids of the wakes an inner turn is running for now (a stop leaves them to that turn).
  const running = new Set();
  let ticking = false;

  const fileOf = (guildId) => path.join(dataDir, 'guilds', String(guildId), 'inner.json');
  const timezoneOf = () => hot.config?.bot?.timezone ?? 'UTC';

  function stateOf(guildId) {
    const key = String(guildId);
    if (!states.has(key)) {
      let raw = null;
      let lost = null;
      try {
        raw = JSON.parse(fs.readFileSync(fileOf(key), 'utf8'));
      } catch (err) {
        if (err?.code !== 'ENOENT') lost = err?.code ?? 'parse';
      }
      const state = normalizeState(raw);
      states.set(key, state);
      if (lost !== null) loseState(key, state, lost);
    }
    return states.get(key);
  }

  /**
   * The state file could not be read: it is moved aside (`inner.json.bad-<ts>`, never overwritten),
   * the loss is logged and journalled, and a `stateLost` fact tells her at her next turn that she
   * started empty. Never a silent empty start. Never throws.
   */
  function loseState(key, state, code) {
    const at = now();
    const backup = `${fileOf(key)}.bad-${at}`;
    let kept = true;
    try {
      fs.renameSync(fileOf(key), backup);
    } catch (err) {
      kept = false;
      log.warn('inner: unreadable state could not be moved aside', { guildId: key, code: err?.code ?? null });
    }
    log.warn('inner: state unreadable, starting empty', { guildId: key, code, kept });
    note(key, { event: 'stateLost', code, kept });
    addFact(state, { at, kind: 'stateLost', code, channelId: null, privateChat: false });
    // Written only when the old file is safe aside; if it could not be moved it stays where it is.
    if (!kept) return;
    try {
      writeJsonAtomic(fileOf(key), state);
    } catch (err) {
      log.warn('inner: state write failed', { guildId: key, code: err?.code ?? null });
    }
  }

  function save(guildId) {
    const key = String(guildId);
    // Pruned in place: whoever holds the state object keeps seeing the one that is written.
    const next = Object.assign(
      stateOf(key),
      pruneState(stateOf(key), now(), { factsKeepMs: innerSettings(hot.config).factsKeepDays * DAY_MS })
    );
    try {
      writeJsonAtomic(fileOf(key), next);
    } catch (err) {
      log.warn('inner: state write failed', { guildId: key, code: err?.code ?? null });
    }
    return next;
  }

  /**
   * One write of the turn's wake run through the memory database's writer (`memoryDb.wakeRuns` exactly true, read
   * now; src/memory/db/wakes.js), in order with the others; a failure is logged with a code. Never throws.
   */
  function wakeWrite(update) {
    if (hot.config?.memoryDb?.wakeRuns !== true || typeof memoryDb?.recordWake !== 'function') return;
    Promise.resolve()
      .then(() => memoryDb.recordWake(update))
      .catch((err) => log.warn('inner: wake run not recorded', { op: update?.op ?? null, code: err?.code ?? null }));
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
      return store?.state?.data?.paused === true;
    } catch {
      return false;
    }
  }

  let factSeq = 0;

  /** `fact` kept in `state.facts` (not told yet); the fact's `channelId` and `privateChat` say where it may be shown. */
  function addFact(state, fact) {
    const at = Number.isFinite(fact.at) ? fact.at : now();
    return addFactTo(state, { ...fact, at }, `f${at.toString(36)}-${++factSeq}`);
  }

  /** The purpose of intention `id` in the guild's store ('' when unknown). Never throws. */
  function purposeOf(guildId, id) {
    try {
      const purpose = guildId && id ? intentions?.store?.(guildId)?.get?.(id)?.purpose : null;
      return typeof purpose === 'string' ? purpose : '';
    } catch {
      return '';
    }
  }

  /** The fact about `wake` (`wakeDropped` or `wakeHeld`) with its `code`, where it belongs and what `extra` adds. */
  function wakeFact(guildId, wake, kind, code, extra = {}) {
    const intentionId = list(wake.intentionIds).map(String)[0] ?? null;
    return {
      kind,
      wakeId: wake.id,
      wake: wake.kind,
      code,
      intentionId,
      purpose: intentionId ? purposeOf(guildId, intentionId) : '',
      ...extra,
      channelId: wake.channelId ?? null,
      privateChat: wake.privateChat === true,
    };
  }

  /**
   * `wakes` marked handled with `outcome` and taken off the queue; every recurring intention they
   * name advances to its next occurrence (the service's `advance`: `recurred` for one in `named`,
   * the ids her turn's calls named, else `missed`). A one-off, a waiting one and an occurrence she
   * already closed or moved are left as they are by the service. An outcome other than a run turn
   * (DROP_OUTCOMES) is a `wakeDropped` fact at once; `why` (a string, or a function of the wake) is its sub-code.
   */
  function markHandled(state, wakes, outcome, at, { guildId = null, named = null, why = null } = {}) {
    for (const wake of wakes) {
      state.handled[wake.id] = { at, outcome, ...(wake.kind === 'attend' ? { place: wake.channelId ?? null } : {}) };
      if (DROP_OUTCOMES.has(outcome)) {
        const reason = typeof why === 'function' ? why(wake) : why;
        addFact(state, {
          at,
          ...wakeFact(
            guildId,
            wake,
            'wakeDropped',
            outcome,
            typeof reason === 'string' && reason ? { why: reason } : {}
          ),
        });
      }
    }
    const ids = new Set(wakes.map((wake) => wake.id));
    state.queue = state.queue.filter((wake) => !ids.has(wake.id));
    if (!guildId || typeof intentions?.advance !== 'function') return;
    const touched = named instanceof Set ? named : new Set(Array.isArray(named) ? named.map(String) : []);
    for (const id of new Set(wakes.flatMap((wake) => (Array.isArray(wake.intentionIds) ? wake.intentionIds : [])))) {
      const result = intentions.advance(guildId, id, { named: touched.has(String(id)) });
      if (result?.changed)
        note(guildId, {
          event: 'recurred',
          intentionId: String(id),
          code: result.intention?.history?.at?.(-1)?.code ?? null,
          dueAt: result.intention?.dueAt ?? null,
          outcome,
        });
    }
  }

  /**
   * The door's handler of `inner.wake`: the wake queued (persisted), unless it was handled
   * already, is queued, the inner life is stopped, or the queue is full (`overflow`, journalled
   * and handled so it is never dropped unseen). Answers what happened.
   */
  function onWake(event) {
    const guildId = event?.communityId ?? getGuildId();
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
      ...(wake.retry
        ? { retry: wake.retry, firstFailedAt: wake.firstFailedAt ?? null, notBefore: wake.notBefore ?? null }
        : {}),
      ...(wake.errandId ? { errandId: wake.errandId } : {}),
      ...(wake.attend ? { place: wake.attend.place, lines: wake.attend.lines, people: wake.attend.people.length } : {}),
      ...(wake.kind === 'feedback' ? { turnId: wake.turnId ?? null, facts: list(wake.facts) } : {}),
    };
  }

  async function enqueue(guildId, wake) {
    const event = { kind: 'inner.wake', at: now(), id: wake.id, communityId: String(guildId), wake };
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
          bucket.lines.push({
            id,
            at: lineAt,
            by: line.kind === 'said' ? null : typeof line.by === 'string' ? line.by : null,
            said: line.kind === 'said',
          });
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
    for (const line of placeIndexOf(guildId).places.get(String(place))?.lines ?? [])
      if (line.said && line.at > last) last = line.at;
    for (const [id, entry] of Object.entries(stateOf(guildId).handled)) {
      if (
        id.startsWith(ATTEND_PREFIX) &&
        entry?.place === String(place) &&
        Number.isFinite(entry.at) &&
        entry.at > last
      )
        last = entry.at;
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
      return (intentions?.list?.(guildId, { all: true }) ?? []).filter(
        (record) => record?.status === 'pending' && isAttend(record)
      );
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
      const since = Math.max(
        lastLookAt(guildId, place),
        Number.isFinite(record.createdAt) ? record.createdAt : -Infinity
      );
      const wake = attendWake(record, linesSince(guildId, place, since), {
        now: at,
        since: Number.isFinite(since) ? since : null,
      });
      if (wake) out.push(wake);
    }
    return out;
  }

  /** The name of place `id`: the directory's, else the interface's cache, else the id. */
  function placeNameOf(guildId, id) {
    const named = directoryOf(guildId).find((entry) => entry.id === String(id));
    return named?.name ?? conversationName(String(id)) ?? String(id);
  }

  /** The places the interface publishes for the guild (`places`), else the places the record shows. */
  function directoryOf(guildId) {
    let listed = [];
    if (typeof placesOf === 'function') {
      try {
        listed = list(placesOf(String(guildId))).filter(
          (entry) => entry && (typeof entry.id === 'string' || typeof entry.id === 'number')
        );
      } catch (err) {
        log.warn('inner: places unreadable', { guildId, code: err?.code ?? null });
        listed = [];
      }
      return listed.map((entry) => ({
        id: String(entry.id),
        name: typeof entry.name === 'string' && entry.name ? entry.name : String(entry.id),
        writable: typeof entry.writable === 'boolean' ? entry.writable : null,
      }));
    }
    return [...placeIndexOf(guildId).places.keys()].map((id) => ({
      id,
      name: conversationName(id) ?? id,
      writable: null,
    }));
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
    const entries = [
      ...directory,
      ...[...attended]
        .filter((id) => !known.has(id))
        .map((id) => ({ id, name: placeNameOf(guildId, id), writable: null })),
    ];
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
      if (previous && previous.done !== true && Number.isFinite(previous.at))
        note(guildId, { event: 'review-missed', day: previous.day });
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

  /**
   * The heartbeat's timer (state.heartbeat = { nextAt, lastAt }, persisted): drawn at start when missing; once its
   * wake is handled (a turn ran for it, or it was dropped) the next moment is drawn from then, with the jitter. The
   * wake when its moment came and it is not handled yet. Null with the heartbeat off.
   */
  function heartbeatDue(guildId, settings, at) {
    if (!settings.heartbeat.enabled) return null;
    const state = stateOf(guildId);
    const draw = (from) =>
      drawHeartbeatAt({
        from,
        everyMinutes: settings.heartbeat.everyMinutes,
        jitterMinutes: settings.heartbeat.jitterMinutes,
        rng,
      });
    if (!state.heartbeat || !Number.isFinite(state.heartbeat.nextAt)) {
      state.heartbeat = { nextAt: draw(at), lastAt: state.heartbeat?.lastAt ?? null };
      save(guildId);
      log.info('inner: heartbeat drawn', { guildId, at: state.heartbeat.nextAt });
      note(guildId, { event: 'heartbeat-drawn', at: state.heartbeat.nextAt });
      return null;
    }
    const wake = heartbeatWake(state.heartbeat.nextAt);
    if (state.heartbeat.nextAt > at) return null;
    const handled = state.handled[wake.id];
    if (handled) {
      const ran = Number.isFinite(handled.at) ? handled.at : at;
      state.heartbeat = { nextAt: draw(Math.max(at, ran)), lastAt: ran };
      save(guildId);
      log.info('inner: heartbeat drawn', { guildId, at: state.heartbeat.nextAt });
      note(guildId, { event: 'heartbeat-drawn', at: state.heartbeat.nextAt });
      return null;
    }
    return wake;
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
      const beat = heartbeatDue(guildId, settings, at);
      if (beat) listed.push(beat);
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
          const older = state.queue.filter(
            (queued) =>
              queued.kind === 'attend' && queued.intentionIds?.[0] === wake.intentionIds[0] && !running.has(queued.id)
          );
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
    const anchor = group.find((wake) => !channelless(wake)) ?? null;
    const candidates = anchor ? [anchor.channelId] : await recentChannels(guildId);
    const readOnlyOk = anchor?.kind === 'attend';
    // Why the first candidate failed (`dm-off`, `not-writable`, `unavailable`); a review with no channel at all: `no-review-channel`.
    let why = anchor ? 'unavailable' : 'no-review-channel';
    let first = true;
    for (const channelId of candidates) {
      if (!channelId) continue;
      const fail = (code) => {
        if (first) why = code;
        first = false;
      };
      // The conversation as the interface describes it now: unknown to it, it is unavailable.
      const found = reads ? await reads.conversationInfo({ iface: iface(), conversationId: String(channelId) }) : null;
      const channel = found?.conversation ?? null;
      if (!channel) {
        fail(CODE.UNAVAILABLE);
        continue;
      }
      // A private chat only while private chats are on (features.privateMessages, read now).
      if (channel.communityId === null && hot.config?.features?.privateMessages !== true) {
        fail(CODE.DM_OFF);
        continue;
      }
      if (channel.communityId !== null && !readOnlyOk && !channel.permissions.send) {
        fail(CODE.NOT_WRITABLE);
        continue;
      }
      return { channel, why: null };
    }
    return { channel: null, why };
  }

  /**
   * The outcome of an `intention_due` turn for an intention a heartbeat made, logged (id and codes, never text):
   * `failed` (the turn erred or was refused), `done` (she closed it), `acted` (another call went through) or
   * `no-op`. Never throws.
   */
  function logDueOutcome(guildId, group, { outcome, actions, named }) {
    try {
      if (!intentions || typeof intentions.store !== 'function') return;
      for (const wake of group.filter((w) => w.kind === 'intention_due')) {
        const id = list(wake.intentionIds)[0];
        const record = id ? intentions.store(guildId)?.get?.(id) : null;
        if (record?.origin !== HEARTBEAT_ORIGIN) continue;
        const closing = actions.some(
          (a) =>
            a.status === 'executed' &&
            a.result === 'ok' &&
            a.intentionId === id &&
            (a.skill === 'intention.cancel' || a.state === 'done' || a.state === 'dropped')
        );
        const acted = actions.some(
          (a) => a.status === 'executed' && a.result === 'ok' && !String(a.skill).startsWith('intention.')
        );
        const result =
          outcome === 'error' || outcome === 'refused'
            ? 'failed'
            : closing
              ? 'done'
              : acted || named.includes(id)
                ? 'acted'
                : 'no-op';
        log.info('inner: heartbeat intention due', {
          guildId,
          intentionId: id,
          recurring: Boolean(record.every),
          turn: outcome,
          result,
          actions: actions.length,
        });
      }
    } catch (err) {
      log.warn('inner: due outcome not logged', { guildId, code: err?.code ?? null });
    }
  }

  /**
   * The heartbeat turn's outcome, logged (ids and codes, never text): what it did (`change`: the intention call that
   * went through, `skip`: none did), the intention's id, how many of the open intentions are from heartbeats
   * (the cap's occupancy) and the refusals it met. Never throws.
   */
  function logHeartbeatOutcome(guildId, { outcome, actions }) {
    try {
      const calls = actions.filter((a) => typeof a?.skill === 'string' && a.skill.startsWith('intention.'));
      const changed = calls.find((action) => action.status === 'executed' && action.result === 'ok') ?? null;
      const refused = actions
        .filter((action) => action?.status === 'refused' || (action?.status === 'executed' && action.result !== 'ok'))
        .map((action) => `${action.skill}:${action.code ?? action.result}`);
      const open =
        intentions && typeof intentions.list === 'function'
          ? openFromHeartbeat(intentions.list(guildId, { all: true })).length
          : null;
      log.info('inner: heartbeat outcome', {
        guildId,
        turn: outcome,
        result: changed ? 'change' : 'skip',
        ...(changed ? { skill: changed.skill, intentionId: changed.createdId ?? changed.intentionId ?? null } : {}),
        openFromHeartbeat: open,
        refused,
      });
    } catch (err) {
      log.warn('inner: heartbeat outcome not logged', { guildId, code: err?.code ?? null });
    }
  }

  /** The channels a review or a heartbeat turn may run in: where she spoke lately (the review's remembered ones, else the record's). */
  async function recentChannels(guildId) {
    const known = stateOf(guildId).review?.channels ?? [];
    if (known.length > 0) return known;
    const channels = [];
    const lines = await ownLines(guildId, innerSettings(hot.config).review.historyDays);
    for (const line of lines.sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))) {
      const id = line.scope?.channel;
      if (typeof id === 'string' && id && !channels.includes(id)) channels.push(id);
      if (channels.length >= REVIEW_CHANNELS_MAX) break;
    }
    return channels;
  }

  /** The heartbeat's facts for `<wake>` (src/behavior/heartbeat-view.js), from the stores this life was given. Never throws. */
  async function heartbeatFacts(guildId, settings, at) {
    const state = stateOf(guildId);
    const guarded = (fn, fallback) => {
      try {
        return fn() ?? fallback;
      } catch (err) {
        log.warn('inner: heartbeat source failed', { guildId, code: err?.code ?? null });
        return fallback;
      }
    };
    try {
      return await buildHeartbeatFacts({
        guildId,
        now: at,
        since: state.heartbeat?.lastAt ?? null,
        settings: settings.heartbeat,
        profiles: guarded(() => store?.listUserProfiles?.(guildId), []),
        selfId: guarded(() => heartbeatSources.selfId?.(), null),
        record,
        journal,
        intentions: guarded(
          () => (intentionsOn(hot.config) ? intentions?.list?.(guildId, { all: true, closed: true }) : []),
          []
        ),
        tasks: guarded(() => heartbeatSources.tasks?.(guildId), []),
        diary: guarded(() => store?.getDiary?.(guildId)?.posts, []),
        places: placesInWakeOf(guildId, settings),
        skills: guarded(() => heartbeatSources.skills?.(), []),
        agents: guarded(() => heartbeatSources.agents?.(), []),
        innerState: state,
        nameOf: (id) => (typeof nameOf === 'function' ? nameOf(String(guildId), id) : null),
        placeName: (id) => placeNameOf(guildId, id),
        activePlaces: (memberId) => activePlacesOf(guildId, memberId),
        focusPeople:
          typeof heartbeatSources.focusPeople === 'function' ? () => heartbeatSources.focusPeople(guildId) : null,
        log,
      });
    } catch (err) {
      log.warn('inner: heartbeat view failed', { guildId, code: err?.code ?? null });
      return null;
    }
  }

  /** The places page of `<wake>` (null when `innerLife.attention.placesInWake` is 0). */
  function placesInWakeOf(guildId, settings) {
    const size = settings.attention.placesInWake;
    return size > 0 ? places(guildId, { sort: 'recent', page: 1, pageSize: size }) : null;
  }

  /** The names of the places where `memberId` wrote within the lookback window, the busiest first. */
  function activePlacesOf(guildId, memberId) {
    const counts = [];
    for (const [id, bucket] of placeIndexOf(guildId).places) {
      const n = bucket.lines.filter((line) => line.by === String(memberId)).length;
      if (n > 0) counts.push({ id, n });
    }
    return counts.sort((a, b) => b.n - a.n || (a.id < b.id ? -1 : 1)).map((entry) => placeNameOf(guildId, entry.id));
  }

  /** The channel names of the review's recent channels, for `<wake>`. */
  function channelNames(guildId) {
    const ids = stateOf(guildId).review?.channels ?? [];
    return ids.map((id) => conversationName(String(id))).filter(Boolean);
  }

  /**
   * One inner turn for the queue's first coalesced group, when the attention is free and no cap
   * refuses; a turn held back (`busy`, `paused`) leaves the group queued with its due times.
   */
  /** What an operation of a cut-off turn is called in the `interrupted` fact. */
  const opLabel = (op) =>
    (op.name === 'skill'
      ? `skill ${op.skill ?? ''}`
      : op.name === 'post' && op.text
        ? `post "${op.text}"`
        : String(op.name ?? 'operation')
    ).trim();

  /**
   * An in-flight mark left behind by a process that died in a turn (`state.inflight`): resolved from the journal
   * once its start-up reconciliation is done. If any operation of that turn went out (a persona's post reconciled as
   * sent or a call that executed; one that may have run and cannot be told counts too), its wakes are handled, not run
   * again, and an `interrupted` fact tells her what was done; if nothing went out (or the journal cannot say), the mark
   * is cleared and the wakes run again as before. Never throws.
   */
  async function resolveInflight(guildId) {
    const state = stateOf(guildId);
    const mark = state.inflight;
    if (!mark) return;
    try {
      await ready();
    } catch (err) {
      log.warn('inner: journal reconciliation failed before an interrupted turn was resolved', {
        guildId,
        code: err?.code ?? null,
      });
    }
    let ops = [];
    if (hot.config?.features?.journal === true && typeof journal?.turnOperations === 'function') {
      try {
        const at = now();
        ops = await journal.turnOperations(guildId, {
          turnId: mark.turnId,
          days: [...new Set([utcDay(mark.startedAt), utcDay(at)])],
          privateUserId: mark.privateUserId,
        });
      } catch (err) {
        log.warn('inner: journal could not say what an interrupted turn did', { guildId, code: err?.code ?? null });
      }
    }
    const done = [];
    for (const op of ops) {
      if (op.by !== 'persona' || op.dryRun || op.shadow) continue;
      if (op.phase === 'succeeded') done.push(opLabel(op));
      else if (op.phase === 'open' || (op.phase === 'unknown' && op.name !== 'post'))
        done.push(`${opLabel(op)} (unclear)`);
    }
    const ids = new Set(mark.wakeIds);
    const wakes = state.queue.filter((wake) => ids.has(wake.id));
    const at = now();
    state.inflight = null;
    if (done.length > 0 && wakes.length > 0) {
      markHandled(state, wakes, 'interrupted', at, {
        guildId,
        named: wakes.flatMap((wake) => list(wake.intentionIds)),
      });
      addFact(state, {
        at,
        kind: 'interrupted',
        wake: mark.kind,
        done: done.join('; '),
        channelId: mark.channelId,
        privateChat: mark.privateChat,
      });
    }
    save(guildId);
    log.warn('inner: a turn was cut off by a restart', {
      guildId,
      turnId: mark.turnId,
      wakes: wakes.length,
      done: done.length,
      rerun: !(done.length > 0 && wakes.length > 0),
    });
    note(guildId, {
      event: 'interrupted',
      turnId: mark.turnId,
      wakes: wakes.map(wakeFields),
      done: done.length,
      handled: done.length > 0 && wakes.length > 0,
    });
  }

  async function drain(guildId) {
    const state = stateOf(guildId);
    if (state.inflight) await resolveInflight(guildId);
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
    const stale = state.queue.filter(
      (wake) => wake.kind !== 'review' && wake.intentionIds.length > 0 && wake.intentionIds.every((id) => !openOf(id))
    );
    if (stale.length > 0) {
      // Why it is stale: the status the intention ended in; one that is gone or never began is `forgotten`.
      const staleWhy = (wake) => {
        const status = intentions?.store?.(guildId)?.get?.(wake.intentionIds[0])?.status;
        return ['done', 'cancelled', 'expired'].includes(status) ? status : 'forgotten';
      };
      markHandled(state, stale, 'stale', at, { guildId, why: staleWhy });
      save(guildId);
      for (const wake of stale) note(guildId, { event: 'stale', wake: wakeFields(wake) });
      if (state.queue.length === 0) return { dropped: stale.length };
    }

    // A feedback wake whose facts a turn of hers already carried has nothing left to say.
    const untold = new Set(
      list(state.facts)
        .filter((fact) => !fact.told)
        .map((fact) => fact.id)
    );
    const spent = state.queue.filter(
      (wake) => wake.kind === 'feedback' && list(wake.factIds).length > 0 && !wake.factIds.some((id) => untold.has(id))
    );
    if (spent.length > 0) {
      markHandled(state, spent, 'told', at, { guildId });
      save(guildId);
      if (state.queue.length === 0) return { told: spent.length };
    }

    const timezone = timezoneOf();
    // An attention past its own per-day bound, or a chain past its per-chain bound: its wakes wait for the next
    // local day, the rest go on.
    const day = zonedDay(at, timezone);
    const overDay = (wake) => {
      if (wake.kind !== 'attend') return false;
      const record = openOf(wake.intentionIds[0]);
      return Boolean(record?.attend) && attendCounter(record, day).wakes >= record.attend.perDay;
    };
    const chainOf = (chainId) => chainBudget(state, chainId, settings.caps.perChain, { now: at, timezone });
    const overChain = (wake) => chainOf(wake.chainId).left <= 0;
    // A feedback wake is never held: what it carries must reach her.
    const holdOf = (wake) =>
      wake.kind === 'feedback' ? null : overDay(wake) ? 'attend-per-day' : overChain(wake) ? 'per-chain' : null;
    const held = [];
    const heldFresh = {};
    const freshHolds = [];
    for (const wake of state.queue) {
      const cap = holdOf(wake);
      if (!cap) {
        // The day rolled: a wake held by a cap is released.
        delete wake.capped;
        continue;
      }
      held.push(wake);
      if (wake.capped === cap) continue;
      wake.capped = cap;
      heldFresh[cap] = (heldFresh[cap] ?? 0) + 1;
      // A hold is a fact once: what holds it and when it is expected to run (the next local midnight).
      freshHolds.push({
        wake,
        fact: addFact(state, {
          at,
          ...wakeFact(guildId, wake, 'wakeHeld', cap, { until: dayBounds(at, timezone).next }),
        }),
      });
      note(guildId, { event: 'capped', cap, wake: wakeFields(wake) });
    }
    const freshCaps = Object.keys(heldFresh);
    for (const cap of freshCaps) log.info('inner: capped', { guildId, cap, wakes: heldFresh[cap] });
    if (freshCaps.length > 0) save(guildId);
    // A wake of a failed turn waits for its retry time (`notBefore`).
    const eligible = state.queue.filter((wake) => !held.includes(wake) && !(wake.notBefore > at));
    if (eligible.length === 0) {
      if (held.length === 0) return { deferred: 'retry' };
      // No turn is coming to carry the new holds of an intention's wake: a feedback wake in its conversation tells her.
      for (const { wake, fact } of freshHolds) {
        if (!['intention_due', 'errand_deadline'].includes(wake.kind) || !wake.channelId) continue;
        await enqueue(guildId, {
          id: `inner.wake:feedback:held:${wake.id}:${fact.id}`,
          kind: 'feedback',
          reason: 'feedback',
          intentionIds: [],
          chainId: wake.chainId,
          dueAt: at,
          channelId: String(wake.channelId),
          privateChat: wake.privateChat === true,
          here: String(wake.channelId),
          turnId: null,
          facts: [factPayload(fact)],
          factIds: [fact.id],
        });
      }
      return { refused: held[0].capped };
    }

    const group = coalesceGroup(eligible, (wake) => held.includes(wake));
    const anchor = group.find((wake) => !channelless(wake)) ?? group[0];
    const chainId = anchor.chainId;
    const chain = chainOf(chainId);

    const { channel, why: noChannelWhy } = await conversationFor(guildId, group);
    if (!channel) {
      // The day's review rides with a server wake only for company: when that wake's conversation is gone the
      // review stays queued and goes on alone at the next drain.
      const dropping = anchor.kind === 'review' ? group : group.filter((wake) => wake.kind !== 'review');
      markHandled(state, dropping, 'no-channel', at, { guildId, why: noChannelWhy });
      save(guildId);
      log.info('inner: no conversation', { guildId, wakes: dropping.length });
      for (const wake of dropping) note(guildId, { event: 'no-channel', wake: wakeFields(wake) });
      return { dropped: dropping.length };
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
    const expired =
      isReview && intentions && intentionsOn(hot.config)
        ? expiredToShow(intentions.store?.(guildId)?.list?.() ?? [], { max: settings.review.expiredMax })
        : null;
    const shadow = settings.mode !== 'live';
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
      return {
        attend: {
          ...wake.attend,
          placeName: placeNameOf(guildId, wake.attend.place),
          peopleNames: wake.attend.people.map(name),
        },
      };
    };
    const placesInWake = settings.attention.placesInWake;
    const current = currentChannelOf(group, records);
    // The facts a feedback wake carries that are still untold, and the other facts this conversation may be shown (not told yet).
    const ownFactIds = new Set(group.filter((wake) => wake.kind === 'feedback').flatMap((wake) => list(wake.factIds)));
    const factsOfWake = (wake) =>
      list(wake.factIds).length > 0
        ? list(state.facts)
            .filter((fact) => !fact.told && wake.factIds.includes(fact.id))
            .map(factPayload)
        : list(wake.facts);
    const shownFacts = pendingFactsOf(state, {
      channelId: String(channel.id),
      privateChat: channel.communityId === null,
      anywhere: true,
    })
      .filter((fact) => !ownFactIds.has(fact.id))
      .slice(0, FACTS_SHOWN_MAX);
    const heartbeat = group.some((wake) => wake.kind === 'heartbeat')
      ? await heartbeatFacts(guildId, settings, at)
      : null;
    const info = {
      kind: anchor.kind,
      items: group.map((wake) => ({
        kind: wake.kind,
        reason: wake.reason,
        intentionIds: wake.intentionIds,
        errandId: wake.errandId ?? null,
        ...attendOf(wake),
        ...(wake.retry
          ? {
              delayed: {
                minutes: Math.max(0, Math.round((at - (wake.dueAt ?? at)) / MINUTE_MS)),
                code: wake.lastCode ?? 'error',
              },
            }
          : {}),
        ...(wake.kind === 'feedback' ? { facts: factsOfWake(wake), turnId: wake.turnId ?? null } : {}),
      })),
      ...(shownFacts.length > 0 ? { facts: shownFacts.map(factPayload) } : {}),
      intentions: records,
      ...(Object.keys(notes).length > 0 ? { notes } : {}),
      ...(expired && expired.items.length > 0 ? { expired } : {}),
      now: at,
      timezone,
      channels: isReview ? channelNames(guildId) : [],
      // The places page: where life is, beyond this conversation (0 keeps it to her places.list skill).
      ...(placesInWake > 0 ? { places: placesInWakeOf(guildId, settings) } : {}),
      budgets: { chain },
      chainId,
      ...(heartbeat ? { heartbeat } : {}),
      // The current channel: where her output tags act, and why it is that one (`<wake>`).
      here: current.channelId ? { channel: placeNameOf(guildId, current.channelId), why: current.why } : null,
    };
    for (const wake of group) running.add(wake.id);
    // The turn is on record before it runs: a process that dies in it leaves this mark (resolveInflight).
    const turnKey = `t-${uuid()}`;
    state.inflight = {
      turnId: turnKey,
      wakeIds: group.map((wake) => wake.id),
      kind: anchor.kind,
      startedAt: at,
      channelId: String(channel.id),
      privateChat: channel.communityId === null,
      privateUserId: channel.communityId !== null ? null : channel.partnerId == null ? null : String(channel.partnerId),
    };
    save(guildId);
    // The wake run (memoryDb.wakeRuns): what this turn's view showed, ids with their versions; the journal and the
    // `day` rows stay as they are.
    wakeWrite({
      kind: 'wake',
      op: 'start',
      run: {
        id: turnKey,
        kind: anchor.kind,
        trigger: anchor.id,
        scheduledAt: Number.isFinite(anchor.dueAt) ? anchor.dueAt : null,
        startedAt: at,
        policyVersion: WAKE_POLICY_VERSION,
        inputs: {
          wakes: group.map((wake) => wake.id),
          intentions: records.map((record) => ({
            id: record.id,
            updatedAt: Number.isFinite(record.updatedAt) ? record.updatedAt : null,
          })),
          facts: [...shownFacts.map((fact) => fact.id), ...ownFactIds],
          channelId: current.channelId ?? null,
          ...(heartbeat ? { heartbeat: true } : {}),
        },
      },
    });
    let measured;
    try {
      measured = await costs.run(() =>
        turns.runTurn({
          conversation: { iface: channel.iface, conversationId: channel.id },
          guildId,
          mode: 'inner',
          triggerKind: 'inner',
          journalTurn: { turnId: turnKey, attemptId: 1 },
          inner: {
            wake: info,
            currentChannel: current.channelId,
            shadow,
            mayAct: () => mayAct(guildId),
          },
        })
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
    after.inflight = null;
    // The run's actions, each once by its number (a restarted run records nothing twice), then its end.
    const runActions = list(result.inner?.actions);
    if (runActions.length > 0) {
      wakeWrite({
        kind: 'wake',
        op: 'actions',
        actions: runActions.map((action, index) => ({
          runId: turnKey,
          n: index + 1,
          kind: String(action?.skill ?? 'unknown'),
          target: action?.target ?? null,
          status: String(action?.status ?? 'unknown'),
          at: now(),
        })),
      });
    }
    wakeWrite({
      kind: 'wake',
      op: 'finish',
      finish: {
        id: turnKey,
        status: outcome === 'error' || HELD.has(outcome) ? 'failed' : 'succeeded',
        outcome,
        finishedAt: now(),
      },
    });
    if (HELD.has(outcome)) {
      // Stopped while it waited: its wakes go with the rest of the queue.
      if (after.stopped) {
        markHandled(after, group, 'stopped', now(), { guildId });
      }
      // The turn never ran: its mark goes.
      save(guildId);
      log.info('inner: turn held', { guildId, outcome, wakes: group.length });
      return { deferred: outcome };
    }
    const ended = now();
    const errorCode =
      outcome === 'error' ? (typeof result.reason === 'string' && result.reason ? result.reason : CODE.ERROR) : null;
    after.turns.push({
      at: ended,
      chainId,
      usd: measured.usd,
      outcome,
      kinds: [...new Set(group.map((wake) => wake.kind))],
      ...(errorCode ? { code: errorCode, failed: true } : {}),
    });
    // Each attention woken for counts the wake on its day (its own per-day bound).
    if (typeof intentions?.countAttendWake === 'function') {
      for (const id of new Set(group.filter((wake) => wake.kind === 'attend').flatMap((wake) => wake.intentionIds)))
        intentions.countAttendWake(guildId, id);
    }
    if (measured.usd > 0) after.spend.push({ at: ended, usd: measured.usd });
    const turnId = result.inner?.turnId ?? result.turnId ?? null;
    if (turnId) after.turnIds.push(String(turnId));
    // The facts this turn showed are told once a model answer carried them (not after an error).
    if (outcome !== 'error') markFactsTold(after, [...shownFacts.map((fact) => fact.id), ...ownFactIds], ended);
    const retry =
      errorCode && RETRY_CODES.has(errorCode) && !after.stopped ? planRetry(group, ended, settings, errorCode) : null;
    // A wake of hers that comes back (a retry, or the one more try of a one-off) carries the facts of this turn.
    let comesBack = false;
    const requeue = (wakes, fields) => {
      const ids = new Set(wakes.map((wake) => wake.id));
      for (const wake of after.queue.filter((queued) => ids.has(queued.id))) Object.assign(wake, fields);
      comesBack = comesBack || wakes.length > 0;
    };
    if (retry?.action === 'requeue') {
      requeue(group, {
        retry: retry.n,
        firstFailedAt: retry.firstFailedAt,
        notBefore: retry.notBefore,
        lastCode: errorCode,
      });
      log.info('inner: turn failed, wakes retried', {
        guildId,
        code: errorCode,
        retry: retry.n,
        wakes: group.length,
        notBefore: retry.notBefore,
      });
      note(guildId, {
        event: 'retry',
        code: errorCode,
        retry: retry.n,
        notBefore: retry.notBefore,
        wakes: group.map(wakeFields),
      });
    } else {
      if (isReview && after.review) after.review = { ...after.review, done: true };
      if (retry?.action === 'drop') {
        markHandled(after, group, 'provider', ended, { guildId, why: errorCode });
        log.warn('inner: turn failed, wakes dropped', {
          guildId,
          code: errorCode,
          retry: retry.n,
          wakes: group.length,
        });
      } else if (errorCode && !after.stopped) {
        // An error that is not a provider failure: a one-off intention's due moment gets one more try, then she is told.
        const oneOff = (wake) =>
          (wake.kind === 'intention_due' || wake.kind === 'errand_deadline') &&
          wake.retry !== 'error' &&
          !intentions?.store?.(guildId)?.get?.(list(wake.intentionIds)[0])?.every;
        const again = group.filter(oneOff);
        if (again.length > 0) {
          requeue(again, {
            retry: 'error',
            firstFailedAt: ended,
            notBefore: ended + settings.retry.delaysMinutes[0] * MINUTE_MS,
            lastCode: errorCode,
          });
          note(guildId, {
            event: 'retry',
            code: errorCode,
            retry: 'error',
            notBefore: ended + settings.retry.delaysMinutes[0] * MINUTE_MS,
            wakes: again.map(wakeFields),
          });
        }
        markHandled(
          after,
          group.filter((wake) => !again.includes(wake)),
          outcome,
          ended,
          { guildId, named: result.inner?.intentIds ?? [], why: errorCode }
        );
      } else {
        markHandled(after, group, outcome, ended, { guildId, named: result.inner?.intentIds ?? [], why: errorCode });
      }
    }
    // What did not go through (feedbackFacts), and a failed turn itself: kept as facts. A feedback turn's own
    // misses queue no second wake; any other turn's queue one feedback wake in its chain and conversation, due at
    // the next tick, unless its own wakes come back and carry them.
    const isFeedback = anchor.kind === 'feedback';
    const failure =
      outcome === 'error' || outcome === 'refused'
        ? [
            {
              kind: 'turnFailed',
              code: errorCode ?? (typeof result.reason === 'string' && result.reason ? result.reason : 'refused'),
              wake: anchor.kind,
            },
          ]
        : [];
    const feedback = [
      ...failure,
      ...feedbackFacts(result, { named: result.inner?.intentIds ?? [], intentions: records }),
    ];
    const keptFacts = feedback.map((fact) =>
      addFact(after, { at: ended, channelId: String(channel.id), privateChat: channel.communityId === null, ...fact })
    );
    save(guildId);
    let feedbackWakeId = null;
    if (feedback.length > 0 && !isFeedback && !comesBack) {
      feedbackWakeId = `inner.wake:feedback:${turnId ?? ended}`;
      await enqueue(guildId, {
        id: feedbackWakeId,
        kind: 'feedback',
        reason: 'feedback',
        intentionIds: [],
        chainId,
        dueAt: ended,
        channelId: String(channel.id),
        privateChat: channel.communityId === null,
        here: current.channelId,
        turnId: turnId ? String(turnId) : null,
        facts: feedback,
        factIds: keptFacts.map((fact) => fact.id),
      });
    }
    // The expired intentions the review listed were read: a turn that erred shows them again next time.
    if (expired && outcome !== 'error' && typeof intentions?.markExpiredShown === 'function') {
      for (const item of expired.items) intentions.markExpiredShown(guildId, item.id);
    }
    const actions = result.inner?.actions ?? [];
    if (anchor.kind === 'heartbeat') logHeartbeatOutcome(guildId, { outcome, actions });
    else logDueOutcome(guildId, group, { outcome, actions, named: result.inner?.intentIds ?? [] });
    log.info('inner: turn', {
      guildId,
      outcome,
      reason: result.reason ?? null,
      wakes: group.length,
      shadow,
      actions: actions.length,
      usd: measured.usd,
      voice: measured.voice,
    });
    note(guildId, {
      event: 'turn',
      channelId: channel.communityId !== null ? String(channel.id) : null,
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

  /**
   * The facts for the turns that are not inner turns (src/behavior/turn.js's addressed turns): `add` a
   * fact (`kind`, `channelId`, `privateChat`, its payload), `pending` ones a conversation may be shown
   * (`scope`: `{ channelId, privateChat }`; a private chat's only in it), `markTold` the ones a completed
   * answer carried. `enabled` follows the switch; without it the turn runner keeps its own in process.
   */
  const factsApi = {
    enabled: () => innerOn(hot.config),
    add(guildId, fact) {
      const key = guildId ?? getGuildId();
      if (!key) return null;
      const stored = addFact(stateOf(key), fact);
      save(key);
      return stored;
    },
    pending(guildId, scope) {
      const key = guildId ?? getGuildId();
      return key ? pendingFactsOf(stateOf(key), scope) : [];
    },
    markTold(guildId, ids) {
      const key = guildId ?? getGuildId();
      if (!key) return;
      markFactsTold(stateOf(key), ids, now());
      save(key);
    },
  };

  /** The kill switch: stopped (persisted), the queue dropped (journalled). */
  function stop(guildId = getGuildId(), { by = null } = {}) {
    if (!guildId) return { ok: false, code: CODE.NO_GUILD };
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
    if (!guildId) return { ok: false, code: CODE.NO_GUILD };
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
  function nextWakeOf(state, open, at, settings) {
    const found = [];
    for (const wake of state.queue)
      if (Number.isFinite(wake.notBefore ?? wake.dueAt))
        found.push({ at: wake.notBefore ?? wake.dueAt, kind: 'queue' });
    // A time already past that she handled counts no more; one not yet handled wakes her at the next tick.
    const upcoming = (record, reason, when, wakeAt = when) =>
      Number.isFinite(when) && (wakeAt > at || !state.handled[wakeOfDue({ intention: record, reason, at: when }).id]);
    for (const record of open) {
      if (record.status !== 'pending' && record.status !== 'waiting') continue;
      const wakeAt = wakeTimeOf(record, settings.heartbeat.dueJitterMinutes);
      if (upcoming(record, 'due', record.dueAt, wakeAt)) found.push({ at: wakeAt, kind: 'intention' });
      if (record.status === 'waiting' && upcoming(record, 'wait-deadline', record.waitDeadline))
        found.push({ at: record.waitDeadline, kind: 'intention' });
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
    if (!guildId)
      return {
        on: innerOn(hot.config),
        mode: settings.mode,
        stopped: false,
        queue: [],
        review: null,
        turnsToday: null,
        chains: 0,
        spentUsd: 0,
        intentions: null,
        attention: null,
        next: null,
        lastTurn: null,
        lastError: null,
      };
    const state = stateOf(guildId);
    const at = now();
    const timezone = timezoneOf();
    const { start } = dayBounds(at, timezone);
    let open = [];
    if (intentions && intentionsOn(hot.config)) {
      try {
        open = (intentions.list(guildId, { all: true }) ?? []).filter((record) =>
          ['pending', 'waiting', 'proposed'].includes(record?.status)
        );
      } catch (err) {
        log.warn('inner: status intentions failed', { guildId, code: err?.code ?? null });
      }
    }
    const countOf = (name) => open.filter((record) => record.status === name).length;
    const last = state.turns.reduce((latest, turn) => (!latest || turn.at >= latest.at ? turn : latest), null);
    const lastFailed = state.turns.reduce(
      (latest, turn) => (turn.outcome === 'error' && (!latest || turn.at >= latest.at) ? turn : latest),
      null
    );
    // Her attention today: the attend wakes handled (run: a turn ran for it) and the queued ones.
    const attention = {
      open: open.filter((record) => record.status === 'pending' && isAttend(record)).length,
      listed: 0,
      run: 0,
      spoken: 0,
      skipped: 0,
      waiting: 0,
    };
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
      queue: state.queue.map((wake) => ({
        id: wake.id,
        kind: wake.kind,
        dueAt: wake.dueAt ?? null,
        capped: wake.capped ?? null,
      })),
      review: state.review
        ? { day: state.review.day, at: state.review.at ?? null, done: state.review.done === true }
        : null,
      heartbeat: settings.heartbeat.enabled
        ? { nextAt: state.heartbeat?.nextAt ?? null, lastAt: state.heartbeat?.lastAt ?? null }
        : null,
      turnsToday: turnsToday(state, { now: at, timezone }),
      chains: new Set(state.turns.filter((turn) => turn.at >= start).map((turn) => turn.chainId)).size,
      spentUsd:
        Math.round(state.spend.filter((item) => item.at >= start).reduce((sum, item) => sum + item.usd, 0) * 10000) /
        10000,
      intentions: { pending: countOf('pending'), waiting: countOf('waiting'), proposed: countOf('proposed') },
      attention,
      next: nextWakeOf(state, open, at, settings),
      lastTurn: last ? { at: last.at, outcome: typeof last.outcome === 'string' ? last.outcome : null } : null,
      lastError: lastFailed
        ? { at: lastFailed.at, code: typeof lastFailed.code === 'string' ? lastFailed.code : CODE.ERROR }
        : null,
    };
  }

  return {
    tick,
    drain,
    onWake,
    onTaskFinished,
    mayAct,
    stop,
    start,
    status,
    places,
    state: stateOf,
    facts: factsApi,
  };
}
