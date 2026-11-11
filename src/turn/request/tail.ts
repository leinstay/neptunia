// The end of a turn's request: `<now>` with the persona's recent time away, the user message's text parts in their
// cache segments, what the archive keeps of each block, and what of the chat window went in for the journal. The head
// (src/turn/request/head.ts) and the frame's reader (src/turn/request/reader.ts) call them.

import { fill, formatDuration, formatNow } from '../../format.ts';
import { mediaParts } from '../../media/classify.ts';
import { pulledMoment } from './text.ts';
import type { LabelGroup, Labels, Message } from './types.ts';

/** One text part of a request's user message, tagged with its cache segment but the tail. */
export type UserPart = { type: 'text'; text: string; cacheSegment?: 'stable' | 'memory' };

/**
 * A cache segment of the user message by its name. `stable` holds `<self>`, `memory` the listed blocks after it up to
 * the first of the turn's own blocks, `<surroundings>` first, and `tail` the turn's own blocks from `<chat>` on.
 */
export type BlockSegment = 'stable' | 'memory' | 'tail';

/** One block of the user message as it goes out, empty when it has nothing. `section` is its budget section when it has one. */
export type ListedBlock = {
  readonly name: string;
  readonly segment: BlockSegment;
  readonly source: string;
  readonly section?: string;
  readonly text: string;
  readonly offKind?: boolean;
};

/**
 * What the archive keeps of a block: the tag it goes out under, which is not yet the frame's `BlockName`, its size with
 * the tags, its segment, its producer and why it holds what it holds.
 */
export type BlockRecord = {
  readonly name: string;
  readonly chars: number;
  readonly segment: BlockSegment;
  readonly source: string;
  readonly reason: 'empty' | 'kept' | 'cut' | 'not_for_kind';
};

/** One part of a message's media (src/media/classify.ts#mediaParts). */
type MediaPart = { readonly attachments?: Array<{ readonly kind?: string; readonly previewText?: unknown } | null> };

/**
 * The body of `<now>`: the present moment (formatNow), then, when `periods` holds any (the
 * journal's off periods, src/memory/journal.ts#offPeriods, newest first), `labels.journal.offLead`
 * and one line per period: `offPaused` or `offStopped` with `{from}` / `{to}` (the date and
 * the clock in `timezone`, as a pulled channel's header writes them) and `{length}`
 * (formatDuration). A period whose label is missing is left out; without the lead, or with no
 * line left, the clock stands alone. `withClock` false (the request carries `<spatial_awareness>`, which holds the
 * time) leaves the clock out, and with no period line the body is ''. Per-turn: it sits in the tail, never in a cached
 * part.
 */
export function nowBlock(now: number, timezone: string, labels: Labels, periods: unknown, withClock = true): string {
  const clock = withClock ? formatNow(now, timezone, labels.locale) : '';
  const l: LabelGroup = labels.journal ?? {};
  if (!Array.isArray(periods) || periods.length === 0 || typeof l.offLead !== 'string' || !l.offLead.trim())
    return clock;
  const lines: Array<string> = [];
  // The journal's off periods as given, read loosely: a period without its label or its times is left out.
  for (const period of periods as Array<{ kind?: unknown; from?: unknown; to?: unknown } | null>) {
    const template = period?.kind === 'paused' ? l.offPaused : period?.kind === 'stopped' ? l.offStopped : null;
    if (
      typeof template !== 'string' ||
      !template.trim() ||
      typeof period?.from !== 'number' ||
      !Number.isFinite(period.from) ||
      typeof period.to !== 'number' ||
      !Number.isFinite(period.to)
    )
      continue;
    lines.push(
      fill(template, {
        from: pulledMoment(period.from, timezone, labels.locale),
        to: pulledMoment(period.to, timezone, labels.locale),
        length: formatDuration(Math.max(0, period.to - period.from), labels.units),
      })
    );
  }
  return lines.length > 0 ? [clock, l.offLead, ...lines].filter(Boolean).join('\n') : clock;
}

/**
 * The user message's text parts from its listed blocks, one part per cache segment in the order stable, memory, tail.
 * A segment with no text sends no part.
 */
export function userParts(blocks: ReadonlyArray<ListedBlock>): Array<UserPart> {
  const segments = (['stable', 'memory', 'tail'] as const)
    .map((segment) => ({
      text: blocks
        .filter((one) => one.segment === segment)
        .map((one) => one.text)
        .filter(Boolean)
        .join('\n\n'),
      cacheSegment: segment === 'tail' ? null : segment,
    }))
    .filter((segment) => segment.text);
  return segments.map(({ text, cacheSegment }, i) => ({
    type: 'text' as const,
    text: i < segments.length - 1 ? `${text}\n\n` : text,
    ...(cacheSegment ? { cacheSegment } : {}),
  }));
}

/**
 * What the archive keeps of each listed block (src/llm/archive.ts): its size and why it holds what it holds. A block the
 * budget shortened or emptied (`stats`, a section's `dropped`) is `cut`, a block this kind of turn never has `not_for_kind`.
 */
export function blockRecords(
  blocks: ReadonlyArray<ListedBlock>,
  stats: Readonly<Record<string, { readonly dropped?: number } | undefined>>
): Array<BlockRecord> {
  return blocks.map(({ name, segment, source, section, text, offKind }) => {
    const cut = section !== undefined && (stats[section]?.dropped ?? 0) > 0;
    const reason = offKind === true ? 'not_for_kind' : cut ? 'cut' : text ? 'kept' : 'empty';
    return { name, chars: text.length, segment, source, reason };
  });
}

/**
 * What of the chat window entered a turn's request, for the journal: the ids of the kept
 * transcript lines (oldest first), of the reply parents among them (prepended to the window
 * from outside it, `replyParent: true`) and of the kept messages whose text attachment was
 * previewed. `anchoredIds`: the reply parents `<earlier>` showed instead of `<chat>` (the
 * anchored window), counted first.
 */
export function seenOf({
  history,
  keptChat,
  anchoredIds = [],
}: {
  history: Array<Message>;
  keptChat: Array<{ id: string }>;
  anchoredIds?: Array<string>;
}): { messageIds: Array<string>; parents: Array<string>; parts: { filePreviews: Array<string> } } {
  const byId = new Map(history.map((message) => [message.id, message]));
  const messageIds = [...anchoredIds, ...keptChat.map((item) => item.id)].filter((id) => typeof id === 'string' && id);
  const keptMessages = messageIds.map((id) => byId.get(id)).filter((message): message is Message => Boolean(message));
  return {
    messageIds,
    parents: keptMessages.filter((message) => message.replyParent === true).map((message) => message.id),
    parts: {
      filePreviews: keptMessages
        .filter((message) =>
          // mediaParts gives the message's own parts, which it returns as plain objects.
          (mediaParts(message) as Array<MediaPart>).some((part) =>
            (part.attachments ?? []).some((a) => a?.kind === 'text' && typeof a.previewText === 'string')
          )
        )
        .map((message) => message.id),
    },
  };
}
