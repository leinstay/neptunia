// The task board's names in the memory database. Its four tables, `board_tasks`, `board_events`, `board_outbox` and
// `board_results`, hold the persona's errands (src/board/errands.ts) in the shape step 60 of src/memory/db/schema.ts gives them,
// and `board_schema_version` holds the version they had in the memory's baseline, which the memory handle reports
// (src/memory/db/open.ts). The tables are internal-only: no graph projection, recall, export or sync reads them.

// The connection the board needs: node:sqlite's DatabaseSync has every method named here.
export type BoardDb = {
  exec(sql: string): void;
  prepare(sql: string): {
    get(...params: Array<unknown>): Record<string, unknown> | undefined;
    all(...params: Array<unknown>): Array<Record<string, unknown>>;
    run(...params: Array<unknown>): { changes: number | bigint };
  };
};

/** The version `board_schema_version` holds: the board's tables are part of the memory's baseline at it. */
export const BOARD_VERSION = 3;

/** MAX(version) of `board_schema_version`; 0 when the table does not exist. */
export function boardVersion(db: BoardDb): number {
  const table = db
    .prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'board_schema_version'")
    .get();
  if (table === undefined) return 0;
  return Number(db.prepare('SELECT MAX(version) AS v FROM board_schema_version').get()?.v ?? 0);
}

export type BoardStatus = { ok: true; version: number } | { ok: false; version: number; error: string };
