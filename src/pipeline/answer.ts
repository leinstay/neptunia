// The ordinary path of a call the persona may answer: held while the attention is taken, otherwise passed through the
// per-author rail and answered by a reply turn. createMessageHandler (src/behavior/pipeline.ts) builds it once with
// createAnswer; the door, the follow-up path and the drain call it.

import { decideTurn } from '../behavior/mention.ts';
import { MINUTE_MS } from '../time.ts';
import { log } from '../log.ts';
import type { CallOutcome } from './call-outcome.ts';
import type { ConversationRef } from './conversations.ts';
import type { HoldCall } from './merge.ts';
import type { PendingQueueOps } from './pending-queue.ts';
import type { Conv, Line, PipelineConfig, PipelineTurns, TriggerKind } from './types.ts';

/** The rail's decision on one turn (src/behavior/mention.ts#decideTurn). */
export type Decision = { respond: boolean; reason: string };

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
  turns: PipelineTurns;
  tagHistory: {
    count: (key: string, at: number, windowMs: number) => number;
    hit: (key: string, at: number, windowMs: number) => number;
  };
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
  turns,
  tagHistory,
  refOf,
  holdCall,
  queuedFor,
  afterCallTurn,
}: AnswerContext): Answer {
  /**
   * The per-author rail at the moment a turn would start, the live path and the drain alike: past
   * `address.maxTurnsPerAuthor` started turns of this author in this place within `address.attentionMinutes` the turn
   * is refused and logged by count; any other turn is counted. `config` is the caller's `hot.config`, read at the
   * moment of use; `deferred` marks a ping answered from the pending queue.
   */
  function decideAndLog(
    channel: Conv,
    trigger: Line,
    kind: TriggerKind,
    config: PipelineConfig,
    { deferred = false }: { deferred?: boolean } = {}
  ): Decision {
    const key = JSON.stringify([channel.iface, channel.id, trigger.authorId]);
    const windowMs = (config.address?.attentionMinutes ?? 0) * MINUTE_MS;
    const limit = config.address?.maxTurnsPerAuthor ?? 0;
    const turnsSoFar = tagHistory.count(key, now(), windowMs);
    const decision = decideTurn({
      turns: turnsSoFar,
      limit,
      neverIgnore: config.mention.neverIgnore.includes(trigger.authorId),
    });
    if (decision.respond) tagHistory.hit(key, now(), windowMs);
    else log.info('address: refused', { channel: channel.id, author: trigger.authorId, turns: turnsSoFar, limit });
    log.info('mention: decided', {
      kind,
      reason: decision.reason,
      author: trigger.authorId,
      channel: channel.id,
      ...(deferred ? { deferred: true } : {}),
    });
    return decision;
  }

  /**
   * The ordinary path of a call the classifier said `yes` to. `channel` is where the call was written; busy and the
   * pending rules are keyed by it. A direct call (mention or reply) that cannot be answered now is remembered as pending
   * instead of dropped, and answered by drainPending once the turn frees up (the rail counts it there). One turn at a
   * time: a turn running anywhere holds it. A direct call is held through holdCall: queued, or folded into an item its
   * author already waits for there (the merge classifier). Should runTurn itself still answer 'busy', that is logged as
   * a drop. Otherwise the rail decides (decideAndLog) and the reply turn starts, never awaited. `config` is the caller's
   * `hot.config`, read now.
   */
  function answerCall({ channel, normalized, kind, config }: Call): void {
    const direct = kind === 'mention' || kind === 'reply';
    const dropBusy = () => log.info('mention: dropped', { channel: channel.id, kind, reason: 'busy' });
    // A direct call is one of the queue's kinds.
    const holdDirect = () => holdCall(channel, normalized, kind as 'mention' | 'reply');
    const sameChannelBusy = turns.isBusy(channel.id);
    if (sameChannelBusy && direct) {
      holdDirect();
      return;
    }
    // Not held (not a direct call): dropped before it is counted.
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
