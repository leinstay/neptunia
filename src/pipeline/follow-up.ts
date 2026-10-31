// The follow-up path of an untagged line in an open window: at most one address classifier call in flight per channel,
// the lines that arrive meanwhile held and worked off one at a time, and the follow-up or overheard turn a verdict asks
// for, started now or deferred to the pending queue. createMessageHandler (src/behavior/pipeline.js) builds it once
// with createFollowUp; handleMessage asks maybeFollowUp first for a line that called nobody.

import { followUpTriggerKind } from '../behavior/mention.js';
import { log } from '../log.js';
import type { AddressAnswer, ClassifyFollowUp } from './address-classifier.ts';
import type { Answer } from './answer.ts';
import type { CallOutcome } from './call-outcome.ts';
import type { ConversationRef } from './conversations.ts';
import type { FollowUpGate, FollowUpWindows } from './follow-up-window.ts';
import type { PendingQueueOps } from './pending-queue.ts';
import type { Conv, Line, PipelineConfig, PipelineHot, PipelineTurns } from './types.ts';

/** A line the follow-up path works on: the channel it was written in and the line. */
type Candidate = { channel: Conv; normalized: Line };

/** A line that arrived while its channel's classifier call was in flight. */
type Held = Candidate & { selfId: string; ownPrefill: Promise<void> | null };

/** What a classifier call left: whether it started a turn, and an overheard line still waiting on held ones. */
type Settled = { started: boolean; waiting: Candidate | null };

/** The trigger kinds of a follow-up verdict's turn (followUpTriggerKind). */
type FollowUpKind = 'followUp' | 'overheard';

/** What createFollowUp reads: the dependencies of createMessageHandler and its other parts' functions. */
export type FollowUpContext = {
  hot: PipelineHot;
  turns: PipelineTurns;
  followUpGate: FollowUpWindows['followUpGate'];
  followUpMuted: FollowUpWindows['followUpMuted'];
  followUpOff: FollowUpWindows['followUpOff'];
  currentOf: (channel: Conv) => Promise<Conv>;
  refOf: (channel: Conv) => ConversationRef;
  classifyFollowUp: ClassifyFollowUp;
  turnBlocked: (channelId: string, config: PipelineConfig) => boolean;
  deferFollowUp: PendingQueueOps['deferFollowUp'];
  decideAndLog: Answer['decideAndLog'];
  drainPending: () => Promise<void>;
  announceRefusal: CallOutcome['announceRefusal'];
};

export type MaybeFollowUp = (
  channel: Conv,
  normalized: Line,
  selfId: string,
  ownPrefill?: Promise<void> | null
) => Promise<boolean>;

/**
 * Whether a follow-up turn of `triggerKind` that found the attention taken
 * waits in the pending queue: a `followUp` always, an `overheard` while
 * mention.pendingOverheard is on in `config` (missing = on).
 */
function waitsWhenBusy(triggerKind: FollowUpKind, config: PipelineConfig): boolean {
  return triggerKind === 'followUp' || config.mention?.pendingOverheard !== false;
}

