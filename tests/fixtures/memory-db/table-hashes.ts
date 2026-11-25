// The content hash of every table of a memory database, for the tests that check a write or a projection changed
// nothing, or that a copy holds the same rows as its source.
import { createHash } from 'node:crypto';
import type { UntypedDb } from '../loose-types.ts';

type Rec = Record<string, unknown>;

const valueOf = (value: unknown): Array<unknown> => {
  if (value instanceof Uint8Array) return ['blob', Buffer.from(value).toString('hex')];
  if (typeof value === 'bigint') return ['int', String(value)];
  return [value === null ? 'null' : typeof value, value];
};

/** The tables of a database (no SQLite internals), with the virtual ones marked and their shadow tables left out. */
function tablesOf(db: UntypedDb): Array<{ name: string; virtual: boolean }> {
  const rows = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
    .all()
    .map((row: Rec) => ({ name: String(row.name), sql: typeof row.sql === 'string' ? row.sql : '' }));
  const virtual = new Set(rows.filter((row) => /^CREATE VIRTUAL TABLE/i.test(row.sql)).map((row) => row.name));
  return rows
    .map((row) => row.name)
    .filter((name) => ![...virtual].some((v) => name.startsWith(`${v}_`)))
    .map((name) => ({ name, virtual: virtual.has(name) }));
}

/**
 * The content hash of every table (or of `only`): `[{ table, rows, hash }]`. Rows in primary-key order, every column;
 * a table without a primary key in the order of all its columns; a full-text table by its index content (fts5vocab
 * `instance`: every term, row, column and offset).
 * @param handleDb the node:sqlite connection under a memory handle, which types it as `object`
 */
export function tableHashes(
  handleDb: object,
  only: ReadonlyArray<string> | null = null
): Array<{ table: string; rows: number; hash: string }> {
  const db = handleDb as UntypedDb;
  const out = [];
  for (const { name, virtual } of tablesOf(db)) {
    if (only && !only.includes(name)) continue;
    const hash = createHash('sha256');
    let rows = 0;
    let statement;
    if (virtual) {
      const vocab = `_hash_${name}`;
      db.exec(`CREATE VIRTUAL TABLE IF NOT EXISTS temp."${vocab}" USING fts5vocab(main, "${name}", 'instance')`);
      statement = db.prepare(`SELECT term, doc, col, offset FROM temp."${vocab}" ORDER BY term, doc, col, offset`);
    } else {
      const columns: Array<Rec> = db.prepare(`PRAGMA table_info("${name}")`).all();
      const keys = columns
        .filter((column) => Number(column.pk) > 0)
        .sort((a, b) => Number(a.pk) - Number(b.pk))
        .map((column) => String(column.name));
      const order = (keys.length ? keys : columns.map((column) => String(column.name)))
        .map((column) => `"${column}"`)
        .join(', ');
      statement = db.prepare(
        `SELECT ${columns.map((column) => `"${String(column.name)}"`).join(', ')} FROM "${name}" ORDER BY ${order}`
      );
    }
    for (const row of statement.all()) {
      hash.update(JSON.stringify(Object.values(row).map(valueOf)));
      hash.update('\n');
      rows += 1;
    }
    out.push({ table: name, rows, hash: hash.digest('hex') });
  }
  return out;
}
