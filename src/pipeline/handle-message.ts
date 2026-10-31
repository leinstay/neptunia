// What happens to one new message: ignored, observed into memory, handed to the spontaneous scheduler, put to the
// address or room classifier, or answered as a call, here or in the main channel once its channel settles. A message
// the gateway delivered and one the start's catch-up delivered are handled once, whichever path reaches it first.
// createMessageHandler (src/behavior/pipeline.js) builds it once with createHandleMessage and returns its onMessage.

import { observeWhilePaused } from '../behavior/core-pause.ts';
import type { PausedDeps } from '../behavior/core-pause.ts';
import { isLimitNotice } from '../behavior/limits.js';
import { lineOf } from '../behavior/line-of.js';
import { detectTrigger } from '../behavior/mention.js';
import { log } from '../log.js';
import type { MessageReceived } from '../protocol/events.js';
import type { Answer } from './answer.ts';
import type { Conversations } from './conversations.ts';
import type { MessageEvent } from './edits.ts';
import type { FollowUpWindows } from './follow-up-window.ts';
import type { MaybeFollowUp } from './follow-up.ts';
import type { NoteFollowingLine } from './following.ts';
import type { MediaPrefill } from './media-prefill.ts';
import type { ObserveLine } from './observe.ts';
import type { PrivateGate } from './private-gate.ts';
import type { MaybeRoom } from './room.ts';
import type { Settles } from './settle.ts';
import type { Conv, Line, PipelineHot, PipelineMissed, PipelineState, PipelineTurns, TriggerKind } from './types.ts';

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
  memory: { observe: (guildId: string, line: Line, options?: { direct: boolean }) => void };
  spontaneous: { onMessage: (channel: Conv, normalized: Line) => unknown };
  activity: { note: (channelId: string, authorId: string, at: number) => void } | null;
  missed: PipelineMissed | null;
  getGuildId: () => string | null;
  selfIdOf: () => string;
  observeLine: ObserveLine;
  maybePauseNotice: (event: MessageEvent) => Promise<void>;
  onPrivateMessage: PrivateGate['onPrivateMessage'];
  resolveReference: Conversations['resolveReference'];
  turnPlaceOf: Conversations['turnPlaceOf'];
  routeOf: Conversations['routeOf'];
  warmMediaCache: MediaPrefill['warmMediaCache'];
  noteFollowUpSend: FollowUpWindows['noteFollowUpSend'];
  noteFollowingLine: NoteFollowingLine;
  touchSettle: Settles['touchSettle'];
  maybeFollowUp: MaybeFollowUp;
  maybeNotice: Settles['maybeNotice'];
  maybeRoom: MaybeRoom;
  rememberCall: Settles['rememberCall'];
  armSettle: Settles['armSettle'];
  answerCall: Answer['answerCall'];
};

