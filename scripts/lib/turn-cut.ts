// The cut of a data copy at the moment a stored turn started, for scripts/turn-replay.ts `--cut`: a new folder beside
// the original whose `memory.db` holds memory as it stood then. `cutCopy` copies the folder's files, writes the
// database with `VACUUM INTO` from a read-only connection, and runs `cutMemory` on the new file alone. It refuses a
// target that exists, a source or target whose `memory.db.lock` names a live process, and a turn the `day` table holds
// no `turn.start` for.
//
// The `turn.start` row of the turn the copy is cut for stays, though it is written at T.
// What `cutMemory` does, table by table, with `T` the moment (ISO text, or milliseconds for a `_ms` column):
//   deleted at or after T: `sources.recorded_at`, `day.at`, `decisions.at`, `model_requests.started_at`,
//     `execution_contexts.issued_at`, `session_runs.started_at`, `claims` by `created_at` (else `first_seen_at`),
//     `claim_versions.recorded_at`, `semantic_assertion_versions.recorded_at`, `description_versions.written_at`,
//     `episodes.created_at`, `affinity_events.at`, `graph_nodes.created_at`, `graph_edges.recorded_at`,
//     `source_relations.recorded_at`, `ingest.committed_at`, `external_keys.recorded_at`, `publications.created_at`,
//     `wake_runs.started_at`, `wake_actions.at`, `vectors.occurred_at`, `selfreflection.at_ms`,
//     `intentions.created_ms`, `work.created_ms`, `work_events.at_ms`, `wakes.queued_at`. Also `turn_reads` of a
//     turn that started at or after T or of a context issued then, and the rows that hang on a row the cut deleted
//     (its links, sources, vectors, versions). A row whose owner was gone before the cut stays.
//   un-retired when retired at or after T: `sources`, `claims`, `claim_versions`, `description_versions`, `media`,
//     `episodes`, `affinity_events`, `graph_edges` (and an edge's `valid_to_at`), `vectors`.
//   set back: a claim's `text` to its newest version before T, a description's `current_version` to its newest
//     version before T (a description with none left goes), a picture's `description` and `described_at` cleared when
//     described at or after T, an episode's `feeling` cleared when felt then, a person's `affinity` to the score of
//     their newest event before T. Each is set back only for a row that lost a version or an event in the cut.
//   left as they are: the counters and stamps of `people`, `places`, `accounts` and `memberships`, the person links
//     and merges (`account_person_links`, `people_merges`, `person_accounts`) and every row a merge rewrote in place,
//     the `intentions` and `work` records changed after T, the board's tables, the `operational` rows (the calibration
//     among them) and `names`. A change made in place without a dated version cannot be taken back by date.
// The append-only guards of the schema (its RAISE triggers) are dropped for the cut and made again after it.

import fs from 'node:fs';
import path from 'node:path';
import { DatabaseSync } from 'node:sqlite';

type Db = InstanceType<typeof DatabaseSync>;

/** What the cut did to one table: rows deleted and rows set back. */
export type CutCount = { table: string; removed: number; restored: number };

/** The rows deleted at or after the moment, by the column that dates them. */
const DATED: ReadonlyArray<{ table: string; column: string; ms?: boolean }> = [
  { table: 'day', column: 'at' },
  { table: 'decisions', column: 'at' },
  { table: 'model_requests', column: 'started_at' },
  { table: 'session_runs', column: 'started_at' },
  { table: 'claim_versions', column: 'recorded_at' },
  { table: 'semantic_assertion_versions', column: 'recorded_at' },
  { table: 'description_versions', column: 'written_at' },
  { table: 'episodes', column: 'created_at' },
  { table: 'affinity_events', column: 'at' },
  { table: 'graph_edges', column: 'recorded_at' },
  { table: 'graph_nodes', column: 'created_at' },
  { table: 'source_relations', column: 'recorded_at' },
  { table: 'ingest', column: 'committed_at' },
  { table: 'external_keys', column: 'recorded_at' },
  { table: 'publications', column: 'created_at' },
  { table: 'wake_actions', column: 'at' },
  { table: 'wake_runs', column: 'started_at' },
  { table: 'vectors', column: 'occurred_at' },
  { table: 'selfreflection', column: 'at_ms', ms: true },
  { table: 'intentions', column: 'created_ms', ms: true },
  { table: 'work', column: 'created_ms', ms: true },
  { table: 'work_events', column: 'at_ms', ms: true },
  { table: 'wakes', column: 'queued_at', ms: true },
];

