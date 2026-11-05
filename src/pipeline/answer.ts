// The ordinary path of a server call the persona may answer: held while the attention is taken, otherwise counted,
// rolled for the ignore chance and answered by a reply turn. createMessageHandler (src/behavior/pipeline.ts) builds it once with
// createAnswer; the live path, the follow-up path and the drain call it.

import { SPAM_WINDOW_MS, decideMention } from '../behavior/mention.ts';
import { log } from '../log.ts';
import type { CallOutcome } from './call-outcome.ts';
import type { ConversationRef } from './conversations.ts';
import type { HoldCall } from './merge.ts';
import type { PendingQueueOps } from './pending-queue.ts';
import type { Conv, Line, PipelineConfig, PipelineTurns, TriggerKind } from './types.ts';

/** The ignore decision of one call (src/behavior/mention.ts#decideMention). */
export type Decision = { respond: boolean; reason: string; ignoreChance: number; roll?: number };

/** One call on the ordinary path: where it was written, the line and its kind. */
export type Call = {
  channel: Conv;
  normalized: Line;
  kind: TriggerKind;
  config: PipelineConfig;
};

/** What createAnswer reads: the dependencies of createMessageHandler and its other parts' functions. */
export type AnswerContext = {
  store:
    | {
        getUser: (accountId: string) => { affinity?: { score?: number } } | null | undefined;
      }
    | null
    | undefined;
  now: () => number;
  rng: () => number;
  turns: PipelineTurns;
  tagHistory: { hit: (authorId: string, at: number, windowMs: number) => number };
  selfIdOf: () => string;
  getSelfName: (placeId: string) => string;
  refOf: (channel: Conv) => ConversationRef;
  holdCall: HoldCall;
  queuedFor: PendingQueueOps['queuedFor'];
  afterCallTurn: CallOutcome['afterCallTurn'];
};

export type Answer = {
  decideAndLog: (
    channel: Conv,
    trigger: Line,
    kind: TriggerKind,
    config: PipelineConfig,
    options?: { deferred?: boolean }
  ) => Decision;
  answerCall: (call: Call) => void;
};

export function createAnswer({
  now,
  rng,
  turns,
  tagHistory,
  refOf,
  holdCall,
  queuedFor,
  afterCallTurn,
}: AnswerContext): Answer {
  /**
   * Count the call, roll the ignore decision (decideMention) and log it, for
   * a server ping of `kind` -- the live path and the drain alike. `config` is
   * the caller's `hot.config`, read at the moment of use; `deferred` marks a
   * ping answered from the pending queue.
   */
  function decideAndLog(
    channel: Conv,
    trigger: Line,
    kind: TriggerKind,
    config: PipelineConfig,
    { deferred = false }: { deferred?: boolean } = {}
  ): Decision {
    const recentCalls = tagHistory.hit(trigger.authorId, now(), SPAM_WINDOW_MS);
    const decision = decideMention({
      // decideMention reads the kinds of a server call; a follow-up is one of them.
      kind: kind as 'mention' | 'reply' | 'name' | 'followUp',
      recentCalls,
      neverIgnore: config.mention.neverIgnore.includes(trigger.authorId),
      rng,
    });
    log.info('mention: decided', {
      kind,
      reason: decision.reason,
      ignoreChance: decision.ignoreChance,
      roll: decision.roll === undefined ? undefined : Math.round(decision.roll * 100) / 100,
      author: trigger.authorId,
      channel: channel.id,
      ...(deferred ? { deferred: true } : {}),
    });
    return decision;
  }

  /**
   * The ordinary path of a server call the persona may answer. `channel` is where the call was written; busy and the
   * pending rules are keyed by it. A direct call (mention/reply/name) that cannot be answered now is remembered as
   * pending instead of dropped, and answered by drainPending once the turn frees up (the tag count and the ignore roll
   * happen there):
   *  - a turn is running in that channel (mention.pendingSameChannel, default on, regardless of mention.oneAtATime) --
   *    that turn may already have fetched its history without this message;
   *  - one turn at a time (mention.oneAtATime, default on): a turn is running in another channel.
   * A direct call is held through holdCall: queued, or folded into an item its author already waits for there (the
   * merge classifier). A name call is held like a tag; its mention.nameTriggerChance roll is made at drain time, as the
   * others' ignore roll is. With pendingSameChannel off, a call in a busy channel is dropped here (`mention: dropped`,
   * `busy`) -- before it is counted or rolled, so it neither adds to the spam count (tagHistory) nor meets the ignore
   * chance. Should runTurn itself still answer 'busy', that is logged as the same drop.
   * Otherwise the call is counted and rolled (decideAndLog) and the reply turn started, never awaited. `config` is the
   * caller's `hot.config`, read now.
   */
  function answerCall({ channel, normalized, kind, config }: Call): void {
    const direct = kind === 'mention' || kind === 'reply' || kind === 'name';
    const dropBusy = () => log.info('mention: dropped', { channel: channel.id, kind, reason: 'busy' });
    // A direct call is one of the queue's kinds.
    const holdDirect = () => holdCall(channel, normalized, kind as 'mention' | 'reply' | 'name');
    const sameChannelBusy = turns.isBusy(channel.id);
    if (sameChannelBusy && direct) {
      holdDirect();
      return;
    }
    // Not held (not a direct call): dropped before it is counted or rolled.
    if (sameChannelBusy) {
      dropBusy();
      return;
    }
    const busyElsewhere = turns.isAnyBusy();
    if (busyElsewhere) {
      if (direct) holdDirect();
      else dropBusy();
      return;
    }

    const decision = decideAndLog(channel, normalized, kind, config);
    if (!decision.respond) return;
    turns
      .runTurn({
        conversation: refOf(channel),
        mode: 'reply',
        trigger: normalized,
        triggerKind: kind,
        queued: queuedFor(channel.id, normalized),
      })
      .then((result) => {
        if (result?.outcome === 'busy') dropBusy();
        return afterCallTurn(channel, normalized, result, kind);
      })
      .catch((err: unknown) => log.error('mention: reply turn failed', { channel: channel.id, error: err }));
  }

  return { decideAndLog, answerCall };
}
