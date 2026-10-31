// The pieces of posting one of the persona's library GIFs that the reply turn
// (src/behavior/turn.js#postGif, a `<gif>`) and `message.create`'s `gif` option
// (src/tools/impl/message.ts) share: a fresh URL of an attached GIF, the URL a GIF
// posts as, and the daily count against `gifs.maxPerDay`. No wording here.

import { bumpDaily } from '../time.js';

/**
 * A fresh URL of an attached GIF: its original message is read again (attachment URLs of a platform expire)
 * through the interface's `fetchMessages` and the attachment found by id, in the message itself or in a forwarded
 * message. Null when the entry has no message or anything fails (`onError` told the error).
 * @param {{ reads: import('../interface/reads.ts').Reads, channel: { iface: string, conversationId: string },
 *   entry: { messageId?: string, channelId?: string, itemId?: string }, onError?: (err: unknown) => void }} input
 *   `channel`: the reference of the conversation the turn is in, where an entry of no other conversation is read.
 * @returns {Promise<string|null>}
 */
export async function freshAttachmentUrl({ reads, channel, entry, onError = () => {} }) {
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
    /** @type {(attachments: unknown) => string|null} */
    const urlIn = (attachments) => {
      const list = /** @type {Array<{ id?: string, url?: string }>} */ (Array.isArray(attachments) ? attachments : []);
      return list.find((item) => item.id === entry.itemId)?.url ?? null;
    };
    const own = urlIn(message?.attachments);
    if (own) return own;
    for (const forwarded of /** @type {Array<{ attachments?: unknown }>} */ (message?.forwarded ?? [])) {
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
 * @param {{ url: string }} entry  A library entry (src/memory/gifs.js), which always has its URL.
 * @param {string|null} fresh
 * @returns {string}
 */
export function gifPostUrl(entry, fresh) {
  return fresh ?? entry.url;
}

/** Count one posted GIF against `gifs.maxPerDay` (the counter restarts on a new UTC day); the caller marks the state dirty. */
export function countGifPost(data, nowMs) {
  bumpDaily(data, { dayKey: 'gifDay', countKey: 'gifCount' }, nowMs);
}
