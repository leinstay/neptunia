// The memory audit (scripts/memory-audit.ts, and the watcher's `audit`): counts of what breaks the rules of the stored rows,
// over a read connection. It writes nothing and returns no word, id or name of a row. Retired rows are history and are not
// looked at. Each check is one rule:
//   placeExists        a live row's place is a row of `places`
//   scopeMatchesPlace  a row of a DM place is scoped to a DM, and a row of any other place is not
//   audienceDerived    a live row's `audience_id` is the one its scope resolves to (src/memory/db/rows.ts#resolveRow)
//   danglingLinks      a live link between rows points at live rows, and a version belongs to a row that exists
//   unexplainedNone    a live row under `aud:none` has a live `decisions` row of `AUDIENCE_NONE_KEPT` naming it
//   vectorManifests    a month's manifest counts the rows the month holds, in the size it says
//   linkedMediaKept    no media row a live line or a live selfreflection entry links is retired

import { resolveRow } from './rows.ts';
import { SCOPED_TABLES } from './schema.ts';
import type { Db } from './types.ts';

/** The `decisions.action` that records why a row stays under `aud:none`. */
export const AUDIENCE_NONE_KEPT = 'audience-none-kept';

export const AUDIT_CHECKS = [
  'placeExists',
  'scopeMatchesPlace',
  'audienceDerived',
  'danglingLinks',
  'unexplainedNone',
  'vectorManifests',
  'linkedMediaKept',
] as const;
export type AuditCheck = (typeof AUDIT_CHECKS)[number];
export type AuditReport = { findings: number; checks: Record<AuditCheck, number> };

/** The columns of `table`, none when it does not exist. */
function columnsOf(db: Db, table: string): Set<string> {
  return new Set(
    db
      .prepare(`SELECT name FROM pragma_table_info(?)`)
      .all(table)
      .map((row) => String(row.name))
  );
}

const countOf = (db: Db, sql: string, ...params: Array<string>): number =>
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
       WHERE ${live} AND (COALESCE(p.conversation = 'dm', 0) OR p.kind = 'dm') <> (t.scope_kind IS 'dm')`
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

/** The links of `child` to `target`: from a live row `owner` that exists, and to a live row that exists. */
function deadLinks(
  db: Db,
  child: string,
  ownerColumn: string,
  owner: string,
  targetColumn: string,
  target: string
): number {
  const links = columnsOf(db, child);
  if (links.size === 0) return 0;
  return countOf(
    db,
    `SELECT COUNT(*) AS n FROM ${child} l
       LEFT JOIN ${owner} o ON o.id = l.${ownerColumn} LEFT JOIN ${target} d ON d.id = l.${targetColumn}
     WHERE ${liveIn(links, 'l')} AND (o.id IS NULL OR (${liveIn(columnsOf(db, owner), 'o')} AND (d.id IS NULL OR ${liveIn(columnsOf(db, target), 'd')} IS NOT TRUE)))`
  );
}

/** The versions of `child` whose row `parent` does not exist. */
function orphanVersions(db: Db, child: string, column: string, parent: string): number {
  const columns = columnsOf(db, child);
  if (columns.size === 0) return 0;
  return countOf(
    db,
    `SELECT COUNT(*) AS n FROM ${child} v LEFT JOIN ${parent} p ON p.id = v.${column} WHERE ${liveIn(columns, 'v')} AND p.id IS NULL`
  );
}

function danglingLinks(db: Db): number {
  const descriptions = columnsOf(db, 'descriptions');
  return (
    deadMediaLinks(db) +
    deadLinks(db, 'claim_sources', 'claim_id', 'claims', 'source_id', 'sources') +
    deadLinks(db, 'episode_sources', 'episode_id', 'episodes', 'source_id', 'sources') +
    orphanVersions(db, 'claim_versions', 'claim_id', 'claims') +
    orphanVersions(db, 'description_versions', 'description_id', 'descriptions') +
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

/** Whether a month's stored row agrees with what the month holds. A month kept raw holds no rows to count. */
function monthAgrees(db: Db, owner: unknown, stored: unknown): boolean {
  let value: { manifest?: { rows?: unknown; dims?: unknown }; raw?: unknown };
  try {
    value = JSON.parse(String(stored)) as typeof value;
  } catch {
    return false;
  }
  if (value.raw !== undefined) return true;
  const held = db
    .prepare(
      `SELECT COUNT(*) AS n, COALESCE(SUM(bytes IS NOT NULL AND length(bytes) <> ?), 0) AS off FROM vectors
       WHERE owner_key = ? AND retired_at IS NULL`
    )
    .get(Number(value.manifest?.dims), String(owner));
  return value.manifest?.rows === Number(held?.n) && Number(held?.off) === 0;
}

function vectorManifests(db: Db): number {
  const live = liveIn(columnsOf(db, 'operational'), 'o');
  return db
    .prepare(`SELECT o.owner_key, o.value FROM operational o WHERE o.kind = 'vectors' AND ${live}`)
    .all()
    .filter((row) => !monthAgrees(db, row.owner_key, row.value)).length;
}

function linkedMediaKept(db: Db): number {
  if (columnsOf(db, 'media_links').size === 0) return 0;
  return countOf(
    db,
    `SELECT COUNT(*) AS n FROM media_links l JOIN media m ON m.id = l.media_id
     LEFT JOIN sources s ON l.owner_kind = 'source' AND s.id = l.owner_id
     LEFT JOIN selfreflection d ON l.owner_kind = 'selfreflection' AND d.id = l.owner_id
     WHERE m.retired_at IS NOT NULL AND (s.id IS NOT NULL OR d.id IS NOT NULL)
       AND COALESCE(s.retired_at, d.retired_at) IS NULL`
  );
}

/** Links whose item or owner is gone. */
function deadMediaLinks(db: Db): number {
  if (columnsOf(db, 'media_links').size === 0) return 0;
  return countOf(
    db,
    `SELECT COUNT(*) AS n FROM media_links l WHERE NOT EXISTS (SELECT 1 FROM media m WHERE m.id = l.media_id)
       OR (l.owner_kind = 'source' AND NOT EXISTS (SELECT 1 FROM sources s WHERE s.id = l.owner_id))
       OR (l.owner_kind = 'selfreflection' AND NOT EXISTS (SELECT 1 FROM selfreflection d WHERE d.id = l.owner_id))`
  );
}

/** The counts of every check over `db`, and their sum. */
export function auditMemory(db: Db): AuditReport {
  const checks: Record<AuditCheck, number> = {
    ...placeChecks(db),
    audienceDerived: audienceDerived(db),
    danglingLinks: danglingLinks(db),
    unexplainedNone: unexplainedNone(db),
    vectorManifests: vectorManifests(db),
    linkedMediaKept: linkedMediaKept(db),
  };
  return { findings: Object.values(checks).reduce((sum, count) => sum + count, 0), checks };
}
