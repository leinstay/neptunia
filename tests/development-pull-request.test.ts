// What the worker's pull request carries and what follows its merge, over the world of tests/fixtures/development-rig.ts:
// the repository named on every gh call, the engine's own test counts, the paths no test covers, a failed `gh pr create`
// or thinker run, and the branch gone after a merge. Each test names the bug it catches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { developmentWorld, ownerTask, settle } from './fixtures/development-rig.ts';
import { FIX_REQUEST, herCalls } from './fixtures/selfimprovement-rig.ts';

test('auto mode deletes the branch with its merge', async (t) => {
  // Catches: merged branches pile up on the repository.
  const world = developmentWorld(t);
  ownerTask(world);
  const worker = world.worker();
  await settle(worker);
  if (world.pr !== null) world.pr.checks = ['SUCCESS'];
  world.mode = 'auto';
  await settle(worker);
  assert.equal(world.ghPr('merge')[0]?.includes('--delete-branch'), true);
});

test("an owner's merge deletes the branch on the named repository, once", async (t) => {
  // Catches: only the worker's own merge cleans up, so every owner merge leaves its branch behind.
  const world = developmentWorld(t);
  const id = ownerTask(world);
  const worker = world.worker();
  await settle(worker);
  const branch = world.pr?.branch ?? '';
  if (world.pr !== null) world.pr.state = 'MERGED';
  await settle(worker);
  await settle(worker);
  assert.equal(world.show(id).task.status, 'done');
  const deletions = world.gitCalls('push').filter((args) => args.includes('--delete'));
  assert.deepEqual(deletions, [['push', 'https://github.com/example/engine.git', '--delete', branch]]);
});

test('every gh call of a pull request names the repository, from create to merge', async (t) => {
  // Catches: a deployment on a fork reads or merges on the checkout's `origin` instead.
  const world = developmentWorld(t);
  ownerTask(world);
  const worker = world.worker();
  await settle(worker);
  if (world.pr !== null) world.pr.checks = ['SUCCESS'];
  world.mode = 'auto';
  await settle(worker);
  assert.deepEqual([...new Set(world.gh.map((call) => String(call.args[1])))].sort(), [
    'create',
    'merge',
    'ready',
    'view',
  ]);
  for (const { args } of world.gh) assert.equal(args[args.indexOf('--repo') + 1], 'example/engine', args.join(' '));
});

test("the pull request and the handoff carry the evidence, the paths and the engine's own test counts", async (t) => {
  // Catches: a body built from what the agent says, or a reviewer with no evidence and no counts.
  const world = developmentWorld(t);
  const id = ownerTask(world);
  world.scripts.thinker = () => ({ ok: true, text: 'All 99 tests pass.', exitCode: 0 });
  await settle(world.worker());
  const body = world.pr?.body ?? '';
  assert.ok(body.includes('web.read timed out in three turns.'));
  assert.ok(body.includes('src/web/read.ts'));
  assert.ok(body.includes('3 passed, 0 failed'));
  assert.equal(body.includes('99'), false);
  const { handoff } = world.show(id);
  assert.deepEqual(
    handoff?.tests.map((one) => [one.passed, one.failed]),
    [[3, 0]]
  );
  assert.deepEqual(handoff?.evidence, world.changed);
  assert.ok(handoff?.artifacts.includes(world.pr?.url ?? ''));
});

test('a change no test covers runs no tests and says which paths', async (t) => {
  // Catches: a change without tests reads as tested, or a runner started with no files runs the whole suite.
  const world = developmentWorld(t);
  const id = ownerTask(world);
  world.changed = ['docs/board.md'];
  await settle(world.worker());
  assert.equal(world.tests.length, 0);
  assert.equal(world.created, 1);
  assert.ok(world.pr?.body.includes('No test covers: docs/board.md'));
  assert.deepEqual(world.show(id).handoff?.open_issues, ['No test covers: docs/board.md']);
});

test('a failed gh pr create fails the task with its first line and leaves nothing waiting', async (t) => {
  // Catches: a task in needs_validation with no pull request, which nobody ever looks at.
  const world = developmentWorld(t);
  const id = ownerTask(world);
  world.createError = 'GraphQL: rate limited\nand a second line';
  await settle(world.worker());
  const { task } = world.show(id);
  assert.equal(task.status, 'failed');
  assert.equal(task.close_reason, 'gh-failed: GraphQL: rate limited');
});

test('a thinker run that fails closes the task with the error, and nothing is pushed', async (t) => {
  // Catches: a crashed agent read as a finished turn, so a half-made change goes up as a pull request.
  const world = developmentWorld(t);
  const id = ownerTask(world);
  world.scripts.thinker = () => ({ ok: false, text: '', exitCode: null, error: 'timeout' });
  await settle(world.worker());
  const { task } = world.show(id);
  assert.equal(task.status, 'failed');
  assert.match(task.close_reason ?? '', /timeout/);
  assert.equal(world.gitCalls('push').length, 0);
});

test('her task keeps her cases, and the thinker reads her evidence', async (t) => {
  // Catches: the intake rewrites her filing, or the brief drops the only reason for the work.
  const world = developmentWorld(t);
  const answer = await herCalls(world.caller)('task.propose', { ...FIX_REQUEST, kind: 'fix' });
  const id = String((answer.data as { task: { id: string } }).task.id);
  await settle(world.worker());
  assert.deepEqual(world.show(id).task.metadata?.examples, FIX_REQUEST.examples);
  assert.equal(world.show(id).task.description, FIX_REQUEST.evidence);
  assert.ok(world.runsOf('thinker')[0]?.brief.includes(FIX_REQUEST.evidence));
});
