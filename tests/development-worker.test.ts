// The development worker over a real task board and fakes for git, gh, the test runner and the agent runs
// (tests/fixtures/development-rig.ts). A filed task starts one thinker run in the task's own worktree; the thinker
// files dev work on the board; code keeps the push-right check, the tests before a pull request, the exact-head CI read
// and the one merge. Each test names the bug it catches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import type { TaskRecord } from '../src/board/board.ts';
import { serveDevelopment } from '../src/development/worker.ts';
import type { DevelopmentWorker, WakeReport } from '../src/development/worker.ts';
import { landedFor } from '../src/selfimprovement/landed.ts';
import {
  FAILING_TAP,
  HEAD,
  MINUTE,
  WORKER,
  askPersona,
  childrenOf,
  developmentWorld,
  fakePr,
  fileDevTask,
  generationOf,
  ownerTask,
  settle,
} from './fixtures/development-rig.ts';
import type { CheckState, DevelopmentWorld, FakePullRequest } from './fixtures/development-rig.ts';
import { FIX_REQUEST, herCalls } from './fixtures/selfimprovement-rig.ts';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { labelsFileOf } from '../src/config/labels.ts';
import { developmentEdges } from '../src/development/edges.ts';
import { tempDir } from './fixtures/tmp.ts';

/** What `task.metadata.development` holds: the persisted branch, worktree, pull request and head of the task. */
type Persisted = { branch: string; worktree: string; pr: number | null; head: string | null };

function persisted(world: DevelopmentWorld, id: string): Persisted {
  const development = world.show(id).task.metadata?.development;
  assert.ok(development !== null && typeof development === 'object', 'the task persists metadata.development');
  // The worker writes this shape; the assertions below read its fields.
  return development as Persisted;
}

const statusOf = (world: DevelopmentWorld, id: string): TaskRecord['status'] => world.show(id).task.status;
const hasGitCall = (world: DevelopmentWorld, ...words: ReadonlyArray<string>): boolean =>
  world.git.some((call) => words.every((word) => call.args.includes(word)));

/** Her `task.propose` of a kind, through her tool; the task id. */
async function herProposal(world: DevelopmentWorld, kind: 'fix' | 'skill'): Promise<string> {
  const answer = await herCalls(world.caller)('task.propose', { ...FIX_REQUEST, kind });
  assert.equal(answer.status, 'ok', answer.summary ?? '');
  return String((answer.data as { task: { id: string } }).task.id);
}

/** The pull request on the fake GitHub; a test that reaches this without one is broken. */
function prOf(world: DevelopmentWorld): FakePullRequest {
  if (world.pr === null) throw new Error('no pull request was opened');
  return world.pr;
}

/** A task through its thinker turn to an open pull request, with the CI state the test names. */
async function withPullRequest(world: DevelopmentWorld, checks: Array<CheckState>): Promise<string> {
  const id = ownerTask(world);
  await settle(world.worker());
  assert.equal(statusOf(world, id), 'needs_validation');
  prOf(world).checks = checks;
  return id;
}

function cancelAsOwner(world: DevelopmentWorld, id: string): void {
  const { revision } = world.show(id).task;
  world.board.call('boss', 'task.transition', { id, status: 'cancelled', close_reason: 'Not needed.', revision });
}

/** Wakes, as the board's events would, until a dev run started. */
async function wakeUntilDevRuns(world: DevelopmentWorld, worker: DevelopmentWorker): Promise<void> {
  for (let tries = 0; tries < 100 && world.runsOf('dev').length === 0; tries += 1) {
    await worker.wake();
    await delay(1);
  }
  assert.equal(world.runsOf('dev').length, 1);
}

// ---------- 1. One claim, one thinker run ----------

test('an approved task starts one thinker run in a worktree and branch of that task from the base', async (t) => {
  // Catches: the run works in the checkout, or forks from a base other than the setting at the time of the run.
  const world = developmentWorld(t);
  world.base = 'release';
  const id = ownerTask(world);
  const release = world.hold('thinker');
  const worker = world.worker();
  const report = await worker.wake();
  assert.deepEqual(report.started, [{ taskId: id, agent: 'thinker' }]);
  assert.deepEqual(
    world.runs.map((run) => run.agent),
    ['thinker']
  );
  const add = world.gitCalls('worktree').find((args) => args[1] === 'add');
  assert.equal(add?.[2], '-b');
  assert.equal(add?.at(-1), 'release');
  const { branch, worktree } = persisted(world, id);
  assert.ok(branch.includes(id), `the branch ${branch} names the task`);
  assert.equal(add?.[3], branch);
  assert.ok(worktree.startsWith(world.worktreeRoot) && worktree.includes(id));
  assert.equal(world.runs[0]?.cwd, worktree);
  assert.notEqual(world.runs[0]?.cwd, world.repoDir);
  assert.equal(statusOf(world, id), 'in_progress');
  release();
  await worker.idle();
});

