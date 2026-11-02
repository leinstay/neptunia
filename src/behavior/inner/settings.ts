// The settings of the persona's inner life: the wake kinds, the defaults of the `wakes` section and
// `innerSettings`, which checks every number of that section against them. The scheduler's modules
// (src/behavior/inner/) and the turn runner (src/behavior/turn.ts) read them. Nothing here keeps state.

import { isPositive, objOf } from '../../tools/types.ts';
import type { InnerSettings } from './types.ts';

/** The wake kinds, as the `<wake>` block names them. */
export const WAKE_KINDS = Object.freeze([
  'intention_due',
  'review',
  'errand_deadline',
  'attend',
  'feedback',
  'heartbeat',
  'selfimprovement',
] as const);

/**
 * The inner life's measures: production values of the config cut of 2026-10-31, and the fallbacks of the keys the
 * live config holds (`mode`, `tickSeconds`, `review.historyDays`, `caps.perChain`, `loop`, `retry` and `factsKeepDays`
 * of `wakes`; the heartbeat's switch, clock, history and token budget of `heartbeat`; the selfimprovement wake's
 * switch and clock of `selfimprovement`).
 */
export const INNER_DEFAULTS = Object.freeze({
  mode: 'shadow',
  tickSeconds: 60,
  queueMax: 20,
  chatMessages: 30,
  review: Object.freeze({ historyDays: 14, expiredMax: 5 }),
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
    maxOpen: 3,
    maxRecurring: 1,
    dueJitterMinutes: 20,
  }),
  caps: Object.freeze({ perChain: 3 }),
  // The selfimprovement wake (PR 7e): once a week on the heartbeat's clock, and when one chain shape fails this many
  // times in a UTC day. Decision of 2026-10-24 (the archived design), kept by the owner on 2026-10-31.
  selfimprovement: Object.freeze({ enabled: true }),
  wakes: Object.freeze({ selfimprovement: Object.freeze({ everyDays: 7, failuresPerShape: 3 }) }),
  attention: Object.freeze({ settleSeconds: 90, perDayDefault: 12, pageSize: 12, placesInWake: 8, lookbackHours: 24 }),
  loop: Object.freeze({ maxSteps: 4, timeBudgetMs: 180000, maxCallsPerStep: 4, callTimeoutMs: 60000 }),
  retry: Object.freeze({ delaysMinutes: Object.freeze([1, 5, 15, 60]), maxHours: 6 }),
  factsKeepDays: 7,
});

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
  const review = objOf(raw.review);
  const loop = objOf(raw.loop);
  const retry = objOf(raw.retry);
  const improvement = objOf(objOf(config).selfimprovement);
  const d = INNER_DEFAULTS;
  return {
    mode: raw.mode === 'live' ? 'live' : 'shadow',
    tickSeconds: Math.max(1, count(raw.tickSeconds, d.tickSeconds)),
    queueMax: d.queueMax,
    chatMessages: d.chatMessages,
    review: {
      historyDays: Math.max(1, count(review.historyDays, d.review.historyDays)),
      expiredMax: d.review.expiredMax,
    },
    heartbeat: {
      enabled: heartbeat.enabled !== false,
      everyMinutes: Math.max(1, count(heartbeat.everyMinutes, d.heartbeat.everyMinutes)),
      jitterMinutes: count(heartbeat.jitterMinutes, d.heartbeat.jitterMinutes),
      dueJitterMinutes: d.heartbeat.dueJitterMinutes,
      people: d.heartbeat.people,
      filteredShown: d.heartbeat.filteredShown,
      closedShown: d.heartbeat.closedShown,
      historyDays: Math.max(1, count(heartbeat.historyDays, d.heartbeat.historyDays)),
      placesHours: d.heartbeat.placesHours,
      placesShown: d.heartbeat.placesShown,
      placeLines: d.heartbeat.placeLines,
      maxTokens: Math.floor(count(heartbeat.maxTokens, d.heartbeat.maxTokens)),
      maxOpen: d.heartbeat.maxOpen,
      maxRecurring: d.heartbeat.maxRecurring,
    },
    caps: {
      perChain: Math.floor(count(caps.perChain, d.caps.perChain)),
    },
    selfimprovement: { enabled: improvement.enabled !== false },
    wakes: {
      selfimprovement: {
        everyDays: whole(improvement.everyDays, d.wakes.selfimprovement.everyDays),
        failuresPerShape: whole(improvement.failuresPerShape, d.wakes.selfimprovement.failuresPerShape),
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
