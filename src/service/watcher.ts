// The watcher's own commands of the `services` family (src/service/commands.ts): `trigger`, `cancel`, `evidence`, the report `/logs watcher` reads
// and the lines status adds. All of them work with no core, and none asks a model. `trigger` claims the run first and only then asks the
// manager for the worker, which adopts the claim, so the answer names the run that will work. `cancel` writes `stopping`
// into the run's record, and the worker that holds the run, or the worker that comes for a claim nobody holds yet, ends it.
// Neither `cancel` nor `disable` touches the other's business. `evidence` opens the memory database read-only, runs only
// reads and asks no model: it is the bounded path by which the watcher agent reads what the services asked and answered,
// and what is left over (src/watcher/trash.ts).

import fs from 'node:fs';
import path from 'node:path';
import { readKeys } from '../keys/file.ts';
import { openMemoryDb } from '../memory/db/open.ts';
import { dbOf } from '../memory/db/types.ts';
import { selfimprovementSettings } from '../selfimprovement/settings.ts';
import { backendOfAgent } from '../subharness/control.ts';
import { subharnessPlace } from '../subharness/place.ts';
import { readSessionMap } from '../subharness/sessions.ts';
import { readFilings } from '../watcher/filing.ts';
import {
  WATCHER_RUN_TIMEOUT_MS,
  claimRun,
  currentRun,
  finishRun,
  lastRuns,
  requestCancel,
  runStoreOf,
} from '../watcher/lifecycle.ts';
import type { RunRecord } from '../watcher/lifecycle.ts';
import { isDay, readReport, readReportRun, reportsDirOf, runLines, watcherDir } from '../watcher/read.ts';
import {
  WATCHER_EVIDENCE_MAX_CHARS,
  observationInterval,
  openTaskIds,
  readArchiveGaps,
  readRecordedRuns,
  taskOutcomes,
} from '../watcher/requests.ts';
import type { RecordedRunPage } from '../watcher/requests.ts';
import { watcherSettings } from '../watcher/settings.ts';
import { readTranscriptRuns } from '../watcher/transcripts.ts';
import { collectTrash } from '../watcher/trash.ts';
import type { Trash } from '../watcher/trash.ts';
import type { ServiceAnswer, ServiceDeps } from './commands.ts';
import { startWorker, unitFolder, unitScope } from './manager.ts';

const iso = (moment: number): string => new Date(moment).toISOString();
const failed = (text: string): ServiceAnswer => ({ text, status: 'failed' });

const reportsDir = (deps: ServiceDeps): string => reportsDirOf(deps.privateDir, watcherDir(deps.config()));
const storeOf = (deps: ServiceDeps) => runStoreOf(path.dirname(reportsDir(deps)), () => deps.now());

const runAnswer = (run: RunRecord | null): string => `run: ${run?.runId ?? 'none'}\nstate: ${run?.state ?? 'none'}`;

/** The folder the rendered unit keeps writable has to exist before its first start, so `enable` makes it. */
export function readyWatcherFolder(deps: ServiceDeps): void {
  try {
    fs.mkdirSync(reportsDir(deps), { recursive: true });
  } catch {
    // A folder this user cannot make shows when the worker first runs.
  }
}

/** One immediate inspection: refused while disabled, and answering the run in progress when there is one. */
export async function triggerWatcher(deps: ServiceDeps): Promise<ServiceAnswer> {
  if (!watcherSettings(deps.config()).enabled)
    return failed('services watcher trigger: the watcher is disabled; run neptunia services watcher enable first');
  const store = storeOf(deps);
  const { claimed, run } = claimRun(store, { source: 'manual', owner: null, timeoutMs: WATCHER_RUN_TIMEOUT_MS });
  if (!claimed) return { text: runAnswer(run), status: 'ok' };
  const refused = await startWorker(deps.run, deps.env);
  if (refused === null) return { text: runAnswer(run), status: 'ok' };
  const ended = finishRun(store, run.runId, { state: 'failed', code: 'manager-refused', detail: refused });
  return failed(`services watcher trigger: the manager refused: ${refused}\n${runAnswer(ended)}`);
}

/** Asks the run in progress to stop. Nothing to stop is an answer too, so a repeated cancel stays a success. */
export function cancelWatcher(deps: ServiceDeps): ServiceAnswer {
  return { text: runAnswer(requestCancel(storeOf(deps))), status: 'ok' };
}

