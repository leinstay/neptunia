// The synthetic world of the owner's memory browser tests: a digest of every row of a database, so that a read proves it
// changed nothing, and direct seeds of what the browser reads, through a connection the test owns before the code under
// test runs. Greek and accented Latin stand in for non-ASCII text; every id is made up.
import { createHash } from 'node:crypto';
import type { Db } from '../../../src/memory/db/types.ts';

const AT = '2026-11-01T00:00:00.000Z';

export const quoted = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** Every table of the connection, as SQLite itself lists them. */
export function actualTableNames(db: Db): Array<string> {
  return db
    .prepare("SELECT name FROM sqlite_schema WHERE type = 'table' ORDER BY name")
    .all()
    .map((row) => String(row.name));
}

/** The rows of a table as sorted lines of typed bytes, whichever storage class each value has. */
function rowLines(db: Db, table: string): Array<string> {
  const columns = db.prepare(`SELECT name, hidden FROM pragma_table_xinfo(?)`).all(table);
  const visible = columns.filter((column) => Number(column.hidden) === 0).map((column) => quoted(String(column.name)));
  const parts = visible.map((column) => `typeof(${column}) || ':' || COALESCE(hex(${column}), '')`);
  return db
    .prepare(`SELECT ${parts.join(` || char(31) || `)} AS line FROM ${quoted(table)}`)
    .all()
    .map((row) => String(row.line))
    .sort();
}

/** The hash and row count of every table: two equal digests mean no row of any table moved. */
export function databaseDigest(db: Db): Record<string, string> {
  const digest: Record<string, string> = {};
  for (const table of actualTableNames(db)) {
    const lines = rowLines(db, table);
    digest[table] = `${lines.length}:${createHash('sha256').update(lines.join('\n')).digest('hex')}`;
  }
  return digest;
}

/** The rows a table holds, read directly. */
export const countOf = (db: Db, table: string): number =>
  Number(db.prepare(`SELECT COUNT(*) AS n FROM ${quoted(table)}`).get()?.n);

/** Registers an interface, an authority and the audience of a group on it. */
export function addAuthority(db: Db, iface: string, authority: string): void {
  db.prepare('INSERT OR IGNORE INTO interfaces (id, name, contract) VALUES (?, ?, 1)').run(iface, iface);
  db.prepare('INSERT OR IGNORE INTO authorities (id, iface, namespace) VALUES (?, ?, ?)').run(
    authority,
    iface,
    authority
  );
  db.prepare("INSERT OR IGNORE INTO audiences (id, kind, iface) VALUES (?, 'group', ?)").run(
    `aud:group:${iface}`,
    iface
  );
}

export type PlaceSeed = {
  id: string;
  iface: string;
  authority: string;
  nativeKey?: string;
  parent?: string | null;
  continues?: string | null;
  kind?: string;
  conversation?: 'group' | 'dm';
  name?: string | null;
  retiredAt?: string | null;
};

