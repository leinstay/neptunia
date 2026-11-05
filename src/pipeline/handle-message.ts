// What happens to one new message: ignored, observed into memory, put to the
// address classifier, or answered as a call. A message
// the gateway delivered and one the start's catch-up delivered are handled once, whichever path reaches it first.
// createMessageHandler (src/behavior/pipeline.ts) builds it once with createHandleMessage and returns its onMessage.

import { sharedPlaceOf } from '../memory/addresses.ts';
import { observeWhilePaused } from '../behavior/core-pause.ts';
import type { PausedDeps } from '../behavior/core-pause.ts';
import { isLimitNotice } from '../behavior/limits.ts';
import { lineOf } from '../behavior/line-of.ts';
import { detectTrigger } from '../behavior/mention.ts';
import { log } from '../log.ts';
import type { MessageReceived } from '../protocol/events.ts';
import type { Conversations } from './conversations.ts';
import type { MessageEvent } from './edits.ts';
import type { AddressAttention } from './address-attention.ts';
import type { AnswerFlagged, MaybeFollowUp } from './follow-up.ts';
import type { NoteFollowingLine } from './following.ts';
import type { MediaPrefill } from './media-prefill.ts';
import type { ObserveLine } from './observe.ts';
import type { PrivateGate } from './private-gate.ts';
import type { Line, MessageReadOptions, PipelineHot, PipelineMissed, PipelineState, PipelineTurns } from './types.ts';

/** How many message ids each path of handleMessage remembers (the live one, the start's catch-up). */
const CATCH_UP_IDS_KEPT = 1000;

/** What became of one message. */
type Handled = 'duplicate' | 'ignored' | 'observed' | 'triggered' | undefined;

/** The start's catch-up of a message: whether a call in it is answered. */
type CatchUp = { trigger: boolean } | null;

/** What createHandleMessage reads: the dependencies of createMessageHandler and its other parts' functions. */
export type HandleMessageContext = {
  hot: PipelineHot;
  store: { state?: PipelineState } | null | undefined;
  turns: PipelineTurns;
  memory: { observe: (placeId: string, line: Line, options?: { direct: boolean }) => void };
  activity: { note: (placeId: string, authorId: string, at: number) => void } | null;
  missed: PipelineMissed | null;
  /** A community some connected interface serves. */
  isServedCommunity: (placeId: string | null | undefined) => boolean;
  selfIdOf: () => string;
  observeLine: ObserveLine;
  maybePauseNotice: (event: MessageEvent) => Promise<void>;
  onPrivateMessage: PrivateGate['onPrivateMessage'];
  resolveReference: Conversations['resolveReference'];
  turnPlaceOf: Conversations['turnPlaceOf'];
  warmMediaCache: MediaPrefill['warmMediaCache'];
  noteAttention: AddressAttention['noteAttention'];
  noteFollowingLine: NoteFollowingLine;
  maybeFollowUp: MaybeFollowUp;
  answerFlagged: AnswerFlagged;
};

export type HandleMessage = {
  onMessage: (event: MessageEvent, options?: MessageReadOptions) => Promise<void>;
  catchUpMessage: (
    event: MessageReceived & { raw: object },
    options?: { trigger?: boolean }
  ) => Promise<'duplicate' | 'ignored' | 'observed' | 'triggered'>;
};

