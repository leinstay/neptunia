// The check before a top-level task claims work (src/development/edges.ts over src/selfimprovement/repository.ts): a dev
// checkout with no `node_modules` blocks the task with a reason that names `npm install`, because a worktree under it
// resolves its packages there. The worker and the board are the rig's, the check is the real one over temp folders, and a
// disposable fake `gh` on PATH answers it. No network.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { labelsFileOf } from '../src/config/labels.ts';
import { developmentEdges } from '../src/development/edges.ts';
import { developmentWorld, ownerTask, settle } from './fixtures/development-rig.ts';
import { tempDir } from './fixtures/tmp.ts';

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
