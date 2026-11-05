// What the watcher's development tests share: a report in the thirteen sections of the template, whatever the older
// fixtures hold, a tasks block after it, the facts of one development checkout and the readers of a stamped section.
// Synthetic data only.
import type { DevelopmentFacts } from '../../src/watcher/development.ts';
import { templateOf } from './watcher-inspection-rig.ts';
import { tasksBlock } from './watcher-rig.ts';

/** The owner's thirteen sections: `Development` stands between the host and the wishes, and `For the owner` stays last. */
export const THIRTEEN: ReadonlyArray<string> = [
  'Her day',
  'Service runs',
  'Memory',
  'Errors',
  'Misunderstandings',
  'Project',
  'Modules and structure',
  'Trash',
  'The server',
  'Development',
  'Wishes',
  'Tasks filed',
  'For the owner',
];

/** The flag every test run from the development checkout carries. */
export const REFUSING_FLAG = '--test-global-setup=tests/fixtures/refuse-manager.ts';

/** A body per section: a string goes under `Inspected without a finding`, an object names its subheadings. */
type Bodies = Readonly<Record<string, string | Readonly<Record<string, string>>>>;

/**
 * A whole answer in thirteen sections, with the drafts' block after it. Each draft with a key brings its finding line at
 * `medium` under `Errors`, its evidence as the text, so it may file.
 */
export function devAnswer(bodies: Bodies = {}, drafts: ReadonlyArray<Record<string, unknown>> = []): string {
  const lines = drafts.flatMap((draft) =>
    typeof draft.finding === 'string' ? [`- [medium] ${draft.finding}: ${String(draft.evidence)}`] : []
  );
  const withLines = lines.length === 0 ? bodies : { ...bodies, Errors: { 'Observed defects': lines.join('\n') } };
  return templateOf({ sections: THIRTEEN, bodies: withLines }) + (drafts.length === 0 ? '' : tasksBlock(drafts));
}

/** One section of a report, its heading left out. */
export function sectionText(report: string, name: string): string {
  const start = report.indexOf(`\n## ${name}\n`);
  if (start === -1) return '';
  const body = report.slice(start + name.length + 5);
  const ends = [body.indexOf('\n## '), body.indexOf('\n```coverage')].filter((at) => at !== -1);
  return ends.length === 0 ? body : body.slice(0, Math.min(...ends));
}

/** One subsection of a section's text, trimmed. */
export function subsectionText(section: string, name: string): string {
  const start = section.indexOf(`### ${name}\n`);
  if (start === -1) return '';
  const body = section.slice(start + name.length + 5);
  const end = body.indexOf('\n### ');
  return (end === -1 ? body : body.slice(0, end)).trim();
}

/** A checkout with a stale base, one worktree and its branch, one failed task and one open pull request. */
export const FACTS: DevelopmentFacts = {
  base: { name: 'trunk', behind: 3 },
  worktrees: [{ name: 'wt-a', ageDays: 9, taskId: 'T-1' }],
  branches: [{ name: 'work/T-1', taskId: 'T-1' }],
  tasks: { filed: 2, running: 1, failed: [{ id: 'T-2', finishReason: 'over-budget' }], waiting: 1, merged: 4 },
  pullRequests: [{ number: 12, branch: 'work/T-1', ci: 'failure' }],
  worker: { state: 'active', since: null },
  modules: true,
};
