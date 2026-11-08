// The drain and the turn it opens: one inner turn for the queue's first coalesced group, once the attention is free
// and no cap holds it. The drain picks the chat, builds the `<wake>` facts, records the wake run, runs the
// turn through the turn runner (src/behavior/turn.ts, mode `inner`), then marks the wakes handled or retries them,
// keeps the turn's feedback facts and queues the feedback wake. The drain asks the wake queue (wake-queue.ts) to claim
// the group before the turn asks the model and reports what became of each wake after it; a live turn's posts are held
// and sent once the completion committed (deliveries.ts). The queue's start runs first. An errand an
// inner turn handed off has its cost counted here when it ends. The tick (src/behavior/inner.ts) calls `drain`.

import { isPublicationBoundary } from '../../tools/publication.ts';
import type { PublicationBoundary } from '../../tools/publication.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { onLog } from '../../log.ts';
import { HOUR_MS, MINUTE_MS, zonedDay, zonedEpoch } from '../../time.ts';
import { HEARTBEAT_ORIGIN, attendCounter, nextOccurrence } from '../../intentions/model.ts';
import type { Intention } from '../../intentions/types.ts';
import { errorCodeOf } from '../../llm/openrouter.ts';
import { CODE } from '../../tools/codes.ts';
import { WAKE_POLICY_VERSION } from '../../tools/access.ts';
import { errorCode as codeOf, isFiniteNumber, listOf, objOf } from '../../tools/types.ts';
import type { ChatInfo } from '../../protocol/adapter.ts';
import { deliveriesOf, holdFor, sendDeliveries } from './deliveries.ts';
import { asText, factPayload, feedbackFacts, idOrNull, markFactsTold, pendingFactsOf } from './facts.ts';
import { logHeartbeatOutcome } from './heartbeat.ts';
import { committedSelfimprovement, selfimprovementFacts } from './selfimprovement.ts';
import type { SelfimprovementFacts } from '../selfimprovement-view.ts';
import { attendFactsOf } from './places.ts';
import {
  contextOf,
  inScope,
  addFact,
  channelless,
  coalesceGroup,
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
import { FACTS_SHOWN_MAX, innerSettings } from './settings.ts';
import {
  claimWakes,
  disposeWakes,
  endRun,
  enqueueWake,
  finishWakes,
  holdWake,
  retryWakes,
  startUp,
} from './wake-queue.ts';
import type { TurnClaim } from './wake-queue.ts';
import { ifaceOfChat } from '../../interface/cli-chat.ts';
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
export type CurrentChannel = { placeId: string | null; why: string | null };

/** The restriction a wake inherits from the intentions it serves: an internal turn's label stays on its later turns. */
function restrictedBy(records: ReadonlyArray<unknown>): { publicationBoundary?: PublicationBoundary } {
  for (const record of records) {
    const carried = objOf(objOf(record).provenance).publicationBoundary;
    if (isPublicationBoundary(carried)) return { publicationBoundary: carried };
  }
  return {};
}

/**
 * The current channel of an inner turn for `group` (the coalesced wakes) and why it is that one,
 * chosen by the cause of the wake, never by recency: the first wake that runs in a place is the
 * cause. An `intention_due` wake: the intention's destination when recorded, else the channel it
 * was asked in (the wake's `placeId`, targetOf; a private chat's is that chat); `attend`: the
 * place; `errand_deadline`: the channel of the intention that waits on the errand; `feedback`:
 * the current channel of the turn it reports (`here`, null when that turn had none). A heartbeat, a
 * selfimprovement wake or a wake with no channel: none. `why` is a short machine word (`destination`, `asked`, `attend`,
 * `errand`, `feedback`), null with no channel.
 * `records` are the open intentions of the group, for the destination.
 */
export function currentChannelOf(group: ReadonlyArray<Wake>, records: ReadonlyArray<unknown> = []): CurrentChannel {
  const cause = group.find((wake) => Boolean(wake) && !channelless(wake)) ?? null;
  if (!cause) return { placeId: null, why: null };
  const pick = (id: unknown, why: string): CurrentChannel =>
    id !== null && id !== undefined && asText(id) !== '' ? { placeId: asText(id), why } : { placeId: null, why: null };
  switch (cause.kind) {
    case 'intention_due': {
      const first = asText(listOf(cause.intentionIds)[0]);
      const record = objOf(listOf(records).find((item) => item && asText(objOf(item).id) === first));
      return pick(cause.placeId, record.destination && !cause.dmChat ? 'destination' : 'asked');
    }
    case 'attend':
      return pick(cause.placeId, 'attend');
    case 'errand_deadline':
      return pick(cause.placeId, 'errand');
    case 'feedback':
      return pick(Object.hasOwn(cause, 'here') ? cause.here : cause.placeId, 'feedback');
    default:
      return { placeId: null, why: null };
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
 * (AsyncLocalStorage over the log listeners, src/log.ts#onLog), requests on model roles other than `core` it starts included;
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

/**
 * Where a turn runs. `channel` is its chat, null when it runs nowhere: a heartbeat, a selfimprovement wake, an
 * intention or a feedback wake with no place, and a due intention whose place cannot be reached, with that place's code
 * in `placeFailure`. `drop` with `why` when the wakes cannot run at all: an attention whose place is gone.
 */
export type ChatFound = {
  channel: ChatInfo | null;
  why: string | null;
  drop: boolean;
  placeFailure: string | null;
};

/**
 * The chat an inner turn of `group` runs in, chosen by the cause of the wake (currentChannelOf). An attend
 * wake's place may be one she can only read: she listens there and posts, if at all, through a call elsewhere. Any
 * other place must be one she may write in, and a direct chat only while `dm.enabled` is true. A place a due
 * intention named that fails does not lose the intention and picks no other room: the turn runs nowhere with the code.
 */
export async function chatFor(life: InnerContext, group: ReadonlyArray<Wake>): Promise<ChatFound> {
  const { hot, reads, iface } = life;
  const nowhere = (placeFailure: string | null = null): ChatFound => ({
    channel: null,
    why: null,
    drop: false,
    placeFailure,
  });
  const anchor = group.find((wake) => !channelless(wake)) ?? null;
  const placeId = currentChannelOf(group).placeId;
  if (!anchor || !placeId) return nowhere();
  const readOnlyOk = anchor.kind === 'attend';
  const failed = (code: string): ChatFound =>
    readOnlyOk ? { channel: null, why: code, drop: true, placeFailure: null } : nowhere(code);
  // The chat as its own interface describes it now (the command line for its chat): unknown to it, it is unavailable.
  const found = reads ? await reads.chatInfo({ iface: ifaceOfChat(placeId, iface()), chatId: placeId }) : null;
  const channel = found?.chat ?? null;
  if (!channel) return failed(CODE.UNAVAILABLE);
  // A private chat only while private chats are on (dm.enabled, read now).
  if (channel.rootId === null && objOf(objOf(hot.config).dm).enabled !== true) return failed(CODE.DM_OFF);
  if (channel.rootId !== null && !readOnlyOk && !channel.permissions.send) return failed(CODE.NOT_WRITABLE);
  return { channel, why: null, drop: false, placeFailure: null };
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
  group: ReadonlyArray<Wake>,
  { outcome, actions, named }: TurnEnd
): void {
  const { intentions, log } = life;
  try {
    if (!intentions || typeof intentions.store !== 'function') return;
    for (const wake of group.filter((w) => w.kind === 'intention_due')) {
      const id = listOf(wake.intentionIds).map(String)[0];
      const record = id ? intentions.store()?.get?.(id) : null;
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
        intentionId: id,
        recurring: Boolean(record.every),
        turn: outcome,
        result,
        actions: actions.length,
      });
    }
  } catch (err) {
    log.warn('inner: due outcome not logged', { code: codeOf(err) });
  }
}

/** An intention of the place's store that is still open (pending or waiting), else null. */
function openRecordOf(life: InnerContext, id: string): Intention | null {
  const intention = life.intentions?.store?.()?.get?.(id) ?? null;
  return intention && ['pending', 'waiting'].includes(intention.status) ? intention : null;
}

/** What the wake of a group's turn is built from, beside the group itself. */
type WakeView = {
  anchor: Wake;
  at: number;
  timezone: string;
  records: Array<Intention>;
  notes: Record<string, string>;
  shownFacts: Array<Fact>;
  selfimprovement: SelfimprovementFacts | null;
  /** The code of the place a due intention named and could not be reached in, null when it was or named none. */
  placeFailure: string | null;
};

/** The wake an inner turn of `group` carries for its request (src/behavior/wake.ts and selfimprovement-text.ts word it). */
function wakeInfoOf(life: InnerContext, group: ReadonlyArray<Wake>, view: WakeView): WakeInfo {
  const { anchor, at, timezone, records, notes, shownFacts, selfimprovement, placeFailure } = view;
  const state = stateOf(life);
  // The facts a feedback wake carries that are still untold.
  const factsOfWake = (wake: Wake): Array<FactPayload> =>
    listOf(wake.factIds).length > 0
      ? state.facts.filter((fact) => !fact.told && listOf(wake.factIds).includes(fact.id)).map(factPayload)
      : Array.isArray(wake.facts)
        ? wake.facts
        : [];
  return {
    kind: anchor.kind,
    items: group.map((wake) => ({
      kind: wake.kind,
      reason: wake.reason,
      intentionIds: wake.intentionIds,
      errandId: wake.errandId ?? null,
      ...attendFactsOf(life, wake),
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
    now: at,
    timezone,
    chainId: anchor.chainId,
    ...(selfimprovement ? { selfimprovement } : {}),
    ...(placeFailure ? { placeFailure } : {}),
  };
}

/** The facts of the wake kinds that carry their own view: the heartbeat's and the selfimprovement wake's, each null for a group without it. */
async function kindFacts(
  life: InnerContext,
  group: ReadonlyArray<Wake>,
  when: { settings: InnerSettings; at: number }
): Promise<{
  selfimprovement: SelfimprovementFacts | null;
  improvementWake: Wake | null;
  improvementReadAt: number;
}> {
  const improvementWake = group.find((wake) => wake.kind === 'selfimprovement') ?? null;
  // Taken before the read: a row made during it shows again in the next wake and is never lost.
  const improvementReadAt = life.now();
  return {
    selfimprovement: improvementWake ? await selfimprovementFacts(life, when.at) : null,
    improvementWake,
    improvementReadAt,
  };
}

/** The wake run of a turn as it starts: what its view showed, ids with their versions. */
function startWakeRun(
  life: InnerContext,
  run: { turnKey: string; anchor: Wake; group: ReadonlyArray<Wake>; at: number; records: Array<Intention> },
  facts: Array<string>,
  { placeId, heartbeat }: { placeId: string | null; heartbeat: boolean }
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
        placeId,
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

/** The wakes of a turn's group claimed before the turn runs, with the chat it runs in; null when refused. */
async function beginTurn(
  life: InnerContext,
  group: ReadonlyArray<Wake>,
  { at, channel, kind }: { at: number; channel: ChatInfo | null; kind: string }
): Promise<TurnClaim | null> {
  const where = {
    placeId: channel ? String(channel.id) : null,
    dmChat: channel?.rootId === null,
    privateAccountId: channel && channel.rootId === null ? idOrNull(channel.partnerId) : null,
    iface: channel?.iface ?? life.iface(),
  };
  const claim = await claimWakes(life, group, { at, kind, where });
  if (claim) save(life);
  return claim;
}

/** The feedback wakes whose facts a turn of hers already carried, handled `told`: they have nothing left to say. How many. */
function dropSpentFeedback(life: InnerContext, state: InnerState, at: number): number {
  const untold = new Set(state.facts.filter((fact) => !fact.told).map((fact) => fact.id));
  const spent = state.queue.filter(
    (wake) =>
      inScope(life, wake) &&
      wake.kind === 'feedback' &&
      listOf(wake.factIds).length > 0 &&
      !listOf(wake.factIds).some((id) => untold.has(asText(id)))
  );
  if (spent.length === 0) return 0;
  disposeWakes(life, spent, 'told', at);
  save(life);
  return spent.length;
}

/** Retire only this root's wakes whose intentions have ended. */
function dropStale(life: InnerContext, state: InnerState, at: number): number {
  const { intentions } = life;
  const openOf = (id: string) => openRecordOf(life, id);
  const stale = state.queue.filter(
    (wake) => inScope(life, wake) && wake.intentionIds.length > 0 && wake.intentionIds.every((id) => !openOf(id))
  );
  if (stale.length > 0) {
    // Why it is stale: the status the intention ended in; one that is gone or never began is `forgotten`.
    const staleWhy = (wake: Wake) => {
      const status = intentions?.store?.()?.get?.(wake.intentionIds[0])?.status;
      return status === 'done' || status === 'cancelled' || status === 'expired' ? status : 'forgotten';
    };
    disposeWakes(life, stale, 'stale', at, { why: staleWhy });
    save(life);
    for (const wake of stale) note(life, { event: 'stale', wake: wakeFields(wake) });
  }
  return stale.length;
}

/** What drain answers: why nothing ran, or the turn that did. */
export type DrainAnswer =
  | { deferred: unknown }
  | { dropped: number }
  | { told: number }
  | { refused: string | undefined }
  | { outcome: unknown; wakes: number; usd: number; feedback?: string }
  | null;

/** Whether `wake` may run now: not held by a cap and not waiting for its retry time. */
function isEligible(wake: Wake, now: { held: ReadonlyArray<Wake>; at: number }): boolean {
  return !now.held.includes(wake) && !(Number(wake.notBefore) > now.at);
}

/**
 * One inner turn for the queue's first coalesced group, when the attention is free and no cap
 * refuses; a turn held back (`busy`, `paused`) leaves the group queued with its due times.
 */
export async function drain(life: InnerContext): Promise<DrainAnswer> {
  const { hot, turns, intentions, peopleWaiting, costs, now, log } = life;
  const state = stateOf(life);
  await startUp(life);
  if (state.queue.length === 0) return null;
  if (state.stopped || paused(life)) return { deferred: 'stopped' };
  if (typeof turns?.isAnyBusy === 'function' && turns.isAnyBusy()) return { deferred: 'busy' };
  if (peopleWaiting()) return { deferred: 'people' };
  const settings = innerSettings(hot.config);
  const at = now();

  // An intention closed since its wake was queued (done, cancelled, expired): the wake is stale.
  const openOf = (id: string) => openRecordOf(life, id);
  const dropped = dropStale(life, state, at);
  if (dropped > 0 && state.queue.length === 0) return { dropped };

  const told = dropSpentFeedback(life, state, at);
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
    if (!inScope(life, wake)) continue;
    const cap = holdOf(wake);
    if (!cap) {
      // The day rolled: a wake held by a cap is released.
      holdWake(life, wake, null);
      continue;
    }
    held.push(wake);
    if (!holdWake(life, wake, cap)) continue;
    heldFresh[cap] = (heldFresh[cap] ?? 0) + 1;
    // A hold is a fact once: what holds it and when it is expected to run (the next local midnight).
    freshHolds.push({
      wake,
      fact: addFact(life, state, {
        at,
        ...wakeFact(life, wake, 'wakeHeld', cap, { until: dayBounds(at, timezone).next }),
      }),
    });
    note(life, { event: 'capped', cap, wake: wakeFields(wake) });
  }
  const freshCaps = Object.keys(heldFresh);
  for (const cap of freshCaps) log.info('inner: capped', { cap, wakes: heldFresh[cap] });
  if (freshCaps.length > 0) save(life);
  // A wake of a failed turn waits for its retry time (`notBefore`).
  const eligible = state.queue.filter((wake) => inScope(life, wake) && isEligible(wake, { held, at }));
  if (eligible.length === 0) {
    if (held.length === 0) return { deferred: 'retry' };
    // No turn is coming to carry the new holds of an intention's wake: a feedback wake in its chat tells her.
    for (const { wake, fact } of freshHolds) {
      if (!['intention_due', 'errand_deadline'].includes(wake.kind) || !wake.placeId) continue;
      await enqueueWake(life, {
        id: `inner.wake:feedback:held:${wake.id}:${fact.id}`,
        kind: 'feedback',
        reason: 'feedback',
        intentionIds: [],
        chainId: wake.chainId,
        dueAt: at,
        placeId: String(wake.placeId),
        dmChat: wake.dmChat === true,
        here: String(wake.placeId),
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

  const { channel, why: noChannelWhy, drop, placeFailure } = await chatFor(life, group);
  if (drop) {
    disposeWakes(life, group, 'no-channel', at, { why: noChannelWhy });
    save(life);
    log.info('inner: no chat', { wakes: group.length });
    for (const wake of group) note(life, { event: 'no-channel', wake: wakeFields(wake) });
    return { dropped: group.length };
  }
  // Where the turn is: its chat's id and whether it is a private chat; none for a turn that is nowhere.
  const where = channel ? String(channel.id) : null;
  const dmChat = channel?.rootId === null;

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
  const shadow = settings.mode !== 'live';
  const hold = holdFor(life, shadow);
  const current = currentChannelOf(group, records);
  // The facts a feedback wake carries, and the other facts this chat may be shown (not told yet).
  const ownFactIds = new Set(group.filter((wake) => wake.kind === 'feedback').flatMap((wake) => listOf(wake.factIds)));
  const shownFacts = pendingFactsOf(state, {
    ...contextOf(life, where),
    placeId: where,
    dmChat,
    anywhere: true,
  })
    .filter((fact) => !ownFactIds.has(fact.id))
    .slice(0, FACTS_SHOWN_MAX);
  const kinds = await kindFacts(life, group, { settings, at });
  const info = wakeInfoOf(life, group, {
    anchor,
    at,
    timezone,
    records,
    notes,
    shownFacts,
    selfimprovement: kinds.selfimprovement,
    placeFailure,
  });
  // The turn's wakes are claimed before it runs: a process that dies in it leaves them running (wake-queue.ts).
  const claimed = await beginTurn(life, group, { at, channel, kind: anchor.kind });
  if (!claimed) return { deferred: 'claim' };
  const { turnId: turnKey, attempt } = claimed;
  const shownIds = [...shownFacts.map((fact) => fact.id), ...[...ownFactIds].map(asText)];
  startWakeRun(life, { turnKey, anchor, group, at, records }, shownIds, {
    placeId: current.placeId ?? null,
    heartbeat: group.some((wake) => wake.kind === 'heartbeat'),
  });
  let measured: Measured;
  try {
    measured = await costs.run(() =>
      turns.runTurn({
        chat: channel ? { iface: channel.iface, chatId: channel.id } : null,
        ...restrictedBy(records),
        mode: 'inner',
        triggerKind: 'inner',
        journalTurn: { turnId: turnKey, attemptId: attempt },
        inner: {
          wake: info,
          currentChannel: channel ? current.placeId : null,
          shadow,
          mayAct: () => mayAct(life),
          hold,
        },
      })
    );
  } catch (err) {
    const code = errorCodeOf(err);
    log.warn('inner: turn failed', { code, error: err });
    measured = { result: { outcome: 'error', reason: code }, usd: 0, requests: 0, voice: 0 };
  } finally {
    endRun(life, group);
  }
  const result = objOf(measured.result ?? { outcome: 'error' });
  const inner = objOf(result.inner);
  const outcome = result.outcome ?? 'error';
  const named = listOf(inner.intentIds ?? []);
  const after = stateOf(life);
  endWakeRun(life, turnKey, listOf(inner.actions), outcome);
  if (HELD.has(outcome)) {
    // Stopped while it waited: its wakes go with the rest of the queue.
    if (after.stopped) disposeWakes(life, group, 'stopped', now());
    // The turn never ran: its mark goes, and its wakes are released.
    save(life);
    await finishWakes(life, group);
    log.info('inner: turn held', { outcome, wakes: group.length });
    return { deferred: outcome };
  }
  const ended = now();
  const errorCode =
    outcome === 'error' ? (typeof result.reason === 'string' && result.reason ? result.reason : CODE.ERROR) : null;
  after.turns.push({
    ...contextOf(life, where),
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
      intentions.countAttendWake(id);
  }
  if (measured.usd > 0) after.spend.push({ at: ended, usd: measured.usd });
  const turnId = inner.turnId ?? result.turnId ?? null;
  if (turnId) after.turnIds.push(asText(turnId));
  // The facts this turn showed are told once a model answer carried them (not after an error).
  if (outcome !== 'error') markFactsTold(after, shownIds, ended, contextOf(life));
  const retry =
    errorCode && RETRY_CODES.has(errorCode) && !after.stopped ? planRetry(group, ended, settings, errorCode) : null;
  // A wake of hers that comes back (a retry, or the one more try of a one-off) carries the facts of this turn.
  let comesBack = false;
  const requeue = (wakes: ReadonlyArray<Wake>, fields: Partial<Wake>) => {
    retryWakes(life, wakes, fields);
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
      code: errorCode,
      retry: retry.n,
      wakes: group.length,
      notBefore: retry.notBefore,
    });
    note(life, {
      event: 'retry',
      code: errorCode,
      retry: retry.n,
      notBefore: retry.notBefore,
      wakes: group.map(wakeFields),
    });
  } else {
    if (retry?.action === 'drop') {
      disposeWakes(life, group, 'provider', ended, { why: errorCode });
      log.warn('inner: turn failed, wakes dropped', {
        code: errorCode,
        retry: retry.n,
        wakes: group.length,
      });
    } else if (errorCode && !after.stopped) {
      // An error that is not a provider failure: a one-off intention's due moment gets one more try, then she is told.
      const oneOff = (wake: Wake) =>
        (wake.kind === 'intention_due' || wake.kind === 'errand_deadline') &&
        wake.retry !== 'error' &&
        !intentions?.store?.()?.get?.(String(listOf(wake.intentionIds)[0]))?.every;
      const again = group.filter(oneOff);
      if (again.length > 0) {
        const [firstDelayMinutes] = settings.retry.delaysMinutes;
        const notBefore = ended + firstDelayMinutes * MINUTE_MS;
        requeue(again, { retry: 'error', firstFailedAt: ended, notBefore, lastCode: errorCode });
        note(life, {
          event: 'retry',
          code: errorCode,
          retry: 'error',
          notBefore,
          wakes: again.map(wakeFields),
        });
      }
      disposeWakes(
        life,
        group.filter((wake) => !again.includes(wake)),
        asText(outcome),
        ended,
        { named, why: errorCode }
      );
    } else {
      disposeWakes(life, group, asText(outcome), ended, { named, why: errorCode });
    }
  }
  // What did not go through (feedbackFacts), and a failed turn itself: kept as facts. A feedback turn's own
  // misses queue no second wake; any other turn's queue one feedback wake in its chain and chat, due at
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
      placeId: where,
      dmChat,
      ...fact,
    })
  );
  save(life);
  const recorded = await finishWakes(life, group, deliveriesOf(hold, { turnId: turnKey, chainId }));
  await sendDeliveries(life, recorded);
  await committedSelfimprovement(life, { ...kinds, outcome });
  let feedbackWakeId: string | null = null;
  if (feedback.length > 0 && !isFeedback && !comesBack) {
    feedbackWakeId = `inner.wake:feedback:${asText(turnId ?? ended)}`;
    await enqueueWake(life, {
      id: feedbackWakeId,
      kind: 'feedback',
      reason: 'feedback',
      intentionIds: [],
      chainId,
      dueAt: ended,
      placeId: where,
      dmChat,
      here: channel ? current.placeId : null,
      turnId: turnId ? asText(turnId) : null,
      facts: feedback,
      factIds: keptFacts.map((fact) => fact.id),
    });
  }
  const actions = inner.actions ?? [];
  const calls = listOf(actions).map(objOf);
  if (anchor.kind === 'heartbeat') logHeartbeatOutcome(life, { outcome, actions: calls });
  else logDueOutcome(life, group, { outcome, actions: calls, named });
  log.info('inner: turn', {
    outcome,
    reason: result.reason ?? null,
    wakes: group.length,
    shadow,
    actions: calls.length,
    usd: measured.usd,
    voice: measured.voice,
  });
  note(life, {
    event: 'turn',
    placeId: dmChat ? null : where,
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
export function onTaskFinished(life: InnerContext, task: unknown): boolean {
  const { now, log } = life;
  try {
    const errand = objOf(task);
    if (!errand.id) return false;
    const state = stateOf(life);
    const id = asText(errand.id);
    const turnId = objOf(errand.origin).turnId;
    const handedOff = turnId && state.turnIds.includes(asText(turnId));
    const usd = Number(objOf(errand.usage).usd);
    const counted = Boolean(handedOff) && Number.isFinite(usd) && usd > 0;
    if (counted) state.spend.push({ at: now(), usd });
    if (!counted) return false;
    save(life);
    note(life, { event: 'errand-cost', taskId: id, usd: counted ? usd : 0 });
    return counted;
  } catch (err) {
    log.warn('inner: errand cost not counted', { code: codeOf(err) });
    return false;
  }
}
