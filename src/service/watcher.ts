// The watcher agent's reads of the `services` family (src/service/commands.ts), `evidence` and `select`. Both work with no
// core, and neither asks a model. `evidence` opens the memory database read-only, runs only
// reads and asks no model: it is the bounded path by which the watcher agent reads what the services asked and answered,
// what is left over (src/watcher/trash.ts) and what the analyzer did (src/watcher/analyzer-facts.ts). `select` runs one
// read-only statement of the agent's over the same kind of connection (src/watcher/select.ts).

import fs from 'node:fs';
import path from 'node:path';
import { readPrompts } from '../hot.ts';
import { auditMemory, auditSettingsOf } from '../memory/db/audit.ts';
import { openMemoryDb } from '../memory/db/open.ts';
import { dbOf } from '../memory/db/types.ts';
import { subharnessPlace } from '../subharness/place.ts';
import { readSessionMap } from '../subharness/sessions.ts';
import { analyzerFacts } from '../watcher/analyzer-facts.ts';
import { currentRun, lastRuns, runStoreOf } from '../watcher/lifecycle.ts';
import { reportsDirOf, watcherDir } from '../watcher/read.ts';
import {
  WATCHER_EVIDENCE_MAX_CHARS,
  mirrorFacts,
  observationInterval,
  readArchiveGaps,
  readRecordedRuns,
  selfreflectionFacts,
  taskOutcomes,
  standardFacts,
} from '../watcher/requests.ts';
import type { RecordedRunPage } from '../watcher/requests.ts';
import { maskCredentials } from '../watcher/report.ts';
import { selectRefusal, selectRows } from '../watcher/select.ts';
import { readTranscriptRuns } from '../watcher/transcripts.ts';
import { collectTrash } from '../watcher/trash.ts';
import { readRouteFacts } from '../watcher/routes.ts';
import type { Trash } from '../watcher/trash.ts';
import type { ServiceAnswer, ServiceDeps } from './commands.ts';
import { unitFolder, unitScope } from './manager.ts';

const iso = (moment: number): string => new Date(moment).toISOString();
const failed = (text: string): ServiceAnswer => ({ text, status: 'failed' });

const reportsDir = (deps: ServiceDeps): string => reportsDirOf(deps.privateDir, watcherDir(deps.config()));
const storeOf = (deps: ServiceDeps) => runStoreOf(path.dirname(reportsDir(deps)), () => deps.now());

const EVIDENCE_CURSOR = /^(\d+)\.(\d+)\.(\d+)$/;

/** The board's tables migrate apart from the memory's: a board that is down leaves the session unlinked. */
function taskOf(db: Parameters<typeof taskOutcomes>[0], runId: string): ReturnType<typeof taskOutcomes> {
  try {
    return taskOutcomes(db, runId);
  } catch {
    return null;
  }
}

/** What the memory database holds of the window, or the gap of a database that cannot be read. */
function recordedPage(
  deps: ServiceDeps,
  query: { from: number; to: number; offset: number; excludeRunId: string | null }
): { page: RecordedRunPage; tasks: (runId: string) => ReturnType<typeof taskOutcomes> } {
  const none = (): ReturnType<typeof taskOutcomes> => null;
  const gone: RecordedRunPage = {
    runs: [],
    totalRuns: 0,
    examinedRuns: 0,
    unreviewedRuns: 0,
    inFlightRuns: 0,
    nextCursor: null,
    gaps: [{ kind: 'memory-unavailable' }],
  };
  const file = path.join(deps.dataDir, 'memory.db');
  if (!fs.existsSync(file)) return { page: gone, tasks: none };
  let handle: ReturnType<typeof openMemoryDb> | null = null;
  try {
    handle = openMemoryDb(file, { readOnly: true });
    const db = dbOf(handle);
    const page = readRecordedRuns(db, {
      from: query.from,
      to: query.to,
      maxChars: WATCHER_EVIDENCE_MAX_CHARS,
      cursor: String(query.offset),
      excludeRunId: query.excludeRunId,
      archiveGaps: readArchiveGaps(deps.privateDir),
    });
    const known = new Map<string, ReturnType<typeof taskOutcomes>>();
    const tasks = (runId: string): ReturnType<typeof taskOutcomes> => known.get(runId) ?? null;
    for (const row of readSessionMap(deps.privateDir)) {
      if (row.runId !== null) known.set(row.runId, taskOf(db, row.runId));
    }
    return { page, tasks };
  } catch {
    return { page: gone, tasks: none };
  } finally {
    handle?.close();
  }
}

