// The watcher as the owner reaches it under `/doctor watcher`: `run` claims one run (src/watcher/lifecycle.ts) and starts
// `neptunia worker watcher` detached from the caller, so closing the terminal stops nothing, `stop` asks the running run to
// end, `list` shows every run and every older report with its number, dates and state, and `read` and `<n>` open one
// report with its dates. The console of the core (src/interface/commands/console.ts) answers `run`, since the core starts
// the worker; bin/neptunia.ts answers the others from the files, with the core up or down. A number is the place in the
// order of the starts, the oldest first, so a later run never changes it. `accepted`, `accept` and `unaccept` read and write
// the owner's list of accepted findings (src/watcher/accepted.ts) and answer in labels, also with the core up or down. A report from before run records has no start
// time and goes by its day. Every answer names times in UTC to the minute. Nothing here asks a model.

import { spawn as spawnChild } from 'node:child_process';
import path from 'node:path';
import { WATCHER_RUN_TIMEOUT_MS, allRuns, claimRun, finishRun, requestCancel, runStoreOf } from './lifecycle.ts';
import type { RunRecord, RunState, RunStore } from './lifecycle.ts';
import { fill } from '../format.ts';
import { acceptLine, acceptedLines, unacceptLine } from './accepted.ts';
import { DEFAULT_WATCHER_DIR, readReport, readReportRun, reportDays, reportVersions, reportsDirOf } from './read.ts';

export type DoctorAnswer = { text: string; status: 'ok' | 'failed' };
export type WatcherPlace = { store: RunStore; reportsDir: string };
/** The live labels (`hot.prompts.labels`), whose `watcher.accepted` section words the answers of the accepted list. */
export type AcceptedPlace = WatcherPlace & { labels?: unknown };
/** Starts the worker of one claimed run: null when it started, else the reason. */
export type StartWorker = (runId: string) => string | null;

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

/** The folder under the watcher's own that `GH_CONFIG_DIR` names: nothing ever writes a login there. */
const NO_GH_LOGIN = 'no-gh-login';

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

