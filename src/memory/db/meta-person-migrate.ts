// The offline migration to the meta-person (plan 2026-11-08-meta-person, slice 4), run by
// scripts/meta-person-migrate.ts with the core stopped, inside the caller's transaction. Every person becomes a
// meta-person (`people.meta` 1) and every account hangs under one in `person_accounts`:
//
//   - the command line's accounts are linked to the owner's person first (identity-links.ts#linkOwnerAccount), so the
//     owner ends as one meta-person with all his accounts;
//   - her own person `person:self` and a person whose id spells no interface are marked meta where they stand;
//   - a person whose id spells an interface (`person:<iface>:<native>`) gets a new `person:<uuid>`. The new row takes the
//     old row's columns, its profile unit included (`owner_key`), and the old row stays as a merged alias: `status`
//     `merged_into:<meta>` and one `people_merges` row, so `survivorOf` and the legacy key in `external_keys` still
//     lead an old id to its meta-person;
//   - every account with a verified person is linked to the meta-person that person ends in, a person merged before
//     included, and an account linked to nobody gets a meta-person of its own;
//   - every stored reference to an old person id is rewritten to its meta-person, in every text column of every table,
//     the ids built from a person id included (`alias:<person>:...`, `desc:<person>:...` and their versions, graph nodes,
//     edges, `node_access`, names). The survivors of earlier merges are rewritten first, the people merged into them
//     after, and a row whose new id is already taken is dropped, the first one's data winning. The daily relationship
//     counts of a merged person are added to the survivor's instead. An edge's id hashes its tuple (graph.ts#edgeIdOf),
//     so a rewritten edge gets the id of its new tuple and the witnesses in `node_access` follow it;
//   - `person_accounts` gets one row per account: its interface, platform id, generation, newest display name and
//     avatar. The handle and the profile text stay empty, since no older row holds them apart;
//   - `sources.author_person` names the meta-person of every line whose author account has one. A line with no account
//     (an anonymous participant) names none.
//
// Columns that keep an old id on purpose: the old `people` row's own id, the history of `account_person_links` and
// `people_merges`, the legacy alias key in `external_keys`, the storage catalog (its ids hash its keys), the session
// cursors (`meta.key`, `session_runs.scope_key` and `batch_key`, spelled from the place by session-scopes.ts#dmScopeKey),
// the request archive and the columns of words. No row changes its `audience_id`. A second run finds nothing to do and
// changes nothing. Counts and ids only; no message content.

import { edgeIdOf } from './graph.ts';
import { OWNER_CONSOLE_IFACE, linkOwnerAccount } from './identity-links.ts';
import { SELF_PERSON, legacyPersonNative, newPersonId, survivorOf } from './ids.ts';
import { moveRelationship } from './person-merge.ts';
import { linkAccount } from './person-links.ts';
import type { Db, Row } from './types.ts';

/** What the run needs: the owner's person as the live config names it, the time it writes and the uuid source. */
export type MetaPersonOptions = { ownerPerson: string | null; at: string; newId?: () => string };

/**
 * What the run did, as counts and ids. `changed`, `dropped` and `kept` are keyed by `table.column`: the rows rewritten,
 * the rows dropped because their new id was taken, and the rows an append-only guard keeps as they were written. The
 * daily relationship counts of a person merged before the run, added to its survivor's, count under their own key.
 */
export type MetaPersonReport = {
  persons: Record<string, string>;
  minted: number;
  promoted: number;
  linked: number;
  accounts: number;
  authorPerson: number;
  changed: Record<string, number>;
  dropped: Record<string, number>;
  kept: Record<string, number>;
  ownerPerson: { from: string; to: string } | null;
  counts: { before: Record<string, number>; after: Record<string, number> };
};

const REASON = 'meta-person migration';

/** SQLite's extended code for a trigger's `RAISE(ABORT)`: an append-only or immutable row refusing a change. */
const CONSTRAINT_TRIGGER = 1811;

type Tally = { changed: Record<string, number>; dropped: Record<string, number>; kept: Record<string, number> };

/**
 * Tables no rewrite touches: the request archive, the sealed semantic records (immutable by their triggers), the history
 * of links, the storage catalog and the schema versions.
 */
const KEPT_TABLES = new Set([
  'model_requests',
  'semantic_entity_kinds',
  'semantic_predicate_versions',
  'semantic_assertion_versions',
  'semantic_arguments',
  'semantic_dependencies',
  'account_person_links',
  'storage_units',
  'legacy_unit_aliases',
  'schema_version',
  'board_schema_version',
]);

