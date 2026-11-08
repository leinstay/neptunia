// The third step of a turn's request: the mode the turn is answered in, noted on its life. The request phase
// (src/turn/phases/request.ts) runs it after the searches step.

import type { PhaseParams } from '../context.ts';
import type { Opened } from '../preflight.ts';

/** What the mode step made: the turn's mode. */
export type Pulled = {
  ended: null;
  finalMode: string;
};

export function pullRequest(params: PhaseParams, turn: Pick<Opened, 'life'>): Pulled {
  const finalMode = params.mode;
  turn.life.turnMode = finalMode;
  return { ended: null, finalMode };
}