/** What `read` makes of a read-only connection to the memory of `dataDir`; null when it cannot be read. */
function readMemoryAt<TResult>(dataDir: string, read: (db: ReturnType<typeof dbOf>) => TResult): TResult | null {
  const file = path.join(dataDir, 'memory.db');
  if (!fs.existsSync(file)) return null;
  let handle: ReturnType<typeof openMemoryDb> | null = null;
  try {
    handle = openMemoryDb(file, { readOnly: true });
    return read(dbOf(handle));
  } catch {
    return null;
  } finally {
    handle?.close();
  }
}

const readMemory = <TResult>(deps: ServiceDeps, read: (db: ReturnType<typeof dbOf>) => TResult): TResult | null =>
  readMemoryAt(deps.dataDir, read);

/** What only the first page of a walk carries, read once per walk: the leftovers, the core's degraded routes, the mirrors, the selfreflection's facts, the standards and the audit. */
async function firstPageFacts(deps: ServiceDeps, window: { from: number; to: number }) {
  return {
    trash: await trashOf(deps),
    routes: await readRouteFacts({ run: deps.run, env: deps.env, now: deps.now(), window, config: deps.config() }),
    mirrors: readMemory(deps, mirrorFacts),
    selfreflection: readMemory(deps, selfreflectionFacts),
    standards: readMemory(deps, (db) => standardFacts(db, window)),
    audit: readMemory(deps, (db) => auditMemory(db, auditSettingsOf(deps.config()))),
    analyzer: readMemory(deps, (db) =>
      analyzerFacts(db, window, { config: deps.config(), prompts: readPrompts(deps.rootDir, deps.privateDir) })
    ),
  };
}

/** The leftovers of the install and of the system. */
function trashOf(deps: ServiceDeps): Promise<Trash> {
  return collectTrash({
    installDir: deps.rootDir,
    unitDir: unitFolder(deps.env),
    env: { ...deps.env, NEPTUNIA_UNIT_SCOPE: unitScope(deps.env) },
    run: deps.run,
  });
}

/** The flags of `evidence`, or the line that refuses them. */
function evidenceFlags(
  args: Readonly<Record<string, unknown>>
): { from: number | null; to: number | null; records: number; sessions: number } | string {
  const from = args.from === undefined ? null : typeof args.from === 'string' ? Date.parse(args.from) : NaN;
  if (from !== null && Number.isNaN(from)) return 'services watcher evidence: --from takes a date';
  if (args.cursor === undefined) return { from, to: null, records: 0, sessions: 0 };
  const cursor = typeof args.cursor === 'string' ? EVIDENCE_CURSOR.exec(args.cursor) : null;
  if (cursor === null) return 'services watcher evidence: --cursor takes the nextCursor of an earlier page';
  return { from, to: Number(cursor[1]), records: Number(cursor[2]), sessions: Number(cursor[3]) };
}

/** Records first, then sessions: while records are left, the page holds no session and the sessions' place stays. */
function joinPages(
  window: { from: number; to: number },
  records: RecordedRunPage,
  sessions: RecordedRunPage,
  at: number
) {
  const moved = records.nextCursor === null;
  const examined = records.examinedRuns + (moved ? sessions.examinedRuns : at);
  const total = records.totalRuns + sessions.totalRuns;
  const next = moved ? (sessions.nextCursor ?? String(sessions.totalRuns)) : String(at);
  return {
    interval: { from: iso(window.from), to: iso(window.to) },
    runs: [...records.runs, ...(moved ? sessions.runs : [])],
    totalRuns: total,
    examinedRuns: examined,
    unreviewedRuns: total - examined,
    inFlightRuns: records.inFlightRuns,
    nextCursor:
      moved && sessions.nextCursor === null
        ? null
        : `${window.to}.${records.nextCursor ?? records.examinedRuns}.${next}`,
    gaps: [...records.gaps, ...(moved ? sessions.gaps : [])],
  };
}