/** Columns that keep an old id on purpose. */
const KEPT_COLUMNS = new Set([
  'people.id',
  'people_merges.id',
  'people_merges.from_person',
  'external_keys.native_key',
  'meta.key',
  'session_runs.scope_key',
  'session_runs.batch_key',
]);

/** Columns of words: what was said or written, never an id to rewrite. */
const WORD_COLUMNS = new Set([
  'text',
  'what',
  'reason',
  'body',
  'summary',
  'content',
  'draft',
  'label',
  'normalized',
  'stem',
  'display',
  'name',
  'topic',
]);

function coded(code: string): Error {
  return Object.assign(new Error(code), { code });
}

const quoted = (name: string): string => `"${name.replaceAll('"', '""')}"`;

/** The ordinary tables of the database: no virtual table and no table a full-text index keeps for itself. */
function tablesOf(db: Db): Array<string> {
  return db
    .prepare(
      `SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%'
       AND COALESCE(sql, '') NOT LIKE 'CREATE VIRTUAL%' ORDER BY name`
    )
    .all()
    .map((row) => String(row.name))
    .filter((name) => !/_(data|idx|docsize|config|content)$/.test(name));
}

/** The row count of every ordinary table. */
export function tableCounts(db: Db): Record<string, number> {
  const counts: Record<string, number> = {};
  for (const table of tablesOf(db))
    counts[table] = Number(db.prepare(`SELECT COUNT(*) AS n FROM ${quoted(table)}`).get()?.n ?? 0);
  return counts;
}

/** The columns of a table that may hold an id: declared as text, JSON or with no type. */
function idColumns(db: Db, table: string): Array<string> {
  return db
    .prepare(`PRAGMA table_info(${quoted(table)})`)
    .all()
    .filter((column) => !/INT|REAL|BLOB|NUM|FLOA|DOUB/i.test(String(column.type)))
    .map((column) => String(column.name))
    .filter((column) => !WORD_COLUMNS.has(column) && !KEPT_COLUMNS.has(`${table}.${column}`));
}

const escaped = (value: string): string => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

const add = (counts: Record<string, number>, key: string, by: number): void => {
  if (by > 0) counts[key] = (counts[key] ?? 0) + by;
};

/**
 * The ids the semantic layer sealed, which no rewrite may change: each sealed claim version and the claim it names.
 * A value that holds one keeps it, and only the rest of the value is rewritten.
 */
function sealedIds(db: Db): Array<string> {
  return db
    .prepare(
      `SELECT version_id AS id FROM semantic_assertion_versions
       UNION SELECT claim_id FROM claim_versions WHERE id IN (SELECT version_id FROM semantic_assertion_versions)`
    )
    .all()
    .map((row) => row.id)
    .filter((id): id is string => typeof id === 'string' && id.includes('person:'));
}

const tokens = (ids: ReadonlyArray<string>): RegExp =>
  new RegExp(
    `(?<![\\w-])(?:${[...ids]
      .sort((a, b) => b.length - a.length)
      .map(escaped)
      .join('|')})(?![\\w-])`,
    'g'
  );

/** `value` with every old id of `mapping` rewritten, the sealed ids kept as they are. */
function rewritten(
  value: string,
  pattern: RegExp,
  mapping: ReadonlyMap<string, string>,
  sealed: RegExp | null
): string {
  if (sealed === null) return value.replace(pattern, (old) => mapping.get(old) ?? old);
  const kept: Array<string> = [];
  const masked = value.replace(sealed, (id) => `\uE000${String(kept.push(id) - 1)}\uE001`);
  return masked
    .replace(pattern, (old) => mapping.get(old) ?? old)
    .replace(/\uE000(\d+)\uE001/g, (_, at: string) => kept[Number(at)] ?? '');
}

/**
 * The evidence and qualifier an edge's id was hashed with, read off the tail of its projection key; null when no split
 * of the tail gives the stored id (graph.ts#writeUnit replaces such an edge when its unit is projected).
 */
