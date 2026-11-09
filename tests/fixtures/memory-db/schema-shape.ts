// The shape of a memory database for tests that compare two schemas: every object of `sqlite_master` with its SQL
// in a normal form, the columns, foreign keys and index columns SQLite reports for it, and the rows of the tables a
// new database fills. Whitespace outside quotes is folded, so two texts that differ only in layout compare equal.

import type { Db } from '../../../src/memory/db/types.ts';

/** SQL with whitespace outside quotes folded to one space and dropped next to brackets and commas. */
export function normalSql(sql: unknown): string | null {
  if (typeof sql !== 'string') return null;
  let out = '';
  let quote = '';
  for (const char of sql) {
    if (quote !== '') {
      out += char;
      if (char === quote) quote = '';
    } else if (char === "'" || char === '"') {
      quote = char;
      out += char;
    } else if (/\s/.test(char)) {
      if (!out.endsWith(' ')) out += ' ';
    } else {
      if ('(),'.includes(char) && out.endsWith(' ')) out = out.slice(0, -1);
      if (out.endsWith('(') || out.endsWith(',')) out = out.trimEnd();
      out += char;
    }
  }
  return out.replace(/([(,]) /g, '$1').trim();
}

type Shape = Record<string, { table: string; sql: string | null; details: Array<string> }>;

const joined = (rows: Array<Record<string, unknown>>, keys: Array<string>): Array<string> =>
  rows.map((row) => keys.map((key) => String(row[key])).join('|'));

/** Every object of `sqlite_master` but SQLite's statistics, keyed by its type and name. */
export function schemaShape(db: Db): Shape {
  const shape: Shape = {};
  const objects = db
    .prepare("SELECT type, name, tbl_name, sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_stat%' ORDER BY type, name")
    .all();
  for (const object of objects) {
    const name = String(object.name);
    let details: Array<string> = [];
    if (object.type === 'table') {
      details = [
        ...joined(db.prepare(`PRAGMA table_xinfo("${name}")`).all(), ['name', 'type', 'notnull', 'dflt_value', 'pk', 'hidden']),
        ...joined(db.prepare(`PRAGMA foreign_key_list("${name}")`).all(), ['table', 'from', 'to', 'on_update', 'on_delete']),
        // The planner breaks a tie between two indexes by this order, so it is part of the shape.
        ...joined(db.prepare(`PRAGMA index_list("${name}")`).all(), ['seq', 'name', 'unique', 'origin', 'partial']),
      ];
    } else if (object.type === 'index') {
      details = joined(db.prepare(`PRAGMA index_xinfo("${name}")`).all(), ['name', 'desc', 'coll', 'key']);
    }
    shape[`${String(object.type)} ${name}`] = { table: String(object.tbl_name), sql: normalSql(object.sql), details };
  }
  return shape;
}

/**
 * The rows of every ordinary table that holds any, sorted, leaving out the tables named in `except` and SQLite's own
 * counters of `sqlite_sequence`, which say what was once inserted and no seed row.
 */
export function filledRows(db: Db, except: ReadonlyArray<string> = []): Record<string, Array<string>> {
  const rows: Record<string, Array<string>> = {};
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND sql NOT LIKE 'CREATE VIRTUAL%' ORDER BY name")
    .all()
    .map((row) => String(row.name))
    .filter((name) => !except.includes(name) && name !== 'sqlite_sequence' && !/_(data|idx|docsize|config)$/.test(name));
  for (const table of tables) {
    const all = db.prepare(`SELECT * FROM "${table}"`).all();
    if (all.length > 0) rows[table] = all.map((row) => JSON.stringify(row)).sort();
  }
  return rows;
}
