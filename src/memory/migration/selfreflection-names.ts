// The diary becomes `selfreflection` in stored data (B10 of the master plan). schema.ts appends `renameToSelfreflection`
// as its last step, the offline conversion runs it on its working copy, and `migrate` (src/memory/db/open.ts) calls
// `moveSelfreflectionMedia` on every open that knows the data directory.
//
// The rename keeps every row and every row id. It changes the two tables with their column, indexes and trigger, the
// stored discriminators, the graph's node ids and edge keys, the idempotency keys, the persona's storage unit (whose id is
// a hash of its kind, so every pointer follows), the pending marks, the structured words in stored JSON and `media.path`.
// `model_requests` stays as history. What a model read stays too: the `turn_reads.block` of the block `<diary>` and
// the budget's sections in the journal.
//
// `withCurrentNames` lends a shipped step or an old-schema fixture the names the writers of today speak, and takes them
// back afterwards: the data steps v10, v12 and v15 call those writers on a database that still holds the old names.
//
// The files move apart from the rows, so either can be first: the move only renames what is still in the old folder, and
// a crash between the two leaves a state the next open finishes. Pure SQL and one folder. Logs: a kept conflict, by count.

import fs from 'node:fs';
import path from 'node:path';
import { edgeIdOf } from '../db/graph.ts';
import { keyText, storageId } from '../db/storage-keys.ts';
import type { StorageKey } from '../db/storage-keys.ts';
import type { Db, Row } from '../db/types.ts';
import { log } from '../../log.ts';

const OLD = 'diary';
const NEW = 'selfreflection';

const OLD_MEDIA = `media/${OLD}/`;
const NEW_MEDIA = `media/${NEW}/`;

/** The prefix of the id of a picture of an entry before the move of the ids, and after it. */
export const LEGACY_ENTRY_MEDIA = `media:${OLD}:`;
export const ENTRY_MEDIA = `media:${NEW}:`;

/** The columns that hold the word as a whole value, each changed with the column's rows alone. */
const DISCRIMINATORS: ReadonlyArray<readonly [string, string]> = [
  ['mirrors', 'row_kind'],
  ['publication_grants', 'row_kind'],
  ['turn_reads', 'row_kind'],
  ['operational', 'kind'],
  ['files', 'kind'],
  ['decisions', 'target_kind'],
];

/** Tables whose guards refuse the update of a discriminator or a key. */
const GUARDED = ['publications', 'publication_grants'];

const tableExists = (db: Db, name: string): boolean =>
  db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = ?").get(name) !== undefined;

const columnsOf = (db: Db, table: string): Array<string> =>
  db
    .prepare(`PRAGMA table_info("${table}")`)
    .all()
    .map((column) => String(column.name));

const hasColumn = (db: Db, table: string, column: string): boolean => columnsOf(db, table).includes(column);

/** Runs `change` with the update guards of `tables` dropped, and puts them back as they were. */
function withoutGuards(db: Db, tables: ReadonlyArray<string>, change: () => void): void {
  const guards = tables.flatMap((table) =>
    db.prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?").all(table)
  );
  for (const guard of guards) db.exec(`DROP TRIGGER "${String(guard.name)}"`);
  change();
  for (const guard of guards) db.exec(String(guard.sql));
}

/** The entry's tables and their column under the names `to`, when they stand under `from`. */
function renameTables(db: Db, from: string, to: string): void {
  if (tableExists(db, from)) db.exec(`ALTER TABLE "${from}" RENAME TO "${to}"`);
  const oldMirrors = `${from}_mirrors`;
  const mirrors = `${to}_mirrors`;
  if (tableExists(db, oldMirrors)) db.exec(`ALTER TABLE "${oldMirrors}" RENAME TO "${mirrors}"`);
  if (tableExists(db, mirrors) && hasColumn(db, mirrors, `${from}_id`))
    db.exec(`ALTER TABLE "${mirrors}" RENAME COLUMN "${from}_id" TO "${to}_id"`);
}

