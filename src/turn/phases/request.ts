// The second phase of a turn attempt: everything before the reply request, built from what the turn prepared. Its
// steps live in src/turn/phases/request/: the setup, the searches, the pulls, the stages, the second look, the lookup,
// the wait, the gather, the facts and the build. runAttempt (src/turn/phases/attempt.ts) calls it after the preflight; the
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

/**
 * What the request phase made, as one flat record: what the preflight opened, each step's own fields spread over it in
 * order, and the request. Every step names the fields it reads as a `Pick` of this record.
 */
export type Prepared = Opened &
  Setup &
  Planned &
  Pulled &
  Staged &
  SecondLook &
  Looked &
  Waited &
  Gathered &
  Told & { ended: null; request: BuiltRequest };

export async function requestPhase(
  ctx: PhaseContext,
  params: PhaseParams,
  draft: Draft,
  opened: Opened
): Promise<Ended | Prepared> {
  const track = ctx.track ?? untracked;
  const setup = await track('turn.setup', () => setupRequest(ctx, params, draft, opened));
  if (setup.ended) return setup;
  const set = { ...opened, ...setup };
  const planned = { ...set, ...planRequest(ctx, set), ...pullRequest(params, set) };
  const staged = { ...planned, ...startStages(ctx, params, planned) };
  const second = { ...staged, ...startSecondLook(ctx, params, staged) };
  const looked = { ...second, ...startLookup(ctx, second) };
  const waited = await waitForPreparation(ctx, draft, looked);
  if (waited.ended) return waited;
  const ready = { ...looked, ...waited };
  const gathered = { ...ready, ...(await track('turn.gather', () => gatherRequest(ctx, draft, ready))) };
  const told = { ...gathered, ...(await track('turn.facts', () => tellFacts(ctx, params, draft, gathered))) };
  const request = track('turn.build', () => buildTurnRequest(ctx, params, draft, told));
  return { ...told, ended: null, request };
}
