// The memory database's schema steps above the baseline, and the names its checks and readers share. A new database
// starts from the baseline (src/memory/db/schema-baseline.ts); src/memory/db/open.ts then applies each entry of
// `MIGRATIONS` in order, one version per entry, and never edits a shipped one.

import { createHash } from 'node:crypto';
import { edgeIdOf } from './graph.ts';
import { PERSONA_ID } from './ids.ts';
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

/**
 * Version 59: `names.script_key`, the key of a name's stems across scripts (script-key.ts), null for the rows already
 * stored. A database whose stems were all filled has them marked pending again, so the next projection job's
 * `fillStems` fills the key of those rows. A column already there is left as it is.
 */
function nameScripts(db: Db): void {
  const held = db.prepare("SELECT 1 AS ok FROM pragma_table_info('names') WHERE name = 'script_key'").get();
  if (!held) db.exec('ALTER TABLE names ADD COLUMN script_key TEXT');
  db.exec(`CREATE INDEX IF NOT EXISTS names_script ON names(script_key);
    UPDATE meta SET value = '1' WHERE key = 'stems_pending';`);
}

/**
 * Version 60: the board holds her errands and nothing else (the maintainer's decision of 2026-11-16). Every task
 * outside the errand lane, a task with no lane among them, goes with its events, outbox rows and results, and so do
 * the events that name no task. The seven tables only development used are dropped. `board_tasks` keeps the columns
 * the errand store writes and the five statuses an errand stands in, `board_results` the handoff, each rebuilt
 * through a copy because a CHECK cannot be altered; the copy keeps the rowids, which give the order errands were
 * filed in. `board_events`, `board_outbox` and `board_schema_version` stay as they are. The selfimprovement wakes not
 * yet handled, which no service claims, go with their deliveries.
 */
function errandBoard(db: Db): void {
  const hasColumn = (table: string, column: string): boolean =>
    db.prepare(`SELECT 1 AS ok FROM pragma_table_info('${table}') WHERE name = ?`).get(column) !== undefined;
  // A board already in this shape is left as it is, as step 59 leaves a column already there.
  if (hasColumn('board_tasks', 'lane')) {
    const notErrand = "SELECT id FROM board_tasks WHERE lane IS NOT 'errand'";
    db.exec(`DELETE FROM board_events WHERE task_id IS NULL OR task_id IN (${notErrand});
      DELETE FROM board_outbox WHERE task_id IS NULL OR task_id IN (${notErrand});
      DELETE FROM board_results WHERE task_id IN (${notErrand});
      DELETE FROM board_tasks WHERE lane IS NOT 'errand';
      CREATE TABLE board_tasks_new (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, role TEXT,
        status TEXT NOT NULL CHECK (status IN ('approved','in_progress','done','failed','cancelled')),
        close_reason TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, metadata TEXT
      );
      INSERT INTO board_tasks_new (rowid, id, title, role, status, close_reason, created_at, updated_at, metadata)
        SELECT rowid, id, title, role, status, close_reason, created_at, updated_at, metadata FROM board_tasks;
      DROP TABLE board_tasks;
      ALTER TABLE board_tasks_new RENAME TO board_tasks;
      CREATE INDEX board_tasks_status ON board_tasks(status);`);
  }
  if (hasColumn('board_results', 'attempt_id')) {
    db.exec(`CREATE TABLE board_results_new (
        id TEXT PRIMARY KEY, task_id TEXT NOT NULL, kind TEXT CHECK (kind IN ('handoff')), body TEXT, created_at TEXT
      );
      INSERT INTO board_results_new (rowid, id, task_id, kind, body, created_at)
        SELECT rowid, id, task_id, kind, body, created_at FROM board_results WHERE kind = 'handoff';
      DROP TABLE board_results;
      ALTER TABLE board_results_new RENAME TO board_results;`);
  }
  db.exec(`DROP TABLE IF EXISTS board_agent_runs;
    DROP TABLE IF EXISTS board_attempts;
    DROP TABLE IF EXISTS board_comments;
    DROP TABLE IF EXISTS board_dependencies;
    DROP TABLE IF EXISTS board_idempotency;
    DROP TABLE IF EXISTS board_questions;
    DROP TABLE IF EXISTS board_reviews;
    DELETE FROM deliveries WHERE wake_id IN (SELECT id FROM wakes WHERE kind = 'selfimprovement' AND state <> 'handled');
    DELETE FROM wakes WHERE kind = 'selfimprovement' AND state <> 'handled';`);
}

