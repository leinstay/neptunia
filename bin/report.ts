// The console's `/report [<date>]` (bin/neptunia.ts runs it with no core): the watcher's latest report, or the report of
// a date, read from the reports folder (src/watcher/read.ts) and rendered for the terminal (bin/markdown.ts). A report
// that is not there is one line, never an error trace.

import { renderMarkdown } from './markdown.ts';
import { readReport } from '../src/watcher/read.ts';

export type ReportAnswer = { text: string; status: string };

/** The report of `day` (the latest without one) as the chat prints it, with its `ok`, `failed` or `invalid` status. */
export function reportAnswer({
  reportsDir,
  day,
  color,
}: {
  reportsDir: string;
  day: string | undefined;
  color: boolean;
}): ReportAnswer {
  const read = readReport(reportsDir, day);
  if (read.ok) {
    return { text: renderMarkdown(`# Report of ${read.report.day}\n\n${read.report.text}`, { color }), status: 'ok' };
  }
  if (read.code === 'invalid-day') {
    return { text: `/report takes a date written YYYY-MM-DD, not "${day ?? ''}"`, status: 'invalid' };
  }
  return { text: day === undefined ? 'no report yet' : `no report for ${day}`, status: 'failed' };
}
