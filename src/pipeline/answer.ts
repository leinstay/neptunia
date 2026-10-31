// The ordinary path of a server call the persona may answer: held while the attention is taken, otherwise counted,
// rolled for the ignore chance and answered by a reply turn, the live call and a routed one alike. createMessageHandler
// (src/behavior/pipeline.js) builds it once with createAnswer; the live path, the settle waits, the follow-up path and
// the drain call it.

import { decideMention, isTaggedCall, repeatWindowMs, strippedLength } from '../behavior/mention.js';
import { log } from '../log.js';
import type { CallOutcome } from './call-outcome.ts';
import { routedFields } from './call-outcome.ts';
import type { ConversationRef } from './conversations.ts';
import type { HoldCall } from './merge.ts';
import type { PendingQueueOps } from './pending-queue.ts';
import type { Conv, Line, PipelineConfig, PipelineTurns, TriggerKind } from './types.ts';

/** The ignore decision of one call (src/behavior/mention.js#decideMention). */
export type Decision = { respond: boolean; reason: string; ignoreChance: number; roll?: number };

/** One call on the ordinary path: where it was written, the line, its kind and, for a routed call, its destination. */
export type Call = {
  channel: Conv;
  normalized: Line;
  kind: TriggerKind;
  config: PipelineConfig;
  destination?: Conv | null;
  superseded?: Array<string>;
};

/** What createAnswer reads: the dependencies of createMessageHandler and its other parts' functions. */
export type AnswerContext = {
  store:
    | {
        getUser?: (guildId: string, userId: string) => { affinity?: { score?: number } } | null | undefined;
      }
    | null
    | undefined;
  now: () => number;
  rng: () => number;
  turns: PipelineTurns;
  tagHistory: { hit: (authorId: string, at: number, windowMs: number) => number };
  selfIdOf: () => string;
  getSelfName: (guildId: string) => string;
  refOf: (channel: Conv) => ConversationRef;
  holdCall: HoldCall;
  queuedFor: PendingQueueOps['queuedFor'];
  afterCallTurn: CallOutcome['afterCallTurn'];
  passRoutedCall: CallOutcome['passRoutedCall'];
};

export type Answer = {
  decideAndLog: (
    channel: Conv,
    trigger: Line,
    kind: TriggerKind,
    config: PipelineConfig,
    options?: { deferred?: boolean; destination?: Conv | null }
  ) => Decision;
  answerCall: (call: Call) => void;
};

