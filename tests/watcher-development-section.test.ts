// The report's thirteenth section, `Development`. Changed by the lead's ruling, B12.1 of the plan: with the mode off the
// section does not exist, not even as an empty heading. With the mode on the engine writes what it read of the checkout, the board, GitHub and the worker
// under the section's subheadings, with no model call and no write to the checkout. `developmentFacts` gets a real git
// repository, a real memory database and a fake `gh` and `systemctl`. Counts and names only: no diff and no file content.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { openMemoryDb } from '../src/memory/db/open.ts';
import { dbOf } from '../src/memory/db/types.ts';
import type { Db } from '../src/memory/db/types.ts';
import type { DevelopmentFacts, DevelopmentMode } from '../src/watcher/development.ts';
import * as reports from '../src/watcher/report.ts';
import { FACTS, THIRTEEN, devAnswer, sectionText, subsectionText } from './fixtures/watcher-development-rig.ts';
import { templateOf } from './fixtures/watcher-inspection-rig.ts';
import { tempDir } from './fixtures/tmp.ts';

const development = () => import('../src/watcher/development.ts');

// ---------- the place of the section ----------

test('the section stands right after `The server`, and `For the owner` stays the last of thirteen', () => {
  // Bug: the section moves with each change, so two reports cannot be compared, and `For the owner` no longer closes.
  assert.deepEqual([...reports.REPORT_HEADINGS], [...THIRTEEN]);
});

test('with the mode on a report without the section is refused', () => {
  // Bug: the section is optional in the mode, and a report that left it out reads as a clean development checkout.
  // Changed by B12.1: the refusal holds with the mode on, and the next test holds the mode off.
  const twelve = templateOf({ sections: THIRTEEN.filter((one) => one !== 'Development') });
  const checked = reports.checkTemplate(twelve, { development: true });
  assert.equal(checked.ok ? 'passed' : checked.code, 'missing-heading');
});

test('with the mode off a report with the section is refused and one without it passes', () => {
  // Bug: B12.1 of the plan: the checker takes the section in any mode, and it leaks into a report with no development.
  const twelve = templateOf({ sections: THIRTEEN.filter((one) => one !== 'Development') });
  const checked = reports.checkTemplate(devAnswer());
  assert.equal(checked.ok ? 'passed' : checked.code, 'extra-heading');
  assert.ok(reports.checkTemplate(twelve).ok);
});

test('a report with thirteen sections passes, findings allowed under the new section', () => {
  // Bug: the section joins the list without the four subheadings, or its findings are refused as stray text.
  // Changed by B12.1: the section belongs to the template with the mode on.
  const checked = reports.checkTemplate(
    devAnswer({ Development: { 'Observed defects': '- [medium] dead-export: src/a.ts:1 is called by nothing' } }),
    { development: true }
  );
  assert.ok(checked.ok, checked.ok ? '' : `${checked.code} ${checked.detail}`);
});

// ---------- the mode off ----------

test('with the mode off the section does not exist, not even as an empty heading, and the report passes', async () => {
  // Bug: B12.1 of the plan: an install with no development carries a heading about a checkout it does not have.
  // Changed by B12.1: this test expected the line `not configured`, which the owner's word rules out.
  const { stampDevelopment } = await development();
  const text = stampDevelopment(devAnswer(), { on: false });
  assert.equal(text.includes('## Development'), false);
  assert.equal(text.includes('not configured'), false);
  assert.ok(reports.checkTemplate(text).ok);
});

test('with the mode off whatever the agent wrote in the section is gone', async () => {
  // Bug: without a dev folder the model invents a finding about code it was never given, and the finding files.
  const { stampDevelopment } = await development();
  const text = stampDevelopment(
    devAnswer({ Development: { 'Observed defects': '- [high] made-up: src/a.ts:1 looks wrong' } }),
    { on: false }
  );
  assert.equal(text.includes('made-up'), false);
  assert.deepEqual(reports.findingLines(text), []);
});

// ---------- the mode on: the lines ----------

const stampedOn = async (facts: DevelopmentFacts | null = FACTS, answer: string = devAnswer()): Promise<string> =>
  (await development()).stampDevelopment(answer, { on: true, facts });