/** The stored word step 61 replaces, and the word it puts in its place. */
const OLD_WORD = 'selfreflection';
const NEW_WORD = 'diary';
/** The three spellings of the old word step 61 replaces in a stored JSON word, each with its new spelling. */
const WORD_FORMS = [
  ['selfreflection', 'diary'],
  ['Selfreflection', 'Diary'],
  ['SELFREFLECTION', 'DIARY'],
] as const;

/** The columns whose values step 61 renames by replacing the word wherever it stands, table by table. */
const RENAMED_COLUMNS: ReadonlyArray<readonly [string, ReadonlyArray<string>]> = [
  ['diary', ['id']],
  ['diary_mirrors', ['diary_id', 'id']],
  ['publications', ['id', 'row_kind', 'row_id', 'grant_id', 'idempotency_key']],
  ['publication_grants', ['id', 'row_kind', 'row_id']],
  ['mirrors', ['id', 'row_kind', 'backfill_high_water']],
  ['media', ['id', 'path', 'owner']],
  ['media_links', ['owner_id', 'media_id']],
  ['vectors', ['item_id', 'chunk_key']],
  ['turn_reads', ['row_kind', 'row_id']],
  ['decisions', ['target_kind', 'target_id']],
  ['model_requests', ['service', 'purpose']],
];

/** The values a rename may not merge with another row's: a table and the column whose values are unique. */
const UNIQUE_VALUES: ReadonlyArray<readonly [string, string]> = [
  ['selfreflection', 'id'],
  ['selfreflection_mirrors', 'id'],
  ['publications', 'id'],
  ['publications', 'idempotency_key'],
  ['publication_grants', 'id'],
  ['mirrors', 'id'],
  ['media', 'id'],
  ['media', 'path'],
  ['vectors', 'chunk_key'],
  ['graph_nodes', 'id'],
];

/** The JSON columns whose engine words step 61 renames: keys and string values without whitespace. */
const JSON_COLUMNS: ReadonlyArray<readonly [string, string]> = [
  ['day', 'extra'],
  ['deliveries', 'receipt'],
  ['operational', 'value'],
  ['publications', 'delivery'],
  ['vectors', 'context'],
  ['model_requests', 'outcome'],
];

/** `text` with the old word replaced in each of its three spellings. */
const withNewWord = (text: string): string => WORD_FORMS.reduce((out, [from, to]) => out.replaceAll(from, to), text);

/** A stored JSON value with the old word replaced in every key and every string that holds no whitespace. */
function renamedJson(value: unknown): unknown {
  if (typeof value === 'string') return /\s/.test(value) ? value : withNewWord(value);
  if (Array.isArray(value)) return value.map(renamedJson);
  if (value === null || typeof value !== 'object') return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, inner]) => [/\s/.test(key) ? key : withNewWord(key), renamedJson(inner)])
  );
}

/** The `operational` owner of the persona's value of `kind`, as `collectionId` in unit-keys.ts computes it. */
const personaOwner = (kind: string): string =>
  `unit:${createHash('sha256')
    .update(JSON.stringify({ kind, subject: { type: 'persona', id: PERSONA_ID } }))
    .digest('hex')
    .slice(0, 32)}`;

/**
 * The ids, paths and keys the rename would give a row that another row already holds, or two rows with different
 * values would come to share, as `table.column` names. Rows that share a value before the step share it after it and
 * meet no one new: a diary picture and the same file kept as an interface's attachment are two rows with one path.
 */
function renameCollisions(db: Db, has: (table: string, column: string) => boolean): Array<string> {
  const found: Array<string> = [];
  for (const [table, column] of UNIQUE_VALUES) {
    if (!has(table, column)) continue;
    const met = db
      .prepare(
        `SELECT 1 AS hit FROM "${table}" a WHERE instr(a."${column}", ?) > 0 AND EXISTS (
           SELECT 1 FROM "${table}" b WHERE b."${column}" = replace(a."${column}", ?, ?) AND b.rowid <> a.rowid)
         UNION ALL SELECT 1 FROM "${table}" WHERE instr("${column}", ?) > 0
           GROUP BY replace("${column}", ?, ?) HAVING COUNT(DISTINCT "${column}") > 1 LIMIT 1`
      )
      .get(OLD_WORD, OLD_WORD, NEW_WORD, OLD_WORD, OLD_WORD, NEW_WORD);
    if (met) found.push(`${table}.${column}`);
  }
  const oldOwner = personaOwner(OLD_WORD);
  if (
    has('operational', 'kind') &&
    db.prepare('SELECT 1 AS hit FROM operational WHERE kind = ? AND owner = ?').get(OLD_WORD, oldOwner) &&
    db.prepare('SELECT 1 AS hit FROM operational WHERE kind = ? AND owner = ?').get(NEW_WORD, personaOwner(NEW_WORD))
  )
    found.push('operational.owner');
  return found;
}

