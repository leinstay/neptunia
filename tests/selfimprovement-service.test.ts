// She codes herself, end to end (item E of the final plan), over a real task board and fakes for the subharness
// runner, git, gh and the test runner: her `board.propose` of kind `fix` becomes a dev task, a dev attempt works in a
// worktree the engine makes from the base branch, the engine runs the tests of the touched modules and opens the pull
// request, a merge is observed through `gh pr view` and reaches her wake once, the engine merges in auto mode when CI is
// green and the journal says who decided, and a refusal is a board event with its reason. Each test names the bug it
// catches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { buildSelfimprovementFacts, proposalsOf } from '../src/behavior/selfimprovement-view.ts';
import { ackLanded, landedFor } from '../src/selfimprovement/landed.ts';
import { briefFrom, createSelfimprovement } from '../src/selfimprovement/service.ts';
import {
  FAILING_TAP,
  FIX_REQUEST,
  PR_URL,
  SELFIMPROVEMENT_T0,
  proposeFix,
  selfimprovementWorld,
} from './fixtures/selfimprovement-rig.ts';
import type { SelfimprovementWorld } from './fixtures/selfimprovement-rig.ts';

/** Her proposal, the intake and one attempt; returns the task id and the attempt's report. */
async function submitted(world: SelfimprovementWorld) {
  const id = await proposeFix(world);
  const service = createSelfimprovement(world.deps);
  await service.intake();
  const [report] = await service.work();
  assert.equal(report?.outcome, 'submitted', report?.reason ?? '');
  return { id, service, report };
}

const show = (world: SelfimprovementWorld, id: string) => world.board.call('boss', 'task.show', { id });

test('she files a fix about herself, dev patches it, the owner merges it and she sees it land once', async (t) => {
  const world = selfimprovementWorld(t);
  // Her wake shows three failed web.read chains; her scripted answer is the proposal built from them.
  const records = ['t1', 't2', 't3'].flatMap((turnId, n) =>
    ['started', 'failed'].map((phase) => ({
      kind: 'action',
      name: 'skill',
      turnId,
      opId: `${turnId}-0`,
      scope: { channel: 'c1' },
      phase,
      occurredAt: new Date(SELFIMPROVEMENT_T0 - (3 - n) * 3_600_000 + (phase === 'failed' ? 1000 : 0)).toISOString(),
      input: { skill: 'web.read', args: ['url'] },
      result: { code: 'timeout' },
    }))
  );
  const facts = await buildSelfimprovementFacts({
    guildId: 'g1',
    now: SELFIMPROVEMENT_T0,
    since: null,
    journal: { read: (_guild: string, query: { kind: string }) => (query.kind === 'action' ? records : []) },
    granted: ['web.read'],
    skills: [],
    proposals: [],
    outbox: [],
    landed: [],
  });
  assert.equal(facts.shapes[0]?.failures, 3);
  const id = await proposeFix(world, { examples: facts.shapes[0]?.turnIds ?? [] });

  const service = createSelfimprovement(world.deps);
  assert.deepEqual(await service.intake(), [id]);
  const [report] = await service.work();
  assert.equal(report?.outcome, 'submitted');
  assert.equal(show(world, id).task.status, 'needs_validation');

  // Nothing lands while the owner has not merged.
  world.mode = 'approve';
  assert.deepEqual(
    (await service.observe()).map((one) => one.action),
    ['waiting-owner']
  );
  assert.equal((await landedFor(world.caller)).landed.length, 0);

  // The owner merges on the host; the next look closes the task, and her next wake carries the change.
  world.pr.state = 'MERGED';
  world.pr.title = 'Lift the web.read timeout to 15 seconds';
  assert.deepEqual(
    (await service.observe()).map((one) => one.action),
    ['merged-by-owner']
  );
  assert.equal(show(world, id).task.status, 'done');
  const view = await proposalsOf(world.caller);
  const { landed, seqs } = await landedFor(world.caller);
  const after = await buildSelfimprovementFacts({
    guildId: 'g1',
    now: SELFIMPROVEMENT_T0,
    since: null,
    journal: null,
    granted: [],
    skills: [],
    proposals: view.entries,
    outbox: view.outbox,
    landed,
  });
  assert.equal(after.news.landed[0]?.title, 'Lift the web.read timeout to 15 seconds');
  assert.deepEqual(after.news.landed[0]?.files, ['src/web/read.ts', 'tests/web-read.test.ts']);
  await ackLanded(world.caller, seqs);
  assert.deepEqual((await landedFor(world.caller)).landed, []);
});