function hashedTail(edge: Row): { evidence: string | null; qualifier: string | undefined } | null {
  const [predicate, src, dst] = [String(edge.predicate), String(edge.src), String(edge.dst)];
  const base = `${predicate}:${src}:${dst}`;
  const key = String(edge.projection_key);
  if (!key.startsWith(base)) return null;
  const tail = key.slice(base.length + 1);
  const splits: Array<{ evidence: string | null; qualifier: string | undefined }> = [
    { evidence: tail === '' ? null : tail, qualifier: undefined },
    { evidence: null, qualifier: tail === '' ? undefined : tail },
  ];
  for (let at = tail.indexOf(':'); at > 0; at = tail.indexOf(':', at + 1))
    splits.push({ evidence: tail.slice(0, at), qualifier: tail.slice(at + 1) });
  return splits.find((split) => edgeIdOf(predicate, src, dst, split.evidence, split.qualifier) === edge.id) ?? null;
}

/**
 * The graph edges whose ends name an old id of `mapping`, rewritten with the id of their new tuple, their witnesses in
 * `node_access` repointed to it. An edge whose new id or key another edge holds is dropped with its witnesses. The rest
 * of the row (`evidence_id`, `owner_key`) is left to the rewrite of every column.
 */
function rewriteEdges(db: Db, rewrite: (value: string) => string, tally: Tally): void {
  const rows = db
    .prepare(
      'SELECT rowid AS rid, id, src, predicate, dst, projection_key FROM graph_edges WHERE projection_key LIKE ?'
    )
    .all('%person:%');
  const update = db.prepare(
    'UPDATE OR IGNORE graph_edges SET id = ?, src = ?, dst = ?, projection_key = ? WHERE rowid = ?'
  );
  const drop = db.prepare('DELETE FROM graph_edges WHERE rowid = ?');
  const repoint = db.prepare('UPDATE OR IGNORE node_access SET evidence_id = ? WHERE evidence_id = ?');
  const unwitness = db.prepare('DELETE FROM node_access WHERE evidence_id = ?');
  for (const row of rows) {
    const key = rewrite(String(row.projection_key));
    if (key === row.projection_key) continue;
    const [src, dst] = [rewrite(String(row.src)), rewrite(String(row.dst))];
    const tail = hashedTail(row);
    const old = String(row.id);
    const id =
      tail === null
        ? old
        : edgeIdOf(row.predicate, src, dst, tail.evidence === null ? null : rewrite(tail.evidence), tail.qualifier);
    if (Number(update.run(id, src, dst, key, Number(row.rid)).changes) === 0) {
      add(tally.dropped, 'graph_edges.id', Number(drop.run(Number(row.rid)).changes));
      unwitness.run(old);
      continue;
    }
    add(tally.changed, 'graph_edges.projection_key', 1);
    if (id === old) continue;
    add(tally.changed, 'graph_edges.id', 1);
    repoint.run(id, old);
    unwitness.run(old);
  }
}

/**
 * Rewrites every whole occurrence of an old id of `mapping` to its meta-person, column by column. A row whose new value
 * is already taken by another row is dropped, so the row that holds it wins.
 */
function rewrite(db: Db, mapping: ReadonlyMap<string, string>, tally: Tally): void {
  if (mapping.size === 0) return;
  const pattern = tokens([...mapping.keys()]);
  const sealedList = sealedIds(db);
  const sealed = sealedList.length > 0 ? tokens(sealedList) : null;
  const tables = tablesOf(db);
  if (tables.includes('graph_edges')) rewriteEdges(db, (value) => rewritten(value, pattern, mapping, sealed), tally);
  for (const table of tables) {
    if (KEPT_TABLES.has(table)) continue;
    for (const column of idColumns(db, table)) {
      const rows = db
        .prepare(`SELECT rowid AS rid, ${quoted(column)} AS value FROM ${quoted(table)} WHERE ${quoted(column)} LIKE ?`)
        .all('%person:%');
      const update = db.prepare(`UPDATE OR IGNORE ${quoted(table)} SET ${quoted(column)} = ? WHERE rowid = ?`);
      const drop = db.prepare(`DELETE FROM ${quoted(table)} WHERE rowid = ?`);
      for (const row of rows) {
        if (typeof row.value !== 'string') continue;
        const next = rewritten(row.value, pattern, mapping, sealed);
        if (next === row.value) continue;
        const rid = Number(row.rid);
        const key = `${table}.${column}`;
        try {
          if (Number(update.run(next, rid).changes) > 0) add(tally.changed, key, 1);
          else add(tally.dropped, key, Number(drop.run(rid).changes));
        } catch (error) {
          if ((error as { errcode?: unknown } | null)?.errcode !== CONSTRAINT_TRIGGER) throw error;
          add(tally.kept, key, 1);
        }
      }
    }
  }
}

