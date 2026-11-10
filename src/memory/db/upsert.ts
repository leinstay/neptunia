// The shared write rules of the writers that store a whole value or a line as rows. Each row names its owner in its own
// columns, `writer`, `holder_id` and, for a line, `period` (place-owner.ts, profile-owner.ts, line-owner.ts). A row
// another place's writer holds is shared instead of rewritten (listed in `co_owners`), and keeps its first owner until
// retirement hands it to a place that shares it (place-owner.ts#retirePlaceAbsent). Rows her memory session wrote and
// rows the database wrote have no such writer and stay as they are. Derived identity, graph projection, publication
// state and session-held fields are updated within the caller's writer transaction.

import { PERSONA_ID } from './storage-keys.ts';
import {
  deriveRow,
  ensureLinks,
  ensureNodeKeys,
  ensureRelations,
  restrictSelfreflectionMedia,
  syncPersonAccounts,
} from './rows.ts';
import { projectRow } from './graph.ts';
import { deriveMirrorPublication } from './publish.ts';
import { resolveParticipationSources } from './participation-sources.ts';
import { sessionHold } from './session-rows.ts';
import { isPlaceWriter, placeOfHolder, sharePlaceRow, unsharePlaceRow } from './place-owner.ts';
import { placeOfVersions } from './profile-owner.ts';
import { parseExtra } from './row-columns.ts';
import { hasMessageFamilies } from './message-family-catalog.ts';
import { asText } from './types.ts';
import type { Db, Row, Rows } from './types.ts';

/** Tables whose rows a writer owns, and their primary key columns. */
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
  selfreflection: ['id'],
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
  selfreflection_mirrors: ['selfreflection', 'selfreflection_id'],
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
    statement = db.prepare(sql);
    map.set(sql, statement);
  }
  return statement;
}

const bind = (value: unknown): unknown => (value === undefined ? null : value);

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

/** The writers whose rows own themselves through their owner columns; a row of any other is her session's or the database's. */
const ROW_WRITERS: ReadonlySet<unknown> = new Set([
  'place',
  'channel',
  'lore',
  'participation',
  'recent',
  'selfreflection',
  'profile',
  'private',
  'versions',
  'record',
  'journal',
  'archive',
  'requests',
  'media',
]);

/** The owner columns a table has, of `writer`, `holder_id` and `period`. */
const ownerColumns = (db: Db, table: string): Array<string> =>
  ['writer', 'holder_id', 'period'].filter((col) => columnsOf(db, table).has(col));

/**
 * The existing row of a mapped row's primary key: { retired_at, origin?, kind?, writer?, holder_id?, period? } or
 * undefined.
 */
function existingOf(db: Db, table: string, row: Row): Row | undefined {
  const key = OWNED[table];
  const origin = table === 'sources' ? ['origin'] : table === 'people' ? ['kind'] : [];
  const columns = ['retired_at', ...origin, ...ownerColumns(db, table)].map(quote).join(', ');
  return prepared(
    db,
    `SELECT ${columns} FROM ${quote(table)} WHERE ${key.map((col) => `${quote(col)} = ?`).join(' AND ')}`
  ).get(...key.map((col) => bind(row[col])));
}

/**
 * Whether a row the database wrote is an observation's (observe.ts) that a write now brings: a line observed live
 * (`origin` `observation`), or an account or a non-DM place (only an observation writes those without a writer; the DM
 * places the resolver creates are never in a value). The written row adopts it (its owner columns, every column the
 * mapping names) instead of skipping it or writing a second row. A person with no kind is what an owner's link made
 * (person-links.ts) and waits for its profile the same way.
 */
const observedRow = (table: string, found: Row, row: Row) =>
  table === 'sources'
    ? found.origin === 'observation'
    : table === 'accounts' ||
      (table === 'places' && row.kind !== 'dm') ||
      (table === 'people' && (found.kind === null || found.kind === undefined));

/** Whether a row has an owner: one of the writers that own their rows. */
const isOwned = (row: Row): boolean => ROW_WRITERS.has(row.writer);

/** Whether a found row has the owner columns the mapped row names. */
const sameOwner = (db: Db, table: string, found: Row, given: Row): boolean =>
  given.writer !== undefined && ownerColumns(db, table).every((col) => found[col] === bind(given[col]));

