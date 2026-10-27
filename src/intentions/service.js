// The persona's intentions at work (docs/inner-life.md): her own calls (`intention.set`,
// `intention.update`, `intention.cancel`, `intention.list`, src/tools/impl/intention.ts) create and move them, the
// memory analyzer's candidates from her own lines arrive as `proposed` ones (`addCandidates`),
// an errand's end reaches the intention waiting on it (`onTaskFinished`), and a reconciliation
// (`reconcile`, at start and for the scheduler of step 2) finds every wait whose errand already
// ended, is gone, or passed its deadline. Reliable waiting: `waiting` needs a real errand id and
// a deadline (the model's invariant); an errand is linked only once the task store holds it --
// given by id, or handed off in the same turn (a wait asked before the errand was queued is kept
// as `waitRequested` on a `pending` intention and linked by `linkTurnTask` when that turn's
// `errand.run` queues one; a failed launch links nothing, so nothing waits on it). Completion is
// idempotent: a second end of the same errand finds nothing waiting. A recurring intention
// (`every`, src/intentions/model.js) is advanced to its next occurrence when the scheduler disposes
// of its wake (`advance`: `recurred` when a call of hers named it, `missed` otherwise), when her
// `state=done` closes the occurrence (`done-occurrence`), and when a wait of its ends with the
// errand (the outcome kept); its wall-clock time is pinned in `bot.timezone`. An attention
// (`attend`, model.js) is set and changed through the same calls (`attend`, `people`, `settle`,
// `perDay`; a due time or a recurrence on it is refused) and carries the day's wake counter the
// scheduler bumps (`countAttendWake`) and reads (`attendToday`, the local day of `bot.timezone`).
// An expired one is told to her once, in her next review's `<wake>`: the scheduler lists the
// expired records not yet marked and marks them (`markExpiredShown`) once that review turn ran.
// Settings are read at the moment of use (`intentions.*`, `innerLife.attention.*`,
// `features.intentions`); logs carry ids and codes, never text.

import { randomUUID } from 'node:crypto';
import { log as defaultLog } from '../log.js';
import { DAY_MS, HOUR_MS, zonedDay } from '../time.js';
import { isOpenState } from '../errands/store.js';
import { createLineSources } from './sources.js';
import {
  acceptRefusal,
  advanceOccurrence,
  arrive,
  attendCounter,
  attentionSettings,
  bumpAttend,
  isAttend,
  normalizeAttend,
  candidatesFromAnswer,
  createIntention,
  dropIntention,
  dueList as dueOf,
  duplicates,
  expireAt,
  heartbeatLimits,
  dueJitterMinutes,
  wakeTimeOf,
  openFromHeartbeat,
  HEARTBEAT_ORIGIN,
  intentionSettings,
  markExpiredShown as markShown,
  intentionsOn,
  isOpen,
  newIntentionId,
  pinEvery,
  reconcileWait,
  transition,
  waitOn,
  CHAIN_CHARS,
  CONDITION_CHARS,
  PURPOSE_CHARS,
} from './model.js';
import { clampChars, oneLine } from '../memory/clamp.js';
import { CODE } from '../tools/codes.ts';

/** Statuses counted against `intentions.maxOpen` (her active ones; candidates have their own cap). */
const ACTIVE = Object.freeze(['pending', 'waiting']);

/**
 * @param {object} options
 * @param {{ get(guildId: string): object|null }} options.stores  src/intentions/store.js#createIntentionStores
 * @param {{ config: object }} options.hot
 * @param {{ store(guildId: string): ({ get(id: string): object|null }|null) }|null} [options.tasks]  The errand
 *   service (src/errands/service.js): the task store a wait is checked against.
 * @param {{ findTurn?: Function }|null} [options.journal]  Where a candidate's turn is looked up.
 * @param {{ note: Function, get: Function }|null} [options.lineSources]  The notes of where her lines
 *   came from (src/intentions/sources.js#createLineSources; one of its own by default): the turn
 *   runner notes each line she posts (`noteLine`), the memory buffer takes the note with the line
 *   (`lineSources`), and a candidate is judged by it (`addCandidates`, strict: a line of hers with
 *   no note counts as external).
 * @param {() => string|null} [options.getGuildId]
 * @param {() => number} [options.now]
 * @param {() => string} [options.uuid]
 * @param {{ info: Function, warn: Function }} [options.log]
 */
