// The watcher as the owner reaches it under `/doctor watcher`: `run` claims one run (src/watcher/lifecycle.ts) and starts
// the oneshot unit `neptunia-watcher.service` with `systemctl start --no-block`, whose worker adopts the claim, so closing
// the terminal stops nothing; `stop` writes `stopping` into the run, which the worker reads; `list` shows every run and
// every older report with its number, dates and state; `read` and `<n>` open one report with its dates. bin/neptunia.ts
// runs all five in the command line, with the core up or down, since the core cannot `sudo`. A number is the place in the
// order of the starts, the oldest first, so a later run never changes it. A report from before run records has no start
// time and goes by its day. Every answer names times in UTC to the minute. Nothing here asks a model.

import { startWorker } from '../service/manager.ts';
import type { Environment, RunManager } from '../service/manager.ts';
import { WATCHER_RUN_TIMEOUT_MS, allRuns, claimRun, finishRun, requestCancel } from './lifecycle.ts';
import type { RunRecord, RunState, RunStore } from './lifecycle.ts';
import { readReport, readReportRun, reportDays, reportVersions } from './read.ts';

export type DoctorAnswer = { text: string; status: 'ok' | 'failed' };
export type WatcherPlace = { store: RunStore; reportsDir: string };
/** Starts the worker of one claimed run: null when it started, else the reason. */
export type StartWorker = (runId: string) => string | null | Promise<string | null>;

/** One line of the list: a run, or a report written before run records. */
type Entry = {
  number: number;
  runId: string | null;
  day: string;
  state: RunState;
  code: string | null;
  startedAt: number | null;
  finishedAt: number | null;
};

const minute = (at: number): string => `${new Date(at).toISOString().slice(0, 16).replace('T', ' ')} UTC`;
const startOf = (entry: Entry): string => (entry.startedAt === null ? entry.day : minute(entry.startedAt));
const finishOf = (entry: Entry): string => (entry.finishedAt === null ? '-' : minute(entry.finishedAt));
const stateOf = (entry: Entry): string => (entry.code === null ? entry.state : `${entry.state} (${entry.code})`);
const sortKey = (entry: Omit<Entry, 'number'>): number => entry.startedAt ?? Date.parse(`${entry.day}T00:00:00Z`);

/** Every run and every report without a run record, numbered from the oldest. */
function entriesOf(place: WatcherPlace): Array<Entry> {
  const runs = allRuns(place.store);
  const known = new Set(runs.map((run) => run.runId));
  const ofRun = (run: RunRecord): Omit<Entry, 'number'> => ({
    runId: run.runId,
    day: run.day,
    state: run.state,
    code: run.code,
    startedAt: run.claimedAt,
    finishedAt: run.finishedAt,
  });
  const versions = reportVersions(place.reportsDir).filter((one) => !known.has(one.runId));
  const versioned = new Set(versions.map((one) => one.runId));
  const older = [
    ...versions.map((one) => ({ runId: one.runId, day: one.day, finishedAt: one.at > 0 ? one.at : null })),
    // A day file that is no link to a version is a report from before versions.
    ...reportDays(place.reportsDir)
      .filter((day) => {
        const read = readReport(place.reportsDir, day);
        return read.ok && read.report.runId === undefined && !versioned.has(`legacy-${day}`);
      })
      .map((day) => ({ runId: null, day, finishedAt: null })),
  ].map((one) => ({ ...one, state: 'succeeded' as const, code: null, startedAt: null }));
  return [...older, ...runs.map(ofRun)]
    .sort((a, b) => sortKey(a) - sortKey(b))
    .map((entry, index) => ({ ...entry, number: index + 1 }));
}

const numberOf = (place: WatcherPlace, runId: string): number =>
  entriesOf(place).find((entry) => entry.runId === runId)?.number ?? 0;

/** The text of an entry's report, or null when its run wrote none. */
function reportOf(place: WatcherPlace, entry: Entry): string | null {
  const read =
    entry.runId === null ? readReport(place.reportsDir, entry.day) : readReportRun(place.reportsDir, entry.runId);
  return read.ok ? read.report.text : null;
}