test('two workers waking together start one thinker run', async (t) => {
  // Catches: both workers list the task as ready and both start a run because the claim is not what decides.
  const world = developmentWorld(t);
  const id = ownerTask(world);
  const release = world.hold('thinker');
  const [one, two] = [world.worker(), world.worker()];
  const reports = await Promise.all([one.wake(), two.wake()]);
  assert.equal(reports.flatMap((report) => report.started).length, 1);
  assert.equal(world.runsOf('thinker').length, 1);
  assert.equal(world.gitCalls('worktree').filter((args) => args[1] === 'add').length, 1);
  assert.equal(statusOf(world, id), 'in_progress');
  release();
  await Promise.all([one.idle(), two.idle()]);
});

test('a restarted worker leaves a task under a live lease alone', async (t) => {
  // Catches: a new process reads in_progress as an orphan and starts a second thinker beside the running one.
  const world = developmentWorld(t);
  const id = ownerTask(world);
  const release = world.hold('thinker');
  const first = world.worker();
  await first.wake();
  const restarted = world.worker();
  const report = await restarted.wake();
  assert.deepEqual(report.started, []);
  assert.equal(world.runsOf('thinker').length, 1);
  assert.equal(statusOf(world, id), 'in_progress');
  release();
  await first.idle();
});

test('the lease is renewed while a run lasts, so the reaper leaves a long run alone', async (t) => {
  // Catches: a thinker run longer than the lease is reaped and its task run twice.
  const world = developmentWorld(t);
  world.deps.leaseRenewMs = 2;
  const id = ownerTask(world);
  const release = world.hold('thinker');
  const worker = world.worker();
  await worker.wake();
  world.advance(20 * MINUTE);
  await delay(30);
  world.advance(20 * MINUTE);
  assert.deepEqual(world.board.reap(), []);
  assert.equal(statusOf(world, id), 'in_progress');
  release();
  await worker.idle();
});

test('a lapsed lease stops the old run, and the next claim runs one thinker on the same branch', async (t) => {
  // Catches: the old run goes on beside the new one, or its late end writes over the new holder's task.
  const world = developmentWorld(t);
  const id = ownerTask(world);
  world.hold('thinker');
  const worker = world.worker();
  await worker.wake();
  const { branch } = persisted(world, id);
  const before = generationOf(world, id);
  world.advance(31 * MINUTE);
  assert.deepEqual(world.board.reap(), [id]);
  await settle(worker);
  assert.equal(world.runs[0]?.aborted, true);
  assert.equal(world.runsOf('thinker').length, 2);
  assert.ok(generationOf(world, id) > before);
  assert.equal(persisted(world, id).branch, branch);
  assert.equal(statusOf(world, id), 'needs_validation');
  assert.equal(world.created, 1);
});

test('the errand lane stays with the errand runner', async (t) => {
  // Catches: the worker takes every ready task of the board and runs an errand as development.
  const world = developmentWorld(t);
  const errand = ownerTask(world, { lane: 'errand' });
  await settle(world.worker());
  assert.equal(world.runs.length, 0);
  assert.equal(statusOf(world, errand), 'approved');
});

// ---------- 2. The thinker files, dev works ----------

test('dev tasks the thinker files run dev once each, in worktrees of their own from the task branch', async (t) => {
  // Catches: two dev runs share a worktree, or a child branch nests under the task's ref, which git refuses.
  const world = developmentWorld(t);
  const id = ownerTask(world);
  world.scripts.thinker = (_run, turn) => {
    if (turn > 1) return;
    fileDevTask(world, id, 'First scoped step');
    fileDevTask(world, id, 'Second scoped step');
  };
  await settle(world.worker());
  const devRuns = world.runsOf('dev');
  assert.equal(devRuns.length, 2);
  const { branch, worktree } = persisted(world, id);
  const cwds = devRuns.map((run) => run.cwd);
  assert.equal(new Set(cwds).size, 2);
  assert.ok(!cwds.includes(worktree) && !cwds.includes(world.repoDir));
  for (const child of childrenOf(world, id)) {
    const own = persisted(world, child);
    assert.ok(cwds.includes(own.worktree));
    assert.ok(own.branch.includes(id) && own.branch.includes(child), `${own.branch} names task and child`);
    assert.ok(!own.branch.startsWith(`${branch}/`), 'a ref under the branch cannot exist beside it');
    const add = world.gitCalls('worktree').find((args) => args[3] === own.branch);
    assert.equal(add?.at(-1), branch);
  }
  assert.ok(devRuns.every((run) => run.brief.includes('The scoped plan')));
});

test('the thinker runs again in its worktree once the last dev task closed, and only then', async (t) => {
  // Catches: the thinker's next turn starts while a dev run is working, or never starts.
  const world = developmentWorld(t);
  const id = ownerTask(world);
  let devsOpenAtSecondTurn: number | null = null;
  world.scripts.thinker = (_run, turn) => {
    if (turn === 1) fileDevTask(world, id, 'The one step');
    else devsOpenAtSecondTurn = childrenOf(world, id).filter((one) => world.show(one).task.status !== 'done').length;
  };
  await settle(world.worker());
  const [first, second] = world.runsOf('thinker');
  assert.equal(world.runsOf('thinker').length, 2);
  assert.equal(second?.cwd, first?.cwd);
  assert.equal(devsOpenAtSecondTurn, 0);
  assert.equal(statusOf(world, id), 'needs_validation');
});

