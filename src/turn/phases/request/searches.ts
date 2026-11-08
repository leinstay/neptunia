// The second step of a turn's request: which searches the turn may run. The request phase
// (src/turn/phases/request.ts) runs it after the setup; the lookup step and `<senses>` read what it decided.

import type { PhaseContext } from '../context.ts';
import type { Prepared } from '../request.ts';

/** What the searches step decided: the web lookup, the web search and the server search. */
export type Planned = {
  webLookupOn: boolean;
  webSearchOn: boolean;
  serverOn: boolean;
};

/**
 * The searches this turn may run: the web lookup when the runner has a lookup client, the web search when
 * `web.quickSearch.enabled` is not false and the client searches, and the server search (a private chat only on its
 * partner's behalf). Asked once, so the lookup stage and `<senses>` agree.
 */
export function planRequest(ctx: PhaseContext, turn: Pick<Prepared, 'isDm' | 'config' | 'likeServer'>): Planned {
  const { lookup, recallAvailable } = ctx;
  const { isDm, config, likeServer } = turn;
  const webLookupOn = Boolean(lookup);
  const quickSearch = config.web?.quickSearch;
  const webSearchOn = webLookupOn && quickSearch?.enabled !== false && typeof lookup?.search === 'function';
  const serverOn = (!isDm || likeServer) && recallAvailable();
  return { webLookupOn, webSearchOn, serverOn };
}
