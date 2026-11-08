// Whether the work of the moment is unrecorded: a turn over a line of the `service` client (src/interface/principals.ts),
// carried through its awaits. The lead, the development agents and scripts check the persona through that client, and
// such a turn answers like any other while it leaves no trace in her memory. runTurn (src/turn/outcome.ts) enters the
// mark for a turn it is asked to run unrecorded, and the event producers enter it for a line of that client
// (src/behavior/core-message-producers.ts). The journal notes, the turn facts, the skill uses, the missed-answer
// registry and the owner's chat read it at the moment they would record something (docs/cli.md, "The service client").

import { AsyncLocalStorage } from 'node:async_hooks';

const mark = new AsyncLocalStorage<true>();

/** Runs `work` unrecorded when `isUnrecordedWork` is true, else as it is. */
export function runUnrecorded<TResult>(isUnrecordedWork: boolean, work: () => TResult): TResult {
  return isUnrecordedWork ? mark.run(true, work) : work();
}

/** Whether the current work is unrecorded. */
export function isUnrecorded(): boolean {
  return mark.getStore() === true;
}
