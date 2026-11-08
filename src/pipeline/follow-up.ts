// The door's two paths through the address classifier. A flagged line goes to it at once and its verdict decides the
// turn (answerFlagged). An unflagged line goes only within attention, with at most one call in flight per place, the
// lines that arrive meanwhile held and worked off one at a time (maybeFollowUp). The follow-up or overheard turn a
// verdict asks for starts now or is deferred to the pending queue. createMessageHandler (src/behavior/pipeline.ts) builds
// it once with createFollowUp; handleMessage calls one of the two for every line of a group place.

import { followUpTriggerKind } from '../behavior/mention.ts';
import { log } from '../log.ts';
import type { AddressAnswer, ClassifyAddress } from './address-classifier.ts';
import type { AddressAttention, AddressGate } from './address-attention.ts';
import type { Answer } from './answer.ts';
import type { CallOutcome } from './call-outcome.ts';
import type { ChatRef } from './chats.ts';
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
  addressGate: AddressAttention['addressGate'];
  followUpMuted: AddressAttention['followUpMuted'];
  currentOf: (channel: Conv) => Promise<Conv>;
  refOf: (channel: Conv) => ChatRef;
  classifyAddress: ClassifyAddress;
  turnBlocked: (placeId: string, config: PipelineConfig) => boolean;
  deferFollowUp: PendingQueueOps['deferFollowUp'];
  decideAndLog: Answer['decideAndLog'];
  answerCall: Answer['answerCall'];
  drainPending: () => Promise<void>;
  announceRefusal: CallOutcome['announceRefusal'];
};

export type MaybeFollowUp = (
  channel: Conv,
  normalized: Line,
  selfId: string,
  ownPrefill?: Promise<void> | null
) => Promise<boolean>;

export type AnswerFlagged = (
  channel: Conv,
  normalized: Line,
  kind: 'mention' | 'reply',
  ownPrefill?: Promise<void> | null
) => Promise<boolean>;