export function createHandleMessage({
  hot,
  store,
  turns,
  memory,
  activity,
  missed,
  isServedCommunity,
  selfIdOf,
  observeLine,
  maybePauseNotice,
  onPrivateMessage,
  resolveReference,
  turnPlaceOf,
  warmMediaCache,
  noteAttention,
  noteFollowingLine,
  maybeFollowUp,
  answerFlagged,
}: HandleMessageContext): HandleMessage {
  // The ids of the messages the gateway delivered and of those the start's catch-up delivered
  // (catchUpMessage), each the newest CATCH_UP_IDS_KEPT: a message the gateway also delivers is
  // handled once, whichever path reaches it first. The live path never skips a message the
  // catch-up has not taken.
  const liveIds = new Set<string>();
  // observeWhilePaused always names the record of the line it observes (src/behavior/core-pause.ts).
  const isServed = isServedCommunity;
  const pausedDeps = {
    hot,
    isServed,
    sharedPlaceOf: (conversation: never, iface: string) => sharedPlaceOf(store, conversation, iface),
    selfIdOf,
    observeLine: observeLine as PausedDeps['observeLine'],
  };
  const caughtUpIds = new Set<string>();
  /** Add `id` to `ids`, the oldest past the cap going first. */
  function keepId(ids: Set<string>, id: string): void {
    ids.add(id);
    // The set is past its cap, so it has a first value.
    if (ids.size > CATCH_UP_IDS_KEPT) ids.delete(ids.values().next().value as string);
  }

  async function onMessage(event: MessageEvent, options?: MessageReadOptions): Promise<void> {
    await handleMessage(event, null, options);
  }

  /**
   * One message posted while the bot was offline (src/behavior/catch-up.ts, at start), handled
   * like a live one with three differences: it is dropped when the gateway (or an earlier
   * catch-up) already delivered it; nothing at all happens while paused (no pause notice), in a
   * private chat or for a line that carries no flag (no follow-up for stale chatter); and a flagged line (a mention, a
   * reply to the persona) reaches the classifier and its verdict's turn only with `trigger` true, otherwise it is only
   * observed. Never throws.
   */
  async function catchUpMessage(
    event: MessageReceived & { raw: object },
    { trigger = false }: { trigger?: boolean } = {}
  ): Promise<'duplicate' | 'ignored' | 'observed' | 'triggered'> {
    // A catch-up delivers whole messages (src/behavior/catch-up.ts).
    return (await handleMessage(event as MessageEvent, { trigger: trigger === true })) ?? 'ignored';
  }

  // health: allow complexity until 2027-04-01 -- moved whole from src/behavior/pipeline.ts in stage 5d, a pure move
  async function handleMessage(event: MessageEvent, catchUp: CatchUp, options?: MessageReadOptions): Promise<Handled> {
    try {
      // 1. System / webhook messages are not conversation.
      if (event.message.system === true) return 'ignored';

      // 1a. Paused (/nep pause): no trigger, no turn, nothing marks the store dirty. A live line is observed
      // into the memory database and the core holds it for the resume, which hands it back through the catch-up path
      // (core-pause.ts), so it is not noted as live; a direct call also gets the pause notice (maybePauseNotice).
      if (store?.state?.data?.paused) {
        if (!catchUp)
          await Promise.all([maybePauseNotice(event), observeWhilePaused(event, pausedDeps, options?.acceptedEvent)]);
        return 'ignored';
      }

      // 1b. Once per message across the gateway and the start's catch-up (checked and noted
      // before the first await, so the two paths never both take it).
      const messageId = event.message.id
        ? JSON.stringify([event.iface, event.conversation.id, event.message.id])
        : null;
      if (messageId) {
        if (caughtUpIds.has(messageId)) return 'duplicate';
        if (catchUp) {
          if (liveIds.has(messageId)) return 'duplicate';
          keepId(caughtUpIds, messageId);
        } else {
          keepId(liveIds, messageId);
        }
      }

      const config = hot.config;
      const memoryOn = true;

      // 2. DMs: private chat (features.privateMessages, off by default) --
      // see onPrivateMessage. Owner commands are slash commands
      // (the interface's command handler), never DMs.
      if (event.conversation.rootId === null && event.conversation.chatType !== 'group_dm') {
        if (catchUp) return 'ignored';
        await onPrivateMessage(event, config, options);
        return;
      }

      // 3. A place under a root the interface serves, or a group that has no root. Threads are followed places like
      // any other; which places it sees is the platform's permissions alone.
      if (event.conversation.rootId !== null && !isServed(event.conversation.rootId)) return 'ignored';

      // 3c. When this author last wrote in this channel, for a turn that waits until the person
      // it answers stops writing (pace.settleMs). The persona's own messages never count.
      if (event.message.author.id !== selfIdOf())
        activity?.note(event.conversation.id, event.message.author.id, event.message.at);
      // Any message, hers included, pushes back a missed-answer sweep armed here (src/behavior/missed.ts).
      missed?.noteActivity(event.conversation.id, event.message.at, event.iface);

      const selfId = selfIdOf();
      // lineOf gives the normalized line of a message event.
      const normalized = lineOf(event) as Line;
      // A served community is a string: the door refuses any other shape, and the gate above admits only those.
      const placeId = sharedPlaceOf(store, event.conversation, event.iface);

      // 5. Its own message: only bookkeeping. Also opens or extends attention
      // in this place (noteAttention). A limit notice is not the persona's
      // speech: the post is noted, but it never opens attention or reaches memory.
      if (normalized.self) {
        turns.notePost(normalized.placeId, normalized.ts);
        // isLimitNotice reads the labels it is given, a missing labels file as none.
        if (isLimitNotice(hot.prompts?.labels as object, normalized.content)) return 'ignored';
        noteAttention(event.iface, normalized.placeId, normalized.ts);
        if (memoryOn) {
          memory.observe(placeId, normalized);
          const observing = observeLine(event, false, { placeId }, options?.acceptedEvent);
          if (observing) await observing;
        }
        return 'observed';
      }

      // 6. Other bots are never answered, never memorised.
      if (event.message.author.bot) return 'ignored';

      // 6b. A line soon after the persona's own one here joins her participation episode.
      noteFollowingLine(placeId, normalized, config);

      // 8. The flags the interface reports. Done BEFORE memory observes the message, so the buffer can mark it. A
      // forward of the persona's own message has no replyToId: not a reply.
      // The door refuses a whole message without its addressing (src/protocol/validate.ts).
      const mentionsSelf = event.addressing!.mentioned;
      // The adapter's cached answer first; else the reference is fetched as before.
      const repliesToSelf =
        event.addressing!.replyToSelf ||
        (await resolveReference({ iface: event.iface, conversationId: event.conversation.id }, normalized.replyToId));
      const kind = detectTrigger({ mentionsSelf, repliesToSelf });

      // 9. Everyone else feeds memory; a message addressed to the persona is
      // marked `direct` so the analyzer can weigh it separately.
      const ownPrefill = warmMediaCache(placeId, normalized);
      if (memoryOn) {
        memory.observe(placeId, normalized, { direct: Boolean(kind) });
        const observing = observeLine(event, Boolean(kind), { placeId }, options?.acceptedEvent);
        if (observing) await observing;
      }

      // 10. A caught-up line stops here unless it is a flagged line to answer: no classifier for chatter from before
      // the start. Nothing opens a turn in a diary mirror's place: only her diary writes there (src/behavior/mirror.ts).
      if (catchUp && (!kind || !catchUp.trigger)) return 'observed';
      const channel = await turnPlaceOf(event);
      if (!channel) return 'observed';
      if (!kind) {
        await maybeFollowUp(channel, normalized, selfId, ownPrefill);
        return;
      }

      // 11. A flagged line where she cannot write: no conversation stands in for it, so it is never asked about or
      // queued, and leaves a trace.
      if (!channel.permissions.send) {
        log.info('mention: dropped', { channel: channel.id, kind, reason: 'cannot-send' });
        return 'observed';
      }

      // 11b. Its verdict decides: a turn now, a held call while a turn runs, or nothing.
      return (await answerFlagged(channel, normalized, kind, ownPrefill)) ? 'triggered' : 'observed';
    } catch (err) {
      log.error('events: message handler failed', { error: err });
      return 'ignored';
    }
  }

  return { onMessage, catchUpMessage };
}