/** `run`: one run claimed and its worker started, or the run already going. A start refused fails the run at once. */
export async function watcherRun(place: WatcherPlace & { start: StartWorker }): Promise<DoctorAnswer> {
  const { claimed, run } = claimRun(place.store, {
    source: 'manual',
    owner: null,
    timeoutMs: WATCHER_RUN_TIMEOUT_MS,
  });
  const started = minute(run.claimedAt);
  if (!claimed) {
    return { text: `report ${numberOf(place, run.runId)} is ${run.state}, started ${started}`, status: 'ok' };
  }
  const refused = await place.start(run.runId);
  if (refused !== null) {
    finishRun(place.store, run.runId, { state: 'failed', code: 'start-failed', detail: refused });
    return { text: `the watcher's worker did not start: ${refused}`, status: 'failed' };
  }
  return { text: `report ${numberOf(place, run.runId)} started ${started}`, status: 'ok' };
}

/** `stop`: the running run asked to end; nothing running is an answer too. */
export function watcherStop(place: WatcherPlace): DoctorAnswer {
  const run = requestCancel(place.store);
  if (run === null) return { text: 'no watcher run is going', status: 'ok' };
  return {
    text: `report ${numberOf(place, run.runId)} is ${run.state}, started ${minute(run.claimedAt)}`,
    status: 'ok',
  };
}

/** `list`: every entry, the newest first. */
export function watcherList(place: WatcherPlace): DoctorAnswer {
  const entries = entriesOf(place).reverse();
  if (entries.length === 0) return { text: 'no watcher report yet', status: 'ok' };
  const width = String(entries[0]?.number ?? 0).length;
  const lines = entries.map(
    (entry) =>
      `${String(entry.number).padStart(width)}  ${stateOf(entry)}  started ${startOf(entry)}  finished ${finishOf(entry)}`
  );
  return { text: lines.join('\n'), status: 'ok' };
}

/** `read` and `<n>`: one report under its number and dates. */
export function watcherOpen(place: WatcherPlace, which: 'latest' | number): DoctorAnswer {
  const entries = entriesOf(place);
  const entry =
    which === 'latest'
      ? entries.findLast((one) => one.state === 'succeeded' && reportOf(place, one) !== null)
      : entries[which - 1];
  if (entry === undefined) {
    return { text: which === 'latest' ? 'no watcher report yet' : `no report ${which}`, status: 'failed' };
  }
  const text = reportOf(place, entry);
  if (text === null) return { text: `report ${entry.number} has no text: it ${stateOf(entry)}`, status: 'failed' };
  const head = [
    `report ${entry.number}  ${stateOf(entry)}`,
    `started ${startOf(entry)}`,
    `finished ${finishOf(entry)}`,
  ];
  return { text: [...head, '', text].join('\n'), status: 'ok' };
}

/** The starter of the watcher's unit, through the manager of the install's scope (src/service/manager.ts). */
export const unitStarter =
  (manager: { run: RunManager; env: Environment }): StartWorker =>
  () =>
    startWorker(manager.run, manager.env);

/** One `/doctor watcher` command by its parsed name. `run` needs a starter; without one it is refused and claims nothing. */
export function watcherDoctor(
  name: string,
  args: Readonly<Record<string, unknown>>,
  place: WatcherPlace & { start?: StartWorker }
): DoctorAnswer | Promise<DoctorAnswer> {
  switch (name) {
    case 'doctor.watcher.run':
      return place.start === undefined
        ? {
            text: 'a watcher report starts from the neptunia command line, which asks the service manager',
            status: 'failed',
          }
        : watcherRun({ ...place, start: place.start });
    case 'doctor.watcher.stop':
      return watcherStop(place);
    case 'doctor.watcher.list':
      return watcherList(place);
    case 'doctor.watcher.read':
      return watcherOpen(place, 'latest');
    default:
      return watcherOpen(place, Number(args.number));
  }
}
