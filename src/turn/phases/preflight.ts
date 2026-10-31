// The first phase of a turn attempt: the pause and the attention taken, the conversation as the interface describes
// it now, the journal's start and the wait for the trigger's author to finish writing. runTurnOnce
// (src/behavior/turn.js) calls it before every other phase; what it opens, the later phases use and the attempt's
// end closes.

import { createPrepLedger } from '../../behavior/turn-parts.ts';
import type { Ledger } from '../../behavior/turn-parts.ts';
import { log } from '../../log.js';
import type { ConversationInfo } from '../../protocol/adapter.ts';
import type { Draft } from '../draft.ts';
import { journalStartOf } from '../journal.ts';
import type { JournalStep } from '../lookup.ts';
import { inCommunity } from '../routing.ts';
import { takeAttention } from '../triggers.ts';
import type { Ended, Life, PhaseContext, PhaseParams } from './context.ts';

/** What the preflight opened: the conversation, the community it is served for and the attempt's lifecycle. */
export type Opened = {
  ended: null;
  prep: Ledger;
  prepStep: JournalStep;
  channel: ConversationInfo;
  guildId: string;
  isPrivate: boolean;
  settledMs: number;
  life: Life;
};

export async function preflight(ctx: PhaseContext, params: PhaseParams, draft: Draft): Promise<Ended | Opened> {
  const { hot, store, busy, ifaceReads, journal, journalOp, journalOn, notifyIdle, settleAuthor, clock } = ctx;
  const {
    conversation,
    guildId: guildIdParam = null,
    mode,
    trigger = null,
    triggerKind = null,
    reuseHistory = null,
    owned = false,
    journalTurn = null,
    taskResult = null,
    inner = null,
    standIn = null,
  } = params;
  // The journal's preparation steps of this attempt (createPrepLedger): each an operation of
  // the engine, closed with whether its result reached the request.
  const prep = createPrepLedger();
  const prepStep: JournalStep = (stage, name, fields, offeredOf) => {
    const op = journalOp(draft, name, 'engine', fields);
    // The ledger's step starts the journal operation, a promise of nothing, and hands `offeredOf` the result the
    // step succeeded with, which is the stage's own result.
    const offered = offeredOf as ((result: Record<string, unknown>) => unknown) | undefined;
    return op.opId ? (prep.step(stage, op, offered) as NonNullable<ReturnType<JournalStep>>) : null;
  };
  // An inner turn (mode `inner`, src/behavior/inner.ts): her calls pass its gate (innerVerdict).
  if (inner && mode === 'inner') draft.inner = inner;
  // The turn a finished errand of her own opens (asked in an inner turn: requester kind
  // `persona`, no person behind it) is her own initiative too: her grants alone decide her calls.
  if (taskResult?.requester?.kind === 'persona' && !taskResult.requester.userId) draft.ownInitiative = true;
  // /nep pause: the owner is editing data/ by hand -- no new turn may start (a reply, an interject, an initiate, an
  // eavesdrop, or a forced turn) until /nep resume. A turn already in flight when the pause is requested is left to
  // finish naturally; admin.js's pause handler waits for it via waitIdle() below instead of aborting it here.
  if (store.state.data.paused) return { ended: { outcome: 'paused' } };
  // A chain's turn runs under the attention it holds; taken before anything is awaited, so two turns cannot both take it.
  const attentionId = conversation.conversationId;
  if (!owned && !takeAttention(busy, attentionId, hot.config)) return { ended: { outcome: 'busy' } };
  const letGo = () => {
    if (owned) return;
    busy.delete(attentionId);
    notifyIdle();
  };
  // The conversation as the interface describes it now (a wake's own, `standIn`); one it no longer knows ends the turn.
  const found = standIn
    ? { conversation: standIn }
    : await ifaceReads.conversationInfo(conversation, { audience: true, viewers: [] });
  if (found === null) {
    letGo();
    log.warn('turn: conversation unavailable', { channel: conversation.conversationId });
    return { ended: { outcome: 'unavailable' } };
  }
  const channel = found.conversation;
  draft.info = channel;
  // A conversation of a community carries it; a private chat is served on behalf of the pinned one.
  const guildId = channel.communityId ?? guildIdParam;
  if (!guildId) {
    letGo();
    throw new Error('runTurn: a private chat needs a guildId');
  }
  const isPrivate = !inCommunity(channel);
  // The journal (features.journal, read now): the turn starts here, past the pause and
  // attention rails; a later attempt of the same turn (journalTurn) keeps its id.
  if (journalOn()) {
    draft.guildId = guildId;
    draft.channelId = channel.id;
    draft.privateUserId = isPrivate ? (trigger?.authorId ?? channel.partnerId ?? null) : null;
    draft.mode = mode;
    draft.started = journal.start(guildId, journalStartOf({ draft, channel, trigger, triggerKind, mode, journalTurn }));
  }
  // A turn answering a person first lets them finish writing (pace.settleMs), holding the
  // attention meanwhile; the turn's clocks (its deadline, its bar) start after this wait. The
  // first part of a split message reuses the history its message already waited for. The
  // author's activity is read in the trigger's own channel (a routed call's turn posts elsewhere).
  const settledMs =
    mode === 'reply' && !reuseHistory ? await settleAuthor(trigger?.channelId ?? channel.id, trigger) : 0;
  // The typing indicator, the preparation's deadline and the turn's bar, ended at the attempt's end
  // whatever the outcome; the start and the mode a dropped turn logs. The turn planner is abandoned
  // there if it never started; `chained` is set when this turn hands its message to a chain of parts.
  const life: Life = {
    stopTyping: () => {},
    deadline: null,
    bar: null,
    planner: null,
    chained: false,
    turnStartedAt: clock(),
    turnMode: mode,
  };
  return { ended: null, prep, prepStep, channel, guildId, isPrivate, settledMs, life };
}
