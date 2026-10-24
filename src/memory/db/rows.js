// Rows between the mappers and SQLite. A mapping is `{ table: [row, ...] }`, a row is column -> value. These helpers
// write a mapping with one parameterised statement per row (a column the schema lacks fails loudly) and read the
// rows of the named tables back as plain objects, so a mapper's output can go through the real schema.

const quote = (name) => `"${String(name).replace(/"/g, '""')}"`;

/** Inserts (or replaces, by primary key) every row of a mapping. */
export function insertRows(db, mapping) {
  for (const [table, rows] of Object.entries(mapping)) {
    for (const row of rows) {
      const cols = Object.keys(row);
      const sql = `INSERT OR REPLACE INTO ${quote(table)} (${cols.map(quote).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
      db.prepare(sql).run(...cols.map((col) => (row[col] === undefined ? null : row[col])));
    }
  }
}

/** Every row of each named table as a plain object, in rowid order. */
export function readRows(db, tables) {
  const out = {};
  for (const table of tables) {
    out[table] = db.prepare(`SELECT * FROM ${quote(table)} ORDER BY rowid`).all().map((row) => ({ ...row }));
  }
  return out;
}
