// The last phase of a turn attempt: what its steps posted, noted for the journal, the end hook and the pending pings,
// a selfreflection post's entry recorded before any publication, and the result the attempt returns. Beside it, how an attempt
// that threw ends (outcomeOfError) and what every attempt past its preflight closes whatever it returned
// (closeAttempt), and what runTurn hears of the attempt (attemptReport). runAttempt (src/turn/phases/attempt.ts)
// calls them all.

import { audienceChoice, turnBoundary } from '../../tools/publication.ts';
import { recordEntry } from '../../behavior/selfreflection-turn.ts';
import { NO_PLACES, publicationPlaces, readMirrors } from '../../behavior/mirror.ts';
import { limitOf } from '../../behavior/limits.ts';
import { DailyCapError, TokenLimitError, errorCodeOf, railReason } from '../../llm/openrouter.ts';
import { log } from '../../log.ts';
import { skillUsesOfTurn } from '../../skills/uses.ts';
import { effectsOf } from '../../tools/definitions.ts';
import type { AudienceChoice } from '../../tools/publication.ts';
import type { HeldSpeech } from '../act.ts';
import type { Draft } from '../draft.ts';
import { SKIP_NOTHING_TO_DO, untoldDiagnostics } from '../journal.ts';
import { NO_LOOP } from '../settings.ts';
import { TOO_SLOW, TURN_CANCELLED } from '../timers.ts';
import type { AttemptResult, PhaseContext, PhaseParams } from './context.ts';
import type { Opened } from './preflight.ts';
import type { Rounded } from './tool-round.ts';

/** What her `<audience>` tags came to, over the places memory knows now. A refused one is logged by its code. */
function audienceOfTurn(store: unknown, draft: Draft): AudienceChoice {
  const choice = audienceChoice(draft.selfreflectionAudience ?? [], readMirrors(store, publicationPlaces, NO_PLACES));
  if (!choice.ok) log.warn('selfreflection: audience refused', { code: choice.code });
  return choice;
}

/** A call that changed nothing: refused, failed, or a read. A proposal in shadow mode is what the turn did, so it is none. */
function changedNothing(action: { skill?: unknown; status?: unknown }): boolean {
  if (action.status === 'refused' || action.status === 'failed') return true;
  return action.status === 'executed' && effectsOf(String(action.skill)) === 'read';
}

/** An inner turn that said nothing, reacted to nothing, changed nothing and answered skip last: it skipped, whatever it read. */
function isQuietInner(draft: Draft, stepped: Rounded['stepped']): boolean {
  if (draft.inner === undefined || draft.inner === null || !stepped.skipped) return false;
  const reached = stepped.acts.some(
    (acted) => acted.delivered === true || (acted.posts?.length ?? 0) > 0 || (acted.reacted?.length ?? 0) > 0
  );
  return !reached && (draft.innerActions ?? []).every((action) => changedNothing(action as Record<string, unknown>));
}

/** What the outcome phase reads of the attempt. */
type OutcomeNeeds = Pick<
  Rounded,
  'channel' | 'now' | 'finalMode' | 'history' | 'selfreflectionPrep' | 'notAnswered' | 'folded' | 'stepped'
>;

