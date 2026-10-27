// The owner's view and switch of the inner life: `status` for `/nep task inner` and the status tool, and the kill
// switch `stop` and `start`, persisted with the state. Called through src/behavior/inner.ts.

import { intentionsOn, isAttend, wakeTimeOf } from '../../intentions/model.ts';
import type { Intention } from '../../intentions/types.ts';
import { CODE } from '../../tools/codes.ts';
import { errorCode, isFiniteNumber, listOf, objOf } from '../../tools/types.ts';
import { dayBounds, turnsToday } from './drain.ts';
import { asText } from './facts.ts';
import { ATTEND_PREFIX } from './places.ts';
import { markHandled, note, save, stateOf, timezoneOf, wakeOfDue } from './queue.ts';
import { innerOn, innerSettings } from './settings.ts';
import type { InnerContext, InnerSettings, InnerState, TurnRecord } from './types.ts';

/** The outcomes of runTurn that mean a turn ran for the wake (src/behavior/turn.js#TurnOutcome less the held ones). */
const TURN_OUTCOMES: ReadonlySet<unknown> = new Set(['spoke', 'skip', 'refused', 'not-now', 'error']);

/** The statuses an open intention may have, for the status card. */
const OPEN_STATES: ReadonlyArray<unknown> = ['pending', 'waiting', 'proposed'];

/** What the kill switch answers: done (and whether it was so already, and how many queued wakes it dropped), or why not. */
export type SwitchAnswer =
  | { ok: true; already: boolean; dropped?: number; code?: undefined }
  | { ok: false; code: string; already?: undefined; dropped?: undefined };

/** Who threw the switch. */
export type SwitchOptions = { by?: unknown };

/** The kill switch: stopped (persisted), the queue dropped (journalled). */
export function stop(
  life: InnerContext,
  guildId: string | null = life.getGuildId(),
  { by = null }: SwitchOptions = {}
): SwitchAnswer {
  const { now, log, running } = life;
  if (!guildId) return { ok: false, code: CODE.NO_GUILD };
  const state = stateOf(life, guildId);
  const at = now();
  const queued = state.queue.filter((wake) => !running.has(wake.id));
  const dropped = queued.length;
  markHandled(life, state, queued, 'stopped', at, { guildId });
  const already = state.stopped;
  state.stopped = true;
  state.stoppedAt = already ? state.stoppedAt : at;
  state.stoppedBy = by ? asText(by) : state.stoppedBy;
  save(life, guildId);
  log.info('inner: stopped', { guildId, dropped, already });
  note(life, guildId, { event: 'stopped', dropped, by: by ? asText(by) : null });
  return { ok: true, already, dropped };
}

/** The kill switch released (persisted). */
export function start(
  life: InnerContext,
  guildId: string | null = life.getGuildId(),
  { by = null }: SwitchOptions = {}
): SwitchAnswer {
  const { log } = life;
  if (!guildId) return { ok: false, code: CODE.NO_GUILD };
  const state = stateOf(life, guildId);
  const already = !state.stopped;
  state.stopped = false;
  state.stoppedAt = null;
  state.stoppedBy = null;
  save(life, guildId);
  log.info('inner: started', { guildId, already });
  note(life, guildId, { event: 'started', by: by ? asText(by) : null });
  return { ok: true, already };
}

/** The next thing that will wake her: when, and whether it is a queued wake, an intention or the review. */
export type NextWake = { at: number; kind: 'queue' | 'intention' | 'review' };

/** The earliest moment something will wake her (null when nothing is known), and what: `queue`, `intention` or `review`. */
function nextWakeOf(
  state: InnerState,
  open: ReadonlyArray<Intention>,
  at: number,
  settings: InnerSettings
): NextWake | null {
  const found: Array<NextWake> = [];
  for (const wake of state.queue) {
    const when = wake.notBefore ?? wake.dueAt;
    if (Number.isFinite(when)) found.push({ at: when, kind: 'queue' });
  }
  // A time already past that she handled counts no more; one not yet handled wakes her at the next tick.
  const upcoming = (record: Intention, reason: string, when: number | null, wakeAt: number | null = when) =>
    isFiniteNumber(when) &&
    (Number(wakeAt) > at || !state.handled[wakeOfDue({ intention: record, reason, at: when }).id]);
  for (const record of open) {
    if (record.status !== 'pending' && record.status !== 'waiting') continue;
    const wakeAt = wakeTimeOf(record, settings.heartbeat.dueJitterMinutes);
    if (upcoming(record, 'due', record.dueAt, wakeAt)) found.push({ at: wakeAt, kind: 'intention' });
    if (
      record.status === 'waiting' &&
      isFiniteNumber(record.waitDeadline) &&
      upcoming(record, 'wait-deadline', record.waitDeadline)
    )
      found.push({ at: record.waitDeadline, kind: 'intention' });
  }
  const review = state.review;
  if (review && review.done !== true && isFiniteNumber(review.at)) found.push({ at: review.at, kind: 'review' });
  return found.length > 0 ? found.reduce((first, item) => (item.at < first.at ? item : first)) : null;
}

/** What the owner's status of the inner life shows (`/nep task inner`, the status tool). */
export type InnerStatus = {
  on: boolean;
  mode: InnerSettings['mode'];
  stopped: boolean;
  stoppedAt?: number | null;
  queue: Array<{ id: string; kind: string; dueAt: number | null; capped: string | null }>;
  review: { day: string; at: number | null; done: boolean } | null;
  heartbeat?: { nextAt: number | null; lastAt: number | null } | null;
  turnsToday: number | null;
  chains: number;
  spentUsd: number;
  intentions: { pending: number; waiting: number; proposed: number } | null;
  attention: { open: number; listed: number; run: number; spoken: number; skipped: number; waiting: number } | null;
  next: NextWake | null;
  lastTurn: { at: number; outcome: string | null } | null;
  lastError: { at: number; code: string } | null;
};

/**
 * What the owner's status shows: the switch, the mode, the stop, the queue, the review, the budgets,
 * and for the status card the chains of the day, the open intentions by
 * status, the next wake and the last inner turn.
 */
export function status(life: InnerContext, guildId: string | null = life.getGuildId()): InnerStatus {
  const { hot, intentions, now, log } = life;
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
  const state = stateOf(life, guildId);
  const at = now();
  const timezone = timezoneOf(life);
  const { start } = dayBounds(at, timezone);
  let open: Array<Intention> = [];
  if (intentions && intentionsOn(hot.config)) {
    try {
      const listed = listOf(intentions.list?.(guildId, { all: true }) ?? []);
      // The service's records; a test's narrower fake answers the fields read here.
      open = listed.filter((record) => OPEN_STATES.includes(objOf(record).status)) as Array<Intention>;
    } catch (err) {
      log.warn('inner: status intentions failed', { guildId, code: errorCode(err) });
    }
  }
  const countOf = (name: string) => open.filter((record) => record.status === name).length;
  const last = state.turns.reduce<TurnRecord | null>(
    (latest, turn) => (!latest || turn.at >= latest.at ? turn : latest),
    null
  );
  const lastFailed = state.turns.reduce<TurnRecord | null>(
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
