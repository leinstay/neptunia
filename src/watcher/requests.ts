// The watcher's read of what the services asked and answered, over `model_requests` (src/memory/db/request-archive.ts): the
// observation window on the engine clock, whole records paged under a bound, counts of what is left, and every gap named
// instead of filled in. It works on a read-only connection and changes nothing. Inspected text is evidence and never an
// instruction: a read masks what looks like a credential, and nothing here reconstructs a missing part from today's files.
// A run is one turn's attempt, or one `run_id`, or a request alone, and it belongs to the window its last step finished in.

import fs from 'node:fs';
import path from 'node:path';
import type { ArchiveWriteGap, RequestOutcome } from '../llm/archive.ts';
import type { Db } from '../memory/db/types.ts';
import { DAY_MS } from '../time.ts';
import { maskCredentials } from './report.ts';

export type { ArchiveWriteGap };

/** The most characters one page of evidence holds. A run larger than this comes alone and whole. */
export const WATCHER_EVIDENCE_MAX_CHARS = 50_000;

export type RecordedRequest = {
  id: string;
  service: string | null;
  runId: string | null;
  backend: string | null;
  model: string | null;
  effort: string | null;
  startedAt: string;
  finishedAt: string | null;
  status: string;
  errorCode: string | null;
  systemText: string | null;
  messages: string | null;
  tools: string | null;
  toolCalls: string | null;
  responseText: string | null;
  usage: string | null;
  outcome: RequestOutcome;
  gaps: Array<string>;
};
export type RecordedRun = { runKey: string; requests: Array<RecordedRequest> };
export type PageGap = { kind: string; requestId?: string; runKey?: string; count?: number; op?: string; at?: number };
export type RecordedRunPage = {
  runs: Array<RecordedRun>;
  totalRuns: number;
  examinedRuns: number;
  unreviewedRuns: number;
  inFlightRuns: number;
  nextCursor: string | null;
  gaps: Array<PageGap>;
};

type Row = Record<string, unknown>;
const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
const iso = (at: number): string => new Date(at).toISOString();

/** The window of an inspection: from the last successful one, else the start of the day, to now. */
export function observationInterval(input: { now: number; previousSuccessAt: number | null }): {
  from: number;
  to: number;
  dayFrom: number;
} {
  const dayFrom = Math.floor(input.now / DAY_MS) * DAY_MS;
  return { from: input.previousSuccessAt ?? dayFrom, to: input.now, dayFrom };
}

/** A cursor as an offset; null for no cursor. Throws for anything else. */
export function offsetOf(cursor: string | null | undefined): number {
  if (cursor === null || cursor === undefined) return 0;
  if (!/^\d+$/.test(cursor)) throw new RangeError('not a cursor');
  return Number(cursor);
}

/**
 * Fills a page from `keys` at `offset` under `maxChars`: `build` makes a run when its turn comes. The first run of a page comes
 * even when it alone is larger, unless `fitOnly`, because the caller's page already holds something.
 */
export function fillPage<TRun>(
  keys: ReadonlyArray<string>,
  input: { offset: number; maxChars: number; fitOnly?: boolean },
  build: (key: string) => TRun
): { runs: Array<TRun>; nextCursor: string | null; examined: number } {
  const runs: Array<TRun> = [];
  let used = 2;
  let at = input.offset;
  for (; at < keys.length; at += 1) {
    const run = build(keys[at] ?? '');
    const size = JSON.stringify(run).length + 1;
    const mayOverflow = runs.length === 0 && input.fitOnly !== true;
    if (used + size > input.maxChars && !mayOverflow) break;
    runs.push(run);
    used += size;
  }
  return { runs, nextCursor: at < keys.length ? String(at) : null, examined: at };
}

/** The masked fields of a request, and whether anything was masked. */
export function maskFields<TFields extends Record<string, string | null>>(
  fields: TFields
): { masked: boolean; fields: TFields } {
  let masked = false;
  const out: Record<string, string | null> = {};
  for (const [name, value] of Object.entries(fields)) {
    if (value === null) {
      out[name] = null;
      continue;
    }
    const clean = maskCredentials(value);
    if (clean.masked > 0) masked = true;
    out[name] = clean.text;
  }
  return { masked, fields: out as TFields };
}

