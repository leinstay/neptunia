// Deleted messages in the persona's chat window. The window is the live history the interface
// returns, so a message deleted since simply vanishes from it. The record (src/memory/record.js)
// still holds a `deleted` line for it (src/pipeline/edits.ts#onMessageDelete) and the `seen`
// line it was first recorded with: this module reads the record over the window's span in the one
// channel and turns each deletion the history lacks into a placeholder message at its own place,
// numbered like any line and rendered without text (src/format.js, labels.transcript.deleted).

/** How many placeholders a window keeps when `context.deletedLinesMax` is not a whole number of at least 0. */
export const DELETED_LINES_MAX_DEFAULT = 10;

/** The placeholders cap under `context` (`deletedLinesMax`; 0 allowed, anything else unusable takes the default). */
export function deletedLinesMax(context) {
  const value = context?.deletedLinesMax;
  return Number.isInteger(value) && value >= 0 ? value : DELETED_LINES_MAX_DEFAULT;
}

/**
 * The deletions of `channelId` over the span of `history` (from its oldest line that is not a
 * reply parent) that the history does not hold: `{ placeholders, deletedIds, ms }`. A placeholder
 * is a message shaped like a normalized one with `deleted: true`, empty `content` and no media,
 * its author named by the history, else `nameOf(id)`, else the id; its time is the original
 * message's (the `seen` line of the same scan), else the `deleted` line's own `occurredAt`, which
 * is the message's time for a line written by src/pipeline/edits.ts#onMessageDelete (an older line, dated by
 * the deletion, gives that time). The scan starts at the window's oldest line, so a message older
 * than the window deleted today is not read at all. `deletedIds` holds every
 * such message id (the cap cuts only the placeholders, the newest `max` stay). Reads only; a
 * failed read is `{ placeholders: [], deletedIds: empty, ms, failed: true }`.
 * @param {{ record: { iterate: Function }, guildId: string, channelId: string, history: object[],
 *   selfId?: string|null, selfName?: string, nameOf?: ((id: string) => string|null)|null, max?: number, clock?: () => number }} input
 */
export async function deletedLinesOf({
  record,
  guildId,
  channelId,
  history,
  selfId = null,
  selfName = '',
  nameOf = null,
  max = DELETED_LINES_MAX_DEFAULT,
  clock = Date.now,
}) {
  const started = clock();
  const empty = { placeholders: [], deletedIds: new Set(), ms: 0 };
  const own = (history ?? []).filter(
    (message) => message && message.replyParent !== true && Number.isFinite(message.ts)
  );
  if (!record || typeof record.iterate !== 'function' || own.length === 0) return empty;
  const oldest = Math.min(...own.map((message) => message.ts));
  const present = new Set((history ?? []).map((message) => String(message?.id)));
  const names = new Map();
  for (const message of history ?? [])
    if (message?.authorId && message.authorName) names.set(String(message.authorId), message.authorName);
  const seen = new Map();
  const gone = new Map();
  try {
    for await (const line of record.iterate(guildId, {
      from: new Date(oldest).toISOString(),
      channelIds: [String(channelId)],
    })) {
      const id = typeof line?.messageId === 'string' ? line.messageId : '';
      if (!id || present.has(id)) continue;
      if (line.kind === 'deleted') gone.set(id, line);
      else if (line.kind === 'seen' && !seen.has(id)) seen.set(id, line);
    }
  } catch {
    return { ...empty, ms: clock() - started, failed: true };
  }
  const all = [];
  for (const [id, line] of gone) {
    const first = seen.get(id) ?? null;
    const ts = Date.parse(first?.occurredAt ?? line.occurredAt);
    if (!Number.isFinite(ts)) continue;
    const authorId = (typeof first?.by === 'string' && first.by) || line.participants?.[0] || null;
    const self = authorId !== null && selfId !== null && String(authorId) === String(selfId);
    const name = self
      ? selfName
      : (names.get(String(authorId)) ??
        (authorId ? nameOf?.(String(authorId)) : null) ??
        (authorId ? String(authorId) : ''));
    all.push({
      id,
      channelId: String(channelId),
      authorId: authorId ? String(authorId) : '',
      authorName: name,
      self,
      bot: false,
      content: '',
      ts,
      deleted: true,
      mentionedUserIds: [],
      mentionedChannelIds: [],
      replyToId: null,
      attachments: [],
      links: [],
      forwarded: [],
      stickers: [],
      emojis: [],
      reactions: [],
    });
  }
  all.sort((a, b) => a.ts - b.ts);
  const kept = max > 0 ? all.slice(-max) : [];
  return { placeholders: kept, deletedIds: new Set(all.map((message) => message.id)), ms: clock() - started };
}

/**
 * `history` with the placeholders in their own places by time (each before the first line of the
 * window that is later; reply parents, shown first, stay first), `history` itself when none.
 */
export function withDeletedLines(history, placeholders) {
  if (!Array.isArray(placeholders) || placeholders.length === 0) return history;
  const out = [...history];
  for (const placeholder of placeholders) {
    const at = out.findIndex((message) => message.replyParent !== true && message.ts > placeholder.ts);
    if (at === -1) out.push(placeholder);
    else out.splice(at, 0, placeholder);
  }
  return out;
}