/**
 * The graph under the new word: the nodes whose id, kind or row id holds it, the edges whose ends, evidence, key or
 * owner hold it with each edge id recomputed from its new ends, and the witnesses that name a renamed node or edge.
 * An edge id that is neither hash of its old tuple, one with a qualifier, keeps its id.
 */
function renameGraph(db: Db): void {
  const hit = `instr(id, '${OLD_WORD}') > 0 OR instr(kind, '${OLD_WORD}') > 0 OR instr(row_id, '${OLD_WORD}') > 0`;
  db.exec(`UPDATE graph_nodes SET id = replace(id, '${OLD_WORD}', '${NEW_WORD}'),
      kind = replace(kind, '${OLD_WORD}', '${NEW_WORD}'), row_id = replace(row_id, '${OLD_WORD}', '${NEW_WORD}')
    WHERE ${hit};
    UPDATE node_access SET node_id = replace(node_id, '${OLD_WORD}', '${NEW_WORD}')
    WHERE instr(node_id, '${OLD_WORD}') > 0;`);
  const edges = db
    .prepare(
      `SELECT id, src, dst, predicate, evidence_id FROM graph_edges WHERE instr(src, ?) > 0 OR instr(dst, ?) > 0
         OR instr(evidence_id, ?) > 0 OR instr(projection_key, ?) > 0 OR instr(owner_key, ?) > 0`
    )
    .all(OLD_WORD, OLD_WORD, OLD_WORD, OLD_WORD, OLD_WORD);
  const setEdge = db.prepare(
    `UPDATE graph_edges SET id = ?, src = replace(src, ?, ?), dst = replace(dst, ?, ?),
       evidence_id = replace(evidence_id, ?, ?), projection_key = replace(projection_key, ?, ?),
       owner_key = replace(owner_key, ?, ?) WHERE id = ?`
  );
  const setWitness = db.prepare('UPDATE node_access SET evidence_id = ? WHERE evidence_id = ?');
  const renamed = (id: unknown): unknown => (typeof id === 'string' ? withNewWord(id) : id);
  for (const edge of edges) {
    const { id, src, dst, predicate, evidence_id: evidence } = edge;
    const next =
      edgeIdOf(predicate, src, dst, evidence) === id
        ? edgeIdOf(predicate, renamed(src), renamed(dst), renamed(evidence))
        : edgeIdOf(predicate, src, dst, null) === id
          ? edgeIdOf(predicate, renamed(src), renamed(dst), null)
          : String(id);
    const word = [OLD_WORD, NEW_WORD];
    setEdge.run(next, ...word, ...word, ...word, ...word, ...word, id);
    if (next !== id) setWitness.run(next, id);
  }
  db.exec(`UPDATE node_access SET evidence_id = replace(evidence_id, '${OLD_WORD}', '${NEW_WORD}')
    WHERE instr(evidence_id, '${OLD_WORD}') > 0`);
}

/** `media_links` again with the owner kind `diary` in its CHECK, which SQLite cannot change in place. */
function rebuildMediaLinks(db: Db): void {
  const links = String(
    db.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'media_links'").get()?.sql
  );
  if (links.includes(`'${OLD_WORD}'`)) {
    const indexes = db
      .prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND tbl_name = 'media_links' AND sql IS NOT NULL")
      .all();
    db.exec(`${links
      .replace(/^CREATE TABLE\s+"?media_links"?/, 'CREATE TABLE media_links_next')
      .replaceAll(`'${OLD_WORD}'`, `'${NEW_WORD}'`)};
      INSERT INTO media_links_next (owner_kind, owner_id, position, media_id)
        SELECT replace(owner_kind, '${OLD_WORD}', '${NEW_WORD}'), owner_id, position, media_id FROM media_links;
      DROP TABLE media_links;
      ALTER TABLE media_links_next RENAME TO media_links;`);
    for (const index of indexes) db.exec(String(index.sql));
  }
}