test('intake takes her fix proposals and leaves her skill proposals and other tasks alone', async (t) => {
  const world = selfimprovementWorld(t);
  const fix = await proposeFix(world);
  // Bug: the dev worker builds a pull request for a skill proposal, whose pull request is another agent's task.
  const skill = await proposeFix(world, { kind: 'skill', title: 'A skill for lookups' });
  const other = world.board.call('boss', 'task.add', { lane: 'dev', title: 'Not hers', requester: 'boss' });
  const taken = await createSelfimprovement(world.deps).intake();
  assert.deepEqual(taken, [fix]);
  assert.equal(show(world, fix).task.status, 'approved');
  assert.equal(show(world, fix).task.role, 'dev');
  assert.equal(show(world, skill).task.status, 'proposed');
  assert.equal(show(world, other.id).task.status, 'proposed');
});

test('the task keeps her evidence and her cases, and the brief the agent gets carries the evidence', async (t) => {
  const world = selfimprovementWorld(t);
  const id = await proposeFix(world);
  const service = createSelfimprovement(world.deps);
  await service.intake();
  const task = show(world, id).task;
  assert.equal(task.description, FIX_REQUEST.evidence);
  assert.deepEqual(task.metadata?.examples, ['t3', 't2', 't1']);
  await service.work();
  // Bug: the agent is briefed on the title alone and patches what it guesses.
  assert.ok(world.runs[0]?.brief.includes(FIX_REQUEST.evidence), world.runs[0]?.brief);
});

test('the attempt works in a worktree made from the base branch and never in the checkout', async (t) => {
  const world = selfimprovementWorld(t);
  const { id } = await submitted(world);
  const tree = path.join(world.worktreeRoot, id);
  const add = world.git.find((call) => call.args[0] === 'worktree' && call.args[1] === 'add');
  // Bug: the agent edits the live checkout, or branches from whatever HEAD the checkout is on.
  assert.deepEqual(add?.args, ['worktree', 'add', '-b', `self/${id}`, tree, 'main']);
  assert.equal(add?.cwd, world.repoDir);
  assert.equal(world.runs.length, 1);
  assert.equal(world.runs[0]?.cwd, tree);
  assert.notEqual(world.runs[0]?.cwd, world.repoDir);
  assert.equal(world.tests[0]?.cwd, tree);
});

test('the base branch comes from the setting at the time of the attempt', async (t) => {
  const world = selfimprovementWorld(t);
  world.base = 'trunk';
  await submitted(world);
  const add = world.git.find((call) => call.args[0] === 'worktree');
  assert.equal(add?.args.at(-1), 'trunk');
  assert.equal(world.create.base, 'trunk');
});

test('the tests of the touched modules run before anything is pushed or submitted, and only those', async (t) => {
  const world = selfimprovementWorld(t);
  await submitted(world);
  const at = (name: string) => world.order.indexOf(name);
  // Bug: the pull request is opened first and the tests run after, or never.
  assert.ok(at('git worktree add') < at('run'), world.order.join(' > '));
  assert.ok(at('run') < at('tests'), world.order.join(' > '));
  assert.ok(at('tests') < at('git push'), world.order.join(' > '));
  assert.ok(at('git push') < at('gh pr create'), world.order.join(' > '));
  assert.ok(at('gh pr create') < at('board task.submit'), world.order.join(' > '));
  assert.equal(world.tests.length, 1);
  assert.equal(world.tests[0]?.file, 'node');
  assert.ok(world.tests[0]?.args.includes('--test'));
  // Bug: the whole suite runs, or a test of another module.
  assert.ok(world.tests[0]?.args.includes('tests/web-read.test.ts'));
  assert.ok(!world.tests[0]?.args.includes('tests/unrelated.test.ts'));
  assert.ok(!world.tests[0]?.args.some((arg) => arg === 'tests' || arg === 'tests/'));
});