test('the task keeps its lease while its dev tasks run', async (t) => {
  // Catches: the thinker's turn ended, nobody renews the task, and the reaper restarts it under a working dev.
  const world = developmentWorld(t);
  world.deps.leaseRenewMs = 2;
  const id = ownerTask(world);
  world.scripts.thinker = (_run, turn) => {
    if (turn === 1) fileDevTask(world, id, 'A long step');
  };
  const release = world.hold('dev');
  const worker = world.worker();
  await wakeUntilDevRuns(world, worker);
  world.advance(20 * MINUTE);
  await delay(30);
  world.advance(20 * MINUTE);
  assert.deepEqual(world.board.reap(), []);
  release();
  await settle(worker);
  assert.equal(world.runsOf('thinker').length, 2);
});

test('a failed dev run closes its dev task failed with the error, and the thinker still decides', async (t) => {
  // Catches: a crashed dev leaves its child open, so the parent waits for ever.
  const world = developmentWorld(t);
  const id = ownerTask(world);
  world.scripts.thinker = (_run, turn) => {
    if (turn === 1) fileDevTask(world, id, 'A step that breaks');
  };
  world.scripts.dev = () => ({ ok: false, text: '', exitCode: 3 });
  await settle(world.worker());
  const child = childrenOf(world, id)[0] ?? '';
  assert.equal(statusOf(world, child), 'failed');
  assert.match(world.show(child).task.close_reason ?? '', /\S/);
  assert.equal(world.runsOf('thinker').length, 2);
});

test('only the top task opens a pull request; a dev task never pushes', async (t) => {
  // Catches: each dev run ends in a pull request of its own instead of one per task.
  const world = developmentWorld(t);
  const id = ownerTask(world);
  world.scripts.thinker = (_run, turn) => {
    if (turn === 1) fileDevTask(world, id, 'A step');
  };
  await settle(world.worker());
  assert.equal(world.created, 1);
  assert.equal(world.pr?.branch, persisted(world, id).branch);
  assert.equal(world.gitCalls('push').length, 1);
});

// ---------- 3. Statuses and the way back to her ----------

test('a question to persona:self waits needs_answer and starts nothing until she answers', async (t) => {
  // Catches: the wait counts as an end of the thinker, which fails the task or opens a pull request.
  const world = developmentWorld(t);
  const id = await herProposal(world, 'fix');
  world.scripts.thinker = (_run, turn) => {
    if (turn === 1) askPersona(world, id, 'Which timeout do you want?');
  };
  await settle(world.worker());
  assert.equal(statusOf(world, id), 'needs_answer');
  assert.equal(world.show(id).questions[0]?.to_whom, 'persona:self');
  assert.equal(world.created, 0);
  assert.equal(world.runsOf('thinker').length, 1);
});

test('her answer resumes the task: the thinker runs again on its branch and reads the answer', async (t) => {
  // Catches: the answer closes the question and nothing runs, or the thinker starts over without it.
  const world = developmentWorld(t);
  const id = await herProposal(world, 'fix');
  world.scripts.thinker = (_run, turn) => {
    if (turn === 1) askPersona(world, id, 'Which timeout do you want?');
  };
  const worker = world.worker();
  await settle(worker);
  const questionId = String(world.show(id).questions[0]?.id);
  const answer = await herCalls(world.caller)('task.answer', { question_id: questionId, text: 'Fifteen seconds.' });
  assert.equal(answer.status, 'ok', answer.summary ?? '');
  await settle(worker);
  const [first, second] = world.runsOf('thinker');
  assert.equal(world.runsOf('thinker').length, 2);
  assert.equal(second?.cwd, first?.cwd);
  assert.ok(second?.brief.includes('Fifteen seconds.'));
  assert.equal(statusOf(world, id), 'needs_validation');
});

test('an answer resumes exactly once when two workers wake on it', async (t) => {
  // Catches: both workers see an in_progress task with no run of theirs and both start a thinker.
  const world = developmentWorld(t);
  const id = await herProposal(world, 'fix');
  world.scripts.thinker = (_run, turn) => {
    if (turn === 1) askPersona(world, id, 'Which timeout do you want?');
  };
  const [one, two] = [world.worker(), world.worker()];
  await settle(one);
  await herCalls(world.caller)('task.answer', {
    question_id: String(world.show(id).questions[0]?.id),
    text: 'Fifteen seconds.',
  });
  const release = world.hold('thinker');
  await Promise.all([one.wake(), two.wake()]);
  assert.equal(world.runsOf('thinker').length, 2);
  release();
  await Promise.all([one.idle(), two.idle()]);
});

