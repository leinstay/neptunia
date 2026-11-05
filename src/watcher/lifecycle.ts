// The watcher's durable run. A run is one JSON record under `<watcher dir>/runs/`, `active` names the run in progress, and
// every change happens under `.lock`, so a manual trigger and a timer start share one atomic claim whichever process
// they come from. Reads take no lock and write nothing: a replaced record appears whole, and a run whose holder is
// gone reads as finished before any writer records it. `claimRun` with no owner is what `service watcher trigger`
// does before it asks the manager for a worker, and the worker that starts adopts that claim and keeps its identity. A
// holder is the pair of pid and start identity, so a reused pid never counts as alive and nothing here signals a
// process. The start identity comes from /proc, because the watcher's units are systemd's and run on Linux only.

import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { utcDay } from '../time.ts';
import { readReportRun } from './read.ts';

/** How long one inspection's agent may run before its process group is killed (ms). */
export const WATCHER_RUN_TIMEOUT_MS = 60 * 60 * 1000;

export type RunState = 'running' | 'stopping' | 'succeeded' | 'failed' | 'cancelled';
export type RunSource = 'manual' | 'timer';
export type ProcessIdentity = { pid: number; startId: string };

/** Where runs are kept and the three things a run needs from outside. */
export type RunStore = {
  dir: string;
  now: () => number;
  newRunId: () => string;
  /** The start identity of the process `pid`, null when no such process lives. */
  processStart: (pid: number) => string | null;
};

export type RunRecord = {
  runId: string;
  state: RunState;
  source: RunSource;
  /** The UTC day of the claim, which names the report. */
  day: string;
  claimedAt: number;
  finishedAt: number | null;
  timeoutMs: number;
  owner: ProcessIdentity | null;
  code: string | null;
  detail: string | null;
  /** The answers asked for so far, each counted before it runs; absent on a record from before retries. */
  attempts?: number;
};

/** A lock older than this was left by a crash: every holder is done within a few file operations (ms). */
const LOCK_STALE_MS = 10_000;
const LOCK_WAIT_MS = 5;

const runsDir = (store: RunStore): string => path.join(store.dir, 'runs');
const recordFile = (store: RunStore, runId: string): string => path.join(runsDir(store), `${runId}.json`);
const activeFile = (store: RunStore): string => path.join(runsDir(store), 'active');

const isOpen = (state: RunState): boolean => state === 'running' || state === 'stopping';

function writeWhole(file: string, text: string): void {
  fs.writeFileSync(`${file}.${process.pid}.tmp`, text);
  fs.renameSync(`${file}.${process.pid}.tmp`, file);
}

function readRecord(store: RunStore, runId: string): RunRecord | null {
  try {
    return JSON.parse(fs.readFileSync(recordFile(store, runId), 'utf8')) as RunRecord;
  } catch {
    return null;
  }
}

function activeId(store: RunStore): string | null {
  try {
    return fs.readFileSync(activeFile(store), 'utf8').trim() || null;
  } catch {
    return null;
  }
}

/** Runs `change` holding the lock. The lock's age is measured against the file's own real time, not the store's clock. */
function locked<T>(store: RunStore, change: () => T): T {
  fs.mkdirSync(runsDir(store), { recursive: true });
  const lock = path.join(runsDir(store), '.lock');
  const pause = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      fs.closeSync(fs.openSync(lock, 'wx'));
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
    let age = 0;
    try {
      age = Date.now() - fs.statSync(lock).mtimeMs;
    } catch {
      continue;
    }
    if (age > LOCK_STALE_MS) fs.rmSync(lock, { force: true });
    else Atomics.wait(pause, 0, 0, LOCK_WAIT_MS);
  }
  try {
    return change();
  } finally {
    fs.rmSync(lock, { force: true });
  }
}

/** Whether nobody holds this open run any more: its owner's process is gone, or no worker came within its timeout. */
function isStale(store: RunStore, run: RunRecord): boolean {
  if (run.owner === null) return store.now() - run.claimedAt > run.timeoutMs;
  return store.processStart(run.owner.pid) !== run.owner.startId;
}

/** An open run as it stands once its holder is known to be gone: a report it committed makes it a success. */
function asRecovered(store: RunStore, run: RunRecord): RunRecord {
  const committed = readReportRun(path.join(store.dir, 'reports'), run.runId).ok;
  return {
    ...run,
    state: committed ? 'succeeded' : 'failed',
    code: committed ? null : 'holder-gone',
    detail: committed ? null : run.owner === null ? 'no worker came within the timeout' : 'the worker died',
    finishedAt: store.now(),
  };
}

/** The record as a reader should take it. */
function viewOf(store: RunStore, run: RunRecord): RunRecord {
  return isOpen(run.state) && isStale(store, run) ? asRecovered(store, run) : run;
}

function recordFinished(store: RunStore, run: RunRecord): void {
  writeWhole(recordFile(store, run.runId), JSON.stringify(run, null, 2));
  if (activeId(store) === run.runId) fs.rmSync(activeFile(store), { force: true });
}

