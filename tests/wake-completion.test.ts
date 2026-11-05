// What ends a heartbeat and a selfimprovement wake (plan sections 7 and 8, the owner's word of 2026-11-04): memory reads
// may come first, a heartbeat records one intention or a skip, a selfimprovement wake files one task or a skip and ends.
// Neither starts an agent or acts outward. Over the real turn runner and operations, a real board and a fake model
// (tests/fixtures/wake-turn.ts). `guard:` names a test of what already works and must keep working.
//
// The signatures these tests hold the code to:
// - `CODE.SELFIMPROVEMENT_ONLY` is `selfimprovement-only` (src/tools/codes.ts, labels and docs/prompt-contract.md): the
//   refusal of a call outside the wake's set, and of a second `board.propose` of one wake.
// - The set a selfimprovement wake accepts: the memory reads of `HEARTBEAT_READ_SKILLS`, `board.status`, `board.cancel`,
//   `board.comment`, `board.answer` and one `board.propose`. Only an ok `board.propose` ends the turn.
// - `board.propose` of one wake carries one idempotency key built from the wake's `chainId`, so a restarted turn of the
//   same wake answers with the task it already filed.
// - The tools offered to the model follow the same sets on both wakes, for the names these tests read.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { apiNameOf } from '../src/tools/definitions.ts';
import { createIntentionService } from '../src/intentions/service.ts';
import { createIntentionStores } from '../src/intentions/store.ts';
import { call, toolAnswer } from './fixtures/tool-answers.ts';
import { selfimprovementWorld } from './fixtures/selfimprovement-rig.ts';
import type { SelfimprovementWorld } from './fixtures/selfimprovement-rig.ts';
import { PROMPT_MARK, WAKE_NOW, requestText, wakeOfKind, wakeTurn } from './fixtures/wake-turn.ts';
import { tempDir } from './fixtures/tmp.ts';

const THINK = '<think>I looked at it.</think>';
const IMPROVE = wakeOfKind('selfimprovement', 'selfimprovement:1');
const BEAT = wakeOfKind('heartbeat', 'heartbeat:1');
const TASK = { title: 'A skill for the weekly digest', evidence: 'I repeated the same five calls in t1, t2 and t3.' };
const PROPOSE = toolAnswer(THINK, [call('board.propose', TASK)]);
const SET = toolAnswer(THINK, [call('intention.set', { due: '1h', text: 'ask how the move went' })]);

async function herTasks(world: SelfimprovementWorld) {
  return await world.caller.call('persona', 'task.list', { requester: 'persona:self' });
}

const nameOf = (skill: string): string => apiNameOf(skill) ?? skill;

test('selfimprovement wake: an ok board.propose ends the turn even when a read in the same step left a fresh result', async (t) => {
  // Bug: the fresh read earns another request after the filing, so the deciding wake goes on and may file or act again.
  const world = selfimprovementWorld(t);
  const run = await wakeTurn({
    wake: IMPROVE,
    answers: [toolAnswer(THINK, [call('lore.list'), call('board.propose', TASK)]), PROPOSE],
    board: world.caller,
  });
  assert.deepEqual(run.actions, ['lore.list:executed:ok', 'board.propose:executed:ok']);
  assert.equal(run.requests.length, 1);
  assert.equal((await herTasks(world)).length, 1);
});

test('guard: selfimprovement wake: a skip is one request and files nothing', async (t) => {
  const world = selfimprovementWorld(t);
  const run = await wakeTurn({ wake: IMPROVE, answers: [`${THINK}<skip/>`], board: world.caller });
  assert.equal(run.requests.length, 1);
  assert.equal(run.result.outcome, 'skip');
  assert.deepEqual(await herTasks(world), []);
});

test('guard: selfimprovement wake: a recall that finds something comes first, she reads it, and then she files', async (t) => {
  const world = selfimprovementWorld(t);
  const run = await wakeTurn({
    wake: IMPROVE,
    answers: [toolAnswer(THINK, [call('lore.list')]), PROPOSE],
    board: world.caller,
    lore: [{ id: 'l1', title: 'the digest ritual', text: 'every week', keys: ['digest'], always: false }],
  });
  assert.deepEqual(run.actions, ['lore.list:executed:ok', 'board.propose:executed:ok']);
  assert.equal(run.requests.length, 2);
  assert.ok(requestText(run.requests[1] ?? []).includes('the digest ritual'));
  assert.equal((await herTasks(world)).length, 1);
});