test('a block by the thinker keeps its reason, and her unblock runs the thinker again on the branch', async (t) => {
  // Catches: a blocked task is failed, or its resume makes a second branch.
  const world = developmentWorld(t);
  const id = await herProposal(world, 'fix');
  world.scripts.thinker = (_run, turn) => {
    if (turn === 1) {
      world.board.call(WORKER, 'task.block', {
        id,
        generation: generationOf(world, id),
        reason: 'The fixture is missing.',
        unblocks: 'A fixture with the new schema.',
      });
    }
  };
  const worker = world.worker();
  await settle(worker);
  assert.equal(statusOf(world, id), 'blocked');
  assert.equal(world.show(id).task.blocked_reason, 'The fixture is missing.');
  assert.equal(world.created, 0);
  const { branch } = persisted(world, id);
  const answer = await herCalls(world.caller)('task.unblock', { id, note: 'The fixture is in tests/fixtures.' });
  assert.equal(answer.status, 'ok', answer.summary ?? '');
  await settle(worker);
  const [first, second] = world.runsOf('thinker');
  assert.equal(second?.cwd, first?.cwd);
  assert.equal(persisted(world, id).branch, branch);
  assert.equal(statusOf(world, id), 'needs_validation');
});

test('cancelling stops the running thinker and leaves its branch and worktree to inspect', async (t) => {
  // Catches: a cancel only moves the status while the agent goes on, or the cleanup destroys the evidence.
  const world = developmentWorld(t);
  const id = ownerTask(world);
  world.hold('thinker');
  const worker = world.worker();
  await worker.wake();
  cancelAsOwner(world, id);
  await worker.wake();
  await worker.idle();
  assert.equal(world.runs[0]?.aborted, true);
  assert.equal(statusOf(world, id), 'cancelled');
  assert.equal(world.created, 0);
  assert.equal(world.gitCalls('push').length, 0);
  assert.ok(!hasGitCall(world, 'worktree', 'remove') && !hasGitCall(world, 'branch', '-D'));
  assert.ok(persisted(world, id).branch.includes(id));
});

test('cancelling a task stops its running dev runs and cancels its dev tasks', async (t) => {
  // Catches: the dev children outlive their cancelled task and go on spending.
  const world = developmentWorld(t);
  const id = ownerTask(world);
  world.scripts.thinker = (_run, turn) => {
    if (turn === 1) fileDevTask(world, id, 'A long step');
  };
  world.hold('dev');
  const worker = world.worker();
  await wakeUntilDevRuns(world, worker);
  cancelAsOwner(world, id);
  await worker.wake();
  await worker.idle();
  assert.equal(world.runsOf('dev')[0]?.aborted, true);
  assert.equal(statusOf(world, childrenOf(world, id)[0] ?? ''), 'cancelled');
  assert.ok(!hasGitCall(world, 'worktree', 'remove'));
  assert.equal(world.created, 0);
});

// ---------- 4. What code keeps ----------

test('the tests of the touched modules run before the pull request, in the worktree, and only those', async (t) => {
  // Catches: a pull request opens on the agent's word, or the whole suite runs.
  const world = developmentWorld(t);
  ownerTask(world);
  await settle(world.worker());
  const tests = world.order.indexOf('tests');
  assert.ok(tests >= 0 && tests < world.order.indexOf('git push'));
  assert.ok(world.order.indexOf('git push') < world.order.indexOf('gh pr create'));
  const run = world.tests[0];
  assert.ok(run?.args.includes('tests/web-read.test.ts'));
  assert.ok(!run?.args.includes('tests/unrelated.test.ts'));
  assert.notEqual(run?.cwd, world.repoDir);
});

test('failing tests stop the task: nothing pushed, no pull request, failed with the command', async (t) => {
  // Catches: a red change reaches GitHub because the thinker said it was fine.
  const world = developmentWorld(t);
  const id = ownerTask(world);
  world.testRun = { code: 1, stdout: FAILING_TAP };
  await settle(world.worker());
  assert.equal(world.gitCalls('push').length, 0);
  assert.equal(world.created, 0);
  assert.equal(statusOf(world, id), 'failed');
  assert.match(world.show(id).task.close_reason ?? '', /tests-failed/);
});

test('a thinker that changed nothing opens no pull request', async (t) => {
  // Catches: an empty branch becomes a pull request and its CI goes green on nothing.
  const world = developmentWorld(t);
  const id = ownerTask(world);
  world.changed = [];
  await settle(world.worker());
  assert.equal(world.created, 0);
  assert.equal(statusOf(world, id), 'failed');
  assert.match(world.show(id).task.close_reason ?? '', /no-change/);
});

test('the pull request opens against the named repository, pushed to its github.com URL, and is persisted', async (t) => {
  // Catches: a push to the checkout's origin, or a restart that cannot find its pull request.
  const world = developmentWorld(t);
  world.head = 'b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2b2';
  const id = ownerTask(world);
  await settle(world.worker());
  assert.equal(world.created, 1);
  assert.equal(world.pr?.repository, 'example/engine');
  assert.equal(world.pr?.base, 'main');
  assert.equal(world.gitCalls('push')[0]?.includes('https://github.com/example/engine.git'), true);
  const saved = persisted(world, id);
  assert.equal(saved.pr, 12);
  assert.equal(saved.head, world.head);
  assert.equal(statusOf(world, id), 'needs_validation');
});

