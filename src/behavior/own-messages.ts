// The persona's own messages of a conversation, found through the interface's `history` read: the `fetchOwnMessages` the
// journal's reconciliation after a restart is handed. The text of a message is the one written in the core's grammar
// (`sourceText`), the form a post's intent was recorded in, never the text as the chat shows it.

import type { Reads } from '../interface/reads.ts';

export type OwnMessage = { id: string; content: string; replyToId: string | null; createdAt: number };

/**
 * The last `count` messages of a conversation that are hers. It rejects when the interface cannot give the history, so
 * the reconciliation leaves the operation unknown instead of closing it as never posted.
 */
export function ownMessagesOf(
  reads: Reads,
  iface: string
): (conversationId: string, count: number) => Promise<Array<OwnMessage>> {
  return async (conversationId, count) => {
    const found = await reads.history({ iface, conversationId }, { limit: count });
    if (found === null) throw new Error(`the interface cannot give the history of conversation ${conversationId}`);
    const own: Array<OwnMessage> = [];
    for (const { message } of found.events) {
      if (message.author?.self !== true) continue;
      own.push({
        id: message.id,
        content: message.sourceText ?? message.content ?? '',
        replyToId: message.replyToId ?? null,
        createdAt: message.at ?? 0,
      });
    }
    return own;
  };
}
