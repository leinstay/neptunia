// What keeps the first start of the development worker from spending on old work, and the lead's decisions the
// specifier's files leave open: the boundary `startedAt` (a task approved before it waits for the owner), the base
// fetched before a worktree, a dev task's work reaching the task's branch, and the most thinker turns on a task. A real
// board and fakes for git, gh, the tests and the agents (tests/fixtures/development-rig.ts). Each test names its bug.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { applyBoardWrite, createBoardPort } from '../src/board/writer.ts';
import { developmentSettings, ensureStartedAt } from '../src/development/settings.ts';
import {
  MINUTE,
  T0,
  childrenOf,
  developmentWorld,
  fileDevTask,
  ownerTask,
  settle,
} from './fixtures/development-rig.ts';
import type { DevelopmentWorld } from './fixtures/development-rig.ts';
import { freshMemoryDb } from './fixtures/memory-db-copy.ts';
import { FIX_REQUEST, herCalls } from './fixtures/selfimprovement-rig.ts';
import { tempDir } from './fixtures/tmp.ts';

const iso = (at: number): string => new Date(at).toISOString();

/** The world with the boundary set; the settings otherwise as the rig reads them. */
function bounded(world: DevelopmentWorld, startedAt: number): void {
  world.deps.settings = () => ({
    mode: world.mode,
    base: world.base,
    repository: world.repository,
    startedAt: iso(startedAt),
  });
}

const statusOf = (world: DevelopmentWorld, id: string): string => world.show(id).task.status;

test('a task approved before the worker first started waits, runs nothing, and is listed for the owner', async (t) => {
  // Catches: enabling the unit on a live board starts paying agents for every old approved task at once.
  const world = developmentWorld(t);
  const old = ownerTask(world);
  world.advance(MINUTE);
  bounded(world, T0 + MINUTE);
  const report = await world.worker().wake();
  assert.deepEqual(report.started, []);
  assert.equal(world.runs.length, 0);
  assert.equal(world.git.length, 0);
  assert.equal(statusOf(world, old), 'approved');
  assert.deepEqual(report.heldBack, [old]);
});

test('a task approved after the boundary runs, the old one beside it still waits', async (t) => {
  // Catches: the boundary stops everything, or a new task is taken for an old one.
  const world = developmentWorld(t);
  const old = ownerTask(world);
  world.advance(MINUTE);
  bounded(world, T0 + MINUTE);
  const fresh = ownerTask(world, { title: 'A later task' });
  await settle(world.worker());
  assert.equal(statusOf(world, fresh), 'needs_validation');
  assert.equal(statusOf(world, old), 'approved');
  assert.equal(world.runsOf('thinker').length, 1);
});

test('an old task the owner admits runs', async (t) => {
  // Catches: an old task the owner still wants can only be filed again, losing its history.
  const world = developmentWorld(t);
  const old = ownerTask(world);
  world.advance(MINUTE);
  bounded(world, T0 + MINUTE);
  const worker = world.worker();
  await worker.wake();
  const { revision } = world.show(old).task;
  world.board.call('boss', 'task.update', { id: old, revision, metadata: { admitted: 'yes' } });
  await settle(worker);
  assert.equal(world.runsOf('thinker').length, 1);
});

test('a proposal of hers filed before the boundary is not approved by the worker', async (t) => {
  // Catches: the intake turns an old fix of hers into new approved work the boundary then calls fresh.
  const world = developmentWorld(t);
  const answer = await herCalls(world.caller)('board.propose', { ...FIX_REQUEST, kind: 'fix' });
  const id = String((answer.data as { task: { id: string } }).task.id);
  world.advance(MINUTE);
  bounded(world, T0 + MINUTE);
  const report = await world.worker().wake();
  assert.equal(statusOf(world, id), 'proposed');
  assert.deepEqual(report.heldBack, [id]);
  assert.equal(world.runs.length, 0);
});

test('a task the worker already started goes on after a restart, whatever the boundary says', async (t) => {
  // Catches: moving the boundary forward strands work in flight.
  const world = developmentWorld(t);
  const id = ownerTask(world);
  world.scripts.thinker = (_run, turn) => {
    if (turn === 1) {
      const { lease_generation: generation } = world.show(id).task;
      world.board.call('development', 'task.block', { id, generation, reason: 'Stuck.', unblocks: 'A word.' });
    }
  };
  await settle(world.worker());
  world.advance(MINUTE);
  bounded(world, T0 + MINUTE);
  world.board.call('boss', 'task.unblock', { id, note: 'Go on.' });
  await settle(world.worker());
  assert.equal(statusOf(world, id), 'needs_validation');
});

test('the first start writes the boundary once, and a restart keeps it', () => {
  // Catches: a boundary that moves at every restart, or a worker that starts with none and runs everything.
  const privateDir = tempDir('nep-development-boundary-');
  const first = ensureStartedAt(privateDir, {}, T0);
  assert.equal(first, iso(T0));
  const config = { development: { startedAt: first } };
  assert.equal(ensureStartedAt(privateDir, config, T0 + 5 * MINUTE), first);
  assert.equal(developmentSettings(config).startedAt, first);
});

