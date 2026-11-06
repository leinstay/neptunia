// The worktree of a development task (src/development/worker.ts, `placeTree`) gets the checkout's dependencies before any
// agent runs in it. The pre-commit hook runs `node_modules/.bin/prettier` relative to the worktree, and a worktree under
// `<checkout>/.worktrees/` has no `node_modules` of its own (observed 2026-11-06: `commit-failed: xargs:
// node_modules/.bin/prettier: No such file or directory`). The design assumed here is the one of
// `.agents/tools/worktree-node-modules.sh`: `<tree>/node_modules` is a real folder holding one symlink per package of
// `<repoDir>/node_modules` (`.bin` included), except `@neptunia/*`, whose links are relative (`../../interfaces/<name>`)
// so they resolve to the worktree's own workspace folders. The worker links with node:fs itself, so the rig needs no new
// dependency: the tree the fake `git worktree add` makes is a real temp folder. Nothing bypasses a hook.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { childrenOf, developmentWorld, fileDevTask, ownerTask, settle } from './fixtures/development-rig.ts';
import type { DevelopmentWorld } from './fixtures/development-rig.ts';

/** The checkout's installed packages: a bin, one plain package and one workspace link, as `npm install` leaves them. */
function installModules(repoDir: string): void {
  const modules = path.join(repoDir, 'node_modules');
  fs.mkdirSync(path.join(modules, '.bin'), { recursive: true });
  fs.writeFileSync(path.join(modules, '.bin', 'prettier'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  fs.mkdirSync(path.join(modules, 'left-pad'));
  fs.writeFileSync(path.join(modules, 'left-pad', 'index.js'), 'module.exports = 1;\n');
  fs.mkdirSync(path.join(repoDir, 'interfaces', 'chat'), { recursive: true });
  fs.mkdirSync(path.join(modules, '@neptunia'));
  fs.symlinkSync('../../interfaces/chat', path.join(modules, '@neptunia', 'chat'));
}

/** What a run sees in its folder the moment it starts. */
function seenAtStart(world: DevelopmentWorld, agent: 'thinker' | 'dev', seen: Array<boolean>): void {
  world.scripts[agent] = (run) => {
    seen.push(fs.existsSync(path.join(run.cwd, 'node_modules', '.bin', 'prettier')));
  };
}

test('the first agent of a task finds node_modules/.bin/prettier in its new worktree', async (t) => {
  // Bug: the worktree has no node_modules, so the hook's prettier is missing and the commit of the task fails.
  const world = developmentWorld(t);
  installModules(world.repoDir);
  const seen: Array<boolean> = [];
  seenAtStart(world, 'thinker', seen);
  ownerTask(world);
  await settle(world.worker());
  assert.deepEqual(seen, [true]);
});

test('a dev task of a thinker gets the dependencies in its own worktree before the dev run', async (t) => {
  // Bug: only the top-level worktree is linked, and the dev run (which commits) works in a bare one.
  const world = developmentWorld(t);
  installModules(world.repoDir);
  const seen: Array<boolean> = [];
  seenAtStart(world, 'dev', seen);
  const id = ownerTask(world);
  world.scripts.thinker = (_run, turn) => {
    if (turn === 1) fileDevTask(world, id, 'The one step');
  };
  await settle(world.worker());
  assert.equal(childrenOf(world, id).length, 1);
  assert.deepEqual(seen, [true]);
});

test('links every package of the checkout, and points @neptunia at the worktree own folders', async (t) => {
  // Bug: a plain link of the whole folder resolves @neptunia/* to the checkout's code, so a test in the worktree runs it.
  const world = developmentWorld(t);
  installModules(world.repoDir);
  let tree = '';
  world.scripts.thinker = (run) => {
    tree = run.cwd;
  };
  ownerTask(world);
  await settle(world.worker());
  const modules = path.join(tree, 'node_modules');
  assert.equal(fs.lstatSync(modules).isDirectory(), true);
  assert.equal(fs.existsSync(path.join(modules, 'left-pad', 'index.js')), true);
  const workspace = fs.readlinkSync(path.join(modules, '@neptunia', 'chat'));
  assert.equal(path.isAbsolute(workspace), false);
  assert.equal(
    path.resolve(modules, '@neptunia', workspace),
    path.join(tree, 'interfaces', 'chat'),
    'the link resolves inside the worktree'
  );
});

test('links a worktree that already exists without node_modules', async (t) => {
  // Bug: a worktree made before the fix, or by hand, is found in `git worktree list` and used bare.
  const world = developmentWorld(t);
  installModules(world.repoDir);
  const id = ownerTask(world);
  const tree = path.join(world.worktreeRoot, id);
  fs.mkdirSync(tree, { recursive: true });
  world.branches.add(`self/${id}`);
  world.trees.set(tree, `self/${id}`);
  const seen: Array<boolean> = [];
  seenAtStart(world, 'thinker', seen);
  await settle(world.worker());
  assert.deepEqual(seen, [true]);
});

test('leaves a node_modules the worktree already holds as it is', async (t) => {
  // Bug: a second entry into a task wipes or fails on the links the first one made.
  const world = developmentWorld(t);
  installModules(world.repoDir);
  const id = ownerTask(world);
  const tree = path.join(world.worktreeRoot, id);
  fs.mkdirSync(path.join(tree, 'node_modules', 'own'), { recursive: true });
  world.branches.add(`self/${id}`);
  world.trees.set(tree, `self/${id}`);
  await settle(world.worker());
  assert.equal(fs.existsSync(path.join(tree, 'node_modules', 'own')), true);
  assert.notEqual(world.show(id).task.status, 'failed');
});

test('fails the task before any agent runs when the checkout has no node_modules, naming npm install', async (t) => {
  // Bug: the task runs a whole thinker turn and then dies at its first commit with a missing-file line from xargs.
  // The lead: the rig seeds node_modules by default, so this case asks for a checkout without it.
  const world = developmentWorld(t, { modules: false });
  const id = ownerTask(world);
  await settle(world.worker());
  const { task } = world.show(id);
  assert.equal(task.status, 'failed');
  assert.match(task.close_reason ?? '', /^modules-missing: .*node_modules/);
  assert.match(task.close_reason ?? '', /npm install/);
  assert.deepEqual(world.runsOf('thinker'), []);
  assert.deepEqual(world.runsOf('dev'), []);
});

test('commits what a dev run left with the hooks on', async (t) => {
  // Bug: the missing prettier is "fixed" by committing with --no-verify.
  const world = developmentWorld(t);
  installModules(world.repoDir);
  const id = ownerTask(world);
  world.changed = ['src/web.ts'];
  world.scripts.thinker = (_run, turn) => {
    if (turn === 1) fileDevTask(world, id, 'The one step');
  };
  await settle(world.worker());
  const commits = world.gitCalls('commit');
  assert.ok(commits.length > 0, 'a commit was made');
  for (const args of commits) {
    assert.equal(
      args.some((one) => one === '--no-verify' || one === '-n'),
      false
    );
  }
});
