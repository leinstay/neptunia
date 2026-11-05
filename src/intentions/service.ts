// The persona's intentions at work (docs/inner-life.md): her own calls (`intention.set`,
// `intention.update`, `intention.cancel`, `intention.list`, src/tools/impl/intention.ts) create and move them,
// an errand's end reaches the intention waiting on it (`onErrandFinished`), and a reconciliation
// (`reconcile`, at start and for the scheduler of step 2) finds every wait whose errand already
// ended, is gone, or passed its deadline. Reliable waiting: `waiting` needs a real errand id and
// a deadline (the model's invariant); an errand is linked only once the errand store holds it --
// given by id, or handed off in the same turn (a wait asked before the errand was queued is kept
// as `waitRequested` on a `pending` intention and linked by `linkTurnErrand` when that turn's
// `errand.run` queues one; a failed launch links nothing, so nothing waits on it). Completion is
// idempotent: a second end of the same errand finds nothing waiting. A recurring intention
// (`every`, src/intentions/model.ts) is advanced to its next occurrence when the scheduler disposes
// of its wake (`advance`: `recurred` when a call of hers named it, `missed` otherwise), when her
// `state=done` closes the occurrence (`done-occurrence`), and when a wait of its ends with the
// errand (the outcome kept); its wall-clock time is pinned in `bot.timezone`. An attention
// (`attend`, model.js) is set and changed through the same calls (`attend`, `people`, `settle`,
// `perDay`; a due time or a recurrence on it is refused) and carries the day's wake counter the
// scheduler bumps (`countAttendWake`) and reads (`attendToday`, the local day of `bot.timezone`).
// An expired one is told to her once, in her next review's `<wake>`: the scheduler lists the
// expired records not yet marked and marks them (`markExpiredShown`) once that review turn ran.
// Settings are read at the moment of use (`intentions.*`, `wakes.attention.*`,
// `features.intentions`); logs carry ids and codes, never text.

import { randomUUID } from 'node:crypto';
import { log as defaultLog } from '../log.ts';
import { HOUR_MS, zonedDay } from '../time.ts';
import { isOpenState } from '../errands/store.ts';
import {
  advanceOccurrence,
  arrive,
  attendCounter,
  attentionSettings,
  bumpAttend,
  isAttend,
  normalizeAttend,
  createIntention,
  dropIntention,
  dueList as dueOf,
  expireAt,
  heartbeatLimits,
  dueJitterMinutes,
  wakeTimeOf,
  openFromHeartbeat,
  HEARTBEAT_ORIGIN,
  intentionSettings,
  markExpiredShown as markShown,
  isOpen,
  newIntentionId,
  pinEvery,
  reconcileWait,
  sleepIntention,
  transition,
  waitOn,
  CHAIN_CHARS,
  CONDITION_CHARS,
  PURPOSE_CHARS,
} from './model.ts';
import { clampChars, oneLine } from '../memory/clamp.ts';
import { CODE } from '../tools/codes.ts';
import { idText, isFiniteNumber } from '../tools/types.ts';
import type { Untyped } from '../tools/types.ts';
import type { ErrandRecord } from '../errands/types.ts';
import type { ErrandLike } from './types.ts';
import type {
  Advanced,
  Created,
  Due,
  Intention,
  IntentionService,
  IntentionServiceOptions,
  IntentionSettings,
  IntentionStore,
  Moved,
  ReconcileCounts,
  SetInput,
  UpdatePatch,
  Where,
} from './types.ts';

/** Her active ones in due order, the undated last, then the oldest. */
const byDue = (a: Intention, b: Intention): number =>
  (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity) || a.createdAt - b.createdAt;

/** Statuses counted against `intentions.maxOpen` (her active ones; candidates have their own cap). */
const ACTIVE: ReadonlyArray<string> = Object.freeze(['pending', 'waiting'] as const);

