// Version step 55: the storage unit layer leaves the schema. Every row names its owner in its own columns (writer,
// holder and, for a line, period), so the unit catalog `storage_units`, the path aliases `legacy_unit_aliases`, the file
// ledger `files`, the four capture tables and the columns `owner_key`, `owner_file` and `origin_file` go. A graph
// edge's `owner_key` stays: it is the key of the row that projected the edge (graph.ts), not a unit.
//
// `co_owners` stays as the list of the places that share a row another place's writer holds (place-owner.ts), keyed by
// the table, the row's key and the sharing writer and holder, the four columns the sharing reads. A legacy row without
// a writer or a holder names no sharing place and is left out.
//
// The triggers that fill the id of a claim's or an episode's link read `owner_file` to tell a file's link from one the
// database wrote. No writer gives `owner_file`, so each keeps the branch of a link the database wrote.

import type { Db } from './types.ts';

/** The tables the step drops, those that hang off another first. */
export const DROPPED_TABLES = [
  'capture_events',
  'capture_watches',
  'capture_members',
  'capture_bundles',
  'legacy_unit_aliases',
  'files',
] as const;

/** The columns the step drops from every table but `graph_edges`. */
export const DROPPED_COLUMNS = ['owner_key', 'owner_file', 'origin_file'] as const;

const quote = (name: string): string => `"${name.replaceAll('"', '""')}"`;
const names = (db: Db, sql: string, ...args: Array<string>): Array<string> =>
  db
    .prepare(sql)
    .all(...args)
    .map((row) => String(row.name));

function rebuildCoOwners(db: Db): void {
  db.exec(`CREATE TABLE co_owners_shared (
    tbl TEXT NOT NULL, key TEXT NOT NULL, writer TEXT NOT NULL, holder_id TEXT NOT NULL,
    PRIMARY KEY (tbl, key, writer, holder_id)
  )`);
  db.exec(`INSERT OR IGNORE INTO co_owners_shared (tbl, key, writer, holder_id)
    SELECT tbl, key, writer, holder_id FROM co_owners
    WHERE tbl IS NOT NULL AND key IS NOT NULL AND writer IS NOT NULL AND holder_id IS NOT NULL ORDER BY rowid`);
  db.exec('DROP TABLE co_owners');
  db.exec('ALTER TABLE co_owners_shared RENAME TO co_owners');
  db.exec('CREATE INDEX "co_owners_holder" ON "co_owners"(tbl, writer, holder_id)');
}

/** The trigger that fills the id of a link of `table` under its parent's `parent` column: `<prefix>:<parent>:s:<source>`. */
const linkIdTrigger = (table: string, prefix: string, parent: string): string =>
  `CREATE TRIGGER ${table}_id_fill AFTER INSERT ON ${table} WHEN new.id IS NULL
BEGIN
  UPDATE ${table} SET id = '${prefix}:' || COALESCE(new.${parent}, '') || ':s:' || COALESCE(new.source_id, '') || CASE WHEN EXISTS (SELECT 1 FROM ${table} o WHERE o.id = '${prefix}:' || COALESCE(new.${parent}, '') || ':s:' || COALESCE(new.source_id, '')) THEN '#dup' || new.rowid ELSE '' END WHERE rowid = new.rowid;
END`;

/** The links whose id trigger read `owner_file`: table, id prefix, parent column. */
const LINKS: ReadonlyArray<[string, string, string]> = [
  ['claim_sources', 'cs', 'claim_id'],
  ['episode_sources', 'es', 'episode_id'],
];

/** Drops the columns of the unit layer from one table, with the indexes that name them first. */
function dropColumns(db: Db, table: string): void {
  const columns = names(db, `SELECT name FROM pragma_table_info(?)`, table);
  const dropped = DROPPED_COLUMNS.filter((column) => columns.includes(column));
  if (dropped.length === 0) return;
  for (const index of names(
    db,
    "SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = ? AND sql IS NOT NULL",
    table
  )) {
    const indexed = names(db, 'SELECT name FROM pragma_index_info(?)', index);
    if (indexed.some((column) => (dropped as ReadonlyArray<string>).includes(column)))
      db.exec(`DROP INDEX ${quote(index)}`);
  }
  for (const column of dropped) db.exec(`ALTER TABLE ${quote(table)} DROP COLUMN ${quote(column)}`);
}

/** Version step 55. */
export function dropUnitLayer(db: Db): void {
  rebuildCoOwners(db);
  for (const [table, prefix, parent] of LINKS) {
    db.exec(`DROP TRIGGER IF EXISTS ${table}_id_fill`);
    db.exec(linkIdTrigger(table, prefix, parent));
  }
  for (const table of DROPPED_TABLES) db.exec(`DROP TABLE IF EXISTS ${quote(table)}`);
  const tables = names(
    db,
    "SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT IN ('graph_edges', 'storage_units') ORDER BY name"
  );
  for (const table of tables) dropColumns(db, table);
  db.exec('DROP TABLE IF EXISTS storage_units');
}
