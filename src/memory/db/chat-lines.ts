// The stored lines of one place, oldest first, for the owner's chat sessions (src/chat/): the current
// revision of each message, with deleted ones left out, as recall reads them. A line stands where it was first said and
// is hers when its first revision is: an edit gives the text and the edited mark and carries whatever moment and kind its
// event had (source-current.ts#LINE_MOMENT). Each line carries its number, its place among
// all the stored lines of the place, deleted ones counted, the oldest being 1. The owner's chat draws it as `#N`, and her
// `<chat>` numbers a line by the same count (placeLineNumbers, src/turn/history.ts). Read only, and with no audience
// applied: a number tells nothing of a line's text.

import { LINE_HOLDS_MEDIA, lineMedia } from './media-store.ts';
import type { MediaRow } from './media-store.ts';
import { replyMessageSql, routeMessageSql } from './message-locator.ts';
import { CURRENT_REVISION, LINE_KIND, LINE_MOMENT, LINE_ROWID, SOURCE_DELETED } from './source-current.ts';
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
  /** When the current revision was recorded, for a line edited since it was said (a revision above 1). */
  editedAt?: number;
  /** The number of the line it replies to, when this read holds that line. */
  replyNumber?: number;
};

const HOLDS_SOMETHING = `(length(COALESCE(s.text, '')) > 0 OR ${LINE_HOLDS_MEDIA})`;
/** A counted line of a place: the current revision of a message that holds text or media, deleted since or not. */
const COUNTED = `${CURRENT_REVISION} AND ${HOLDS_SOMETHING}`;
/** How many counted lines a place holds: one read over `sources_place_time` for the place's rows. */
const COUNT_SQL = `SELECT COUNT(*) AS n FROM sources s WHERE s.place_id = ? AND ${COUNTED}`;
/**
 * A line's message id: the platform's from its message route, else its `native_id`. A line written through message
 * families keeps a key of the core's own in `native_id`, and the chat client knows the line by the platform's id.
 */
const MESSAGE_ID = `COALESCE(${routeMessageSql('s')}, s.native_id)`;

/**
 * The newest counted lines of a place, newest first, as `newest(r, m, k)`: the row's `rowid`, the moment the line was first
 * said and where its first revision stands among lines of that moment. The sort holds three columns, so a place of
 * thousands of lines is ordered without reading anything else of each row.
 */
const NEWEST = `WITH newest AS (
  SELECT s.rowid AS r, ${LINE_MOMENT} AS m, ${LINE_ROWID} AS k FROM sources s WHERE s.place_id = ? AND ${COUNTED}
  ORDER BY m DESC, k DESC LIMIT ?)`;

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
  const counted = db.prepare(COUNT_SQL).get(placeId);
  const rows = db
    .prepare(
      `${NEWEST}
       SELECT s.id, ${LINE_KIND} AS kind, s.text, newest.m AS occurred_at, s.recorded_at, s.revision, s.native_id, ${MESSAGE_ID} AS message_id, s.reply_to,
         ${replyMessageSql('s')} AS reply_message, ${SOURCE_DELETED} AS deleted FROM newest JOIN sources s ON s.rowid = newest.r
       ORDER BY newest.m DESC, newest.k DESC`
    )
    .all(placeId, LINES_MAX);
  // A read past LINES_MAX starts after the lines it leaves out, so the numbers stay those of the whole place.
  const skipped = Number(counted?.n ?? rows.length) - rows.length;
  // A deleted line keeps its count and is left out of the lines.
  const numbered = rows
    .toReversed()
    .map((row, index) => ({ row, number: skipped + index + 1 }))
    .filter(({ row }) => !row.deleted);
  const media = lineMedia(
    db,
    numbered.map(({ row }) => asText(row.id)),
    internalContext()
  );
  const byKey = new Map(numbered.map(({ row, number }) => [row.native_id, { id: asText(row.message_id), number }]));
  return numbered.map(({ row, number }) => ({
    id: asText(row.id),
    placeId,
    at: Date.parse(asText(row.occurred_at)),
    who: row.kind === 'said' ? 'her' : 'owner',
    text: asText(row.text),
    ...(typeof row.message_id === 'string' ? { nativeId: row.message_id } : {}),
    ...(media.has(asText(row.id)) ? { media: media.get(asText(row.id)) } : {}),
    number,
    ...(Number(row.revision) > 1 && Number.isFinite(Date.parse(asText(row.recorded_at)))
      ? { editedAt: Date.parse(asText(row.recorded_at)) }
      : {}),
    ...replyOf(row.reply_to, row.reply_message, byKey),
  }));
}

/**
 * The number `chatLines` gives the line of `placeId` whose message id is `nativeId`, the platform's or the row's own:
 * how many of the place's counted lines come up to it in the same order. Null when the place holds no such line or it
 * was deleted.
 */
export function lineNumberOf(db: Db, placeId: string, nativeId: string): number | null {
  const line = db
    .prepare(
      `SELECT ${LINE_MOMENT} AS occurred_at, ${LINE_ROWID} AS r FROM sources s
       WHERE s.place_id = ? AND (s.native_id = ? OR ${routeMessageSql('s')} = ?) AND ${COUNTED}
         AND NOT ${SOURCE_DELETED} LIMIT 1`
    )
    .get(placeId, nativeId, nativeId);
  if (!line) return null;
  const counted = db
    .prepare(
      `${COUNT_SQL}
       AND (${LINE_MOMENT} < ? OR (${LINE_MOMENT} = ? AND ${LINE_ROWID} <= ?))`
    )
    .get(placeId, line.occurred_at, line.occurred_at, line.r);
  return Number(counted?.n ?? 0) || null;
}

/** What placeLineNumbers reads of a place: its count of lines and the numbers of its newest lines by message id. */
export type PlaceLineNumbers = { count: number; numbers: Map<string, number> };

/**
 * The count of the counted lines of `placeId` and the number `chatLines` gives each of its newest `newest` lines, by
 * the line's message id (the platform's from its route, else its `native_id`): one pass over the place's rows, which
 * gives the count and the order of the newest lines, then one read of those rows.
 */
export function placeLineNumbers(db: Db, placeId: string, newest: number): PlaceLineNumbers {
  const rows = db
    .prepare(
      `WITH counted AS MATERIALIZED (
         SELECT s.rowid AS r, ${LINE_MOMENT} AS m, ${LINE_ROWID} AS k FROM sources s WHERE s.place_id = ? AND ${COUNTED})
       SELECT (SELECT COUNT(*) FROM counted) AS n, ${MESSAGE_ID} AS message_id
       FROM (SELECT r, m, k FROM counted ORDER BY m DESC, k DESC LIMIT ?) top JOIN sources s ON s.rowid = top.r
       ORDER BY top.m DESC, top.k DESC`
    )
    .all(placeId, Math.max(0, Math.floor(newest)));
  const count = rows.length > 0 ? Number(rows[0]?.n) : Number(db.prepare(COUNT_SQL).get(placeId)?.n ?? 0);
  const numbers = new Map<string, number>();
  rows.forEach((row, index) => {
    if (typeof row.message_id === 'string' && !numbers.has(row.message_id)) numbers.set(row.message_id, count - index);
  });
  return { count, numbers };
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