test('guard: selfimprovement wake: a recall that finds nothing does not end the wake, and she may skip', async (t) => {
  const world = selfimprovementWorld(t);
  const run = await wakeTurn({
    wake: IMPROVE,
    answers: [toolAnswer(THINK, [call('lore.list')]), `${THINK}<skip/>`],
    board: world.caller,
  });
  assert.equal(run.requests.length, 2);
  assert.equal(run.sends, 0);
  assert.deepEqual(await herTasks(world), []);
});

test('guard: selfimprovement wake: a rejected filing does not end the turn, she reads why and corrects it', async (t) => {
  const world = selfimprovementWorld(t);
  const run = await wakeTurn({
    wake: IMPROVE,
    answers: [toolAnswer(THINK, [call('board.propose', { ...TASK, kind: 'fix' })]), PROPOSE],
    board: world.caller,
  });
  assert.equal(run.requests.length, 2);
  assert.equal((await herTasks(world)).length, 1);
  assert.equal(run.actions.at(-1), 'board.propose:executed:ok');
  assert.notEqual(run.actions[0], 'board.propose:executed:ok');
});

test('selfimprovement wake: a second filing in one step is refused and only one task exists', async (t) => {
  // Bug: two calls of one answer both run, and the wake files two tasks.
  const world = selfimprovementWorld(t);
  const run = await wakeTurn({
    wake: IMPROVE,
    answers: [
      toolAnswer(THINK, [
        call('board.propose', TASK),
        call('board.propose', { title: 'Another', evidence: 'Another need.' }),
      ]),
    ],
    board: world.caller,
  });
  assert.deepEqual(run.actions, ['board.propose:executed:ok', 'board.propose:refused:selfimprovement-only']);
  assert.equal((await herTasks(world)).length, 1);
});

test('selfimprovement wake: a restarted turn of the same wake files nothing new', async (t) => {
  // Bug: a crash after the filing and before the commit reruns the wake, and the rerun files a second task.
  const world = selfimprovementWorld(t);
  await wakeTurn({ wake: IMPROVE, answers: [PROPOSE], board: world.caller });
  const again = await wakeTurn({
    wake: IMPROVE,
    answers: [toolAnswer(THINK, [call('board.propose', { ...TASK, title: 'Reworded on the second try' })])],
    board: world.caller,
  });
  assert.equal(again.requests.length, 1);
  assert.equal((await herTasks(world)).length, 1);
});

test('selfimprovement wake: the same tool call delivered twice leaves one task', async (t) => {
  // Bug: the provider repeats a tool call id in one answer, and the repeat files a second time.
  const world = selfimprovementWorld(t);
  const once = call('board.propose', TASK, { id: 'call-1' });
  const run = await wakeTurn({ wake: IMPROVE, answers: [toolAnswer(THINK, [once, once])], board: world.caller });
  assert.equal(run.requests.length, 1);
  assert.equal((await herTasks(world)).length, 1);
});

test('selfimprovement wake: posts, intentions, web searches and errands are refused, nothing goes out, no agent starts', async (t) => {
  // Bug: the deciding wake acts outward or starts an agent itself, which the owner's scheme forbids.
  const world = selfimprovementWorld(t);
  const run = await wakeTurn({
    wake: IMPROVE,
    answers: [
      toolAnswer(THINK, [
        call('message.create', { text: 'hello' }),
        call('intention.set', { due: '1h', text: 'later' }),
        call('web.search', { query: 'anything' }),
        call('errand.run', { agent: 'dev', goal: 'build it' }),
      ]),
      `${THINK}<skip/>`,
    ],
    board: world.caller,
  });
  assert.deepEqual(run.actions, [
    'message.create:refused:selfimprovement-only',
    'intention.set:refused:selfimprovement-only',
    'web.search:refused:selfimprovement-only',
    'errand.run:refused:selfimprovement-only',
  ]);
  assert.equal(run.sends, 0);
  assert.deepEqual(run.intentions, []);
});

test('selfimprovement wake: a memory search and an answer on a task are accepted and do not end the wake', async (t) => {
  // Bug: answering a task ends the wake, so she cannot answer one task and still file another, or memory.search is refused.
  const world = selfimprovementWorld(t);
  const filed = await world.caller.call('persona', 'task.add', {
    lane: 'dev',
    title: 'An older task',
    description: 'evidence',
    requester: 'persona:self',
    subscriber: 'persona:self',
  });
  const run = await wakeTurn({
    wake: IMPROVE,
    answers: [
      toolAnswer(THINK, [
        call('memory.search', { question: 'digest' }),
        call('board.comment', { id: filed.id, text: 'Keep it small.' }),
      ]),
      PROPOSE,
    ],
    board: world.caller,
  });
  assert.equal(run.requests.length, 2);
  assert.ok(!run.actions.some((one) => one.startsWith('memory.search:refused')), run.actions.join(' '));
  assert.ok(run.actions.includes('board.comment:executed:ok'), run.actions.join(' '));
  assert.equal(run.actions.at(-1), 'board.propose:executed:ok');
});

