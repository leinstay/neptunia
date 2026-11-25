// The memory audit: counts of what breaks the rules of the stored rows, over a read connection. The memory tests run
// it over the rows the real writers made, so a writer that breaks a rule fails its test. It writes nothing and returns no word, id or name of a row. Retired rows are history and are not
// looked at. Each check is one rule:
//   placeExists        a live row's place is a row of `places`
//   scopeMatchesPlace  a row of a DM place is scoped to a DM, and a row of any other place is not
//   audienceDerived    a live row's `audience_id` is the one its scope resolves to (src/memory/db/rows.ts#resolveRow)
//   danglingLinks      a live link between rows points at live rows, and a version belongs to a row that exists (a claim version names a claim or an episode,
//                      retired or not, because an expired episode's archive line is kept as a version beside it)
//   unexplainedNone    a live row under `aud:none` has a live `decisions` row of `AUDIENCE_NONE_KEPT` naming it
//   linkedMediaKept    no media row a live line or a live diary entry links is retired
//   unlinkedLineMedia  no live media row of a message's item (`<message id>#<item>`) stands apart from the message's live line
//                      (unlinkedLineItems below)
//   placeUnnamed       a live room or root has a name (a direct chat has none by design)
//   placeUndescribed   a live place with `DESCRIBE_AFTER_LINES` (20) live lines or more has
//                      all of `purpose`, `tone` and `topics` as live descriptions
//   interfaceUnnamed   an interface with a live place has no name
//   cliLineRetired     a line of the owner's command line (its DM place) retired with an `origin` other than `owner`,
//                      the stamp the memory command leaves on a line it retires

import { resolveRow } from '../../src/memory/db/rows.ts';
import { SCOPED_TABLES } from '../../src/memory/db/schema.ts';
import { asText } from '../../src/memory/db/types.ts';
import type { Db } from '../../src/memory/db/types.ts';

/** The `decisions.action` that records why a row stays under `aud:none`. */
const AUDIENCE_NONE_KEPT = 'audience-none-kept';

type AuditCheck =
  | 'placeExists'
  | 'scopeMatchesPlace'
  | 'audienceDerived'
  | 'danglingLinks'
  | 'unexplainedNone'
  | 'linkedMediaKept'
  | 'unlinkedLineMedia'
  | 'placeUnnamed'
  | 'placeUndescribed'
  | 'interfaceUnnamed'
  | 'cliLineRetired';
type AuditReport = { findings: number; checks: Record<AuditCheck, number> };
/** The live lines after which a place is expected to be described. */
const DESCRIBE_AFTER_LINES = 20;
/** The fields every place with lines carries (plan of the turn frame, "The fields of a place"). */
const PLACE_FIELDS = ['purpose', 'tone', 'topics'] as const;
/** The interface of the owner's chat at the command line, and the `origin` the memory command stamps on a line it retires. */
const CLI_IFACE = 'cli';
const OWNER_ORIGIN = 'owner';

/** The columns of `table`, none when it does not exist. */
function columnsOf(db: Db, table: string): Set<string> {
  return new Set(
    db
      .prepare(`SELECT name FROM pragma_table_info(?)`)
      .all(table)
      .map((row) => String(row.name))
  );
}

const countOf = (db: Db, sql: string, ...params: Array<string | number>): number =>
  Number(db.prepare(sql).get(...params)?.n ?? 0);

/** `<alias>.retired_at IS NULL` when the table has the column, else a condition every row meets. */
const liveIn = (columns: ReadonlySet<string>, alias: string): string =>
  columns.has('retired_at') ? `${alias}.retired_at IS NULL` : '1';

/** The scoped tables that exist, each with its columns. */
function scopedTables(db: Db): Array<{ table: string; columns: Set<string> }> {
  return SCOPED_TABLES.map((table) => ({ table, columns: columnsOf(db, table) })).filter(
    ({ columns }) => columns.size > 0
  );
}

function placeChecks(db: Db): { placeExists: number; scopeMatchesPlace: number } {
  let placeExists = 0;
  let scopeMatchesPlace = 0;
  for (const { table, columns } of scopedTables(db)) {
    if (!columns.has('place_id')) continue;
    const live = liveIn(columns, 't');
    placeExists += countOf(
      db,
      `SELECT COUNT(*) AS n FROM "${table}" t LEFT JOIN places p ON p.id = t.place_id
       WHERE ${live} AND t.place_id IS NOT NULL AND p.id IS NULL`
    );
    scopeMatchesPlace += countOf(
      db,
      `SELECT COUNT(*) AS n FROM "${table}" t JOIN places p ON p.id = t.place_id
       WHERE ${live} AND (COALESCE(p.chat = 'dm', 0) OR p.kind = 'dm') <> (t.scope_kind IS 'dm')`
    );
  }
  return { placeExists, scopeMatchesPlace };
}

