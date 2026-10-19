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
// itself; a review is its day's chain), dollars per local day (a reservation held while the turn
// runs -- the estimate, or the costliest recent inner turn's real cost when more -- then what it
// actually cost -- every `llm: usage` and `images: generated` line logged inside it -- and the
// errands it handed off when they end; a turn reaching the ceiling mid-way makes no further call
// or request), public posts per local day. An errand an inner turn hands off (`task.run`, live)
// holds its most possible cost -- its agent's per-errand dollar limit, `agents.<agent>.limits.usd`
// -- against the day's dollars from its dispatch (`reserveErrand`, refused `inner-usd-cap` when it
// does not fit); its end replaces the hold with its real cost, and a lost one (it never ends) is
// released at its wait's deadline or after `innerLife.errandReserveMaxMinutes`, whichever comes
// first. The holds are persisted with the state.
// Over a cap no turn runs and the refusal is journalled once per wake. What is left and when it
// resets reach her as facts in `<wake>`, never as a rule.
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
import { intentionsOn } from '../intentions/model.js';

/** The wake kinds, as the `<wake>` block names them. */
export const WAKE_KINDS = Object.freeze(['intention_due', 'review', 'errand_deadline']);

/** The defaults of the `innerLife` section (config.json carries the same). */
export const INNER_DEFAULTS = Object.freeze({
  mode: 'shadow',
  tickSeconds: 60,
  queueMax: 20,
  chatMessages: 30,
  estimatedTurnUsd: 0.15,
  errandReserveMaxMinutes: 60,
  review: Object.freeze({ enabled: true, historyDays: 14 }),
  caps: Object.freeze({ perDay: 24, perHour: 4, perChain: 3, usdPerDay: 4, publicPostsPerDay: 2 }),
});

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
/** The skills that post where people read (a public post counts against `publicPostsPerDay`). */
export const POSTING_SKILLS = Object.freeze(['message.create', 'draw.create', 'diary.post']);

/** Whether the inner life runs (`features.innerLife` exactly true). */
export function innerOn(config) {
  return config?.features?.innerLife === true;
}

const count = (value, fallback) => (Number.isFinite(value) && value >= 0 ? value : fallback);

/**
 * The `innerLife` section with every number checked against INNER_DEFAULTS (a missing or bad value
 * takes the default). `mode` is `live` only when it says so exactly.
 * @param {object} config
 */
export function innerSettings(config) {
  const raw = config?.innerLife ?? {};
  const caps = raw.caps ?? {};
  const review = raw.review ?? {};
  const d = INNER_DEFAULTS;
  return {
    mode: raw.mode === 'live' ? 'live' : 'shadow',
    tickSeconds: Math.max(1, count(raw.tickSeconds, d.tickSeconds)),
    queueMax: Math.max(1, Math.floor(count(raw.queueMax, d.queueMax))),
    chatMessages: Math.max(1, Math.floor(count(raw.chatMessages, d.chatMessages))),
    estimatedTurnUsd: count(raw.estimatedTurnUsd, d.estimatedTurnUsd),
    errandReserveMaxMinutes: Math.max(1, count(raw.errandReserveMaxMinutes, d.errandReserveMaxMinutes)),
    review: { enabled: review.enabled !== false, historyDays: Math.max(1, count(review.historyDays, d.review.historyDays)) },
    caps: {
      perDay: Math.floor(count(caps.perDay, d.caps.perDay)),
      perHour: Math.floor(count(caps.perHour, d.caps.perHour)),
      perChain: Math.floor(count(caps.perChain, d.caps.perChain)),
      usdPerDay: count(caps.usdPerDay, d.caps.usdPerDay),
      publicPostsPerDay: Math.floor(count(caps.publicPostsPerDay, d.caps.publicPostsPerDay)),
    },
  };
}

/** A fresh state. */
export function emptyState() {
  return { v: VERSION, stopped: false, stoppedAt: null, stoppedBy: null, queue: [], handled: {}, review: null, turns: [], spend: [], posts: [], chains: {}, turnIds: [], holds: [] };
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
    holds: list(raw.holds).filter((hold) => typeof hold?.id === 'string' && Number.isFinite(hold.usd) && Number.isFinite(hold.until)),
  };
}

