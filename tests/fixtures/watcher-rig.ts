// What the watcher tests share: a temp watcher folder (prompt.md and reports/), a task row, and builders for a report
// that holds the seven headings and a tasks block. Synthetic data only; no provider, no database, no socket.
import fs from 'node:fs';
import path from 'node:path';
import type { TaskRecord } from '../../src/board/board.ts';
import { tempDir } from './tmp.ts';

/** The headings of a report, in order (src/watcher/report.ts#REPORT_HEADINGS). */
export const HEADINGS: ReadonlyArray<string> = [
  'Her day',
  'Misunderstandings',
  'Memory',
  'The project',
  'The server',
  'Tasks filed',
  'For the owner',
];

/** A report with every heading, each holding `bodies[heading]` or the line "nothing found". */
export function reportText(bodies: Readonly<Record<string, string>> = {}): string {
  return (
    HEADINGS.map((heading) => `## ${heading}\n\n${bodies[heading] ?? 'nothing found'}\n`).join('\n')
  );
}

/** A `tasks` block as the agent ends its answer with. */
export function tasksBlock(drafts: ReadonlyArray<Record<string, unknown>>): string {
  return '```tasks\n' + JSON.stringify(drafts, null, 2) + '\n```\n';
}

/** A key shaped like an OpenRouter key, built in pieces so no scanner sees one in the source. */
export const PLANTED_KEY = ['sk', 'or', 'v1', 'a1b2c3d4e5f60718293a4b5c6d7e8f9012345678'].join('-');

export type WatcherDirs = { root: string; watcherDir: string; reportsDir: string };

/** `.agents/watcher/` in a temp folder, with `prompt.md` written and an empty `reports/`. */
export function watcherDirs(prompt = 'PROMPT-SENTINEL: the three questions.'): WatcherDirs {
  const root = tempDir('nep-watcher-');
  const watcherDir = path.join(root, '.agents', 'watcher');
  const reportsDir = path.join(watcherDir, 'reports');
  fs.mkdirSync(reportsDir, { recursive: true });
  fs.writeFileSync(path.join(watcherDir, 'prompt.md'), prompt);
  return { root, watcherDir, reportsDir };
}

/** Writes `<day>.md` into the reports folder. */
export function putReport(dirs: WatcherDirs, day: string, text: string): void {
  fs.writeFileSync(path.join(dirs.reportsDir, `${day}.md`), text);
}

/** One task row with the fields the watcher reads. */
export function taskRow(fields: Partial<TaskRecord> & { id: string }): TaskRecord {
  return {
    lane: 'dev',
    project: null,
    title: 'a task',
    description: null,
    acceptance: null,
    requester: 'watcher',
    priority: 2,
    risk: 'normal',
    role: null,
    budget_usd: null,
    step_cap: null,
    estimate_minutes: null,
    status: 'proposed',
    close_reason: null,
    defer_until: null,
    is_blocked: 0,
    revision: 1,
    lease_owner: null,
    lease_expires_at: null,
    heartbeat_at: null,
    subscriber: null,
    created_at: '2026-11-01T00:00:00.000Z',
    updated_at: '2026-11-01T00:00:00.000Z',
    metadata: null,
    lease_generation: 0,
    blocked_reason: null,
    unblocks: null,
    ...fields,
  };
}
