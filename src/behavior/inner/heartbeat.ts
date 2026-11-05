// The heartbeat's timer (docs/inner-life.md "The heartbeat"): `heartbeat.schedule` kept in the state
// (`heartbeat: { nextAt, lastAt }`), an interval moved by a jitter either way and a daily time exact, the wake it gives, the facts
// its `<wake>` carries (src/behavior/heartbeat-view.ts over the stores this life was given) and the log line of its
// outcome. The tick (src/behavior/inner.ts) and the drain (src/behavior/inner/drain.ts) call it.

import { personOfMember } from '../../memory/addresses.ts';
import { wakeRetrieval } from './facts.ts';
import { evaluateSchedule } from '../../service/schedule.ts';
import type { ServiceSchedule } from '../../service/schedule.ts';
import { DAY_MS, MINUTE_MS } from '../../time.ts';
import { openFromHeartbeat } from '../../intentions/model.ts';
import { errorCode, isFiniteNumber } from '../../tools/types.ts';
import { buildHeartbeatFacts } from '../heartbeat-view.ts';
import type { HeartbeatFacts } from '../heartbeat-view.ts';
import { activePlacesOf, placeNameOf, placesInWakeOf } from './places.ts';
import { note, save, stateOf } from './queue.ts';
import type { InnerContext, InnerSettings, TurnAction, Wake } from './types.ts';

/** The heartbeat wake due at `at` (its own chain, no place). */
export function heartbeatWake(at: number): Wake {
  return {
    id: `inner.wake:heartbeat:${at}`,
    kind: 'heartbeat',
    reason: 'heartbeat',
    intentionIds: [],
    chainId: `heartbeat:${at}`,
    dueAt: at,
    placeId: null,
    privateChat: false,
  };
}

/**
 * The moment of the next heartbeat after `from`: `everyMinutes` plus a jitter drawn evenly in
 * +-`jitterMinutes`, never less than a minute after `from`. `rng` in [0, 1).
 */
export function drawHeartbeatAt({
  from,
  everyMinutes,
  jitterMinutes = 0,
  rng,
}: {
  from: number;
  everyMinutes: number;
  jitterMinutes?: number;
  rng: () => number;
}): number {
  const jitter = (rng() * 2 - 1) * jitterMinutes;
  return Math.round(from + Math.max(1, everyMinutes + jitter) * MINUTE_MS);
}

/**
 * Whether a moment still ahead belongs to `schedule`. The owner may have changed the schedule since it was drawn: a daily
 * moment must be one of the daily times, and an interval's moment lies within one interval and its jitter of `now`.
 */
function isOfSchedule(schedule: ServiceSchedule, jitterMinutes: number, moment: number, now: number): boolean {
  if (schedule.kind === 'at') return schedule.at.includes(new Date(moment).toISOString().slice(11, 16));
  return moment - now <= (schedule.everyMinutes + jitterMinutes) * MINUTE_MS;
}

/**
 * The heartbeat's timer (state.heartbeat = { nextAt, lastAt }, persisted): drawn at start when missing; once its
 * wake is handled (a turn ran for it, or it was dropped) the next moment is drawn from then, from the interval with the
 * jitter or as the next daily time exactly. A moment ahead that a changed schedule no longer holds is drawn again. The
 * wake when its moment came and it is not handled yet. Null with the heartbeat off.
 */
export function heartbeatDue(life: InnerContext, settings: InnerSettings, at: number): Wake | null {
  const { rng, log } = life;
  if (!settings.heartbeat.enabled) return null;
  const state = stateOf(life);
  const { schedule, jitterMinutes } = settings.heartbeat;
  const draw = (from: number): number =>
    schedule.kind === 'every'
      ? drawHeartbeatAt({ from, everyMinutes: schedule.everyMinutes, jitterMinutes, rng })
      : (evaluateSchedule({ schedule, enabled: true, now: from, last: null }).next ?? from + DAY_MS);
  if (!state.heartbeat || !isFiniteNumber(state.heartbeat.nextAt)) {
    state.heartbeat = { nextAt: draw(at), lastAt: state.heartbeat?.lastAt ?? null };
    save(life);
    log.info('inner: heartbeat drawn', { at: state.heartbeat.nextAt });
    note(life, { event: 'heartbeat-drawn', at: state.heartbeat.nextAt });
    return null;
  }
  const wake = heartbeatWake(state.heartbeat.nextAt);
  if (state.heartbeat.nextAt > at) {
    if (isOfSchedule(schedule, jitterMinutes, state.heartbeat.nextAt, at)) return null;
    state.heartbeat = { ...state.heartbeat, nextAt: draw(at) };
    save(life);
    log.info('inner: heartbeat drawn', { at: state.heartbeat.nextAt });
    note(life, { event: 'heartbeat-drawn', at: state.heartbeat.nextAt });
    return null;
  }
  const handled = state.handled[wake.id];
  if (handled) {
    const ran = isFiniteNumber(handled.at) ? handled.at : at;
    state.heartbeat = { nextAt: draw(Math.max(at, ran)), lastAt: ran };
    save(life);
    log.info('inner: heartbeat drawn', { at: state.heartbeat.nextAt });
    note(life, { event: 'heartbeat-drawn', at: state.heartbeat.nextAt });
    return null;
  }
  return wake;
}