test('approve mode: green at the head makes the pull request ready once and never merges', async (t) => {
  // Catches: `approve` merges on green, or asks the owner again on every look.
  const world = developmentWorld(t);
  const id = await withPullRequest(world, ['SUCCESS']);
  world.mode = 'approve';
  const worker = world.worker();
  await settle(worker);
  await settle(worker);
  assert.equal(world.ghPr('ready').length, 1);
  assert.equal(world.pr?.isDraft, false);
  assert.equal(world.ghPr('merge').length, 0);
  assert.equal(statusOf(world, id), 'needs_validation');
});

test('approve mode: a pending head stays a draft', async (t) => {
  // Catches: the owner is asked to merge before CI answered.
  const world = developmentWorld(t);
  await withPullRequest(world, ['PENDING']);
  await settle(world.worker());
  assert.equal(world.ghPr('ready').length, 0);
  assert.equal(world.pr?.isDraft, true);
});

test('approve mode: the thinker asking for a merge merges nothing', async (t) => {
  // Catches: a path around the mode for an agent that wants its work in.
  const world = developmentWorld(t);
  const id = await withPullRequest(world, ['SUCCESS']);
  const { task } = world.show(id);
  world.board.call('boss', 'task.update', { id, revision: task.revision, metadata: { mergeRequested: true } });
  await settle(world.worker());
  assert.equal(world.ghPr('merge').length, 0);
});

test('auto mode: green at the exact head merges once, naming that head, and closes the task', async (t) => {
  // Catches: a merge of a draft, which GitHub refuses; a merge that would take a commit CI never saw; a second merge.
  const world = developmentWorld(t);
  const id = await withPullRequest(world, ['SUCCESS']);
  world.mode = 'auto';
  const worker = world.worker();
  await settle(worker);
  await settle(worker);
  assert.equal(world.pr?.state, 'MERGED');
  const merges = world.ghPr('merge');
  assert.equal(merges.filter((args) => args.includes('--match-head-commit')).length, 1);
  const named = merges.find((args) => args.includes('--match-head-commit'));
  assert.equal(named?.[named.indexOf('--match-head-commit') + 1], HEAD);
  assert.equal(statusOf(world, id), 'done');
  assert.equal((world.show(id).task.metadata?.landed as { decidedBy: string }).decidedBy, 'auto');
});

test('her fix merged in auto mode reaches her next wake as landed, once', async (t) => {
  // Catches: the merge closes the task and she never hears that her change is in.
  const world = developmentWorld(t);
  const id = await herProposal(world, 'fix');
  // Changed: a fix of hers merges in `auto` only with a thinker's assessment on the board, so its thinker records one.
  world.scripts.thinker = (_run, turn) => {
    if (turn === 1) world.board.call(WORKER, 'task.risk', { id, risk: 'low', reason: 'One constant in one reader.' });
  };
  await settle(world.worker());
  prOf(world).checks = ['SUCCESS'];
  world.mode = 'auto';
  await settle(world.worker());
  assert.equal(statusOf(world, id), 'done');
  const { landed } = await landedFor(world.caller);
  assert.deepEqual(
    landed.map((one) => one.decidedBy),
    ['auto']
  );
});

const NEVER_MERGED: ReadonlyArray<[string, Array<CheckState>, string | null]> = [
  ['a red check', ['SUCCESS', 'FAILURE'], null],
  ['a pending check', ['SUCCESS', 'PENDING'], null],
  ['no checks at all', [], null],
  ['green checks on another head than the persisted one', ['SUCCESS'], 'c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3c3'],
];
for (const [label, checks, otherHead] of NEVER_MERGED) {
  test(`auto mode never merges on ${label}, even when the thinker asks`, async (t) => {
    // Catches: a merge the code's CI read did not clear; a head pushed after the tests counts as tested.
    const world = developmentWorld(t);
    const id = await withPullRequest(world, checks);
    if (otherHead !== null) prOf(world).head = otherHead;
    world.mode = 'auto';
    const { task } = world.show(id);
    world.board.call('boss', 'task.update', { id, revision: task.revision, metadata: { mergeRequested: true } });
    await settle(world.worker());
    assert.equal(world.ghPr('merge').length, 0);
    assert.equal(world.pr?.state, 'OPEN');
    assert.equal(statusOf(world, id), 'needs_validation');
  });
}

test('a merge GitHub refuses leaves the task waiting, with nothing recorded as merged', async (t) => {
  // Catches: the task closes and tells her it landed when the code never reached the base.
  const world = developmentWorld(t);
  const id = await withPullRequest(world, ['SUCCESS']);
  world.mode = 'auto';
  world.mergeCode = 1;
  await settle(world.worker());
  assert.equal(statusOf(world, id), 'needs_validation');
  assert.equal(world.show(id).task.metadata?.merged ?? null, null);
});

test('an owner merge in approve mode closes the task, attributed to the owner, without a merge of ours', async (t) => {
  // Catches: the task waits for ever after the owner merged on GitHub.
  const world = developmentWorld(t);
  const id = await withPullRequest(world, ['SUCCESS']);
  prOf(world).state = 'MERGED';
  await settle(world.worker());
  assert.equal(world.ghPr('merge').length, 0);
  assert.equal(statusOf(world, id), 'done');
  assert.equal((world.show(id).task.metadata?.landed as { decidedBy: string }).decidedBy, 'owner');
});

