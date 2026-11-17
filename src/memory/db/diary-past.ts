// Her past entries, read for a request (`readDiary`): the newest entries of her diary a context may
// read, from the `diary` table and the marks of each entry's first picture.

import { marksOf } from './media-store.ts';
import type { MediaMarks } from './media-store.ts';
import { parseExtra } from './row-columns.ts';
import { whereFor } from './scope.ts';
import type { Db } from './types.ts';

/**
 * One stored entry as a request shows it: when, its kind and gist, its picture and the plan it was written from, and the
 * marks of its first picture when she drew it (`made`, `depicted` with the people's current names).
 */
export type PastEntry = {
  id: string;
  at: number;
  kind: string | null;
  gist: string;
  picture: string | null;
  pictures: number | null;
  plan: unknown;
} & Partial<MediaMarks>;

/**
 * The newest `limit` entries of her diary that `ctx` may read, oldest first, from the `diary` table and the `media`
 * row of each entry's first picture: no mirror and no message is read.
 */
export function readDiary(connection: unknown, ctx: unknown, limit: number): Array<PastEntry> {
  const db = connection as Db; // a node:sqlite connection; the queries below read it
  const count = Math.max(0, Math.floor(limit));
  if (count === 0) return [];
  const where = whereFor(ctx);
  const rows = db
    .prepare(
      `SELECT id, at_ms, kind, gist, picture_prompt, extra FROM diary
        WHERE retired_at IS NULL AND ${where.sql}
        ORDER BY at_ms DESC, COALESCE(position, 0) DESC, id DESC LIMIT ?`
    )
    .all(...where.params, count)
    .reverse();
  return rows.map((row) => {
    const extra = parseExtra(row.extra);
    return {
      id: text(row.id),
      at: Number(row.at_ms) || 0,
      kind: text(row.kind) || null,
      gist: text(row.gist),
      picture: typeof row.picture_prompt === 'string' ? row.picture_prompt : null,
      pictures: typeof extra.pictures === 'number' ? extra.pictures : null,
      plan: extra.plan ?? null,
      ...firstPictureMarks(db, text(row.id)),
    };
  });
}

/** The marks of an entry's first picture (media-store.ts#marksOf), or none. */
function firstPictureMarks(db: Db, entryId: string): Partial<MediaMarks> {
  const row = db
    .prepare(
      `SELECT m.extra AS extra FROM media_links l JOIN media m ON m.id = l.media_id
       WHERE l.owner_kind = 'diary' AND l.owner_id = ? AND m.kind = 'image' ORDER BY l.position LIMIT 1`
    )
    .get(entryId);
  return marksOf(db, parseExtra(row?.extra)) ?? {};
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
