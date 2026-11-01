// The typing lease: the persona's "typing" indicator as something that is held for a while and
// then lapses, never an open-ended loop. `startTypingLease` sends the indicator now and again
// every `refreshMs` (a platform's indicator fades after a few seconds) until the returned stop
// function is called or the lease expires -- `leaseMs` after it started, by the injected clock --
// so an indicator whose owner never stops it (a turn that hangs, a path that forgets) cannot keep
// the persona "typing" forever. Sending is the caller's: `send()` answers a promise (a failure is
// the caller's to log); the timer is the caller's `schedule(fn, ms)` -> cancel function, as the
// turn runner has it. Nothing throws.

/** How long a lease lasts when the caller names none: far past a turn's own bar, a leak guard only. */
export const TYPING_LEASE_MS = 5 * 60_000;

/**
 * @param options.send Shows the indicator once.
 * @param options.onExpire Called once when the lease lapsed instead of being stopped.
 * @returns Stops the lease; calling it again, or after the expiry, does nothing.
 */
export function startTypingLease({
  send,
  schedule,
  refreshMs,
  now = Date.now,
  leaseMs = TYPING_LEASE_MS,
  onExpire = () => {},
}: {
  send: () => unknown;
  schedule: (fn: () => void, ms: number) => (() => void) | null | undefined;
  refreshMs: number;
  now?: () => number;
  leaseMs?: number;
  onExpire?: () => void;
}): () => void {
  const expiresAt = now() + leaseMs;
  let stopped = false;
  let cancel: (() => void) | null = null;
  const tick = () => {
    cancel = null;
    if (stopped) return;
    if (now() >= expiresAt) {
      stopped = true;
      try {
        onExpire();
      } catch {
        // An expiry hook never breaks the lease.
      }
      return;
    }
    Promise.resolve()
      .then(send)
      .catch(() => {});
    cancel = schedule(tick, refreshMs) ?? null;
  };
  tick();
  return () => {
    stopped = true;
    cancel?.();
    cancel = null;
  };
}