/** How a wait is planned: refused, none asked, an errand to wait on, or a wait on the errand her turn will queue. */
type WaitPlan =
  | { ok: false; code: string }
  | { ok: true; none: true }
  | { ok: true; errandId: string; deadline: number }
  | { ok: true; requested: { turnId: string; deadline: number } };

/** The provenance of an intention she set herself from `input`. */
function selfProvenance(input: SetInput): Parameters<typeof createIntention>[0]['provenance'] {
  return {
    kind: 'self',
    turnId: input.turnId ?? null,
    messageId: input.messageId ?? null,
    placeId: input.placeId ?? null,
    scope: input.scope,
    participants: input.participants,
    ...(input.publicationBoundary ? { publicationBoundary: input.publicationBoundary } : {}),
    ...(input.callKey ? { callKey: input.callKey } : {}),
  };
}

/**
 * A restarted turn's same `set` call answers with what the first one made, whatever the call says this time and before
 * any cap is checked. Any other call goes to `make`.
 */
function setOnce<TAnswer>(
  store: IntentionStore | null,
  input: SetInput,
  make: () => TAnswer
): TAnswer | { ok: true; intention: Intention } {
  const key = input.callKey;
  const made = key ? store?.list().find((record) => record.provenance?.callKey === key) : null;
  return made ? { ok: true, intention: made } : make();
}

/** What a call that needs an open record answers on a closed one: `slept` when the engine cancelled it as she slept. */
const closedCode = (record: Intention): string => (isFiniteNumber(record.sleptAt) ? CODE.SLEPT : CODE.TERMINAL);

/**
 * Whether `record` may be seen and moved where the caller is: a private chat's intention only in
 * that chat (`privateChannelId`), any with `all` (an owner's command, the engine).
 */
function visibleTo(record: Intention, { privateChannelId = null, all = false }: Where = {}): boolean {
  return (
    all ||
    record?.provenance?.scope !== 'dm' ||
    (privateChannelId !== null &&
      privateChannelId !== undefined &&
      record.provenance?.placeId === String(privateChannelId))
  );
}

/** How many intentions of `list` count against `maxOpen`. */
function activeCount(list: Array<Intention>): number {
  return list.filter((record) => ACTIVE.includes(record.status)).length;
}

/** `record` with the wait of `plan` applied (a model move), or the record as it is. */
function applyWait(record: Intention, plan: WaitPlan | null, by: string, at: number): Moved {
  if (!plan || !plan.ok || 'none' in plan) return { ok: true, intention: record, changed: false };
  if ('requested' in plan)
    return { ok: true, intention: { ...record, waitRequested: plan.requested, updatedAt: at }, changed: true };
  return waitOn(record, { errandId: plan.errandId, deadline: plan.deadline, now: at, by });
}

/**
 * The refusal of one more intention from a heartbeat when the caps are reached (`heartbeat.maxOpen`,
 * `maxRecurring`, read now): `{ ok: false, code: 'heartbeat-cap'|'heartbeat-recurring-cap', open }`, `open` the
 * open records from heartbeats (so she can update or cancel one), or null.
 */
function heartbeatCapRefusal(
  config: Untyped,
  store: IntentionStore,
  { recurring }: { recurring: boolean }
): { ok: false; code: string; open: Array<Intention> } | null {
  const limits = heartbeatLimits(config);
  const open = openFromHeartbeat(store.list());
  if (open.length >= limits.maxOpen) return { ok: false, code: CODE.HEARTBEAT_CAP, open };
  if (recurring && open.filter((record) => record.every).length >= limits.maxRecurring)
    return { ok: false, code: CODE.HEARTBEAT_RECURRING_CAP, open };
  return null;
}

/**
 * `hot` holds the live config. `errands` is the errand service (src/errands/service.ts): the errand store a wait is
 * checked against.
 */
