// The event loop watch: a timer that measures its own lateness. A tick later than `diagnostics.loopStallMs` logs one
// line naming the operations open at that tick and the ones that ended since the previous tick. A synchronous operation
// that blocks the loop has ended by the time the late tick runs, so the ended list is what attributes the stall.
// `track(name, fn)` marks an operation. The line carries names, counts and milliseconds, never a value or an error.

type Interval = { unref?: () => void };

/** The shape of `LoopWatch.track`, for a module that takes it as a dependency. */
export type Track = <T>(name: string, fn: () => T) => T;

/** A `Track` that only runs `fn`, the default of a module built without the watch. */
export const untracked: Track = (_name, fn) => fn();

export type LoopWatch = {
  /** Runs `fn` as the operation `name`; a promise it returns keeps the operation open until it settles. */
  track: Track;
  stop(): void;
};

type Stall = {
  stalledMs: number;
  open: Array<string>;
  ended: Array<{ name: string; count: number; ms: number }>;
};

export function createLoopWatch<Handle extends Interval>(deps: {
  log: { warn(message: string, fields: Stall): void };
  now: () => number;
  /** Read at each tick; 0 turns the line off. */
  thresholdMs: () => number;
  sampleMs: number;
  setInterval: (fn: () => void, ms: number) => Handle;
  clearInterval: (handle: Handle) => void;
}): LoopWatch {
  const open = new Map<string, number>();
  let ended = new Map<string, { count: number; ms: number }>();
  let last = deps.now();
  let stopped = false;

  const close = (name: string, startedAt: number) => {
    const running = (open.get(name) ?? 1) - 1;
    if (running > 0) open.set(name, running);
    else open.delete(name);
    const one = ended.get(name) ?? { count: 0, ms: 0 };
    ended.set(name, { count: one.count + 1, ms: one.ms + (deps.now() - startedAt) });
  };

  const handle = deps.setInterval(() => {
    if (stopped) return;
    const time = deps.now();
    const late = time - last - deps.sampleMs;
    last = time;
    const threshold = deps.thresholdMs();
    const list = [...ended].map(([name, one]) => ({ name, ...one })).sort((a, b) => b.ms - a.ms);
    ended = new Map();
    if (threshold > 0 && late > threshold)
      deps.log.warn('core: event loop stalled', { stalledMs: late, open: [...open.keys()], ended: list });
  }, deps.sampleMs);
  handle.unref?.();

  return {
    track<T>(name: string, fn: () => T): T {
      const startedAt = deps.now();
      open.set(name, (open.get(name) ?? 0) + 1);
      let result: T;
      try {
        result = fn();
      } catch (error) {
        close(name, startedAt);
        throw error;
      }
      if (result instanceof Promise) {
        return result.finally(() => close(name, startedAt)) as T;
      }
      close(name, startedAt);
      return result;
    },
    stop() {
      if (stopped) return;
      stopped = true;
      deps.clearInterval(handle);
    },
  };
}

/** `diagnostics.loopStallMs` from the config: 0 or more, the schema default when missing or unusable. */
export function loopStallMs(config: unknown): number {
  const value = (config as { diagnostics?: { loopStallMs?: unknown } } | null)?.diagnostics?.loopStallMs;
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : DEFAULT_LOOP_STALL_MS;
}

export const DEFAULT_LOOP_STALL_MS = 1000;
