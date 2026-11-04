// The owner's `task.review changes` on a task whose pull request waits: the persisted pull request must not send the
// task straight back to `needs_validation`. Over the world of tests/fixtures/development-rig.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HEAD, MINUTE, developmentWorld, ownerTask, settle } from './fixtures/development-rig.ts';

const FIXED_HEAD = 'd4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4d4';

test("the owner's requested changes give the thinker a new turn on the same branch and pull request", async (t) => {
  // Catches: the task lapses, is reclaimed, finds its pull request and returns to needs_validation, unchanged, with the
  // owner's comment read by nobody.
  const world = developmentWorld(t);
  const id = ownerTask(world);
  const worker = world.worker();
  await settle(worker);
  assert.equal(world.show(id).task.status, 'needs_validation');
  const [first] = world.runsOf('thinker');
  world.scripts.thinker = () => {
    world.head = FIXED_HEAD;
  };

  world.board.call('boss', 'task.review', { id, decision: 'changes', comment: 'The timeout belongs in the config.' });
  await settle(worker);
  // Whether the worker resumes at once or only once the lease lapsed is its own choice; a lapse must not lose the turn.
  world.advance(31 * MINUTE);
  world.board.reap();
  await settle(worker);

  const turns = world.runsOf('thinker');
  assert.equal(turns.length, 2);
  assert.equal(turns[1]?.cwd, first?.cwd);
  assert.ok(turns[1]?.brief.includes('The timeout belongs in the config.'));
  assert.equal(world.created, 1);
  assert.equal(world.show(id).task.status, 'needs_validation');
});

test('after requested changes the merge names the new head, never the one the owner refused', async (t) => {
  // Catches: the persisted head stays the old one, so green checks on the fixed commit never count, or the old counts.
  const world = developmentWorld(t);
  const id = ownerTask(world);
  const worker = world.worker();
  await settle(worker);
  world.scripts.thinker = () => {
    world.head = FIXED_HEAD;
  };
  world.board.call('boss', 'task.review', { id, decision: 'changes', comment: 'The timeout belongs in the config.' });
  await settle(worker);
  world.advance(31 * MINUTE);
  world.board.reap();
  await settle(worker);
  assert.notEqual(world.head, HEAD);
  assert.equal(world.pr?.head, FIXED_HEAD);

  if (world.pr !== null) world.pr.checks = ['SUCCESS'];
  world.mode = 'auto';
  await settle(worker);

  const merge = world.ghPr('merge').find((args) => args.includes('--match-head-commit'));
  assert.equal(merge?.[merge.indexOf('--match-head-commit') + 1], FIXED_HEAD);
  assert.equal(world.show(id).task.status, 'done');
});