/** The publications' kind and their keys, `<kind>:<entry>:<place>`: only the first word changes, the row ids stay. */
function renamePublications(db: Db, from: string, to: string): void {
  if (!tableExists(db, 'publications')) return;
  db.prepare(
    `UPDATE publications SET row_kind = ?, idempotency_key = ? || substr(idempotency_key, ?)
      WHERE row_kind = ? AND idempotency_key LIKE ?`
  ).run(to, to, from.length + 1, from, `${from}:%`);
  db.prepare('UPDATE publications SET row_kind = ? WHERE row_kind = ?').run(to, from);
}

/**
 * The graph's nodes `<word>:<entry>` and what points at them: the edges' ends and keys, the edge's id (a hash of its
 * ends, which the projection recomputes and must find), and the witnesses that name a node or an edge.
 */
function renameGraph(db: Db, from: string, to: string): void {
  if (!tableExists(db, 'graph_nodes')) return;
  const prefix = `${from}:`;
  const moved = (id: unknown): string => `${to}:${String(id).slice(prefix.length)}`;
  const nodes = db.prepare('SELECT id FROM graph_nodes WHERE kind = ? AND id LIKE ?').all(from, `${prefix}%`);
  db.exec('PRAGMA defer_foreign_keys = ON');
  const setNode = db.prepare('UPDATE graph_nodes SET id = ?, kind = ? WHERE id = ?');
  const setAccess = db.prepare('UPDATE node_access SET node_id = ? WHERE node_id = ?');
  const setWitness = db.prepare('UPDATE node_access SET evidence_id = ? WHERE evidence_id = ?');
  for (const { id } of nodes) {
    setNode.run(moved(id), to, id);
    setAccess.run(moved(id), id);
    setWitness.run(moved(id), id);
  }
  const edges = db
    .prepare(
      'SELECT id, src, dst, predicate, evidence_id, projection_key FROM graph_edges WHERE src LIKE ? OR dst LIKE ?'
    )
    .all(`${prefix}%`, `${prefix}%`);
  const setEdge = db.prepare('UPDATE graph_edges SET id = ?, src = ?, dst = ?, projection_key = ? WHERE id = ?');
  const end = (id: unknown): string => (String(id).startsWith(prefix) ? moved(id) : String(id));
  for (const edge of edges) renameEdge(edge, { moved: end, setEdge, setWitness });
}

function renameEdge(
  edge: Row,
  rename: {
    moved: (id: unknown) => string;
    setEdge: ReturnType<Db['prepare']>;
    setWitness: ReturnType<Db['prepare']>;
  }
): void {
  const { moved: end, setEdge, setWitness } = rename;
  const src = end(edge.src);
  const dst = end(edge.dst);
  const predicate = String(edge.predicate);
  const known = String(edge.projection_key).startsWith(`${predicate}:${String(edge.src)}:${String(edge.dst)}`);
  const key = known
    ? `${predicate}:${src}:${dst}${String(edge.projection_key).slice(`${predicate}:${String(edge.src)}:${String(edge.dst)}`.length)}`
    : String(edge.projection_key);
  // The projection hashes the evidence into the id only when it is not one of the edge's ends. An id neither way is left.
  const evidenced = edgeIdOf(predicate, edge.src, edge.dst, edge.evidence_id) === edge.id;
  const plain = edgeIdOf(predicate, edge.src, edge.dst, null) === edge.id;
  const id = evidenced
    ? edgeIdOf(predicate, src, dst, edge.evidence_id)
    : plain
      ? edgeIdOf(predicate, src, dst, null)
      : String(edge.id);
  setEdge.run(id, src, dst, key, edge.id);
  setWitness.run(id, edge.id);
}

/** Everything of the rename that can be taken back: the tables, the discriminators, the keys and the graph. */
function switchNames(db: Db, from: string, to: string): void {
  renameTables(db, from, to);
  withoutGuards(
    db,
    GUARDED.filter((table) => tableExists(db, table)),
    () => {
      renamePublications(db, from, to);
      for (const [table, column] of DISCRIMINATORS)
        if (tableExists(db, table) && hasColumn(db, table, column))
          db.prepare(`UPDATE "${table}" SET "${column}" = ? WHERE "${column}" = ?`).run(to, from);
    }
  );
  renameGraph(db, from, to);
  if (tableExists(db, 'media') && hasColumn(db, 'media', 'kind'))
    db.prepare('UPDATE media SET kind = ? WHERE kind = ?').run(to, from);
}

