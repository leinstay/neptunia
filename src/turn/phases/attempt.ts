// One attempt of a turn: its draft created, its phases run in order, the attempt closed, what its turn's end reads
// noted, and the report runTurn hears. createTurnRunner (src/behavior/turn.ts) hands every attempt of a turn here
// (runTurnOnce); src/turn/outcome.ts runs the attempts of a turn and writes their journal records.

import type { TrackedParams } from '../../behavior/turn-types.ts';
import { createLimits } from '../../llm/limits.ts';
import type { Draft } from '../draft.ts';
import { createHandles } from '../handles.ts';
import type { JournalNotes } from '../journal-notes.ts';
import type { Outcome, TurnParams } from '../outcome.ts';
import { actPhase } from './act.ts';
import type { AttemptResult, PhaseContext } from './context.ts';
import { attemptReport, closeAttempt, outcomeOfError, outcomePhase } from './outcome.ts';
import { preflight } from './preflight.ts';
import { requestPhase } from './request.ts';
import { responsePhase } from './response.ts';
import { toolRoundPhase } from './tool-round.ts';

/** What an attempt reads beyond the phases' context: where a turn's facts and her think are kept at its end. */
export type AttemptContext = PhaseContext & Pick<Outcome, 'recordTurnFacts'> & Pick<JournalNotes, 'recordTurnThink'>;

/** An attempt's first draft: its limits, its handles, and the context and the restriction the turn was opened with. */
function draftOf(args: TurnParams): Draft {
  const { memoryContext, publicationBoundary } = args;
  return { limits: createLimits(), memoryContext, publicationBoundary, handles: createHandles() } as Draft;
}

/**
 * One attempt, as runTurn describes a turn. The request phase sets the draft's `tools` and the response phase its
 * `format` before any phase reads them (src/turn/draft.ts).
 */
export async function runAttempt(ctx: AttemptContext, args: TurnParams): Promise<AttemptResult> {
  const draft = draftOf(args);
  // `runTurn` names the chat of every attempt (TurnParams types it as optional) and adds the attempts to
  // journal and the end facts (src/turn/outcome.ts).
  const params = args as Parameters<typeof preflight>[1] & TrackedParams;
  let result;
  try {
    const opened = await preflight(ctx, params, draft);
    if (opened.ended) {
      result = opened.ended;
    } else {
      try {
        const prepared = await requestPhase(ctx, params, draft, opened);
        const answered = prepared.ended ? prepared : await responsePhase(ctx, params, draft, prepared);
        const acting = answered.ended ? answered : actPhase(ctx, params, draft, answered);
        const rounded = acting.ended ? acting : await toolRoundPhase(ctx, params, draft, acting);
        result = rounded.ended ?? outcomePhase(ctx, draft, rounded);
      } catch (err) {
        result = outcomeOfError(ctx, params, draft, opened, err);
      } finally {
        closeAttempt(ctx, params, draft, opened);
      }
    }
  } finally {
    // An attempt whose turn.start was written closes with its turn record at runTurn's exit,
    // whatever it returned (a throw counts as `error`).
    if (draft.started) params.journalAttempts?.push({ draft, result: result ?? { outcome: 'error' } });
    const { turnEnds } = params;
    if (turnEnds) {
      if (draft.info) turnEnds.info = draft.info;
      turnEnds.replyTargets.push(...(draft.replyTargets ?? []));
      turnEnds.folded.push(...(draft.folded ?? []));
      if (typeof draft.reason === 'string') turnEnds.reasons.push(draft.reason);
      if (draft.factsShown) turnEnds.factsShown = draft.factsShown;
    }
    // What an addressed turn lost, kept for her next request there (an inner turn's go to the inner life).
    if (!args.inner) ctx.recordTurnFacts(args, draft);
    ctx.recordTurnThink(args, draft, result);
  }
  return attemptReport(params, draft, result);
}