test('a pull request closed unmerged cancels the task', async (t) => {
  // Catches: the task waits for ever, or tells her it landed.
  const world = developmentWorld(t);
  const id = await withPullRequest(world, ['FAILURE']);
  prOf(world).state = 'CLOSED';
  await settle(world.worker());
  assert.equal(statusOf(world, id), 'cancelled');
  assert.equal(world.show(id).task.metadata?.landed ?? null, null);
});

test('the mode is read at each look, so the owner can take the merge back', async (t) => {
  // Catches: a mode cached at the start of the long-lived worker.
  const world = developmentWorld(t);
  await withPullRequest(world, ['PENDING']);
  world.mode = 'auto';
  const worker = world.worker();
  await settle(worker);
  world.mode = 'approve';
  prOf(world).checks = ['SUCCESS'];
  await settle(worker);
  assert.equal(world.ghPr('merge').length, 0);
});

// ---------- 5. Access ----------

const ACCESS: ReadonlyArray<[DevelopmentWorld['access'], RegExp]> = [
  ['gh-missing', /no gh on her PATH/],
  ['gh-logged-out', /not logged in/],
  ['no-push', /cannot push to example\/engine\. Fork it/],
];
for (const [access, reason] of ACCESS) {
  test(`${access} blocks the task with its reason before any work`, async (t) => {
    // Catches: a run spent on work that can never reach GitHub, or a silent wait with no reason to act on.
    const world = developmentWorld(t);
    world.access = access;
    const id = ownerTask(world);
    await settle(world.worker());
    assert.equal(statusOf(world, id), 'blocked');
    assert.match(world.show(id).task.blocked_reason ?? '', reason);
    assert.ok(!(world.show(id).task.blocked_reason ?? '').includes('SECRET-FROM-GH'));
    assert.equal(world.runs.length, 0);
    assert.equal(world.git.length, 0);
    assert.equal(world.gh.length, 0);
  });
}

test('a repository outside github.com blocks the task as unset, with nothing asked of gh or git', async (t) => {
  // Catches: `gitlab.example/team/engine` read as a repository and a push aimed at it.
  const world = developmentWorld(t);
  world.repository = 'gitlab.example/team/engine';
  const id = ownerTask(world);
  await settle(world.worker());
  assert.equal(statusOf(world, id), 'blocked');
  assert.match(world.show(id).task.blocked_reason ?? '', /names no repository/);
  assert.equal(world.git.length, 0);
});

test('access is checked before any work, and once access returns the task runs', async (t) => {
  // Catches: the check after the worktree, or a task blocked for ever once the owner fixed the login.
  const world = developmentWorld(t);
  world.access = 'no-push';
  const id = ownerTask(world);
  const worker = world.worker();
  await settle(worker);
  assert.deepEqual(world.order, ['check']);
  world.access = 'ok';
  world.board.call('boss', 'task.unblock', { id, note: 'Named the fork.' });
  await settle(worker);
  assert.deepEqual(world.order.slice(1, 4), ['check', 'git worktree add', 'run thinker']);
});

test('her filed fix starts development at the next board event, and a proposal with no kind waits', async (t) => {
  // Catches: filed work waits for her wake or a timer; a loose idea of hers runs as development.
  const world = developmentWorld(t);
  const fix = await herProposal(world, 'fix');
  const answer = await herCalls(world.caller)('task.propose', { title: 'An idea', evidence: 'Something I noticed.' });
  const idea = String((answer.data as { task: { id: string } }).task.id);
  await settle(world.worker());
  assert.equal(world.runsOf('thinker').length, 1);
  assert.equal(world.runs[0]?.brief.includes(fix), true);
  assert.equal(world.show(fix).task.requester, 'persona:self');
  assert.equal(statusOf(world, idea), 'proposed');
});

test('a skill task ends at the package seam and is submitted, with no pull request', async (t) => {
  // Catches: a skill task opens a pull request, or the worker binds itself to the activation code.
  const world = developmentWorld(t);
  const id = await herProposal(world, 'skill');
  await settle(world.worker());
  assert.equal(world.runsOf('thinker').length, 1);
  assert.deepEqual(
    world.skillPackages.map((one) => [one.task.id, one.tree]),
    [[id, persisted(world, id).worktree]]
  );
  assert.equal(world.created, 0);
  assert.equal(world.gitCalls('push').length, 0);
  assert.equal(statusOf(world, id), 'needs_validation');
});

test('a skill package the seam refuses fails the task with the reason', async (t) => {
  // Catches: an incomplete package reported as waiting for the owner.
  const world = developmentWorld(t);
  world.skillAnswer = { code: 'refused', reason: 'SKILL.md has no description' };
  const id = await herProposal(world, 'skill');
  await settle(world.worker());
  assert.equal(statusOf(world, id), 'failed');
  assert.match(world.show(id).task.close_reason ?? '', /SKILL\.md has no description/);
});