test("the handoff holds the engine's own test counts, not what the agent says", async (t) => {
  const world = selfimprovementWorld(t);
  const { id } = await submitted(world);
  const handoff = show(world, id).handoff;
  // The agent wrote "All 99 tests pass"; the runner counted 3.
  assert.equal(handoff?.tests.length, 1);
  assert.equal(handoff?.tests[0]?.passed, 3);
  assert.equal(handoff?.tests[0]?.failed, 0);
  assert.ok(handoff?.tests[0]?.command.includes('tests/web-read.test.ts'));
});

test('failing tests stop the attempt: nothing is pushed, no pull request, the task fails with the command', async (t) => {
  const world = selfimprovementWorld(t);
  world.testRun = { code: 1, stdout: FAILING_TAP };
  const id = await proposeFix(world);
  const service = createSelfimprovement(world.deps);
  await service.intake();
  const [report] = await service.work();
  assert.equal(report?.outcome, 'failed');
  // Bug: a red patch is submitted because the agent said it was fine.
  assert.equal(world.order.includes('git push'), false);
  assert.equal(world.gh.length, 0);
  const task = show(world, id).task;
  assert.equal(task.status, 'failed');
  assert.ok(task.close_reason?.startsWith('tests-failed'), String(task.close_reason));
  assert.ok(task.close_reason?.includes('tests/web-read.test.ts'));
});

test('a change with no test file runs no tests and says which paths no test covers', async (t) => {
  const world = selfimprovementWorld(t);
  world.changed = ['prompts/format.md'];
  const { id } = await submitted(world);
  assert.equal(world.tests.length, 0);
  const handoff = show(world, id).handoff;
  assert.deepEqual(handoff?.tests, []);
  // Bug: the owner reads an empty test list as "tested".
  assert.ok(handoff?.open_issues.some((line) => line.includes('prompts/format.md')));
});

test('an agent that changed nothing opens no pull request', async (t) => {
  const world = selfimprovementWorld(t);
  world.changed = [];
  const id = await proposeFix(world);
  const service = createSelfimprovement(world.deps);
  await service.intake();
  const [report] = await service.work();
  assert.equal(report?.outcome, 'failed');
  assert.equal(show(world, id).task.close_reason, 'no-change');
  assert.equal(world.gh.length, 0);
});

test('the handoff is a pull request: the branch, the URL, the body with the evidence, the files and the tests', async (t) => {
  const world = selfimprovementWorld(t);
  const { id, report } = await submitted(world);
  assert.equal(report.branch, `self/${id}`);
  assert.equal(report.pr, 12);
  assert.equal(world.create.base, 'main');
  assert.equal(world.create.head, `self/${id}`);
  assert.equal(world.create.title, FIX_REQUEST.title);
  const view = show(world, id);
  assert.equal(view.task.status, 'needs_validation');
  // Bug: the owner gets a review request with no branch, no way to read why, or a body without the proof.
  assert.deepEqual(view.handoff?.artifacts, [`self/${id}`, PR_URL]);
  assert.deepEqual(view.handoff?.evidence, ['src/web/read.ts', 'tests/web-read.test.ts']);
  const result = view.results.find((row) => row.kind === 'pr');
  assert.equal(result?.uri, PR_URL);
  assert.equal(result?.body, world.create.body);
  const body = String(world.create.body);
  assert.ok(body.includes(FIX_REQUEST.evidence));
  assert.ok(body.includes('src/web/read.ts'));
  assert.ok(body.includes('tests/web-read.test.ts'));
  assert.ok(body.includes(id));
  assert.equal(view.task.metadata?.pr && (view.task.metadata.pr as { number: number }).number, 12);
});

