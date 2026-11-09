// The settings of the persona's inner life: the wake kinds, the defaults of the `wakes` section and
// `innerSettings`, which checks every number of that section against them. The scheduler's modules
// (src/behavior/inner/) and the turn runner (src/behavior/turn.ts) read them. Nothing here keeps state.

import { parseSchedule } from '../../service/schedule.ts';
import type { ServiceSchedule } from '../../service/schedule.ts';
import { isClockTime } from '../../time.ts';
import { toolsWith } from '../../tools/definitions.ts';
import { isPositive, objOf } from '../../tools/types.ts';
import type { InnerSettings } from './types.ts';

/** The wake kinds. */
export const WAKE_KINDS = Object.freeze([
  'intention_due',
  'errand_deadline',
  'attend',
  'feedback',
  'heartbeat',
  'selfimprovement',
] as const);

/**
 * The selfimprovement wake's defaults: once a day at 03:00 (UTC, owner 2026-11-02), and when one chain shape fails this many times in a UTC day (decision of 2026-10-24).
 */
const IMPROVEMENT_WAKE_DEFAULTS = Object.freeze({
  schedule: Object.freeze({ kind: 'at', at: Object.freeze(['03:00']) }),
  failuresPerShape: 3,
});

/**
 * The inner life's measures: production values of the config cut of 2026-10-31, and the fallbacks of the keys the
 * live config holds (`mode`, `tickSeconds`, `caps.perChain`, `loop`, `retry` and `factsKeepDays` of `wakes`; the
 * heartbeat's switch and clock of `heartbeat`; the selfimprovement wake's switch and clock of `selfimprovement`).
 */
export const INNER_DEFAULTS = Object.freeze({
  mode: 'shadow',
  tickSeconds: 60,
  queueMax: 20,
  chatMessages: 30,
  heartbeat: Object.freeze({
    enabled: true,
    schedule: Object.freeze({ kind: 'every', everyMinutes: 180 }),
    jitterMinutes: 60,
    maxOpen: 3,
    maxRecurring: 1,
    dueJitterMinutes: 20,
  }),
  caps: Object.freeze({ perChain: 3 }),
  selfimprovement: Object.freeze({ enabled: true }),
  wakes: Object.freeze({ selfimprovement: IMPROVEMENT_WAKE_DEFAULTS }),
  attention: Object.freeze({ settleSeconds: 90, perDayDefault: 12, pageSize: 12, placesInWake: 8, lookbackHours: 24 }),
  loop: Object.freeze({ maxSteps: 4, timeBudgetMs: 180000, maxCallsPerStep: 4, callTimeoutMs: 60000 }),
  retry: Object.freeze({ delaysMinutes: Object.freeze([1, 5, 15, 60]), maxHours: 6 }),
  factsKeepDays: 7,
});

/** The skills that post where people read: the trait `posts` of their definitions. */
export const POSTING_SKILLS = toolsWith('posts');
/** The calls that deliver something out of an inner turn: the posting skills and an errand. */
export const DELIVERY_SKILLS = Object.freeze([...POSTING_SKILLS, 'errand.run']);
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
  'pendingQuarantined',
  'proxySwitched',
  'interrupted',
  'diagnostic',
]);

/** The most facts one turn is shown; the rest stay for the next one. */
export const FACTS_SHOWN_MAX = 12;

const count = (value: unknown, fallback: number): number =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : fallback;
/** A whole number of at least `min`, else `fallback`. */
const whole = (value: unknown, fallback: number, min = 1): number =>
  typeof value === 'number' && Number.isInteger(value) && value >= min ? value : fallback;
/** A positive finite number, else `fallback`. */
const positive = (value: unknown, fallback: number): number => (isPositive(value) ? value : fallback);
/** Whether `value` is a list of positive numbers with at least one in it. */
const isDelayList = (value: unknown): value is Array<number> =>
  Array.isArray(value) && value.length > 0 && value.every((m) => positive(m, 0) > 0);

/** `heartbeat.schedule`, or the old `heartbeat.everyMinutes` of a config that did not pass the loader's moves. */
function heartbeatSchedule(heartbeat: Record<string, unknown>): ServiceSchedule {
  const everyMinutes = count(heartbeat.everyMinutes, 0);
  return (
    parseSchedule(heartbeat.schedule) ??
    (everyMinutes > 0 ? { kind: 'every', everyMinutes } : INNER_DEFAULTS.heartbeat.schedule)
  );
}

/** `selfimprovement.schedule`, or the old `selfimprovement.at` of a config that did not pass the loader's moves. */
function improvementSchedule(improvement: Record<string, unknown>): ServiceSchedule {
  return (
    parseSchedule(improvement.schedule) ??
    (isClockTime(improvement.at) ? { kind: 'at', at: [improvement.at] } : IMPROVEMENT_WAKE_DEFAULTS.schedule)
  );
}

/**
 * The inner life's settings: INNER_DEFAULTS, with the keys the live config holds each checked against its default
 * (a missing or bad value takes the default). The heartbeat's keys are read from the `heartbeat` section and the
 * selfimprovement wake's from `selfimprovement`. `mode` is `live` only when it says so exactly. `loop`: the tool loop's
 * bounds of an inner turn (src/behavior/turn.ts#loopSettings with `inner`; nobody waits for
 * one, so its budget is generous): `maxSteps`, `timeBudgetMs`, `maxCallsPerStep` as
 * `tools.loop`'s, `callTimeoutMs` the most one call of hers may run.
 */
export function innerSettings(config: unknown): InnerSettings {
  const raw = objOf(objOf(config).wakes);
  const caps = objOf(raw.caps);
  const heartbeat = objOf(objOf(config).heartbeat);
  const loop = objOf(raw.loop);
  const retry = objOf(raw.retry);
  const improvement = objOf(objOf(config).selfimprovement);
  const d = INNER_DEFAULTS;
  return {
    mode: raw.mode === 'live' ? 'live' : 'shadow',
    tickSeconds: Math.max(1, count(raw.tickSeconds, d.tickSeconds)),
    queueMax: d.queueMax,
    chatMessages: d.chatMessages,
    heartbeat: {
      enabled: heartbeat.enabled !== false,
      schedule: heartbeatSchedule(heartbeat),
      jitterMinutes: count(heartbeat.jitterMinutes, d.heartbeat.jitterMinutes),
      dueJitterMinutes: d.heartbeat.dueJitterMinutes,
      maxOpen: d.heartbeat.maxOpen,
      maxRecurring: d.heartbeat.maxRecurring,
    },
    caps: {
      perChain: Math.floor(count(caps.perChain, d.caps.perChain)),
    },
    selfimprovement: { enabled: improvement.enabled !== false },
    wakes: {
      selfimprovement: {
        schedule: improvementSchedule(improvement),
        failuresPerShape: whole(improvement.failuresPerShape, IMPROVEMENT_WAKE_DEFAULTS.failuresPerShape),
      },
    },
    attention: { ...d.attention },
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
      delaysMinutes: isDelayList(retry.delaysMinutes) ? [...retry.delaysMinutes] : [...d.retry.delaysMinutes],
      maxHours: positive(retry.maxHours, d.retry.maxHours),
    },
  };
}