const inspected = (text: string): string =>
  subsectionText(sectionText(text, 'Development'), 'Inspected without a finding');
const unavailable = (text: string): string => subsectionText(sectionText(text, 'Development'), 'Unavailable checks');

test('a stale base, one failed task and one open pull request are all in the section', async () => {
  // Bug: B12.5 of the plan: the three facts the owner reads first are computed and fall out of the section.
  const lines = inspected(await stampedOn());
  assert.match(lines, /trunk.*behind.*3|behind.*3.*trunk/);
  assert.match(lines, /T-2.*over-budget/);
  assert.match(lines, /#12.*failure/);
});

test('the section names each worktree with its age and task, the branches, the counts and the worker', async () => {
  // Bug: a worktree left for nine days stays invisible, because only the count or only the name reaches the report.
  const lines = inspected(await stampedOn());
  assert.match(lines, /wt-a.*9.*T-1/);
  assert.match(lines, /work\/T-1/);
  assert.match(lines, /filed\D*2/);
  assert.match(lines, /running\D*1/);
  assert.match(lines, /waiting\D*1/);
  assert.match(lines, /merged\D*4/);
  assert.match(lines, /active/);
});

test('the lines are no findings: nothing is counted or filed from them, and the report passes', async () => {
  // Bug: B12.3 of the plan: a fact line shaped like a finding raises the report's risk and files a task on its own.
  const text = await stampedOn();
  assert.ok(reports.checkTemplate(text, { development: true }).ok);
  assert.deepEqual(reports.findingLines(text), []);
});

test('the agent keeps its findings under the section when the mode is on', async () => {
  // Bug: the engine's write replaces the section as it does with the mode off, and every code finding is lost.
  const text = await stampedOn(
    FACTS,
    devAnswer({ Development: { 'Observed defects': '- [medium] dead-export: src/a.ts:1 is called by nothing' } })
  );
  assert.deepEqual(
    reports.findingLines(text).map((one) => one.key),
    ['dead-export']
  );
  assert.match(inspected(text), /T-2/);
});

test('`gh` failing gives the line `pull requests unavailable`, never a count', async () => {
  // Bug: B12.5 of the plan: a logged-out `gh` reads as no open pull request, and a red one is missed.
  const text = await stampedOn({ ...FACTS, pullRequests: null });
  assert.match(unavailable(text), /pull requests unavailable/);
  assert.doesNotMatch(inspected(text), /pull request/i);
});

test('no open pull request is said as such and is not called unavailable', async () => {
  // Bug: an empty list and a failed read print the same line, so the owner chases a login that works.
  const text = await stampedOn({ ...FACTS, pullRequests: [] });
  assert.doesNotMatch(unavailable(text), /pull requests unavailable/);
  assert.match(inspected(text), /pull request/i);
});

test('a missing `node_modules` is said, since the executor cannot run tests without it', async () => {
  // Bug: every task fails on its tests for days, and nothing in the report says why.
  const text = await stampedOn({ ...FACTS, modules: false });
  assert.match(`${inspected(text)}\n${unavailable(text)}`, /node_modules/);
});

test('each fact that could not be read is named under `Unavailable checks`, with no zero in its place', async () => {
  // Bug: a board that cannot be read prints `failed 0`, which looks like a healthy day.
  const text = await stampedOn({ ...FACTS, base: { name: 'trunk', behind: null }, tasks: null, worker: null });
  const gaps = unavailable(text);
  assert.match(gaps, /trunk/);
  assert.match(gaps, /board/);
  assert.match(gaps, /worker/);
  assert.doesNotMatch(inspected(text), /behind|failed|filed/);
});

test('no facts at all still leave the section in the template, saying they could not be read', async () => {
  // Bug: a probe that threw leaves `none` everywhere, the same as a clean checkout.
  const text = await stampedOn(null);
  assert.ok(reports.checkTemplate(text, { development: true }).ok);
  assert.match(unavailable(text), /development facts unavailable/);
});

// ---------- the mode on: reading the facts ----------

const git = (cwd: string, ...args: Array<string>): string =>
  execFileSync('git', ['-c', 'user.name=spec', '-c', 'user.email=spec@example.invalid', '-C', cwd, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });

const NINE_DAYS_AGO = Date.now() - 9 * 86_400_000 - 3_600_000;

/** A checkout on `trunk` three commits behind `origin/trunk`, with one worktree a task left and one nothing owns. */
function checkoutRig(): string {
  // Changed: the folder's name held the word `checkout`, which the test of the git commands below looks for in each line.
  const checkout = tempDir('nep-watcher-dev-repo-');
  git(checkout, 'init', '--quiet', '-b', 'trunk');
  for (const one of ['a', 'b', 'c', 'd']) git(checkout, 'commit', '--quiet', '--allow-empty', '-m', one);
  git(checkout, 'update-ref', 'refs/remotes/origin/trunk', 'HEAD');
  git(checkout, 'reset', '--quiet', '--hard', 'HEAD~3');
  for (const [folder, branch] of [
    ['wt-a', 'work/T-1'],
    ['stray', 'work/stray'],
  ] as const) {
    git(checkout, 'worktree', 'add', '--quiet', path.join(checkout, '.worktrees', folder), '-b', branch);
    const when = new Date(NINE_DAYS_AGO);
    fs.utimesSync(path.join(checkout, '.worktrees', folder), when, when);
  }
  return checkout;
}

/** A memory database whose board holds each state the section counts, and tasks it must not. */
function boardRig(checkout: string): { read: <T>(read: (db: Db) => T) => T | null } {
  const handle = openMemoryDb(path.join(tempDir('nep-watcher-dev-board-'), 'memory.db'));
  const db = dbOf(handle);
  const task = (id: string, status: string, lane = 'dev', metadata: string | null = null): void => {
    db.prepare(
      `INSERT INTO board_tasks (id, lane, title, description, requester, status, created_at, updated_at, metadata)
       VALUES (?, ?, 'TITLE-PLANTED', 'BODY-PLANTED', 'watcher', ?, '', '', ?)`
    ).run(id, lane, status, metadata);
  };
  task('T-proposed', 'proposed');
  task('T-triaged', 'triaged');
  task('T-1', 'in_progress');
  task('T-2', 'failed');
  task('T-waiting', 'needs_validation');
  task('T-merged', 'done', 'dev', JSON.stringify({ merged: { number: 9 } }));
  task('T-unmerged', 'done');
  task('E-1', 'failed', 'errand');
  const attempt = (
    id: string,
    taskId: string,
    n: number,
    fields: { worktree?: string; branch?: string; reason?: string }
  ): void => {
    db.prepare(
      `INSERT INTO board_attempts (id, task_id, n, worktree, branch, started_at, finish_reason)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      id,
      taskId,
      n,
      fields.worktree ?? null,
      fields.branch ?? null,
      new Date(NINE_DAYS_AGO).toISOString(),
      fields.reason ?? null
    );
  };
  attempt('a-1', 'T-1', 1, { worktree: path.join(checkout, '.worktrees', 'wt-a'), branch: 'work/T-1' });
  attempt('a-2', 'T-2', 1, { reason: 'timeout' });
  attempt('a-3', 'T-2', 2, { reason: 'over-budget' });
  attempt('a-4', 'E-1', 1, { reason: 'errand-reason' });
  return { read: (read) => read(db) };
}

const REPOSITORY = 'example/engine';
const OPEN_PRS = [
  {
    number: 12,
    title: 'TITLE-PLANTED',
    headRefName: 'work/T-1',
    statusCheckRollup: [
      { status: 'COMPLETED', conclusion: 'SUCCESS' },
      { status: 'COMPLETED', conclusion: 'FAILURE' },
    ],
  },
  { number: 13, title: 'x', headRefName: 'b', statusCheckRollup: [{ status: 'COMPLETED', conclusion: 'SUCCESS' }] },
  { number: 14, title: 'x', headRefName: 'c', statusCheckRollup: [{ status: 'IN_PROGRESS', conclusion: '' }] },
  { number: 15, title: 'x', headRefName: 'd', statusCheckRollup: [] },
];

type Run = (command: string, args: ReadonlyArray<string>) => Promise<{ code: number; stdout: string; stderr: string }>;
type Called = Array<{ command: string; args: ReadonlyArray<string> }>;

/** Real git, a canned `gh` and `systemctl`, and nothing else on the machine. */
function runOf(called: Called, over: { gh?: Run; systemctl?: Run } = {}): Run {
  return (command, args) => {
    called.push({ command, args });
    if (command === 'git') {
      return new Promise((resolve) => {
        execFile('git', [...args], { encoding: 'utf8' }, (error, stdout, stderr) => {
          resolve({ code: error === null ? 0 : 1, stdout, stderr });
        });
      });
    }
    if (command === 'gh')
      return over.gh?.(command, args) ?? Promise.resolve({ code: 0, stdout: JSON.stringify(OPEN_PRS), stderr: '' });
    if (command === 'systemctl') {
      if (over.systemctl !== undefined) return over.systemctl(command, args);
      const stdout = args.includes('is-active') ? 'active\n' : 'ActiveState=active\nActiveEnterTimestamp=n/a\n';
      return Promise.resolve({ code: 0, stdout, stderr: '' });
    }
    return Promise.resolve({ code: 127, stdout: '', stderr: `no ${command} here` });
  };
}

const modeAt = (checkout: string): Extract<DevelopmentMode, { on: true }> => ({
  on: true,
  checkout,
  repository: REPOSITORY,
  base: 'trunk',
});

let shared: Promise<{ facts: DevelopmentFacts; checkout: string; called: Called }> | null = null;

/** The facts of the one prepared checkout, read once: everything here only reads. */
const readOnce = () =>
  (shared ??= (async () => {
    const checkout = checkoutRig();
    const called: Called = [];
    const board = boardRig(checkout);
    const { developmentFacts } = await development();
    const facts = await developmentFacts({
      mode: modeAt(checkout),
      run: runOf(called),
      readMemory: board.read,
      now: () => Date.now(),
    });
    return { facts, checkout, called };
  })());

test('the base is read as commits behind `origin/<base>`, from the base the settings name', async () => {
  // Bug: the count compares against `origin/main`, or against HEAD of a worktree, and a stale checkout reads as current.
  assert.deepEqual((await readOnce()).facts.base, { name: 'trunk', behind: 3 });
});

test('each worktree under `.worktrees` comes with its age and the task `board_attempts` holds for it', async () => {
  // Bug: the task is guessed from the folder's name, or a worktree nobody owns is dropped, and that one is the leftover.
  const { worktrees } = (await readOnce()).facts;
  const byName = (name: string) => worktrees.find((one) => one.name === name);
  assert.equal(worktrees.length, 2);
  assert.equal(byName('wt-a')?.taskId, 'T-1');
  assert.equal(byName('wt-a')?.ageDays, 9);
  assert.equal(byName('stray')?.taskId, null);
});

test('the branches the executor left are named with their tasks, and the base is not one of them', async () => {
  // Bug: the base counts as a leftover, so the count is never zero and nobody reads it.
  const { branches } = (await readOnce()).facts;
  // Changed: `localeCompare` puts `work/stray` ahead of `work/T-1`, so the sorted list had its two rows the wrong way round.
  assert.deepEqual(
    [...branches].sort((a, b) => a.name.localeCompare(b.name)),
    [
      { name: 'work/stray', taskId: null },
      { name: 'work/T-1', taskId: 'T-1' },
    ]
  );
});

test('the tasks of the development lane are counted by state, and errands stay out', async () => {
  // Bug: a failed errand reads as a failed development task, or a closed task with no merge counts as merged.
  const { tasks } = (await readOnce()).facts;
  assert.equal(tasks?.filed, 2);
  assert.equal(tasks?.running, 1);
  assert.equal(tasks?.waiting, 1);
  assert.equal(tasks?.merged, 1);
});

test('a failed task carries the `finish_reason` of its last attempt', async () => {
  // Bug: the first attempt's reason is reported, and the owner hunts a timeout that a retry already passed.
  assert.deepEqual((await readOnce()).facts.tasks?.failed, [{ id: 'T-2', finishReason: 'over-budget' }]);
});

test('the open pull requests come from the configured repository, each with its CI conclusion', async () => {
  // Bug: `gh` picks the repository from the folder it runs in, and the worst check of a pull request is lost.
  const { facts, called } = await readOnce();
  const gh = called.find((one) => one.command === 'gh');
  assert.ok(gh?.args.includes(REPOSITORY), gh?.args.join(' ') ?? 'no gh call');
  assert.deepEqual(
    facts.pullRequests?.map((one) => [one.number, one.ci]),
    [
      [12, 'failure'],
      [13, 'success'],
      [14, 'pending'],
      [15, 'none'],
    ]
  );
});

test('the worker line reads the state of `neptunia-development.service`', async () => {
  // Bug: a dead worker with a full queue reads as a quiet day. The unit is a service with no timer of its own.
  const { facts, called } = await readOnce();
  assert.equal(facts.worker?.state, 'active');
  const asked = called.find((one) => one.command === 'systemctl');
  assert.ok(asked?.args.includes('neptunia-development.service'), asked?.args.join(' ') ?? 'no systemctl call');
});

test('a checkout with no `node_modules` says so, and one with it says that', async () => {
  // Bug: the fact reads the install's folder, which always has it, and the executor's failing tests go unexplained.
  const { developmentFacts } = await development();
  const checkout = tempDir('nep-watcher-dev-modules-');
  const read = () =>
    developmentFacts({ mode: modeAt(checkout), run: runOf([]), readMemory: () => null, now: () => Date.now() });
  assert.equal((await read()).modules, false);
  fs.mkdirSync(path.join(checkout, 'node_modules'));
  assert.equal((await read()).modules, true);
});

test('reading the facts runs only git, `gh` and `systemctl`, and no git command that changes or opens anything', async () => {
  // Bug: B12.2 of the plan: a `git fetch` writes into the live checkout, a `worktree prune` removes the executor's work,
  // a `diff` carries file contents, and any other child could be a model.
  const { called } = await readOnce();
  assert.deepEqual([...new Set(called.map((one) => one.command))].sort(), ['gh', 'git', 'systemctl']);
  const gits = called.filter((one) => one.command === 'git').map((one) => one.args.join(' '));
  assert.ok(gits.length > 0);
  for (const line of gits)
    assert.doesNotMatch(line, /\b(fetch|pull|push|gc|prune|remove|reset|checkout|switch|clean|diff|show|cat-file)\b/);
});

test('titles and bodies of tasks and pull requests stay out of the facts', async () => {
  // Bug: B12.2 of the plan: a task's title quotes a chat, and a report keeps it for good.
  const text = JSON.stringify((await readOnce()).facts);
  assert.equal(text.includes('TITLE-PLANTED'), false);
  assert.equal(text.includes('BODY-PLANTED'), false);
});

for (const [name, gh] of [
  ['exits non-zero', () => Promise.resolve({ code: 1, stdout: '', stderr: 'auth' })],
  ['answers no JSON', () => Promise.resolve({ code: 0, stdout: 'not json', stderr: '' })],
  ['answers no list', () => Promise.resolve({ code: 0, stdout: '{}', stderr: '' })],
  ['cannot be started', () => Promise.reject(new Error('spawn gh ENOENT'))],
] as ReadonlyArray<readonly [string, Run]>) {
  test(`pull requests read as unavailable when \`gh\` ${name}`, async () => {
    // Bug: B12.5 of the plan: the failure becomes an empty list, or it throws and the whole section is lost.
    const { developmentFacts } = await development();
    const facts = await developmentFacts({
      mode: modeAt(tempDir('nep-watcher-dev-nogit-')),
      run: runOf([], { gh }),
      readMemory: () => null,
      now: () => Date.now(),
    });
    assert.equal(facts.pullRequests, null);
  });
}

test('a checkout folder that is gone, a board and a manager that do not answer give gaps and no throw', async () => {
  // Bug: a removed folder makes `developmentFacts` throw at the worst moment, when the owner most needs the report.
  const { developmentFacts } = await development();
  const facts = await developmentFacts({
    mode: modeAt(path.join(tempDir('nep-watcher-dev-gone-'), 'absent')),
    run: runOf([], { systemctl: () => Promise.resolve({ code: 1, stdout: '', stderr: '' }) }),
    readMemory: () => null,
    now: () => Date.now(),
  });
  assert.equal(facts.base.behind, null);
  assert.deepEqual(facts.worktrees, []);
  assert.deepEqual(facts.branches, []);
  assert.equal(facts.tasks, null);
  assert.equal(facts.worker, null);
  assert.equal(facts.modules, false);
});