export function createIntentionService({
  stores,
  hot,
  tasks = null,
  journal = null,
  lineSources = createLineSources(),
  getGuildId = () => null,
  now = Date.now,
  uuid = randomUUID,
  log = defaultLog,
}) {
  function storeOf(guildId) {
    return stores.get(guildId || getGuildId?.() || '');
  }

  function settings() {
    return intentionSettings(hot.config);
  }

  /** The bot's timezone, read now (the wall clock a recurrence is pinned to). */
  function timezone() {
    return hot.config?.bot?.timezone ?? 'UTC';
  }

  /** The errand `id` of the guild's task store, or null. */
  function taskOf(guildId, id) {
    const store = tasks?.store?.(guildId) ?? null;
    const task = id && store ? store.get(String(id)) : null;
    return task ?? null;
  }

  /** The latest errand of turn `turnId` in the guild's task store, or null. */
  function taskOfTurn(guildId, turnId) {
    const store = tasks?.store?.(guildId) ?? null;
    if (!store || !turnId || typeof store.recent !== 'function') return null;
    return store.recent(50).find((task) => task.origin?.turnId === String(turnId)) ?? null;
  }

  /**
   * Whether `record` may be seen and moved where the caller is: a private chat's intention only in
   * that chat (`privateChannelId`), any with `all` (an owner's command, the engine).
   */
  function visibleTo(record, { privateChannelId = null, all = false } = {}) {
    return (
      all ||
      record?.provenance?.scope !== 'dm' ||
      (privateChannelId !== null &&
        privateChannelId !== undefined &&
        record.provenance?.channelId === String(privateChannelId))
    );
  }

  /** How many intentions of `list` count against `maxOpen`. */
  function activeCount(list) {
    return list.filter((record) => ACTIVE.includes(record.status)).length;
  }

  /** The wait `move` adds to a record: on errand `taskId` (checked) or the turn's errand, else requested. */
  function waitPlan(guildId, { taskId = null, deadline = null, turnId = null }) {
    const at = now();
    const until = Number.isFinite(deadline) ? deadline : at + settings().waitHours * HOUR_MS;
    if (taskId) {
      const task = taskOf(guildId, taskId);
      if (!task) return { ok: false, code: CODE.NO_ERRAND };
      if (!isOpenState(task.state)) return { ok: false, code: CODE.ERRAND_ENDED };
      return { ok: true, taskId: task.id, deadline: until };
    }
    if (!Number.isFinite(deadline)) return { ok: true, none: true };
    const same = taskOfTurn(guildId, turnId);
    if (same && isOpenState(same.state)) return { ok: true, taskId: same.id, deadline: until };
    if (!turnId) return { ok: false, code: CODE.WAIT_WITHOUT_ERRAND };
    return { ok: true, requested: { turnId: String(turnId), deadline: until } };
  }

  /** `record` with the wait of `plan` applied (a model move), or the record as it is. */
  function applyWait(record, plan, by) {
    if (!plan || plan.none) return { ok: true, intention: record, changed: false };
    if (plan.requested)
      return { ok: true, intention: { ...record, waitRequested: plan.requested, updatedAt: now() }, changed: true };
    return waitOn(record, { taskId: plan.taskId, deadline: plan.deadline, now: now(), by });
  }

  /**
   * A new intention of hers (or an owner's command), `pending`: `{ ok: true, intention }` or
   * `{ ok: false, code }` (`no-guild`, `cap-open`, the model's codes, the wait's: `no-errand`,
   * `errand-ended`, `wait-without-errand`, `bad-deadline`; `write-failed`).
   * @param {string|null} guildId
   * @param {{ purpose: string, dueAt?: number|null, every?: { period: string, at?: string|null }|null, expiresAt?: number|null, destination?: string|null,
   *   completionCondition?: string|null, chainId?: string|null, taskId?: string|null, deadline?: number|null,
   *   turnId?: string|null, messageId?: string|null, channelId?: string|null, scope?: 'dm'|'group', participants?: string[], by?: string,
   *   attend?: { place: string, people?: string[], settle?: number, perDay?: number }|null }} input
   *   `every` is parseEvery's shape (null or missing: a one-off); its wall-clock time is pinned from `dueAt`.
   *   `attend` makes it an attention (model.js#normalizeAttend; its defaults `innerLife.attention.*`, read now).
   */
  function set(guildId, input) {
    const store = storeOf(guildId);
    if (!store) return { ok: false, code: CODE.NO_GUILD };
    const limits = settings();
    if (activeCount(store.list()) >= limits.maxOpen) return { ok: false, code: CODE.CAP_OPEN };
    const by = input.by ?? 'persona';
    if (input.state === 'dropped') return setDropped(store, input, by);
    // What a heartbeat turn creates is stamped by the engine and held to its own caps, checked here
    // in the same synchronous step as the add (nothing can slip between the count and the write).
    const origin = input.origin === HEARTBEAT_ORIGIN ? HEARTBEAT_ORIGIN : null;
    if (origin) {
      const refused = heartbeatCapRefusal(store, { recurring: Boolean(input.every) });
      if (refused) {
        log.info('intentions: heartbeat cap', {
          guildId: store.guildId,
          code: refused.code,
          open: refused.open.length,
        });
        return refused;
      }
    }
    const created = createIntention({
      purpose: input.purpose,
      provenance: {
        kind: 'self',
        turnId: input.turnId ?? null,
        messageId: input.messageId ?? null,
        channelId: input.channelId ?? null,
        scope: input.scope,
        participants: input.participants,
      },
      dueAt: input.dueAt ?? null,
      every: pinEvery(input.every ?? null, input.dueAt ?? null, timezone()),
      expiresAt: input.expiresAt ?? null,
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
    const plan = waitPlan(store.guildId, {
      taskId: input.taskId ?? null,
      deadline: input.deadline ?? null,
      turnId: input.turnId ?? null,
    });
    if (!plan.ok) return plan;
    const waited = applyWait(created.intention, plan, by);
    if (!waited.ok) return waited;
    const added = store.add(waited.intention);
    if (added.ok)
      log.info('intentions: set', {
        guildId: store.guildId,
        id: added.intention.id,
        status: added.intention.status,
        by,
        ...(origin ? { origin, openFromHeartbeat: openFromHeartbeat(store.list()).length } : {}),
      });
    return added;
  }

  /**
   * The refusal of one more intention from a heartbeat when the caps are reached (`innerLife.heartbeat.maxOpen`,
   * `maxRecurring`, read now): `{ ok: false, code: 'heartbeat-cap'|'heartbeat-recurring-cap', open }`, `open` the
   * open records from heartbeats (so she can update or cancel one), or null.
   */
  function heartbeatCapRefusal(store, { recurring }) {
    const limits = heartbeatLimits(hot.config);
    const open = openFromHeartbeat(store.list());
    if (open.length >= limits.maxOpen) return { ok: false, code: CODE.HEARTBEAT_CAP, open };
    if (recurring && open.filter((record) => record.every).length >= limits.maxRecurring)
      return { ok: false, code: CODE.HEARTBEAT_RECURRING_CAP, open };
    return null;
  }

  /**
   * A new record born `dropped` (`set` with `state: 'dropped'`): a desire she considered and let
   * go, with its `reason` (`reason-required` without one). It is not active (no `maxOpen` check),
   * never wakes, and is kept like any closed one.
   */
  function setDropped(store, input, by) {
    const created = createIntention({
      purpose: input.purpose,
      provenance: {
        kind: 'self',
        turnId: input.turnId ?? null,
        messageId: input.messageId ?? null,
        channelId: input.channelId ?? null,
        scope: input.scope,
        participants: input.participants,
      },
      dropped: true,
      reason: input.reason ?? null,
      now: now(),
      settings: settings(),
      id: freshId(store),
      by,
    });
    if (!created.ok) return created;
    const added = store.add(created.intention);
    if (added.ok)
      log.info('intentions: set', { guildId: store.guildId, id: added.intention.id, status: 'dropped', by });
    return added;
  }

  function freshId(store) {
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
   * `attend-with-due` / `attend-with-every`); `taskId` / `deadline` set it waiting (as in
   * `set`). `{ ok, intention }` or `{ ok: false, code }` (`not-found`, `terminal`, `cap-open`,
   * `bad-move`, the model's and the wait's codes). `patch.privateChannelId` / `patch.all`: where the
   * caller is (a private chat's intention is `not-found` anywhere else, see `list`).
   * `patch.initiative` (an inner turn's call), `patch.callerChain` (its chain) and `patch.turnId`
   * decide whether a candidate may be accepted (model.js#acceptRefusal: `candidate-same-turn`,
   * `candidate-external`, `candidate-same-chain`).
   */
  function update(guildId, id, patch = {}) {
    const store = storeOf(guildId);
    if (!store) return { ok: false, code: CODE.NO_GUILD };
    const current = store.get(id);
    if (!current || !visibleTo(current, patch)) return { ok: false, code: CODE.NOT_FOUND };
    if (!isOpen(current.status)) return { ok: false, code: CODE.TERMINAL };
    const by = patch.by ?? 'persona';
    const dropping = patch.state === 'dropped';
    if (dropping && !(typeof patch.reason === 'string' && patch.reason.trim()))
      return { ok: false, code: CODE.REASON_REQUIRED };
    // A candidate is accepted only where its origin allows (model.js#acceptRefusal): never in the
    // turn that wrote its line, and from an inner turn neither an external one nor one born in an
    // inner turn of the same chain.
    if (patch.state === 'pending' && current.status === 'proposed') {
      const refused = acceptRefusal(current, {
        by,
        initiative: patch.initiative === true,
        chainId: patch.callerChain ?? null,
        turnId: patch.turnId ?? null,
      });
      if (refused) {
        log.info('intentions: accept refused', { guildId: store.guildId, id: String(id), code: refused });
        return { ok: false, code: refused };
      }
    }
    if (patch.state === 'pending' && current.status === 'proposed' && activeCount(store.list()) >= settings().maxOpen)
      return { ok: false, code: CODE.CAP_OPEN };
    // A heartbeat's one-off made recurring counts against the recurring cap like a new recurring one.
    if (current.origin === HEARTBEAT_ORIGIN && patch.every && !current.every) {
      const others = openFromHeartbeat(store.list()).filter((record) => record.id !== current.id);
      if (others.filter((record) => record.every).length >= heartbeatLimits(hot.config).maxRecurring)
        return { ok: false, code: CODE.HEARTBEAT_RECURRING_CAP, open: others };
    }
    const plan =
      !dropping && (patch.taskId || Number.isFinite(patch.deadline))
        ? waitPlan(store.guildId, {
            taskId: patch.taskId ?? null,
            deadline: patch.deadline ?? null,
            turnId: patch.turnId ?? null,
          })
        : null;
    if (plan && !plan.ok) return plan;
    const at = now();
    const result = store.update(id, (record) => {
      let next = record;
      let changed = false;
      const fields = {};
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
        if (next.every && !Number.isFinite(next.dueAt)) return { ok: false, code: CODE.EVERY_WITHOUT_DUE };
        // A recurrence keeps the wall clock of its (new) first occurrence.
        if (next.every && (fields.every !== undefined || fields.dueAt !== undefined))
          next.every = pinEvery(
            { period: next.every.period, at: fields.every !== undefined ? (fields.every.at ?? null) : null },
            next.dueAt,
            timezone()
          );
        // (A recurring one's next occurrence may already lie past its expiry: the expiry wins; only a new due or expiry is checked.)
        if (
          (fields.dueAt !== undefined || fields.expiresAt !== undefined) &&
          Number.isFinite(next.dueAt) &&
          next.dueAt > next.expiresAt
        )
          return { ok: false, code: CODE.DUE_AFTER_EXPIRY };
        changed = true;
      }
      if (patch.state === 'pending' && next.status !== 'pending') {
        const accepted = next.status === 'proposed';
        // An accepted candidate lives as long as her own (`expiresDays`), not its review window.
        const expiry =
          accepted && fields.expiresAt === undefined
            ? { expiresAt: Math.max(next.expiresAt, at + settings().expiresDays * DAY_MS) }
            : {};
        const moved = transition(next, 'pending', {
          now: at,
          by,
          code: accepted ? 'accepted' : 'resumed',
          patch: expiry,
        });
        if (!moved.ok) return moved;
        next = moved.intention;
        changed = true;
      }
      if (plan) {
        const waited = applyWait(next, plan, by);
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
      log.info('intentions: updated', { guildId: store.guildId, id: String(id), status: result.intention.status, by });
    return result;
  }

  /**
   * Intention `id` cancelled (a candidate rejected): `{ ok, intention }` or `{ ok: false, code }`.
   * `privateChannelId` / `all`: where the caller is, as in `update`.
   */
  function cancel(guildId, id, { by = 'persona', privateChannelId = null, all = false } = {}) {
    const store = storeOf(guildId);
    if (!store) return { ok: false, code: CODE.NO_GUILD };
    const current = store.get(id);
    if (current && !visibleTo(current, { privateChannelId, all })) return { ok: false, code: CODE.NOT_FOUND };
    const result = store.update(id, (record) =>
      transition(record, 'cancelled', { now: now(), by, code: record.status === 'proposed' ? 'rejected' : 'cancelled' })
    );
    if (result.ok) log.info('intentions: cancelled', { guildId: store.guildId, id: String(id), by });
    return result;
  }

  /** Every open intention past its `expiresAt` expired and written. How many. */
  function sweepExpired(store) {
    let count = 0;
    const at = now();
    for (const record of store.list()) {
      if (!isOpen(record.status) || !(at >= record.expiresAt)) continue;
      const result = store.update(record.id, (current) => expireAt(current, at));
      if (result.ok && result.changed) count += 1;
    }
    if (count > 0) log.info('intentions: expired', { guildId: store.guildId, count });
    return count;
  }

  /**
   * The guild's intentions, the expired ones swept first: open ones only unless `closed`, each
   * visible to the conversation (`privateChannelId`: a private chat's own only there), or every
   * one with `all` (an owner's list).
   */
  function list(guildId, { closed = false, privateChannelId = null, all = false } = {}) {
    const store = storeOf(guildId);
    if (!store) return [];
    sweepExpired(store);
    return store
      .list()
      .filter((record) => (closed || isOpen(record.status)) && visibleTo(record, { privateChannelId, all }));
  }

  /**
   * What the `<intentions>` block shows in a conversation: her active ones (`pending`, then
   * `waiting`, by due time then age), then the candidates (`proposed`), newest first. Empty with
   * `features.intentions` off.
   */
  function view(guildId, { privateChannelId = null } = {}) {
    if (!intentionsOn(hot.config)) return [];
    const open = list(guildId, { privateChannelId });
    const byDue = (a, b) => (a.dueAt ?? Infinity) - (b.dueAt ?? Infinity) || a.createdAt - b.createdAt;
    const active = open.filter((record) => record.status === 'pending').sort(byDue);
    const waiting = open.filter((record) => record.status === 'waiting').sort(byDue);
    const proposed = open.filter((record) => record.status === 'proposed').sort((a, b) => b.createdAt - a.createdAt);
    return [...active, ...waiting, ...proposed];
  }

  /**
   * Errand `taskId`, just queued by turn `turnId`, linked to every `pending` intention of that turn
   * whose wait was asked before the errand existed (`waitRequested`). How many.
   */
  function linkTurnTask(guildId, { turnId, taskId }) {
    const store = storeOf(guildId);
    if (!store || !turnId || !taskId) return 0;
    let linked = 0;
    for (const record of store.list()) {
      if (record.status !== 'pending' || record.waitRequested?.turnId !== String(turnId)) continue;
      const deadline = record.waitRequested.deadline;
      const result = store.update(record.id, (current) =>
        waitOn(current, {
          taskId,
          deadline: Number.isFinite(deadline) && deadline > now() ? deadline : now() + settings().waitHours * HOUR_MS,
          now: now(),
          by: 'engine',
        })
      );
      if (result.ok && result.changed) linked += 1;
    }
    if (linked > 0) log.info('intentions: linked', { guildId: store.guildId, taskId: String(taskId), count: linked });
    return linked;
  }

  /**
   * An errand's end (src/errands/service.js's `onFinished`): every intention waiting on it moves
   * to `pending` with its outcome. Idempotent: the same end twice moves nothing the second time.
   * Never throws; how many moved.
   */
  function onTaskFinished(task, guildId) {
    try {
      const store = storeOf(guildId);
      if (!store || !task?.id) return 0;
      let moved = 0;
      for (const record of store.list()) {
        if (record.status !== 'waiting' || record.awaitingErrandId !== String(task.id)) continue;
        const result = store.update(record.id, (current) => arrive(current, task, { now: now() }));
        if (result.ok && result.changed) moved += 1;
        if (result.ok && result.changed) afterWait(store, result.intention);
      }
      if (moved > 0)
        log.info('intentions: errand arrived', {
          guildId: store.guildId,
          taskId: String(task.id),
          state: task.state,
          count: moved,
        });
      return moved;
    } catch (err) {
      log.warn('intentions: errand end not applied', { taskId: task?.id ?? null, error: err });
      return 0;
    }
  }

  /**
   * The reconciliation (at start, and the scheduler's tick of step 2): every `waiting` intention
   * whose errand already ended (`arrived`), is gone from the task store (`missing`), or passed its
   * wait deadline (`deadline`) moved to `pending` with a note; then every open one past its expiry
   * expired. Counts; never throws.
   */
  function reconcile(guildId) {
    const counts = { arrived: 0, missing: 0, deadline: 0, expired: 0 };
    try {
      const store = storeOf(guildId);
      if (!store) return counts;
      for (const record of store.list()) {
        if (record.status !== 'waiting') continue;
        const result = store.update(record.id, (current) =>
          reconcileWait(current, { taskOf: (id) => taskOf(store.guildId, id), now: now() })
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
      if (counts.arrived + counts.missing + counts.deadline > 0)
        log.info('intentions: reconciled', { guildId: store.guildId, ...counts });
    } catch (err) {
      log.warn('intentions: reconcile failed', { error: err });
    }
    return counts;
  }

  /**
   * Recurring intention `id` advanced past its current occurrence (src/intentions/model.js#advanceOccurrence)
   * when that occurrence is due or past (`dueAt <= now`) and the record is `pending`: the scheduler calls
   * it when the occurrence's wake is disposed of (her turn ended, or the wake was dropped). `named`: a
   * call of hers in that turn named it (code `recurred`), else `missed`. A one-off, a waiting one (its
   * occurrence runs on until the wait ends), an occurrence already advanced (her `state=done`, a new
   * due she set) and a closed record change nothing. Never throws; `{ ok, intention, changed }`.
   */
  function advance(guildId, id, { named = false, by = 'engine' } = {}) {
    try {
      const store = storeOf(guildId);
      const current = store?.get(id) ?? null;
      const at = now();
      if (!current?.every || current.status !== 'pending' || !(wakeTimeOf(current, dueJitterMinutes(hot.config)) <= at))
        return { ok: true, intention: current, changed: false };
      const code = named ? 'recurred' : 'missed';
      const result = store.update(id, (record) =>
        advanceOccurrence(record, { now: at, timezone: timezone(), code, by })
      );
      if (result.ok && result.changed)
        log.info('intentions: recurred', {
          guildId: store.guildId,
          id: String(id),
          code,
          dueAt: result.intention.dueAt,
        });
      return result;
    } catch (err) {
      log.warn('intentions: advance failed', { id: String(id ?? ''), error: err });
      return { ok: false, code: CODE.WRITE_FAILED };
    }
  }

  /** A wait of recurring `record` just ended with its errand: the occurrence closes, the outcome kept. */
  function afterWait(store, record) {
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
        guildId: store.guildId,
        id: String(record.id),
        code: CODE.RECURRED,
        dueAt: result.intention.dueAt,
      });
  }

  /**
   * Expired intention `id` marked as shown to her (`expiredShownAt`, src/intentions/model.js#markExpiredShown):
   * the scheduler calls it once the review turn that listed it ran. An unexpired, unknown or already
   * marked record changes nothing. `{ ok, intention, changed }` or `{ ok: false, code }`.
   */
  function markExpiredShown(guildId, id) {
    const store = storeOf(guildId);
    if (!store) return { ok: false, code: CODE.NO_GUILD };
    const result = store.update(id, (current) => markShown(current, now()));
    if (result.ok && result.changed) log.info('intentions: expired shown', { guildId: store.guildId, id: String(id) });
    return result;
  }

  /** The guild's open attentions (`pending` records with an `attend` place), the expired swept first. */
  function attending(guildId) {
    return list(guildId, { all: true }).filter((record) => record.status === 'pending' && isAttend(record));
  }

  /** The day's wake counter of attention `id` (model.js#attendCounter, today in `bot.timezone`), or null. */
  function attendToday(guildId, id) {
    const record = storeOf(guildId)?.get(id) ?? null;
    return isAttend(record) ? attendCounter(record, zonedDay(now(), timezone())) : null;
  }

  /**
   * One attend wake of attention `id` counted on today's counter (the scheduler, after the
   * wake's turn): `{ ok, intention, changed }` (`not-attend`, `not-found`, `write-failed`). Never throws.
   */
  function countAttendWake(guildId, id) {
    try {
      const store = storeOf(guildId);
      if (!store) return { ok: false, code: CODE.NO_GUILD };
      const result = store.update(id, (record) => bumpAttend(record, zonedDay(now(), timezone())));
      if (result.ok && result.changed)
        log.info('intentions: attend wake counted', {
          guildId: store.guildId,
          id: String(id),
          wakes: result.intention.attend.today.wakes,
        });
      return result;
    } catch (err) {
      log.warn('intentions: attend count failed', { id: String(id ?? ''), error: err });
      return { ok: false, code: CODE.WRITE_FAILED };
    }
  }

  /** What is due now (src/intentions/model.js#dueList) for the guild, its expired swept first. */
  function due(guildId) {
    const store = storeOf(guildId);
    if (!store) return [];
    sweepExpired(store);
    return dueOf(store.list(), now(), dueJitterMinutes(hot.config));
  }

  /**
   * The candidates one analyzer batch found in her own lines (`raw`: the answer's `intentions`
   * field; `messages`: the batch's lines the model saw) stored as `proposed` intentions: anchored
   * and filtered by the model (candidatesFromAnswer), each not repeating an open one, while the
   * open candidates stay under `intentions.maxCandidates`; each one's turn looked up in the journal
   * (`findTurn` of the line's message, null when unknown). With `features.intentions` off, nothing.
   * Each carries its origin (model.js#candidatesFromAnswer over the line's note: the buffered
   * line's `sources`, else `lineSources`; strict). Never throws; `{ added, external, duplicate, capped, dropped }`.
   */
  async function addCandidates(guildId, raw, messages) {
    const out = {
      added: 0,
      external: 0,
      duplicate: 0,
      capped: 0,
      dropped: { invalid: 0, unanchored: 0, quoted: 0, over: 0 },
    };
    try {
      if (!intentionsOn(hot.config) || !Array.isArray(raw) || raw.length === 0) return out;
      const store = storeOf(guildId);
      if (!store) return out;
      const limits = settings();
      const { candidates, dropped } = candidatesFromAnswer(raw, messages, {
        max: limits.maxCandidates,
        sourcesOf: (line) => line?.sources ?? lineSources?.get?.(String(line?.id ?? '')) ?? null,
        strict: Boolean(lineSources),
      });
      out.dropped = dropped;
      for (const candidate of candidates) {
        const open = store.list().filter((record) => isOpen(record.status));
        if (duplicates(candidate, open)) {
          out.duplicate += 1;
          continue;
        }
        if (open.filter((record) => record.status === 'proposed').length >= limits.maxCandidates) {
          out.capped += 1;
          continue;
        }
        let turnId = candidate.turnId ?? null;
        if (
          !turnId &&
          typeof journal?.findTurn === 'function' &&
          hot.config?.features?.journal === true &&
          Number.isFinite(candidate.ts)
        ) {
          try {
            turnId =
              (await journal.findTurn(store.guildId, { messageId: candidate.messageId, at: candidate.ts }))?.turn
                ?.turnId ?? null;
          } catch {
            turnId = null;
          }
        }
        const created = createIntention({
          purpose: candidate.purpose,
          provenance: {
            kind: 'candidate',
            turnId,
            messageId: candidate.messageId,
            channelId: candidate.channelId,
            span: candidate.span,
            scope: 'group',
            participants: candidate.participants,
            origin: candidate.origin,
            originReason: candidate.originReason,
            bornInner: candidate.bornInner === true,
            innerChainId: candidate.innerChainId ?? null,
          },
          now: now(),
          settings: limits,
          id: freshId(store),
          by: 'analyzer',
        });
        if (!created.ok) continue;
        if (store.add(created.intention).ok) {
          out.added += 1;
          if (created.intention.provenance.origin === 'external') out.external += 1;
        }
      }
      const skipped = out.duplicate + out.capped + Object.values(out.dropped).reduce((sum, n) => sum + n, 0);
      if (out.added + skipped > 0)
        log.info('intentions: candidates', {
          guildId: store.guildId,
          added: out.added,
          external: out.external,
          duplicate: out.duplicate,
          capped: out.capped,
          ...out.dropped,
        });
    } catch (err) {
      log.warn('intentions: candidates not stored', { error: err });
    }
    return out;
  }

  /** Note where her posted line `messageId` came from (src/intentions/sources.js#lineSourcesOf's note). */
  function noteLine(messageId, sources) {
    lineSources?.note?.(String(messageId ?? ''), sources);
  }

  /** The note of her line `messageId`, or null. */
  function lineSourcesOfLine(messageId) {
    return lineSources?.get?.(String(messageId ?? '')) ?? null;
  }

  return {
    set,
    update,
    cancel,
    list,
    view,
    noteLine,
    lineSources: lineSourcesOfLine,
    linkTurnTask,
    onTaskFinished,
    reconcile,
    advance,
    due,
    attending,
    attendToday,
    countAttendWake,
    markExpiredShown,
    addCandidates,
    store: storeOf,
  };
}