/** One place of any shape. An orphan's parent is written inside `withoutForeignKeys`. */
export function addPlace(db: Db, seed: PlaceSeed): void {
  addAuthority(db, seed.iface, seed.authority);
  const conversation = seed.conversation ?? 'group';
  db.prepare(
    `INSERT INTO places (id, iface, kind, native_id, native_key, authority_id, generation, conversation, scope_kind,
       parent_id, continues_place_id, name, retired_at, seen_from_at)
     VALUES (?, ?, ?, ?, ?, ?, 1, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    seed.id,
    seed.iface,
    seed.kind ?? 'channel',
    seed.nativeKey ?? seed.id,
    seed.nativeKey ?? seed.id,
    seed.authority,
    conversation,
    conversation,
    seed.parent ?? null,
    seed.continues ?? null,
    seed.name ?? null,
    seed.retiredAt ?? null,
    AT
  );
  if (conversation === 'dm')
    db.prepare("INSERT OR IGNORE INTO audiences (id, kind, iface, place_id) VALUES (?, 'dm', ?, ?)").run(
      `aud:dm:${seed.id}`,
      seed.iface,
      seed.id
    );
}

/** Runs `write` with foreign keys off, for a row the schema would refuse but an old database may hold. */
export function withoutForeignKeys(db: Db, write: () => void): void {
  db.exec('PRAGMA foreign_keys = OFF');
  try {
    write();
  } finally {
    db.exec('PRAGMA foreign_keys = ON');
  }
}

export type SourceSeed = {
  id: string;
  place: string;
  iface: string;
  audience: string;
  text: string;
  revision?: number;
  nativeId?: string;
  retiredAt?: string | null;
};

export function addSource(db: Db, seed: SourceSeed): void {
  db.prepare(
    `INSERT INTO sources (id, kind, iface, native_id, revision, place_id, occurred_at, recorded_at, text, audience_id, retired_at)
     VALUES (?, 'message', ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    seed.id,
    seed.iface,
    seed.nativeId ?? seed.id,
    seed.revision ?? 0,
    seed.place,
    AT,
    AT,
    seed.text,
    seed.audience,
    seed.retiredAt ?? null
  );
}

/** A description of `subject` with one current version holding `text`. */
export function addDescription(
  db: Db,
  seed: { id: string; subjectKind: 'place' | 'person'; subject: string; field: string; audience: string; text: string }
): void {
  const version = `${seed.id}:v1`;
  db.prepare(
    `INSERT INTO descriptions (id, subject_kind, subject_id, field, audience_id, scope_kind, current_version)
     VALUES (?, ?, ?, ?, ?, 'group', ?)`
  ).run(seed.id, seed.subjectKind, seed.subject, seed.field, seed.audience, version);
  db.prepare(
    `INSERT INTO description_versions (id, description_id, text, author, written_at, chars, origin)
     VALUES (?, ?, ?, 'synthetic', ?, ?, 'synthetic')`
  ).run(version, seed.id, seed.text, AT, seed.text.length);
}

export type EdgeSeed = {
  id?: string;
  src: string;
  dst: string;
  predicate?: string;
  audience?: string;
  evidence?: string | null;
  validFrom?: string | null;
  validTo?: string | null;
  recordedAt?: string;
  retiredAt?: string | null;
};

/** Empties the graph a migrated database starts with (its interfaces, authorities and self), so a test's inventory is exact. */
export function clearGraph(db: Db): void {
  db.exec('DELETE FROM node_access; DELETE FROM graph_edges; DELETE FROM graph_nodes;');
}

/** One graph node, its kind read from the node-id rule `<kind>:<row id>`, with no witness. */
export function addNode(db: Db, id: string): void {
  const kind = id.slice(0, id.indexOf(':'));
  db.prepare('INSERT OR IGNORE INTO graph_nodes (id, kind, row_id, created_at) VALUES (?, ?, ?, ?)').run(
    id,
    kind,
    id.slice(kind.length + 1),
    AT
  );
}

/** One graph edge between two nodes (made when absent); a live edge witnesses both its ends, as the projection does. */
export function addEdge(db: Db, seed: EdgeSeed): string {
  const predicate = seed.predicate ?? 'mentions';
  const audience = seed.audience ?? 'aud:internal';
  const id = seed.id ?? `edge:${predicate}:${seed.src}:${seed.dst}:${seed.evidence ?? ''}`;
  addNode(db, seed.src);
  addNode(db, seed.dst);
  db.prepare(
    `INSERT INTO graph_edges (id, src, predicate, dst, audience_id, evidence_id, valid_from_at, valid_to_at, recorded_at,
       retired_at, projection_key, owner_key)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'synthetic')`
  ).run(
    id,
    seed.src,
    predicate,
    seed.dst,
    audience,
    seed.evidence ?? null,
    seed.validFrom ?? null,
    seed.validTo ?? null,
    seed.recordedAt ?? AT,
    seed.retiredAt ?? null,
    id
  );
  if (seed.retiredAt == null) {
    const witness = db.prepare(
      'INSERT OR IGNORE INTO node_access (node_id, audience_id, evidence_id) VALUES (?, ?, ?)'
    );
    witness.run(seed.src, audience, id);
    witness.run(seed.dst, audience, id);
  }
  return id;
}

/** A row's value by column, for a row shaped `{ values: [{ column, value }] }`. */
export function cell<TValue>(row: { values: ReadonlyArray<{ column: string; value: TValue }> }, column: string): TValue {
  const found = row.values.find((one) => one.column === column);
  if (found === undefined) throw new Error(`the row has no column ${column}: ${JSON.stringify(row.values)}`);
  return found.value;
}
