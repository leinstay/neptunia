// The durable record of every model request: table `model_requests`, one row per request with its whole system text, its
// messages, its answer and its result. Pictures stay markers (src/llm/archive.ts), the media tables hold what was kept
// of them. The row is written before the request goes out, as `pending`, and closed afterwards; a process that dies in
// between leaves it `pending`, and the next open marks it `unknown`. No answer is invented and nothing is sent again.
// The table has no index into recall, so ordinary search never reads it. Written through the memory writer. `importRequestDumps` reads the
// expiring dump files once and keeps what they say, a missing counterpart named in the row.

import { oldJournalDirs } from '../migration/old-journals.ts';
import fs from 'node:fs';
import path from 'node:path';
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
  'error_text',
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
           error_code = ?, error_text = ?, model = COALESCE(?, model), backend = COALESCE(?, backend), source = COALESCE(?, source)
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
          update.error_text ?? null,
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

function filesIn(dir: string): Array<string> {
  try {
    return fs.readdirSync(dir);
  } catch {
    return [];
  }
}

const attemptOf = (value: unknown): string | null =>
  typeof value === 'number' ? String(value) : typeof value === 'string' ? value : null;

function dumpRecord(body: Row, id: string, tools: unknown, toolsMissing: boolean): Row {
  const later: Array<unknown> = Array.isArray(body.later) ? body.later : [];
  return {
    id,
    schema_version: REQUEST_RECORD_VERSION,
    turn_id: body.turnId ?? null,
    attempt_id: attemptOf(body.attemptId),
    step: typeof body.step === 'number' ? body.step : 0,
    status: typeof body.raw === 'string' && body.raw !== '' ? 'ok' : 'unknown',
    started_at: typeof body.recordedAt === 'string' ? body.recordedAt : iso(0),
    finished_at: typeof body.recordedAt === 'string' ? body.recordedAt : null,
    system_text: typeof body.system === 'string' ? body.system : null,
    messages: JSON.stringify([{ role: 'user', content: body.parts ?? [] }, ...later]),
    tools: tools === undefined ? null : JSON.stringify(tools),
    tool_choice: typeof body.toolChoice === 'string' ? body.toolChoice : null,
    response_text: typeof body.raw === 'string' && body.raw !== '' ? body.raw : null,
    tool_calls: Array.isArray(body.toolCalls) ? JSON.stringify(body.toolCalls) : null,
    usage: body.usage === undefined || body.usage === null ? null : JSON.stringify(body.usage),
    error_code: toolsMissing ? 'tools-file-missing' : null,
    source: 'dump',
  };
}

/**
 * Reads the request dump files under `dataDir` into the table, once each: a dump's id is its path, so a second run adds
 * nothing. Files stay where they are. A dump whose shared tool file is gone keeps its row, with `tools-file-missing`,
 * and an unreadable dump is counted, not guessed at.
 */
export function importRequestDumps(
  handle: MemoryHandle,
  { dataDir }: { dataDir: string }
): { imported: number; broken: number } {
  const counts = { imported: 0, broken: 0 };
  for (const journal of oldJournalDirs(dataDir)) {
    const requests = path.join(journal, 'requests');
    for (const day of filesIn(requests)) {
      if (day === 'tools') continue;
      for (const name of filesIn(path.join(requests, day))) {
        if (!name.endsWith('.json')) continue;
        const file = path.join(requests, day, name);
        const id = `dump:${path.relative(dataDir, file)}`;
        try {
          const body = JSON.parse(fs.readFileSync(file, 'utf8')) as Row;
          let tools: unknown;
          let toolsMissing = false;
          if (typeof body.tools === 'string') {
            try {
              tools = JSON.parse(fs.readFileSync(path.join(requests, 'tools', `${body.tools}.json`), 'utf8'));
            } catch {
              toolsMissing = true;
            }
          }
          counts.imported += handle.transaction(() => insert(dbOf(handle), dumpRecord(body, id, tools, toolsMissing)));
        } catch {
          counts.broken += 1;
        }
      }
    }
  }
  return counts;
}

/** At open: what a dead process left `pending` becomes `unknown`, and the old dump files are read in once. */
export function recoverRequestArchive(
  handle: MemoryHandle,
  { dataDir, now = Date.now() }: { dataDir: string; now?: number }
): void {
  applyRequestArchiveWrite(handle, { op: 'interrupt', at: now });
  importRequestDumps(handle, { dataDir });
}