/** The place whose writer holds a row: a place's row, a line or a cache of a place, a place's prose; else null. */
function placeOfRow(row: Row): string | null {
  if (isPlaceWriter(row.writer)) return placeOfHolder(row);
  if (typeof row.holder_id !== 'string') return null;
  if (row.writer === 'versions') return placeOfVersions(row.holder_id);
  if (row.writer === 'record' || row.writer === 'journal' || row.writer === 'archive' || row.writer === 'media')
    return row.holder_id === PERSONA_ID ? null : row.holder_id;
  return null;
}

/** The owner columns of a mapped row, for the list of the places that share a row. */
const ownerOf = (row: Row): { writer: string; holder_id: string | null } => ({
  writer: asText(row.writer),
  holder_id: typeof row.holder_id === 'string' ? row.holder_id : null,
});

/**
 * Whether a write leaves the found row of `given` alone: a row the database wrote (no owner) stays as it is, and a live
 * row another place's writer holds is shared (listed in `co_owners`, not rewritten).
 */
function leavesAlone(db: Db, table: string, found: Row, given: Row, mine: boolean): boolean {
  if (!isOwned(found) && !observedRow(table, found, given)) return true;
  if (mine || found.retired_at !== null) return false;
  const theirs = placeOfRow(found);
  const ours = placeOfRow(given);
  if (theirs === null || ours === null || theirs === ours) return false;
  sharePlaceRow(db, table, keyOf(table, given), ownerOf(given));
  return true;
}

/**
 * Writes one mapped row, keeping the ownership rules (`leavesAlone`); anything else is upserted. A row a place's writer
 * held that a row with no writer columns takes loses them. Returns true when the row is now this writer's to write
 * (false: skipped).
 */
function writeRow(db: Db, table: string, given: Row, opts: { ignore?: boolean; at?: string }): boolean {
  const found = existingOf(db, table, given);
  const mine = found !== undefined && sameOwner(db, table, found, given);
  if (found && leavesAlone(db, table, found, given, mine)) return false;
  const row =
    found && isPlaceWriter(found.writer) && !Object.hasOwn(given, 'writer')
      ? { ...given, writer: null, holder_id: null }
      : given;
  // The v7 derived columns (audience, authority, native key, ...) come from the row itself, so a remap re-derives them.
  const derived = deriveRow(db, table, row);
  upsert(db, table, derived, opts);
  if (table === 'people' || table === 'accounts' || table === 'places')
    ensureNodeKeys(db, table, derived, { at: opts.at });
  // Schema v8: a line's `reply_to` is a `replies_to` relation, and relations waiting for this line are resolved. Schema
  // v9: the row is projected (ensureRelations projects a source with its relations).
  if (table === 'sources') ensureRelations(db, derived, { at: opts.at });
  else projectRow(db, table, derived, { at: opts.at });
  if (table === 'selfreflection') restrictSelfreflectionMedia(db, derived, opts.at);
  if (found && !mine && row.writer !== undefined && row.writer !== null)
    unsharePlaceRow(db, table, keyOf(table, row), ownerOf(row));
  return true;
}

