// Her past entries, read for a request (`readSelfreflection`): the newest entries of her selfreflection a context may
// read, from the `selfreflection` table alone.

import { entryPictureDescriptions } from './media-store.ts';
import { whereFor } from './scope.ts';
import type { Db } from './types.ts';

/** One stored entry as a request shows it: when, its kind and gist, its picture and the plan it was written from. */
export type PastEntry = {
  id: string;
  at: number;
  kind: string | null;
  gist: string;
  picture: string | null;
  pictures: number | null;
  plan: unknown;
  pictureDescription: string | null;
};

/**
 * The newest `limit` entries of her selfreflection that `ctx` may read, oldest first, from the `selfreflection` table
 * alone: no mirror and no message is read. A picture's description comes from the entry's first linked image.
 */
export function readSelfreflection(connection: unknown, ctx: unknown, limit: number): Array<PastEntry> {
  const db = connection as Db; // a node:sqlite connection; the queries below read it
  const count = Math.max(0, Math.floor(limit));
  if (count === 0) return [];
  const where = whereFor(ctx);
  const rows = db
    .prepare(
      `SELECT id, at_ms, kind, gist, picture_prompt, extra FROM selfreflection
        WHERE retired_at IS NULL AND ${where.sql}
        ORDER BY at_ms DESC, COALESCE(position, 0) DESC, id DESC LIMIT ?`
    )
    .all(...where.params, count)
    .reverse();
  const described = entryPictureDescriptions(
    db,
    rows.map((row) => text(row.id))
  );
  return rows.map((row) => {
    const extra = (() => {
      try {
        const parsed: unknown = JSON.parse(text(row.extra) || '{}');
        return parsed !== null && typeof parsed === 'object' ? (parsed as Record<string, unknown>) : {};
      } catch {
        return {};
      }
    })();
    const id = text(row.id);
    return {
      id,
      at: Number(row.at_ms) || 0,
      kind: text(row.kind) || null,
      gist: text(row.gist),
      picture: typeof row.picture_prompt === 'string' ? row.picture_prompt : null,
      pictures: typeof extra.pictures === 'number' ? extra.pictures : null,
      plan: extra.plan ?? null,
      pictureDescription: described.get(id) ?? null,
    };
  });
}

const text = (value: unknown): string => (typeof value === 'string' ? value : '');
