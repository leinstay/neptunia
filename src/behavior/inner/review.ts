// The day's review (docs/inner-life.md): one wake a local day at a moment drawn from the hours she usually speaks in
// (her own `said` lines in the record), and the channels she spoke in lately, where a review or a heartbeat turn runs.
// The tick (src/behavior/inner.ts) draws it; the drain (src/behavior/inner/drain.ts) reads the channels.

import { DAY_MS, HOUR_MS, MINUTE_MS, zonedDay, zonedEpoch } from '../../time.js';
import { localHour } from '../../format.js';
import { errorCode, isFiniteNumber, objOf } from '../../tools/types.ts';
import type { Obj } from '../../tools/types.ts';
import { markHandled, note, save, stateOf, timezoneOf } from './queue.ts';
import { innerSettings } from './settings.ts';
import type { InnerContext, InnerSettings, Wake } from './types.ts';

/** The time of a record line: Date.parse over its text. */
const parseAt = (value: unknown): number => Date.parse(String(value));
/** Her lines, the newest first, by their record time. */
const newestFirst = (a: Obj, b: Obj): number => parseAt(b.occurredAt) - parseAt(a.occurredAt);

/** The channels of her recent lines a review remembers, newest first. */
const REVIEW_CHANNELS_MAX = 3;

/** The day's review wake (`day` the local date, `at` its moment). */
export function reviewWake(day: unknown, at: unknown): Wake {
  return {
    id: `inner.wake:review:${String(day)}`,
    kind: 'review',
    reason: 'review',
    intentionIds: [],
    chainId: `review:${String(day)}`,
    // The review's drawn moment, a number; a JavaScript caller hands it in untyped and it is kept as given.
    dueAt: at as number,
    channelId: null,
    privateChat: false,
  };
}

/**
 * Her lines per local hour of `timezone` (24 counts): the `said` lines of `lines` (the record's).
 */
export function hourWeights(lines: Iterable<unknown> | null | undefined, timezone: string): Array<number> {
  const weights = new Array<number>(24).fill(0);
  for (const entry of lines ?? []) {
    const line = objOf(entry);
    if (line.kind !== 'said') continue;
    const at = parseAt(line.occurredAt);
    if (Number.isFinite(at)) weights[localHour(at, timezone)] += 1;
  }
  return weights;
}

/**
 * The review's moment on local day `day`: an hour drawn with the weight of her lines in it
 * (`weights`, hourWeights'; all hours alike when she has none), then a minute in it, never before
 * `notBefore` (the hours already past on the day it is drawn are not offered). Null when no hour
 * of the day is left. `rng` in [0, 1).
 */
export function drawReviewAt({
  day,
  weights,
  timezone,
  rng,
  notBefore = -Infinity,
}: {
  day: string;
  weights: ReadonlyArray<number>;
  timezone: string;
  rng: () => number;
  notBefore?: number;
}): number | null {
  const total = weights.reduce((sum, value) => sum + (value > 0 ? value : 0), 0);
  const hours: Array<{ hour: number; weight: number }> = [];
  for (let hour = 0; hour < 24; hour += 1) {
    const end = zonedEpoch(day, hour, 59, timezone) + MINUTE_MS - 1;
    if (!Number.isFinite(end) || end < notBefore) continue;
    const weight = total > 0 ? Math.max(0, weights[hour] ?? 0) : 1;
    if (weight > 0) hours.push({ hour, weight });
  }
  if (hours.length === 0) return null;
  const sum = hours.reduce((acc, entry) => acc + entry.weight, 0);
  let pick = rng() * sum;
  let chosen = hours[hours.length - 1];
  for (const entry of hours) {
    if (pick < entry.weight) {
      chosen = entry;
      break;
    }
    pick -= entry.weight;
  }
  const start = zonedEpoch(day, chosen.hour, 0, timezone);
  const from = Math.max(start, Number.isFinite(notBefore) ? notBefore : start);
  const end = start + HOUR_MS;
  return Math.floor(from + rng() * Math.max(0, end - from - 1));
}

