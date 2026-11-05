// The stored lines of one place, oldest first, for the owner's conversation sessions (src/conversation/): the current
// revision of each message, with deleted ones left out, as recall reads them. Read only, and through the owner's own command,
// so this reader applies no audience: only the `cli` principal reaches it.

import { CURRENT_SOURCE } from './recall.ts';
import { asText } from './types.ts';
import type { Db } from './types.ts';

/** The newest lines a session shows: far past any chat, and a bound on one read. Decided 2026-11-05. */
const LINES_MAX = 5000;

export type ConversationLine = {
  id: string;
  placeId: string;
  at: number;
  who: 'owner' | 'her';
  text: string;
  nativeId?: string;
};

export function conversationLines(db: Db, placeId: string): Array<ConversationLine> {
  const rows = db
    .prepare(
      `SELECT s.id, s.kind, s.text, s.occurred_at, s.native_id FROM sources s
       WHERE s.place_id = ? AND ${CURRENT_SOURCE} AND length(COALESCE(s.text, '')) > 0
       ORDER BY s.occurred_at DESC, s.rowid DESC LIMIT ?`
    )
    .all(placeId, LINES_MAX);
  return rows.toReversed().map((row) => ({
    id: asText(row.id),
    placeId,
    at: Date.parse(asText(row.occurred_at)),
    who: row.kind === 'said' ? 'her' : 'owner',
    text: asText(row.text),
    ...(typeof row.native_id === 'string' ? { nativeId: row.native_id } : {}),
  }));
}

/**
 * The newest lines of a group's place, newest first, each with the author's stored names: a task's recent context. Only
 * what the groups may read: a line of a DM that once landed under the same spelled place stays out.
 */
export function recentGroupLines(
  db: Db,
  placeId: string,
  count: number
): Array<{ kind: string; text: string | null; names: string | null }> {
  return db
    .prepare(
      `SELECT s.kind, s.text, a.names FROM sources s LEFT JOIN accounts a ON a.id = s.author_account
       WHERE s.place_id = ? AND s.kind IN ('seen', 'said') AND s.retired_at IS NULL AND length(COALESCE(s.text, '')) > 0
         AND s.audience_id LIKE 'aud:group:%'
       ORDER BY s.occurred_at DESC, s.rowid DESC LIMIT ?`
    )
    .all(placeId, count) as Array<{ kind: string; text: string | null; names: string | null }>;
}
