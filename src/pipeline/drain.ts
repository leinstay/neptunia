// The drain of the pending queue: once a turn finishes anywhere, the oldest waiting call is answered, one at a time,
// after a human switch pause, each checked again first. createMessageHandler (src/behavior/pipeline.js) builds it
// once with createDrain and hands drainPending to the turn runner's `setOnIdle` (src/index.js).

import { isExpired, popOldest } from '../behavior/pending.js';
import { between } from '../behavior/random.js';
import { log } from '../log.js';
import { CODE } from '../tools/codes.ts';
import type { Answer } from './answer.ts';
import type { CallOutcome } from './call-outcome.ts';
import { callSwitchOff, missingReason, routedFields } from './call-outcome.ts';
import type { ConversationRef, Conversations } from './conversations.ts';
import type { FollowUpWindows } from './follow-up-window.ts';
import type { PendingQueueOps } from './pending-queue.ts';
import { isDeferredFollowUp } from './pending-queue.ts';
import type { PrivateGate } from './private-gate.ts';
import type { Conv, PendingQueue, Ping, PipelineHot, PipelineState, PipelineTurns } from './types.ts';

/** What createDrain reads: the dependencies of createMessageHandler, the queue and its other parts' functions. */
export type DrainContext = {
  hot: PipelineHot;
  store: { state?: PipelineState } | null | undefined;
  now: () => number;
  rng: () => number;
  sleep: (ms: number) => Promise<void>;
  turns: PipelineTurns;
  getGuildId: () => string | null;
  pending: PendingQueue;
  logPending: PendingQueueOps['logPending'];
  noteUnanswered: PendingQueueOps['noteUnanswered'];
  queuedCount: PendingQueueOps['queuedCount'];
  queuedFor: PendingQueueOps['queuedFor'];
  requeueBusy: PendingQueueOps['requeueBusy'];
  currentOf: (channel: Conv) => Promise<Conv>;
  refOf: (channel: Conv) => ConversationRef;
  routeOf: Conversations['routeOf'];
  heldCallState: CallOutcome['heldCallState'];
  skipSeenCalls: CallOutcome['skipSeenCalls'];
  afterCallTurn: CallOutcome['afterCallTurn'];
  passRoutedCall: CallOutcome['passRoutedCall'];
  checkPrivateGate: PrivateGate['checkPrivateGate'];
  dropPrivate: PrivateGate['dropPrivate'];
  afterPrivateTurn: PrivateGate['afterPrivateTurn'];
  followUpOff: FollowUpWindows['followUpOff'];
  followUpStale: FollowUpWindows['followUpStale'];
  decideAndLog: Answer['decideAndLog'];
};

