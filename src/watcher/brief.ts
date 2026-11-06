// The watcher's brief: the prompt file, the day of the run, its observation interval, the facts of the running install and
// `<development>` and `<audit-topic>` in development mode (src/watcher/development.ts), and
// the last seven reports it wrote before this run, oldest first: the newest report of each earlier day, then every kept
// report of the run's own day. Only the structure is added here (the tags below); what the watcher is asked is in
// `<watcher dir>/prompt.md`, which src/watcher/inspection.ts reads. docs/prompt-contract.md names the tags.

import type { InstallFacts } from './install.ts';
import { readReportRun, reportDays, reportText, reportVersions } from './read.ts';

/** How many earlier reports the brief carries. */
const EARLIER_REPORTS = 7;

const iso = (at: number): string => new Date(at).toISOString();

/**
 * The prompt, `<day>`, `<observation from to day-from>`, `<install>`, `<development>`, `<audit-topic>` and `<memory>` when the run has them, and one `<report day="...">`
 * per earlier report, with `run="..."` on those of the run's day.
 */
export function buildBrief({
  prompt,
  day,
  reportsDir,
  observation,
  install,
  development,
  auditTopic,
  memory = [],
}: {
  prompt: string;
  day: string;
  reportsDir: string;
  observation?: { from: number; to: number; dayFrom: number };
  install?: InstallFacts;
  /** The JSON of `developmentBrief` when the mode is on. */
  development?: string;
  /** The one topic this run audits, when the mode is on and the settings name any. */
  auditTopic?: string | null;
  /** Stored facts from group conversations that bear on failing work, one line each. */
  memory?: ReadonlyArray<string>;
}): string {
  const earlier: Array<string> = [];
  for (const one of reportDays(reportsDir).filter((other) => other < day)) {
    const text = reportText(reportsDir, one);
    if (text !== null) earlier.push(`<report day="${one}">\n${text.trim()}\n</report>`);
  }
  for (const { runId } of reportVersions(reportsDir, day)) {
    const read = readReportRun(reportsDir, runId);
    if (!read.ok) continue;
    const reportText = read.report.text;
    earlier.push(`<report day="${day}" run="${runId}">\n${reportText.trim()}\n</report>`);
  }
  const parts = [
    prompt.trim(),
    `<day>${day}</day>`,
    ...(observation === undefined
      ? []
      : [
          `<observation from="${iso(observation.from)}" to="${iso(observation.to)}" day-from="${iso(observation.dayFrom)}"/>`,
        ]),
    ...(install === undefined ? [] : [`<install>\n${JSON.stringify(install, null, 2)}\n</install>`]),
    ...(development === undefined ? [] : [`<development>\n${development}\n</development>`]),
    ...(auditTopic === undefined || auditTopic === null ? [] : [`<audit-topic>${auditTopic}</audit-topic>`]),
    ...(memory.length === 0 ? [] : [`<memory>\n${memory.join('\n')}\n</memory>`]),
    ...earlier.slice(-EARLIER_REPORTS),
  ];
  return `${parts.join('\n\n')}\n`;
}
