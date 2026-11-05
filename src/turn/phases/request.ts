// The second phase of a turn attempt: everything before the reply request, built from what the turn prepared. Its
// steps live in src/turn/phases/request/: the setup, the searches, the pulls, the stages, the second look, the lookup,
// the wait, the gather, the facts and the build. runTurnOnce (src/behavior/turn.ts) calls it after the preflight; the
// turn ends here when a step returns its result (a refused selfreflection picture, a source gone, nothing to choose, parts in
// time).

import { untracked } from '../../loop-watch.ts';
import type { Draft } from '../draft.ts';
import type { Ended, PhaseContext, PhaseParams } from './context.ts';
import type { Opened } from './preflight.ts';
import { buildTurnRequest } from './request/build.ts';
import type { BuiltRequest } from './request/build.ts';
import { tellFacts } from './request/facts.ts';
import type { Told } from './request/facts.ts';
import { gatherRequest } from './request/gather.ts';
import type { Gathered } from './request/gather.ts';
import { startLookup } from './request/lookup.ts';
import type { Looked } from './request/lookup.ts';
import { planRequest } from './request/searches.ts';
import type { Planned } from './request/searches.ts';
import { pullRequest } from './request/pulls.ts';
import type { Pulled } from './request/pulls.ts';
import { startSecondLook } from './request/second-look.ts';
import type { SecondLook } from './request/second-look.ts';
import { setupRequest } from './request/setup.ts';
import type { Setup } from './request/setup.ts';
import { startStages } from './request/stages.ts';
import type { Staged } from './request/stages.ts';
import { waitForPreparation } from './request/wait.ts';
import type { Waited } from './request/wait.ts';

/** What the request phase made: the request, and what each of its steps made on the way. */
export type Prepared = {
  ended: null;
  opened: Opened;
  setup: Setup;
  planned: Planned;
  pulled: Pulled;
  staged: Staged;
  second: SecondLook;
  looked: Looked;
  waited: Waited;
  gathered: Gathered;
  told: Told;
  request: BuiltRequest;
};

export async function requestPhase(
  ctx: PhaseContext,
  params: PhaseParams,
  draft: Draft,
  opened: Opened
): Promise<Ended | Prepared> {
  const track = ctx.track ?? untracked;
  const setup = await track('turn.setup', () => setupRequest(ctx, params, draft, opened));
  if (setup.ended) return setup;
  const planned = planRequest(ctx, opened, setup);
  const pulled = await track('turn.pulls', () => pullRequest(ctx, params, opened, setup));
  if (pulled.ended) return pulled;
  const staged = startStages(ctx, params, opened, setup, pulled);
  const second = startSecondLook(ctx, params, opened, setup, staged);
  const looked = startLookup(ctx, opened, setup, planned, staged);
  const waited = await waitForPreparation(ctx, params, draft, opened, setup, pulled, staged, second, looked);
  if (waited.ended) return waited;
  const gathered = await track('turn.gather', () =>
    gatherRequest(ctx, params, draft, opened, setup, pulled, staged, second, looked, waited)
  );
  const told = await track('turn.facts', () => tellFacts(ctx, params, draft, opened, setup, pulled, gathered));
  const request = track('turn.build', () =>
    buildTurnRequest(ctx, params, draft, opened, setup, planned, pulled, waited, gathered, told)
  );
  return { ended: null, opened, setup, planned, pulled, staged, second, looked, waited, gathered, told, request };
}