export function createAnswer({
  store,
  now,
  rng,
  turns,
  tagHistory,
  selfIdOf,
  getSelfName,
  refOf,
  holdCall,
  queuedFor,
  afterCallTurn,
  passRoutedCall,
}: AnswerContext): Answer {
  /**
   * Count the call, roll the ignore decision (decideMention) and log it, for
   * a server ping of `kind` -- the live path and the drain alike. `config` is
   * the caller's `hot.config`, read at the moment of use; `deferred` marks a
   * ping answered from the pending queue; `destination` is the channel a
   * routed call's turn posts in (logged beside `channel`, where the call was
   * written). Whether the call tags the persona (isTaggedCall: not by the
   * reply ping alone) is read off `trigger`, so an untagged reply meets
   * mention.followUpIgnoreChance like a follow-up (decideMention).
   */
  function decideAndLog(
    channel: Conv,
    trigger: Line,
    kind: TriggerKind,
    config: PipelineConfig,
    { deferred = false, destination = null }: { deferred?: boolean; destination?: Conv | null } = {}
  ): Decision {
    const features = config.features ?? {};
    // A server call is written in a community, so its channel has the id.
    const guildId = channel.communityId as string;
    const recentCalls = tagHistory.hit(trigger.authorId, now(), repeatWindowMs(config.mention));
    const affinityScore =
      features.memory !== false && features.relationships !== false
        ? store?.getUser?.(guildId, trigger.authorId)?.affinity?.score
        : undefined;
    const decision = decideMention({
      // decideMention reads the kinds of a server call; a follow-up is one of them.
      kind: kind as 'mention' | 'reply' | 'name' | 'followUp',
      tagged: isTaggedCall(trigger, selfIdOf()),
      // A message event carries its text (src/protocol/events.js), so the line has it.
      textLength: strippedLength(trigger.content as string, getSelfName(guildId)),
      recentCalls,
      neverIgnore: config.mention.neverIgnore.includes(trigger.authorId),
      affinityScore,
      cfg: config.mention,
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
      ...routedFields({ destination }),
    });
    return decision;
  }

  /**
   * The ordinary path of a server call the persona may answer, the live one
   * and a routed one alike. `channel` is where the call was written,
   * `destination` the channel a routed call's turn posts in (null: the call's
   * own channel); busy and the pending rules are keyed by the channel the turn
   * posts in. A direct call (mention/reply/name) that cannot be answered now is
   * remembered as pending instead of dropped, and answered by drainPending
   * once the turn frees up (the tag count and the ignore roll happen there):
   *  - a turn is running in that channel (mention.pendingSameChannel, default
   *    on, regardless of mention.oneAtATime) -- that turn may already have
   *    fetched its history without this message;
   *  - one turn at a time (mention.oneAtATime, default on): a turn is running in
   *    another channel.
   * A direct call is held through holdCall: queued, or folded into an item
   * its author already waits for there (the merge classifier).
   * A routed call is held the same way, never folded: queued under the channel it was
   * written in (its source), carrying its destination, which the drain posts
   * in, and the calls its settle wait took the place of. A name call is held
   * like a tag; its mention.nameTriggerChance roll is made at drain time, as
   * the others' ignore roll is. With pendingSameChannel off, a call in a busy
   * channel is dropped here (`mention: dropped`, `busy`) -- before it is
   * counted or rolled, so it neither adds to the spam count (tagHistory) nor
   * meets the ignore chance. A routed call dropped as busy stays unanswered
   * in the ring: busy is not the persona's choice, and only a call she chose
   * to let pass is stamped skipped. Should runTurn itself still answer
   * 'busy', that is logged as the same drop.
   * Otherwise the call is counted and rolled (decideAndLog) and the reply
   * turn started, never awaited; a routed one carries its `source`
   * (`reason: 'routed'`), and its outcome reaches the ring and its notice the
   * destination (afterCallTurn). A routed call the ignore roll lets pass
   * (`ignored:*`, `name-unnoticed`) is stamped skipped in the ring with the
   * calls it took the place of (passRoutedCall). `config` is the caller's
   * `hot.config`, read now. `superseded`: a routed call only, the message ids of the calls of its
   * source it took the place of in its settle wait (armSettle).
   */
  function answerCall({ channel, normalized, kind, config, destination = null, superseded = [] }: Call): void {
    const turnChannel = destination ?? channel;
    const routed = routedFields({ destination });
    const direct = kind === 'mention' || kind === 'reply' || kind === 'name';
    const oneAtATime = config.mention.oneAtATime !== false;
    const dropBusy = () => log.info('mention: dropped', { channel: channel.id, kind, reason: 'busy', ...routed });
    // A direct call is one of the queue's kinds.
    const holdDirect = () =>
      holdCall(channel, normalized, kind as 'mention' | 'reply' | 'name', destination, superseded);
    const sameChannelBusy = turns.isBusy(turnChannel.id);
    if (sameChannelBusy && direct && config.mention.pendingSameChannel !== false) {
      holdDirect();
      return;
    }
    // Not held (pendingSameChannel off): dropped before it is counted or rolled.
    if (sameChannelBusy) {
      dropBusy();
      return;
    }
    const busyElsewhere = oneAtATime && turns.isAnyBusy();
    if (busyElsewhere) {
      if (direct) holdDirect();
      else dropBusy();
      return;
    }

    const decision = decideAndLog(channel, normalized, kind, config, { destination });
    if (!decision.respond) {
      // The ignore roll let a routed call pass, and the calls it replaced with it.
      if (destination) passRoutedCall(normalized.id, superseded);
      return;
    }
    const source = destination ? { source: { channelId: channel.id, reason: 'routed' as const } } : {};
    turns
      .runTurn({
        conversation: refOf(turnChannel),
        mode: 'reply',
        trigger: normalized,
        triggerKind: kind,
        queued: queuedFor(channel.id, normalized, Boolean(destination)),
        ...source,
      })
      .then((result) => {
        if (result?.outcome === 'busy') dropBusy();
        return afterCallTurn(channel, normalized, result, kind, destination);
      })
      .catch((err: unknown) => log.error('mention: reply turn failed', { channel: channel.id, ...routed, error: err }));
  }

  return { decideAndLog, answerCall };
}
