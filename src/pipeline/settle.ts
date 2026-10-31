// Calls from a channel the persona cannot write in (features.elsewhere). A call (a mention, a reply or the persona's
// name) written where the bot can read but not send has nowhere to be answered. When a destination is usable (the
// first usable id of memory.mainChannelIds, src/behavior/turn.js#usableDestination) and everyone who can view it can
// view the source too (the audience rail, context.pull.sameAudience; src/behavior/turn.js#routeFor), the call is
// recorded in the ring (state.json `elsewherePings`: ids and a time, no author, no text) and a settle wait is armed
// for the source: one timer per source, never a busy mark, so the attention stays free while it waits. Every message
// observed in the source moves the wait (elsewhere.settleSeconds after the last one, at most
// elsewhere.settleMaxSeconds after the call that armed it); a newer call there takes the waiting one's place unless
// it is weaker (a name after a tag; callRank), and both stay in the ring; the call that keeps the wait carries the
// other along (`superseded`): the settle groups a burst into one decision. When the wait is over, the call takes the
// ordinary call path (answerCall) with the destination as the channel the turn posts in and the source passed to the
// turn -- pending included -- and the ring follows the outcome: the call by its turn's outcome (markRoutedCall; every
// other call the turn showed is stamped by the turn itself), the call and those it carries when the ignore roll lets
// it pass (passRoutedCall), the call and the others of its source a turn that spoke already had in view
// (skipSeenCalls). A call the ring already holds as answered is never answered again (ringAnswered: state.json, so a
// restart keeps it). The waits live in memory only: a restart during one loses the call, which stays unanswered in
// the ring; a pause (clearPending) and shutdown (stop) clear them.
// The same wait (kind `noticed`, no call, nothing in the ring) follows an eavesdrop hit on an untriggered message
// there (spontaneous.noticeElsewhere) when no wait is armed in that source; when it is over the persona may comment
// on the source in the destination (spontaneous.runNoticed). A call arriving meanwhile takes its place, as a newer
// call does. createMessageHandler (src/behavior/pipeline.js) builds it once with createSettles.

import { elsewhereSettings, recordPing, settleDueAt } from '../behavior/elsewhere.ts';
import { log } from '../log.js';
import type { Answer } from './answer.ts';
import type { CallOutcome } from './call-outcome.ts';
import { callSwitchOff, missingReason } from './call-outcome.ts';
import type { Conversations } from './conversations.ts';
import type { FollowUpWindows } from './follow-up-window.ts';
import type { Timers } from './observe.ts';
import type { Conv, Line, PipelineConfig, PipelineHot, PipelineState, PipelineTurns, TriggerKind } from './types.ts';

/** One settle wait of a source: a routed call (`ping`) or a noticed comment, and its timing. */
type SettleEntry = {
  kind: 'ping' | 'noticed';
  channel: Conv;
  normalized: Line;
  triggerKind: TriggerKind | null;
  superseded: Array<string>;
  firstAt: number;
  lastAt: number;
  due: number | null;
  moved: number;
  timer: unknown;
};

/** The spontaneous scheduler (src/behavior/spontaneous.js#createSpontaneous), as the noticed waits call it. */
type NoticeScheduler = {
  noticeElsewhere?: (source: Conv, normalized: Line) => unknown;
  runNoticed?: (channel: Conv) => Promise<{ reason?: string } | null | undefined>;
};

/** What createSettles reads: the dependencies of createMessageHandler and its other parts' functions. */
export type SettlesContext = {
  hot: PipelineHot;
  store: { state?: PipelineState } | null | undefined;
  now: () => number;
  timers: Timers;
  turns: PipelineTurns;
  spontaneous: NoticeScheduler;
  routeOf: Conversations['routeOf'];
  followUpMuted: FollowUpWindows['followUpMuted'];
  heldCallState: CallOutcome['heldCallState'];
  skipSeenCalls: CallOutcome['skipSeenCalls'];
  answerCall: Answer['answerCall'];
};

