// The pending direct pings. A mention or a reply to the persona the classifier said `yes` to that arrives while a turn is running in its
// own channel (mention.pendingSameChannel) or, with one turn at a time (mention.oneAtATime), in another channel is
// remembered here instead of dropped, and answered once the turn frees up -- every one of them, in arrival order
// (src/behavior/pending.js), unless the turn that spoke there already had it in view (turns.spokeAfterSeeing; a turn
// that named it as still waiting for its own turn does not count). A call whose author already has items waiting in that channel may be about one of them: the merge classifier
// (src/pipeline/merge.ts) folds it into that item instead of queueing it, and the item's turn names it
// (labels.task.added). A follow-up the address classifier said `yes` to that found the attention taken waits here too
// (deferFollowUp, kind `followUp`), and so does an `overheard` one (kind `overheard`): one of
// them per channel (followUpSlot), logged as `follow-up: ...`; at pickup attention must still hold (followUpStale)
// and, like any call, it is dropped as answered only when the turn that spoke there had it in its history
// (turns.spokeAfterSeeing). Never persisted. createMessageHandler (src/behavior/pipeline.js) builds it once with
// createPendingQueue over the queue it shares with the merge and the drain (src/pipeline/drain.ts).

import { addPending, authorCalls, followUpSlot, requeuePending } from '../behavior/pending.ts';
import { log } from '../log.ts';
import { clampChars, oneLine } from '../memory/clamp.ts';
import { CODE } from '../tools/codes.ts';
import type { AddressAttention } from './address-attention.ts';
import type {
  Conv,
  Line,
  MessageReadOptions,
  PendingQueue,
  Ping,
  PipelineHot,
  PipelineMissed,
  PipelineTurns,
  TurnRequest,
} from './types.ts';
import { MAX_MESSAGE_CHARS } from '../format.ts';

/** What src/behavior/pending.js answers a change of the list with: it keeps the entries it is given. */
type Kept = { list: Array<Ping>; evicted: Ping | null };

/** The kinds a queued call has (src/behavior/pending.js#PendingPing). */
export type PingKind = Ping['kind'];

/** What createPendingQueue reads: the dependencies of createMessageHandler, the queue and the window's checks. */
export type PendingQueueContext = {
  hot: PipelineHot;
  now: () => number;
  turns: PipelineTurns;
  missed: PipelineMissed | null;
  pending: PendingQueue;
  followUpMuted: AddressAttention['followUpMuted'];
};

export type PendingQueueOps = {
  queuedCount: (placeId: string, authorId: string) => number;
  itemText: (text: string | undefined) => string;
  queuedFor: (placeId: string, trigger: Line | null | undefined) => TurnRequest['queued'];
  noteUnanswered: (ping: Pick<Ping, 'kind' | 'placeId' | 'trigger'>, code: string) => void;
  logPending: (ping: Ping, event: string, fields?: object) => void;
  deferFollowUp: (channel: Conv, trigger: Line, kind?: 'followUp' | 'overheard') => void;
  enqueuePending: (
    channel: Conv,
    trigger: Line,
    kind: PingKind,
    arrivedAt?: number,
    readOptions?: MessageReadOptions
  ) => void;
  requeueBusy: (ping: Ping) => boolean;
};

/** Whether a turn blocks a new one: one turn at a time, so a turn running anywhere -- the rule runTurn applies. */
export function turnBlocked(turns: PipelineTurns): boolean {
  return turns.isAnyBusy();
}

/** Whether a pending entry is a deferred follow-up or overheard line (deferFollowUp), not a call. */
export function isDeferredFollowUp(ping: Pick<Ping, 'kind'>): boolean {
  return ping.kind === 'followUp' || ping.kind === 'overheard';
}

/** The kinds of call somebody waits on an answer for; an overheard line is nobody's debt. */
const OWED_PING_KINDS = new Set<string | undefined>(['mention', 'reply', 'private', 'followUp']);

