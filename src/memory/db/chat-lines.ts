// The stored lines of one place, oldest first, for the owner's chat sessions (src/chat/): the current
// revision of each message, with deleted ones left out, as recall reads them. Each line carries its number, its place among
// all these lines of the place, the oldest being 1, which the owner's chat draws as `#N` and nothing sends to her. Read only,
// and through the owner's own command, so this reader applies no audience: only the `cli` principal reaches it.

import { LINE_HOLDS_MEDIA, lineMedia } from './media-store.ts';
import type { MediaRow } from './media-store.ts';
import { replyMessageSql, routeMessageSql } from './message-locator.ts';
import { CURRENT_SOURCE } from './recall.ts';
import { internalContext } from './scope.ts';
import { asText } from './types.ts';
import type { Db } from './types.ts';

/** The newest lines a session shows: far past any chat, and a bound on one read. Decided 2026-11-05. */
const LINES_MAX = 5000;

export type ChatLine = {
  id: string;
  placeId: string;
  at: number;
  who: 'owner' | 'her';
  text: string;
  /** The line's message id (`MESSAGE_ID`). */
  nativeId?: string;
  media?: Array<MediaRow>;
  /** The line's place among all the stored lines of its place, in the order of this read, the oldest being 1. */
  number: number;
  /** The message id of the line it replies to, when it replies to one. */
  replyToId?: string;
  /** The number of the line it replies to, when this read holds that line. */
  replyNumber?: number;
};

const HOLDS_SOMETHING = `(length(COALESCE(s.text, '')) > 0 OR ${LINE_HOLDS_MEDIA})`;
/**
 * A line's message id: the platform's from its message route, else its `native_id`. A line written through message
 * families keeps a key of the core's own in `native_id`, and the chat client knows the line by the platform's id.
 */
const MESSAGE_ID = `COALESCE(${routeMessageSql('s')}, s.native_id)`;

const filled = (value: unknown): value is string => typeof value === 'string' && value !== '';

/**
 * The reply fields of a line that replies to the stored key `parent`, or to the platform message `routed`: the parent's
 * message id as this read gives it, else the platform's, else the key, and its number when the read holds it.
 */
function replyOf(
  parent: unknown,
  routed: unknown,
  byKey: ReadonlyMap<unknown, { id: string; number: number }>
): Pick<ChatLine, 'replyToId' | 'replyNumber'> {
  const held = filled(parent) ? byKey.get(parent) : undefined;
  if (held !== undefined) return { replyToId: held.id, replyNumber: held.number };
  if (filled(routed)) return { replyToId: routed };
  return filled(parent) ? { replyToId: parent } : {};
}

/** The stored lines of `placeId`, oldest first, each with its number; none without a database. */
export function chatLines(db: Db | null, placeId: string): Array<ChatLine> {
  if (db === null) return [];
  const counted = db
    .prepare(`SELECT COUNT(*) AS n FROM sources s WHERE s.place_id = ? AND ${CURRENT_SOURCE} AND ${HOLDS_SOMETHING}`)
    .get(placeId);
  const rows = db
    .prepare(
      `SELECT s.id, s.kind, s.text, s.occurred_at, s.native_id, ${MESSAGE_ID} AS message_id, s.reply_to,
         ${replyMessageSql('s')} AS reply_message FROM sources s
       WHERE s.place_id = ? AND ${CURRENT_SOURCE} AND ${HOLDS_SOMETHING}
       ORDER BY s.occurred_at DESC, s.rowid DESC LIMIT ?`
    )
    .all(placeId, LINES_MAX);
  const media = lineMedia(
    db,
    rows.map((row) => asText(row.id)),
    internalContext()
  );
  // A read past LINES_MAX starts after the lines it leaves out, so the numbers stay those of the whole place.
  const skipped = Number(counted?.n ?? rows.length) - rows.length;
  const ordered = rows.toReversed();
  const byKey = new Map(
    ordered.map((row, index) => [row.native_id, { id: asText(row.message_id), number: skipped + index + 1 }])
  );
  return ordered.map((row, index) => ({
    id: asText(row.id),
    placeId,
    at: Date.parse(asText(row.occurred_at)),
    who: row.kind === 'said' ? 'her' : 'owner',
    text: asText(row.text),
    ...(typeof row.message_id === 'string' ? { nativeId: row.message_id } : {}),
    ...(media.has(asText(row.id)) ? { media: media.get(asText(row.id)) } : {}),
    number: skipped + index + 1,
    ...replyOf(row.reply_to, row.reply_message, byKey),
  }));
}

/**
 * The number `chatLines` gives the line of `placeId` whose message id is `nativeId`, the platform's or the row's own:
 * how many of the place's lines come up to it in the same order. Null when the place holds no such line.
 */
export function lineNumberOf(db: Db, placeId: string, nativeId: string): number | null {
  const line = db
    .prepare(
      `SELECT s.occurred_at, s.rowid AS r FROM sources s
       WHERE s.place_id = ? AND (s.native_id = ? OR ${routeMessageSql('s')} = ?) AND ${CURRENT_SOURCE}
         AND ${HOLDS_SOMETHING} LIMIT 1`
    )
    .get(placeId, nativeId, nativeId);
  if (!line) return null;
  const counted = db
    .prepare(
      `SELECT COUNT(*) AS n FROM sources s WHERE s.place_id = ? AND ${CURRENT_SOURCE} AND ${HOLDS_SOMETHING}
       AND (s.occurred_at < ? OR (s.occurred_at = ? AND s.rowid <= ?))`
    )
    .get(placeId, line.occurred_at, line.occurred_at, line.r);
  return Number(counted?.n ?? 0) || null;
}

/**
 * The newest lines of a group's place, newest first, each with the author's stored names: a task's recent context. Only
 * what the groups may read: a line of a DM that once landed under the same spelled place stays out.
 */
export function recentGroupLines(
  db: Db,
  placeId: string,
  count: number
): Array<{ kind: string; text: string | null; names: string | null; media?: Array<MediaRow> }> {
  const rows = db
    .prepare(
      `SELECT s.id, s.kind, s.text, a.names FROM sources s LEFT JOIN accounts a ON a.id = s.author_account
       WHERE s.place_id = ? AND s.kind IN ('seen', 'said') AND s.retired_at IS NULL AND ${HOLDS_SOMETHING}
         AND s.audience_id LIKE 'aud:group:%'
       ORDER BY s.occurred_at DESC, s.rowid DESC LIMIT ?`
    )
    .all(placeId, count);
  const media = lineMedia(
    db,
    rows.map((row) => asText(row.id)),
    internalContext()
  );
  return rows.map((row) => ({
    kind: asText(row.kind),
    text: typeof row.text === 'string' ? row.text : null,
    names: typeof row.names === 'string' ? row.names : null,
    ...(media.has(asText(row.id)) ? { media: media.get(asText(row.id)) } : {}),
  }));
}