export function createFollowUp({
  hot,
  turns,
  followUpGate,
  followUpMuted,
  followUpOff,
  currentOf,
  refOf,
  classifyFollowUp,
  turnBlocked,
  deferFollowUp,
  decideAndLog,
  drainPending,
  announceRefusal,
}: FollowUpContext): { maybeFollowUp: MaybeFollowUp } {
  const followUpInFlight = new Set<string>(); // channelIds with a classifier call running right now
  const followUpHeld = new Map<string, Held>(); // channelId -> the latest message that arrived in flight

  /**
   * Whether an untagged `normalized` message was fully handled by the address
   * classifier (pre-filter or a real model verdict, any answer, or
   * held for a classifier call already in flight in its channel) -- the
   * caller must then NOT also hand it to the spontaneous scheduler. Never
   * throws: an LLM/context-building error is treated as a "no" per the
   * contract. `false` means none of this applied (feature off, no open
   * window, a turn running that blocks this one with mention.classifyWhileBusy
   * off -- see followUpGate) and the caller falls back to its usual
   * handling. `ownPrefill` is the message's picture prefill from
   * warmMediaCache (or null), awaited before its classifier request is built.
   */
  async function maybeFollowUp(
    channel: Conv,
    normalized: Line,
    selfId: string,
    ownPrefill: Promise<void> | null = null
  ): Promise<boolean> {
    const gate = followUpGate(channel, normalized, selfId);
    if (gate.kind === 'skip') return false;
    if (gate.kind === 'handled') return true;

    // At most one classifier call in flight per channel. A message landing
    // while one is already running is held (only the latest per channel; an
    // earlier held one is replaced) and returned as handled. When the call in
    // flight ends without starting a turn, the held message goes through the
    // gate and the classifier as if it had just arrived; after a turn started
    // (a "yes") it is dropped, since the turn reads it in the channel history
    // anyway. An overheard turn frames its line as not said to the persona,
    // so it waits instead: the held message is classified first
    // (settleFollowUp). The slot stays taken until the held messages are
    // worked off, one at a time.
    const channelId = channel.id;
    if (followUpInFlight.has(channelId)) {
      const replaced = followUpHeld.has(channelId);
      followUpHeld.set(channelId, { channel, normalized, selfId, ownPrefill });
      log.info('follow-up: held while a classifier call is in flight', {
        channel: channelId,
        message: normalized.id,
        replaced,
      });
      return true;
    }

    followUpInFlight.add(channelId);
    let settled: Settled;
    try {
      const answer = await classifyFollowUp(channel, normalized, selfId, gate, ownPrefill);
      settled = settleFollowUp(channelId, { channel, normalized }, answer);
    } catch (err) {
      followUpHeld.delete(channelId);
      followUpInFlight.delete(channelId);
      throw err;
    }
    // Not awaited: this message is answered (or waits on a held one); a held
    // one is classified in the background, still holding the slot. With
    // nothing held the slot is released synchronously, before this returns.
    classifyHeldFollowUps(channelId, settled).catch((err: unknown) =>
      log.error('follow-up: classifying a held message failed', { channel: channelId, error: err })
    );
    return true;
  }

  /**
   * Works off the messages held for `channelId` while its classifier slot was
   * taken, one at a time, then frees the slot. `settled` is what the call
   * that just ended left (settleFollowUp): whether it started a turn, and the
   * overheard line still waiting on the held messages, if any. A waiting
   * line that no newer verdict replaced is started at the end
   * (startWaitingLine: its turn is overheard, or followUp with the switch
   * turned off meanwhile) -- or dropped there.
   */
  async function classifyHeldFollowUps(channelId: string, settled: Settled): Promise<void> {
    try {
      let { started, waiting } = settled;
      for (;;) {
        const held = followUpHeld.get(channelId);
        if (!held) break;
        followUpHeld.delete(channelId);
        if (started) {
          log.info('follow-up: held message dropped', {
            channel: channelId,
            message: held.normalized.id,
            reason: 'turn',
          });
          return;
        }
        // As if it had just arrived: paused, onMessage would
        // never reach the classifier (and pause forbids marking the store dirty).
        const muted = followUpMuted();
        const here = muted ? held.channel : await currentOf(held.channel);
        const gate: FollowUpGate = muted
          ? { kind: 'skip', reason: muted }
          : followUpGate(here, held.normalized, held.selfId);
        if (gate.kind === 'skip') {
          log.info('follow-up: held message dropped', {
            channel: channelId,
            message: held.normalized.id,
            reason: gate.reason,
          });
          // A waiting line meets the same check in startWaitingLine, except
          // `closed` (it was classified inside the window).
          break;
        }
        if (gate.kind === 'handled') break;
        const answer = await classifyFollowUp(here, held.normalized, held.selfId, gate, held.ownPrefill);
        ({ started, waiting } = settleFollowUp(channelId, held, answer, waiting));
      }
      if (waiting) await startWaitingLine(channelId, waiting);
    } finally {
      followUpHeld.delete(channelId);
      followUpInFlight.delete(channelId);
    }
  }

  /**
   * What an answer of the address classifier starts for `candidate` (`{
   * message, normalized }`): `{ started, waiting }`. A "no" starts nothing and
   * keeps `waiting` (an earlier overheard line still waiting on held
   * messages). An overheard turn (followUpTriggerKind, the switch read now)
   * waits while a newer message is held in the channel: that one is
   * classified first. Otherwise the turn starts now (startFollowUpTurn), and
   * a waiting line gives way to this newer one, whose turn reads it in the
   * channel history.
   */
  function settleFollowUp(
    channelId: string,
    candidate: Candidate,
    answer: AddressAnswer,
    waiting: Candidate | null = null
  ): Settled {
    if (answer === 'no') return { started: false, waiting };
    if (waiting)
      log.info('follow-up: dropped', { channel: channelId, message: waiting.normalized.id, reason: 'newer' });
    // A "yes" or an "overheard" answer always has its kind.
    const triggerKind = followUpTriggerKind(answer, hot.config.mention) as FollowUpKind;
    if (triggerKind === 'overheard' && followUpHeld.has(channelId)) return { started: false, waiting: candidate };
    return { started: startFollowUpTurn(candidate, triggerKind), waiting: null };
  }

  /**
   * Start the overheard line that waited on the held messages (settleFollowUp)
   * once they are worked off. That took at least one more classifier call,
   * so the gate's checks that do not depend on the window are read again
   * now: paused, the follow-up or mention switch off, or no
   * Send Messages drop the line (`follow-up: dropped` with that reason); a
   * turn running drops it as busy (startFollowUpTurn). A window closed
   * meanwhile does not: the line was classified while it was open. The kind
   * is read now as well (followUpTriggerKind).
   */
  async function startWaitingLine(channelId: string, waiting: Candidate): Promise<void> {
    const config = hot.config;
    let reason: string | null = followUpMuted();
    if (!reason && followUpOff(config)) reason = 'off';
    if (!reason) {
      const here = await currentOf(waiting.channel);
      if (!here.permissions.send) reason = 'cannot-send';
    }
    if (reason) {
      log.info('follow-up: dropped', { channel: channelId, message: waiting.normalized.id, reason });
      return;
    }
    // An "overheard" answer always has its kind.
    startFollowUpTurn(waiting, followUpTriggerKind('overheard', config.mention) as FollowUpKind);
  }

  /**
   * Start the reply turn a follow-up verdict asked for, `triggerKind` being
   * `followUp` or `overheard` (followUpTriggerKind). Never awaits the turn;
   * returns whether it was started: a turn started
   * elsewhere while the classifier was thinking (turnBlocked, read now)
   * would answer 'busy', so none is started (and a held message is not
   * dropped as already answered). A `followUp` that finds the attention
   * taken -- here, or as runTurn's 'busy' -- waits in the pending queue
   * (deferFollowUp); so does an `overheard` one while
   * mention.pendingOverheard is on (missing = on, read at that moment),
   * keeping its kind; with the switch off it is dropped (`follow-up:
   * dropped`, `busy`). A `followUp` the ignore roll lets pass
   * (mention.followUpIgnoreChance, `ignored:follow-up`) starts no turn and
   * returns false, so a line held meanwhile is classified next.
   */
  function startFollowUpTurn({ channel, normalized }: Candidate, triggerKind: FollowUpKind): boolean {
    const channelId = channel.id;
    const config = hot.config;
    if (turnBlocked(channelId, config)) {
      if (waitsWhenBusy(triggerKind, config)) deferFollowUp(channel, normalized, triggerKind);
      else log.info('follow-up: dropped', { channel: channelId, message: normalized.id, reason: 'busy' });
      return false;
    }
    // A follow-up is counted for spam (mention.spamThreshold, future
    // explicit pings) and rolled for mention.followUpIgnoreChance
    // (decideAndLog): the persona may let the other person have the last
    // word. An ignored one starts no turn and leaves the window and its
    // no-streak as they are. Talk about the persona (overheard) is not a call
    // to it: neither counted nor rolled.
    if (triggerKind === 'followUp' && !decideAndLog(channel, normalized, 'followUp', config).respond) return false;
    turns
      .runTurn({ conversation: refOf(channel), mode: 'reply', trigger: normalized, triggerKind })
      .then((result) => {
        if (result?.outcome === 'busy') {
          if (!waitsWhenBusy(triggerKind, hot.config)) {
            log.info('follow-up: dropped', { channel: channelId, message: normalized.id, reason: 'busy' });
            return undefined;
          }
          deferFollowUp(channel, normalized, triggerKind);
          if (!turnBlocked(channelId, hot.config)) return drainPending();
          return undefined;
        }
        return announceRefusal(channel, normalized, result, triggerKind);
      })
      .catch((err: unknown) => log.error('follow-up: reply turn failed', { channel: channelId, error: err }));
    return true;
  }

  return { maybeFollowUp };
}
