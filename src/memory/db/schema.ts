// The memory database's schema steps above the baseline, and the names its checks and readers share. A new database
// starts from the baseline (src/memory/db/schema-baseline.ts); src/memory/db/open.ts then applies each entry of
// `MIGRATIONS` in order, one version per entry, and never edits a shipped one.

import type { Db } from './types.ts';

/** One migration: SQL text, or a function of the connection. */
export type Migration = string | ((db: Db) => void);

/** The kind at the head of a vector's chunk key, past the account of a DM line (`private:<account>:`). */
const VECTOR_KIND = /^(?:private:[^:]+:)?([^:]+):/;

/**
 * Version 57: the columns that carry what a row's key spelled, filled once from the keys of the rows already stored.
 * `affinity_events.decision_id` names the memory line (`decisions.id`) an attitude row of the journal belongs to,
 * `session_runs.page` and `parts` the page of a batch a run answered and how many parts that page went out in, and
 * `vectors.kind` the kind of a vector (`record`, `archive`, `claim`, `desc`, `episode`, `names`, `gif`, `media` or
 * `semantic`). A lorebook entry's own id joins its other fields in the claim's `extra`.
 */
function rowLinks(db: Db): void {
  db.exec(`ALTER TABLE affinity_events ADD COLUMN decision_id TEXT;
    UPDATE affinity_events SET decision_id = (
      SELECT d.id FROM decisions d WHERE d.writer = 'journal' AND affinity_events.id = 'aff:' || d.id || ':' || affinity_events.position
        AND d.holder_id IS affinity_events.holder_id AND d.period IS affinity_events.period)
     WHERE writer = 'journal';
    CREATE INDEX affinity_events_decision ON affinity_events(decision_id) WHERE decision_id IS NOT NULL;
    ALTER TABLE session_runs ADD COLUMN page INTEGER;
    ALTER TABLE session_runs ADD COLUMN parts INTEGER;
    CREATE INDEX session_runs_page ON session_runs(scope_key, cursor_from, cursor_to, page) WHERE applied = 1;
    ALTER TABLE vectors ADD COLUMN kind TEXT;
    UPDATE claims SET extra = json_set(COALESCE(extra, '{}'), '$.id', substr(id, 6))
     WHERE kind = 'lore' AND id GLOB 'lore:*' AND json_extract(COALESCE(extra, '{}'), '$."$noId"') IS NULL;`);
  // A batch key is `<mode>|<scope key>|<cursor from>|<cursor to>|<page>`, with `|<part>/<parts>` for a page in parts.
  const page = db.prepare('UPDATE session_runs SET page = ?, parts = ? WHERE rowid = ?');
  for (const row of db
    .prepare(
      'SELECT rowid, mode, scope_key, cursor_from, cursor_to, batch_key FROM session_runs WHERE batch_key IS NOT NULL'
    )
    .all()) {
    const head = `${String(row.mode)}|${String(row.scope_key)}|${String(row.cursor_from)}|${String(row.cursor_to)}|`;
    const key = String(row.batch_key);
    if (!key.startsWith(head)) continue;
    const match = /^(\d+)(?:\|\d+\/(\d+))?$/.exec(key.slice(head.length));
    if (match) page.run(Number(match[1]), match[2] === undefined ? 1 : Number(match[2]), row.rowid);
  }
  const kind = db.prepare('UPDATE vectors SET kind = ? WHERE rowid = ?');
  for (const row of db.prepare('SELECT rowid, chunk_key FROM vectors').all()) {
    const found = VECTOR_KIND.exec(typeof row.chunk_key === 'string' ? row.chunk_key : '');
    if (found) kind.run(found[1], row.rowid);
  }
  db.exec('CREATE INDEX vectors_kind ON vectors(kind)');
}

/**
 * Version 58: every record vector with no `source_rowid` links to the line it was made from, read from the row's own
 * fields (its message id in `item_id`, its revision in `context`) through `message_families` and then `native_id`, as
 * the line vectors' writer links a new row. A vector whose line no `sources` row holds stays unlinked.
 */
function vectorSources(db: Db): void {
  const ofFamily = db.prepare(
    `SELECT rowid FROM sources WHERE authority_id = ? AND native_kind = ? AND native_id = ? AND generation = ?
       AND revision = ? AND kind IN ('seen', 'said') AND retired_at IS NULL ORDER BY kind LIMIT 1`
  );
  const ofNative = db.prepare(
    "SELECT rowid FROM sources WHERE native_id = ? AND revision = ? AND kind IN ('seen', 'said') ORDER BY kind LIMIT 1"
  );
  const link = db.prepare('UPDATE vectors SET source_rowid = ? WHERE rowid = ?');
  const unlinked = db
    .prepare(
      `SELECT rowid, item_id, scope_iface, json_extract(context, '$.revision') AS revision,
         json_extract(context, '$.placeId') AS chat FROM vectors WHERE kind = 'record' AND source_rowid IS NULL`
    )
    .all();
  // The catalog's key starts at the interface, so one scan answers every message id at once.
  const ids = [...new Set(unlinked.map((row) => row.item_id).filter((id) => typeof id === 'string'))];
  const families = new Map<unknown, Array<Record<string, unknown>>>();
  for (const family of db
    .prepare('SELECT * FROM message_families WHERE generation = 1 AND message_id IN (SELECT value FROM json_each(?))')
    .all(JSON.stringify(ids)))
    families.set(family.message_id, [...(families.get(family.message_id) ?? []), family]);
  for (const row of unlinked) {
    if (typeof row.item_id !== 'string' || !Number.isInteger(row.revision)) continue;
    let held = families.get(row.item_id) ?? [];
    if (held.length > 1)
      held = held.filter(
        (family) =>
          (row.chat === null || family.conversation_id === row.chat) &&
          (row.scope_iface === null || family.iface === row.scope_iface)
      );
    const family = held.length === 1 ? held[0] : undefined;
    const found =
      (family
        ? ofFamily.get(family.authority_id, family.native_kind, family.native_key, family.generation, row.revision)
        : undefined) ?? ofNative.get(row.item_id, row.revision);
    if (found) link.run(found.rowid, row.rowid);
  }
}

/** The steps above the baseline, version 57 first. */
export const MIGRATIONS: Array<Migration> = [rowLinks, vectorSources];

/** The tables that carry a scope and its `audience_id`. */
export const SCOPED_TABLES = [
  'sources',
  'vectors',
  'claims',
  'descriptions',
  'episodes',
  'affinity_events',
  'day',
  'selfreflection',
  'media',
  'intentions',
  'work',
  'session_runs',
];

/** The token kinds of a participant. */
export const PARTICIPANT_TOKEN_KINDS = ['thread_token', 'site_token', 'post_number', 'display_name', 'none'];
/** The predicates of `source_relations`. */
export const RELATION_PREDICATES = ['replies_to', 'quotes', 'reposts', 'mentions', 'edits', 'references'];
/** The states of a wake run. */
export const WAKE_RUN_STATUSES = ['queued', 'running', 'succeeded', 'failed', 'interrupted'];
