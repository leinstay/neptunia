// The writes a module store sent straight to the memory database's writer and has not seen settle: the intentions
// (src/intentions/store.ts) and the errand tasks (src/errands/store.ts). Each store keeps its own values in memory and
// knows what a failed write left unwritten; this follows the writes:
//   - `track(write, onFail)`   starts one write (a function that sends it) and follows it; a failure is logged as
//                              `memory db: unit write failed` with the store's name and code, then `onFail()` runs;
//   - `drain({ final, timeoutMs, unwritten, resend })`  awaits the writes under way, then `resend()` while `unwritten()`
//                              shrinks, three rounds at most, and answers how many are still unwritten. With `final`
//                              (the shutdown) what is left is logged as `memory db: units lost` with the last code, and
//                              with `timeoutMs` too the wait ends after it, logged as `memory db: writes still under way
//                              at shutdown` with the count.
// Logs carry codes and counts only.

/** The log a module store hands over: `warn`, and `error` where it has one. */
type StoreLog = {
  warn: (message: string, fields?: Record<string, unknown>) => unknown;
  error?: (message: string, fields?: Record<string, unknown>) => unknown;
};

/** What `createWritesUnderWay` offers a module store. */
export type WritesUnderWay = {
  track: (write: () => Promise<unknown>, onFail: () => void) => void;
  drain: (options: {
    final?: boolean;
    timeoutMs?: number | undefined;
    unwritten: () => number;
    resend: () => void;
  }) => Promise<number>;
};

/** `name` says whose writes they are in the logs (`intentions`, `tasks`). */
export function createWritesUnderWay({ log, name }: { log: StoreLog; name: string }): WritesUnderWay {
  const under = new Set<Promise<void>>();
  let lastCode: unknown = null;

  function track(write: () => Promise<unknown>, onFail: () => void): void {
    let sending: Promise<unknown>;
    try {
      sending = Promise.resolve(write());
    } catch (error) {
      sending = Promise.reject(error instanceof Error ? error : new Error(String(error)));
    }
    const done: Promise<void> = sending
      .then(
        () => {},
        (error: unknown) => {
          lastCode = (error as { code?: unknown } | null)?.code ?? null;
          log.warn('memory db: unit write failed', { reader: name, units: 1, code: lastCode });
          onFail();
        }
      )
      .finally(() => under.delete(done));
    under.add(done);
  }

  /** Rounds of awaiting and resending while what is unwritten shrinks; how many are left. */
  async function rounds(unwritten: () => number, resend: () => void): Promise<number> {
    for (let round = 0; round < 3; round += 1) {
      await Promise.allSettled([...under]);
      const before = unwritten();
      if (before === 0) break;
      resend();
      await Promise.allSettled([...under]);
      if (unwritten() >= before) break;
    }
    return unwritten();
  }

  async function drain({
    final = false,
    timeoutMs,
    unwritten,
    resend,
  }: {
    final?: boolean;
    timeoutMs?: number | undefined;
    unwritten: () => number;
    resend: () => void;
  }): Promise<number> {
    const draining = rounds(unwritten, resend);
    let waiting: number | null;
    if (final && typeof timeoutMs === 'number' && timeoutMs >= 0) {
      let timer: ReturnType<typeof setTimeout> | undefined;
      const late = new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), timeoutMs);
      });
      waiting = await Promise.race([draining, late]);
      clearTimeout(timer);
      if (waiting === null) {
        const units = Math.max(under.size, unwritten());
        log.error?.('memory db: writes still under way at shutdown', { reader: name, units, ms: timeoutMs });
        return units;
      }
    } else waiting = await draining;
    if (final && waiting > 0) log.error?.('memory db: units lost', { reader: name, units: waiting, code: lastCode });
    return waiting;
  }

  return { track, drain };
}
