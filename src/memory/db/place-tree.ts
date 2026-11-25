// The tree of places: `parent_id` walked to its top. A pure read over a connection; the store, the private views and
// the `<spatial_awareness>` block (src/turn/request/spatial.ts, through the store's `placeChainOf`) use it.

import type { Db } from './types.ts';

/** The most parents a walk follows; deeper than any platform nests its places. */
const MAX_DEPTH = 64;

/**
 * One place of a chain: its stored id, its kind and its name, each null when the row holds none. `joinedAt` is the
 * moment the bot joined the place (a root's), milliseconds since the epoch, present only when the store knows it.
 */
export type PlaceChainLink = { id: string; kind: string | null; name: string | null; joinedAt?: number | null };

const textOrNull = (value: unknown): string | null => (typeof value === 'string' && value !== '' ? value : null);

/**
 * The chain from a place up to the top of its stored tree, the place itself first. It ends at a missing parent, before
 * a place it already holds (a cycle) and at MAX_DEPTH; an unknown id gives an empty chain.
 */
export function placeChainInDb(db: Db, placeId: string): Array<PlaceChainLink> {
  const read = db.prepare(
    `SELECT id, kind, name, parent_id,
       CASE WHEN json_valid(extra) THEN json_extract(extra, '$.joinedAt') END AS joined FROM places WHERE id = ?`
  );
  const chain: Array<PlaceChainLink> = [];
  const seen = new Set<string>();
  let row = read.get(placeId);
  while (row && chain.length < MAX_DEPTH) {
    const id = String(row.id);
    seen.add(id);
    const joinedAt = typeof row.joined === 'number' && Number.isFinite(row.joined) ? row.joined : null;
    chain.push({
      id,
      kind: textOrNull(row.kind),
      name: textOrNull(row.name),
      ...(joinedAt === null ? {} : { joinedAt }),
    });
    const parent = textOrNull(row.parent_id);
    if (parent === null || seen.has(parent)) break;
    row = read.get(parent);
  }
  return chain;
}

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