export type HandleMessage = {
  onMessage: (event: MessageEvent) => Promise<void>;
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
  spontaneous,
  activity,
  missed,
  getGuildId,
  selfIdOf,
  observeLine,
  maybePauseNotice,
  onPrivateMessage,
  resolveReference,
  turnPlaceOf,
  routeOf,
  warmMediaCache,
  noteFollowUpSend,
  noteFollowingLine,
  touchSettle,
  maybeFollowUp,
  maybeNotice,
  maybeRoom,
  rememberCall,
  armSettle,
  answerCall,
}: HandleMessageContext): HandleMessage {
  // The ids of the messages the gateway delivered and of those the start's catch-up delivered
  // (catchUpMessage), each the newest CATCH_UP_IDS_KEPT: a message the gateway also delivers is
  // handled once, whichever path reaches it first. The live path never skips a message the
  // catch-up has not taken.
  const liveIds = new Set<string>();
  // observeWhilePaused always names the record of the line it observes (src/behavior/core-pause.ts).
  const pausedDeps = { hot, getGuildId, selfIdOf, observeLine: observeLine as PausedDeps['observeLine'] };
  const caughtUpIds = new Set<string>();
  /** Add `id` to `ids`, the oldest past the cap going first. */
  function keepId(ids: Set<string>, id: string): void {
    ids.add(id);
    // The set is past its cap, so it has a first value.
    if (ids.size > CATCH_UP_IDS_KEPT) ids.delete(ids.values().next().value as string);
  }

  async function onMessage(event: MessageEvent): Promise<void> {
    await handleMessage(event, null);
  }

  /**
   * One message posted while the bot was offline (src/behavior/catch-up.js, at start), handled
   * like a live one with three differences: it is dropped when the gateway (or an earlier
   * catch-up) already delivered it; nothing at all happens while paused (no pause notice), in a
   * private chat or for a line that is no call (no follow-up, eavesdrop or room question for
   * stale chatter); and a call (a mention, a reply to the persona, her name -- the live
   * detectTrigger) reaches the ordinary call path (answerCall, or the settle wait of a channel
   * she cannot write in) only with `trigger` true, otherwise it is only observed. Never throws.
   */
  async function catchUpMessage(
    event: MessageReceived & { raw: object },
    { trigger = false }: { trigger?: boolean } = {}
  ): Promise<'duplicate' | 'ignored' | 'observed' | 'triggered'> {
    // A catch-up delivers whole messages (src/behavior/catch-up.js).
    return (await handleMessage(event as MessageEvent, { trigger: trigger === true })) ?? 'ignored';
  }

  // health: allow complexity until 2027-04-01 -- moved whole from src/behavior/pipeline.js in stage 5d, a pure move
  async function handleMessage(event: MessageEvent, catchUp: CatchUp): Promise<Handled> {
    try {
      // 1. System / webhook messages are not conversation.
      if (event.message.system === true) return 'ignored';

      // 1a. Paused (/nep pause): no trigger, no turn, no eavesdrop, nothing marks the store dirty. A live line is observed
      // into the memory database and the core holds it for the resume, which hands it back through the catch-up path
      // (core-pause.ts), so it is not noted as live; a direct call also gets the pause notice (maybePauseNotice).
      if (store?.state?.data?.paused) {
        if (!catchUp) await Promise.all([maybePauseNotice(event), observeWhilePaused(event, pausedDeps)]);
        return 'ignored';
      }

      // 1b. Once per message across the gateway and the start's catch-up (checked and noted
      // before the first await, so the two paths never both take it).
      const messageId = event.message.id ?? null;
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
      const features = config.features ?? {};
      const memoryOn = features.memory !== false;

      // 2. DMs: private chat (features.privateMessages, off by default) --
      // see onPrivateMessage. Owner commands are slash commands
      // (the interface's command handler), never DMs.
      if (event.conversation.communityId === null) {
        if (catchUp) return 'ignored';
        await onPrivateMessage(event, config);
        return;
      }

      // 3. This instance serves exactly one guild; no threads. Which channels
      // it sees is the platform's permissions alone.
      if (event.conversation.communityId !== getGuildId()) return 'ignored';
      if (event.conversation.kind === 'thread') return 'ignored';

      // 3b. The dry-run mirror channel is the owner's private test room: it
      // carries the persona's own rehearsal output (src/behavior/turn.js),
      // never real conversation. Nothing posted here is ever observed into
      // memory, no trigger is detected, no turn runs, no eavesdrop.
      const dryRunChannelId = config.bot.dryRunChannelId;
      if (dryRunChannelId && event.conversation.id === dryRunChannelId) return 'ignored';

      // 3c. When this author last wrote in this channel, for a turn that waits until the person
      // it answers stops writing (pace.settleMs). The persona's own messages never count.
      if (event.message.author.id !== selfIdOf())
        activity?.note(event.conversation.id, event.message.author.id, event.message.at);
      // Any message, hers included, pushes back a missed-answer sweep armed here (src/behavior/missed.js).
      missed?.noteActivity(event.conversation.id, event.message.at);

      const selfId = selfIdOf();
      // lineOf gives the normalized line of a message event.
      const normalized = lineOf(event) as Line;
      const guildId = event.conversation.communityId;

      // 5. Its own message: only bookkeeping. Also (re)opens/extends the
      // follow-up window for this channel -- see noteFollowUpSend above. A
      // limit notice is not the persona's speech: the post is noted, but it
      // never opens a window or reaches memory.
      if (normalized.self) {
        turns.notePost(normalized.channelId, normalized.ts);
        // isLimitNotice reads the labels it is given, a missing labels file as none.
        if (isLimitNotice(hot.prompts?.labels as object, normalized.content)) return 'ignored';
        noteFollowUpSend(normalized.channelId, normalized.ts);
        if (memoryOn) {
          memory.observe(guildId, normalized);
          const observing = observeLine(event, false, { guildId });
          if (observing) await observing;
        }
        return 'observed';
      }

      // 6. Other bots are never answered, never memorised.
      if (event.message.author.bot) return 'ignored';

      // 6b. A line soon after the persona's own one here joins her participation episode.
      noteFollowingLine(guildId, normalized, config);

      // 8. Detect how (if at all) the persona was called, masking each input
      // by its own feature switch so detectTrigger itself stays pure. Done
      // BEFORE memory observes the message, so the buffer can mark it. A
      // forward of the persona's own message has no replyToId: not a reply.
      // The door refuses a whole message without its addressing (src/protocol/validate.js).
      const mentionsSelf = features.mentions !== false && event.addressing!.mentioned;
      // The adapter's cached answer first; else the reference is fetched as before.
      const repliesToSelf =
        features.replies !== false &&
        (event.addressing!.replyToSelf ||
          (await resolveReference(
            { iface: event.iface, conversationId: event.conversation.id },
            normalized.replyToId
          )));
      const nameTriggers = features.nameTriggers !== false ? config.bot.nameTriggers : [];
      // detectTrigger answers a trigger kind or null (src/behavior/mention.js).
      const kind = detectTrigger({
        mentionsSelf,
        repliesToSelf,
        content: normalized.content,
        nameTriggers,
      }) as TriggerKind | null;

      // 9. Everyone else feeds memory; a message addressed to the persona is
      // marked `direct` so the analyzer can weigh it separately.
      const ownPrefill = warmMediaCache(guildId, normalized);
      if (memoryOn) {
        memory.observe(guildId, normalized, { direct: Boolean(kind) });
        const observing = observeLine(event, Boolean(kind), { guildId });
        if (observing) await observing;
      }

      // 9b. A channel whose call waits to be answered elsewhere is still talking: its settle wait moves (touchSettle).
      touchSettle(event.conversation.id);

      // 10. No trigger: maybe a follow-up (features.followUp) inside a window the persona itself opened by answering --
      // fully handled by maybeFollowUp either way (a computed verdict or a deliberate no-op, see its own header
      // comment); otherwise let the spontaneous scheduler eavesdrop, nothing more. In a channel the bot cannot send in,
      // an eavesdrop hit there arms a noticed settle wait (maybeNotice). A line the eavesdrop roll did not schedule may
      // still be put to the whole room (maybeRoom). A caught-up line stops here: no follow-up, eavesdrop or room
      // question for chatter from before the start; so does a caught-up call not to be answered. Nothing opens a
      // turn in a diary mirror's place: only her diary writes there (src/behavior/mirror.ts).
      if (catchUp && (!kind || !catchUp.trigger)) return 'observed';
      const channel = await turnPlaceOf(event);
      if (!channel) return 'observed';
      if (!kind) {
        const followedUp = await maybeFollowUp(channel, normalized, selfId, ownPrefill);
        if (!followedUp) {
          const scheduled = spontaneous.onMessage(channel, normalized) === true;
          if (!channel.permissions.send) await maybeNotice(channel, normalized);
          else if (!scheduled) await maybeRoom(channel, normalized, ownPrefill);
        }
        return;
      }

      // 11. The persona was called where it cannot write: the call is
      // answered in the main channel when the route holds (routeFor) --
      // recorded in the ring, then answered once this channel settles
      // (armSettle). Otherwise it is never queued, but it leaves a trace with
      // the route's code.
      if (!channel.permissions.send) {
        const route = await routeOf(channel, config);
        if (!route.destination) {
          log.info('mention: dropped', {
            channel: channel.id,
            kind,
            reason: 'cannot-send',
            route: route.reason,
          });
          return 'observed';
        }
        rememberCall(channel, normalized, config);
        armSettle(channel, normalized, kind, route.destination);
        return 'triggered';
      }

      // 11b. Decide whether to actually answer, or keep a direct call
      // pending while a turn runs (answerCall).
      answerCall({ channel, normalized, kind, config });
      return 'triggered';
    } catch (err) {
      log.error('events: message handler failed', { error: err });
      return 'ignored';
    }
  }

  return { onMessage, catchUpMessage };
}
