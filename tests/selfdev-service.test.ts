// She codes herself, end to end (item E of the final plan), over a real task board and fakes for the subharness
// runner, git, gh and the test runner: her `board.propose` of kind `fix` becomes a dev task, a dev attempt works in a
// worktree the engine makes from the base branch, the engine runs the tests of the touched modules and opens the pull
// request, a merge is observed through `gh pr view` and reaches her wake once, a released class merges when CI is
// green and the journal says who decided, and a refusal is a board event with its reason. Each test names the bug it
// catches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { buildSelfimprovementFacts, proposalsOf } from '../src/behavior/selfimprovement-view.ts';
import { ackLanded, landedFor } from '../src/selfdev/landed.ts';
import { createSelfdev } from '../src/selfdev/service.ts';
import { FAILING_TAP, FIX_REQUEST, PR_URL, SELFDEV_T0, proposeFix, selfdevWorld } from './fixtures/selfdev-rig.ts';
import type { SelfdevWorld } from './fixtures/selfdev-rig.ts';

/** Her proposal, the intake and one attempt; returns the task id and the attempt's report. */
async function submitted(world: SelfdevWorld) {
  const id = await proposeFix(world);
  const service = createSelfdev(world.deps);
  await service.intake();
  const [report] = await service.work();
  assert.equal(report?.outcome, 'submitted', report?.reason ?? '');
  return { id, service, report };
}

const show = (world: SelfdevWorld, id: string) => world.board.call('boss', 'task.show', { id });