// ---------- 7. Crash recovery ----------

/** A task whose worker died mid-run: claimed, its development record persisted, its lease lapsed and reaped. */
function crashed(world: DevelopmentWorld, over: Partial<Persisted> = {}): { id: string; saved: Persisted } {
  const id = ownerTask(world);
  const branch = `self/${id}`;
  const worktree = `${world.worktreeRoot}/${id}`;
  world.branches.add(branch);
  world.trees.set(worktree, branch);
  const saved: Persisted = { branch, worktree, pr: null, head: null, ...over };
  world.board.call(WORKER, 'task.claim', { id });
  const { task } = world.show(id);
  world.board.call(WORKER, 'task.update', { id, revision: task.revision, metadata: { development: saved } });
  world.advance(31 * MINUTE);
  assert.deepEqual(world.board.reap(), [id]);
  return { id, saved };
}

test('a crash with a persisted branch and no pull request resumes one thinker on that branch', async (t) => {
  // Catches: a second branch for the same task, or `worktree add -b` on the existing branch failing the task.
  const world = developmentWorld(t);
  const { id, saved } = crashed(world);
  await settle(world.worker());
  assert.equal(world.runsOf('thinker').length, 1);
  assert.equal(world.runs[0]?.cwd, saved.worktree);
  assert.equal(persisted(world, id).branch, saved.branch);
  assert.equal(world.created, 1);
  assert.equal(statusOf(world, id), 'needs_validation');
});

test('a crash after the pull request opened, before it was recorded, finds it by branch and opens none', async (t) => {
  // Catches: the duplicate pull request of a worker that died between `gh pr create` and the board write.
  const world = developmentWorld(t);
  const { id, saved } = crashed(world);
  fakePr(world, saved.branch);
  await settle(world.worker());
  assert.equal(world.created, 0);
  assert.equal(world.runs.length, 0);
  assert.equal(persisted(world, id).pr, 12);
  assert.equal(statusOf(world, id), 'needs_validation');
});

test('a crash with a persisted pull request number opens none and runs no agent', async (t) => {
  // Catches: a resumed thinker redoing finished work on top of an open pull request.
  const world = developmentWorld(t);
  const { id, saved } = crashed(world, { pr: 12, head: HEAD });
  fakePr(world, saved.branch);
  await settle(world.worker());
  assert.equal(world.created, 0);
  assert.equal(world.runs.length, 0);
  assert.equal(statusOf(world, id), 'needs_validation');
});

test('a crash whose branch is gone fails the task and says so', async (t) => {
  // Catches: a silent restart from the base that drops the work, or an endless loop of failed worktree adds.
  const world = developmentWorld(t);
  const { id, saved } = crashed(world);
  world.branches.delete(saved.branch);
  world.trees.clear();
  await settle(world.worker());
  assert.equal(world.runs.length, 0);
  assert.equal(statusOf(world, id), 'failed');
  assert.ok((world.show(id).task.close_reason ?? '').includes(saved.branch));
});

test('a restarted worker goes on watching a pull request and merges it once in auto mode', async (t) => {
  // Catches: the wait for CI lives only in the memory of the process that opened the pull request.
  const world = developmentWorld(t);
  const id = await withPullRequest(world, ['SUCCESS']);
  world.mode = 'auto';
  await settle(world.worker());
  await settle(world.worker());
  assert.equal(world.pr?.state, 'MERGED');
  assert.equal(world.ghPr('merge').filter((args) => args.includes('--match-head-commit')).length, 1);
  assert.equal(statusOf(world, id), 'done');
});

// ---------- The loop over the board's events ----------

/** A worker whose wakes answer in turn and record that they ran. */
function scriptedWorker(reports: ReadonlyArray<WakeReport>) {
  const seen = { wakes: 0, stops: 0 };
  const worker: DevelopmentWorker = {
    wake() {
      const report = reports[Math.min(seen.wakes, reports.length - 1)];
      seen.wakes += 1;
      return Promise.resolve(report ?? { started: [], watching: 0 });
    },
    idle: () => Promise.resolve(),
    stop() {
      seen.stops += 1;
      return Promise.resolve();
    },
  };
  return { worker, seen };
}

test('the loop wakes on each batch of board events, reads on from the last one, and sets no clock while idle', async () => {
  // Catches: a fixed polling interval back in the worker, or events replayed from the start at each wake.
  const { worker, seen } = scriptedWorker([{ started: [], watching: 0 }]);
  const controller = new AbortController();
  const asked: Array<{ from: number; waitMs: number | null }> = [];
  await serveDevelopment({
    worker,
    signal: controller.signal,
    lookEveryMs: () => 90_000,
    waitForBoard(from, waitMs) {
      asked.push({ from, waitMs });
      if (asked.length === 3) controller.abort();
      return Promise.resolve([{ seq: from + 5 }]);
    },
  });
  assert.deepEqual(
    asked.map((one) => one.from),
    [0, 5, 10]
  );
  assert.ok(asked.every((one) => one.waitMs === null));
  assert.equal(seen.wakes, 3);
  assert.equal(seen.stops, 1);
});