/** `run`: one run claimed and its worker started, or the run already going. */
export function watcherRun(place: WatcherPlace & { start: StartWorker }): DoctorAnswer {
  const { claimed, run } = claimRun(place.store, {
    source: 'manual',
    owner: null,
    timeoutMs: WATCHER_RUN_TIMEOUT_MS,
  });
  const started = minute(run.claimedAt);
  if (!claimed) {
    return { text: `report ${numberOf(place, run.runId)} is ${run.state}, started ${started}`, status: 'ok' };
  }
  const refused = place.start(run.runId);
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

/** The data folder of a place: the reports folder sits at `<data>/<watcher dir>/reports`. */
const dataDirOf = (place: WatcherPlace): string =>
  path.resolve(place.reportsDir, '..', ...DEFAULT_WATCHER_DIR.split('/').map(() => '..'));

/** `labels.watcher.accepted.<key>` filled with `values`; the key itself when a deployment's labels lack it. */
function acceptedLabel(place: AcceptedPlace, key: string, values: Record<string, string | number> = {}): string {
  let node: unknown = place.labels;
  for (const step of ['watcher', 'accepted', ...key.split('.')]) {
    node = typeof node === 'object' && node !== null ? (node as Record<string, unknown>)[step] : undefined;
  }
  return typeof node === 'string' ? fill(node, values) : key;
}

/** `accepted`: the list with a number per line, or that it is empty. */
export function watcherAccepted(place: AcceptedPlace): DoctorAnswer {
  const lines = acceptedLines(dataDirOf(place));
  if (lines.length === 0) return { text: acceptedLabel(place, 'none'), status: 'ok' };
  const rows = lines.map((text, index) => acceptedLabel(place, 'row', { number: index + 1, text }));
  return { text: rows.join('\n'), status: 'ok' };
}

/** `accept <text>`: the text added as the last line, or why not. */
export function watcherAccept(place: AcceptedPlace, text: string): DoctorAnswer {
  const added = acceptLine(dataDirOf(place), text);
  if (added.ok) return { text: acceptedLabel(place, 'added', { number: added.line }), status: 'ok' };
  return {
    text: acceptedLabel(place, `refused.${added.code}`, { number: added.line ?? 0 }),
    status: 'failed',
  };
}

/** `unaccept <number>`: the line removed and its text, or how many lines the list has. */
export function watcherUnaccept(place: AcceptedPlace, number: number): DoctorAnswer {
  const removed = unacceptLine(dataDirOf(place), number);
  if (removed.ok) return { text: acceptedLabel(place, 'removed', { number, text: removed.text }), status: 'ok' };
  return { text: acceptedLabel(place, 'noLine', { number, count: removed.count }), status: 'failed' };
}

type Spawned = { unref(): void; on(event: 'error', listener: (error: NodeJS.ErrnoException) => void): unknown };
type Spawn = (command: string, args: ReadonlyArray<string>, options: Record<string, unknown>) => Spawned;

/**
 * The starter of the worker: `node bin/neptunia.ts worker watcher` of this install, in its own process group, with no
 * stdio, so neither the caller nor its terminal holds it. A child of a core under systemd still ends with the core's
 * unit, and the run then reads as `holder-gone`. The child gets no GitHub token and a `GH_CONFIG_DIR` that holds no login.
 * `failed` hears a spawn that fails after it was asked.
 */
export function workerStarter(input: {
  rootDir: string;
  dataDir: string;
  env: Readonly<Record<string, string | undefined>>;
  spawn?: Spawn;
  failed?: (runId: string, code: string) => void;
}): StartWorker {
  const spawn: Spawn = input.spawn ?? ((command, args, options) => spawnChild(command, [...args], options));
  const env: Record<string, string | undefined> = {
    ...input.env,
    NEPTUNIA_DATA_DIR: input.dataDir,
    GH_CONFIG_DIR: path.join(input.dataDir, DEFAULT_WATCHER_DIR, NO_GH_LOGIN),
  };
  delete env.GH_TOKEN;
  delete env.GITHUB_TOKEN;
  return (runId) => {
    try {
      const child = spawn(process.execPath, [path.join(input.rootDir, 'bin', 'neptunia.ts'), 'worker', 'watcher'], {
        cwd: input.rootDir,
        detached: true,
        stdio: 'ignore',
        env,
      });
      child.on('error', (error) => input.failed?.(runId, error.code ?? 'spawn-error'));
      child.unref();
      return null;
    } catch (error) {
      return (error as NodeJS.ErrnoException).code ?? 'spawn-error';
    }
  };
}

/**
 * One `/doctor watcher` command by its parsed name. `run` needs the starter the core holds; without one, as in a terminal
 * with no core, it is refused and nothing is claimed.
 */
export function watcherDoctor(
  name: string,
  args: Readonly<Record<string, unknown>>,
  place: AcceptedPlace & { start?: StartWorker }
): DoctorAnswer {
  switch (name) {
    case 'doctor.watcher.run':
      return place.start === undefined
        ? {
            text: 'the core starts a watcher report, and none answers; start it with neptunia services start',
            status: 'failed',
          }
        : watcherRun({ ...place, start: place.start });
    case 'doctor.watcher.stop':
      return watcherStop(place);
    case 'doctor.watcher.list':
      return watcherList(place);
    case 'doctor.watcher.read':
      return watcherOpen(place, 'latest');
    case 'doctor.watcher.accepted':
      return watcherAccepted(place);
    case 'doctor.watcher.accept':
      return watcherAccept(place, typeof args.text === 'string' ? args.text : '');
    case 'doctor.watcher.unaccept':
      return watcherUnaccept(place, Number(args.number));
    default:
      return watcherOpen(place, Number(args.number));
  }
}

/** The core's starter of `/doctor watcher run` (src/core.ts): this install's worker, its run failed when the spawn fails. */
export function coreWatcherStarter(paths: { rootDir: string; privateDir: string; dataDir: string }): StartWorker {
  const store = runStoreOf(path.dirname(reportsDirOf(paths.privateDir)));
  return workerStarter({
    rootDir: paths.rootDir,
    dataDir: paths.dataDir,
    env: process.env,
    failed: (runId, code) => finishRun(store, runId, { state: 'failed', code: 'start-failed', detail: code }),
  });
}