/**
 * The heartbeat turn's outcome, logged (ids and codes, never text): what it did (`change`: the intention call that
 * went through, `skip`: none did), the intention's id, how many of the open intentions are from heartbeats
 * (the cap's occupancy) and the refusals it met. Never throws.
 */
export function logHeartbeatOutcome(
  life: InnerContext,
  { outcome, actions }: { outcome: unknown; actions: ReadonlyArray<TurnAction> }
): void {
  const { intentions, log } = life;
  try {
    const calls = actions.filter((a) => typeof a.skill === 'string' && a.skill.startsWith('intention.'));
    const changed = calls.find((action) => action.status === 'executed' && action.result === 'ok') ?? null;
    const refused = actions
      .filter((action) => action.status === 'refused' || (action.status === 'executed' && action.result !== 'ok'))
      .map((action) => `${String(action.skill)}:${String(action.code ?? action.result)}`);
    const open =
      intentions && typeof intentions.list === 'function'
        ? openFromHeartbeat(intentions.list({ all: true })).length
        : null;
    log.info('inner: heartbeat outcome', {
      turn: outcome,
      result: changed ? 'change' : 'skip',
      ...(changed ? { skill: changed.skill, intentionId: changed.createdId ?? changed.intentionId ?? null } : {}),
      openFromHeartbeat: open,
      refused,
    });
  } catch (err) {
    log.warn('inner: heartbeat outcome not logged', { code: errorCode(err) });
  }
}

/** The heartbeat's facts for `<wake>` (src/behavior/heartbeat-view.ts), from the stores this life was given. Never throws. */
export async function heartbeatFacts(
  life: InnerContext,
  settings: InnerSettings,
  at: number
): Promise<HeartbeatFacts | null> {
  const { intentions, record, nameOf, journal, store, heartbeatSources, log } = life;
  const state = stateOf(life);
  const guarded = (fn: () => unknown, fallback: unknown): unknown => {
    try {
      return fn() ?? fallback;
    } catch (err) {
      log.warn('inner: heartbeat source failed', { code: errorCode(err) });
      return fallback;
    }
  };
  try {
    return await buildHeartbeatFacts({
      now: at,
      since: state.heartbeat?.lastAt ?? null,
      settings: settings.heartbeat,
      profiles: guarded(() => store?.listUserProfiles?.(), []),
      selfId: guarded(() => heartbeatSources.selfId?.(), null),
      record,
      journal,
      intentions: guarded(() => intentions?.list?.({ all: true, closed: true }), []),
      tasks: guarded(() => heartbeatSources.tasks?.(), []),
      selfreflection: guarded(() => store?.getSelfreflection?.()?.posts, []),
      places: placesInWakeOf(life, settings),
      skills: guarded(() => heartbeatSources.skills?.(), []),
      agents: guarded(() => heartbeatSources.agents?.(), []),
      innerState: state,
      nameOf: (id: string) => (typeof nameOf === 'function' ? nameOf(id) : null),
      placeName: (id: string) => placeNameOf(life, id),
      activePlaces: (accountId: string) => activePlacesOf(life, accountId),
      focusPeople: focusOf(heartbeatSources),
      log,
      ...wakeRetrieval(life, 'heartbeat'),
      personOf: (id: string) => guarded(() => personOfMember(store, id), null) as string | null,
    });
  } catch (err) {
    log.warn('inner: heartbeat view failed', { code: errorCode(err) });
    return null;
  }
}

/** Her focus set's reader for `placeId`, or null without one. */
function focusOf(sources: InnerContext['heartbeatSources']): (() => unknown) | null {
  return typeof sources.focusPeople === 'function' ? () => sources.focusPeople?.() : null;
}
