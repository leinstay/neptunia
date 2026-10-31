// The facts kept for her next request in a conversation: the inner life keeps them in its state when it is on
// (src/behavior/inner.ts, `setFactsSource`), else they are kept in process. An addressed reply turn that ended `error`
// or `refused` (`failedTurn`: `{ messageId, authorId, code }`, kept `FAILED_TURN_KEEP_MS` and at most
// `context.failedTurnsKept`, told by `labels.task.failedEarlier`) and what a turn lost (`sendFailed`, `loopCut`,
// `callFailed`, `wakeDropped`, ...: `labels.wake.feedbackInTurn`). A fact is told once a completed answer carried it.
// createTurnRunner (src/behavior/turn.js) builds it once per runner with createFacts; the journal notes, the attempt
// and the outcome read the store of the moment through `facts`.

import { createLocalFacts } from '../behavior/inner.ts';
import type { FactsApi } from '../behavior/inner.ts';

export type FactsContext = { clock: () => number };

export type Facts = {
  /** The facts store of the moment: the inner life's while its `enabled()` says so, else the runner's own. */
  facts: () => FactsApi;
  setFactsSource: (source: FactsApi | null | undefined) => void;
};

export function createFacts(ctx: FactsContext): Facts {
  const { clock } = ctx;
  let factsSource: FactsApi | null = null;
  const localFacts = createLocalFacts({ now: () => clock() });
  const facts = (): FactsApi => (factsSource?.enabled?.() === true ? factsSource : localFacts);
  return {
    facts,
    setFactsSource: (source) => {
      factsSource = source ?? null;
    },
  };
}
