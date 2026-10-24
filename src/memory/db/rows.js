// Rows between the mappers and SQLite. A mapping is `{ table: [row, ...] }`, a row is column -> value. These helpers
// write a mapping with one parameterised statement per row (a column the schema lacks fails loudly) and read the
// rows of the named tables back as plain objects, so a mapper's output can go through the real schema.
//
// Schema v7 (spec 2026-10-24-memory-schema-v7, sections 1, 2 and 11): every writer fills the derived columns from the
// row itself through `deriveRow` (the sync's upsert, `insertRows`, the database's own writers in session-write.js and
// diary-media.js), so a remap of a file re-derives them instead of nulling them:
//   - a row of a table with the scope triple gets `audience_id` from scope.js#audienceOf (the one resolver); the
//     audience row, its interface and, for a DM, the DM place of the partner are created when missing. A given
//     `audience_id` that is not the triple's audience is a conflict: the row is quarantined to internal and logged;
//   - an account gets its authority and native key, a place its authority, native key and conversation, a source its
//     authority, author kind and `observed_at`;
//   - `ensureNodeKeys` registers a person, account or place in `external_keys` (its native authority and the legacy
//     spelling), and `ensureLinks` gives an account with a person its `account_person_links` row once: a missing one
//     is inserted, an existing one is never rewritten (the links are the database's own, no file owns them).
// Every helper checks the schema it runs on: on a database before v7 it derives nothing.

import { log as engineLog } from '../../log.js';
import {
  CORE_AUTHORITY, LEGACY_AUTHORITY, dmPartnerOfPlace, guildAuthorityOf, legacyAccountNative, legacyPersonNative, linkId, nativeAuthorityOf,
  placeNativeKey, SELF_PERSON,
} from './ids.js';
import { AUD_INTERNAL, SCOPE_INTERNAL, audienceOf, audienceParts } from './scope.js';
import { SELF_SOURCE_KINDS } from './schema.js';

const quote = (name) => `"${String(name).replace(/"/g, '""')}"`;
const bind = (value) => (value === undefined ? null : value);
const SELF_KINDS = new Set(SELF_SOURCE_KINDS);
const CONTAINERS = new Set(['guild', 'server', 'workspace', 'category']);

const columnCache = new WeakMap();
/** The columns a table has on this connection (an empty set for a table that does not exist). */
export function columnsOf(db, table) {
  let tables = columnCache.get(db);
  if (!tables) columnCache.set(db, (tables = new Map()));
  if (!tables.has(table)) tables.set(table, new Set(db.prepare(`PRAGMA table_info(${quote(table)})`).all().map((c) => c.name)));
  return tables.get(table);
}

const statementCache = new WeakMap();
function prepared(db, sql) {
  let map = statementCache.get(db);
  if (!map) statementCache.set(db, (map = new Map()));
  if (!map.has(sql)) map.set(sql, db.prepare(sql));
  return map.get(sql);
}

const hasV7 = (db) => columnsOf(db, 'audiences').size > 0;

/** The interface row and its native authority, when missing. */
export function ensureInterface(db, iface) {
  if (!hasV7(db) || typeof iface !== 'string' || !iface) return;
  prepared(db, 'INSERT OR IGNORE INTO interfaces (id) VALUES (?)').run(iface);
  const authority = nativeAuthorityOf(iface);
  prepared(db, 'INSERT OR IGNORE INTO authorities (id, iface, namespace) VALUES (?, ?, ?)').run(authority, iface, authority.slice(iface.length + 1));
}

function ensureAuthority(db, authority, iface, namespace) {
  ensureInterface(db, iface);
  prepared(db, 'INSERT OR IGNORE INTO authorities (id, iface, namespace) VALUES (?, ?, ?)').run(authority, iface, namespace);
}

/** The time a derived row is recorded at: the writer's (`at`, an ISO time), else the clock of this moment. */
const stampOf = (at) => (typeof at === 'string' && at ? at : new Date().toISOString());