/** Her `said` lines of the last `days` from the record, as the review's hours and channels. */
export async function ownLines(life: InnerContext, guildId: string, days: number): Promise<Array<Obj>> {
  const { record, now, log } = life;
  const lines: Array<Obj> = [];
  if (typeof record?.iterate !== 'function') return lines;
  const from = new Date(now() - days * DAY_MS).toISOString();
  try {
    for await (const raw of record.iterate(guildId, { from })) {
      const line = objOf(raw);
      if (line.kind === 'said') lines.push(line);
    }
  } catch (err) {
    log.warn('inner: record read failed', { guildId, code: errorCode(err) });
  }
  return lines;
}

/** Today's review drawn (once per local day, persisted); the wake when its moment came. */
export async function reviewDue(
  life: InnerContext,
  guildId: string,
  settings: InnerSettings,
  at: number
): Promise<Wake | null> {
  const { rng, log } = life;
  if (!settings.review.enabled) return null;
  const state = stateOf(life, guildId);
  const timezone = timezoneOf(life);
  const day = zonedDay(at, timezone);
  if (state.review?.day !== day) {
    const previous = state.review;
    if (previous && previous.done !== true && isFiniteNumber(previous.at))
      note(life, guildId, { event: 'review-missed', day: previous.day });
    const lines = await ownLines(life, guildId, settings.review.historyDays);
    const weights = hourWeights(lines, timezone);
    const reviewAt = drawReviewAt({ day, weights, timezone, rng, notBefore: at });
    const channels: Array<string> = [];
    for (const line of [...lines].sort(newestFirst)) {
      const channelId = objOf(line.scope).channel;
      if (typeof channelId === 'string' && channelId && !channels.includes(channelId)) channels.push(channelId);
      if (channels.length >= REVIEW_CHANNELS_MAX) break;
    }
    // Re-read: the record scan awaited, a tick of the same day may have drawn it meanwhile.
    const current = stateOf(life, guildId);
    if (current.review?.day !== day) {
      // An earlier day's review still queued (held by a cap) gives way to today's.
      const older = current.queue.filter((wake) => wake.kind === 'review' && wake.id !== reviewWake(day, 0).id);
      if (older.length > 0) markHandled(life, current, older, 'superseded', at);
      current.review = { day, at: reviewAt, done: reviewAt === null, channels, lines: lines.length };
      save(life, guildId);
      log.info('inner: review drawn', { guildId, day, at: reviewAt, lines: lines.length });
      note(life, guildId, { event: 'review-drawn', day, at: reviewAt, lines: lines.length });
    }
  }
  const review = stateOf(life, guildId).review;
  if (!review || review.done || !isFiniteNumber(review.at) || review.at > at) return null;
  return reviewWake(day, review.at);
}

/** The channels a review or a heartbeat turn may run in: where she spoke lately (the review's remembered ones, else the record's). */
export async function recentChannels(life: InnerContext, guildId: string): Promise<Array<string>> {
  const { hot } = life;
  const known = stateOf(life, guildId).review?.channels ?? [];
  if (known.length > 0) return known;
  const channels: Array<string> = [];
  const lines = await ownLines(life, guildId, innerSettings(hot.config).review.historyDays);
  for (const line of lines.sort(newestFirst)) {
    const id = objOf(line.scope).channel;
    if (typeof id === 'string' && id && !channels.includes(id)) channels.push(id);
    if (channels.length >= REVIEW_CHANNELS_MAX) break;
  }
  return channels;
}

/** The channel names of the review's recent channels, for `<wake>`. */
export function channelNames(life: InnerContext, guildId: string): Array<string> {
  const { conversationName } = life;
  const ids = stateOf(life, guildId).review?.channels ?? [];
  return ids.map((id) => conversationName(String(id))).filter((name): name is string => Boolean(name));
}
