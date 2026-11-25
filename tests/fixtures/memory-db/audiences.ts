// The audience of rows a test wrote with raw SQL. Every context the core issues reads through `audience_id`
// (src/memory/db/scope.ts), so a fixture that inserts the scope triple alone fills the column the way a writer does:
// each triple resolved to its audience (src/memory/db/rows.ts#resolveRow), the audience row made when missing
// (#ensureAudience), then set on every row of that triple still without one.
import type { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { SCOPED_TABLES } from '../../../src/memory/db/schema.ts';
import { columnsOf, ensureAudience, resolveRow } from '../../../src/memory/db/rows.ts';

/** Whether the column set columnsOf answered holds `name`. */
const hasColumn = (columns: unknown, name: string): boolean => columns instanceof Set && columns.has(name);

export function fillAudiences(db: DatabaseSync): void {
  for (const table of SCOPED_TABLES) {
    if (!hasColumn(columnsOf(db, table), 'audience_id')) continue;
    const triples = db
      .prepare(`SELECT DISTINCT scope_kind, scope_iface, scope_dm FROM ${table} WHERE audience_id IS NULL`)
      .all();
    for (const triple of triples) {
      const resolved = resolveRow(db, triple);
      ensureAudience(db, resolved);
      db.prepare(
        `UPDATE ${table} SET audience_id = ? WHERE audience_id IS NULL AND scope_kind IS ? AND scope_iface IS ? AND scope_dm IS ?`
      ).run(resolved.audience_id as SQLInputValue, triple.scope_kind, triple.scope_iface, triple.scope_dm);
    }
  }
}

/** fillAudiences over the database of a fixture environment (`env.db`). */
export function fillEnvAudiences(env: unknown): void {
  fillAudiences((env as { db: DatabaseSync }).db);
}
