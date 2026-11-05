// The line of a message: the plain shape the transcript, the memory and the turn read (the key order of the old
// platform normaliser), taken from a whole `message.received` event. It is pure over the event, so a line read through
// the adapter's `history` is the same line the live pipeline gets from the event it receives.

import type { MessageEvent } from '../protocol/adapter.ts';

/**
 * The line of a whole `message.received` event. A deletion, a partial edit or an event without a message has no line.
 */
export function lineOf(event: MessageEvent): Record<string, unknown> {
  const { conversation, message, addressing } = event;
  const author = message.author;
  return {
    id: message.id,
    placeId: conversation.id,
    channelName: conversation.name,
    channelCategory: conversation.category,
    channelTopic: conversation.topic,
    authorId: author?.id,
    authorName: author?.name,
    self: author?.self,
    bot: author?.bot,
    content: message.content,
    ts: message.at,
    editedAt: message.editedAt ?? null,
    mentionedAccountIds: addressing?.mentionedAccountIds,
    mentionedUsers: addressing?.mentionedUsers ?? [],
    mentionedChannelIds: addressing?.mentionedConversationIds,
    replyToId: message.replyToId,
    replyPingAccountId: message.replyPingAccountId,
    forwardedFrom: message.forwardedFrom,
    attachments: message.attachments,
    links: message.links,
    forwarded: message.forwarded,
    stickers: message.stickers,
    emojis: message.emojis,
    reactions: message.reactions,
    messageRefs: message.messageRefs ?? [],
  };
}
