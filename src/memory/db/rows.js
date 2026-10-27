// Rows between the mappers and SQLite. A mapping is `{ table: [row, ...] }`, a row is column -> value. These functions
// write a mapping with one parameterised statement per row (a column the schema lacks fails loudly) and read the
// rows of the named tables back as plain objects, so a mapper's output can go through the real schema.
//
// Schema v7 (spec 2026-10-24-memory-schema-v7, sections 1, 2 and 11): every writer fills the derived columns from the
// row itself through `deriveRow` (the sync's upsert, `insertRows`, the database's own writers in session-write.js and
// diary-media.js), so a remap of a file re-derives them instead of nulling them:
//   - a row of a table with the scope triple gets `audience_id` from scope.ts#audienceOf (the one resolver); the
//     audience row, its interface and, for a DM, the DM place of the partner are created when missing. A given
//     `audience_id` that is not the triple's audience is a conflict: the row is quarantined to internal and logged;
//   - an account gets its authority and native key, a place its authority, native key and conversation, a source its
//     authority, author kind and `observed_at`;
//   - `ensureNodeKeys` registers a person, account or place in `external_keys` (its native authority and the legacy
//     spelling), and `ensureLinks` gives an account with a person its `account_person_links` row once: a missing one
//     is inserted, an existing one is never rewritten (the links are the database's own, no file owns them).
// Schema v8 (stage 2): a row that names its own authority (an observation, observe.js) keeps it, its native key and
// its conversation instead of the legacy derivation; a source's author combination is checked (`checkAuthor`: an
// account line names no participant, a participant line names no account); `ensureRelations` gives a source its
// `source_relations` rows (a legacy line's `reply_to`, derived here so a remap keeps it) and resolves the relations
// that were waiting for it. Relations are the database's own: inserted once, a target filled in once, never rewritten.
// Schema v9 (stage 3): every row these functions write is projected into the graph in the same transaction
// (graph.js#projectRow: the row's unit, again from the database as it is now): `insertRows`, the DM place, the interface
// and authority rows, the links `ensureLinks` adds, and the sources whose relations `ensureRelations` and
// `resolveRelationsTo` wrote or resolved.
// Schema v10 (stages 4 and 5): a diary mirror written through `insertRows` derives its publication
// (publish.js#deriveMirrorPublication, the function the sync calls for every mirror write), and a line of hers that is
// stored after the mirror that names it projects that publication again (its `publication_source` edge).
// Every function checks the schema it runs on: on a database before v7 it derives nothing, before v8 no relation, before
// v9 no projection, before v10 no publication.

import { log as engineLog } from '../../log.js';
import {
  CORE_AUTHORITY,
  LEGACY_AUTHORITY,
  dmPartnerOfPlace,
  externalTargetKey,
  guildAuthorityOf,
  legacyAccountNative,
  legacyNativeKind,
  legacyPersonNative,
  linkId,
  nativeAuthorityOf,
  placeNativeKey,
  SELF_PERSON,
  sourceTargetKey,
} from './ids.ts';
import { AUD_INTERNAL, SCOPE_INTERNAL, audienceOf, audienceParts } from './scope.ts';
import { SELF_SOURCE_KINDS } from './schema.js';
import { projectRow } from './graph.js';
import { deriveMirrorPublication, projectPublicationsNaming } from './publish.js';

const quote = (name) => `"${String(name).replace(/"/g, '""')}"`;
const bind = (value) => (value === undefined ? null : value);
const SELF_KINDS = new Set(SELF_SOURCE_KINDS);
const CONTAINERS = new Set(['guild', 'server', 'workspace', 'category']);