test('the base is fetched from the named repository before the worktree exists, and the tree starts at what came', async (t) => {
  // Catches: a long-lived worker forks every task from the base it saw weeks ago.
  const world = developmentWorld(t);
  ownerTask(world);
  await settle(world.worker());
  const fetch = world.git.findIndex((call) => call.args[0] === 'fetch');
  const add = world.git.findIndex((call) => call.args[0] === 'worktree' && call.args[1] === 'add');
  const reset = world.git.findIndex((call) => call.args[0] === 'reset');
  assert.ok(fetch >= 0 && fetch < add && add < reset, `fetch ${fetch}, add ${add}, reset ${reset}`);
  assert.ok(world.git[fetch]?.args.includes('https://github.com/example/engine.git'));
  assert.equal(world.git[fetch]?.cwd, world.repoDir);
  assert.equal(world.git[reset]?.args.at(-1), world.git[fetch]?.args.at(-1)?.split(':')[1]);
});

test("a dev task's work reaches the task's branch before the thinker reads it", async (t) => {
  // Catches: the dev's commits stay on its own branch, so the pull request holds none of them.
  const world = developmentWorld(t);
  const id = ownerTask(world);
  world.scripts.thinker = (_run, turn) => {
    if (turn === 1) fileDevTask(world, id, 'The one step');
  };
  await settle(world.worker());
  const child = childrenOf(world, id)[0] ?? '';
  const merge = world.git.find((call) => call.args[0] === 'merge');
  const tree = world.show(id).task.metadata?.development as { worktree: string };
  const own = world.show(child).task.metadata?.development as { branch: string };
  assert.equal(merge?.cwd, tree.worktree);
  assert.equal(merge?.args.at(-1), own.branch);
  assert.equal(statusOf(world, child), 'done');
});

test('a dev task whose work will not merge fails with that, and the thinker still decides', async (t) => {
  // Catches: a conflict leaves a half-merged tree under the thinker's next turn.
  const world = developmentWorld(t);
  const id = ownerTask(world);
  world.scripts.thinker = (_run, turn) => {
    if (turn === 1) fileDevTask(world, id, 'A clashing step');
  };
  const git = world.deps.git;
  world.deps.git = (file, args, options) =>
    args[0] === 'merge' && args[1] !== '--abort'
      ? Promise.resolve({ code: 1, stdout: '', stderr: 'CONFLICT (content)' })
      : git(file, args, options);
  await settle(world.worker());
  const child = world.show(childrenOf(world, id)[0] ?? '').task;
  assert.equal(child.status, 'failed');
  assert.match(child.close_reason ?? '', /merge-failed/);
  assert.ok(world.gitCalls('merge').some((args) => args[1] === '--abort'));
  assert.equal(world.runsOf('thinker').length, 2);
});

test('past the most thinker turns the task blocks with the reason to her, and her unblock gives new turns', async (t) => {
  // Catches: a thinker that files a task every turn spends for ever.
  const world = developmentWorld(t);
  const answer = await herCalls(world.caller)('board.propose', { ...FIX_REQUEST, kind: 'fix' });
  const id = String((answer.data as { task: { id: string } }).task.id);
  world.deps.settings = () => ({ mode: world.mode, base: world.base, repository: world.repository, thinkerTurns: 2 });
  let filed = 0;
  world.scripts.thinker = () => {
    filed += 1;
    if (filed <= 2) fileDevTask(world, id, `Step ${filed}`);
  };
  const worker = world.worker();
  await settle(worker);
  assert.equal(world.runsOf('thinker').length, 2);
  assert.equal(statusOf(world, id), 'blocked');
  assert.match(world.show(id).task.blocked_reason ?? '', /thinker-turns/);
  const rows = world.board.call('persona', 'outbox.pull', { to_whom: 'persona:self' });
  assert.ok(rows.some((row) => row.kind === 'blocked' && row.task_id === id));
  await herCalls(world.caller)('board.unblock', { id, note: 'One more try.' });
  await settle(worker);
  assert.equal(world.runsOf('thinker').length, 3);
  assert.equal(statusOf(world, id), 'needs_validation');
});

test('task.wait over the socket answers its events as JSON text when asked to', async (t) => {
  // Catches: the wait drops `json`, the worker cannot parse the plain text, and it restarts at every event.
  const handle = freshMemoryDb();
  t.after(() => handle.close());
  const privateDir = tempDir('nep-development-wait-');
  const port = createBoardPort({
    write: (write) => Promise.resolve(applyBoardWrite(handle, { kind: 'board', write })),
    context: () => ({
      at: T0,
      settings: { leaseTtlMinutes: 30, autoTriage: { role: 'dev', budget: 4, steps: 80, estimate: 30 }, projects: {} },
      privateDir,
    }),
    briefWaitMs: () => 0,
  });
  await port.call('development', 'task.add', { lane: 'dev', title: 'A filed task' });
  const answer = await port.command('development', 'task.wait', { from: 0, json: true });
  const rows = JSON.parse(answer.text) as Array<{ seq: number }>;
  assert.ok(rows.length > 0 && rows.every((row) => row.seq > 0));
});