/** The tables whose rows retired at or after the moment read as live again. */
const RETIRED = [
  'sources',
  'claims',
  'claim_versions',
  'description_versions',
  'media',
  'episodes',
  'affinity_events',
  'graph_edges',
  'vectors',
] as const;

/** The keys of the tables other rows hang on, recorded as the cut deletes their rows. */
const OWNER_KEYS: Readonly<Record<string, ReadonlyArray<string>>> = {
  sources: ['id', 'rowid'],
  claims: ['id'],
  claim_versions: ['id', 'claim_id'],
  affinity_events: ['person_id'],
  description_versions: ['id'],
  semantic_assertion_versions: ['version_id'],
  episodes: ['id'],
  graph_nodes: ['id'],
  selfreflection: ['id'],
  work: ['id'],
  wake_runs: ['id'],
};

/**
 * The rows that hang on a row the cut deleted, deleted after it: `table.column` names `owner.key`, and `where` narrows
 * the rows that hang on that owner. A row whose owner was missing before the cut stays.
 */
const HANGING: ReadonlyArray<{ table: string; column: string; owner: string; key: string; where?: string }> = [
  { table: 'media_links', column: 'owner_id', owner: 'sources', key: 'id', where: "owner_kind = 'source'" },
  {
    table: 'media_links',
    column: 'owner_id',
    owner: 'selfreflection',
    key: 'id',
    where: "owner_kind = 'selfreflection'",
  },
  { table: 'claim_sources', column: 'source_id', owner: 'sources', key: 'id' },
  { table: 'claim_sources', column: 'claim_id', owner: 'claims', key: 'id' },
  { table: 'claim_versions', column: 'claim_id', owner: 'claims', key: 'id' },
  { table: 'claim_version_sources', column: 'version_id', owner: 'claim_versions', key: 'id' },
  { table: 'claim_version_sources', column: 'source_id', owner: 'sources', key: 'id' },
  { table: 'semantic_arguments', column: 'version_id', owner: 'semantic_assertion_versions', key: 'version_id' },
  { table: 'semantic_labels', column: 'version_id', owner: 'semantic_assertion_versions', key: 'version_id' },
  { table: 'semantic_dependencies', column: 'version_id', owner: 'semantic_assertion_versions', key: 'version_id' },
  { table: 'semantic_search_documents', column: 'version_id', owner: 'claim_versions', key: 'id' },
  { table: 'episode_sources', column: 'episode_id', owner: 'episodes', key: 'id' },
  { table: 'episode_sources', column: 'source_id', owner: 'sources', key: 'id' },
  { table: 'source_relations', column: 'source_id', owner: 'sources', key: 'id' },
  { table: 'vectors', column: 'source_rowid', owner: 'sources', key: 'rowid' },
  { table: 'graph_edges', column: 'src', owner: 'graph_nodes', key: 'id' },
  { table: 'graph_edges', column: 'dst', owner: 'graph_nodes', key: 'id' },
  { table: 'node_access', column: 'node_id', owner: 'graph_nodes', key: 'id' },
  { table: 'selfreflection_mirrors', column: 'selfreflection_id', owner: 'selfreflection', key: 'id' },
  { table: 'work_events', column: 'work_id', owner: 'work', key: 'id' },
  { table: 'wake_actions', column: 'run_id', owner: 'wake_runs', key: 'id' },
];

function tableNames(db: Db): Set<string> {
  return new Set(
    db
      .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
      .all()
      .map((row) => String(row.name))
  );
}

const changesOf = (result: { changes: number | bigint }): number => Number(result.changes);

/**
 * Memory as it stood at `at` (milliseconds), on the open writable database `db` (see the head of this file). Returns
 * what changed per table, tables that changed nothing left out.
 */
