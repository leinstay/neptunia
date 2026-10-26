// The runner's sweep of old task output: every task works in `<outDir>/<id>/` and leaves its
// files there for the core to attach (src/errands/store.js#fileOf). The directory belongs to the
// agent's own Unix user, so the core can list and read it but not delete it: the runner does.
// A sweep removes each task directory under the out dir whose newest entry (the directory
// itself, any file or subdirectory inside, never following a link) is older than
// `agents.keepFilesHours`, and never the directory of a task the runner still has (running or
// queued). It runs when the runner starts and then once an hour, reading the hours from the
// live config at each sweep. Only names that may be a task id (src/agent-runner/protocol.js
// TASK_ID) are considered; anything else in the out dir is left alone. One log line per sweep
// with counts, never a name.

import fsp from 'node:fs/promises';
import path from 'node:path';
import { log as defaultLog } from '../log.js';
import { HOUR_MS } from '../time.js';
import { TASK_ID } from './protocol.js';

/** `agents.keepFilesHours` when it is missing or not a positive number (config.json carries the same). */
export const DEFAULT_KEEP_FILES_HOURS = 24;
/** How often the runner sweeps after its start (ms). */
export const SWEEP_INTERVAL_MS = HOUR_MS;

/** `hours` when it is a positive finite number, else DEFAULT_KEEP_FILES_HOURS. */
export function keepHoursOf(hours) {
  return typeof hours === 'number' && Number.isFinite(hours) && hours > 0 ? hours : DEFAULT_KEEP_FILES_HOURS;
}

/** The newest modification time (ms) of `dir` and everything under it; links are not followed. */
async function newestMtime(dir) {
  let newest = 0;
  async function walk(current) {
    let stat;
    try {
      stat = await fsp.lstat(current);
    } catch {
      return;
    }
    if (stat.mtimeMs > newest) newest = stat.mtimeMs;
    if (!stat.isDirectory()) return;
    let entries;
    try {
      entries = await fsp.readdir(current);
    } catch {
      return;
    }
    for (const name of entries) await walk(path.join(current, name));
  }
  await walk(dir);
  return newest;
}

/**
 * One sweep of `outDir`: the task directories older than `keepHours` removed, the live ones kept.
 * Never throws; a missing out dir is an empty sweep.
 * @param {object} options
 * @param {string} options.outDir
 * @param {number} [options.keepHours]  `agents.keepFilesHours` (keepHoursOf).
 * @param {() => Iterable<string>} [options.liveIds]  The ids of the tasks the runner still has,
 *   asked again before each removal.
 * @param {() => number} [options.now]
 * @returns {Promise<{ removed: number, kept: number, live: number, failed: number }>}
 */
export async function sweepOutputs({ outDir, keepHours, liveIds = () => [], now = Date.now }) {
  const counts = { removed: 0, kept: 0, live: 0, failed: 0 };
  const cutoff = now() - keepHoursOf(keepHours) * HOUR_MS;
  const isLive = (id) => new Set(liveIds() ?? []).has(id);
  let entries;
  try {
    entries = await fsp.readdir(outDir, { withFileTypes: true });
  } catch {
    return counts;
  }
  for (const entry of entries) {
    if (!entry.isDirectory() || !TASK_ID.test(entry.name)) continue;
    if (isLive(entry.name)) {
      counts.live += 1;
      continue;
    }
    const dir = path.join(outDir, entry.name);
    const newest = await newestMtime(dir);
    if (newest >= cutoff) {
      counts.kept += 1;
      continue;
    }
    // A task that came back under this id while the directory was read keeps it.
    if (isLive(entry.name)) {
      counts.live += 1;
      continue;
    }
    try {
      await fsp.rm(dir, { recursive: true, force: true });
      counts.removed += 1;
    } catch {
      counts.failed += 1;
    }
  }
  return counts;
}

/**
 * The sweeper of one runner: a sweep now, then every `intervalMs`, each one reading the hours
 * and the live ids at its own moment. Sweeps never overlap.
 * @param {object} options
 * @param {string} options.profile  The profile name (for the log line).
 * @param {string} options.outDir
 * @param {() => unknown} options.keepHours  The live `agents.keepFilesHours`.
 * @param {() => Iterable<string>} options.liveIds  The ids of the tasks the runner still has.
 * @param {number} [options.intervalMs]
 * @param {() => number} [options.now]
 * @param {{ info: Function }} [options.log]
 * @returns {{ sweep: () => Promise<object|null>, stop: () => void }}
 */
export function startSweeper({
  profile,
  outDir,
  keepHours,
  liveIds,
  intervalMs = SWEEP_INTERVAL_MS,
  now = Date.now,
  log = defaultLog,
}) {
  let busy = null;
  let stopped = false;

  /** One sweep and its log line; a sweep asked for while one runs is that one. */
  function sweep() {
    if (stopped) return Promise.resolve(null);
    if (busy) return busy;
    busy = (async () => {
      let hours;
      try {
        hours = keepHoursOf(keepHours());
      } catch {
        hours = DEFAULT_KEEP_FILES_HOURS;
      }
      const counts = await sweepOutputs({ outDir, keepHours: hours, liveIds, now });
      log.info('agent-runner: swept', { profile, hours, ...counts });
      return counts;
    })().finally(() => {
      busy = null;
    });
    return busy;
  }

  const timer = setInterval(() => {
    sweep();
  }, intervalMs);
  timer.unref?.();
  sweep();

  return {
    sweep,
    stop() {
      stopped = true;
      clearInterval(timer);
    },
  };
}
