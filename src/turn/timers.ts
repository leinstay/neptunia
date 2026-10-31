// The clock side of a turn's preparation: the stages `turn: timings` names, the signal a turn throws once its bar has
// passed, the typing indicator's refresh, the real timer behind `schedule` and the record of one preparation stage.
// src/behavior/turn.js uses them for every attempt.

/** The stages of a turn's preparation, in the order `turn: timings` names them. */
export const PREPARE_STAGES = Object.freeze([
  'history',
  'previews',
  'captions',
  'videos',
  'rewatch',
  'links',
  'lookup',
  'neighbors',
  'pulled',
  'participation',
]);

/** What a turn throws to itself once its bar (pace.dropAfterMs) has passed: caught by runTurnOnce. */
export const TOO_SLOW = Symbol('too-slow');

// A chat platform shows a typing indicator for about ten seconds: it is sent again before it fades.
export const PREPARE_TYPING_REFRESH_MS = 8000;

/** The real timer behind createTurnRunner's `schedule`: `fn` once after `ms`; resolves a cancel function. */
export function scheduleTimer(fn: () => void, ms: number): () => void {
  const timer = setTimeout(fn, ms);
  return () => clearTimeout(timer);
}

export type Stage = { done: boolean; value: unknown; ms: number | null; settled: Promise<void> | null };

/**
 * One stage of a turn's preparation: `work()` started now, its outcome kept
 * on the returned record once it settles -- `value` (undefined after a
 * failure, which `onError` hears of), `ms` since `startedAt` on `clock`, and
 * `done`. `settled` never rejects, so a stage the turn no longer waits for
 * can never surface as an unhandled rejection.
 */
export function trackStage(
  work: () => unknown,
  { clock, startedAt, onError }: { clock: () => number; startedAt: number; onError: (err: unknown) => void }
): Stage {
  const stage: Stage = { done: false, value: undefined, ms: null, settled: null };
  stage.settled = new Promise((resolve) => resolve(work()))
    .then(
      (value) => {
        stage.value = value;
      },
      (err) => {
        try {
          onError(err);
        } catch {
          // A failing log line never fails the stage.
        }
      }
    )
    .then(() => {
      stage.ms = clock() - startedAt;
      stage.done = true;
    });
  return stage;
}