/**
 * Version 61: the stored word `selfreflection` becomes `diary` (the maintainer's decision of 2026-11-16), as a whole
 * word inside ids and paths too. The step first deletes the media vectors under `media:diary:` that no `media` row
 * holds and whose twin under `media:selfreflection:` is live, since the twin takes their key, and refuses the whole
 * step when a renamed id, path or key meets one another row holds. It renames the tables `selfreflection` and
 * `selfreflection_mirrors`, the column `selfreflection_id`, their indexes and the trigger, and rebuilds `media_links`
 * so its CHECK names `diary`. It then renames every `writer`, the columns of `RENAMED_COLUMNS` with the guards of
 * `publications` and `publication_grants` dropped and restored, the graph, the `operational` row of the persona's
 * entries with its owner, and the engine words of `JSON_COLUMNS`. A second run finds nothing to change.
 */
function diaryNames(db: Db): void {
  const tableNames = (): Set<string> =>
    new Set(
      db
        .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
        .all()
        .map((row) => String(row.name))
    );
  const has = (table: string, column: string): boolean =>
    db.prepare(`SELECT 1 AS ok FROM pragma_table_info('${table}') WHERE name = ?`).get(column) !== undefined;
  const tables = tableNames();
  db.exec(`DELETE FROM vectors WHERE instr(item_id, 'media:${NEW_WORD}:') = 1
      AND item_id NOT IN (SELECT id FROM media)
      AND chunk_key IN (SELECT replace(w.chunk_key, '${OLD_WORD}', '${NEW_WORD}') FROM vectors w
        WHERE instr(w.chunk_key, '${OLD_WORD}') > 0 AND w.item_id IN (SELECT id FROM media))`);
  const collisions = renameCollisions(db, has);
  if (collisions.length > 0)
    throw new Error(
      `diary-rename-collision: renaming ${OLD_WORD} to ${NEW_WORD} would merge rows in ${collisions.join(', ')}; ` +
        'resolve those rows by hand, then open the database again'
    );
  if (tables.has(OLD_WORD)) db.exec(`ALTER TABLE "${OLD_WORD}" RENAME TO "${NEW_WORD}"`);
  if (tables.has(`${OLD_WORD}_mirrors`)) db.exec(`ALTER TABLE "${OLD_WORD}_mirrors" RENAME TO "${NEW_WORD}_mirrors"`);
  if (has(`${NEW_WORD}_mirrors`, `${OLD_WORD}_id`))
    db.exec(`ALTER TABLE "${NEW_WORD}_mirrors" RENAME COLUMN "${OLD_WORD}_id" TO "${NEW_WORD}_id"`);
  // SQLite carries an index's and a trigger's name through a table rename, so those named after the word are made again.
  for (const object of db
    .prepare("SELECT type, name, sql FROM sqlite_master WHERE type IN ('index', 'trigger') AND instr(name, ?) > 0")
    .all(OLD_WORD)) {
    db.exec(`DROP ${String(object.type).toUpperCase()} "${String(object.name)}"`);
    db.exec(String(object.sql).replaceAll(OLD_WORD, NEW_WORD));
  }
  rebuildMediaLinks(db);
  db.exec('PRAGMA defer_foreign_keys = ON');
  const guards = db
    .prepare(
      "SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name IN ('publications', 'publication_grants')"
    )
    .all();
  for (const guard of guards) db.exec(`DROP TRIGGER "${String(guard.name)}"`);
  for (const table of tableNames()) {
    if (has(table, 'writer'))
      db.exec(`UPDATE "${table}" SET writer = replace(writer, '${OLD_WORD}', '${NEW_WORD}')
        WHERE instr(writer, '${OLD_WORD}') > 0`);
  }
  for (const [table, columns] of RENAMED_COLUMNS)
    for (const column of columns)
      if (has(table, column))
        db.exec(`UPDATE "${table}" SET "${column}" = replace("${column}", '${OLD_WORD}', '${NEW_WORD}')
          WHERE instr("${column}", '${OLD_WORD}') > 0`);
  for (const guard of guards) db.exec(String(guard.sql));
  if (tableNames().has('graph_nodes')) renameGraph(db);
  db.prepare('UPDATE operational SET kind = ?, owner = CASE owner WHEN ? THEN ? ELSE owner END WHERE kind = ?').run(
    NEW_WORD,
    personaOwner(OLD_WORD),
    personaOwner(NEW_WORD),
    OLD_WORD
  );
  for (const [table, column] of JSON_COLUMNS) {
    if (!has(table, column)) continue;
    const write = db.prepare(`UPDATE "${table}" SET "${column}" = ? WHERE rowid = ?`);
    for (const row of db
      .prepare(`SELECT rowid AS rowid, "${column}" AS value FROM "${table}" WHERE "${column}" LIKE ?`)
      .all(`%${OLD_WORD}%`)) {
      let stored: unknown;
      try {
        stored = JSON.parse(String(row.value));
      } catch {
        continue; // Not JSON: no engine word can be told from free text.
      }
      const next = JSON.stringify(renamedJson(stored));
      if (next !== JSON.stringify(stored)) write.run(next, row.rowid);
    }
  }
}

