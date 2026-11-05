// What the persona's selfimprovement wake carries of the watcher: the titles of what its newest report of the past day
// filed, each with the state of its receipt (src/watcher/filing.ts). src/core.ts hands `watcherNews` to the inner life as
// a source, and src/behavior/inner/selfimprovement.ts asks it with the wake's time. The watcher is not part of her, so
// this is the one way its work reaches her. No section of a report reaches her, because a report may hold server evidence
// meant for the owner alone. A report with no receipts, a report from before run identities included, gives her nothing.
// Reads the reports folder of `watcher.dir`; never throws.

import path from 'node:path';
import { utcDay, DAY_MS } from '../time.ts';
import { readFilings } from './filing.ts';
import type { FilingState } from './filing.ts';
import { readReport, reportDays, reportsDirOf } from './read.ts';
import { watcherSettings } from './settings.ts';

export type WatcherFinding = { title: string; kind?: string; state: FilingState; taskId: string | null };
export type WatcherNews = { day: string; runId: string; findings: Array<WatcherFinding> };

/** A draft that repeats what is already filed, or that a cancel stopped, is no news. */
const IS_NEWS: ReadonlyArray<FilingState> = ['pending', 'filed', 'deferred', 'failed'];

/**
 * The findings of the newest report of the past day (its day is the UTC day of `now` or the one before). Null when
 * `watcher.enabled` is not true, when there is no such report, or when it has no finding for her. Reads `watcher.dir`
 * under `rootDir`. Never throws.
 */
export function watcherNews(input: { config: unknown; rootDir: string; now: number }): WatcherNews | null {
  try {
    const settings = watcherSettings(input.config);
    if (!settings.enabled) return null;
    const reportsDir = reportsDirOf(input.rootDir, settings.dir);
    const window = new Set([utcDay(input.now), utcDay(input.now - DAY_MS)]);
    const day = reportDays(reportsDir)
      .filter((one) => window.has(one))
      .at(-1);
    if (day === undefined) return null;
    const read = readReport(reportsDir, day);
    const runId = read.ok ? read.report.runId : undefined;
    if (runId === undefined) return null;
    const findings = readFilings(path.dirname(reportsDir), runId)
      .filter((one) => IS_NEWS.includes(one.state))
      .map(({ title, kind, state, taskId }) => ({ title, kind, state, taskId }));
    return findings.length === 0 ? null : { day, runId, findings };
  } catch {
    // An unreadable folder or file leaves the wake without the report; the wake's other facts stay.
    return null;
  }
}
