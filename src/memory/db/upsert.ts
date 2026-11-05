// Unit writes preserve primary and shared ownership through catalog owner keys. A row shared across semantic
// community scopes keeps its original owner until retirement hands it to a surviving co-owner. Session-owned rows
// and child links have no owner key and remain protected. Derived identity, graph projection, publication state and
// session-held fields are updated within the caller's writer transaction. Historical imports retain their original
// column contract and frozen path provenance through the explicit compatibility adapter.

import { hasStorageUnits, ensureUnit, unitById } from './storage-units.ts';
import { legacyStorageKey } from './paths.ts';
import { deriveRow, ensureLinks, ensureNodeKeys, ensureRelations, restrictDiaryMedia } from './rows.ts';
import { projectRow } from './graph.ts';
import { deriveMirrorPublication } from './publish.ts';
import { resolveParticipationSources } from './participation-sources.ts';
import { sessionHold } from './session-rows.ts';
import { asText } from './types.ts';
import type { Db, Row, Rows } from './types.ts';

/** Tables whose rows belong to one file (`owner_key`), and their primary key columns. */
export const OWNED: Record<string, ReadonlyArray<string>> = {
  people: ['id'],
  accounts: ['id'],
  places: ['id'],
  memberships: ['id'],
  sources: ['id'],
  claims: ['id'],
  claim_versions: ['id'],
  descriptions: ['id'],
  description_versions: ['id'],
  episodes: ['id'],
  affinity_events: ['id'],
  day: ['id'],
  diary: ['id'],
  media: ['id'],
  intentions: ['id'],
  work: ['id'],
  work_events: ['id'],
  decisions: ['id'],
  operational: ['kind', 'owner'],
  vectors: ['chunk_key'],
};

/** Tables that hang off a parent row of the same unit: child table -> [parent table, link column, parent key]. */
const CHILDREN: Record<string, [string, string]> = {
  episode_sources: ['episodes', 'episode_id'],
  claim_sources: ['claims', 'claim_id'],
  diary_mirrors: ['diary', 'diary_id'],
};

const quote = (name: string): string => `"${name}"`;

const columnCache = new WeakMap<Db, Map<string, Set<unknown>>>();
function columnsOf(db: Db, table: string): Set<unknown> {
  let tables = columnCache.get(db);
  if (!tables) columnCache.set(db, (tables = new Map()));
  let columns = tables.get(table);
  if (!columns) {
    columns = new Set(
      db
        .prepare(`PRAGMA table_info(${quote(table)})`)
        .all()
        .map((c) => c.name)
    );
    tables.set(table, columns);
  }
  return columns;
}

const statementCache = new WeakMap<Db, Map<string, ReturnType<Db['prepare']>>>();
function prepared(db: Db, sql: string): ReturnType<Db['prepare']> {
  let map = statementCache.get(db);
  if (!map) statementCache.set(db, (map = new Map()));
  let statement = map.get(sql);
  if (!statement) {
    const legacy = !hasStorageUnits(db);
    const raw = db.prepare(legacy ? sql.replaceAll('owner_key', 'owner_file') : sql);
    const owned = (row: Row | undefined): Row | undefined =>
      row && legacy && Object.hasOwn(row, 'owner_file') ? { ...row, owner_key: row.owner_file } : row;
    statement = legacy
      ? {
          run: (...args: Array<unknown>) => raw.run(...args),
          get: (...args: Array<unknown>) => owned(raw.get(...args)),
          all: (...args: Array<unknown>) => raw.all(...args).map((row) => owned(row)!),
          *iterate(...args: Array<unknown>) {
            for (const row of raw.iterate(...args)) yield owned(row)!;
          },
        }
      : raw;
    map.set(sql, statement);
  }
  return statement;
}

const bind = (value: unknown): unknown => (value === undefined ? null : value);