test('a refusal of the agent is a board event with its reason, and nothing else is tried', async (t) => {
  const world = selfimprovementWorld(t);
  world.agent = { ok: true, text: 'REFUSED: the change would touch the key store, which I will not edit' };
  const id = await proposeFix(world);
  const service = createSelfimprovement(world.deps);
  await service.intake();
  const [report] = await service.work();
  assert.equal(report?.outcome, 'refused');
  assert.ok(report?.reason?.includes('key store'));
  const task = show(world, id).task;
  assert.equal(task.status, 'failed');
  assert.ok(task.close_reason?.startsWith('refused:') && task.close_reason.includes('key store'));
  // Bug: a refusal is retried on another backend, or ends in a pull request, or in silence.
  assert.equal(world.runs.length, 1);
  assert.equal(world.order.includes('tests'), false);
  assert.equal(world.gh.length, 0);
  // She hears of it: the row to her outbox carries the reason.
  const view = await proposalsOf(world.caller);
  const facts = await buildSelfimprovementFacts({
    guildId: 'g1',
    now: SELFIMPROVEMENT_T0,
    since: null,
    journal: null,
    granted: [],
    skills: [],
    proposals: view.entries,
    outbox: view.outbox,
    landed: [],
  });
  assert.ok(facts.news.outbox.some((row) => row.taskId === id && row.closeReason?.includes('key store')));
  // A refusal does not sit in the next intake or work either.
  assert.deepEqual(await service.work(), []);
});

test('a runner that fails is a board event too, with the error', async (t) => {
  const world = selfimprovementWorld(t);
  world.agent = { ok: false, text: '' };
  const id = await proposeFix(world);
  const service = createSelfimprovement(world.deps);
  await service.intake();
  const [report] = await service.work();
  assert.equal(report?.outcome, 'failed');
  assert.ok(show(world, id).task.close_reason?.startsWith('run-failed'));
});

test('a gh failure fails the task with the first line of its error and leaves nothing waiting for review', async (t) => {
  const world = selfimprovementWorld(t);
  world.create = { ...world.create, code: 1, stderr: 'GraphQL: could not create\nsecond line' };
  const id = await proposeFix(world);
  const service = createSelfimprovement(world.deps);
  await service.intake();
  const [report] = await service.work();
  assert.equal(report?.outcome, 'failed');
  const task = show(world, id).task;
  // Bug: the task sits in needs_validation with no pull request behind it.
  assert.equal(task.status, 'failed');
  assert.equal(task.close_reason, 'gh-failed: GraphQL: could not create');
});

test('a merge by the owner closes the task once: title and files from the pull request, the journal says owner', async (t) => {
  const world = selfimprovementWorld(t);
  const { id, service } = await submitted(world);
  world.pr.state = 'MERGED';
  world.pr.title = 'Lift the web.read timeout';
  world.pr.files = ['src/web/read.ts', 'tests/web-read.test.ts', 'docs/media.md'];
  assert.deepEqual(
    (await service.observe()).map((one) => one.action),
    ['merged-by-owner']
  );
  assert.deepEqual(
    (await service.observe()).map((one) => one.action),
    []
  );
  // The engine did not merge it.
  assert.equal(
    world.gh.some((call) => call.args[1] === 'merge'),
    false
  );
  assert.equal(show(world, id).task.status, 'done');
  const merged = world.journal.filter((line) => line.event === 'merged');
  // Bug: two looks write two events, or the journal names nobody.
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.decidedBy, 'owner');
  assert.equal(merged[0]?.taskId, id);
  const { landed } = await landedFor(world.caller);
  assert.equal(landed.length, 1);
  assert.equal(landed[0]?.title, 'Lift the web.read timeout');
  assert.deepEqual(landed[0]?.files, ['src/web/read.ts', 'tests/web-read.test.ts', 'docs/media.md']);
});