/**
 * Version 62: the members' ping states leave with `pings.get` and `pings.set` (the owner's decision of 2026-11-17).
 * The keys `pings` and `pingsOff` leave the value of every operational row of kind `place`, the key `notify` leaves
 * the send of every diary entry, and the column `memberships.pings_off`, which nothing writes, is dropped. A row that
 * holds none of the keys stays as it is, and so does a table without the column.
 */
function noPings(db: Db): void {
  db.exec(`UPDATE operational SET value = json_remove(value, '$.pings', '$.pingsOff')
     WHERE kind = 'place' AND json_valid(value)
       AND (json_type(value, '$.pings') IS NOT NULL OR json_type(value, '$.pingsOff') IS NOT NULL);
    UPDATE diary SET extra = json_remove(extra, '$.send.notify')
     WHERE json_valid(extra) AND json_type(extra, '$.send.notify') IS NOT NULL;`);
  const held = db.prepare("SELECT 1 AS ok FROM pragma_table_info('memberships') WHERE name = 'pings_off'").get();
  if (held) db.exec('ALTER TABLE memberships DROP COLUMN pings_off');
}

/**
 * Version 63: `media_names`, the stable name of each custom emoji and sticker an interface showed (media-names.ts),
 * bound to the interface and the platform id at first sight.
 */
const MEDIA_NAMES = `CREATE TABLE IF NOT EXISTS media_names (
    name TEXT PRIMARY KEY,
    kind TEXT NOT NULL CHECK (kind IN ('emoji', 'sticker')),
    iface TEXT NOT NULL,
    native_id TEXT NOT NULL,
    platform_name TEXT NOT NULL,
    animated INTEGER NOT NULL DEFAULT 0,
    first_seen_at TEXT NOT NULL,
    renamed_at TEXT,
    UNIQUE (iface, kind, native_id)
  );`;

/**
 * Version 64: one link per media of an owner. The first link of each owner and media stays and the later ones go, the
 * owner's remaining positions close up in their old order, and a unique key on `(owner_kind, owner_id, media_id)`
 * refuses a second link from then on.
 */
const UNIQUE_MEDIA_LINKS = `DELETE FROM media_links WHERE EXISTS (SELECT 1 FROM media_links f
    WHERE f.owner_kind = media_links.owner_kind AND f.owner_id = media_links.owner_id
      AND f.media_id = media_links.media_id AND f.position < media_links.position);
  CREATE TEMP TABLE media_links_order AS SELECT rowid AS link,
    ROW_NUMBER() OVER (PARTITION BY owner_kind, owner_id ORDER BY position) - 1 AS position FROM media_links;
  UPDATE media_links SET position = -1 - (SELECT o.position FROM media_links_order o WHERE o.link = media_links.rowid);
  UPDATE media_links SET position = -1 - position;
  DROP TABLE media_links_order;
  CREATE UNIQUE INDEX IF NOT EXISTS media_links_owner_media ON media_links(owner_kind, owner_id, media_id);`;

/**
 * Version 65: `rules`, the owner's rules (rules.ts). Removing a rule deletes its row, on the owner's word. The rules
 * apply everywhere, so the table carries no scope.
 */
const RULES = `CREATE TABLE IF NOT EXISTS rules (
    id TEXT PRIMARY KEY,
    text TEXT NOT NULL,
    added_at TEXT NOT NULL
  );`;

/** The steps above the baseline, version 57 first. */
export const MIGRATIONS: Array<Migration> = [
  rowLinks,
  vectorSources,
  nameScripts,
  errandBoard,
  diaryNames,
  noPings,
  MEDIA_NAMES,
  UNIQUE_MEDIA_LINKS,
  RULES,
];

/** The tables that carry a scope and its `audience_id`. */
export const SCOPED_TABLES = [
  'sources',
  'vectors',
  'claims',
  'descriptions',
  'episodes',
  'affinity_events',
  'day',
  'diary',
  'media',
  'intentions',
  'work',
  'session_runs',
];

/** The token kinds of a participant. */
export const PARTICIPANT_TOKEN_KINDS = ['thread_token', 'site_token', 'post_number', 'display_name', 'none'];
/** The predicates of `source_relations`. */
export const RELATION_PREDICATES = ['replies_to', 'quotes', 'reposts', 'mentions', 'edits', 'references'];