export function cutMemory(db: Db, at: number, { keepTurn = null }: { keepTurn?: string | null } = {}): Array<CutCount> {
  const iso = new Date(at).toISOString();
  const tables = tableNames(db);
  const counts = new Map<string, CutCount>();
  const note = (table: string, removed: number, restored: number) => {
    const held = counts.get(table) ?? { table, removed: 0, restored: 0 };
    counts.set(table, { table, removed: held.removed + removed, restored: held.restored + restored });
  };
  const run = (sql: string, ...args: Array<string | number>) => changesOf(db.prepare(sql).run(...args));
  // Deletes the rows of `table` that `where` picks, its owner keys kept in `temp.cut_gone` first.
  const drop = (table: string, where: string, ...args: Array<string | number>): number => {
    for (const key of OWNER_KEYS[table] ?? [])
      run(
        `INSERT INTO temp.cut_gone (owner, key, value) SELECT ?, ?, "${key}" FROM "${table}" WHERE ${where}`,
        table,
        key,
        ...args
      );
    return run(`DELETE FROM "${table}" WHERE ${where}`, ...args);
  };
  const guards = db
    .prepare("SELECT name, sql FROM sqlite_master WHERE type = 'trigger' AND sql LIKE '%RAISE(ABORT%'")
    .all()
    .map((row) => ({ name: String(row.name), sql: String(row.sql) }));
  db.exec('PRAGMA foreign_keys = OFF');
  for (const guard of guards) db.exec(`DROP TRIGGER "${guard.name}"`);
  try {
    db.exec('BEGIN');
    db.exec('CREATE TEMP TABLE IF NOT EXISTS cut_gone (owner TEXT, key TEXT, value)');
    db.exec('DELETE FROM temp.cut_gone');
    // The reads of turns started at or after the moment, while the day rows that date them still exist.
    if (tables.has('turn_reads')) {
      note(
        'turn_reads',
        run(
          `DELETE FROM turn_reads WHERE turn_id IN (SELECT turn_id FROM day WHERE what = 'turn.start' AND at >= ?)
             OR context_id IN (SELECT id FROM execution_contexts WHERE issued_at >= ?)`,
          iso,
          iso
        ),
        0
      );
    }
    note('execution_contexts', drop('execution_contexts', 'issued_at >= ?', iso), 0);
    note('sources', drop('sources', 'recorded_at >= ?', iso), 0);
    note('claims', drop('claims', 'COALESCE(created_at, first_seen_at) >= ?', iso), 0);
    // The start row of the turn the copy is cut for is written at the moment itself and stays: the replay reads it.
    if (keepTurn !== null)
      note('day', drop('day', "at >= ? AND NOT (what = 'turn.start' AND turn_id IS ?)", iso, keepTurn), 0);
    for (const { table, column, ms } of DATED) {
      if (!tables.has(table) || (table === 'day' && keepTurn !== null)) continue;
      note(table, drop(table, `"${column}" >= ?`, ms ? at : iso), 0);
    }
    for (const table of RETIRED) {
      if (!tables.has(table)) continue;
      note(table, 0, run(`UPDATE "${table}" SET retired_at = NULL WHERE retired_at >= ?`, iso));
    }
    note('graph_edges', 0, run('UPDATE graph_edges SET valid_to_at = NULL WHERE valid_to_at >= ?', iso));
    // Twice: a row deleted on the first pass may hold rows of its own (a claim's versions hold their sources).
    for (let pass = 0; pass < 2; pass += 1) {
      for (const { table, column, owner, key, where } of HANGING) {
        if (!tables.has(table) || !tables.has(owner)) continue;
        const gone = `"${column}" IN (SELECT value FROM temp.cut_gone WHERE owner = ? AND key = ?)`;
        note(table, drop(table, where ? `${where} AND ${gone}` : gone, owner, key), 0);
      }
    }
    note(
      'claims',
      0,
      run(
        `UPDATE claims SET text = (SELECT v.text FROM claim_versions v WHERE v.claim_id = claims.id
             ORDER BY v.recorded_at DESC, v.rowid DESC LIMIT 1)
         WHERE id IN (SELECT value FROM temp.cut_gone WHERE owner = 'claim_versions' AND key = 'claim_id')
           AND EXISTS (SELECT 1 FROM claim_versions v WHERE v.claim_id = claims.id)
           AND text IS NOT (SELECT v.text FROM claim_versions v WHERE v.claim_id = claims.id
             ORDER BY v.recorded_at DESC, v.rowid DESC LIMIT 1)`
      )
    );
    note(
      'claims',
      0,
      run(
        `UPDATE claims SET superseded_by = NULL
         WHERE superseded_by IN (SELECT value FROM temp.cut_gone WHERE owner = 'claims' AND key = 'id')`
      )
    );
    note(
      'descriptions',
      0,
      run(
        `UPDATE descriptions SET current_version = (SELECT v.id FROM description_versions v
             WHERE v.description_id = descriptions.id ORDER BY v.written_at DESC, v.rowid DESC LIMIT 1)
         WHERE current_version IN (SELECT value FROM temp.cut_gone WHERE owner = 'description_versions' AND key = 'id')
           AND EXISTS (SELECT 1 FROM description_versions v WHERE v.description_id = descriptions.id)`
      )
    );
    note(
      'descriptions',
      run(
        `DELETE FROM descriptions WHERE current_version IN (SELECT value FROM temp.cut_gone WHERE owner = 'description_versions' AND key = 'id')`
      ),
      0
    );
    note('media', 0, run('UPDATE media SET description = NULL, described_at = NULL WHERE described_at >= ?', iso));
    note('episodes', 0, run('UPDATE episodes SET feeling = NULL, feeling_at = NULL WHERE feeling_at >= ?', iso));
    note(
      'people',
      0,
      run(
        `UPDATE people SET affinity = (SELECT e.score FROM affinity_events e WHERE e.person_id = people.id
             AND e.retired_at IS NULL ORDER BY e.at DESC, e.rowid DESC LIMIT 1)
         WHERE id IN (SELECT value FROM temp.cut_gone WHERE owner = 'affinity_events' AND key = 'person_id')
           AND EXISTS (SELECT 1 FROM affinity_events e WHERE e.person_id = people.id AND e.retired_at IS NULL)
           AND affinity IS NOT (SELECT e.score FROM affinity_events e WHERE e.person_id = people.id
             AND e.retired_at IS NULL ORDER BY e.at DESC, e.rowid DESC LIMIT 1)`
      )
    );
    db.exec('COMMIT');
  } catch (error) {
    db.exec('ROLLBACK');
    throw error;
  } finally {
    for (const guard of guards) db.exec(guard.sql);
    db.exec('PRAGMA foreign_keys = ON');
  }
  return [...counts.values()].filter((count) => count.removed > 0 || count.restored > 0);
}

