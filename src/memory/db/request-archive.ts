// The durable record of every model request: table `model_requests`, one row per request with its whole system text, its
// messages, its answer and its result. Pictures stay markers (src/llm/archive.ts), the media tables hold what was kept
// of them. The row is written before the request goes out, as `pending`, and closed afterwards; a process that dies in
// between leaves it `pending`, and the next open marks it `unknown`. No answer is invented and nothing is sent again.
// The table has no index into recall, so ordinary search never reads it. Written through the memory writer.

import type { Db, MemoryHandle } from './types.ts';
import { dbOf } from './types.ts';

type Row = Record<string, unknown>;

export const REQUEST_RECORD_VERSION = 1;

const COLUMNS = [
  'id',
  'schema_version',
  'turn_id',
  'attempt_id',
  'step',
  'role',
  'model',
  'purpose',
  'status',
  'started_at',
  'finished_at',
  'system_text',
  'messages',
  'tools',
  'tool_choice',
  'response_text',
  'think',
  'tool_calls',
  'usage',
  'error_code',
  'source',
  'service',
  'backend',
  'run_id',
  'blocks',
] as const;

const iso = (at: unknown): string => new Date(typeof at === 'number' ? at : Date.now()).toISOString();

function insert(db: Db, record: Row): number {
  const placeholders = COLUMNS.map(() => '?').join(', ');
  const values = COLUMNS.map((column) => (record[column] ?? null) as never);
  return Number(
    db.prepare(`INSERT OR IGNORE INTO model_requests (${COLUMNS.join(', ')}) VALUES (${placeholders})`).run(...values)
      .changes
  );
}

/** The row of the one request a memory session run makes; `session-write.ts` links its outcome by this id. */
export const sessionRequestId = (runId: string): string => `request:${runId}`;

/** What a request led to, on its row: read by the watcher (src/watcher/requests.ts). No row, no change. */
export function setRequestOutcome(db: Db, id: unknown, outcome: unknown): number {
  const result = db.prepare('UPDATE model_requests SET outcome = ? WHERE id = ?').run(JSON.stringify(outcome), id);
  return Number(result.changes);
}

/** One archive write on the writer connection: `start`, `finish`, `outcome` or `interrupt`. */
export function applyRequestArchiveWrite(handle: MemoryHandle, update: Row): { changed: number } {
  return handle.transaction(() => {
    const db = dbOf(handle);
    if (update.op === 'start') {
      const record = update.record as Row;
      return {
        changed: insert(db, {
          ...record,
          schema_version: REQUEST_RECORD_VERSION,
          status: 'pending',
          started_at: iso(record.at),
        }),
      };
    }
    if (update.op === 'finish') {
      const result = db
        .prepare(
          `UPDATE model_requests SET status = ?, finished_at = ?, response_text = ?, think = ?, tool_calls = ?, usage = ?,
           error_code = ?, model = COALESCE(?, model), backend = COALESCE(?, backend), source = COALESCE(?, source)
           WHERE id = ? AND status = 'pending'`
        )
        .run(
          update.status,
          iso(update.at),
          update.response_text ?? null,
          update.think ?? null,
          update.tool_calls ?? null,
          update.usage ?? null,
          update.error_code ?? null,
          update.model ?? null,
          update.backend ?? null,
          update.source ?? null,
          update.id
        );
      return { changed: Number(result.changes) };
    }
    if (update.op === 'outcome') return { changed: setRequestOutcome(db, update.id, update.outcome) };
    if (update.op === 'interrupt') {
      const result = db
        .prepare("UPDATE model_requests SET status = 'unknown', finished_at = ? WHERE status = 'pending'")
        .run(iso(update.at));
      return { changed: Number(result.changes) };
    }
    throw Object.assign(new Error('BAD_UPDATE'), { code: 'BAD_UPDATE' });
  });
}

/** Every record in the order they started; the owner's and the tests' read, never a turn's. */
export function readRequests(db: Db): Array<Row> {
  return db.prepare('SELECT * FROM model_requests ORDER BY started_at, rowid').all();
}

/** At open: what a dead process left `pending` becomes `unknown`. */
export function recoverRequestArchive(handle: MemoryHandle, { now = Date.now() }: { now?: number } = {}): void {
  applyRequestArchiveWrite(handle, { op: 'interrupt', at: now });
}