const UNLINKED: RequestOutcome = { kind: 'none', state: 'unlinked', ref: null };

function outcomeOf(value: unknown): RequestOutcome {
  if (typeof value !== 'string') return UNLINKED;
  try {
    return JSON.parse(value) as RequestOutcome;
  } catch {
    return UNLINKED;
  }
}

function recordOf(row: Row): RecordedRequest {
  const { masked, fields } = maskFields({
    systemText: text(row.system_text),
    messages: text(row.messages),
    tools: text(row.tools),
    toolCalls: text(row.tool_calls),
    responseText: text(row.response_text),
    usage: text(row.usage),
  });
  const gaps: Array<string> = [];
  if (masked) gaps.push('credential-masked');
  if (fields.systemText === null) gaps.push('missing-system-text');
  if (fields.messages?.includes('"type":"image_marker"') === true) gaps.push('missing-media');
  if (fields.messages?.includes('"truncated":true') === true) gaps.push('truncated-tool-output');
  if (row.status === 'unknown' && fields.responseText === null) gaps.push('absent-response');
  if (row.source === 'subprocess') gaps.push('vendor-instructions', 'absent-transcript');
  return {
    id: String(row.id),
    service: text(row.service),
    runId: text(row.run_id),
    backend: text(row.backend),
    model: text(row.model),
    effort: null,
    startedAt: String(row.started_at),
    finishedAt: text(row.finished_at),
    status: String(row.status),
    errorCode: text(row.error_code),
    ...fields,
    outcome: outcomeOf(row.outcome),
    gaps,
  };
}

const IDENTITY = 'id, turn_id, attempt_id, service, run_id, status, started_at, finished_at';

function runKeyOf(row: Row): string {
  const turn = text(row.turn_id);
  if (turn !== null) return `turn:${turn}:${text(row.attempt_id) ?? ''}`;
  const run = text(row.run_id);
  if (run !== null) return `run:${text(row.service) ?? ''}:${run}`;
  return `request:${text(row.id) ?? ''}`;
}

/** The runs with a step in the window or still in flight, each with every one of its steps, wherever they fall. */
function candidateRuns(db: Db, fromIso: string, toIso: string): Map<string, Array<Row>> {
  const near = db
    .prepare(
      `SELECT ${IDENTITY} FROM model_requests WHERE (finished_at > ? AND finished_at <= ?) OR finished_at IS NULL`
    )
    .all(fromIso, toIso);
  const runs = new Map<string, Array<Row>>();
  for (const row of near) {
    const key = runKeyOf(row);
    const steps = runs.get(key) ?? [];
    steps.push(row);
    runs.set(key, steps);
  }
  for (const [key, steps] of runs) {
    const [first] = steps;
    if (first === undefined) continue;
    if (first.turn_id !== null) {
      runs.set(
        key,
        db
          .prepare(`SELECT ${IDENTITY} FROM model_requests WHERE turn_id = ? AND attempt_id IS ?`)
          .all(first.turn_id, first.attempt_id)
      );
    } else if (first.run_id !== null) {
      runs.set(
        key,
        db
          .prepare(`SELECT ${IDENTITY} FROM model_requests WHERE run_id = ? AND turn_id IS NULL AND service IS ?`)
          .all(first.run_id, first.service)
      );
    }
  }
  return runs;
}

/**
 * The page of the runs that finished in (`from`, `to`]. A pending row keeps its run out and counts it apart. `excludeRunId` is
 * the current inspection, which never reviews itself. `archiveGaps` are writes the archive reported lost.
 */
