// The watcher's brief: the prompt file, the day of the run and the last seven reports it wrote before that day, oldest
// first. Only the structure is added here (the tags below); what the watcher is asked is in `<watcher dir>/prompt.md`,
// which src/watcher/run.ts reads. docs/watcher.md names the tags.

import { reportDays, reportText } from './read.ts';

/** How many earlier reports the brief carries. */
const EARLIER_REPORTS = 7;

/** The prompt, `<day>` and one `<report day="...">` per earlier report. */
export function buildBrief({ prompt, day, reportsDir }: { prompt: string; day: string; reportsDir: string }): string {
  const earlier = reportDays(reportsDir)
    .filter((one) => one < day)
    .slice(-EARLIER_REPORTS);
  const parts = [prompt.trim(), `<day>${day}</day>`];
  for (const one of earlier) {
    const text = reportText(reportsDir, one);
    if (text !== null) parts.push(`<report day="${one}">\n${text.trim()}\n</report>`);
  }
  return `${parts.join('\n\n')}\n`;
}
