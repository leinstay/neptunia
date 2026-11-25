// When each person last wrote in each channel, so a turn answering someone can wait until they
// have stopped writing (pace.settleMs) and answer a thought posted as several quick messages
// whole. Pure: times come from the caller, no message contents are kept, and old entries are
// evicted on every note so the map never grows without bound.

import type { Untyped } from '../tools/types.ts';

/** Entries older than this are dropped on every note. */
const KEEP_MS = 10 * 60 * 1000;

/**
 * A tracker of the last message time per `placeId:authorId`. `note` records a message (an
 * older time never moves an entry back) and evicts entries older than ten minutes against that
 * time; `lastAt` reads the latest time or null; `prune(now, maxAgeMs)` drops entries older than
 * `maxAgeMs` at `now`; `size()` is the number of entries kept. Which messages count (the
 * persona's own do not) is the caller's decision.
 */
export function createActivity(): {
  note: (placeId: string, authorId: string, at: number) => void;
  lastAt: (placeId: string, authorId: string) => number | null;
  prune: (now: number, maxAgeMs: number) => void;
  size: () => number;
} {
  const last = new Map();
  const keyOf = (placeId: string, authorId: string) => `${placeId}:${authorId}`;
  function prune(now: number, maxAgeMs: Untyped) {
    if (!Number.isFinite(now) || !Number.isFinite(maxAgeMs)) return;
    for (const [key, at] of last) {
      if (now - at > maxAgeMs) last.delete(key);
    }
  }
  return {
    note(placeId, authorId, at) {
      if (!placeId || !authorId || !Number.isFinite(at)) return;
      const key = keyOf(placeId, authorId);
      const known = last.get(key);
      if (known === undefined || at > known) last.set(key, at);
      prune(at, KEEP_MS);
    },
    lastAt(placeId, authorId) {
      return last.get(keyOf(placeId, authorId)) ?? null;
    },
    prune,
    size: () => last.size,
  };
}

/**
 * How long a turn should still wait now before it reads the channel: until `settleMs` have
 * passed since the author's last message (`lastAt`; null = only the trigger is known, counted
 * from `triggerAt`), never past `settleMaxMs` counted from `triggerAt` (0 or a non-number: one
 * settle from `triggerAt`). 0 when there is nothing to wait for: settle off (`settleMs` 0, a
 * negative value or a non-number), the author silent long enough, the cap reached, or neither
 * time known.
 * @returns milliseconds to wait now
 */
export function settleWait({
  now,
  triggerAt,
  lastAt,
  settleMs,
  settleMaxMs,
}: {
  now: number;
  triggerAt: number | null;
  lastAt: number | null;
  settleMs: unknown;
  settleMaxMs: unknown;
}): number {
  if (typeof settleMs !== 'number' || !Number.isFinite(settleMs) || settleMs <= 0) return 0;
  const anchor = Number.isFinite(triggerAt) ? triggerAt : null;
  const known = [anchor, Number.isFinite(lastAt) ? lastAt : null].filter((at) => at !== null);
  if (known.length === 0 || !Number.isFinite(now)) return 0;
  const latest = Math.max(...known);
  const cap =
    typeof settleMaxMs === 'number' && Number.isFinite(settleMaxMs) && settleMaxMs > 0 ? settleMaxMs : settleMs;
  const until = Math.min(latest + settleMs, (anchor ?? latest) + cap);
  return Math.max(0, until - now);
}

/**
 * The lines a turn's settle wait read as part of its call: the trigger author's lines after the trigger in `lines`
 * (oldest first), each written within `settleMs` of the author's line before it, none later than `settleMaxMs` after
 * the trigger (0 or a non-number: one `settleMs`). The run ends at the first line past either bound. Empty with the
 * settle off, no trigger author or the trigger not among the lines.
 * @returns the ids of those lines, the trigger's not among them
 */
export function settledBurst(
  lines: ReadonlyArray<{ id: string; authorId?: string | null; ts?: number | null }>,
  trigger: { id?: string | null; authorId?: string | null; ts?: number | null } | null,
  { settleMs, settleMaxMs }: { settleMs: unknown; settleMaxMs: unknown }
): Set<string> {
  const burst = new Set<string>();
  if (typeof settleMs !== 'number' || !Number.isFinite(settleMs) || settleMs <= 0) return burst;
  const start = trigger?.authorId ? lines.findIndex((line) => line.id === trigger.id) : -1;
  const triggerAt = trigger?.ts;
  if (start === -1 || typeof triggerAt !== 'number' || !Number.isFinite(triggerAt)) return burst;
  const cap =
    typeof settleMaxMs === 'number' && Number.isFinite(settleMaxMs) && settleMaxMs > 0 ? settleMaxMs : settleMs;
  let previous = triggerAt;
  for (const line of lines.slice(start + 1)) {
    if (line.authorId !== trigger?.authorId) continue;
    const at = line.ts;
    if (typeof at !== 'number' || at - previous > settleMs || at - triggerAt > cap) break;
    burst.add(line.id);
    previous = at;
  }
  return burst;
}
