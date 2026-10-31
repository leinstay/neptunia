// The drain and the turn it opens: one inner turn for the queue's first coalesced group, once the attention is free
// and no cap holds it. The drain picks the conversation, builds the `<wake>` facts, records the wake run, runs the
// turn through the turn runner (src/behavior/turn.js, mode `inner`), then marks the wakes handled or retries them,
// keeps the turn's feedback facts and queues the feedback wake. The turn's wakes are claimed in the memory database
// before the turn asks the model and completed or released after it (wake-store.ts); a live turn's posts are held
// and sent once the completion committed (deliveries.ts). The start's recovery (recovery.ts) runs first. An errand an
// inner turn handed off has its cost counted here when it ends. The tick (src/behavior/inner.ts) calls `drain`.

import { AsyncLocalStorage } from 'node:async_hooks';
import { onLog } from '../../log.js';
import { HOUR_MS, MINUTE_MS, zonedDay, zonedEpoch } from '../../time.js';
import {
  HEARTBEAT_ORIGIN,
  attendCounter,
  expiredToShow,
  intentionsOn,
  nextOccurrence,
} from '../../intentions/model.ts';
import type { Intention } from '../../intentions/types.ts';
import { errorCodeOf } from '../../llm/openrouter.js';
import { CODE } from '../../tools/codes.ts';
import { WAKE_POLICY_VERSION } from '../../tools/access.ts';
import { errorCode as codeOf, isFiniteNumber, listOf, objOf } from '../../tools/types.ts';
import type { ConversationInfo } from '../../protocol/adapter.ts';
import type { HeartbeatFacts } from '../heartbeat-view.ts';
import { deliveriesOf, holdFor, sendDeliveries } from './deliveries.ts';
import { asText, factPayload, feedbackFacts, idOrNull, markFactsTold, pendingFactsOf } from './facts.ts';
import { heartbeatFacts, logHeartbeatOutcome } from './heartbeat.ts';
import { attendFactsOf, placeNameOf, placesInWakeOf } from './places.ts';
import {
  addFact,
  channelless,
  coalesceGroup,
  enqueue,
  markHandled,
  mayAct,
  note,
  paused,
  save,
  stateOf,
  timezoneOf,
  wakeFact,
  wakeFields,
  wakeWrite,
} from './queue.ts';
import { startUp } from './recovery.ts';
import { channelNames, recentChannels } from './review.ts';
import { FACTS_SHOWN_MAX, innerSettings } from './settings.ts';
import { claimTurn, finishTurn } from './wake-store.ts';
import type { TurnClaim } from './wake-store.ts';
import type {
  ChainBudget,
  CostMeter,
  Fact,
  FactPayload,
  InnerContext,
  InnerSettings,
  InnerState,
  Measured,
  TurnAction,
  Wake,
  WakeInfo,
} from './types.ts';

/** The error codes of a failed turn whose wakes are retried; any other error is handled as an ended turn. */
const RETRY_CODES: ReadonlySet<string> = new Set(['provider-limit', 'provider-error', 'timeout']);

/** The outcomes of runTurn that mean the turn never ran: the wake waits. */
const HELD: ReadonlySet<unknown> = new Set(['busy', 'paused']);

/** The current channel of a turn, and the machine word for why it is that one. */
export type CurrentChannel = { channelId: string | null; why: string | null };

/**
 * The current channel of an inner turn for `group` (the coalesced wakes) and why it is that one,
 * chosen by the cause of the wake, never by recency: the first wake that is not a review is the
 * cause. An `intention_due` wake: the intention's destination when recorded, else the channel it
 * was asked in (the wake's `channelId`, targetOf; a private chat's is that chat); `attend`: the
 * place; `errand_deadline`: the channel of the intention that waits on the errand; `feedback`:
 * the current channel of the turn it reports (`here`, null when that turn had none). A review, or
 * a wake with no channel: none. `why` is a short machine word (`destination`, `asked`, `attend`,
 * `errand`, `feedback`), null with no channel.
 * `records` are the open intentions of the group, for the destination.
 */
