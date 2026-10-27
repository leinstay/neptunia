// Pure logic for the server memory: how alive a channel is (computed from
// real message statistics, never the model's call — see
// docs/prompt-contract.md, "Server memory (the channel map)") and how
// one channel entry is rendered into the <server> prompt block. No I/O here;
// `nowMs` and the channel record are always injected.

import { fill, formatDuration } from '../format.js';
import { DAY_MS, utcDay } from '../time.js';

const DEFAULT_ACTIVITY_THRESHOLDS = { liveMessagesPerDay: 20, deadAfterDays: 7 };

/**
 * How alive a channel is, from stored message statistics only.
 * `live`   — today's + yesterday's (UTC) message counts reach `liveMessagesPerDay`.
 * `dead`   — never seen a message, or the last one is older than `deadAfterDays`.
 * `slow`   — anything in between.
 *
 * @param {{ days?: Record<string, number>, lastMessageAt?: number|null }} channel
 * @param {number} nowMs
 * @param {{ liveMessagesPerDay?: number, deadAfterDays?: number }} [cfg]  Defaults to
 *   DEFAULT_ACTIVITY_THRESHOLDS when omitted or missing a key.
 * @returns {'live'|'slow'|'dead'}
 */
export function channelActivity(channel, nowMs, cfg) {
  const liveMessagesPerDay = cfg?.liveMessagesPerDay ?? DEFAULT_ACTIVITY_THRESHOLDS.liveMessagesPerDay;
  const deadAfterDays = cfg?.deadAfterDays ?? DEFAULT_ACTIVITY_THRESHOLDS.deadAfterDays;
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
 * @param {{id: string, count: number}[]} topWriters
 * @param {(id: string) => (string|null)} [nameOf]
 */
function topWritersText(topWriters, nameOf) {
  if (!Array.isArray(topWriters) || topWriters.length === 0 || typeof nameOf !== 'function') return '';
  return topWriters
    .map((writer) => nameOf(writer?.id))
    .filter((name) => typeof name === 'string' && name)
    .join(', ');
}

/**
 * Render one channel entry for the <server> prompt block.
 *
 * @param {{ name: string, category?: string|null, topic?: string|null, purpose?: string,
 *   topics?: string, tone?: string, lastMessageAt?: number|null,
 *   topWriters?: {id: string, count: number}[] }} channel
 * @param {object} labels  Live `prompts.labels`; uses `labels.server.*`/`labels.units`.
 * @param {{ current?: boolean, activity: 'live'|'slow'|'dead', now?: number,
 *   nameOf?: (id: string) => (string|null), readOnly?: boolean }} options  `now` and
 *   `labels.server.lastMessage` together render "how long ago the last message was"
 *   (`formatDuration`, the same humanised-age function the `<tempo>` block uses); `nameOf` and
 *   `labels.server.topWriters` together render who writes here most. Either fact is omitted --
 *   not rendered as an empty/placeholder line -- when its label is missing (an older labels.json
 *   never breaks), when the underlying data is missing, or (for the last-message line) when `now`
 *   was not given. `readOnly` (a channel the bot can read but not write in, decided by the
 *   caller) adds the `labels.server.readOnly` line after the fact lines, before the last-message
 *   line; nothing is added when that label is missing or blank, and never on the `current`
 *   channel (the turn is answering there, so it is never shown as one the persona cannot write in).
 *   `diary` (the caller's `channel.id === config.diary.channelId`) adds the `labels.server.diary`
 *   line, with `{channel}` the channel's name, right before the read-only line, on any channel
 *   including the current one; nothing is added when that label is missing.
 * @returns {string}
 */
export function renderChannel(
  channel,
  labels,
  { current = false, activity, now: nowMs, nameOf, readOnly = false, diary = false } = {}
) {
  const s = labels.server;
  const mark = current ? s.currentMark : '';
  const lines = [`# ${channel.name}${mark}`];

  if (channel.category) lines.push(fill(s.category, { text: channel.category }));
  if (channel.topic) lines.push(fill(s.topic, { text: channel.topic }));
  if (channel.purpose) lines.push(fill(s.purpose, { text: channel.purpose }));
  if (channel.topics) lines.push(fill(s.topics, { text: channel.topics }));
  if (channel.tone) lines.push(fill(s.tone, { text: channel.tone }));

  if (diary === true && s.diary) lines.push(fill(s.diary, { channel: channel.name }));
  if (readOnly === true && !current && s.readOnly) lines.push(fill(s.readOnly));

  if (s.lastMessage && Number.isFinite(channel.lastMessageAt) && Number.isFinite(nowMs)) {
    const when = formatDuration(Math.max(0, nowMs - channel.lastMessageAt), labels.units);
    lines.push(fill(s.lastMessage, { when }));
  }

  const topWritersLine = s.topWriters ? topWritersText(channel.topWriters, nameOf) : '';
  if (topWritersLine) lines.push(fill(s.topWriters, { names: topWritersLine }));

  const activityLabel = { live: s.activityLive, slow: s.activitySlow, dead: s.activityDead }[activity];
  lines.push(fill(s.activity, { activity: activityLabel }));

  return lines.join('\n');
}

/**
 * Messages a channel saw since `sinceMs` (UTC-day resolution, from the stored `days` tally).
 * `coveredFromMs` is the oldest day the tally holds, so a caller knows when the count cannot
 * reach back to `sinceMs`. Pure; a missing or malformed tally counts as empty.
 * @param {object} channel  A stored channel (`days: { 'YYYY-MM-DD': count }`).
 * @param {number|null} sinceMs  Count from this day on; null = every day.
 * @param {number} nowMs
 * @returns {{ count: number, coveredFromMs: number|null }}
 */
export function messagesSince(channel, sinceMs, nowMs) {
  const days = channel && typeof channel.days === 'object' && channel.days !== null ? channel.days : {};
  const from = sinceMs === null || sinceMs === undefined ? null : utcDay(sinceMs);
  const to = utcDay(nowMs);
  let count = 0;
  let oldest = null;
  for (const [day, n] of Object.entries(days)) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || !Number.isFinite(n)) continue;
    const ms = Date.parse(day + 'T00:00:00Z');
    if (!Number.isFinite(ms)) continue;
    if (oldest === null || ms < oldest) oldest = ms;
    if ((from === null || day >= from) && day <= to) count += n;
  }
  return { count, coveredFromMs: oldest };
}