/** Whether a process is running under `pid`. */
function pidAlive(pid: unknown): boolean {
  if (typeof pid !== 'number' || !Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException | null)?.code === 'EPERM';
  }
}

/** Refuses a folder whose `memory.db.lock` names a live process. */
function refuseLive(dir: string, alive: (pid: unknown) => boolean): void {
  const file = path.join(dir, 'memory.db.lock');
  if (!fs.existsSync(file)) return;
  let pid: unknown = null;
  try {
    pid = (JSON.parse(fs.readFileSync(file, 'utf8')) as { pid?: unknown }).pid;
  } catch {
    return;
  }
  if (alive(pid)) throw new Error(`turn-cut: ${dir} is held by the live process ${String(pid)}; copy it when quiet`);
}

/** The database files a copy never takes as files: the database itself, its journal and its lock. */
const DB_FILES = /^memory\.db(?:-wal|-shm|-journal|\.lock)?$/;

/** The start of `turnId` as the `day` table of `db` holds it, in milliseconds. */
export function turnStartOf(db: Db, turnId: string): number {
  const row = db
    .prepare("SELECT at FROM day WHERE what = 'turn.start' AND turn_id = ? ORDER BY at LIMIT 1")
    .get(turnId);
  const at = typeof row?.at === 'string' ? Date.parse(row.at) : Number.NaN;
  if (!Number.isFinite(at)) throw new Error(`turn-cut: the day table holds no turn.start for ${turnId}`);
  return at;
}

/**
 * Writes `into`, a copy of the data folder `from` with its memory cut at the start of `turnId` (see the head of this
 * file). Returns the moment and what the cut changed.
 */
export function cutCopy({
  from,
  into,
  turnId,
  alive = pidAlive,
}: {
  from: string;
  into: string;
  turnId: string;
  alive?: (pid: unknown) => boolean;
}): { at: number; counts: Array<CutCount> } {
  if (fs.existsSync(into)) throw new Error(`turn-cut: ${into} exists; name a new folder`);
  refuseLive(from, alive);
  const sourceDb = path.join(from, 'memory.db');
  if (!fs.existsSync(sourceDb)) throw new Error(`turn-cut: no memory.db in ${from}`);
  const source = new DatabaseSync(sourceDb, { readOnly: true });
  let at: number;
  try {
    at = turnStartOf(source, turnId);
    fs.mkdirSync(into, { recursive: true });
    fs.cpSync(from, into, {
      recursive: true,
      filter: (file) => path.dirname(file) !== from || !DB_FILES.test(path.basename(file)),
    });
    refuseLive(into, alive);
    source.exec(`VACUUM INTO '${path.join(into, 'memory.db').replaceAll("'", "''")}'`);
  } finally {
    source.close();
  }
  const target = new DatabaseSync(path.join(into, 'memory.db'));
  try {
    return { at, counts: cutMemory(target, at, { keepTurn: turnId }) };
  } finally {
    target.close();
  }
}
