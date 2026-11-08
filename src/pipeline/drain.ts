// The drain of the pending queue: once a turn finishes anywhere, the oldest waiting call is answered, one at a time,
// after a human switch pause, each checked again first. createMessageHandler (src/behavior/pipeline.ts) builds it
// once with createDrain and hands drainPending to the turn runner's `setOnIdle` (src/index.ts).

import { isExpired, popOldest } from '../behavior/pending.ts';
import { between } from '../behavior/random.ts';
import { log } from '../log.ts';
import { CODE } from '../tools/codes.ts';
import type { Answer } from './answer.ts';
import type { CallOutcome } from './call-outcome.ts';
import { missingReason } from './call-outcome.ts';
import type { ChatRef } from './chats.ts';
import type { AddressAttention } from './address-attention.ts';
import type { PendingQueueOps } from './pending-queue.ts';
import { isDeferredFollowUp } from './pending-queue.ts';
import type { PrivateGate } from './private-gate.ts';
import type { Conv, PendingQueue, Ping, PipelineHot, PipelineState, PipelineTurns } from './types.ts';

/** The pause, in ms, before a deferred ping is answered (a human switching to it). Production value, config cut of
 * 2026-10-31. */
const SWITCH_DELAY_MS: [number, number] = [2000, 9000];

/** What createDrain reads: the dependencies of createMessageHandler, the queue and its other parts' functions. */
export type DrainContext = {
  hot: PipelineHot;
  store: { state?: PipelineState } | null | undefined;
  now: () => number;
  rng: () => number;
  sleep: (ms: number) => Promise<void>;
  turns: PipelineTurns;
  pending: PendingQueue;
  logPending: PendingQueueOps['logPending'];
  noteUnanswered: PendingQueueOps['noteUnanswered'];
  queuedCount: PendingQueueOps['queuedCount'];
  queuedFor: PendingQueueOps['queuedFor'];
  requeueBusy: PendingQueueOps['requeueBusy'];
  currentOf: (channel: Conv) => Promise<Conv>;
  refOf: (channel: Conv) => ChatRef;
  heldCallState: CallOutcome['heldCallState'];
  afterCallTurn: CallOutcome['afterCallTurn'];
  checkPrivateGate: PrivateGate['checkPrivateGate'];
  dropPrivate: PrivateGate['dropPrivate'];
  afterPrivateTurn: PrivateGate['afterPrivateTurn'];
  followUpStale: AddressAttention['followUpStale'];
  decideAndLog: Answer['decideAndLog'];
};

