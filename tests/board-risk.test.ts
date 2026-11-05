// A task's risk on the board: `task.risk` raises it with a reason and records who and why, a lowering is refused on
// every write path, and a parent never reads lower than its highest dev task. The thinker holds the worker's client
// (bin/development.ts), so here the thinker is the principal `development`. Over the world of
// tests/fixtures/development-rig.ts. Each test names the bug it catches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { runTask } from '../bin/neptunia-task.ts';
import { runTaskCommand } from '../src/board/commands.ts';
import { BoardError } from '../src/board/machine.ts';
import { WORKER, developmentWorld, fileDevTask, ownerTask } from './fixtures/development-rig.ts';
import type { DevelopmentWorld } from './fixtures/development-rig.ts';
import { tempDir } from './fixtures/tmp.ts';

const SELF = 'persona:self';

type RiskEvent = { actor: string; old: string | null; risk: string; reason: string };

/** The `task.risk` events of a task, oldest first; `new` holds `{ risk, reason }`. */
function riskEvents(world: DevelopmentWorld, id: string): Array<RiskEvent> {
  return world.board
    .eventsSince()
    .filter((row) => row.task_id === id && row.type === 'task.risk')
    .map((row) => {
      // The contract of the event: the board writes `new` as the JSON of `{ risk, reason }`.
      const written = JSON.parse(row.new ?? '{}') as { risk: string; reason: string };
      return { actor: row.actor, old: row.old, risk: written.risk, reason: written.reason };
    });
}

const riskOf = (world: DevelopmentWorld, id: string): string => world.show(id).task.risk;

/** The board's code of a refusal, or `passed`. */
function outcome(call: () => unknown): string {
  try {
    call();
    return 'passed';
  } catch (error) {
    return error instanceof BoardError ? error.code : String(error);
  }
}