/** Writes the child links of a mapping: a link that is already there is updated and un-retired, a new one is inserted. */
function writeChildren(
  db: Db,
  mapping: Rows,
  skippedParents: ReadonlySet<string>,
  touched: Array<[string, Row]>
): number {
  // A link that names no writer is the database's or her session's (`isOwned`); a place's links name theirs in columns.
  let count = 0;
  for (const [child, [parent, link]] of Object.entries(CHILDREN)) {
    const unowned = columnsOf(db, child).has('writer') ? 'writer IS NULL' : '1';
    for (const row of mapping[child] ?? []) {
      if (skippedParents.has(`${parent}\u0000${asText(row[link])}`)) continue;
      const out: Row = { ...row, retired_at: null };
      const cols = Object.keys(out);
      const where =
        child === 'selfreflection_mirrors'
          ? "selfreflection_id = ? AND iface = ? AND coalesce(place_id, '') = ?"
          : `${quote(link)} = ? AND position = ?`;
      const args =
        child === 'selfreflection_mirrors'
          ? [row.selfreflection_id, row.iface, row.place_id ?? '']
          : [row[link], bind(row.position)];
      const found = prepared(
        db,
        `SELECT rowid, * FROM ${quote(child)} WHERE ${where} ORDER BY ${unowned} DESC, rowid LIMIT 1`
      ).get(...args);
      if (found && !isOwned(found)) continue;
      // A link that already holds every value is left as it is: rewriting it costs a page write and changes nothing.
      const same = found !== undefined && cols.every((col) => found[col] === bind(out[col]));
      if (found && !same) {
        prepared(
          db,
          `UPDATE ${quote(child)} SET ${cols.map((col) => `${quote(col)} = ?`).join(', ')} WHERE rowid = ?`
        ).run(...cols.map((col) => bind(out[col])), found.rowid);
      } else if (!found) {
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

/** Writes a mapping (table -> rows) whose rows name their owner in their owner columns. */
export function writeMapping(
  db: Db,
  mapping: Rows,
  { ignoreClaims = false, at }: { ignoreClaims?: boolean; at?: string } = {}
): number {
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
  syncPersonAccounts(db, mapping.accounts, at);
  const touched: Array<[string, Row]> = [];
  count += writeChildren(db, mapping, skippedParents, touched);
  // Schema v10: a mirror's publication follows the mirror (publish.ts#deriveMirrorPublication), on this one path.
  for (const [child, row] of touched) {
    if (child === 'selfreflection_mirrors') deriveMirrorPublication(db, row, { at });
    projectRow(db, child, row, { at });
  }
  return count;
}

/** The ids of the hot claims and episodes (what an archive entry must not stub over, archive-lines.ts). */
export function hotClaimIds(db: Db): Set<string> {
  const ids = new Set<string>();
  for (const row of db
    .prepare("SELECT id FROM claims WHERE retired_at IS NULL AND (writer IS NULL OR writer != 'archive')")
    .all())
    ids.add(row.id as string);
  for (const row of db.prepare('SELECT id FROM episodes WHERE retired_at IS NULL').all()) ids.add(row.id as string);
  return ids;
}

/** The families of protocol message ids, by message id: several when chats of an interface reuse an id. */
function familiesOf(db: Db, messageIds: ReadonlyArray<string>): Map<string, Array<Row>> {
  const out = new Map<string, Array<Row>>();
  if (messageIds.length === 0 || !hasMessageFamilies(db)) return out;
  // The catalog's key starts at the interface and a chunk key names none, so one scan answers the whole batch.
  const rows = prepared(
    db,
    'SELECT * FROM message_families WHERE generation = 1 AND message_id IN (SELECT value FROM json_each(?))'
  ).all(JSON.stringify(messageIds));
  for (const row of rows) {
    const id = asText(row.message_id);
    out.set(id, [...(out.get(id) ?? []), row]);
  }
  return out;
}

/** The one family a vector row's message belongs to: narrowed by its channel and interface, none when still ambiguous. */
function familyOfVector(row: Row, families: ReadonlyArray<Row>): Row | undefined {
  if (families.length <= 1) return families[0];
  const channel = parseExtra(row.context).placeId;
  const narrowed = families.filter(
    (family) =>
      (channel === undefined || channel === null || family.conversation_id === channel) &&
      (row.scope_iface === undefined || row.scope_iface === null || family.iface === row.scope_iface)
  );
  return narrowed.length === 1 ? narrowed[0] : undefined;
}

const CHUNK_KEY = /^(?:private:[^:]+:)?record:(.+):([^:]*?)(?:#\d+)?$/;

/**
 * Sets each vector row's `source_rowid` from its chunk key, `record:<message id>:<revision>`. An observed line holds its
 * family's key in `native_id`, so the message id goes through `message_families`; a line with no family holds the id
 * itself.
 */
export function linkVectors(db: Db, rows: ReadonlyArray<Row>): void {
  const keys = rows.map((row) => CHUNK_KEY.exec(String(row.chunk_key)));
  const families = familiesOf(db, [...new Set(keys.flatMap((match) => (match && match[2] !== '' ? [match[1]] : [])))]);
  rows.forEach((row, index) => {
    const match = keys[index];
    if (!match || match[2] === '') return;
    const revision = Number(match[2]);
    const family = familyOfVector(row, families.get(match[1]) ?? []);
    const found = family
      ? prepared(
          db,
          `SELECT rowid FROM sources WHERE authority_id = ? AND native_kind = ? AND native_id = ? AND generation = ?
           AND revision = ? AND kind IN ('seen', 'said') AND retired_at IS NULL ORDER BY kind LIMIT 1`
        ).get(family.authority_id, family.native_kind, family.native_key, family.generation, revision)
      : undefined;
    const direct =
      found ??
      prepared(
        db,
        "SELECT rowid FROM sources WHERE native_id = ? AND revision = ? AND kind IN ('seen', 'said') ORDER BY kind LIMIT 1"
      ).get(match[1], revision);
    if (direct) row.source_rowid = direct.rowid;
  });
}
