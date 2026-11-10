// Version step 56: the `legacy/local` authority leaves the database. Its keys named each person, and each account and
// place spelled the old Discord way, by the row's own id, and no reader asked for them: a lookup by key always names the
// authority of the interface that sent the event (observe.ts#resolveAlias). The writers no longer add them, and the step
// deletes the keys, the authority row and the authority's graph node.

import type { Db } from './types.ts';

const AUTHORITY = 'legacy/local';

/** Version step 56. */
export function dropLegacyKeys(db: Db): void {
  db.prepare('DELETE FROM external_keys WHERE authority_id = ?').run(AUTHORITY);
  db.prepare('DELETE FROM graph_edges WHERE src = ?1 OR dst = ?1').run(`authority:${AUTHORITY}`);
  db.prepare('DELETE FROM graph_nodes WHERE id = ?').run(`authority:${AUTHORITY}`);
  db.prepare('DELETE FROM authorities WHERE id = ?').run(AUTHORITY);
}
