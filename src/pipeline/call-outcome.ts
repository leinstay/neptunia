// What follows a call's turn and what became of a call that waited. A turn someone asked for (a mention, reply, name,
// follow-up or private message) that a rail refused gets one plain line naming the limit and the numbers
// (labels.limits.notice), so the requester knows it was a limit and not silence in character. Spontaneous turns never
// come through here; an overheard turn does, and nobody asked for it: it stays silent too. A routed call's ring entry
// (state.json `elsewherePings`) follows its turn's outcome, and a held call is looked up again before it is answered.
// createMessageHandler (src/behavior/pipeline.js) builds it once with createCallOutcome.

import { elsewhereSettings, pingStatus, pingsIn, stampPings } from '../behavior/elsewhere.ts';
import { postLimitNotice } from '../behavior/limits.js';
import type { Reads } from '../interface/reads.ts';
import { log } from '../log.js';
import type { ConversationRef } from './conversations.ts';
import type {
  Conv,
  Line,
  PipelineConfig,
  PipelineHot,
  PipelineState,
  PipelineTurns,
  TriggerKind,
  TurnResult,
} from './types.ts';

/** A rail's limit as the notice quotes it (src/behavior/limits.js#postLimitNotice). */
export type NoticeLimit = Parameters<typeof postLimitNotice>[0]['limit'];

/** How a limit notice is posted: as a platform reply to the call, or `plain`. */
type NoticeOptions = { plain?: boolean };

/** What became of a held call while it waited (heldCallState). */
export type HeldState = true | 'answered' | 'gone' | 'error';

/** What createCallOutcome reads: the dependencies of createMessageHandler and the conversation reference. */
export type CallOutcomeContext = {
  hot: PipelineHot;
  store: { state?: PipelineState } | null | undefined;
  now: () => number;
  turns: PipelineTurns;
  reads: Reads;
  refOf: (channel: Conv) => ConversationRef;
  port: Parameters<typeof postLimitNotice>[0]['port'];
};

export type CallOutcome = {
  notifyLimit: (
    channel: Conv,
    trigger: Line,
    limit: NoticeLimit,
    triggerKind: TriggerKind,
    options?: NoticeOptions
  ) => Promise<void>;
  announceRefusal: (
    channel: Conv,
    trigger: Line,
    result: TurnResult,
    triggerKind: TriggerKind,
    options?: NoticeOptions
  ) => Promise<void>;
  afterCallTurn: (
    channel: Conv,
    trigger: Line,
    result: TurnResult,
    kind: TriggerKind,
    destination?: Conv | null
  ) => Promise<void>;
  passRoutedCall: (messageId: string, superseded?: Array<string>) => void;
  skipSeenCalls: (sourceId: string, messageId: string) => void;
  heldCallState: (channel: Conv, messageId: string, routed: boolean) => Promise<HeldState>;
};

/**
 * `{ destination: id }` for the log lines of a routed call (anything
 * carrying the channel its turn posts in as `destination`: a call, a
 * pending ping), `{}` for any other.
 */
export function routedFields({ destination }: { destination?: Conv | null }): { destination?: string } {
  return destination ? { destination: destination.id } : {};
}

/**
 * Whether the switch that lets a server call of `kind` through (onMessage
 * step 8) is off in `features` now: features.replies for a reply,
 * features.nameTriggers for a name, features.mentions for a mention.
 */
export function callSwitchOff(kind: TriggerKind, features: NonNullable<PipelineConfig['features']>): boolean {
  if (kind === 'reply') return features.replies === false;
  if (kind === 'name') return features.nameTriggers === false;
  return features.mentions === false;
}

/**
 * The `mention: dropped` reason for a call messageStillExists did not find:
 * `gone` (deleted) or `fetch-failed` (the lookup failed; it may still exist).
 */
export function missingReason(missing: 'gone' | 'error'): 'gone' | 'fetch-failed' {
  return missing === 'gone' ? 'gone' : 'fetch-failed';
}

