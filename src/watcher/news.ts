// What the persona's selfimprovement wake carries of the watcher: the newest report of the past day, its date and the
// bodies of its `## For the owner` and `## Tasks filed` sections. src/core.ts hands `watcherNews` to the inner life as
// a source, and src/behavior/inner/selfimprovement.ts asks it with the wake's time. The watcher is not part of her,
// so this is the one way its work reaches her. Reads the reports folder of `watcher.dir`; never throws.

import { utcDay, DAY_MS } from '../time.ts';
import { reportDays, reportText, reportsDirOf } from './read.ts';
import { watcherSettings } from './settings.ts';

export type WatcherNews = { day: string; forOwner: string; tasksFiled: string };

/** The body of the `## <heading>` section of `text`, trimmed, up to the next heading; '' when there is none. */
function sectionOf(text: string, heading: string): string {
  const lines = text.split('\n');
  const start = lines.findIndex((line) => line.trim() === `## ${heading}`);
  if (start === -1) return '';
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => /^#{1,2}\s/.test(line));
  return (end === -1 ? rest : rest.slice(0, end)).join('\n').trim();
}

/**
 * The newest report of the past day (its day is the UTC day of `now` or the one before), with the bodies of its
 * `## For the owner` and `## Tasks filed` sections, trimmed. Null when `watcher.enabled` is not true, when there is no
 * such report, or when both sections are missing or empty. Reads `watcher.dir` under `rootDir`. Never throws.
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
    const text = reportText(reportsDir, day);
    if (text === null) return null;
    const forOwner = sectionOf(text, 'For the owner');
    const tasksFiled = sectionOf(text, 'Tasks filed');
    return forOwner === '' && tasksFiled === '' ? null : { day, forOwner, tasksFiled };
  } catch {
    // An unreadable folder or file leaves the wake without the report; the wake's other facts stay.
    return null;
  }
}
