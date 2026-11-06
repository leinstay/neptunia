// What follows a call's turn and what became of a call that waited. A turn someone asked for (a mention, reply, name,
// follow-up or private message) that a rail refused gets one plain line naming the limit and the numbers
// (labels.limits.notice), so the requester knows it was a limit and not silence in character. Spontaneous turns never
// come through here; an overheard turn does, and nobody asked for it: it stays silent too. A held call is looked up
// again before it is answered.
// createMessageHandler (src/behavior/pipeline.ts) builds it once with createCallOutcome.

import { postLimitNotice } from '../behavior/limits.ts';
import type { Reads } from '../interface/reads.ts';
import type { ConversationRef } from './conversations.ts';
import type { Conv, Line, PipelineHot, TriggerKind, TurnResult } from './types.ts';

/** A rail's limit as the notice quotes it (src/behavior/limits.ts#postLimitNotice). */
export type NoticeLimit = Parameters<typeof postLimitNotice>[0]['limit'];

/** What became of a held call while it waited (heldCallState). */
export type HeldState = true | 'gone' | 'error';

/** What createCallOutcome reads: the dependencies of createMessageHandler and the conversation reference. */
export type CallOutcomeContext = {
  hot: PipelineHot;
  reads: Reads;
  refOf: (channel: Conv) => ConversationRef;
  port: Parameters<typeof postLimitNotice>[0]['port'];
};

export type CallOutcome = {
  notifyLimit: (channel: Conv, trigger: Line, limit: NoticeLimit, triggerKind: TriggerKind) => Promise<void>;
  announceRefusal: (channel: Conv, trigger: Line, result: TurnResult, triggerKind: TriggerKind) => Promise<void>;
  afterCallTurn: (channel: Conv, trigger: Line, result: TurnResult, kind: TriggerKind) => Promise<void>;
  heldCallState: (channel: Conv, messageId: string) => Promise<HeldState>;
};

/**
 * The `mention: dropped` reason for a call messageStillExists did not find:
 * `gone` (deleted) or `fetch-failed` (the lookup failed; it may still exist).
 */
export function missingReason(missing: 'gone' | 'error'): 'gone' | 'fetch-failed' {
  return missing === 'gone' ? 'gone' : 'fetch-failed';
}

export function createCallOutcome({ hot, reads, refOf, port }: CallOutcomeContext): CallOutcome {
  /**
   * Post the limit notice in `channel` (src/behavior/limits.ts#postLimitNotice: labels read now). A follow-up's notice
   * is never a platform reply, like the follow-up turn itself. Never throws.
   */
  async function notifyLimit(
    channel: Conv,
    trigger: Line,
    limit: NoticeLimit,
    triggerKind: TriggerKind
  ): Promise<void> {
    await postLimitNotice({
      channel,
      trigger,
      limit,
      asReply: triggerKind !== 'followUp',
      // postLimitNotice reads the labels it is given, a missing labels file as none.
      labels: hot.prompts?.labels as object,
      port,
    });
  }

  /**
   * After a triggered turn: a rail refusal that carries its limit gets the notice in `channel` -- except on an overheard
   * turn, which nobody asked for.
   */
  async function announceRefusal(
    channel: Conv,
    trigger: Line,
    result: TurnResult,
    triggerKind: TriggerKind
  ): Promise<void> {
    if (triggerKind === 'overheard') return;
    if (result?.outcome !== 'refused' || !result.limit) return;
    // A refused turn's limit carries its numbers (src/turn/outcome.ts).
    await notifyLimit(channel, trigger, result.limit as NoticeLimit, triggerKind);
  }

  /** After the reply turn of a server call, the live path and the drain alike: a refusal gets its limit notice. */
  async function afterCallTurn(channel: Conv, trigger: Line, result: TurnResult, kind: TriggerKind): Promise<void> {
    await announceRefusal(channel, trigger, result, kind);
  }

  /**
   * Whether the held call `messageId` written in `channel` is still there to answer, as the interface says: `true`,
   * `'gone'` (missing: deleted) or `'error'` (the read failed, so it may still exist; never read as deleted).
   */
  async function heldCallState(channel: Conv, messageId: string): Promise<HeldState> {
    const found = await reads.fetchMessages(refOf(channel), [messageId]);
    if (found === null) return 'error';
    const { messages } = found;
    return messages[0]?.missing === true || messages.length === 0 ? 'gone' : true;
  }

  return { notifyLimit, announceRefusal, afterCallTurn, heldCallState };
}