const columnCache = new WeakMap();
/** The columns a table has on this connection (an empty set for a table that does not exist). */
export function columnsOf(db, table) {
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

const hasV7 = (db) => columnsOf(db, 'audiences').size > 0;
const hasV8 = (db) => columnsOf(db, 'source_relations').size > 0;
const coded = (code) => Object.assign(new Error(`memory db: ${code}`), { code });

/** The interface row and its native authority, when missing. */
export function ensureInterface(db, iface) {
  if (!hasV7(db) || typeof iface !== 'string' || !iface) return;
  if (Number(prepared(db, 'INSERT OR IGNORE INTO interfaces (id) VALUES (?)').run(iface).changes) > 0)
    projectRow(db, 'interfaces', { id: iface });
  const authority = nativeAuthorityOf(iface);
  if (
    Number(
      prepared(db, 'INSERT OR IGNORE INTO authorities (id, iface, namespace) VALUES (?, ?, ?)').run(
        authority,
        iface,
        authority.slice(iface.length + 1)
      ).changes
    ) > 0
  ) {
    projectRow(db, 'authorities', { id: authority });
  }
}

/** An authority row (and its interface), when missing. */
export function ensureAuthority(db, authority, iface, namespace) {
  ensureInterface(db, iface);
  if (
    Number(
      prepared(db, 'INSERT OR IGNORE INTO authorities (id, iface, namespace) VALUES (?, ?, ?)').run(
        authority,
        iface,
        namespace
      ).changes
    ) > 0
  ) {
    projectRow(db, 'authorities', { id: authority });
  }
}

/** The time a derived row is recorded at: the writer's (`at`, an ISO time), else the clock of this moment. */
const stampOf = (at) => (typeof at === 'string' && at ? at : new Date().toISOString());

export function addKey(db, authority, kind, nativeKey, nodeId, { generation = 1, at } = {}) {
  if (nativeKey === null || nativeKey === undefined || nativeKey === '') return;
  prepared(
    db,
    `INSERT OR IGNORE INTO external_keys (authority_id, object_kind, native_key, generation, node_id, recorded_at) VALUES (?, ?, ?, ?, ?, ?)`
  ).run(authority, kind, String(nativeKey), generation, nodeId, stampOf(at));
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
  prepared(
    db,
    `INSERT INTO places (id, iface, kind, native_id, parent_id, scope_kind, authority_id, native_key, generation, conversation, partner_person, partner_account)
    VALUES (?, ?, 'dm', NULL, NULL, 'dm', ?, ?, 1, 'dm', ?, ?)`
  ).run(placeId, iface, cols.authority_id, cols.native_key, person ?? null, account);
  addKey(db, cols.authority_id, 'place', cols.native_key, placeId, { at });
  addKey(db, LEGACY_AUTHORITY, 'place', placeId, placeId, { at });
  projectRow(db, 'places', { id: placeId }, { at });
}

/** The audience row of a resolved scope (and its interface, and the DM place), when missing. */
export function ensureAudience(db, resolved, { at } = {}) {
  if (!hasV7(db)) return;
  const parts = audienceParts(resolved.audience_id);
  if (!parts || parts.kind === 'none' || parts.kind === 'internal') {
    prepared(db, 'INSERT OR IGNORE INTO audiences (id, kind) VALUES (?, ?)').run(
      parts ? parts.id : AUD_INTERNAL,
      parts ? parts.kind : 'internal'
    );
    return;
  }
  const iface = parts.kind === 'group' ? parts.iface : resolved.scope_iface;
  ensureInterface(db, iface);
  if (parts.kind === 'group') {
    prepared(db, "INSERT OR IGNORE INTO audiences (id, kind, iface) VALUES (?, 'group', ?)").run(parts.id, iface);
    return;
  }
  ensureDmPlace(db, parts.place_id, iface, resolved.scope_dm, { at });
  prepared(db, "INSERT OR IGNORE INTO audiences (id, kind, iface, place_id) VALUES (?, 'dm', ?, ?)").run(
    parts.id,
    iface,
    parts.place_id
  );
}

/**
 * The resolved scope of a row: the triple and its audience. A given `audience_id` is kept when it is the triple's own,
 * or a DM audience whose place names the same partner on the same interface (a writer that knows the DM place);
 * anything else is a conflict (`conflict: true`).
 */
export function resolveRow(db, row) {
  const scope = {
    scope_kind: row.scope_kind ?? null,
    scope_iface: row.scope_iface ?? null,
    scope_dm: row.scope_dm ?? null,
  };
  const given = row.audience_id ?? null;
  const parts = given ? audienceParts(given) : null;
  let dmPlace = null;
  if (parts?.kind === 'dm' && scope.scope_kind === 'dm' && hasV7(db)) {
    const place = prepared(db, 'SELECT iface, partner_person, conversation FROM places WHERE id = ?').get(
      parts.place_id
    );
    // A DM place with no known partner person (an observed DM) matches a triple with none (schema v8).
    if (
      place &&
      place.conversation === 'dm' &&
      place.iface === scope.scope_iface &&
      (place.partner_person ?? null) === (scope.scope_dm ?? null)
    )
      dmPlace = parts.place_id;
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
  // A row that names its own authority (an observation) keeps it, with its native key and conversation.
  const own = typeof row.authority_id === 'string' && row.authority_id !== '';
  if (table === 'accounts' && have.has('authority_id') && Object.hasOwn(out, 'id')) {
    ensureInterface(db, out.iface);
    if (!own) {
      out.authority_id = nativeAuthorityOf(out.iface);
      out.native_key = out.native_id ?? legacyAccountNative(out.id, out.iface);
    }
  } else if (table === 'places' && have.has('authority_id') && Object.hasOwn(out, 'id') && own) {
    ensureInterface(db, out.iface);
  } else if (table === 'places' && have.has('authority_id') && Object.hasOwn(out, 'id')) {
    ensureInterface(db, out.iface);
    Object.assign(out, placeColumns(out));
    if (
      out.kind === 'guild' &&
      typeof out.iface === 'string' &&
      out.iface &&
      out.native_id !== null &&
      out.native_id !== undefined
    ) {
      ensureAuthority(db, guildAuthorityOf(out.native_id, out.iface), out.iface, `guild:${out.native_id}`);
    }
  } else if (table === 'sources' && have.has('authority_id')) {
    if (Object.hasOwn(out, 'iface') && !own) out.authority_id = nativeAuthorityOf(out.iface);
    if (Object.hasOwn(out, 'kind') && !Object.hasOwn(row, 'author_kind')) {
      out.author_kind = SELF_KINDS.has(out.kind)
        ? 'self'
        : out.author_participant
          ? 'participant'
          : out.author_account
            ? 'account'
            : null;
    }
    if (Object.hasOwn(out, 'recorded_at')) out.observed_at = out.observed_at ?? out.recorded_at ?? null;
    if (have.has('native_kind') && Object.hasOwn(out, 'iface') && !Object.hasOwn(row, 'native_kind')) {
      out.native_kind = out.native_id === null || out.native_id === undefined ? null : legacyNativeKind(out.iface);
    }
    if (have.has('author_participant')) checkAuthor(out);
  }
  return out;
}

/**
 * The author combination of a source row (schema v8; the check SQLite cannot add to an existing table): an `account`
 * line names an account and no participant, a `participant` line a participant and no account, a `self` line (or one
 * with no author kind) no participant. Throws `AUTHOR_COMBINATION`.
 */
export function checkAuthor(row) {
  const kind = row.author_kind ?? null;
  const participant = row.author_participant ?? null;
  const account = row.author_account ?? null;
  const ok =
    kind === 'participant'
      ? participant !== null && account === null
      : kind === 'account'
        ? participant === null && account !== null
        : participant === null;
  if (!ok) throw coded('AUTHOR_COMBINATION');
}

/** The stored source a native tuple names (a revision not named: its first stored revision), or null. */
export function findSourceByTuple(db, { authority, kind, key, generation = 1, revision = null }) {
  if (!hasV8(db)) return null;
  const row = prepared(
    db,
    `SELECT id FROM sources WHERE authority_id = ? AND native_kind = ? AND native_id = ? AND generation = ?
    AND (? IS NULL OR revision = ?) AND kind IN ('seen', 'said') AND retired_at IS NULL ORDER BY revision, rowid LIMIT 1`
  ).get(
    String(authority),
    String(kind),
    String(key),
    Number.isInteger(generation) ? generation : 1,
    bind(revision),
    bind(revision)
  );
  return row?.id ?? null;
}

/**
 * One relation of a source, when missing: `target` is `{ source }` (our id) or a native tuple `{ authority, kind, key,
 * generation?, revision? }`. Its key never changes; the target is filled in when it is a stored source (now or later,
 * `resolveRelationsTo`). Returns 1 when a row was inserted.
 */
export function addRelation(db, sourceId, predicate, target, { at } = {}) {
  const stamp = stampOf(at);
  let key;
  let found = null;
  if (typeof target?.source === 'string' && target.source) {
    key = sourceTargetKey(target.source);
    found = prepared(db, 'SELECT id FROM sources WHERE id = ?').get(target.source)?.id ?? null;
  } else {
    key = externalTargetKey(target);
    found = findSourceByTuple(db, target);
  }
  const done = prepared(
    db,
    `INSERT OR IGNORE INTO source_relations (source_id, predicate, target_key, target_source_id, recorded_at, resolved_at)
    VALUES (?, ?, ?, ?, ?, ?)`
  ).run(sourceId, predicate, key, found, stamp, found ? stamp : null);
  if (Number(done.changes) === 0 && found) {
    prepared(
      db,
      'UPDATE source_relations SET target_source_id = ?, resolved_at = ? WHERE source_id = ? AND predicate = ? AND target_key = ? AND target_source_id IS NULL'
    ).run(found, stamp, sourceId, predicate, key);
  }
  return Number(done.changes);
}

/** Fills in the target of every relation still waiting for this source (by our id and by its native tuple). */
export function resolveRelationsTo(db, row, { at } = {}) {
  if (!hasV8(db) || typeof row?.id !== 'string') return 0;
  const keys = [sourceTargetKey(row.id)];
  if (
    (row.kind === 'seen' || row.kind === 'said') &&
    row.retired_at == null &&
    row.authority_id &&
    row.native_kind &&
    row.native_id !== null &&
    row.native_id !== undefined
  ) {
    const tuple = {
      authority: row.authority_id,
      kind: row.native_kind,
      key: row.native_id,
      generation: Number.isInteger(row.generation) ? row.generation : 1,
    };
    keys.push(externalTargetKey(tuple));
    if (Number.isInteger(row.revision)) keys.push(externalTargetKey({ ...tuple, revision: row.revision }));
  }
  const stamp = stampOf(at);
  let count = 0;
  const waiting = new Set();
  for (const key of keys) {
    const done = prepared(
      db,
      'UPDATE source_relations SET target_source_id = ?, resolved_at = ? WHERE target_key = ? AND target_source_id IS NULL RETURNING source_id'
    ).all(row.id, stamp, key);
    count += done.length;
    for (const relation of done) waiting.add(relation.source_id);
  }
  // The lines whose relations now have a target project their new edges.
  for (const source of waiting) projectRow(db, 'sources', { id: source }, { at });
  return count;
}

/**
 * The relations a written source row derives (schema v8): a legacy line's `reply_to` (the native message it answers,
 * on the line's own authority) is a `replies_to` relation; then every relation waiting for this source is resolved.
 */
export function ensureRelations(db, row, { at } = {}) {
  if (!hasV8(db) || typeof row?.id !== 'string' || !row.id) return;
  const kind = legacyNativeKind(row.iface);
  if (kind && typeof row.reply_to === 'string' && row.reply_to !== '' && row.authority_id) {
    addRelation(
      db,
      row.id,
      'replies_to',
      { authority: row.authority_id, kind, key: row.reply_to, generation: 1, revision: null },
      { at }
    );
  }
  resolveRelationsTo(db, row, { at });
  projectRow(db, 'sources', { id: row.id }, { at });
  projectPublicationsNaming(db, row, { at });
}

/**
 * Registers a person, account or place row in `external_keys`: under its native authority and its legacy spelling
 * (`legacy: false`: a node made from an observation has no legacy spelling, only its native key).
 */
export function ensureNodeKeys(db, table, row, { at, legacy = true } = {}) {
  if (!hasV7(db) || typeof row?.id !== 'string' || !row.id) return;
  if (table === 'people') {
    if (row.id === SELF_PERSON) {
      addKey(db, CORE_AUTHORITY, 'person', 'self', row.id, { at });
      return;
    }
    const native = legacyPersonNative(row.id);
    if (native) {
      ensureInterface(db, native.iface);
      addKey(db, nativeAuthorityOf(native.iface), 'person', native.native, row.id, { at });
    }
    addKey(db, LEGACY_AUTHORITY, 'person', row.id, row.id, { at });
  } else if (table === 'accounts' || table === 'places') {
    const kind = table === 'accounts' ? 'account' : 'place';
    const legacyDerived =
      table === 'accounts'
        ? {
            authority_id: nativeAuthorityOf(row.iface),
            native_key: row.native_key ?? row.native_id ?? legacyAccountNative(row.id, row.iface),
          }
        : placeColumns(row);
    const derived = legacy ? legacyDerived : { authority_id: row.authority_id, native_key: row.native_key };
    addKey(db, derived.authority_id, kind, derived.native_key, row.id, {
      generation: Number.isInteger(row.generation) ? row.generation : 1,
      at,
    });
    if (legacy) addKey(db, LEGACY_AUTHORITY, kind, row.id, row.id, { at });
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
    const done = prepared(
      db,
      `INSERT OR IGNORE INTO account_person_links (id, account_id, person_id, state, by, reason, evidence_id, valid_from_at, valid_to_at, recorded_at)
      VALUES (?, ?, ?, ?, ?, NULL, NULL, ?, NULL, ?)`
    ).run(
      linkId(row.id, row.person_id),
      row.id,
      row.person_id,
      row.link === 'verified' ? 'verified' : 'proposed',
      by,
      bind(row.linked_at),
      stampOf(at)
    );
    count += Number(done.changes);
    if (Number(done.changes) > 0) projectRow(db, 'account_person_links', { account_id: row.id }, { at });
  }
  return count;
}

/** Inserts (or replaces, by primary key) every row of a mapping, with the v7 derived columns filled from each row. */
// Tests only: REPLACE does not fire the FTS delete trigger without recursive_triggers, so no live writer may use it for sources.
export function insertRows(db, mapping, { log = engineLog, at } = {}) {
  for (const [table, rows] of Object.entries(mapping)) {
    for (const given of rows) {
      const row = deriveRow(db, table, given, { log, at });
      const cols = Object.keys(row);
      const sql = `INSERT OR REPLACE INTO ${quote(table)} (${cols.map(quote).join(', ')}) VALUES (${cols.map(() => '?').join(', ')})`;
      db.prepare(sql).run(...cols.map((col) => bind(row[col])));
      if (table === 'people' || table === 'accounts' || table === 'places') ensureNodeKeys(db, table, row, { at });
      if (table === 'sources') ensureRelations(db, row, { at });
      else if (table === 'diary_mirrors') deriveMirrorPublication(db, row, { at });
      else projectRow(db, table, row, { at });
    }
  }
  ensureLinks(db, mapping.accounts, { at });
}

/** Every row of each named table as a plain object, in rowid order. */
export function readRows(db, tables) {
  const out = {};
  for (const table of tables) {
    out[table] = db
      .prepare(`SELECT * FROM ${quote(table)} ORDER BY rowid`)
      .all()
      .map((row) => ({ ...row }));
  }
  return out;
}
