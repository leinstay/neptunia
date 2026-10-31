// The channel history a turn reads and continues: the empty `<recent>` input, the history with the parents its replies
// answer from outside it, and the history a turn continues with after her skill call. src/behavior/turn.js calls them
// while it reads a channel; the tests and the replay's skill scenarios call continuationHistory through its re-export.

import { fetchReplyParents } from '../behavior/reply-parents.ts';
import type { Line } from '../behavior/lines.ts';
import type { Reads } from '../interface/reads.ts';
import type { ConversationInfo } from '../protocol/adapter.ts';

/** No `<recent>` input: no store's lines handed over, so the request builder builds no block. */
export const NO_RECENT = Object.freeze({ lines: undefined, audience: undefined });

/** The config keys withReplyParents reads. */
type ReplyParentsConfig = {
  context?: { fetchReplyParents?: unknown; replyParentsFor?: number; replyParentsMax?: number } | null;
  features?: { anchoredWindow?: unknown } | null;
};

/**
 * `history` with the messages its replies answer from outside it prepended as its oldest lines
 * (src/behavior/reply-parents.ts#fetchReplyParents): the parent of `trigger` when it lives in this
 * channel, one level of that parent's own parent, and the parents of the last
 * `context.replyParentsFor` lines (every line of the window with `features.anchoredWindow`
 * exactly true: the request then shows the parents as anchors in `<earlier>`), at most
 * `context.replyParentsMax` in all, each marked `replyParent: true`. Off with
 * `context.fetchReplyParents` false (a missing key counts as on); `history` as it is then.
 * `reads` are the core's reads of the interface (src/interface/reads.ts).
 */
export async function withReplyParents(
  reads: Reads,
  channel: ConversationInfo,
  history: Array<Line>,
  {
    trigger,
    config,
  }: {
    trigger: { id?: string; channelId?: string | null; replyToId?: string | null } | null;
    config: ReplyParentsConfig;
  }
): Promise<Array<Line>> {
  const context = config.context ?? {};
  if (context.fetchReplyParents === false) return history;
  const own = trigger && (!trigger.channelId || trigger.channelId === channel.id) ? trigger : null;
  const parents = await fetchReplyParents(reads, { iface: channel.iface, conversationId: channel.id }, history, {
    trigger: own,
    recent: config.features?.anchoredWindow === true ? history.length : (context.replyParentsFor ?? 3),
    max: context.replyParentsMax ?? 4,
  });
  // Marked, so the request can say which of its lines came from outside the window (the journal's `seen.parents`).
  return parents.length > 0 ? [...parents.map((parent) => ({ ...parent, replyParent: true })), ...history] : history;
}

/** The list fields of a normalized message (src/protocol/events.js#Message), empty on a line built here. */
const EMPTY_LINE_LISTS = Object.freeze([
  'mentionedUserIds',
  'mentionedChannelIds',
  'attachments',
  'links',
  'forwarded',
  'stickers',
  'emojis',
  'reactions',
]);

/** Whether a list argument is a list (a JavaScript caller may pass anything). */
function isList<TItem>(value: ReadonlyArray<TItem> | null | undefined): value is ReadonlyArray<TItem> {
  return Array.isArray(value);
}

/** A line of a channel as continuationHistory reads it: the id and the time, the rest passes through. */
type ChannelLine = Record<string, unknown> & { id?: unknown; ts?: unknown };

/**
 * The turn's channel as it stands when the turn continues after the persona's skill call
 * (followUp): the turn's `history` as it was (its lines, previews and order untouched), then the
 * lines it did not hold yet, oldest first -- those of a fresh fetch (`fetched`: her own posts of
 * the turn as the platform gives them, and what others wrote meanwhile), then her posts of the turn the
 * fetch did not return (`own`, act's `lines`: id, time and text as written; `selfName` as their
 * author's name, the missing list fields empty). A line without an id is left out; an id is kept
 * once, the first time it comes. The call marks and trigger links are the caller's to put on.
 * Pure; exported for the tests and the replay's skill scenarios.
 */
export function continuationHistory({
  history,
  fetched = [],
  own = [],
  selfName = null,
}: {
  history: ReadonlyArray<ChannelLine | null | undefined>;
  fetched?: ReadonlyArray<ChannelLine | null | undefined> | null;
  own?: ReadonlyArray<ChannelLine | null | undefined> | null;
  selfName?: string | null;
}): Array<ChannelLine | null | undefined> {
  const base = isList(history) ? history : [];
  const seen = new Set<unknown>(base.map((line) => line?.id).filter((id) => typeof id === 'string' && id));
  const asLine = (line: ChannelLine): ChannelLine => {
    const out: ChannelLine = {
      channelName: null,
      authorName: selfName ?? '',
      bot: false,
      replyToId: null,
      replyPingUserId: null,
      forwardedFrom: null,
      ...line,
      self: true,
    };
    for (const key of EMPTY_LINE_LISTS) if (!Array.isArray(out[key])) out[key] = [];
    return out;
  };
  const later: Array<ChannelLine> = [];
  const add = (line: ChannelLine | null | undefined) => {
    if (!line || typeof line.id !== 'string' || !line.id || seen.has(line.id)) return;
    seen.add(line.id);
    later.push(line);
  };
  for (const line of isList(fetched) ? fetched : []) add(line);
  for (const line of isList(own) ? own : []) if (line && !seen.has(line.id)) add(asLine(line));
  later.sort((a, b) => (Number(a.ts) || 0) - (Number(b.ts) || 0));
  return [...base, ...later];
}
