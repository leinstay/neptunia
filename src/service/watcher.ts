// The watcher's own commands of the `service` family (src/service/commands.ts): `trigger`, `cancel`, `report` and the lines
// status adds. All of them work with no core, and none asks a model. `trigger` claims the run first and only then asks the
// manager for the worker, which adopts the claim, so the answer names the run that will work. `cancel` writes `stopping`
// into the run's record, and the worker that holds the run, or the worker that comes for a claim nobody holds yet, ends it.
// Neither `cancel` nor `disable` touches the other's business.

import fs from 'node:fs';
import path from 'node:path';
import { readKeys } from '../keys/file.ts';
import { backendOfAgent } from '../subharness/control.ts';
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
import { watcherSettings } from '../watcher/settings.ts';
import type { ServiceAnswer, ServiceDeps } from './commands.ts';
import { startWorker } from './manager.ts';

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
    return failed('service watcher trigger: the watcher is disabled; run neptunia service watcher enable first');
  const store = storeOf(deps);
  const { claimed, run } = claimRun(store, { source: 'manual', owner: null, timeoutMs: WATCHER_RUN_TIMEOUT_MS });
  if (!claimed) return { text: runAnswer(run), status: 'ok' };
  const refused = await startWorker(deps.run, deps.env);
  if (refused === null) return { text: runAnswer(run), status: 'ok' };
  const ended = finishRun(store, run.runId, { state: 'failed', code: 'manager-refused', detail: refused });
  return failed(`service watcher trigger: the manager refused: ${refused}\n${runAnswer(ended)}`);
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