/** The person an account is verified to: its live verified link, else the copy in `accounts`; null for none. */
function verifiedPerson(db: Db, accountId: string): { person: string; by: string } | null {
  const live = db
    .prepare(
      `SELECT person_id, by FROM account_person_links WHERE account_id = ? AND state = 'verified' AND valid_to_at IS NULL
       ORDER BY valid_from_at DESC LIMIT 1`
    )
    .get(accountId);
  if (typeof live?.person_id === 'string')
    return { person: live.person_id, by: typeof live.by === 'string' ? live.by : 'owner' };
  const copy = db
    .prepare("SELECT person_id, linked_by FROM accounts WHERE id = ? AND link = 'verified'")
    .get(accountId);
  if (typeof copy?.person_id !== 'string' || copy.person_id === '') return null;
  return { person: copy.person_id, by: typeof copy.linked_by === 'string' ? copy.linked_by : 'owner' };
}

const exists = (db: Db, person: string): boolean =>
  Boolean(db.prepare('SELECT 1 AS ok FROM people WHERE id = ?').get(person));

/** The command line's accounts linked to the owner's person, so his accounts end under one meta-person. */
function linkOwner(db: Db, ownerPerson: string | null, at: string): number {
  if (ownerPerson === null) return 0;
  const owner = survivorOf(db, ownerPerson);
  if (!exists(db, owner)) throw coded('UNKNOWN_PERSON');
  let linked = 0;
  const accounts = db
    .prepare('SELECT id FROM accounts WHERE iface = ? AND retired_at IS NULL ORDER BY id')
    .all(OWNER_CONSOLE_IFACE);
  for (const row of accounts) {
    const current = verifiedPerson(db, String(row.id));
    if (current !== null && survivorOf(db, current.person) === owner) continue;
    linkOwnerAccount(db, String(row.id), owner, at);
    linked += 1;
  }
  return linked;
}

/** Her own person and every person whose id spells no interface, marked meta where they stand. */
function promote(db: Db): number {
  const people = db
    .prepare("SELECT id FROM people WHERE COALESCE(meta, 0) = 0 AND COALESCE(status, '') NOT LIKE 'merged_into:%'")
    .all()
    .map((row) => String(row.id))
    .filter((id) => id === SELF_PERSON || legacyPersonNative(id) === null);
  for (const id of people) db.prepare('UPDATE people SET meta = 1 WHERE id = ?').run(id);
  return people.length;
}

/** A new meta-person for every person whose id spells an interface; the old row stays as its merged alias. */
function mint(db: Db, at: string, uuid: () => string): Map<string, string> {
  const columns = db
    .prepare('PRAGMA table_info(people)')
    .all()
    .map((column) => String(column.name))
    .filter((name) => !['id', 'meta', 'status'].includes(name));
  const list = columns.map(quoted).join(', ');
  const minted = new Map<string, string>();
  const people = db
    .prepare(
      "SELECT id FROM people WHERE COALESCE(meta, 0) = 0 AND COALESCE(status, '') NOT LIKE 'merged_into:%' ORDER BY id"
    )
    .all()
    .map((row) => String(row.id))
    .filter((id) => id !== SELF_PERSON && legacyPersonNative(id) !== null);
  for (const old of people) {
    const meta = newPersonId(uuid);
    db.prepare(
      `INSERT INTO people (id, meta, status, ${list}) SELECT ?, 1, 'active', ${list} FROM people WHERE id = ?`
    ).run(meta, old);
    db.prepare('UPDATE people SET owner_key = NULL, owner_file = NULL, status = ? WHERE id = ?').run(
      `merged_into:${meta}`,
      old
    );
    db.prepare(
      'INSERT INTO people_merges (id, from_person, into_person, at, by, reason) VALUES (?, ?, ?, ?, ?, ?)'
    ).run(`merge:${old}`, old, meta, at, 'owner', REASON);
    minted.set(old, meta);
  }
  return minted;
}

