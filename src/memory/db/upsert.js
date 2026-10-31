// The one way rows of a memory unit get into the memory database: a unit's mapper (src/memory/db/map/) turns a unit's
// value or lines into rows, and these write them, keeping the ownership rules. Every row a unit's mapper wrote carries
// the unit's full path (`guilds/<g>/users/<u>.json`) as `owner_file`, so two guilds never share a unit. A row that two
// guilds both map (one person in two servers) stays one row owned by the first; the others are listed in `co_owners`
// (an export of their unit finds it, and retiring the owner hands it over). Rows the database itself wrote (no
// `owner_file`) are never updated or retired by a unit write, and neither are child links (`claim_sources`,
// `episode_sources`, `diary_mirrors`) without an `owner_file`: a write retires the links its unit no longer holds
// (`retired_at`) and un-retires the ones that return, it never deletes.
//
// Every row is written with its derived columns filled from the row itself (rows.js#deriveRow: the audience, an
// account's or a place's authority and native key, a source's author kind); the DM place a DM row names and its
// audience are created when missing; people, accounts and places are registered in `external_keys`; an account with a
// person gets its `account_person_links` row once. A line's `reply_to` also gives it a `source_relations` row
// (rows.js#ensureRelations). Every row written or retired is projected into the graph in the same transaction
// (graph.js#projectRow), and every diary mirror written or retired derives its `publications` row
// (publish.js#deriveMirrorPublication). A row an observation wrote live (observe.js: a line, an account, a place under
// the observer's own id) is adopted when a unit write brings it (`observedRow`). In a row the unit still owns, the
// columns her memory session wrote last stay as she wrote them (session-rows.ts#sessionHold: a person's attitude, a
// description's current version).
//
// Pure of the bot: it takes an opened database's connection; the caller holds the writer lock and the transaction
// (unit-write.js, through the service's writer).

import { deriveRow, ensureLinks, ensureNodeKeys, ensureRelations } from './rows.js';
import { projectRow } from './graph.js';
import { deriveMirrorPublication } from './publish.js';
import { LEGACY_IFACE } from './legacy-namespace.ts';
import { sessionHold } from './session-rows.ts';

