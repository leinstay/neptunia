// The channel history a turn reads and continues: the empty `<recent>` input, the history with the parents its replies
// answer from outside it, the history a turn continues with after her skill call, and the history in time order with
// her call marks among the lines. src/behavior/turn.ts calls them while it reads a channel, the request's head orders
// the lines of `<chat>` and `<channel_view>`; the tests and the replay's skill scenarios call continuationHistory
// through its re-export.

import { fetchReplyParents } from '../behavior/reply-parents.ts';
import type { CallMark, Line } from '../behavior/lines.ts';
import type { Reads } from '../interface/reads.ts';
import type { ConversationInfo } from '../protocol/adapter.ts';

/** No `<recent>` input: no store's lines handed over, so the request builder builds no block. */
export const NO_RECENT = Object.freeze({ lines: undefined, audience: undefined });

/** The parent lines placed before the window per turn. Production value, config cut of 2026-10-31. */
const REPLY_PARENTS_MAX = 4;

/**
 * `history` with the messages its replies answer from outside it prepended as its oldest lines
 * (src/behavior/reply-parents.ts#fetchReplyParents): the parent of `trigger` when it lives in this
 * channel, one level of that parent's own parent, and the parents of every line of the window (the request shows
 * them as anchors in `<earlier>`), at most `REPLY_PARENTS_MAX` in all, each marked `replyParent: true`.
 * `reads` are the core's reads of the interface (src/interface/reads.ts).
 */
export async function withReplyParents(
  reads: Reads,
  channel: ConversationInfo,
  history: Array<Line>,
  { trigger }: { trigger: { id?: string; placeId?: string | null; replyToId?: string | null } | null }
): Promise<Array<Line>> {
  const own = trigger && (!trigger.placeId || trigger.placeId === channel.id) ? trigger : null;
  const parents = await fetchReplyParents(reads, { iface: channel.iface, conversationId: channel.id }, history, {
    trigger: own,
    recent: history.length,
    max: REPLY_PARENTS_MAX,
  });
  // Marked, so the request can say which of its lines came from outside the window (the journal's `seen.parents`).
  return parents.length > 0 ? [...parents.map((parent) => ({ ...parent, replyParent: true })), ...history] : history;
}

/** The list fields of a normalized message (src/protocol/events.ts#Message), empty on a line built here. */
const EMPTY_LINE_LISTS = Object.freeze([
  'mentionedAccountIds',
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
      replyPingAccountId: null,
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

/** What orderedHistory reads of a line: its time, its place and whether it is a reply parent from outside the window. */
type OrderedLine = { readonly ts?: number | null; readonly placeId?: string; readonly replyParent?: boolean };

/** The id of a call mark's line: never a message id, since a message id has no colon prefix of this kind. */
/** A line's time; a line without a finite time keeps its place among the oldest rather than breaking the sort. */
function tsOf(line: OrderedLine): number {
  return typeof line.ts === 'number' && Number.isFinite(line.ts) ? line.ts : 0;
}

function markId(mark: CallMark, i: number): string {
  return `call:${mark.placeId}:${mark.at}:${i}`;
}

/** A call mark as a line of hers at the call's time. */
function markLine(mark: CallMark, i: number): Line {
  return {
    id: markId(mark, i),
    placeId: mark.placeId,
    authorId: '',
    authorName: '',
    content: '',
    self: true,
    ts: mark.at,
    reactions: [],
    kind: 'call',
    call: mark,
  };
}

/**
 * Every line of a turn's chat and every call mark of hers made in its place, in time order, sorted once after the reply
 * parents, the deleted placeholders and the continuation lines are in. A mark is a line of its own with `self: true`,
 * `kind: 'call'` and the call's time. A mark of another place, one older than the oldest line of the window (a reply
 * parent does not count, since it comes from outside the window), one later than `now` and one without a finite time
 * are dropped. At an equal time a message comes before a mark, and two marks keep the order they were given in, which
 * is the journal's. Pure.
 */
export function orderedHistory<TLine extends OrderedLine>(
  lines: ReadonlyArray<TLine>,
  marks: ReadonlyArray<CallMark> | null | undefined,
  now: number
): Array<TLine | Line> {
  const places = new Set(lines.map((line) => line.placeId));
  const window = lines.filter((line) => line.replyParent !== true).map(tsOf);
  const start = window.length > 0 ? Math.min(...window) : Number.POSITIVE_INFINITY;
  const kept = (marks ?? []).filter(
    (mark) => places.has(mark.placeId) && Number.isFinite(mark.at) && mark.at >= start && mark.at <= now
  );
  const all: Array<{ line: TLine | Line; rank: number; order: number }> = [
    ...lines.map((line, order) => ({ line, rank: 0, order })),
    ...kept.map((mark, i) => ({ line: markLine(mark, i), rank: 1, order: i })),
  ];
  all.sort((a, b) => tsOf(a.line) - tsOf(b.line) || a.rank - b.rank || a.order - b.order);
  return all.map((entry) => entry.line);
}