export function readRecordedRuns(
  db: Db,
  query: {
    from: number;
    to: number;
    maxChars: number;
    cursor?: string | null;
    excludeRunId?: string | null;
    archiveGaps?: ReadonlyArray<ArchiveWriteGap>;
  }
): RecordedRunPage {
  const fromIso = iso(query.from);
  const toIso = iso(query.to);
  const finished: Array<{ key: string; last: string; ids: Array<string> }> = [];
  let inFlightRuns = 0;
  for (const [key, steps] of candidateRuns(db, fromIso, toIso)) {
    if (steps.some((row) => query.excludeRunId != null && row.run_id === query.excludeRunId)) continue;
    if (steps.some((row) => row.status === 'pending')) {
      if (steps.some((row) => String(row.started_at) <= toIso)) inFlightRuns += 1;
      continue;
    }
    const last =
      steps
        .map((row) => String(row.finished_at ?? row.started_at))
        .sort()
        .at(-1) ?? '';
    if (last > fromIso && last <= toIso) finished.push({ key, last, ids: steps.map((row) => String(row.id)) });
  }
  finished.sort((a, b) => (a.last === b.last ? (a.key < b.key ? -1 : 1) : a.last < b.last ? -1 : 1));
  const byKey = new Map(finished.map((run) => [run.key, run.ids]));
  const offset = offsetOf(query.cursor);
  const { runs, nextCursor, examined } = fillPage(
    finished.map((run) => run.key),
    { offset, maxChars: query.maxChars },
    (runKey): RecordedRun => {
      const rows = (byKey.get(runKey) ?? []).flatMap((id) => {
        const row = db.prepare('SELECT rowid AS ord, * FROM model_requests WHERE id = ?').get(id);
        return row === undefined ? [] : [row];
      });
      rows.sort((a, b) => Number(a.step ?? 0) - Number(b.step ?? 0) || Number(a.ord) - Number(b.ord));
      return { runKey, requests: rows.map(recordOf) };
    }
  );
  const lost = new Map(
    (query.archiveGaps ?? [])
      .filter((gap) => gap.at > query.from && gap.at <= query.to)
      .map((gap): [string, PageGap] => [gap.requestId, { ...gap }])
  );
  return {
    runs,
    totalRuns: finished.length,
    examinedRuns: examined,
    unreviewedRuns: finished.length - examined,
    inFlightRuns,
    nextCursor,
    gaps: [...lost.values()],
  };
}

/** The day so far: the runs that finished between the start of `now`'s day and `now`. */
export function currentDayView(
  db: Db,
  query: { now: number; maxChars: number; cursor?: string | null }
): RecordedRunPage {
  const { dayFrom } = observationInterval({ now: query.now, previousSuccessAt: null });
  return readRecordedRuns(db, {
    from: dayFrom - 1,
    to: query.now,
    maxChars: query.maxChars,
    cursor: query.cursor ?? null,
  });
}

const CLOSED_WELL: ReadonlyArray<string> = ['done'];
const CLOSED_BADLY: ReadonlyArray<string> = ['failed', 'cancelled'];

/** What became of the board task named `runId`, read from the board's table: null when no task has that id. */
export function taskOutcomes(db: Db, runId: string): RequestOutcome | null {
  const row = db.prepare('SELECT status FROM board_tasks WHERE id = ?').get(runId);
  if (row === undefined) return null;
  const status = String(row.status);
  if (CLOSED_WELL.includes(status)) return { kind: 'task', state: 'confirmed', ref: runId };
  return { kind: 'task', state: CLOSED_BADLY.includes(status) ? 'failed' : 'open', ref: runId };
}

const gapsFile = (privateDir: string): string => path.join(privateDir, 'agents', 'watcher', 'archive-gaps.jsonl');

/** Appends a request the archive lost, for the next inspection. The gap holds ids and never content. Never throws. */
export function noteArchiveGap(privateDir: string, gap: ArchiveWriteGap): void {
  try {
    fs.mkdirSync(path.dirname(gapsFile(privateDir)), { recursive: true });
    fs.appendFileSync(gapsFile(privateDir), `${JSON.stringify(gap)}\n`);
  } catch {
    // A disk that refuses this too has refused the archive's own write, which the log already holds.
  }
}

/** Every lost request on file; none for a missing file. A torn line is skipped. */
export function readArchiveGaps(privateDir: string): Array<ArchiveWriteGap> {
  let lines: Array<string> = [];
  try {
    lines = fs.readFileSync(gapsFile(privateDir), 'utf8').split('\n');
  } catch {
    return [];
  }
  return lines.flatMap((line) => {
    try {
      return line.trim() === '' ? [] : [JSON.parse(line) as ArchiveWriteGap];
    } catch {
      return [];
    }
  });
}