/** Tables whose rows belong to one file (`owner_file`), and their primary key columns. */
export const OWNED = {
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
const CHILDREN = {
  episode_sources: ['episodes', 'episode_id'],
  claim_sources: ['claims', 'claim_id'],
  diary_mirrors: ['diary', 'diary_id'],
};

const quote = (name) => `"${name}"`;

const columnCache = new WeakMap();
function columnsOf(db, table) {
  let tables = columnCache.get(db);
  if (!tables) columnCache.set(db, (tables = new Map()));
  if (!tables.has(table))
    tables.set(
      table,
      new Set(
        db
          .prepare(`PRAGMA table_info(${quote(table)})`)
          .all()
          .map((c) => c.name)
      )
    );
  return tables.get(table);
}

const statementCache = new WeakMap();
function prepared(db, sql) {
  let map = statementCache.get(db);
  if (!map) statementCache.set(db, (map = new Map()));
  if (!map.has(sql)) map.set(sql, db.prepare(sql));
  return map.get(sql);
}

const bind = (value) => (value === undefined ? null : value);

/** The guild directory prefix of a full unit path (`guilds/<g>/`), or null. */
const guildOf = (owner) => /^guilds\/[^/]+\//.exec(String(owner ?? ''))?.[0] ?? null;

/** Inserts a row, or updates the columns it names when the primary key exists (rowid and unnamed columns stay). */
function upsert(db, table, row, { ignore = false } = {}) {
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

const keyOf = (table, row) => OWNED[table].map((col) => row[col]).join('\u0000');

/** The existing row of a mapped row's primary key: { owner_file, retired_at, origin? } or undefined. */
function existingOf(db, table, row) {
  const key = OWNED[table];
  const origin = table === 'sources' ? ', origin' : '';
  return prepared(
    db,
    `SELECT owner_file, retired_at${origin} FROM ${quote(table)} WHERE ${key.map((col) => `${quote(col)} = ?`).join(' AND ')}`
  ).get(...key.map((col) => bind(row[col])));
}

/**
 * Whether a row the database wrote is an observation's (observe.js) that a unit write now brings: a line observed
 * live (`origin` `observation`), or an account or a non-DM place (only an observation writes those without a unit;
 * the DM places the resolver creates are never in a unit). The unit's row adopts it (its `owner_file`, every column
 * the mapping names) instead of skipping it or writing a second row.
 */
const observedRow = (table, found, row) =>
  table === 'sources'
    ? found.origin === 'observation'
    : table === 'accounts' || (table === 'places' && row.kind !== 'dm');

/**
 * Writes one mapped row of a unit, keeping the ownership rules: a row the database wrote (no owner) is left alone;
 * a live row of another guild is shared (listed in `co_owners`, not rewritten); anything else is upserted.
 * Returns true when the row is now this unit's to write (false: skipped).
 */
function writeRow(db, table, row, opts) {
  const found = existingOf(db, table, row);
  if (found) {
    if ((found.owner_file === null || found.owner_file === undefined) && !observedRow(table, found, row)) return false;
    const mine = row.owner_file;
    if (found.owner_file !== mine && found.retired_at === null) {
      const theirs = guildOf(found.owner_file);
      if (theirs !== null && guildOf(mine) !== null && theirs !== guildOf(mine)) {
        prepared(db, 'INSERT OR IGNORE INTO co_owners (tbl, key, owner_file) VALUES (?, ?, ?)').run(
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
  if (found && found.owner_file !== row.owner_file) {
    prepared(db, 'DELETE FROM co_owners WHERE tbl = ? AND key = ? AND owner_file = ?').run(
      table,
      keyOf(table, row),
      row.owner_file
    );
  }
  return true;
}

/** Hands a row over to another live unit that also maps it; false when there is none. */
function handOver(db, table, key, owner) {
  const heir = prepared(
    db,
    `SELECT c.owner_file FROM co_owners c JOIN files f ON f.path = c.owner_file
     WHERE c.tbl = ? AND c.key = ? AND c.owner_file != ? AND f.gone_at IS NULL ORDER BY c.owner_file LIMIT 1`
  ).get(table, keyOf(table, key), owner);
  if (!heir) return false;
  const cols = OWNED[table];
  prepared(
    db,
    `UPDATE ${quote(table)} SET owner_file = ? WHERE ${cols.map((col) => `${quote(col)} = ?`).join(' AND ')}`
  ).run(heir.owner_file, ...cols.map((col) => key[col]));
  prepared(db, 'DELETE FROM co_owners WHERE tbl = ? AND key = ? AND owner_file = ?').run(
    table,
    keyOf(table, key),
    heir.owner_file
  );
  for (const [child, [parent, link]] of Object.entries(CHILDREN)) {
    if (parent === table)
      prepared(db, `UPDATE ${quote(child)} SET owner_file = ? WHERE ${quote(link)} = ? AND owner_file = ?`).run(
        heir.owner_file,
        key.id,
        owner
      );
  }
  return true;
}

/** The identity of a child link inside its unit: where it sits under its parent (a mirror: which place it was sent to). */
const childKey = (child, row) =>
  child === 'diary_mirrors'
    ? [row.diary_id, row.iface, row.place_id ?? ''].join('\u0000')
    : [row[CHILDREN[child][1]], row.position].join('\u0000');

/** Retires the active rows of a unit that the given mapping no longer holds. Returns how many. */
export function retireAbsent(db, owner, mapping, at) {
  let count = 0;
  for (const [table, key] of Object.entries(OWNED)) {
    const keep = new Set((mapping[table] ?? []).map((row) => keyOf(table, row)));
    const existing = prepared(
      db,
      `SELECT ${key.map(quote).join(', ')} FROM ${quote(table)} WHERE owner_file = ? AND retired_at IS NULL`
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
    for (const shared of prepared(db, 'SELECT key FROM co_owners WHERE tbl = ? AND owner_file = ?').all(table, owner)) {
      if (!keep.has(shared.key))
        prepared(db, 'DELETE FROM co_owners WHERE tbl = ? AND key = ? AND owner_file = ?').run(
          table,
          shared.key,
          owner
        );
    }
  }
  for (const [child, [parent, link]] of Object.entries(CHILDREN)) {
    const keep = new Set((mapping[child] ?? []).map((row) => childKey(child, row)));
    const cols = child === 'diary_mirrors' ? 'rowid, diary_id, iface, place_id' : `rowid, ${quote(link)}, position`;
    const existing = prepared(
      db,
      `SELECT ${cols} FROM ${quote(child)} c WHERE owner_file = ? AND retired_at IS NULL
      AND NOT EXISTS (SELECT 1 FROM ${quote(parent)} p WHERE p.id = c.${quote(link)} AND p.retired_at IS NULL AND p.owner_file IS NOT NULL AND p.owner_file != ?)`
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
function writeChildren(db, mapping, owner, skippedParents, touched) {
  let count = 0;
  for (const [child, [parent, link]] of Object.entries(CHILDREN)) {
    for (const row of mapping[child] ?? []) {
      if (skippedParents.has(`${parent}\u0000${row[link]}`)) continue;
      const out = { ...row, owner_file: owner, retired_at: null };
      const cols = Object.keys(out);
      const where =
        child === 'diary_mirrors'
          ? "diary_id = ? AND iface = ? AND coalesce(place_id, '') = ?"
          : `${quote(link)} = ? AND position = ?`;
      const args =
        child === 'diary_mirrors' ? [row.diary_id, row.iface, row.place_id ?? ''] : [row[link], bind(row.position)];
      const found = prepared(
        db,
        `SELECT rowid, owner_file FROM ${quote(child)} WHERE ${where} ORDER BY owner_file IS NULL DESC, rowid LIMIT 1`
      ).get(...args);
      if (found && (found.owner_file === null || found.owner_file === undefined)) continue;
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

/** Writes a mapping (table -> rows) of the unit `owner`. */
export function writeMapping(db, mapping, owner, { ignoreClaims = false, at } = {}) {
  let count = 0;
  const skippedParents = new Set();
  const hold = sessionHold(db, mapping);
  for (const [table, rows] of Object.entries(mapping)) {
    if (CHILDREN[table] || !rows.length) continue;
    for (const row of rows) {
      const kept = hold(table, row);
      if (kept && writeRow(db, table, kept, { ignore: table === 'claims' && ignoreClaims, at })) count += 1;
      else if (Object.values(CHILDREN).some(([parent]) => parent === table))
        skippedParents.add(`${table}\u0000${row.id}`);
    }
  }
  // An account with a person gets its link row once; an existing link is the database's and is never rewritten.
  ensureLinks(db, mapping.accounts, { at });
  const touched = [];
  count += writeChildren(db, mapping, owner, skippedParents, touched);
  // A participation file names lines by their message (`src:discord:<id>`): they are pointed at the stored revision
  // before the episodes are projected, so a remap never projects the bare reference for a moment.
  if ((mapping.episode_sources ?? []).length > 0) relinkParticipation(db, at);
  // Schema v10: a mirror's publication follows the mirror (publish.js#deriveMirrorPublication), on this one path.
  for (const [child, row] of touched) {
    if (child === 'diary_mirrors') deriveMirrorPublication(db, row, { at });
    projectRow(db, child, row, { at });
  }
  return count;
}

/** Makes a unit's mapping use the full unit path: `owner_file` of every row, and the `owner` of an operational row built from the path. */
export function qualify(mapping, unit) {
  for (const rows of Object.values(mapping)) {
    for (const row of rows) {
      if (row.owner_file !== undefined && row.owner_file !== null && row.owner_file === unit.rel) {
        if (row.owner !== undefined && (row.owner === unit.rel || String(row.owner).startsWith(`${unit.rel}#`)))
          row.owner = `${unit.full}${String(row.owner).slice(unit.rel.length)}`;
        row.owner_file = unit.full;
      }
    }
  }
  for (const child of Object.keys(CHILDREN)) for (const row of mapping[child] ?? []) row.owner_file = unit.full;
  return mapping;
}

/** The ids of the hot claims and episodes (what an archive line must not stub over, map/archive.js). */
export function hotClaimIds(db) {
  const ids = new Set();
  for (const row of db
    .prepare("SELECT id FROM claims WHERE retired_at IS NULL AND owner_file NOT GLOB '*archive/*'")
    .all())
    ids.add(row.id);
  for (const row of db.prepare('SELECT id FROM episodes WHERE retired_at IS NULL').all()) ids.add(row.id);
  return ids;
}

/**
 * Points every participation message ref (`src:discord:<messageId>`) at the newest revision of that message in the
 * record, when the record has it; a ref the record does not hold is kept as it is. Returns how many were changed.
 */
function relinkParticipation(db, at) {
  // The ref names a message of the legacy namespace: the line is looked up by its native tuple (schema v8), so another interface's id
  // that happens to be the same string is never taken for it. A database before v8 has only the native id.
  const tuple = columnsOf(db, 'sources').has('native_kind');
  const find = tuple
    ? prepared(
        db,
        `SELECT id FROM sources WHERE authority_id = '${LEGACY_IFACE}/global' AND native_kind = 'message' AND generation = 1 AND native_id = ? AND kind IN ('seen', 'said') AND retired_at IS NULL ORDER BY revision DESC LIMIT 1`
      )
    : prepared(
        db,
        "SELECT id FROM sources WHERE native_id = ? AND kind IN ('seen', 'said') AND retired_at IS NULL ORDER BY revision DESC LIMIT 1"
      );
  const update = prepared(
    db,
    'UPDATE episode_sources SET source_id = ? WHERE episode_id = ? AND position = ? AND source_id = ?'
  );
  let count = 0;
  for (const row of db
    .prepare(
      `SELECT episode_id, source_id, position FROM episode_sources WHERE source_id LIKE 'src:${LEGACY_IFACE}:%' AND retired_at IS NULL`
    )
    .all()) {
    const messageId = new RegExp(`^src:${LEGACY_IFACE}:([^:]+)`).exec(row.source_id)?.[1];
    const found = messageId ? find.get(messageId) : null;
    if (!found || found.id === row.source_id) continue;
    update.run(found.id, row.episode_id, row.position, row.source_id);
    projectRow(db, 'episode_sources', { episode_id: row.episode_id }, { at });
    count += 1;
  }
  return count;
}

export function linkVectors(db, rows) {
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
