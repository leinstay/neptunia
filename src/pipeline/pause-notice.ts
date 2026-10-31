// The pause notice. While paused (`/nep pause`) a direct call gets one plain line saying so (labels.limits.paused,
// features.pauseNotice), like a limit notice. Read only: no model request, no observe, no queue, no window, no ring
// stamp, nothing marked dirty. The interval lives in memory alone. createMessageHandler (src/behavior/pipeline.js)
// builds it once with createPauseNotice; handleMessage calls maybePauseNotice for a live line while paused.

import { privateChatsOff } from '../behavior/core-pause.ts';
import { lineOf } from '../behavior/line-of.js';
import { pauseNotice, pauseNoticeMinutes, postPauseNotice } from '../behavior/limits.js';
import { detectTrigger } from '../behavior/mention.js';
import { MINUTE_MS } from '../time.js';
import type { Conversations } from './conversations.ts';
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
  getGuildId: () => string | null;
  selfIdOf: () => string;
  checkPrivateGate: PrivateGate['checkPrivateGate'];
  infoNow: Conversations['infoNow'];
  refOf: Conversations['refOf'];
  resolveReference: Conversations['resolveReference'];
};

export function createPauseNotice({
  hot,
  now,
  port,
  getGuildId,
  selfIdOf,
  checkPrivateGate,
  infoNow,
  refOf,
  resolveReference,
}: PauseNoticeContext): { maybePauseNotice: (event: MessageEvent) => Promise<void> } {
  const pauseNoticeAt = new Map<string, number>(); // channelId -> when the last pause notice went out

  /**
   * How `message` (arriving while paused) called the persona directly, by the
   * rules of the live path without its model request: on the server a
   * mention, a reply to one of its messages or its name (each behind its
   * switch) in the served guild, outside threads, in a channel the bot can
   * send in, not the dry-run mirror, from a human; in a private chat
   * (features.privateMessages) an author the private gate lets through, the
   * daily cap aside. `{ channel, trigger, kind }`, or null for anything else
   * (an untagged follow-up included: it would need the address classifier).
   */
  async function pausedCall(event: MessageEvent, config: PipelineConfig): Promise<PausedCall | null> {
    const author = event.message.author;
    const features = config.features ?? {};
    const selfId = selfIdOf();
    if (author?.bot || author?.id === selfId) return null;
    // lineOf gives the normalized line of a message event.
    const normalize = () => lineOf(event) as Line;

    if (event.conversation.communityId === null) {
      if (privateChatsOff(features, event)) return null;
      const guildId = getGuildId();
      if (!guildId) return null;
      const { gate } = await checkPrivateGate(config, guildId, author.id, event.iface);
      if (!gate.ok && gate.reason !== 'cap') return null;
      const privateChannel = await infoNow(event.iface, event.conversation.id);
      return privateChannel ? { channel: privateChannel, trigger: normalize(), kind: 'private' } : null;
    }

    if (event.conversation.communityId !== getGuildId() || event.conversation.kind === 'thread') return null;
    if (config.bot.dryRunChannelId && event.conversation.id === config.bot.dryRunChannelId) return null;
    const channel = await infoNow(event.iface, event.conversation.id);
    if (!channel?.permissions.send) return null;
    const normalized = normalize();
    // The door refuses a whole message without its addressing (src/protocol/validate.js).
    const kind: unknown = detectTrigger({
      mentionsSelf: features.mentions !== false && event.addressing!.mentioned,
      repliesToSelf:
        features.replies !== false &&
        (event.addressing!.replyToSelf || (await resolveReference(refOf(channel), normalized.replyToId))),
      content: normalized.content,
      nameTriggers: features.nameTriggers !== false ? config.bot.nameTriggers : [],
    });
    // detectTrigger answers a trigger kind or null (src/behavior/mention.js).
    return kind ? { channel, trigger: normalized, kind: kind as string } : null;
  }

  /**
   * A message arrived while paused: a direct call (pausedCall) gets the pause
   * notice in its channel -- a reply to the call, like a limit notice -- at
   * most once per channel per mention.pauseNoticeMinutes (0: every call).
   * Off with features.pauseNotice or without the label; anything else stays
   * silent. Config and labels read now.
   */
  async function maybePauseNotice(event: MessageEvent): Promise<void> {
    const config = hot.config;
    if (config.features?.pauseNotice === false) return;
    const labels = hot.prompts?.labels;
    // pauseNotice reads the labels it is given, a missing labels file as none.
    if (!pauseNotice(labels as object)) return;
    const call = await pausedCall(event, config);
    if (!call) return;
    const minutes = pauseNoticeMinutes(config);
    const last = pauseNoticeAt.get(call.channel.id);
    const t = now();
    if (minutes > 0 && last !== undefined && t - last < minutes * MINUTE_MS) return;
    pauseNoticeAt.set(call.channel.id, t);
    // postPauseNotice reads the labels it is given; pauseNotice found the label above, so they are there.
    await postPauseNotice({ ...call, asReply: true, labels: labels as object, config, port });
  }

  return { maybePauseNotice };
}
