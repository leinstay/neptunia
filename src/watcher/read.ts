// Watcher reports live in data/agents/watcher/reports. The watcher, core and CLI use the same fixed persona
// location. Each successful run keeps one immutable file in `runs/`, named `<day>_<commit ms>_<run id>.md`, and
// `<day>.md` is a link to the newest of its day, swapped atomically (src/watcher/report.ts). A `<day>.md` that is a plain
// file comes from before versions and has no run identity. Readers never log a report's contents.

import fs from 'node:fs';
import path from 'node:path';

export type ReportView = { day: string; text: string; runId?: string };
export type ReportVersion = { runId: string; day: string; at: number };
export type ReadResult = { ok: true; report: ReportView } | { ok: false; code: 'not-found' | 'invalid-day' };
export type ReportReader = { read(day?: string, runId?: string): ReadResult };

/** The fixed watcher directory relative to the persona data root. */
export const DEFAULT_WATCHER_DIR = 'agents/watcher';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const REPORT_FILE = /^(\d{4}-\d{2}-\d{2})\.md$/;
const VERSION_FILE = /^(\d{4}-\d{2}-\d{2})_(\d{13})_([A-Za-z0-9_-]+)\.md$/;

/** The folder of the immutable reports inside the reports folder. */
export const VERSIONS_DIR = 'runs';

/** Whether `day` is a real date written `YYYY-MM-DD`. */
export function isDay(day: unknown): boolean {
  if (typeof day !== 'string' || !DAY.test(day)) return false;
  const at = Date.parse(`${day}T00:00:00Z`);
  return !Number.isNaN(at) && new Date(at).toISOString().slice(0, 10) === day;
}

/** The fixed directory; the argument preserves the existing caller shape. */
export function watcherDir(config: unknown): string {
  void config;
  return DEFAULT_WATCHER_DIR;
}

/** The reports folder under `rootDir`: `<dir>/reports`, `dir` being relative to the root or absolute. */
export function reportsDirOf(rootDir: string, dir: string = DEFAULT_WATCHER_DIR): string {
  return path.join(path.resolve(rootDir, dir), 'reports');
}

/** The days that have a report in `reportsDir`, oldest first; none for a folder that does not exist. */
export function reportDays(reportsDir: string): Array<string> {
  let names: Array<string>;
  try {
    names = fs.readdirSync(reportsDir);
  } catch {
    return [];
  }
  const days: Array<string> = [];
  for (const name of names) {
    const day = REPORT_FILE.exec(name)?.[1];
    if (day !== undefined && isDay(day)) days.push(day);
  }
  return days.sort();
}

/** The text of the report of `day`, or null when the file is not there. */
export function reportText(reportsDir: string, day: string): string | null {
  try {
    return fs.readFileSync(path.join(reportsDir, `${day}.md`), 'utf8');
  } catch {
    return null;
  }
}

/** The file name of a run's report: its day, the moment of the commit, which orders a day's reports, and its identity. */
export const versionFileOf = (day: string, at: number, runId: string): string =>
  `${day}_${String(at).padStart(13, '0')}_${runId}.md`;

const versionOf = (name: string): (ReportVersion & { name: string }) | null => {
  const found = VERSION_FILE.exec(name);
  if (found === null) return null;
  return { day: found[1] ?? '', at: Number(found[2]), runId: found[3] ?? '', name };
};

function versionFiles(reportsDir: string): Array<ReportVersion & { name: string }> {
  try {
    return fs
      .readdirSync(path.join(reportsDir, VERSIONS_DIR))
      .map(versionOf)
      .filter((one) => one !== null)
      .sort((a, b) => a.at - b.at);
  } catch {
    return [];
  }
}

/** The kept reports, or those of `day`, oldest first. */
export function reportVersions(reportsDir: string, day?: string): Array<ReportVersion> {
  return versionFiles(reportsDir)
    .filter((one) => day === undefined || one.day === day)
    .map(({ runId, day: its, at }) => ({ runId, day: its, at }));
}

/** The report of one run. The identity is only compared with the names in the folder, so it never reaches a path. */
export function readReportRun(reportsDir: string, runId: string): ReadResult {
  const version = versionFiles(reportsDir).find((one) => one.runId === runId);
  if (version === undefined) return { ok: false, code: 'not-found' };
  try {
    const text = fs.readFileSync(path.join(reportsDir, VERSIONS_DIR, version.name), 'utf8');
    return { ok: true, report: { day: version.day, runId, text } };
  } catch {
    return { ok: false, code: 'not-found' };
  }
}

/** The run a day's view links to; undefined for a plain file from before versions. */
function viewRun(reportsDir: string, day: string): string | undefined {
  try {
    return versionOf(path.basename(fs.readlinkSync(path.join(reportsDir, `${day}.md`))))?.runId;
  } catch {
    return undefined;
  }
}

/** The report of `day`, or the latest one without a day. A day that is no date is `invalid-day`. */
export function readReport(reportsDir: string, day?: string): ReadResult {
  if (day !== undefined && !isDay(day)) return { ok: false, code: 'invalid-day' };
  const wanted = day ?? reportDays(reportsDir).at(-1);
  if (wanted === undefined) return { ok: false, code: 'not-found' };
  const text = reportText(reportsDir, wanted);
  if (text === null) return { ok: false, code: 'not-found' };
  const runId = viewRun(reportsDir, wanted);
  return { ok: true, report: { day: wanted, text, ...(runId === undefined ? {} : { runId }) } };
}

/** The lines above a report the owner reads: which run this is and which other runs its day has. */
export function runLines(reportsDir: string, report: ReportView): Array<string> {
  if (report.runId === undefined) return [];
  const ofDay = reportVersions(reportsDir, report.day).map((one) => one.runId);
  return [`run: ${report.runId}`, `runs of this day: ${ofDay.join(', ')}`];
}

/** A reader over a reports folder; give a function to follow a setting that can change between two reads. */
export function createReportReader(reportsDir: string | (() => string)): ReportReader {
  const dir = (): string => (typeof reportsDir === 'function' ? reportsDir() : reportsDir);
  return { read: (day, runId) => (runId === undefined ? readReport(dir(), day) : readReportRun(dir(), runId)) };
}