test('the loop looks at GitHub on its setting only while a pull request is being watched', async () => {
  // Catches: a merge on GitHub raises no board event, so a worker waiting for events alone never sees CI or the owner.
  const { worker, seen } = scriptedWorker([
    { started: [], watching: 1 },
    { started: [], watching: 0 },
  ]);
  const controller = new AbortController();
  const asked: Array<number | null> = [];
  await serveDevelopment({
    worker,
    signal: controller.signal,
    lookEveryMs: () => 90_000,
    waitForBoard(_from, waitMs) {
      asked.push(waitMs);
      if (asked.length === 2) controller.abort();
      return Promise.resolve([]);
    },
  });
  assert.deepEqual(asked, [90_000, null]);
  assert.equal(seen.wakes, 2);
});

test('a lost link to the core ends the loop with its error, so systemd restarts the worker', async () => {
  // Catches: a tight loop of failed waits, or a worker alive and deaf after the core restarted.
  const { worker } = scriptedWorker([{ started: [], watching: 0 }]);
  await assert.rejects(
    serveDevelopment({
      worker,
      signal: new AbortController().signal,
      lookEveryMs: () => 90_000,
      waitForBoard: () => Promise.reject(new Error('the link to the core closed')),
    }),
    /the link to the core closed/
  );
});

// What the worker does when a thinker ends its turn on a review's requested changes without changing anything, over the
// world of tests/fixtures/development-rig.ts.

test('a turn that leaves the refused head in place blocks the task and pushes nothing', async (t) => {
  // Catches: the old head goes back to needs_validation, CI is green on it, and auto mode merges what the owner refused.
  const world = developmentWorld(t);
  const id = ownerTask(world);
  const worker = world.worker();
  await settle(worker);
  const pushes = world.gitCalls('push').length;
  world.board.call('boss', 'task.review', { id, decision: 'changes', comment: 'The timeout belongs in the config.' });
  await settle(worker);
  const { task } = world.show(id);
  assert.equal(task.status, 'blocked');
  assert.match(task.blocked_reason ?? '', new RegExp(HEAD));
  assert.equal(world.gitCalls('push').length, pushes);
  if (world.pr !== null) world.pr.checks = ['SUCCESS'];
  world.mode = 'auto';
  await settle(worker);
  assert.equal(world.ghPr('merge').length, 0);
});

// The check before a top-level task claims work (src/development/edges.ts over src/selfimprovement/repository.ts): a dev
// checkout with no `node_modules` blocks the task with a reason that names `npm install`, because a worktree under it
// resolves its packages there. The worker and the board are the rig's, the check is the real one over temp folders, and a
// disposable fake `gh` on PATH answers it. No network.

const ROOT = path.join(import.meta.dirname, '..');
const LABELS = labelsFileOf(JSON.parse(fs.readFileSync(path.join(ROOT, 'config', 'labels.json'), 'utf8'))).owner;

/** The rig's world with the real check over a temp checkout; `gh` records each call and grants the push. */
function worldOver(t: Parameters<typeof developmentWorld>[0]) {
  const checkout = tempDir('nep-modules-checkout-');
  const bin = tempDir('nep-modules-bin-');
  const record = path.join(bin, 'record');
  fs.writeFileSync(
    path.join(bin, 'gh'),
    `#!/bin/sh\necho "$1" >> "${record}"\n[ "$1" = api ] && echo '{"permissions":{"push":true}}'\nexit 0\n`,
    { mode: 0o755 }
  );
  const edges = developmentEdges({
    checkout,
    privateDir: tempDir('nep-modules-data-'),
    dataDir: tempDir('nep-modules-data-'),
    env: { PATH: `${bin}:/usr/bin:/bin` },
    denyDir: path.join(tempDir('nep-modules-deny-'), 'nosudo'),
    tmpDir: os.tmpdir(),
  });
  const world = developmentWorld(t);
  world.deps.check = () => edges.check('example/engine', LABELS);
  return { world, checkout, askedGh: () => fs.existsSync(record) };
}

test('a checkout with no node_modules blocks the task, naming npm install, before any worktree or run', async (t) => {
  // Catches: the thinker works for a whole turn and the task then fails on tests that could never start.
  const { world, askedGh } = worldOver(t);
  const id = ownerTask(world);
  await settle(world.worker());
  const { task } = world.show(id);
  assert.equal(task.status, 'blocked');
  assert.match(task.blocked_reason ?? '', /npm install/);
  assert.deepEqual(world.runsOf('thinker'), []);
  assert.equal(world.order.includes('git worktree add'), false);
  assert.equal(askedGh(), false);
});

test('a checkout with node_modules goes on to the push-right check and the thinker', async (t) => {
  // Catches: the check blocks every task, or stops before the push right is asked.
  const { world, checkout, askedGh } = worldOver(t);
  fs.mkdirSync(path.join(checkout, 'node_modules'));
  const id = ownerTask(world);
  await settle(world.worker());
  assert.equal(askedGh(), true);
  assert.equal(world.runsOf('thinker').length > 0, true);
  assert.notEqual(world.show(id).task.status, 'blocked');
});