test('a pull request closed without a merge cancels the task and does not tell her it landed', async (t) => {
  const world = selfimprovementWorld(t);
  const { id, service } = await submitted(world);
  world.pr.state = 'CLOSED';
  assert.deepEqual(
    (await service.observe()).map((one) => one.action),
    ['closed']
  );
  assert.equal(show(world, id).task.status, 'cancelled');
  assert.deepEqual((await landedFor(world.caller)).landed, []);
});

test('in auto mode the engine merges when every check is green, deletes the branch and the journal says auto decided', async (t) => {
  const world = selfimprovementWorld(t);
  world.mode = 'auto';
  const { id, service } = await submitted(world);
  assert.deepEqual(
    (await service.observe()).map((one) => one.action),
    ['merged-auto']
  );
  const merges = world.gh.filter((call) => call.args[1] === 'merge');
  assert.equal(merges.length, 1);
  assert.ok(merges[0]?.args.includes('12'));
  // Bug: the branch of a merged request stays on the remote.
  assert.ok(merges[0]?.args.includes('--delete-branch'));
  assert.equal(show(world, id).task.status, 'done');
  const merged = world.journal.filter((line) => line.event === 'merged');
  // Bug: the log says "owner" for a merge nobody approved, so the owner cannot tell who decided.
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.decidedBy, 'auto');
  // The look after the merge does not merge again nor write a second event.
  assert.deepEqual(
    (await service.observe()).map((one) => one.action),
    []
  );
  assert.equal(world.gh.filter((call) => call.args[1] === 'merge').length, 1);
  const { landed } = await landedFor(world.caller);
  assert.equal(landed.length, 1);
  assert.equal(landed[0]?.decidedBy, 'auto');
});

for (const [label, checks] of [
  ['one check failed', ['SUCCESS', 'FAILURE']],
  ['a check is still running', ['SUCCESS', 'PENDING']],
  ['there is no check at all', []],
] as const) {
  test(`in auto mode the engine does not merge when ${label}`, async (t) => {
    const world = selfimprovementWorld(t);
    world.mode = 'auto';
    const { id, service } = await submitted(world);
    world.pr.checks = [...checks];
    // Bug: the rule merges on "no red seen" and lands a change CI has not passed.
    assert.deepEqual(
      (await service.observe()).map((one) => one.action),
      ['waiting-ci']
    );
    assert.equal(
      world.gh.some((call) => call.args[1] === 'merge'),
      false
    );
    assert.equal(show(world, id).task.status, 'needs_validation');
    world.pr.checks = ['SUCCESS'];
    assert.deepEqual(
      (await service.observe()).map((one) => one.action),
      ['merged-auto']
    );
  });
}

test('in approve mode the draft becomes a request to the owner only once CI is green, and the engine never merges', async (t) => {
  const world = selfimprovementWorld(t);
  const { id, service } = await submitted(world);
  // The request is opened as a draft.
  assert.ok(world.gh.find((call) => call.args[1] === 'create')?.args.includes('--draft'));
  world.pr.checks = ['SUCCESS', 'PENDING'];
  assert.deepEqual(
    (await service.observe()).map((one) => one.action),
    ['waiting-ci']
  );
  // Bug: the owner is asked to look at a request CI has not passed.
  assert.equal(world.pr.ready, false);
  world.pr.checks = ['SUCCESS'];
  assert.deepEqual(
    (await service.observe()).map((one) => one.action),
    ['waiting-owner']
  );
  assert.equal(world.pr.ready, true);
  await service.observe();
  assert.equal(world.gh.filter((call) => call.args[1] === 'ready').length, 1);
  assert.equal(
    world.gh.some((call) => call.args[1] === 'merge'),
    false
  );
  assert.equal(show(world, id).task.status, 'needs_validation');
});

