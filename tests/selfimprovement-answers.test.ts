// Her answers on a waiting task from the selfimprovement wake (the owner's word of 2026-11-04): she cancels a task,
// comments on it, or accepts the thinker's proposal, which reaches her as a question addressed to `persona:self`. The
// board's own operations already let `persona` do all three, so those are guards; her tools for them are missing. A
// task that needs her answer shows once per new question. A real board; her tools as the operations run them.
//
// The signatures these tests hold the code to, in src/tools/impl/board.ts, src/tools/definitions.ts and config/tools.json:
// - `board.cancel { id, reason }`: `task.transition` to `cancelled`, as `persona`, at the task's current revision.
// - `board.comment { id, text }`: `task.comment`, as `persona`.
// - `board.answer { id, text }`: `id` is the task, as the wake text names it; it answers the open question addressed to
//   `persona:self` on that task through `task.answer`, as `persona`, and is refused `not-found` when there is none.
// - The wake's clock: `state.selfimprovement.lastAt` moves to the moment the wake's view was read, so a question made
//   after the wake fell due and before its turn ran shows in that turn only.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { skillRegistry } from '../src/tools/registry.ts';
import '../src/tools/impl/index.ts';
import { herCalls, selfimprovementWorld, SELFIMPROVEMENT_T0 } from './fixtures/selfimprovement-rig.ts';
import type { SelfimprovementWorld } from './fixtures/selfimprovement-rig.ts';
import { callsOf, wakeLife } from './fixtures/wake-life.ts';

const FILING = {
  lane: 'dev',
  title: 'A task of hers',
  description: 'evidence',
  requester: 'persona:self',
  subscriber: 'persona:self',
};

async function filed(world: SelfimprovementWorld, title = FILING.title) {
  return await world.caller.call('persona', 'task.add', { ...FILING, title });
}

async function show(world: SelfimprovementWorld, id: string) {
  return await world.caller.call('persona', 'task.show', { id });
}

/** A task of hers worked by `selfimprovement`, whose holder asks `to_whom`. */
async function asked(world: SelfimprovementWorld, to_whom = 'persona:self', text = 'Plan: one small script. Accept?') {
  const { caller } = world;
  const task = await filed(world);
  await caller.call('selfimprovement', 'task.transition', {
    id: task.id,
    status: 'triaged',
    revision: task.revision,
    set: { role: 'dev', estimate: 30, budget: 4, risk: 'low' },
  });
  await caller.call('selfimprovement', 'task.approve', { id: task.id, scope: 'plan' });
  await caller.call('selfimprovement', 'task.claim', { id: task.id });
  const { question } = await caller.call('selfimprovement', 'task.ask', { id: task.id, text, to_whom });
  return { id: task.id, questionId: String(question.id) };
}

test('guard: as persona the board cancels her task and takes her comment', async (t) => {
  const world = selfimprovementWorld(t);
  const one = await filed(world);
  await world.caller.call('persona', 'task.comment', { id: one.id, text: 'Keep it small.' });
  await world.caller.call('persona', 'task.transition', {
    id: one.id,
    status: 'cancelled',
    revision: (await show(world, one.id)).task.revision,
    close_reason: 'I no longer need it.',
  });
  const view = await show(world, one.id);
  assert.equal(view.task.status, 'cancelled');
  assert.equal(view.comments[0]?.text, 'Keep it small.');
});

test('guard: as persona the board takes her answer to a question addressed to her, and the holder goes on', async (t) => {
  const world = selfimprovementWorld(t);
  const { id, questionId } = await asked(world);
  await world.caller.call('persona', 'task.answer', { question_id: questionId, text: 'Accepted.' });
  assert.equal((await show(world, id)).task.status, 'in_progress');
});

test('guard: as persona the board refuses to approve, review or unblock', async (t) => {
  // She decides on her wishes; the plan and the merge stay with the thinker and the owner.
  const world = selfimprovementWorld(t);
  const one = await filed(world);
  assert.throws(() => world.caller.call('persona', 'task.approve', { id: one.id, scope: 'plan' }));
});

test('her tools for the three answers are registered', () => {
  // Bug: the board allows it and no tool reaches it, so the wake shows a question she cannot answer.
  for (const name of ['board.cancel', 'board.comment', 'board.answer']) assert.ok(skillRegistry().has(name), name);
});

test('board.cancel cancels her task with her reason', async (t) => {
  // Bug: the tool needs a revision she has no way to know, so every cancel comes back stale.
  const world = selfimprovementWorld(t);
  const one = await filed(world);
  await world.caller.call('persona', 'task.comment', { id: one.id, text: 'A revision moved.' });
  const answer = await herCalls(world.caller)('board.cancel', { id: one.id, reason: 'I no longer need it.' });
  assert.equal(answer.status, 'ok', answer.summary);
  const { task } = await show(world, one.id);
  assert.equal(task.status, 'cancelled');
  assert.equal(task.close_reason, 'I no longer need it.');
});