export function createDrain({
  hot,
  store,
  now,
  rng,
  sleep,
  turns,
  getGuildId,
  pending,
  logPending,
  noteUnanswered,
  queuedCount,
  queuedFor,
  requeueBusy,
  currentOf,
  refOf,
  routeOf,
  heldCallState,
  skipSeenCalls,
  afterCallTurn,
  passRoutedCall,
  checkPrivateGate,
  dropPrivate,
  afterPrivateTurn,
  followUpOff,
  followUpStale,
  decideAndLog,
}: DrainContext): { drainPending: () => Promise<void> } {
  let draining = false; // guards against a re-entrant drainPending() call (see below)

  /**
   * Answers pending direct pings, oldest first, one at a time, each after a
   * human "switch" pause (mention.switchDelayMs) -- called once a turn
   * finishes anywhere (src/index.js wires this to src/behavior/turn.js's
   * `setOnIdle`, in the same `finally` that frees the channel). The ignore
   * decision (decideMention) is rolled HERE, not when the ping arrived. A
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
   * same way once that turn frees the channel. A deferred follow-up is never
   * rolled (counted for spam only) and is dropped when its window closed
   * (followUpStale) or a turn that spoke had it in view, or when
   * features.followUp is off now. Guarded against re-entrancy:
   * the turn this function itself starts also frees the channel through the very same `onIdle`,
   * which would otherwise start a second overlapping drain. A no-op while
   * paused; a pause that lands during the switch pause puts the ping in hand back and ends the pass. A server ping is also dropped when its
   * switch (features.mentions / features.replies / features.nameTriggers) was turned
   * off while it waited (callSwitchOff).
   *
   * A routed call (one with a `destination`) goes through the same checks in
   * the channel it was written in, except the send permission: the
   * destination it waited with is not checked, its route is read again now
   * instead (routeFor: features.elsewhere, memory.mainChannelIds, the audience
   * rail, a main channel the bot can send in) -- a route that no longer holds
   * drops it like onMessage step 11 does (`cannot-send` with `route`) -- and
   * its turn posts in the destination resolved now, with its source
   * (afterCallTurn: the notice there, plain; the ring). A routed call the
   * ring already holds as answered is dropped (`mention: already answered`,
   * reason `ring`: read from state.json, so it holds across a restart,
   * whatever the turns remember in memory) -- read before its message is
   * looked up, so an answered call is never logged as `gone` or
   * `fetch-failed` (heldCallState). Otherwise, a routed call a turn
   * that spoke already had in view is stamped skipped in the ring with every
   * other call of its source that turn showed (skipSeenCalls); one the ignore
   * roll lets pass, with every call it took the place of (passRoutedCall).
   *
   * A turn that started during the switch pause makes runTurn answer 'busy':
   * the ping is re-queued (requeueBusy; a server ping keeps its `respond`
   * decision, so the retry neither counts it again toward spamThreshold nor
   * re-rolls the ignore chance) and the pass stops -- the running turn calls
   * drainPending again when it ends. From the busy result to `draining =
   * false` nothing is awaited, so that onIdle call either finds `draining`
   * already cleared, or the blocking turn had already ended when requeueBusy
   * looked and the pass goes on instead of stopping.
   */
  // health: allow complexity until 2027-04-01 -- moved whole from src/behavior/pipeline.js in stage 5d, a pure move
  async function drainPending(): Promise<void> {
    if (draining || store?.state?.data?.paused) return;
    draining = true;
    try {
      while (pending.list.length > 0) {
        // pending.js keeps the entries it is given.
        const { ping, list } = popOldest(pending.list) as { ping: Ping | null; list: Array<Ping> };
        pending.list = list;
        if (!ping) break;

        const mentionCfg = hot.config.mention;
        const routed = routedFields(ping);
        if (isExpired(ping, now(), mentionCfg.pendingMinutes ?? 10)) {
          logPending(ping, 'expired');
          noteUnanswered(ping, CODE.PENDING_EXPIRED);
          continue;
        }

        logPending(ping, 'picked up', { queued: queuedCount(ping.channelId, ping.trigger.authorId) });
        await sleep(between(mentionCfg.switchDelayMs ?? [2000, 9000], rng));

        // Paused meanwhile: the ping goes back to the queue, which the resume drains.
        if (store?.state?.data?.paused) {
          pending.list = [...pending.list, ping];
          logPending(ping, 'kept', { reason: 'paused' });
          break;
        }
        // An ordinary ping is answered where it was written. A routed call's
        // turn posts in a main channel, resolved again below (routeFor): the
        // one it waited with may have changed or lost Send meanwhile.
        if (!ping.destination) {
          const here = await currentOf(ping.channel);
          if (!here.permissions.send) {
            logPending(ping, 'dropped', { reason: 'cannot-send' });
            continue;
          }
        }
        const held = await heldCallState(ping.channel, ping.trigger.id, Boolean(ping.destination));
        // A routed call the ring holds as answered (a turn that showed it
        // spoke): not answered a second time, whatever the turns remember.
        if (held === 'answered') {
          log.info('mention: already answered', {
            channel: ping.channelId,
            kind: ping.kind,
            reason: 'ring',
            ...routed,
          });
          continue;
        }
        if (held !== true) {
          logPending(ping, 'dropped', { reason: missingReason(held) });
          continue;
        }
        // The turn that ran meanwhile fetched its history after this ping
        // landed and spoke with it in view: not answered a second time (a
        // routed call, and the calls of its source that turn showed, are no
        // longer presented as waiting either).
        if (turns.spokeAfterSeeing?.(ping.channelId, ping.trigger.id)) {
          if (isDeferredFollowUp(ping)) logPending(ping, 'dropped', { reason: 'answered' });
          else log.info('mention: already answered', { channel: ping.channelId, kind: ping.kind, ...routed });
          if (ping.destination) skipSeenCalls(ping.channelId, ping.trigger.id);
          continue;
        }

        const config = hot.config;
        const features = config.features ?? {};
        let stop = false; // set by requeueBusy while the turn that blocked this ping still runs

        // A private message is answered like a direct ping, without the
        // ignore roll; the channel has no guild, so the pinned one is passed.
        // The gate is checked again here: the switch, the profile or today's
        // cap may have changed while the ping waited.
        if (ping.kind === 'private') {
          const privateGuildId = getGuildId();
          if (!privateGuildId) continue;
          try {
            const authorId = ping.trigger.authorId;
            const check = await checkPrivateGate(config, privateGuildId, authorId);
            if (!check.gate.ok) {
              await dropPrivate(ping.channel, privateGuildId, authorId, ping.trigger, check);
              continue;
            }
            const result = await turns.runTurn({
              conversation: refOf(ping.channel),
              guildId: privateGuildId,
              mode: 'reply',
              trigger: ping.trigger,
              triggerKind: 'private',
              queued: queuedFor(ping.channelId, ping.trigger),
              added: ping.added ?? null,
            });
            if (result?.outcome === 'busy') stop = requeueBusy(ping);
            else await afterPrivateTurn(ping.channel, privateGuildId, ping.trigger, result);
          } catch (err) {
            log.error('private: deferred turn failed', { channel: ping.channelId, error: err });
          }
          if (stop) break;
          continue;
        }

        // The ping's own switch is hot: it may have changed while the ping
        // waited.
        const switchOff = isDeferredFollowUp(ping) ? followUpOff(config) : callSwitchOff(ping.kind, features);
        if (switchOff) {
          logPending(ping, 'dropped', { reason: 'off' });
          continue;
        }

        // A routed call: where it is answered is read again now (the switch,
        // the main channels and the audience rail are hot).
        let destination: Conv | null = null;
        if (ping.destination) {
          const route = await routeOf(ping.channel, config);
          if (!route.destination) {
            log.info('mention: dropped', {
              channel: ping.channelId,
              kind: ping.kind,
              reason: 'cannot-send',
              route: route.reason,
              ...routed,
            });
            continue;
          }
          destination = route.destination;
        }

        // A deferred follow-up or overheard line: its window must still be
        // open (a post the line came too late for is no answer: the
        // spokeAfterSeeing check above decides that). A follow-up is
        // counted for spam and rolled for the ignore chance like a live one,
        // an overheard line is neither (startFollowUpTurn).
        if (isDeferredFollowUp(ping)) {
          const stale = followUpStale(ping, config);
          if (stale) {
            logPending(ping, 'dropped', { reason: stale });
            continue;
          }
          if (ping.kind === 'followUp' && !ping.decided) {
            if (!decideAndLog(ping.channel, ping.trigger, ping.kind, config, { deferred: true }).respond) continue;
          }
        }
        // A re-queued ping was already counted and decided `respond` on the
        // pass whose turn found another one running: not counted or rolled again.
        else if (!ping.decided) {
          const decision = decideAndLog(ping.channel, ping.trigger, ping.kind, config, { deferred: true, destination });
          if (!decision.respond) {
            // The ignore roll let a routed call pass, and the calls it replaced with it.
            if (destination) passRoutedCall(ping.trigger.id, ping.superseded);
            continue;
          }
        }

        try {
          const result = await turns.runTurn({
            conversation: refOf(destination ?? ping.channel),
            mode: 'reply',
            trigger: ping.trigger,
            triggerKind: ping.kind,
            queued: queuedFor(ping.channelId, ping.trigger, Boolean(destination)),
            added: ping.added ?? null,
            ...(destination ? { source: { channelId: ping.channelId, reason: 'routed' as const } } : {}),
          });
          if (result?.outcome === 'busy')
            stop = requeueBusy({ ...ping, decided: true, ...(destination ? { destination } : {}) });
          else await afterCallTurn(ping.channel, ping.trigger, result, ping.kind, destination);
        } catch (err) {
          log.error('mention: deferred turn failed', { channel: ping.channelId, ...routed, error: err });
        }
        if (stop) break;
      }
    } finally {
      draining = false;
    }
  }

  return { drainPending };
}