export function createIntentionService({
  stores,
  hot,
  errands = null,
  now = Date.now,
  uuid = randomUUID,
  log = defaultLog,
}: IntentionServiceOptions): IntentionService {
  function storeOf(): IntentionStore | null {
    return stores.get();
  }

  function settings(): IntentionSettings {
    return intentionSettings(hot.config);
  }

  /** The bot's timezone, read now (the wall clock a recurrence is pinned to). */
  function timezone(): string {
    return hot.config?.bot?.timezone ?? 'UTC';
  }

  /** The errand `id` of the place's errand store, or null. */
  function errandOf(id: unknown): ErrandLike | null {
    const store = errands?.store?.() ?? null;
    const errand = id && store ? store.get(idText(id)) : null;
    return errand ?? null;
  }

  /** The latest errand of turn `turnId` in the place's errand store, or null. */
  function errandOfTurn(turnId: unknown): ErrandLike | null {
    const store = errands?.store?.() ?? null;
    if (!store || !turnId || typeof store.recent !== 'function') return null;
    return store.recent(50).find((errand) => errand.origin?.turnId === idText(turnId)) ?? null;
  }

  /** The wait `move` adds to a record: on errand `errandId` (checked) or the turn's errand, else requested. */
  function waitPlan({
    errandId = null,
    deadline = null,
    turnId = null,
  }: {
    errandId?: string | null;
    deadline?: number | null;
    turnId?: string | null;
  }): WaitPlan {
    const at = now();
    const until = isFiniteNumber(deadline) ? deadline : at + settings().waitHours * HOUR_MS;
    if (errandId) {
      const errand = errandOf(errandId);
      if (!errand) return { ok: false, code: CODE.NO_ERRAND };
      if (!isOpenState(errand.state)) return { ok: false, code: CODE.ERRAND_ENDED };
      return { ok: true, errandId: errand.id, deadline: until };
    }
    if (!isFiniteNumber(deadline)) return { ok: true, none: true };
    const same = errandOfTurn(turnId);
    if (same && isOpenState(same.state)) return { ok: true, errandId: same.id, deadline: until };
    if (!turnId) return { ok: false, code: CODE.WAIT_WITHOUT_ERRAND };
    return { ok: true, requested: { turnId: idText(turnId), deadline: until } };
  }

  /**
   * A new intention of hers (or an owner's command), `pending`: `{ ok: true, intention }` or
   * `{ ok: false, code }` (`no-place`, `cap-open`, the model's codes, the wait's: `no-errand`,
   * `errand-ended`, `wait-without-errand`, `bad-deadline`; `write-failed`).
   * `input.every` is parseEvery's shape (null or missing: a one-off); its wall-clock time is pinned from `dueAt`.
   * `input.attend` makes it an attention (model.js#normalizeAttend; its defaults `wakes.attention.*`, read now).
   */
  function set(input: SetInput): ReturnType<IntentionService['set']> {
    const store = storeOf();
    if (!store) return { ok: false, code: CODE.PLACE_REQUIRED };
    const limits = settings();
    if (activeCount(store.list()) >= limits.maxOpen) return { ok: false, code: CODE.CAP_OPEN };
    const by = input.by ?? 'persona';
    if (input.state === 'dropped') return setDropped(store, input, by);
    // What a heartbeat turn creates is stamped by the engine and held to its caps, in the same synchronous step as the add.
    const origin = input.origin === HEARTBEAT_ORIGIN ? HEARTBEAT_ORIGIN : null;
    if (origin) {
      const refused = heartbeatCapRefusal(hot.config, store, { recurring: Boolean(input.every) });
      if (refused) {
        log.info('intentions: heartbeat cap', {
          code: refused.code,
          open: refused.open.length,
        });
        return refused;
      }
    }
    const created = createIntention({
      purpose: input.purpose,
      provenance: selfProvenance(input),
      dueAt: input.dueAt ?? null,
      every: pinEvery(input.every ?? null, input.dueAt ?? null, timezone()),
      expiresAt: input.expiresAt ?? null,
      standing: input.standing,
      destination: input.destination ?? null,
      completionCondition: input.completionCondition ?? null,
      chainId: input.chainId ?? null,
      attend: input.attend ?? null,
      origin,
      now: now(),
      settings: { ...limits, attention: attentionSettings(hot.config) },
      id: freshId(store),
      by,
    });
    if (!created.ok) return created;
    const plan = waitPlan({
      errandId: input.errandId ?? null,
      deadline: input.deadline ?? null,
      turnId: input.turnId ?? null,
    });
    if (!plan.ok) return plan;
    const waited = applyWait(created.intention, plan, by, now());
    if (!waited.ok) return waited;
    const added = store.add(waited.intention);
    if (added.ok)
      log.info('intentions: set', {
        id: added.intention.id,
        status: added.intention.status,
        by,
        ...(origin ? { origin, openFromHeartbeat: openFromHeartbeat(store.list()).length } : {}),
      });
    return added;
  }

  /**
   * A new record born `dropped` (`set` with `state: 'dropped'`): a desire she considered and let
   * go, with its `reason` (`reason-required` without one). It is not active (no `maxOpen` check),
   * never wakes, and is kept like any closed one.
   */
  function setDropped(store: IntentionStore, input: SetInput, by: string): Created {
    const created = createIntention({
      purpose: input.purpose,
      provenance: selfProvenance(input),
      dropped: true,
      reason: input.reason ?? null,
      now: now(),
      settings: settings(),
      id: freshId(store),
      by,
    });
    if (!created.ok) return created;
    const added = store.add(created.intention);
    if (added.ok) log.info('intentions: set', { id: added.intention.id, status: 'dropped', by });
    return added;
  }

  function freshId(store: IntentionStore): string {
    for (;;) {
      const id = newIntentionId(uuid);
      if (!store.get(id)) return id;
    }
  }

  /**
   * Intention `id` changed: `state` `pending` accepts a candidate (it counts against `maxOpen`
   * and lives `expiresDays` from then unless `expiresAt` is given)
   * or ends a wait by hand, `done` closes it (a recurring one's occurrence only: it advances to the
   * next, code `done-occurrence`); `purpose`, `dueAt`, `every` (parseEvery's shape; null makes it
   * one-off; `every-without-due` without a due time), `expiresAt`, `destination`,
   * `completionCondition`, `chainId` edit an open one; `attend` (`{ people?, settle?, perDay? }`)
   * edits an attention (`not-attend` on any other; a due time or a recurrence on an attention is
   * `attend-with-due` / `attend-with-every`); `errandId` / `deadline` set it waiting (as in
   * `set`). `{ ok, intention }` or `{ ok: false, code }` (`not-found`, `terminal`, `cap-open`,
   * `bad-move`, the model's and the wait's codes). `patch.privateChannelId` / `patch.all`: where the
   * caller is (a private chat's intention is `not-found` anywhere else, see `list`).
   */
  function update(id: unknown, patch: UpdatePatch = {}): Moved {
    const store = storeOf();
    if (!store) return { ok: false, code: CODE.PLACE_REQUIRED };
    const current = store.get(id);
    if (!current || !visibleTo(current, patch)) return { ok: false, code: CODE.NOT_FOUND };
    if (!isOpen(current.status)) return { ok: false, code: closedCode(current) };
    const by = patch.by ?? 'persona';
    const dropping = patch.state === 'dropped';
    if (dropping && !(typeof patch.reason === 'string' && patch.reason.trim()))
      return { ok: false, code: CODE.REASON_REQUIRED };
    // A heartbeat's one-off made recurring counts against the recurring cap like a new recurring one.
    if (current.origin === HEARTBEAT_ORIGIN && patch.every && !current.every) {
      const others = openFromHeartbeat(store.list()).filter((record) => record.id !== current.id);
      if (others.filter((record) => record.every).length >= heartbeatLimits(hot.config).maxRecurring)
        return { ok: false, code: CODE.HEARTBEAT_RECURRING_CAP, open: others };
    }
    const plan =
      !dropping && (patch.errandId || isFiniteNumber(patch.deadline))
        ? waitPlan({
            errandId: patch.errandId ?? null,
            deadline: patch.deadline ?? null,
            turnId: patch.turnId ?? null,
          })
        : null;
    if (plan && !plan.ok) return plan;
    const at = now();
    const result = store.update(id, (record): Moved => {
      let next = record;
      let changed = false;
      const fields: Partial<Intention> = {};
      if (typeof patch.purpose === 'string' && patch.purpose.trim())
        fields.purpose = clampChars(oneLine(patch.purpose), PURPOSE_CHARS);
      if (patch.dueAt !== undefined) fields.dueAt = patch.dueAt;
      if (patch.every !== undefined) fields.every = patch.every;
      if (patch.expiresAt !== undefined && patch.expiresAt !== null) {
        if (!(patch.expiresAt > at)) return { ok: false, code: CODE.BAD_EXPIRY };
        fields.expiresAt = patch.expiresAt;
      }
      if (patch.destination !== undefined) fields.destination = patch.destination ? String(patch.destination) : null;
      if (typeof patch.completionCondition === 'string')
        fields.completionCondition = clampChars(oneLine(patch.completionCondition), CONDITION_CHARS) || null;
      if (typeof patch.chainId === 'string') fields.chainId = clampChars(oneLine(patch.chainId), CHAIN_CHARS) || null;
      if (patch.attend !== undefined && patch.attend !== null) {
        if (!isAttend(record)) return { ok: false, code: CODE.NOT_ATTEND };
        const attend = normalizeAttend(
          { ...record.attend, ...patch.attend, place: record.attend.place, today: record.attend.today ?? null },
          attentionSettings(hot.config)
        );
        if (!attend) return { ok: false, code: CODE.BAD_ATTEND };
        fields.attend = attend;
      }
      if (isAttend(record) && fields.dueAt !== undefined && fields.dueAt !== null)
        return { ok: false, code: CODE.ATTEND_WITH_DUE };
      if (isAttend(record) && fields.every) return { ok: false, code: CODE.ATTEND_WITH_EVERY };
      if (Object.keys(fields).length > 0) {
        next = { ...next, ...fields, updatedAt: at };
        if (next.every && !isFiniteNumber(next.dueAt)) return { ok: false, code: CODE.EVERY_WITHOUT_DUE };
        // A recurrence keeps the wall clock of its (new) first occurrence.
        if (next.every && (fields.every !== undefined || fields.dueAt !== undefined))
          next.every = pinEvery({ period: next.every.period, at: fields.every?.at ?? null }, next.dueAt, timezone());
        // (A recurring one's next occurrence may already lie past its expiry: the expiry wins; only a new due or expiry is checked.)
        if (
          (fields.dueAt !== undefined || fields.expiresAt !== undefined) &&
          isFiniteNumber(next.dueAt) &&
          next.dueAt > next.expiresAt
        )
          return { ok: false, code: CODE.DUE_AFTER_EXPIRY };
        changed = true;
      }
      if (patch.state === 'pending' && next.status !== 'pending') {
        const moved = transition(next, 'pending', { now: at, by, code: 'resumed' });
        if (!moved.ok) return moved;
        next = moved.intention;
        changed = true;
      }
      if (plan) {
        const waited = applyWait(next, plan, by, now());
        if (!waited.ok) return waited;
        next = waited.intention;
        changed = changed || waited.changed;
      }
      if (dropping) {
        const moved = dropIntention(next, { reason: patch.reason, now: at, by });
        if (!moved.ok) return moved;
        next = moved.intention;
        changed = true;
      }
      if (patch.state === 'done') {
        // A recurring one is never done: this closes the occurrence and sets the next.
        const moved = next.every
          ? advanceOccurrence(next, { now: at, timezone: timezone(), code: CODE.DONE_OCCURRENCE, by })
          : transition(next, 'done', { now: at, by, code: CODE.DONE });
        if (!moved.ok) return moved;
        next = moved.intention;
        changed = true;
      }
      return { ok: true, intention: next, changed };
    });
    if (result.ok && result.changed)
      log.info('intentions: updated', { id: idText(id), status: result.intention.status, by });
    return result;
  }

  /**
   * Intention `id` cancelled (a candidate rejected): `{ ok, intention }` or `{ ok: false, code }`.
   * `privateChannelId` / `all`: where the caller is, as in `update`.
   */
  function cancel(
    id: unknown,
    { by = 'persona', privateChannelId = null, all = false }: { by?: string } & Where = {}
  ): Moved {
    const store = storeOf();
    if (!store) return { ok: false, code: CODE.PLACE_REQUIRED };
    const current = store.get(id);
    if (current && !visibleTo(current, { privateChannelId, all })) return { ok: false, code: CODE.NOT_FOUND };
    if (current && isFiniteNumber(current.sleptAt)) return { ok: false, code: CODE.SLEPT };
    const result = store.update(id, (record) => transition(record, 'cancelled', { now: now(), by, code: 'cancelled' }));
    if (result.ok) log.info('intentions: cancelled', { id: idText(id), by });
    return result;
  }

  /** Intention `id` whose wake slept (src/behavior/inner/recovery.ts), through model.ts#sleepIntention. */
  function sleep(id: unknown): Moved {
    const store = storeOf();
    if (!store) return { ok: false, code: CODE.PLACE_REQUIRED };
    const result = store.update(id, (record) => sleepIntention(record, { now: now(), timezone: timezone() }));
    if (result.ok && result.changed) log.info('intentions: slept', { id: idText(id) });
    return result;
  }

  /** Every open intention past its `expiresAt` expired and written. How many. */
  function sweepExpired(store: IntentionStore): number {
    let count = 0;
    const at = now();
    for (const record of store.list()) {
      if (!isOpen(record.status) || !(at >= record.expiresAt)) continue;
      const result = store.update(record.id, (current) => expireAt(current, at));
      if (result.ok && result.changed) count += 1;
    }
    if (count > 0) log.info('intentions: expired', { count });
    return count;
  }

  /**
   * The place's intentions, the expired ones swept first: open ones only unless `closed`, each
   * visible to the conversation (`privateChannelId`: a private chat's own only there), or every
   * one with `all` (an owner's list).
   */
  function list({
    closed = false,
    privateChannelId = null,
    all = false,
  }: { closed?: boolean } & Where = {}): Array<Intention> {
    const store = storeOf();
    if (!store) return [];
    sweepExpired(store);
    return store
      .list()
      .filter((record) => (closed || isOpen(record.status)) && visibleTo(record, { privateChannelId, all }));
  }

  /**
   * What the `<intentions>` block shows in a conversation: her active ones (`pending`, then
   * `waiting`, by due time then age). Empty with
   * `features.intentions` off.
   */
  function view({ privateChannelId = null }: { privateChannelId?: string | null } = {}): Array<Intention> {
    const open = list({ privateChannelId });
    const active = open.filter((record) => record.status === 'pending').sort(byDue);
    const waiting = open.filter((record) => record.status === 'waiting').sort(byDue);
    return [...active, ...waiting];
  }

  /**
   * Errand `errandId`, just queued by turn `turnId`, linked to every `pending` intention of that turn
   * whose wait was asked before the errand existed (`waitRequested`). How many.
   */
  function linkTurnErrand({ turnId, errandId }: { turnId: unknown; errandId: unknown }): number {
    const store = storeOf();
    if (!store || !turnId || !errandId) return 0;
    let linked = 0;
    for (const record of store.list()) {
      if (record.status !== 'pending' || record.waitRequested?.turnId !== idText(turnId)) continue;
      const deadline = record.waitRequested.deadline;
      const result = store.update(record.id, (current) =>
        waitOn(current, {
          errandId,
          deadline: isFiniteNumber(deadline) && deadline > now() ? deadline : now() + settings().waitHours * HOUR_MS,
          now: now(),
          by: 'engine',
        })
      );
      if (result.ok && result.changed) linked += 1;
    }
    if (linked > 0) log.info('intentions: linked', { taskId: idText(errandId), count: linked });
    return linked;
  }

  /**
   * An errand's end (src/errands/service.ts's `onFinished`): every intention waiting on it moves
   * to `pending` with its outcome. Idempotent: the same end twice moves nothing the second time.
   * Never throws; how many moved.
   */
  function onErrandFinished(errand: ErrandRecord): number {
    try {
      const store = storeOf();
      if (!store || !errand?.id) return 0;
      let moved = 0;
      for (const record of store.list()) {
        if (record.status !== 'waiting' || record.awaitingErrandId !== String(errand.id)) continue;
        const result = store.update(record.id, (current) => arrive(current, errand, { now: now() }));
        if (result.ok && result.changed) moved += 1;
        if (result.ok && result.changed) afterWait(store, result.intention);
      }
      if (moved > 0)
        log.info('intentions: errand arrived', {
          taskId: String(errand.id),
          state: errand.state,
          count: moved,
        });
      return moved;
    } catch (err) {
      log.warn('intentions: errand end not applied', { taskId: errand?.id ?? null, error: err });
      return 0;
    }
  }

  /**
   * The reconciliation (at start, and the scheduler's tick of step 2): every `waiting` intention
   * whose errand already ended (`arrived`), is gone from the errand store (`missing`), or passed its
   * wait deadline (`deadline`) moved to `pending` with a note; then every open one past its expiry
   * expired. Counts; never throws.
   */
  function reconcile(): ReconcileCounts {
    const counts: ReconcileCounts = { arrived: 0, missing: 0, deadline: 0, expired: 0 };
    try {
      const store = storeOf();
      if (!store) return counts;
      for (const record of store.list()) {
        if (record.status !== 'waiting') continue;
        const result = store.update(record.id, (current) =>
          reconcileWait(current, { errandOf: (id) => errandOf(id), now: now() })
        );
        if (!result.ok || !result.changed) continue;
        const note = result.intention.note;
        if (note === 'errand-missing') counts.missing += 1;
        else if (note === 'wait-deadline') counts.deadline += 1;
        else counts.arrived += 1;
        // A passed deadline wakes her (an `errand_deadline` wake); that wake's disposition advances it.
        if (note !== 'wait-deadline') afterWait(store, result.intention);
      }
      counts.expired = sweepExpired(store);
      if (counts.arrived + counts.missing + counts.deadline > 0) log.info('intentions: reconciled', { ...counts });
    } catch (err) {
      log.warn('intentions: reconcile failed', { error: err });
    }
    return counts;
  }

  /**
   * Recurring intention `id` advanced past its current occurrence (src/intentions/model.ts#advanceOccurrence)
   * when that occurrence is due or past (`dueAt <= now`) and the record is `pending`: the scheduler calls
   * it when the occurrence's wake is disposed of (her turn ended, or the wake was dropped). `named`: a
   * call of hers in that turn named it (code `recurred`), else `missed`. A one-off, a waiting one (its
   * occurrence runs on until the wait ends), an occurrence already advanced (her `state=done`, a new
   * due she set) and a closed record change nothing. Never throws; `{ ok, intention, changed }`.
   */
  function advance(id: unknown, { named = false, by = 'engine' }: { named?: boolean; by?: string } = {}): Advanced {
    try {
      const store = storeOf();
      const current = store?.get(id) ?? null;
      const at = now();
      if (
        !store ||
        !current?.every ||
        current.status !== 'pending' ||
        !(wakeTimeOf(current, dueJitterMinutes(hot.config)) <= at)
      )
        return { ok: true, intention: current, changed: false };
      const code = named ? 'recurred' : 'missed';
      const result = store.update(id, (record) =>
        advanceOccurrence(record, { now: at, timezone: timezone(), code, by })
      );
      if (result.ok && result.changed)
        log.info('intentions: recurred', {
          id: idText(id),
          code,
          dueAt: result.intention.dueAt,
        });
      return result;
    } catch (err) {
      log.warn('intentions: advance failed', { id: idText(id), error: err });
      return { ok: false, code: CODE.WRITE_FAILED };
    }
  }

  /** A wait of recurring `record` just ended with its errand: the occurrence closes, the outcome kept. */
  function afterWait(store: IntentionStore, record: Intention): void {
    if (!record?.every || record.status !== 'pending') return;
    const at = now();
    if (!(wakeTimeOf(record, dueJitterMinutes(hot.config)) <= at)) return;
    const result = store.update(record.id, (current) =>
      advanceOccurrence(current, {
        now: at,
        timezone: timezone(),
        code: CODE.RECURRED,
        by: 'engine',
        keepWaitEnd: true,
      })
    );
    if (result.ok && result.changed)
      log.info('intentions: recurred', {
        id: String(record.id),
        code: CODE.RECURRED,
        dueAt: result.intention.dueAt,
      });
  }

  /**
   * Expired intention `id` marked as shown to her (`expiredShownAt`, src/intentions/model.ts#markExpiredShown):
   * the scheduler calls it once the review turn that listed it ran. An unexpired, unknown or already
   * marked record changes nothing. `{ ok, intention, changed }` or `{ ok: false, code }`.
   */
  function markExpiredShown(id: unknown): Moved {
    const store = storeOf();
    if (!store) return { ok: false, code: CODE.PLACE_REQUIRED };
    const result = store.update(id, (current) => markShown(current, now()));
    if (result.ok && result.changed) log.info('intentions: expired shown', { id: idText(id) });
    return result;
  }

  /** The place's open attentions (`pending` records with an `attend` place), the expired swept first. */
  function attending(): Array<Intention> {
    return list({ all: true }).filter((record) => record.status === 'pending' && isAttend(record));
  }

  /** The day's wake counter of attention `id` (model.js#attendCounter, today in `bot.timezone`), or null. */
  function attendToday(id: unknown): { day: string; wakes: number } | null {
    const record = storeOf()?.get(id) ?? null;
    return isAttend(record) ? attendCounter(record, zonedDay(now(), timezone())) : null;
  }

  /**
   * One attend wake of attention `id` counted on today's counter (the scheduler, after the
   * wake's turn): `{ ok, intention, changed }` (`not-attend`, `not-found`, `write-failed`). Never throws.
   */
  function countAttendWake(id: unknown): Moved {
    try {
      const store = storeOf();
      if (!store) return { ok: false, code: CODE.PLACE_REQUIRED };
      const result = store.update(id, (record) => bumpAttend(record, zonedDay(now(), timezone())));
      if (result.ok && result.changed)
        log.info('intentions: attend wake counted', {
          id: idText(id),
          wakes: result.intention.attend?.today?.wakes,
        });
      return result;
    } catch (err) {
      log.warn('intentions: attend count failed', { id: idText(id), error: err });
      return { ok: false, code: CODE.WRITE_FAILED };
    }
  }

  /** What is due now (src/intentions/model.ts#dueList) for the place, its expired swept first. */
  function due(): Array<Due> {
    const store = storeOf();
    if (!store) return [];
    sweepExpired(store);
    return dueOf(store.list(), now(), dueJitterMinutes(hot.config));
  }

  return {
    set: (input) => setOnce(storeOf(), input, () => set(input)),
    update,
    cancel,
    list,
    view,
    linkTurnErrand,
    onErrandFinished,
    reconcile,
    advance,
    sleep,
    due,
    attending,
    attendToday,
    countAttendWake,
    markExpiredShown,
    store: storeOf,
  };
}