/**
 * `evidence [--from <iso>] [--cursor <c>]`: the recorded requests, then the Claude transcripts, of the window from the last
 * successful inspection (or `--from`) to now, under `WATCHER_EVIDENCE_MAX_CHARS`, as JSON. The cursor pins the end of the window,
 * so a walk over pages reads one fixed set of runs. The inspection in progress and its session are left out. The first page,
 * the one with no cursor, also carries `trash`, `mirrors`, `selfreflection`, `standards` and `audit`.
 */
export async function watcherEvidence(
  deps: ServiceDeps,
  args: Readonly<Record<string, unknown>>
): Promise<ServiceAnswer> {
  const flags = evidenceFlags(args);
  if (typeof flags === 'string') return { text: flags, status: 'invalid' };
  const store = storeOf(deps);
  const interval = observationInterval({
    now: flags.to ?? deps.now(),
    previousSuccessAt: lastRuns(store).lastSuccess?.finishedAt ?? null,
  });
  const window = { from: flags.from ?? interval.from, to: interval.to };
  const current = currentRun(store)?.runId ?? null;
  const sessions = readSessionMap(deps.privateDir);
  const recorded = recordedPage(deps, { ...window, offset: flags.records, excludeRunId: current });
  const recordedRuns = recorded.page.runs;
  const agents = new Map(sessions.map((row) => [row.sessionId, row]));
  const transcripts = readTranscriptRuns({
    home: path.join(subharnessPlace(deps.privateDir, 'claude').dir, 'home'),
    ...window,
    maxChars: Math.max(WATCHER_EVIDENCE_MAX_CHARS - JSON.stringify(recordedRuns).length, 0),
    fitOnly: recordedRuns.length > 0,
    cursor: String(flags.sessions),
    excludeSessions: sessions.filter((row) => current !== null && row.runId === current).map((row) => row.sessionId),
    attribute: (_project, session) => agents.get(session)?.agent ?? null,
    outcome: (session) => recorded.tasks(agents.get(session)?.runId ?? ''),
  });
  const page = joinPages(window, recorded.page, transcripts, flags.sessions);
  const first = flags.to === null ? await firstPageFacts(deps, window) : {};
  return { text: JSON.stringify({ ...page, ...first }), status: 'ok' };
}

/**
 * `select --sql <statement>`: the rows of one read-only statement over the live database as JSON, its text bounded, what looks
 * like a key masked. A statement that is no read is refused before the database is opened, and a read-only connection
 * refuses what slips past that. It opens no missing database, so it makes no file.
 */
export function watcherSelect(deps: ServiceDeps, args: Readonly<Record<string, unknown>>): ServiceAnswer {
  const { sql } = args;
  if (typeof sql !== 'string' || sql.trim() === '') {
    return { text: 'services watcher select: --sql takes one read-only statement', status: 'invalid' };
  }
  const refusal = selectRefusal(sql);
  if (refusal !== null) return failed(`services watcher select: ${refusal}`);
  const file = path.join(deps.dataDir, 'memory.db');
  if (!fs.existsSync(file)) return failed('services watcher select: no memory database');
  let handle: ReturnType<typeof openMemoryDb> | null = null;
  try {
    handle = openMemoryDb(file, { readOnly: true });
    return { text: selectRows(dbOf(handle), sql), status: 'ok' };
  } catch (error) {
    return failed(`services watcher select: ${maskCredentials((error as Error).message).text}`);
  } finally {
    handle?.close();
  }
}