export type Settles = {
  clearSettles: (reason: 'paused' | null) => void;
  rememberCall: (source: Conv, normalized: Line, config: PipelineConfig) => void;
  armSettle: (source: Conv, normalized: Line, triggerKind: TriggerKind, destination: Conv) => void;
  maybeNotice: (source: Conv, normalized: Line) => Promise<void>;
  touchSettle: (channelId: string) => void;
};

/**
 * How strongly a call asks for an answer: a tag (mention/reply) above the
 * persona's name, which rolls mention.nameTriggerChance. A settle wait never
 * trades a call for a weaker one.
 */
function callRank(triggerKind: TriggerKind | null | undefined): number {
  if (triggerKind === 'mention' || triggerKind === 'reply') return 2;
  return triggerKind === 'name' ? 1 : 0;
}

export function createSettles({
  hot,
  store,
  now,
  timers,
  turns,
  spontaneous,
  routeOf,
  followUpMuted,
  heldCallState,
  skipSeenCalls,
  answerCall,
}: SettlesContext): Settles {
  // source channel id -> { kind, channel, normalized, triggerKind, superseded, firstAt, lastAt, due, moved, timer }
  const settles = new Map<string, SettleEntry>();

  /**
   * Clear every settle wait without answering its call (it stays unanswered
   * in the ring); with a `reason` each is logged as `elsewhere: dropped`.
   */
  function clearSettles(reason: 'paused' | null): void {
    for (const [sourceId, entry] of settles) {
      timers.clear(entry.timer);
      if (reason)
        log.info('elsewhere: dropped', { source: sourceId, kind: entry.kind, message: entry.normalized.id, reason });
    }
    settles.clear();
  }

  /**
   * Record a routable call written in `source` in the ring (state.json
   * `elsewherePings`; elsewhere.rememberPings and elsewhere.pingMaxAgeDays
   * read from `config` now) and mark the state dirty. No state, nothing kept.
   */
  function rememberCall(source: Conv, normalized: Line, config: PipelineConfig): void {
    const state = store?.state;
    if (!state?.data) return;
    const { rememberPings, pingMaxAgeMs } = elsewhereSettings(config);
    state.data.elsewherePings = recordPing(
      state.data.elsewherePings,
      { messageId: normalized.id, channelId: source.id, ts: normalized.ts },
      { cap: rememberPings, maxAgeMs: pingMaxAgeMs, now: now() }
    );
    state.markDirty?.();
  }

  /** When the wait `entry` is due (settleDueAt, elsewhere.settleSeconds / settleMaxSeconds read now). */
  function settleDue(entry: SettleEntry): number {
    const { settleMs, settleMaxMs } = elsewhereSettings(hot.config);
    return settleDueAt({ firstAt: entry.firstAt, lastAt: entry.lastAt, settleMs, maxMs: settleMaxMs });
  }

  /** (Re)start the timer of the wait `entry` for `due`, the previous one cleared; a real timer is unref'd. */
  function scheduleSettle(sourceId: string, entry: SettleEntry, due: number): void {
    timers.clear(entry.timer);
    const timer = timers.set(() => fireSettle(sourceId, entry), Math.max(0, due - now())) as
      { unref?: () => void } | null | undefined;
    timer?.unref?.();
    entry.timer = timer;
    entry.due = due;
  }

  /**
   * Arm the settle wait of `source` for a routed call of `triggerKind`
   * (`elsewhere: settling`), or, while one is armed there, hand it to this
   * newer call when it is at least as strong (callRank): the waiting call is
   * dropped (`elsewhere: dropped`, `replaced`; it stays in the ring), the wait
   * keeps its start, and its due time was already moved for this message
   * (touchSettle). A weaker newer call (the persona's name after a tag) is the
   * one dropped (`outranked`; it stays in the ring too) and the waiting call
   * keeps its place. Either way the call that keeps the wait carries the one
   * dropped, and whatever that one carried, in `superseded`. Waits are per
   * source: a call elsewhere never touches this one. A waiting noticed
   * comment (no call: callRank 0) always gives way to a call, and the call
   * carries nothing for it (its message is no call of the ring).
   */
  function armSettle(source: Conv, normalized: Line, triggerKind: TriggerKind, destination: Conv): void {
    const waiting = settles.get(source.id);
    if (waiting) {
      if (callRank(triggerKind) < callRank(waiting.triggerKind)) {
        log.info('elsewhere: dropped', {
          source: source.id,
          kind: 'ping',
          message: normalized.id,
          reason: 'outranked',
        });
        waiting.superseded = [...waiting.superseded, normalized.id];
        return;
      }
      log.info('elsewhere: dropped', {
        source: source.id,
        kind: waiting.kind,
        message: waiting.normalized.id,
        reason: 'replaced',
      });
      const superseded =
        waiting.kind === 'noticed' ? [...waiting.superseded] : [...waiting.superseded, waiting.normalized.id];
      Object.assign(waiting, { kind: 'ping', channel: source, normalized, triggerKind, superseded });
      return;
    }
    startSettle(source, normalized, 'ping', triggerKind, destination);
  }

  /**
   * Arm a new settle wait in `source` (none is armed there) for a routed call
   * (`ping`, its `triggerKind`) or a noticed comment (`noticed`, no
   * triggerKind) and log `elsewhere: settling`.
   */
  function startSettle(
    source: Conv,
    normalized: Line,
    kind: 'ping' | 'noticed',
    triggerKind: TriggerKind | null,
    destination: Conv
  ): void {
    const t = now();
    const entry: SettleEntry = {
      kind,
      channel: source,
      normalized,
      triggerKind,
      superseded: [],
      firstAt: t,
      lastAt: t,
      due: null,
      moved: 0,
      timer: null,
    };
    settles.set(source.id, entry);
    scheduleSettle(source.id, entry, settleDue(entry));
    log.info('elsewhere: settling', { source: source.id, kind, message: normalized.id, destination: destination.id });
  }

  /**
   * An untriggered message in `source`, a channel the bot cannot send in,
   * after its settle wait was touched: with no wait armed there, an
   * eavesdrop hit (spontaneous.noticeElsewhere: the rails and the roll)
   * arms one of kind `noticed` toward the destination resolved now.
   */
  async function maybeNotice(source: Conv, normalized: Line): Promise<void> {
    if (settles.has(source.id)) return;
    if ((await spontaneous.noticeElsewhere?.(source, normalized)) !== true) return;
    const route = await routeOf(source, hot.config);
    if (!route.destination) return;
    if (settles.has(source.id)) return;
    startSettle(source, normalized, 'noticed', null, route.destination);
  }

  /**
   * A noticed wait is over: the comment runs through spontaneous.runNoticed,
   * which reads every rail again; one that refuses is logged as
   * `elsewhere: dropped` with its code.
   */
  async function fireNoticed(sourceId: string, { channel, normalized }: SettleEntry): Promise<void> {
    const result = await spontaneous.runNoticed?.(channel);
    if (result?.reason)
      log.info('elsewhere: dropped', {
        source: sourceId,
        kind: 'noticed',
        message: normalized.id,
        reason: result.reason,
      });
  }

  /**
   * A message observed in `channelId`: when a settle wait is armed there, it
   * now ends elsewhere.settleSeconds after this message, never later than
   * elsewhere.settleMaxSeconds after the call that armed it (read now). A
   * message that pushes the due time later counts as `moved`.
   */
  function touchSettle(channelId: string): void {
    const entry = settles.get(channelId);
    if (!entry) return;
    entry.lastAt = now();
    const due = settleDue(entry);
    if (due === entry.due) return;
    // An armed wait is scheduled at once, so it has its due time.
    if (due > (entry.due as number)) entry.moved += 1;
    scheduleSettle(channelId, entry, due);
  }

  /**
   * The settle wait of `sourceId` is over (`elsewhere: settled`): the waiting
   * call takes the ordinary call path (answerCall) toward the destination
   * resolved again now. It is dropped instead, and stays unanswered in the
   * ring, while paused and when the route no longer holds
   * (`elsewhere: dropped` with that code), or, as at the pending drain
   * (heldCallState): when the ring already holds it as answered (`mention:
   * already answered`, reason `ring`: a turn that showed it answered it --
   * read from state.json, so it holds across a restart and after a later
   * turn's view left the call out; read before the lookup below, and once
   * more after it); when its message was deleted meanwhile or cannot be
   * fetched now (`mention: dropped`, `gone` / `fetch-failed`:
   * messageStillExists); when a turn that spoke had it in view
   * (turns.spokeAfterSeeing -- a pulled block showed it and the persona
   * could answer it there; `mention: already answered`, and the call and the
   * other calls of its source that turn showed are stamped skipped in the
   * ring: skipSeenCalls); when its kind's switch was turned off
   * (`mention: dropped`, `off`). The calls it carries (`superseded`) go with it to
   * answerCall. A noticed wait (no call) goes to fireNoticed instead once
   * the pause check passed. A timer whose wait already ended (or
   * was removed) does nothing. Never rejects: it runs from a timer.
   */
  async function fireSettle(sourceId: string, entry: SettleEntry): Promise<void> {
    if (settles.get(sourceId) !== entry) return;
    settles.delete(sourceId);
    try {
      const { kind, channel, normalized, superseded } = entry;
      // A wait of kind `ping` carries the kind of its call; a noticed wait returns before it is read.
      const triggerKind = entry.triggerKind as TriggerKind;
      log.info('elsewhere: settled', { source: sourceId, kind, waitedMs: now() - entry.firstAt, moved: entry.moved });
      const muted = followUpMuted();
      if (muted) {
        log.info('elsewhere: dropped', { source: sourceId, kind, message: normalized.id, reason: muted });
        return;
      }
      if (kind === 'noticed') {
        await fireNoticed(sourceId, entry);
        return;
      }
      const held = await heldCallState(channel, normalized.id, true);
      // A turn that showed this call in a pulled block of its source answered
      // it and stamped the ring (read from state.json: it holds across a
      // restart): not answered a second time.
      if (held === 'answered') {
        log.info('mention: already answered', { channel: sourceId, kind: triggerKind, reason: 'ring' });
        return;
      }
      if (held !== true) {
        log.info('mention: dropped', { channel: sourceId, kind: triggerKind, reason: missingReason(held) });
        return;
      }
      // A turn that spoke meanwhile showed this call in a pulled block of its
      // source: not answered a second time.
      if (turns.spokeAfterSeeing?.(sourceId, normalized.id)) {
        log.info('mention: already answered', { channel: sourceId, kind: triggerKind });
        skipSeenCalls(sourceId, normalized.id);
        return;
      }
      const config = hot.config;
      const features = config.features ?? {};
      // The switch that let this call through in onMessage step 8.
      const switchOff = callSwitchOff(triggerKind, features);
      if (switchOff) {
        log.info('mention: dropped', { channel: sourceId, kind: triggerKind, reason: 'off' });
        return;
      }
      const route = await routeOf(channel, config);
      if (!route.destination) {
        log.info('elsewhere: dropped', { source: sourceId, kind, message: normalized.id, reason: route.reason });
        return;
      }
      answerCall({ channel, normalized, kind: triggerKind, config, destination: route.destination, superseded });
    } catch (err) {
      log.error('elsewhere: settle failed', { source: sourceId, error: err });
    }
  }

  return { clearSettles, rememberCall, armSettle, maybeNotice, touchSettle };
}
