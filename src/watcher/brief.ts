// The watcher's brief: the prompt file, the day of the run and the last seven reports it wrote before this run, oldest
// first: the newest report of each earlier day, then every kept report of the run's own day. Only the structure is added
// here (the tags below); what the watcher is asked is in `<watcher dir>/prompt.md`, which src/watcher/inspection.ts reads.
// docs/watcher.md names the tags.

import { readReportRun, reportDays, reportText, reportVersions } from './read.ts';

/** How many earlier reports the brief carries. */
const EARLIER_REPORTS = 7;

/** The prompt, `<day>` and one `<report day="...">` per earlier report, with `run="..."` on those of the run's day. */
export function buildBrief({ prompt, day, reportsDir }: { prompt: string; day: string; reportsDir: string }): string {
  const earlier: Array<string> = [];
  for (const one of reportDays(reportsDir).filter((other) => other < day)) {
    const text = reportText(reportsDir, one);
    if (text !== null) earlier.push(`<report day="${one}">\n${text.trim()}\n</report>`);
  }
  for (const { runId } of reportVersions(reportsDir, day)) {
    const read = readReportRun(reportsDir, runId);
    if (read.ok) earlier.push(`<report day="${day}" run="${runId}">\n${read.report.text.trim()}\n</report>`);
  }
  const parts = [prompt.trim(), `<day>${day}</day>`, ...earlier.slice(-EARLIER_REPORTS)];
  return `${parts.join('\n\n')}\n`;
}
