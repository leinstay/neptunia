// Pure logic for the server memory: how alive a channel is (computed from
// real message statistics, never the model's call — see
// docs/prompt-contract.md, "Server memory (the channel map)") and how
// one channel entry is rendered into the <server> prompt block. No I/O here;
// `nowMs` and the channel record are always injected.

import { DAY_MS, utcDay } from '../time.ts';

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