export function createFollowUp({
  hot,
  turns,
  addressGate,
  followUpMuted,
  currentOf,
  refOf,
  classifyAddress,
  turnBlocked,
  deferFollowUp,
  decideAndLog,
  answerCall,
  drainPending,
  announceRefusal,
}: FollowUpContext): { maybeFollowUp: MaybeFollowUp; answerFlagged: AnswerFlagged } {
  /**
   * A line that carries the interface's mention or reply flag: its verdict at once, past any call in flight for
   * unflagged lines, so no flagged line is held or replaced. `yes` is an ordinary call of its kind, `overheard` an
   * overheard turn, `no` nothing. Resolves whether the verdict asked for a turn.
   */
  async function answerFlagged(
    channel: Conv,
    normalized: Line,
    kind: 'mention' | 'reply',
    ownPrefill: Promise<void> | null = null
  ): Promise<boolean> {
    const config = hot.config;
    const answer = await classifyAddress(channel, normalized, { config, flagged: true }, ownPrefill);
    if (answer === 'no') return false;
    if (answer === 'overheard') startFollowUpTurn({ channel, normalized }, 'overheard');
    else answerCall({ channel, normalized, kind, config: hot.config });
    return true;
  }

  const followUpInFlight = new Set<string>(); // places with a classifier call running right now
  const followUpHeld = new Map<string, Held>(); // placeId -> the latest message that arrived in flight

  /**
   * Whether an unflagged `normalized` message was fully handled by the address
   * classifier (pre-filter or a real model verdict, any answer, or
   * held for a classifier call already in flight in its place). Never
   * throws: an LLM/context-building error is treated as a "no" per the
   * contract. `false` means none of this applied (outside attention, cannot send: see addressGate).
   * `ownPrefill` is the message's picture prefill from
   * warmMediaCache (or null), awaited before its classifier request is built.
   */
  async function maybeFollowUp(
    channel: Conv,
    normalized: Line,
    selfId: string,
    ownPrefill: Promise<void> | null = null
  ): Promise<boolean> {
    const gate = addressGate(channel, normalized, selfId);
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
    const placeId = JSON.stringify([channel.iface, channel.id]);
    if (followUpInFlight.has(placeId)) {
      const replaced = followUpHeld.has(placeId);
      followUpHeld.set(placeId, { channel, normalized, selfId, ownPrefill });
      log.info('follow-up: held while a classifier call is in flight', {
        channel: channel.id,
        message: normalized.id,
        replaced,
      });
      return true;
    }

    followUpInFlight.add(placeId);
    let settled: Settled;
    try {
      const answer = await classifyAddress(channel, normalized, { config: gate.config, flagged: false }, ownPrefill);
      settled = settleFollowUp(placeId, { channel, normalized }, answer);
    } catch (err) {
      followUpHeld.delete(placeId);
      followUpInFlight.delete(placeId);
      throw err;
    }
    // Not awaited: this message is answered (or waits on a held one); a held
    // one is classified in the background, still holding the slot. With
    // nothing held the slot is released synchronously, before this returns.
    classifyHeldFollowUps(placeId, settled).catch((err: unknown) =>
      log.error('follow-up: classifying a held message failed', { channel: placeId, error: err })
    );
    return true;
  }

  /**
   * Works off the messages held for `placeId` while its classifier slot was
   * taken, one at a time, then frees the slot. `settled` is what the call
   * that just ended left (settleFollowUp): whether it started a turn, and the
   * overheard line still waiting on the held messages, if any. A waiting
   * line that no newer verdict replaced is started at the end
   * (startWaitingLine: its turn is overheard, or followUp with the switch
   * turned off meanwhile) -- or dropped there.
   */
  async function classifyHeldFollowUps(placeId: string, settled: Settled): Promise<void> {
    try {
      let { started, waiting } = settled;
      for (;;) {
        const held = followUpHeld.get(placeId);
        if (!held) break;
        followUpHeld.delete(placeId);
        if (started) {
          log.info('follow-up: held message dropped', {
            channel: placeId,
            message: held.normalized.id,
            reason: 'turn',
          });
          return;
        }
        // As if it had just arrived: paused, onMessage would
        // never reach the classifier (and pause forbids marking the store dirty).
        const muted = followUpMuted();
        const here = muted ? held.channel : await currentOf(held.channel);
        const gate: AddressGate = muted
          ? { kind: 'skip', reason: muted }
          : addressGate(here, held.normalized, held.selfId);
        if (gate.kind === 'skip') {
          log.info('follow-up: held message dropped', {
            channel: placeId,
            message: held.normalized.id,
            reason: gate.reason,
          });
          // A waiting line meets the same check in startWaitingLine, except
          // `closed` (it was classified inside the window).
          break;
        }
        if (gate.kind === 'handled') break;
        const answer = await classifyAddress(
          here,
          held.normalized,
          { config: gate.config, flagged: false },
          held.ownPrefill
        );
        ({ started, waiting } = settleFollowUp(placeId, held, answer, waiting));
      }
      if (waiting) await startWaitingLine(placeId, waiting);
    } finally {
      followUpHeld.delete(placeId);
      followUpInFlight.delete(placeId);
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
    placeId: string,
    candidate: Candidate,
    answer: AddressAnswer,
    waiting: Candidate | null = null
  ): Settled {
    if (answer === 'no') return { started: false, waiting };
    if (waiting) log.info('follow-up: dropped', { channel: placeId, message: waiting.normalized.id, reason: 'newer' });
    // A "yes" or an "overheard" answer always has its kind.
    const triggerKind = followUpTriggerKind(answer) as FollowUpKind;
    if (triggerKind === 'overheard' && followUpHeld.has(placeId)) return { started: false, waiting: candidate };
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
  async function startWaitingLine(placeId: string, waiting: Candidate): Promise<void> {
    let reason: string | null = followUpMuted();
    if (!reason) {
      const here = await currentOf(waiting.channel);
      if (!here.permissions.send) reason = 'cannot-send';
    }
    if (reason) {
      log.info('follow-up: dropped', { channel: placeId, message: waiting.normalized.id, reason });
      return;
    }
    // An "overheard" answer always has its kind.
    startFollowUpTurn(waiting, followUpTriggerKind('overheard') as FollowUpKind);
  }

  /**
   * Start the reply turn a verdict asked for, `triggerKind` being `followUp` or `overheard` (followUpTriggerKind).
   * Never awaits the turn; returns whether it was started: a turn started elsewhere while the classifier was thinking
   * (turnBlocked, read now) would answer 'busy', so none is started (and a held message is not dropped as already
   * answered) and the line waits in the pending queue (deferFollowUp) keeping its kind. A turn the per-author rail
   * refuses starts nothing and returns false, so a line held meanwhile is classified next.
   */
  function startFollowUpTurn({ channel, normalized }: Candidate, triggerKind: FollowUpKind): boolean {
    const placeId = channel.id;
    const config = hot.config;
    // A follow-up turn that finds the attention taken waits in the pending queue, an overheard one too.
    if (turnBlocked(placeId, config)) {
      deferFollowUp(channel, normalized, triggerKind);
      return false;
    }
    if (!decideAndLog(channel, normalized, triggerKind, config).respond) return false;
    turns
      .runTurn({ chat: refOf(channel), mode: 'reply', trigger: normalized, triggerKind })
      .then((result) => {
        if (result?.outcome === 'busy') {
          deferFollowUp(channel, normalized, triggerKind);
          if (!turnBlocked(placeId, hot.config)) return drainPending();
          return undefined;
        }
        return announceRefusal(channel, normalized, result, triggerKind);
      })
      .catch((err: unknown) => log.error('follow-up: reply turn failed', { channel: placeId, error: err }));
    return true;
  }

  return { maybeFollowUp, answerFlagged };
}
