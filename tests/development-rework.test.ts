// What the worker does when a thinker ends its turn on a review's requested changes without changing anything, over the
// world of tests/fixtures/development-rig.ts.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { HEAD, developmentWorld, ownerTask, settle } from './fixtures/development-rig.ts';

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