/** `change` in a transaction of its own, unless the caller's holds it: a rewrite of the graph defers its foreign keys. */
function atomically(db: Db, change: () => void): void {
  // A node:sqlite connection knows; a fixture's connection is the same object.
  if ((db as unknown as { isTransaction: boolean }).isTransaction) {
    change();
    return;
  }
  db.exec('BEGIN IMMEDIATE');
  change();
  db.exec('COMMIT');
}

/**
 * Runs `work` on a database that holds the old names with the names of today, and takes them back. For the shipped
 * data steps, whose writers speak today's names, and for a fixture that seeds an old schema through those writers.
 */
export function withCurrentNames<TResult>(connection: unknown, work: () => TResult): TResult {
  const db = connection as Db; // a node:sqlite connection
  atomically(db, () => {
    switchNames(db, OLD, NEW);
  });
  const result = work();
  atomically(db, () => {
    switchNames(db, NEW, OLD);
  });
  return result;
}

/** The indexes and the trigger of the two tables under the new word: SQLite keeps their names through a table rename. */
function renameSchemaObjects(db: Db): void {
  const objects = db
    .prepare(
      "SELECT type, name, sql FROM sqlite_master WHERE type IN ('index', 'trigger') AND sql IS NOT NULL AND name LIKE ?"
    )
    .all(`%${OLD}%`);
  for (const object of objects) {
    db.exec(`DROP ${String(object.type).toUpperCase()} "${String(object.name)}"`);
    db.exec(String(object.sql).replaceAll(OLD, NEW));
  }
}

/** `media_links` again with the new owner kind in its constraint, which SQLite cannot change in place. */
function rebuildMediaLinks(db: Db): void {
  if (!tableExists(db, 'media_links')) return;
  const table = db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'media_links'").get();
  if (!String(table?.sql).includes(`'${OLD}'`)) return;
  const indexes = db
    .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'media_links' AND sql IS NOT NULL")
    .all();
  const created = String(table?.sql)
    .replace(/^CREATE TABLE\s+"?media_links"?/, 'CREATE TABLE media_links_next')
    .replaceAll(`'${OLD}'`, `'${NEW}'`);
  db.exec(created);
  db.prepare(
    `INSERT INTO media_links_next (owner_kind, owner_id, position, media_id)
      SELECT CASE owner_kind WHEN ? THEN ? ELSE owner_kind END, owner_id, position, media_id FROM media_links`
  ).run(OLD, NEW);
  db.exec('DROP TABLE media_links; ALTER TABLE media_links_next RENAME TO media_links;');
  for (const index of indexes) db.exec(String(index.sql));
}

/** The persona's unit under its new kind: its id is a hash of the key, so every row that points at it follows. */
function rekeyUnits(db: Db): void {
  if (!tableExists(db, 'storage_units')) return;
  const units = db.prepare('SELECT * FROM storage_units WHERE kind = ?').all(OLD);
  if (units.length === 0) return;
  db.exec('PRAGMA defer_foreign_keys = ON');
  const owners = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'")
    .all()
    .map((row) => String(row.name))
    .flatMap((table) =>
      columnsOf(db, table)
        .filter((column) => column === 'owner_key' || column === 'unit_id')
        .map((column) => [table, column] as const)
    );
  for (const unit of units) {
    // The catalog wrote this key from a typed StorageKey; only its kind changes.
    const key = { ...(JSON.parse(String(unit.key_json)) as StorageKey), kind: NEW } as StorageKey;
    const id = storageId(key);
    db.prepare(
      `INSERT OR IGNORE INTO storage_units (id, kind, subject_type, subject_id, scope_place_id, partition, selector, key_json, lines, offset, synced_at, retired_at)
        SELECT ?, ?, subject_type, subject_id, scope_place_id, partition, selector, ?, lines, offset, synced_at, retired_at
          FROM storage_units WHERE id = ?`
    ).run(id, NEW, keyText(key), unit.id);
    for (const [table, column] of owners)
      db.prepare(`UPDATE "${table}" SET "${column}" = ? WHERE "${column}" = ?`).run(id, unit.id);
    // A converted database's operational row names its unit in `owner` too.
    db.prepare('UPDATE operational SET owner = ? WHERE owner = ?').run(id, unit.id);
    db.prepare('DELETE FROM storage_units WHERE id = ?').run(unit.id);
  }
}

