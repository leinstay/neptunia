// The last phase of a turn attempt: what its steps posted, noted for the journal, the end hook and the pending pings,
// a diary post's entry recorded before any publication, and the result the attempt returns. Beside it, how an attempt
// that threw ends (outcomeOfError) and what every attempt past its preflight closes whatever it returned
// (closeAttempt), and what runTurn hears of the attempt (attemptReport). runTurnOnce (src/behavior/turn.js) calls
// them all.

import { recordEntry } from '../../behavior/diary-turn.ts';
import { limitOf } from '../../behavior/limits.js';
import { DailyCapError, TokenLimitError, errorCodeOf, railReason } from '../../llm/openrouter.js';
import { log } from '../../log.js';
import type { HeldSpeech } from '../act.ts';
import type { Draft } from '../draft.ts';
import { untoldDiagnostics } from '../journal.ts';
import { NO_LOOP } from '../settings.ts';
import { TOO_SLOW } from '../timers.ts';
import type { AttemptResult, PhaseContext, PhaseParams } from './context.ts';
import type { Opened } from './preflight.ts';
import type { Rounded } from './tool-round.ts';

export function outcomePhase(ctx: PhaseContext, params: PhaseParams, draft: Draft, rounded: Rounded): AttemptResult {
  const { hot, store, noteSpokeSaw, stampShownCalls } = ctx;
  const { opened, setup, pulled: pulledStep, gathered, told, stepped, serverShown, ownCallId } = rounded;
  const { channel, guildId } = opened;
  const { now } = setup;
  const { finalMode } = pulledStep;
  const { history, pulled, diaryPrep } = gathered;
  const { notAnswered } = told;
  // The lines her steps read carry their message ids, as the history's do.
  const loopSeen = (draft.loopSeen ?? []) as ReadonlyArray<{ id: string }>;
  noteSpokeSaw(channel, [...history, ...loopSeen], serverShown, pulled, notAnswered);
  const acts = stepped.acts;
  const answeredAll = new Set(acts.flatMap((acted) => [...(acted.answered ?? [])]));
  stampShownCalls({ shown: serverShown, pulled, answered: answeredAll, exceptId: ownCallId });
  if (draft.started) {
    draft.posted = acts.flatMap((acted) => acted.posts ?? []);
    draft.reactions = acts.flatMap((acted) => acted.reacted ?? []);
  }
  // The messages its posts replied to, for the end hook (noteTurnEnd), journal or not.
  draft.replyTargets = acts
    .flatMap((acted) => acted.posts ?? [])
    .map((post) => post?.replyTo)
    .filter((id): id is string => typeof id === 'string' && Boolean(id));
  // A diary post holds what it would send (holdSpeech): the entry is recorded and counted before any publication.
  const held = acts.filter((one): one is HeldSpeech => 'held' in one && one.held === true);
  const recorded =
    diaryPrep && held.length > 0
      ? {
          diary: recordEntry({
            store,
            config: hot.config,
            guildId,
            now,
            plan: diaryPrep.plan,
            held: {
              texts: held.flatMap((one) => one.texts),
              // The entry keeps the mentions as the act rendered them; its type names them as member ids.
              rendered: held.flatMap((one) => one.rendered) as Parameters<typeof recordEntry>[0]['held']['rendered'],
            },
            staged: held.findLast((one) => one.staged.length > 0)?.staged ?? [],
            set: Boolean(draft.diary?.set),
            voice: draft.diaryVoice ?? null,
          }),
        }
      : {};
  // An inner turn in shadow mode delivers nothing, whatever it proposed.
  const delivered = stepped.delivered && draft.inner?.shadow !== true;
  return {
    outcome: 'spoke',
    mode: finalMode,
    delivered,
    ...recorded,
    ...(draft.sendFailure || draft.gifFailure ? { partial: true } : {}),
  };
}

/** How an attempt that threw past its preflight ends: dropped at the bar, refused by a rail, or failed. */
export function outcomeOfError(
  ctx: PhaseContext,
  params: PhaseParams,
  draft: Draft,
  opened: Opened,
  err: unknown
): AttemptResult {
  const { clock } = ctx;
  const { triggerKind = null } = params;
  const { channel, life } = opened;
  if (err === TOO_SLOW) {
    // Past the bar: nothing is posted; `error`, like a failed request (a routed call stays unanswered).
    log.warn('turn: dropped', {
      channel: channel.id,
      mode: life.turnMode,
      triggerKind: triggerKind ?? null,
      reason: 'too-slow',
      seconds: Math.round((clock() - life.turnStartedAt) / 100) / 10,
    });
    draft.reason = 'too-slow';
    return { outcome: 'error' };
  }
  if (err instanceof DailyCapError || err instanceof TokenLimitError) {
    log.warn('turn: refused by a safety rail', { channel: channel.id, error: err });
    draft.reason = railReason(err);
    if (err instanceof DailyCapError)
      draft.limits?.add({ kind: 'daily-cap', where: limitOf(err)?.key ?? 'llm.maxRequestsPerDay' });
    return { outcome: 'refused', limit: limitOf(err) };
  }
  const code = errorCodeOf(err);
  log.error('turn: failed', { channel: channel.id, code, error: err });
  return { outcome: 'error', reason: code };
}

/** What every attempt past its preflight closes, whatever it returned: its clocks, its planner and the attention. */
export function closeAttempt(ctx: PhaseContext, params: PhaseParams, draft: Draft, opened: Opened): void {
  const { busy, notifyIdle } = ctx;
  const { owned = false } = params;
  const { channel, prep, life } = opened;
  draft.mode = life.turnMode;
  prep.closeAll();
  life.planner?.abandon('ended');
  life.stopTyping();
  life.deadline?.close();
  life.bar?.close();
  // A turn of a chain, or one that hands its message to a chain, leaves the attention and
  // the notifications to the chain (runChain), which releases them once every part is done.
  if (!owned && !life.chained) busy.delete(channel.id);
  if (!owned && !life.chained) notifyIdle();
}

/** What runTurn hears of an attempt: its result, an inner turn's report, and the journal's ids of the attempt. */
export function attemptReport(params: PhaseParams, draft: Draft, result: AttemptResult): AttemptResult {
  // An inner turn reports what it did and proposed, and its turn id (the errands it handed off name it).
  const innerTurnId = draft.started?.turnId ?? draft.turnKey?.turnId ?? null;
  const innerPart = params.inner
    ? {
        inner: {
          actions: draft.innerActions ?? [],
          intentIds: [...(draft.innerIntentIds ?? [])],
          loop: draft.innerLoop ?? { ...NO_LOOP },
          ...(untoldDiagnostics(draft).length > 0 ? { diagnostics: untoldDiagnostics(draft) } : {}),
          ...(draft.innerOpenFollowUp === true ? { openFollowUp: true } : {}),
          turnId: innerTurnId,
        },
        ...(params.inner.shadow ? { shadow: true } : {}),
      }
    : {};
  return draft.started
    ? { ...result, ...innerPart, turnId: draft.started.turnId, attemptId: draft.started.attemptId }
    : { ...result, ...innerPart };
}