test('she files a fix about herself, dev patches it, the owner merges it and she sees it land once', async (t) => {
  const world = selfdevWorld(t);
  // Her wake shows three failed web.read chains; her scripted answer is the proposal built from them.
  const records = ['t1', 't2', 't3'].flatMap((turnId, n) =>
    ['started', 'failed'].map((phase) => ({
      kind: 'action',
      name: 'skill',
      turnId,
      opId: `${turnId}-0`,
      scope: { channel: 'c1' },
      phase,
      occurredAt: new Date(SELFDEV_T0 - (3 - n) * 3_600_000 + (phase === 'failed' ? 1000 : 0)).toISOString(),
      input: { skill: 'web.read', args: ['url'] },
      result: { code: 'timeout' },
    }))
  );
  const facts = await buildSelfimprovementFacts({
    guildId: 'g1',
    now: SELFDEV_T0,
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

  const service = createSelfdev(world.deps);
  assert.deepEqual(await service.intake(), [id]);
  const [report] = await service.work();
  assert.equal(report?.outcome, 'submitted');
  assert.equal(show(world, id).task.status, 'needs_validation');

  // Nothing lands while the owner has not merged.
  world.released = [];
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
    now: SELFDEV_T0,
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
  const world = selfdevWorld(t);
  const fix = await proposeFix(world);
  // Bug: the dev worker builds a pull request for a skill proposal, whose pull request is another agent's task.
  const skill = await proposeFix(world, { kind: 'skill', title: 'A skill for lookups' });
  const other = world.board.call('boss', 'task.add', { lane: 'dev', title: 'Not hers', requester: 'boss' });
  const taken = await createSelfdev(world.deps).intake();
  assert.deepEqual(taken, [fix]);
  assert.equal(show(world, fix).task.status, 'approved');
  assert.equal(show(world, fix).task.role, 'dev');
  assert.equal(show(world, skill).task.status, 'proposed');
  assert.equal(show(world, other.id).task.status, 'proposed');
});

test('the task keeps her evidence and her cases, and the brief the agent gets carries the evidence', async (t) => {
  const world = selfdevWorld(t);
  const id = await proposeFix(world);
  const service = createSelfdev(world.deps);
  await service.intake();
  const task = show(world, id).task;
  assert.equal(task.description, FIX_REQUEST.evidence);
  assert.deepEqual(task.metadata?.examples, ['t3', 't2', 't1']);
  await service.work();
  // Bug: the agent is briefed on the title alone and patches what it guesses.
  assert.ok(world.runs[0]?.brief.includes(FIX_REQUEST.evidence), world.runs[0]?.brief);
});

test('the attempt works in a worktree made from the base branch and never in the checkout', async (t) => {
  const world = selfdevWorld(t);
  const { id } = await submitted(world);
  const tree = path.join(world.worktreeRoot, id);
  const add = world.git.find((call) => call.args[0] === 'worktree' && call.args[1] === 'add');
  // Bug: the agent edits the live checkout, or branches from whatever HEAD the checkout is on.
  assert.deepEqual(add?.args, ['worktree', 'add', '-b', `selfdev/${id}`, tree, 'main']);
  assert.equal(add?.cwd, world.repoDir);
  assert.equal(world.runs.length, 1);
  assert.equal(world.runs[0]?.cwd, tree);
  assert.notEqual(world.runs[0]?.cwd, world.repoDir);
  assert.equal(world.tests[0]?.cwd, tree);
});

test('the base branch comes from the setting at the time of the attempt', async (t) => {
  const world = selfdevWorld(t);
  world.base = 'trunk';
  await submitted(world);
  const add = world.git.find((call) => call.args[0] === 'worktree');
  assert.equal(add?.args.at(-1), 'trunk');
  assert.equal(world.create.base, 'trunk');
});

test('the tests of the touched modules run before anything is pushed or submitted, and only those', async (t) => {
  const world = selfdevWorld(t);
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
  const world = selfdevWorld(t);
  const { id } = await submitted(world);
  const handoff = show(world, id).handoff;
  // The agent wrote "All 99 tests pass"; the runner counted 3.
  assert.equal(handoff?.tests.length, 1);
  assert.equal(handoff?.tests[0]?.passed, 3);
  assert.equal(handoff?.tests[0]?.failed, 0);
  assert.ok(handoff?.tests[0]?.command.includes('tests/web-read.test.ts'));
});

test('failing tests stop the attempt: nothing is pushed, no pull request, the task fails with the command', async (t) => {
  const world = selfdevWorld(t);
  world.testRun = { code: 1, stdout: FAILING_TAP };
  const id = await proposeFix(world);
  const service = createSelfdev(world.deps);
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
  const world = selfdevWorld(t);
  world.changed = ['prompts/format.md'];
  const { id } = await submitted(world);
  assert.equal(world.tests.length, 0);
  const handoff = show(world, id).handoff;
  assert.deepEqual(handoff?.tests, []);
  // Bug: the owner reads an empty test list as "tested".
  assert.ok(handoff?.open_issues.some((line) => line.includes('prompts/format.md')));
});

test('an agent that changed nothing opens no pull request', async (t) => {
  const world = selfdevWorld(t);
  world.changed = [];
  const id = await proposeFix(world);
  const service = createSelfdev(world.deps);
  await service.intake();
  const [report] = await service.work();
  assert.equal(report?.outcome, 'failed');
  assert.equal(show(world, id).task.close_reason, 'no-change');
  assert.equal(world.gh.length, 0);
});

test('the handoff is a pull request: the branch, the URL, the body with the evidence, the files and the tests', async (t) => {
  const world = selfdevWorld(t);
  const { id, report } = await submitted(world);
  assert.equal(report.branch, `selfdev/${id}`);
  assert.equal(report.pr, 12);
  assert.equal(world.create.base, 'main');
  assert.equal(world.create.head, `selfdev/${id}`);
  assert.equal(world.create.title, FIX_REQUEST.title);
  const view = show(world, id);
  assert.equal(view.task.status, 'needs_validation');
  // Bug: the owner gets a review request with no branch, no way to read why, or a body without the proof.
  assert.deepEqual(view.handoff?.artifacts, [`selfdev/${id}`, PR_URL]);
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
  const world = selfdevWorld(t);
  world.agent = { ok: true, text: 'REFUSED: the change would touch the key store, which I will not edit' };
  const id = await proposeFix(world);
  const service = createSelfdev(world.deps);
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
    now: SELFDEV_T0,
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
  const world = selfdevWorld(t);
  world.agent = { ok: false, text: '' };
  const id = await proposeFix(world);
  const service = createSelfdev(world.deps);
  await service.intake();
  const [report] = await service.work();
  assert.equal(report?.outcome, 'failed');
  assert.ok(show(world, id).task.close_reason?.startsWith('run-failed'));
});

test('a gh failure fails the task with the first line of its error and leaves nothing waiting for review', async (t) => {
  const world = selfdevWorld(t);
  world.create = { ...world.create, code: 1, stderr: 'GraphQL: could not create\nsecond line' };
  const id = await proposeFix(world);
  const service = createSelfdev(world.deps);
  await service.intake();
  const [report] = await service.work();
  assert.equal(report?.outcome, 'failed');
  const task = show(world, id).task;
  // Bug: the task sits in needs_validation with no pull request behind it.
  assert.equal(task.status, 'failed');
  assert.equal(task.close_reason, 'gh-failed: GraphQL: could not create');
});

test('a merge by the owner closes the task once: title and files from the pull request, the journal says owner', async (t) => {
  const world = selfdevWorld(t);
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
  const world = selfdevWorld(t);
  const { id, service } = await submitted(world);
  world.pr.state = 'CLOSED';
  assert.deepEqual(
    (await service.observe()).map((one) => one.action),
    ['closed']
  );
  assert.equal(show(world, id).task.status, 'cancelled');
  assert.deepEqual((await landedFor(world.caller)).landed, []);
});

test('a released class merges without the owner when every check is green, and the journal says the rule decided', async (t) => {
  const world = selfdevWorld(t);
  world.released = ['prompts/*.md', 'config/labels.json'];
  world.changed = ['prompts/format.md', 'config/labels.json'];
  const { id, service } = await submitted(world);
  assert.deepEqual(
    (await service.observe()).map((one) => one.action),
    ['merged-released']
  );
  const merges = world.gh.filter((call) => call.args[1] === 'merge');
  assert.equal(merges.length, 1);
  assert.ok(merges[0]?.args.includes('12'));
  assert.equal(show(world, id).task.status, 'done');
  const merged = world.journal.filter((line) => line.event === 'merged');
  // Bug: the log says "owner" for a merge nobody approved, so the owner cannot tell who decided.
  assert.equal(merged.length, 1);
  assert.equal(merged[0]?.decidedBy, 'released-class');
  assert.deepEqual(merged[0]?.globs, ['prompts/*.md', 'config/labels.json']);
  // The look after the merge does not merge again nor write a second event.
  assert.deepEqual(
    (await service.observe()).map((one) => one.action),
    []
  );
  assert.equal(world.gh.filter((call) => call.args[1] === 'merge').length, 1);
  const { landed } = await landedFor(world.caller);
  assert.equal(landed.length, 1);
  assert.equal(landed[0]?.decidedBy, 'released-class');
});

for (const [label, checks] of [
  ['one check failed', ['SUCCESS', 'FAILURE']],
  ['a check is still running', ['SUCCESS', 'PENDING']],
  ['there is no check at all', []],
] as const) {
  test(`a released class does not merge when ${label}`, async (t) => {
    const world = selfdevWorld(t);
    world.released = ['prompts/*.md'];
    world.changed = ['prompts/format.md'];
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
    assert.equal(
      world.journal.some((line) => line.event === 'merged'),
      false
    );
    // Green later: the same task merges on a later look.
    world.pr.checks = ['SUCCESS'];
    assert.deepEqual(
      (await service.observe()).map((one) => one.action),
      ['merged-released']
    );
  });
}

test('a path outside the released classes waits for the owner even with green checks, and says so once', async (t) => {
  const world = selfdevWorld(t);
  world.released = ['prompts/*.md'];
  world.changed = ['prompts/format.md', 'src/core.ts'];
  const { id, service } = await submitted(world);
  assert.deepEqual(
    (await service.observe()).map((one) => one.action),
    ['waiting-owner']
  );
  assert.deepEqual(
    (await service.observe()).map((one) => one.action),
    ['waiting-owner']
  );
  // Bug: the prompt edit carries a src/ change through the release.
  assert.equal(
    world.gh.some((call) => call.args[1] === 'merge'),
    false
  );
  assert.equal(show(world, id).task.status, 'needs_validation');
  const notes = show(world, id).comments;
  assert.equal(notes.length, 1);
  assert.ok(notes[0]?.text.includes('src/core.ts'));
  assert.ok(!notes[0]?.text.includes('prompts/format.md'));
});

test('with nothing released every pull request waits for the owner', async (t) => {
  const world = selfdevWorld(t);
  world.released = [];
  world.changed = ['prompts/format.md'];
  const { service } = await submitted(world);
  assert.deepEqual(
    (await service.observe()).map((one) => one.action),
    ['waiting-owner']
  );
  assert.equal(
    world.gh.some((call) => call.args[1] === 'merge'),
    false
  );
});

test('the released classes are read at each look, so the owner can take a class back', async (t) => {
  const world = selfdevWorld(t);
  world.released = ['prompts/*.md'];
  world.changed = ['prompts/format.md'];
  const { service } = await submitted(world);
  // Bug: the globs are cached when the service is made, and a revoked class still merges.
  world.released = [];
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
  const world = selfdevWorld(t);
  world.released = ['prompts/*.md'];
  world.changed = ['prompts/format.md'];
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
});