/** The pending marks of the data steps under their new names. */
function renameMeta(db: Db): void {
  for (const mark of ['destination_pending', 'mirror_pending'])
    db.prepare('UPDATE OR REPLACE meta SET key = ? WHERE key = ?').run(`${NEW}_${mark}`, `${OLD}_${mark}`);
}

const WORDS: Readonly<Record<string, string>> = {
  [OLD]: NEW,
  [`${OLD}.post`]: `${NEW}.post`,
  [`${OLD}.show`]: `${NEW}.show`,
  [`${OLD}-mirror`]: `${NEW}-mirror`,
  [`${OLD}-draw-only`]: `${NEW}-draw-only`,
};
/** The keys of stored JSON whose value is an engine's word and never her text. */
const WORD_KEYS = new Set(['mode', 'skill', 'op', 'code']);

/** `value` with the engine's words of `WORD_KEYS` renamed, everything else (her text, above all) left alone. */
function renamedWords(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(renamedWords);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => {
      const word = typeof inner === 'string' && WORD_KEYS.has(key) ? WORDS[inner] : undefined;
      return [key, word ?? renamedWords(inner)];
    })
  );
}

/** The state's counters and day plan, `diary` and `diaryDay` and their like, and the words inside it. */
function renamedState(state: unknown): unknown {
  const words = renamedWords(state);
  if (words === null || typeof words !== 'object' || Array.isArray(words)) return words;
  return Object.fromEntries(
    Object.entries(words).map(([key, inner]) => [key.startsWith(OLD) ? `${NEW}${key.slice(OLD.length)}` : key, inner])
  );
}

/** Rewrites one JSON column for the rows that may hold the word; a row that comes out the same is not touched. */
function rewriteJson(db: Db, table: string, column: string, where: string, rewrite: (value: unknown) => unknown): void {
  if (!tableExists(db, table) || !hasColumn(db, table, column)) return;
  const rows = db
    .prepare(`SELECT rowid AS rowid, "${column}" AS value FROM "${table}" WHERE ${where} AND "${column}" LIKE ?`)
    .all(`%${OLD}%`);
  const write = db.prepare(`UPDATE "${table}" SET "${column}" = ? WHERE rowid = ?`);
  for (const row of rows) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(String(row.value));
    } catch {
      continue; // Not JSON: no engine word can be told from her text.
    }
    const next = JSON.stringify(rewrite(parsed));
    if (next !== JSON.stringify(parsed)) write.run(next, row.rowid);
  }
}

/**
 * The whole rename, the last schema step. Idempotent: on a database under the new names (a fresh one's step, a converted
 * copy that is already there) it finds nothing to change.
 */
export function renameToSelfreflection(db: Db): void {
  switchNames(db, OLD, NEW);
  renameSchemaObjects(db);
  rebuildMediaLinks(db);
  rekeyUnits(db);
  renameMeta(db);
  rewriteJson(db, 'operational', 'value', "kind = 'state'", renamedState);
  rewriteJson(db, 'operational', 'value', "kind = 'inner'", renamedWords);
  rewriteJson(db, 'day', 'extra', '1 = 1', renamedWords);
  rewriteJson(db, 'deliveries', 'receipt', '1 = 1', renamedWords);
  if (tableExists(db, 'media'))
    db.prepare('UPDATE media SET path = ? || substr(path, ?) WHERE path LIKE ?').run(
      NEW_MEDIA,
      OLD_MEDIA.length + 1,
      `${OLD_MEDIA}%`
    );
}

/** The graph node of a media row. */
const mediaNode = (id: string): string => `media:${id}`;

/**
 * The ids of her entries' pictures, `media:diary:<entry>-<n>`, become `media:selfreflection:<entry>-<n>`: the item in
 * `media` with every other column kept, its links in `media_links`, its graph node with the edges and witnesses that name
 * it. A picture whose new id is already taken keeps its old one and is counted. A second run finds nothing to move.
 */
