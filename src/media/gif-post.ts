// The pieces of posting one of the persona's library GIFs that the reply turn
// (src/behavior/turn.js#postGif, a `<gif>`) and `message.create`'s `gif` option
// (src/tools/impl/message.ts) share: a fresh URL of an attached GIF, the URL a GIF
// posts as. No wording here.

import type { Reads } from '../interface/reads.ts';
import { objOf } from '../tools/types.ts';

/**
 * A fresh URL of an attached GIF: its original message is read again (attachment URLs of a platform expire)
 * through the interface's `fetchMessages` and the attachment found by id, in the message itself or in a forwarded
 * message. Null when the entry has no message or anything fails (`onError` told the error).
 * @param input `channel`: the reference of the conversation the turn is in, where an entry of no other conversation is read.
 */
export async function freshAttachmentUrl({
  reads,
  channel,
  entry,
  onError = () => {},
}: {
  reads: Reads;
  channel: { iface: string; conversationId: string };
  entry: { messageId?: string; channelId?: string; itemId?: string };
  onError?: (err: unknown) => void;
}): Promise<string | null> {
  if (!entry.messageId) return null;
  try {
    const ref =
      entry.channelId && entry.channelId !== channel.conversationId
        ? { ...channel, conversationId: entry.channelId }
        : channel;
    const found = await reads.fetchMessages(ref, [entry.messageId]);
    // A message the interface cannot give (the read failed, the message is gone) is a failed lookup.
    const fetched = found?.messages[0];
    if (!fetched || fetched.missing === true) throw new Error('message unavailable');
    const message = fetched.event?.message;
    const urlIn: (attachments: unknown) => string | null = (attachments) => {
      const list = (Array.isArray(attachments) ? (attachments as Array<unknown>) : []).map((item) => objOf(item));
      const url = list.find((item) => item.id === entry.itemId)?.url;
      return typeof url === 'string' ? url : null;
    };
    const own = urlIn(message?.attachments);
    if (own) return own;
    const forwardedMessages: Array<{ attachments?: unknown }> = message?.forwarded ?? [];
    for (const forwarded of forwardedMessages) {
      const url = urlIn(forwarded.attachments);
      if (url) return url;
    }
    return null;
  } catch (err) {
    onError(err);
    return null;
  }
}

/**
 * The URL a GIF posts as: the fresh one of an attachment when it was found, else the stored one.
 * @param entry A library entry (src/memory/gifs.js), which always has its URL.
 */
export function gifPostUrl(entry: { url: string }, fresh: string | null): string {
  return fresh ?? entry.url;
}
