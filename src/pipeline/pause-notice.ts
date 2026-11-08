// The pause notice. While paused (`/nep pause`) a direct call gets one plain line saying so (labels.limits.paused,
// features.pauseNotice), like a limit notice. Read only: no model request, no observe, no queue, no window, no ring
// stamp, nothing marked dirty. The interval lives in memory alone. createMessageHandler (src/behavior/pipeline.ts)
// builds it once with createPauseNotice; handleMessage calls maybePauseNotice for a live line while paused.

import { dmChatsOff } from '../behavior/core-pause.ts';
import { lineOf } from '../behavior/line-of.ts';
import { pauseNotice, PAUSE_NOTICE_MINUTES, postPauseNotice } from '../behavior/limits.ts';
import { detectTrigger } from '../behavior/mention.ts';
import { MINUTE_MS } from '../time.ts';
import type { Chats } from './chats.ts';
import type { MessageEvent } from './edits.ts';
import type { PrivateGate } from './private-gate.ts';
import type { Conv, Line, PipelineConfig, PipelineHot } from './types.ts';

/** A direct call that arrived while paused: where, the line and how it called the persona. */
type PausedCall = { channel: Conv; trigger: Line; kind: string };

/** What createPauseNotice reads: the dependencies of createMessageHandler and its other parts' functions. */
export type PauseNoticeContext = {
  hot: PipelineHot;
  now: () => number;
  port: Parameters<typeof postPauseNotice>[0]['port'];
  /** A root some connected interface serves. */
  isServedRoot: (placeId: string | null | undefined) => boolean;
  selfIdOf: () => string;
  checkPrivateGate: PrivateGate['checkPrivateGate'];
  infoNow: Chats['infoNow'];
  refOf: Chats['refOf'];
  resolveReference: Chats['resolveReference'];
};

export function createPauseNotice({
  hot,
  now,
  port,
  isServedRoot,
  selfIdOf,
  checkPrivateGate,
  infoNow,
  refOf,
  resolveReference,
}: PauseNoticeContext): { maybePauseNotice: (event: MessageEvent) => Promise<void> } {
  const pauseNoticeAt = new Map<string, number>(); // placeId -> when the last pause notice went out

  /**
   * How `message` (arriving while paused) called the persona directly, by the
   * flags of the live path without its model request: a mention or a reply to one of its messages in a served place
   * the bot can send in, from a human; in a private chat
   * (dm.enabled) an author the private gate lets through. `{ channel, trigger, kind }`, or null for anything else
   * (an unflagged line included: it would need the address classifier).
   */
  async function pausedCall(event: MessageEvent, config: PipelineConfig): Promise<PausedCall | null> {
    const author = event.message.author;
    const selfId = selfIdOf();
    if (author?.bot || author?.id === selfId) return null;
    // lineOf gives the normalized line of a message event.
    const normalize = () => lineOf(event) as Line;

    if (event.chat.rootId === null) {
      if (dmChatsOff(config, event)) return null;
      const { gate } = await checkPrivateGate(config, author.id, event.iface);
      if (!gate.ok) return null;
      const privateChannel = await infoNow(event.iface, event.chat.id);
      return privateChannel ? { channel: privateChannel, trigger: normalize(), kind: 'private' } : null;
    }

    if (!isServedRoot(event.chat.rootId)) return null;
    const channel = await infoNow(event.iface, event.chat.id);
    if (!channel?.permissions.send) return null;
    const normalized = normalize();
    // The door refuses a whole message without its addressing (src/protocol/validate.ts).
    const kind = detectTrigger({
      mentionsSelf: event.addressing!.mentioned,
      repliesToSelf: event.addressing!.replyToSelf || (await resolveReference(refOf(channel), normalized.replyToId)),
    });
    return kind ? { channel, trigger: normalized, kind } : null;
  }

  /**
   * A message arrived while paused: a direct call (pausedCall) gets the pause
   * notice in its channel -- a reply to the call, like a limit notice -- at
   * most once per channel per mention.PAUSE_NOTICE_MINUTES (0: every call).
   * Off with features.pauseNotice or without the label; anything else stays
   * silent. Config and labels read now.
   */
  async function maybePauseNotice(event: MessageEvent): Promise<void> {
    const config = hot.config;
    const labels = hot.prompts?.labels;
    // pauseNotice reads the labels it is given, a missing labels file as none.
    if (!pauseNotice(labels as object)) return;
    const call = await pausedCall(event, config);
    if (!call) return;
    const minutes = PAUSE_NOTICE_MINUTES;
    const last = pauseNoticeAt.get(call.channel.id);
    const t = now();
    if (minutes > 0 && last !== undefined && t - last < minutes * MINUTE_MS) return;
    pauseNoticeAt.set(call.channel.id, t);
    // postPauseNotice reads the labels it is given; pauseNotice found the label above, so they are there.
    await postPauseNotice({ ...call, asReply: true, labels: labels as object, port });
  }

  return { maybePauseNotice };
}
