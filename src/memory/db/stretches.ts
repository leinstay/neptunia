// Her stretches: her own posted lines in one place, cut where SILENCE_MS pass with no line of hers there. `<my_day>`
// tells each as a conversation (src/turn/request/my-day.ts) and the memory session writes one sentence per stretch it
// reads (session.ts, session-write.ts). A sentence is an `episodes` row of the kind `stretch` with the writer `stretch`
// and, as its holder, the place of its lines, or the heartbeat run of her own time, so a read of the sentences of many
// stretches goes over the index `episodes_holder`.

import type { Db } from './types.ts';

/** A silence of hers this long in one place ends a stretch there. */
export const SILENCE_MS = 30 * 60_000;

/** The kind and the writer of the `episodes` row of a stretch's sentence. */
export const STRETCH_KIND = 'stretch';

/** One stretch: its place, its first and last line of hers, and those lines in order. */
export type Stretch<T> = { placeId: string; at: number; end: number; lines: Array<T> };

/** Her lines, oldest first, as stretches: by place, cut at each silence of hers longer than SILENCE_MS. Pure. */
export function stretchesOf<T extends { placeId: string; at: number }>(lines: ReadonlyArray<T>): Array<Stretch<T>> {
  const open = new Map<string, Stretch<T>>();
  const out: Array<Stretch<T>> = [];
  for (const line of lines) {
    let stretch = open.get(line.placeId);
    if (!stretch || line.at - stretch.end > SILENCE_MS) {
      stretch = { placeId: line.placeId, at: line.at, end: line.at, lines: [] };
      open.set(line.placeId, stretch);
      out.push(stretch);
    }
    stretch.end = line.at;
    stretch.lines.push(line);
  }
  return out;
}

/** A stored sentence: its row, its holder, its first and last moment and the sentence. */
export type StoredStretch = { id: string; holder: string; at: number; end: number; what: string };

/**
 * The live sentences of the holders `holders` that reach from `from` to `to`, read under `where` (a scope filter on
 * the alias `e`), over `episodes_holder`. One read for all the holders.
 */
export function storedStretches(
  db: Db,
  where: { sql: string; params: ReadonlyArray<unknown> },
  { holders, from, to }: { holders: ReadonlyArray<string>; from: number; to: number }
): Array<StoredStretch> {
  if (holders.length === 0) return [];
  return db
    .prepare(
      `SELECT e.id, e.holder_id, e.start_ms, e.last_ms, e.what FROM episodes e
        WHERE e.writer = '${STRETCH_KIND}' AND e.holder_id IN (${holders.map(() => '?').join(', ')})
          AND e.retired_at IS NULL AND e.last_ms >= ? AND e.start_ms <= ? AND ${where.sql}`
    )
    .all(...holders, from, to, ...where.params)
    .map((row) => ({
      id: String(row.id),
      holder: String(row.holder_id),
      at: Number(row.start_ms),
      end: Number(row.last_ms),
      what: typeof row.what === 'string' ? row.what : '',
    }));
}

/** The newest of `stored` that `holder` holds and that overlaps `at` to `end`, else null. */
export function overlapping(
  stored: ReadonlyArray<StoredStretch>,
  { holder, at, end }: { holder: string; at: number; end: number }
): StoredStretch | null {
  let found: StoredStretch | null = null;
  for (const one of stored)
    if (one.holder === holder && one.at <= end && one.end >= at && (!found || one.end > found.end)) found = one;
  return found;
}
