// Pure logic for the server memory: how alive a channel is (computed from
// real message statistics, never the model's call — see
// docs/prompt-contract.md, "Server memory (the channel map)") and how
// one channel entry is rendered into the <server> prompt block. No I/O here;
// `nowMs` and the channel record are always injected.

import { fill, formatDuration } from '../format.ts';
import { DAY_MS, utcDay } from '../time.ts';
import { isFiniteNumber } from './types.ts';
import type { StoredRecord } from './types.ts';

// Production values, config cut of 2026-10-31.
const LIVE_MESSAGES_PER_DAY = 20;
const DEAD_AFTER_DAYS = 7;

/**
 * How alive a channel is, from stored message statistics only.
 * `live`   — today's + yesterday's (UTC) message counts reach `LIVE_MESSAGES_PER_DAY`.
 * `dead`   — never seen a message, or the last one is older than `DEAD_AFTER_DAYS`.
 * `slow`   — anything in between.
 *
 */
export function channelActivity(
  channel: { days?: Record<string, number>; lastMessageAt?: number | null },
  nowMs: number
): 'live' | 'slow' | 'dead' {
  const liveMessagesPerDay = LIVE_MESSAGES_PER_DAY;
  const deadAfterDays = DEAD_AFTER_DAYS;
  const days = channel?.days ?? {};

  const todayKey = utcDay(nowMs);
  const yesterdayKey = utcDay(nowMs - DAY_MS);
  const recent = (days[todayKey] ?? 0) + (days[yesterdayKey] ?? 0);
  if (recent >= liveMessagesPerDay) return 'live';

  const lastMessageAt = channel?.lastMessageAt ?? null;
  if (lastMessageAt === null || nowMs - lastMessageAt > deadAfterDays * DAY_MS) return 'dead';

  return 'slow';
}

/**
 * The `labels.server.topWriters` line's `{names}`: up to the stored `topWriters`' current names
 * (`nameOf`, the store's `profile.names[0]`), in the stored (count-descending) order,
 * comma-separated -- an id `nameOf` cannot resolve (no profile, e.g. someone who left) is skipped
 * silently, never rendered as a bare id. `''` when there is nothing to show, or when `nameOf` is
 * missing.
 */
function topWritersText(
  topWriters: Array<{ id: string; count: number }> | undefined,
  nameOf?: (id: string) => string | null
) {
  if (!Array.isArray(topWriters) || topWriters.length === 0 || typeof nameOf !== 'function') return '';
  return topWriters
    .map((writer) => nameOf(writer?.id))
    .filter((name) => typeof name === 'string' && name)
    .join(', ');
}

/**
 * Render one channel entry for the <server> prompt block.
 *
 * @param labels  Live `prompts.labels`; uses `labels.server.*`/`labels.units`.
 * @param options  `now` and
 *   `labels.server.lastMessage` together render "how long ago the last message was"
 *   (`formatDuration`, the same humanised-age function the `<tempo>` block uses); `nameOf` and
 *   `labels.server.topWriters` together render who writes here most. Either fact is omitted --
 *   not rendered as an empty/placeholder line -- when its label is missing (an older labels.json
 *   never breaks), when the underlying data is missing, or (for the last-message line) when `now`
 *   was not given. `readOnly` (a channel the bot can read but not write in, decided by the
 *   caller) adds the `labels.server.readOnly` line after the fact lines, before the last-message
 *   line; nothing is added when that label is missing or blank, and never on the `current`
 *   channel (the turn is answering there, so it is never shown as one the persona cannot write in).
 *   `selfreflection` (the caller says the channel is a place of her selfreflection, its mirrors) adds the `labels.server.selfreflection`
 *   line, with `{channel}` the channel's name, right before the read-only line, on any channel
 *   including the current one; nothing is added when that label is missing.
 */
export function renderChannel(
  channel: {
    name: string;
    topic?: string | null;
    purpose?: string;
    topics?: string;
    tone?: string;
    lastMessageAt?: number | null;
    topWriters?: Array<{ id: string; count: number }>;
  },
  labels: StoredRecord,
  {
    current = false,
    activity,
    now: nowMs,
    nameOf,
    readOnly = false,
    selfreflection = false,
  }: {
    current?: boolean;
    activity?: 'live' | 'slow' | 'dead';
    now?: number;
    nameOf?: (id: string) => string | null;
    readOnly?: boolean;
    selfreflection?: boolean;
  } = {}
): string {
  const s = labels.server;
  const mark = current ? s.currentMark : '';
  const lines = [`# ${channel.name}${mark}`];

  if (channel.topic) lines.push(fill(s.topic, { text: channel.topic }));
  if (channel.purpose) lines.push(fill(s.purpose, { text: channel.purpose }));
  if (channel.topics) lines.push(fill(s.topics, { text: channel.topics }));
  if (channel.tone) lines.push(fill(s.tone, { text: channel.tone }));

  if (selfreflection === true && s.selfreflection) lines.push(fill(s.selfreflection, { channel: channel.name }));
  if (readOnly === true && !current && s.readOnly) lines.push(fill(s.readOnly));

  if (
    s.lastMessage &&
    typeof channel.lastMessageAt === 'number' &&
    isFiniteNumber(channel.lastMessageAt) &&
    typeof nowMs === 'number' &&
    isFiniteNumber(nowMs)
  ) {
    const when = formatDuration(Math.max(0, nowMs - channel.lastMessageAt), labels.units);
    lines.push(fill(s.lastMessage, { when }));
  }

  const topWritersLine = s.topWriters ? topWritersText(channel.topWriters, nameOf) : '';
  if (topWritersLine) lines.push(fill(s.topWriters, { names: topWritersLine }));

  const activityLabels: Record<string, unknown> = { live: s.activityLive, slow: s.activitySlow, dead: s.activityDead };
  const activityLabel = activityLabels[String(activity)];
  lines.push(fill(s.activity, { activity: activityLabel }));

  return lines.join('\n');
}

/**
 * Messages a channel saw since `sinceMs` (UTC-day resolution, from the stored `days` tally).
 * `coveredFromMs` is the oldest day the tally holds, so a caller knows when the count cannot
 * reach back to `sinceMs`. Pure; a missing or malformed tally counts as empty.
 * @param channel  A stored channel (`days: { 'YYYY-MM-DD': count }`).
 * @param sinceMs  Count from this day on; null = every day.
 */
export function messagesSince(
  channel: { days?: Record<string, number> } | null | undefined,
  sinceMs: number | null,
  nowMs: number
): { count: number; coveredFromMs: number | null } {
  const days = channel && typeof channel.days === 'object' && channel.days !== null ? channel.days : {};
  const from = sinceMs === null || sinceMs === undefined ? null : utcDay(sinceMs);
  const to = utcDay(nowMs);
  let count = 0;
  let oldest: number | null = null;
  for (const [day, n] of Object.entries(days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !isFiniteNumber(n)) continue;
    const ms = Date.parse(day + 'T00:00:00Z');
    if (!isFiniteNumber(ms)) continue;
    if (oldest === null || ms < oldest) oldest = ms;
    if ((from === null || day >= from) && day <= to) count += n;
  }
  return { count, coveredFromMs: oldest };
}