/** The guild directory prefix of a full unit path (`guilds/<g>/`), or null. */
const guildOf = (db: Db, owner: unknown): string | null =>
  hasStorageUnits(db)
    ? (unitById(db, asText(owner))?.key.scopePlaceId ?? null)
    : (/^guilds\/[^/]+\//.exec(asText(owner ?? ''))?.[0] ?? null);

/** Inserts a row, or updates the columns it names when the primary key exists (rowid and unnamed columns stay). */
function upsert(db: Db, table: string, row: Row, { ignore = false }: { ignore?: boolean } = {}): void {
  const have = columnsOf(db, table);
  const out = { ...row };
  if (have.has('retired_at') && !Object.hasOwn(out, 'retired_at')) out.retired_at = null;
  const cols = Object.keys(out).filter((col) => have.has(col));
  const key = OWNED[table] ?? [];
  const update = cols.filter((col) => !key.includes(col));
  // A source whose text changed loses its stems (the stems job stems it again).
  const restem =
    table === 'sources' && cols.includes('text') && have.has('stems')
      ? ', "stems" = CASE WHEN excluded."text" IS "sources"."text" THEN "sources"."stems" ELSE NULL END'
      : '';
  const sql =
    `INSERT INTO ${quote(table)} (${cols.map(quote).join(', ')}) VALUES (${cols.map(() => '?').join(', ')}) ON CONFLICT(${key.map(quote).join(', ')}) ` +
    (ignore || update.length === 0
      ? 'DO NOTHING'
      : `DO UPDATE SET ${update.map((col) => `${quote(col)} = excluded.${quote(col)}`).join(', ')}${restem}`);
  prepared(db, sql).run(...cols.map((col) => bind(out[col])));
}

const keyOf = (table: string, row: Row): string => OWNED[table].map((col) => row[col]).join('\u0000');

/** The existing row of a mapped row's primary key: { owner_key, retired_at, origin?, kind? } or undefined. */
function existingOf(db: Db, table: string, row: Row): Row | undefined {
  const key = OWNED[table];
  const origin = table === 'sources' ? ', origin' : table === 'people' ? ', kind' : '';
  return prepared(
    db,
    `SELECT owner_key, retired_at${origin} FROM ${quote(table)} WHERE ${key.map((col) => `${quote(col)} = ?`).join(' AND ')}`
  ).get(...key.map((col) => bind(row[col])));
}

/**
 * Whether a row the database wrote is an observation's (observe.ts) that a unit write now brings: a line observed
 * live (`origin` `observation`), or an account or a non-DM place (only an observation writes those without a unit;
 * the DM places the resolver creates are never in a unit). The unit's row adopts it (its `owner_key`, every column
 * the mapping names) instead of skipping it or writing a second row. A person with no kind is what an owner's link
 * made (person-links.ts) and waits for its profile the same way.
 */
const observedRow = (table: string, found: Row, row: Row) =>
  table === 'sources'
    ? found.origin === 'observation'
    : table === 'accounts' ||
      (table === 'places' && row.kind !== 'dm') ||
      (table === 'people' && (found.kind === null || found.kind === undefined));

/**
 * Writes one mapped row of a unit, keeping the ownership rules: a row the database wrote (no owner) is left alone;
 * a live row of another guild is shared (listed in `co_owners`, not rewritten); anything else is upserted.
 * Returns true when the row is now this unit's to write (false: skipped).
 */
function writeRow(db: Db, table: string, row: Row, opts: { ignore?: boolean; at?: string }): boolean {
  const found = existingOf(db, table, row);
  if (found) {
    if ((found.owner_key === null || found.owner_key === undefined) && !observedRow(table, found, row)) return false;
    const mine = row.owner_key;
    if (found.owner_key !== mine && found.retired_at === null) {
      const theirs = guildOf(db, found.owner_key);
      if (theirs !== null && guildOf(db, mine) !== null && theirs !== guildOf(db, mine)) {
        prepared(db, 'INSERT OR IGNORE INTO co_owners (tbl, key, owner_key) VALUES (?, ?, ?)').run(
          table,
          keyOf(table, row),
          mine
        );
        return false;
      }
    }
  }
  // The v7 derived columns (audience, authority, native key, ...) come from the row itself, so a remap re-derives them.
  const derived = deriveRow(db, table, row, { at: opts.at });
  upsert(db, table, derived, opts);
  if (table === 'people' || table === 'accounts' || table === 'places')
    ensureNodeKeys(db, table, derived, { at: opts.at });
  // Schema v8: a line's `reply_to` is a `replies_to` relation, and relations waiting for this line are resolved. Schema
  // v9: the row's unit is projected (ensureRelations projects a source with its relations).
  if (table === 'sources') ensureRelations(db, derived, { at: opts.at });
  else projectRow(db, table, derived, { at: opts.at });
  if (table === 'diary') restrictDiaryMedia(db, derived, opts.at);
  if (found && found.owner_key !== row.owner_key) {
    prepared(db, 'DELETE FROM co_owners WHERE tbl = ? AND key = ? AND owner_key = ?').run(
      table,
      keyOf(table, row),
      row.owner_key
    );
  }
  return true;
}

/** Hands a row over to another live unit that also maps it; false when there is none. */
function handOver(db: Db, table: string, key: Row, owner: string): boolean {
  const heir = prepared(
    db,
    `SELECT c.owner_key FROM co_owners c JOIN ${hasStorageUnits(db) ? 'storage_units' : 'files'} f ON f.${hasStorageUnits(db) ? 'id' : 'path'} = c.owner_key
     WHERE c.tbl = ? AND c.key = ? AND c.owner_key != ? AND f.${hasStorageUnits(db) ? 'retired_at' : 'gone_at'} IS NULL ORDER BY c.owner_key LIMIT 1`
  ).get(table, keyOf(table, key), owner);
  if (!heir) return false;
  const cols = OWNED[table];
  prepared(
    db,
    `UPDATE ${quote(table)} SET owner_key = ? WHERE ${cols.map((col) => `${quote(col)} = ?`).join(' AND ')}`
  ).run(heir.owner_key, ...cols.map((col) => key[col]));
  prepared(db, 'DELETE FROM co_owners WHERE tbl = ? AND key = ? AND owner_key = ?').run(
    table,
    keyOf(table, key),
    heir.owner_key
  );
  for (const [child, [parent, link]] of Object.entries(CHILDREN)) {
    if (parent === table)
      prepared(db, `UPDATE ${quote(child)} SET owner_key = ? WHERE ${quote(link)} = ? AND owner_key = ?`).run(
        heir.owner_key,
        key.id,
        owner
      );
  }
  return true;
}

/** The identity of a child link inside its unit: where it sits under its parent (a mirror: which place it was sent to). */
const childKey = (child: string, row: Row): string =>
  child === 'diary_mirrors'
    ? [row.diary_id, row.iface, row.place_id ?? ''].join('\u0000')
    : [row[CHILDREN[child][1]], row.position].join('\u0000');

/** Retires the active rows of a unit that the given mapping no longer holds. Returns how many. */
export function retireAbsent(db: Db, owner: string, mapping: Rows, at: string): number {
  owner = mappingOwner(db, mapping, owner);
  let count = 0;
  for (const [table, key] of Object.entries(OWNED)) {
    const keep = new Set((mapping[table] ?? []).map((row: Row) => keyOf(table, row)));
    const existing = prepared(
      db,
      `SELECT ${key.map(quote).join(', ')} FROM ${quote(table)} WHERE owner_key = ? AND retired_at IS NULL`
    ).all(owner);
    const update = prepared(
      db,
      `UPDATE ${quote(table)} SET retired_at = ? WHERE ${key.map((col) => `${quote(col)} = ?`).join(' AND ')}`
    );
    for (const row of existing) {
      if (keep.has(keyOf(table, row))) continue;
      if (handOver(db, table, row, owner)) continue;
      update.run(at, ...key.map((col) => row[col]));
      projectRow(db, table, row, { at });
      count += 1;
    }
    // This unit no longer maps the rows it shared with another guild.
    for (const shared of prepared(db, 'SELECT key FROM co_owners WHERE tbl = ? AND owner_key = ?').all(table, owner)) {
      if (!keep.has(shared.key as string))
        prepared(db, 'DELETE FROM co_owners WHERE tbl = ? AND key = ? AND owner_key = ?').run(table, shared.key, owner);
    }
  }
  for (const [child, [parent, link]] of Object.entries(CHILDREN)) {
    const keep = new Set((mapping[child] ?? []).map((row: Row) => childKey(child, row)));
    const cols = child === 'diary_mirrors' ? 'rowid, diary_id, iface, place_id' : `rowid, ${quote(link)}, position`;
    const existing = prepared(
      db,
      `SELECT ${cols} FROM ${quote(child)} c WHERE owner_key = ? AND retired_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM ${quote(parent)} p WHERE p.id = c.${quote(link)} AND p.retired_at IS NULL AND p.owner_key IS NOT NULL AND p.owner_key != ?)`
    ).all(owner, owner);
    for (const row of existing) {
      if (keep.has(childKey(child, row))) continue;
      prepared(db, `UPDATE ${quote(child)} SET retired_at = ? WHERE rowid = ?`).run(at, row.rowid);
      if (child === 'diary_mirrors') deriveMirrorPublication(db, row, { at });
      projectRow(db, child, row, { at });
      count += 1;
    }
  }
  return count;
}

/** Writes the child links of a mapping for one unit: a link that is already there is updated and un-retired, a new one is inserted. */
function writeChildren(
  db: Db,
  mapping: Rows,
  owner: string,
  skippedParents: ReadonlySet<string>,
  touched: Array<[string, Row]>
): number {
  let count = 0;
  for (const [child, [parent, link]] of Object.entries(CHILDREN)) {
    for (const row of mapping[child] ?? []) {
      if (skippedParents.has(`${parent}\u0000${asText(row[link])}`)) continue;
      const out: Row = { ...row, owner_key: owner, retired_at: null };
      const cols = Object.keys(out);
      const where =
        child === 'diary_mirrors'
          ? "diary_id = ? AND iface = ? AND coalesce(place_id, '') = ?"
          : `${quote(link)} = ? AND position = ?`;
      const args =
        child === 'diary_mirrors' ? [row.diary_id, row.iface, row.place_id ?? ''] : [row[link], bind(row.position)];
      const found = prepared(
        db,
        `SELECT rowid, owner_key FROM ${quote(child)} WHERE ${where} ORDER BY owner_key IS NULL DESC, rowid LIMIT 1`
      ).get(...args);
      if (found && (found.owner_key === null || found.owner_key === undefined)) continue;
      if (found) {
        prepared(
          db,
          `UPDATE ${quote(child)} SET ${cols.map((col) => `${quote(col)} = ?`).join(', ')} WHERE rowid = ?`
        ).run(...cols.map((col) => bind(out[col])), found.rowid);
      } else {
        prepared(
          db,
          `INSERT INTO ${quote(child)} (${cols.map(quote).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`
        ).run(...cols.map((col) => bind(out[col])));
      }
      touched.push([child, row]);
      count += 1;
    }
  }
  return count;
}

/** Legacy import adapters resolve their provenance once; active writers already provide a catalog identity. */
function mappingOwner(db: Db, mapping: Rows, owner: string): string {
  const current = hasStorageUnits(db);
  const id = current && !owner.startsWith('unit:') ? ensureUnit(db, legacyStorageKey(owner)) : owner;
  for (const rows of Object.values(mapping))
    for (const row of rows) {
      const provenance = row.owner_file;
      if ((row.owner_key !== null && row.owner_key !== undefined) || (provenance !== null && provenance !== undefined))
        row.owner_key = id;
    }
  return id;
}

/** Writes a mapping (table -> rows) of the unit `owner`. */
export function writeMapping(
  db: Db,
  mapping: Rows,
  owner: string,
  { ignoreClaims = false, at }: { ignoreClaims?: boolean; at?: string } = {}
): number {
  owner = mappingOwner(db, mapping, owner);
  resolveParticipationSources(db, mapping);
  let count = 0;
  const skippedParents = new Set<string>();
  const hold = sessionHold(db, mapping);
  for (const [table, rows] of Object.entries(mapping)) {
    if (CHILDREN[table] || !rows.length) continue;
    for (const row of rows) {
      const kept = hold(table, row);
      if (kept && writeRow(db, table, kept, { ignore: table === 'claims' && ignoreClaims, at })) count += 1;
      else if (Object.values(CHILDREN).some(([parent]) => parent === table))
        skippedParents.add(`${table}\u0000${asText(row.id)}`);
    }
  }
  // An account with a person gets its link row once; an existing link is the database's and is never rewritten.
  ensureLinks(db, mapping.accounts, { at });
  const touched: Array<[string, Row]> = [];
  count += writeChildren(db, mapping, owner, skippedParents, touched);
  // Schema v10: a mirror's publication follows the mirror (publish.ts#deriveMirrorPublication), on this one path.
  for (const [child, row] of touched) {
    if (child === 'diary_mirrors') deriveMirrorPublication(db, row, { at });
    projectRow(db, child, row, { at });
  }
  return count;
}

/** Makes a unit's mapping use the full unit path: `owner_key` of every row, and the `owner` of an operational row built from the path. */
export function qualify(mapping: Rows, unit: { rel: string; full: string }): Rows {
  for (const rows of Object.values(mapping)) {
    for (const row of rows) {
      if (row.owner_file === unit.rel) {
        if (row.owner !== undefined && (row.owner === unit.rel || asText(row.owner).startsWith(`${unit.rel}#`)))
          row.owner = `${unit.full}${asText(row.owner).slice(unit.rel.length)}`;
        row.owner_file = unit.full;
      }
      if (row.owner_key !== undefined && row.owner_key !== null && row.owner_key === unit.rel) {
        if (row.owner !== undefined && (row.owner === unit.rel || asText(row.owner).startsWith(`${unit.rel}#`)))
          row.owner = `${unit.full}${asText(row.owner).slice(unit.rel.length)}`;
        row.owner_key = unit.full;
      }
    }
  }
  for (const child of Object.keys(CHILDREN)) for (const row of mapping[child] ?? []) row.owner_key = unit.full;
  return mapping;
}

/** The ids of the hot claims and episodes (what an archive line must not stub over, map/archive.ts). */
export function hotClaimIds(db: Db): Set<string> {
  const ids = new Set<string>();
  for (const row of db
    .prepare(
      hasStorageUnits(db)
        ? "SELECT c.id FROM claims c LEFT JOIN storage_units u ON u.id=c.owner_key WHERE c.retired_at IS NULL AND (u.kind IS NULL OR u.kind != 'archive')"
        : "SELECT id FROM claims WHERE retired_at IS NULL AND owner_file NOT GLOB '*archive/*'"
    )
    .all())
    ids.add(row.id as string);
  for (const row of db.prepare('SELECT id FROM episodes WHERE retired_at IS NULL').all()) ids.add(row.id as string);
  return ids;
}

export function linkVectors(db: Db, rows: ReadonlyArray<Row>): void {
  for (const row of rows) {
    const match = /^(?:private:[^:]+:)?record:(.+):([^:]*?)(?:#\d+)?$/.exec(String(row.chunk_key));
    if (!match || match[2] === '') continue;
    const found = prepared(
      db,
      "SELECT rowid FROM sources WHERE native_id = ? AND revision = ? AND kind IN ('seen', 'said') ORDER BY kind LIMIT 1"
    ).get(match[1], Number(match[2]));
    if (found) row.source_rowid = found.rowid;
  }
}