/** `report [target]`: a day, a run identity, or the newest. */
export function watcherReport(deps: ServiceDeps, target: string | undefined): ServiceAnswer {
  const asRun = target !== undefined && !isDay(target) ? target : undefined;
  const day = asRun === undefined ? target : undefined;
  if (deps.report !== undefined) return deps.report(day, asRun);
  const dir = reportsDir(deps);
  const read = asRun === undefined ? readReport(dir, day) : readReportRun(dir, asRun);
  if (read.ok) return { text: [...runLines(dir, read.report), read.report.text].join('\n\n'), status: 'ok' };
  return failed(target === undefined ? 'no report yet' : `no report for ${target}`);
}

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

/** The ids of the open board tasks; null when the database or the board cannot be read. */
function openTasks(deps: ServiceDeps): Array<string> | null {
  const file = path.join(deps.dataDir, 'memory.db');
  if (!fs.existsSync(file)) return null;
  let handle: ReturnType<typeof openMemoryDb> | null = null;
  try {
    handle = openMemoryDb(file, { readOnly: true });
    return openTaskIds(dbOf(handle));
  } catch {
    return null;
  } finally {
    handle?.close();
  }
}

/** The leftovers of the install and of the development checkout the settings name, if they name one. */
function trashOf(deps: ServiceDeps): Promise<Trash> {
  return collectTrash({
    installDir: deps.rootDir,
    checkout: selfimprovementSettings(deps.config()).checkout,
    unitDir: unitFolder(deps.env),
    env: { ...deps.env, NEPTUNIA_PRIVATE_DIR: deps.privateDir, NEPTUNIA_UNIT_SCOPE: unitScope(deps.env) },
    run: deps.run,
    now: () => deps.now(),
    tasks: () => openTasks(deps),
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
 * the one with no cursor, also carries `trash`, read once per walk.
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
  const map = readSessionMap(deps.privateDir);
  const recorded = recordedPage(deps, { ...window, offset: flags.records, excludeRunId: current });
  const agents = new Map(map.map((row) => [row.sessionId, row]));
  const transcripts = readTranscriptRuns({
    home: path.join(subharnessPlace(deps.privateDir, 'claude').dir, 'home'),
    ...window,
    maxChars: Math.max(WATCHER_EVIDENCE_MAX_CHARS - JSON.stringify(recorded.page.runs).length, 0),
    fitOnly: recorded.page.runs.length > 0,
    cursor: String(flags.sessions),
    excludeSessions: map.filter((row) => current !== null && row.runId === current).map((row) => row.sessionId),
    attribute: (_project, session) => agents.get(session)?.agent ?? null,
    outcome: (session) => recorded.tasks(agents.get(session)?.runId ?? ''),
  });
  const page = joinPages(window, recorded.page, transcripts, flags.sessions);
  const trash = flags.to === null ? { trash: await trashOf(deps) } : {};
  return { text: JSON.stringify({ ...page, ...trash }), status: 'ok' };
}

/** The backend, model and effort the watcher runs on, `default` for what the backend picks, `unknown` with no backend. */
function sourceText(deps: ServiceDeps): string {
  try {
    const { subharness } = readKeys(deps.privateDir);
    const backend = backendOfAgent(subharness, 'watcher');
    if (backend === null) return 'unknown';
    return `${backend} ${subharness.models.watcher ?? 'default'} ${subharness.efforts.watcher ?? 'default'}`;
  } catch {
    return 'unknown';
  }
}

/** How the last report's drafts stand: the count per state, `none` when it had none. */
function filingText(deps: ServiceDeps, run: RunRecord | null): string {
  const states = run === null ? [] : readFilings(path.dirname(reportsDir(deps)), run.runId).map((one) => one.state);
  const counted = [...new Set(states)].map((state) => `${state} ${states.filter((one) => one === state).length}`);
  return counted.length === 0 ? 'none' : counted.join(', ');
}

/** The lines of the watcher's status that only its run records know. */
export function watcherStatusFields(deps: ServiceDeps): Array<readonly [string, string]> {
  const store = storeOf(deps);
  const current = currentRun(store);
  const { lastSuccess, lastFailure } = lastRuns(store);
  const at = (run: RunRecord): string => iso(run.finishedAt ?? run.claimedAt);
  return [
    ['current run', current === null ? 'none' : `${current.runId} ${current.state} ${current.source}`],
    ['last success', lastSuccess === null ? 'none' : `${lastSuccess.runId} ${at(lastSuccess)}`],
    [
      'last failure',
      lastFailure === null ? 'none' : `${lastFailure.runId} ${lastFailure.code ?? 'failed'} ${at(lastFailure)}`,
    ],
    ['filing', filingText(deps, lastSuccess)],
    ['source', sourceText(deps)],
    ['run timeout', `${WATCHER_RUN_TIMEOUT_MS / 60_000}m`],
  ];
}