export function createDrain({
  hot,
  store,
  now,
  rng,
  sleep,
  turns,
  pending,
  logPending,
  noteUnanswered,
  queuedCount,
  queuedFor,
  requeueBusy,
  currentOf,
  refOf,
  heldCallState,
  afterCallTurn,
  checkPrivateGate,
  dropPrivate,
  afterPrivateTurn,
  followUpStale,
  decideAndLog,
}: DrainContext): { drainPending: () => Promise<void> } {
  /** The store's `state.json` data, read at each call: the pause flag. */
  const storeState = () => store?.state?.data;
  let draining = false; // guards against a re-entrant drainPending() call (see below)

  /**
   * Answers pending direct pings, oldest first, one at a time, each after a
   * human "switch" pause (mention.switchDelayMs) -- called once a turn
   * finishes anywhere (src/index.ts wires this to src/behavior/turn.ts's
   * `setOnIdle`, in the same `finally` that frees the channel). The per-author
   * rail (decideAndLog) decides HERE, not when the ping arrived. A
   * ping whose message was deleted meanwhile (`gone`) or cannot be fetched
   * now (`fetch-failed`: messageStillExists), a channel that lost send
   * permission, or a ping the last turn that spoke in its channel already
   * had in its history (turns.spokeAfterSeeing -- unless that turn named it as
   * a call still waiting for its own turn: its author's under
   * labels.task.queued, another member's under labels.task.queuedOthers),
   * is dropped with a log line; the messages folded into a dropped call
   * (`added`) go with it. Each call's turn gets the other calls waiting in its
   * channel (`queued`, queuedFor) and the messages folded into it (`added`).
   * A ping queued in a channel whose own turn was running is picked up the
   * same way once that turn frees the channel. A deferred follow-up or overheard line is dropped when attention
   * has passed (followUpStale) or a turn that spoke had it in view. Guarded against re-entrancy:
   * the turn this function itself starts also frees the channel through the very same `onIdle`,
   * which would otherwise start a second overlapping drain. A no-op while
   * paused; a pause that lands during the switch pause puts the ping in hand back and ends the pass.
   *
   * A turn that started during the switch pause makes runTurn answer 'busy':
   * the ping is re-queued (requeueBusy; a server ping keeps its `respond`
   * decision, so the retry does not count it again) and the pass stops -- the running turn calls
   * drainPending again when it ends. From the busy result to `draining =
   * false` nothing is awaited, so that onIdle call either finds `draining`
   * already cleared, or the blocking turn had already ended when requeueBusy
   * looked and the pass goes on instead of stopping.
   */
  // health: allow complexity until 2027-04-01 -- moved whole from src/behavior/pipeline.ts in stage 5d, a pure move
  async function drainPending(): Promise<void> {
    if (draining || storeState()?.paused) return;
    draining = true;
    try {
      while (pending.list.length > 0) {
        // pending.js keeps the entries it is given.
        const { ping, list } = popOldest(pending.list) as { ping: Ping | null; list: Array<Ping> };
        pending.list = list;
        if (!ping) break;

        const mentionCfg = hot.config.mention;
        if (isExpired(ping, now(), mentionCfg.pendingMinutes ?? 10)) {
          logPending(ping, 'expired');
          noteUnanswered(ping, CODE.PENDING_EXPIRED);
          continue;
        }

        logPending(ping, 'picked up', { queued: queuedCount(ping.placeId, ping.trigger.authorId) });
        await sleep(between(SWITCH_DELAY_MS, rng));

        // Paused meanwhile: the ping goes back to the queue, which the resume drains.
        if (storeState()?.paused) {
          pending.list = [...pending.list, ping];
          logPending(ping, 'kept', { reason: 'paused' });
          break;
        }
        const here = await currentOf(ping.channel);
        if (!here.permissions.send) {
          logPending(ping, 'dropped', { reason: 'cannot-send' });
          continue;
        }
        const held = await heldCallState(ping.channel, ping.trigger.id);
        if (held !== true) {
          logPending(ping, 'dropped', { reason: missingReason(held) });
          continue;
        }
        // The turn that ran meanwhile fetched its history after this ping
        // landed and spoke with it in view: not answered a second time.
        if (!ping.readOptions?.memoryContext && turns.spokeAfterSeeing?.(ping.placeId, ping.trigger.id)) {
          if (isDeferredFollowUp(ping)) logPending(ping, 'dropped', { reason: 'answered' });
          else log.info('mention: already answered', { channel: ping.placeId, kind: ping.kind });
          continue;
        }

        const config = hot.config;
        let stop = false; // set by requeueBusy while the turn that blocked this ping still runs

        // A private message is answered like a direct ping, without the
        // per-author rail; the channel has no root, so the live path's answer for this person is passed, which may
        // be none. The gate is checked again here: the switch or the profile may have
        // changed while the ping waited.
        if (ping.kind === 'private') {
          try {
            const authorId = ping.trigger.authorId;
            const check = await checkPrivateGate(config, authorId, ping.channel.iface);
            if (!check.gate.ok) {
              dropPrivate(check);
              continue;
            }
            const result = await turns.runTurn({
              chat: refOf(ping.channel),
              mode: 'reply',
              trigger: ping.trigger,
              triggerKind: 'private',
              memoryContext: ping.readOptions?.memoryContext,
              queued: queuedFor(ping.placeId, ping.trigger),
              added: ping.added ?? null,
            });
            if (result?.outcome === 'busy') stop = requeueBusy(ping);
            else await afterPrivateTurn(ping.channel, ping.trigger, result);
          } catch (err) {
            log.error('private: deferred turn failed', { channel: ping.placeId, error: err });
          }
          if (stop) break;
          continue;
        }

        // A deferred follow-up or overheard line: attention must still hold
        // (a post the line came too late for is no answer: the
        // spokeAfterSeeing check above decides that).
        if (isDeferredFollowUp(ping)) {
          const stale = followUpStale(ping, config);
          if (stale) {
            logPending(ping, 'dropped', { reason: stale });
            continue;
          }
        }
        // A re-queued ping was already counted and decided `respond` on the
        // pass whose turn found another one running: not counted again.
        if (!ping.decided) {
          if (!decideAndLog(ping.channel, ping.trigger, ping.kind, config, { deferred: true }).respond) continue;
        }

        try {
          const result = await turns.runTurn({
            chat: refOf(ping.channel),
            mode: 'reply',
            trigger: ping.trigger,
            triggerKind: ping.kind,
            queued: queuedFor(ping.placeId, ping.trigger),
            added: ping.added ?? null,
          });
          if (result?.outcome === 'busy') stop = requeueBusy({ ...ping, decided: true });
          else await afterCallTurn(ping.channel, ping.trigger, result, ping.kind);
        } catch (err) {
          log.error('mention: deferred turn failed', { channel: ping.placeId, error: err });
        }
        if (stop) break;
      }
    } finally {
      draining = false;
    }
  }

  return { drainPending };
}