export function createCallOutcome({ hot, store, now, turns, reads, refOf, port }: CallOutcomeContext): CallOutcome {
  /**
   * Post the limit notice in `channel` (src/behavior/limits.js#postLimitNotice:
   * labels, dry-run and the mirror read now). A follow-up's notice is never a
   * platform reply, like the follow-up turn itself; nor is one posted `plain`
   * (a routed call's, whose trigger lives in another channel). Never throws.
   */
  async function notifyLimit(
    channel: Conv,
    trigger: Line,
    limit: NoticeLimit,
    triggerKind: TriggerKind,
    { plain = false }: NoticeOptions = {}
  ): Promise<void> {
    await postLimitNotice({
      channel,
      trigger,
      limit,
      asReply: !plain && triggerKind !== 'followUp',
      // postLimitNotice reads the labels it is given, a missing labels file as none.
      labels: hot.prompts?.labels as object,
      config: hot.config,
      port,
    });
  }

  /**
   * After a triggered turn: a rail refusal that carries its limit gets the
   * notice in `channel` -- except on an overheard turn, which nobody asked
   * for. `plain`: see notifyLimit.
   */
  async function announceRefusal(
    channel: Conv,
    trigger: Line,
    result: TurnResult,
    triggerKind: TriggerKind,
    { plain = false }: NoticeOptions = {}
  ): Promise<void> {
    if (triggerKind === 'overheard') return;
    if (result?.outcome !== 'refused' || !result.limit) return;
    // A refused turn's limit carries its numbers (src/turn/outcome.ts).
    await notifyLimit(channel, trigger, result.limit as NoticeLimit, triggerKind, { plain });
  }

  /**
   * After the reply turn of a server call, the live path and the drain alike:
   * a rail refusal gets its limit notice (announceRefusal). A routed call
   * (`destination`: the channel its turn posted in) gets it there, as a plain
   * message -- never a platform reply to a message of another channel -- and its
   * ring entry follows the outcome (markRoutedCall).
   */
  async function afterCallTurn(
    channel: Conv,
    trigger: Line,
    result: TurnResult,
    kind: TriggerKind,
    destination: Conv | null = null
  ): Promise<void> {
    if (!destination) {
      await announceRefusal(channel, trigger, result, kind);
      return;
    }
    markRoutedCall(trigger.id, result);
    await announceRefusal(destination, trigger, result, kind, { plain: true });
  }

  /**
   * The routed call itself after its turn (state.json `elsewherePings`, read
   * by every later pull of the source; stampRing): answered when the turn
   * spoke for real and something reached the chat (`delivered`: a reaction
   * alone counts), skipped when the persona chose silence (`skip`) or nothing
   * it chose reached the chat (a reaction dropped or refused). The other
   * calls of the ring the turn showed -- one this call replaced, an earlier
   * one still waiting -- are the turn's to stamp, by what its output answered
   * (src/behavior/turn.js#stampShownCalls); one it did not show stays as it
   * was. A dry run that spoke reached nobody and stamps nothing (the call
   * stays unanswered); a dry run that skipped stamps it like any skip --
   * silence is the persona's choice, not a post. Any other outcome (an error,
   * a refusal, busy, paused) stamps nothing.
   */
  function markRoutedCall(messageId: string, result: TurnResult): void {
    let status: 'answered' | 'skipped' | null = null;
    if (result?.outcome === 'skip') status = 'skipped';
    else if (result?.outcome === 'spoke' && result.dryRun !== true)
      status = result.delivered === false ? 'skipped' : 'answered';
    if (status) stampRing([{ messageId, status }]);
  }

  /**
   * The ignore roll let a routed call pass -- the persona's choice, and one
   * decision for the burst the settle grouped: the call and every call it
   * took the place of (`superseded`: replaced in the settle wait, or
   * outranked by it) are stamped skipped (stampRing), so a
   * later pull never presents them as waiting. Safe in a dry run: a skip
   * claims no answer.
   */
  function passRoutedCall(messageId: string, superseded: Array<string> = []): void {
    stampRing([messageId, ...superseded].map((id) => ({ messageId: id, status: 'skipped' as const })));
  }

  /**
   * A routed call a turn that spoke already had in view
   * (turns.spokeAfterSeeing): the call and every other call of its source in
   * the ring that turn showed are stamped skipped (stampRing) -- in view, so
   * a later pull never presents them as waiting. A turn that spoke for real
   * stamped them itself already (src/behavior/turn.js#stampShownCalls; an
   * answer it gave is kept), a rehearsal did not. A call of the source that
   * turn did not show is left as it was. Safe in a dry run: a skip claims no
   * answer.
   */
  function skipSeenCalls(sourceId: string, messageId: string): void {
    const seen = ringCalls(sourceId)
      .map((entry) => entry.messageId)
      .filter((id) => id !== messageId && turns.spokeAfterSeeing?.(sourceId, id));
    stampRing([messageId, ...seen].map((id) => ({ messageId: id, status: 'skipped' as const })));
  }

  /**
   * The calls of `sourceId` the ring holds (state.json `elsewherePings`, read
   * now), oldest first, those past elsewhere.pingMaxAgeDays left out
   * (src/behavior/elsewhere.ts#pingsIn). Read-only.
   */
  function ringCalls(sourceId: string) {
    const { pingMaxAgeMs } = elsewhereSettings(hot.config);
    return pingsIn(store?.state?.data?.elsewherePings, sourceId, { now: now(), maxAgeMs: pingMaxAgeMs });
  }

  /**
   * Whether the ring holds the routed call `messageId` of `sourceId` as
   * answered (src/behavior/elsewhere.ts#pingStatus): a turn that showed it
   * spoke and stamped it. Read from state.json, so it holds across a restart
   * and after a later turn's view of the source (turns.spokeAfterSeeing, in
   * memory) left the call out. A call the ring does not hold (never recorded,
   * past its age, no state) is not answered; nor is a skipped one.
   */
  function ringAnswered(sourceId: string, messageId: string): boolean {
    return pingStatus(ringCalls(sourceId).find((entry) => entry.messageId === messageId)) === 'answered';
  }

  /**
   * Stamp calls of the ring (state.json `elsewherePings`) `answered` or
   * `skipped` (src/behavior/elsewhere.ts#stampPings: an answer wins over a
   * skip, a stamp is never moved), log `elsewhere: marked` for each call
   * whose state changed and mark the state dirty once. A message id the ring
   * does not hold is passed over. Nothing changes while paused (the owner may
   * be editing data/) or without a state.
   */
  function stampRing(stamps: Array<{ messageId: string; status: 'answered' | 'skipped' }>): void {
    const state = store?.state;
    const data = state?.data;
    if (!data || data.paused || !Array.isArray(data.elsewherePings)) return;
    const { ring, marked } = stampPings(data.elsewherePings, stamps, now());
    if (marked.length === 0) return;
    data.elsewherePings = ring;
    state.markDirty?.();
    for (const { messageId, channelId, status } of marked)
      log.info('elsewhere: marked', { source: channelId, message: messageId, status });
  }

  /**
   * Whether the message `messageId` of `channel` is still there to answer, as the interface says: `true`, `'gone'`
   * (missing: deleted) or `'error'` (the read failed, so it may still exist; never read as deleted).
   */
  async function messageStillExists(channel: Conv, messageId: string): Promise<true | 'gone' | 'error'> {
    const found = await reads.fetchMessages(refOf(channel), [messageId]);
    if (found === null) return 'error';
    return found.messages[0]?.missing === true || found.messages.length === 0 ? 'gone' : true;
  }

  /**
   * What became of the held call `messageId` written in `channel` while it
   * waited (a settle wait, the pending queue), read now: `'answered'` when it
   * is a routed call (`routed`) the ring holds as answered (ringAnswered),
   * else what messageStillExists says (`true`, `'gone'`, `'error'`). The ring
   * is read on both sides of the lookup: before it, so a call already
   * answered costs no fetch and is never reported as lost when its message
   * cannot be found any more; after it, for a stamp that landed while the
   * fetch was in flight. An answer wins over a missing message either way.
   * `channel` is where the call was written; only a routed call is in the ring.
   */
  async function heldCallState(channel: Conv, messageId: string, routed: boolean): Promise<HeldState> {
    const answered = () => routed && ringAnswered(channel.id, messageId);
    if (answered()) return 'answered';
    const found = await messageStillExists(channel, messageId);
    return answered() ? 'answered' : found;
  }

  return { notifyLimit, announceRefusal, afterCallTurn, passRoutedCall, skipSeenCalls, heldCallState };
}
