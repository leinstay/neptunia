// The settings of the persona's inner life: the wake kinds, the defaults of the `innerLife` section and
// `innerSettings`, which checks every number of that section against them. The scheduler's modules
// (src/behavior/inner/) and the turn runner (src/behavior/turn.js) read them. Nothing here keeps state.

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
] as const);

/** The defaults of the `innerLife` section (config.json carries the same). */
export const INNER_DEFAULTS = Object.freeze({
  mode: 'shadow',
  tickSeconds: 60,
  queueMax: 20,
  chatMessages: 30,
  review: Object.freeze({ enabled: true, historyDays: 14, expiredMax: 5 }),
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
    intentionsOnly: true,
    maxOpen: 3,
    maxRecurring: 1,
    dueJitterMinutes: 20,
  }),
  caps: Object.freeze({ perChain: 3 }),
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

/** Whether the inner life runs (`features.innerLife` exactly true). */
export function innerOn(config: unknown): boolean {
  return objOf(objOf(config).features).innerLife === true;
}

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
 * The `innerLife` section with every number checked against INNER_DEFAULTS (a missing or bad value
 * takes the default). `mode` is `live` only when it says so exactly. `loop`: the tool loop's
 * bounds of an inner turn (src/behavior/turn.js#loopSettings with `inner`; nobody waits for
 * one, so its budget is generous): `maxSteps`, `timeBudgetMs`, `maxCallsPerStep` as
 * `tools.loop`'s, `callTimeoutMs` the most one call of hers may run.
 */
export function innerSettings(config: unknown): InnerSettings {
  const raw = objOf(objOf(config).innerLife);
  const caps = objOf(raw.caps);
  const heartbeat = objOf(raw.heartbeat);
  const review = objOf(raw.review);
  const attention = objOf(raw.attention);
  const loop = objOf(raw.loop);
  const retry = objOf(raw.retry);
  const d = INNER_DEFAULTS;
  return {
    mode: raw.mode === 'live' ? 'live' : 'shadow',
    tickSeconds: Math.max(1, count(raw.tickSeconds, d.tickSeconds)),
    queueMax: Math.max(1, Math.floor(count(raw.queueMax, d.queueMax))),
    chatMessages: Math.max(1, Math.floor(count(raw.chatMessages, d.chatMessages))),
    review: {
      enabled: review.enabled !== false,
      historyDays: Math.max(1, count(review.historyDays, d.review.historyDays)),
      expiredMax: Math.floor(count(review.expiredMax, d.review.expiredMax)),
    },
    heartbeat: {
      enabled: heartbeat.enabled !== false,
      everyMinutes: Math.max(1, count(heartbeat.everyMinutes, d.heartbeat.everyMinutes)),
      jitterMinutes: count(heartbeat.jitterMinutes, d.heartbeat.jitterMinutes),
      dueJitterMinutes: count(heartbeat.dueJitterMinutes, d.heartbeat.dueJitterMinutes),
      people: Math.floor(count(heartbeat.people, d.heartbeat.people)),
      filteredShown: Math.floor(count(heartbeat.filteredShown, d.heartbeat.filteredShown)),
      closedShown: Math.floor(count(heartbeat.closedShown, d.heartbeat.closedShown)),
      historyDays: Math.max(1, count(heartbeat.historyDays, d.heartbeat.historyDays)),
      placesHours: Math.max(1, count(heartbeat.placesHours, d.heartbeat.placesHours)),
      placesShown: Math.floor(count(heartbeat.placesShown, d.heartbeat.placesShown)),
      placeLines: Math.floor(count(heartbeat.placeLines, d.heartbeat.placeLines)),
      maxTokens: Math.floor(count(heartbeat.maxTokens, d.heartbeat.maxTokens)),
      intentionsOnly: heartbeat.intentionsOnly !== false,
      maxOpen: Math.floor(count(heartbeat.maxOpen, d.heartbeat.maxOpen)),
      maxRecurring: Math.floor(count(heartbeat.maxRecurring, d.heartbeat.maxRecurring)),
    },
    caps: {
      perChain: Math.floor(count(caps.perChain, d.caps.perChain)),
    },
    attention: {
      settleSeconds: count(attention.settleSeconds, d.attention.settleSeconds),
      perDayDefault: Math.max(1, Math.floor(count(attention.perDayDefault, d.attention.perDayDefault))),
      pageSize: Math.max(1, Math.floor(count(attention.pageSize, d.attention.pageSize))),
      placesInWake: Math.floor(count(attention.placesInWake, d.attention.placesInWake)),
      lookbackHours: Math.max(1, count(attention.lookbackHours, d.attention.lookbackHours)),
    },
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