/**
 * `state` without what is older than its windows (handled ids, turns, spend, posts, idle chains,
 * errand holds released long ago: an expired hold stays until the tick journals its release).
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
    holds: list(state.holds).filter((hold) => hold.until >= since),
  };
}

/** The dollars the errand holds of `state` keep reserved at `now` (an expired hold none). */
export function heldUsd(state, now) {
  return list(state?.holds).reduce((sum, hold) => (hold.until > now ? sum + hold.usd : sum), 0);
}

/** Where an intention lands: its destination, else the conversation it came from; and whether that is a private chat. */
function targetOf(intention) {
  const privateChat = intention?.provenance?.scope === 'dm';
  const channelId = privateChat ? (intention.provenance?.channelId ?? null) : (intention?.destination ?? intention?.provenance?.channelId ?? null);
  return { channelId: channelId ? String(channelId) : null, privateChat };
}

/**
 * The wake of one entry of src/intentions/model.js#dueList (`{ intention, reason, at }`): an
 * `errand_deadline` for a wait past its deadline (its id names the errand), else an
 * `intention_due` (its id names the due time), so the same due item is always the same wake and
 * a new due time is a new one. Its chain is the intention's `chainId`, else the intention.
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
    chainId: intention.chainId ? `chain:${intention.chainId}` : `intention:${intention.id}`,
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
 * @param {object[]} queue
 * @returns {object[]}
 */
export function coalesceGroup(queue) {
  const sorted = [...list(queue)].sort((a, b) => (a.dueAt ?? 0) - (b.dueAt ?? 0));
  if (sorted.length === 0) return [];
  const anchor = sorted.find((wake) => wake.kind !== 'review') ?? null;
  if (!anchor) return sorted;
  return sorted.filter((wake) => (wake.kind === 'review' ? !anchor.privateChat : wake.channelId === anchor.channelId && Boolean(wake.privateChat) === Boolean(anchor.privateChat)));
}

/** The start of the local day of `now` and of the next one. */
function dayBounds(now, timezone) {
  const day = zonedDay(now, timezone);
  const start = zonedEpoch(day, 0, 0, timezone);
  const next = zonedEpoch(zonedDay(start + 26 * HOUR_MS, timezone), 0, 0, timezone);
  return { day, start, next };
}

/**
 * What is left of each cap at `now` (her local day in `timezone`; the hour rolling): `day`,
 * `hour`, `usd` (the reserved estimate and the errand holds counted as spent), `posts`, each `{ used, cap, left,
 * resetAt }` (`resetAt` null when nothing is used in a rolling window). Pure.
 */
export function budgetsOf(state, settings, { now, timezone, reserved = 0 }) {
  const { start, next } = dayBounds(now, timezone);
  const caps = settings.caps;
  const today = state.turns.filter((turn) => turn.at >= start);
  const hour = state.turns.filter((turn) => turn.at > now - HOUR_MS);
  const spent = state.spend.filter((item) => item.at >= start).reduce((sum, item) => sum + item.usd, 0) + reserved + heldUsd(state, now);
  const posts = state.posts.filter((at) => at >= start).length;
  const round = (value) => Math.round(value * 10000) / 10000;
  return {
    day: { used: today.length, cap: caps.perDay, left: Math.max(0, caps.perDay - today.length), resetAt: next },
    hour: { used: hour.length, cap: caps.perHour, left: Math.max(0, caps.perHour - hour.length), resetAt: hour.length > 0 ? Math.min(...hour.map((turn) => turn.at)) + HOUR_MS : null },
    usd: { used: round(spent), cap: caps.usdPerDay, left: round(Math.max(0, caps.usdPerDay - spent)), resetAt: next },
    posts: { used: posts, cap: caps.publicPostsPerDay, left: Math.max(0, caps.publicPostsPerDay - posts), resetAt: next },
  };
}

/** How many inner turns chain `chainId` has had, and how many are left under `cap`. */
export function chainBudget(state, chainId, cap) {
  const used = Number.isFinite(state.chains?.[chainId]?.turns) ? state.chains[chainId].turns : 0;
  return { used, cap, left: Math.max(0, cap - used) };
}

/**
 * What an inner turn reserves of the day's dollars before it runs: `innerLife.estimatedTurnUsd`,
 * or what the costliest inner turn of the kept window (the last two days) really cost when that was
 * more, so a turn that cost more than the estimate raises the next turns' reservation. Pure.
 */
export function turnReserve(state, settings) {
  const real = list(state?.turns).reduce((most, turn) => (Number.isFinite(turn?.usd) && turn.usd > most ? turn.usd : most), 0);
  return Math.max(settings.estimatedTurnUsd, real);
}