test('board.cancel leaves a task that is not hers alone', async (t) => {
  // Bug: acting for `persona:self` reaches another requester's task through the shared board role.
  const world = selfimprovementWorld(t);
  const other = await world.caller.call('selfimprovement', 'task.add', {
    lane: 'dev',
    title: 'Not hers',
    description: 'e',
  });
  const answer = await herCalls(world.caller)('board.cancel', { id: other.id, reason: 'mine now' });
  assert.equal(answer.status, 'denied');
  assert.notEqual((await show(world, other.id)).task.status, 'cancelled');
});

test('board.comment writes her comment and leaves the status', async (t) => {
  // Bug: a comment moves the task or is recorded under another principal.
  const world = selfimprovementWorld(t);
  const { id } = await asked(world);
  const answer = await herCalls(world.caller)('board.comment', { id, text: 'Use the smaller plan.' });
  assert.equal(answer.status, 'ok', answer.summary);
  const view = await show(world, id);
  assert.equal(view.task.status, 'needs_answer');
  assert.equal(view.comments.at(-1)?.text, 'Use the smaller plan.');
  assert.equal(view.comments.at(-1)?.author, 'persona');
});

test('board.answer accepts the proposal: the question is answered and the holder goes on', async (t) => {
  // Bug: the wake text names the task and the tool wants a question id she never sees.
  const world = selfimprovementWorld(t);
  const { id } = await asked(world);
  const answer = await herCalls(world.caller)('board.answer', { id, text: 'Accepted.' });
  assert.equal(answer.status, 'ok', answer.summary);
  const view = await show(world, id);
  assert.equal(view.task.status, 'in_progress');
  assert.equal(view.questions[0]?.answer, 'Accepted.');
  assert.equal(view.questions[0]?.answered_by, 'persona');
});

test('board.answer on a task with no question for her is refused, and a question for the owner stays his', async (t) => {
  // Bug: she answers for the owner, or an answer on a task nobody asked about moves it.
  const world = selfimprovementWorld(t);
  const quiet = await filed(world);
  const her = herCalls(world.caller);
  assert.equal((await her('board.answer', { id: quiet.id, text: 'yes' })).status, 'failed');
  const { id } = await asked(world, 'owner');
  const refused = await her('board.answer', { id, text: 'yes' });
  assert.notEqual(refused.status, 'ok');
  assert.equal((await show(world, id)).task.status, 'needs_answer');
});

const HOUR = 3_600_000;
const NEXT_DAY = 24 * HOUR;

test('guard: a question shows in the wake after it was asked and not in the next one', async (t) => {
  const world = selfimprovementWorld(t);
  await asked(world);
  const start = SELFIMPROVEMENT_T0 - HOUR;
  const run = wakeLife(world.caller, { start, selfimprovement: { enabled: true, at: '12:00', failuresPerShape: 3 } });
  await run.life.tick();
  run.clock.t = Date.parse('2026-11-02T12:01:00Z');
  await run.life.tick();
  run.clock.t += NEXT_DAY;
  await run.life.tick();
  const shown = callsOf(run, 'selfimprovement').map((call) => call.inner.wake.selfimprovement?.news.questions.length);
  assert.deepEqual(shown, [1, 0]);
});

test('a question made after the wake fell due and before it ran shows in that wake and not in the next', async (t) => {
  // Bug: the clock moves to the wake's due moment, older than the question it just showed, so the next wake repeats it.
  const world = selfimprovementWorld(t);
  await asked(world);
  // The rig's board stamps every row at 10:00; this wake fell due at 09:00 and runs at 10:05.
  const run = wakeLife(world.caller, {
    start: Date.parse('2026-11-02T08:00:00Z'),
    selfimprovement: { enabled: true, at: '09:00', failuresPerShape: 3 },
  });
  await run.life.tick();
  run.clock.t = Date.parse('2026-11-02T10:05:00Z');
  await run.life.tick();
  run.clock.t = Date.parse('2026-11-03T09:01:00Z');
  await run.life.tick();
  const shown = callsOf(run, 'selfimprovement').map((call) => call.inner.wake.selfimprovement?.news.questions.length);
  assert.deepEqual(shown, [1, 0]);
});

test('guard: the wake shows a waiting question with its task, its id and that it is open', async (t) => {
  const world = selfimprovementWorld(t);
  const { id, questionId } = await asked(world);
  const run = wakeLife(world.caller, {
    start: SELFIMPROVEMENT_T0 - HOUR,
    selfimprovement: { enabled: true, at: '12:00', failuresPerShape: 3 },
  });
  await run.life.tick();
  run.clock.t = Date.parse('2026-11-02T12:01:00Z');
  await run.life.tick();
  const entry = callsOf(run, 'selfimprovement')[0]?.inner.wake.selfimprovement?.news.questions[0];
  assert.equal(entry?.taskId, id);
  assert.equal(entry?.questionId, questionId);
  assert.equal(entry?.answered, false);
});
