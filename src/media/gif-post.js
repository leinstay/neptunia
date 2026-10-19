// The pieces of posting one of the persona's library GIFs that the reply turn
// (src/behavior/turn.js#postGif, a `<gif>`) and `message.create`'s `gif` option
// (src/ops/message.js) share: a fresh URL of an attached GIF, the URL a GIF
// posts as, and the daily count against `gifs.maxPerDay`. No wording here.

import { bumpDaily } from '../time.js';

/**
 * A fresh URL of an attached GIF: its original message is fetched again (Discord attachment
 * URLs expire) and the attachment found by id, in the message itself or in a forwarded
 * snapshot. Null when the entry has no message or anything fails (`onError` told the error).
 * @param {{ client: object, channel: { id: string }, entry: object, onError?: (err: unknown) => void }} input
 * @returns {Promise<string|null>}
 */
export async function freshAttachmentUrl({ client, channel, entry, onError = () => {} }) {
  if (!entry.messageId) return null;
  try {
    const source = entry.channelId && entry.channelId !== channel.id ? await client.channels.fetch(entry.channelId) : channel;
    const message = await source?.messages?.fetch(entry.messageId);
    const own = message?.attachments?.get?.(entry.itemId);
    if (own?.url) return own.url;
    for (const snapshot of message?.messageSnapshots?.values?.() ?? []) {
      const forwarded = snapshot?.attachments?.get?.(entry.itemId);
      if (forwarded?.url) return forwarded.url;
    }
    return null;
  } catch (err) {
    onError(err);
    return null;
  }
}

/** The URL a GIF posts as: the fresh one of an attachment when it was found, else the stored one. */
export function gifPostUrl(entry, fresh) {
  return fresh ?? entry.url;
}

/** Count one posted GIF against `gifs.maxPerDay` (the counter restarts on a new UTC day); the caller marks the state dirty. */
export function countGifPost(data, nowMs) {
  bumpDaily(data, { dayKey: 'gifDay', countKey: 'gifCount' }, nowMs);
}