export function outcomePhase(ctx: PhaseContext, draft: Draft, turn: OutcomeNeeds): AttemptResult {
  const { hot, store, noteSpokeSaw, recordSkillUses } = ctx;
  const { channel, now, finalMode, history, selfreflectionPrep, notAnswered, folded, stepped } = turn;
  // The lines her steps read carry their message ids, as the history's do.
  const loopSeen = (draft.loopSeen ?? []) as ReadonlyArray<{ id: string }>;
  noteSpokeSaw(channel, [...history, ...loopSeen], notAnswered);
  // The lines its settle wait read as part of the call, answered with it, for the end hook (noteTurnEnd).
  draft.folded = [...folded];
  const acts = stepped.acts;
  if (draft.started) {
    draft.posted = acts.flatMap((acted) => acted.posts ?? []);
    draft.reactions = acts.flatMap((acted) => acted.reacted ?? []);
  }
  // The messages its posts replied to, for the end hook (noteTurnEnd), journal or not.
  draft.replyTargets = acts
    .flatMap((acted) => acted.posts ?? [])
    .map((post) => post?.replyTo)
    .filter((id): id is string => typeof id === 'string' && Boolean(id));
  // A selfreflection post holds what it would send (holdSpeech): the entry is recorded and counted before any publication.
  const held = acts.filter((one): one is HeldSpeech => 'held' in one && one.held === true);
  const recorded =
    selfreflectionPrep && held.length > 0
      ? {
          selfreflection: recordEntry({
            publicationBoundary: turnBoundary(draft, ctx.chatOf(channel)),
            audience: audienceOfTurn(store, draft),
            ...(draft.started?.turnId ? { turnId: draft.started.turnId } : {}),
            store,
            config: hot.config,
            now,
            plan: selfreflectionPrep.plan,
            held: {
              texts: held.flatMap((one) => one.texts),
              // The entry keeps the mentions as the act rendered them; its type names them as member ids.
              rendered: held.flatMap((one) => one.rendered) as Parameters<typeof recordEntry>[0]['held']['rendered'],
            },
            staged: held.findLast((one) => one.staged.length > 0)?.staged ?? [],
            set: Boolean(draft.selfreflection?.set),
            voice: draft.selfreflectionVoice ?? null,
          }),
        }
      : {};
  // The use of her skills this turn: what her request showed and what her calls did with it.
  if (recordSkillUses != null && (draft.skillsIndexed?.length ?? 0) > 0) {
    const uses = skillUsesOfTurn({
      turnId: draft.started?.turnId ?? `turn:${now}`,
      at: now,
      index: draft.skillsIndexed ?? [],
      calls: draft.skillCalls ?? [],
    });
    recordSkillUses(uses).catch((error: unknown) =>
      log.warn('skills: uses not recorded', { count: uses.length, code: errorCodeOf(error) })
    );
  }
  if (isQuietInner(draft, stepped)) return { outcome: 'skip', mode: finalMode, reason: SKIP_NOTHING_TO_DO };
  // A selfreflection turn that held no speech recorded no entry: ended on her skip, it skipped, whatever it called.
  if (selfreflectionPrep && stepped.skipped && held.length === 0)
    return { outcome: 'skip', mode: finalMode, reason: SKIP_NOTHING_TO_DO };
  // An inner turn in shadow mode delivers nothing, whatever it proposed.
  const delivered = stepped.delivered && draft.inner?.shadow !== true;
  return {
    outcome: 'spoke',
    mode: finalMode,
    delivered,
    ...recorded,
    ...(draft.sendFailure ? { partial: true } : {}),
  };
}

/** How an attempt that threw past its preflight ends: dropped at the bar, refused by a rail, or failed. */
export function outcomeOfError(
  ctx: PhaseContext,
  params: PhaseParams,
  draft: Draft,
  turn: Pick<Opened, 'channel' | 'life'>,
  err: unknown
): AttemptResult {
  const { clock } = ctx;
  const { triggerKind = null } = params;
  const { channel, life } = turn;
  if (err === TURN_CANCELLED) {
    log.info('turn: cancelled', { channel: channel.id, mode: life.turnMode, triggerKind: triggerKind ?? null });
    draft.reason = 'cancelled';
    return { outcome: 'cancelled', reason: 'cancelled' };
  }
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

/** What every attempt past its preflight closes, whatever it returned: its clocks and the attention. */
export function closeAttempt(
  ctx: PhaseContext,
  params: PhaseParams,
  draft: Draft,
  turn: Pick<Opened, 'channel' | 'prep' | 'life'>
): void {
  const { busy, notifyIdle } = ctx;
  const { owned = false } = params;
  const { channel, prep, life } = turn;
  draft.mode = life.turnMode;
  prep.closeAll();
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