export function createPendingQueue({
  hot,
  now,
  turns,
  missed,
  pending,
  followUpMuted,
}: PendingQueueContext): PendingQueueOps {
  /** How many calls `authorId` has waiting in `placeId` (authorCalls): the `queued` count of the pending logs. */
  function queuedCount(placeId: string, authorId: string): number {
    return authorCalls(pending.list, placeId, authorId).length;
  }

  /** A waiting item's or a candidate's text as the merge classifier and the task labels show it: one line, cut. */
  function itemText(text: string | undefined): string {
    return clampChars(oneLine(text), MAX_MESSAGE_CHARS);
  }

  /**
   * The `queued` input of a turn answering `trigger` (src/behavior/turn.js): a
   * function giving, when the turn builds its request, the other calls waiting
   * in `placeId` (never a deferred overheard line: talk about the persona is
   * no call to it), arrival order: the trigger author's own as `{ id, text }`,
   * another member's as `{ id, text, author }` (their display name).
   */
  function queuedFor(placeId: string, trigger: Line | null | undefined): TurnRequest['queued'] {
    if (!trigger?.authorId) return null;
    return () =>
      pending.list
        .filter((p) => p.kind !== 'overheard' && p.placeId === placeId && p.trigger?.id !== trigger.id)
        .sort((a, b) => a.arrivedAt - b.arrivedAt)
        .map((p) => ({
          id: p.trigger.id,
          text: itemText(p.trigger.content),
          ...(p.trigger.authorId === trigger.authorId ? {} : { author: oneLine(p.trigger.authorName ?? '') }),
        }));
  }

  /**
   * Log the ping addPending / requeuePending pushed out to stay within
   * mention.maxPending (the oldest of any channel), with the counts: how many wait now, and the cap.
   */
  function logEvicted(evicted: Ping, maxPending: number): void {
    logPending(evicted, 'dropped', { reason: 'full', pending: pending.list.length, maxPending });
    noteUnanswered(evicted, CODE.PENDING_FULL);
  }

  /**
   * A call that left the pending queue without its turn (evicted `full`, `expired`, `outranked`) is
   * a missed fact with that code (src/behavior/missed.js), so the missed-answer recovery owes it like
   * a turn that was dropped. A private message's stays in its chat. Never throws.
   */
  function noteUnanswered(ping: Pick<Ping, 'kind' | 'placeId' | 'trigger'>, code: string): void {
    if (!missed || !OWED_PING_KINDS.has(ping?.kind) || !ping.trigger?.id) return;
    missed.noteFact({
      reason: code,
      message: { ...ping.trigger, placeId: ping.trigger.placeId ?? ping.placeId },
    });
  }

  /**
   * One log line about a pending entry: `follow-up: <event>` for a deferred
   * follow-up or overheard line (its message id included, as every follow-up
   * line has it),
   * `mention: <event>` for any other call; channel, kind and `fields`.
   */
  function logPending(ping: Ping, event: string, fields: object = {}): void {
    const followUp = isDeferredFollowUp(ping);
    log.info(`${followUp ? 'follow-up' : 'mention'}: ${event}`, {
      channel: ping.placeId,
      kind: ping.kind,
      ...(followUp ? { message: ping.trigger.id } : {}),
      ...fields,
    });
  }

  /**
   * A follow-up `yes` (trigger kind `followUp`) that found the attention
   * taken (startFollowUpTurn): held in the pending queue like a direct call,
   * answered by drainPending once the turn frees up, after the attention check
   * (followUpStale) and the "already answered" one (spokeAfterSeeing) there. Read now: muted
   * (paused), features.followUp / features.mentions off, or its
   * own channel busy with mention.pendingSameChannel off -- not held, dropped
   * with that reason (`busy` for the last two, as before). An `overheard`
   * line (`kind`, startFollowUpTurn) is held the same way. One of them per
   * channel, by followUpSlot: a newer one takes an older one's place
   * (`follow-up: dropped`, `newer`), except that an `overheard` line never
   * takes a waiting `followUp`'s place -- it is dropped itself
   * (`outranked`). Never folded into another call, nor a fold target
   * (waitingItems). `follow-up: deferred` names where the running turn is
   * (`runningIn`), and the kind of an overheard line.
   */
  function deferFollowUp(channel: Conv, trigger: Line, kind: 'followUp' | 'overheard' = 'followUp'): void {
    const config = hot.config;
    const placeId = channel.id;
    const sameChannel = turns.isBusy(placeId);
    const reason: string | null = followUpMuted();
    if (reason) {
      log.info('follow-up: dropped', { channel: placeId, message: trigger.id, reason });
      return;
    }
    const slot = followUpSlot(pending.list, placeId, kind) as { admit: boolean; replaced: Ping | null };
    if (!slot.admit) {
      log.info('follow-up: dropped', { channel: placeId, message: trigger.id, reason: 'outranked' });
      noteUnanswered({ kind, placeId, trigger }, CODE.PENDING_OUTRANKED);
      return;
    }
    if (slot.replaced) dropReplaced(slot.replaced, trigger.id);
    const maxPending = config.mention.maxPending ?? 6;
    const ping = { placeId, channel, trigger, kind, arrivedAt: now() };
    const { list, evicted } = addPending(pending.list, ping, maxPending) as Kept;
    pending.list = list;
    log.info('follow-up: deferred', {
      channel: placeId,
      author: trigger.authorId,
      message: trigger.id,
      runningIn: sameChannel ? placeId : (turns.busyChannels?.()[0] ?? null),
      sameChannel,
      pending: pending.list.length,
      ...(kind === 'overheard' ? { kind } : {}),
    });
    if (evicted) logEvicted(evicted, maxPending);
  }

  /**
   * Remove the deferred follow-up or overheard line a newer entry of its channel replaced
   * (followUpSlot), logged `newer`. A replaced follow-up -- a line said to the persona -- is a
   * `replaced-deferred` fact with both ids (src/behavior/missed.js); an overheard line is not.
   */
  function dropReplaced(older: Ping, newerId: string | null = null): void {
    pending.list = pending.list.filter((p) => p !== older);
    log.info('follow-up: dropped', { channel: older.placeId, message: older.trigger.id, reason: 'newer' });
    if (older.kind === 'followUp')
      missed?.noteFact({ reason: 'replaced-deferred', message: older.trigger, replacedBy: newerId });
  }

  /**
   * Remember a direct ping (mention, reply or private message) that arrived while a turn is running in its own channel
   * or, with one turn at a time, elsewhere. Every call waits, in arrival order (`arrivedAt`, default now): none replaces
   * another, of its channel or of its author. At most mention.maxPending entries; the oldest of any channel is evicted
   * when full (logEvicted). A direct call takes the place of an overheard line waiting in its channel (followUpSlot,
   * `follow-up: dropped`, `newer`): its turn reads that line in the history. `queued` is how many calls the author has
   * waiting in that channel.
   */
  function enqueuePending(
    channel: Conv,
    trigger: Line,
    kind: PingKind,
    arrivedAt: number = now(),
    readOptions?: MessageReadOptions
  ): void {
    const maxPending = hot.config.mention.maxPending ?? 6;
    const { replaced } = followUpSlot(pending.list, channel.id, kind) as { replaced: Ping | null };
    if (replaced) dropReplaced(replaced, trigger.id);
    const ping: Ping = {
      placeId: channel.id,
      channel,
      trigger,
      kind,
      arrivedAt,
      ...(readOptions ? { readOptions } : {}),
    };
    const { list, evicted } = addPending(pending.list, ping, maxPending) as Kept;
    pending.list = list;
    log.info('mention: deferred', {
      channel: channel.id,
      kind,
      sameChannel: turns.isBusy(channel.id),
      pending: pending.list.length,
      queued: queuedCount(channel.id, trigger.authorId),
    });
    if (evicted) logEvicted(evicted, maxPending);
  }

  /**
   * The drain's runTurn answered 'busy': another turn started during the
   * switch pause. The ping goes back into the queue with its original
   * arrivedAt, ahead of every call that came after it (mention.maxPending
   * still applies). Synchronous on
   * purpose -- see drainPending. Returns whether a turn that blocks this ping
   * is still running (its end calls drainPending again through onIdle).
   */
  function requeueBusy(ping: Ping): boolean {
    const mentionCfg = hot.config.mention;
    const maxPending = mentionCfg.maxPending ?? 6;
    const { list, evicted } = requeuePending(pending.list, ping, maxPending) as Kept;
    pending.list = list;
    logPending(ping, 'deferred again', {
      reason: 'busy',
      pending: pending.list.length,
      queued: queuedCount(ping.placeId, ping.trigger.authorId),
    });
    if (evicted) logEvicted(evicted, maxPending);
    return turnBlocked(turns);
  }

  return {
    queuedCount,
    itemText,
    queuedFor,
    noteUnanswered,
    logPending,
    deferFollowUp,
    enqueuePending,
    requeueBusy,
  };
}