function audienceDerived(db: Db): number {
  let found = 0;
  for (const { table, columns } of scopedTables(db)) {
    if (!columns.has('audience_id')) continue;
    const triples = db
      .prepare(
        `SELECT scope_kind, scope_iface, scope_dm, audience_id, COUNT(*) AS n FROM "${table}" t WHERE ${liveIn(columns, 't')}
         GROUP BY scope_kind, scope_iface, scope_dm, audience_id`
      )
      .all();
    for (const row of triples) {
      if (row.audience_id === null || resolveRow(db, row).conflict) found += Number(row.n);
    }
  }
  return found;
}

/** The links of `child` to `target`: from a live linking row that exists, and to a live row that exists. */
function deadLinks(
  db: Db,
  child: string,
  parentColumn: string,
  parent: string,
  targetColumn: string,
  target: string
): number {
  const links = columnsOf(db, child);
  if (links.size === 0) return 0;
  return countOf(
    db,
    `SELECT COUNT(*) AS n FROM ${child} l
       LEFT JOIN ${parent} o ON o.id = l.${parentColumn} LEFT JOIN ${target} d ON d.id = l.${targetColumn}
     WHERE ${liveIn(links, 'l')} AND (o.id IS NULL OR (${liveIn(columnsOf(db, parent), 'o')} AND (d.id IS NULL OR ${liveIn(columnsOf(db, target), 'd')} IS NOT TRUE)))`
  );
}

/** The versions of `child` whose row exists in none of the `parents` tables. */
function orphanVersions(db: Db, child: string, column: string, parents: Array<string>): number {
  const columns = columnsOf(db, child);
  if (columns.size === 0) return 0;
  const found = parents.filter((parent) => columnsOf(db, parent).size > 0);
  const joins = found.map((parent, i) => `LEFT JOIN ${parent} p${i} ON p${i}.id = v.${column}`).join(' ');
  const missing = found.length === 0 ? '1' : found.map((_, i) => `p${i}.id IS NULL`).join(' AND ');
  return countOf(db, `SELECT COUNT(*) AS n FROM ${child} v ${joins} WHERE ${liveIn(columns, 'v')} AND ${missing}`);
}

function danglingLinks(db: Db): number {
  const descriptions = columnsOf(db, 'descriptions');
  return (
    deadMediaLinks(db) +
    deadLinks(db, 'claim_sources', 'claim_id', 'claims', 'source_id', 'sources') +
    deadLinks(db, 'episode_sources', 'episode_id', 'episodes', 'source_id', 'sources') +
    orphanVersions(db, 'claim_versions', 'claim_id', ['claims', 'episodes']) +
    orphanVersions(db, 'description_versions', 'description_id', ['descriptions']) +
    countOf(
      db,
      `SELECT COUNT(*) AS n FROM descriptions d LEFT JOIN description_versions v ON v.id = d.current_version
       WHERE ${liveIn(descriptions, 'd')} AND d.current_version IS NOT NULL AND v.id IS NULL`
    )
  );
}

function unexplainedNone(db: Db): number {
  let found = 0;
  for (const { table, columns } of scopedTables(db)) {
    if (!columns.has('audience_id')) continue;
    const reason = columns.has('id')
      ? `AND NOT EXISTS (SELECT 1 FROM decisions r WHERE r.target_kind = ? AND r.target_id = t.id AND r.action = ? AND r.retired_at IS NULL)`
      : '';
    found += countOf(
      db,
      `SELECT COUNT(*) AS n FROM "${table}" t WHERE ${liveIn(columns, 't')} AND t.audience_id = 'aud:none' ${reason}`,
      ...(columns.has('id') ? [table, AUDIENCE_NONE_KEPT] : [])
    );
  }
  return found;
}

function linkedMediaKept(db: Db): number {
  if (columnsOf(db, 'media_links').size === 0) return 0;
  return countOf(
    db,
    `SELECT COUNT(*) AS n FROM media_links l JOIN media m ON m.id = l.media_id
     LEFT JOIN sources s ON l.owner_kind = 'source' AND s.id = l.owner_id
     LEFT JOIN diary d ON l.owner_kind = 'diary' AND d.id = l.owner_id
     WHERE m.retired_at IS NOT NULL AND (s.id IS NOT NULL OR d.id IS NOT NULL)
       AND COALESCE(s.retired_at, d.retired_at) IS NULL`
  );
}

/**
 * The media rows a stored line misses: a live row that no row links, whose reference `<message id>#<item>` names the message of
 * a live `seen` or `said` line of its interface, while that line links no item of the reference. The describer wrote such a
 * row for an embed the platform unfurled after the line was stored. The line's message id is its locator's, else
 * `native_id`. One pair per line and row, in no order.
 */
