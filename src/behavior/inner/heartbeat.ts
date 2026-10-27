// The heartbeat's schedule (docs/inner-life.md "The heartbeat"): its own timer, `innerLife.heartbeat.everyMinutes`
// moved by a jitter either way and kept in the state (`heartbeat: { nextAt, lastAt }`), the wake it gives, the facts
// its `<wake>` carries (src/behavior/heartbeat-view.ts over the stores this life was given) and the log line of its
// outcome. The tick (src/behavior/inner.ts) and the drain (src/behavior/inner/drain.ts) call it.

import { MINUTE_MS } from '../../time.js';
import { intentionsOn, openFromHeartbeat } from '../../intentions/model.ts';
import { buildHeartbeatFacts } from '../heartbeat-view.ts';
import { activePlacesOf, placeNameOf, placesInWakeOf } from './places.ts';
import { note, save, stateOf } from './queue.ts';

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

/**
 * The heartbeat's timer (state.heartbeat = { nextAt, lastAt }, persisted): drawn at start when missing; once its
 * wake is handled (a turn ran for it, or it was dropped) the next moment is drawn from then, with the jitter. The
 * wake when its moment came and it is not handled yet. Null with the heartbeat off.
 */
export function heartbeatDue(life, guildId, settings, at) {
  const { rng, log } = life;
  if (!settings.heartbeat.enabled) return null;
  const state = stateOf(life, guildId);
  const draw = (from) =>
    drawHeartbeatAt({
      from,
      everyMinutes: settings.heartbeat.everyMinutes,
      jitterMinutes: settings.heartbeat.jitterMinutes,
      rng,
    });
  if (!state.heartbeat || !Number.isFinite(state.heartbeat.nextAt)) {
    state.heartbeat = { nextAt: draw(at), lastAt: state.heartbeat?.lastAt ?? null };
    save(life, guildId);
    log.info('inner: heartbeat drawn', { guildId, at: state.heartbeat.nextAt });
    note(life, guildId, { event: 'heartbeat-drawn', at: state.heartbeat.nextAt });
    return null;
  }
  const wake = heartbeatWake(state.heartbeat.nextAt);
  if (state.heartbeat.nextAt > at) return null;
  const handled = state.handled[wake.id];
  if (handled) {
    const ran = Number.isFinite(handled.at) ? handled.at : at;
    state.heartbeat = { nextAt: draw(Math.max(at, ran)), lastAt: ran };
    save(life, guildId);
    log.info('inner: heartbeat drawn', { guildId, at: state.heartbeat.nextAt });
    note(life, guildId, { event: 'heartbeat-drawn', at: state.heartbeat.nextAt });
    return null;
  }
  return wake;
}

/**
 * The heartbeat turn's outcome, logged (ids and codes, never text): what it did (`change`: the intention call that
 * went through, `skip`: none did), the intention's id, how many of the open intentions are from heartbeats
 * (the cap's occupancy) and the refusals it met. Never throws.
 */
export function logHeartbeatOutcome(life, guildId, { outcome, actions }) {
  const { intentions, log } = life;
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

/** The heartbeat's facts for `<wake>` (src/behavior/heartbeat-view.ts), from the stores this life was given. Never throws. */
export async function heartbeatFacts(life, guildId, settings, at) {
  const { hot, intentions, record, nameOf, journal, store, heartbeatSources, log } = life;
  const state = stateOf(life, guildId);
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
      places: placesInWakeOf(life, guildId, settings),
      skills: guarded(() => heartbeatSources.skills?.(), []),
      agents: guarded(() => heartbeatSources.agents?.(), []),
      innerState: state,
      nameOf: (id) => (typeof nameOf === 'function' ? nameOf(String(guildId), id) : null),
      placeName: (id) => placeNameOf(life, guildId, id),
      activePlaces: (memberId) => activePlacesOf(life, guildId, memberId),
      focusPeople:
        typeof heartbeatSources.focusPeople === 'function' ? () => heartbeatSources.focusPeople(guildId) : null,
      log,
    });
  } catch (err) {
    log.warn('inner: heartbeat view failed', { guildId, code: err?.code ?? null });
    return null;
  }
}