export function currentChannelOf(group: ReadonlyArray<Wake>, records: ReadonlyArray<unknown> = []): CurrentChannel {
  const cause = group.find((wake) => Boolean(wake) && !channelless(wake)) ?? null;
  if (!cause) return { channelId: null, why: null };
  const pick = (id: unknown, why: string): CurrentChannel =>
    id !== null && id !== undefined && asText(id) !== ''
      ? { channelId: asText(id), why }
      : { channelId: null, why: null };
  switch (cause.kind) {
    case 'intention_due': {
      const first = asText(listOf(cause.intentionIds)[0]);
      const record = objOf(listOf(records).find((item) => item && asText(objOf(item).id) === first));
      return pick(cause.channelId, record.destination && !cause.privateChat ? 'destination' : 'asked');
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

/** The start of the local day of `now` and of the next one. */
export function dayBounds(now: number, timezone: string): { day: string; start: number; next: number } {
  const day = zonedDay(now, timezone);
  const start = zonedEpoch(day, 0, 0, timezone);
  const next = zonedEpoch(zonedDay(start + 26 * HOUR_MS, timezone), 0, 0, timezone);
  return { day, start, next };
}

/** The clock a count of the day is read at: the moment and the timezone. */
export type DayClock = { now: number; timezone: string };

/** How many inner turns ran at `now`'s local day in `timezone`, a failed one (provider or engine error: its wakes retry) not counted. */
export function turnsToday(state: Pick<InnerState, 'turns'>, { now, timezone }: DayClock): number {
  const { start } = dayBounds(now, timezone);
  return state.turns.filter((turn) => turn.failed !== true && turn.at >= start).length;
}

/** What becomes of the wakes of a failed turn: requeued after a delay, or dropped. */
export type RetryPlan = {
  action: 'requeue' | 'drop';
  n: number;
  firstFailedAt: number;
  notBefore: number | null;
  code: string;
};

/**
 * What becomes of the wakes of `group` after a turn that failed at `at`: `requeue` after the next delay of
 * `settings.retry.delaysMinutes` while the first failure is under `retry.maxHours` old, else `drop`; `n` counts attempts.
 * `code` is the failure's code.
 */
export function planRetry(
  group: ReadonlyArray<Wake>,
  at: number,
  settings: Pick<InnerSettings, 'retry'>,
  code: string = CODE.ERROR
): RetryPlan {
  const n =
    group.reduce(
      (most, wake) => Math.max(most, typeof wake.retry === 'number' && Number.isInteger(wake.retry) ? wake.retry : 0),
      0
    ) + 1;
  const firstFailedAt = group.reduce(
    (first, wake) => Math.min(first, isFiniteNumber(wake.firstFailedAt) ? wake.firstFailedAt : at),
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
export function chainBudget(
  state: Pick<InnerState, 'turns'>,
  chainId: string,
  cap: number,
  { now, timezone }: DayClock
): ChainBudget {
  const { start } = dayBounds(now, timezone);
  const feedbackOnly = (turn: InnerState['turns'][number]) =>
    Array.isArray(turn.kinds) && turn.kinds.length > 0 && turn.kinds.every((kind) => kind === 'feedback');
  const used = state.turns.filter(
    (turn) => turn.chainId === chainId && turn.failed !== true && !feedbackOnly(turn) && turn.at >= start
  ).length;
  return { used, cap, left: Math.max(0, cap - used) };
}

/** What a run has cost so far, while it runs. */
type CostBox = { usd: number; peak: number; requests: number; voice: number };

/**
 * The cost of whatever runs inside `run(fn)`: every `llm: usage` line (its `upstreamCost`, else
 * `cost`; the `core` role counted apart, as `voice`, the journal field's name since the role was called so) and `images: generated` line logged in its async context
 * (AsyncLocalStorage over the log listeners, src/log.js#onLog), requests on model roles other than `core` it starts included;
 * `running()`, asked inside it, says what it has cost so far and its costliest single request.
 */
export function createCostMeter({
  subscribe = onLog,
}: { subscribe?: (listener: (entry: unknown) => void) => unknown } = {}): CostMeter & {
  running(): { usd: number; peak: number };
} {
  const scope = new AsyncLocalStorage<CostBox>();
  const round = (value: number) => Math.round(value * 1_000_000) / 1_000_000;
  const amount = (value: unknown) => (isFiniteNumber(value) && value >= 0 ? value : 0);
  subscribe((given) => {
    const box = scope.getStore();
    if (!box || !given || typeof given !== 'object') return;
    const entry = objOf(given);
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
    async run(fn: () => unknown): Promise<Measured> {
      const box: CostBox = { usd: 0, peak: 0, requests: 0, voice: 0 };
      const result: unknown = await scope.run(box, fn);
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

/** The conversation a turn runs in, or why there is none. */
export type ConversationFound = {
  channel: ConversationInfo | null;
  why: string | null;
  /** What the turn runner is handed beside it: for the heartbeat with no interface, its stand-in and no history. */
  turn: { standIn?: ConversationInfo; reuseHistory?: Array<never> };
};

/** Whether an interface answers the conversation reads (one is connected); reads that cannot say are taken as one. */
const interfaceAnswers = (reads: InnerContext['reads']): boolean =>
  reads !== null && (typeof reads.offers !== 'function' || reads.offers('conversation.info'));

/**
 * The stand-in the heartbeat's turn runs in when no interface is connected: no conversation of an interface's, the
 * served community, every permission, so her posting tools reach the port and fail there with their own codes (the
 * selfreflection wake's stand-in, src/behavior/diary-turn.ts#wakeInputs, is built the same way).
 */
function heartbeatStandIn(iface: string, guildId: string): ConversationInfo {
  return {
    iface,
    id: 'heartbeat',
    kind: 'channel',
    name: 'heartbeat',
    communityId: guildId,
    category: null,
    topic: null,
    permissions: { read: true, send: true, attach: true, react: false },
    owner: null,
    lastMessageAt: null,
    voice: false,
    public: true,
  };
}

/**
 * The conversation an inner turn of `group` runs in, or null. An attend wake's place may be one
 * she can only read: she listens there and posts, if at all, through a call elsewhere. The heartbeat with no
 * interface connected runs in its stand-in (heartbeatStandIn) with no history.
 */
export async function conversationFor(
  life: InnerContext,
  guildId: string,
  group: ReadonlyArray<Wake>
): Promise<ConversationFound> {
  const { hot, reads, iface } = life;
  const anchor = group.find((wake) => !channelless(wake)) ?? null;
  if (!anchor && group.some((wake) => wake.kind === 'heartbeat') && !interfaceAnswers(reads)) {
    const standIn = heartbeatStandIn(iface(), guildId);
    return { channel: standIn, why: null, turn: { standIn, reuseHistory: [] } };
  }
  const candidates: ReadonlyArray<string | null> = anchor ? [anchor.channelId] : await recentChannels(life, guildId);
  const readOnlyOk = anchor?.kind === 'attend';
  // Why the first candidate failed (`dm-off`, `not-writable`, `unavailable`); a review with no channel at all: `no-review-channel`.
  let why: string = anchor ? 'unavailable' : 'no-review-channel';
  let first = true;
  for (const channelId of candidates) {
    if (!channelId) continue;
    const fail = (code: string) => {
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
    if (channel.communityId === null && objOf(objOf(hot.config).features).privateMessages !== true) {
      fail(CODE.DM_OFF);
      continue;
    }
    if (channel.communityId !== null && !readOnlyOk && !channel.permissions.send) {
      fail(CODE.NOT_WRITABLE);
      continue;
    }
    return { channel, why: null, turn: {} };
  }
  return { channel: null, why, turn: {} };
}

/** What a turn of a group ended in: its outcome, its calls and the intentions they named. */
type TurnEnd = { outcome: unknown; actions: ReadonlyArray<TurnAction>; named: ReadonlyArray<unknown> };

/**
 * The outcome of an `intention_due` turn for an intention a heartbeat made, logged (id and codes, never text):
 * `failed` (the turn erred or was refused), `done` (she closed it), `acted` (another call went through) or
 * `no-op`. Never throws.
 */
export function logDueOutcome(
  life: InnerContext,
  guildId: string,
  group: ReadonlyArray<Wake>,
  { outcome, actions, named }: TurnEnd
): void {
  const { intentions, log } = life;
  try {
    if (!intentions || typeof intentions.store !== 'function') return;
    for (const wake of group.filter((w) => w.kind === 'intention_due')) {
      const id = listOf(wake.intentionIds).map(String)[0];
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
    log.warn('inner: due outcome not logged', { guildId, code: codeOf(err) });
  }
}

/** An intention of the guild's store that is still open (pending or waiting), else null. */
function openRecordOf(life: InnerContext, guildId: string, id: string): Intention | null {
  const intention = life.intentions?.store?.(guildId)?.get?.(id) ?? null;
  return intention && ['pending', 'waiting'].includes(intention.status) ? intention : null;
}

/** What `<wake>` of a group is built from, beside the group itself. */
type WakeView = {
  anchor: Wake;
  at: number;
  timezone: string;
  settings: InnerSettings;
  records: Array<Intention>;
  notes: Record<string, string>;
  expired: ReturnType<typeof expiredToShow> | null;
  isReview: boolean;
  chain: ChainBudget;
  shownFacts: Array<Fact>;
  heartbeat: HeartbeatFacts | null;
  here: CurrentChannel;
};

/** The `<wake>` facts of an inner turn for `group` (src/behavior/wake.ts words them). */
function wakeInfoOf(life: InnerContext, guildId: string, group: ReadonlyArray<Wake>, view: WakeView): WakeInfo {
  const { anchor, at, timezone, settings, records, notes, expired, isReview, chain, shownFacts, heartbeat, here } =
    view;
  const state = stateOf(life, guildId);
  // The facts a feedback wake carries that are still untold.
  const factsOfWake = (wake: Wake): Array<FactPayload> =>
    listOf(wake.factIds).length > 0
      ? state.facts.filter((fact) => !fact.told && listOf(wake.factIds).includes(fact.id)).map(factPayload)
      : Array.isArray(wake.facts)
        ? wake.facts
        : [];
  const placesInWake = settings.attention.placesInWake;
  return {
    kind: anchor.kind,
    items: group.map((wake) => ({
      kind: wake.kind,
      reason: wake.reason,
      intentionIds: wake.intentionIds,
      errandId: wake.errandId ?? null,
      ...attendFactsOf(life, guildId, wake),
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
    channels: isReview ? channelNames(life, guildId) : [],
    // The places page: where life is, beyond this conversation (0 keeps it to her places.list skill).
    ...(placesInWake > 0 ? { places: placesInWakeOf(life, guildId, settings) } : {}),
    budgets: { chain },
    chainId: anchor.chainId,
    ...(heartbeat ? { heartbeat } : {}),
    // The current channel: where her output tags act, and why it is that one (`<wake>`).
    here: here.channelId ? { channel: placeNameOf(life, guildId, here.channelId), why: here.why } : null,
  };
}

/** The wake run of a turn as it starts (memoryDb.wakeRuns): what its view showed, ids with their versions. */
function startWakeRun(
  life: InnerContext,
  run: { turnKey: string; anchor: Wake; group: ReadonlyArray<Wake>; at: number; records: Array<Intention> },
  facts: Array<string>,
  { channelId, heartbeat }: { channelId: string | null; heartbeat: boolean }
): void {
  const { turnKey, anchor, group, at, records } = run;
  wakeWrite(life, {
    kind: 'wake',
    op: 'start',
    run: {
      id: turnKey,
      kind: anchor.kind,
      trigger: anchor.id,
      scheduledAt: isFiniteNumber(anchor.dueAt) ? anchor.dueAt : null,
      startedAt: at,
      policyVersion: WAKE_POLICY_VERSION,
      inputs: {
        wakes: group.map((wake) => wake.id),
        intentions: records.map((record) => ({
          id: record.id,
          updatedAt: isFiniteNumber(record.updatedAt) ? record.updatedAt : null,
        })),
        facts,
        channelId,
        ...(heartbeat ? { heartbeat: true } : {}),
      },
    },
  });
}

/** The end of a turn's wake run: its actions, each once by its number (a restarted run records nothing twice), then its end. */
function endWakeRun(life: InnerContext, turnKey: string, actions: Array<unknown>, outcome: unknown): void {
  const { now } = life;
  if (actions.length > 0) {
    wakeWrite(life, {
      kind: 'wake',
      op: 'actions',
      actions: actions.map(objOf).map((action, index) => ({
        runId: turnKey,
        n: index + 1,
        kind: asText(action.skill ?? 'unknown'),
        target: action.target ?? null,
        status: asText(action.status ?? 'unknown'),
        at: now(),
      })),
    });
  }
  wakeWrite(life, {
    kind: 'wake',
    op: 'finish',
    finish: {
      id: turnKey,
      status: outcome === 'error' || HELD.has(outcome) ? 'failed' : 'succeeded',
      outcome,
      finishedAt: now(),
    },
  });
}

/**
 * The wakes of a turn's group marked running in process and claimed in the database before the turn runs, and its
 * in-flight mark set (`state.inflight`, the view of the claim); null when the claim was refused.
 */
async function beginTurn(
  life: InnerContext,
  guildId: string,
  group: ReadonlyArray<Wake>,
  { at, channel, kind }: { at: number; channel: ConversationInfo; kind: string }
): Promise<TurnClaim | null> {
  const where = {
    channelId: String(channel.id),
    privateChat: channel.communityId === null,
    privateUserId: channel.communityId !== null ? null : idOrNull(channel.partnerId),
  };
  for (const wake of group) life.running.add(wake.id);
  const claim = await claimTurn(life, guildId, group, { at, turn: { kind, ...where } });
  if (!claim) {
    for (const wake of group) life.running.delete(wake.id);
    return null;
  }
  stateOf(life, guildId).inflight = {
    turnId: claim.turnId,
    wakeIds: group.map((wake) => wake.id),
    kind,
    startedAt: at,
    ...where,
  };
  save(life, guildId);
  return claim;
}

/** The feedback wakes whose facts a turn of hers already carried, handled `told`: they have nothing left to say. How many. */
function dropSpentFeedback(life: InnerContext, guildId: string, state: InnerState, at: number): number {
  const untold = new Set(state.facts.filter((fact) => !fact.told).map((fact) => fact.id));
  const spent = state.queue.filter(
    (wake) =>
      wake.kind === 'feedback' &&
      listOf(wake.factIds).length > 0 &&
      !listOf(wake.factIds).some((id) => untold.has(asText(id)))
  );
  if (spent.length === 0) return 0;
  markHandled(life, state, spent, 'told', at, { guildId });
  save(life, guildId);
  return spent.length;
}

/** What drain answers: why nothing ran, or the turn that did. */
export type DrainAnswer =
  | { deferred: unknown }
  | { dropped: number }
  | { told: number }
  | { refused: string | undefined }
  | { outcome: unknown; wakes: number; usd: number; feedback?: string }
  | null;

/**
 * One inner turn for the queue's first coalesced group, when the attention is free and no cap
 * refuses; a turn held back (`busy`, `paused`) leaves the group queued with its due times.
 */
export async function drain(life: InnerContext, guildId: string): Promise<DrainAnswer> {
  const { hot, turns, intentions, peopleWaiting, costs, now, log, running } = life;
  const state = stateOf(life, guildId);
  await startUp(life, guildId);
  if (state.queue.length === 0) return null;
  if (state.stopped || paused(life)) return { deferred: 'stopped' };
  const oneAtATime = objOf(objOf(hot.config).mention).oneAtATime !== false;
  if (oneAtATime && typeof turns?.isAnyBusy === 'function' && turns.isAnyBusy()) return { deferred: 'busy' };
  if (peopleWaiting()) return { deferred: 'people' };
  const settings = innerSettings(hot.config);
  const at = now();

  // An intention closed since its wake was queued (done, cancelled, expired): the wake is stale.
  const openOf = (id: string) => openRecordOf(life, guildId, id);
  const stale = state.queue.filter(
    (wake) => wake.kind !== 'review' && wake.intentionIds.length > 0 && wake.intentionIds.every((id) => !openOf(id))
  );
  if (stale.length > 0) {
    // Why it is stale: the status the intention ended in; one that is gone or never began is `forgotten`.
    const staleWhy = (wake: Wake) => {
      const status = intentions?.store?.(guildId)?.get?.(wake.intentionIds[0])?.status;
      return status === 'done' || status === 'cancelled' || status === 'expired' ? status : 'forgotten';
    };
    markHandled(life, state, stale, 'stale', at, { guildId, why: staleWhy });
    save(life, guildId);
    for (const wake of stale) note(life, guildId, { event: 'stale', wake: wakeFields(wake) });
    if (state.queue.length === 0) return { dropped: stale.length };
  }

  const told = dropSpentFeedback(life, guildId, state, at);
  if (told > 0 && state.queue.length === 0) return { told };

  const timezone = timezoneOf(life);
  // An attention past its own per-day bound, or a chain past its per-chain bound: its wakes wait for the next
  // local day, the rest go on.
  const day = zonedDay(at, timezone);
  const overDay = (wake: Wake) => {
    if (wake.kind !== 'attend') return false;
    const record = openOf(wake.intentionIds[0]);
    return record?.attend ? attendCounter(record, day).wakes >= record.attend.perDay : false;
  };
  const chainOf = (chainId: string) => chainBudget(state, chainId, settings.caps.perChain, { now: at, timezone });
  const overChain = (wake: Wake) => chainOf(wake.chainId).left <= 0;
  // A feedback wake is never held: what it carries must reach her.
  const holdOf = (wake: Wake) =>
    wake.kind === 'feedback' ? null : overDay(wake) ? 'attend-per-day' : overChain(wake) ? 'per-chain' : null;
  const held: Array<Wake> = [];
  const heldFresh: Record<string, number> = {};
  const freshHolds: Array<{ wake: Wake; fact: Fact }> = [];
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
      fact: addFact(life, state, {
        at,
        ...wakeFact(life, guildId, wake, 'wakeHeld', cap, { until: dayBounds(at, timezone).next }),
      }),
    });
    note(life, guildId, { event: 'capped', cap, wake: wakeFields(wake) });
  }
  const freshCaps = Object.keys(heldFresh);
  for (const cap of freshCaps) log.info('inner: capped', { guildId, cap, wakes: heldFresh[cap] });
  if (freshCaps.length > 0) save(life, guildId);
  // A wake of a failed turn waits for its retry time (`notBefore`).
  const eligible = state.queue.filter((wake) => !held.includes(wake) && !(Number(wake.notBefore) > at));
  if (eligible.length === 0) {
    if (held.length === 0) return { deferred: 'retry' };
    // No turn is coming to carry the new holds of an intention's wake: a feedback wake in its conversation tells her.
    for (const { wake, fact } of freshHolds) {
      if (!['intention_due', 'errand_deadline'].includes(wake.kind) || !wake.channelId) continue;
      await enqueue(life, guildId, {
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

  const { channel, why: noChannelWhy, turn } = await conversationFor(life, guildId, group);
  if (!channel) {
    // The day's review rides with a server wake only for company: when that wake's conversation is gone the
    // review stays queued and goes on alone at the next drain.
    const dropping = anchor.kind === 'review' ? group : group.filter((wake) => wake.kind !== 'review');
    markHandled(life, state, dropping, 'no-channel', at, { guildId, why: noChannelWhy });
    save(life, guildId);
    log.info('inner: no conversation', { guildId, wakes: dropping.length });
    for (const wake of dropping) note(life, guildId, { event: 'no-channel', wake: wakeFields(wake) });
    return { dropped: dropping.length };
  }

  const records = [...new Set(group.flatMap((wake) => wake.intentionIds))]
    .map(openOf)
    .filter((record): record is Intention => record !== null);
  // A recurring intention whose next occurrence would fall past its expiry: this is its last one.
  const notes: Record<string, string> = {};
  for (const record of records) {
    if (!record.every) continue;
    const next = nextOccurrence(record, at, timezone);
    if (!isFiniteNumber(next) || next > record.expiresAt) notes[record.id] = 'last-occurrence';
  }
  // A review tells her once which intentions of hers expired untouched: the expired records not yet
  // shown (never a candidate), the newest first, `review.expiredMax` of them; marked shown once the turn ran.
  const isReview = group.some((wake) => wake.kind === 'review');
  const expired =
    isReview && intentions && intentionsOn(hot.config)
      ? expiredToShow(intentions.store?.(guildId)?.list?.() ?? [], { max: settings.review.expiredMax })
      : null;
  const shadow = settings.mode !== 'live';
  const hold = holdFor(life, shadow);
  const current = currentChannelOf(group, records);
  // The facts a feedback wake carries, and the other facts this conversation may be shown (not told yet).
  const ownFactIds = new Set(group.filter((wake) => wake.kind === 'feedback').flatMap((wake) => listOf(wake.factIds)));
  const shownFacts = pendingFactsOf(state, {
    channelId: String(channel.id),
    privateChat: channel.communityId === null,
    anywhere: true,
  })
    .filter((fact) => !ownFactIds.has(fact.id))
    .slice(0, FACTS_SHOWN_MAX);
  const heartbeat = group.some((wake) => wake.kind === 'heartbeat')
    ? await heartbeatFacts(life, guildId, settings, at)
    : null;
  const info = wakeInfoOf(life, guildId, group, {
    anchor,
    at,
    timezone,
    settings,
    records,
    notes,
    expired,
    isReview,
    chain,
    shownFacts,
    heartbeat,
    here: current,
  });
  // The turn's wakes are claimed before it runs: a process that dies in it leaves them running (recovery.ts).
  const claimed = await beginTurn(life, guildId, group, { at, channel, kind: anchor.kind });
  if (!claimed) return { deferred: 'claim' };
  const { turnId: turnKey, attempt } = claimed;
  // The wake run (memoryDb.wakeRuns): what this turn's view showed; the journal and the `day` rows stay as they are.
  const shownIds = [...shownFacts.map((fact) => fact.id), ...[...ownFactIds].map(asText)];
  startWakeRun(life, { turnKey, anchor, group, at, records }, shownIds, {
    channelId: current.channelId ?? null,
    heartbeat: Boolean(heartbeat),
  });
  let measured: Measured;
  try {
    measured = await costs.run(() =>
      turns.runTurn({
        conversation: { iface: channel.iface, conversationId: channel.id },
        ...turn,
        guildId,
        mode: 'inner',
        triggerKind: 'inner',
        journalTurn: { turnId: turnKey, attemptId: attempt },
        inner: {
          wake: info,
          currentChannel: current.channelId,
          shadow,
          mayAct: () => mayAct(life, guildId),
          hold,
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
  const result = objOf(measured.result ?? { outcome: 'error' });
  const inner = objOf(result.inner);
  const outcome = result.outcome ?? 'error';
  const named = listOf(inner.intentIds ?? []);
  const after = stateOf(life, guildId);
  after.inflight = null;
  endWakeRun(life, turnKey, listOf(inner.actions), outcome);
  if (HELD.has(outcome)) {
    // Stopped while it waited: its wakes go with the rest of the queue.
    if (after.stopped) markHandled(life, after, group, 'stopped', now(), { guildId });
    // The turn never ran: its mark goes, and its wakes are released.
    save(life, guildId);
    await finishTurn(life, guildId, group, after);
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
    ...(errorCode ? { code: errorCode, failed: true as const } : {}),
  });
  // Each attention woken for counts the wake on its day (its own per-day bound).
  if (typeof intentions?.countAttendWake === 'function') {
    for (const id of new Set(group.filter((wake) => wake.kind === 'attend').flatMap((wake) => wake.intentionIds)))
      intentions.countAttendWake(guildId, id);
  }
  if (measured.usd > 0) after.spend.push({ at: ended, usd: measured.usd });
  const turnId = inner.turnId ?? result.turnId ?? null;
  if (turnId) after.turnIds.push(asText(turnId));
  // The facts this turn showed are told once a model answer carried them (not after an error).
  if (outcome !== 'error') markFactsTold(after, shownIds, ended);
  const retry =
    errorCode && RETRY_CODES.has(errorCode) && !after.stopped ? planRetry(group, ended, settings, errorCode) : null;
  // A wake of hers that comes back (a retry, or the one more try of a one-off) carries the facts of this turn.
  let comesBack = false;
  const requeue = (wakes: ReadonlyArray<Wake>, fields: Partial<Wake>) => {
    const ids = new Set(wakes.map((wake) => wake.id));
    for (const wake of after.queue.filter((queued) => ids.has(queued.id))) Object.assign(wake, fields);
    comesBack = comesBack || wakes.length > 0;
  };
  if (retry?.action === 'requeue') {
    requeue(group, {
      retry: retry.n,
      firstFailedAt: retry.firstFailedAt,
      notBefore: retry.notBefore ?? undefined,
      lastCode: errorCode ?? undefined,
    });
    log.info('inner: turn failed, wakes retried', {
      guildId,
      code: errorCode,
      retry: retry.n,
      wakes: group.length,
      notBefore: retry.notBefore,
    });
    note(life, guildId, {
      event: 'retry',
      code: errorCode,
      retry: retry.n,
      notBefore: retry.notBefore,
      wakes: group.map(wakeFields),
    });
  } else {
    if (isReview && after.review) after.review = { ...after.review, done: true };
    if (retry?.action === 'drop') {
      markHandled(life, after, group, 'provider', ended, { guildId, why: errorCode });
      log.warn('inner: turn failed, wakes dropped', {
        guildId,
        code: errorCode,
        retry: retry.n,
        wakes: group.length,
      });
    } else if (errorCode && !after.stopped) {
      // An error that is not a provider failure: a one-off intention's due moment gets one more try, then she is told.
      const oneOff = (wake: Wake) =>
        (wake.kind === 'intention_due' || wake.kind === 'errand_deadline') &&
        wake.retry !== 'error' &&
        !intentions?.store?.(guildId)?.get?.(String(listOf(wake.intentionIds)[0]))?.every;
      const again = group.filter(oneOff);
      if (again.length > 0) {
        requeue(again, {
          retry: 'error',
          firstFailedAt: ended,
          notBefore: ended + settings.retry.delaysMinutes[0] * MINUTE_MS,
          lastCode: errorCode,
        });
        note(life, guildId, {
          event: 'retry',
          code: errorCode,
          retry: 'error',
          notBefore: ended + settings.retry.delaysMinutes[0] * MINUTE_MS,
          wakes: again.map(wakeFields),
        });
      }
      markHandled(
        life,
        after,
        group.filter((wake) => !again.includes(wake)),
        asText(outcome),
        ended,
        { guildId, named, why: errorCode }
      );
    } else {
      markHandled(life, after, group, asText(outcome), ended, { guildId, named, why: errorCode });
    }
  }
  // What did not go through (feedbackFacts), and a failed turn itself: kept as facts. A feedback turn's own
  // misses queue no second wake; any other turn's queue one feedback wake in its chain and conversation, due at
  // the next tick, unless its own wakes come back and carry them.
  const isFeedback = anchor.kind === 'feedback';
  const failure: Array<FactPayload> =
    outcome === 'error' || outcome === 'refused'
      ? [
          {
            kind: 'turnFailed',
            code: errorCode ?? (typeof result.reason === 'string' && result.reason ? result.reason : 'refused'),
            wake: anchor.kind,
          },
        ]
      : [];
  const feedback = [...failure, ...feedbackFacts(result, { named, intentions: records })];
  const keptFacts = feedback.map((fact) =>
    addFact(life, after, {
      at: ended,
      channelId: String(channel.id),
      privateChat: channel.communityId === null,
      ...fact,
    })
  );
  save(life, guildId);
  const recorded = await finishTurn(life, guildId, group, after, deliveriesOf(hold, { turnId: turnKey, chainId }));
  await sendDeliveries(life, guildId, recorded);
  let feedbackWakeId: string | null = null;
  if (feedback.length > 0 && !isFeedback && !comesBack) {
    feedbackWakeId = `inner.wake:feedback:${asText(turnId ?? ended)}`;
    await enqueue(life, guildId, {
      id: feedbackWakeId,
      kind: 'feedback',
      reason: 'feedback',
      intentionIds: [],
      chainId,
      dueAt: ended,
      channelId: String(channel.id),
      privateChat: channel.communityId === null,
      here: current.channelId,
      turnId: turnId ? asText(turnId) : null,
      facts: feedback,
      factIds: keptFacts.map((fact) => fact.id),
    });
  }
  // The expired intentions the review listed were read: a turn that erred shows them again next time.
  if (expired && outcome !== 'error' && typeof intentions?.markExpiredShown === 'function') {
    for (const item of expired.items) intentions.markExpiredShown(guildId, item.id);
  }
  const actions = inner.actions ?? [];
  const calls = listOf(actions).map(objOf);
  if (anchor.kind === 'heartbeat') logHeartbeatOutcome(life, guildId, { outcome, actions: calls });
  else logDueOutcome(life, guildId, group, { outcome, actions: calls, named });
  log.info('inner: turn', {
    guildId,
    outcome,
    reason: result.reason ?? null,
    wakes: group.length,
    shadow,
    actions: calls.length,
    usd: measured.usd,
    voice: measured.voice,
  });
  note(life, guildId, {
    event: 'turn',
    channelId: channel.communityId !== null ? String(channel.id) : null,
    outcome,
    reason: result.reason ?? null,
    shadow,
    turnId,
    wakes: group.map(wakeFields),
    coalesced: group.map((wake) => wake.id),
    actions,
    loop: inner.loop ?? null,
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
export function onTaskFinished(life: InnerContext, task: unknown, guildId: string | null = life.getGuildId()): boolean {
  const { now, log } = life;
  try {
    const errand = objOf(task);
    if (!guildId || !errand.id) return false;
    const state = stateOf(life, guildId);
    const id = asText(errand.id);
    const turnId = objOf(errand.origin).turnId;
    const handedOff = turnId && state.turnIds.includes(asText(turnId));
    const usd = Number(objOf(errand.usage).usd);
    const counted = Boolean(handedOff) && Number.isFinite(usd) && usd > 0;
    if (counted) state.spend.push({ at: now(), usd });
    if (!counted) return false;
    save(life, guildId);
    note(life, guildId, { event: 'errand-cost', taskId: id, usd: counted ? usd : 0 });
    return counted;
  } catch (err) {
    log.warn('inner: errand cost not counted', { code: codeOf(err) });
    return false;
  }
}