function unlinkedLineItems(db: Db): Array<{ sourceId: string; mediaId: string }> {
  return db
    .prepare(
      `WITH loose AS MATERIALIZED (
         SELECT m.id AS media_id, m.native_ref AS ref, m.scope_iface AS iface,
           substr(m.native_ref, 1, instr(m.native_ref, '#') - 1) AS message
         FROM media m
         WHERE m.retired_at IS NULL AND instr(m.native_ref, '#') > 1
           AND NOT EXISTS (SELECT 1 FROM media_links l WHERE l.media_id = m.id)
       ), lines AS MATERIALIZED (
         SELECT s.id AS source_id, s.scope_iface AS iface,
           COALESCE(CASE WHEN json_valid(s.extra) THEN json_extract(s.extra, '$."$messageLocator".messageId') END, s.native_id)
             AS message
         FROM sources s
         WHERE s.kind IN ('seen', 'said') AND s.retired_at IS NULL
       )
       SELECT lines.source_id AS source_id, loose.media_id AS media_id
       FROM loose JOIN lines ON lines.message = loose.message AND lines.iface IS loose.iface
       WHERE NOT EXISTS (
         SELECT 1 FROM media_links l JOIN media o ON o.id = l.media_id
         WHERE l.owner_kind = 'source' AND l.owner_id = lines.source_id AND o.native_ref = loose.ref
       )`
    )
    .all()
    .map((row) => ({ sourceId: asText(row.source_id), mediaId: asText(row.media_id) }));
}

/** The media rows some stored line misses, each counted once however many revisions of the line miss it. */
function unlinkedLineMedia(db: Db): number {
  if (columnsOf(db, 'media_links').size === 0) return 0;
  return new Set(unlinkedLineItems(db).map(({ mediaId }) => mediaId)).size;
}

/** Links whose item or linking row is gone. */
function deadMediaLinks(db: Db): number {
  if (columnsOf(db, 'media_links').size === 0) return 0;
  return countOf(
    db,
    `SELECT COUNT(*) AS n FROM media_links l WHERE NOT EXISTS (SELECT 1 FROM media m WHERE m.id = l.media_id)
       OR (l.owner_kind = 'source' AND NOT EXISTS (SELECT 1 FROM sources s WHERE s.id = l.owner_id))
       OR (l.owner_kind = 'diary' AND NOT EXISTS (SELECT 1 FROM diary d WHERE d.id = l.owner_id))`
  );
}

/** A place is a direct chat by its chat or its kind. */
const IS_DM = "(COALESCE(p.chat = 'dm', 0) OR p.kind = 'dm')";

function placeUnnamed(db: Db): number {
  return countOf(
    db,
    `SELECT COUNT(*) AS n FROM places p WHERE p.retired_at IS NULL AND (p.name IS NULL OR trim(p.name) = '') AND NOT ${IS_DM}`
  );
}

function placeUndescribed(db: Db): number {
  const fields = PLACE_FIELDS.map(() => '?').join(', ');
  return countOf(
    db,
    `SELECT COUNT(*) AS n FROM places p
     WHERE p.retired_at IS NULL
       AND (SELECT COUNT(*) FROM sources s WHERE s.place_id = p.id AND s.retired_at IS NULL) >= ?
       AND (SELECT COUNT(DISTINCT d.field) FROM descriptions d
            WHERE d.subject_kind = 'place' AND d.subject_id = p.id AND d.retired_at IS NULL AND d.field IN (${fields})) < ?`,
    DESCRIBE_AFTER_LINES,
    ...PLACE_FIELDS,
    PLACE_FIELDS.length
  );
}

function interfaceUnnamed(db: Db): number {
  return countOf(
    db,
    `SELECT COUNT(*) AS n FROM interfaces i WHERE (i.name IS NULL OR trim(i.name) = '')
       AND EXISTS (SELECT 1 FROM places p WHERE p.iface = i.id AND p.retired_at IS NULL)`
  );
}

function cliLineRetired(db: Db): number {
  return countOf(
    db,
    `SELECT COUNT(*) AS n FROM sources WHERE place_id IN (SELECT id FROM places WHERE iface = ? AND chat = 'dm')
       AND retired_at IS NOT NULL AND origin IS NOT ?`,
    CLI_IFACE,
    OWNER_ORIGIN
  );
}

/** The counts of every check over `db`, and their sum. */
export function auditMemory(db: Db): AuditReport {
  const checks: Record<AuditCheck, number> = {
    ...placeChecks(db),
    audienceDerived: audienceDerived(db),
    danglingLinks: danglingLinks(db),
    unexplainedNone: unexplainedNone(db),
    linkedMediaKept: linkedMediaKept(db),
    unlinkedLineMedia: unlinkedLineMedia(db),
    placeUnnamed: placeUnnamed(db),
    placeUndescribed: placeUndescribed(db),
    interfaceUnnamed: interfaceUnnamed(db),
    cliLineRetired: cliLineRetired(db),
  };
  return { findings: Object.values(checks).reduce((sum, count) => sum + count, 0), checks };
}
