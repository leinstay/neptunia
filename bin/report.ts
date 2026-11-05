// `service watcher report [<date or run>]` of the command line (bin/neptunia-service.ts runs it with no core): the
// watcher's latest report, the report of a date or of a run, read from the reports folder (src/watcher/read.ts) and rendered
// for the terminal (bin/markdown.ts). A report that is not there is one line, never an error trace.

import { renderMarkdown } from './markdown.ts';
import { readReport, readReportRun, runLines } from '../src/watcher/read.ts';

export type ReportAnswer = { text: string; status: string };

/** The report of `runId`, else of `day`, else the latest, as the chat prints it, with its status `ok`, `failed` or `invalid`. */
export function reportAnswer({
  reportsDir,
  day,
  runId,
  color,
}: {
  reportsDir: string;
  day: string | undefined;
  runId?: string;
  color: boolean;
}): ReportAnswer {
  const read = runId === undefined ? readReport(reportsDir, day) : readReportRun(reportsDir, runId);
  if (read.ok) {
    const head = [`# Report of ${read.report.day}`, ...runLines(reportsDir, read.report), read.report.text];
    return { text: renderMarkdown(head.join('\n\n'), { color }), status: 'ok' };
  }
  if (runId !== undefined) return { text: `no report for ${runId}`, status: 'failed' };
  if (read.code === 'invalid-day') {
    return { text: `service watcher report takes a date written YYYY-MM-DD, not "${day ?? ''}"`, status: 'invalid' };
  }
  return { text: day === undefined ? 'no report yet' : `no report for ${day}`, status: 'failed' };
}
