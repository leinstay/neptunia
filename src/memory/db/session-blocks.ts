// Two blocks of a memory session's request, `<episodes>` and `<intentions>`, read under the session's context. Each read goes
// on the request's read list through `read`. session.ts#buildSessionRequest is the caller.

import { concernsMember, isOpen } from '../../intentions/model.ts';
import type { Intention } from '../../intentions/types.ts';
import { nativeChatOf, placeRefOf } from './frame-reads.ts';
import { scopeWhere } from './scope.ts';
import type { Context } from './scope.ts';
import { asText } from './types.ts';
import type { Db, Row } from './types.ts';

type Person = { id: string; native: string; name: string };
type Read = (kind: string, id: unknown, block: string) => void;

const parse = (text: unknown): unknown => {
  if (typeof text !== 'string' || !text) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

/** The open episodes of the page's people as of the cutoff, newest first, at most `max`. */
export function openEpisodeRows(
  db: Db,
  ctx: Context,
  shown: ReadonlyArray<Person>,
  given: { max: number; cutoffIso: string }
): Array<Row> {
  if (shown.length === 0) return [];
  const episodeScope = scopeWhere(ctx, 'e');
  const ids = shown.map((person) => person.id);
  return db
    .prepare(
      `SELECT e.id, e.subject_id, e.date, e.what, e.feeling FROM episodes e
        WHERE e.retired_at IS NULL AND (e.status IS NULL OR e.status != 'closed') AND e.subject_id IN (${ids.map(() => '?').join(', ')}) AND ${episodeScope.sql}
          AND (e.created_at IS NULL OR e.created_at <= ?)
        ORDER BY COALESCE(e.last_ms, 0) DESC, e.date DESC, e.id LIMIT ?`
    )
    .all(...ids, ...episodeScope.params, given.cutoffIso, given.max);
}

/** The open episodes of the page's people as of the cutoff, each under the id `idOf` gives its row, kept in `episodes`. */
export function episodeLinesOf(
  db: Db,
  ctx: Context,
  shown: ReadonlyArray<Person>,
  given: {
    max: number;
    cutoffIso: string;
    episodes: Map<string, string>;
    idOf: (rowId: string) => string;
    read: Read;
  }
): Array<string> {
  return openEpisodeRows(db, ctx, shown, given).map((row: Row) => {
    const id = given.idOf(row.id as string);
    given.episodes.set(id, row.id as string);
    given.read('episode', row.id, 'episodes');
    const who = shown.find((person) => person.id === row.subject_id)?.name ?? row.subject_id;
    const feeling = row.feeling ? ` (${asText(row.feeling)})` : '';
    return `[${id}] ${[row.date, who].filter(Boolean).join(' ')}: ${asText(row.what)}${feeling}`;
  });
}

/**
 * The id of each stored item of one memory session's request, row id -> id: `k` and the first four characters of
 * `hash` of the row's id, the first character turned into a letter when all four are digits, so no id reads as a
 * numbered one. When two of `rowIds` share an id, every id grows by one character until all differ. Pure.
 */
export function storedIdsOf(rowIds: Iterable<string>, hash: (rowId: string) => string): (rowId: string) => string {
  const idAt = (length: number) => (rowId: string) => {
    const body = hash(rowId).slice(0, length);
    return `k${/^\d+$/.test(body) ? `${String.fromCharCode(97 + Number(body[0]))}${body.slice(1)}` : body}`;
  };
  const rows = [...new Set(rowIds)];
  const longest = Math.max(0, ...rows.map((rowId) => hash(rowId).length));
  let length = 4;
  // A hash shorter than the ids it must tell apart ends the growth: two rows with the same whole hash keep one id.
  while (new Set(rows.map(idAt(length))).size < rows.length && length < longest) length += 1;
  return idAt(length);
}

/** The persona's open intentions that concern the page's people or the batch's places. */
export function intentionLinesOf(
  db: Db,
  ctx: Context,
  shown: ReadonlyArray<Person>,
  placeIds: ReadonlyArray<string>,
  read: Read
): Array<string> {
  const lines: Array<string> = [];
  // The chats the batch's places name on their interfaces: the address each row holds, a DM's as a room's.
  const chats = placeIds.flatMap((id) => {
    const ref = placeRefOf(db, id);
    const chat = ref === null ? null : nativeChatOf(ref);
    return chat === null ? [] : [chat];
  });
  const intentionScope = scopeWhere(ctx, 'i');
  const records = db
    .prepare(
      `SELECT i.id, i.record FROM intentions i WHERE i.archived = 0 AND i.retired_at IS NULL AND ${intentionScope.sql} ORDER BY i.created_ms`
    )
    .all(...intentionScope.params);
  for (const row of records) {
    const record = parse(row.record) as (Row & Intention) | null;
    if (!record || !isOpen(record.status)) continue;
    const concerns =
      shown.some((person) => concernsMember(record, { accountId: person.native, names: [person.name] })) ||
      chats.some((chat) => JSON.stringify(record).includes(chat));
    if (concerns && typeof record.purpose === 'string') {
      lines.push(`${record.status}: ${record.purpose}`);
      read('intention', row.id, 'intentions');
    }
  }
  return lines;
}
