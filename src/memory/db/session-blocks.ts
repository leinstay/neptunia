// Two blocks of a memory session's request, `<episodes>` and `<intentions>`, read under the session's context. Each read goes
// on the request's read list through `read`. session.ts#buildSessionRequest is the caller.

import { concernsMember, isOpen } from '../../intentions/model.ts';
import type { Intention } from '../../intentions/types.ts';
import { nativeOf } from './ids.ts';
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

/** The open episodes of the page's people as of the cutoff, each under the handle it gets in `episodes`. */
export function episodeLinesOf(
  db: Db,
  ctx: Context,
  shown: ReadonlyArray<Person>,
  given: { max: number; cutoffIso: string; episodes: Map<string, string>; read: Read }
): Array<string> {
  if (shown.length === 0) return [];
  const episodeScope = scopeWhere(ctx, 'e');
  const ids = shown.map((person) => person.id);
  const rows = db
    .prepare(
      `SELECT e.id, e.subject_id, e.date, e.what, e.feeling FROM episodes e
        WHERE e.retired_at IS NULL AND (e.status IS NULL OR e.status != 'closed') AND e.subject_id IN (${ids.map(() => '?').join(', ')}) AND ${episodeScope.sql}
          AND (e.created_at IS NULL OR e.created_at <= ?)
        ORDER BY COALESCE(e.last_ms, 0) DESC, e.date DESC, e.id LIMIT ?`
    )
    .all(...ids, ...episodeScope.params, given.cutoffIso, given.max);
  return rows.map((row: Row, index: number) => {
    given.episodes.set(`e${index + 1}`, row.id as string);
    given.read('episode', row.id, 'episodes');
    const who = shown.find((person) => person.id === row.subject_id)?.name ?? row.subject_id;
    const feeling = row.feeling ? ` (${asText(row.feeling)})` : '';
    return `[e${index + 1}] ${[row.date, who].filter(Boolean).join(' ')}: ${asText(row.what)}${feeling}`;
  });
}

/** Her open intentions that concern the page's people or the batch's places. */
export function intentionLinesOf(
  db: Db,
  ctx: Context,
  shown: ReadonlyArray<Person>,
  placeIds: ReadonlyArray<string>,
  read: Read
): Array<string> {
  const lines: Array<string> = [];
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
      placeIds.some((id) => JSON.stringify(record).includes(nativeOf(id) ?? '\u0000'));
    if (concerns && typeof record.purpose === 'string') {
      lines.push(`${record.status}: ${record.purpose}`);
      read('intention', row.id, 'intentions');
    }
  }
  return lines;
}
