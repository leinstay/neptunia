// The clock of the persona's behaviours: spontaneous talk, the diary and the inner life each register a beat, and
// one timer waits for the earliest of them. A wait ends in a `scheduler.tick` event submitted through the event
// door, and the door's handler calls `dispatch(at)`, which starts every beat that is due. A beat runs on its own
// from there (its tick guards its own overlap), so a slow beat never holds a fast one back and never holds the
// timer. Each beat's interval is read when the beat is scheduled, so a changed setting applies from the next wait.
// The housekeeping timers of the composition root (flushes, queues, metrics) are not beats.

import type { Logger } from '../protocol/serve.ts';

/** A beat: `run(at)` is called with the time of the tick that found it due. */
export type Beat = { name: string; everyMs: () => number; run: (at: number) => unknown };

export type SchedulerTick = { kind: 'scheduler.tick'; at: number };

/** The wait used when a beat's interval is not a positive number. */
const FALLBACK_EVERY_MS = 30_000;

type Scheduled = { beat: Beat; dueAt: number };

export function createScheduler(options: {
  submit: (event: SchedulerTick) => Promise<unknown>;
  now: () => number;
  setTimer: (fn: () => void, ms: number) => () => void;
  log: Logger;
}): {
  add(beat: Beat): void;
  start(): void;
  stop(): void;
  dispatch(at: number): { started: Array<string> };
} {
  const { submit, now, setTimer, log } = options;
  const beats: Array<Scheduled> = [];
  let clear: (() => void) | null = null;
  let running = false;
  let ticking = false;

  function intervalOf(beat: Beat): number {
    let ms = FALLBACK_EVERY_MS;
    try {
      const value = beat.everyMs();
      if (Number.isFinite(value) && value > 0) ms = value;
    } catch (error) {
      log.warn('scheduler: interval unreadable', { beat: beat.name, error });
    }
    return ms;
  }

  function disarm(): void {
    clear?.();
    clear = null;
  }

  function arm(): void {
    disarm();
    if (!running || ticking || beats.length === 0) return;
    const earliest = Math.min(...beats.map((entry) => entry.dueAt));
    clear = setTimer(fire, Math.max(0, earliest - now()));
  }

  // Beats still due at `at` after a tick that did not run them (a door that refused it) wait a whole interval
  // again, so a failing door never makes the timer fire without time passing.
  function postpone(at: number): void {
    for (const entry of beats) if (entry.dueAt <= at) entry.dueAt = at + intervalOf(entry.beat);
  }

  function fire(): void {
    clear = null;
    const at = now();
    ticking = true;
    submit({ kind: 'scheduler.tick', at })
      .catch((error: unknown) => log.warn('scheduler: tick not taken', { error }))
      .finally(() => {
        ticking = false;
        postpone(at);
        arm();
      });
  }

  function startBeat(beat: Beat, at: number): void {
    const failed = (error: unknown): void => log.warn('scheduler: beat failed', { beat: beat.name, error });
    try {
      const result = beat.run(at);
      if (result instanceof Promise) result.catch(failed);
    } catch (error) {
      failed(error);
    }
  }

  return {
    add(beat) {
      beats.push({ beat, dueAt: now() + intervalOf(beat) });
      arm();
    },
    start() {
      running = true;
      for (const entry of beats) entry.dueAt = now() + intervalOf(entry.beat);
      arm();
    },
    stop() {
      running = false;
      disarm();
    },
    dispatch(at) {
      const started: Array<string> = [];
      for (const entry of beats) {
        if (entry.dueAt > at) continue;
        entry.dueAt = at + intervalOf(entry.beat);
        started.push(entry.beat.name);
        startBeat(entry.beat, at);
      }
      return { started };
    },
  };
}
