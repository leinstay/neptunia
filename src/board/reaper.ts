// The board's reaper: on its interval it returns the tasks whose lease expired to `approved` and purges the
// idempotency keys past 24 hours (Board.reap). A failing reap is logged and the timer goes on. The core's scheduler
// starts it; a test calls `tick` itself.

import type { Board } from './board.ts';

export function startReaper(
  board: Pick<Board, 'reap'>,
  options: { intervalMs: number; log: (line: string) => void }
): { tick(): void; stop(): void } {
  const { intervalMs, log } = options;
  const tick = (): void => {
    try {
      const ids = board.reap();
      if (ids.length) log(`reaper: lease expired on ${ids.join(', ')}`);
    } catch (error) {
      log(`reaper: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}`);
    }
  };
  const timer = setInterval(tick, intervalMs);
  return { tick, stop: () => clearInterval(timer) };
}