/** The message of a refusal, or `passed`. */
function refusalText(call: () => unknown): string {
  try {
    call();
    return 'passed';
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

// ---------- raising, and who and why ----------

test('the thinker raises a task, and the board records who changed it, from what and why', (t) => {
  // Catches: the risk moves with no trace, so nobody can say why a pull request waits.
  const world = developmentWorld(t);
  const id = ownerTask(world);
  world.board.call(WORKER, 'task.risk', { id, risk: 'high', reason: 'It changes how a lease ends.' });
  assert.equal(riskOf(world, id), 'high');
  assert.deepEqual(riskEvents(world, id), [
    { actor: WORKER, old: 'low', risk: 'high', reason: 'It changes how a lease ends.' },
  ]);
});

test('an assessment at the level the task already has is recorded and moves nothing', (t) => {
  // Catches: the thinker's `low` on a low task counts as a lowering, or leaves no record that it assessed anything.
  const world = developmentWorld(t);
  const id = ownerTask(world);
  world.board.call(WORKER, 'task.risk', { id, risk: 'low', reason: 'One constant in one reader.' });
  assert.equal(riskOf(world, id), 'low');
  assert.deepEqual(riskEvents(world, id), [
    { actor: WORKER, old: 'low', risk: 'low', reason: 'One constant in one reader.' },
  ]);
});

test('a risk without a reason is refused naming the reason, and the value stays', (t) => {
  // Catches: a raise nobody can explain later.
  const world = developmentWorld(t);
  const id = ownerTask(world);
  assert.match(
    refusalText(() => world.board.call(WORKER, 'task.risk', { id, risk: 'high' })),
    /reason/
  );
  assert.equal(riskOf(world, id), 'low');
});

test('a level the board does not know is refused naming the risk, and the value stays', (t) => {
  // Catches: `critical` stored as a risk that the merge gate cannot compare.
  const world = developmentWorld(t);
  const id = ownerTask(world);
  assert.match(
    refusalText(() => world.board.call(WORKER, 'task.risk', { id, risk: 'critical', reason: 'Very bad.' })),
    /risk must be/
  );
  assert.equal(riskOf(world, id), 'low');
});

// ---------- a lowering, on every write path ----------

test('a lowering through task.risk is refused with risk-lowered, the value stays and nothing is recorded', (t) => {
  // Catches: the thinker talks a task back down to `low` and auto mode merges it.
  const world = developmentWorld(t);
  const id = ownerTask(world, { risk: 'high' });
  const code = outcome(() => world.board.call(WORKER, 'task.risk', { id, risk: 'low', reason: 'It is fine really.' }));
  assert.equal(code, 'risk-lowered');
  assert.equal(riskOf(world, id), 'high');
  assert.deepEqual(riskEvents(world, id), []);
});

test('a lowering by one step is a lowering', (t) => {
  // Catches: only `high` to `low` is refused, so two calls walk the risk down.
  const world = developmentWorld(t);
  const id = ownerTask(world, { risk: 'high' });
  const code = outcome(() => world.board.call(WORKER, 'task.risk', { id, risk: 'normal', reason: 'A bit less.' }));
  assert.equal(code, 'risk-lowered');
  assert.equal(riskOf(world, id), 'high');
});

test('a lowering through task.update is refused the same way', (t) => {
  // Catches: the old field path stays open beside the new command, and `neptunia task update --risk low` undoes the rule.
  const world = developmentWorld(t);
  const id = ownerTask(world, { risk: 'high' });
  const { revision } = world.show(id).task;
  const code = outcome(() => world.board.call(WORKER, 'task.update', { id, revision, risk: 'low' }));
  assert.equal(code, 'risk-lowered');
  assert.equal(riskOf(world, id), 'high');
});

test('a lowering in the `set` of a transition is refused, and the move does not happen', (t) => {
  // Catches: a transition's fields skip the rule, or the move goes through with the field dropped.
  const world = developmentWorld(t);
  const id = ownerTask(world, { risk: 'high' });
  world.board.call(WORKER, 'task.claim', { id });
  const { revision } = world.show(id).task;
  const code = outcome(() =>
    world.board.call(WORKER, 'task.transition', {
      id,
      status: 'failed',
      close_reason: 'Gave up.',
      revision,
      set: { risk: 'low' },
    })
  );
  assert.equal(code, 'risk-lowered');
  assert.equal(riskOf(world, id), 'high');
  assert.equal(world.show(id).task.status, 'in_progress');
});

test('her own task cannot be lowered by her either', (t) => {
  // Catches: the requester's right to edit her task turns into a way around the thinker's assessment.
  const world = developmentWorld(t);
  const { id, revision } = world.board.call('persona', 'task.add', {
    lane: 'dev',
    title: 'A fix of hers',
    description: 'evidence',
    requester: SELF,
    subscriber: SELF,
  });
  world.board.call('boss', 'task.transition', {
    id,
    status: 'triaged',
    revision,
    set: { role: 'dev', estimate: 30, budget: 4, risk: 'high' },
  });
  const now = world.show(id).task.revision;
  const code = outcome(() => world.board.call('persona', 'task.update', { id, revision: now, risk: 'low' }));
  assert.equal(code, 'risk-lowered');
  assert.equal(riskOf(world, id), 'high');
});

// ---------- the thinker's way to the board ----------

test('the socket answers a lowering with its code and raises through the command task.risk', (t) => {
  // Catches: the op exists on the board and the agent's command layer does not reach it, or hides the code in `error`.
  const world = developmentWorld(t);
  const id = ownerTask(world);
  const deps = { board: () => world.board, briefWaitMs: () => 0 };
  const raised = runTaskCommand(deps, WORKER, 'task.risk', { id, risk: 'high', reason: 'It touches the lease.' });
  assert.equal(raised.status, 'ok');
  const lowered = runTaskCommand(deps, WORKER, 'task.risk', { id, risk: 'low', reason: 'Never mind.' });
  assert.equal(lowered.status, 'risk-lowered');
  assert.equal(lowered.data, null);
});

test('the command line takes `risk <id> <level> --reason` and refuses it without the reason', async (t) => {
  // Catches: the prompt tells the thinker a command the command line calls unknown, so no task is ever assessed.
  t.mock.method(process.stderr, 'write', () => true);
  const env = { NEPTUNIA_TASK_TOKEN: 'a-token', NEPTUNIA_TASK_CLIENT: WORKER };
  const socket = path.join(tempDir('nep-risk-cli-'), 'no-core.sock');
  // Exit 1 is "no core listens": the line itself was understood. Exit 2 is a usage error.
  assert.equal(await runTask(['risk', 'T-abcdef', 'high', '--reason', 'The lease.', '--socket', socket], env), 1);
  assert.equal(await runTask(['risk', 'T-abcdef', 'high', '--socket', socket], env), 2);
});

// ---------- a parent and its dev tasks ----------

test('a dev task filed above its parent raises the parent, and the parent names it', (t) => {
  // Catches: the thinker's plan holds a high step while the task that merges it still reads low.
  const world = developmentWorld(t);
  const parent = ownerTask(world);
  const child = ownerTask(world, { parent, risk: 'high' });
  assert.equal(riskOf(world, parent), 'high');
  const [raised] = riskEvents(world, parent);
  assert.equal(raised?.risk, 'high');
  assert.ok(raised?.reason.includes(child), `the reason "${raised?.reason}" names the dev task`);
});

test('a raise on a dev task raises its parent to the same level', (t) => {
  // Catches: only the filing is looked at, and the thinker's later assessment of the step stops at the step.
  const world = developmentWorld(t);
  const parent = ownerTask(world);
  const child = fileDevTask(world, parent, 'A step in the schema');
  world.board.call(WORKER, 'task.risk', { id: child, risk: 'normal', reason: 'A column more.' });
  assert.equal(riskOf(world, parent), 'normal');
  world.board.call(WORKER, 'task.risk', { id: child, risk: 'high', reason: 'A column less.' });
  assert.equal(riskOf(world, parent), 'high');
});

test('a raise climbs through a parent of a parent', (t) => {
  // Catches: one level of lookup, so a nested step leaves the task that opens the pull request low.
  const world = developmentWorld(t);
  const top = ownerTask(world);
  const middle = fileDevTask(world, top, 'A step');
  const leaf = fileDevTask(world, middle, 'A step of the step');
  world.board.call(WORKER, 'task.risk', { id: leaf, risk: 'high', reason: 'The lease.' });
  assert.equal(riskOf(world, top), 'high');
});

test('a task linked as a dev task later raises its new parent', (t) => {
  // Catches: only `task.add --parent` is looked at, and `task.depend --type parent-child` is the way around it.
  const world = developmentWorld(t);
  const parent = ownerTask(world);
  const child = ownerTask(world, { risk: 'high' });
  world.board.call('boss', 'task.depend', { id: child, on: parent, type: 'parent-child' });
  assert.equal(riskOf(world, parent), 'high');
});

test('a parent cannot be set below its highest dev task, by anyone', (t) => {
  // Catches: the owner's field edit leaves a parent reading lower than a child, and auto mode reads the parent.
  const world = developmentWorld(t);
  const parent = ownerTask(world, { risk: 'high' });
  ownerTask(world, { parent, risk: 'high' });
  const { revision } = world.show(parent).task;
  // Refused or written back up, either way the parent must not read lower than the child.
  outcome(() => world.board.call('boss', 'task.update', { id: parent, revision, risk: 'low' }));
  assert.equal(riskOf(world, parent), 'high');
});

test('a parent keeps its level over a lower dev task, and a raise never comes down to a child', (t) => {
  // Catches: the parent is set to its child's level instead of the higher of the two, which is a lowering by the back door.
  const world = developmentWorld(t);
  const parent = ownerTask(world, { risk: 'high' });
  const child = fileDevTask(world, parent, 'A small step');
  world.board.call(WORKER, 'task.risk', { id: child, risk: 'normal', reason: 'A little more than nothing.' });
  assert.equal(riskOf(world, parent), 'high');
  assert.equal(riskOf(world, child), 'normal');
});

test("a cancelled or failed high dev task still counts toward its parent's floor", (t) => {
  // Catches: closing a high step clears the floor, though its work may already be merged into the parent's branch.
  const world = developmentWorld(t);
  const cancelledUnder = ownerTask(world, { risk: 'high' });
  const cancelled = ownerTask(world, { parent: cancelledUnder, risk: 'high' });
  world.board.call('boss', 'task.transition', {
    id: cancelled,
    status: 'cancelled',
    close_reason: 'Not needed.',
    revision: world.show(cancelled).task.revision,
  });
  const failedUnder = ownerTask(world, { risk: 'high' });
  const failed = ownerTask(world, { parent: failedUnder, risk: 'high' });
  world.board.call(WORKER, 'task.claim', { id: failed });
  world.board.call(WORKER, 'task.transition', {
    id: failed,
    status: 'failed',
    close_reason: 'The step broke.',
    revision: world.show(failed).task.revision,
  });
  for (const parent of [cancelledUnder, failedUnder]) {
    const { revision } = world.show(parent).task;
    const code = outcome(() => world.board.call('boss', 'task.update', { id: parent, revision, risk: 'low' }));
    assert.equal(code, 'risk-lowered');
    assert.equal(riskOf(world, parent), 'high');
  }
});
