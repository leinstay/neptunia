// The watcher's brief: the prompt file, the day of the run, its observation interval, the facts of the running install, the
// money and limits (src/watcher/money.ts), and the last seven reports it wrote before this run, oldest first: the newest
// report of each earlier day, then every kept report of the run's own day. Only the structure is added here (the tags below); what the watcher is asked is in
// `<watcher dir>/prompt.md`, which src/watcher/inspection.ts reads. docs/prompt-contract.md names the tags.

import type { InstallFacts } from './install.ts';
import type { MoneyFacts } from './money.ts';
import { readReportRun, reportDays, reportText, reportVersions } from './read.ts';

/** How many earlier reports the brief carries. */
const EARLIER_REPORTS = 7;

const iso = (at: number): string => new Date(at).toISOString();

/**
 * The prompt, `<day>`, `<observation from to day-from>`, `<install>`, `<money>`, `<memory>` and `<accepted>` when the run has them, and one
 * `<report day="...">` per earlier report, with `run="..."` on those of the run's day.
 */
export function buildBrief({
  prompt,
  day,
  reportsDir,
  observation,
  install,
  money,
  memory = [],
  accepted = [],
}: {
  prompt: string;
  day: string;
  reportsDir: string;
  observation?: { from: number; to: number; dayFrom: number };
  install?: InstallFacts;
  /** The spend, balances and limits the engine read before the run, with no key in them. */
  money?: MoneyFacts;
  /** Stored facts from group chats that bear on failing work, one line each. */
  memory?: ReadonlyArray<string>;
  /** The owner's accepted findings (src/watcher/accepted.ts), one line each, numbered from 1 in the block. */
  accepted?: ReadonlyArray<string>;
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
    ...(money === undefined ? [] : [`<money>\n${JSON.stringify(money, null, 2)}\n</money>`]),
    ...(memory.length === 0 ? [] : [`<memory>\n${memory.join('\n')}\n</memory>`]),
    ...(accepted.length === 0
      ? []
      : [`<accepted>\n${accepted.map((line, index) => `${index + 1}. ${line}`).join('\n')}\n</accepted>`]),
    ...earlier.slice(-EARLIER_REPORTS),
  ];
  return `${parts.join('\n\n')}\n`;
}
