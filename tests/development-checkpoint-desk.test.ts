// src/development/checkpoint-desk.ts: the board decides which worktree counts. The worktrees are disposable folders.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { createCheckpointDesk } from '../src/development/checkpoint-desk.ts';
import { tempDir } from './fixtures/tmp.ts';

function rig(status = 'in_progress') {
  const root = tempDir('nep-desk-root-');
  const worktree = path.join(root, 'T1');
  fs.mkdirSync(worktree);
  fs.writeFileSync(path.join(worktree, 'a.ts'), 'one\n');
  const outside = tempDir('nep-desk-outside-');
  fs.writeFileSync(path.join(outside, 'a.ts'), 'other\n');
  const rows = [
    { id: 'T1', status, metadata: { development: { worktree } } },
    { id: 'T2', status: 'in_progress', metadata: { development: { worktree: outside } } },
    { id: 'T3', status: 'in_progress', metadata: null },
  ];
  let serial = 0;
  const desk = createCheckpointDesk({
    tasks: () => Promise.resolve(rows),
    worktreeRoot: () => root,
    storeDir: tempDir('nep-desk-store-'),
    now: () => 1000,
    newId: () => `c${(serial += 1)}`,
  });
  return { desk, worktree, outside };
}

test('a checkpoint of a task worktree previews and restores, with the undo reported', async () => {
  // Bug: the desk lists a checkpoint but its restore goes through another path than its preview.
  const { desk, worktree } = rig();
  const taken = await desk.take('T1');
  assert.ok(taken.ok);
  fs.writeFileSync(path.join(worktree, 'a.ts'), 'two\n');
  const { capability, points } = await desk.list();
  assert.equal(capability.restore, true);
  assert.deepEqual(points[0]?.changes, [{ path: 'a.ts', change: 'modified' }]);
  const restored = await desk.restore('T1', taken.id, points[0]?.revision ?? 0);
  assert.equal(restored.status, 'restored');
  assert.equal(fs.readFileSync(path.join(worktree, 'a.ts'), 'utf8'), 'one\n');
});

test('a worktree the board names outside the development folder has no capability', async () => {
  // Bug: a task row pointing at another checkout restores over it.
  const { desk, outside } = rig();
  const taken = await desk.take('T2');
  assert.equal(taken.ok, false);
  assert.equal((await desk.restore('T2', 'c1', 1)).status, 'refused');
  assert.equal(fs.readFileSync(path.join(outside, 'a.ts'), 'utf8'), 'other\n');
});

test('a closed task and an unknown task hold no worktree', async () => {
  // Bug: a finished task's folder can still be rewound.
  const closed = rig('done');
  assert.equal((await closed.desk.take('T1')).ok, false);
  const { capability } = await closed.desk.list();
  assert.equal(capability.restore, false);
  assert.equal((await rig().desk.take('T9')).ok, false);
});
