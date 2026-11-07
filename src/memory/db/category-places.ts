// The migration that takes the sidebar groupings out of the tree of places. A grouping of rooms is nothing she is in, so
// its rooms move up to its parent, its row and its graph node go, and the column that held its label on a room goes too.

import { log } from '../../log.ts';
import { projectRow } from './graph.ts';
import type { Db } from './types.ts';

/** What a grouping may hold. Anything else is a tree this migration never saw, so it stops the open and names the row. */
const MOVABLE_KINDS = new Set<unknown>(['channel', 'room', 'thread']);

/** The node of the row, its edges in both directions, retired ones included, and its witnesses. */
function deleteProjection(db: Db, placeId: string): void {
  for (const node of db.prepare("SELECT id FROM graph_nodes WHERE kind = 'place' AND row_id = ?").all(placeId)) {
    db.prepare('DELETE FROM graph_edges WHERE src = ? OR dst = ?').run(node.id, node.id);
    db.prepare('DELETE FROM node_access WHERE node_id = ?').run(node.id);
    db.prepare('DELETE FROM graph_nodes WHERE id = ?').run(node.id);
  }
}

/**
 * Moves the children of every place of kind `category` to that place's parent, projects each child again so that its
 * `contained_in` edge follows, deletes the place with its projection, and drops `places.category`. A thread under a room
 * stays there. Runs in the migration's transaction, so a refusal leaves the database as it was.
 * @returns How many children moved and how many places went.
 * @throws {Error} naming the row when a category holds something that is neither a room nor a thread.
 */
export function dropCategoryPlaces(db: Db): { moved: number; deleted: number } {
  const categories = db.prepare("SELECT id, parent_id FROM places WHERE kind = 'category'").all();
  let moved = 0;
  for (const category of categories) {
    const children = db.prepare('SELECT id, kind FROM places WHERE parent_id = ?').all(category.id);
    for (const child of children) {
      if (!MOVABLE_KINDS.has(child.kind))
        throw new Error(
          `memory db: category place ${String(category.id)} holds ${String(child.id)}, not a room or a thread`
        );
      db.prepare('UPDATE places SET parent_id = ? WHERE id = ?').run(category.parent_id, child.id);
      projectRow(db, 'places', { id: child.id });
      moved += 1;
    }
    deleteProjection(db, String(category.id));
    db.prepare('DELETE FROM places WHERE id = ?').run(category.id);
  }
  db.exec('ALTER TABLE places DROP COLUMN category');
  if (categories.length > 0) log.info('memory db: category places dropped', { moved, deleted: categories.length });
  return { moved, deleted: categories.length };
}