function addKey(db, authority, kind, nativeKey, nodeId, { generation = 1, at } = {}) {
  if (nativeKey === null || nativeKey === undefined || nativeKey === '') return;
  prepared(db, `INSERT OR IGNORE INTO external_keys (authority_id, object_kind, native_key, generation, node_id, recorded_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .run(authority, kind, String(nativeKey), generation, nodeId, stampOf(at));
}

/** The derived columns of a place row: authority, native key, conversation. */
function placeColumns(row) {
  const kind = row.kind ?? null;
  const conversation = kind === 'dm' || row.scope_kind === 'dm' ? 'dm' : CONTAINERS.has(kind) ? null : 'group';
  return { authority_id: nativeAuthorityOf(row.iface), native_key: placeNativeKey(row), conversation };
}

/**
 * The DM place of a partner, created when missing (`<iface>:dm:<native>`, kind and conversation `dm`, partner from the
 * scope), with its keys. A place the database writes has no `owner_file`: no file remap touches it.
 */
export function ensureDmPlace(db, placeId, iface, person, { at } = {}) {
  if (!hasV7(db)) return;
  if (prepared(db, 'SELECT 1 AS ok FROM places WHERE id = ?').get(placeId)) return;
  ensureInterface(db, iface);
  const partner = dmPartnerOfPlace(placeId);
  const account = partner && partner.iface === iface ? partner.account : null;
  const row = { id: placeId, iface, kind: 'dm', native_id: null, scope_kind: 'dm' };
  const cols = placeColumns(row);
  prepared(db, `INSERT INTO places (id, iface, kind, native_id, parent_id, scope_kind, authority_id, native_key, generation, conversation, partner_person, partner_account)
    VALUES (?, ?, 'dm', NULL, NULL, 'dm', ?, ?, 1, 'dm', ?, ?)`).run(placeId, iface, cols.authority_id, cols.native_key, person ?? null, account);
  addKey(db, cols.authority_id, 'place', cols.native_key, placeId, { at });
  addKey(db, LEGACY_AUTHORITY, 'place', placeId, placeId, { at });
}

/** The audience row of a resolved scope (and its interface, and the DM place), when missing. */
export function ensureAudience(db, resolved, { at } = {}) {
  if (!hasV7(db)) return;
  const parts = audienceParts(resolved.audience_id);
  if (!parts || parts.kind === 'none' || parts.kind === 'internal') {
    prepared(db, 'INSERT OR IGNORE INTO audiences (id, kind) VALUES (?, ?)').run(parts ? parts.id : AUD_INTERNAL, parts ? parts.kind : 'internal');
    return;
  }
  const iface = parts.kind === 'group' ? parts.iface : resolved.scope_iface;
  ensureInterface(db, iface);
  if (parts.kind === 'group') {
    prepared(db, "INSERT OR IGNORE INTO audiences (id, kind, iface) VALUES (?, 'group', ?)").run(parts.id, iface);
    return;
  }
  ensureDmPlace(db, parts.place_id, iface, resolved.scope_dm, { at });
  prepared(db, "INSERT OR IGNORE INTO audiences (id, kind, iface, place_id) VALUES (?, 'dm', ?, ?)").run(parts.id, iface, parts.place_id);
}

/**
 * The resolved scope of a row: the triple and its audience. A given `audience_id` is kept when it is the triple's own,
 * or a DM audience whose place names the same partner on the same interface (a writer that knows the DM place);
 * anything else is a conflict (`conflict: true`).
 */
export function resolveRow(db, row) {
  const scope = { scope_kind: row.scope_kind ?? null, scope_iface: row.scope_iface ?? null, scope_dm: row.scope_dm ?? null };
  const given = row.audience_id ?? null;
  const parts = given ? audienceParts(given) : null;
  let dmPlace = null;
  if (parts?.kind === 'dm' && scope.scope_kind === 'dm' && hasV7(db)) {
    const place = prepared(db, 'SELECT iface, partner_person FROM places WHERE id = ?').get(parts.place_id);
    if (place && place.iface === scope.scope_iface && place.partner_person === scope.scope_dm) dmPlace = parts.place_id;
  }
  const resolved = audienceOf(scope, { dmPlace });
  return { ...resolved, conflict: given !== null && given !== resolved.audience_id };
}

/**
 * A row with its v7 derived columns filled from its own columns (a copy; the input is not changed). Only the columns
 * the table has are touched, so the same code runs on a database before v7.
 */
export function deriveRow(db, table, row, { log = engineLog, at } = {}) {
  const have = columnsOf(db, table);
  if (!have.has('audience_id') && !have.has('authority_id')) return row;
  const out = { ...row };
  if (have.has('audience_id') && (Object.hasOwn(out, 'scope_kind') || Object.hasOwn(out, 'audience_id'))) {
    const resolved = resolveRow(db, out);
    if (resolved.conflict) {
      log.warn?.('memory db: audience conflict, row quarantined to internal', { table, code: 'AUDIENCE_CONFLICT' });
      Object.assign(out, SCOPE_INTERNAL, { audience_id: AUD_INTERNAL });
      ensureAudience(db, { ...SCOPE_INTERNAL, audience_id: AUD_INTERNAL });
    } else {
      out.audience_id = resolved.audience_id;
      ensureAudience(db, resolved, { at });
    }
  }
  if (table === 'accounts' && have.has('authority_id') && Object.hasOwn(out, 'id')) {
    ensureInterface(db, out.iface);
    out.authority_id = nativeAuthorityOf(out.iface);
    out.native_key = out.native_id ?? legacyAccountNative(out.id, out.iface);
  } else if (table === 'places' && have.has('authority_id') && Object.hasOwn(out, 'id')) {
    ensureInterface(db, out.iface);
    Object.assign(out, placeColumns(out));
    if (out.kind === 'guild' && typeof out.iface === 'string' && out.iface && out.native_id !== null && out.native_id !== undefined) {
      ensureAuthority(db, guildAuthorityOf(out.native_id, out.iface), out.iface, `guild:${out.native_id}`);
    }
  } else if (table === 'sources' && have.has('authority_id')) {
    if (Object.hasOwn(out, 'iface')) out.authority_id = nativeAuthorityOf(out.iface);
    if (Object.hasOwn(out, 'kind')) out.author_kind = SELF_KINDS.has(out.kind) ? 'self' : out.author_account ? 'account' : null;
    if (Object.hasOwn(out, 'recorded_at')) out.observed_at = out.observed_at ?? out.recorded_at ?? null;
  }
  return out;
}

/** Registers a person, account or place row in `external_keys`: under its native authority and its legacy spelling. */
export function ensureNodeKeys(db, table, row, { at } = {}) {
  if (!hasV7(db) || typeof row?.id !== 'string' || !row.id) return;
  if (table === 'people') {
    if (row.id === SELF_PERSON) { addKey(db, CORE_AUTHORITY, 'person', 'self', row.id, { at }); return; }
    const native = legacyPersonNative(row.id);
    if (native) {
      ensureInterface(db, native.iface);
      addKey(db, nativeAuthorityOf(native.iface), 'person', native.native, row.id, { at });
    }
    addKey(db, LEGACY_AUTHORITY, 'person', row.id, row.id, { at });
  } else if (table === 'accounts' || table === 'places') {
    const kind = table === 'accounts' ? 'account' : 'place';
    const derived = table === 'accounts' ? { authority_id: nativeAuthorityOf(row.iface), native_key: row.native_key ?? row.native_id ?? legacyAccountNative(row.id, row.iface) } : placeColumns(row);
    addKey(db, derived.authority_id, kind, derived.native_key, row.id, { generation: Number.isInteger(row.generation) ? row.generation : 1, at });
    addKey(db, LEGACY_AUTHORITY, kind, row.id, row.id, { at });
  }
}

/**
 * The link row of every account of `accounts` that names a person, when it has none: `verified` where the account's
 * `link` is `verified`, else `proposed`. An existing link is never rewritten; a pair whose account or person row is
 * missing waits for both.
 */
export function ensureLinks(db, accounts, { by = 'import', at } = {}) {
  if (!hasV7(db)) return 0;
  let count = 0;
  for (const row of accounts ?? []) {
    if (typeof row?.id !== 'string' || typeof row.person_id !== 'string' || !row.person_id) continue;
    if (!prepared(db, 'SELECT 1 AS ok FROM accounts WHERE id = ?').get(row.id)) continue;
    if (!prepared(db, 'SELECT 1 AS ok FROM people WHERE id = ?').get(row.person_id)) continue;
    const done = prepared(db, `INSERT OR IGNORE INTO account_person_links (id, account_id, person_id, state, by, reason, evidence_id, valid_from_at, valid_to_at, recorded_at)
      VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, NULL, ?)`).run(linkId(row.id, row.person_id), row.id, row.person_id, row.link === 'verified' ? 'verified' : 'proposed', by, bind(row.linked_at), stampOf(at));
    count += Number(done.changes);
  }
  return count;
}

/** Inserts (or replaces, by primary key) every row of a mapping, with the v7 derived columns filled from each row. */
export function insertRows(db, mapping, { log = engineLog, at } = {}) {
  for (const [table, rows] of Object.entries(mapping)) {
    for (const given of rows) {
      const row = deriveRow(db, table, given, { log, at });
      const cols = Object.keys(row);
      const sql = `INSERT OR REPLACE INTO ${quote(table)} (${cols.map(quote).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
      db.prepare(sql).run(...cols.map((col) => bind(row[col])));
      if (table === 'people' || table === 'accounts' || table === 'places') ensureNodeKeys(db, table, row, { at });
    }
  }
  ensureLinks(db, mapping.accounts, { at });
}

/** Every row of each named table as a plain object, in rowid order. */
export function readRows(db, tables) {
  const out = {};
  for (const table of tables) {
    out[table] = db.prepare(`SELECT * FROM ${quote(table)} ORDER BY rowid`).all().map((row) => ({ ...row }));
  }
  return out;
}
