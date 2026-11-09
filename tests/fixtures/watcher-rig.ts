// What the watcher tests share: a temp watcher folder (prompt.md and reports/) and a builder for a report that holds the
// twelve headings. Synthetic data only; no provider, no database, no socket.
import fs from 'node:fs';
import path from 'node:path';
import { tempDir } from './tmp.ts';

/** The headings of a report, in order (src/watcher/report.ts#REPORT_HEADINGS). */
export const HEADINGS: ReadonlyArray<string> = [
  'Her day',
  'Service runs',
  'Memory',
  'Money',
  'Errors',
  'Misunderstandings',
  'Project',
  'Modules and structure',
  'Trash',
  'The server',
  'Wishes',
  'For the owner',
];

/** A report with every heading, each holding `bodies[heading]` or the line "nothing found". */
export function reportText(bodies: Readonly<Record<string, string>> = {}): string {
  return (
    HEADINGS.map((heading) => `## ${heading}\n\n${bodies[heading] ?? 'nothing found'}\n`).join('\n')
  );
}

/** A key shaped like an OpenRouter key, built in pieces so no scanner sees one in the source. */
export const PLANTED_KEY = ['sk', 'or', 'v1', 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'].join('-');

export type WatcherDirs = { root: string; watcherDir: string; reportsDir: string };

/** `agents/watcher/` (DEFAULT_WATCHER_DIR) in a temp folder, with `prompt.md` written and an empty `reports/`. */
export function watcherDirs(prompt = 'PROMPT-SENTINEL: the three questions.'): WatcherDirs {
  const root = tempDir('nep-watcher-');
  const watcherDir = path.join(root, 'agents', 'watcher');
  const reportsDir = path.join(watcherDir, 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  fs.writeFileSync(path.join(watcherDir, 'prompt.md'), prompt);
  return { root, watcherDir, reportsDir };
}

/** Writes `<day>.md` into the reports folder. */
export function putReport(dirs: WatcherDirs, day: string, text: string): void {
  fs.writeFileSync(path.join(dirs.reportsDir, `${day}.md`), text);
}