test('the mode is read at each look, so the owner can take the merge back', async (t) => {
  const world = selfimprovementWorld(t);
  world.mode = 'auto';
  const { service } = await submitted(world);
  // Bug: the mode is cached when the service is made, and a revoked auto still merges.
  world.mode = 'approve';
  assert.deepEqual(
    (await service.observe()).map((one) => one.action),
    ['waiting-owner']
  );
  assert.equal(
    world.gh.some((call) => call.args[1] === 'merge'),
    false
  );
});

test('a failed merge command leaves the task waiting and records nothing as merged', async (t) => {
  const world = selfimprovementWorld(t);
  world.mode = 'auto';
  const { id, service } = await submitted(world);
  world.pr.mergeCode = 1;
  await service.observe();
  // Bug: the task is closed and her wake says "landed" for a change that is still open.
  assert.equal(show(world, id).task.status, 'needs_validation');
  assert.equal(
    world.journal.some((line) => line.event === 'merged'),
    false
  );
  assert.deepEqual((await landedFor(world.caller)).landed, []);
  // The owner merges it by hand afterwards: that is the owner's decision, not the engine's.
  world.pr.state = 'MERGED';
  await service.observe();
  assert.equal(world.journal.find((line) => line.event === 'merged')?.decidedBy, 'owner');
});

test('a merge by the owner and a close both delete the branch', async (t) => {
  const world = selfimprovementWorld(t);
  const { id, service } = await submitted(world);
  world.pr.state = 'MERGED';
  await service.observe();
  // Bug: the branch of a merged request stays on the remote.
  const removal = world.git.find((call) => call.args[0] === 'push' && call.args.includes('--delete'));
  assert.ok(removal?.args.includes(`self/${id}`));
});

test('the shipped brief fills every placeholder from the fix and keeps the refusal tag', () => {
  const template = fs.readFileSync(path.join(import.meta.dirname, '..', 'prompts', 'selfdev.md'), 'utf8');
  const text = briefFrom(template, {
    id: 'T-abc',
    title: 'Raise the timeout',
    evidence: 'EVIDENCE-TEXT',
    acceptance: 'ACCEPT-TEXT',
    examples: ['t1', 't2'],
    counterexamples: ['c1'],
    benefit: 'BENEFIT-TEXT',
    evaluation: 'EVAL-TEXT',
  });
  // Bug: a placeholder the file names and the code does not fill goes to the dev agent as literal braces.
  assert.equal(text.includes('{{'), false, text);
  for (const part of ['T-abc', 'EVIDENCE-TEXT', 'ACCEPT-TEXT', '- t1\n- t2', '- c1', 'BENEFIT-TEXT', 'EVAL-TEXT']) {
    assert.ok(text.includes(part), part);
  }
  // The engine reads this tag in the agent's final message.
  assert.ok(text.includes('REFUSED: <reason>'));
});

// The fork check of the beat (spec 2026-11-02, PR 5 "Forks"): every beat checks first that her gh login can push to
// `selfimprovement.repository`, a failed check pauses the beat with its code, and every gh call names that repository.

const repoOf = (args: ReadonlyArray<string>): string | null => {
  const at = args.indexOf('--repo');
  return at < 0 ? null : (args[at + 1] ?? null);
};

test('a beat whose push check fails takes nothing, runs no git or gh, and journals the pause with its code', async (t) => {
  // Catches: a lost push right shows up as a failed push that closes her fix as failed, instead of pausing the beat.
  const world = selfimprovementWorld(t);
  const id = await proposeFix(world);
  world.check = { code: 'no-push', line: 'no push right on example/engine' };
  const beat = await createSelfimprovement(world.deps).beat();
  assert.equal(beat.check.code, 'no-push');
  assert.deepEqual([beat.taken, beat.reports, beat.seen], [[], [], []]);
  assert.equal(show(world, id).task.status, 'proposed');
  assert.deepEqual([world.git, world.gh, world.runs], [[], [], []]);
  assert.deepEqual(
    world.journal.filter((line) => line.event === 'paused'),
    [{ kind: 'selfimprovement', event: 'paused', code: 'no-push' }]
  );
});

