// How a skill task reaches `done`, the state the core's activation sweep reads: the worker's seam binds the package over
// the socket (bin/development.ts), and the worker's next wake accepts her bound task (src/development/worker.ts). A real
// board and fakes for the rest (tests/fixtures/development-rig.ts). Each test names the bug it catches.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skillPackage } from '../bin/development.ts';
import type { TaskRecord } from '../src/board/board.ts';
import { WORKER, developmentWorld, ownerTask, settle } from './fixtures/development-rig.ts';
import type { DevelopmentWorld } from './fixtures/development-rig.ts';
import { FIX_REQUEST, herCalls } from './fixtures/selfimprovement-rig.ts';

const TASK = { id: 'T-1' } as TaskRecord;
const BINDING = { skill: 'say-it', versionId: 'skillver:say-it:abc' };

async function herSkillTask(world: DevelopmentWorld): Promise<string> {
  const answer = await herCalls(world.caller)('task.propose', { ...FIX_REQUEST, kind: 'skill' });
  assert.equal(answer.status, 'ok', answer.summary ?? '');
  return String((answer.data as { task: { id: string } }).task.id);
}

function bind(world: DevelopmentWorld, id: string): void {
  const { task } = world.show(id);
  world.board.call(WORKER, 'task.update', { id, revision: task.revision, metadata: { package: BINDING } });
}

test('her bound skill task closes at the next wake, so the activation sweep can see it', async (t) => {
  // Bug: nothing reviews a task with no pull request, so her skill task waits in needs_validation for ever.
  const world = developmentWorld(t);
  const id = await herSkillTask(world);
  await settle(world.worker());
  assert.equal(world.show(id).task.status, 'needs_validation');
  bind(world, id);
  await settle(world.worker());
  assert.equal(world.show(id).task.status, 'done');
  assert.equal(world.created, 0);
});

test('a skill task with no binding is not accepted', async (t) => {
  // Bug: a task whose seam bound nothing counts as evidence of a produced version.
  const world = developmentWorld(t);
  const id = await herSkillTask(world);
  await settle(world.worker());
  await settle(world.worker());
  assert.equal(world.show(id).task.status, 'needs_validation');
});

test("the owner's bound skill task waits for the owner's review", async (t) => {
  // Bug: the worker accepts a task the sweep never activates, so the owner's task ends with nothing active.
  const world = developmentWorld(t);
  const id = ownerTask(world, { metadata: { kind: 'skill' } });
  await settle(world.worker());
  assert.equal(world.show(id).task.status, 'needs_validation');
  bind(world, id);
  await settle(world.worker());
  assert.equal(world.show(id).task.status, 'needs_validation');
});

/** A link that answers the listing with `pending` and every other command with `bound`; the commands it saw. */
function linkOf(pending: unknown, bound = { status: 'ok', text: 'bound' }) {
  const seen: Array<Record<string, unknown>> = [];
  return {
    seen,
    command(_name: string, args: Record<string, unknown>) {
      seen.push(args);
      return Promise.resolve(args.json === true ? { status: 'ok', text: JSON.stringify(pending) } : bound);
    },
  };
}

test('the seam binds the one pending version that names the task', async () => {
  // Bug: the seam only checks that a version exists, so no task names what it produced.
  const link = linkOf([
    { skill: 'other-skill', task: null },
    { skill: 'say-it', task: 'T-1' },
  ]);
  assert.deepEqual(await skillPackage(link, TASK), { code: 'pending' });
  assert.deepEqual(link.seen.at(-1), { name: 'say-it', task: 'T-1' });
});

test('the seam refuses when no pending version or more than one names the task', async () => {
  // Bug: the seam takes another skill's version, or picks one of two at random.
  const none = await skillPackage(linkOf([{ skill: 'other-skill', task: 'T-2' }]), TASK);
  assert.equal(none.code, 'refused');
  const two = linkOf([
    { skill: 'one', task: 'T-1' },
    { skill: 'two', task: 'T-1' },
  ]);
  assert.equal((await skillPackage(two, TASK)).code, 'refused');
  assert.equal(two.seen.length, 1, 'nothing was bound');
});

test('the seam passes on why the core refused the binding', async () => {
  // Bug: a package that broke since the listing is reported as bound.
  const link = linkOf([{ skill: 'say-it', task: 'T-1' }], {
    status: 'invalid',
    text: 'skill.pending say-it: bad-setup',
  });
  const answer = await skillPackage(link, TASK);
  assert.ok(answer.code === 'refused' && answer.reason.includes('bad-setup'));
});