/** Every account linked to the meta-person its person ends in; an account linked to nobody gets one of its own. */
function relink(db: Db, at: string, uuid: () => string): { linked: number; minted: number } {
  let linked = 0;
  let minted = 0;
  for (const row of db.prepare('SELECT id FROM accounts ORDER BY id').all()) {
    const id = String(row.id);
    const current = verifiedPerson(db, id);
    if (current === null) {
      const meta = newPersonId(uuid);
      db.prepare("INSERT INTO people (id, kind, meta, status) VALUES (?, 'member', 1, 'active')").run(meta);
      linkAccount(db, id, meta, at, { by: 'owner', reason: REASON });
      minted += 1;
      linked += 1;
      continue;
    }
    const target = survivorOf(db, current.person);
    const copied = db.prepare('SELECT person_id FROM accounts WHERE id = ?').get(id)?.person_id;
    if (target === current.person && copied === target) continue;
    linkAccount(db, id, target, at, { by: current.by, reason: REASON });
    linked += 1;
  }
  return { linked, minted };
}

/** Every person merged into another, with the meta-person it ends in now. */
function mergedPeople(db: Db): Map<string, string> {
  const merged = new Map<string, string>();
  const rows = db
    .prepare("SELECT id FROM people WHERE COALESCE(meta, 0) = 0 AND status LIKE 'merged_into:%' ORDER BY id")
    .all();
  for (const row of rows) {
    const id = String(row.id);
    const survivor = survivorOf(db, id);
    if (survivor !== id) merged.set(id, survivor);
  }
  return merged;
}

/** One `person_accounts` row for every verified account of a meta-person that has none; returns how many were written. */
function fillAccounts(db: Db, at: string): number {
  return Number(
    db
      .prepare(
        `INSERT OR IGNORE INTO person_accounts (id, person_id, iface, platform_id, generation, handle, display_name,
           avatar, profile_text, recorded_at)
         SELECT a.id, a.person_id, a.iface, COALESCE(a.native_key, a.native_id, a.id), COALESCE(a.generation, 1), NULL,
           CASE WHEN json_valid(a.names) AND json_type(a.names) = 'array' THEN json_extract(a.names, '$[0]') END,
           a.avatar, NULL, ?
         FROM accounts a JOIN people p ON p.id = a.person_id
         WHERE a.link = 'verified' AND p.meta = 1 AND NOT EXISTS (SELECT 1 FROM person_accounts m WHERE m.id = a.id)
         ORDER BY a.id`
      )
      .run(at).changes
  );
}

/** `sources.author_person` for every line whose author account has a meta-person; returns how many lines got one. */
function fillAuthors(db: Db): number {
  return Number(
    db
      .prepare(
        `UPDATE sources SET author_person = (SELECT m.person_id FROM person_accounts m WHERE m.id = sources.author_account)
         WHERE author_person IS NULL AND author_account IS NOT NULL
           AND EXISTS (SELECT 1 FROM person_accounts m WHERE m.id = sources.author_account)`
      )
      .run().changes
  );
}

/**
 * The migration, inside the caller's transaction (foreign keys are checked at its commit). Throws `UNKNOWN_PERSON`
 * before writing anything when `ownerPerson` names a person nobody stored.
 */
export function migrateMetaPersons(db: Db, { ownerPerson, at, newId }: MetaPersonOptions): MetaPersonReport {
  const uuid = newId ?? ((): string => newPersonId().slice('person:'.length));
  db.exec('PRAGMA defer_foreign_keys = ON');
  const before = tableCounts(db);
  const tally: Tally = { changed: {}, dropped: {}, kept: {} };
  let linked = linkOwner(db, ownerPerson, at);
  const promoted = promote(db);
  const fresh = mint(db, at, uuid);
  const accounts = relink(db, at, uuid);
  linked += accounts.linked;
  rewrite(db, fresh, tally);
  const merged = mergedPeople(db);
  // The people merged before this run; the ones minted above are rewritten already.
  const earlier = new Map([...merged].filter(([id]) => !fresh.has(id)));
  for (const [from, into] of earlier) add(tally.changed, 'daily relationship counts', moveRelationship(db, from, into));
  rewrite(db, earlier, tally);
  fillAccounts(db, at);
  const authors = fillAuthors(db);
  const after = tableCounts(db);
  return {
    persons: Object.fromEntries(merged),
    minted: fresh.size + accounts.minted,
    promoted,
    linked,
    // The links above write most account rows themselves (person-links.ts#linkAccount), so the table's growth counts.
    accounts: Number(after.person_accounts ?? 0) - Number(before.person_accounts ?? 0),
    authorPerson: authors,
    ...tally,
    ownerPerson: ownerPerson === null ? null : { from: ownerPerson, to: survivorOf(db, ownerPerson) },
    counts: { before, after },
  };
}
