// When each person last wrote in each channel, so a turn answering someone can wait until they
// have stopped writing (pace.settleMs) and answer a thought posted as several quick messages
// whole. Pure: times come from the caller, no message contents are kept, and old entries are
// evicted on every note so the map never grows without bound.

/** Entries older than this are dropped on every note. */
const KEEP_MS = 10 * 60 * 1000;

/**
 * A tracker of the last message time per `channelId:authorId`. `note` records a message (an
 * older time never moves an entry back) and evicts entries older than ten minutes against that
 * time; `lastAt` reads the latest time or null; `prune(now, maxAgeMs)` drops entries older than
 * `maxAgeMs` at `now`; `size()` is the number of entries kept. Which messages count (the
 * persona's own do not) is the caller's decision.
 * @returns {{ note: (channelId: string, authorId: string, at: number) => void,
 *   lastAt: (channelId: string, authorId: string) => number|null,
 *   prune: (now: number, maxAgeMs: number) => void, size: () => number }}
 */
export function createActivity() {
  const last = new Map();
  const keyOf = (channelId, authorId) => `${channelId}:${authorId}`;
  function prune(now, maxAgeMs) {
    if (!Number.isFinite(now) || !Number.isFinite(maxAgeMs)) return;
    for (const [key, at] of last) {
      if (now - at > maxAgeMs) last.delete(key);
    }
  }
  return {
    note(channelId, authorId, at) {
      if (!channelId || !authorId || !Number.isFinite(at)) return;
      const key = keyOf(channelId, authorId);
      const known = last.get(key);
      if (known === undefined || at > known) last.set(key, at);
      prune(at, KEEP_MS);
    },
    lastAt(channelId, authorId) {
      return last.get(keyOf(channelId, authorId)) ?? null;
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
 * @param {{ now: number, triggerAt: number|null, lastAt: number|null, settleMs: unknown, settleMaxMs: unknown }} params
 * @returns {number} milliseconds to wait now
 */
export function settleWait({ now, triggerAt, lastAt, settleMs, settleMaxMs }) {
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