/** Under the lock: the run in progress, with a stale claim recorded as finished first. */
function holdActive(store: RunStore): RunRecord | null {
  const id = activeId(store);
  if (id === null) return null;
  const run = readRecord(store, id);
  if (run === null) {
    fs.rmSync(activeFile(store), { force: true });
    return null;
  }
  const seen = viewOf(store, run);
  if (isOpen(seen.state)) return seen;
  recordFinished(store, seen);
  return null;
}

/**
 * One start, manual or timer. With a run in progress it answers that run and `claimed: false`, except that an owner
 * adopts a claim that has none and keeps its identity and source. A start with no owner is a claim for a worker to come.
 */
export function claimRun(
  store: RunStore,
  claim: { source: RunSource; owner: ProcessIdentity | null; timeoutMs: number }
): { claimed: boolean; run: RunRecord } {
  return locked(store, () => {
    const active = holdActive(store);
    if (active !== null) {
      if (active.owner !== null || claim.owner === null) return { claimed: false, run: active };
      const adopted = { ...active, owner: claim.owner };
      writeWhole(recordFile(store, adopted.runId), JSON.stringify(adopted, null, 2));
      return { claimed: true, run: adopted };
    }
    const now = store.now();
    const run: RunRecord = {
      runId: store.newRunId(),
      state: 'running',
      source: claim.source,
      day: utcDay(now),
      claimedAt: now,
      finishedAt: null,
      timeoutMs: claim.timeoutMs,
      owner: claim.owner,
      code: null,
      detail: null,
    };
    writeWhole(recordFile(store, run.runId), JSON.stringify(run, null, 2));
    writeWhole(activeFile(store), run.runId);
    return { claimed: true, run };
  });
}

/** The run in progress, or null. */
export function currentRun(store: RunStore): RunRecord | null {
  const id = activeId(store);
  const run = id === null ? null : readRecord(store, id);
  if (run === null) return null;
  const seen = viewOf(store, run);
  return isOpen(seen.state) ? seen : null;
}

/** One run by its identity, or null. */
export function readRun(store: RunStore, runId: string): RunRecord | null {
  const run = readRecord(store, runId);
  return run === null ? null : viewOf(store, run);
}

/**
 * Asks the run in progress to stop: its holder sees `stopping` at its next look. Repeating it changes nothing, and with no
 * run it answers null. A claim no worker has adopted yet stays `stopping` too, and the worker that comes ends it.
 */
export function requestCancel(store: RunStore): RunRecord | null {
  return locked(store, () => {
    const active = holdActive(store);
    if (active === null || active.state === 'stopping') return active;
    const stopping: RunRecord = { ...active, state: 'stopping' };
    writeWhole(recordFile(store, stopping.runId), JSON.stringify(stopping, null, 2));
    return stopping;
  });
}

/** Ends a run. A finished state is final, so a later finish changes nothing; the answer is the record as it stands. */
/** Counts the attempt about to run, so a crash inside it reads as having started. */
export function noteAttempt(store: RunStore, runId: string, attempts: number): void {
  locked(store, () => {
    const run = readRecord(store, runId);
    if (run !== null && isOpen(run.state))
      writeWhole(recordFile(store, runId), JSON.stringify({ ...run, attempts }, null, 2));
  });
}

export function finishRun(
  store: RunStore,
  runId: string,
  end: { state: 'succeeded' | 'failed' | 'cancelled'; code?: string; detail?: string }
): RunRecord | null {
  return locked(store, () => {
    const run = readRecord(store, runId);
    if (run === null || !isOpen(run.state)) return run;
    const finished: RunRecord = {
      ...run,
      state: end.state,
      code: end.code ?? null,
      detail: end.detail ?? null,
      finishedAt: store.now(),
    };
    recordFinished(store, finished);
    return finished;
  });
}

/** The newest succeeded and the newest failed run, each null when there is none. */
export function lastRuns(store: RunStore): { lastSuccess: RunRecord | null; lastFailure: RunRecord | null } {
  let names: Array<string> = [];
  try {
    names = fs.readdirSync(runsDir(store)).filter((name) => name.endsWith('.json'));
  } catch {
    // No run yet.
  }
  const runs = names
    .map((name) => readRun(store, name.slice(0, -'.json'.length)))
    .filter((run): run is RunRecord => run !== null)
    .sort((a, b) => (a.finishedAt ?? a.claimedAt) - (b.finishedAt ?? b.claimedAt));
  return {
    lastSuccess: runs.findLast((run) => run.state === 'succeeded') ?? null,
    lastFailure: runs.findLast((run) => run.state === 'failed') ?? null,
  };
}

/** A process's start identity: the boot and its start time in /proc, null for a process that is gone or a zombie. */
export function defaultProcessStart(pid: number): string | null {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const fields = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (fields[0] === 'Z') return null;
    const boot = fs.readFileSync('/proc/sys/kernel/random/boot_id', 'utf8').trim();
    return `${boot}:${fields[19] ?? ''}`;
  } catch {
    return null;
  }
}

/** The store of a watcher folder in production. */
export function runStoreOf(dir: string, now: () => number = Date.now): RunStore {
  return {
    dir,
    now,
    newRunId: () => `${new Date(now()).toISOString().replace(/[-:.]/g, '')}-${randomBytes(3).toString('hex')}`,
    processStart: defaultProcessStart,
  };
}
