// Reading the watcher's reports: the folder they live in, the latest report or the one of a day, and a reader bound to
// a folder. Her tool `watcher.read` (src/tools/impl/watcher.ts), the core and the console's `/report` (bin/report.ts)
// call it; the watcher run (src/watcher/run.ts) and the brief (src/watcher/brief.ts) use the day check and the list of
// days. The folder is `watcher.dir` (default `.agents/watcher`) under the checkout, read at each call.

import fs from 'node:fs';
import path from 'node:path';
import { objOf } from '../tools/types.ts';

export type ReportView = { day: string; text: string };
export type ReadResult = { ok: true; report: ReportView } | { ok: false; code: 'not-found' | 'invalid-day' };
export type ReportReader = { read(day?: string): ReadResult };

/** `watcher.dir` when the setting is missing or empty (config/config.json carries the same). */
export const DEFAULT_WATCHER_DIR = '.agents/watcher';

const DAY = /^\d{4}-\d{2}-\d{2}$/;
const REPORT_FILE = /^(\d{4}-\d{2}-\d{2})\.md$/;

/** Whether `day` is a real date written `YYYY-MM-DD`. */
export function isDay(day: unknown): day is string {
  if (typeof day !== 'string' || !DAY.test(day)) return false;
  const at = Date.parse(`${day}T00:00:00Z`);
  return !Number.isNaN(at) && new Date(at).toISOString().slice(0, 10) === day;
}

/** `watcher.dir` of a config, read at the moment of use; the default for a missing or blank value. */
export function watcherDir(config: unknown): string {
  const dir = objOf(objOf(config).watcher).dir;
  return typeof dir === 'string' && dir.trim() !== '' ? dir.trim() : DEFAULT_WATCHER_DIR;
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

/** The report of `day`, or the latest one without a day. A day that is no date is `invalid-day`. */
export function readReport(reportsDir: string, day?: string): ReadResult {
  if (day !== undefined && !isDay(day)) return { ok: false, code: 'invalid-day' };
  const wanted = day ?? reportDays(reportsDir).at(-1);
  if (wanted === undefined) return { ok: false, code: 'not-found' };
  const text = reportText(reportsDir, wanted);
  return text === null ? { ok: false, code: 'not-found' } : { ok: true, report: { day: wanted, text } };
}

/** A reader over a reports folder; give a function to follow a setting that can change between two reads. */
export function createReportReader(reportsDir: string | (() => string)): ReportReader {
  return { read: (day) => readReport(typeof reportsDir === 'function' ? reportsDir() : reportsDir, day) };
}
