// The rewrite of the stored log of requests `model_requests` and the recall traces, the `recall_trace` rows of
// `operational`, to stable names, run by scripts/stable-names-rewrite.ts after the main plan of stable-names-rewrite.ts.
// The log is large, so `planLogBatches` reads each table by key, at most `batchSize` rows at a time, and yields one plan
// per batch in the shape of a plan of `planStableNamesRewrite`. The write kind `stable-names-rewrite` applies each with
// its stale check. Each batch reads the names as they stand after the batches before it. A request keeps its structure
// and keys: only its strings take the forms of stable-names-texts.ts. A run stopped between batches and run again
// finishes the rest, since a rewritten row plans no cell.

import { logResolverOf, tablesOf } from './stable-names-rewrite.ts';
import type { Choice, StableNamesPlan } from './stable-names-rewrite.ts';
import { LOG_COLUMNS, logCell } from './stable-names-texts.ts';
import type { Cell } from './stable-names-texts.ts';
import type { Db, Row } from './types.ts';

type LogTable = { table: string; key: string; filter: string; first: string | number };

/** The log tables, each read in order of its key from a value below every key. */
const LOG_TABLES: ReadonlyArray<LogTable> = [
  { table: 'model_requests', key: 'id', filter: '', first: '' },
  { table: 'operational', key: 'rowid', filter: "kind = 'recall_trace' AND ", first: -1 },
];

type Options = { batchSize: number; choose?: Choice; markupIface?: string | null };

/** The cells one batch of rows changes. */
function batchPlan(db: Db, rows: ReadonlyArray<Row>, table: string, options: Options): StableNamesPlan {
  const { resolver, issue, issued, left } = logResolverOf(db, options);
  const cells: Array<Cell> = [];
  for (const row of rows)
    for (const target of LOG_COLUMNS.filter((one) => one.table === table)) {
      const { column } = target;
      const from = row[column];
      if (typeof from !== 'string') continue;
      const to = logCell(target, from, resolver);
      if (to !== from) cells.push({ table, column, id: String(row.key), from, to });
    }
  const plan = { issue, twins: [], lines: [], media: [], cells, ties: [], rewritten: [] };
  const counts = {
    lines: 0,
    rewritten: 0,
    tokens: 0,
    media: 0,
    untied: 0,
    issue: issued,
    left,
    tables: tablesOf(plan),
  };
  return { ...plan, counts };
}

/**
 * One plan per batch of at most `batchSize` rows of the log tables, read by key. The caller applies each plan before it
 * asks for the next. `choose` and `markupIface` are those of `planStableNamesRewrite`.
 */
export function* planLogBatches(db: Db, options: Options): Generator<StableNamesPlan> {
  for (const { table, key, filter, first } of LOG_TABLES) {
    const columns = [...new Set(LOG_COLUMNS.filter((one) => one.table === table).map((one) => one.column))];
    const page = db.prepare(
      `SELECT ${key} AS key, ${columns.join(', ')} FROM ${table} WHERE ${filter}${key} > ? ORDER BY ${key} LIMIT ?`
    );
    let after: unknown = first;
    for (;;) {
      const rows = page.all(after, options.batchSize);
      if (rows.length === 0) break;
      after = rows[rows.length - 1].key;
      yield batchPlan(db, rows, table, options);
    }
  }
}