/**
 * The cap an inner turn would break now, or null: `per-day`, `per-hour`, `usd-per-day` (what was
 * really spent today and what running turns hold reserved, plus this turn's reservation
 * `estimate` -- turnReserve's -- over the ceiling), `per-chain`.
 */
export function capRefusal(budgets, chain, estimate) {
  if (budgets.day.left <= 0) return 'per-day';
  if (budgets.hour.left <= 0) return 'per-hour';
  if (budgets.usd.used + estimate > budgets.usd.cap) return 'usd-per-day';
  if (chain.left <= 0) return 'per-chain';
  return null;
}

/**
 * Whether an errand holding `usd` may be handed off now: null when the day's dollars (`usd`, budgetsOf's,
 * the real spend, other turns' reservations and the holds already counted) plus the handing turn's
 * share (`share`) plus `usd` stay within the ceiling, else `inner-usd-cap` (also for an errand whose
 * most possible cost is unknown: nothing bounds it).
 */
export function errandRefusal(usdBudget, share, usd) {
  if (!(Number.isFinite(usd) && usd >= 0)) return 'inner-usd-cap';
  return usdBudget.used + share + usd > usdBudget.cap + 1e-9 ? 'inner-usd-cap' : null;
}

/**
 * The cost of whatever runs inside `run(fn)`: every `llm: usage` line (its `upstreamCost`, else
 * `cost`; a `voice` role counted apart) and `images: generated` line logged in its async context
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
      if (entry.role === 'voice') box.voice += 1;
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
 * @param {{ iterate: Function }|null} [options.record]  Her own lines, for the review's hours.
 * @param {{ inner?: Function }|null} [options.journal]
 * @param {{ channels?: { fetch: Function } }|null} [options.client]
 * @param {{ canSend?: Function }|null} [options.discord]
 * @param {(event: object) => Promise<object>} [options.submit]  The event door's submit (src/index.js).
 * @param {{ state: { data: object } }|null} [options.store]  The memory store (its pause).
 * @param {() => string|null} [options.getGuildId]
 * @param {() => boolean} [options.isWarmingUp]
 * @param {() => boolean} [options.peopleWaiting]  Calls queued for the attention (people first).
 * @param {{ run: Function }} [options.meter]  createCostMeter's.
 * @param {((agent: string) => number|null)|null} [options.errandLimitUsd]  The most an errand of
 *   `agent` may cost (`agents.<agent>.limits.usd` over the profile's default,
 *   src/errands/service.js#limitsOf): what a handed-off errand holds. Without it errands hold nothing.
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
  errandLimitUsd = null,
  rng = Math.random,
  now = Date.now,
  setTimer = (fn, ms) => setTimeout(fn, ms),
  log = defaultLog,
}) {
  const states = new Map();
  const costs = meter ?? createCostMeter();
  // Per guild: the estimate held while an inner turn runs.
  const reserved = new Map();
  // The ids of the wakes an inner turn is running for now (a stop leaves them to that turn).
  const running = new Set();
  let ticking = false;
  let holdSeq = 0;
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

  function markHandled(state, wakes, outcome, at) {
    for (const wake of wakes) state.handled[wake.id] = { at, outcome };
    const ids = new Set(wakes.map((wake) => wake.id));
    state.queue = state.queue.filter((wake) => !ids.has(wake.id));
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
      markHandled(state, [queued], 'overflow', at);
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
      ...(wake.taskId ? { taskId: wake.taskId } : {}),
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

  /** The deadline of an intention's wait on errand `taskId` (epoch ms), or null. */
  function waitDeadlineOf(guildId, taskId) {
    if (!taskId) return null;
    try {
      const records = intentions?.store?.(guildId)?.list?.() ?? [];
      const waiting = records.find((record) => record?.status === 'waiting' && record.awaitingTaskId === String(taskId) && Number.isFinite(record.waitDeadline));
      return waiting ? waiting.waitDeadline : null;
    } catch {
      return null;
    }
  }

  /**
   * An errand of `agent` an inner turn hands off now: its most possible cost (errandLimitUsd's) held
   * against the day's dollars (persisted) when the day's dollars with `others` (what other running
   * turns hold reserved), the handing turn's `share` and this hold fit the ceiling; else refused
   * (`inner-usd-cap`, journalled). `key` is the call's idempotency key (its errand carries it).
   * Answers `{ ok: true, id }` or `{ ok: false, code }`.
   */
  function holdErrand(guildId, { agent, key = null, share = 0, others = 0 }) {
    const settings = innerSettings(hot.config);
    const at = now();
    const limit = typeof errandLimitUsd === 'function' ? errandLimitUsd(String(agent ?? '')) : null;
    const usd = typeof limit === 'number' ? limit : NaN;
    const state = stateOf(guildId);
    const budget = budgetsOf(state, settings, { now: at, timezone: timezoneOf(), reserved: others }).usd;
    const refusal = errandRefusal(budget, share, usd);
    if (refusal) {
      log.info('inner: errand refused', { guildId, agent: String(agent ?? ''), code: refusal });
      note(guildId, { event: 'errand-refused', agent: String(agent ?? ''), usd: Number.isFinite(usd) ? usd : null, code: refusal });
      return { ok: false, code: refusal };
    }
    holdSeq += 1;
    const base = typeof key === 'string' && key ? `hold:${key}` : `hold:${at}`;
    const id = state.holds.some((hold) => hold.id === base) || !(typeof key === 'string' && key) ? `${base}:${holdSeq}` : base;
    state.holds.push({ id, agent: String(agent), usd, at, until: at + settings.errandReserveMaxMinutes * MINUTE_MS, taskId: null, key: typeof key === 'string' && key ? key : null });
    save(guildId);
    note(guildId, { event: 'errand-held', holdId: id, agent: String(agent), usd });
    return { ok: true, id };
  }

  /**
   * Hold `holdId` bound to the errand `taskId` it became: released at the deadline of an intention's
   * wait on it when that comes before the hold's own end. A second hold of the same errand goes.
   */
  function bindErrand(guildId, holdId, taskId) {
    const state = stateOf(guildId);
    const hold = state.holds.find((item) => item.id === holdId);
    if (!hold || !taskId) return false;
    if (state.holds.some((item) => item !== hold && item.taskId === String(taskId))) {
      state.holds = state.holds.filter((item) => item !== hold);
    } else {
      hold.taskId = String(taskId);
      const deadline = waitDeadlineOf(guildId, taskId);
      if (Number.isFinite(deadline) && deadline < hold.until) hold.until = deadline;
    }
    save(guildId);
    return true;
  }

  /** Hold `holdId` released: its call never handed an errand off. */
  function releaseErrand(guildId, holdId) {
    const state = stateOf(guildId);
    const before = state.holds.length;
    state.holds = state.holds.filter((item) => item.id !== holdId);
    if (state.holds.length === before) return false;
    save(guildId);
    note(guildId, { event: 'errand-released', holdId, reason: 'not-dispatched' });
    return true;
  }

  /**
   * The holds of errands that never ended released (journalled `errand-released`, `lost`): at an
   * intention's wait deadline on the errand, or at the hold's own end.
   */
  function expireHolds(guildId, at) {
    const state = stateOf(guildId);
    if (state.holds.length === 0) return 0;
    for (const hold of state.holds) {
      const deadline = waitDeadlineOf(guildId, hold.taskId);
      if (Number.isFinite(deadline) && deadline < hold.until) hold.until = deadline;
    }
    const lost = state.holds.filter((hold) => hold.until <= at);
    if (lost.length === 0) return 0;
    state.holds = state.holds.filter((hold) => hold.until > at);
    save(guildId);
    for (const hold of lost) {
      log.info('inner: errand hold released', { guildId, taskId: hold.taskId, usd: hold.usd });
      note(guildId, { event: 'errand-released', holdId: hold.id, taskId: hold.taskId, usd: hold.usd, reason: 'lost' });
    }
    return lost.length;
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
      // Holds of errands that never ended, released at their wait's deadline or their own end.
      expireHolds(guildId, at);
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
      const state = stateOf(guildId);
      let submitted = 0;
      for (const wake of listed) {
        if (state.handled[wake.id] || state.queue.some((queued) => queued.id === wake.id)) continue;
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

  /** The conversation an inner turn of `group` runs in, or null. */
  async function conversationFor(guildId, group) {
    const anchor = group.find((wake) => wake.kind !== 'review') ?? null;
    const candidates = anchor ? [anchor.channelId] : (stateOf(guildId).review?.channels ?? []);
    for (const channelId of candidates) {
      if (!channelId) continue;
      const channel = await Promise.resolve(client?.channels?.fetch?.(String(channelId))).catch(() => null);
      if (!channel) continue;
      // A private chat only while private chats are on (features.privateMessages, read now).
      if (!channel.guild && hot.config?.features?.privateMessages !== true) continue;
      if (channel.guild && typeof discord?.canSend === 'function') {
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
      markHandled(state, stale, 'stale', at);
      save(guildId);
      for (const wake of stale) note(guildId, { event: 'stale', wake: wakeFields(wake) });
      if (state.queue.length === 0) return { dropped: stale.length };
    }

    const group = coalesceGroup(state.queue);
    const anchor = group.find((wake) => wake.kind !== 'review') ?? group[0];
    const chainId = anchor.chainId;
    const timezone = timezoneOf();
    const budgets = budgetsOf(state, settings, { now: at, timezone, reserved: reserved.get(String(guildId)) ?? 0 });
    const chain = chainBudget(state, chainId, settings.caps.perChain);
    const reserve = turnReserve(state, settings);
    const refusal = capRefusal(budgets, chain, reserve);
    if (refusal) {
      let fresh = 0;
      for (const wake of group) {
        if (wake.capped === refusal) continue;
        wake.capped = refusal;
        fresh += 1;
        note(guildId, { event: 'capped', cap: refusal, wake: wakeFields(wake) });
      }
      // A spent chain never comes back: its wakes are done with. The other caps reset.
      if (refusal === 'per-chain') markHandled(state, group, 'chain-cap', at);
      if (fresh > 0 || refusal === 'per-chain') {
        save(guildId);
        log.info('inner: capped', { guildId, cap: refusal, wakes: group.length });
      }
      return { refused: refusal };
    }

    const channel = await conversationFor(guildId, group);
    if (!channel) {
      markHandled(state, group, 'no-channel', at);
      save(guildId);
      log.info('inner: no conversation', { guildId, wakes: group.length });
      for (const wake of group) note(guildId, { event: 'no-channel', wake: wakeFields(wake) });
      return { dropped: group.length };
    }

    const records = [...new Set(group.flatMap((wake) => wake.intentionIds))].map(openOf).filter(Boolean);
    const shadow = settings.mode !== 'live';
    const posts = () => budgetsOf(stateOf(guildId), innerSettings(hot.config), { now: now(), timezone: timezoneOf() }).posts;
    const info = {
      kind: anchor.kind,
      items: group.map((wake) => ({ kind: wake.kind, reason: wake.reason, intentionIds: wake.intentionIds, taskId: wake.taskId ?? null })),
      intentions: records,
      now: at,
      timezone,
      channels: group.some((wake) => wake.kind === 'review') ? channelNames(guildId) : [],
      budgets: { day: budgets.day, hour: budgets.hour, chain, usd: budgets.usd, posts: budgets.posts },
      chainId,
    };
    const key = String(guildId);
    reserved.set(key, (reserved.get(key) ?? 0) + reserve);
    // Asked before each of her calls and tool-loop steps: the day's real spend, what other running
    // turns hold reserved, what this turn has really cost so far, and one more request as costly as
    // its costliest so far, within the ceiling.
    const spendAllowed = () => {
      const others = Math.max(0, (reserved.get(key) ?? 0) - reserve);
      const usd = budgetsOf(stateOf(guildId), innerSettings(hot.config), { now: now(), timezone: timezoneOf(), reserved: others }).usd;
      const so = typeof costs.running === 'function' ? costs.running() : null;
      return usd.used + (so?.usd ?? 0) + (so?.peak ?? 0) <= usd.cap + 1e-9;
    };
    // Asked right before an errand of hers is handed off (task.run, live): its most possible cost
    // held against the day's dollars, beside this turn's own share (its reservation, or what it has
    // cost so far and one more request as costly as its costliest, when more).
    const reserveErrand = ({ agent, key: callKey = null } = {}) => {
      const so = typeof costs.running === 'function' ? costs.running() : null;
      const share = Math.max(reserve, (so?.usd ?? 0) + (so?.peak ?? 0));
      return holdErrand(guildId, { agent, key: callKey, share, others: Math.max(0, (reserved.get(key) ?? 0) - reserve) });
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
            shadow,
            mayAct: () => mayAct(guildId),
            spendAllowed,
            ...(typeof errandLimitUsd === 'function'
              ? { reserveErrand, bindErrand: (holdId, taskId) => bindErrand(guildId, holdId, taskId), releaseErrand: (holdId) => releaseErrand(guildId, holdId) }
              : {}),
            postAllowed: () => posts().left > 0,
            onPosted: () => {
              stateOf(guildId).posts.push(now());
              save(guildId);
            },
          },
        }),
      );
    } catch (err) {
      log.warn('inner: turn failed', { guildId, error: err });
      measured = { result: { outcome: 'error' }, usd: 0, requests: 0, voice: 0 };
    } finally {
      reserved.set(key, Math.max(0, (reserved.get(key) ?? 0) - reserve));
      for (const wake of group) running.delete(wake.id);
    }
    const result = measured.result ?? { outcome: 'error' };
    const outcome = result.outcome ?? 'error';
    const after = stateOf(guildId);
    if (HELD.has(outcome)) {
      // Stopped while it waited: its wakes go with the rest of the queue.
      if (after.stopped) {
        markHandled(after, group, 'stopped', now());
        save(guildId);
      }
      log.info('inner: turn held', { guildId, outcome, wakes: group.length });
      return { deferred: outcome };
    }
    const ended = now();
    after.turns.push({ at: ended, chainId, usd: measured.usd });
    if (measured.usd > 0) after.spend.push({ at: ended, usd: measured.usd });
    after.chains[chainId] = { turns: (after.chains[chainId]?.turns ?? 0) + 1, lastAt: ended };
    const turnId = result.inner?.turnId ?? result.turnId ?? null;
    if (turnId) after.turnIds.push(String(turnId));
    if (group.some((wake) => wake.kind === 'review') && after.review) after.review = { ...after.review, done: true };
    markHandled(after, group, outcome, ended);
    save(guildId);
    // What she did and found goes to her memory, shadow or live: her reads really ran.
    if (result.inner?.episode && typeof onEpisode === 'function') {
      try {
        onEpisode(String(guildId), result.inner.episode);
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
      stray: result.inner?.stray ?? null,
      cost: { usd: measured.usd, requests: measured.requests, voice: measured.voice, reservedUsd: reserve },
    });
    return { outcome, wakes: group.length, usd: measured.usd };
  }

  /**
   * An errand's end: one an inner turn handed off counts its cost against the day's dollars, in
   * place of the hold it kept (found by the errand's id, else by its call's idempotency key).
   * Answers whether a cost was counted. Never throws.
   */
  function onTaskFinished(task, guildId = getGuildId()) {
    try {
      if (!guildId || !task?.id) return false;
      const state = stateOf(guildId);
      const id = String(task.id);
      const ikey = typeof task.idempotencyKey === 'string' && task.idempotencyKey ? task.idempotencyKey : null;
      const held = state.holds.filter((hold) => hold.taskId === id || (ikey !== null && hold.key === ikey));
      if (held.length > 0) state.holds = state.holds.filter((hold) => !held.includes(hold));
      const handedOff = held.length > 0 || (task.origin?.turnId && state.turnIds.includes(String(task.origin.turnId)));
      const usd = Number(task.usage?.usd);
      const counted = Boolean(handedOff) && Number.isFinite(usd) && usd > 0;
      if (counted) state.spend.push({ at: now(), usd });
      if (!counted && held.length === 0) return false;
      save(guildId);
      note(guildId, { event: 'errand-cost', taskId: id, usd: counted ? usd : 0, ...(held.length > 0 ? { heldUsd: held.reduce((sum, hold) => sum + hold.usd, 0) } : {}) });
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
    markHandled(state, queued, 'stopped', at);
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

  /** What the owner's status shows: the switch, the mode, the stop, the queue, the review, the budgets. */
  function status(guildId = getGuildId()) {
    const settings = innerSettings(hot.config);
    if (!guildId) return { on: innerOn(hot.config), mode: settings.mode, stopped: false, queue: [], review: null, budgets: null };
    const state = stateOf(guildId);
    const at = now();
    return {
      on: innerOn(hot.config),
      mode: settings.mode,
      stopped: state.stopped,
      stoppedAt: state.stoppedAt,
      queue: state.queue.map((wake) => ({ id: wake.id, kind: wake.kind, dueAt: wake.dueAt ?? null, capped: wake.capped ?? null })),
      review: state.review ? { day: state.review.day, at: state.review.at ?? null, done: state.review.done === true } : null,
      budgets: budgetsOf(state, settings, { now: at, timezone: timezoneOf(), reserved: reserved.get(String(guildId)) ?? 0 }),
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

  return { tick, drain, onWake, onTaskFinished, mayAct, stop, start, status, startTimer, stopTimer, state: stateOf };
}