export function moveSelfreflectionMediaIds(db: Db): { moved: number; kept: number } {
  const report = { moved: 0, kept: 0 };
  if (!tableExists(db, 'media')) return report;
  const old = db
    .prepare('SELECT id FROM media WHERE id LIKE ?')
    .all(`${LEGACY_ENTRY_MEDIA}%`)
    .map((row) => String(row.id));
  if (old.length === 0) return report;
  const taken = db.prepare('SELECT 1 AS ok FROM media WHERE id = ?');
  const renamed = new Map<string, string>();
  for (const id of old) {
    const next = `${ENTRY_MEDIA}${id.slice(LEGACY_ENTRY_MEDIA.length)}`;
    if (taken.get(next) === undefined) renamed.set(id, next);
    else report.kept += 1;
  }
  atomically(db, () => {
    const setMedia = db.prepare('UPDATE media SET id = ? WHERE id = ?');
    const setLink = tableExists(db, 'media_links')
      ? db.prepare('UPDATE media_links SET media_id = ? WHERE media_id = ?')
      : null;
    for (const [from, to] of renamed) {
      setMedia.run(to, from);
      setLink?.run(to, from);
    }
    if (!tableExists(db, 'graph_nodes')) return;
    db.exec('PRAGMA defer_foreign_keys = ON');
    const setNode = db.prepare('UPDATE graph_nodes SET id = ?, row_id = ? WHERE id = ?');
    const setAccess = db.prepare('UPDATE node_access SET node_id = ? WHERE node_id = ?');
    const setWitness = db.prepare('UPDATE node_access SET evidence_id = ? WHERE evidence_id = ?');
    const nodes = new Map([...renamed].map(([from, to]) => [mediaNode(from), mediaNode(to)]));
    for (const [from, to] of renamed) {
      setNode.run(mediaNode(to), to, mediaNode(from));
      setAccess.run(mediaNode(to), mediaNode(from));
      setWitness.run(mediaNode(to), mediaNode(from));
    }
    const setEdge = db.prepare('UPDATE graph_edges SET id = ?, src = ?, dst = ?, projection_key = ? WHERE id = ?');
    const edgeOf = db.prepare(
      'SELECT id, src, dst, predicate, evidence_id, projection_key FROM graph_edges WHERE src = ? OR dst = ?'
    );
    for (const from of nodes.keys())
      for (const edge of edgeOf.all(from, from))
        renameEdge(edge, { moved: (id) => nodes.get(String(id)) ?? String(id), setEdge, setWitness });
  });
  report.moved = renamed.size;
  if (report.kept > 0) log.warn('selfreflection media: ids kept under the old prefix', { kept: report.kept });
  return report;
}

/** One file of the old folder moved; a file the new folder already holds stays where it is unless it is the same. */
function moveFile(from: string, to: string): boolean {
  if (!fs.existsSync(to)) {
    fs.renameSync(from, to);
    return true;
  }
  if (!fs.readFileSync(from).equals(fs.readFileSync(to))) return false;
  fs.rmSync(from);
  return true;
}

/**
 * Moves what is left of `media/diary` under `dataDir` to `media/selfreflection`, file by file with a rename, and removes the
 * old folder once it is empty. Returns the files moved and the files kept back because the new folder holds another
 * file of that name. Safe to run at any point of a crash: it only ever looks at what is still in the old folder.
 */
export function moveSelfreflectionMedia(dataDir: string): { moved: number; kept: number } {
  const from = path.join(dataDir, 'media', OLD);
  if (!fs.existsSync(from)) return { moved: 0, kept: 0 };
  const to = path.join(dataDir, 'media', NEW);
  fs.mkdirSync(to, { recursive: true });
  const report = { moved: 0, kept: 0 };
  for (const name of fs.readdirSync(from)) {
    if (moveFile(path.join(from, name), path.join(to, name))) report.moved += 1;
    else report.kept += 1;
  }
  if (report.kept > 0) log.warn('selfreflection media: files kept in the old folder', { kept: report.kept });
  else fs.rmdirSync(from);
  return report;
}
