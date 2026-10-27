// The day's review (docs/inner-life.md): one wake a local day at a moment drawn from the hours she usually speaks in
// (her own `said` lines in the record), and the channels she spoke in lately, where a review or a heartbeat turn runs.
// The tick (src/behavior/inner.ts) draws it; the drain (src/behavior/inner/drain.ts) reads the channels.

import { DAY_MS, HOUR_MS, MINUTE_MS, zonedDay, zonedEpoch } from '../../time.js';
import { localHour } from '../../format.js';
import { listOf } from '../../tools/types.ts';
import { markHandled, note, save, stateOf, timezoneOf } from './queue.ts';
import { innerSettings } from './settings.ts';

/** The channels of her recent lines a review remembers, newest first. */
const REVIEW_CHANNELS_MAX = 3;

/** The day's review wake. */
export function reviewWake(day, at) {
  return {
    id: `inner.wake:review:${day}`,
    kind: 'review',
    reason: 'review',
    intentionIds: [],
    chainId: `review:${day}`,
    dueAt: at,
    channelId: null,
    privateChat: false,
  };
}

/**
 * Her lines per local hour of `timezone` (24 counts): the `said` lines of `lines` (the record's).
 * @param {Iterable<object>} lines
 * @param {string} timezone
 */
export function hourWeights(lines, timezone) {
  const weights = new Array(24).fill(0);
  for (const line of lines ?? []) {
    if (line?.kind !== 'said') continue;
    const at = Date.parse(line.occurredAt);
    if (Number.isFinite(at)) weights[localHour(at, timezone)] += 1;
  }
  return weights;
}

/**
 * The review's moment on local day `day`: an hour drawn with the weight of her lines in it
 * (`weights`, hourWeights'; all hours alike when she has none), then a minute in it, never before
 * `notBefore` (the hours already past on the day it is drawn are not offered). Null when no hour
 * of the day is left. `rng` in [0, 1).
 * @param {{ day: string, weights: number[], timezone: string, rng: () => number, notBefore?: number }} input
 * @returns {number|null}
 */
export function drawReviewAt({ day, weights, timezone, rng, notBefore = -Infinity }) {
  const total = listOf(weights).reduce((sum, value) => sum + (value > 0 ? value : 0), 0);
  const hours = [];
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
export async function ownLines(life, guildId, days) {
  const { record, now, log } = life;
  const lines = [];
  if (typeof record?.iterate !== 'function') return lines;
  const from = new Date(now() - days * DAY_MS).toISOString();
  try {
    for await (const line of record.iterate(guildId, { from })) if (line?.kind === 'said') lines.push(line);
  } catch (err) {
    log.warn('inner: record read failed', { guildId, code: err?.code ?? null });
  }
  return lines;
}

/** Today's review drawn (once per local day, persisted); the wake when its moment came. */
export async function reviewDue(life, guildId, settings, at) {
  const { rng, log } = life;
  if (!settings.review.enabled) return null;
  const state = stateOf(life, guildId);
  const timezone = timezoneOf(life);
  const day = zonedDay(at, timezone);
  if (state.review?.day !== day) {
    const previous = state.review;
    if (previous && previous.done !== true && Number.isFinite(previous.at))
      note(life, guildId, { event: 'review-missed', day: previous.day });
    const lines = await ownLines(life, guildId, settings.review.historyDays);
    const weights = hourWeights(lines, timezone);
    const reviewAt = drawReviewAt({ day, weights, timezone, rng, notBefore: at });
    const channels = [];
    for (const line of [...lines].sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))) {
      const channelId = line.scope?.channel;
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
  if (!review || review.done || !Number.isFinite(review.at) || review.at > at) return null;
  return reviewWake(day, review.at);
}

/** The channels a review or a heartbeat turn may run in: where she spoke lately (the review's remembered ones, else the record's). */
export async function recentChannels(life, guildId) {
  const { hot } = life;
  const known = stateOf(life, guildId).review?.channels ?? [];
  if (known.length > 0) return known;
  const channels = [];
  const lines = await ownLines(life, guildId, innerSettings(hot.config).review.historyDays);
  for (const line of lines.sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))) {
    const id = line.scope?.channel;
    if (typeof id === 'string' && id && !channels.includes(id)) channels.push(id);
    if (channels.length >= REVIEW_CHANNELS_MAX) break;
  }
  return channels;
}

/** The channel names of the review's recent channels, for `<wake>`. */
export function channelNames(life, guildId) {
  const { conversationName } = life;
  const ids = stateOf(life, guildId).review?.channels ?? [];
  return ids.map((id) => conversationName(String(id))).filter(Boolean);
}
