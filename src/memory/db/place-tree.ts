// The tree of places: `parent_id` walked to its top. A pure read over a connection; the store and the private views use it.

import type { Db } from './types.ts';

/** The most parents a walk follows; deeper than any platform nests its places. */
const MAX_DEPTH = 64;

/**
 * The top of a place's stored tree: the place itself when it has no parent, the last stored place when a parent is
 * missing, null for an unknown id and for a cycle.
 */
export function rootPlaceInDb(db: Db, placeId: string): string | null {
  const read = db.prepare('SELECT id, parent_id FROM places WHERE id = ?');
  let row = read.get(placeId);
  if (!row) return null;
  const seen = new Set<unknown>([row.id]);
  for (let depth = 0; depth < MAX_DEPTH; depth += 1) {
    const parent = row.parent_id;
    if (typeof parent !== 'string' || parent === '') return String(row.id);
    if (seen.has(parent)) return null;
    const next = read.get(parent);
    if (!next) return String(row.id);
    seen.add(parent);
    row = next;
  }
  return null;
}