test('a beat whose check throws pauses with code failed and touches nothing', async (t) => {
  // Catches: a crashing check escapes the beat, or lets intake and work run without knowing the push right.
  const world = selfimprovementWorld(t);
  const id = await proposeFix(world);
  world.deps = { ...world.deps, check: () => Promise.reject(new Error('spawn gh EACCES')) };
  const beat = await createSelfimprovement(world.deps).beat();
  assert.equal(beat.check.code, 'failed');
  assert.equal(show(world, id).task.status, 'proposed');
  assert.deepEqual(world.gh, []);
  assert.deepEqual(
    world.journal.filter((line) => line.event === 'paused').map((line) => line.code),
    ['failed']
  );
});

test('a beat whose check passes runs intake, work and observe once each, with the check run once first', async (t) => {
  // Catches: beat() checks but forgets a step, or checks again per task and doubles the gh calls.
  const world = selfimprovementWorld(t);
  const id = await proposeFix(world);
  const beat = await createSelfimprovement(world.deps).beat();
  assert.equal(beat.check.code, 'ok');
  assert.deepEqual(beat.taken, [id]);
  assert.deepEqual(
    beat.reports.map((one) => one.outcome),
    ['submitted']
  );
  assert.deepEqual(
    beat.seen.map((one) => one.action),
    ['waiting-owner']
  );
  assert.equal(world.checks, 1);
  assert.equal(
    world.journal.some((line) => line.event === 'paused'),
    false
  );
});

test('the pull request opens against selfimprovement.repository', async (t) => {
  // Catches: gh pr create picks the checkout's origin, so a deployment that named its fork still proposes upstream.
  const world = selfimprovementWorld(t);
  world.repository = 'fork-owner/engine';
  world.check = { code: 'ok', repository: 'fork-owner/engine' };
  await submitted(world);
  const create = world.gh.find((call) => call.args[0] === 'pr' && call.args[1] === 'create');
  assert.equal(repoOf(create?.args ?? []), 'fork-owner/engine');
});

test('every look, ready and merge names selfimprovement.repository too', async (t) => {
  // Catches: the pull request opens on the fork but gh pr view and merge ask the origin, so it is never seen merged.
  const world = selfimprovementWorld(t);
  world.repository = 'fork-owner/engine';
  world.check = { code: 'ok', repository: 'fork-owner/engine' };
  const { service } = await submitted(world);
  await service.observe();
  world.mode = 'auto';
  assert.deepEqual(
    (await service.observe()).map((one) => one.action),
    ['merged-auto']
  );
  const used = world.gh.filter((call) => call.args[0] === 'pr').map((call) => [call.args[1], repoOf(call.args)]);
  assert.deepEqual(used, [
    ['create', 'fork-owner/engine'],
    ['view', 'fork-owner/engine'],
    ['ready', 'fork-owner/engine'],
    ['view', 'fork-owner/engine'],
    ['merge', 'fork-owner/engine'],
  ]);
});

test('the branch is pushed to the selfimprovement.repository URL, never to origin', async (t) => {
  // Catches: the branch goes to origin (upstream) while the pull request opens on the fork, so gh finds no head branch.
  const world = selfimprovementWorld(t);
  world.repository = 'fork-owner/engine';
  world.check = { code: 'ok', repository: 'fork-owner/engine' };
  const { id } = await submitted(world);
  const pushes = world.git.filter((call) => call.args[0] === 'push');
  assert.deepEqual(
    pushes.map((call) => call.args),
    [['push', '-u', 'https://github.com/fork-owner/engine.git', `self/${id}`]]
  );
});