test('selfimprovement wake: the request offers her task operations and memory reads, and no way to act outward', async (t) => {
  // Bug: she is offered tools every call of which is refused, and spends the wake on them.
  const world = selfimprovementWorld(t);
  const run = await wakeTurn({ wake: IMPROVE, answers: ['<skip/>'], board: world.caller });
  for (const name of ['board.propose', 'board.status', 'board.cancel', 'board.comment', 'board.answer', 'lore.list'])
    assert.ok(run.offered.includes(nameOf(name)), `${name} is offered`);
  for (const name of ['message.create', 'intention.set', 'web.search', 'errand.run', 'skill.run', 'skill.disable'])
    assert.ok(!run.offered.includes(nameOf(name)), `${name} is not offered`);
});

test('heartbeat: the request offers no skill or task route and carries no diary task', async (t) => {
  // Bug: heartbeat turns back into the wake that files skills and writes the diary.
  const world = selfimprovementWorld(t);
  const run = await wakeTurn({ wake: BEAT, answers: ['<skip/>'], board: world.caller });
  for (const name of ['board.propose', 'board.cancel', 'board.comment', 'board.answer', 'skill.run', 'skill.disable'])
    assert.ok(!run.offered.includes(nameOf(name)), `${name} is not offered`);
  assert.ok(!run.offered.some((name) => name.startsWith('diary')));
  assert.ok(!requestText(run.requests[0] ?? []).includes(PROMPT_MARK.diary));
});

test('guard: heartbeat: a filing or a skill run is refused, and an intention ends the turn', async (t) => {
  const world = selfimprovementWorld(t);
  const run = await wakeTurn({
    wake: BEAT,
    answers: [toolAnswer(THINK, [call('board.propose', TASK), call('skill.run', { name: 'x', script: 'y' })]), SET],
    board: world.caller,
  });
  assert.deepEqual(run.actions, [
    'board.propose:refused:heartbeat-only',
    'skill.run:refused:heartbeat-only',
    'intention.set:executed:ok',
  ]);
  assert.equal(run.requests.length, 2);
  assert.deepEqual(await herTasks(world), []);
});

test('guard: heartbeat: a recall first, then a skip, is a completed wake with no intention', async () => {
  const run = await wakeTurn({
    wake: BEAT,
    answers: [toolAnswer(THINK, [call('lore.list')]), `${THINK}<skip/>`],
    board: null,
  });
  assert.equal(run.requests.length, 2);
  assert.equal(run.sends, 0);
  assert.deepEqual(run.intentions, []);
});

test('heartbeat: a restarted turn of the same wake records no second intention', async () => {
  // Bug: a crash after the intention and before the commit reruns the wake, and she wakes twice for one wish.
  const hot = { config: { bot: { timezone: 'UTC' }, intentions: { expiresDays: 14, maxOpen: 20 } } };
  const service = createIntentionService({
    stores: createIntentionStores({ dataDir: tempDir('nep-wake-restart-'), now: () => WAKE_NOW }),
    hot,
    now: () => WAKE_NOW,
    log: { info() {}, warn() {} },
  });
  await wakeTurn({ wake: BEAT, answers: [SET], board: null, service });
  const again = await wakeTurn({
    wake: BEAT,
    answers: [toolAnswer(THINK, [call('intention.set', { due: '2h', text: 'ask how the move went, reworded' })])],
    board: null,
    service,
  });
  assert.equal(again.requests.length, 1);
  assert.equal(again.intentions.length, 1);
});

test('board.propose: the same title while her task is open is refused and names the open task', async (t) => {
  // Bug: wake after wake she files the same need, and the executor builds it several times.
  const world = selfimprovementWorld(t);
  const first = await wakeTurn({ wake: IMPROVE, answers: [PROPOSE], board: world.caller });
  assert.deepEqual(first.actions, ['board.propose:executed:ok']);
  const [open] = await herTasks(world);
  const second = await wakeTurn({
    wake: wakeOfKind('selfimprovement', 'selfimprovement:2'),
    answers: [
      toolAnswer(THINK, [call('board.propose', { ...TASK, title: `  ${TASK.title.toUpperCase()} ` })]),
      '<skip/>',
    ],
    board: world.caller,
  });
  assert.equal(second.actions[0], 'board.propose:executed:duplicate-task');
  assert.equal(second.requests.length, 2);
  assert.ok(requestText(second.requests[1] ?? []).includes(String(open?.id)));
  assert.equal((await herTasks(world)).length, 1);
});
